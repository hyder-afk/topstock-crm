-- Day 6b attack and behaviour tests: the inventory reads (design docs/evidence/day6/design.md sections 3.2, 5.2 and
-- 10.1; migration 20261017090000_inventory_reads.sql). Runs after stock_attack.sql on the same database
-- (scripts/db-test.sh, CI job "db"), reusing its users: admin a, manager a1, rep b1, other-org admin c1. Its own
-- products carry the category "Inv6b" (or the name prefix "Inv6b"), so the counts below never depend on what earlier
-- files left. Any failure raises an exception and stops the run. Checks compare with IS DISTINCT FROM. The file ends with
-- ledger_sums_match_levels.
\set ON_ERROR_STOP 1
\set QUIET 1

-- The app's day. The guards compare dates with the Paris day ((now() at time zone 'Europe/Paris')::date), so every date
-- this file checks against them is built from it too, never from current_date (the session's time zone: UTC on the
-- runners, a day behind Paris from 22:00 or 23:00 UTC). The suite then passes under any PGTZ, at any hour.
create function pg_temp.paris_today() returns date language sql stable as $$
  select (now() at time zone 'Europe/Paris')::date
$$;

-- Helpers (the same as stock_attack.sql) --------------------------------------------------------------------------------
create function pg_temp.as_user(sub text, aal text, totp_age_s integer default null) returns void
language sql as $$
  select set_config('request.jwt.claims', jsonb_build_object(
    'sub', sub, 'role', 'authenticated', 'aal', aal,
    'amr', case when totp_age_s is null then '[]'::jsonb else jsonb_build_array(
      jsonb_build_object('method', 'totp', 'timestamp', extract(epoch from now())::bigint - totp_age_s)) end
  )::text, false)
$$;
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
create function pg_temp.mv(p uuid, kind text, qty integer default null, place text default null,
                           reason text default null, company uuid default null, target integer default null)
returns jsonb language sql as $$
  select public.post_stock_movement(p_product => p, p_kind => kind, p_qty => qty, p_location => place,
                                    p_reason => reason, p_company => company, p_target => target)
$$;
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

-- 1. Catalog: every new RPC is invoker, sets search_path = '', and only authenticated may execute it ---------------------
do $$
declare
  f record;
  n integer := 0;
