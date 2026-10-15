-- Day 6a attack and behaviour tests: the stock engine (design docs/evidence/day6/design.md sections 3.1, 4, 9 and 11.1;
-- migration 20261016090000_stock_engine.sql). Runs after rls_attack.sql, import_attack.sql, activity_attack.sql and
-- their two-session tests on the same database (scripts/db-test.sh, CI job "rls"), reusing their users: admins a and b
-- (Henri), manager a1, reps b1, d1 and e1, other-org admin c1. It adds 20 managers (r01 to r20) for the random
-- operations, so the per-person rate guard never interferes. Any failure raises an exception and stops the run.
-- Three kinds of probe, as on Day 4a:
--  - as a signed-in user through the API role: grants, row level security and triggers all apply;
--  - as a signed-in user inside a probe that grants every column for that probe only (rolled back after): only the
--    triggers and policies apply, which proves the guard on its own (as if a grant were loosened by mistake);
--  - as the superuser (postgres, the owner): the engine's trusted path and the append-only rule.
-- Checks compare with IS DISTINCT FROM, so a missing value fails them instead of passing unnoticed. The file ends with
-- ledger_sums_match_levels (check_stock_integrity returns no row in either organisation).
\set ON_ERROR_STOP 1
\set QUIET 1

-- Helpers --------------------------------------------------------------------------------------------------------------
create function pg_temp.as_user(sub text, aal text, totp_age_s integer default null) returns void
language sql as $$
  select set_config('request.jwt.claims', jsonb_build_object(
    'sub', sub, 'role', 'authenticated', 'aal', aal,
    'amr', case when totp_age_s is null then '[]'::jsonb else jsonb_build_array(
      jsonb_build_object('method', 'totp', 'timestamp', extract(epoch from now())::bigint - totp_age_s)) end
  )::text, false)
$$;

