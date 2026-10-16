-- Day 5a attack and behaviour tests: the deals database (design docs/evidence/day5/design.md sections 3.1, 4.1, 5.1 to
-- 5.6, 6 and 8.1; migration 20261015090000_deals_pipeline.sql). Runs after outcome_attack.sql on the same database
-- (scripts/db-test.sh, CI job "rls"), reusing admin a and other-org admin c1, and adding reps r1 and r2 and manager m1
-- for this file. Threat numbers refer to design section 6. Any failure raises an exception and stops the run.
-- Probes run as a signed-in user through the API role (grants, row level security and triggers all apply). Each scenario
-- runs in one block that is rolled back at the end (raise TS001, caught), so the open and move flood guards never add up
-- and every scenario starts from known rows; inside one block now() is one instant, so "within 120 s" holds, and
-- "after 121 s" is made by moving history rows back as the superuser. Every scenario ends with the two invariants
-- (stage_status_consistent, history_chain_consistent) over every deal.
\set ON_ERROR_STOP 1
\set QUIET 1

-- Helpers (temporary functions do not survive into a new psql session, so they are defined again here) -------------
create function pg_temp.as_user(sub text, aal text, totp_age_s integer default null) returns void
language sql as $$
  select set_config('request.jwt.claims', jsonb_build_object(
    'sub', sub, 'role', 'authenticated', 'aal', aal,
    'amr', case when totp_age_s is null then '[]'::jsonb else jsonb_build_array(
      jsonb_build_object('method', 'totp', 'timestamp', extract(epoch from now())::bigint - totp_age_s)) end
  )::text, false)
$$;
-- The API role with a user's claims (default: two-factor, code entered 30 seconds ago), and back to the superuser.
create function pg_temp.act(sub uuid, aal text default 'aal2', totp_age_s integer default 30) returns void
language plpgsql as $$
begin
  perform set_config('role', 'authenticated', false);
  perform pg_temp.as_user(sub::text, aal, totp_age_s);
end;
$$;
create function pg_temp.su() returns void
language plpgsql as $$
begin
  execute 'reset role';
  perform set_config('request.jwt.claims', '', false);