begin
  for f in select p.oid, p.proname, p.prosecdef, p.proconfig from pg_proc p join pg_namespace s on s.oid = p.pronamespace
            where s.nspname = 'public' and p.proname in ('list_stock', 'count_stock', 'stock_summary', 'get_product',
              'list_movements', 'list_reservations', 'get_inventory_settings', 'update_inventory_settings',
              'rename_location', 'set_product_eta', 'set_product_share_visible') loop
    n := n + 1;
    if f.prosecdef then
      raise exception 'FAIL: % is SECURITY DEFINER', f.proname;
    end if;
    if f.proconfig is null or not ('search_path=""' = any (f.proconfig)) then
      raise exception 'FAIL: % does not set search_path = ''''', f.proname;
    end if;
    if has_function_privilege('anon', f.oid, 'execute') or has_function_privilege('public', f.oid, 'execute') then
      raise exception 'FAIL: anon or public may execute %', f.proname;
    end if;
    if not has_function_privilege('authenticated', f.oid, 'execute') then
      raise exception 'FAIL: authenticated cannot execute %', f.proname;
    end if;
    -- Static SQL only (design 3.0): no format() and no EXECUTE in the body.
    if pg_get_functiondef(f.oid) ~* '(\mformat\s*\(|\mexecute\M)' then
      raise exception 'FAIL: % builds SQL at run time', f.proname;
    end if;
  end loop;
  if n <> 11 then
    raise exception 'FAIL: expected 11 inventory read RPCs, found %', n;
  end if;
  -- The view is invoker (row level security of the caller) and nobody but authenticated reads it.
  if not exists (select 1 from pg_class c join pg_namespace s on s.oid = c.relnamespace
                  where s.nspname = 'private' and c.relname = 'stock_rows'
                    and c.reloptions @> array['security_invoker=true']) then
    raise exception 'FAIL: private.stock_rows is not security_invoker';
  end if;
  if has_table_privilege('anon', 'private.stock_rows', 'select') then
    raise exception 'FAIL: anon reads private.stock_rows';
  end if;
  if has_table_privilege('authenticated', 'private.stock_rows', 'insert')
     or has_table_privilege('authenticated', 'private.stock_rows', 'update') then
    raise exception 'FAIL: authenticated may write through private.stock_rows';
  end if;
end $$;

-- Fixtures: a manager of its own (m6, so the per-person rate guard never meets earlier files' rows), then 30 products in
-- category "Inv6b" through the RPCs (m6, fresh code), with stock in set patterns -----------------------------------------
do $$ begin perform set_config('request.jwt.claims', '', false); end $$;
insert into auth.users (id, email, raw_user_meta_data)
values ('00000000-0000-0000-0000-0000000006a1', 'inv-m6@test.invalid', '{"first_name":"Mia"}');
update public.profiles set role = 'manager' where id = '00000000-0000-0000-0000-0000000006a1';
set role authenticated;
do $$
declare
  ids uuid[] := '{}';
  p uuid;
begin
  perform pg_temp.as_user('00000000-0000-0000-0000-0000000006a1', 'aal2', 30);
  for i in 1..30 loop
    p := public.create_product(
      p_name => 'Inv6b ' || case when i = 7 then 'Sac 100%_jute' else 'Produit ' || lpad(i::text, 2, '0') end,
      p_pieces_per_carton => 12, p_price_min => 1.5, p_price_max => 2.5, p_category => 'Inv6b',
      p_reorder_point => case when i <= 5 then 50 end, p_cost_per_piece => 0.8,
      p_opening_qty => case when i <= 20 then i * 10 end,                     -- 1..20 in the warehouse
      p_opening_location => 'warehouse');
    ids := ids || p;
  end loop;
  -- 21..25 in transit only (arriving), 26..30 sold out (nothing anywhere); 3 and 4 hidden from clients.
  for i in 21..25 loop
    perform pg_temp.mv(ids[i], 'receive', 100, 'transit', 'received');
  end loop;
  perform public.set_product_share_visible(ids[3], false);
  perform public.set_product_share_visible(ids[4], false);
  -- 8 holds 30 of its 80 for lead LA; 22 holds 40 of its 100 in transit for LA.
  perform pg_temp.mv(ids[8], 'reserve', 30, 'warehouse', company => '33000000-0000-0000-0000-0000000000a1');
  perform pg_temp.mv(ids[22], 'reserve', 40, 'transit', company => '33000000-0000-0000-0000-0000000000a1');
  perform set_config('t.inv', array_to_string(ids, ','), false);
end $$;

-- 2. Access: aal1 and no session refused on every read; the other organisation sees none of it ---------------------------
do $$
declare
  ids constant uuid[] := string_to_array(current_setting('t.inv'), ',')::uuid[];
  stmt text;
begin
  perform pg_temp.as_user('00000000-0000-0000-0000-0000000000a1', 'aal1');
  foreach stmt in array array[
    'select * from public.list_stock()', 'select public.count_stock()', 'select public.stock_summary()',
    format('select public.get_product(%L)', ids[1]), 'select * from public.list_movements()',
    'select * from public.list_reservations()', 'select public.get_inventory_settings()',
    format('select public.set_product_eta(%L, pg_temp.paris_today())', ids[1]),
    format('select public.set_product_share_visible(%L, true)', ids[1])] loop
    perform pg_temp.expect_error(stmt, '42501', 'forbidden');
  end loop;
  perform set_config('request.jwt.claims', '', false);
  perform pg_temp.expect_error('select * from public.list_stock()', '42501', 'forbidden');
  -- c1 (other org, admin): its own (empty) world only; a product id of this org is "not found".
  perform pg_temp.as_user('00000000-0000-0000-0000-0000000000c1', 'aal2', 30);
  if exists (select 1 from public.list_stock(p_filter => 'all', p_limit => 200) s where s.id = any (ids)) then
    raise exception 'FAIL: the other org lists this org''s products';
  end if;
  if public.count_stock(p_category => 'Inv6b') <> 0 then
    raise exception 'FAIL: the other org counts this org''s products';
  end if;
  perform pg_temp.expect_error(format('select public.get_product(%L)', ids[1]), 'P0002');
  if exists (select 1 from public.list_movements(p_limit => 100) m where m.product_id = any (ids))
     or exists (select 1 from public.list_reservations(p_status => 'all', p_limit => 100) r where r.product_id = any (ids)) then
    raise exception 'FAIL: the other org reads this org''s movements or holds';
  end if;
  perform pg_temp.expect_error(format('select public.set_product_eta(%L, pg_temp.paris_today())', ids[21]), 'P0002');
end $$;

-- 3. Costs: managers and admins read the cost per piece; a rep reads null (row level security on product_costs) -------
do $$
declare
  ids constant uuid[] := string_to_array(current_setting('t.inv'), ',')::uuid[];
begin
  perform pg_temp.as_user('00000000-0000-0000-0000-0000000000a1', 'aal2');
  if (select s.cost_per_piece from public.list_stock(p_search => 'Inv6b Produit 01') s) is distinct from 0.8 then
    raise exception 'FAIL: the manager does not read the cost';
  end if;
  perform pg_temp.as_user('00000000-0000-0000-0000-0000000000b1', 'aal2');
  if exists (select 1 from public.list_stock(p_category => 'Inv6b', p_limit => 200) s where s.cost_per_piece is not null) then
    raise exception 'FAIL: rep_cost_null: a rep reads a cost in list_stock';
  end if;
  if public.get_product(ids[1]) -> 'cost_per_piece' is distinct from 'null'::jsonb then
    raise exception 'FAIL: rep_cost_null: a rep reads a cost in get_product';
  end if;
  -- The rep still reads everything else (stock is organisation-wide).
  if public.count_stock(p_category => 'Inv6b') <> 30 then
    raise exception 'FAIL: the rep should count 30 Inv6b products, got %', public.count_stock(p_category => 'Inv6b');
  end if;
end $$;

-- 4. Validation: constant 22023 refusals with hints --------------------------------------------------------------------
do $$
begin
  perform pg_temp.as_user('00000000-0000-0000-0000-0000000000b1', 'aal2');
  perform pg_temp.expect_error('select * from public.list_stock(p_limit => 0)', '22023', 'bounds');
  perform pg_temp.expect_error('select * from public.list_stock(p_limit => 201)', '22023', 'bounds');
  perform pg_temp.expect_error('select * from public.list_stock(p_filter => ''everything'')', '22023', 'bad_filter');
  perform pg_temp.expect_error('select * from public.list_stock(p_sort => ''cost'')', '22023', 'bad_sort');
  perform pg_temp.expect_error('select * from public.list_stock(p_after_value => ''x'')', '22023', 'bad_cursor');
  perform pg_temp.expect_error(format('select * from public.list_stock(p_sort => ''available'', p_after_value => ''abc'', p_after_id => %L)',
                                      gen_random_uuid()), '22023', 'bad_cursor');
  perform pg_temp.expect_error(format('select * from public.list_stock(p_sort => ''updated'', p_after_value => ''soon'', p_after_id => %L)',
                                      gen_random_uuid()), '22023', 'bad_cursor');
  perform pg_temp.expect_error('select * from public.list_stock(p_search => repeat(''x'', 201))', '22023', 'bounds');
  perform pg_temp.expect_error('select public.count_stock(p_filter => ''nope'')', '22023', 'bad_filter');
  perform pg_temp.expect_error('select * from public.list_movements(p_limit => 101)', '22023', 'bounds');
  perform pg_temp.expect_error('select * from public.list_movements(p_kinds => array[''steal''])', '22023', 'bad_types');
  perform pg_temp.expect_error('select * from public.list_movements(p_kinds => array[null::text])', '22023', 'bad_types');
  perform pg_temp.expect_error('select * from public.list_movements(p_from => pg_temp.paris_today(), p_to => pg_temp.paris_today() - 1)',
                               '22023', 'bounds');
  perform pg_temp.expect_error('select * from public.list_reservations(p_status => ''gone'')', '22023', 'state');
  perform pg_temp.expect_error('select * from public.list_reservations(p_before_created => now())', '22023', 'bad_cursor');
  perform pg_temp.expect_error('select * from public.list_reservations(p_limit => 0)', '22023', 'bounds');
end $$;

-- 5. Filters, search, counts and statuses on the Inv6b set ---------------------------------------------------------------
do $$
declare
  ids constant uuid[] := string_to_array(current_setting('t.inv'), ',')::uuid[];
  f text;
  want integer;
  got integer;
  listed integer;
  s jsonb;
  r record;
begin
  perform pg_temp.as_user('00000000-0000-0000-0000-0000000000b1', 'aal2');
  -- Expected sizes: all 30 unarchived; in_warehouse 1..20 (20); in_transit 21..25 (5); low: 1..5 have reorder 50 and
  -- available 10..50 (5); sold_out 26..30 (5); held 8 and 22 (2); hidden 3 and 4 (2); archived 0.
  foreach f in array array['all', 'in_warehouse', 'in_transit', 'low', 'sold_out', 'held', 'hidden', 'archived'] loop
    want := case f when 'all' then 30 when 'in_warehouse' then 20 when 'in_transit' then 5 when 'low' then 5
                   when 'sold_out' then 5 when 'held' then 2 when 'hidden' then 2 else 0 end;
    got := public.count_stock(p_filter => f, p_category => 'Inv6b');
    select count(*) into listed from public.list_stock(p_filter => f, p_category => 'Inv6b', p_limit => 200);
    if got is distinct from want or listed is distinct from want then
      raise exception 'FAIL: filter %: count % and list %, expected %', f, got, listed, want;
    end if;
  end loop;
  -- Statuses.
  for r in select s.id, s.status_key, s.wh_available, s.tr_on_hand, s.wh_reserved, s.tr_reserved
             from public.list_stock(p_category => 'Inv6b', p_limit => 200) s loop
    f := case when r.id = any (ids[1:5]) then 'low' when r.id = any (ids[6:20]) then 'in_stock'
              when r.id = any (ids[21:25]) then 'arriving' else 'sold_out' end;
    if r.status_key is distinct from f then
      raise exception 'FAIL: status of % is %', r.id, r.status_key;
    end if;
  end loop;
  select * into r from public.list_stock(p_search => 'Inv6b Produit 08') s;
  if r.wh_available is distinct from 50 or r.wh_reserved is distinct from 30 then
    raise exception 'FAIL: held pieces are not taken off available: %', row_to_json(r);
  end if;
  -- Search: LIKE characters are text, not wildcards; a reference "P-0042" finds that product.
  if (select count(*) from public.list_stock(p_search => '100%_jute')) <> 1
     or (select count(*) from public.list_stock(p_search => 'Inv6b%Produit')) <> 0
     or (select count(*) from public.list_stock(p_search => 'Produit _1')) <> 0 then
    raise exception 'FAIL: search did not escape %% or _';
  end if;
  select s.number into got from public.list_stock(p_search => 'Inv6b Produit 12') s;
  if (select s.id from public.list_stock(p_search => 'P-' || lpad(got::text, 4, '0')) s where s.number = got) is distinct from ids[12]
     or (select s.id from public.list_stock(p_search => got::text) s where s.number = got) is distinct from ids[12] then
    raise exception 'FAIL: search by reference';
  end if;
  if (select count(*) from public.list_stock(p_search => 'INV6B PRODUIT', p_limit => 200)) <> 29 then
    raise exception 'FAIL: search is not case-insensitive';
  end if;
  -- The summary adds up (only Inv6b changes are checked against a before/after in section 7).
  s := public.stock_summary();
  if not (s ? 'wh_pieces' and s ? 'tr_pieces' and s ? 'held_pieces' and s ? 'low' and s ? 'sold_out' and s ? 'categories') then
    raise exception 'FAIL: stock_summary keys: %', s;
  end if;
  if not (s -> 'categories') ? 'Inv6b' then
    raise exception 'FAIL: stock_summary categories miss Inv6b';
  end if;
end $$;

-- 6. Keyset pages: every sort walks all 30 once, in order, at 7 a page ---------------------------------------------------
do $$
declare
  srt text;
  after_v text;
  after_i uuid;
  seen uuid[];
  prev record;
  have_prev boolean;
  r record;
  pages integer;
begin
  perform pg_temp.as_user('00000000-0000-0000-0000-0000000000b1', 'aal2');
  foreach srt in array array['name', 'available', 'updated'] loop
    after_v := null;
    after_i := null;
    seen := '{}';
    pages := 0;
    have_prev := false;
    loop
      pages := pages + 1;
      exit when pages > 10;
      for r in select * from public.list_stock(p_category => 'Inv6b', p_sort => srt, p_after_value => after_v,
                                               p_after_id => after_i, p_limit => 7) loop
        if r.id = any (seen) then
          raise exception 'FAIL: sort % repeats %', srt, r.id;
        end if;
        if have_prev then
          if (srt = 'name' and (lower(prev.name), prev.id) > (lower(r.name), r.id))
             or (srt = 'available' and (prev.wh_available, prev.id) < (r.wh_available, r.id))
             or (srt = 'updated' and (prev.touched_at, prev.id) < (r.touched_at, r.id)) then
            raise exception 'FAIL: sort % out of order at %', srt, r.id;
          end if;
        end if;
        seen := seen || r.id;
        prev := r;
        have_prev := true;
        after_v := r.sort_value;
        after_i := r.id;
      end loop;
      exit when cardinality(seen) >= 30;
    end loop;
    if cardinality(seen) <> 30 then
      raise exception 'FAIL: sort % walked % of 30', srt, cardinality(seen);
    end if;
  end loop;
end $$;

-- 7. The product panel, movements and holds ---------------------------------------------------------------------------
do $$
declare
  ids constant uuid[] := string_to_array(current_setting('t.inv'), ',')::uuid[];
  g jsonb;
  n integer;
  before_id bigint;
  seen bigint[] := '{}';
  r record;
begin
  perform pg_temp.as_user('00000000-0000-0000-0000-0000000000b1', 'aal2');
  g := public.get_product(ids[8]);
  if (g ->> 'wh_on_hand')::int <> 80 or (g ->> 'wh_reserved')::int <> 30 or jsonb_array_length(g -> 'holds') <> 1
     or g -> 'holds' -> 0 ->> 'company_name' <> 'Stock A' or g -> 'holds' -> 0 ->> 'location' <> 'warehouse'
     or jsonb_array_length(g -> 'movements') <> 2 or g -> 'movements' -> 0 ->> 'kind' <> 'reserve'
     or g -> 'movements' -> 1 ->> 'kind' <> 'receive' or g -> 'movements' -> 1 ->> 'user_first_name' is null then
    raise exception 'FAIL: get_product: %', g;
  end if;
  perform pg_temp.expect_error(format('select public.get_product(%L)', gen_random_uuid()), 'P0002');
  -- 25 more movements on product 1, then walk them 10 at a time: newest first, each once.
  perform pg_temp.as_user('00000000-0000-0000-0000-0000000006a1', 'aal2', 30);
  for i in 1..25 loop
    perform pg_temp.mv(ids[1], 'adjust_in', 1, 'warehouse', 'found');
  end loop;
  perform pg_temp.as_user('00000000-0000-0000-0000-0000000000b1', 'aal2');
  if jsonb_array_length(public.get_product(ids[1]) -> 'movements') <> 20 then
    raise exception 'FAIL: get_product returns more or less than the last 20 movements';
  end if;
  loop
    n := 0;
    for r in select * from public.list_movements(p_product => ids[1], p_before_id => before_id, p_limit => 10) loop
      if before_id is not null and r.id >= before_id then
        raise exception 'FAIL: list_movements keyset went back';
      end if;
      seen := seen || r.id;
      before_id := r.id;
      n := n + 1;
    end loop;
    exit when n < 10;
  end loop;
  if cardinality(seen) <> 26 or (select count(distinct x) from unnest(seen) x) <> 26 then
    raise exception 'FAIL: list_movements walked % rows, expected 26', cardinality(seen);
  end if;
  -- Kind and person filters.
  if exists (select 1 from public.list_movements(p_product => ids[1], p_kinds => array['receive'], p_limit => 100) m
              where m.kind <> 'receive')
     or (select count(*) from public.list_movements(p_product => ids[1], p_kinds => array['receive'], p_limit => 100)) <> 1
     or (select count(*) from public.list_movements(p_product => ids[1], p_user => '00000000-0000-0000-0000-0000000006a1',
                                                     p_limit => 100)) <> 26
     or (select count(*) from public.list_movements(p_product => ids[1], p_user => '00000000-0000-0000-0000-0000000000b1',
                                                     p_limit => 100)) <> 0
     or (select count(*) from public.list_movements(p_product => ids[1], p_from => pg_temp.paris_today() + 1, p_limit => 100)) <> 0 then
    raise exception 'FAIL: list_movements filters';
  end if;
  -- Holds: active, then closed after a release; the lead filter.
  if (select count(*) from public.list_reservations(p_product => ids[8])) <> 1
     or (select count(*) from public.list_reservations(p_product => ids[22], p_status => 'active')) <> 1
     or (select x.location from public.list_reservations(p_product => ids[22]) x) <> 'transit'
     or (select count(*) from public.list_reservations(p_company => '33000000-0000-0000-0000-0000000000a1') x
          where x.product_id = any (ids)) <> 2 then
    raise exception 'FAIL: list_reservations';
  end if;
end $$;

-- 8. A deal on a hold shows only to someone who may see the deal (rep b1 cannot see a1's deal on lead LB) -------------
reset role;
do $$ begin perform set_config('request.jwt.claims', '', false); end $$;
insert into public.deals (id, org_id, company_id, stage_id, owner_id, status, fulfilment)
select '43000000-0000-0000-0000-0000000000a5', c.org_id, c.id,
       (select s.id from public.pipeline_stages s where s.org_id = c.org_id order by s.position limit 1),
       '00000000-0000-0000-0000-0000000000a1', 'open', 'from_stock'
  from public.companies c where c.id = '33000000-0000-0000-0000-0000000000b1';
set role authenticated;
do $$
declare
  ids constant uuid[] := string_to_array(current_setting('t.inv'), ',')::uuid[];
  v_deal constant uuid := '43000000-0000-0000-0000-0000000000a5';
begin
  perform pg_temp.as_user('00000000-0000-0000-0000-0000000000a1', 'aal2', 30);
  perform public.post_stock_movement(p_product => ids[9], p_kind => 'reserve', p_qty => 5,
                                     p_company => '33000000-0000-0000-0000-0000000000b1', p_deal => v_deal);
  if (select r.deal_id from public.list_reservations(p_product => ids[9]) r) is distinct from v_deal
     or public.get_product(ids[9]) -> 'holds' -> 0 ->> 'deal_id' is distinct from v_deal::text then
    raise exception 'FAIL: the deal owner does not see the deal on the hold';
  end if;
  perform pg_temp.as_user('00000000-0000-0000-0000-0000000000b1', 'aal2');
  if (select r.deal_id from public.list_reservations(p_product => ids[9]) r) is not null
     or public.get_product(ids[9]) -> 'holds' -> 0 -> 'deal_id' is distinct from 'null'::jsonb then
    raise exception 'FAIL: a rep sees a deal they cannot read through a hold';
  end if;
end $$;

-- 9. Settings and the two one-field product changes --------------------------------------------------------------------
do $$
declare
  ids constant uuid[] := string_to_array(current_setting('t.inv'), ',')::uuid[];
  s jsonb;
begin
  -- Everyone reads the settings; only admins change them.
  perform pg_temp.as_user('00000000-0000-0000-0000-0000000000b1', 'aal2');
  s := public.get_inventory_settings();
  if s ->> 'warehouse_name' is null or (s ->> 'can_edit')::boolean or (s ->> 'hold_days')::int <> 14 then
    raise exception 'FAIL: get_inventory_settings as a rep: %', s;
  end if;
  perform pg_temp.expect_error('select public.update_inventory_settings(null, 10)', '42501', 'forbidden');
  perform pg_temp.expect_error('select public.rename_location(''warehouse'', ''Mine'')', '42501', 'forbidden');
  perform pg_temp.as_user('00000000-0000-0000-0000-0000000000a1', 'aal2');
  perform pg_temp.expect_error('select public.update_inventory_settings(null, 10)', '42501', 'forbidden');
  perform pg_temp.as_user('00000000-0000-0000-0000-00000000000a', 'aal2');
  perform pg_temp.expect_error('select public.update_inventory_settings(null, 0)', '22023', 'hold_days');
  perform pg_temp.expect_error('select public.update_inventory_settings(null, 91)', '22023', 'hold_days');
  perform pg_temp.expect_error('select public.update_inventory_settings(null, 40000)', '22023', 'hold_days');
  perform pg_temp.expect_error('select public.update_inventory_settings(''00000000-0000-0000-0000-0000000000c1'', 10)',
                               '22023', 'assignee');
  s := public.update_inventory_settings('00000000-0000-0000-0000-0000000000a1', 21);
  if (s ->> 'hold_days')::int <> 21 or s ->> 'alert_assignee_id' <> '00000000-0000-0000-0000-0000000000a1'
     or not (s ->> 'can_edit')::boolean then
    raise exception 'FAIL: update_inventory_settings: %', s;
  end if;
  s := public.update_inventory_settings(null, 14);
  if s -> 'alert_assignee_id' is distinct from 'null'::jsonb then
    raise exception 'FAIL: the assignee could not be set to nobody';
  end if;
  perform pg_temp.expect_error('select public.rename_location(''attic'', ''Attic'')', '22023', 'location');
  perform pg_temp.expect_error('select public.rename_location(''warehouse'', ''Bad' || chr(8238) || 'name'')', '22023',
                               'location_name', chr(8238));
  perform pg_temp.expect_error('select public.rename_location(''warehouse'', repeat(''y'', 81))', '22023', 'location_name');
  perform public.rename_location('warehouse', '  Entrepôt Lyon  ');
  if public.get_inventory_settings() ->> 'warehouse_name' <> 'Entrepôt Lyon' then
    raise exception 'FAIL: rename_location did not trim or save';
  end if;
  perform public.rename_location('warehouse', 'Warehouse France');
  -- The one-field changes: managers and admins only; the date window; a missing product.
  perform pg_temp.as_user('00000000-0000-0000-0000-0000000000b1', 'aal2');
  perform pg_temp.expect_error(format('select public.set_product_eta(%L, pg_temp.paris_today() + 7)', ids[21]), '42501', 'forbidden');
  perform pg_temp.expect_error(format('select public.set_product_share_visible(%L, false)', ids[21]), '42501', 'forbidden');
  perform pg_temp.as_user('00000000-0000-0000-0000-0000000000a1', 'aal2');
  perform pg_temp.expect_error(format('select public.set_product_eta(%L, pg_temp.paris_today() + 1000)', ids[21]), '22023', 'eta');
  perform pg_temp.expect_error(format('select public.set_product_eta(%L, pg_temp.paris_today())', gen_random_uuid()), 'P0002');
  perform pg_temp.expect_error(format('select public.set_product_share_visible(%L, null)', ids[21]), '22023', 'bounds');
  perform public.set_product_eta(ids[21], pg_temp.paris_today() + 7);
  perform public.set_product_share_visible(ids[21], false);
  if (select s.transit_eta from public.list_stock(p_search => 'Inv6b Produit 21') s) is distinct from pg_temp.paris_today() + 7
     or (select s.share_visible from public.list_stock(p_search => 'Inv6b Produit 21') s) then
    raise exception 'FAIL: set_product_eta or set_product_share_visible did not save';
  end if;
  perform public.set_product_eta(ids[21], null);
  perform public.set_product_share_visible(ids[21], true);
end $$;

-- 10. Archived products: listed only under "archived" ------------------------------------------------------------------
do $$
declare
  ids constant uuid[] := string_to_array(current_setting('t.inv'), ',')::uuid[];
begin
  perform pg_temp.as_user('00000000-0000-0000-0000-0000000000a1', 'aal2', 30);
  perform public.archive_product(ids[30]);   -- sold out: nothing anywhere
  if public.count_stock(p_category => 'Inv6b') <> 29 or public.count_stock(p_filter => 'archived', p_category => 'Inv6b') <> 1
     or (select s.status_key from public.list_stock(p_filter => 'archived', p_category => 'Inv6b') s) <> 'archived'
     or public.count_stock(p_filter => 'sold_out', p_category => 'Inv6b') <> 4 then
    raise exception 'FAIL: archived products in the lists';
  end if;
end $$;

-- 11. ledger_sums_match_levels ------------------------------------------------------------------------------------------
do $$ begin perform pg_temp.integrity_clean('the inventory attack test'); end $$;
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

\echo 'inventory_attack: all checks passed'