-- A statement that must fail with this SQLSTATE (and hint). With a marker (planted in the user's text), the marker must
-- appear in neither the message nor the detail, and neither may say "Failing row": constant errors only.
create function pg_temp.expect_error(stmt text, want_state text, want_hint text default null, marker text default null)
returns void language plpgsql as $$
declare
  got_state text;
  got_hint text;
  got_msg text;
  got_detail text;
begin
  begin
    execute stmt;
  exception when others then
    get stacked diagnostics got_state = returned_sqlstate, got_hint = pg_exception_hint, got_msg = message_text,
                            got_detail = pg_exception_detail;
    if got_state <> want_state or (want_hint is not null and coalesce(got_hint, '') <> want_hint) then
      raise exception 'FAIL: "%" gave % (hint "%", %), expected % (hint "%")', left(stmt, 200), got_state, got_hint,
        got_msg, want_state, want_hint;
    end if;
    if marker is not null and (strpos(coalesce(got_msg, ''), marker) > 0 or strpos(coalesce(got_detail, ''), marker) > 0
                               or strpos(coalesce(got_detail, ''), 'Failing row') > 0) then
      raise exception 'FAIL: "%" put the user''s text in the error', left(stmt, 200);
    end if;
    return;
  end;
  raise exception 'FAIL: "%" succeeded, expected %', left(stmt, 200), want_state;
end;
$$;

-- A statement that must succeed, then is undone: an allowed probe leaves nothing behind.
create function pg_temp.expect_ok(stmt text) returns void
language plpgsql as $$
begin
  begin
    execute stmt;
    raise exception 'probe undone' using errcode = 'TS001';
  exception
    when sqlstate 'TS001' then
      return;
    when others then
      raise exception 'FAIL: "%" gave % (%), expected it to succeed', left(stmt, 200), sqlstate, sqlerrm;
  end;
end;
$$;

-- On hand and held at a product's warehouse ('warehouse') or transit ('transit') level; 0 when there is no level yet.
create function pg_temp.oh(p uuid, k text) returns integer language sql as $$
  select coalesce((select l.on_hand from public.stock_levels l join public.locations x on x.id = l.location_id
                    where l.product_id = p and x.kind = k), 0)
$$;
create function pg_temp.rv(p uuid, k text) returns integer language sql as $$
  select coalesce((select l.reserved from public.stock_levels l join public.locations x on x.id = l.location_id
                    where l.product_id = p and x.kind = k), 0)
$$;
-- Posts a movement and returns the RPC's answer (named arguments keep the calls short).
create function pg_temp.mv(p uuid, kind text, qty integer default null, place text default null,
                           reason text default null, company uuid default null, deal uuid default null,
                           reservation uuid default null, target integer default null, note text default null,
                           hold_until date default null, request uuid default null) returns jsonb
language sql as $$
  select public.post_stock_movement(p_product => p, p_kind => kind, p_qty => qty, p_location => place,
                                    p_reason => reason, p_note => note, p_company => company, p_deal => deal,
                                    p_reservation => reservation, p_hold_until => hold_until, p_target => target,
                                    p_request_id => request)
$$;
-- The integrity checks must find nothing: run as an admin of the org (a by default), then the caller's claims return.
create function pg_temp.integrity_clean(what text, admin_sub text default '00000000-0000-0000-0000-00000000000a')
returns void language plpgsql as $$
declare
  saved constant text := current_setting('request.jwt.claims', true);
  r record;
begin
  perform pg_temp.as_user(admin_sub, 'aal2', 30);
  for r in select * from public.check_stock_integrity() loop
    raise exception 'FAIL: % left a difference: %', what, row_to_json(r);
  end loop;
  perform set_config('request.jwt.claims', coalesce(saved, ''), false);
end;
$$;

-- Fixtures (superuser, no claims: the guards and the org trigger leave rows as given) ----------------------------------
do $$ begin perform set_config('request.jwt.claims', '', false); end $$;
insert into auth.users (id, email)
select ('00000000-0000-0000-0000-0000000005' || lpad(g::text, 2, '0'))::uuid, 'stock-r' || g || '@test.invalid'
  from generate_series(1, 20) g;
update public.profiles set role = 'manager'
 where id in (select ('00000000-0000-0000-0000-0000000005' || lpad(g::text, 2, '0'))::uuid from generate_series(1, 20) g);
do $$
declare
  main_org uuid := (select id from public.orgs where name = 'TopStock Wholesale');
  stage uuid := (select s.id from public.pipeline_stages s where s.org_id = main_org and s.position = 1);
begin
  perform set_config('t.org', main_org::text, false);
  perform set_config('t.wh', (select id from public.locations where org_id = main_org and kind = 'warehouse')::text, false);
  perform set_config('t.tr', (select id from public.locations where org_id = main_org and kind = 'transit')::text, false);
  perform set_config('t.wh_c', (select id from public.locations
                                 where org_id = '00000000-0000-0000-0000-0000000000cc' and kind = 'warehouse')::text, false);
  -- Leads: LA (manager a1's), LB (rep b1's), LD (rep d1's), LE (rep e1's), LC (the other org's).
  insert into public.companies (id, org_id, name, owner_id) values
    ('33000000-0000-0000-0000-0000000000a1', main_org, 'Stock A', '00000000-0000-0000-0000-0000000000a1'),
    ('33000000-0000-0000-0000-0000000000b1', main_org, 'Stock B', '00000000-0000-0000-0000-0000000000b1'),
    ('33000000-0000-0000-0000-0000000000d1', main_org, 'Stock D', '00000000-0000-0000-0000-0000000000d1'),
    ('33000000-0000-0000-0000-0000000000e1', main_org, 'Stock E', '00000000-0000-0000-0000-0000000000e1'),
    ('33000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000cc', 'Stock C',
     '00000000-0000-0000-0000-0000000000c1');
  -- Deals: b1's open, direct and won deals on LB; a1's deal on LB (b1 cannot see it); d1's on LD; two for the random
  -- operations. (Since Day 5 merged, 15 Oct 2026, a deal always has a lead (company_id not null), so the old "deal with no
  -- lead" fixture is gone; a won deal has its final value and close time, as Day 5's deals_won_shape and
  -- deals_closed_at_matches require.)
  insert into public.deals (id, org_id, company_id, stage_id, owner_id, status, fulfilment) values
    ('43000000-0000-0000-0000-0000000000b1', main_org, '33000000-0000-0000-0000-0000000000b1', stage,
     '00000000-0000-0000-0000-0000000000b1', 'open', 'from_stock'),
    ('43000000-0000-0000-0000-0000000000b2', main_org, '33000000-0000-0000-0000-0000000000b1', stage,
     '00000000-0000-0000-0000-0000000000b1', 'open', 'direct_from_source'),
    ('43000000-0000-0000-0000-0000000000b4', main_org, '33000000-0000-0000-0000-0000000000b1', stage,
     '00000000-0000-0000-0000-0000000000a1', 'open', 'from_stock'),
    ('43000000-0000-0000-0000-0000000000d1', main_org, '33000000-0000-0000-0000-0000000000d1', stage,
     '00000000-0000-0000-0000-0000000000d1', 'open', 'from_stock'),
    ('43000000-0000-0000-0000-0000000000f1', main_org, '33000000-0000-0000-0000-0000000000b1', stage,
     '00000000-0000-0000-0000-0000000000a1', 'open', 'from_stock'),
    ('43000000-0000-0000-0000-0000000000f2', main_org, '33000000-0000-0000-0000-0000000000d1', stage,
     '00000000-0000-0000-0000-0000000000a1', 'open', 'from_stock');
  insert into public.deals (id, org_id, company_id, stage_id, owner_id, status, fulfilment, value, closed_at) values
    ('43000000-0000-0000-0000-0000000000b3', main_org, '33000000-0000-0000-0000-0000000000b1',
     (select s.id from public.pipeline_stages s where s.org_id = main_org and s.key = 'won'),
     '00000000-0000-0000-0000-0000000000b1', 'won', 'from_stock', 1000, now());
  -- Products: one per area of the tests (48 pieces a carton), five for the random operations, one archived and empty,
  -- one in the other org.
  insert into public.products (id, org_id, name, pieces_per_carton, price_min, price_max)
  select ('7a000000-0000-0000-0000-0000000000' || t.k)::uuid, main_org, 'Stock test ' || t.k, 48, 1.5, 3.25
    from unnest(array['01', '02', '03', '04', '05', '06', '07', '08', '09', 'a1', 'a2', 'a3', 'a4', 'a5']) t (k);
  insert into public.products (id, org_id, name, pieces_per_carton, archived_at)
  values ('7a000000-0000-0000-0000-0000000000f0', main_org, 'Stock test archived', 12, now());
  insert into public.products (id, org_id, name, pieces_per_carton)
  values ('cc000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-0000000000cc', 'Stock test 01', 24);
end $$;

-- Opening stock, posted by admin b (Henri) with a fresh code (the levels can only come from the ledger).
set role authenticated;
do $$ begin perform pg_temp.as_user('00000000-0000-0000-0000-00000000000b', 'aal2', 30); end $$;
do $$
declare
  r jsonb;
begin
  r := pg_temp.mv('7a000000-0000-0000-0000-000000000001', 'receive', 96, reason => 'received');
  if r -> 'levels' -> 0 ->> 'location' is distinct from 'warehouse' or (r -> 'levels' -> 0 ->> 'on_hand')::int is distinct from 96
     or r ->> 'unchanged' is distinct from 'false' or jsonb_array_length(r -> 'movement_ids') <> 1 then
    raise exception 'FAIL: receive answer %', r;
  end if;
  perform pg_temp.mv('7a000000-0000-0000-0000-000000000002', 'receive', 800, 'transit', 'received');
  perform pg_temp.mv('7a000000-0000-0000-0000-000000000003', 'receive', 500, reason => 'received');
  perform pg_temp.mv('7a000000-0000-0000-0000-000000000003', 'receive', 300, 'transit', 'received');
  perform pg_temp.mv('7a000000-0000-0000-0000-000000000005', 'receive', 100, reason => 'received');
  perform pg_temp.mv('7a000000-0000-0000-0000-000000000006', 'receive', 300, reason => 'received');
  perform pg_temp.mv('7a000000-0000-0000-0000-000000000007', 'receive', 200, reason => 'received');
  perform pg_temp.mv('7a000000-0000-0000-0000-000000000008', 'receive', 100, reason => 'found');
  perform pg_temp.mv(('7a000000-0000-0000-0000-0000000000' || k)::uuid, 'receive', 500, reason => 'received')
    from unnest(array['a1', 'a2', 'a3', 'a4', 'a5']) k;
  perform pg_temp.mv(('7a000000-0000-0000-0000-0000000000' || k)::uuid, 'receive', 200, 'transit', 'received')
    from unnest(array['a1', 'a2', 'a3', 'a4', 'a5']) k;
end $$;
reset role;

-- 0. What the database itself says: grants, functions, triggers, policies ---------------------------------------------
do $$
declare
  cols text[];
  t text;
  f text;
begin
  -- Column grants (S10, mass assignment): clients name only these columns; the rest is the server's.
  select array_agg(attname::text order by attname) into cols from pg_attribute
   where attrelid = 'public.products'::regclass and attnum > 0 and not attisdropped
     and has_column_privilege('authenticated', attrelid, attname, 'INSERT');
  -- 6c adds import_batch_id (insert only, behind the restrictive products_import_column policy).
  if cols is distinct from array['cartons_per_pallet', 'category', 'import_batch_id', 'name', 'pieces_per_carton',
                                 'price_max', 'price_min', 'reorder_point', 'share_visible', 'transit_eta'] then
    raise exception 'FAIL: product insert columns are %', cols;
  end if;
  select array_agg(attname::text order by attname) into cols from pg_attribute
   where attrelid = 'public.products'::regclass and attnum > 0 and not attisdropped
     and has_column_privilege('authenticated', attrelid, attname, 'UPDATE');
  if cols is distinct from array['archived_at', 'cartons_per_pallet', 'category', 'name', 'pieces_per_carton', 'price_max',
                                 'price_min', 'reorder_point', 'share_visible', 'transit_eta'] then
    raise exception 'FAIL: product update columns are %', cols;
  end if;
  -- Units are pieces only (Haider, 11 Oct 2026): no per-product unit label anywhere.
  if exists (select 1 from pg_attribute where attrelid = 'public.products'::regclass and attname = 'unit'
               and not attisdropped) then
    raise exception 'FAIL: products has a unit column';
  end if;
  select array_agg(attname::text order by attname) into cols from pg_attribute
   where attrelid = 'private.stock_movements'::regclass and attnum > 0 and not attisdropped
     and has_column_privilege('authenticated', attrelid, attname, 'INSERT');
  if cols is distinct from array['company_id', 'deal_id', 'expected_on_hand', 'group_id', 'hold_until', 'import_batch_id',
                                 'kind', 'location_id', 'note', 'order_line_id', 'pair_id', 'product_id', 'qty',
                                 'reason', 'reservation_id', 'target_on_hand'] then
    raise exception 'FAIL: ledger insert columns are %', cols;
  end if;
  select array_agg(attname::text order by attname) into cols from pg_attribute
   where attrelid = 'private.product_costs'::regclass and attnum > 0 and not attisdropped
     and has_column_privilege('authenticated', attrelid, attname, 'UPDATE');
  if cols is distinct from array['cost_per_piece', 'source'] then raise exception 'FAIL: cost update columns are %', cols; end if;
  select array_agg(attname::text order by attname) into cols from pg_attribute
   where attrelid = 'private.inventory_settings'::regclass and attnum > 0 and not attisdropped
     and has_column_privilege('authenticated', attrelid, attname, 'UPDATE');
  -- 6e adds the sharing switch (its guard lets non-admins change only that, and only to off).
  if cols is distinct from array['alert_assignee_id', 'hold_days', 'sharing_enabled'] then raise exception 'FAIL: settings update columns are %', cols; end if;
  select array_agg(attname::text order by attname) into cols from pg_attribute
   where attrelid = 'public.locations'::regclass and attnum > 0 and not attisdropped
     and has_column_privilege('authenticated', attrelid, attname, 'UPDATE');
  if cols is distinct from array['name'] then raise exception 'FAIL: location update columns are %', cols; end if;
  -- stock_levels_direct_write_denied (catalog), hold uses read only (S1); holds read only but for their end date
  -- (6d: extend_reservation, guarded by reservation_extend_guard).
  select array_agg(attname::text order by attname) into cols from pg_attribute
   where attrelid = 'private.stock_reservations'::regclass and attnum > 0 and not attisdropped
     and (has_column_privilege('authenticated', attrelid, attname, 'UPDATE')
          or has_column_privilege('authenticated', attrelid, attname, 'INSERT'));
  if cols is distinct from array['hold_until'] or has_table_privilege('authenticated', 'private.stock_reservations', 'INSERT')
     or has_table_privilege('authenticated', 'private.stock_reservations', 'DELETE')
     or has_table_privilege('authenticated', 'private.stock_reservations', 'TRUNCATE') then
    raise exception 'FAIL: hold write columns are %', cols;
  end if;
  foreach t in array array['public.stock_levels', 'private.stock_hold_uses'] loop
    if not has_table_privilege('authenticated', t, 'SELECT')
       or has_table_privilege('authenticated', t, 'INSERT') or has_table_privilege('authenticated', t, 'UPDATE')
       or has_table_privilege('authenticated', t, 'DELETE') or has_table_privilege('authenticated', t, 'TRUNCATE')
       or exists (select 1 from pg_attribute a where a.attrelid = t::regclass and a.attnum > 0 and not a.attisdropped
                    and (has_column_privilege('authenticated', a.attrelid, a.attname, 'INSERT')
                         or has_column_privilege('authenticated', a.attrelid, a.attname, 'UPDATE'))) then
      raise exception 'FAIL: % must be read-only for authenticated', t;
    end if;
  end loop;
  if has_table_privilege('authenticated', 'private.stock_movements', 'UPDATE')
     or has_table_privilege('authenticated', 'private.stock_movements', 'DELETE')
     or has_table_privilege('authenticated', 'private.stock_movements', 'TRUNCATE')
     or has_table_privilege('authenticated', 'public.products', 'DELETE') then
    raise exception 'FAIL: ledger or products writable beyond their grants';
  end if;
  -- anon reaches nothing (P6 starts in 6e).
  foreach t in array array['public.products', 'public.locations', 'public.stock_levels', 'private.product_costs',
                           'private.inventory_settings', 'private.stock_reservations', 'private.stock_movements',
                           'private.stock_hold_uses', 'private.movement_requests'] loop
    if has_table_privilege('anon', t, 'SELECT') or has_table_privilege('anon', t, 'INSERT')
       or has_table_privilege('anon', t, 'UPDATE') or has_table_privilege('anon', t, 'DELETE') then
      raise exception 'FAIL: anon has a privilege on %', t;
    end if;
    if not (select relrowsecurity from pg_class where oid = t::regclass) then
      raise exception 'FAIL: row level security off on %', t;
    end if;
    if not exists (select 1 from pg_policies where schemaname || '.' || tablename = t and policyname = 'require_mfa'
                     and permissive = 'RESTRICTIVE') then
      raise exception 'FAIL: % lacks the restrictive two-factor policy', t;
    end if;
  end loop;
  -- stock_core_not_exposed: the ledger, holds, hold uses, costs, settings and idempotency rows live in private.
  if (select array_agg(relname::text order by relname) from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'private' and c.relkind = 'r' and c.relname in ('stock_movements', 'stock_reservations',
             'stock_hold_uses', 'product_costs', 'inventory_settings', 'movement_requests')) is distinct from
     array['inventory_settings', 'movement_requests', 'product_costs', 'stock_hold_uses', 'stock_movements',
           'stock_reservations'] then
    raise exception 'FAIL: stock tables outside private';
  end if;
  -- RPCs: authenticated only, invoker, search_path pinned; anon_no_execute_on_stock_rpcs.
  foreach f in array array[
    'public.post_stock_movement(uuid, text, integer, text, text, text, uuid, uuid, uuid, date, integer, uuid)',
    'public.create_product(text, integer, numeric, numeric, text, integer, integer, date, boolean, numeric, integer, text, uuid)',
    'public.update_product(uuid, text, integer, numeric, numeric, text, integer, integer, date, boolean)',
    'public.set_product_cost(uuid, numeric)', 'public.archive_product(uuid)', 'public.restore_product(uuid)',
    'public.release_expired_reservations()', 'public.check_stock_integrity()'] loop
    if has_function_privilege('anon', f, 'EXECUTE') or not has_function_privilege('authenticated', f, 'EXECUTE') then
      raise exception 'FAIL: execute rights on %', f;
    end if;
    if (select prosecdef or not ('search_path=""' = any (proconfig)) from pg_proc where oid = f::regprocedure) then
      raise exception 'FAIL: % must be invoker with search_path pinned', f;
    end if;
  end loop;
  if not (select 'lock_timeout=3s' = any (proconfig) from pg_proc
           where oid = 'public.post_stock_movement(uuid, text, integer, text, text, text, uuid, uuid, uuid, date, integer, uuid)'::regprocedure) then
    raise exception 'FAIL: post_stock_movement must set lock_timeout = 3s';
  end if;
  -- Trigger functions and internal helpers: nobody but the owner may call them.
  foreach f in array array['private.stock_movement_a_guard()', 'private.stock_movement_b_apply()',
    'private.stock_movement_immutable()', 'private.stock_transfer_paired()', 'private.release_deal_holds()',
    'private.product_guard()', 'private.product_cost_guard()', 'private.inventory_settings_guard()',
    'private.location_guard()', 'private.movement_request_guard()', 'private.audit_inventory_row()',
    'private.seed_org_inventory(uuid)', 'private.seed_org_inventory_trigger()',
    'private.expire_holds_for(uuid, uuid, uuid, integer)', 'private.nightly_stock_jobs()'] loop
    if has_function_privilege('authenticated', f, 'EXECUTE') or has_function_privilege('anon', f, 'EXECUTE') then
      raise exception 'FAIL: % is callable', f;
    end if;
  end loop;
  foreach f in array array['private.expire_due_holds(uuid, uuid, uuid)', 'private.sweep_expired_holds()',
    'private.stock_integrity_rows(uuid)', 'private.product_name_key(text)'] loop
    if has_function_privilege('anon', f, 'EXECUTE') or not has_function_privilege('authenticated', f, 'EXECUTE') then
      raise exception 'FAIL: execute rights on %', f;
    end if;
  end loop;
  -- The apply step (the only code that writes levels and holds) is a postgres-owned SECURITY DEFINER; the guard is
  -- invoker. The other definers (expiry helpers, the deal-lost release, transfer pairing, the nightly job, seeding and
  -- audit) are owned by postgres too and listed above as not callable, or granted only where needed.
  if (select not prosecdef or proowner::regrole::text <> 'postgres' from pg_proc
       where oid = 'private.stock_movement_b_apply()'::regprocedure)
     or (select prosecdef from pg_proc where oid = 'private.stock_movement_a_guard()'::regprocedure) then
    raise exception 'FAIL: apply must be a postgres-owned definer and the guard an invoker';
  end if;
  -- The deal-lost release fires on any update of a deal, not only one naming status (no column list: a status set by a
  -- BEFORE trigger must release holds too).
  if (select tgattr::text from pg_trigger where tgrelid = 'public.deals'::regclass and tgname = 'release_deal_holds_lost')
     is distinct from '' then
    raise exception 'FAIL: release_deal_holds_lost must have no column list';
  end if;
  -- The guard runs before the apply step (BEFORE INSERT triggers fire in name order).
  if (select array_agg(tgname::text order by tgname) from pg_trigger
       where tgrelid = 'private.stock_movements'::regclass and not tgisinternal and tgtype & 4 = 4 and tgtype & 2 = 2)
     is distinct from array['stock_movement_a_guard', 'stock_movement_b_apply'] then
    raise exception 'FAIL: BEFORE INSERT triggers on the ledger';
  end if;
  -- Holds keep their lead (restrict) and lose a deleted deal (set null).
  if (select array_agg(conname::text || '=' || confdeltype::text order by conname) from pg_constraint
       where contype = 'f' and conrelid = 'private.stock_reservations'::regclass
         and conname in ('stock_reservations_company_id_fkey', 'stock_reservations_deal_id_fkey'))
     is distinct from array['stock_reservations_company_id_fkey=r', 'stock_reservations_deal_id_fkey=n'] then
    raise exception 'FAIL: hold foreign key actions';
  end if;
  -- Exactly these policies (an extra permissive policy would widen access).
  if (select array_agg(schemaname || '.' || tablename || ':' || policyname order by schemaname || '.' || tablename || ':' || policyname) from pg_policies
       where (schemaname, tablename) in (('public', 'products'), ('public', 'locations'), ('public', 'stock_levels'),
             ('private', 'product_costs'), ('private', 'inventory_settings'), ('private', 'stock_reservations'),
             ('private', 'stock_movements'), ('private', 'stock_hold_uses'), ('private', 'movement_requests'))
         and policyname <> 'require_mfa')
     is distinct from array['private.inventory_settings:inventory_settings_reader',   -- 6e: share_reader, org-bound
                            'private.inventory_settings:inventory_settings_select',
                            'private.inventory_settings:inventory_settings_update',
                            'private.movement_requests:movement_requests_own', 'private.product_costs:product_costs_rw',
                            'private.stock_hold_uses:stock_hold_uses_select',
                            'private.stock_movements:stock_movements_insert',
                            'private.stock_movements:stock_movements_select',
                            'private.stock_reservations:stock_reservations_extend',
                            'private.stock_reservations:stock_reservations_select',
                            'public.locations:locations_reader', 'public.locations:locations_select',
                            'public.locations:locations_update',
                            'public.products:products_import_column', 'public.products:products_insert',
                            'public.products:products_reader', 'public.products:products_select',
                            'public.products:products_update', 'public.stock_levels:stock_levels_reader',
                            'public.stock_levels:stock_levels_select'] then
    raise exception 'FAIL: stock policies are %', (select array_agg(schemaname || '.' || tablename || ':' || policyname order by schemaname || '.' || tablename || ':' || policyname)
      from pg_policies where tablename in ('products', 'locations', 'stock_levels', 'product_costs', 'inventory_settings',
        'stock_reservations', 'stock_movements', 'stock_hold_uses', 'movement_requests') and policyname <> 'require_mfa');
  end if;
  -- Every organisation has its two places and its settings row (seeded, and by the trigger for the test org c1).
  if exists (select 1 from public.orgs o where (select count(*) from public.locations l where l.org_id = o.id) <> 2
                                            or not exists (select 1 from private.inventory_settings s where s.org_id = o.id)) then
    raise exception 'FAIL: an organisation lacks its places or settings';
  end if;
end $$;

-- 0b. The product name key (D13). product_name_key_cases: the same rows will be checked against the TypeScript copy in 6c
-- (stock-key-parity.spec.ts reads the literal between the markers). Columns: name, expected key.
do $$
declare
  t record;
begin
  for t in select * from (values
      -- product-key-table:start
      ('T-SHIRT COTON', 't shirt coton'),
      ('T-shirt coton', 't shirt coton'),
      ('  t shirt   coton ', 't shirt coton'),
      ('Œuvre Æther Straße', 'oeuvre aether strasse'),
      ('Crème brûlée 250g', 'creme brulee 250g'),
      ('Café' || chr(769) || ' noir', 'cafe noir'),
      ('Pack 1.5L', 'pack 1 5l'),
      ('Pack 1,5L', 'pack 1 5l'),
      ('Łódź – edition «spéciale»', 'lodz edition speciale'),
      ('Soft' || chr(173) || 'ware', 'software'),
      ('Zero' || chr(8203) || 'width', 'zerowidth'),
      ('A/B (lot 2)', 'a b lot 2'),
      ('ÉCRAN 4K™', 'ecran 4k'),
      ('東京 T-shirt', '東京 t shirt'),
      ('ΑΒΓ', 'ΑΒΓ'),
      ('!!!', ''),
      ('Sneakers 👟 pair', 'sneakers pair')
      -- product-key-table:end
    ) as k (name, want) loop
    if private.product_name_key(t.name) is distinct from t.want then
      raise exception 'FAIL: product_name_key(%) gave "%", expected "%"', t.name, private.product_name_key(t.name), t.want;
    end if;
  end loop;
end $$;

-- 1. Access (S1, S5, S12) ----------------------------------------------------------------------------------------------
set role authenticated;
do $$ begin perform pg_temp.as_user('00000000-0000-0000-0000-00000000000a', 'aal2', 30); end $$;
do $$
begin
  -- stock_levels_direct_write_denied: even an admin with a fresh code.
  perform pg_temp.expect_error($q$insert into public.stock_levels (product_id, location_id, org_id, on_hand)
    values ('7a000000-0000-0000-0000-000000000009', current_setting('t.wh')::uuid, current_setting('t.org')::uuid, 5)$q$, '42501');
  perform pg_temp.expect_error($q$update public.stock_levels set on_hand = on_hand + 1$q$, '42501');
  perform pg_temp.expect_error($q$delete from public.stock_levels$q$, '42501');
  -- ledger_tables_direct_write_denied
  perform pg_temp.expect_error($q$insert into private.stock_reservations (id, org_id, product_id, location_id, company_id,
    quantity, remaining, hold_until, created_by) values (gen_random_uuid(), current_setting('t.org')::uuid,
    '7a000000-0000-0000-0000-000000000001', current_setting('t.wh')::uuid, '33000000-0000-0000-0000-0000000000b1', 1, 1,
    current_date, '00000000-0000-0000-0000-00000000000a')$q$, '42501');
  perform pg_temp.expect_error($q$update private.stock_reservations set remaining = 1$q$, '42501');
  perform pg_temp.expect_error($q$delete from private.stock_reservations$q$, '42501');
  perform pg_temp.expect_error($q$insert into private.stock_hold_uses (movement_id, reservation_id, org_id, pieces)
    values (1, gen_random_uuid(), current_setting('t.org')::uuid, 1)$q$, '42501');
  perform pg_temp.expect_error($q$update private.stock_movements set qty = 1$q$, '42501');
  perform pg_temp.expect_error($q$delete from private.stock_movements$q$, '42501');
  perform pg_temp.expect_error($q$delete from public.products where id = '7a000000-0000-0000-0000-000000000009'$q$, '42501');
  -- trusted_branch_only_postgres: an expiry row from a person is refused.
  perform pg_temp.expect_error($q$insert into private.stock_movements (group_id, product_id, location_id, kind,
    reservation_id) values (gen_random_uuid(), '7a000000-0000-0000-0000-000000000001', current_setting('t.wh')::uuid,
    'expire', gen_random_uuid())$q$, '42501', 'forbidden');
end $$;
do $$ begin perform pg_temp.as_user('00000000-0000-0000-0000-0000000000b1', 'aal2', 30); end $$;
do $$
begin
  perform pg_temp.expect_error($q$update public.stock_levels set reserved = 0$q$, '42501');
  perform pg_temp.expect_error($q$insert into public.stock_levels (product_id, location_id, org_id)
    values ('7a000000-0000-0000-0000-000000000009', current_setting('t.wh')::uuid, current_setting('t.org')::uuid)$q$, '42501');
end $$;
-- aal1_every_stock_rpc_denied
do $$ begin perform pg_temp.as_user('00000000-0000-0000-0000-00000000000a', 'aal1'); end $$;
do $$
declare
  s text;
begin
  foreach s in array array[
    $q$select pg_temp.mv('7a000000-0000-0000-0000-000000000001', 'receive', 1, reason => 'received')$q$,
    $q$select public.create_product('aal1 product', 12)$q$,
    $q$select public.update_product('7a000000-0000-0000-0000-000000000001', 'x', 12)$q$,
    $q$select public.set_product_cost('7a000000-0000-0000-0000-000000000001', 1)$q$,
    $q$select public.archive_product('7a000000-0000-0000-0000-000000000009')$q$,
    $q$select public.restore_product('7a000000-0000-0000-0000-0000000000f0')$q$,
    $q$select public.release_expired_reservations()$q$,
    $q$select * from public.check_stock_integrity()$q$] loop
    perform pg_temp.expect_error(s, '42501');
  end loop;
  if exists (select 1 from public.stock_levels) or exists (select 1 from public.products)
     or exists (select 1 from private.stock_movements) then
    raise exception 'FAIL: an aal1 session can read stock';
  end if;
end $$;
reset role;
-- anon: no stock RPC at all.
set role anon;
do $$
declare
  s text;
begin
  perform set_config('request.jwt.claims', '{"role":"anon"}', false);
  foreach s in array array[
    $q$select public.post_stock_movement('7a000000-0000-0000-0000-000000000001', 'receive', 1)$q$,
    $q$select public.create_product('anon product', 12)$q$,
    $q$select public.release_expired_reservations()$q$,
    $q$select * from public.check_stock_integrity()$q$,
    $q$select count(*) from public.stock_levels$q$, $q$select count(*) from public.products$q$] loop
    begin
      execute s;
      raise exception 'FAIL: anon ran %', s;
    exception when insufficient_privilege then null;
    end;
  end loop;
end $$;
reset role;
-- stock_movements_immutable: append-only for every role, the owner included, TRUNCATE included (I4).
do $$
begin
  perform set_config('request.jwt.claims', '', false);
  perform set_config('client_min_messages', 'warning', true);
  perform pg_temp.expect_error($q$update private.stock_movements set note = 'x'$q$, '42501', 'append_only');
  perform pg_temp.expect_error($q$delete from private.stock_movements$q$, '42501', 'append_only');
  perform pg_temp.expect_error($q$truncate private.stock_movements cascade$q$, '42501', 'append_only');
end $$;
-- The guard on its own: with every ledger column granted for this probe only (rolled back), the server-kept fields are
-- still set by the guard and the apply step, whatever the row says.
do $$
declare
  m record;
begin
  begin
    grant insert on private.stock_movements to authenticated;
    perform pg_temp.as_user('00000000-0000-0000-0000-00000000000a', 'aal2', 30);
    set local role authenticated;
    insert into private.stock_movements (org_id, group_id, product_id, location_id, kind, qty, reason, user_id, created_at,
                                         d_on_hand, on_hand_after, level_version)
    values ('00000000-0000-0000-0000-0000000000cc', gen_random_uuid(), '7a000000-0000-0000-0000-000000000008',
            current_setting('t.wh')::uuid, 'adjust_in', 1, 'found', '00000000-0000-0000-0000-0000000000b1',
            now() - interval '1 day', 999, 999, 999)
    returning org_id, user_id, created_at, d_on_hand, on_hand_after into m;
    if m.org_id is distinct from current_setting('t.org')::uuid or m.user_id is distinct from '00000000-0000-0000-0000-00000000000a'
       or m.created_at is distinct from now() or m.d_on_hand is distinct from 1 or m.on_hand_after is distinct from 101 then
      raise exception 'FAIL: movement_server_fields (guard alone): %', row_to_json(m);
    end if;
    reset role;
    raise exception 'probe undone' using errcode = 'TS001';
  exception when sqlstate 'TS001' then null;
  end;
  perform set_config('request.jwt.claims', '', false);
end $$;

-- 2. Validation (constant messages; design 4.2 step 2 and 4.3) --------------------------------------------------------
set role authenticated;
do $$ begin perform pg_temp.as_user('00000000-0000-0000-0000-00000000000a', 'aal2', 30); end $$;
do $$
declare
  p constant uuid := '7a000000-0000-0000-0000-000000000001';
  m record;
begin
  -- post_movement_validation
  perform pg_temp.expect_error(format('select pg_temp.mv(%L, %L, %s, reason => %L)', p, 'receive', 0, 'received'), '22023', 'quantity');
  perform pg_temp.expect_error(format('select pg_temp.mv(%L, %L, %s, reason => %L)', p, 'receive', -1, 'received'), '22023', 'quantity');
  perform pg_temp.expect_error(format('select pg_temp.mv(%L, %L, %s, reason => %L)', p, 'receive', 50000001, 'received'), '22023', 'quantity');
  perform pg_temp.expect_error(format('select pg_temp.mv(%L, %L, null, reason => %L)', p, 'receive', 'received'), '22023', 'quantity');
  perform pg_temp.expect_error(format('select pg_temp.mv(%L, %L, %s)', p, 'teleport', 1), '22023', 'kind');
  perform pg_temp.expect_error(format('select pg_temp.mv(%L, %L, %s)', p, 'receive', 1), '22023', 'reason');
  perform pg_temp.expect_error(format('select pg_temp.mv(%L, %L, %s, reason => %L)', p, 'adjust_out', 1, 'received'), '22023', 'reason');
  perform pg_temp.expect_error(format('select pg_temp.mv(%L, %L, %s, reason => %L)', p, 'transfer', 1, 'damaged'), '22023', 'reason');
  perform pg_temp.expect_error(format('select pg_temp.mv(%L, %L, %s, reason => %L)', p, 'adjust_in', 1, 'other'), '22023', 'note_required');
  perform pg_temp.expect_error(format('select pg_temp.mv(%L, %L, %s, reason => %L, note => %L)', p, 'adjust_in', 1, 'other',
    repeat('n', 495) || 'MARK1x'), '22023', 'note', 'MARK1');
  perform pg_temp.expect_error(format('select pg_temp.mv(%L, %L, %s, reason => %L, note => %L)', p, 'adjust_in', 1, 'other',
    'MARK2' || chr(8238) || 'x'), '22023', 'note', 'MARK2');
  perform pg_temp.expect_error(format('select pg_temp.mv(%L, %L, %s, %L, %L)', p, 'receive', 1, 'garage', 'received'), '22023', 'location');
  perform pg_temp.expect_error(format('select pg_temp.mv(%L, %L, %s, reason => %L)', '7a000000-0000-0000-0000-0000000000f0',
    'receive', 1, 'received'), '22023', 'product_archived');
  perform pg_temp.expect_error(format('select pg_temp.mv(%L, %L, %s, target => 5)', p, 'count', 1), '22023', 'quantity');
  perform pg_temp.expect_error(format('select pg_temp.mv(%L, %L, target => -1)', p, 'count'), '22023', 'quantity');
  perform pg_temp.expect_error(format('select pg_temp.mv(%L, %L, target => 50000001)', p, 'count'), '22023', 'quantity');
  perform pg_temp.expect_error(format('select pg_temp.mv(%L, %L)', p, 'release'), '22023', 'reservation');
  perform pg_temp.expect_error(format('select pg_temp.mv(%L, %L, %s)', p, 'reserve', 1), '22023', 'document');
  perform pg_temp.expect_error(format('select pg_temp.mv(%L, %L, %s, company => %L, hold_until => current_date - 1)', p,
    'reserve', 1, '33000000-0000-0000-0000-0000000000b1'), '22023', 'hold_until');
  perform pg_temp.expect_error(format('select pg_temp.mv(%L, %L, %s, company => %L, hold_until => current_date + 92)', p,
    'reserve', 1, '33000000-0000-0000-0000-0000000000b1'), '22023', 'hold_until');
  perform pg_temp.expect_error(format('select pg_temp.mv(%L, %L, %s, company => %L, note => %L)', p, 'reserve', 1,
    '33000000-0000-0000-0000-0000000000b1', repeat('h', 301)), '22023', 'note');
  perform pg_temp.expect_error(format('select pg_temp.mv(%L, %L, %s, company => %L)', p, 'reserve', 1,
    '99000000-0000-0000-0000-000000000000'), 'P0002');
  perform pg_temp.expect_error(format('select pg_temp.mv(%L, %L, %s, reason => %L)', '99000000-0000-0000-0000-000000000000',
    'receive', 1, 'received'), 'P0002');
  -- Direct ledger inserts (the RPC is not the only door): wrong place, kinds 6a cannot post, documents 6a has no path for.
  perform pg_temp.expect_error($q$insert into private.stock_movements (group_id, product_id, location_id, kind, qty, reason)
    values (gen_random_uuid(), '7a000000-0000-0000-0000-000000000001', current_setting('t.wh')::uuid, 'transfer_out', 1,
    'arrived')$q$, '22023', 'location');
  perform pg_temp.expect_error($q$insert into private.stock_movements (group_id, product_id, location_id, kind, qty, reason)
    values (gen_random_uuid(), '7a000000-0000-0000-0000-000000000001', current_setting('t.wh_c')::uuid, 'receive', 1,
    'received')$q$, '22023', 'location');
  perform pg_temp.expect_error($q$insert into private.stock_movements (group_id, product_id, location_id, kind, qty)
    values (gen_random_uuid(), '7a000000-0000-0000-0000-000000000001', current_setting('t.wh')::uuid, 'ship', 1)$q$,
    '22023', 'kind');
  perform pg_temp.expect_error($q$insert into private.stock_movements (group_id, product_id, location_id, kind, qty)
    values (gen_random_uuid(), '7a000000-0000-0000-0000-000000000001', current_setting('t.wh')::uuid, 'import_in', 1)$q$,
    '22023', 'kind');
  perform pg_temp.expect_error($q$insert into private.stock_movements (group_id, product_id, location_id, kind, qty, reason,
    import_batch_id) values (gen_random_uuid(), '7a000000-0000-0000-0000-000000000001', current_setting('t.wh')::uuid,
    'receive', 1, 'received', '90000000-0000-0000-0000-00000000000a')$q$, '22023', 'document');
  perform pg_temp.expect_error($q$insert into private.stock_movements (group_id, product_id, location_id, kind, qty, reason,
    order_line_id) values (gen_random_uuid(), '7a000000-0000-0000-0000-000000000001', current_setting('t.wh')::uuid,
    'receive', 1, 'received', gen_random_uuid())$q$, '22023', 'document');
  perform pg_temp.expect_error($q$insert into private.stock_movements (product_id, location_id, kind, qty, reason)
    values ('7a000000-0000-0000-0000-000000000001', current_setting('t.wh')::uuid, 'receive', 1, 'received')$q$,
    '22023', 'document');
  -- A hold's end date is checked by the guard too (a direct insert skips the RPC's check).
  perform pg_temp.expect_error($q$insert into private.stock_movements (group_id, product_id, location_id, kind, qty,
    company_id, hold_until) values (gen_random_uuid(), '7a000000-0000-0000-0000-000000000001', current_setting('t.wh')::uuid,
    'reserve', 1, '33000000-0000-0000-0000-0000000000b1', current_date + 91)$q$, '22023', 'hold_until');
  perform pg_temp.expect_error($q$insert into private.stock_movements (group_id, product_id, location_id, kind, qty,
    company_id) values (gen_random_uuid(), '7a000000-0000-0000-0000-000000000001', current_setting('t.wh')::uuid,
    'reserve', 1, '33000000-0000-0000-0000-0000000000b1')$q$, '22023', 'hold_until');
  -- movement_server_fields_not_writable: the engine's columns are not even grantable to name.
  perform pg_temp.expect_error($q$insert into private.stock_movements (group_id, product_id, location_id, kind, qty, reason,
    user_id) values (gen_random_uuid(), '7a000000-0000-0000-0000-000000000001', current_setting('t.wh')::uuid, 'receive',
    1, 'received', '00000000-0000-0000-0000-0000000000b1')$q$, '42501');
  perform pg_temp.expect_error($q$insert into private.stock_movements (group_id, product_id, location_id, kind, qty, reason,
    d_on_hand) values (gen_random_uuid(), '7a000000-0000-0000-0000-000000000001', current_setting('t.wh')::uuid, 'receive',
    1, 'received', 1000)$q$, '42501');
  perform pg_temp.expect_error($q$insert into private.stock_movements (org_id, group_id, product_id, location_id, kind, qty,
    reason) values ('00000000-0000-0000-0000-0000000000cc', gen_random_uuid(), '7a000000-0000-0000-0000-000000000001',
    current_setting('t.wh')::uuid, 'receive', 1, 'received')$q$, '42501');
  -- A direct insert of the granted columns gets the server's values (and passes every engine rule).
  insert into private.stock_movements (group_id, product_id, location_id, kind, qty, reason, company_id, deal_id, hold_until)
  values (gen_random_uuid(), '7a000000-0000-0000-0000-000000000008', current_setting('t.wh')::uuid, 'adjust_in', 2, 'found',
          '33000000-0000-0000-0000-0000000000b1', '43000000-0000-0000-0000-0000000000b1', current_date)
  returning org_id, user_id, created_at, d_on_hand, on_hand_after, company_id, deal_id, hold_until into m;
  if m.org_id is distinct from current_setting('t.org')::uuid or m.user_id is distinct from '00000000-0000-0000-0000-00000000000a'
     or m.created_at is distinct from now() or m.d_on_hand is distinct from 2 or m.on_hand_after is distinct from 102
     or m.company_id is not null or m.deal_id is not null or m.hold_until is not null then
    raise exception 'FAIL: movement_server_fields_not_writable: %', row_to_json(m);
  end if;
end $$;
-- product_insert_server_fields and check_constraints_never_fire (every CHECK a client can reach has a constant message).
do $$
declare
  r record;
begin
  perform pg_temp.expect_error($q$insert into public.products (name, pieces_per_carton, created_by)
    values ('Server fields', 12, '00000000-0000-0000-0000-0000000000b1')$q$, '42501');
  perform pg_temp.expect_error($q$insert into public.products (name, pieces_per_carton, archived_at)
    values ('Server fields', 12, now())$q$, '42501');
  perform pg_temp.expect_error($q$insert into public.products (name, pieces_per_carton, org_id)
    values ('Server fields', 12, '00000000-0000-0000-0000-0000000000cc')$q$, '42501');
  perform pg_temp.expect_error($q$insert into public.products (name, pieces_per_carton, import_batch_id)
    values ('Server fields', 12, '90000000-0000-0000-0000-00000000000a')$q$, '42501');
  insert into public.products (name, pieces_per_carton, category) values ('  Server fields  ', 12, '  ')
  returning org_id, created_by, archived_at, name, category, number into r;
  if r.org_id is distinct from current_setting('t.org')::uuid or r.created_by is distinct from '00000000-0000-0000-0000-00000000000a'
     or r.archived_at is not null or r.name is distinct from 'Server fields' or r.category is not null or r.number is null then
    raise exception 'FAIL: product_insert_server_fields: %', row_to_json(r);
  end if;
  for r in select * from (values
      ($q$insert into public.products (name, pieces_per_carton) values ('MARK3' || chr(9) || 'tab', 12)$q$, 'product_name'),
      ($q$insert into public.products (name, pieces_per_carton) values ('MARK3' || repeat('x', 200), 12)$q$, 'product_name'),
      ($q$insert into public.products (name, pieces_per_carton) values ('!!!', 12)$q$, 'product_name'),
      ($q$insert into public.products (name, pieces_per_carton) values ('', 12)$q$, 'product_name'),
      ($q$insert into public.products (name, pieces_per_carton, category) values ('MARK3 ok', 12, 'MARK3' || repeat('c', 80))$q$, 'category'),
      ($q$insert into public.products (name, pieces_per_carton) values ('MARK3 ok', 0)$q$, 'carton'),
      ($q$insert into public.products (name, pieces_per_carton) values ('MARK3 ok', null)$q$, 'carton'),
      ($q$insert into public.products (name, pieces_per_carton, cartons_per_pallet) values ('MARK3 ok', 12, 0)$q$, 'pallet'),
      ($q$insert into public.products (name, pieces_per_carton, reorder_point) values ('MARK3 ok', 12, -1)$q$, 'reorder'),
      ($q$insert into public.products (name, pieces_per_carton, price_min) values ('MARK3 ok', 12, -0.01)$q$, 'price'),
      ($q$insert into public.products (name, pieces_per_carton, price_max) values ('MARK3 ok', 12, 1000000.01)$q$, 'price'),
      ($q$insert into public.products (name, pieces_per_carton, price_min, price_max) values ('MARK3 ok', 12, 5, 4)$q$, 'price_order'),
      ($q$insert into public.products (name, pieces_per_carton, transit_eta) values ('MARK3 ok', 12, current_date + 731)$q$, 'eta'),
      ($q$insert into public.products (name, pieces_per_carton, transit_eta) values ('MARK3 ok', 12, current_date - 366)$q$, 'eta'),
      ($q$insert into public.products (name, pieces_per_carton) values ('stock TEST 01', 12)$q$, 'name_taken'),
      ($q$insert into public.products (name, pieces_per_carton) values ('Stock-test (archived)', 12)$q$, 'name_taken'),
      ($q$insert into private.product_costs (product_id, cost_per_piece, source) values ('7a000000-0000-0000-0000-000000000009', -1, 'manual')$q$, 'cost'),
      ($q$insert into private.product_costs (product_id, cost_per_piece, source) values ('7a000000-0000-0000-0000-000000000009', 1, 'MARK3')$q$, 'source'),
      ($q$update private.inventory_settings set hold_days = 0$q$, 'hold_days'),
      ($q$update public.locations set name = 'MARK3' || chr(10) || 'x' where kind = 'warehouse'$q$, 'location_name'),
      ($q$update public.locations set name = '   ' where kind = 'warehouse'$q$, 'location_name'),
      ($q$insert into private.movement_requests (request_id, kind) values (gen_random_uuid(), 'MARK3')$q$, 'request'),
      ($q$insert into private.stock_movements (group_id, product_id, location_id, kind, qty, reason, note) values
         (gen_random_uuid(), '7a000000-0000-0000-0000-000000000001', current_setting('t.wh')::uuid, 'adjust_in', 1, 'other',
          'MARK3' || repeat('n', 500))$q$, 'note'),
      ($q$insert into private.stock_movements (group_id, product_id, location_id, kind, qty, reason, note) values
         (gen_random_uuid(), '7a000000-0000-0000-0000-000000000001', current_setting('t.wh')::uuid, 'adjust_in', 0, 'other',
          'MARK3')$q$, 'quantity'),
      ($q$insert into private.stock_movements (group_id, product_id, location_id, kind, target_on_hand, reason, note) values
         (gen_random_uuid(), '7a000000-0000-0000-0000-000000000001', current_setting('t.wh')::uuid, 'count', -5, 'count',
          'MARK3')$q$, 'quantity'),
      ($q$insert into private.stock_movements (group_id, product_id, location_id, kind, qty, reason, note) values
         (gen_random_uuid(), '7a000000-0000-0000-0000-000000000001', current_setting('t.wh')::uuid, 'adjust_in', 1, 'MARK3',
          'MARK3')$q$, 'reason'),
      ($q$insert into private.stock_movements (group_id, product_id, location_id, kind, qty, reason, note) values
         (gen_random_uuid(), '7a000000-0000-0000-0000-000000000001', current_setting('t.wh')::uuid, 'receive', 49999990,
          'received', 'MARK3')$q$, 'quantity')
    ) as c (stmt, hint) loop
    perform pg_temp.expect_error(r.stmt, '22023', r.hint, 'MARK3');
  end loop;
end $$;

-- 3. Rules on the locked level (I1, I5, I6) ----------------------------------------------------------------------------
do $$
declare
  p constant uuid := '7a000000-0000-0000-0000-000000000001';
  r jsonb;
  v_hold uuid;
  n integer;
  ver bigint;
begin
  -- no_negative_stock, no_over_reservation
  perform pg_temp.expect_error(format('select pg_temp.mv(%L, %L, %s, reason => %L)', p, 'adjust_out', 97, 'lost'), '22023', 'insufficient_stock');
  perform pg_temp.expect_ok(format('select pg_temp.mv(%L, %L, %s, reason => %L)', p, 'adjust_out', 96, 'lost'));
  perform pg_temp.expect_error(format('select pg_temp.mv(%L, %L, %s, company => %L)', p, 'reserve', 97,
    '33000000-0000-0000-0000-0000000000b1'), '22023', 'over_reservation');
  perform pg_temp.expect_ok(format('select pg_temp.mv(%L, %L, %s, company => %L)', p, 'reserve', 96,
    '33000000-0000-0000-0000-0000000000b1'));
  -- cannot_sell_reserved_stock (6a: no stock leaves past what is held for clients)
  r := pg_temp.mv(p, 'reserve', 40, company => '33000000-0000-0000-0000-0000000000b1');
  v_hold := (r ->> 'reservation_id')::uuid;
  if pg_temp.rv(p, 'warehouse') <> 40 or (r -> 'levels' -> 0 ->> 'available')::int <> 56 then
    raise exception 'FAIL: hold of 40: %', r;
  end if;
  perform pg_temp.expect_error(format('select pg_temp.mv(%L, %L, %s, reason => %L)', p, 'adjust_out', 57, 'damaged'), '22023', 'below_reserved');
  perform pg_temp.expect_ok(format('select pg_temp.mv(%L, %L, %s, reason => %L)', p, 'adjust_out', 56, 'damaged'));
  perform pg_temp.expect_error(format('select pg_temp.mv(%L, %L, %s, company => %L)', p, 'reserve', 57,
    '33000000-0000-0000-0000-0000000000d1'), '22023', 'over_reservation');
  -- count_sets_exact_quantity, count_unchanged_writes_nothing, count_below_held_refused
  r := pg_temp.mv(p, 'count', target => 120);
  if pg_temp.oh(p, 'warehouse') <> 120 or not exists (select 1 from private.stock_movements m
       where m.id = (r -> 'movement_ids' ->> 0)::bigint and m.kind = 'adjust_in' and m.qty = 24 and m.reason = 'count'
         and m.target_on_hand = 120 and m.d_on_hand = 24) then
    raise exception 'FAIL: count up to 120: %', r;
  end if;
  r := pg_temp.mv(p, 'count', target => 100);
  if pg_temp.oh(p, 'warehouse') <> 100 or not exists (select 1 from private.stock_movements m
       where m.id = (r -> 'movement_ids' ->> 0)::bigint and m.kind = 'adjust_out' and m.qty = 20 and m.d_on_hand = -20) then
    raise exception 'FAIL: count down to 100: %', r;
  end if;
  select count(*), max(l.version) into n, ver from private.stock_movements m, public.stock_levels l
   where m.product_id = p and l.product_id = p and l.location_id = current_setting('t.wh')::uuid;
  r := pg_temp.mv(p, 'count', target => 100);
  if r ->> 'unchanged' is distinct from 'true' or jsonb_array_length(r -> 'movement_ids') <> 0
     or (select count(*) from private.stock_movements m where m.product_id = p) <> n
     or (select l.version from public.stock_levels l where l.product_id = p and l.location_id = current_setting('t.wh')::uuid) <> ver then
    raise exception 'FAIL: count_unchanged_writes_nothing: %', r;
  end if;
  perform pg_temp.expect_error(format('select pg_temp.mv(%L, %L, target => 39)', p, 'count'), '22023', 'below_reserved');
  perform pg_temp.expect_ok(format('select pg_temp.mv(%L, %L, target => 40)', p, 'count'));
  -- adjust_below_reserved_refused (on hand 100, held 40)
  perform pg_temp.expect_error(format('select pg_temp.mv(%L, %L, %s, reason => %L)', p, 'adjust_out', 61, 'sample'), '22023', 'below_reserved');
  -- cas_stale_refused: a compare-and-set that does not match the locked level is refused; a matching one passes.
  perform pg_temp.expect_error($q$insert into private.stock_movements (group_id, product_id, location_id, kind, qty, reason,
    expected_on_hand) values (gen_random_uuid(), '7a000000-0000-0000-0000-000000000001', current_setting('t.wh')::uuid,
    'receive', 1, 'received', 99)$q$, '22023', 'stale');
  perform pg_temp.expect_ok($q$insert into private.stock_movements (group_id, product_id, location_id, kind, qty, reason,
    expected_on_hand) values (gen_random_uuid(), '7a000000-0000-0000-0000-000000000001', current_setting('t.wh')::uuid,
    'receive', 1, 'received', 100)$q$);
  -- Too much stock in one place is refused before the CHECK.
  perform pg_temp.expect_error(format('select pg_temp.mv(%L, %L, %s, reason => %L)', p, 'receive', 49999901, 'received'), '22023', 'quantity');
  r := pg_temp.mv(p, 'release', reservation => v_hold);
  if pg_temp.rv(p, 'warehouse') <> 0 then raise exception 'FAIL: release all: %', r; end if;
end $$;
-- versions_match_snapshots: per level, rows ordered by level_version are 1..n and chain their snapshots (D5, I8).
do $$
declare
  bad integer;
begin
  select count(*) into bad from (
    select m.product_id, m.location_id, m.level_version, m.on_hand_after, m.reserved_after, m.d_on_hand, m.d_reserved,
           row_number() over w as rn,
           lag(m.on_hand_after, 1, 0) over w as prev_on, lag(m.reserved_after, 1, 0) over w as prev_res
      from private.stock_movements m
    window w as (partition by m.product_id, m.location_id order by m.level_version)) x
   where x.level_version <> x.rn or x.on_hand_after <> x.prev_on + x.d_on_hand
      or x.reserved_after <> x.prev_res + x.d_reserved;
  if bad <> 0 then raise exception 'FAIL: versions_match_snapshots: % rows out of chain', bad; end if;
  perform pg_temp.integrity_clean('the rules section');
end $$;

-- 4. Transfers: Arrived (design 6.4) -----------------------------------------------------------------------------------
-- Holds 400 (b1, lead LB, oldest) and 400 (d1, lead LD) at transit, which has 800; manager a1 marks 700 as arrived.
do $$ begin perform pg_temp.as_user('00000000-0000-0000-0000-0000000000b1', 'aal2', 30); end $$;
do $$ begin perform set_config('t.h1', (pg_temp.mv('7a000000-0000-0000-0000-000000000002', 'reserve', 400, 'transit',
  company => '33000000-0000-0000-0000-0000000000b1') ->> 'reservation_id'), false); end $$;
do $$ begin perform pg_temp.as_user('00000000-0000-0000-0000-0000000000d1', 'aal2', 30); end $$;
do $$ begin perform set_config('t.h2', (pg_temp.mv('7a000000-0000-0000-0000-000000000002', 'reserve', 400, 'transit',
  company => '33000000-0000-0000-0000-0000000000d1', hold_until => current_date + 30) ->> 'reservation_id'), false); end $$;
do $$ begin perform pg_temp.as_user('00000000-0000-0000-0000-0000000000b1', 'aal2', 30); end $$;
do $$
begin
  -- rep_cannot_transfer
  perform pg_temp.expect_error($q$select pg_temp.mv('7a000000-0000-0000-0000-000000000002', 'transfer', 10)$q$, '42501', 'forbidden');
end $$;
do $$ begin perform pg_temp.as_user('00000000-0000-0000-0000-0000000000a1', 'aal2', 3000); end $$;
do $$
declare
  p constant uuid := '7a000000-0000-0000-0000-000000000002';
  h1 constant uuid := current_setting('t.h1')::uuid;
  h2 constant uuid := current_setting('t.h2')::uuid;
  r jsonb;
  s record;
begin
  update public.products set transit_eta = current_date + 10 where id = p;
  -- Arrived needs no fresh code (D20): manager a1 entered the code 50 minutes ago.
  r := pg_temp.mv(p, 'transfer', 700);
  -- transfer_conserves_total and transfer_moves_holds_oldest_first_and_splits
  if pg_temp.oh(p, 'transit') <> 100 or pg_temp.rv(p, 'transit') <> 100 or pg_temp.oh(p, 'warehouse') <> 700
     or pg_temp.rv(p, 'warehouse') <> 700 or (r ->> 'moved')::int <> 700 or (r ->> 'held_moved')::int <> 700 then
    raise exception 'FAIL: transfer levels: %', r;
  end if;
  if not exists (select 1 from private.stock_reservations where id = h1 and location_id = current_setting('t.wh')::uuid
                   and remaining = 400 and status = 'active') then
    raise exception 'FAIL: the oldest hold should move whole';
  end if;
  if not exists (select 1 from private.stock_reservations where id = h2 and location_id = current_setting('t.tr')::uuid
                   and remaining = 100 and quantity = 400 and status = 'active') then
    raise exception 'FAIL: the second hold should keep 100 at transit';
  end if;
  select r2.* into s from private.stock_reservations r2 where r2.split_from = h2;
  if s.location_id is distinct from current_setting('t.wh')::uuid or s.remaining is distinct from 300
     or s.quantity is distinct from 300 or s.created_by is distinct from '00000000-0000-0000-0000-0000000000d1'
     or s.company_id is distinct from '33000000-0000-0000-0000-0000000000d1' or s.hold_until is distinct from current_date + 30
     or s.created_at is distinct from (select created_at from private.stock_reservations where id = h2) then
    raise exception 'FAIL: the split part: %', row_to_json(s);
  end if;
  if (select array_agg(m.kind || ':' || m.d_on_hand || ':' || m.d_reserved || ':' || coalesce(m.pair_id::text, '-') order by m.id)
        from private.stock_movements m where m.group_id = (r ->> 'group_id')::uuid)
     is distinct from array['transfer_out:-700:-700:-', 'transfer_in:700:700:' || (r -> 'movement_ids' ->> 0)] then
    raise exception 'FAIL: transfer rows';
  end if;
  -- The expected date stays while pieces are still in transit.
  if (select transit_eta from public.products where id = p) is null then raise exception 'FAIL: eta cleared too early'; end if;
  -- transfer_more_than_in_transit_refused
  perform pg_temp.expect_error(format('select pg_temp.mv(%L, %L, %s)', p, 'transfer', 101), '22023', 'insufficient_stock');
  -- transfer_in_without_out_refused: no departure, or one that already arrived.
  perform pg_temp.expect_error(format($q$insert into private.stock_movements (group_id, product_id, location_id, kind, qty)
    values (gen_random_uuid(), %L, current_setting('t.wh')::uuid, 'transfer_in', 5)$q$, p), '22023', 'pair');
  perform pg_temp.expect_error(format($q$insert into private.stock_movements (group_id, product_id, location_id, kind, qty, pair_id)
    values (%L, %L, current_setting('t.wh')::uuid, 'transfer_in', 700, %s)$q$, r ->> 'group_id', p, r -> 'movement_ids' ->> 0),
    '22023', 'pair');
  -- The rest arrives: transit empties, the expected date goes, the second hold moves whole.
  r := pg_temp.mv(p, 'transfer', 100);
  if pg_temp.oh(p, 'transit') <> 0 or pg_temp.rv(p, 'transit') <> 0 or pg_temp.oh(p, 'warehouse') <> 800
     or pg_temp.rv(p, 'warehouse') <> 800 or (select transit_eta from public.products where id = p) is not null
     or not exists (select 1 from private.stock_reservations where id = h2 and location_id = current_setting('t.wh')::uuid) then
    raise exception 'FAIL: second transfer: %', r;
  end if;
  perform pg_temp.integrity_clean('the transfers');
end $$;
-- transfer_out_without_in_refused: a departure alone (stock leaving transit with no fresh code) fails when the deferred
-- check runs (forced to run now with SET CONSTRAINTS; otherwise at commit).
do $$ begin perform pg_temp.as_user('00000000-0000-0000-0000-00000000000a', 'aal2', 30); end $$;
do $$
declare
  h text;
begin
  perform pg_temp.mv('7a000000-0000-0000-0000-000000000002', 'receive', 10, 'transit', 'received');
  begin
    set constraints private.stock_movements_transfer_paired immediate;
    insert into private.stock_movements (group_id, product_id, location_id, kind, qty)
    values (gen_random_uuid(), '7a000000-0000-0000-0000-000000000002', current_setting('t.tr')::uuid, 'transfer_out', 10);
    raise exception 'FAIL: a lone transfer_out was accepted';
  exception when sqlstate '22023' then
    get stacked diagnostics h = pg_exception_hint;
    if h is distinct from 'pair' then raise exception 'FAIL: lone transfer_out gave hint %', h; end if;
  end;
  set constraints private.stock_movements_transfer_paired deferred;
end $$;
-- transfer_moves_held_pieces_first: transit has 10 pieces, 4 of them held; Arrived of 5 carries the 4 held pieces and 1
-- free one (moving free pieces first would leave the hold at transit). Undone afterwards.
do $$ begin perform pg_temp.as_user('00000000-0000-0000-0000-0000000000a1', 'aal2', 3000); end $$;
do $$
declare
  p constant uuid := '7a000000-0000-0000-0000-000000000002';
  r jsonb;
begin
  begin
    perform pg_temp.mv(p, 'reserve', 4, 'transit', company => '33000000-0000-0000-0000-0000000000d1');
    r := pg_temp.mv(p, 'transfer', 5);
    if (r ->> 'held_moved')::int is distinct from 4 or pg_temp.oh(p, 'transit') <> 5 or pg_temp.rv(p, 'transit') <> 0
       or pg_temp.rv(p, 'warehouse') <> 804 then
      raise exception 'FAIL: transfer_moves_held_pieces_first: %', r;
    end if;
    perform pg_temp.integrity_clean('held pieces first');
    raise exception 'undo' using errcode = 'TS001';
  exception when sqlstate 'TS001' then null;
  end;
end $$;

-- 5. Permissions and step-up (S5, S6, D20, D21) ------------------------------------------------------------------------
do $$ begin perform pg_temp.as_user('00000000-0000-0000-0000-00000000000a', 'aal2', 660); end $$;
do $$
declare
  p constant uuid := '7a000000-0000-0000-0000-000000000005';
begin
  -- adjust_stale_code_step_up, receive_stale_code_step_up, count too; archive and restore too.
  perform pg_temp.expect_error(format('select pg_temp.mv(%L, %L, %s, reason => %L)', p, 'adjust_out', 1, 'damaged'), '42501', 'step_up');
  perform pg_temp.expect_error(format('select pg_temp.mv(%L, %L, %s, reason => %L)', p, 'adjust_in', 1, 'found'), '42501', 'step_up');
  perform pg_temp.expect_error(format('select pg_temp.mv(%L, %L, %s, reason => %L)', p, 'receive', 1, 'received'), '42501', 'step_up');
  perform pg_temp.expect_error(format('select pg_temp.mv(%L, %L, target => 1)', p, 'count'), '42501', 'step_up');
  perform pg_temp.expect_error($q$select public.archive_product('7a000000-0000-0000-0000-000000000009')$q$, '42501', 'step_up');
  perform pg_temp.expect_error($q$update public.products set archived_at = now() where id = '7a000000-0000-0000-0000-000000000009'$q$, '42501', 'step_up');
  perform pg_temp.expect_error($q$select public.restore_product('7a000000-0000-0000-0000-0000000000f0')$q$, '42501', 'step_up');
  perform pg_temp.expect_error($q$select public.create_product('Opening stale', 12, p_opening_qty => 5)$q$, '42501', 'step_up');
  -- Holds and Arrived need no fresh code.
  perform pg_temp.expect_ok(format('select pg_temp.mv(%L, %L, %s, company => %L)', p, 'reserve', 1, '33000000-0000-0000-0000-0000000000b1'));
  perform pg_temp.expect_ok($q$select public.create_product('No opening stock', 12)$q$);
end $$;
do $$ begin perform pg_temp.as_user('00000000-0000-0000-0000-00000000000a', 'aal2', 30); end $$;
do $$
declare
  p constant uuid := '7a000000-0000-0000-0000-000000000005';
begin
  perform pg_temp.expect_ok(format('select pg_temp.mv(%L, %L, %s, reason => %L)', p, 'adjust_out', 1, 'damaged'));
  perform pg_temp.expect_ok(format('select pg_temp.mv(%L, %L, target => 1)', p, 'count'));
end $$;
-- rep_cannot_adjust_or_receive_or_transfer, and reps do not create, change, cost or archive products.
do $$ begin perform pg_temp.as_user('00000000-0000-0000-0000-0000000000b1', 'aal2', 30); end $$;
do $$
declare
  p constant uuid := '7a000000-0000-0000-0000-000000000005';
  n integer;
begin
  perform pg_temp.expect_error(format('select pg_temp.mv(%L, %L, %s, reason => %L)', p, 'receive', 1, 'received'), '42501', 'forbidden');
  perform pg_temp.expect_error(format('select pg_temp.mv(%L, %L, %s, reason => %L)', p, 'adjust_in', 1, 'found'), '42501', 'forbidden');
  perform pg_temp.expect_error(format('select pg_temp.mv(%L, %L, %s, reason => %L)', p, 'adjust_out', 1, 'lost'), '42501', 'forbidden');
  perform pg_temp.expect_error(format('select pg_temp.mv(%L, %L, target => 1)', p, 'count'), '42501', 'forbidden');
  perform pg_temp.expect_error(format('select pg_temp.mv(%L, %L, %s)', p, 'transfer', 1), '42501', 'forbidden');
  perform pg_temp.expect_error($q$insert into private.stock_movements (group_id, product_id, location_id, kind, qty, reason)
    values (gen_random_uuid(), '7a000000-0000-0000-0000-000000000005', current_setting('t.wh')::uuid, 'adjust_in', 1, 'found')$q$, '42501', 'forbidden');
  perform pg_temp.expect_error($q$select public.create_product('Rep product', 12)$q$, '42501', 'forbidden');
  perform pg_temp.expect_error($q$insert into public.products (name, pieces_per_carton) values ('Rep product', 12)$q$, '42501');
  perform pg_temp.expect_error($q$select public.update_product('7a000000-0000-0000-0000-000000000005', 'Renamed', 12)$q$, '42501', 'forbidden');
  perform pg_temp.expect_error($q$select public.set_product_cost('7a000000-0000-0000-0000-000000000005', 1)$q$, '42501', 'forbidden');
  perform pg_temp.expect_error($q$select public.archive_product('7a000000-0000-0000-0000-000000000009')$q$, '42501', 'forbidden');
  update public.products set name = 'Renamed by rep' where id = p;
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'FAIL: a rep renamed a product'; end if;
  update public.products set archived_at = now() where id = '7a000000-0000-0000-0000-000000000009';
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'FAIL: a rep archived a product'; end if;
  -- Only admins run the stock check.
  perform pg_temp.expect_error('select * from public.check_stock_integrity()', '42501', 'forbidden');
  -- rep_cost_null: reps never see costs.
  if exists (select 1 from private.product_costs) then raise exception 'FAIL: a rep sees costs'; end if;
  perform pg_temp.expect_error($q$insert into private.product_costs (product_id, cost_per_piece, source)
    values ('7a000000-0000-0000-0000-000000000005', 1, 'manual')$q$, '42501');
  -- Reps read products and stock.
  if not exists (select 1 from public.products where id = p) or pg_temp.oh(p, 'warehouse') <> 100 then
    raise exception 'FAIL: a rep should read products and levels';
  end if;
end $$;
-- Managers correct stock with a fresh code, create and change products, and set costs; archive_stale_code,
-- archive_needs_zero_stock, archived_product_refuses_new_stock, restore by admins only.
do $$ begin perform pg_temp.as_user('00000000-0000-0000-0000-0000000000a1', 'aal2', 30); end $$;
do $$
declare
  v_id uuid;
  v_again uuid;
  r jsonb;
  req constant uuid := 'c0ffee00-0000-0000-0000-000000000001';
begin
  perform pg_temp.expect_ok($q$select pg_temp.mv('7a000000-0000-0000-0000-000000000005', 'adjust_in', 1, reason => 'found')$q$);
  -- create_product with a cost and opening stock; a retry with the same request id returns the same product.
  v_id := public.create_product('Manager product', 24, 2, 4.5, 'Shoes', 40, 48, current_date + 20, true, 1.25, 72,
                                'transit', req);
  v_again := public.create_product('Manager product', 24, 2, 4.5, 'Shoes', 40, 48, current_date + 20, true, 1.25, 72,
                                   'transit', req);
  if v_again is distinct from v_id or (select count(*) from public.products where name = 'Manager product') <> 1
     or pg_temp.oh(v_id, 'transit') <> 72 or pg_temp.oh(v_id, 'warehouse') <> 0
     or (select cost_per_piece from private.product_costs where product_id = v_id) is distinct from 1.25
     or (select count(*) from private.stock_movements where product_id = v_id) <> 1
     or (select created_by from public.products where id = v_id) is distinct from '00000000-0000-0000-0000-0000000000a1' then
    raise exception 'FAIL: create_product';
  end if;
  perform set_config('t.pm', v_id::text, false);
  -- name_taken: the same name key, by a create or a rename, gets a constant error.
  perform pg_temp.expect_error($q$select public.create_product('MANAGER-product', 12)$q$, '22023', 'name_taken');
  perform pg_temp.expect_error($q$select public.update_product('7a000000-0000-0000-0000-000000000005', 'manager  product', 12)$q$, '22023', 'name_taken');
  -- product_name_unsafe_refused
  perform pg_temp.expect_error(format('select public.create_product(%L, 12)', 'Bidi ' || chr(8238) || 'name'), '22023', 'product_name');
  perform pg_temp.expect_error(format('select public.create_product(%L, 12)', '***'), '22023', 'product_name');
  perform pg_temp.expect_error($q$select public.create_product('Huge price', 12, 1e20)$q$, '22023', 'price');
  perform pg_temp.expect_error($q$select public.create_product('Huge cost', 12, p_cost_per_piece => 1e20)$q$, '22023', 'cost');
  -- update_product replaces the editable fields.
  r := public.update_product(v_id, 'Manager product v2', 12, 2.5, 5, null, null, 10, null, false);
  if (select row(name, pieces_per_carton, price_min, price_max, category, cartons_per_pallet, reorder_point,
                 transit_eta, share_visible)::text from public.products where id = v_id)
     is distinct from '("Manager product v2",12,2.5000,5.0000,,,10,,f)' or r ->> 'id' is distinct from v_id::text then
    raise exception 'FAIL: update_product: %', (select row_to_json(p) from public.products p where id = v_id);
  end if;
  perform pg_temp.expect_error(format('select public.update_product(%L, %L, 12)', gen_random_uuid(), 'Ghost'), 'P0002');
  perform public.set_product_cost(v_id, 0.9);
  if (select cost_per_piece || ':' || source || ':' || updated_by from private.product_costs where product_id = v_id)
     is distinct from '0.900000:manual:00000000-0000-0000-0000-0000000000a1' then
    raise exception 'FAIL: set_product_cost';
  end if;
  perform pg_temp.expect_error(format('select public.set_product_cost(%L, -1)', v_id), '22023', 'cost');
  -- archive_needs_zero_stock (the RPC and a direct update), then archive the empty test product.
  perform pg_temp.expect_error(format('select public.archive_product(%L)', v_id), '22023', 'has_stock');
  perform pg_temp.expect_error(format('update public.products set archived_at = now() where id = %L', v_id), '22023', 'has_stock');
  perform public.archive_product('7a000000-0000-0000-0000-000000000009');
  if (select archived_at from public.products where id = '7a000000-0000-0000-0000-000000000009') is distinct from now() then
    raise exception 'FAIL: archive_product';
  end if;
  perform public.archive_product('7a000000-0000-0000-0000-000000000009');  -- again: nothing changes
  -- archived_product_refuses_new_stock
  perform pg_temp.expect_error($q$select pg_temp.mv('7a000000-0000-0000-0000-000000000009', 'receive', 1, reason => 'received')$q$, '22023', 'product_archived');
  perform pg_temp.expect_error($q$select pg_temp.mv('7a000000-0000-0000-0000-000000000009', 'reserve', 1,
    company => '33000000-0000-0000-0000-0000000000b1')$q$, '22023', 'product_archived');
  -- Restore: admins only (a manager is refused by the RPC and by the guard).
  perform pg_temp.expect_error($q$select public.restore_product('7a000000-0000-0000-0000-000000000009')$q$, '42501', 'forbidden');
  perform pg_temp.expect_error($q$update public.products set archived_at = null where id = '7a000000-0000-0000-0000-000000000009'$q$, '42501', 'forbidden');
  -- The archive time never moves.
  update public.products set archived_at = now() - interval '1 day' where id = '7a000000-0000-0000-0000-000000000009';
  if (select archived_at from public.products where id = '7a000000-0000-0000-0000-000000000009') is distinct from now() then
    raise exception 'FAIL: the archive time moved';
  end if;
end $$;
do $$ begin perform pg_temp.as_user('00000000-0000-0000-0000-00000000000a', 'aal2', 30); end $$;
do $$
begin
  perform public.restore_product('7a000000-0000-0000-0000-000000000009');
  if (select archived_at from public.products where id = '7a000000-0000-0000-0000-000000000009') is not null then
    raise exception 'FAIL: restore_product';
  end if;
  perform pg_temp.expect_error(format('select public.restore_product(%L)', gen_random_uuid()), 'P0002');
  perform pg_temp.expect_error(format('select public.archive_product(%L)', gen_random_uuid()), 'P0002');
end $$;
-- The product guard on its own (every product column granted for this probe only, rolled back): server fields, and
-- only an admin restores.
reset role;
do $$
declare
  r record;
begin
  begin
    grant insert, update on public.products to authenticated;
    perform pg_temp.as_user('00000000-0000-0000-0000-0000000000a1', 'aal2', 30);
    set local role authenticated;
    insert into public.products (name, pieces_per_carton, created_by, archived_at)
    values ('Probe product', 12, '00000000-0000-0000-0000-00000000000a', now())
    returning created_by, archived_at into r;
    if r.created_by is distinct from '00000000-0000-0000-0000-0000000000a1' or r.archived_at is not null then
      raise exception 'FAIL: product guard alone: %', row_to_json(r);
    end if;
    perform pg_temp.expect_error($q$update public.products set archived_at = null where id = '7a000000-0000-0000-0000-0000000000f0'$q$, '42501', 'forbidden');
    perform pg_temp.expect_error($q$update public.products set created_by = null where name = 'Probe product'$q$, '42501', 'not_editable');
    perform pg_temp.expect_error($q$update public.products set import_batch_id = '90000000-0000-0000-0000-00000000000a' where name = 'Probe product'$q$, '42501', 'not_editable');
    reset role;
    raise exception 'probe undone' using errcode = 'TS001';
  exception when sqlstate 'TS001' then null;
  end;
  perform set_config('request.jwt.claims', '', false);
end $$;

-- rep_cost_null, once costs exist (the check in section 5 runs before any): a rep still reads none of them.
do $$ begin perform set_config('t.costs', (select count(*) from private.product_costs)::text, false); end $$;

-- 6. Holds and deals ---------------------------------------------------------------------------------------------------
set role authenticated;
do $$ begin perform pg_temp.as_user('00000000-0000-0000-0000-0000000000b1', 'aal2', 30); end $$;
do $$
begin
  if current_setting('t.costs')::int = 0 then raise exception 'FAIL: rep_cost_null needs costs to exist'; end if;
  if exists (select 1 from private.product_costs) then raise exception 'FAIL: rep_cost_null: a rep sees costs'; end if;
end $$;
do $$
declare
  p constant uuid := '7a000000-0000-0000-0000-000000000003';
  r jsonb;
begin
  -- reserve_requires_editable_lead: a rep holds for their own leads only.
  perform pg_temp.expect_error(format('select pg_temp.mv(%L, %L, %s, company => %L)', p, 'reserve', 5,
    '33000000-0000-0000-0000-0000000000a1'), '42501', 'forbidden');
  r := pg_temp.mv(p, 'reserve', 10, company => '33000000-0000-0000-0000-0000000000b1', note => 'for the spring order');
  if not exists (select 1 from private.stock_reservations where id = (r ->> 'reservation_id')::uuid
                   and created_by = '00000000-0000-0000-0000-0000000000b1' and company_id = '33000000-0000-0000-0000-0000000000b1'
                   and hold_until = current_date + 14 and note = 'for the spring order' and quantity = 10 and remaining = 10) then
    raise exception 'FAIL: hold row: %', r;
  end if;
  perform set_config('t.hb', r ->> 'reservation_id', false);
  -- reserve_deal_invisible_refused: a deal on b1's lead that b1 cannot see (manager a1's) is refused by the guard.
  perform pg_temp.expect_error(format('select pg_temp.mv(%L, %L, %s, company => %L, deal => %L)', p, 'reserve', 5,
    '33000000-0000-0000-0000-0000000000b1', '43000000-0000-0000-0000-0000000000b4'), '22023', 'deal_mismatch');
  -- reserve_closed_or_direct_deal_refused
  perform pg_temp.expect_error(format('select pg_temp.mv(%L, %L, %s, company => %L, deal => %L)', p, 'reserve', 5,
    '33000000-0000-0000-0000-0000000000b1', '43000000-0000-0000-0000-0000000000b3'), '22023', 'deal_closed');
  perform pg_temp.expect_error(format('select pg_temp.mv(%L, %L, %s, company => %L, deal => %L)', p, 'reserve', 5,
    '33000000-0000-0000-0000-0000000000b1', '43000000-0000-0000-0000-0000000000b2'), '22023', 'deal_direct');
  -- reserve_transit_allowed, with the deal
  r := pg_temp.mv(p, 'reserve', 50, 'transit', company => '33000000-0000-0000-0000-0000000000b1',
                  deal => '43000000-0000-0000-0000-0000000000b1');
  if not exists (select 1 from private.stock_reservations where id = (r ->> 'reservation_id')::uuid
                   and location_id = current_setting('t.tr')::uuid and deal_id = '43000000-0000-0000-0000-0000000000b1') then
    raise exception 'FAIL: reserve_transit_allowed';
  end if;
  perform pg_temp.mv(p, 'reserve', 100, company => '33000000-0000-0000-0000-0000000000b1',
                     deal => '43000000-0000-0000-0000-0000000000b1');
