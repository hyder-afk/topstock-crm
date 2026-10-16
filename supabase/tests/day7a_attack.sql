-- Day 7a attack tests (migration 20261021100000_day7a_security.sql; docs/evidence/day7a/README.md). Runs after the
-- earlier files in scripts/db-test.sh (CI job "rls"), on the same database, with its own fixture people:
--   A. An owner from another organisation is refused on every path a manager or an admin can choose one (lead owner,
--      deal owner through open_deal and update_deal, task assignee through create_task, update_task and a direct
--      write): by private.enforce_org_and_owner for signed-in callers (42501), and by the composite foreign keys for
--      sessions with no signed-in user, which the trigger skips (23503).
--   B. Sign-in audit rows: a person writes only their own row ('sign_in' or 'mfa_verify', table 'auth', nothing else),
--      only with a two-factor session, never another person's or another organisation's, never another action, and
--      cannot change or delete one; at most 30 an hour; admins of the organisation read them, nobody else.
-- Each scenario that writes runs in a block that is rolled back at the end (raise TS001, caught).
\set ON_ERROR_STOP 1
\set QUIET 1

create function pg_temp.as_user(sub text, aal text, totp_age_s integer default null) returns void
language sql as $$
  select set_config('request.jwt.claims', jsonb_build_object(
    'sub', sub, 'role', 'authenticated', 'aal', aal,
    'amr', case when totp_age_s is null then '[]'::jsonb else jsonb_build_array(
      jsonb_build_object('method', 'totp', 'timestamp', extract(epoch from now())::bigint - totp_age_s)) end
  )::text, false)
$$;
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
create function pg_temp.expect_error(stmt text, want_state text, want_hint text default null) returns void
language plpgsql as $$
declare
  got_state text;
  got_hint text;
  got_msg text;
begin
  begin
    execute stmt;
  exception when others then
    get stacked diagnostics got_state = returned_sqlstate, got_hint = pg_exception_hint, got_msg = message_text;
    if got_state <> want_state or (want_hint is not null and coalesce(got_hint, '') <> want_hint) then
      raise exception 'FAIL: "%" gave % (hint "%", %), expected % (hint "%")', left(stmt, 200), got_state, got_hint,
        got_msg, want_state, want_hint;
    end if;
    return;
  end;
  raise exception 'FAIL: "%" succeeded, expected %', left(stmt, 200), want_state;
end;
$$;
create function pg_temp.eq(label text, got anyelement, want anyelement) returns void
language plpgsql as $$
begin
  if got is distinct from want then
    raise exception 'FAIL: % is %, expected %', label, got, want;
  end if;
end;
$$;

-- Fixtures: manager Mia and rep Rio in TopStock, admin Xan in a separate organisation. Rio owns a lead, a deal on it and
-- a task. Written by the superuser (no signed-in user: the guards leave the rows as given).
insert into auth.users (id, email, raw_user_meta_data) values
  ('00000000-0000-0000-0000-0000d7a00001', 'mia7a@test.invalid', '{"first_name":"Mia"}'),
  ('00000000-0000-0000-0000-0000d7a00002', 'rio7a@test.invalid', '{"first_name":"Rio"}'),
  ('00000000-0000-0000-0000-0000d7a00003', 'xan7a@test.invalid', '{"first_name":"Xan"}'),
  ('00000000-0000-0000-0000-0000d7a00004', 'ada7a@test.invalid', '{"first_name":"Ada"}');
insert into public.orgs (id, name) values ('00000000-0000-0000-0000-0000d7a000cc', 'Seven Other Org');
do $$
declare
  main_org constant uuid := (select id from public.orgs where name = 'TopStock Wholesale');
  lead_stage constant uuid := (select s.id from public.pipeline_stages s where s.org_id = main_org and s.key = 'lead');