end;
$$;
-- Runs a statement that must fail with this SQLSTATE (and hint, when given). With a marker, the marker (planted in the
-- user's text) must appear in neither the message nor the detail.
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
    if marker is not null and (strpos(coalesce(got_msg, ''), marker) > 0 or strpos(coalesce(got_detail, ''), marker) > 0) then
      raise exception 'FAIL: "%" put the user''s text in the error', left(stmt, 200);
    end if;
    return;
  end;
  raise exception 'FAIL: "%" succeeded, expected %', left(stmt, 200), want_state;
end;
$$;
-- A lead (superuser).
create function pg_temp.new_lead(owner uuid, status text default 'cold', lead_name text default 'Day5a Lead') returns uuid
language sql as $$
  insert into public.companies (org_id, name, owner_id, lead_status, country)
  select o.id, lead_name, owner, status, 'FR' from public.orgs o where o.name = 'TopStock Wholesale'
  returning id
$$;
-- Opens a deal through the RPC as the current user; returns its id.
create function pg_temp.open(lead uuid, title text default null, val numeric default null) returns uuid
language sql as $$
  select (public.open_deal(lead, title, val) -> 'deal' ->> 'id')::uuid
$$;
-- A stage change through the RPC as the current user, with the version the caller can see now.
create function pg_temp.mv(deal uuid, stage text, val numeric default null, ful text default null,
                           reason text default null, note text default null, undo_of bigint default null) returns jsonb
language sql as $$
  select public.move_deal(deal, stage, (select d.version from public.deals d where d.id = deal), val, ful, reason, note,
                          undo_of)
$$;
-- Moves a deal's history back by some seconds (superuser).
create function pg_temp.age_history(deal uuid, seconds integer) returns void
language sql as $$
  update public.deal_stage_history set created_at = created_at - make_interval(secs => seconds) where deal_id = deal
$$;
create function pg_temp.key(deal uuid) returns text
language sql as $$
  select s.key from public.deals d join public.pipeline_stages s on s.id = d.stage_id where d.id = deal
$$;
create function pg_temp.last_kind(deal uuid) returns text
language sql as $$
  select h.kind from public.deal_stage_history h where h.deal_id = deal order by h.id desc limit 1
$$;
-- The two invariants (superuser, over every deal): status agrees with the stage's key and the close time; each history
-- row starts where the previous one ended, the first is the open, the last ends at the current stage, versions rise.
create function pg_temp.invariants(label text) returns void
language plpgsql as $$
declare
  n integer;
begin
  select count(*) into n from public.deals d join public.pipeline_stages s on s.id = d.stage_id
   where d.status <> case s.key when 'won' then 'won' when 'lost' then 'lost' else 'open' end
      or (d.status = 'open') <> (d.closed_at is null);
  if n <> 0 then raise exception 'FAIL: stage_status_consistent after %: % deals', label, n; end if;
  select count(*) into n from (
    select h.deal_id, h.kind, h.from_stage, h.to_stage, h.version_after,
           lag(h.to_stage) over w as prev_to, lag(h.version_after) over w as prev_version,
           row_number() over w as rn,
           row_number() over (partition by h.deal_id order by h.id desc) as rn_desc
      from public.deal_stage_history h
    window w as (partition by h.deal_id order by h.id)) x
   join public.deals d on d.id = x.deal_id
   join public.pipeline_stages s on s.id = d.stage_id
   where (x.rn = 1 and (x.kind <> 'open' or x.from_stage is not null))
      or (x.rn > 1 and (x.from_stage is distinct from x.prev_to or x.version_after <= x.prev_version))
      or (x.rn_desc = 1 and x.to_stage <> s.key);
  if n <> 0 then raise exception 'FAIL: history_chain_consistent after %: % rows', label, n; end if;
  if exists (select 1 from public.deals d where not exists (select 1 from public.deal_stage_history h where h.deal_id = d.id)) then
    raise exception 'FAIL: history_chain_consistent after %: a deal without its open row', label;
  end if;
end;
$$;

-- Fixtures: reps r1 (Rae) and r2 (Rob), manager m1 (Mia). Ids end in 5a1, 5a2, 5b1. ----------------------------------
do $$ begin perform set_config('request.jwt.claims', '', false); end $$;
insert into auth.users (id, email, raw_user_meta_data) values
  ('00000000-0000-0000-0000-0000000005a1', 'rep5a1@test.invalid', '{"first_name":"Rae"}'),
  ('00000000-0000-0000-0000-0000000005a2', 'rep5a2@test.invalid', '{"first_name":"Rob"}'),
  ('00000000-0000-0000-0000-0000000005b1', 'mgr5b1@test.invalid', '{"first_name":"Mia"}');
update public.profiles set role = 'manager' where id = '00000000-0000-0000-0000-0000000005b1';
do $$ begin
  if (select role from public.profiles where id = '00000000-0000-0000-0000-0000000005a1') <> 'rep'
     or (select role from public.profiles where id = '00000000-0000-0000-0000-00000000000a') <> 'admin'
     or (select org_id from public.profiles where id = '00000000-0000-0000-0000-0000000000c1')
        = (select id from public.orgs where name = 'TopStock Wholesale') then
    raise exception 'FAIL: Day 5a fixture roles';
  end if;
end $$;
do $$ begin perform pg_temp.invariants('the earlier test files'); end $$;

-- 0. What the database itself says: grants, functions, policies, constraints (threats 5, 9, 10, 25, 30) ---------------
do $$
declare
  cols text[];
  f record;
  bad text[];
  code text;
begin
  -- deal_insert_columns_exact / deal_update_columns_exact (G1)
  select array_agg(attname::text order by attname) into cols from pg_attribute
   where attrelid = 'public.deals'::regclass and attnum > 0 and not attisdropped
     and has_column_privilege('authenticated', attrelid, attname, 'INSERT');
  if cols is distinct from array['company_id', 'contact_id', 'expected_close', 'fulfilment', 'owner_id', 'request_id',
                                 'source_activity_id', 'title', 'value'] then
    raise exception 'FAIL: deal_insert_columns_exact: %', cols;
  end if;
  select array_agg(attname::text order by attname) into cols from pg_attribute
   where attrelid = 'public.deals'::regclass and attnum > 0 and not attisdropped
     and has_column_privilege('authenticated', attrelid, attname, 'UPDATE');
  if cols is distinct from array['contact_id', 'expected_close', 'fulfilment', 'lost_note', 'lost_reason', 'owner_id',
                                 'stage_id', 'title', 'value'] then
    raise exception 'FAIL: deal_update_columns_exact: %', cols;
  end if;
  if has_table_privilege('anon', 'public.deals', 'SELECT') or not has_table_privilege('authenticated', 'public.deals', 'DELETE') then
    raise exception 'FAIL: deal table grants';
  end if;
  -- History: select only (threat 9); stages: select only, even for admins (threat 10); move records: private, own rows.
  if not has_table_privilege('authenticated', 'public.deal_stage_history', 'SELECT')
     or has_table_privilege('authenticated', 'public.deal_stage_history', 'INSERT')
     or has_table_privilege('authenticated', 'public.deal_stage_history', 'UPDATE')
     or has_table_privilege('authenticated', 'public.deal_stage_history', 'DELETE')
     or has_table_privilege('anon', 'public.deal_stage_history', 'SELECT')
     or not (select relrowsecurity from pg_class where oid = 'public.deal_stage_history'::regclass) then
    raise exception 'FAIL: deal_stage_history grants';
  end if;
  if has_table_privilege('authenticated', 'public.pipeline_stages', 'INSERT')
     or has_table_privilege('authenticated', 'public.pipeline_stages', 'UPDATE')
     or has_table_privilege('authenticated', 'public.pipeline_stages', 'DELETE')
     or (select array_agg(policyname::text order by policyname) from pg_policies
          where schemaname = 'public' and tablename = 'pipeline_stages') is distinct from array['pipeline_stages_select', 'require_mfa'] then
    raise exception 'FAIL: stage_write_denied_even_admin (grants or policies)';
  end if;
  if not (select relrowsecurity from pg_class where oid = 'private.deal_moves'::regclass)
     or (select array_agg(policyname::text order by policyname) from pg_policies
          where schemaname = 'private' and tablename = 'deal_moves') is distinct from array['deal_moves_own', 'require_mfa']
     or has_table_privilege('authenticated', 'private.deal_moves', 'UPDATE')
     or has_table_privilege('anon', 'private.deal_moves', 'SELECT') then
    raise exception 'FAIL: private.deal_moves protections';
  end if;
  -- Open records (threat 22): own rows readable, no client writes, restrictive require_mfa.
  if not (select relrowsecurity from pg_class where oid = 'private.deal_opens'::regclass)
     or (select array_agg(policyname::text order by policyname) from pg_policies
          where schemaname = 'private' and tablename = 'deal_opens') is distinct from array['deal_opens_own', 'require_mfa']
     or not has_table_privilege('authenticated', 'private.deal_opens', 'SELECT')
     or has_table_privilege('authenticated', 'private.deal_opens', 'INSERT')
     or has_table_privilege('authenticated', 'private.deal_opens', 'UPDATE')
     or has_table_privilege('authenticated', 'private.deal_opens', 'DELETE')
     or has_table_privilege('anon', 'private.deal_opens', 'SELECT') then
    raise exception 'FAIL: private.deal_opens protections';
  end if;
  if (select array_agg(policyname::text order by policyname) from pg_policies
       where schemaname = 'public' and tablename = 'deals')
     is distinct from array['deals_delete', 'deals_insert', 'deals_select', 'deals_update', 'require_mfa']
     or (select array_agg(policyname::text order by policyname) from pg_policies
          where schemaname = 'public' and tablename = 'deal_stage_history') is distinct from array['deal_history_select', 'require_mfa']
     or exists (select 1 from pg_policies where tablename in ('deals', 'deal_stage_history', 'deal_moves', 'deal_opens')
                and policyname = 'require_mfa' and permissive <> 'RESTRICTIVE') then
    raise exception 'FAIL: deal policies (restrictive require_mfa on every Day 5a table)';
  end if;
  -- Every new RPC: SECURITY INVOKER, search_path '', callable by signed-in people only, static SQL.
  for f in select p.oid, p.oid::regprocedure::text as sig, p.prosecdef, p.proconfig, p.prosrc
             from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'public' and p.proname in ('open_deal', 'move_deal', 'update_deal', 'delete_deal',
                  'get_deal', 'list_stage_deals', 'pipeline_summary', 'pipeline_board', 'list_lead_deals') loop
    if f.prosecdef or not (f.proconfig @> array['search_path=""'])
       or not has_function_privilege('authenticated', f.oid, 'EXECUTE')
       or has_function_privilege('anon', f.oid, 'EXECUTE') or has_function_privilege('public', f.oid, 'EXECUTE')
       or f.prosrc ~* '\mexecute\M' or f.prosrc ~* 'format\s*\(' then
      bad := bad || f.sig;
    end if;
  end loop;
  if bad is not null or (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                          where n.nspname = 'public' and p.proname in ('open_deal', 'move_deal', 'update_deal',
                                'delete_deal', 'get_deal', 'list_stage_deals', 'pipeline_summary', 'pipeline_board',
                                'list_lead_deals')) <> 9 then
    raise exception 'FAIL: RPC rules broken by %', bad;
  end if;
  -- deal_history_not_callable: the only DEFINER code is the history trigger, revoked from everyone; the guard is INVOKER.
  if has_function_privilege('authenticated', 'private.deal_history()', 'EXECUTE')
     or has_function_privilege('authenticated', 'private.deal_guard()', 'EXECUTE')
     or not (select prosecdef from pg_proc where oid = 'private.deal_history()'::regprocedure)
     or (select prosecdef from pg_proc where oid = 'private.deal_guard()'::regprocedure) then
    raise exception 'FAIL: deal_history_not_callable / the guard must be INVOKER';
  end if;
  -- The statement-level flood triggers (verifier round 2): DEFINER (they count every row of the caller's, visible or
  -- not), search_path '', trigger-only and revoked from everyone; AFTER ... FOR EACH STATEMENT with transition tables.
  foreach code in array array['private.deal_open_flood()', 'private.deal_move_flood()'] loop
    if has_function_privilege('authenticated', code::regprocedure, 'EXECUTE')
       or has_function_privilege('anon', code::regprocedure, 'EXECUTE')
       or has_function_privilege('public', code::regprocedure, 'EXECUTE')
       or not (select prosecdef from pg_proc where oid = code::regprocedure)
       or not ((select proconfig from pg_proc where oid = code::regprocedure) @> array['search_path=""']) then
      raise exception 'FAIL: flood trigger function % must be DEFINER, search_path empty, revoked from everyone', code;
    end if;
  end loop;
  if (select array_agg(tgname::text order by tgname) from pg_trigger
       where tgrelid = 'public.deals'::regclass and not tgisinternal
         and tgtype & 1 = 0 and tgtype & 2 = 0 and tgnewtable = 'new_deals')  -- statement level, AFTER, new rows
     is distinct from array['flood_deal_move', 'flood_deal_open'] then
    raise exception 'FAIL: the flood triggers must be AFTER ... FOR EACH STATEMENT with the new rows';
  end if;
  foreach code in array array['private.stage_id(text)', 'private.stage_key(uuid)',
      'private.deal_undo_candidate(uuid,text,text,integer)',
      'private.deal_cards(uuid[])', 'private.deal_card(uuid)', 'private.deal_value_ok(numeric)',
      'private.deal_scope_owner(text,uuid,boolean)', 'private.opened_deal(uuid,boolean)',
      'private.moved_deal(bigint,boolean)', 'private.deal_conflict(uuid)', 'private.pipeline_summary_for(uuid)',
      'private.stage_deal_ids(uuid,uuid,text,boolean,timestamptz,timestamptz,timestamptz,uuid,integer)'] loop
    if not has_function_privilege('authenticated', code::regprocedure, 'EXECUTE')
       or has_function_privilege('anon', code::regprocedure, 'EXECUTE')
       or (select prosecdef from pg_proc where oid = code::regprocedure)
       or not ((select proconfig from pg_proc where oid = code::regprocedure) @> array['search_path=""']) then
      raise exception 'FAIL: helper % must be INVOKER, search_path empty, callable by signed-in people only', code;
    end if;
  end loop;
  -- The Day 6 seam, filled in by 20261020100000_deal_stock_blocks.sql (Haider, 11 Oct 2026): it must see every sale and
  -- hold in the deal's organisation whatever the caller's role, so it is SECURITY DEFINER owned by postgres; the grants
  -- stay Day 5's (signed-in people only, because the guard and delete_deal run as the caller; private has no endpoint).
  if not has_function_privilege('authenticated', 'private.deal_closing_blocked(uuid)', 'EXECUTE')
     or has_function_privilege('anon', 'private.deal_closing_blocked(uuid)', 'EXECUTE')
     or has_function_privilege('public', 'private.deal_closing_blocked(uuid)', 'EXECUTE')
     or not (select prosecdef from pg_proc where oid = 'private.deal_closing_blocked(uuid)'::regprocedure)
     or (select pg_get_userbyid(proowner) from pg_proc where oid = 'private.deal_closing_blocked(uuid)'::regprocedure) <> 'postgres'
     or not ((select proconfig from pg_proc where oid = 'private.deal_closing_blocked(uuid)'::regprocedure) @> array['search_path=""']) then
    raise exception 'FAIL: deal_closing_blocked must be DEFINER owned by postgres, search_path empty, signed-in people only';
  end if;
  -- Day 6 contract (section 10): no BEFORE trigger on deals other than these three; the history triggers fire on
  -- insert and on a stage change (WHEN, never UPDATE OF status). Since the merge into Day 6 (15 Oct 2026) Day 6a's two
  -- hold-release triggers are on the table too: release_deal_holds_lost AFTER UPDATE (row, WHEN the status becomes
  -- 'lost', which this file's Closed/lost path sets) and release_deal_holds_deleted BEFORE DELETE; neither writes the
  -- deal row, so the BEFORE INSERT/UPDATE set stays exactly the three below. Day 6's deal_stock_blocks migration adds
  -- block_deal_delete_on_stock (BEFORE DELETE: a signed-in session never deletes a deal stock records hold) and
  -- fit_deal_fulfilment_to_stock (AFTER UPDATE, WHEN the shipping is first chosen); neither writes the deal row either.
  if (select array_agg(tgname::text order by tgname) from pg_trigger
       where tgrelid = 'public.deals'::regclass and not tgisinternal)
     is distinct from array['audit_row', 'block_deal_delete_on_stock', 'enforce_org_and_owner', 'fit_deal_fulfilment_to_stock',
                            'flood_deal_move', 'flood_deal_open', 'guard_deal',
                            'history_deal', 'history_deal_stage', 'release_deal_holds_deleted', 'release_deal_holds_lost',
                            'set_updated_at'] then
    raise exception 'FAIL: the triggers on deals changed';
  end if;
  -- tgtype bits: 1 row, 2 before, 4 insert, 8 delete, 16 update. BEFORE row INSERT or UPDATE: only these three.
  if (select array_agg(tgname::text order by tgname) from pg_trigger
       where tgrelid = 'public.deals'::regclass and not tgisinternal and tgtype & 2 = 2 and tgtype & (4 | 16) <> 0)
     is distinct from array['enforce_org_and_owner', 'guard_deal', 'set_updated_at'] then
    raise exception 'FAIL: a new BEFORE INSERT or UPDATE trigger on deals';
  end if;
  if (select tgtype from pg_trigger where tgrelid = 'public.deals'::regclass and tgname = 'release_deal_holds_lost') <> 1 | 16
     or (select tgtype from pg_trigger where tgrelid = 'public.deals'::regclass and tgname = 'release_deal_holds_deleted') <> 1 | 2 | 8 then
    raise exception 'FAIL: Day 6a''s release triggers must stay AFTER UPDATE and BEFORE DELETE (row)';
  end if;
  -- Constraints the design names (G2, G5 to G7, S6), the tasks FK (G8) and the lead FK.
  if (select array_agg(conname::text order by conname) from pg_constraint
       where conrelid = 'public.deals'::regclass and contype = 'c')
     is distinct from array['deals_closed_at_matches', 'deals_currency_eur', 'deals_fulfilment_check', 'deals_lost_has_reason',
                            'deals_lost_reason_code', 'deals_note_safe', 'deals_other_has_note', 'deals_status_check',
                            'deals_title_safe', 'deals_value_bounds', 'deals_version_nonneg', 'deals_won_shape'] then
    raise exception 'FAIL: deal CHECK constraints';
  end if;
  if (select confdeltype from pg_constraint where conname = 'deals_company_id_fkey') <> 'r'
     or (select confdeltype from pg_constraint where conname = 'tasks_deal_id_fkey') <> 'n'
     or (select attnotnull from pg_attribute where attrelid = 'public.deals'::regclass and attname = 'company_id') is not true then
    raise exception 'FAIL: lead FK restrict, company_id not null, tasks.deal_id set null';
  end if;
  -- stage_key_flags_consistent / one_won_one_lost_per_org: the seeded rows and their constraints.
  if exists (select 1 from public.pipeline_stages where is_won <> (key = 'won') or is_lost <> (key = 'lost'))
     or (select count(*) from public.pipeline_stages s join public.orgs o on o.id = s.org_id
          where o.name = 'TopStock Wholesale') <> 5
     or (select array_agg(key || ':' || coalesce(stall_days::text, '-') order by position) from public.pipeline_stages s
          join public.orgs o on o.id = s.org_id where o.name = 'TopStock Wholesale')
        <> array['lead:7', 'qualified:14', 'negotiations:21', 'won:-', 'lost:-'] then
    raise exception 'FAIL: seeded stage keys and stall limits';
  end if;
  begin
    insert into public.pipeline_stages (org_id, name, position, key, is_won)
    select id, 'Second won', 9, 'won', true from public.orgs where name = 'TopStock Wholesale';
    raise exception 'FAIL: one_won_one_lost_per_org (a second won stage)';
  exception when unique_violation then null;
  end;
  begin
    insert into public.pipeline_stages (org_id, name, position, key, is_won)
    select id, 'Fake won', 9, 'qualified', true from public.orgs where name = 'Other Org';
    raise exception 'FAIL: stage_key_flags_consistent';
  exception when check_violation then null;
  end;
  -- The CHECKs hold without the guard (superuser, no signed-in user): NaN, over the cap, won without value or
  -- shipping, lost without a reason, other without a note, closed time out of step, bidi in a title (S6, G2, G6).
  declare
    lead uuid := (select id from public.companies where org_id = (select id from public.orgs where name = 'TopStock Wholesale') limit 1);
    st record;
    stmt text;
  begin
    select org_id, (select id from public.pipeline_stages s where s.org_id = c.org_id and s.key = 'won') as won,
           (select id from public.pipeline_stages s where s.org_id = c.org_id and s.key = 'lost') as lost,
           (select id from public.pipeline_stages s where s.org_id = c.org_id and s.key = 'lead') as open
      into st from public.companies c where c.id = lead;
    foreach stmt in array array[
        format('insert into public.deals (org_id, company_id, stage_id, value) values (%L, %L, %L, %L)', st.org_id, lead, st.open, 'NaN'),
        format('insert into public.deals (org_id, company_id, stage_id, value) values (%L, %L, %L, 100000000.01)', st.org_id, lead, st.open),
        format('insert into public.deals (org_id, company_id, stage_id, value) values (%L, %L, %L, -1)', st.org_id, lead, st.open),
        format('insert into public.deals (org_id, company_id, stage_id, status, closed_at, fulfilment) values (%L, %L, %L, %L, now(), %L)', st.org_id, lead, st.won, 'won', 'from_stock'),
        format('insert into public.deals (org_id, company_id, stage_id, status, closed_at, value) values (%L, %L, %L, %L, now(), 5)', st.org_id, lead, st.won, 'won'),
        format('insert into public.deals (org_id, company_id, stage_id, status, closed_at, value, fulfilment) values (%L, %L, %L, %L, now(), 0, %L)', st.org_id, lead, st.won, 'won', 'from_stock'),
        format('insert into public.deals (org_id, company_id, stage_id, status, closed_at) values (%L, %L, %L, %L, now())', st.org_id, lead, st.lost, 'lost'),
        format('insert into public.deals (org_id, company_id, stage_id, status, closed_at, lost_reason) values (%L, %L, %L, %L, now(), %L)', st.org_id, lead, st.lost, 'lost', 'other'),
        format('insert into public.deals (org_id, company_id, stage_id, status, closed_at, lost_reason) values (%L, %L, %L, %L, now(), %L)', st.org_id, lead, st.lost, 'lost', 'bored'),
        format('insert into public.deals (org_id, company_id, stage_id, status) values (%L, %L, %L, %L)', st.org_id, lead, st.won, 'won'),
        format('insert into public.deals (org_id, company_id, stage_id, closed_at) values (%L, %L, %L, now())', st.org_id, lead, st.open),
        format('insert into public.deals (org_id, company_id, stage_id, currency) values (%L, %L, %L, %L)', st.org_id, lead, st.open, 'USD'),
        format('insert into public.deals (org_id, company_id, stage_id, title) values (%L, %L, %L, %L)', st.org_id, lead, st.open, 'x' || chr(8238)),
        format('insert into public.deals (org_id, company_id, stage_id, version) values (%L, %L, %L, -1)', st.org_id, lead, st.open)] loop
      begin
        execute stmt;
        raise exception 'FAIL: a deal CHECK let this through: %', stmt;
      exception when check_violation then null;
      end;
    end loop;
    begin
      insert into public.deals (org_id, stage_id) values (st.org_id, st.open);
      raise exception 'FAIL: a deal without a lead (G5)';
    exception when not_null_violation then null;
    end;
  end;
  -- closing_blocked_stub_null (threat 30)
  if private.deal_closing_blocked(gen_random_uuid()) is not null then
    raise exception 'FAIL: closing_blocked_stub_null';
  end if;
end $$;

-- 1. Signed in without two-factor (threat 1): nothing to read, nothing to call --------------------------------------
do $$
declare
  lead uuid := pg_temp.new_lead('00000000-0000-0000-0000-0000000005a1', 'warm');
  deal uuid;
begin
  insert into public.deals (org_id, company_id, stage_id, owner_id)
  select org_id, lead, (select id from public.pipeline_stages where org_id = c.org_id and key = 'lead'),
         '00000000-0000-0000-0000-0000000005a1' from public.companies c where c.id = lead returning id into deal;
  perform pg_temp.act('00000000-0000-0000-0000-0000000005a1', 'aal1', null);
  if (select count(*) from public.deals) <> 0 or (select count(*) from public.deal_stage_history) <> 0
     or (select count(*) from public.pipeline_stages) <> 0 or (select count(*) from private.deal_moves) <> 0
     or (select count(*) from private.deal_opens) <> 0 then
    raise exception 'FAIL: day5_aal1_blocked (tables)';
  end if;
  perform pg_temp.expect_error(format('select public.open_deal(%L)', lead), '42501');
  perform pg_temp.expect_error(format('select public.move_deal(%L, %L, 0)', deal, 'qualified'), '42501');
  perform pg_temp.expect_error(format('select public.update_deal(%L, 0, %L, %L)', deal, '{title}', 'x'), '42501');
  perform pg_temp.expect_error(format('select public.delete_deal(%L)', deal), '42501');
  perform pg_temp.expect_error('select public.pipeline_board()', '42501');
  perform pg_temp.expect_error('select public.pipeline_summary()', '42501');
  perform pg_temp.expect_error($q$select * from public.list_stage_deals('lead', 'mine')$q$, '42501');
  perform pg_temp.expect_error(format('select * from public.list_lead_deals(%L)', lead), '42501');
  if public.get_deal(deal) is not null then raise exception 'FAIL: day5_aal1_blocked (get_deal)'; end if;
  perform pg_temp.su();
  perform pg_temp.invariants('aal1');
  raise exception 'undo' using errcode = 'TS001';
exception when sqlstate 'TS001' then perform pg_temp.su();
end $$;

-- 2. Opening a deal: the server's columns, the policy, the lead rules (threats 4, 5, 20, 27; 5.1) ---------------------
do $$
declare
  r1 constant uuid := '00000000-0000-0000-0000-0000000005a1';
  r2 constant uuid := '00000000-0000-0000-0000-0000000005a2';
  admin constant uuid := '00000000-0000-0000-0000-00000000000a';
  lead uuid := pg_temp.new_lead(r1, 'cold');
  lead2 uuid := pg_temp.new_lead(r2, 'cold');
  dnc uuid := pg_temp.new_lead(r1, 'do_not_contact');
  other_contact uuid;
  r jsonb;
  deal uuid;
  d record;
  req uuid := gen_random_uuid();
begin
  insert into public.contacts (org_id, company_id, first_name) select org_id, id, 'Elsewhere' from public.companies
   where id = lead2 returning id into other_contact;
  perform pg_temp.act(r1);
  -- deal_opens_at_lead, deal_created_by_forced: a direct insert (values the client may name) opens at Lead, open,
  -- version 0, created by and owned by the caller, in euros.
  insert into public.deals (company_id, title, value) values (lead, '  Denim jackets, 2 pallets  ', 1200) returning id into deal;
  perform pg_temp.su();
  select dd.*, s.key into d from public.deals dd join public.pipeline_stages s on s.id = dd.stage_id where dd.id = deal;
  if d.key <> 'lead' or d.status <> 'open' or d.version <> 0 or d.created_by is distinct from r1 or d.owner_id is distinct from r1
     or d.currency <> 'EUR' or d.closed_at is not null or d.title <> 'Denim jackets, 2 pallets' or d.value <> 1200
     or d.fulfilment is not null or d.stage_entered_at <> now() then
    raise exception 'FAIL: deal_opens_at_lead / deal_created_by_forced: %', row_to_json(d);
  end if;
  if (select count(*) from public.deal_stage_history h where h.deal_id = deal and h.kind = 'open' and h.actor_id = r1
       and h.to_stage = 'lead' and h.version_after = 0) <> 1 then
    raise exception 'FAIL: the open history row';
  end if;
  perform pg_temp.act(r1);
  -- deal_insert_stage_not_writable, deal_status_not_writable, insert_at_won_refused (column grants: 42501)
  perform pg_temp.expect_error(format('insert into public.deals (company_id, stage_id) values (%L, (select id from public.pipeline_stages where key = %L))', lead, 'won'), '42501');
  perform pg_temp.expect_error(format('insert into public.deals (company_id, status) values (%L, %L)', lead, 'won'), '42501');
  perform pg_temp.expect_error(format('insert into public.deals (company_id, created_by) values (%L, %L)', lead, r2), '42501');
  perform pg_temp.expect_error(format('insert into public.deals (company_id, currency) values (%L, %L)', lead, 'USD'), '42501');
  -- open_deal_on_colleagues_lead_42501 (RPC and direct), open_deal_contact_other_lead (RPC: P0002 like log_activity;
  -- direct: the policy, 42501)
  perform pg_temp.expect_error(format('select public.open_deal(%L)', lead2), '42501', 'lead_not_editable');
  perform pg_temp.expect_error(format('insert into public.deals (company_id) values (%L)', lead2), '42501');
  perform pg_temp.expect_error(format('select public.open_deal(%L, p_contact => %L)', lead, other_contact), 'P0002');
  perform pg_temp.expect_error(format('insert into public.deals (company_id, contact_id) values (%L, %L)', lead, other_contact), '42501');
  perform pg_temp.expect_error(format('select public.open_deal(%L)', gen_random_uuid()), 'P0002');
  perform pg_temp.expect_error('select public.open_deal(null)', '22023', 'lead_required');
  perform pg_temp.expect_error('insert into public.deals (title) values (''x'')', '22023', 'lead_required');
  -- open_deal_on_dnc_refused (threat 27)
  perform pg_temp.expect_error(format('select public.open_deal(%L)', dnc), '22023', 'dnc');
  perform pg_temp.expect_error(format('insert into public.deals (company_id) values (%L)', dnc), '22023', 'dnc');
  -- rep_cannot_reassign_deal (on open): a rep opens only their own deals
  perform pg_temp.expect_error(format('select public.open_deal(%L, p_owner => %L)', lead, r2), '42501');
  -- Through the RPC: the lead follows (cold becomes warm); the answer carries the card, the count and the undo time.
  r := public.open_deal(lead, 'Spring order', 5400.5, p_request_id => req);
  if r -> 'deal' ->> 'stage' <> 'lead' or r -> 'deal' ->> 'value' <> '5400.50' or (r ->> 'open_deal_count')::int <> 2
     or r ->> 'lead_status_before' <> 'cold' or r ->> 'lead_status_after' <> 'warm' or (r ->> 'replayed')::boolean
     or (r ->> 'undo_until')::timestamptz <> now() + interval '120 seconds'
     or not (r -> 'deal' ->> 'can_edit')::boolean or r -> 'deal' ->> 'owner_first_name' <> 'Rae' then
    raise exception 'FAIL: open_deal answer %', r;
  end if;
  -- open_deal_idempotent: the same request answers the same deal and changes nothing.
  if (public.open_deal(lead, 'Spring order again', p_request_id => req) ->> 'replayed')::boolean is not true
     or (select count(*) from public.deals where company_id = lead) <> 2 then
    raise exception 'FAIL: open_deal_idempotent';
  end if;
  perform pg_temp.su();
  if (select lead_status from public.companies where id = lead) <> 'warm' then
    raise exception 'FAIL: opening a deal should make a cold lead warm';
  end if;
  perform pg_temp.act(r1);  -- a second direct insert with the same request id: the unique index is the backstop
  perform pg_temp.expect_error(format('insert into public.deals (company_id, request_id) values (%L, %L)', lead, req), '23505');
  -- request_id_other_author_no_collision: another person's same request id is another deal.
  perform pg_temp.act(admin);
  r := public.open_deal(lead, 'Admin order', p_request_id => req);
  if (r ->> 'replayed')::boolean or (select count(*) from public.deals where company_id = lead) <> 3 then
    raise exception 'FAIL: request_id_other_author_no_collision %', r;
  end if;
  -- owner_defaults_to_creator (G11: an admin naming nobody), owner_must_be_org_member, an admin may name a teammate.
  insert into public.deals (company_id) values (lead) returning id into deal;
  if (select owner_id from public.deals where id = deal) is distinct from admin then
    raise exception 'FAIL: owner_defaults_to_creator';
  end if;
  perform pg_temp.expect_error(format('select public.open_deal(%L, p_owner => %L)', lead, '00000000-0000-0000-0000-0000000000c1'), '42501');
  if (public.open_deal(lead, p_owner => r2) -> 'deal' ->> 'owner_id')::uuid is distinct from r2 then
    raise exception 'FAIL: an admin may open a deal for a teammate';
  end if;
  -- Validation before any write, constant messages (threats 8, 21): a planted value never reaches the error.
  perform pg_temp.expect_error(format('select public.open_deal(%L, %L)', lead, 'PLANTED-5101 ' || chr(8238) || 'gpj.exe'), '22023', 'deal_title', 'PLANTED-5101');
  perform pg_temp.expect_error(format('insert into public.deals (company_id, title) values (%L, %L)', lead, 'PLANTED-5102' || chr(7)), '22023', 'deal_title', 'PLANTED-5102');
  perform pg_temp.expect_error(format('select public.open_deal(%L, %L)', lead, repeat('x', 121)), '22023', 'deal_title');
  perform pg_temp.expect_error(format('select public.open_deal(%L, p_value => %L)', lead, 'NaN'), '22023', 'value');
  perform pg_temp.expect_error(format('select public.open_deal(%L, p_value => %L)', lead, 'Infinity'), '22023', 'value');
  perform pg_temp.expect_error(format('select public.open_deal(%L, p_value => %L)', lead, '-1'), '22023', 'value');
  perform pg_temp.expect_error(format('select public.open_deal(%L, p_value => %L)', lead, '100000000.01'), '22023', 'value', '100000000.01');
  perform pg_temp.expect_error(format('select public.open_deal(%L, p_value => %L)', lead, '12.345'), '22023', 'value');
  perform pg_temp.expect_error(format('insert into public.deals (company_id, value) values (%L, %L)', lead, 'NaN'), '22023', 'value');
  perform pg_temp.expect_error(format('insert into public.deals (company_id, value) values (%L, %L)', lead, '-0.01'), '22023', 'value');
  perform pg_temp.expect_error(format('insert into public.deals (company_id, value) values (%L, %L)', lead, '100000001'), '22023', 'value', '100000001');
  perform pg_temp.expect_error(format('insert into public.deals (company_id, value) values (%L, %L)', lead, 'Infinity'), '22003');
  perform pg_temp.expect_error(format('select public.open_deal(%L, p_fulfilment => %L)', lead, 'PLANTED-5103'), '22023', 'fulfilment', 'PLANTED-5103');
  perform pg_temp.expect_error(format('insert into public.deals (company_id, fulfilment) values (%L, %L)', lead, 'drone'), '22023', 'fulfilment');
  perform pg_temp.expect_error(format('select public.open_deal(%L, p_expected_close => %L)', lead, (current_date + 1200)::text), '22023', 'bounds');
  perform pg_temp.expect_error(format('insert into public.deals (company_id, expected_close) values (%L, %L)', lead, '1999-01-01'), '22023', 'bounds');
  -- A deal from a call: only the caller's own Interested call on this lead, just logged (5b's path; 42501 source).
  perform pg_temp.expect_error(format('insert into public.deals (company_id, source_activity_id) values (%L, (select id from public.activities limit 1))', lead), '42501', 'source');
  -- SQL or filter text in a title is stored as it was written (threat 28).
  if (public.open_deal(lead, '''); drop table deals;--') -> 'deal' ->> 'title') <> '''); drop table deals;--'
     or (public.open_deal(lead, '),id.eq.') -> 'deal' ->> 'title') <> '),id.eq.' then
    raise exception 'FAIL: titles with SQL or filter text should be stored verbatim';
  end if;
  perform pg_temp.su();
  perform pg_temp.invariants('opening');
  raise exception 'undo' using errcode = 'TS001';
exception when sqlstate 'TS001' then perform pg_temp.su();
end $$;

-- 3. Forging server columns and other people's deals (threats 2, 3, 5, 9, 20, 25) ----------------------------------------
do $$
declare
  r1 constant uuid := '00000000-0000-0000-0000-0000000005a1';
  r2 constant uuid := '00000000-0000-0000-0000-0000000005a2';
  c1 constant uuid := '00000000-0000-0000-0000-0000000000c1';
  lead uuid := pg_temp.new_lead(r1, 'warm');
  deal uuid;
  hist_id bigint;
  other_stage uuid := (select s.id from public.pipeline_stages s join public.orgs o on o.id = s.org_id
                        where o.name = 'Other Org' and s.key = 'lead');
  attempt text;
begin
  perform pg_temp.act(r1);
  deal := pg_temp.open(lead, 'Mine');
  hist_id := (select max(id) from public.deal_stage_history where deal_id = deal);
  -- deal_status_not_writable, deal_stage_entered_at_not_writable, deal_closed_at_not_writable, deal_version_not_writable,
  -- deal_company_immutable, and the rest of the server's columns: no column privilege.
  foreach attempt in array array['status = ''won''', 'stage_entered_at = now() - interval ''30 days''',
      'closed_at = now()', 'version = 99', 'company_id = gen_random_uuid()', 'created_by = null',
      'created_at = now() - interval ''1 year''', 'currency = ''USD''', 'request_id = gen_random_uuid()',
      'source_activity_id = null', 'org_id = gen_random_uuid()'] loop
    perform pg_temp.expect_error(format('update public.deals set %s where id = %L', attempt, deal), '42501');
  end loop;
  -- history_insert_denied, history_update_denied, history_delete_denied (threat 9; e2e covers REST)
  perform pg_temp.expect_error(format('insert into public.deal_stage_history (org_id, deal_id, kind, to_stage, version_after) select org_id, %L, %L, %L, 9 from public.deals where id = %L', deal, 'move', 'won', deal), '42501');
  perform pg_temp.expect_error(format('update public.deal_stage_history set actor_id = %L where id = %L', r2, hist_id), '42501');
  perform pg_temp.expect_error(format('delete from public.deal_stage_history where id = %L', hist_id), '42501');
  perform pg_temp.expect_error('select private.deal_history()', '42501');
  -- other_org_stage_refused_42501 (the guard's invisible-stage path, before the policy)
  perform pg_temp.expect_error(format('update public.deals set stage_id = %L where id = %L', other_stage, deal), '42501', 'stage');
  perform pg_temp.expect_error(format('update public.deals set stage_id = gen_random_uuid() where id = %L', deal), '42501', 'stage');
  -- stage_write_denied_even_admin is in block 0 (grants); a rep cannot write one either.
  perform pg_temp.expect_error('update public.pipeline_stages set stall_days = 1', '42501');
  -- rep_cannot_reassign_deal (enforce_org_and_owner) through the RPC and directly
  perform pg_temp.expect_error(format('select public.update_deal(%L, %s, %L, p_owner => %L)', deal,
                                      (select version from public.deals where id = deal), '{owner_id}', r2), '42501');
  perform pg_temp.expect_error(format('update public.deals set owner_id = %L where id = %L', r2, deal), '42501');
  -- rep_cannot_move_others_deal_p0002, rep_get_other_deal_null (threat 3): rep r2 sees nothing of r1's deal.
  perform pg_temp.act(r2);
  perform pg_temp.expect_error(format('select public.move_deal(%L, %L, 0)', deal, 'qualified'), 'P0002');
  perform pg_temp.expect_error(format('select public.update_deal(%L, 0, %L, %L)', deal, '{title}', 'x'), 'P0002');
  perform pg_temp.expect_error(format('select public.delete_deal(%L)', deal), 'P0002');
  if public.get_deal(deal) is not null or exists (select 1 from public.deal_stage_history where deal_id = deal)
     or exists (select 1 from public.list_lead_deals(lead)) then
    raise exception 'FAIL: rep_get_other_deal_null';
  end if;
  update public.deals set title = 'hijack' where id = deal;
  delete from public.deals where id = deal;
  -- stage_write_denied_even_admin: an admin with a fresh code writes no stage either (threat 10).
  perform pg_temp.act('00000000-0000-0000-0000-00000000000a');
  perform pg_temp.expect_error('update public.pipeline_stages set stall_days = 2 where key = ''lead''', '42501');
  perform pg_temp.expect_error('update public.pipeline_stages set is_won = true where key = ''lost''', '42501');
  perform pg_temp.expect_error('insert into public.pipeline_stages (name, position, key) values (''Hack'', 9, ''lead'')', '42501');
  perform pg_temp.expect_error('delete from public.pipeline_stages where key = ''qualified''', '42501');
  -- other_org_deal_invisible, other_org_history_invisible (threat 2)
  perform pg_temp.act(c1);
  if public.get_deal(deal) is not null or exists (select 1 from public.deals where id = deal)
     or exists (select 1 from public.deal_stage_history where deal_id = deal)
     or public.pipeline_board()::text like '%' || deal::text || '%' then
    raise exception 'FAIL: other_org_deal_invisible / other_org_history_invisible';
  end if;
  perform pg_temp.expect_error(format('select public.move_deal(%L, %L, 0)', deal, 'qualified'), 'P0002');
  perform pg_temp.su();
  if (select title from public.deals where id = deal) <> 'Mine' then
    raise exception 'FAIL: a colleague changed or deleted a deal';
  end if;
  perform pg_temp.invariants('forging');
  raise exception 'undo' using errcode = 'TS001';
exception when sqlstate 'TS001' then perform pg_temp.su();
end $$;

-- 4. transition_matrix (threats 6 and 7; D7, D8): every from -> to pair, through move_deal, with each missing input ----
-- Columns of the table below: from stage, to stage, then what happens with the full inputs: the history kind, or the
-- error hint (SQLSTATE in the 'state' column). Missing inputs for won and lost are checked separately below.
do $$
declare
  r1 constant uuid := '00000000-0000-0000-0000-0000000005a1';
  t record;
  lead uuid;
  deal uuid;
  r jsonb;
  d record;
begin
  for t in select * from (values
      ('lead', 'qualified', 'move', null, null), ('lead', 'negotiations', 'move', null, null),
      ('lead', 'won', 'won', null, null), ('lead', 'lost', 'lost', null, null),
      ('qualified', 'lead', 'move', null, null), ('qualified', 'negotiations', 'move', null, null),
      ('qualified', 'won', 'won', null, null), ('qualified', 'lost', 'lost', null, null),
      ('negotiations', 'lead', 'move', null, null), ('negotiations', 'qualified', 'move', null, null),
      ('negotiations', 'won', 'won', null, null), ('negotiations', 'lost', 'lost', null, null),
      ('won', 'lead', 'reopen', null, null), ('won', 'qualified', 'reopen', null, null),
      ('won', 'negotiations', 'reopen', null, null), ('won', 'lost', null, '22023', 'reopen_first'),
      ('lost', 'lead', 'reopen', null, null), ('lost', 'qualified', 'reopen', null, null),
      ('lost', 'negotiations', 'reopen', null, null), ('lost', 'won', null, '22023', 'reopen_first')
    ) as x (from_stage, to_stage, kind, state, hint) loop
    -- Build the deal at from_stage as the owner, then make its last change older than the undo window.
    perform pg_temp.su();
    lead := pg_temp.new_lead(r1, 'warm');
    perform pg_temp.act(r1);
    deal := pg_temp.open(lead, 'Matrix ' || t.from_stage || ' to ' || t.to_stage, 800);
    if t.from_stage in ('qualified', 'negotiations') then
      perform pg_temp.mv(deal, t.from_stage);
    elsif t.from_stage = 'won' then
      perform pg_temp.mv(deal, 'won', 900, 'from_stock');
    elsif t.from_stage = 'lost' then
      perform pg_temp.mv(deal, 'lost', reason => 'price');
    end if;
    perform pg_temp.su();
    perform pg_temp.age_history(deal, 300);
    update public.deals set stage_entered_at = now() - interval '5 days' where id = deal;  -- a known clock
    perform pg_temp.act(r1);
    if t.state is not null then
      perform pg_temp.expect_error(format('select pg_temp.mv(%L, %L, %s, %L, %L)', deal, t.to_stage,
                                          case when t.to_stage = 'won' then '900' else 'null' end,
                                          case when t.to_stage = 'won' then 'from_stock' end,
                                          case when t.to_stage = 'lost' then 'price' end), t.state, t.hint);
      -- the same through a direct PATCH (the guard)
      perform pg_temp.expect_error(format('update public.deals set stage_id = private.stage_id(%L)%s where id = %L',
                                          t.to_stage, case when t.to_stage = 'lost' then ', lost_reason = ''timing''' else '' end,
                                          deal), t.state, t.hint);
      if pg_temp.key(deal) <> t.from_stage then raise exception 'FAIL: transition_matrix % -> % wrote', t.from_stage, t.to_stage; end if;
    else
      if t.from_stage = 'won' then
        -- reopen_won_stale_code_denied, then reopen_won_fresh_code_ok
        perform pg_temp.act(r1, 'aal2', 700);
        perform pg_temp.expect_error(format('select pg_temp.mv(%L, %L)', deal, t.to_stage), '42501', 'step_up');
        perform pg_temp.expect_error(format('update public.deals set stage_id = private.stage_id(%L) where id = %L', t.to_stage, deal), '42501', 'step_up');
        perform pg_temp.act(r1, 'aal2', 30);
      end if;
      r := pg_temp.mv(deal, t.to_stage, case when t.to_stage = 'won' then 900 end,
                      case when t.to_stage = 'won' then 'direct_from_source' end,
                      case when t.to_stage = 'lost' then 'competitor' end);
      perform pg_temp.su();
      select dd.*, s.key into d from public.deals dd join public.pipeline_stages s on s.id = dd.stage_id where dd.id = deal;
      if r ->> 'result' <> 'moved' or d.key <> t.to_stage or pg_temp.last_kind(deal) <> t.kind
         or d.status <> (case t.to_stage when 'won' then 'won' when 'lost' then 'lost' else 'open' end)
         or d.stage_entered_at <> now()                                                    -- the clock restarts
         or (d.status = 'open') <> (d.closed_at is null) or (d.closed_at is not null and d.closed_at <> now())  -- closed_at_is_server_time
         or (t.to_stage = 'won' and (d.value <> 900 or d.fulfilment <> 'direct_from_source'))
         or (t.to_stage = 'lost' and d.lost_reason <> 'competitor')
         or (t.from_stage = 'lost' and d.lost_reason <> 'price')                           -- a reopen keeps the reason
         or (t.from_stage = 'won' and d.value <> 900) then
        raise exception 'FAIL: transition_matrix % -> %: % / %', t.from_stage, t.to_stage, r, row_to_json(d);
      end if;
    end if;
  end loop;

  -- Missing inputs (won_needs_value_gt_0, won_needs_fulfilment, lost_needs_reason, lost_other_needs_note), through the
  -- RPC and directly; nothing is written.
  perform pg_temp.su();
  lead := pg_temp.new_lead(r1, 'warm');
  perform pg_temp.act(r1);
  deal := pg_temp.open(lead, 'Inputs');
  perform pg_temp.expect_error(format('select pg_temp.mv(%L, %L, null, %L)', deal, 'won', 'from_stock'), '22023', 'value_required');
  perform pg_temp.expect_error(format('select pg_temp.mv(%L, %L, 0, %L)', deal, 'won', 'from_stock'), '22023', 'value_required');
  perform pg_temp.expect_error(format('select pg_temp.mv(%L, %L, 10)', deal, 'won'), '22023', 'fulfilment_required');
  perform pg_temp.expect_error(format('select pg_temp.mv(%L, %L, %L, %L)', deal, 'won', 'NaN', 'from_stock'), '22023', 'value');
  perform pg_temp.expect_error(format('update public.deals set stage_id = private.stage_id(%L), fulfilment = %L where id = %L', 'won', 'from_stock', deal), '22023', 'value_required');
  perform pg_temp.expect_error(format('update public.deals set stage_id = private.stage_id(%L), value = 0, fulfilment = %L where id = %L', 'won', 'from_stock', deal), '22023', 'value_required');
  perform pg_temp.expect_error(format('update public.deals set stage_id = private.stage_id(%L), value = 5 where id = %L', 'won', deal), '22023', 'fulfilment_required');
  perform pg_temp.expect_error(format('select pg_temp.mv(%L, %L)', deal, 'lost'), '22023', 'lost_reason_required');
  perform pg_temp.expect_error(format('select pg_temp.mv(%L, %L, reason => %L)', deal, 'lost', 'bored'), '22023', 'lost_reason_required');
  perform pg_temp.expect_error(format('select pg_temp.mv(%L, %L, reason => %L)', deal, 'lost', 'other'), '22023', 'lost_note_required');
  perform pg_temp.expect_error(format('select pg_temp.mv(%L, %L, reason => %L, note => %L)', deal, 'lost', 'other', '   '), '22023', 'lost_note_required');
  perform pg_temp.expect_error(format('select pg_temp.mv(%L, %L, reason => %L, note => %L)', deal, 'lost', 'other', 'PLANTED-5104' || chr(8238)), '22023', 'lost_note', 'PLANTED-5104');
  perform pg_temp.expect_error(format('update public.deals set stage_id = private.stage_id(%L) where id = %L', 'lost', deal), '22023', 'lost_reason_required');
  perform pg_temp.expect_error(format('update public.deals set stage_id = private.stage_id(%L), lost_reason = %L where id = %L', 'lost', 'other', deal), '22023', 'lost_note_required');
  perform pg_temp.expect_error(format('update public.deals set stage_id = private.stage_id(%L), lost_reason = %L, lost_note = %L where id = %L', 'lost', 'other', repeat('n', 501), deal), '22023', 'lost_note');
  -- The parameter mix (state): value with a loss, a reason with a win or a move; unknown stage.
  perform pg_temp.expect_error(format('select pg_temp.mv(%L, %L, 10, reason => %L)', deal, 'lost', 'price'), '22023', 'state');
  perform pg_temp.expect_error(format('select pg_temp.mv(%L, %L, 10, %L, %L)', deal, 'won', 'from_stock', 'price'), '22023', 'state');
  perform pg_temp.expect_error(format('select pg_temp.mv(%L, %L, 10)', deal, 'qualified'), '22023', 'state');
  perform pg_temp.expect_error(format('select pg_temp.mv(%L, %L)', deal, 'closed/won'), '22023', 'stage');
  perform pg_temp.expect_error(format('update public.deals set stage_id = private.stage_id(%L), lost_reason = %L where id = %L', 'qualified', 'price', deal), '22023', 'state');
  perform pg_temp.expect_error(format('update public.deals set stage_id = private.stage_id(%L), value = 5 where id = %L', 'qualified', deal), '22023', 'state');
  -- Same stage: an open deal's reason and note change only with a loss (and every change moves the version).
  perform pg_temp.expect_error(format('update public.deals set lost_reason = %L where id = %L', 'price', deal), '22023', 'state');
  perform pg_temp.expect_error(format('update public.deals set lost_note = %L where id = %L', 'quiet edit', deal), '22023', 'state');
  if pg_temp.key(deal) <> 'lead' or (select count(*) from public.deal_stage_history where deal_id = deal) <> 1 then
    raise exception 'FAIL: refused stage changes wrote something';
  end if;
  -- Unchanged: asking for the stage the deal is in writes nothing.
  r := pg_temp.mv(deal, 'lead');
  if r ->> 'result' <> 'unchanged' or (select version from public.deals where id = deal) <> 0 then
    raise exception 'FAIL: unchanged move %', r;
  end if;
  -- closed_value_frozen (threat 7, D14): a closed deal changes only title, contact and owner.
  perform pg_temp.mv(deal, 'won', 1500, 'from_stock');
  perform pg_temp.expect_error(format('update public.deals set value = 1 where id = %L', deal), '22023', 'closed');
  perform pg_temp.expect_error(format('update public.deals set fulfilment = %L where id = %L', 'direct_from_source', deal), '22023', 'closed');
  perform pg_temp.expect_error(format('update public.deals set expected_close = current_date where id = %L', deal), '22023', 'closed');
  perform pg_temp.expect_error(format('update public.deals set lost_note = %L where id = %L', 'after the win', deal), '22023', 'closed');
  perform pg_temp.expect_error(format('select public.update_deal(%L, %s, %L, p_value => 1)', deal,
                                      (select version from public.deals where id = deal), '{value}'), '22023', 'closed');
  r := public.update_deal(deal, (select version from public.deals where id = deal), '{title}', 'Renamed after the win');
  if r ->> 'result' <> 'updated' or r -> 'deal' ->> 'title' <> 'Renamed after the win' or r -> 'deal' ->> 'value' <> '1500.00' then
    raise exception 'FAIL: a won deal may be renamed %', r;
  end if;
  perform pg_temp.su();
  perform pg_temp.invariants('transition_matrix');
  raise exception 'undo' using errcode = 'TS001';
exception when sqlstate 'TS001' then perform pg_temp.su();
end $$;

-- 5. Undo by reverse move (threat 14; D6): restores, refusals, and what is only an ordinary move ------------------------
do $$
declare
  r1 constant uuid := '00000000-0000-0000-0000-0000000005a1';
  admin constant uuid := '00000000-0000-0000-0000-00000000000a';
  lead uuid := pg_temp.new_lead(r1, 'warm');
  deal uuid;
  r jsonb;
  u jsonb;
  d record;
  h bigint;
  n integer;
begin
  perform pg_temp.act(r1);
  deal := pg_temp.open(lead, 'Undo', 700);
  perform pg_temp.mv(deal, 'negotiations');
  perform pg_temp.su();
  perform pg_temp.age_history(deal, 300);
  update public.deals set stage_entered_at = now() - interval '10 days' where id = deal;  -- a 10-day clock
  perform pg_temp.act(r1);
  -- undo_restores_clock_close_value_fulfilment: win, then the toast's Undo (p_undo_of).
  r := pg_temp.mv(deal, 'won', 950, 'from_stock');
  h := (r ->> 'history_id')::bigint;
  if pg_temp.last_kind(deal) <> 'won' or (r ->> 'undo_until')::timestamptz <> now() + interval '120 seconds' then
    raise exception 'FAIL: the win %', r;
  end if;
  if (public.get_deal(deal) -> 'undo' ->> 'history_id')::bigint <> h or public.get_deal(deal) -> 'undo' ->> 'to_stage' <> 'negotiations' then
    raise exception 'FAIL: get_deal.undo after a win: %', public.get_deal(deal) -> 'undo';
  end if;
  -- undo_of_expired_refused_no_write: an Undo naming another row is refused before anything is written.
  perform pg_temp.expect_error(format('select pg_temp.mv(%L, %L, undo_of => %s)', deal, 'negotiations', h - 1), '22023', 'undo_expired');
  -- undo_own_win_within_120s_no_code: no fresh code needed (code entered 700 s ago).
  perform pg_temp.act(r1, 'aal2', 700);
  u := pg_temp.mv(deal, 'negotiations', undo_of => h);
  perform pg_temp.su();
  select dd.* into d from public.deals dd where dd.id = deal;
  if not (u ->> 'undone')::boolean or u ->> 'undo_until' is not null or d.status <> 'open' or d.closed_at is not null
     or d.value <> 700 or d.fulfilment is not null or d.stage_entered_at <> now() - interval '10 days'
     or (select kind || ':' || undoes from public.deal_stage_history where deal_id = deal order by id desc limit 1) <> 'undo:' || h then
    raise exception 'FAIL: undo_restores_clock_close_value_fulfilment % / %', u, row_to_json(d);
  end if;
  -- A restored 10-day clock in Negotiations (limit 21 days) is not stalled; in Lead (7 days) it is (next block).
  if (select is_stalled from private.deal_cards(array[deal])) or (select quiet_days from private.deal_cards(array[deal])) is distinct from 10 then
    raise exception 'FAIL: the restored clock: 10 quiet days in Negotiations is not stalled';
  end if;
  perform pg_temp.invariants('undo of a win');
  raise exception 'undo' using errcode = 'TS001';
exception when sqlstate 'TS001' then perform pg_temp.su();
end $$;

do $$
declare
  r1 constant uuid := '00000000-0000-0000-0000-0000000005a1';
  r2 constant uuid := '00000000-0000-0000-0000-0000000005a2';
  admin constant uuid := '00000000-0000-0000-0000-00000000000a';
  lead uuid := pg_temp.new_lead(r1, 'warm');
  deal uuid;
  r jsonb;
  u jsonb;
  h bigint;
  n integer;
begin
  perform pg_temp.su();
  -- undo_of_undo_is_ordinary and the 10-day clock in Lead (7 days): stalled again after the undo.
  perform pg_temp.act(r1);
  deal := pg_temp.open(lead, 'Undo chain');
  perform pg_temp.su();
  update public.deals set stage_entered_at = now() - interval '10 days' where id = deal;
  update public.companies set last_activity_at = now() - interval '9 days' where id = lead;
  perform pg_temp.age_history(deal, 300);
  perform pg_temp.act(r1);
  r := pg_temp.mv(deal, 'qualified');
  if (select is_stalled from private.deal_cards(array[deal])) then
    raise exception 'FAIL: a move restarts the clock (not stalled)';
  end if;
  u := pg_temp.mv(deal, 'lead');  -- dragging back by hand within 120 s: the same undo
  if not (u ->> 'undone')::boolean or (select stage_entered_at from public.deals where id = deal) <> now() - interval '10 days'
     or not (select is_stalled from private.deal_cards(array[deal]))
     or (select quiet_days from private.deal_cards(array[deal])) is distinct from 9 then
    raise exception 'FAIL: a hand drag back should undo and restore the 10-day clock %', u;
  end if;
  r := pg_temp.mv(deal, 'qualified');  -- moving again after an undo: ordinary (only the latest change is undoable)
  if pg_temp.last_kind(deal) <> 'move' or (select stage_entered_at from public.deals where id = deal) <> now() then
    raise exception 'FAIL: undo_of_undo_is_ordinary (redo is a move)';
  end if;
  u := pg_temp.mv(deal, 'lead');      -- this reverses the redo: an undo again
  r := pg_temp.mv(deal, 'qualified');  -- and reversing that undo is ordinary
  if pg_temp.last_kind(deal) <> 'move' then
    raise exception 'FAIL: undo_of_undo_is_ordinary';
  end if;
  -- reverse_by_other_user_is_ordinary_move: the admin moves it back within 120 s.
  perform pg_temp.act(admin);
  r := pg_temp.mv(deal, 'lead');
  if (r ->> 'undone')::boolean or pg_temp.last_kind(deal) <> 'move'
     or (select actor_id from public.deal_stage_history where deal_id = deal order by id desc limit 1) is distinct from admin then
    raise exception 'FAIL: reverse_by_other_user_is_ordinary_move / history_actor_forced %', r;
  end if;
  -- reverse_after_121s_is_ordinary_move
  perform pg_temp.act(r1);
  r := pg_temp.mv(deal, 'negotiations');
  perform pg_temp.su();
  perform pg_temp.age_history(deal, 121);
  perform pg_temp.act(r1);
  h := (r ->> 'history_id')::bigint;
  perform pg_temp.expect_error(format('select pg_temp.mv(%L, %L, undo_of => %s)', deal, 'lead', h), '22023', 'undo_expired');
  r := pg_temp.mv(deal, 'lead');
  if (r ->> 'undone')::boolean or pg_temp.last_kind(deal) <> 'move' then
    raise exception 'FAIL: reverse_after_121s_is_ordinary_move';
  end if;
  -- reverse_after_colleague_edit_is_ordinary: any change since (the version moved) ends the undo.
  r := pg_temp.mv(deal, 'qualified');
  perform pg_temp.act(admin);
  perform public.update_deal(deal, (select version from public.deals where id = deal), '{title}', 'Edited by the admin');
  perform pg_temp.act(r1);
  if public.get_deal(deal) -> 'undo' is not null and jsonb_typeof(public.get_deal(deal) -> 'undo') <> 'null' then
    raise exception 'FAIL: get_deal offers an undo after a colleague''s edit';
  end if;
  r := pg_temp.mv(deal, 'lead');
  if (r ->> 'undone')::boolean or pg_temp.last_kind(deal) <> 'move' then
    raise exception 'FAIL: reverse_after_colleague_edit_is_ordinary';
  end if;
  -- undo_of_reopen_from_lost_keeps_reason: lose (other + note), reopen, undo the reopen: lost again, same reason and note.
  r := pg_temp.mv(deal, 'lost', reason => 'other', note => '  Went quiet after the samples ');
  perform pg_temp.su();
  perform pg_temp.age_history(deal, 300);
  update public.deals set closed_at = now() - interval '300 seconds' where id = deal;  -- lost 5 minutes ago
  perform pg_temp.act(r1);
  r := pg_temp.mv(deal, 'qualified');
  if pg_temp.last_kind(deal) <> 'reopen' or (select lost_note from public.deals where id = deal) <> 'Went quiet after the samples' then
    raise exception 'FAIL: a reopen from lost keeps the reason and note';
  end if;
  u := pg_temp.mv(deal, 'lost', undo_of => (r ->> 'history_id')::bigint);
  perform pg_temp.su();
  if not (u ->> 'undone')::boolean
     or (select status || ':' || lost_reason || ':' || lost_note || ':' || (closed_at = now() - interval '300 seconds')
           from public.deals where id = deal) <> 'lost:other:Went quiet after the samples:true' then
    raise exception 'FAIL: undo_of_reopen_from_lost_keeps_reason %', u;
  end if;
  -- history_no_row_without_stage_change, history_row_per_stage_change, history_written_on_direct_patch
  n := (select count(*) from public.deal_stage_history where deal_id = deal);
  perform pg_temp.act(r1);
  update public.deals set title = 'Only the title' where id = deal;
  perform pg_temp.su();
  if (select count(*) from public.deal_stage_history where deal_id = deal) <> n then
    raise exception 'FAIL: history_no_row_without_stage_change';
  end if;
  perform pg_temp.age_history(deal, 300);
  perform pg_temp.act(r1);
  update public.deals set stage_id = private.stage_id('negotiations') where id = deal;  -- a direct reopen
  perform pg_temp.su();
  if (select count(*) from public.deal_stage_history where deal_id = deal) <> n + 1 or pg_temp.last_kind(deal) <> 'reopen'
     or (select actor_id from public.deal_stage_history where deal_id = deal order by id desc limit 1) is distinct from r1 then
    raise exception 'FAIL: history_written_on_direct_patch';
  end if;
  -- The version moves on every change, including a lost note on its own path (mutation 31) and a title.
  if (select version from public.deals where id = deal)
     <> (select max(version_after) from public.deal_stage_history where deal_id = deal) then
    raise exception 'FAIL: version and the last history row disagree';
  end if;
  perform pg_temp.invariants('undo');
  raise exception 'undo' using errcode = 'TS001';
exception when sqlstate 'TS001' then perform pg_temp.su();
end $$;

-- 6. Conflicts and replays in one session (threats 11, 13; the two-session cases are in deal_concurrency.sh) ------------
do $$
declare
  r1 constant uuid := '00000000-0000-0000-0000-0000000005a1';
  admin constant uuid := '00000000-0000-0000-0000-00000000000a';
  lead uuid := pg_temp.new_lead(r1, 'warm');
  deal uuid;
  r jsonb;
  r2 jsonb;
  req uuid := gen_random_uuid();
  n integer;
begin
  perform pg_temp.act(r1);
  deal := pg_temp.open(lead, 'Conflict');
  perform pg_temp.act(admin);
  perform pg_temp.mv(deal, 'qualified');  -- Ada moves it (version 1)
  perform pg_temp.act(r1);
  r := public.move_deal(deal, 'negotiations', 0);  -- Rae still holds version 0
  if r ->> 'result' <> 'conflict' or r -> 'deal' ->> 'stage' <> 'qualified' or r ->> 'changed_by_first_name' <> 'Ada'
     or pg_temp.key(deal) <> 'qualified' then
    raise exception 'FAIL: a stale move should be a conflict result %', r;
  end if;
  r := public.update_deal(deal, 0, '{title}', 'Stale edit');
  if r ->> 'result' <> 'conflict' or (select title from public.deals where id = deal) <> 'Conflict' then
    raise exception 'FAIL: a stale update should be a conflict result %', r;
  end if;
  -- move_replay_returns_stored: the same request answers the stored move and writes nothing.
  r := public.move_deal(deal, 'negotiations', 1, p_request_id => req);
  n := (select count(*) from public.deal_stage_history where deal_id = deal);
  r2 := public.move_deal(deal, 'lead', 2, p_request_id => req);
  if not (r2 ->> 'replayed')::boolean or r2 ->> 'history_id' <> r ->> 'history_id' or pg_temp.key(deal) <> 'negotiations'
     or (select count(*) from public.deal_stage_history where deal_id = deal) <> n then
    raise exception 'FAIL: move_replay_returns_stored % / %', r, r2;
  end if;
  -- update_deal: fields whitelist (threat 28), bad version, contact of another lead, a patch changes only what it names.
  perform pg_temp.expect_error(format('select public.update_deal(%L, 2, %L, %L)', deal, '{title,status}', 'x'), '22023', 'fields');
  perform pg_temp.expect_error(format('select public.update_deal(%L, 2, %L)', deal, '{}'), '22023', 'fields');
  perform pg_temp.expect_error(format('select public.update_deal(%L, 2, %L)', deal, '{NULL}'), '22023', 'fields');
  perform pg_temp.expect_error(format('select public.update_deal(%L, null, %L, %L)', deal, '{title}', 'x'), '22023', 'fields');
  perform pg_temp.expect_error(format('select public.update_deal(%L, 2, %L, p_value => %L)', deal, '{value}', 'NaN'), '22023', 'value');
  perform pg_temp.expect_error(format('select public.update_deal(%L, 2, %L, p_contact => %L)', deal, '{contact_id}',
                                      (select id from public.contacts where company_id <> lead limit 1)), 'P0002');
  perform pg_temp.expect_error(format('update public.deals set value = %L where id = %L', 'NaN', deal), '22023', 'value');
  perform pg_temp.expect_error(format('update public.deals set value = -5 where id = %L', deal), '22023', 'value');
  perform pg_temp.expect_error(format('update public.deals set fulfilment = %L where id = %L', 'teleport', deal), '22023', 'fulfilment');
  perform pg_temp.expect_error(format('update public.deals set title = %L where id = %L', 'PLANTED-5105' || chr(8297), deal), '22023', 'deal_title', 'PLANTED-5105');
  r := public.update_deal(deal, 2, '{value,expected_close}', 'ignored title', 2500, current_date + 30);
  if r -> 'deal' ->> 'title' <> 'Conflict' or r -> 'deal' ->> 'value' <> '2500.00'
     or (r -> 'deal' ->> 'expected_close')::date <> current_date + 30 or (r -> 'deal' ->> 'version')::int <> 3 then
    raise exception 'FAIL: update_deal patch %', r;
  end if;
  r := public.update_deal(deal, 3, '{value}', p_value => null);  -- back to "not estimated"
  if r -> 'deal' ->> 'value' is not null then raise exception 'FAIL: update_deal to no value %', r; end if;
  perform pg_temp.su();
  perform pg_temp.invariants('conflicts');
  raise exception 'undo' using errcode = 'TS001';
exception when sqlstate 'TS001' then perform pg_temp.su();
end $$;

-- 7. Deleting (threats 15, 16; D8): codes, roles, the creator's window, what a delete keeps ---------------------------
-- Deleting is for admins with a fresh code (Haider, 11 Oct: "delete admin-only with code"); a manager is refused like a
-- rep. The creator's untouched 2-minute window needs no code and no role.
do $$
declare
  r1 constant uuid := '00000000-0000-0000-0000-0000000005a1';
  m1 constant uuid := '00000000-0000-0000-0000-0000000005b1';
  admin constant uuid := '00000000-0000-0000-0000-00000000000a';
  lead uuid := pg_temp.new_lead(r1, 'cold');
  lead_b uuid := pg_temp.new_lead(r1, 'warm');
  deal uuid;
  deal2 uuid;
  task uuid;
  act uuid;
  call jsonb;
  n integer;
  v_hint text;
begin
  -- deal_delete_creator_within_120s_untouched_ok: no code; the lead goes back (warm -> cold).
  perform pg_temp.act(r1, 'aal2', null);
  deal := pg_temp.open(lead, 'Mistake');
  if (select lead_status from public.companies where id = lead) <> 'warm' then raise exception 'FAIL: open made the lead warm'; end if;
  if not (public.get_deal(deal) ->> 'can_delete')::boolean then raise exception 'FAIL: get_deal.can_delete in the creator''s window'; end if;
  -- get_deal.delete_until (Day 7): the end of the creator's window, so the sheet can drop Delete when it passes.
  if (public.get_deal(deal) ->> 'delete_until')::timestamptz
     is distinct from (select created_at + interval '120 seconds' from public.deals where id = deal) then
    raise exception 'FAIL: get_deal.delete_until for the creator: %', public.get_deal(deal) ->> 'delete_until';
  end if;
  perform public.delete_deal(deal);
  perform pg_temp.su();
  if exists (select 1 from public.deals where id = deal) or (select lead_status from public.companies where id = lead) <> 'cold'
     or exists (select 1 from public.deal_stage_history where deal_id = deal) then
    raise exception 'FAIL: deal_delete_creator_within_120s_untouched_ok';
  end if;
  -- deal_delete_creator_window_any_role: the window is the creator's, whatever the role (a manager, no code).
  perform pg_temp.act(m1, 'aal2', null);
  deal := pg_temp.open(lead, 'Manager mistake');
  if not (public.get_deal(deal) ->> 'can_delete')::boolean then raise exception 'FAIL: a manager creator is not offered Delete'; end if;
  perform public.delete_deal(deal);
  perform pg_temp.su();
  if exists (select 1 from public.deals where id = deal) or (select lead_status from public.companies where id = lead) <> 'cold' then
    raise exception 'FAIL: deal_delete_creator_window_any_role';
  end if;
  -- deal_delete_after_move_needs_code: once moved (version 1), the creator needs a code and the admin role.
  perform pg_temp.act(r1, 'aal2', null);
  deal := pg_temp.open(lead_b, 'Moved');
  perform pg_temp.mv(deal, 'qualified');
  perform pg_temp.expect_error(format('select public.delete_deal(%L)', deal), '42501', 'step_up');
  delete from public.deals where id = deal;
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'FAIL: a moved deal was deleted directly without a code'; end if;
  -- deal_delete_rep_fresh_code_denied
  perform pg_temp.act(r1, 'aal2', 30);
  perform pg_temp.expect_error(format('select public.delete_deal(%L)', deal), '42501');
  -- deal_delete_manager_fresh_code_denied: a manager with a fresh code is refused by delete_deal (42501, no hint: the
  -- app's generic "forbidden") and by the policy (a direct delete removes nothing), and is not offered Delete.
  perform pg_temp.act(m1, 'aal2', 30);
  perform pg_temp.expect_error(format('select public.delete_deal(%L)', deal), '42501');
  begin
    perform public.delete_deal(deal);
  exception when insufficient_privilege then
    get stacked diagnostics v_hint = pg_exception_hint;
    if v_hint <> '' then raise exception 'FAIL: deal_delete_manager_fresh_code_denied (hint %)', v_hint; end if;
  end;
  delete from public.deals where id = deal;
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'FAIL: deal_delete_manager_fresh_code_denied (direct)'; end if;
  if (public.get_deal(deal) ->> 'can_delete')::boolean
     or (select can_delete from public.list_stage_deals('qualified', 'team') where id = deal) then
    raise exception 'FAIL: a manager is offered Delete';
  end if;
  -- An admin is offered Delete without a fresh code (the code is asked on use), with no time limit (delete_until null).
  perform pg_temp.act(admin, 'aal2', 700);
  if not (public.get_deal(deal) ->> 'can_delete')::boolean
     or not (select can_delete from public.list_stage_deals('qualified', 'team') where id = deal) then
    raise exception 'FAIL: an admin is not offered Delete';
  end if;
  if public.get_deal(deal) -> 'delete_until' <> 'null'::jsonb or (public.get_deal(deal) ->> 'stock_held')::boolean then
    raise exception 'FAIL: get_deal for an admin: delete_until %, stock_held %', public.get_deal(deal) -> 'delete_until',
      public.get_deal(deal) -> 'stock_held';
  end if;
  -- deal_delete_stale_code_denied (an admin with a code from 700 s ago)
  perform pg_temp.act(admin, 'aal2', 700);
  perform pg_temp.expect_error(format('select public.delete_deal(%L)', deal), '42501', 'step_up');
  delete from public.deals where id = deal;
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'FAIL: deal_delete_stale_code_denied (direct)'; end if;
  -- deal_delete_keeps_activities_and_tasks (G8, task_guard's FK exception) and deal_delete_admin_fresh_code_ok
  perform pg_temp.su();
  insert into public.tasks (org_id, company_id, deal_id, title, assignee_id, created_by)
  select org_id, lead_b, deal, 'Send the price list', r1, r1 from public.companies where id = lead_b returning id into task;
  insert into public.activities (org_id, company_id, deal_id, type, body, user_id)
  select org_id, lead_b, deal, 'note', 'About the deal', r1 from public.companies where id = lead_b returning id into act;
  perform pg_temp.act(admin, 'aal2', 30);  -- an admin with a fresh code
  perform public.delete_deal(deal);
  perform pg_temp.su();
  if exists (select 1 from public.deals where id = deal)
     or (select deal_id from public.tasks where id = task) is not null
     or (select deal_id from public.activities where id = act) is not null then
    raise exception 'FAIL: deal_delete_keeps_activities_and_tasks';
  end if;
  if not exists (select 1 from public.audit_log where table_name = 'deals' and record_id = deal::text and action = 'delete') then
    raise exception 'FAIL: audit_deal_insert_update_delete_rows (delete)';
  end if;
  -- lead_with_deal_delete_23503: a lead with a deal cannot be deleted, even by an admin with a fresh code.
  perform pg_temp.act(r1);
  deal2 := pg_temp.open(lead_b, 'Keeps the lead');
  perform pg_temp.act(admin, 'aal2', 30);
  perform pg_temp.expect_error(format('delete from public.companies where id = %L', lead_b), '23503');
  perform pg_temp.expect_error(format('select public.delete_deal(%L)', gen_random_uuid()), 'P0002');
  -- deal_direct_delete_refused_while_activity_undo_record: a deal made from a call (5b's path) cannot be removed without
  -- a code while the call's undo record stands (undo_activity consumes it first and puts the lead back).
  perform pg_temp.act(r1, 'aal2', null);
  call := public.log_activity(lead_b, 'call', 'interested', null, null, null, current_date + 3, null, 'Call back');
  insert into public.deals (company_id, source_activity_id) values (lead_b, (call ->> 'activity_id')::uuid) returning id into deal;
  if (public.get_deal(deal) ->> 'can_delete')::boolean then
    raise exception 'FAIL: get_deal.can_delete while the call''s undo record stands';
  end if;
  delete from public.deals where id = deal;
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'FAIL: deal_direct_delete_refused_while_activity_undo_record'; end if;
  -- delete_deal answers like the policy (no code: step_up), not "deal not found".
  perform pg_temp.expect_error(format('select public.delete_deal(%L)', deal), '42501', 'step_up');
  delete from private.activity_undo where activity_id = (call ->> 'activity_id')::uuid;  -- what undo_activity does first
  perform public.delete_deal(deal);
  if exists (select 1 from public.deals where id = deal) then
    raise exception 'FAIL: the creator may remove it once the undo record is consumed';
  end if;
  perform pg_temp.su();
  perform pg_temp.invariants('deleting');
  raise exception 'undo' using errcode = 'TS001';
exception when sqlstate 'TS001' then perform pg_temp.su();
end $$;

-- 8. The lead follows its deal (threat 19; 5.4): coupling_table, events x 7 statuses x editor / non-editor ------------
do $$
declare
  r1 constant uuid := '00000000-0000-0000-0000-0000000005a1';
  r2 constant uuid := '00000000-0000-0000-0000-0000000005a2';
  t record;
  st text;
  ed boolean;
  lead uuid;
  deal uuid;
  got text;
  want text;
  next_before timestamptz;
  next_after timestamptz;
begin
  -- Expected new status per event and status (null: unchanged), for an editor of the lead.
  for t in select * from (values
      ('open',             '{"cold":"warm","cool_off":"warm"}'::jsonb),
      ('negotiations',     '{"cold":"negotiation","warm":"negotiation","cool_off":"negotiation"}'),
      ('won',              '{"cold":"customer","warm":"customer","negotiation":"customer","cool_off":"customer"}'),
      ('lost',             '{"warm":"cool_off","negotiation":"cool_off"}'),
      ('lost_other_open',  '{}'),
      ('reopen_qualified', '{"cool_off":"warm"}'),
      ('reopen_negotiations', '{"cold":"negotiation","warm":"negotiation","cool_off":"negotiation"}'),
      ('reopen_won',       '{}'),
      ('qualified',        '{}')
    ) as x (event, rules) loop
    foreach st in array array['cold', 'warm', 'negotiation', 'customer', 'cool_off', 'do_not_contact', 'disqualified'] loop
      foreach ed in array array[true, false] loop
        perform pg_temp.su();
        lead := pg_temp.new_lead(r1, case when t.event = 'open' then st else 'warm' end);
        -- The deal: opened by r1 (editor) or, for a non-editor, made by the superuser for rep r2 on r1's lead.
        if t.event = 'open' then
          if st = 'do_not_contact' then continue; end if;  -- open_deal_on_dnc_refused (block 2)
          if not ed then continue; end if;                  -- a non-editor cannot open (block 2)
          perform pg_temp.act(r1);
          deal := pg_temp.open(lead);
        else
          -- made by the superuser (so 60-odd deals in this block stay under the open flood guard): r1's own deal on
          -- r1's lead (editor), or rep r2's deal on r1's lead (r2 may move the deal but not change the lead)
          insert into public.deals (org_id, company_id, stage_id, owner_id, value)
          select c.org_id, lead, s.id, case when ed then r1 else r2 end, 400
            from public.companies c join public.pipeline_stages s on s.org_id = c.org_id and s.key = 'lead'
           where c.id = lead returning id into deal;
          if t.event in ('reopen_qualified', 'reopen_negotiations') then
            perform pg_temp.act(case when ed then r1 else r2 end);
            perform pg_temp.mv(deal, 'lost', reason => 'timing');
          elsif t.event = 'reopen_won' then
            perform pg_temp.act(case when ed then r1 else r2 end);
            perform pg_temp.mv(deal, 'won', 400, 'from_stock');
          elsif t.event = 'lost_other_open' then
            perform pg_temp.su();
            insert into public.deals (org_id, company_id, stage_id, owner_id)
            select org_id, lead, (select id from public.pipeline_stages s where s.org_id = c.org_id and s.key = 'qualified'),
                   case when ed then r1 else r2 end from public.companies c where c.id = lead;
          end if;
          perform pg_temp.su();
          perform pg_temp.age_history(deal, 300);
          update public.companies set lead_status = st where id = lead;
          next_before := (select next_action_at from public.companies where id = lead);
          perform pg_temp.act(case when ed then r1 else r2 end);
          perform pg_temp.mv(deal, case t.event when 'lost_other_open' then 'lost' when 'reopen_qualified' then 'qualified'
                                                when 'reopen_negotiations' then 'negotiations' when 'reopen_won' then 'qualified'
                                                else t.event end,
                             case when t.event = 'won' then 400 end, case when t.event = 'won' then 'from_stock' end,
                             case when t.event in ('lost', 'lost_other_open') then 'price' end);
        end if;
        perform pg_temp.su();
        got := (select lead_status from public.companies where id = lead);
        want := case when ed then coalesce(t.rules ->> st, st) else st end;
        if got <> want then
          raise exception 'FAIL: coupling_table % on a % lead (editor %): got %, expected %', t.event, st, ed, got, want;
        end if;
        next_after := (select next_action_at from public.companies where id = lead);
        if t.event = 'lost' and ed and st in ('warm', 'negotiation') and next_after <> now() + interval '90 days' then
          raise exception 'FAIL: a lost deal rests its lead for 90 days';
        end if;
        if t.event <> 'open' and not (t.event = 'lost' and ed and st in ('warm', 'negotiation'))
           and next_after is distinct from next_before then
          raise exception 'FAIL: coupling % on % changed next_action_at', t.event, st;
        end if;
      end loop;
    end loop;
  end loop;
  perform pg_temp.invariants('coupling');
  raise exception 'undo' using errcode = 'TS001';
exception when sqlstate 'TS001' then perform pg_temp.su();
end $$;

-- Undo puts the lead back only while it still holds what the change wrote (undo_restores_lead_only_if_unchanged).
do $$
declare
  r1 constant uuid := '00000000-0000-0000-0000-0000000005a1';
  lead uuid := pg_temp.new_lead(r1, 'warm');
  lead2 uuid := pg_temp.new_lead(r1, 'negotiation');
  deal uuid;
  deal2 uuid;
  r jsonb;
  u jsonb;
  nxt timestamptz;
begin
  perform pg_temp.act(r1);
  deal := pg_temp.open(lead, 'Back', 300);
  r := pg_temp.mv(deal, 'won', 300, 'from_stock');
  if r ->> 'lead_status_before' <> 'warm' or r ->> 'lead_status_after' <> 'customer' then
    raise exception 'FAIL: the win answer reports the lead %', r;
  end if;
  u := pg_temp.mv(deal, 'lead', undo_of => (r ->> 'history_id')::bigint);
  perform pg_temp.su();
  if (select lead_status from public.companies where id = lead) <> 'warm' or u ->> 'lead_status_after' <> 'warm' then
    raise exception 'FAIL: undo of a win puts the lead back %', u;
  end if;
  -- A colleague changed the lead in between: the undo leaves it.
  perform pg_temp.act(r1);
  r := pg_temp.mv(deal, 'won', 300, 'from_stock');
  perform pg_temp.su();
  update public.companies set lead_status = 'disqualified' where id = lead;
  perform pg_temp.act(r1);
  u := pg_temp.mv(deal, 'lead', undo_of => (r ->> 'history_id')::bigint);
  perform pg_temp.su();
  if (select lead_status from public.companies where id = lead) <> 'disqualified' then
    raise exception 'FAIL: undo_restores_lead_only_if_unchanged';
  end if;
  -- Lost rests the lead with a 90-day date; the undo brings back both status and date.
  update public.companies set next_action_at = now() + interval '3 days' where id = lead2;
  nxt := (select next_action_at from public.companies where id = lead2);
  perform pg_temp.act(r1);
  deal2 := pg_temp.open(lead2, 'Lose and undo');
  r := pg_temp.mv(deal2, 'lost', reason => 'no_response');
  perform pg_temp.su();
  if (select lead_status || ':' || (next_action_at = now() + interval '90 days') from public.companies where id = lead2) <> 'cool_off:true' then
    raise exception 'FAIL: lost should rest the lead';
  end if;
  perform pg_temp.act(r1);
  u := pg_temp.mv(deal2, 'lead', undo_of => (r ->> 'history_id')::bigint);
  perform pg_temp.su();
  if (select lead_status from public.companies where id = lead2) <> 'negotiation'
     or (select next_action_at from public.companies where id = lead2) is distinct from nxt then
    raise exception 'FAIL: undo of a loss puts back the status and the date';
  end if;
  perform pg_temp.invariants('lead undo');
  raise exception 'undo' using errcode = 'TS001';
exception when sqlstate 'TS001' then perform pg_temp.su();
end $$;

-- 9. The board, columns and summary (threat 18; D19 to D21; 5.6): scope, hand counts, keyset, cursors, limits -----------
do $$
declare
  r1 constant uuid := '00000000-0000-0000-0000-0000000005a1';
  r2 constant uuid := '00000000-0000-0000-0000-0000000005a2';
  admin constant uuid := '00000000-0000-0000-0000-00000000000a';
  m1 constant uuid := '00000000-0000-0000-0000-0000000005b1';
  org uuid := (select id from public.orgs where name = 'TopStock Wholesale');
  lead uuid := pg_temp.new_lead(r1, 'warm', 'Board lead');
  lead2 uuid := pg_temp.new_lead(r2, 'warm', 'Board lead 2');
  b jsonb;
  s jsonb;
  ids uuid[];
  page uuid[];
  seen uuid[];
  cur_at timestamptz;
  cur_id uuid;
  ord text;
  n integer;
  k text;
begin
  -- Start from an empty board for this org (rolled back at the end), then 30 deals in Lead for r1 with one clock,
  -- 5 in Qualified for r2 (two stalled), 3 won (one 40 days ago) and 2 lost for r1.
  delete from public.deals where org_id = org;
  insert into public.deals (org_id, company_id, stage_id, owner_id, value, stage_entered_at)
  select org, lead, (select id from public.pipeline_stages where org_id = org and key = 'lead'), r1,
         case when g % 3 = 0 then null else g * 10 end, now() - interval '1 hour'
    from generate_series(1, 30) g;
  insert into public.deals (org_id, company_id, stage_id, owner_id, value, stage_entered_at)
  select org, lead2, (select id from public.pipeline_stages where org_id = org and key = 'qualified'), r2, 100,
         now() - case when g <= 2 then interval '20 days' else interval '2 days' end
    from generate_series(1, 5) g;
  update public.companies set last_activity_at = now() - interval '15 days' where id = lead2;
  insert into public.deals (org_id, company_id, stage_id, owner_id, value, fulfilment, status, closed_at)
  select org, lead, (select id from public.pipeline_stages where org_id = org and key = 'won'), r1, 1000, 'from_stock', 'won',
         now() - case when g = 3 then interval '40 days' else make_interval(days => g) end
    from generate_series(1, 3) g;
  insert into public.deals (org_id, company_id, stage_id, owner_id, status, closed_at, lost_reason)
  select org, lead, (select id from public.pipeline_stages where org_id = org and key = 'lost'), r1, 'lost',
         now() - interval '3 days', (array['price', 'timing'])[g] from generate_series(1, 2) g;

  -- pipeline_board_equals_hand_count (admin, team)
  perform pg_temp.act(admin);
  b := public.pipeline_board('team', null, 7);
  if b ->> 'scope' <> 'team' or (b -> 'open_total' ->> 'count')::int <> 35
     or (b -> 'open_total' ->> 'value')::numeric <> (select sum(g * 10) from generate_series(1, 30) g where g % 3 <> 0) + 500 then
    raise exception 'FAIL: pipeline_board_equals_hand_count (open total) %', b -> 'open_total';
  end if;
  for s in select * from jsonb_array_elements(b -> 'stages') loop
    k := s ->> 'key';
    if (k = 'lead' and ((s ->> 'count')::int <> 30 or (s ->> 'no_value')::int <> 10 or (s ->> 'stalled')::int <> 0
                        or jsonb_array_length(s -> 'cards') <> 7 or s -> 'next' is null or jsonb_typeof(s -> 'next') = 'null'))
       or (k = 'qualified' and ((s ->> 'count')::int <> 5 or (s ->> 'stalled')::int <> 2 or (s ->> 'value')::numeric <> 500
                                or jsonb_array_length(s -> 'cards') <> 5 or jsonb_typeof(s -> 'next') <> 'null'))
       or (k = 'negotiations' and ((s ->> 'count')::int <> 0 or jsonb_array_length(s -> 'cards') <> 0)) then
      raise exception 'FAIL: pipeline_board_equals_hand_count (%): %', k, s - 'cards';
    end if;
  end loop;
  if (b -> 'won' ->> 'count')::int <> 2 or (b -> 'won' ->> 'value')::numeric <> 2000 or jsonb_array_length(b -> 'won' -> 'cards') <> 2
     or (b -> 'lost' ->> 'count')::int <> 2 or jsonb_array_length(b -> 'lost' -> 'reasons') <> 2
     or jsonb_array_length(b -> 'stages') <> 3 then
    raise exception 'FAIL: pipeline_board won/lost: % / %', b -> 'won' - 'cards', b -> 'lost';
  end if;
  -- The card fields (5.6) and newest-in-stage first.
  s := b -> 'stages' -> 1 -> 'cards' -> 0;
  if not (s ?& array['id', 'stage', 'title', 'company_id', 'company_name', 'city', 'country', 'lead_status', 'contact_name',
                     'value', 'currency', 'status', 'stage_entered_at', 'closed_at', 'expected_close', 'fulfilment',
                     'owner_id', 'owner_first_name', 'owner_last_name', 'version', 'last_activity_at', 'is_stalled',
                     'quiet_days', 'lost_reason', 'can_edit'])
     or s ? 'ordinality' or s ->> 'company_name' <> 'Board lead 2' or s ->> 'owner_first_name' <> 'Rob' then
    raise exception 'FAIL: card fields %', s;
  end if;
  if (b -> 'stages' -> 1 -> 'cards' -> 0 ->> 'stage_entered_at')::timestamptz <> now() - interval '2 days' then
    raise exception 'FAIL: newest in stage first';
  end if;
  -- rep_board_team_falls_back_to_mine, rep_stage_list_team_42501, rep_summary_team_42501
  perform pg_temp.act(r2);
  b := public.pipeline_board('team');
  if b ->> 'scope' <> 'mine' or (b -> 'open_total' ->> 'count')::int <> 5 or (b ->> 'owner_id')::uuid <> r2 then
    raise exception 'FAIL: rep_board_team_falls_back_to_mine %', b -> 'open_total';
  end if;
  if (public.pipeline_board('mine', r1) -> 'open_total' ->> 'count')::int <> 5 then
    raise exception 'FAIL: a rep naming a colleague gets their own board';
  end if;
  perform pg_temp.expect_error($q$select * from public.list_stage_deals('lead', 'team')$q$, '42501', 'scope');
  perform pg_temp.expect_error(format('select * from public.list_stage_deals(%L, %L, %L)', 'lead', 'mine', r1), '42501', 'scope');
  perform pg_temp.expect_error($q$select public.pipeline_summary('team')$q$, '42501', 'scope');
  if (select count(*) from public.list_stage_deals('qualified', 'mine')) <> 5
     or (select count(*) from public.list_stage_deals('qualified', 'mine', p_stalled_only => true)) <> 2
     or (public.pipeline_summary('mine') -> 'stages' -> 1 ->> 'stalled')::int <> 2 then
    raise exception 'FAIL: a rep''s own column and stalled filter';
  end if;
  -- A manager sees the team and may filter by owner.
  perform pg_temp.act(m1);
  if (select count(*) from public.list_stage_deals('lead', 'team', r1, p_limit => 100)) <> 30
     or (select count(*) from public.list_stage_deals('lead', 'mine')) <> 0
     or (public.pipeline_summary('team', r2) -> 'open_total' ->> 'count')::int <> 5 then
    raise exception 'FAIL: manager scope';
  end if;
  -- Won and lost lists page by close time with no age limit; the board's Won column covers 30 days.
  if (select count(*) from public.list_stage_deals('won')) <> 3 or (select count(*) from public.list_stage_deals('lost')) <> 2 then
    raise exception 'FAIL: See all won / See lost deals';
  end if;
  -- list_stage_keyset_stable: 30 deals with one stage_entered_at, pages of 7, both orders, mine and team: no repeats or gaps.
  foreach ord in array array['recent', 'oldest'] loop
    foreach k in array array['team', 'owner'] loop
      seen := '{}';
      cur_at := null;
      cur_id := null;
      loop
        select array_agg(x.id order by x.rn) into page
          from (select l.id, row_number() over () as rn
                  from public.list_stage_deals('lead', 'team', case when k = 'owner' then r1 end, false, ord, cur_at, cur_id, 7) l) x;
        exit when page is null or cardinality(seen) > 60;  -- a cursor that repeats a row would loop for ever
        seen := seen || page;
        select d.stage_entered_at, d.id into cur_at, cur_id from public.deals d where d.id = page[cardinality(page)];
      end loop;
      if cardinality(seen) <> 30 or (select count(distinct x) from unnest(seen) x) <> 30
         or seen <> (select array_agg(d.id order by case when ord = 'recent' then d.id end desc, d.id)
                       from public.deals d where d.org_id = org and d.status = 'open' and d.owner_id = r1) then
        raise exception 'FAIL: list_stage_keyset_stable (% %): % rows', ord, k, cardinality(seen);
      end if;
    end loop;
  end loop;
  -- bad_cursor_22023, bad_order_22023, bad_scope_22023, limit_bounds_22023 (threats 22, 28)
  perform pg_temp.expect_error($q$select * from public.list_stage_deals('lead', p_after_at => now())$q$, '22023', 'bad_cursor');
  perform pg_temp.expect_error($q$select * from public.list_stage_deals('lead', p_after_id => gen_random_uuid())$q$, '22023', 'bad_cursor');
  perform pg_temp.expect_error($q$select * from public.list_stage_deals('lead', p_order => 'value')$q$, '22023', 'bad_order');
  perform pg_temp.expect_error($q$select * from public.list_stage_deals('lead', 'everyone')$q$, '22023', 'bad_scope');
  perform pg_temp.expect_error($q$select public.pipeline_board('everyone')$q$, '22023', 'bad_scope');
  perform pg_temp.expect_error($q$select public.pipeline_summary(null)$q$, '22023', 'bad_scope');
  perform pg_temp.expect_error($q$select * from public.list_stage_deals('somewhere')$q$, '22023', 'stage');
  perform pg_temp.expect_error($q$select * from public.list_stage_deals('lead', p_limit => 0)$q$, '22023', 'limit');
  perform pg_temp.expect_error($q$select * from public.list_stage_deals('lead', p_limit => 101)$q$, '22023', 'limit');
  perform pg_temp.expect_error($q$select public.pipeline_board(p_per_stage => 0)$q$, '22023', 'limit');
  perform pg_temp.expect_error($q$select public.pipeline_board(p_per_stage => 101)$q$, '22023', 'limit');
  perform pg_temp.expect_error(format('select * from public.list_lead_deals(%L, 0)', lead), '22023', 'limit');
  -- list_lead_deals: open first (newest in stage first), then closed (newest close first).
  if (select array_agg(l.status order by l.rn) from (select x.status, row_number() over () as rn
                                                   from public.list_lead_deals(lead, 100) x) l)
     <> array_fill('open'::text, array[30]) || array['won', 'won', 'lost', 'lost', 'won'] then
    raise exception 'FAIL: list_lead_deals order';
  end if;
  -- The next cursor of the board pages on from where the first page stopped.
  perform pg_temp.act(admin);
  b := public.pipeline_board('team', null, 7);
  s := b -> 'stages' -> 0 -> 'next';
  if (select l.id from public.list_stage_deals('lead', 'team', null, false, 'recent', (s ->> 'after_at')::timestamptz,
                                               (s ->> 'after_id')::uuid, 1) l)
     is distinct from (select x.id from public.deals x where x.org_id = org and x.status = 'open' and x.owner_id = r1
                        order by x.stage_entered_at desc, x.id desc offset 7 limit 1) then
    raise exception 'FAIL: the board''s next cursor';
  end if;
  perform pg_temp.su();
  perform pg_temp.invariants('board');
  raise exception 'undo' using errcode = 'TS001';
exception when sqlstate 'TS001' then perform pg_temp.su();
end $$;

-- 10. Days in stage and stalled (D16; 5.5): the shared cases, in three session time zones ------------------------------
-- Columns: stage, hours in stage, hours since the lead's last activity (null: never), expected stalled, expected quiet
-- days. Elapsed hours, 24 a day: the answer is the same in every session time zone and across a clock change.
do $$
declare
  admin constant uuid := '00000000-0000-0000-0000-00000000000a';
  -- stall-cases:start (shared with tests/unit/days-in-stage.spec.ts in 5b)
  src text := $cases$
lead|167.9997|null|false|6
lead|168|null|false|7
lead|168.0003|null|true|7
qualified|335.9997|null|false|13
qualified|336.0003|null|true|14
negotiations|503.9997|null|false|20
negotiations|504.0003|null|true|21
lead|720|1|false|0
lead|1|720|false|0
lead|240|192|true|8
lead|240|170|true|7
lead|240|160|false|6
qualified|400|300|false|12
negotiations|600|510|true|21
won|1000|null|false|null
lost|1000|null|false|null
$cases$;
  -- stall-cases:end
  line text;
  f text[];
  lead uuid;
  deal uuid;
  zone text;
  card record;
begin
  foreach zone in array array['UTC', 'Europe/Paris', 'America/New_York', 'Asia/Karachi'] loop
    perform set_config('timezone', zone, true);
    foreach line in array regexp_split_to_array(btrim(src, E'\n'), E'\n') loop
      f := string_to_array(line, '|');
      perform pg_temp.su();
      lead := pg_temp.new_lead('00000000-0000-0000-0000-0000000005a1', 'warm', 'Stall case');
      update public.companies set last_activity_at = case when f[3] = 'null' then null
                                                          else now() - make_interval(secs => f[3]::numeric * 3600) end
       where id = lead;
      insert into public.deals (org_id, company_id, stage_id, owner_id, value, fulfilment, status, closed_at, lost_reason,
                                stage_entered_at)
      select c.org_id, lead, s.id, '00000000-0000-0000-0000-0000000005a1',
             case when f[1] = 'won' then 10 end, case when f[1] = 'won' then 'from_stock' end,
             case when f[1] in ('won', 'lost') then f[1] else 'open' end,
             case when f[1] in ('won', 'lost') then now() end, case when f[1] = 'lost' then 'price' end,
             now() - make_interval(secs => f[2]::numeric * 3600)
        from public.companies c join public.pipeline_stages s on s.org_id = c.org_id and s.key = f[1]
       where c.id = lead returning id into deal;
      perform pg_temp.act(admin);
      select x.is_stalled, x.quiet_days into card from public.list_lead_deals(lead) x where x.id = deal;
      if card.is_stalled <> f[4]::boolean or card.quiet_days is distinct from nullif(f[5], 'null')::integer then
        raise exception 'FAIL: stall case "%" in %: stalled %, quiet %', line, zone, card.is_stalled, card.quiet_days;
      end if;
    end loop;
  end loop;
  perform pg_temp.su();
  raise exception 'undo' using errcode = 'TS001';
exception when sqlstate 'TS001' then perform pg_temp.su();
end $$;

-- 11. get_deal, move records, audit, flood guards (threats 13, 22, 26) ----------------------------------------------------
do $$
declare
  r1 constant uuid := '00000000-0000-0000-0000-0000000005a1';
  r2 constant uuid := '00000000-0000-0000-0000-0000000005a2';
  admin constant uuid := '00000000-0000-0000-0000-00000000000a';
  lead uuid := pg_temp.new_lead(r1, 'warm');
  deal uuid;
  r jsonb;
  g jsonb;
  hid bigint;
  n integer;
  req uuid := gen_random_uuid();
begin
  perform pg_temp.act(r1);
  deal := pg_temp.open(lead, 'Sheet', 120);
  r := public.move_deal(deal, 'qualified', 0, p_request_id => req);
  perform pg_temp.su();
  insert into public.activities (org_id, company_id, deal_id, type, outcome, body, user_id)
  select org_id, lead, deal, 'call', 'connected', 'SECRET-BODY-5106', r1 from public.companies where id = lead;
  perform pg_temp.act(r1);
  g := public.get_deal(deal);
  if g ->> 'stage' <> 'qualified' or (g -> 'lead' ->> 'can_edit')::boolean is not true or (g ->> 'stall_days')::int <> 14
     or jsonb_array_length(g -> 'history') <> 2 or g -> 'history' -> 0 ->> 'kind' <> 'move'
     or g -> 'history' -> 0 ->> 'actor_first_name' <> 'Rae' or (g -> 'undo' ->> 'history_id')::bigint <> (r ->> 'history_id')::bigint
     or (g ->> 'can_delete')::boolean  -- a rep after a move: no delete
     or jsonb_array_length(g -> 'activities') <> 1 or g::text like '%SECRET-BODY-5106%'
     or g -> 'activities' -> 0 ? 'body' then
    raise exception 'FAIL: get_deal %', g;
  end if;
  -- After an undo the pair is flagged in the history.
  perform pg_temp.mv(deal, 'lead', undo_of => (r ->> 'history_id')::bigint);
  g := public.get_deal(deal);
  if not (g -> 'history' -> 1 ->> 'undone')::boolean or g -> 'history' -> 0 ->> 'kind' <> 'undo'
     or jsonb_typeof(g -> 'undo') <> 'null' then
    raise exception 'FAIL: get_deal undo pair %', g -> 'history';
  end if;
  -- deal_moves_own_rows_only: one's own records only; nobody writes one for another person's change or another lead.
  hid := (select max(id) from public.deal_stage_history where deal_id = deal);
  if (select count(*) from private.deal_moves) = 0 then raise exception 'FAIL: the open left no move record'; end if;
  perform pg_temp.expect_error(format('insert into private.deal_moves (history_id, org_id, user_id, deal_id, company_id) select %s, org_id, %L, %L, %L from public.deals where id = %L',
                                      hid, r1, deal, gen_random_uuid(), deal), '42501');
  perform pg_temp.act(admin);
  if exists (select 1 from private.deal_moves where user_id = r1) then
    raise exception 'FAIL: deal_moves_own_rows_only (another person''s rows are visible)';
  end if;
  perform pg_temp.expect_error(format('insert into private.deal_moves (history_id, org_id, user_id, deal_id, company_id) select %s, org_id, %L, %L, %L from public.deals where id = %L',
                                      hid, admin, deal, lead, deal), '42501');
  delete from private.deal_moves where user_id = r1;
  perform pg_temp.su();
  if not exists (select 1 from private.deal_moves where user_id = r1) then
    raise exception 'FAIL: an admin deleted another person''s move records';
  end if;
  -- audit_deal_insert_update_delete_rows, audit_version_not_diffed, audit_lost_note_masked, audit_deal_value_change_logged
  perform pg_temp.act(r1);
  perform public.update_deal(deal, (select version from public.deals where id = deal), '{value}', p_value => 4400);
  perform pg_temp.mv(deal, 'lost', reason => 'other', note => 'NOTE-TEXT-5107 asked for credit');
  perform pg_temp.su();
  if not exists (select 1 from public.audit_log where table_name = 'deals' and record_id = deal::text and action = 'insert')
     or not exists (select 1 from public.audit_log where table_name = 'deals' and record_id = deal::text and action = 'update'
                    and diff_json -> 'value' ->> 'old' = '120.00' and diff_json -> 'value' ->> 'new' = '4400.00')
     or not exists (select 1 from public.audit_log where table_name = 'deals' and record_id = deal::text and action = 'update'
                    and diff_json ? 'stage_id' and diff_json ? 'status' and diff_json ? 'closed_at'
                    and (diff_json -> 'lost_note' ->> 'changed')::boolean and (diff_json -> 'lost_note' ->> 'new_len')::int = 31) then
    raise exception 'FAIL: audit_deal_insert_update_delete_rows / audit_deal_value_change_logged / audit_lost_note_masked: %',
      (select jsonb_agg(jsonb_build_object('action', action, 'diff', diff_json) order by id) from public.audit_log
        where table_name = 'deals' and record_id = deal::text);
  end if;
  if exists (select 1 from public.audit_log where table_name = 'deals'
               and (diff_json ? 'version' or diff_json::text like '%NOTE-TEXT-5107%')) then
    raise exception 'FAIL: audit_version_not_diffed / audit_lost_note_masked';
  end if;
  if exists (select 1 from public.audit_log where table_name = 'deals' and diff_json -> 'new' ? 'lost_note') then
    raise exception 'FAIL: a new deal''s audit row carries the note itself';
  end if;
  if exists (select 1 from public.audit_log where table_name = 'deal_stage_history') then
    raise exception 'FAIL: stage history should not be audited';
  end if;
  -- open_deal_rate_limited: 30 opens in the last hour (r2's open records, made as the superuser), the 31st is refused;
  -- records older than an hour do not count, and the next open removes them.
  insert into private.deal_opens (user_id, created_at)
  select r2, now() - interval '30 minutes' from generate_series(1, 29);
  insert into private.deal_opens (user_id, created_at)
  select r2, now() - interval '2 hours' from generate_series(1, 5);
  update public.companies set owner_id = r2 where id = lead;
  perform pg_temp.act(r2);
  perform pg_temp.open(lead, 'The 30th');  -- 29 recent + this one
  perform pg_temp.su();
  if (select count(*) from private.deal_opens where user_id = r2) <> 30 then
    raise exception 'FAIL: an open should remove its author''s open records older than an hour';
  end if;
  perform pg_temp.act(r2);
  perform pg_temp.expect_error(format('select public.open_deal(%L)', lead), '22023', 'rate_limited');
  -- move_rate_limited: 120 stage changes in the last minute.
  perform pg_temp.su();
  insert into public.deal_stage_history (org_id, deal_id, actor_id, kind, from_stage, to_stage, version_after, created_at)
  select org_id, deal, r1, 'move', 'qualified', 'qualified', 0, now() - interval '10 seconds'
    from public.deals d, generate_series(1, 120) where d.id = deal;
  perform pg_temp.act(r1);
  perform pg_temp.expect_error(format('update public.deals set stage_id = private.stage_id(%L) where id = %L', 'qualified', deal), '22023', 'rate_limited');
  perform pg_temp.su();
  raise exception 'undo' using errcode = 'TS001';
exception when sqlstate 'TS001' then perform pg_temp.su();
end $$;

-- 12. Referential links empty without a version-free change; DEFINER code paths and the task guard (G8) --------------
do $$
declare
  r1 constant uuid := '00000000-0000-0000-0000-0000000005a1';
  admin constant uuid := '00000000-0000-0000-0000-00000000000a';
  lead uuid := pg_temp.new_lead(r1, 'warm');
  contact uuid;
  deal uuid;
  v integer;
begin
  insert into public.contacts (org_id, company_id, first_name) select org_id, id, 'Goes away' from public.companies
   where id = lead returning id into contact;
  perform pg_temp.act(r1);
  deal := (public.open_deal(lead, 'With contact', p_contact => contact) -> 'deal' ->> 'id')::uuid;
  v := (select version from public.deals where id = deal);
  -- A contact delete (fresh code) empties the deal's link one level down: allowed, and it counts as a change.
  delete from public.contacts where id = contact;
  perform pg_temp.su();
  if (select contact_id from public.deals where id = deal) is not null or (select version from public.deals where id = deal) <> v + 1 then
    raise exception 'FAIL: a contact delete should empty the deal''s link and move its version';
  end if;
  perform pg_temp.invariants('referential');
  raise exception 'undo' using errcode = 'TS001';
exception when sqlstate 'TS001' then perform pg_temp.su();
end $$;

-- 13. The Day 6 seam with a stub that blocks (threat 30; section 10): every call site refuses while stock records hold
-- the deal. The superuser swaps the stub for one returning 'order' inside this block, which is rolled back (the null
-- stub comes back). A win that keeps the shipping, a move between open stages and a title change are not blocked.
do $$
declare
  r1 constant uuid := '00000000-0000-0000-0000-0000000005a1';
  admin constant uuid := '00000000-0000-0000-0000-00000000000a';
  lead uuid := pg_temp.new_lead(r1, 'warm');
  d_reopen uuid;   -- won over 120 s ago: reopening it
  d_undo uuid;     -- won just now: undoing the win
  d_ship uuid;     -- open, shipping from stock: changing the shipping (patch, update_deal, a win that changes it)
  d_keep uuid;     -- open, shipping from stock: a win that keeps it
  d_del uuid;      -- just opened: the creator's delete
  d_del2 uuid;     -- moved: an admin's delete with a fresh code
  win jsonb;
  v integer;
begin
  perform pg_temp.act(r1);
  d_reopen := pg_temp.open(lead, 'Seam reopen');
  perform pg_temp.mv(d_reopen, 'won', 500, 'from_stock');
  d_undo := pg_temp.open(lead, 'Seam undo');
  win := pg_temp.mv(d_undo, 'won', 600, 'direct_from_source');
  d_ship := pg_temp.open(lead, 'Seam shipping');
  perform public.update_deal(d_ship, 0, '{fulfilment}', p_fulfilment => 'from_stock');
  d_keep := pg_temp.open(lead, 'Seam keep');
  perform public.update_deal(d_keep, 0, '{fulfilment}', p_fulfilment => 'from_stock');
  d_del := pg_temp.open(lead, 'Seam delete');
  d_del2 := pg_temp.open(lead, 'Seam delete 2');
  perform pg_temp.mv(d_del2, 'qualified');
  perform pg_temp.su();
  perform pg_temp.age_history(d_reopen, 300);
  create or replace function private.deal_closing_blocked(p_deal uuid) returns text
  language sql stable set search_path = '' as $f$
    select 'order'::text where p_deal is not null
  $f$;
  if private.deal_closing_blocked(gen_random_uuid()) is distinct from 'order' then
    raise exception 'FAIL: the blocking stub was not swapped in';
  end if;
  -- closing_blocked_on_reopen: reopening a won deal, with a fresh code, by the owner and by an admin.
  perform pg_temp.act(r1, 'aal2', 30);
  perform pg_temp.expect_error(format('select pg_temp.mv(%L, %L)', d_reopen, 'negotiations'), '42501', 'blocked_order');
  perform pg_temp.act(admin, 'aal2', 30);
  perform pg_temp.expect_error(format('update public.deals set stage_id = private.stage_id(%L) where id = %L', 'lead', d_reopen), '42501', 'blocked_order');
  -- closing_blocked_on_undo_win: the Undo button and the drag back, both inside the window.
  perform pg_temp.act(r1, 'aal2', 30);
  perform pg_temp.expect_error(format('select pg_temp.mv(%L, %L, undo_of => %s)', d_undo, 'lead', win ->> 'history_id'), '42501', 'blocked_order');
  perform pg_temp.expect_error(format('update public.deals set stage_id = private.stage_id(%L) where id = %L', 'lead', d_undo), '42501', 'blocked_order');
  -- closing_blocked_on_fulfilment_change: update_deal, a direct patch, and a win that switches the shipping.
  perform pg_temp.expect_error(format('select public.update_deal(%L, 1, %L, p_fulfilment => %L)', d_ship, '{fulfilment}', 'direct_from_source'), '42501', 'blocked_order');
  perform pg_temp.expect_error(format('select public.update_deal(%L, 1, %L, p_fulfilment => null)', d_ship, '{fulfilment}'), '42501', 'blocked_order');
  perform pg_temp.expect_error(format('update public.deals set fulfilment = %L where id = %L', 'direct_from_source', d_ship), '42501', 'blocked_order');
  perform pg_temp.expect_error(format('select pg_temp.mv(%L, %L, 700, %L)', d_ship, 'won', 'direct_from_source'), '42501', 'blocked_order');
  perform pg_temp.expect_error(format('update public.deals set stage_id = private.stage_id(%L), value = 700, fulfilment = %L where id = %L', 'won', 'direct_from_source', d_ship), '42501', 'blocked_order');
  -- closing_blocked_on_delete: the creator's window and an admin with a fresh code.
  perform pg_temp.act(r1, 'aal2', null);
  perform pg_temp.expect_error(format('select public.delete_deal(%L)', d_del), '42501', 'blocked_order');
  perform pg_temp.act(admin, 'aal2', 30);
  perform pg_temp.expect_error(format('select public.delete_deal(%L)', d_del2), '42501', 'blocked_order');
  -- Not blocked: a move between open stages, a title change, a win that keeps (or first sets) the shipping.
  perform pg_temp.act(r1, 'aal2', 30);
  perform pg_temp.mv(d_ship, 'qualified');
  v := (select version from public.deals where id = d_ship);
  perform public.update_deal(d_ship, v, '{title}', 'Seam renamed');
  if (pg_temp.mv(d_keep, 'won', 800) -> 'deal' ->> 'status') <> 'won'
     or (select fulfilment from public.deals where id = d_keep) <> 'from_stock' then
    raise exception 'FAIL: a win that keeps the shipping should not be blocked';
  end if;
  perform pg_temp.su();
  if pg_temp.key(d_reopen) <> 'won' or pg_temp.key(d_undo) <> 'won' or not exists (select 1 from public.deals where id = d_del)
     or not exists (select 1 from public.deals where id = d_del2)
     or (select fulfilment from public.deals where id = d_ship) <> 'from_stock' then
    raise exception 'FAIL: a blocked change was written';
  end if;
  perform pg_temp.invariants('the blocking seam');
  raise exception 'undo' using errcode = 'TS001';
exception when sqlstate 'TS001' then perform pg_temp.su();
end $$;
do $$ begin
  if private.deal_closing_blocked(gen_random_uuid()) is not null then
    raise exception 'FAIL: the null stub should be back after the rolled-back block';
  end if;
end $$;

-- 14. Verifier round 1: a deal keeps an owner, a repeated Undo is a replay, opens that were deleted still count -------
do $$
declare
  r1 constant uuid := '00000000-0000-0000-0000-0000000005a1';
  admin constant uuid := '00000000-0000-0000-0000-00000000000a';
  lead uuid := pg_temp.new_lead(r1, 'warm');
  deal uuid;
  r jsonb;
  u jsonb;
  u2 jsonb;
  req uuid := gen_random_uuid();
  n integer;
  i integer;
begin
  -- deal_owner_never_emptied (G11): neither update_deal nor a direct patch empties the owner, for an admin either.
  perform pg_temp.act(r1);
  deal := pg_temp.open(lead, 'Owned');
  perform pg_temp.act(admin);
  perform pg_temp.expect_error(format('select public.update_deal(%L, 0, %L, p_owner => null)', deal, '{owner_id}'), '22023', 'owner_required');
  perform pg_temp.expect_error(format('update public.deals set owner_id = null where id = %L', deal), '22023', 'owner_required');
  r := public.update_deal(deal, 0, '{owner_id}', p_owner => admin);  -- a new owner is fine
  if (select owner_id from public.deals where id = deal) is distinct from admin then
    raise exception 'FAIL: an admin hands a deal to someone %', r;
  end if;
  -- undo_replay_returns_stored: the same Undo request twice answers the stored undo, and writes nothing more.
  r := pg_temp.mv(deal, 'qualified');
  u := public.move_deal(deal, 'lead', (r -> 'deal' ->> 'version')::int, p_undo_of => (r ->> 'history_id')::bigint,
                        p_request_id => req);
  n := (select count(*) from public.deal_stage_history where deal_id = deal);
  u2 := public.move_deal(deal, 'lead', (r -> 'deal' ->> 'version')::int, p_undo_of => (r ->> 'history_id')::bigint,
                         p_request_id => req);
  if not (u ->> 'undone')::boolean or u2 ->> 'result' <> 'moved' or not (u2 ->> 'replayed')::boolean
     or not (u2 ->> 'undone')::boolean or u2 ->> 'history_id' <> u ->> 'history_id'
     or (select count(*) from public.deal_stage_history where deal_id = deal) <> n or pg_temp.key(deal) <> 'lead' then
    raise exception 'FAIL: undo_replay_returns_stored % / %', u, u2;
  end if;
  -- open_deal_rate_counts_deleted_opens (threat 22): 30 opens deleted in the creator's window still count; the 31st
  -- open is refused, through the RPC and a direct insert.
  perform pg_temp.act(r1, 'aal2', null);
  for i in 1 .. 29 loop
    perform public.delete_deal(pg_temp.open(lead, 'Flood ' || i));
  end loop;
  perform pg_temp.su();
  if (select count(*) from public.deals where created_by = r1 and created_at > now() - interval '1 hour') <> 1 then
    raise exception 'FAIL: the flood deals should be gone (only "Owned" stays)';
  end if;
  perform pg_temp.act(r1, 'aal2', null);
  perform pg_temp.expect_error(format('select public.open_deal(%L)', lead), '22023', 'rate_limited');
  perform pg_temp.expect_error(format('insert into public.deals (company_id) values (%L)', lead), '22023', 'rate_limited');
  -- Another person's opens do not count against r1's limit (own rows only), and r1 cannot read or write them.
  perform pg_temp.act(admin);
  perform pg_temp.open(lead, 'Admin opens');
  if exists (select 1 from private.deal_opens where user_id <> admin) then
    raise exception 'FAIL: deal_opens_own_rows_only (another person''s opens are visible)';
  end if;
  perform pg_temp.expect_error(format('insert into private.deal_opens (user_id) values (%L)', admin), '42501');
  perform pg_temp.expect_error('delete from private.deal_opens', '42501');
  perform pg_temp.su();
  perform pg_temp.invariants('verifier round 1');
  raise exception 'undo' using errcode = 'TS001';
exception when sqlstate 'TS001' then perform pg_temp.su();
end $$;

-- 15. Verifier round 2: one statement with many rows cannot pass the flood guards (threat 22; N1, N2) ----------------
-- The guard counts before each row, but the open records and history rows are written by the AFTER row trigger at the
-- end of the statement; the statement-level triggers count again after it.
do $$
declare
  r1 constant uuid := '00000000-0000-0000-0000-0000000005a1';
  r2 constant uuid := '00000000-0000-0000-0000-0000000005a2';
  lead uuid := pg_temp.new_lead(r1, 'warm');
  lead2 uuid := pg_temp.new_lead(r2, 'warm');
  own uuid;
  other uuid;
  one uuid;
  n integer;
begin
  -- stage_flood_counts_hidden_history: 120 of r1's stage changes on a deal r1 can no longer see (handed to r2) still
  -- count. The guard (INVOKER) sees none of them; the statement check (DEFINER) refuses the next move.
  insert into public.deals (org_id, company_id, owner_id, stage_id)
  select c.org_id, lead, r1, s.id from public.companies c join public.pipeline_stages s on s.org_id = c.org_id and s.key = 'lead'
   where c.id = lead returning id into own;
  insert into public.deals (org_id, company_id, owner_id, stage_id)
  select c.org_id, lead2, r2, s.id from public.companies c join public.pipeline_stages s on s.org_id = c.org_id and s.key = 'lead'
   where c.id = lead2 returning id into other;
  insert into public.deal_stage_history (org_id, deal_id, actor_id, kind, from_stage, to_stage, version_after, created_at)
  select org_id, other, r1, 'move', 'lead', 'lead', 0, now() - interval '10 seconds'
    from public.deals d, generate_series(1, 120) where d.id = other;
  perform pg_temp.act(r1);
  if exists (select 1 from public.deal_stage_history where actor_id = r1) then
    raise exception 'FAIL: the hidden history should be invisible to r1 (the scenario needs it)';
  end if;
  perform pg_temp.expect_error(format('update public.deals set stage_id = private.stage_id(%L) where id = %L', 'qualified', own), '22023', 'rate_limited');
  perform pg_temp.su();
  delete from public.deal_stage_history where actor_id = r1 and deal_id = other;

  -- bulk_insert_over_open_limit_refused: one INSERT of 31 rows, and the PostgREST bulk-POST shape (100 rows through
  -- json_populate_recordset), are refused whole: no deal, no open record, no history row is left.
  perform pg_temp.act(r1);
  perform pg_temp.expect_error(format('insert into public.deals (company_id) select %L::uuid from generate_series(1, 31)', lead), '22023', 'rate_limited');
  perform pg_temp.expect_error(format(
    'insert into public.deals (company_id, title) select company_id, title from json_populate_recordset(null::public.deals, %L)',
    (select json_agg(json_build_object('company_id', lead, 'title', 'Bulk ' || g)) from generate_series(1, 100) g)), '22023', 'rate_limited');
  perform pg_temp.su();
  if exists (select 1 from public.deals where created_by = r1) or exists (select 1 from private.deal_opens where user_id = r1)
     or exists (select 1 from public.deal_stage_history where actor_id = r1) then
    raise exception 'FAIL: bulk_insert_over_open_limit_refused (a refused bulk insert left rows)';
  end if;
  -- bulk_insert_at_open_limit_ok: 30 rows in one INSERT are the limit itself; the next open is refused (guard and RPC).
  perform pg_temp.act(r1);
  insert into public.deals (company_id, title) select lead, 'Bulk ' || g from generate_series(1, 30) g;
  perform pg_temp.expect_error(format('insert into public.deals (company_id) values (%L)', lead), '22023', 'rate_limited');
  perform pg_temp.expect_error(format('select public.open_deal(%L)', lead), '22023', 'rate_limited');
  perform pg_temp.su();
  if (select count(*) from public.deals where created_by = r1) <> 30 or (select count(*) from private.deal_opens where user_id = r1) <> 30 then
    raise exception 'FAIL: bulk_insert_at_open_limit_ok';
  end if;

  -- bulk_patch_over_move_limit_refused: one PATCH moving 150 of r2's deals is refused whole (no move, no history row).
  insert into public.deals (org_id, company_id, owner_id, stage_id)
  select c.org_id, lead2, r2, s.id from public.companies c join public.pipeline_stages s on s.org_id = c.org_id and s.key = 'lead',
         generate_series(1, 149) where c.id = lead2;
  perform pg_temp.act(r2);
  perform pg_temp.expect_error(format('update public.deals set stage_id = private.stage_id(%L) where company_id = %L', 'qualified', lead2), '22023', 'rate_limited');
  perform pg_temp.su();
  if (select count(*) from public.deals d join public.pipeline_stages s on s.id = d.stage_id
       where d.company_id = lead2 and s.key <> 'lead') <> 0
     or exists (select 1 from public.deal_stage_history where actor_id = r2) then
    raise exception 'FAIL: bulk_patch_over_move_limit_refused (a refused bulk move left rows)';
  end if;
  -- bulk_patch_at_move_limit_ok: 120 moves in one PATCH are the limit itself; the next move is refused.
  perform pg_temp.act(r2);
  update public.deals set stage_id = private.stage_id('qualified')
   where id in (select id from public.deals where company_id = lead2 order by id limit 120);
  select id into one from public.deals d where d.company_id = lead2 and d.stage_id = private.stage_id('lead') limit 1;
  perform pg_temp.expect_error(format('update public.deals set stage_id = private.stage_id(%L) where id = %L', 'qualified', one), '22023', 'rate_limited');
  -- stage_flood_ignores_other_edits: past the limit (one more change made by r2 elsewhere, 121), a statement that
  -- changes no stage is not refused; a move still is.
  perform pg_temp.su();
  insert into public.deal_stage_history (org_id, deal_id, actor_id, kind, from_stage, to_stage, version_after, created_at)
  select org_id, other, r2, 'move', 'lead', 'lead', 0, now() - interval '5 seconds' from public.deals where id = other;
  perform pg_temp.act(r2);
  update public.deals set title = 'Renamed' where company_id = lead2;
  perform pg_temp.expect_error(format('update public.deals set stage_id = private.stage_id(%L) where id = %L', 'qualified', one), '22023', 'rate_limited');
  perform pg_temp.su();
  if (select count(*) from public.deals d where d.company_id = lead2 and d.title = 'Renamed') <> 150
     or (select count(*) from public.deal_stage_history where actor_id = r2) <> 121 then
    raise exception 'FAIL: bulk_patch_at_move_limit_ok / stage_flood_ignores_other_edits';
  end if;
  delete from public.deal_stage_history where actor_id = r2 and deal_id = other and from_stage = to_stage;  -- the made-up row
  perform pg_temp.invariants('verifier round 2');
  raise exception 'undo' using errcode = 'TS001';
exception when sqlstate 'TS001' then perform pg_temp.su();
end $$;

do $$ begin perform pg_temp.invariants('the end of deals_attack'); end $$;
\echo 'deals_attack: all checks passed'