end $$;
do $$ begin perform pg_temp.as_user('00000000-0000-0000-0000-0000000000a1', 'aal2', 30); end $$;
do $$
declare
  p constant uuid := '7a000000-0000-0000-0000-000000000003';
begin
  -- reserve_deal_other_lead_refused (a manager sees every deal). reserve_deal_null_company_refused is now the schema's:
  -- Day 5 made deals.company_id not null, so no deal without a lead can exist (checked here; the engine's
  -- "d.company_id is null" branch stays as a second layer).
  perform pg_temp.expect_error(format('select pg_temp.mv(%L, %L, %s, company => %L, deal => %L)', p, 'reserve', 5,
    '33000000-0000-0000-0000-0000000000b1', '43000000-0000-0000-0000-0000000000d1'), '22023', 'deal_mismatch');
  if (select attnotnull from pg_attribute where attrelid = 'public.deals'::regclass and attname = 'company_id') is not true then
    raise exception 'FAIL: reserve_deal_null_company_refused: deals.company_id may be null again (test a lead-less deal)';
  end if;
  perform pg_temp.expect_error(format('select pg_temp.mv(%L, %L, %s, company => %L, deal => %L)', p, 'reserve', 5,
    '33000000-0000-0000-0000-0000000000b1', gen_random_uuid()), '22023', 'deal_mismatch');
  -- The manager may hold for any lead, and for a deal on it.
  perform pg_temp.expect_ok(format('select pg_temp.mv(%L, %L, %s, company => %L, deal => %L)', p, 'reserve', 5,
    '33000000-0000-0000-0000-0000000000b1', '43000000-0000-0000-0000-0000000000b4'));
  perform set_config('t.ha1', pg_temp.mv(p, 'reserve', 20, company => '33000000-0000-0000-0000-0000000000b1') ->> 'reservation_id', false);