begin
  update public.profiles set role = 'manager' where id = '00000000-0000-0000-0000-0000d7a00001';
  update public.profiles set role = 'rep' where id = '00000000-0000-0000-0000-0000d7a00002';
  update public.profiles set role = 'admin' where id = '00000000-0000-0000-0000-0000d7a00004';
  update public.profiles set org_id = '00000000-0000-0000-0000-0000d7a000cc', role = 'admin'
   where id = '00000000-0000-0000-0000-0000d7a00003';
  insert into public.companies (id, org_id, name, owner_id, lead_status, country)
  values ('30000000-0000-0000-0000-0000d7a00002', main_org, 'Co 7a', '00000000-0000-0000-0000-0000d7a00002', 'warm', 'FR');
  insert into public.deals (id, org_id, company_id, stage_id, owner_id)
  values ('40000000-0000-0000-0000-0000d7a00002', main_org, '30000000-0000-0000-0000-0000d7a00002', lead_stage,
          '00000000-0000-0000-0000-0000d7a00002');
  insert into public.tasks (id, org_id, company_id, title, assignee_id)
  values ('60000000-0000-0000-0000-0000d7a00002', main_org, '30000000-0000-0000-0000-0000d7a00002', 'Call back',
          '00000000-0000-0000-0000-0000d7a00002');
end $$;

-- A. Same-organisation owner -------------------------------------------------------------------------------------
-- A0. The rule is in the catalog: the three composite keys exist, are validated, and point at profiles (id, org_id).
do $$
declare k text;
begin
  foreach k in array array['companies_owner_same_org', 'deals_owner_same_org', 'tasks_assignee_same_org'] loop
    if not exists (select 1 from pg_constraint c where c.conname = k and c.contype = 'f' and c.convalidated
                     and c.confrelid = 'public.profiles'::regclass and cardinality(c.conkey) = 2) then
      raise exception 'FAIL: foreign key % missing or not validated', k;
    end if;
  end loop;
end $$;

