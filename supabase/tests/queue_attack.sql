-- Day 4c attack and behaviour tests: tasks and the work queue (design docs/evidence/day4/design.md sections 3.3, 4.2,
-- 5.1, 5.4 to 5.6, 6 and 8.1; migration 20261013090000_tasks_queue.sql). Runs after outcome_attack.sql on the same
-- database (scripts/db-test.sh, CI job "rls"), reusing its users: admin a, admin2 Henri (0b, from import_attack), rep
-- b1, other-org admin c1. It adds reps Hal (a5), Ivy (a6) and Jo (a8) and admin Kit (a7), each starting with no leads
-- or tasks, so their own queues and task lists are exactly what each case builds. Any failure raises an exception and
-- stops the run.
-- Probes run as a signed-in user through the API role (grants, row level security and triggers all apply), except where
-- a comment says the superuser looks. Calling hours depend on the real clock: the order cases use "outside calling
-- hours too" (p_any_hours), and the hours cases pick a country that is in hours now and one that is not (on a weekend
-- moment when no country is in hours, the "in hours" half is skipped with a notice; the "outside hours" half always runs).
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
-- user's text) must appear in neither the message nor the detail: constant errors keep user data out of the logs.
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
-- A lead (superuser: the guards leave it as given, except lead_guard's rules for everyone). FR main line by default.
create function pg_temp.new_lead(owner uuid, status text default 'cold', next_at timestamptz default null,
                                 phone text default '+33 1 99 00 10 01', country text default 'FR',
                                 lead_name text default 'Day4c Lead') returns uuid
language sql as $$
  insert into public.companies (org_id, name, owner_id, lead_status, phone, country, next_action_at)
  select o.id, lead_name, owner, status, phone, country, next_at from public.orgs o where o.name = 'TopStock Wholesale'
  returning id
$$;
create function pg_temp.new_contact(lead uuid, contact_phone text default '+33 6 39 98 00 01', first text default 'Fakey')
returns uuid language sql as $$
  insert into public.contacts (org_id, company_id, first_name, phone)
  select c.org_id, c.id, first, contact_phone from public.companies c where c.id = lead
  returning id
$$;
create function pg_temp.new_task(lead uuid, who uuid, task_kind text default 'call', due date default null,
                                 due_time timestamptz default null, task_title text default 'Day4c task') returns uuid
language sql as $$
  insert into public.tasks (org_id, company_id, title, kind, due_date, due_at, assignee_id, created_by)
  select o.id, lead, task_title, task_kind, due, due_time, who, who from public.orgs o where o.name = 'TopStock Wholesale'
  returning id
$$;
-- A lead's queue facts as the superuser sees them.
create function pg_temp.rank_of(lead uuid) returns smallint
language sql as $$ select queue_rank from public.companies where id = lead $$;
-- A country whose calling zone (a plain zone, not a span) is in hours at this moment (null if none), and one that is not.
create function pg_temp.country_in_hours(want_open boolean) returns text
language sql as $$
  select code from (select chr(65 + i / 26) || chr(65 + i % 26) as code from generate_series(0, 675) i) c
   where private.country_call_zone(code) is not null and private.span_zones(private.country_call_zone(code)) is null
     and private.country_zone_choices(code) is null
     and private.call_zone_open(private.country_call_zone(code), now(), false) = want_open
   order by code
   limit 1
$$;
-- The ids a series of claim_next_lead answers served, in order (one card per call; each call lets the previous go).
create function pg_temp.serve_all(scope text, any_hours boolean default true, max_calls integer default 60)
returns uuid[] language plpgsql as $$
declare
  served uuid[] := '{}';
  r jsonb;
begin
  for n in 1..max_calls loop
    r := public.claim_next_lead(scope, '{}'::uuid[], served, 1, any_hours);
    exit when jsonb_array_length(r -> 'cards') = 0;
    served := served || (r -> 'cards' -> 0 ->> 'id')::uuid;
  end loop;
  return served;
end;
$$;

-- Fixtures ------------------------------------------------------------------------------------------------------------
do $$ begin perform set_config('request.jwt.claims', '', false); end $$;
insert into auth.users (id, email, raw_user_meta_data) values
  ('00000000-0000-0000-0000-0000000000a5', 'reph@test.invalid', '{"first_name":"Hal"}'),
  ('00000000-0000-0000-0000-0000000000a6', 'repi@test.invalid', '{"first_name":"Ivy"}'),
  ('00000000-0000-0000-0000-0000000000a7', 'admink@test.invalid', '{"first_name":"Kit"}'),
  ('00000000-0000-0000-0000-0000000000a8', 'repj@test.invalid', '{"first_name":"Jo"}');
update public.profiles set role = 'admin' where id = '00000000-0000-0000-0000-0000000000a7';
do $$ begin
  if (select array_agg(role::text order by id) from public.profiles
       where id in ('00000000-0000-0000-0000-0000000000a5', '00000000-0000-0000-0000-0000000000a6',
                    '00000000-0000-0000-0000-0000000000a7', '00000000-0000-0000-0000-0000000000a8'))
     is distinct from array['rep', 'rep', 'admin', 'rep']
     or (select role from public.profiles where id = '00000000-0000-0000-0000-00000000000b') <> 'admin'
     or (select first_name from public.profiles where id = '00000000-0000-0000-0000-00000000000b') <> 'Henri' then
    raise exception 'FAIL: fixture users (reps Hal, Ivy, Jo; admins Kit and Henri)';
  end if;
  perform set_config('t.main_org', (select id::text from public.orgs where name = 'TopStock Wholesale'), false);
end $$;

-- 0. What the database itself says: columns, grants, policies, functions, indexes, triggers ---------------------------
do $$
declare
  f record;
  bad text[];
  code text;
begin
  -- Queue facts on leads: server-kept, never written by a client (threat 7).
  if exists (select 1 from unnest(array['has_contact_phone', 'call_zone', 'queue_rank']) c
              where has_column_privilege('authenticated', 'public.companies', c, 'INSERT')
                 or has_column_privilege('authenticated', 'public.companies', c, 'UPDATE')) then
    raise exception 'FAIL: a client may write has_contact_phone, call_zone or queue_rank';
  end if;
  if (select array_agg(attname::text || ':' || attgenerated::text order by attname) from pg_attribute
       where attrelid = 'public.companies'::regclass and attname in ('call_zone', 'queue_rank', 'has_contact_phone'))
     is distinct from array['call_zone:s', 'has_contact_phone:', 'queue_rank:s'] then
    raise exception 'FAIL: call_zone and queue_rank must be stored generated columns';
  end if;
  -- Claims: private, row level security on, exactly these policies (two-factor restrictive), insert names only the
  -- lead, update only the end, nothing for anon (threat 15).
  if not (select relrowsecurity from pg_class where oid = 'private.queue_claims'::regclass)
     or (select array_agg(policyname::text || ':' || permissive order by policyname) from pg_policies
          where schemaname = 'private' and tablename = 'queue_claims')
        is distinct from array['claims_delete:PERMISSIVE', 'claims_insert:PERMISSIVE', 'claims_select:PERMISSIVE',
                               'claims_update:PERMISSIVE', 'require_mfa:RESTRICTIVE']
     or not has_table_privilege('authenticated', 'private.queue_claims', 'SELECT')
     or not has_table_privilege('authenticated', 'private.queue_claims', 'DELETE')
     or has_table_privilege('authenticated', 'private.queue_claims', 'INSERT')
     or has_table_privilege('authenticated', 'private.queue_claims', 'UPDATE')
     or not has_column_privilege('authenticated', 'private.queue_claims', 'company_id', 'INSERT')
     or has_column_privilege('authenticated', 'private.queue_claims', 'user_id', 'INSERT')
     or has_column_privilege('authenticated', 'private.queue_claims', 'org_id', 'INSERT')
     or has_column_privilege('authenticated', 'private.queue_claims', 'expires_at', 'INSERT')
     or has_column_privilege('authenticated', 'private.queue_claims', 'claimed_at', 'INSERT')
     or not has_column_privilege('authenticated', 'private.queue_claims', 'expires_at', 'UPDATE')
     or has_column_privilege('authenticated', 'private.queue_claims', 'user_id', 'UPDATE')
     or has_column_privilege('authenticated', 'private.queue_claims', 'company_id', 'UPDATE')
     or has_table_privilege('anon', 'private.queue_claims', 'SELECT')
     or has_table_privilege('public', 'private.queue_claims', 'SELECT') then
    raise exception 'FAIL: private.queue_claims protections';
  end if;
  if (select array_agg(a.attname::text order by a.attname) from pg_constraint k
        join pg_attribute a on a.attrelid = k.conrelid and a.attnum = any (k.conkey)
       where k.conrelid = 'private.queue_claims'::regclass and k.contype = 'p') is distinct from array['company_id'] then
    raise exception 'FAIL: one claim per lead (primary key on company_id)';
  end if;
  -- Every new or redefined RPC: SECURITY INVOKER, search_path '', callable by signed-in people only, static SQL.
  for f in select p.oid, p.oid::regprocedure::text as sig, p.prosecdef, p.proconfig, p.prosrc
             from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where (n.nspname = 'public' and p.proname in ('claim_next_lead', 'claim_lead', 'renew_claims', 'release_claims',
                   'queue_summary', 'list_tasks', 'count_tasks', 'update_task', 'delete_task', 'set_my_timezone',
                   'get_lead', 'log_activity'))
               or (n.nspname = 'private' and p.proname in ('queue_card', 'queue_candidates', 'call_zone_open',
                   'open_call_zones', 'call_zone_keys')) loop
    if f.prosecdef or not (f.proconfig @> array['search_path=""'])
       or not has_function_privilege('authenticated', f.oid, 'EXECUTE')
       or has_function_privilege('anon', f.oid, 'EXECUTE') or has_function_privilege('public', f.oid, 'EXECUTE')
       or f.prosrc ~* '\mexecute\M' or f.prosrc ~* 'format\s*\(' then
      bad := bad || f.sig;
    end if;
  end loop;
  if bad is not null then raise exception 'FAIL: function rules broken by %', bad; end if;
  if (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where (n.nspname = 'public' and p.proname in ('claim_next_lead', 'claim_lead', 'renew_claims', 'release_claims',
              'queue_summary', 'list_tasks', 'count_tasks', 'update_task', 'delete_task', 'set_my_timezone'))
          or (n.nspname = 'private' and p.proname in ('queue_card', 'queue_candidates', 'call_zone_open',
              'open_call_zones', 'call_zone_keys'))) <> 15 then
    raise exception 'FAIL: the Day 4c functions are not all there, or one exists twice';
  end if;
  -- Trigger functions are never callable; the contact trigger is the one DEFINER (nobody is granted the column).
  foreach code in array array['private.sync_contact_phone()', 'private.claim_guard()',
                              'private.check_profile_timezone()'] loop
    if has_function_privilege('authenticated', code::regprocedure, 'EXECUTE')
       or has_function_privilege('anon', code::regprocedure, 'EXECUTE')
       or not ((select proconfig from pg_proc where oid = code::regprocedure) @> array['search_path=""']) then
      raise exception 'FAIL: trigger function % must be uncallable with search_path ''''', code;
    end if;
  end loop;
  if not (select prosecdef from pg_proc where oid = 'private.sync_contact_phone()'::regprocedure)
     or (select prosecdef from pg_proc where oid = 'private.claim_guard()'::regprocedure)
     or (select prosecdef from pg_proc where oid = 'private.check_profile_timezone()'::regprocedure) then
    raise exception 'FAIL: sync_contact_phone is DEFINER, the guards INVOKER';
  end if;
  if (select tgtype & 2 = 0 and tgenabled = 'O' from pg_trigger
       where tgname = 'sync_contact_phone' and tgrelid = 'public.contacts'::regclass) is not true
     or (select tgtype & 2 = 2 and tgenabled = 'O' from pg_trigger
          where tgname = 'claim_guard' and tgrelid = 'private.queue_claims'::regclass) is not true
     or (select tgtype & 2 = 2 and tgenabled = 'O' from pg_trigger
          where tgname = 'check_profile_timezone' and tgrelid = 'public.profiles'::regclass) is not true then
    raise exception 'FAIL: sync_contact_phone (AFTER), claim_guard and check_profile_timezone (BEFORE) must be on';
  end if;
  -- Indexes (design 3.3): the queue walks, the task buckets; the old task index is gone.
  if (select array_agg(indexrelid::regclass::text order by indexrelid::regclass::text) from pg_index
       where indrelid = 'public.companies'::regclass and indexrelid::regclass::text like 'companies_queue_%'
         and pg_get_expr(indpred, indrelid) like '%queue_rank IS NOT NULL%')
     is distinct from array['companies_queue_owner_idx', 'companies_queue_team_idx', 'companies_queue_unassigned_idx']
     or pg_get_indexdef('public.companies_queue_owner_idx'::regclass) not like
        '%(org_id, owner_id, queue_rank, next_action_at, last_activity_at NULLS FIRST, id) WHERE (queue_rank IS NOT NULL)'
     or pg_get_indexdef('public.companies_queue_unassigned_idx'::regclass) not like '%(owner_id IS NULL)%'
     or to_regclass('public.tasks_assignee_open_idx') is null or to_regclass('public.tasks_assignee_done_idx') is null
     or to_regclass('public.tasks_queue_idx') is null or to_regclass('public.tasks_org_assignee_idx') is not null
     or to_regclass('public.tasks_assignee_idx') is null then
    raise exception 'FAIL: the Day 4c indexes';
  end if;
end $$;

-- 1. anon and a session without two-factor (aal1) see and change nothing (threat 1) ---------------------------------
set role anon;
do $$ begin perform set_config('request.jwt.claims', '{"role":"anon"}', false); end $$;
do $$
declare stmt text;
begin
  foreach stmt in array array[
    'select public.claim_next_lead()', 'select public.claim_lead(gen_random_uuid())', 'select public.renew_claims()',
    'select public.release_claims()', 'select public.queue_summary()', $q$select * from public.list_tasks('today')$q$,
    'select public.count_tasks()', $q$select public.update_task(gen_random_uuid(), 'x', null, null, null, null)$q$,
    'select public.delete_task(gen_random_uuid())', $q$select public.set_my_timezone('Asia/Karachi')$q$,
    'select count(*) from private.queue_claims', 'select private.open_call_zones(now(), false)'] loop
    begin
      execute stmt;
      raise exception 'FAIL: anon ran %', stmt;
    exception when insufficient_privilege then null;
    end;
  end loop;
end $$;
reset role;

do $$
declare l uuid := pg_temp.new_lead('00000000-0000-0000-0000-0000000000a7', lead_name => 'Day4c aal1 lead');
begin
  perform set_config('t.aal1_lead', l::text, false);
  insert into private.queue_claims (company_id, org_id, user_id, expires_at)
  values (l, current_setting('t.main_org')::uuid, '00000000-0000-0000-0000-0000000000a7', now() + interval '10 minutes');
  perform set_config('t.aal1_task', pg_temp.new_task(l, '00000000-0000-0000-0000-0000000000a7')::text, false);
end $$;
set role authenticated;
do $$ begin perform pg_temp.as_user('00000000-0000-0000-0000-0000000000a7', 'aal1', 30); end $$;
do $$
declare
  l constant text := quote_literal(current_setting('t.aal1_lead'));
  t constant text := quote_literal(current_setting('t.aal1_task'));
  stmt text;
begin
  -- day4_aal1_blocked: every Day 4c RPC answers 42501; the private table shows and takes nothing.
  foreach stmt in array array[
    'select public.claim_next_lead()', format('select public.claim_lead(%s)', l), 'select public.renew_claims()',
    'select public.release_claims()', 'select public.queue_summary()', $q$select * from public.list_tasks('today')$q$,
    'select public.count_tasks()', format('select public.update_task(%s, %L, null, null, null, null)', t, 'x'),
    format('select public.delete_task(%s)', t), $q$select public.set_my_timezone('Asia/Karachi')$q$,
    format('insert into private.queue_claims (company_id) values (%s)', l)] loop
    perform pg_temp.expect_error(stmt, '42501');
  end loop;
  if (select count(*) from private.queue_claims) <> 0
     or public.get_lead(current_setting('t.aal1_lead')::uuid) is not null then
    raise exception 'FAIL: an aal1 session read claims or a lead';
  end if;
  delete from private.queue_claims;
  update private.queue_claims set expires_at = now();
end $$;
reset role;
do $$ begin
  if (select count(*) from private.queue_claims where company_id = current_setting('t.aal1_lead')::uuid) <> 1 then
    raise exception 'FAIL: an aal1 session removed a claim';
  end if;
  delete from private.queue_claims where company_id = current_setting('t.aal1_lead')::uuid;
  delete from public.companies where id = current_setting('t.aal1_lead')::uuid;  -- Kit starts the queue cases with no lead
end $$;

-- 2. Calling hours: the shared cases (design 5.1, threat 17) ----------------------------------------------------------
-- The same list as tests/unit/call-window.spec.ts between its call-window markers (key, instant, lunch switch, open).

do $$
declare
  t record;
  n integer := 0;
begin
  for t in select * from (values
-- call-window:start
  ('Europe/Paris', '2026-10-12T06:59:00Z', false, false), -- Monday 08:59 Paris
  ('Europe/Paris', '2026-10-12T07:00:00Z', false, true), -- Monday 09:00
  ('Europe/Paris', '2026-10-12T15:59:00Z', false, true), -- 17:59
  ('Europe/Paris', '2026-10-12T16:00:00Z', false, false), -- 18:00 closes
  ('Europe/Paris', '2026-10-12T10:30:00Z', false, true), -- 12:30, lunch switch off
  ('Europe/Paris', '2026-10-12T10:30:00Z', true, false), -- 12:30, lunch switch on
  ('Europe/Paris', '2026-10-12T09:59:00Z', true, true), -- 11:59 with the switch
  ('Europe/Paris', '2026-10-12T12:00:00Z', true, true), -- 14:00 with the switch
  ('Europe/Paris', '2026-10-10T10:00:00Z', false, false), -- Saturday
  ('Europe/Paris', '2026-10-11T10:00:00Z', false, false), -- Sunday
  ('Europe/Paris', '2026-10-26T07:30:00Z', false, false), -- Monday after the change: 07:30 UTC is 08:30 CET
  ('Europe/Paris', '2026-10-26T08:00:00Z', false, true), -- 09:00 CET
  ('Europe/Paris', '2026-10-23T06:59:00Z', false, false), -- Friday before the change, 08:59 CEST
  ('Europe/Paris', '2026-03-30T06:59:00Z', false, false), -- Monday after spring change, 08:59 CEST
  ('Europe/Paris', '2026-03-30T07:00:00Z', false, true),
  ('Europe/London', '2026-10-12T07:59:00Z', false, false), -- 08:59 BST
  ('Europe/London', '2026-10-12T08:00:00Z', false, true), -- 09:00 BST
  ('Europe/London', '2026-10-26T08:59:00Z', false, false), -- 08:59 GMT
  ('Europe/London', '2026-10-26T09:00:00Z', false, true),
  ('America/New_York', '2026-10-26T13:00:00Z', false, true), -- 09:00 EDT (Paris already on CET: 14:00)
  ('America/New_York', '2026-10-26T12:59:00Z', false, false),
  ('America/New_York', '2026-11-02T13:59:00Z', false, false), -- 08:59 EST
  ('America/New_York', '2026-11-02T14:00:00Z', false, true),
  ('America/New_York', '2026-03-09T13:00:00Z', false, true), -- after the US spring change, 09:00 EDT
  ('America/New_York', '2026-10-12T16:30:00Z', true, true), -- lunch switch: not a European zone
  ('Asia/Karachi', '2026-10-12T04:00:00Z', false, true), -- 09:00 PKT
  ('Asia/Karachi', '2026-10-12T13:00:00Z', false, false), -- 18:00
  ('Asia/Kolkata', '2026-10-12T03:30:00Z', false, true), -- 09:00 IST (+05:30)
  ('Asia/Kolkata', '2026-10-12T03:29:00Z', false, false),
  ('Asia/Kathmandu', '2026-10-12T03:15:00Z', false, true), -- 09:00 (+05:45)
  ('Asia/Kathmandu', '2026-10-12T03:14:00Z', false, false),
  ('Asia/Dubai', '2026-10-16T06:00:00Z', false, true), -- Friday 10:00 (Monday to Friday everywhere)
  ('Asia/Dubai', '2026-10-17T06:00:00Z', false, false), -- Saturday
  ('Africa/Casablanca', '2026-10-12T09:30:00Z', false, true),
  ('US', '2026-10-12T15:59:00Z', false, false), -- New York 11:59, Los Angeles 08:59
  ('US', '2026-10-12T16:00:00Z', false, true), -- New York 12:00, Los Angeles 09:00
  ('US', '2026-10-12T21:59:00Z', false, true), -- New York 17:59
  ('US', '2026-10-12T22:00:00Z', false, false), -- New York 18:00
  ('US', '2026-10-12T16:30:00Z', true, true), -- spans ignore the lunch switch
  ('US', '2026-11-02T17:00:00Z', false, true), -- after 1 Nov: NY 12:00 EST, LA 09:00 PST
  ('US', '2026-11-02T16:59:00Z', false, false),
  ('CA', '2026-10-12T16:00:00Z', false, true), -- Halifax 13:00, Vancouver 09:00
  ('CA', '2026-10-12T15:59:00Z', false, false),
  ('AU', '2026-10-12T00:00:00Z', false, false), -- Sydney 11:00, Perth 08:00
  ('AU', '2026-10-12T01:00:00Z', false, true), -- Perth 09:00, Sydney 12:00
  ('AU', '2026-10-12T05:00:00Z', false, true), -- Sydney 16:00, Perth 13:00
  ('AU', '2026-10-12T07:00:00Z', false, false), -- Sydney 18:00
  ('MX', '2026-10-12T16:00:00Z', false, true), -- Mexico City 10:00, Tijuana 09:00
  ('BR', '2026-10-12T13:00:00Z', false, true), -- São Paulo 10:00, Manaus 09:00
  ('BR', '2026-10-12T12:59:00Z', false, false),
  ('ID', '2026-10-12T02:00:00Z', false, true), -- Jakarta 09:00, Jayapura 11:00
  ('ID', '2026-10-12T01:59:00Z', false, false),
  ('ID', '2026-10-12T09:00:00Z', false, false), -- Jayapura 18:00
  ('Europe/Madrid', '2026-10-12T10:30:00Z', true, false), -- lunch: European
  ('Atlantic/Canary', '2026-10-12T11:30:00Z', true, true), -- Canaries 12:30: not Europe/*, the switch does not apply
  ('Europe/Moscow', '2026-10-12T06:00:00Z', false, true), -- 09:00 MSK
  ('Pacific/Auckland', '2026-10-11T20:00:00Z', false, true), -- Monday 09:00 NZDT
  ('Pacific/Auckland', '2026-10-11T19:59:00Z', false, false),
  ('America/Los_Angeles', '2026-10-12T16:00:00Z', false, true),
  ('America/Los_Angeles', '2026-10-12T15:59:00Z', false, false)
-- call-window:end
    ) as c (zone_key, at_utc, skip_lunch, want) loop
    n := n + 1;
    if private.call_zone_open(t.zone_key, t.at_utc::timestamptz, t.skip_lunch) is distinct from t.want then
      raise exception 'FAIL: calling hours for % at % (lunch switch %): expected %', t.zone_key, t.at_utc, t.skip_lunch, t.want;
    end if;
    -- open_call_zones agrees with call_zone_open for every key (spans and the lunch switch included).
    if (t.zone_key = any (private.open_call_zones(t.at_utc::timestamptz, t.skip_lunch))) is distinct from t.want then
      raise exception 'FAIL: open_call_zones for % at %', t.zone_key, t.at_utc;
    end if;
  end loop;
  if n < 55 then raise exception 'FAIL: only % calling-hours cases', n; end if;
  if private.call_zone_open(null, now(), false) or private.call_zone_open('Europe/Paris', null, false) then
    raise exception 'FAIL: calling hours with nothing to go on must be closed';
  end if;
end $$;

-- 3. The calling zone and the rank, as stored (design 3.3: call_zone_matches_map; zone keys) ------------------------
do $$
declare
  keys text[];
begin
  -- call_zone_keys is every value lead_call_zone can return, worked out again from the zone map here.
  select array_agg(distinct k order by k) into keys
    from (select private.country_call_zone(chr(65 + i / 26) || chr(65 + i % 26)) as k from generate_series(0, 675) i
          union all
          select unnest(private.country_zone_choices(chr(65 + i / 26) || chr(65 + i % 26))) from generate_series(0, 675) i
          union all
          select 'Europe/Paris') z
   where k is not null;
  if private.call_zone_keys() is distinct from keys or cardinality(keys) < 250 then
    raise exception 'FAIL: call_zone_keys does not match the zone map (% keys, map gives %)',
      cardinality(private.call_zone_keys()), cardinality(keys);
  end if;
  -- Every key is a zone PostgreSQL knows, or a span whose two ends it knows.
  if exists (select 1 from unnest(keys) k
              where not exists (select 1 from pg_timezone_names z where z.name = k)
                and (private.span_zones(k) is null
                     or exists (select 1 from unnest(private.span_zones(k)) e
                                 where not exists (select 1 from pg_timezone_names z where z.name = e)))) then
    raise exception 'FAIL: a calling zone key PostgreSQL cannot read';
  end if;
end $$;

-- call_zone_matches_map and queue_rank_matches_rule over every lead the earlier test files made (and again at the end).
create function pg_temp.check_stored_facts() returns void
language plpgsql as $$
begin
  if (select count(*) from public.companies where call_zone is distinct from private.lead_call_zone(timezone, country)) <> 0
     or (select count(*) from public.companies where not (call_zone = any (private.call_zone_keys()))) <> 0 then
    raise exception 'FAIL: call_zone_matches_map: a stored calling zone differs from the zone map';
  end if;
  if (select count(*) from public.companies c
       where c.queue_rank is distinct from (
               case
                 when not ((coalesce(c.phone ~ '[0-9]', false) and c.phone_wrong_at is null) or c.has_contact_phone) then null
                 when c.lead_status = 'negotiation' then 0
                 when c.lead_status = 'warm' then 1
                 when c.lead_status = 'cold' then case when c.next_action_at is null then 3 else 2 end
                 when c.lead_status = 'cool_off' and c.next_action_at is not null then 2
               end)) <> 0 then
    raise exception 'FAIL: queue_rank_matches_rule';
  end if;
  if (select count(*) from public.companies c
       where c.has_contact_phone is distinct from exists (
               select 1 from public.contacts k where k.company_id = c.id and k.phone ~ '[0-9]' and k.phone_wrong_at is null)) <> 0 then
    raise exception 'FAIL: has_contact_phone_consistent: a lead''s contact flag differs from its contacts';
  end if;
end;
$$;
do $$ begin perform pg_temp.check_stored_facts(); end $$;

-- The calling zone follows the lead (threat 19 and D4): a picked zone, the country's zone or span, Europe/Paris; a
-- country change clears a picked zone and the stored key follows.
do $$
declare
  l uuid := pg_temp.new_lead('00000000-0000-0000-0000-0000000000a7', country => 'US', lead_name => 'Day4c zone lead');
begin
  if (select call_zone from public.companies where id = l) <> 'US' then raise exception 'FAIL: US span key'; end if;
  perform pg_temp.act('00000000-0000-0000-0000-0000000000a7');
  perform public.set_lead_timezone(l, 'America/Chicago');
  perform pg_temp.su();
  if (select call_zone from public.companies where id = l) <> 'America/Chicago' then raise exception 'FAIL: picked zone'; end if;
  perform pg_temp.act('00000000-0000-0000-0000-0000000000a7');
  update public.companies set country = 'GB' where id = l;
  perform pg_temp.su();
  if (select call_zone || ' ' || coalesce(timezone, '-') from public.companies where id = l) <> 'Europe/London -' then
    raise exception 'FAIL: a country change must clear the zone and move the calling zone';
  end if;
  perform pg_temp.act('00000000-0000-0000-0000-0000000000a7');
  update public.companies set country = null where id = l;
  perform pg_temp.su();
  if (select call_zone from public.companies where id = l) <> 'Europe/Paris' then raise exception 'FAIL: no country'; end if;
  delete from public.companies where id = l;
end $$;

-- 4. Queue rank rules (design D5; threats 16 and 18) and the facts nobody may write (threat 7) ------------------------
do $$
declare
  k constant uuid := '00000000-0000-0000-0000-0000000000a7';
  l uuid;
  c uuid;
begin
  begin
    -- Statuses with a working main number.
    if pg_temp.rank_of(pg_temp.new_lead(k, 'negotiation')) <> 0 or pg_temp.rank_of(pg_temp.new_lead(k, 'warm')) <> 1
       or pg_temp.rank_of(pg_temp.new_lead(k, 'cold')) <> 3
       or pg_temp.rank_of(pg_temp.new_lead(k, 'cold', now() + interval '1 day')) <> 2
       or pg_temp.rank_of(pg_temp.new_lead(k, 'cold', now() - interval '1 day')) <> 2
       or pg_temp.rank_of(pg_temp.new_lead(k, 'warm', now() + interval '1 day')) <> 1
       or pg_temp.rank_of(pg_temp.new_lead(k, 'cool_off')) <> 2  -- lead_guard gives it +90 days
       or pg_temp.rank_of(pg_temp.new_lead(k, 'do_not_contact')) is not null           -- dnc_never_served
       or pg_temp.rank_of(pg_temp.new_lead(k, 'disqualified')) is not null
       or pg_temp.rank_of(pg_temp.new_lead(k, 'customer')) is not null then
      raise exception 'FAIL: queue rank by status';
    end if;
    -- Nothing to dial: no main number, one without a digit, or one marked wrong (with no contact number).
    if pg_temp.rank_of(pg_temp.new_lead(k, 'warm', phone => null)) is not null
       or pg_temp.rank_of(pg_temp.new_lead(k, 'negotiation', phone => '( )')) is not null
       or pg_temp.rank_of(pg_temp.new_lead(k, 'cold', phone => '')) is not null then
      raise exception 'FAIL: a lead with nothing to dial has a rank';
    end if;
    l := pg_temp.new_lead(k, 'cold');
    update public.companies set phone_wrong_at = now() where id = l;
    if pg_temp.rank_of(l) is not null then raise exception 'FAIL: a wrong main line still ranks'; end if;
    -- A contact's working number gives the lead back its rank.
    c := pg_temp.new_contact(l);
    if pg_temp.rank_of(l) <> 3 then raise exception 'FAIL: a contact number must give a rank'; end if;
    -- cool_off_without_date_not_served: a Cool off lead whose date was emptied (maintenance) has no rank.
    l := pg_temp.new_lead(k, 'cool_off');
    alter table public.companies disable trigger lead_guard;
    update public.companies set next_action_at = null where id = l;
    alter table public.companies enable trigger lead_guard;
    if pg_temp.rank_of(l) is not null then raise exception 'FAIL: Cool off without a date ranks'; end if;
    -- The rank follows a status change made through the app (dnc_from_customer: Do not contact from any status).
    l := pg_temp.new_lead(k, 'warm');
    perform pg_temp.act(k);
    perform public.log_activity(l, 'call', 'do_not_contact');
    perform pg_temp.su();
    if pg_temp.rank_of(l) is not null then raise exception 'FAIL: Do not contact still ranks'; end if;
    raise exception 'undo' using errcode = 'TS001';
  exception when sqlstate 'TS001' then null;
  end;
  -- queue_rank_not_writable (threat 7): no client writes the facts, not even the lead's owner or an admin.
  l := pg_temp.new_lead(k, 'cold', lead_name => 'Day4c facts lead');
  perform pg_temp.act(k);
  -- (A generated column refuses any value with 428C9 before privileges are even looked at.)
  perform pg_temp.expect_error(format('update public.companies set queue_rank = 0 where id = %L', l), '428C9');
  perform pg_temp.expect_error(format('update public.companies set has_contact_phone = true where id = %L', l), '42501');
  perform pg_temp.expect_error(format('update public.companies set call_zone = %L where id = %L', 'Asia/Tokyo', l), '428C9');
  perform pg_temp.expect_error($q$insert into public.companies (name, queue_rank) values ('Day4c forged', 0)$q$, '428C9');
  perform pg_temp.expect_error($q$insert into public.companies (name, has_contact_phone) values ('Day4c forged', true)$q$, '42501');
  perform pg_temp.su();
  delete from public.companies where id = l;
end $$;

-- 5. has_contact_phone_follows_contacts (design 3.3: the contact trigger, lock order contact then lead) ---------------
do $$
declare
  k constant uuid := '00000000-0000-0000-0000-0000000000a7';
  p uuid := pg_temp.new_lead(k, 'cold', phone => null, lead_name => 'Day4c contact lead P');
  q uuid := pg_temp.new_lead(k, 'cold', phone => null, lead_name => 'Day4c contact lead Q');
  c1 uuid;
  c2 uuid;
  row_before tid;
  audits integer;
begin
  if (select has_contact_phone from public.companies where id = p) or pg_temp.rank_of(p) is not null then
    raise exception 'FAIL: a lead with no contact has no contact number';
  end if;
  audits := (select count(*) from public.audit_log where table_name = 'companies' and record_id = p::text);
  perform pg_temp.act(k);
  c1 := public.add_contact(p, 'Amelie', 'Fake', null, null, '+33 6 39 98 40 01');
  perform pg_temp.su();
  if not (select has_contact_phone from public.companies where id = p) or pg_temp.rank_of(p) <> 3 then
    raise exception 'FAIL: a contact with a number must flag the lead';
  end if;
  -- audit_queue_columns_not_diffed: the flag (and the rank it moves) writes no audit diff for the lead.
  if (select count(*) from public.audit_log where table_name = 'companies' and record_id = p::text) <> audits then
    raise exception 'FAIL: the contact flag wrote an audit row for the lead';
  end if;
  perform pg_temp.act(k);
  update public.contacts set phone_wrong_at = now() where id = c1;   -- marked wrong
  perform pg_temp.su();
  if (select has_contact_phone from public.companies where id = p) or pg_temp.rank_of(p) is not null then
    raise exception 'FAIL: a contact number marked wrong still flags the lead';
  end if;
  perform pg_temp.act(k);
  perform public.update_contact(c1, 'Amelie', 'Fake', null, null, '+33 6 39 98 40 02');  -- a new number clears the mark
  perform pg_temp.su();
  if not (select has_contact_phone from public.companies where id = p) then
    raise exception 'FAIL: a corrected contact number must flag the lead again';
  end if;
  perform pg_temp.act(k);
  c2 := public.add_contact(p, 'Bruno', 'Fake', null, null, null);
  perform public.update_contact(c2, 'Bruno', 'Fake', null, null, '( )');   -- no digit: nothing to dial
  delete from public.contacts where id = c1;                               -- fresh code (30 s)
  perform pg_temp.su();
  if (select has_contact_phone from public.companies where id = p) then
    raise exception 'FAIL: deleting the only contact number must clear the flag (a number without digits is none)';
  end if;
  perform pg_temp.act(k);
  perform public.update_contact(c2, 'Bruno', 'Fake', null, null, '+33 6 39 98 40 03');
  update public.contacts set company_id = q where id = c2;              -- moved to another lead
  perform pg_temp.su();
  if (select has_contact_phone from public.companies where id = p) or not (select has_contact_phone from public.companies where id = q) then
    raise exception 'FAIL: moving a contact must move the flag';
  end if;
  -- Changing only a contact's name leaves the lead alone (the trigger watches the number, the mark and the lead).
  row_before := (select ctid from public.companies where id = q);   -- a new row version would move it
  perform pg_temp.act(k);
  update public.contacts set first_name = 'Bruno2' where id = c2;
  perform pg_temp.su();
  if (select ctid from public.companies where id = q) <> row_before then
    raise exception 'FAIL: a contact name change touched the lead';
  end if;
  -- A lead delete with contacts (its contacts go first by cascade; the trigger finds no lead and does nothing).
  perform pg_temp.act('00000000-0000-0000-0000-00000000000a');
  delete from public.companies where id in (p, q);
  perform pg_temp.su();
  if exists (select 1 from public.companies where id in (p, q)) then raise exception 'FAIL: lead delete with contacts'; end if;
end $$;
do $$ begin perform pg_temp.check_stored_facts(); end $$;

-- 6. queue_order_fixture (design 5.4 and 8.1): Hal's leads come back in exactly the queue order, and the leads that
-- must never be served (or not yet) do not come back at all. Outside calling hours too, so the clock does not matter.
do $$
declare
  h constant uuid := '00000000-0000-0000-0000-0000000000a5';
  want uuid[] := '{}';
  want_reasons text[] := array['follow_up', 'negotiation', 'negotiation', 'warm', 'retry', 'returning', 'first_call',
                               'retry'];
  never uuid[] := '{}';
  l uuid;
  got uuid[] := '{}';
  reasons text[] := '{}';
  r jsonb;
begin
  -- 1. A due follow-up: Hal's call task due today (his zone), on a cold lead whose next call date is days away (the
  --    task is the reason).
  l := pg_temp.new_lead(h, 'cold', now() + interval '3 days', lead_name => 'Q1 follow-up due');
  perform pg_temp.new_task(l, h, 'call', (now() at time zone 'Europe/Paris')::date);
  want := want || l;
  -- 2 and 3. Negotiation: due, then undated.
  want := want || pg_temp.new_lead(h, 'negotiation', now() - interval '1 day', lead_name => 'Q2 negotiation due');
  want := want || pg_temp.new_lead(h, 'negotiation', lead_name => 'Q3 negotiation');
  -- 4. Warm, due.
  want := want || pg_temp.new_lead(h, 'warm', now() - interval '2 hours', lead_name => 'Q4 warm');
  -- 5 and 6. Rank 2 by date: a cold retry due 3 days ago, then a Cool off lead back since yesterday.
  want := want || pg_temp.new_lead(h, 'cold', now() - interval '3 days', lead_name => 'Q5 cold retry due');
  l := pg_temp.new_lead(h, 'cold', lead_name => 'Q6 cool off returning');
  update public.companies set lead_status = 'cool_off', next_action_at = now() - interval '1 day' where id = l;
  want := want || l;
  -- 7 and 8. First calls: never called first, then a lead called before whose main line is wrong but whose contact
  --    has a number.
  want := want || pg_temp.new_lead(h, 'cold', lead_name => 'Q7 cold never called');
  l := pg_temp.new_lead(h, 'cold', lead_name => 'Q8 wrong main line, contact number');
  update public.companies set phone_wrong_at = now(), last_activity_at = now() - interval '10 days' where id = l;
  perform pg_temp.new_contact(l);
  want := want || l;
  -- Never served, or not yet.
  l := pg_temp.new_lead(h, 'cool_off', lead_name => 'X1 cool off without a date');
  alter table public.companies disable trigger lead_guard;
  update public.companies set next_action_at = null where id = l;
  alter table public.companies enable trigger lead_guard;
  never := never || l;
  never := never || pg_temp.new_lead(h, 'cold', now() + interval '2 days', lead_name => 'X2 future retry');
  never := never || pg_temp.new_lead(h, 'do_not_contact', lead_name => 'X3 do not contact');
  never := never || pg_temp.new_lead(h, 'disqualified', lead_name => 'X4 disqualified');
  never := never || pg_temp.new_lead(h, 'customer', lead_name => 'X5 customer');
  never := never || pg_temp.new_lead(h, 'cold', phone => null, lead_name => 'X6 no number');
  never := never || pg_temp.new_lead(h, 'negotiation', now() + interval '1 day', lead_name => 'X7 negotiation later');
  l := pg_temp.new_lead(h, 'warm', lead_name => 'X8 wrong main line, no contact');
  update public.companies set phone_wrong_at = now() where id = l;
  never := never || l;
  never := never || pg_temp.new_lead(h, 'warm', phone => '( )', lead_name => 'X9 a number without digits');
  perform set_config('t.hal_order', want::text, false);
  perform set_config('t.hal_never', never::text, false);

  perform pg_temp.act(h);
  for n in 1..30 loop
    r := public.claim_next_lead('mine', '{}'::uuid[], got, 1, true);
    exit when jsonb_array_length(r -> 'cards') = 0;
    got := got || (r -> 'cards' -> 0 ->> 'id')::uuid;
    reasons := reasons || (r -> 'cards' -> 0 ->> 'reason');
  end loop;
  if got is distinct from want then
    raise exception 'FAIL: queue order: got %, expected %', got, want;
  end if;
  if reasons is distinct from want_reasons then
    raise exception 'FAIL: queue reasons: got %, expected %', reasons, want_reasons;
  end if;
  if r -> 'summary' is null or jsonb_typeof(r -> 'summary') <> 'object' or r -> 'kept' <> '[]'::jsonb then
    raise exception 'FAIL: an empty queue answers the summary %', r;
  end if;
  -- Two at once (Start): the first two, both claimed for 10 minutes, with the card's facts.
  r := public.claim_next_lead('mine', null, '{}', 2, true);
  if jsonb_array_length(r -> 'cards') <> 2 or (r -> 'cards' -> 0 ->> 'id')::uuid <> want[1]
     or (r -> 'cards' -> 1 ->> 'id')::uuid <> want[2] or r -> 'summary' <> 'null'::jsonb
     or (r -> 'cards' -> 0 ->> 'claimed_until')::timestamptz <> now() + interval '10 minutes'
     or not (r -> 'cards' -> 0 ->> 'can_edit')::boolean or r -> 'cards' -> 0 ->> 'call_zone' <> 'Europe/Paris'
     or jsonb_array_length(r -> 'cards' -> 0 -> 'my_open_tasks') <> 1
     or (r -> 'cards' -> 0 -> 'owner' ->> 'id')::uuid <> h then
    raise exception 'FAIL: Start with two cards: %', r;
  end if;
  if public.release_claims() <> 2 then raise exception 'FAIL: release_claims'; end if;
  perform pg_temp.su();
  if exists (select 1 from private.queue_claims where user_id = h) then
    raise exception 'FAIL: claims left behind';
  end if;
end $$;

-- 7. Calling hours in the queue (threat 17): a lead whose zone is outside hours is never served unless asked.
do $$
declare
  i constant uuid := '00000000-0000-0000-0000-0000000000a6';
  open_c text := pg_temp.country_in_hours(true);
  closed_c text := pg_temp.country_in_hours(false);
  l_open uuid;
  l_closed uuid;
  r jsonb;
  ids uuid[];
begin
  if closed_c is null then raise exception 'FAIL: no country outside calling hours found'; end if;
  l_closed := pg_temp.new_lead(i, 'negotiation', country => closed_c, lead_name => 'H closed');
  if open_c is not null then
    l_open := pg_temp.new_lead(i, 'warm', country => open_c, lead_name => 'H open');
  else
    raise notice 'no country is in calling hours right now: the "in hours" half of section 7 is skipped';
  end if;
  perform pg_temp.act(i);
  r := public.claim_next_lead('mine', '{}'::uuid[], '{}', 2, false);
  select coalesce(array_agg((c ->> 'id')::uuid), '{}') into ids from jsonb_array_elements(r -> 'cards') c;
  if l_closed = any (ids) then raise exception 'FAIL: queue_skips_closed_zones: a lead outside hours was served'; end if;
  if l_open is not null and (ids is distinct from array[l_open]
                             or not (r -> 'cards' -> 0 ->> 'local_time_open')::boolean) then
    raise exception 'FAIL: a lead in hours was not served: %', r;
  end if;
  if l_open is null and (jsonb_array_length(r -> 'cards') <> 0
                         or r -> 'summary' -> 'waiting_by_zone' -> 0 ->> 'key' <> private.country_call_zone(closed_c)) then
    raise exception 'FAIL: nothing in hours answers the summary with the waiting zone: %', r;
  end if;
  -- "Show leads outside calling hours": served, marked as outside.
  r := public.claim_next_lead('mine', '{}'::uuid[], '{}', 2, true);
  if (r -> 'cards' -> 0 ->> 'id')::uuid <> l_closed or (r -> 'cards' -> 0 ->> 'local_time_open')::boolean then
    raise exception 'FAIL: outside hours on request: %', r;
  end if;
  perform public.release_claims();
  perform pg_temp.su();
  delete from public.companies where id in (l_open, l_closed);
end $$;

-- 8. Scopes (threat 13): reps work only their own leads; managers and admins may add the unassigned ones or the team's.
do $$
declare
  h constant uuid := '00000000-0000-0000-0000-0000000000a5';
  i constant uuid := '00000000-0000-0000-0000-0000000000a6';
  k constant uuid := '00000000-0000-0000-0000-0000000000a7';
  l_i uuid := pg_temp.new_lead(i, 'warm', lead_name => 'S Ivy''s lead');
  l_k uuid := pg_temp.new_lead(k, 'negotiation', lead_name => 'S Kit''s lead');
  l_u uuid := pg_temp.new_lead(null, 'negotiation', now() - interval '5 days', lead_name => 'S unassigned lead');
  l_h uuid := (current_setting('t.hal_order')::uuid[])[3];   -- Hal's undated Negotiation lead
  v_today date := (now() at time zone 'Europe/Paris')::date;
  cands uuid[];
  r jsonb;
begin
  perform pg_temp.act(h);
  perform pg_temp.expect_error($q$select public.claim_next_lead('team')$q$, '42501', 'scope');
  perform pg_temp.expect_error($q$select public.claim_next_lead('mine_unassigned')$q$, '42501', 'scope');
  perform pg_temp.expect_error($q$select public.queue_summary('team')$q$, '42501', 'scope');
  perform pg_temp.expect_error($q$select public.queue_summary('mine_unassigned')$q$, '42501', 'scope');
  -- rep_cannot_claim_others_lead: neither through the API function nor a direct insert (no locking a teammate out).
  perform pg_temp.expect_error(format('select public.claim_lead(%L)', l_i), '42501', 'scope');
  perform pg_temp.expect_error(format('insert into private.queue_claims (company_id) values (%L)', l_i), '42501');
  perform pg_temp.expect_error(format('insert into private.queue_claims (company_id) values (%L)', l_u), '42501');
  perform pg_temp.expect_error('select public.claim_lead(gen_random_uuid())', 'P0002');
  -- A rep's candidates are only their own leads, in every part of the order.
  for seg in 0..6 loop
    cands := coalesce(cands, '{}') || array(select private.queue_candidates(seg, 'mine', null, '{}', v_today, 'Europe/Paris', 100000));
  end loop;
  perform pg_temp.su();
  if exists (select 1 from public.companies where id = any (cands) and owner_id is distinct from h) then
    raise exception 'FAIL: a rep''s queue offered someone else''s lead';
  end if;
  -- Kit (admin): Mine + unassigned is his leads and the unassigned ones; Team is everyone's.
  cands := '{}';
  perform pg_temp.act(k);
  for seg in 0..6 loop
    cands := cands || array(select private.queue_candidates(seg, 'mine_unassigned', null, '{}', v_today, 'Europe/Paris', 100000));
  end loop;
  perform pg_temp.su();
  if not (l_k = any (cands)) or not (l_u = any (cands)) or l_h = any (cands) or l_i = any (cands)
     or exists (select 1 from public.companies where id = any (cands) and owner_id is not null and owner_id <> k) then
    raise exception 'FAIL: Mine + unassigned';
  end if;
  cands := '{}';
  perform pg_temp.act(k);
  for seg in 1..6 loop
    cands := cands || array(select private.queue_candidates(seg, 'team', null, '{}', v_today, 'Europe/Paris', 100000));
  end loop;
  if not (l_k = any (cands)) or not (l_u = any (cands)) or not (l_h = any (cands)) or not (l_i = any (cands)) then
    raise exception 'FAIL: Team must offer every lead of the team';
  end if;
  -- The six rank parts never overlap (a lead has one rank, and is either dated and due or undated).
  if (select count(*) from unnest(cands)) <> (select count(distinct x) from unnest(cands) x) then
    raise exception 'FAIL: a lead appears in two parts of the order';
  end if;
  -- Kit may claim a teammate's lead and an unassigned one (managers and admins may change any lead).
  if not public.claim_lead(l_i) or not public.claim_lead(l_u) then raise exception 'FAIL: an admin claims any lead'; end if;
  r := public.claim_next_lead('team', '{}'::uuid[], '{}', 1, true);
  if jsonb_array_length(r -> 'cards') <> 1 then raise exception 'FAIL: Team for an admin: %', r; end if;
  r := public.claim_next_lead('mine_unassigned', '{}'::uuid[], '{}', 1, true);
  perform pg_temp.su();
  if (select owner_id is not null and owner_id <> k from public.companies where id = (r -> 'cards' -> 0 ->> 'id')::uuid) then
    raise exception 'FAIL: Mine + unassigned served someone else''s lead';
  end if;
  delete from private.queue_claims where user_id = k;
  delete from public.companies where id in (l_i, l_k, l_u);
end $$;

-- 9. Claims (threats 14 and 15): one person per lead; the server sets who and how long; at most 3; expired ones go.
do $$
declare
  i constant uuid := '00000000-0000-0000-0000-0000000000a6';
  k constant uuid := '00000000-0000-0000-0000-0000000000a7';
  henri constant uuid := '00000000-0000-0000-0000-00000000000b';
  c1 constant uuid := '00000000-0000-0000-0000-0000000000c1';
  k1 uuid := pg_temp.new_lead(k, 'warm', lead_name => 'C1');
  k2 uuid := pg_temp.new_lead(k, 'warm', lead_name => 'C2');
  k3 uuid := pg_temp.new_lead(k, 'warm', lead_name => 'C3');
  k4 uuid := pg_temp.new_lead(k, 'warm', lead_name => 'C4');
  q record;
  n integer;
  r jsonb;
begin
  -- claim_guard_forces_fields: a direct insert names only the lead; the server sets the rest.
  perform pg_temp.act(k);
  insert into private.queue_claims (company_id) values (k1);
  perform pg_temp.su();
  select * into q from private.queue_claims where company_id = k1;
  if q.user_id <> k or q.org_id <> current_setting('t.main_org')::uuid or q.claimed_at <> now()
     or q.expires_at <> now() + interval '10 minutes' then
    raise exception 'FAIL: the claim guard must set the person, organisation and times: %', row_to_json(q);
  end if;
  perform pg_temp.act(k);
  -- Nobody claims for someone else or chooses the length (column grants), and only the end of a claim changes.
  perform pg_temp.expect_error(format('insert into private.queue_claims (company_id, user_id) values (%L, %L)', k2, i), '42501');
  perform pg_temp.expect_error(format('insert into private.queue_claims (company_id, expires_at) values (%L, %L)',
                                      k2, now() + interval '1 year'), '42501');
  perform pg_temp.expect_error(format('update private.queue_claims set user_id = %L where company_id = %L', i, k1), '42501');
  perform pg_temp.expect_error(format('update private.queue_claims set company_id = %L where company_id = %L', k2, k1), '42501');
  update private.queue_claims set expires_at = now() + interval '1 year' where company_id = k1;
  perform pg_temp.su();
  if (select expires_at from private.queue_claims where company_id = k1) <> now() + interval '10 minutes' then
    raise exception 'FAIL: a client stretched a claim';
  end if;
  -- claim_cap_3: three live claims at most; an expired one does not count; renewing it beyond 3 is refused.
  perform pg_temp.act(k);
  insert into private.queue_claims (company_id) values (k2), (k3);
  perform pg_temp.expect_error(format('insert into private.queue_claims (company_id) values (%L)', k4), '22023', 'busy');
  perform pg_temp.expect_error(format('select public.claim_lead(%L)', k4), '22023', 'busy');
  perform pg_temp.su();
  update private.queue_claims set expires_at = now() - interval '1 second' where company_id = k3;
  perform pg_temp.act(k);
  insert into private.queue_claims (company_id) values (k4);
  perform pg_temp.expect_error(format('update private.queue_claims set expires_at = now() where company_id = %L', k3),
                               '22023', 'busy');
  -- A teammate sees who is on which lead, cannot remove or stretch a fresh claim, and removes an expired one.
  perform pg_temp.act(i);
  if (select count(*) from private.queue_claims where company_id in (k1, k2, k3, k4)) <> 4 then
    raise exception 'FAIL: the team must see the claims';
  end if;
  delete from private.queue_claims where company_id = k1;
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'FAIL: claim_delete_other_fresh_zero_rows'; end if;
  update private.queue_claims set expires_at = now() where company_id = k1;
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'FAIL: a teammate renewed someone else''s claim'; end if;
  delete from private.queue_claims where company_id = k3;
  get diagnostics n = row_count;
  if n <> 1 then raise exception 'FAIL: an expired claim must be removable by anyone in the team'; end if;
  -- other_org_claim_invisible: another organisation sees and removes nothing, even an expired claim.
  perform pg_temp.su();
  update private.queue_claims set expires_at = now() - interval '1 second' where company_id = k2;
  perform pg_temp.act(c1);
  if (select count(*) from private.queue_claims) <> 0 then raise exception 'FAIL: another organisation sees claims'; end if;
  delete from private.queue_claims where company_id = k2;
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'FAIL: another organisation removed a claim'; end if;
  perform pg_temp.expect_error(format('select public.claim_lead(%L)', k2), 'P0002');
  -- Renew and release (own claims only).
  perform pg_temp.act(k);
  if public.renew_claims() <> now() + interval '10 minutes' then raise exception 'FAIL: renew_claims'; end if;
  perform pg_temp.su();
  if (select expires_at from private.queue_claims where company_id = k2) > now() then
    raise exception 'FAIL: renew_claims brought back an expired claim';
  end if;
  perform pg_temp.act(k);
  perform pg_temp.expect_error(format('select public.release_claims(%L::uuid[])',
                                      (select array_agg(gen_random_uuid()) from generate_series(1, 11))::text), '22023', 'bounds');
  if public.release_claims(array[k1]) <> 1 or public.release_claims() <> 2 or public.release_claims() <> 0
     or public.renew_claims() is not null then
    raise exception 'FAIL: release_claims';
  end if;

  -- fresh_claim_not_stolen and expired_claim_taken_over (one session; the races are in queue_concurrency.sh).
  if not public.claim_lead(k1) or not public.claim_lead(k1) then raise exception 'FAIL: claim_lead, then again'; end if;
  perform pg_temp.act(henri);
  if public.claim_lead(k1) then raise exception 'FAIL: a fresh claim was taken over'; end if;
  perform pg_temp.su();
  update private.queue_claims set expires_at = now() - interval '1 second' where company_id = k1;
  perform pg_temp.act(henri);
  if not public.claim_lead(k1) then raise exception 'FAIL: an expired claim must be taken over'; end if;
  perform pg_temp.act(k);
  r := public.claim_next_lead('mine', '{}'::uuid[], '{}', 2, true);
  if exists (select 1 from jsonb_array_elements(r -> 'cards') c where (c ->> 'id')::uuid = k1) then
    raise exception 'FAIL: a lead claimed by a teammate was served';
  end if;
  perform pg_temp.su();
  if (select array_agg(user_id) from private.queue_claims where company_id = k1) <> array[henri] then
    raise exception 'FAIL: one claim per lead, the taker''s';
  end if;
  -- The queue itself takes over an expired claim (removed first, then claimed by the caller).
  delete from private.queue_claims where user_id = k;
  update private.queue_claims set expires_at = now() - interval '1 second' where company_id = k1;
  update public.companies set next_action_at = now() - interval '1 hour' where id = k1;   -- first in Kit's queue
  perform pg_temp.act(k);
  r := public.claim_next_lead('mine', '{}'::uuid[], '{}', 1, true);
  perform pg_temp.su();
  if (r -> 'cards' -> 0 ->> 'id')::uuid <> k1
     or (select array_agg(user_id) from private.queue_claims where company_id = k1) <> array[k] then
    raise exception 'FAIL: claim_next_lead must take over an expired claim: %', r;
  end if;
  -- A claim is not work: it goes with its lead.
  delete from public.companies where id = k1;
  if exists (select 1 from private.queue_claims where company_id = k1) then
    raise exception 'FAIL: a deleted lead kept its claim';
  end if;
  delete from private.queue_claims where user_id in (k, henri);
  delete from public.companies where id in (k2, k3, k4);
end $$;

-- 10. Start, reload and keep (design 5.4 buffer): p_keep null brings back the caller's eligible claims (renewed),
-- p_keep renews those cards and lets the others go; bounds.
do $$
declare
  k constant uuid := '00000000-0000-0000-0000-0000000000a7';
  ka uuid := pg_temp.new_lead(k, 'negotiation', now() - interval '3 days', lead_name => 'B KA');
  kb uuid := pg_temp.new_lead(k, 'negotiation', now() - interval '2 days', lead_name => 'B KB');
  kc uuid := pg_temp.new_lead(k, 'warm', now() - interval '1 day', lead_name => 'B KC');
  kd uuid := pg_temp.new_lead(k, 'cold', lead_name => 'B KD');
  r jsonb;
  ids uuid[];
begin
  perform pg_temp.act(k);
  r := public.claim_next_lead('mine', null, '{}', 2, true);
  select array_agg((c ->> 'id')::uuid) into ids from jsonb_array_elements(r -> 'cards') c;
  if ids is distinct from array[ka, kb] then raise exception 'FAIL: Start: %', ids; end if;
  perform pg_temp.su();
  update private.queue_claims set expires_at = now() + interval '1 minute' where user_id = k;
  perform pg_temp.act(k);
  -- A reload gets the same two back, renewed (reason as usual), and claims nothing new.
  r := public.claim_next_lead('mine', null, '{}', 2, true);
  select array_agg((c ->> 'id')::uuid) into ids from jsonb_array_elements(r -> 'cards') c;
  if ids is distinct from array[ka, kb] or r -> 'cards' -> 0 ->> 'reason' <> 'negotiation'
     or (r -> 'cards' -> 1 ->> 'claimed_until')::timestamptz <> now() + interval '10 minutes' then
    raise exception 'FAIL: a reload must resume the claims: %', r;
  end if;
  -- After an outcome on KA (no answer: back the next working day): keep KB, one new card (KC); KA's claim goes.
  perform public.log_activity(ka, 'call', 'no_answer', p_from_queue => true);
  r := public.claim_next_lead('mine', array[kb], '{}', 1, true);
  if (r -> 'cards' -> 0 ->> 'id')::uuid <> kc or r -> 'kept' <> jsonb_build_array(kb) then
    raise exception 'FAIL: keep one, claim one: %', r;
  end if;
  perform pg_temp.su();
  if (select array_agg(company_id order by company_id) from private.queue_claims where user_id = k)
     is distinct from (select array_agg(x order by x) from unnest(array[kb, kc]) x) then
    raise exception 'FAIL: the caller''s claims after keep';
  end if;
  -- A claim whose lead is no longer due goes on reload; the next lead takes its place.
  update public.companies set next_action_at = now() + interval '1 day' where id = kc;
  perform pg_temp.act(k);
  r := public.claim_next_lead('mine', null, '{}', 2, true);
  select array_agg((c ->> 'id')::uuid) into ids from jsonb_array_elements(r -> 'cards') c;
  if ids is distinct from array[kb, kd] then raise exception 'FAIL: reload with a lead no longer due: %', ids; end if;
  -- A skipped lead is not resumed either.
  r := public.claim_next_lead('mine', null, array[kb], 1, true);
  if (r -> 'cards' -> 0 ->> 'id')::uuid <> kd then raise exception 'FAIL: reload with a skip: %', r; end if;
  perform pg_temp.su();
  if exists (select 1 from private.queue_claims where user_id = k and company_id = kb) then
    raise exception 'FAIL: a skipped lead kept its claim';
  end if;
  -- Bounds (constant errors).
  perform pg_temp.act(k);
  perform pg_temp.expect_error(format('select public.claim_next_lead(%L, %L::uuid[], %L, 1, true)', 'mine',
                                      array[ka, kb, kc]::text, '{}'), '22023', 'bounds');
  perform pg_temp.expect_error($q$select public.claim_next_lead('mine', null, '{}', 3, true)$q$, '22023', 'bounds');
  perform pg_temp.expect_error($q$select public.claim_next_lead('mine', null, '{}', 0, true)$q$, '22023', 'bounds');
  perform pg_temp.expect_error($q$select public.claim_next_lead('mine', null, '{}', null, true)$q$, '22023', 'bounds');
  perform pg_temp.expect_error(format('select public.claim_next_lead(%L, %L::uuid[], %L, 2, true)', 'mine',
                                      array[ka, kb]::text, '{}'), '22023', 'bounds');
  perform pg_temp.expect_error(format('select public.claim_next_lead(%L, null, %L::uuid[], 1, true)', 'mine',
                                      (select array_agg(gen_random_uuid()) from generate_series(1, 201))::text), '22023', 'bounds');
  perform pg_temp.expect_error($q$select public.claim_next_lead('everyone')$q$, '22023', 'bounds');
  perform pg_temp.expect_error($q$select public.claim_next_lead('mine', null, '{}', 1, null)$q$, '22023', 'bounds');
  perform pg_temp.expect_error($q$select public.claim_next_lead('mine', null, '{}', 1, false, null)$q$, '22023', 'bounds');
  perform pg_temp.expect_error($q$select public.queue_summary('everyone')$q$, '22023', 'bounds');
  perform pg_temp.expect_error($q$select public.claim_next_lead('mine', null, array[null]::uuid[], 1, true)$q$, '22023', 'bounds');
  perform pg_temp.expect_error($q$select public.claim_next_lead('mine', array[null]::uuid[], '{}', 1, true)$q$, '22023', 'bounds');
  perform pg_temp.expect_error($q$select public.release_claims(array[null]::uuid[])$q$, '22023', 'bounds');
  -- p_exclude null is read as no skips.
  r := public.claim_next_lead('mine', '{}'::uuid[], null, 1, true);
  if jsonb_array_length(r -> 'cards') <> 1 then raise exception 'FAIL: p_exclude null'; end if;
  perform public.release_claims();

  -- 11. log_activity from the queue releases the claim (design 5.2 step 9); the lead page shows who works a lead.
  if not public.claim_lead(ka) then raise exception 'FAIL: claim KA'; end if;
  perform public.log_activity(ka, 'call', 'no_answer', p_from_queue => true);
  if not public.claim_lead(kb) then raise exception 'FAIL: claim KB'; end if;
  perform public.log_activity(kb, 'call', 'no_answer');
  perform pg_temp.su();
  if exists (select 1 from private.queue_claims where company_id = ka)
     or not exists (select 1 from private.queue_claims where company_id = kb and user_id = k) then
    raise exception 'FAIL: p_from_queue must release the caller''s claim, and only then';
  end if;
  perform pg_temp.act('00000000-0000-0000-0000-00000000000b');
  if not public.claim_lead(kd) then raise exception 'FAIL: Henri claims KD'; end if;
  perform pg_temp.act(k);
  r := public.get_lead(kd) -> 'worked_by';
  if r ->> 'first_name' <> 'Henri' or (r ->> 'until')::timestamptz <> now() + interval '10 minutes'
     or (select count(*) from jsonb_object_keys(r)) <> 2 then
    raise exception 'FAIL: worked_by for a teammate''s claim: %', r;
  end if;
  if public.get_lead(kb) -> 'worked_by' <> 'null'::jsonb then
    raise exception 'FAIL: the caller''s own claim is not "worked by"';
  end if;
  perform pg_temp.act('00000000-0000-0000-0000-00000000000b');
  if public.get_lead(kd) -> 'worked_by' <> 'null'::jsonb then raise exception 'FAIL: worked_by for oneself'; end if;
  -- A call on that lead from Kit's queue releases only Kit's own claim, never Henri's.
  perform pg_temp.act(k);
  perform public.log_activity(kd, 'call', 'connected', p_from_queue => true);
  perform pg_temp.su();
  if (select array_agg(user_id) from private.queue_claims where company_id = kd)
     <> array['00000000-0000-0000-0000-00000000000b'::uuid] then
    raise exception 'FAIL: a call from the queue released a teammate''s claim';
  end if;
  perform pg_temp.act('00000000-0000-0000-0000-00000000000b');
  perform pg_temp.su();
  update private.queue_claims set expires_at = now() - interval '1 second' where company_id = kd;
  perform pg_temp.act(k);
  if public.get_lead(kd) -> 'worked_by' <> 'null'::jsonb then raise exception 'FAIL: worked_by for an expired claim'; end if;
  perform pg_temp.su();
  delete from private.queue_claims where company_id in (ka, kb, kc, kd);
  delete from public.companies where id in (ka, kb, kc, kd);
end $$;

-- 12. queue_summary (design 4.2): Ivy's start-screen counts, from one pass.
do $$
declare
  i constant uuid := '00000000-0000-0000-0000-0000000000a6';
  open_c text := pg_temp.country_in_hours(true);
  closed_c text := pg_temp.country_in_hours(false);
  v_end timestamptz := ((now() at time zone 'Europe/Paris')::date + 1)::timestamp at time zone 'Europe/Paris';
  l_open uuid;
  l_wait uuid := pg_temp.new_lead(i, 'negotiation', country => closed_c, lead_name => 'Sum waiting');
  l_later uuid;
  l_none uuid := pg_temp.new_lead(i, 'cold', phone => null, lead_name => 'Sum no number');
  l_taken uuid := pg_temp.new_lead(i, 'warm', country => closed_c, lead_name => 'Sum taken');
  l_cool uuid := pg_temp.new_lead(i, 'cool_off', lead_name => 'Sum cool off, no date');
  l_cust uuid := pg_temp.new_lead(i, 'customer', phone => null, lead_name => 'Sum customer, no number');
  s jsonb;
  r jsonb;
begin
  if open_c is not null then
    l_open := pg_temp.new_lead(i, 'warm', country => open_c, lead_name => 'Sum callable');
    perform pg_temp.new_task(l_open, i, 'call', (now() at time zone 'Europe/Paris')::date);
  end if;
  if v_end - now() > interval '2 minutes' then
    l_later := pg_temp.new_lead(i, 'cold', now() + (v_end - now()) / 2, country => closed_c, lead_name => 'Sum later today');
  else
    raise notice 'less than 2 minutes left in the day in Paris: the "later today" lead of section 12 is skipped';
  end if;
  alter table public.companies disable trigger lead_guard;
  update public.companies set next_action_at = null where id = l_cool;
  alter table public.companies enable trigger lead_guard;
  insert into private.queue_claims (company_id, org_id, user_id, expires_at)
  values (l_taken, current_setting('t.main_org')::uuid, '00000000-0000-0000-0000-0000000000a7', now() + interval '5 minutes');
  perform pg_temp.act(i);
  s := public.queue_summary();
  if (s ->> 'callable_now')::integer <> (open_c is not null)::integer
     or (s ->> 'follow_ups_due')::integer <> (open_c is not null)::integer
     or (s ->> 'later_today')::integer <> (l_later is not null)::integer
     or (s ->> 'no_number')::integer <> 1 or (s ->> 'claimed_by_others')::integer <> 1
     or s -> 'waiting_by_zone' <> jsonb_build_array(jsonb_build_object('key', private.country_call_zone(closed_c), 'count', 1))
     or (select count(*) from jsonb_object_keys(s)) <> 6 then
    raise exception 'FAIL: queue_summary %', s;
  end if;
  -- Nothing callable (the one lead in hours skipped): no card, and the summary comes with the answer.
  r := public.claim_next_lead('mine', '{}'::uuid[], case when l_open is null then '{}'::uuid[] else array[l_open] end,
                              1, false);
  if jsonb_array_length(r -> 'cards') <> 0 or (r -> 'summary' ->> 'no_number')::integer <> 1 then
    raise exception 'FAIL: nothing callable: %', r;
  end if;
  perform pg_temp.su();
  delete from private.queue_claims where company_id = l_taken;
  delete from public.companies where id in (l_open, l_wait, l_later, l_none, l_taken, l_cool, l_cust);
end $$;

-- 13. Tasks buckets in the caller's own zone (design 5.6), Europe/Paris and Asia/Karachi, with Jo's tasks only.
create function pg_temp.bucket(b text) returns uuid[]
language sql as $$ select coalesce(array_agg(t.id), '{}') from public.list_tasks(b, 'mine', null, null, 100) t $$;
create function pg_temp.same_set(a uuid[], b uuid[]) returns boolean
language sql as $$ select coalesce((select array_agg(x order by x) from unnest(a) x), '{}')
                          = coalesce((select array_agg(x order by x) from unnest(b) x), '{}') $$;
do $$
declare
  j constant uuid := '00000000-0000-0000-0000-0000000000a8';
  jl uuid := pg_temp.new_lead(j, 'cold', lead_name => 'Jo''s lead');
  z text;
  v_today date;
  v_tomorrow timestamptz;
  x_at timestamptz := (((now() at time zone 'Asia/Karachi')::date + 1)::timestamp at time zone 'Asia/Karachi')
                      + interval '30 minutes';   -- 00:30 tomorrow in Karachi: an evening in Paris
  od_d uuid; od_t uuid; td_d uuid; td_t uuid; up_d uuid; up_t uuid; none_t uuid; done_t uuid; gone_t uuid; x_t uuid;
  x_today boolean;
  c jsonb;
  row record;
begin
  perform set_config('t.jo_lead', jl::text, false);
  foreach z in array array['Europe/Paris', 'Asia/Karachi'] loop
    delete from public.tasks where assignee_id = j;
    update public.profiles set timezone = z where id = j;
    v_today := (now() at time zone z)::date;
    v_tomorrow := (v_today + 1)::timestamp at time zone z;
    od_d := pg_temp.new_task(jl, j, 'todo', v_today - 1);
    od_t := pg_temp.new_task(jl, j, 'call', null, now() - interval '1 minute');
    td_d := pg_temp.new_task(jl, j, 'todo', v_today);
    td_t := pg_temp.new_task(jl, j, 'call', null, now() + (v_tomorrow - now()) / 2);
    up_d := pg_temp.new_task(jl, j, 'todo', v_today + 1);
    up_t := pg_temp.new_task(jl, j, 'meeting', null, v_tomorrow + interval '1 minute');
    none_t := pg_temp.new_task(null, j, 'todo');
    done_t := pg_temp.new_task(jl, j, 'todo', v_today);
    gone_t := pg_temp.new_task(jl, j, 'todo', v_today);
    x_t := pg_temp.new_task(jl, j, 'call', null, x_at);
    update public.tasks set done_at = now(), completed_by = j where id = done_t;
    update public.tasks set cancelled_at = now() where id = gone_t;
    x_today := x_at < v_tomorrow;   -- today for Paris most of the day, never for Karachi
    perform pg_temp.act(j);
    if not pg_temp.same_set(pg_temp.bucket('overdue'), array[od_d, od_t]) then
      raise exception 'FAIL: overdue in %: %', z, pg_temp.bucket('overdue');
    end if;
    if not pg_temp.same_set(pg_temp.bucket('today'), array[td_d, td_t] || case when x_today then array[x_t] else '{}' end) then
      raise exception 'FAIL: today in %: %', z, pg_temp.bucket('today');
    end if;
    if not pg_temp.same_set(pg_temp.bucket('upcoming'), array[up_d, up_t, none_t] || case when x_today then '{}' else array[x_t] end) then
      raise exception 'FAIL: upcoming in %: %', z, pg_temp.bucket('upcoming');
    end if;
    if pg_temp.bucket('done') <> array[done_t] then raise exception 'FAIL: done in %', z; end if;
    if (pg_temp.bucket('upcoming'))[cardinality(pg_temp.bucket('upcoming'))] <> none_t then
      raise exception 'FAIL: an undated task comes last in %', z;
    end if;
    if z = 'Asia/Karachi' and x_today then raise exception 'FAIL: 00:30 tomorrow in Karachi is not today there'; end if;
    c := public.count_tasks();
    if (c ->> 'overdue')::integer <> 2 or (c ->> 'today')::integer <> 2 + x_today::integer
       or (c ->> 'upcoming')::integer <> 3 + (not x_today)::integer then
      raise exception 'FAIL: count_tasks in %: %', z, c;
    end if;
    select * into row from public.list_tasks('today', 'mine', null, null, 100) t where t.id = td_d;
    if row.sort_at <> v_today::timestamp at time zone z or row.company_id <> jl or row.company_name <> 'Jo''s lead'
       or row.company_call_zone <> 'Europe/Paris' or row.company_lead_status <> 'cold' or not row.can_edit
       or row.assignee_id <> j or row.assignee_first_name <> 'Jo' or row.created_by <> j then
      raise exception 'FAIL: a Today row: %', row_to_json(row);
    end if;
    if (select t.sort_at from public.list_tasks('upcoming', 'mine', null, null, 100) t where t.id = none_t) is not null then
      raise exception 'FAIL: an undated task has no sort time';
    end if;
    perform pg_temp.su();
  end loop;
end $$;

-- Keyset pages (same times on purpose) never repeat or skip a task; the cursor in the undated part is (null, id).
do $$
declare
  j constant uuid := '00000000-0000-0000-0000-0000000000a8';
  jl uuid := current_setting('t.jo_lead')::uuid;
  v_day date := (now() at time zone 'Asia/Karachi')::date + 3;
  all_ids uuid[];
  paged uuid[] := '{}';
  cur_sort timestamptz;
  cur_id uuid;
  page record;
  n integer;
  done_id uuid;
begin
  delete from public.tasks where assignee_id = j;
  for g in 1..7 loop perform pg_temp.new_task(jl, j, 'todo', v_day, null, 'Same day ' || g); end loop;
  for g in 1..3 loop perform pg_temp.new_task(null, j, 'todo', null, null, 'Someday ' || g); end loop;
  for g in 1..5 loop
    done_id := pg_temp.new_task(jl, j, 'todo', v_day, null, 'Done ' || g);
    update public.tasks set done_at = timestamptz '2026-10-01 10:00+00', completed_by = j where id = done_id;
  end loop;
  perform pg_temp.act(j);
  all_ids := pg_temp.bucket('upcoming');
  if cardinality(all_ids) <> 10 then raise exception 'FAIL: upcoming keyset fixture %', cardinality(all_ids); end if;
  loop
    n := 0;
    for page in select * from public.list_tasks('upcoming', 'mine', cur_sort, cur_id, 3) loop
      paged := paged || page.id;
      cur_sort := page.sort_at;
      cur_id := page.id;
      n := n + 1;
    end loop;
    exit when n < 3;
  end loop;
  if paged is distinct from all_ids then raise exception 'FAIL: upcoming pages % against %', paged, all_ids; end if;
  all_ids := pg_temp.bucket('done');
  paged := '{}';
  cur_sort := null;
  cur_id := null;
  loop
    n := 0;
    for page in select * from public.list_tasks('done', 'mine', cur_sort, cur_id, 2) loop
      paged := paged || page.id;
      cur_sort := page.sort_at;
      cur_id := page.id;
      n := n + 1;
    end loop;
    exit when n < 2;
  end loop;
  if cardinality(all_ids) <> 5 or paged is distinct from all_ids then
    raise exception 'FAIL: done pages % against %', paged, all_ids;
  end if;
  -- Bounds and cursors (constant errors), and the team scope for managers and admins only.
  perform pg_temp.expect_error($q$select * from public.list_tasks('later')$q$, '22023', 'bad_bucket');
  perform pg_temp.expect_error($q$select * from public.list_tasks(null)$q$, '22023', 'bad_bucket');
  perform pg_temp.expect_error($q$select * from public.list_tasks('today', 'mine', now(), null)$q$, '22023', 'bad_cursor');
  perform pg_temp.expect_error($q$select * from public.list_tasks('today', 'mine', null, gen_random_uuid())$q$, '22023', 'bad_cursor');
  perform pg_temp.expect_error($q$select * from public.list_tasks('done', 'mine', null, gen_random_uuid())$q$, '22023', 'bad_cursor');
  perform pg_temp.expect_error($q$select * from public.list_tasks('today', 'mine', null, null, 0)$q$, '22023', 'bounds');
  perform pg_temp.expect_error($q$select * from public.list_tasks('today', 'mine', null, null, 101)$q$, '22023', 'bounds');
  perform pg_temp.expect_error($q$select * from public.list_tasks('today', 'everyone')$q$, '22023', 'bounds');
  perform pg_temp.expect_error($q$select public.count_tasks('everyone')$q$, '22023', 'bounds');
  perform pg_temp.expect_error($q$select * from public.list_tasks('today', 'team')$q$, '42501', 'scope');
  perform pg_temp.expect_error($q$select public.count_tasks('team')$q$, '42501', 'scope');
  perform pg_temp.su();
  -- team_scope_admin_only: Kit (admin) sees Jo's tasks in Team.
  perform pg_temp.act('00000000-0000-0000-0000-0000000000a7');
  cur_sort := null;
  cur_id := null;
  paged := '{}';
  loop
    n := 0;
    for page in select * from public.list_tasks('upcoming', 'team', cur_sort, cur_id, 100) loop
      paged := paged || page.id;
      cur_sort := page.sort_at;
      cur_id := page.id;
      n := n + 1;
    end loop;
    exit when n < 100;
  end loop;
  if not exists (select 1 from unnest(paged) p join public.tasks t on t.id = p where t.assignee_id = j) then
    raise exception 'FAIL: an admin''s Team list must show Jo''s tasks';
  end if;
  if (public.count_tasks('team') ->> 'upcoming')::integer < 10 then raise exception 'FAIL: Team counts'; end if;
  perform pg_temp.su();
end $$;

-- update_task and delete_task (task guard and policies; constant errors; a fresh code to delete).
do $$
declare
  j constant uuid := '00000000-0000-0000-0000-0000000000a8';
  i constant uuid := '00000000-0000-0000-0000-0000000000a6';
  jl uuid := current_setting('t.jo_lead')::uuid;
  other uuid := pg_temp.new_lead(i, 'cold', lead_name => 'Ivy''s other lead');
  v_today date := (now() at time zone 'Asia/Karachi')::date;
  t uuid := pg_temp.new_task(jl, j, 'todo', v_today + 1, null, 'To rename');
  m uuid := pg_temp.new_task(jl, j, 'meeting', null, now() + interval '2 days', 'Meeting');
  jc uuid := pg_temp.new_contact(jl);
  oc uuid := pg_temp.new_contact(other);
  r jsonb;
begin
  perform pg_temp.act(j);
  r := public.update_task(t, '  Renamed  ', v_today + 5, null, null, jc);
  if r ->> 'title' <> 'Renamed' or (r ->> 'due_date')::date <> v_today + 5 or (r ->> 'assignee_id')::uuid <> j
     or (r ->> 'contact_id')::uuid <> jc or r ->> 'due_at' is not null then
    raise exception 'FAIL: update_task: %', r;
  end if;
  perform pg_temp.expect_error(format('select public.update_task(%L, %L, null, null, null, null)', t,
                                      repeat('x', 300) || 'MARKER-TITLE'), '22023', 'task_title', 'MARKER-TITLE');
  perform pg_temp.expect_error(format('select public.update_task(%L, %L, null, null, null, null)', t,
                                      E'bad‮title MARKER-BIDI'), '22023', 'task_title', 'MARKER-BIDI');
  perform pg_temp.expect_error(format('select public.update_task(%L, %L, null, null, %L, null)', t, 'x', i), '42501');
  perform pg_temp.expect_error(format('select public.update_task(%L, %L, null, null, null, %L)', t, 'x', oc), 'P0002');
  perform pg_temp.expect_error(format('select public.update_task(%L, %L, %L, null, null, null)', m, 'Meet', v_today + 2),
                               '22023', 'task_due');
  perform pg_temp.expect_error(format('select public.update_task(%L, %L, null, null, null, null)', gen_random_uuid(), 'x'),
                               'P0002');
  -- Ivy does not see Jo's task: it is not there for her.
  perform pg_temp.act(i);
  perform pg_temp.expect_error(format('select public.update_task(%L, %L, null, null, null, null)', t, 'x'), 'P0002');
  perform pg_temp.expect_error(format('select public.delete_task(%L)', t), 'P0002');
  -- delete_needs_code: a code older than 10 minutes is refused first (hint step_up), then the delete goes through.
  perform pg_temp.act(j, 'aal2', 3600);
  perform pg_temp.expect_error(format('select public.delete_task(%L)', t), '42501', 'step_up');
  perform pg_temp.act(j);
  perform public.delete_task(t);
  perform pg_temp.expect_error(format('select public.delete_task(%L)', t), 'P0002');
  perform pg_temp.su();
  if exists (select 1 from public.tasks where id = t) then raise exception 'FAIL: delete_task'; end if;
  delete from public.companies where id = other;
end $$;

-- 14. The person's time zone (threat 19: profile_timezone_garbage_refused, constant message).
do $$
declare
  j constant uuid := '00000000-0000-0000-0000-0000000000a8';
begin
  perform pg_temp.act(j);
  perform pg_temp.expect_error($q$select public.set_my_timezone('Mars/MARKER-ZONE')$q$, '22023', 'timezone', 'MARKER-ZONE');
  perform pg_temp.expect_error('select public.set_my_timezone(null)', '22023', 'timezone');
  perform pg_temp.expect_error(format('select public.set_my_timezone(%L)', repeat('A', 65)), '22023', 'timezone');
  perform pg_temp.expect_error(format('update public.profiles set timezone = %L where id = %L', 'Nowhere/MARKER-DIRECT', j),
                               '22023', 'timezone', 'MARKER-DIRECT');
  if public.set_my_timezone('Asia/Karachi') <> '{"timezone": "Asia/Karachi"}'::jsonb
     or private.caller_zone() <> 'Asia/Karachi' then
    raise exception 'FAIL: set_my_timezone';
  end if;
  update public.profiles set timezone = 'Europe/Paris' where id = j;   -- a direct update with a real zone is fine
  update public.profiles set first_name = 'Jo' where id = j;           -- other changes are not checked
  perform pg_temp.su();
  if (select timezone from public.profiles where id = j) <> 'Europe/Paris' then raise exception 'FAIL: profile zone'; end if;
end $$;

-- 15. Audit (threat 30): an outcome's status change is recorded without the queue facts; claims are never audited.
do $$
declare
  k constant uuid := '00000000-0000-0000-0000-0000000000a7';
  l uuid := pg_temp.new_lead(k, 'cold', lead_name => 'Audit lead');
  d jsonb;
begin
  perform pg_temp.act(k);
  if not public.claim_lead(l) then raise exception 'FAIL: claim for the audit case'; end if;
  perform public.log_activity(l, 'call', 'not_interested', p_from_queue => true);
  perform pg_temp.su();
  select diff_json into d from public.audit_log
   where table_name = 'companies' and record_id = l::text and action = 'update' order by id desc limit 1;
  if d is null or not d ? 'lead_status' or d ? 'queue_rank' or d ? 'call_zone' or d ? 'has_contact_phone'
     or d ? 'next_action_at' or d ? 'updated_at' then
    raise exception 'FAIL: audit_queue_columns_not_diffed: %', d;
  end if;
  if exists (select 1 from public.audit_log where table_name = 'queue_claims')
     or exists (select 1 from public.audit_log where table_name = 'companies' and record_id = l::text and action = 'insert'
                and (diff_json -> 'new' ? 'queue_rank' or diff_json -> 'new' ? 'call_zone')) then
    raise exception 'FAIL: claims or the stored queue facts reached the audit log';
  end if;
  delete from public.companies where id = l;
end $$;

-- 16. Another organisation (threat 2): no lead, claim or task of the main organisation, through any Day 4c function.
do $$
declare
  c1 constant uuid := '00000000-0000-0000-0000-0000000000c1';
  j constant uuid := '00000000-0000-0000-0000-0000000000a8';
  jl uuid := current_setting('t.jo_lead')::uuid;
  t uuid := pg_temp.new_task(current_setting('t.jo_lead')::uuid, j, 'todo', (now() at time zone 'Europe/Paris')::date);
  r jsonb;
  ids uuid[];
begin
  insert into private.queue_claims (company_id, org_id, user_id, expires_at)
  values (jl, current_setting('t.main_org')::uuid, j, now() - interval '1 second');
  perform pg_temp.act(c1);
  r := public.claim_next_lead('team', '{}'::uuid[], '{}', 2, true);
  select coalesce(array_agg((c ->> 'id')::uuid), '{}') into ids from jsonb_array_elements(r -> 'cards') c;
  perform pg_temp.expect_error(format('select public.claim_lead(%L)', jl), 'P0002');
  perform pg_temp.expect_error(format('select public.update_task(%L, %L, null, null, null, null)', t, 'x'), 'P0002');
  perform pg_temp.expect_error(format('select public.delete_task(%L)', t), 'P0002');
  if public.get_lead(jl) is not null
     or exists (select 1 from public.list_tasks('today', 'team', null, null, 100) x where x.id = t)
     or (select count(*) from private.queue_claims where company_id = jl) <> 0 then
    raise exception 'FAIL: another organisation reached a lead, a task or a claim';
  end if;
  delete from private.queue_claims where company_id = jl;   -- expired, but not theirs to clear
  perform public.queue_summary('team');
  perform public.release_claims();
  perform pg_temp.su();
  if exists (select 1 from public.companies where id = any (ids) and org_id = current_setting('t.main_org')::uuid) then
    raise exception 'FAIL: another organisation was served a lead of the main organisation';
  end if;
  if not exists (select 1 from private.queue_claims where company_id = jl) then
    raise exception 'FAIL: another organisation removed an expired claim of the main organisation';
  end if;
  delete from private.queue_claims where company_id = jl;
  delete from public.tasks where id = t;
end $$;

-- 17. The stored facts again, after every case above (call_zone_matches_map is also a Gate 1 check).
do $$ begin perform pg_temp.check_stored_facts(); end $$;
do $$ begin
  if exists (select 1 from private.queue_claims) then raise exception 'FAIL: a case left a claim behind'; end if;
end $$;

\echo 'queue_attack: all checks passed'