end $$;
-- release_rules: an unrelated rep is refused; a lead editor and the creator may release, in part or whole.
do $$ begin perform pg_temp.as_user('00000000-0000-0000-0000-0000000000d1', 'aal2', 30); end $$;
do $$
begin
  perform pg_temp.expect_error(format('select pg_temp.mv(%L, %L, reservation => %L)', '7a000000-0000-0000-0000-000000000003',
    'release', current_setting('t.hb')), '42501', 'forbidden');
  perform pg_temp.expect_error(format($q$insert into private.stock_movements (group_id, product_id, location_id, kind,
    reservation_id) values (gen_random_uuid(), '7a000000-0000-0000-0000-000000000003', current_setting('t.wh')::uuid,
    'release', %L)$q$, current_setting('t.hb')), '42501', 'forbidden');
end $$;
do $$ begin perform pg_temp.as_user('00000000-0000-0000-0000-0000000000a1', 'aal2', 30); end $$;
do $$
declare
  hb constant uuid := current_setting('t.hb')::uuid;
begin
  perform pg_temp.mv('7a000000-0000-0000-0000-000000000003', 'release', 4, reservation => hb);
  if not exists (select 1 from private.stock_reservations where id = hb and remaining = 6 and status = 'active' and closed_at is null) then
    raise exception 'FAIL: partial release';
  end if;
  perform pg_temp.expect_error(format('select pg_temp.mv(%L, %L, 7, reservation => %L)', '7a000000-0000-0000-0000-000000000003',
    'release', hb), '22023', 'reservation_state');
  perform pg_temp.expect_error(format('select pg_temp.mv(%L, %L, reservation => %L)', '7a000000-0000-0000-0000-000000000005',
    'release', hb), '22023', 'reservation_state');