-- A1. Signed-in manager (two-factor): every path that takes an owner refuses one from another organisation (42501,
-- the trigger's own refusal, before the key would), and still accepts a colleague (positive controls).
do $$
declare
  xan constant text := '00000000-0000-0000-0000-0000d7a00003';
  v int;
begin
  perform pg_temp.act('00000000-0000-0000-0000-0000d7a00001');
  perform pg_temp.expect_error(format(
    $q$update public.companies set owner_id = %L where id = '30000000-0000-0000-0000-0000d7a00002'$q$, xan), '42501');
  perform pg_temp.expect_error(format(
    $q$select public.bulk_update_leads(array['30000000-0000-0000-0000-0000d7a00002']::uuid[], null, true, %L)$q$, xan),
    '42501');
  perform pg_temp.expect_error(format(
    $q$select public.open_deal('30000000-0000-0000-0000-0000d7a00002', p_owner => %L)$q$, xan), '42501');
  v := (select version from public.deals where id = '40000000-0000-0000-0000-0000d7a00002');
  perform pg_temp.expect_error(format(
    $q$select public.update_deal('40000000-0000-0000-0000-0000d7a00002', %s, array['owner_id'], p_owner => %L)$q$, v, xan),
    '42501');
  perform pg_temp.expect_error(format(
    $q$update public.deals set owner_id = %L where id = '40000000-0000-0000-0000-0000d7a00002'$q$, xan), '42501');
  perform pg_temp.expect_error(format(
    $q$select public.create_task('Follow up', '30000000-0000-0000-0000-0000d7a00002', p_assignee => %L)$q$, xan), '42501');
  perform pg_temp.expect_error(format(
    $q$select public.update_task('60000000-0000-0000-0000-0000d7a00002', 'Call back', null, null, %L, null)$q$, xan),
    '42501');
  perform pg_temp.expect_error(format(
    $q$update public.tasks set assignee_id = %L where id = '60000000-0000-0000-0000-0000d7a00002'$q$, xan), '42501');
  -- Positive controls: a colleague in the same organisation is accepted on the same paths.
  update public.companies set owner_id = '00000000-0000-0000-0000-0000d7a00001'
   where id = '30000000-0000-0000-0000-0000d7a00002';
  perform pg_temp.eq('lead owner after a same-org change',
    (select owner_id from public.companies where id = '30000000-0000-0000-0000-0000d7a00002'),
    '00000000-0000-0000-0000-0000d7a00001'::uuid);
  perform public.update_task('60000000-0000-0000-0000-0000d7a00002', 'Call back', null, null,
                             '00000000-0000-0000-0000-0000d7a00001', null);
  perform pg_temp.eq('task assignee after a same-org change',
    (select assignee_id from public.tasks where id = '60000000-0000-0000-0000-0000d7a00002'),
    '00000000-0000-0000-0000-0000d7a00001'::uuid);
  raise exception 'undo' using errcode = 'TS001';
exception when sqlstate 'TS001' then perform pg_temp.su();
end $$;

-- A2. An admin of the other organisation cannot hand its own records to a TopStock person either (same rule, the
-- other way round), and an admin of TopStock cannot pick the outsider.
do $$
begin
  perform pg_temp.act('00000000-0000-0000-0000-0000d7a00004');
  perform pg_temp.expect_error(
    $q$update public.companies set owner_id = '00000000-0000-0000-0000-0000d7a00003'
        where id = '30000000-0000-0000-0000-0000d7a00002'$q$, '42501');
  perform pg_temp.act('00000000-0000-0000-0000-0000d7a00003');
  perform pg_temp.expect_error(
    $q$insert into public.companies (name, owner_id, country) values ('X co', '00000000-0000-0000-0000-0000d7a00002', 'FR')$q$,
    '42501');
  raise exception 'undo' using errcode = 'TS001';
exception when sqlstate 'TS001' then perform pg_temp.su();
end $$;

-- A3. No signed-in user (imports, maintenance, service paths; the trigger skips them): the composite keys refuse an
-- owner from another organisation (23503) on insert and update, and accept a same-org one.
do $$
declare
  main_org constant uuid := (select id from public.orgs where name = 'TopStock Wholesale');
  lead_stage constant uuid := (select s.id from public.pipeline_stages s where s.org_id = main_org and s.key = 'lead');
begin
  perform pg_temp.su();
  perform pg_temp.expect_error(format(
    $q$insert into public.companies (org_id, name, owner_id, country) values (%L, 'Svc co', '00000000-0000-0000-0000-0000d7a00003', 'FR')$q$,
    main_org), '23503');
  perform pg_temp.expect_error(
    $q$update public.companies set owner_id = '00000000-0000-0000-0000-0000d7a00003'
        where id = '30000000-0000-0000-0000-0000d7a00002'$q$, '23503');
  perform pg_temp.expect_error(
    $q$update public.deals set owner_id = '00000000-0000-0000-0000-0000d7a00003'
        where id = '40000000-0000-0000-0000-0000d7a00002'$q$, '23503');
  perform pg_temp.expect_error(format(
    $q$insert into public.deals (org_id, company_id, stage_id, owner_id)
       values (%L, '30000000-0000-0000-0000-0000d7a00002', %L, '00000000-0000-0000-0000-0000d7a00003')$q$,
    main_org, lead_stage), '23503');
  perform pg_temp.expect_error(
    $q$update public.tasks set assignee_id = '00000000-0000-0000-0000-0000d7a00003'
        where id = '60000000-0000-0000-0000-0000d7a00002'$q$, '23503');
  perform pg_temp.expect_error(format(
    $q$insert into public.tasks (org_id, company_id, title, assignee_id)
       values (%L, '30000000-0000-0000-0000-0000d7a00002', 'x', '00000000-0000-0000-0000-0000d7a00003')$q$,
    main_org), '23503');
  insert into public.companies (org_id, name, owner_id, country)
  values (main_org, 'Svc co ok', '00000000-0000-0000-0000-0000d7a00001', 'FR');
  raise exception 'undo' using errcode = 'TS001';
exception when sqlstate 'TS001' then perform pg_temp.su();
end $$;

-- A4. Deleting a person still only empties what they owned (the composite keys set the owner column alone to null).
do $$
begin
  perform pg_temp.su();
  delete from auth.users where id = '00000000-0000-0000-0000-0000d7a00002';
  perform pg_temp.eq('lead kept, owner emptied',
    (select owner_id is null from public.companies where id = '30000000-0000-0000-0000-0000d7a00002'), true);
  perform pg_temp.eq('task kept, assignee emptied',
    (select assignee_id is null from public.tasks where id = '60000000-0000-0000-0000-0000d7a00002'), true);
  raise exception 'undo' using errcode = 'TS001';
exception when sqlstate 'TS001' then perform pg_temp.su();
end $$;

-- B. Sign-in audit rows ----------------------------------------------------------------------------------------------
-- B0. The writer runs as the caller (SECURITY INVOKER) and anon cannot call it; authenticated may insert only the four
-- columns of an auth row, and may not update or delete the log.
do $$ begin
  if (select prosecdef from pg_proc where oid = 'public.record_auth_event(text)'::regprocedure) then
    raise exception 'FAIL: record_auth_event must be SECURITY INVOKER';
  end if;
  if has_function_privilege('anon', 'public.record_auth_event(text)', 'execute')
     or has_function_privilege('public', 'public.record_auth_event(text)', 'execute') then
    raise exception 'FAIL: anon or PUBLIC can call record_auth_event';
  end if;
  if has_function_privilege('authenticated', 'private.auth_event_guard()', 'execute') then
    raise exception 'FAIL: the auth event guard is callable';
  end if;
  if has_table_privilege('authenticated', 'public.audit_log', 'update') or has_table_privilege('authenticated', 'public.audit_log', 'delete')
     or has_any_column_privilege('authenticated', 'public.audit_log', 'update')
     or has_column_privilege('authenticated', 'public.audit_log', 'record_id', 'insert')
     or has_column_privilege('authenticated', 'public.audit_log', 'diff_json', 'insert')
     or has_column_privilege('authenticated', 'public.audit_log', 'created_at', 'insert') then
    raise exception 'FAIL: authenticated has more than the four insert columns on audit_log';
  end if;
end $$;

-- B1. A two-factor session writes exactly one row about itself; the row holds who, which event and when, nothing else.
do $$
declare
  main_org constant uuid := (select id from public.orgs where name = 'TopStock Wholesale');
  r record;
begin
  perform pg_temp.act('00000000-0000-0000-0000-0000d7a00002');
  perform public.record_auth_event('sign_in');
  perform public.record_auth_event('mfa_verify');
  perform pg_temp.eq('a rep cannot read the log (own rows included)', (select count(*) from public.audit_log), 0::bigint);
  perform pg_temp.su();
  perform pg_temp.eq('rows written', (select count(*) from public.audit_log
    where actor_id = '00000000-0000-0000-0000-0000d7a00002' and table_name = 'auth'), 2::bigint);
  select * into r from public.audit_log
   where actor_id = '00000000-0000-0000-0000-0000d7a00002' and action = 'sign_in';
  perform pg_temp.eq('row org', r.org_id, main_org);
  perform pg_temp.eq('row has no record id', r.record_id, null::text);
  perform pg_temp.eq('row has no details', r.diff_json, null::jsonb);
  perform pg_temp.eq('row time is now', r.created_at, now());
  -- The organisation's admin reads both rows; the other organisation's admin reads none.
  perform pg_temp.act('00000000-0000-0000-0000-0000d7a00004');
  perform pg_temp.eq('TopStock admin reads the rows', (select count(*) from public.audit_log
    where actor_id = '00000000-0000-0000-0000-0000d7a00002' and table_name = 'auth'), 2::bigint);
  perform pg_temp.act('00000000-0000-0000-0000-0000d7a00003');
  perform pg_temp.eq('other org admin reads none', (select count(*) from public.audit_log
    where actor_id = '00000000-0000-0000-0000-0000d7a00002'), 0::bigint);
  raise exception 'undo' using errcode = 'TS001';
exception when sqlstate 'TS001' then perform pg_temp.su();
end $$;

-- B2. Forgeries: another person's row, another organisation's row, another action, another table, extra columns, a
-- password-only (aal1) session, changing or deleting a row. All refused (42501), nothing written.
do $$
declare
  main_org constant uuid := (select id from public.orgs where name = 'TopStock Wholesale');
begin
  perform pg_temp.act('00000000-0000-0000-0000-0000d7a00002');
  perform pg_temp.expect_error(format(
    $q$insert into public.audit_log (org_id, actor_id, action, table_name)
       values (%L, '00000000-0000-0000-0000-0000d7a00001', 'sign_in', 'auth')$q$, main_org), '42501');
  perform pg_temp.expect_error(
    $q$insert into public.audit_log (org_id, actor_id, action, table_name)
       values ('00000000-0000-0000-0000-0000d7a000cc', '00000000-0000-0000-0000-0000d7a00002', 'sign_in', 'auth')$q$,
    '42501');
  perform pg_temp.expect_error($q$select public.record_auth_event('role_change')$q$, '42501');
  perform pg_temp.expect_error($q$select public.record_auth_event('delete')$q$, '42501');
  perform pg_temp.expect_error(format(
    $q$insert into public.audit_log (org_id, actor_id, action, table_name)
       values (%L, '00000000-0000-0000-0000-0000d7a00002', 'sign_in', 'profiles')$q$, main_org), '42501');
  perform pg_temp.expect_error(format(
    $q$insert into public.audit_log (org_id, actor_id, action, table_name, diff_json)
       values (%L, '00000000-0000-0000-0000-0000d7a00002', 'sign_in', 'auth', '{"ip":"203.0.113.9"}')$q$, main_org),
    '42501');
  perform pg_temp.expect_error(format(
    $q$insert into public.audit_log (org_id, actor_id, action, table_name, created_at)
       values (%L, '00000000-0000-0000-0000-0000d7a00002', 'sign_in', 'auth', now() - interval '1 day')$q$, main_org),
    '42501');
  perform pg_temp.act('00000000-0000-0000-0000-0000d7a00002', 'aal1', null);
  perform pg_temp.expect_error($q$select public.record_auth_event('sign_in')$q$, '42501');
  perform pg_temp.su();
  perform pg_temp.eq('nothing forged', (select count(*) from public.audit_log where table_name = 'auth'
    and actor_id in ('00000000-0000-0000-0000-0000d7a00001', '00000000-0000-0000-0000-0000d7a00002')), 0::bigint);
  -- A real row, then an attempt to change or delete it (an admin too).
  perform pg_temp.act('00000000-0000-0000-0000-0000d7a00002');
  perform public.record_auth_event('sign_in');
  perform pg_temp.expect_error(
    $q$update public.audit_log set created_at = now() - interval '1 day' where actor_id = '00000000-0000-0000-0000-0000d7a00002'$q$,
    '42501');
  perform pg_temp.expect_error(
    $q$delete from public.audit_log where actor_id = '00000000-0000-0000-0000-0000d7a00002'$q$, '42501');
  perform pg_temp.act('00000000-0000-0000-0000-0000d7a00004');
  perform pg_temp.expect_error(
    $q$delete from public.audit_log where actor_id = '00000000-0000-0000-0000-0000d7a00002'$q$, '42501');
  raise exception 'undo' using errcode = 'TS001';
exception when sqlstate 'TS001' then perform pg_temp.su();
end $$;

-- B3. anon cannot write one.
set role anon;
do $$ begin
  perform set_config('request.jwt.claims', '{"role":"anon"}', false);
  perform pg_temp.expect_error($q$select public.record_auth_event('sign_in')$q$, '42501');
  perform pg_temp.expect_error(
    $q$insert into public.audit_log (org_id, actor_id, action, table_name) values (null, null, 'sign_in', 'auth')$q$, '42501');
end $$;
reset role;

-- B4. Flood guard: 30 rows an hour per person, the 31st is refused with the rate-limit hint; another person is not held.
do $$
begin
  perform pg_temp.act('00000000-0000-0000-0000-0000d7a00002');
  for i in 1..30 loop
    perform public.record_auth_event('mfa_verify');
  end loop;
  perform pg_temp.expect_error($q$select public.record_auth_event('sign_in')$q$, '22023', 'rate_limited');
  perform pg_temp.act('00000000-0000-0000-0000-0000d7a00001');
  perform public.record_auth_event('sign_in');
  raise exception 'undo' using errcode = 'TS001';
exception when sqlstate 'TS001' then perform pg_temp.su();
end $$;

-- B5. The flood count never answers for another person: with the victim at 30 rows this hour, a forged row about them
-- is refused by RLS (42501), not by the flood guard (22023 rate_limited), so the refusal says nothing about their
-- sign-ins. The victim's own 31st row is still held.
do $$
declare
  main_org constant uuid := (select id from public.orgs where name = 'TopStock Wholesale');
begin
  perform pg_temp.act('00000000-0000-0000-0000-0000d7a00001');
  for i in 1..30 loop
    perform public.record_auth_event('sign_in');
  end loop;
  perform pg_temp.act('00000000-0000-0000-0000-0000d7a00002');
  perform pg_temp.expect_error(format(
    $q$insert into public.audit_log (org_id, actor_id, action, table_name)
       values (%L, '00000000-0000-0000-0000-0000d7a00001', 'sign_in', 'auth')$q$, main_org), '42501');
  perform pg_temp.act('00000000-0000-0000-0000-0000d7a00001');
  perform pg_temp.expect_error($q$select public.record_auth_event('sign_in')$q$, '22023', 'rate_limited');
  raise exception 'undo' using errcode = 'TS001';
exception when sqlstate 'TS001' then perform pg_temp.su();
end $$;

\echo 'day7a_attack: all checks passed'