end $$;
do $$ begin perform pg_temp.as_user('00000000-0000-0000-0000-0000000000b1', 'aal2', 30); end $$;
do $$
declare
  hb constant uuid := current_setting('t.hb')::uuid;
  r jsonb;
begin
  r := pg_temp.mv('7a000000-0000-0000-0000-000000000003', 'release', reservation => hb);
  if not exists (select 1 from private.stock_reservations where id = hb and remaining = 0 and status = 'released'
                   and closed_by = '00000000-0000-0000-0000-0000000000b1' and close_reason = 'manual' and closed_at = now())
     or (select qty from private.stock_movements where id = (r -> 'movement_ids' ->> 0)::bigint) <> 6 then
    raise exception 'FAIL: release all';
  end if;
  perform pg_temp.expect_error(format('select pg_temp.mv(%L, %L, reservation => %L)', '7a000000-0000-0000-0000-000000000003',
    'release', hb), '22023', 'reservation_state');
  -- The lead's owner may release a hold a manager made on the lead.
  perform pg_temp.mv('7a000000-0000-0000-0000-000000000003', 'release', reservation => current_setting('t.ha1')::uuid);
end $$;
-- deal_lost_releases_holds: b1 marks the deal lost the way the app does since Day 5 (move_deal to Closed/lost with a
-- reason; Day 5's guard sets status 'lost'); its holds at both places are released (reason deal_lost, by b1).
do $$
declare
  p constant uuid := '7a000000-0000-0000-0000-000000000003';
begin
  if pg_temp.rv(p, 'warehouse') <> 100 or pg_temp.rv(p, 'transit') <> 50 then
    raise exception 'FAIL: deal holds before: % %', pg_temp.rv(p, 'warehouse'), pg_temp.rv(p, 'transit');
  end if;
  perform public.move_deal('43000000-0000-0000-0000-0000000000b1', 'lost',
    (select version from public.deals where id = '43000000-0000-0000-0000-0000000000b1'), p_lost_reason => 'price');
  if (select status from public.deals where id = '43000000-0000-0000-0000-0000000000b1') <> 'lost' then
    raise exception 'FAIL: deal_lost_releases_holds: move_deal did not lose the deal';
  end if;
  if pg_temp.rv(p, 'warehouse') <> 0 or pg_temp.rv(p, 'transit') <> 0
     or exists (select 1 from private.stock_reservations where deal_id = '43000000-0000-0000-0000-0000000000b1' and status = 'active')
     or (select count(*) from private.stock_reservations where deal_id = '43000000-0000-0000-0000-0000000000b1'
           and status = 'released' and close_reason = 'deal_lost') <> 2
     or (select count(*) from private.stock_movements where kind = 'release' and reason = 'deal_lost'
           and deal_id = '43000000-0000-0000-0000-0000000000b1' and user_id = '00000000-0000-0000-0000-0000000000b1') <> 2 then
    raise exception 'FAIL: deal_lost_releases_holds';
  end if;
  -- A lost deal takes no new hold.
  perform pg_temp.expect_error(format('select pg_temp.mv(%L, %L, %s, company => %L, deal => %L)', p, 'reserve', 5,
    '33000000-0000-0000-0000-0000000000b1', '43000000-0000-0000-0000-0000000000b1'), '22023', 'deal_closed');
end $$;
-- deal_delete_releases_holds: d1 holds for a deal; manager a1 deletes the deal (since Day 5, deleting a deal someone
-- worked on takes a manager or an admin with a fresh code, through delete_deal); the hold is released (deal_deleted, in
-- a1's name) and loses the link.
do $$ begin perform pg_temp.as_user('00000000-0000-0000-0000-0000000000d1', 'aal2', 30); end $$;
do $$
declare
  v_hold uuid;
begin
  v_hold := (pg_temp.mv('7a000000-0000-0000-0000-000000000003', 'reserve', 30, company => '33000000-0000-0000-0000-0000000000d1',
                        deal => '43000000-0000-0000-0000-0000000000d1') ->> 'reservation_id')::uuid;
  perform pg_temp.as_user('00000000-0000-0000-0000-0000000000a1', 'aal2', 30);
  perform public.delete_deal('43000000-0000-0000-0000-0000000000d1');
  if exists (select 1 from public.deals where id = '43000000-0000-0000-0000-0000000000d1')
     or not exists (select 1 from private.stock_reservations where id = v_hold and status = 'released'
                   and close_reason = 'deal_deleted' and deal_id is null)
     or pg_temp.rv('7a000000-0000-0000-0000-000000000003', 'warehouse') <> 0
     or not exists (select 1 from private.stock_movements where reservation_id = v_hold and kind = 'release'
                      and reason = 'deal_deleted' and deal_id = '43000000-0000-0000-0000-0000000000d1'
                      and user_id = '00000000-0000-0000-0000-0000000000a1') then
    raise exception 'FAIL: deal_delete_releases_holds';
  end if;
end $$;
reset role;
-- A deal deleted by a maintenance session (no signed-in user): the release row has no person.
do $$
declare
  main_org uuid := current_setting('t.org')::uuid;
  v_hold uuid;
begin
  perform set_config('request.jwt.claims', '', false);
  insert into public.deals (id, org_id, company_id, stage_id, owner_id)
  values ('43000000-0000-0000-0000-0000000000e9', main_org, '33000000-0000-0000-0000-0000000000a1',
          (select s.id from public.pipeline_stages s where s.org_id = main_org and s.position = 1),
          '00000000-0000-0000-0000-0000000000a1');
  perform pg_temp.as_user('00000000-0000-0000-0000-0000000000a1', 'aal2', 30);
  set local role authenticated;
  v_hold := (pg_temp.mv('7a000000-0000-0000-0000-000000000003', 'reserve', 3, company => '33000000-0000-0000-0000-0000000000a1',
                        deal => '43000000-0000-0000-0000-0000000000e9') ->> 'reservation_id')::uuid;
  reset role;
  perform set_config('request.jwt.claims', '', false);
  delete from public.deals where id = '43000000-0000-0000-0000-0000000000e9';
  if not exists (select 1 from private.stock_movements where reservation_id = v_hold and kind = 'release'
                   and reason = 'deal_deleted' and user_id is null) then
    raise exception 'FAIL: a maintenance deal delete should release its holds as the system';
  end if;
end $$;
-- deal_lost_by_before_trigger_releases_holds: Day 5 moves a deal to Closed/lost through its BEFORE trigger (guard_deal:
-- a stage change to 'lost' with a reason sets status). Until Day 5 merged this used a stand-in trigger; since the merge
-- (15 Oct 2026) it is Day 5's real guard. The update never names status, and the holds still go.
do $$
declare
  main_org uuid := current_setting('t.org')::uuid;
  v_hold uuid;
begin
  perform set_config('request.jwt.claims', '', false);
  insert into public.deals (id, org_id, company_id, stage_id, owner_id)
  values ('43000000-0000-0000-0000-0000000000b5', main_org, '33000000-0000-0000-0000-0000000000b1',
          (select s.id from public.pipeline_stages s where s.org_id = main_org and s.position = 1),
          '00000000-0000-0000-0000-0000000000b1');
  perform pg_temp.as_user('00000000-0000-0000-0000-0000000000b1', 'aal2', 30);
  set local role authenticated;
  v_hold := (pg_temp.mv('7a000000-0000-0000-0000-000000000003', 'reserve', 3, company => '33000000-0000-0000-0000-0000000000b1',
                        deal => '43000000-0000-0000-0000-0000000000b5') ->> 'reservation_id')::uuid;
  update public.deals set stage_id = (select s.id from public.pipeline_stages s where s.org_id = main_org and s.key = 'lost'),
                          lost_reason = 'price'
   where id = '43000000-0000-0000-0000-0000000000b5';
  reset role;
  if (select status from public.deals where id = '43000000-0000-0000-0000-0000000000b5') is distinct from 'lost'
     or not exists (select 1 from private.stock_reservations where id = v_hold and status = 'released'
                      and close_reason = 'deal_lost' and remaining = 0) then
    raise exception 'FAIL: deal_lost_by_before_trigger_releases_holds (a status set by a BEFORE trigger kept the hold)';
  end if;
  perform set_config('request.jwt.claims', '', false);
end $$;
-- expired_hold_released_before_write and expire_rows_have_no_user: P6 has 300 on hand, all held; one hold ended
-- yesterday. A correction that needs that room succeeds because the RPC ends the hold first.
set role authenticated;
do $$ begin perform pg_temp.as_user('00000000-0000-0000-0000-0000000000b1', 'aal2', 30); end $$;
do $$
begin
  perform set_config('t.e1', pg_temp.mv('7a000000-0000-0000-0000-000000000006', 'reserve', 100,
    company => '33000000-0000-0000-0000-0000000000b1') ->> 'reservation_id', false);
  perform set_config('t.e2', pg_temp.mv('7a000000-0000-0000-0000-000000000006', 'reserve', 100,
    company => '33000000-0000-0000-0000-0000000000b1') ->> 'reservation_id', false);
  perform set_config('t.e3', pg_temp.mv('7a000000-0000-0000-0000-000000000006', 'reserve', 100,
    company => '33000000-0000-0000-0000-0000000000b1') ->> 'reservation_id', false);
end $$;
reset role;
update private.stock_reservations set hold_until = current_date - 1 where id = current_setting('t.e1')::uuid;
set role authenticated;
do $$ begin perform pg_temp.as_user('00000000-0000-0000-0000-00000000000a', 'aal2', 30); end $$;
do $$
declare
  e1 constant uuid := current_setting('t.e1')::uuid;
begin
  perform pg_temp.mv('7a000000-0000-0000-0000-000000000006', 'adjust_out', 50, reason => 'damaged');
  if not exists (select 1 from private.stock_reservations where id = e1 and status = 'expired' and close_reason = 'expired'
                   and remaining = 0 and closed_by is null)
     or not exists (select 1 from private.stock_movements where reservation_id = e1 and kind = 'expire' and reason = 'expired'
                      and user_id is null and d_reserved = -100)
     or pg_temp.oh('7a000000-0000-0000-0000-000000000006', 'warehouse') <> 250
     or pg_temp.rv('7a000000-0000-0000-0000-000000000006', 'warehouse') <> 200 then
    raise exception 'FAIL: expired_hold_released_before_write';
  end if;
end $$;
-- sweep_throttled_once_a_minute: the page-load sweep ends due holds once a minute per organisation.
reset role;
update private.stock_reservations set hold_until = current_date - 1 where id = current_setting('t.e2')::uuid;
update private.inventory_settings set last_sweep_at = null where org_id = current_setting('t.org')::uuid;
set role authenticated;
do $$ begin perform pg_temp.as_user('00000000-0000-0000-0000-0000000000d1', 'aal2', 30); end $$;
do $$ begin
  if public.release_expired_reservations() <> 1 then raise exception 'FAIL: the first sweep should end one hold'; end if;
end $$;
reset role;
update private.stock_reservations set hold_until = current_date - 1 where id = current_setting('t.e3')::uuid;
set role authenticated;
do $$ begin
  if public.release_expired_reservations() <> 0 then raise exception 'FAIL: a second sweep within a minute should do nothing'; end if;
end $$;
reset role;
update private.inventory_settings set last_sweep_at = now() - interval '61 seconds' where org_id = current_setting('t.org')::uuid;
set role authenticated;
do $$ begin
  if public.release_expired_reservations() <> 1 then raise exception 'FAIL: the sweep after a minute should end the hold'; end if;
  if exists (select 1 from private.stock_reservations where id in (current_setting('t.e2')::uuid, current_setting('t.e3')::uuid)
               and status <> 'expired') then
    raise exception 'FAIL: sweep_throttled_once_a_minute';
  end if;
end $$;
-- Hold length: today + hold_days (14 seeded, 7 after an admin changes it); a hold may end today.
do $$ begin perform pg_temp.as_user('00000000-0000-0000-0000-00000000000a', 'aal2', 30); end $$;
do $$
declare
  r jsonb;
begin
  update private.inventory_settings set hold_days = 7;
  r := pg_temp.mv('7a000000-0000-0000-0000-000000000006', 'reserve', 1, company => '33000000-0000-0000-0000-0000000000a1');
  if (select hold_until from private.stock_reservations where id = (r ->> 'reservation_id')::uuid) <> current_date + 7 then
    raise exception 'FAIL: hold length from settings';
  end if;
  perform pg_temp.expect_ok($q$select pg_temp.mv('7a000000-0000-0000-0000-000000000006', 'reserve', 1,
    company => '33000000-0000-0000-0000-0000000000a1', hold_until => current_date)$q$);
  update private.inventory_settings set hold_days = 14;
end $$;
reset role;

-- 7. Other rules -------------------------------------------------------------------------------------------------------
-- idempotent_request_id: a retry returns the first answer and writes nothing; a request id is per person and per kind.
set role authenticated;
do $$ begin perform pg_temp.as_user('00000000-0000-0000-0000-00000000000a', 'aal2', 30); end $$;
do $$
declare
  req constant uuid := 'c0ffee00-0000-0000-0000-000000000002';
  r1 jsonb;
  r2 jsonb;
  n integer;
begin
  r1 := pg_temp.mv('7a000000-0000-0000-0000-000000000009', 'receive', 10, reason => 'received', request => req);
  select count(*) into n from private.stock_movements where product_id = '7a000000-0000-0000-0000-000000000009';
  r2 := pg_temp.mv('7a000000-0000-0000-0000-000000000009', 'receive', 10, reason => 'received', request => req);
  if r2 is distinct from r1 or pg_temp.oh('7a000000-0000-0000-0000-000000000009', 'warehouse') <> 10
     or (select count(*) from private.stock_movements where product_id = '7a000000-0000-0000-0000-000000000009') <> n then
    raise exception 'FAIL: idempotent_request_id: % / %', r1, r2;
  end if;
  perform pg_temp.expect_error(format('select pg_temp.mv(%L, %L, %s, reason => %L, request => %L)',
    '7a000000-0000-0000-0000-000000000009', 'adjust_in', 10, 'found', req), '22023', 'request');
end $$;
do $$ begin perform pg_temp.as_user('00000000-0000-0000-0000-0000000000b1', 'aal2', 30); end $$;
do $$ begin
  -- b1's own request ids are separate from a's; b1 sees only b1's idempotency rows.
  perform pg_temp.mv('7a000000-0000-0000-0000-000000000009', 'reserve', 1, company => '33000000-0000-0000-0000-0000000000b1',
                     request => 'c0ffee00-0000-0000-0000-000000000002');
  if exists (select 1 from private.movement_requests where user_id <> '00000000-0000-0000-0000-0000000000b1') then
    raise exception 'FAIL: a person sees another person''s request ids';
  end if;
end $$;
-- stock_rate_guard_121st_refused: rep e1 makes 120 holds in a minute; the 121st is refused.
do $$ begin perform pg_temp.as_user('00000000-0000-0000-0000-0000000000e1', 'aal2', 30); end $$;
do $$
begin
  for i in 1..120 loop
    perform pg_temp.mv('7a000000-0000-0000-0000-000000000007', 'reserve', 1, company => '33000000-0000-0000-0000-0000000000e1');
  end loop;
  perform pg_temp.expect_error($q$select pg_temp.mv('7a000000-0000-0000-0000-000000000007', 'reserve', 1,
    company => '33000000-0000-0000-0000-0000000000e1')$q$, '22023', 'rate_limited');
end $$;
-- rate_guard_skips_deal_lost_releases: manager g (a new person) posts 119 rows in a minute (a receipt and 118 holds for
-- one deal), then loses the deal: the system writes 118 release rows in g's name. They do not count, so g's 120th row
-- passes and only the 121st is refused.
reset role;
do $$
declare
  main_org uuid := current_setting('t.org')::uuid;
begin
  perform set_config('request.jwt.claims', '', false);
  insert into auth.users (id, email) values ('00000000-0000-0000-0000-000000000521', 'stock-g@test.invalid');
  update public.profiles set role = 'manager' where id = '00000000-0000-0000-0000-000000000521';
  insert into public.products (id, org_id, name, pieces_per_carton)
  values ('7a000000-0000-0000-0000-0000000000a6', main_org, 'Stock test a6', 48);
  insert into public.deals (id, org_id, company_id, stage_id, owner_id)
  values ('43000000-0000-0000-0000-0000000000e2', main_org, '33000000-0000-0000-0000-0000000000e1',
          (select s.id from public.pipeline_stages s where s.org_id = main_org and s.position = 1),
          '00000000-0000-0000-0000-000000000521');
end $$;
set role authenticated;
do $$ begin perform pg_temp.as_user('00000000-0000-0000-0000-000000000521', 'aal2', 30); end $$;
do $$
declare
  p constant uuid := '7a000000-0000-0000-0000-0000000000a6';
begin
  perform pg_temp.mv(p, 'receive', 500, reason => 'received');
  for i in 1..118 loop
    perform pg_temp.mv(p, 'reserve', 1, company => '33000000-0000-0000-0000-0000000000e1',
                       deal => '43000000-0000-0000-0000-0000000000e2');
  end loop;
  update public.deals set stage_id = (select s.id from public.pipeline_stages s join public.deals d on d.org_id = s.org_id
                                       where d.id = '43000000-0000-0000-0000-0000000000e2' and s.key = 'lost'),
                          lost_reason = 'price'
   where id = '43000000-0000-0000-0000-0000000000e2';
  if (select count(*) from private.stock_movements where kind = 'release' and reason = 'deal_lost'
        and user_id = '00000000-0000-0000-0000-000000000521') <> 118 or pg_temp.rv(p, 'warehouse') <> 0 then
    raise exception 'FAIL: rate_guard_skips_deal_lost_releases: the deal''s holds were not released in g''s name';
  end if;
  perform pg_temp.mv(p, 'reserve', 1, company => '33000000-0000-0000-0000-0000000000e1');   -- g's 120th row
  perform pg_temp.expect_error($q$select pg_temp.mv('7a000000-0000-0000-0000-0000000000a6', 'reserve', 1,
    company => '33000000-0000-0000-0000-0000000000e1')$q$, '22023', 'rate_limited');
exception when sqlstate '22023' then
  raise exception 'FAIL: rate_guard_skips_deal_lost_releases: a row of g''s was refused: %', sqlerrm;
end $$;
-- other_org_product_not_found: the other organisation finds none of this (P0002 on every RPC), sees none of it, and its
-- places cannot be used for this org's products.
do $$ begin perform pg_temp.as_user('00000000-0000-0000-0000-0000000000c1', 'aal2', 30); end $$;
do $$
declare
  s text;
begin
  foreach s in array array[
    $q$select pg_temp.mv('7a000000-0000-0000-0000-000000000001', 'receive', 1, reason => 'received')$q$,
    $q$select pg_temp.mv('7a000000-0000-0000-0000-000000000001', 'adjust_out', 1, reason => 'lost')$q$,
    $q$select pg_temp.mv('7a000000-0000-0000-0000-000000000001', 'count', target => 0)$q$,
    $q$select pg_temp.mv('7a000000-0000-0000-0000-000000000002', 'transfer', 1)$q$,
    $q$select pg_temp.mv('7a000000-0000-0000-0000-000000000003', 'reserve', 1, company => '33000000-0000-0000-0000-0000000000c1')$q$,
    $q$select public.update_product('7a000000-0000-0000-0000-000000000001', 'Taken over', 12)$q$,
    $q$select public.set_product_cost('7a000000-0000-0000-0000-000000000001', 1)$q$,
    $q$select public.archive_product('7a000000-0000-0000-0000-000000000009')$q$,
    $q$select public.restore_product('7a000000-0000-0000-0000-0000000000f0')$q$] loop
    perform pg_temp.expect_error(s, 'P0002');
  end loop;
  perform pg_temp.expect_error(format('select pg_temp.mv(%L, %L, reservation => %L)', '7a000000-0000-0000-0000-000000000003',
    'release', current_setting('t.ha1')), 'P0002');
  perform pg_temp.expect_error($q$insert into private.stock_movements (group_id, product_id, location_id, kind, qty, reason)
    values (gen_random_uuid(), 'cc000000-0000-0000-0000-000000000001', current_setting('t.wh')::uuid, 'receive', 1,
    'received')$q$, '22023', 'location');
  if exists (select 1 from public.products where org_id <> '00000000-0000-0000-0000-0000000000cc')
     or exists (select 1 from public.stock_levels where org_id <> '00000000-0000-0000-0000-0000000000cc')
     or exists (select 1 from private.stock_movements where org_id <> '00000000-0000-0000-0000-0000000000cc')
     or exists (select 1 from private.stock_reservations where org_id <> '00000000-0000-0000-0000-0000000000cc')
     or exists (select 1 from private.product_costs where org_id <> '00000000-0000-0000-0000-0000000000cc')
     or exists (select 1 from private.inventory_settings where org_id <> '00000000-0000-0000-0000-0000000000cc')
     or exists (select 1 from public.locations where org_id <> '00000000-0000-0000-0000-0000000000cc') then
    raise exception 'FAIL: the other org sees this org''s stock';
  end if;
  -- Its own stock works, and a name used in another org is free here (unique per org).
  perform pg_temp.mv('cc000000-0000-0000-0000-000000000001', 'receive', 24, reason => 'received');
  perform pg_temp.expect_ok($q$select public.create_product('Stock test 02', 12)$q$);
  perform pg_temp.integrity_clean('the other org', '00000000-0000-0000-0000-0000000000c1');
end $$;
-- movement_audit_minimal: one minimal audit row per ledger row; the note's text is never copied.
do $$ begin perform pg_temp.as_user('00000000-0000-0000-0000-00000000000a', 'aal2', 30); end $$;
do $$
declare
  r jsonb;
  a jsonb;
begin
  r := pg_temp.mv('7a000000-0000-0000-0000-000000000008', 'adjust_out', 3, reason => 'other', note => 'MARK4 broken in the van');
  select diff_json into a from public.audit_log
   where table_name = 'stock_movements' and record_id = r -> 'movement_ids' ->> 0;
  if (select array_agg(k order by k) from jsonb_object_keys(a) k)
     is distinct from array['d_on_hand', 'd_reserved', 'kind', 'location_id', 'note_len', 'product_id', 'reason', 'refs']
     or a ->> 'kind' is distinct from 'adjust_out' or (a ->> 'd_on_hand')::int is distinct from -3
     or (a ->> 'note_len')::int is distinct from char_length('MARK4 broken in the van')
     or a -> 'refs' ->> 'group_id' is distinct from r ->> 'group_id' or strpos(a::text, 'MARK4') > 0 then
    raise exception 'FAIL: movement_audit_minimal: %', a;
  end if;
  if (select count(*) from private.stock_movements)
     is distinct from (select count(*) from public.audit_log where table_name = 'stock_movements') then
    raise exception 'FAIL: every ledger row needs its audit row';
  end if;
  -- Settings and costs are audited by product or organisation; a sweep time alone writes nothing.
  update private.inventory_settings set hold_days = 21;
  update private.inventory_settings set hold_days = 14;
  if (select count(*) from public.audit_log where table_name = 'inventory_settings' and record_id = current_setting('t.org')
        and diff_json ? 'hold_days') < 2 then
    raise exception 'FAIL: settings changes should be audited';
  end if;
  if not exists (select 1 from public.audit_log where table_name = 'product_costs' and record_id = current_setting('t.pm')) then
    raise exception 'FAIL: cost changes should be audited by product';
  end if;
end $$;
reset role;
do $$
declare
  n bigint := (select count(*) from public.audit_log where table_name = 'inventory_settings');
begin
  update private.inventory_settings set last_sweep_at = now() where org_id = current_setting('t.org')::uuid;
  if (select count(*) from public.audit_log where table_name = 'inventory_settings') <> n then
    raise exception 'FAIL: a sweep alone should not be audited';
  end if;
end $$;
-- The lock-ordered fields (D5): a stock sheet (6c) marks a level as set by an import; a hold keeps that mark, a CRM change
-- of on hand clears it. Simulated here by the owner, as 6c's import would leave it.
update public.stock_levels set crm_moved = false, last_onhand_batch_id = '90000000-0000-0000-0000-00000000000a'
 where product_id = '7a000000-0000-0000-0000-000000000008' and location_id = current_setting('t.wh')::uuid;
set role authenticated;
do $$ begin perform pg_temp.as_user('00000000-0000-0000-0000-00000000000a', 'aal2', 30); end $$;
do $$
declare
  v_hold uuid;
begin
  v_hold := (pg_temp.mv('7a000000-0000-0000-0000-000000000008', 'reserve', 5, company => '33000000-0000-0000-0000-0000000000a1') ->> 'reservation_id')::uuid;
  perform pg_temp.mv('7a000000-0000-0000-0000-000000000008', 'release', reservation => v_hold);
  if (select crm_moved::text || ':' || coalesce(last_onhand_batch_id::text, '-') from public.stock_levels
       where product_id = '7a000000-0000-0000-0000-000000000008' and location_id = current_setting('t.wh')::uuid)
     is distinct from 'false:90000000-0000-0000-0000-00000000000a' then
    raise exception 'FAIL: holds must not mark a level as moved in the CRM';
  end if;
  perform pg_temp.mv('7a000000-0000-0000-0000-000000000008', 'adjust_in', 1, reason => 'found');
  if (select crm_moved::text || ':' || coalesce(last_onhand_batch_id::text, '-') from public.stock_levels
       where product_id = '7a000000-0000-0000-0000-000000000008' and location_id = current_setting('t.wh')::uuid)
     is distinct from 'true:-' then
    raise exception 'FAIL: a CRM change of on hand must mark the level as moved';
  end if;
end $$;
-- Settings: admins only; the alert assignee must be in the org.
do $$
declare
  n integer;
begin
  perform pg_temp.expect_error($q$update private.inventory_settings set alert_assignee_id = '00000000-0000-0000-0000-0000000000c1'$q$, '22023', 'assignee');
  update private.inventory_settings set alert_assignee_id = '00000000-0000-0000-0000-0000000000b1';
  get diagnostics n = row_count;
  if n <> 1 then raise exception 'FAIL: an admin should change the settings'; end if;
  perform pg_temp.expect_ok($q$update public.locations set name = 'Entrepôt Lyon' where kind = 'warehouse'$q$);
  perform pg_temp.expect_error($q$update public.locations set kind = 'transit'$q$, '42501');
end $$;
do $$ begin perform pg_temp.as_user('00000000-0000-0000-0000-0000000000a1', 'aal2', 30); end $$;
do $$
declare
  n integer;
begin
  -- 6e: managers may reach the row (to switch sharing off); the guard refuses every other setting.
  perform pg_temp.expect_error($q$update private.inventory_settings set hold_days = 30$q$, '42501', 'forbidden');
  update public.locations set name = 'Renamed by manager';
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'FAIL: a manager renamed a place'; end if;
  -- Managers read and write costs for their org's products (and a cost row needs a product of the org).
  insert into private.product_costs (product_id, cost_per_piece, source) values ('7a000000-0000-0000-0000-000000000001', 0.75, 'manual');
  perform pg_temp.expect_error($q$insert into private.product_costs (product_id, cost_per_piece, source)
    values ('cc000000-0000-0000-0000-000000000001', 0.75, 'manual')$q$, '42501');
end $$;
-- lead_delete_blocked_by_stock_history: a lead with holds (even released ones) is kept.
do $$ begin perform pg_temp.as_user('00000000-0000-0000-0000-00000000000a', 'aal2', 30); end $$;
do $$ begin
  perform pg_temp.expect_error($q$delete from public.companies where id = '33000000-0000-0000-0000-0000000000d1'$q$, '23503');
end $$;
-- lead_import_untouched_counts_stock: undoing an import keeps a lead that has a hold.
do $$
declare
  batch uuid;
  r jsonb;
begin
  batch := public.create_lead_import('day6a-hold.csv', null, 2, 3);
  perform public.stage_lead_import_rows(batch, '[{"row_no": 2, "name": "Day6a Import One", "lead_status": "cold"},
                                                 {"row_no": 3, "name": "Day6a Import Two", "lead_status": "cold"}]');
  perform public.validate_lead_import(batch);
  r := public.commit_lead_import(batch);
  if r ->> 'status' is distinct from 'imported' then raise exception 'FAIL: import %', r; end if;
  perform pg_temp.mv('7a000000-0000-0000-0000-000000000009', 'reserve', 1,
                     company => (select id from public.companies where import_batch_id = batch and name = 'Day6a Import One'));
  r := public.preview_lead_import_rollback(batch);
  if r is distinct from '{"tagged": 2, "removable": 1, "kept": 1}'::jsonb then raise exception 'FAIL: undo preview with a hold %', r; end if;
  r := public.rollback_lead_import(batch);
  if r ->> 'status' is distinct from 'rolled_back' or (r ->> 'kept')::integer is distinct from 1
     or not exists (select 1 from public.companies where import_batch_id = batch and name = 'Day6a Import One')
     or exists (select 1 from public.companies where import_batch_id = batch and name = 'Day6a Import Two') then
    raise exception 'FAIL: lead_import_untouched_counts_stock: %', r;
  end if;
end $$;
reset role;
-- nightly_stock_jobs: run as the system (no claims): ends due holds, opens one task a day when the checks find a
-- difference, prunes old request ids; refuses a session with claims.
update private.stock_reservations set hold_until = current_date - 1
 where id = (select id from private.stock_reservations where product_id = '7a000000-0000-0000-0000-000000000007'
              and status = 'active' order by id limit 1);
do $$
begin
  alter table private.movement_requests disable trigger movement_request_guard;
  insert into private.movement_requests (user_id, request_id, kind, created_at)
  values ('00000000-0000-0000-0000-00000000000a', gen_random_uuid(), 'receive', now() - interval '8 days');
  alter table private.movement_requests enable trigger movement_request_guard;
end $$;
do $$
declare
  r jsonb;
begin
  perform set_config('request.jwt.claims', '', false);
  r := private.nightly_stock_jobs();
  if (r ->> 'expired')::int <> 1 or (r ->> 'integrity_rows')::int <> 0 or (r ->> 'tasks')::int <> 0
     or (r ->> 'requests_pruned')::int <> 1 then
    raise exception 'FAIL: nightly_stock_jobs: %', r;
  end if;
  -- A difference (made by the owner here) opens one task for the alert assignee (rep b1, set above), once a day.
  update public.stock_levels set on_hand = on_hand + 1
   where product_id = '7a000000-0000-0000-0000-000000000005' and location_id = current_setting('t.wh')::uuid;
  r := private.nightly_stock_jobs();
  if (r ->> 'integrity_rows')::int < 1 or (r ->> 'tasks')::int <> 1 then raise exception 'FAIL: nightly with a difference: %', r; end if;
  -- integrity_rows_ignore_client_org: a signed-in admin who passes another organisation's id still gets their own
  -- organisation's rows (the difference just made), never the other one's; only postgres chooses the organisation.
  perform pg_temp.as_user('00000000-0000-0000-0000-00000000000a', 'aal2', 30);
  set local role authenticated;
  if (select count(*) from private.stock_integrity_rows('00000000-0000-0000-0000-0000000000cc')) < 1
     or exists (select 1 from private.stock_integrity_rows('00000000-0000-0000-0000-0000000000cc') x
                 where x.product_id is distinct from '7a000000-0000-0000-0000-000000000005') then
    raise exception 'FAIL: integrity_rows_ignore_client_org';
  end if;
  reset role;
  perform set_config('request.jwt.claims', '', false);
  r := private.nightly_stock_jobs();
  if (r ->> 'tasks')::int <> 0 then raise exception 'FAIL: a second task the same day: %', r; end if;
  if (select count(*) from public.tasks where title = 'Stock check found a difference' and created_by is null
        and assignee_id = '00000000-0000-0000-0000-0000000000b1' and kind = 'todo') <> 1 then
    raise exception 'FAIL: the integrity task';
  end if;
  update public.stock_levels set on_hand = on_hand - 1
   where product_id = '7a000000-0000-0000-0000-000000000005' and location_id = current_setting('t.wh')::uuid;
  perform pg_temp.as_user('00000000-0000-0000-0000-00000000000a', 'aal2', 30);
  perform pg_temp.expect_error('select private.nightly_stock_jobs()', '42501');
  perform set_config('request.jwt.claims', '', false);
end $$;

-- 8. integrity_after_random_ops: 1,000 random operations, valid and not, across 5 products, 3 leads and 2 deals, by 20
-- managers (so the rate guard never trips), each in its own subtransaction; then the checks find nothing and the
-- ledger replays to the levels. -----------------------------------------------------------------------------------------
set role authenticated;
do $$
declare
  kinds constant text[] := array['receive', 'adjust_in', 'adjust_out', 'count', 'transfer', 'reserve', 'reserve',
                                 'release', 'release', 'reserve_deal', 'deal_lost', 'deal_open', 'bad_qty'];
  leads constant uuid[] := array['33000000-0000-0000-0000-0000000000a1', '33000000-0000-0000-0000-0000000000b1',
                                 '33000000-0000-0000-0000-0000000000d1']::uuid[];
  rdeals constant uuid[] := array['43000000-0000-0000-0000-0000000000f1', '43000000-0000-0000-0000-0000000000f2']::uuid[];
  deal_leads constant uuid[] := array['33000000-0000-0000-0000-0000000000b1', '33000000-0000-0000-0000-0000000000d1']::uuid[];
  k text;
  p uuid;
  place text;
  q integer;
  di integer;
  h uuid;
  ok integer := 0;
  refused integer := 0;
  by_kind jsonb := '{}';
begin
  perform setseed(0.6);
  for i in 0..999 loop
    perform pg_temp.as_user('00000000-0000-0000-0000-0000000005' || lpad((i % 20 + 1)::text, 2, '0'), 'aal2', 30);
    k := kinds[1 + floor(random() * array_length(kinds, 1))::int];
    p := ('7a000000-0000-0000-0000-0000000000a' || (1 + floor(random() * 5))::int)::uuid;
    place := case when random() < 0.7 then 'warehouse' else 'transit' end;
    q := 1 + floor(random() * 120)::int;
    di := 1 + floor(random() * 2)::int;
    begin
      case k
        when 'receive' then perform pg_temp.mv(p, 'receive', q, place, 'received');
        when 'adjust_in' then perform pg_temp.mv(p, 'adjust_in', q, place, 'found');
        when 'adjust_out' then perform pg_temp.mv(p, 'adjust_out', q, place, 'damaged');
        when 'count' then perform pg_temp.mv(p, 'count', place => place, target => floor(random() * 600)::int);
        when 'transfer' then perform pg_temp.mv(p, 'transfer', q);
        when 'reserve' then perform pg_temp.mv(p, 'reserve', q, place, company => leads[1 + floor(random() * 3)::int]);
        when 'reserve_deal' then perform pg_temp.mv(p, 'reserve', q, place, company => deal_leads[di], deal => rdeals[di]);
        when 'release' then
          select r.id into h from private.stock_reservations r where r.product_id = p and r.status = 'active'
           order by random() limit 1;
          perform pg_temp.mv(p, 'release', case when random() < 0.5 then null else q end, reservation => h);
        -- Day 5's way (guard_deal): lose with a stage change and a reason; reopen with a stage change back to Lead.
        when 'deal_lost' then
          update public.deals d
             set stage_id = (select s.id from public.pipeline_stages s where s.org_id = d.org_id and s.key = 'lost'),
                 lost_reason = 'price'
           where d.id = rdeals[di];
        when 'deal_open' then
          update public.deals d
             set stage_id = (select s.id from public.pipeline_stages s where s.org_id = d.org_id and s.key = 'lead')
           where d.id = rdeals[di];
        else perform pg_temp.mv(p, 'adjust_in', 0, place, 'found');
      end case;
      ok := ok + 1;
      by_kind := jsonb_set(by_kind, array[k], to_jsonb(coalesce((by_kind ->> k)::int, 0) + 1));
    exception when sqlstate '22023' or sqlstate 'P0002' or sqlstate '42501' then
      refused := refused + 1;
    end;
  end loop;
  if ok < 400 or refused < 50 or (select count(*) from jsonb_object_keys(by_kind)) < 9 then
    raise exception 'FAIL: the random operations did not exercise the engine: % ok, % refused, %', ok, refused, by_kind;
  end if;
  raise notice 'integrity_after_random_ops: % applied, % refused (constant errors), by kind %', ok, refused, by_kind;
  perform pg_temp.as_user('00000000-0000-0000-0000-00000000000a', 'aal2', 30);
  perform pg_temp.integrity_clean('1,000 random operations');
end $$;

-- 9. ledger_sums_match_levels in every organisation --------------------------------------------------------------------
do $$ begin perform pg_temp.as_user('00000000-0000-0000-0000-00000000000a', 'aal2', 30); end $$;
do $$ begin perform pg_temp.integrity_clean('the stock attack test'); end $$;
do $$ begin perform pg_temp.integrity_clean('the other org', '00000000-0000-0000-0000-0000000000c1'); end $$;
reset role;
do $$
declare
  o record;
begin
  perform set_config('request.jwt.claims', '', false);
  for o in select id from public.orgs loop
    if exists (select 1 from private.stock_integrity_rows(o.id)) then
      raise exception 'FAIL: ledger_sums_match_levels in org %', o.id;
    end if;
  end loop;
end $$;

\echo 'stock_attack: all checks passed'
