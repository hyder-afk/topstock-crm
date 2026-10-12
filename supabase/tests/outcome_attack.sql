-- Day 4b attack and behaviour tests: the lead page (design docs/evidence/day4/design.md sections 3.2, 4.1, 5.1 to 5.3,
-- 5.5, 6 and 8.1; migration 20261012090000_lead_page.sql). Runs after activity_attack.sql on the same database
-- (scripts/db-test.sh, CI job "rls"), reusing its users: admin a, manager a1, reps b1 and d1, other-org admin c1 (rep e1
-- is left alone: its flood-guard entries are recent). It adds rep g1 (only for the flood guards). Any failure raises an
-- exception and stops the run.
-- Probes run as a signed-in user through the API role (grants, row level security and triggers all apply), except where
-- a comment says the superuser runs a guard or a CHECK on its own. Most cases build their own leads and run inside a
-- block that is rolled back at the end (pg_temp.act switches to the API role with a user's claims and pg_temp.su back),
-- so they never add up against the 60-a-minute flood guards and each starts from a known lead.
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
-- user's text) must appear in neither the message nor the detail: constant errors keep lead data out of the logs.
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
                                 lead_name text default 'Day4b Lead') returns uuid
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
                                 due_time timestamptz default null, task_title text default 'Day4b task') returns uuid
language sql as $$
  insert into public.tasks (org_id, company_id, title, kind, due_date, due_at, assignee_id, created_by)
  select c.org_id, c.id, task_title, task_kind, due, due_time, who, who from public.companies c where c.id = lead
  returning id
$$;
-- The same lead, made as the superuser even while the API role is active (for one-statement cases).
create function pg_temp.new_lead_as_su(owner uuid) returns uuid
language plpgsql as $$
declare
  claims text := current_setting('request.jwt.claims', true);
  l uuid;
begin
  execute 'reset role';
  perform set_config('request.jwt.claims', '', false);
  l := pg_temp.new_lead(owner);
  perform set_config('role', 'authenticated', false);
  perform set_config('request.jwt.claims', coalesce(claims, ''), false);
  return l;
end;
$$;
-- Moves an entry's time back (superuser; the server-time trigger is off for the one statement).
create function pg_temp.age_entry(entry uuid, seconds integer) returns void
language plpgsql as $$
declare
  claims text := current_setting('request.jwt.claims', true);
begin
  perform set_config('request.jwt.claims', '', false);
  alter table public.activities disable trigger set_activity_time;
  update public.activities set created_at = now() - make_interval(secs => seconds) where id = entry;
  alter table public.activities enable trigger set_activity_time;
  perform set_config('request.jwt.claims', coalesce(claims, ''), false);
end;
$$;

-- Fixtures ------------------------------------------------------------------------------------------------------------
do $$ begin perform set_config('request.jwt.claims', '', false); end $$;
insert into auth.users (id, email, raw_user_meta_data) values
  ('00000000-0000-0000-0000-0000000000a9', 'repg@test.invalid', '{"first_name":"Gus"}');
do $$ begin
  if (select role from public.profiles where id = '00000000-0000-0000-0000-0000000000a9') <> 'rep' then
    raise exception 'FAIL: the new fixture user should be a rep';
  end if;
end $$;

-- 0. What the database itself says: grants, functions, policies, the zone map ----------------------------------------
do $$
declare
  cols text[];
  f record;
  bad text[];
  zone text;
  zones text[] := '{}';
  code text;
begin
  -- Lead columns (threat 7): the three new ones are updatable by lead editors (RLS), never insertable.
  select array_agg(attname::text order by attname) into cols from pg_attribute
   where attrelid = 'public.companies'::regclass and attnum > 0 and not attisdropped
     and has_column_privilege('authenticated', attrelid, attname, 'UPDATE');
  if cols is distinct from array['city', 'country', 'email', 'industry', 'lead_status', 'name', 'next_action_at',
                                 'owner_id', 'phone', 'phone_wrong_at', 'timezone', 'website'] then
    raise exception 'FAIL: lead update columns are %', cols;
  end if;
  if has_column_privilege('authenticated', 'public.companies', 'timezone', 'INSERT')
     or has_column_privilege('authenticated', 'public.companies', 'next_action_at', 'INSERT')
     or has_column_privilege('authenticated', 'public.companies', 'phone_wrong_at', 'INSERT')
     or has_column_privilege('authenticated', 'public.contacts', 'phone_wrong_at', 'INSERT')
     or not has_column_privilege('authenticated', 'public.contacts', 'phone_wrong_at', 'UPDATE')
     or has_column_privilege('anon', 'public.companies', 'timezone', 'UPDATE') then
    raise exception 'FAIL: grants on the new lead and contact columns';
  end if;
  -- Undo records: private, row level security on, exactly two policies, no update grant, nothing for anon.
  if not (select relrowsecurity from pg_class where oid = 'private.activity_undo'::regclass)
     or (select array_agg(policyname::text order by policyname) from pg_policies
          where schemaname = 'private' and tablename = 'activity_undo') is distinct from array['require_mfa', 'undo_own']
     or not has_table_privilege('authenticated', 'private.activity_undo', 'SELECT')
     or not has_table_privilege('authenticated', 'private.activity_undo', 'INSERT')
     or not has_table_privilege('authenticated', 'private.activity_undo', 'DELETE')
     or has_table_privilege('authenticated', 'private.activity_undo', 'UPDATE')
     or has_table_privilege('anon', 'private.activity_undo', 'SELECT') then
    raise exception 'FAIL: private.activity_undo protections';
  end if;
  -- Every new RPC: SECURITY INVOKER, search_path '', callable by signed-in people only, static SQL (no EXECUTE or
  -- format() in its body).
  for f in select p.oid, p.oid::regprocedure::text as sig, p.prosecdef, p.proconfig, p.prosrc
             from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'public' and p.proname in ('get_lead', 'list_lead_activities', 'get_activity', 'log_activity',
                  'undo_activity', 'edit_activity', 'delete_activity', 'set_lead_timezone', 'set_lead_next_action',
                  'create_task', 'set_task_done', 'set_task_cancelled', 'list_lead_tasks', 'bulk_update_leads') loop
    if f.prosecdef or not (f.proconfig @> array['search_path=""'])
       or not has_function_privilege('authenticated', f.oid, 'EXECUTE')
       or has_function_privilege('anon', f.oid, 'EXECUTE') or has_function_privilege('public', f.oid, 'EXECUTE')
       or f.prosrc ~* '\mexecute\M' or f.prosrc ~* 'format\s*\(' then
      bad := bad || f.sig;
    end if;
  end loop;
  if bad is not null then raise exception 'FAIL: RPC rules broken by %', bad; end if;
  if (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.proname = 'bulk_update_leads') <> 1 then
    raise exception 'FAIL: the old bulk_update_leads is still there';
  end if;
  -- Trigger functions are never callable; the helpers the RPCs use are (private has no API endpoint).
  if has_function_privilege('authenticated', 'private.lead_guard()', 'EXECUTE')
     or has_function_privilege('authenticated', 'private.contact_guard()', 'EXECUTE')
     or (select prosecdef from pg_proc where oid = 'private.lead_guard()'::regprocedure)
     or (select prosecdef from pg_proc where oid = 'private.contact_guard()'::regprocedure) then
    raise exception 'FAIL: the Day 4b guards must be INVOKER trigger functions nobody can call';
  end if;
  foreach code in array array['private.country_call_zone(text)', 'private.country_zone_choices(text)',
      'private.span_zones(text)', 'private.zone_fits_country(text,text)', 'private.lead_call_zone(text,text)',
      'private.next_working_day(timestamptz,integer,text)', 'private.call_attempts(uuid)', 'private.caller_zone()',
      'private.logged_activity(uuid,boolean)'] loop
    if not has_function_privilege('authenticated', code::regprocedure, 'EXECUTE')
       or has_function_privilege('anon', code::regprocedure, 'EXECUTE')
       or (select prosecdef from pg_proc where oid = code::regprocedure) then
      raise exception 'FAIL: helper % must be INVOKER and callable by signed-in people only', code;
    end if;
  end loop;
  if (select tgtype & 2 = 2 and tgenabled = 'O' from pg_trigger where tgname = 'lead_guard' and tgrelid = 'public.companies'::regclass)
       is not true
     or (select tgtype & 2 = 2 from pg_trigger where tgname = 'contact_guard' and tgrelid = 'public.contacts'::regclass) is not true
     or not exists (select 1 from pg_constraint where conname = 'companies_timezone_fits' and contype = 'c') then
    raise exception 'FAIL: lead_guard, contact_guard (BEFORE) and the time zone CHECK must exist';
  end if;
  -- zone_map_zones_exist: every zone the map can hand out is one PostgreSQL knows (all 676 two-letter codes tried).
  for code in select chr(65 + i / 26) || chr(65 + i % 26) from generate_series(0, 675) i loop
    zone := private.country_call_zone(code);
    if zone is not null and zone !~ '^[A-Z]{2}$' then zones := zones || zone; end if;
    zones := zones || coalesce(private.country_zone_choices(code), '{}') || coalesce(private.span_zones(code), '{}');
  end loop;
  if cardinality(zones) < 250 then raise exception 'FAIL: the zone map looks empty (% zones)', cardinality(zones); end if;
  select array_agg(z) into bad from unnest(zones) z where not exists (select 1 from pg_timezone_names t where t.name = z);
  if bad is not null then raise exception 'FAIL: zones PostgreSQL does not know: %', bad; end if;
end $$;


-- 1. anon and a session without two-factor (aal1) see and change nothing (threat 1) ---------------------------------
set role anon;
do $$ begin perform set_config('request.jwt.claims', '{"role":"anon"}', false); end $$;
do $$
declare stmt text;
begin
  -- Inline, not through the helpers: anon may not run the session's temporary functions on every image.
  foreach stmt in array array[
    'select public.get_lead(gen_random_uuid())', 'select public.get_activity(gen_random_uuid())',
    'select * from public.list_lead_activities(gen_random_uuid())', 'select * from public.list_lead_tasks(gen_random_uuid())',
    $q$select public.log_activity(gen_random_uuid(), 'note', null, 'x')$q$, 'select public.undo_activity(gen_random_uuid())',
    $q$select public.edit_activity(gen_random_uuid(), 'x')$q$, 'select public.delete_activity(gen_random_uuid())',
    $q$select public.set_lead_timezone(gen_random_uuid(), null)$q$, 'select public.set_lead_next_action(gen_random_uuid(), null)',
    $q$select public.create_task('x')$q$, 'select public.set_task_done(gen_random_uuid(), true)',
    'select public.set_task_cancelled(gen_random_uuid(), true)',
    $q$select public.bulk_update_leads(array[gen_random_uuid()], 'cold')$q$,
    'select count(*) from private.activity_undo'] loop
    begin
      execute stmt;
      raise exception 'FAIL: anon ran %', stmt;
    exception when insufficient_privilege then null;
    end;
  end loop;
end $$;
reset role;

-- A lead and an entry made by the admin, for the aal1 probes.
do $$
declare l uuid := pg_temp.new_lead('00000000-0000-0000-0000-0000000000d1', lead_name => 'Day4b aal1 lead');
begin
  perform set_config('t.aal1_lead', l::text, false);
  perform set_config('t.main_org', (select id::text from public.orgs where name = 'TopStock Wholesale'), false);
  perform pg_temp.act('00000000-0000-0000-0000-00000000000a');
  perform set_config('t.aal1_entry', (public.log_activity(l, 'note', null, 'aal1 probe') ->> 'activity_id'), false);
  perform pg_temp.su();
end $$;
set role authenticated;
do $$ begin perform pg_temp.as_user('00000000-0000-0000-0000-00000000000a', 'aal1', 30); end $$;
do $$
declare
  l constant text := quote_literal(current_setting('t.aal1_lead'));
  e constant text := quote_literal(current_setting('t.aal1_entry'));
  stmt text;
begin
  -- day4_aal1_blocked: every writing RPC (and the plpgsql reads) answers 42501; the SQL reads answer nothing.
  foreach stmt in array array[
    format('select public.log_activity(%s, %L, null, %L)', l, 'note', 'x'), format('select public.undo_activity(%s)', e),
    format('select public.edit_activity(%s, %L)', e, 'x'), format('select public.delete_activity(%s)', e),
    format('select public.set_lead_timezone(%s, null)', l), format('select public.set_lead_next_action(%s, null)', l),
    format('select public.create_task(%L, %s)', 'x', l), format('select public.set_task_done(%s, true)', e),
    format('select public.set_task_cancelled(%s, true)', e),
    format('select * from public.list_lead_activities(%s)', l), format('select * from public.list_lead_tasks(%s)', l)] loop
    perform pg_temp.expect_error(stmt, '42501');
  end loop;
  if public.get_lead(current_setting('t.aal1_lead')::uuid) is not null
     or public.get_activity(current_setting('t.aal1_entry')::uuid) is not null
     or (select count(*) from private.activity_undo) <> 0 then
    raise exception 'FAIL: an aal1 session read a lead, an entry or an undo record';
  end if;
  perform pg_temp.expect_error(format('insert into private.activity_undo (activity_id, org_id, user_id) values (%s, %L, %L)',
                                      e, current_setting('t.main_org'), '00000000-0000-0000-0000-00000000000a'), '42501');
  -- bulk_update_leads keeps Day 3a's behaviour: row level security leaves it nothing to change.
  if public.bulk_update_leads(array[current_setting('t.aal1_lead')::uuid], 'warm') <> 0 then
    raise exception 'FAIL: an aal1 session changed a lead in bulk';
  end if;
end $$;
reset role;
do $$ begin
  if (select lead_status from public.companies where id = current_setting('t.aal1_lead')::uuid) <> 'cold' then
    raise exception 'FAIL: an aal1 session changed a lead';
  end if;
end $$;

-- 2. The zone map and the lead's calling zone (design 5.1, threat 19) -------------------------------------------------
do $$
begin
  if private.country_call_zone('FR') <> 'Europe/Paris' or private.country_call_zone('GB') <> 'Europe/London'
     or private.country_call_zone('ES') <> 'Europe/Madrid' or private.country_call_zone('DE') <> 'Europe/Berlin'
     or private.country_call_zone('PK') <> 'Asia/Karachi' or private.country_call_zone('RU') <> 'Europe/Moscow'
     or private.country_call_zone('US') <> 'US' or private.country_call_zone('CA') <> 'CA'
     or private.country_call_zone('AU') <> 'AU' or private.country_call_zone('ID') <> 'ID'
     or private.country_call_zone('AQ') is not null or private.country_call_zone(null) is not null
     or private.country_call_zone('ZZ') is not null then
    raise exception 'FAIL: country_call_zone';
  end if;
  if private.lead_call_zone(null, 'US') <> 'US' or private.lead_call_zone('America/Chicago', 'US') <> 'America/Chicago'
     or private.lead_call_zone(null, null) <> 'Europe/Paris' or private.lead_call_zone(null, 'AQ') <> 'Europe/Paris'
     or private.lead_call_zone(null, 'BE') <> 'Europe/Brussels' then
    raise exception 'FAIL: lead_call_zone';
  end if;
  if not private.zone_fits_country('America/Chicago', 'US') or not private.zone_fits_country('Atlantic/Canary', 'ES')
     or private.zone_fits_country('Europe/Paris', 'US') or private.zone_fits_country('Europe/Paris', 'FR')
     or private.zone_fits_country(null, 'US') or private.zone_fits_country('America/Chicago', null)
     or private.zone_fits_country('America/Toronto', 'US') then
    raise exception 'FAIL: zone_fits_country (a closed list per country with several zones)';
  end if;
  if private.span_zones('US') <> array['America/New_York', 'America/Los_Angeles']
     or private.span_zones('ID') <> array['Asia/Jayapura', 'Asia/Jakarta'] or private.span_zones('Europe/Paris') is not null then
    raise exception 'FAIL: span_zones';
  end if;
end $$;

do $$
declare
  us uuid := pg_temp.new_lead('00000000-0000-0000-0000-0000000000d1', country => 'US', phone => '(212) 555-0149',
                              lead_name => 'Day4b US lead');
  fr uuid := pg_temp.new_lead('00000000-0000-0000-0000-0000000000d1', lead_name => 'Day4b FR lead');
  r jsonb;
  g jsonb;
begin
  -- An editor picks a zone for a US lead; get_lead says where it is called and that the zone can be set.
  perform pg_temp.act('00000000-0000-0000-0000-0000000000d1');
  g := public.get_lead(us);
  if g ->> 'call_zone_key' <> 'US' or not (g ->> 'can_set_timezone')::boolean or g ->> 'timezone' is not null then
    raise exception 'FAIL: get_lead zone fields before a pick %', g;
  end if;
  r := public.set_lead_timezone(us, 'America/Chicago');
  if r ->> 'timezone' <> 'America/Chicago' or r ->> 'call_zone_key' is distinct from r ->> 'timezone'
     or public.get_lead(us) ->> 'call_zone_key' <> 'America/Chicago' then
    raise exception 'FAIL: set_lead_timezone %', r;
  end if;
  g := public.get_lead(fr);
  if g ->> 'call_zone_key' <> 'Europe/Paris' or (g ->> 'can_set_timezone')::boolean then
    raise exception 'FAIL: a French lead has one zone and nothing to pick %', g;
  end if;
  -- timezone_outside_country_refused: through the RPC and directly (the guard), with a constant error.
  perform pg_temp.expect_error(format('select public.set_lead_timezone(%L, %L)', us, 'Europe/Paris'), '22023', 'zone_not_in_country');
  perform pg_temp.expect_error(format('select public.set_lead_timezone(%L, %L)', fr, 'Europe/Paris'), '22023', 'zone_not_in_country');
  perform pg_temp.expect_error(format('update public.companies set timezone = %L where id = %L', 'America/Toronto', us),
                               '22023', 'zone_not_in_country');
  -- timezone_bad_constant_error: a planted value never reaches the message or the detail.
  perform pg_temp.expect_error(format('select public.set_lead_timezone(%L, %L)', us, 'Zz/PLANTED-7731'),
                               '22023', 'zone_not_in_country', 'PLANTED-7731');
  perform pg_temp.expect_error(format('update public.companies set timezone = %L where id = %L', 'Zz/PLANTED-7732', us),
                               '22023', 'zone_not_in_country', 'PLANTED-7732');
  -- country_change_clears_zone: a new country drops the picked zone, unless the same statement picks one that fits it.
  update public.companies set country = 'CA' where id = us;
  if (select timezone from public.companies where id = us) is not null then
    raise exception 'FAIL: a country change kept the picked zone';
  end if;
  update public.companies set country = 'US', timezone = 'America/Denver' where id = us;
  if (select timezone from public.companies where id = us) <> 'America/Denver' then
    raise exception 'FAIL: a zone picked with the new country should stay';
  end if;
  perform pg_temp.expect_error(format('update public.companies set country = %L, timezone = %L where id = %L', 'CA',
                                      'America/Chicago', us), '22023', 'zone_not_in_country');
  -- Day 3a's edit form (update_lead sends every field) changing the country clears it too.
  perform public.update_lead(us, 'Day4b US lead', '00000000-0000-0000-0000-0000000000d1', 'cold', '(212) 555-0149', null,
                             null, 'MX');
  if (select timezone from public.companies where id = us) is not null
     or public.get_lead(us) ->> 'call_zone_key' <> 'MX' then
    raise exception 'FAIL: update_lead changing the country should clear the zone';
  end if;
  update public.companies set timezone = 'America/Tijuana' where id = us;
  perform public.set_lead_timezone(us, null);
  if public.get_lead(us) ->> 'call_zone_key' <> 'MX' then raise exception 'FAIL: clearing the zone'; end if;
  -- A rep who may not change the lead: no pick, and get_lead says so.
  perform pg_temp.act('00000000-0000-0000-0000-0000000000b1');
  if (public.get_lead(us) ->> 'can_set_timezone')::boolean then raise exception 'FAIL: a non-editor may set the zone'; end if;
  perform pg_temp.expect_error(format('select public.set_lead_timezone(%L, %L)', us, 'America/Tijuana'), '42501');
  perform pg_temp.expect_error(format('select public.set_lead_timezone(%L, %L)', gen_random_uuid(), 'America/Tijuana'), 'P0002');
  perform pg_temp.su();
  -- The CHECK behind the guard (superuser, lead_guard off): it exists, and only as a backstop.
  begin
    alter table public.companies disable trigger lead_guard;
    perform pg_temp.expect_error(format('update public.companies set timezone = %L where id = %L', 'Europe/Paris', fr), '23514');
    raise exception 'undo' using errcode = 'TS001';
  exception when sqlstate 'TS001' then null;
  end;
  -- The zone rule holds for the superuser too (the guard's rules 1 and 2 are not limited to people).
  perform pg_temp.expect_error(format('update public.companies set timezone = %L where id = %L', 'Europe/Paris', fr),
                               '22023', 'zone_not_in_country');
end $$;

-- 3. next_working_day: 09:00 on the Nth weekday after, in the key's zone (a span: its eastern end), across DST --------
-- The cases between the markers are shared with the browser's copy (tests/unit/next-working-day.spec.ts, Day 4b app).
-- Columns: instant (UTC), working days, zone or span key, expected instant (UTC).
-- next-working-day:start
create temporary table nwd_cases (at_utc timestamptz, days integer, zone_key text, expected timestamptz);
insert into nwd_cases values
  ('2026-10-09 15:30+00', 1, 'Europe/Paris', '2026-10-12 07:00+00'),         -- Friday 17:30 Paris: Monday 09:00
  ('2026-10-09 15:30+00', 2, 'Europe/Paris', '2026-10-13 07:00+00'),         -- two working days: Tuesday
  ('2026-10-10 10:00+00', 1, 'Europe/Paris', '2026-10-12 07:00+00'),         -- Saturday: Monday
  ('2026-10-11 21:30+00', 1, 'Europe/Paris', '2026-10-12 07:00+00'),         -- Sunday 23:30 Paris: Monday
  ('2026-10-12 06:00+00', 1, 'Europe/Paris', '2026-10-13 07:00+00'),         -- Monday 08:00 Paris: Tuesday, not today
  ('2026-10-23 15:30+00', 1, 'Europe/Paris', '2026-10-26 08:00+00'),         -- summer time ends Sunday 25 Oct
  ('2026-10-22 12:00+00', 2, 'Europe/Paris', '2026-10-26 08:00+00'),         -- Thursday + 2 across the change
  ('2026-10-23 16:00+00', 1, 'Europe/London', '2026-10-26 09:00+00'),        -- London leaves BST the same night
  ('2026-10-28 15:00+00', 1, 'US', '2026-10-29 13:00+00'),                   -- US span: New York, still EDT
  ('2026-10-30 20:00+00', 1, 'US', '2026-11-02 14:00+00'),                   -- New York leaves EDT on 1 Nov
  ('2026-10-30 20:00+00', 1, 'America/Los_Angeles', '2026-11-02 17:00+00'),  -- a picked western zone
  ('2026-03-27 12:00+00', 1, 'Europe/Paris', '2026-03-30 07:00+00'),         -- summer time starts Sunday 29 Mar
  ('2026-03-06 18:00+00', 1, 'America/New_York', '2026-03-09 13:00+00'),     -- US summer time starts Sunday 8 Mar
  ('2026-10-12 23:30+00', 1, 'Asia/Karachi', '2026-10-14 04:00+00'),         -- already Tuesday in Karachi
  ('2026-10-09 10:00+00', 1, 'ID', '2026-10-12 00:00+00'),                   -- Indonesia span: eastern end Jayapura
  ('2026-10-08 22:00+00', 1, 'AU', '2026-10-11 22:00+00'),                   -- Australia span: Sydney (AEDT)
  ('2026-10-12 10:00+00', 10, 'Europe/Paris', '2026-10-26 08:00+00');        -- ten working days
-- next-working-day:end
do $$
declare
  c record;
  got timestamptz;
begin
  for c in select * from nwd_cases loop
    got := private.next_working_day(c.at_utc, c.days, c.zone_key);
    if got <> c.expected then
      raise exception 'FAIL: next_working_day(%, %, %) = %, expected %', c.at_utc, c.days, c.zone_key, got, c.expected;
    end if;
  end loop;
  perform pg_temp.expect_error($q$select private.next_working_day(now(), 0, 'Europe/Paris')$q$, '22023', 'bounds');
  perform pg_temp.expect_error($q$select private.next_working_day(now(), 11, 'Europe/Paris')$q$, '22023', 'bounds');
  perform pg_temp.expect_error($q$select private.next_working_day(now(), 1, null)$q$, '22023', 'bounds');
end $$;

-- 4. The outcome table (design 5.5): 8 outcomes x 4 starting statuses, each logged by the admin on a lead rep d1 owns,
-- then undone (design 5.3). Every case starts from the same lead: FR main line, next call in 3 days, no entries, and
-- three open tasks: the admin's call task due yesterday, the admin's call task due in 10 days, d1's to-do.
do $$
declare
  admin constant uuid := '00000000-0000-0000-0000-00000000000a';
  d1 constant uuid := '00000000-0000-0000-0000-0000000000d1';
  c record;
  l uuid;
  t_due uuid;
  t_future uuid;
  t_other uuid;
  r jsonb;
  u jsonb;
  act record;
  lead record;
  task record;
  undo record;
  today constant date := (now() at time zone 'Europe/Paris')::date;   -- the admin's zone (profile default)
  follow_date constant date := (now() at time zone 'UTC')::date + 2;
  meeting_at constant timestamptz := date_trunc('minute', now()) + interval '3 days 2 hours';
  v0 constant timestamptz := date_trunc('second', now()) + interval '3 days';
  want_next timestamptz;
  want_done jsonb;
  want_gone jsonb;
  want_task jsonb;
  cases integer := 0;
begin
  for c in select * from (values
      ('no_answer', 'cold', 'cold'), ('no_answer', 'warm', 'warm'), ('no_answer', 'negotiation', 'negotiation'),
      ('no_answer', 'cool_off', 'cool_off'),
      ('voicemail', 'cold', 'cold'), ('voicemail', 'warm', 'warm'), ('voicemail', 'negotiation', 'negotiation'),
      ('voicemail', 'cool_off', 'cool_off'),
      ('wrong_number', 'cold', 'cold'), ('wrong_number', 'warm', 'warm'), ('wrong_number', 'negotiation', 'negotiation'),
      ('wrong_number', 'cool_off', 'cool_off'),
      ('not_interested', 'cold', 'cool_off'), ('not_interested', 'warm', 'cool_off'),
      ('not_interested', 'negotiation', 'negotiation'), ('not_interested', 'cool_off', 'cool_off'),
      ('interested', 'cold', 'warm'), ('interested', 'warm', 'warm'), ('interested', 'negotiation', 'negotiation'),
      ('interested', 'cool_off', 'warm'),
      ('meeting_booked', 'cold', 'warm'), ('meeting_booked', 'warm', 'warm'),
      ('meeting_booked', 'negotiation', 'negotiation'), ('meeting_booked', 'cool_off', 'warm'),
      ('do_not_contact', 'cold', 'do_not_contact'), ('do_not_contact', 'warm', 'do_not_contact'),
      ('do_not_contact', 'negotiation', 'do_not_contact'), ('do_not_contact', 'cool_off', 'do_not_contact'),
      ('connected', 'cold', 'cold'), ('connected', 'warm', 'warm'), ('connected', 'negotiation', 'negotiation'),
      ('connected', 'cool_off', 'cool_off')) as x (outcome, start_status, want_status) loop
    begin
      l := pg_temp.new_lead(d1, c.start_status, v0);
      t_due := pg_temp.new_task(l, admin, 'call', today - 1);
      t_future := pg_temp.new_task(l, admin, 'call', today + 10);
      t_other := pg_temp.new_task(l, d1, 'todo');
      perform pg_temp.act(admin);
      r := public.log_activity(l, 'call', c.outcome, 'Fake call note', null,
                               case when c.outcome = 'wrong_number' then 'lead' end,
                               case when c.outcome = 'interested' then follow_date end,
                               case when c.outcome = 'meeting_booked' then meeting_at end,
                               case when c.outcome in ('interested', 'meeting_booked', 'wrong_number')
                                    then 'Follow up with Day4b Lead' end);
      perform pg_temp.su();
      select * into act from public.activities where id = (r ->> 'activity_id')::uuid;
      select * into lead from public.companies where id = l;
      select * into undo from private.activity_undo where activity_id = act.id;
      want_next := case c.outcome
        when 'no_answer' then private.next_working_day(now(), 1, 'Europe/Paris')
        when 'voicemail' then private.next_working_day(now(), 2, 'Europe/Paris')
        when 'wrong_number' then v0
        when 'not_interested' then now() + interval '90 days'
        when 'interested' then ((follow_date + 1) + time '09:00') at time zone 'Europe/Paris'
        when 'meeting_booked' then meeting_at + interval '1 day'
        when 'do_not_contact' then null
        when 'connected' then now() + interval '30 days' end;
      if act.id is null or act.type <> 'call' or act.outcome <> c.outcome or act.user_id <> admin
         or act.body <> 'Fake call note' or act.created_at <> now() then
        raise exception 'FAIL: % on %: the entry %', c.outcome, c.start_status, row_to_json(act);
      end if;
      if lead.lead_status <> c.want_status or lead.next_action_at is distinct from want_next or lead.owner_id <> d1
         or lead.last_activity_at <> act.created_at
         or r ->> 'status_before' <> c.start_status or r ->> 'status_after' <> c.want_status
         or not (r ->> 'editable')::boolean or (r ->> 'replayed')::boolean or (r ->> 'owner_changed')::boolean
         or (r ->> 'next_action_at')::timestamptz is distinct from want_next
         or (r ->> 'undo_until')::timestamptz <> act.created_at + interval '120 seconds' then
        raise exception 'FAIL: % on %: lead (%, %), answer %', c.outcome, c.start_status, lead.lead_status,
          lead.next_action_at, r;
      end if;
      if (lead.phone_wrong_at is not null) <> (c.outcome = 'wrong_number')
         or (c.outcome = 'wrong_number' and (lead.phone_wrong_at <> act.created_at
                                             or not (r ->> 'wrong_number_marked')::boolean or not undo.wrong_company)) then
        raise exception 'FAIL: % on %: the wrong-number mark %', c.outcome, c.start_status, lead.phone_wrong_at;
      end if;
      -- Tasks: the due call task is completed by every call; the future one only by Not interested; Do not contact
      -- dismisses the rest (the admin may change every task).
      select * into task from public.tasks where id = t_due;
      if task.done_at is distinct from act.created_at or task.completed_by is distinct from admin then
        raise exception 'FAIL: % on %: the due call task was not completed', c.outcome, c.start_status;
      end if;
      select * into task from public.tasks where id = t_future;
      if (task.done_at is not null) <> (c.outcome = 'not_interested')
         or (task.cancelled_at is not null) <> (c.outcome = 'do_not_contact') then
        raise exception 'FAIL: % on %: the future call task (done %, dismissed %)', c.outcome, c.start_status,
          task.done_at, task.cancelled_at;
      end if;
      select * into task from public.tasks where id = t_other;
      if (task.cancelled_at is not null) <> (c.outcome = 'do_not_contact') or task.done_at is not null then
        raise exception 'FAIL: % on %: the colleague''s to-do', c.outcome, c.start_status;
      end if;
      want_done := (select jsonb_agg(x order by x) from unnest(array[t_due] || case when c.outcome = 'not_interested'
                                                                                   then array[t_future] end) x);
      want_gone := coalesce((select jsonb_agg(x order by x) from unnest(case when c.outcome = 'do_not_contact'
                                                                              then array[t_future, t_other] end) x), '[]');
      if r -> 'completed_task_ids' <> want_done or r -> 'cancelled_task_ids' <> want_gone then
        raise exception 'FAIL: % on %: task lists in the answer %', c.outcome, c.start_status, r;
      end if;
      -- The task this outcome makes.
      select * into task from public.tasks where source_activity_id = act.id;
      if c.outcome in ('interested', 'meeting_booked', 'wrong_number') then
        -- After a wrong number with no other number: a to-do for today, for the owner (the admin may assign it).
        want_task := jsonb_build_object(
          'kind', (case c.outcome when 'interested' then 'call' when 'meeting_booked' then 'meeting' else 'todo' end),
          'due_date', (case c.outcome when 'interested' then follow_date when 'wrong_number' then today end),
          'due_at', (case when c.outcome = 'meeting_booked' then meeting_at end),
          'assignee_id', (case when c.outcome = 'wrong_number' then d1 else admin end));
        if task.id is null or (r ->> 'task_id')::uuid <> task.id or task.title <> 'Follow up with Day4b Lead'
           or jsonb_build_object('kind', task.kind, 'due_date', task.due_date, 'due_at', task.due_at,
                                 'assignee_id', task.assignee_id) <> want_task
           or task.created_by <> admin or task.company_id <> l then
          raise exception 'FAIL: % on %: the task made %', c.outcome, c.start_status, row_to_json(task);
        end if;
      elsif task.id is not null or r ->> 'task_id' is not null then
        raise exception 'FAIL: % on %: made a task', c.outcome, c.start_status;
      end if;
      if undo.prev_status <> c.start_status or undo.new_status <> c.want_status or undo.prev_next_action_at <> v0
         or undo.new_next_action_at is distinct from want_next or undo.user_id <> admin or undo.owner_changed then
        raise exception 'FAIL: % on %: the undo record %', c.outcome, c.start_status, row_to_json(undo);
      end if;

      -- Undo puts everything back, with no fresh code (the usual case: the entry and the task it made go through the
      -- no-code delete branches, which open once the undo record is consumed).
      perform pg_temp.act(admin, 'aal2', null);
      u := public.undo_activity(act.id);
      perform pg_temp.su();
      select * into lead from public.companies where id = l;
      if lead.lead_status <> c.start_status or lead.next_action_at <> v0 or lead.phone_wrong_at is not null
         or lead.owner_id <> d1 or lead.last_activity_at is not null
         or exists (select 1 from public.activities where id = act.id)
         or exists (select 1 from private.activity_undo where activity_id = act.id)
         or exists (select 1 from public.tasks where source_activity_id = act.id or id = (r ->> 'task_id')::uuid)
         or exists (select 1 from public.tasks where id in (t_due, t_future, t_other)
                      and (done_at is not null or completed_by is not null or cancelled_at is not null))
         or (u -> 'restored' ->> 'status')::boolean <> (c.want_status <> c.start_status)
         or (u -> 'restored' ->> 'next_action_at')::boolean <> (want_next is distinct from v0)
         or (u -> 'restored' ->> 'phone_wrong')::boolean <> (c.outcome = 'wrong_number')
         or (u ->> 'task_deleted')::boolean <> (c.outcome in ('interested', 'meeting_booked', 'wrong_number'))
         or (u ->> 'tasks_reopened')::integer <> (case c.outcome when 'not_interested' then 2 when 'do_not_contact' then 3
                                                                 else 1 end) then
        raise exception 'FAIL: undo of % on %: lead (%, %, %), answer %', c.outcome, c.start_status, lead.lead_status,
          lead.next_action_at, lead.last_activity_at, u;
      end if;
      raise exception 'undo' using errcode = 'TS001';
    exception when sqlstate 'TS001' then null;
    end;
    cases := cases + 1;
  end loop;
  if cases <> 32 then raise exception 'FAIL: the outcome table ran % cases', cases; end if;
end $$;

-- 5. More outcome rules ------------------------------------------------------------------------------------------------
-- 5a. The 6th call in a row without reaching anyone: cold or warm go to Cool off, and the lead rests 30 days (design
-- 5.5; open question 2). Only no answer and voicemail count; a note in between does not break the run, Spoke does.
do $$
declare
  admin constant uuid := '00000000-0000-0000-0000-00000000000a';
  c record;
  l uuid;
  r jsonb;
  i integer;
  lead record;
  want_next timestamptz;
  cases integer := 0;
begin
  for c in select * from (values
      (array['no_answer', 'voicemail', 'no_answer', 'no_answer', 'voicemail'], 'cold', 'no_answer', 'cool_off', 5),
      (array['no_answer', 'voicemail', 'no_answer', 'no_answer', 'voicemail'], 'warm', 'voicemail', 'cool_off', 5),
      (array['no_answer', 'no_answer', 'no_answer', 'no_answer', 'no_answer'], 'negotiation', 'no_answer', 'negotiation', 5),
      (array['no_answer', 'no_answer', 'no_answer', 'no_answer'], 'cold', 'no_answer', 'cold', 4),
      (array['no_answer', 'no_answer', 'connected', 'no_answer', 'no_answer'], 'cold', 'voicemail', 'cold', 2),
      (array['voicemail', 'no_answer', 'no_answer', 'no_answer', 'no_answer', 'no_answer', 'voicemail'], 'warm',
       'no_answer', 'cool_off', 6)) as x (prior, start_status, outcome, want_status, want_attempts) loop
    begin
      l := pg_temp.new_lead('00000000-0000-0000-0000-0000000000d1', c.start_status, now() - interval '1 day');
      for i in 1 .. cardinality(c.prior) loop
        insert into public.activities (org_id, company_id, type, outcome, user_id, created_at)
        select org_id, l, 'call', c.prior[i], '00000000-0000-0000-0000-0000000000b1',
               now() - make_interval(hours => cardinality(c.prior) - i + 2)
          from public.companies where id = l;
      end loop;
      insert into public.activities (org_id, company_id, type, body, user_id, created_at)
      select org_id, l, 'note', 'Not a call', '00000000-0000-0000-0000-0000000000b1', now() - interval '30 minutes'
        from public.companies where id = l;
      if private.call_attempts(l) <> c.want_attempts then
        raise exception 'FAIL: call_attempts after % is %, expected %', c.prior, private.call_attempts(l), c.want_attempts;
      end if;
      perform pg_temp.act(admin);
      r := public.log_activity(l, 'call', c.outcome);
      if (public.get_lead(l) ->> 'attempts')::integer <> least(c.want_attempts + 1, 6) then
        raise exception 'FAIL: get_lead attempts after % then %', c.prior, c.outcome;
      end if;
      perform pg_temp.su();
      select * into lead from public.companies where id = l;
      want_next := case when c.want_attempts >= 5 then now() + interval '30 days'
                        else private.next_working_day(now(), (case when c.outcome = 'no_answer' then 1 else 2 end),
                                                      'Europe/Paris') end;
      if lead.lead_status <> c.want_status or lead.next_action_at <> want_next then
        raise exception 'FAIL: after % then %: (%, %), expected (%, %)', c.prior, c.outcome, lead.lead_status,
          lead.next_action_at, c.want_status, want_next;
      end if;
      raise exception 'undo' using errcode = 'TS001';
    exception when sqlstate 'TS001' then null;
    end;
    cases := cases + 1;
  end loop;
  if cases <> 6 then raise exception 'FAIL: 6-in-a-row cases ran %', cases; end if;
end $$;

-- 5b. Follow-ups: Spoke with a date or a time, Interested with a time; a follow-up after other kinds of entry.
do $$
declare
  admin constant uuid := '00000000-0000-0000-0000-00000000000a';
  l uuid;
  r jsonb;
  task record;
  d constant date := (now() at time zone 'UTC')::date + 3;
  t constant timestamptz := date_trunc('minute', now()) + interval '2 days';
begin
  l := pg_temp.new_lead('00000000-0000-0000-0000-0000000000d1', 'warm');
  perform pg_temp.act(admin);
  r := public.log_activity(l, 'call', 'connected', null, null, null, d, null, 'Call back');
  select * into task from public.tasks where id = (r ->> 'task_id')::uuid;
  if task.kind <> 'call' or task.due_date <> d or task.due_at is not null or task.assignee_id <> admin
     or (r ->> 'next_action_at')::timestamptz <> ((d + 1) + time '09:00') at time zone 'Europe/Paris'
     or r ->> 'status_after' <> 'warm' then
    raise exception 'FAIL: Spoke with a date %', r;
  end if;
  r := public.log_activity(l, 'call', 'connected', null, null, null, null, t, 'Call back');
  select * into task from public.tasks where id = (r ->> 'task_id')::uuid;
  if task.kind <> 'call' or task.due_at <> t or task.due_date is not null
     or (r ->> 'next_action_at')::timestamptz <> t + interval '1 day' then
    raise exception 'FAIL: Spoke with a time %', r;
  end if;
  r := public.log_activity(l, 'call', 'interested', null, null, null, null, t, 'Follow up');
  select * into task from public.tasks where id = (r ->> 'task_id')::uuid;
  if task.kind <> 'call' or task.due_at <> t or (r ->> 'next_action_at')::timestamptz <> t + interval '1 day' then
    raise exception 'FAIL: Interested with a time %', r;
  end if;
  -- Other kinds of entry: an optional follow-up is a call task; a meeting entry with no outcome and a time is a meeting
  -- being booked. No lead change (status and next call stay).
  r := public.log_activity(l, 'note', null, 'Asked for prices', null, null, d, null, 'Send prices');
  select * into task from public.tasks where id = (r ->> 'task_id')::uuid;
  if task.kind <> 'call' or task.due_date <> d or r ->> 'status_after' <> 'warm'
     or (r ->> 'next_action_at')::timestamptz <> t + interval '1 day' then
    raise exception 'FAIL: a note with a follow-up %', r;
  end if;
  r := public.log_activity(l, 'email', 'sent', 'Subject: Catalogue', null, null, null, t, 'Follow up the email');
  if (select kind from public.tasks where id = (r ->> 'task_id')::uuid) <> 'call' then
    raise exception 'FAIL: an email with a follow-up %', r;
  end if;
  r := public.log_activity(l, 'meeting', null, 'Showroom visit', null, null, null, t, 'Meeting with Day4b Lead');
  if (select kind || ' ' || due_at from public.tasks where id = (r ->> 'task_id')::uuid) <> 'meeting ' || t then
    raise exception 'FAIL: booking a meeting from the composer %', r;
  end if;
  r := public.log_activity(l, 'meeting', 'held', 'Good meeting');
  if r ->> 'task_id' is not null then raise exception 'FAIL: a meeting held with no follow-up made a task'; end if;
  perform pg_temp.su();
  if (select count(*) from public.activities where company_id = l) <> 7 then
    raise exception 'FAIL: follow-up entries were not all logged';
  end if;
end $$;

-- 5c. An unassigned lead becomes the caller's on Interested or Book meeting (open question 5); Undo gives it back.
do $$
declare
  admin constant uuid := '00000000-0000-0000-0000-00000000000a';
  d1 constant uuid := '00000000-0000-0000-0000-0000000000d1';
  c record;
  l uuid;
  r jsonb;
  u jsonb;
  t constant timestamptz := date_trunc('minute', now()) + interval '1 day';
begin
  for c in select * from (values
      (null::uuid, 'interested', admin, true), (null::uuid, 'meeting_booked', admin, true),
      (null::uuid, 'connected', null::uuid, false), (null::uuid, 'no_answer', null::uuid, false),
      (null::uuid, 'not_interested', null::uuid, false), (d1, 'interested', d1, false),
      (d1, 'meeting_booked', d1, false)) as x (start_owner, outcome, want_owner, changed) loop
    begin
      l := pg_temp.new_lead(c.start_owner);
      perform pg_temp.act(admin);
      r := public.log_activity(l, 'call', c.outcome, null, null, null, null,
                               case when c.outcome in ('interested', 'meeting_booked') then t end,
                               case when c.outcome in ('interested', 'meeting_booked') then 'Follow up' end);
      if (select owner_id from public.companies where id = l) is distinct from c.want_owner
         or (r ->> 'owner_changed')::boolean <> c.changed then
        raise exception 'FAIL: % on a lead owned by %: owner %, answer %', c.outcome, c.start_owner,
          (select owner_id from public.companies where id = l), r;
      end if;
      u := public.undo_activity((r ->> 'activity_id')::uuid);
      if (select owner_id from public.companies where id = l) is distinct from c.start_owner
         or (u -> 'restored' ->> 'owner')::boolean <> c.changed then
        raise exception 'FAIL: undo of % gave the owner %', c.outcome, (select owner_id from public.companies where id = l);
      end if;
      perform pg_temp.su();
      raise exception 'undo' using errcode = 'TS001';
    exception when sqlstate 'TS001' then null;
    end;
  end loop;
  -- A rep may not change an unassigned lead: the call is logged, the lead stays unassigned and cold.
  begin
    l := pg_temp.new_lead(null);
    perform pg_temp.act('00000000-0000-0000-0000-0000000000b1');
    r := public.log_activity(l, 'call', 'interested', null, null, null, null, t, 'Follow up');
    perform pg_temp.su();
    if (select owner_id from public.companies where id = l) is not null
       or (select lead_status from public.companies where id = l) <> 'cold'
       or (r ->> 'editable')::boolean or (r ->> 'owner_changed')::boolean
       or (select assignee_id from public.tasks where id = (r ->> 'task_id')::uuid) <> '00000000-0000-0000-0000-0000000000b1' then
      raise exception 'FAIL: a rep took or changed an unassigned lead %', r;
    end if;
    raise exception 'undo' using errcode = 'TS001';
  exception when sqlstate 'TS001' then null;
  end;
end $$;

-- 5d. The next call follows the lead's calling zone: a span's eastern end, a picked zone, Paris with no country.
do $$
declare
  admin constant uuid := '00000000-0000-0000-0000-00000000000a';
  c record;
  l uuid;
  r jsonb;
  d constant date := (now() at time zone 'UTC')::date + 4;
begin
  for c in select * from (values ('US', null, 'America/New_York'), ('US', 'America/Los_Angeles', 'America/Los_Angeles'),
                                 ('CA', null, 'America/Halifax'), ('GB', null, 'Europe/London'),
                                 (null, null, 'Europe/Paris'), ('ID', null, 'Asia/Jayapura')) as x (country, zone, east) loop
    begin
      l := pg_temp.new_lead('00000000-0000-0000-0000-0000000000d1', country => c.country);
      update public.companies set timezone = c.zone where id = l;
      perform pg_temp.act(admin);
      r := public.log_activity(l, 'call', 'no_answer');
      if (r ->> 'next_action_at')::timestamptz
           <> private.next_working_day(now(), 1, private.lead_call_zone(c.zone, c.country)) then
        raise exception 'FAIL: no answer on a % lead (zone %): %', c.country, c.zone, r;
      end if;
      r := public.log_activity(l, 'call', 'interested', null, null, null, d, null, 'Follow up');
      if (r ->> 'next_action_at')::timestamptz <> ((d + 1) + time '09:00') at time zone c.east then
        raise exception 'FAIL: interested on a % lead (zone %): %', c.country, c.zone, r;
      end if;
      perform pg_temp.su();
      raise exception 'undo' using errcode = 'TS001';
    exception when sqlstate 'TS001' then null;
    end;
  end loop;
end $$;

-- 5e. Wrong number: the dialled number is marked (lead or contact) with the server's time; "find the right number" only
-- when no working number is left; a phone change clears the mark; only editors mark (threat 12).
do $$
declare
  admin constant uuid := '00000000-0000-0000-0000-00000000000a';
  d1 constant uuid := '00000000-0000-0000-0000-0000000000d1';
  b1 constant uuid := '00000000-0000-0000-0000-0000000000b1';
  l uuid;
  k uuid;
  k2 uuid;
  r jsonb;
  u jsonb;
  created timestamptz;
begin
  -- Main line dialled, a contact's number still works: the lead is marked, no task.
  begin
    l := pg_temp.new_lead(d1);
    k := pg_temp.new_contact(l);
    perform pg_temp.act(admin);
    r := public.log_activity(l, 'call', 'wrong_number', null, null, 'lead', null, null, 'Find the right number');
    perform pg_temp.su();
    created := (r ->> 'created_at')::timestamptz;
    if (select phone_wrong_at from public.companies where id = l) <> created
       or (select phone_wrong_at from public.contacts where id = k) is not null
       or r ->> 'task_id' is not null or not (r ->> 'wrong_number_marked')::boolean then
      raise exception 'FAIL: wrong main line with a working contact %', r;
    end if;
    -- A second wrong number on the marked line keeps the first time and marks nothing new; its undo clears nothing.
    perform pg_temp.act(admin);
    r := public.log_activity(l, 'call', 'wrong_number', null, null, 'lead', null, null, 'Find the right number');
    if (r ->> 'wrong_number_marked')::boolean then raise exception 'FAIL: a marked line was marked again'; end if;
    u := public.undo_activity((r ->> 'activity_id')::uuid);
    perform pg_temp.su();
    if (select phone_wrong_at from public.companies where id = l) <> created or (u -> 'restored' ->> 'phone_wrong')::boolean then
      raise exception 'FAIL: undoing the second wrong number cleared the first mark';
    end if;
    raise exception 'undo' using errcode = 'TS001';
  exception when sqlstate 'TS001' then null;
  end;
  -- The contact dialled is the only number (no main line): the contact is marked and the owner gets the task.
  begin
    l := pg_temp.new_lead(d1, phone => null);
    k := pg_temp.new_contact(l);
    perform pg_temp.act(admin);
    r := public.log_activity(l, 'call', 'wrong_number', null, k, 'contact', null, null, 'Find the right number');
    perform pg_temp.su();
    created := (r ->> 'created_at')::timestamptz;
    if (select phone_wrong_at from public.contacts where id = k) <> created
       or (select phone_wrong_at from public.companies where id = l) is not null
       or (select assignee_id || ' ' || kind || ' ' || contact_id from public.tasks where id = (r ->> 'task_id')::uuid)
          <> d1 || ' todo ' || k
       or (select wrong_contact_id from private.activity_undo where activity_id = (r ->> 'activity_id')::uuid) <> k then
      raise exception 'FAIL: wrong contact number, the only one %', r;
    end if;
    -- get_lead shows the contact's mark.
    if (public.get_lead(l) -> 'contacts' -> 0 ->> 'phone_wrong_at')::timestamptz <> created then
      raise exception 'FAIL: get_lead does not show the contact''s mark';
    end if;
    -- Undo clears the contact's mark and removes the task.
    perform pg_temp.act(admin);
    u := public.undo_activity((r ->> 'activity_id')::uuid);
    perform pg_temp.su();
    if (select phone_wrong_at from public.contacts where id = k) is not null
       or not (u -> 'restored' ->> 'contact_phone_wrong')::boolean or not (u ->> 'task_deleted')::boolean then
      raise exception 'FAIL: undo of a wrong contact number %', u;
    end if;
    raise exception 'undo' using errcode = 'TS001';
  exception when sqlstate 'TS001' then null;
  end;
  -- A contact dialled while another contact's number works: the contact is marked, no task.
  begin
    l := pg_temp.new_lead(d1, phone => null);
    k := pg_temp.new_contact(l);
    k2 := pg_temp.new_contact(l, '+33 6 39 98 00 02', 'Second');
    perform pg_temp.act(admin);
    r := public.log_activity(l, 'call', 'wrong_number', null, k, 'contact', null, null, 'Find the right number');
    if r ->> 'task_id' is not null then raise exception 'FAIL: a task although another contact has a number'; end if;
    -- The contact's number changes: the mark goes; the undo afterwards finds nothing to clear.
    perform public.update_contact(k, 'Fakey', '', null, null, '+33 6 39 98 00 09');
    if (select phone_wrong_at from public.contacts where id = k) is not null then
      raise exception 'FAIL: a new contact number kept the wrong-number mark';
    end if;
    u := public.undo_activity((r ->> 'activity_id')::uuid);
    if (u -> 'restored' ->> 'contact_phone_wrong')::boolean then raise exception 'FAIL: undo cleared a mark twice'; end if;
    perform pg_temp.su();
    raise exception 'undo' using errcode = 'TS001';
  exception when sqlstate 'TS001' then null;
  end;
  -- Undo clears only the mark this entry made: a mark that now carries another time (made again later) stays, on the
  -- lead and on a contact.
  begin
    l := pg_temp.new_lead(d1);
    k := pg_temp.new_contact(l);
    perform pg_temp.act(admin);
    r := public.log_activity(l, 'call', 'wrong_number', null, null, 'lead', null, null, 'Find the right number');
    u := public.log_activity(l, 'call', 'wrong_number', null, k, 'contact', null, null, 'Find the right number');
    perform pg_temp.su();
    -- (Superuser with the guards off: within one transaction a new mark would carry the same time.)
    alter table public.companies disable trigger lead_guard;
    alter table public.contacts disable trigger contact_guard;
    update public.companies set phone_wrong_at = now() - interval '1 minute' where id = l;
    update public.contacts set phone_wrong_at = now() - interval '1 minute' where id = k;
    alter table public.companies enable trigger lead_guard;
    alter table public.contacts enable trigger contact_guard;
    perform pg_temp.act(admin);
    u := public.undo_activity((u ->> 'activity_id')::uuid);
    r := public.undo_activity((r ->> 'activity_id')::uuid);
    perform pg_temp.su();
    if (select phone_wrong_at from public.companies where id = l) is null
       or (select phone_wrong_at from public.contacts where id = k) is null
       or (r -> 'restored' ->> 'phone_wrong')::boolean or (u -> 'restored' ->> 'contact_phone_wrong')::boolean then
      raise exception 'FAIL: undo cleared a mark made at another time % %', r, u;
    end if;
    raise exception 'undo' using errcode = 'TS001';
  exception when sqlstate 'TS001' then null;
  end;
  -- The owner (a rep) with the only number wrong: the task is theirs.
  begin
    l := pg_temp.new_lead(d1);
    perform pg_temp.act(d1);
    r := public.log_activity(l, 'call', 'wrong_number', null, null, 'lead', null, null, 'Find the right number');
    perform pg_temp.su();
    if (select assignee_id from public.tasks where id = (r ->> 'task_id')::uuid) <> d1
       or (select phone_wrong_at from public.companies where id = l) is null then
      raise exception 'FAIL: the owner''s own wrong number %', r;
    end if;
    raise exception 'undo' using errcode = 'TS001';
  exception when sqlstate 'TS001' then null;
  end;
  -- rep_wrong_number_on_others_lead_no_mark: a rep who may not change the lead logs it; nothing is marked; they get
  -- the task, since they had the call.
  begin
    l := pg_temp.new_lead(d1);
    k := pg_temp.new_contact(l, '+33 6 39 98 00 03');
    perform pg_temp.act(b1);
    r := public.log_activity(l, 'call', 'wrong_number', null, null, 'lead', null, null, 'Find the right number');
    perform pg_temp.su();
    if (select phone_wrong_at from public.companies where id = l) is not null or (r ->> 'wrong_number_marked')::boolean
       or (r ->> 'editable')::boolean or r ->> 'task_id' is not null then
      raise exception 'FAIL: a rep marked a colleague''s main line %', r;
    end if;
    perform pg_temp.act(b1);
    r := public.log_activity(l, 'call', 'wrong_number', null, k, 'contact', null, null, 'Find the right number');
    perform pg_temp.su();
    if (select phone_wrong_at from public.contacts where id = k) is not null or (r ->> 'wrong_number_marked')::boolean
       or (select wrong_contact_id from private.activity_undo where activity_id = (r ->> 'activity_id')::uuid) is not null
       or (select assignee_id from public.tasks where id = (r ->> 'task_id')::uuid) <> b1 then
      raise exception 'FAIL: a rep marked a colleague''s contact, or got no task %', r;
    end if;
    -- rep_direct_phone_wrong_patch_zero_rows: nor directly (row level security).
    perform pg_temp.act(b1);
    update public.companies set phone_wrong_at = now() where id = l;
    update public.contacts set phone_wrong_at = now() where id = k;
    perform pg_temp.su();
    if (select phone_wrong_at from public.companies where id = l) is not null
       or (select phone_wrong_at from public.contacts where id = k) is not null then
      raise exception 'FAIL: a rep marked a colleague''s number directly';
    end if;
    raise exception 'undo' using errcode = 'TS001';
  exception when sqlstate 'TS001' then null;
  end;
  -- phone_wrong_time_forced: an editor's direct mark gets the server's time; a later different time keeps the first;
  -- clearing works; a new number clears it (lead and contact).
  begin
    l := pg_temp.new_lead(d1);
    k := pg_temp.new_contact(l);
    perform pg_temp.act(d1);
    update public.companies set phone_wrong_at = '2001-01-01 00:00+00' where id = l;
    update public.contacts set phone_wrong_at = '2001-01-01 00:00+00' where id = k;
    if (select phone_wrong_at from public.companies where id = l) <> now()
       or (select phone_wrong_at from public.contacts where id = k) <> now() then
      raise exception 'FAIL: a client chose the time of a wrong-number mark';
    end if;
    update public.companies set phone_wrong_at = '2030-01-01 00:00+00' where id = l;
    update public.contacts set phone_wrong_at = '2030-01-01 00:00+00' where id = k;
    if (select phone_wrong_at from public.companies where id = l) <> now()
       or (select phone_wrong_at from public.contacts where id = k) <> now() then
      raise exception 'FAIL: a mark''s time changed';
    end if;
    update public.companies set phone_wrong_at = null where id = l;
    if (select phone_wrong_at from public.companies where id = l) is not null then raise exception 'FAIL: clearing a mark'; end if;
    update public.companies set phone_wrong_at = now() where id = l;
    perform public.update_lead(l, 'Day4b Lead', d1, 'cold', '+33 1 99 00 10 09', null, null, 'FR');
    if (select phone_wrong_at from public.companies where id = l) is not null then
      raise exception 'FAIL: a new main number kept the mark';
    end if;
    perform pg_temp.su();
    raise exception 'undo' using errcode = 'TS001';
  exception when sqlstate 'TS001' then null;
  end;
  -- Which number: wrong_number needs it; a contact needs the contact; it must not be empty; only calls name one.
  l := pg_temp.new_lead(d1, phone => null, lead_name => 'Day4b dialled checks');
  k := pg_temp.new_contact(l, null);
  perform pg_temp.act(admin);
  perform pg_temp.expect_error(format('select public.log_activity(%L, %L, %L, null, null, null, null, null, %L)', l, 'call',
                                      'wrong_number', 'Find'), '22023', 'dialled');
  perform pg_temp.expect_error(format('select public.log_activity(%L, %L, %L, null, null, %L, null, null, %L)', l, 'call',
                                      'wrong_number', 'contact', 'Find'), '22023', 'dialled');
  perform pg_temp.expect_error(format('select public.log_activity(%L, %L, %L, null, null, %L, null, null, %L)', l, 'call',
                                      'wrong_number', 'lead', 'Find'), '22023', 'dialled');
  perform pg_temp.expect_error(format('select public.log_activity(%L, %L, %L, null, %L, %L, null, null, %L)', l, 'call',
                                      'wrong_number', k, 'contact', 'Find'), '22023', 'dialled');
  perform pg_temp.expect_error(format('select public.log_activity(%L, %L, %L, null, null, %L)', l, 'call', 'no_answer',
                                      'mobile'), '22023', 'dialled');
  perform pg_temp.expect_error(format('select public.log_activity(%L, %L, null, %L, null, %L)', l, 'note', 'x', 'lead'),
                               '22023', 'dialled');
  perform pg_temp.su();
end $$;

-- 5f. Do not contact wins from any status, empties the next call and dismisses the open tasks the caller may change.
do $$
declare
  admin constant uuid := '00000000-0000-0000-0000-00000000000a';
  d1 constant uuid := '00000000-0000-0000-0000-0000000000d1';
  b1 constant uuid := '00000000-0000-0000-0000-0000000000b1';
  l uuid;
  t_admin uuid;
  t_d1 uuid;
  t_b1 uuid;
  r jsonb;
  u jsonb;
  s text;
begin
  -- dnc_from_customer (and from Disqualified): the admin dismisses every open task; Undo reopens them.
  foreach s in array array['customer', 'disqualified', 'do_not_contact'] loop
    begin
      l := pg_temp.new_lead(d1, s, now() + interval '5 days');
      t_admin := pg_temp.new_task(l, admin, 'todo');
      t_d1 := pg_temp.new_task(l, d1, 'call', (now() at time zone 'UTC')::date + 20);
      perform pg_temp.act(admin);
      r := public.log_activity(l, 'call', 'do_not_contact');
      perform pg_temp.su();
      if (select lead_status || coalesce(next_action_at::text, '-') from public.companies where id = l) <> 'do_not_contact-'
         or (select count(*) from public.tasks where id in (t_admin, t_d1) and cancelled_at = (r ->> 'created_at')::timestamptz) <> 2 then
        raise exception 'FAIL: Do not contact from %: %', s, r;
      end if;
      perform pg_temp.act(admin);
      u := public.undo_activity((r ->> 'activity_id')::uuid);
      perform pg_temp.su();
      if (select lead_status from public.companies where id = l) <> s
         or (select next_action_at from public.companies where id = l) is null
         or exists (select 1 from public.tasks where id in (t_admin, t_d1) and cancelled_at is not null) then
        raise exception 'FAIL: undo of Do not contact from %: %', s, u;
      end if;
      raise exception 'undo' using errcode = 'TS001';
    exception when sqlstate 'TS001' then null;
    end;
  end loop;
  -- Undo reopens a dismissed task only while it carries this entry's time.
  begin
    l := pg_temp.new_lead(d1, 'warm');
    t_admin := pg_temp.new_task(l, admin, 'todo');
    perform pg_temp.act(admin);
    r := public.log_activity(l, 'call', 'do_not_contact');
    perform pg_temp.su();
    update public.tasks set cancelled_at = now() - interval '1 minute' where id = t_admin;   -- superuser, no claims
    perform pg_temp.act(admin);
    u := public.undo_activity((r ->> 'activity_id')::uuid);
    perform pg_temp.su();
    if (select cancelled_at from public.tasks where id = t_admin) is null or (u ->> 'tasks_reopened')::integer <> 0 then
      raise exception 'FAIL: undo reopened a task dismissed at another time %', u;
    end if;
    raise exception 'undo' using errcode = 'TS001';
  exception when sqlstate 'TS001' then null;
  end;
  -- The owner (a rep) dismisses only the tasks they may change: not the admin's.
  begin
    l := pg_temp.new_lead(d1, 'warm');
    t_admin := pg_temp.new_task(l, admin, 'todo');
    t_d1 := pg_temp.new_task(l, d1, 'todo');
    perform pg_temp.act(d1);
    r := public.log_activity(l, 'call', 'do_not_contact');
    perform pg_temp.su();
    if (select cancelled_at from public.tasks where id = t_admin) is not null
       or (select cancelled_at from public.tasks where id = t_d1) is null
       or (select lead_status from public.companies where id = l) <> 'do_not_contact' then
      raise exception 'FAIL: the owner''s Do not contact %', r;
    end if;
    raise exception 'undo' using errcode = 'TS001';
  exception when sqlstate 'TS001' then null;
  end;
  -- outcome_not_editable_logs_only: a rep on a colleague's lead logs Do not contact and Interested; the lead keeps its
  -- status, next call and owner; only the rep's own task is dismissed; the rep's follow-up task is still made.
  begin
    l := pg_temp.new_lead(d1, 'cold', now() + interval '5 days');
    t_d1 := pg_temp.new_task(l, d1, 'todo');
    t_b1 := pg_temp.new_task(l, b1, 'todo');
    perform pg_temp.act(b1);
    r := public.log_activity(l, 'call', 'do_not_contact');
    if (r ->> 'editable')::boolean or r ->> 'status_before' is not null or r ->> 'status_after' is not null
       or (select lead_status from public.companies where id = l) <> 'cold'
       or (select next_action_at from public.companies where id = l) <> now() + interval '5 days'
       or (select cancelled_at from public.tasks where id = t_b1) is null then
      raise exception 'FAIL: a rep''s Do not contact on a colleague''s lead %', r;
    end if;
    r := public.log_activity(l, 'call', 'interested', null, null, null, (now() at time zone 'UTC')::date + 1, null, 'Follow up');
    if (r ->> 'editable')::boolean or (select lead_status || owner_id from public.companies where id = l) <> 'cold' || d1
       or (select assignee_id from public.tasks where id = (r ->> 'task_id')::uuid) <> b1
       or (select user_id from public.activities where id = (r ->> 'activity_id')::uuid) <> b1 then
      raise exception 'FAIL: a rep''s Interested on a colleague''s lead %', r;
    end if;
    -- Undo by the rep: the entry and the task go, the lead was never changed.
    u := public.undo_activity((r ->> 'activity_id')::uuid);
    if (u -> 'restored') <> '{"owner": false, "status": false, "phone_wrong": false, "next_action_at": false, "contact_phone_wrong": false}'::jsonb
       or not (u ->> 'task_deleted')::boolean then
      raise exception 'FAIL: a rep''s undo %', u;
    end if;
    perform pg_temp.su();
    if (select cancelled_at from public.tasks where id = t_d1) is not null then
      raise exception 'FAIL: a rep dismissed a colleague''s task';
    end if;
    raise exception 'undo' using errcode = 'TS001';
  exception when sqlstate 'TS001' then null;
  end;
end $$;

-- 5g. Which tasks a call completes: the caller's call tasks on this lead due by the end of the caller's day (dated or
-- timed); not to-dos, not later ones, not undated ones, not a colleague's.
do $$
declare
  admin constant uuid := '00000000-0000-0000-0000-00000000000a';
  d1 constant uuid := '00000000-0000-0000-0000-0000000000d1';
  today constant date := (now() at time zone 'Europe/Paris')::date;
  l uuid;
  r jsonb;
  want uuid[];
  t_today uuid;
  t_tonight uuid;
  t_old uuid;
begin
  begin
    l := pg_temp.new_lead(d1);
    t_today := pg_temp.new_task(l, admin, 'call', today);
    t_tonight := pg_temp.new_task(l, admin, 'call', null, (today::timestamp + time '23:30') at time zone 'Europe/Paris');
    t_old := pg_temp.new_task(l, admin, 'call', null, now() - interval '3 days');
    perform pg_temp.new_task(l, admin, 'todo', today - 1);                                     -- a to-do
    perform pg_temp.new_task(l, admin, 'call', today + 1);                                     -- tomorrow
    perform pg_temp.new_task(l, admin, 'call', null, ((today + 1)::timestamp + time '00:30') at time zone 'Europe/Paris');
    perform pg_temp.new_task(l, admin, 'call');                                                -- undated
    perform pg_temp.new_task(l, d1, 'call', today - 1);                                        -- a colleague's
    perform pg_temp.new_task(pg_temp.new_lead(d1), admin, 'call', today - 1);                  -- another lead
    want := array(select x from unnest(array[t_today, t_tonight, t_old]) x order by x);
    perform pg_temp.act(admin);
    r := public.log_activity(l, 'call', 'voicemail');
    perform pg_temp.su();
    if r -> 'completed_task_ids' <> to_jsonb(want) then
      raise exception 'FAIL: a call completed % (expected %)', r -> 'completed_task_ids', want;
    end if;
    -- A note completes nothing.
    perform pg_temp.act(admin);
    update public.tasks set done_at = null where id = any (want);
    r := public.log_activity(l, 'note', null, 'Just a note');
    perform pg_temp.su();
    if r -> 'completed_task_ids' <> '[]'::jsonb or exists (select 1 from public.tasks where id = any (want) and done_at is not null) then
      raise exception 'FAIL: a note completed tasks';
    end if;
    raise exception 'undo' using errcode = 'TS001';
  exception when sqlstate 'TS001' then null;
  end;
end $$;

-- 6. Undo: compare and restore, the 2-minute window, one use, own entries only, the delete rules (threats 8 and 9) -----
do $$
declare
  admin constant uuid := '00000000-0000-0000-0000-00000000000a';
  a1 constant uuid := '00000000-0000-0000-0000-0000000000a1';
  d1 constant uuid := '00000000-0000-0000-0000-0000000000d1';
  b1 constant uuid := '00000000-0000-0000-0000-0000000000b1';
  l uuid;
  r jsonb;
  u jsonb;
  e uuid;
  t uuid;
  n integer;
  v0 constant timestamptz := date_trunc('second', now()) + interval '3 days';
begin
  -- undo_skips_changed_status: a colleague moved the lead after the outcome; the status stays theirs, the next call
  -- (untouched by them) comes back.
  begin
    l := pg_temp.new_lead(d1, 'cold', v0);
    perform pg_temp.act(admin);
    r := public.log_activity(l, 'call', 'not_interested');
    perform pg_temp.act(a1);
    perform public.bulk_update_leads(array[l], 'warm');
    perform pg_temp.act(admin);
    u := public.undo_activity((r ->> 'activity_id')::uuid);
    perform pg_temp.su();
    if (select lead_status from public.companies where id = l) <> 'warm'
       or (select next_action_at from public.companies where id = l) <> v0
       or (u -> 'restored' ->> 'status')::boolean or not (u -> 'restored' ->> 'next_action_at')::boolean then
      raise exception 'FAIL: undo overwrote a colleague''s status %', u;
    end if;
    raise exception 'undo' using errcode = 'TS001';
  exception when sqlstate 'TS001' then null;
  end;
  -- undo_skips_changed_next: a colleague set the next call; the status comes back, their date stays.
  begin
    l := pg_temp.new_lead(d1, 'cold', v0);
    perform pg_temp.act(admin);
    r := public.log_activity(l, 'call', 'interested', null, null, null, (now() at time zone 'UTC')::date + 1, null, 'Follow up');
    perform pg_temp.act(a1);
    perform public.set_lead_next_action(l, now() + interval '9 days');
    perform pg_temp.act(admin);
    u := public.undo_activity((r ->> 'activity_id')::uuid);
    perform pg_temp.su();
    if (select lead_status from public.companies where id = l) <> 'cold'
       or (select next_action_at from public.companies where id = l) <> now() + interval '9 days'
       or (u -> 'restored' ->> 'next_action_at')::boolean then
      raise exception 'FAIL: undo overwrote a colleague''s next call %', u;
    end if;
    raise exception 'undo' using errcode = 'TS001';
  exception when sqlstate 'TS001' then null;
  end;
  -- undo_skips_changed_owner: the admin took an unassigned lead with Interested; a manager gave it to d1; undo leaves d1.
  begin
    l := pg_temp.new_lead(null);
    perform pg_temp.act(admin);
    r := public.log_activity(l, 'call', 'meeting_booked', null, null, null, null, now() + interval '1 day', 'Meeting');
    perform pg_temp.act(a1);
    perform public.bulk_update_leads(array[l], null, true, d1);
    perform pg_temp.act(admin);
    u := public.undo_activity((r ->> 'activity_id')::uuid);
    perform pg_temp.su();
    if (select owner_id from public.companies where id = l) is distinct from d1 or (u -> 'restored' ->> 'owner')::boolean then
      raise exception 'FAIL: undo overwrote a colleague''s owner %', u;
    end if;
    raise exception 'undo' using errcode = 'TS001';
  exception when sqlstate 'TS001' then null;
  end;
  -- A completed follow-up is kept by undo (undo_with_touched_task, below, runs over three transactions: within one, an
  -- edit cannot be told from the insert, since both carry the transaction's time).
  begin
    l := pg_temp.new_lead(d1);
    perform pg_temp.act(admin);
    r := public.log_activity(l, 'call', 'interested', null, null, null, (now() at time zone 'UTC')::date + 1, null, 'Follow up');
    perform public.set_task_done((r ->> 'task_id')::uuid, true);
    u := public.undo_activity((r ->> 'activity_id')::uuid);
    if (u ->> 'task_deleted')::boolean or not exists (select 1 from public.tasks where id = (r ->> 'task_id')::uuid) then
      raise exception 'FAIL: undo deleted a completed task';
    end if;
    perform pg_temp.su();
    raise exception 'undo' using errcode = 'TS001';
  exception when sqlstate 'TS001' then null;
  end;
  -- A completed task whose time is no longer this entry's (completed again later) is not reopened.
  begin
    l := pg_temp.new_lead(d1);
    t := pg_temp.new_task(l, admin, 'call', (now() at time zone 'Europe/Paris')::date);
    perform pg_temp.act(admin);
    r := public.log_activity(l, 'call', 'no_answer');
    perform pg_temp.su();
    update public.tasks set done_at = now() - interval '1 minute' where id = t;   -- superuser, no claims
    perform pg_temp.act(admin);
    u := public.undo_activity((r ->> 'activity_id')::uuid);
    perform pg_temp.su();
    if (u ->> 'tasks_reopened')::integer <> 0 or (select done_at from public.tasks where id = t) is null then
      raise exception 'FAIL: undo reopened a task completed at another time %', u;
    end if;
    raise exception 'undo' using errcode = 'TS001';
  exception when sqlstate 'TS001' then null;
  end;
  -- undo_twice_second_refused, someone else's entry, a missing one.
  begin
    l := pg_temp.new_lead(d1);
    perform pg_temp.act(admin);
    r := public.log_activity(l, 'call', 'no_answer');
    perform pg_temp.act(b1);
    perform pg_temp.expect_error(format('select public.undo_activity(%L)', r ->> 'activity_id'), '22023', 'undo_expired');
    perform pg_temp.act(admin);
    perform public.undo_activity((r ->> 'activity_id')::uuid);
    perform pg_temp.expect_error(format('select public.undo_activity(%L)', r ->> 'activity_id'), '22023', 'undo_expired');
    perform pg_temp.expect_error(format('select public.undo_activity(%L)', gen_random_uuid()), '22023', 'undo_expired');
    perform pg_temp.su();
    raise exception 'undo' using errcode = 'TS001';
  exception when sqlstate 'TS001' then null;
  end;
  -- undo_at_119s_ok_at_121s_denied: the window is 2 minutes, even with a fresh code (which could delete the entry).
  begin
    l := pg_temp.new_lead(d1, 'cold', v0);
    perform pg_temp.act(admin);
    r := public.log_activity(l, 'call', 'not_interested');
    perform pg_temp.su();
    perform pg_temp.age_entry((r ->> 'activity_id')::uuid, 119);
    perform pg_temp.act(admin);
    u := public.undo_activity((r ->> 'activity_id')::uuid);
    if (select lead_status from public.companies where id = l) <> 'cold' then raise exception 'FAIL: undo at 119 s'; end if;
    r := public.log_activity(l, 'call', 'not_interested');
    perform pg_temp.su();
    perform pg_temp.age_entry((r ->> 'activity_id')::uuid, 121);
    perform pg_temp.act(admin, 'aal2', 5);
    perform pg_temp.expect_error(format('select public.undo_activity(%L)', r ->> 'activity_id'), '22023', 'undo_expired');
    perform pg_temp.su();
    if (select lead_status from public.companies where id = l) <> 'cool_off'
       or not exists (select 1 from private.activity_undo where activity_id = (r ->> 'activity_id')::uuid) then
      raise exception 'FAIL: a refused undo changed something';
    end if;
    raise exception 'undo' using errcode = 'TS001';
  exception when sqlstate 'TS001' then null;
  end;
  -- outcome_direct_delete_refused_while_undo_record: a logged outcome cannot be deleted around undo_activity (that would
  -- leave the lead changed): no code, 0 rows, for the entry and for its task. With a fresh code it can (the record goes
  -- with it, the lead stays as it is: that is a delete, not an undo).
  begin
    l := pg_temp.new_lead(d1, 'cold', v0);
    perform pg_temp.act(admin, 'aal2', null);
    r := public.log_activity(l, 'call', 'interested', null, null, null, (now() at time zone 'UTC')::date + 1, null, 'Follow up');
    delete from public.tasks where id = (r ->> 'task_id')::uuid;
    get diagnostics n = row_count;
    if n <> 0 then raise exception 'FAIL: the task of a fresh outcome was deleted without a code'; end if;
    delete from public.activities where id = (r ->> 'activity_id')::uuid;
    get diagnostics n = row_count;
    if n <> 0 then raise exception 'FAIL: a fresh outcome was deleted without a code (around undo)'; end if;
    perform pg_temp.act(admin, 'aal2', 30);
    delete from public.activities where id = (r ->> 'activity_id')::uuid;
    get diagnostics n = row_count;
    perform pg_temp.su();
    if n <> 1 or exists (select 1 from private.activity_undo where activity_id = (r ->> 'activity_id')::uuid)
       or (select lead_status from public.companies where id = l) <> 'warm' then
      raise exception 'FAIL: deleting an outcome with a fresh code';
    end if;
    raise exception 'undo' using errcode = 'TS001';
  exception when sqlstate 'TS001' then null;
  end;
  -- An entry inserted directly (no undo record, it changed no lead): its author may remove it without a code for 2
  -- minutes, a colleague may not, and after 2 minutes a code is needed. A task made from it, untouched, likewise.
  begin
    l := pg_temp.new_lead(d1);
    perform pg_temp.act(d1, 'aal2', null);
    insert into public.activities (company_id, type, body) values (l, 'note', 'typed by mistake') returning id into e;
    insert into public.tasks (company_id, title, source_activity_id) values (l, 'From the note', e) returning id into t;
    perform pg_temp.act(b1, 'aal2', null);
    delete from public.activities where id = e;
    get diagnostics n = row_count;
    if n <> 0 then raise exception 'FAIL: a colleague deleted a fresh entry without a code'; end if;
    perform pg_temp.act(d1, 'aal2', null);
    delete from public.tasks where id = t;
    get diagnostics n = row_count;
    if n <> 1 then raise exception 'FAIL: the author could not remove an untouched task from their fresh entry'; end if;
    delete from public.activities where id = e;
    get diagnostics n = row_count;
    if n <> 1 then raise exception 'FAIL: the author could not remove their fresh entry'; end if;
    insert into public.activities (company_id, type, body) values (l, 'note', 'older') returning id into e;
    insert into public.tasks (company_id, title, source_activity_id) values (l, 'From the older note', e) returning id into t;
    -- An admin without a code may not remove a task someone else made this way.
    perform pg_temp.act(admin, 'aal2', null);
    delete from public.tasks where id = t;
    get diagnostics n = row_count;
    if n <> 0 then raise exception 'FAIL: an admin removed a colleague''s fresh task without a code'; end if;
    perform pg_temp.su();
    perform pg_temp.age_entry(e, 121);
    perform pg_temp.act(d1, 'aal2', null);
    delete from public.tasks where id = t;
    get diagnostics n = row_count;
    if n <> 0 then raise exception 'FAIL: a task from an entry older than 2 minutes was deleted without a code'; end if;
    delete from public.activities where id = e;
    get diagnostics n = row_count;
    if n <> 0 then raise exception 'FAIL: an entry older than 2 minutes was deleted without a code'; end if;
    perform pg_temp.su();
    raise exception 'undo' using errcode = 'TS001';
  exception when sqlstate 'TS001' then null;
  end;
  -- undo_restores_previous_date (D9): the lead's last activity goes back to the sheet's date.
  begin
    l := pg_temp.new_lead(d1);
    update public.companies set last_activity_at = '2026-01-15 10:00+00' where id = l;
    perform pg_temp.act(admin);
    r := public.log_activity(l, 'call', 'connected');
    if (select last_activity_at from public.companies where id = l) <> now() then raise exception 'FAIL: last activity'; end if;
    u := public.undo_activity((r ->> 'activity_id')::uuid);
    perform pg_temp.su();
    if (select last_activity_at from public.companies where id = l) <> '2026-01-15 10:00+00'
       or (u -> 'lead' ->> 'last_activity_at')::timestamptz <> '2026-01-15 10:00+00' then
      raise exception 'FAIL: undo did not put the last activity back %', u;
    end if;
    raise exception 'undo' using errcode = 'TS001';
  exception when sqlstate 'TS001' then null;
  end;
end $$;

-- undo_with_touched_task: the follow-up was edited in another request; undo keeps it, and it loses its link to the entry.
do $$
declare r jsonb;
begin
  perform pg_temp.act('00000000-0000-0000-0000-00000000000a');
  r := public.log_activity(pg_temp.new_lead_as_su('00000000-0000-0000-0000-0000000000d1'), 'call', 'interested', null, null,
                           null, (now() at time zone 'UTC')::date + 1, null, 'Follow up');
  perform set_config('t.touched', r::text, false);
  perform pg_temp.su();
end $$;
do $$
begin
  perform pg_temp.act('00000000-0000-0000-0000-00000000000a');
  update public.tasks set title = 'Follow up with the buyer' where id = (current_setting('t.touched')::jsonb ->> 'task_id')::uuid;
  perform pg_temp.su();
end $$;
do $$
declare
  r jsonb := current_setting('t.touched')::jsonb;
  u jsonb;
begin
  perform pg_temp.act('00000000-0000-0000-0000-00000000000a');
  u := public.undo_activity((r ->> 'activity_id')::uuid);
  perform pg_temp.su();
  if (u ->> 'task_deleted')::boolean
     or not exists (select 1 from public.tasks where id = (r ->> 'task_id')::uuid and source_activity_id is null)
     or exists (select 1 from public.activities where id = (r ->> 'activity_id')::uuid) then
    raise exception 'FAIL: undo with a touched task %', u;
  end if;
end $$;

-- The no-code task branch needs an untouched task: one edited in another request needs a code (three transactions).
do $$
declare
  l uuid := pg_temp.new_lead('00000000-0000-0000-0000-0000000000d1');
  e uuid;
  t uuid;
begin
  perform pg_temp.act('00000000-0000-0000-0000-0000000000d1', 'aal2', null);
  insert into public.activities (company_id, type, body) values (l, 'note', 'with a task') returning id into e;
  insert into public.tasks (company_id, title, source_activity_id)
  select company_id, 'Will be touched', e from public.activities where id = e returning id into t;
  perform set_config('t.touched_task', t::text, false);
  perform pg_temp.su();
end $$;
do $$
begin
  perform pg_temp.act('00000000-0000-0000-0000-0000000000d1', 'aal2', null);
  update public.tasks set title = 'Touched once' where id = current_setting('t.touched_task')::uuid;
  perform pg_temp.su();
end $$;
do $$
declare n integer;
begin
  perform pg_temp.act('00000000-0000-0000-0000-0000000000d1', 'aal2', null);
  delete from public.tasks where id = current_setting('t.touched_task')::uuid;
  get diagnostics n = row_count;
  perform pg_temp.su();
  if n <> 0 then raise exception 'FAIL: a touched task was deleted without a code'; end if;
end $$;

-- Undo records are private to their author, and log_activity clears the author's records older than 10 minutes.
do $$
declare
  admin constant uuid := '00000000-0000-0000-0000-00000000000a';
  b1 constant uuid := '00000000-0000-0000-0000-0000000000b1';
  l uuid := pg_temp.new_lead('00000000-0000-0000-0000-0000000000d1', lead_name => 'Day4b undo records');
  old_a uuid;
  old_b uuid;
  r jsonb;
  n integer;
begin
  insert into public.activities (org_id, company_id, type, body, user_id, created_at)
  select org_id, l, 'note', 'old', admin, now() - interval '11 minutes' from public.companies where id = l returning id into old_a;
  insert into public.activities (org_id, company_id, type, body, user_id, created_at)
  select org_id, l, 'note', 'old', b1, now() - interval '11 minutes' from public.companies where id = l returning id into old_b;
  insert into private.activity_undo (activity_id, org_id, user_id, created_at)
  select x.id, x.org_id, x.user_id, now() - interval '11 minutes' from public.activities x where x.id in (old_a, old_b);
  perform pg_temp.act(b1);
  if exists (select 1 from private.activity_undo where user_id <> b1) then
    raise exception 'FAIL: a person sees someone else''s undo records';
  end if;
  delete from private.activity_undo where activity_id = old_a;
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'FAIL: a person deleted someone else''s undo record'; end if;
  perform pg_temp.expect_error(format('insert into private.activity_undo (activity_id, org_id, user_id) values (%L, %L, %L)',
                                      old_a, current_setting('t.main_org'), admin), '42501');
  -- Not even as oneself: a record only for one's own entry (it could otherwise sit on a colleague's entry).
  delete from private.activity_undo where activity_id = old_b;
  perform pg_temp.expect_error(format('insert into private.activity_undo (activity_id, org_id, user_id) values (%L, %L, %L)',
                                      old_a, current_setting('t.main_org'), b1), '42501');
  insert into private.activity_undo (activity_id, org_id, user_id, created_at)
  values (old_b, current_setting('t.main_org')::uuid, b1, now() - interval '11 minutes');
  perform pg_temp.expect_error(format('update private.activity_undo set new_status = %L', 'warm'), '42501');
  perform pg_temp.act(admin);
  r := public.log_activity(l, 'note', null, 'clears my old records');
  perform pg_temp.su();
  if exists (select 1 from private.activity_undo where activity_id = old_a)
     or not exists (select 1 from private.activity_undo where activity_id = old_b) then
    raise exception 'FAIL: the clean-up of old undo records';
  end if;
end $$;

-- 6b. undo_into_due_cool_off: a Cool off lead whose return date has come is the one the queue serves. An outcome that
-- moves it out, then Undo, puts back Cool off and that same (past) date: lead_guard rule 5 keeps a date the statement
-- writes, so the lead does not drop out of the queue for 90 days (design 5.3 and 5.5).
do $$
declare
  admin constant uuid := '00000000-0000-0000-0000-00000000000a';
  d1 constant uuid := '00000000-0000-0000-0000-0000000000d1';
  due constant timestamptz := date_trunc('second', now()) - interval '1 hour';
  c record;
  l uuid;
  r jsonb;
  u jsonb;
  cases integer := 0;
begin
  for c in select * from (values ('interested', 'warm'), ('meeting_booked', 'warm'),
                                 ('do_not_contact', 'do_not_contact')) as x (outcome, want_status) loop
    begin
      l := pg_temp.new_lead(d1, 'cool_off');
      update public.companies set next_action_at = due where id = l;  -- already in Cool off: the date stays
      if (select next_action_at from public.companies where id = l) <> due then
        raise exception 'FAIL: the due Cool off fixture lost its date';
      end if;
      perform pg_temp.act(admin);
      r := public.log_activity(l, 'call', c.outcome, null, null, null,
                               case when c.outcome = 'interested' then (now() at time zone 'UTC')::date + 2 end,
                               case when c.outcome = 'meeting_booked' then date_trunc('minute', now()) + interval '2 days' end,
                               case when c.outcome in ('interested', 'meeting_booked') then 'Follow up' end);
      if r ->> 'status_after' <> c.want_status then
        raise exception 'FAIL: % on a due Cool off lead: %', c.outcome, r;
      end if;
      perform pg_temp.act(admin, 'aal2', null);
      u := public.undo_activity((r ->> 'activity_id')::uuid);
      perform pg_temp.su();
      if (select lead_status from public.companies where id = l) <> 'cool_off'
         or (select next_action_at from public.companies where id = l) is distinct from due
         or not (u -> 'restored' ->> 'status')::boolean or not (u -> 'restored' ->> 'next_action_at')::boolean
         or (u -> 'lead' ->> 'next_action_at')::timestamptz is distinct from due then
        raise exception 'FAIL: undo of % on a due Cool off lead: (%, %), answer %', c.outcome,
          (select lead_status from public.companies where id = l), (select next_action_at from public.companies where id = l), u;
      end if;
      raise exception 'undo' using errcode = 'TS001';
    exception when sqlstate 'TS001' then null;
    end;
    cases := cases + 1;
  end loop;
  if cases <> 3 then raise exception 'FAIL: undo into a due Cool off ran % cases', cases; end if;
end $$;

-- 6c. undo_into_cool_off_without_date: a Cool off lead whose date was cleared. Interested, then Undo: Cool off comes
-- back, and lead_guard rule 5 gives the empty date +90 days, so the answer must not claim the date was restored.
do $$
declare
  admin constant uuid := '00000000-0000-0000-0000-00000000000a';
  d1 constant uuid := '00000000-0000-0000-0000-0000000000d1';
  l uuid;
  r jsonb;
  u jsonb;
  kept timestamptz;
  ran boolean := false;
begin
  begin
    l := pg_temp.new_lead(d1, 'cool_off');
    update public.companies set next_action_at = null where id = l;  -- already in Cool off: a date can be cleared
    if (select next_action_at from public.companies where id = l) is not null then
      raise exception 'FAIL: the Cool off fixture kept a date';
    end if;
    perform pg_temp.act(admin);
    r := public.log_activity(l, 'call', 'interested', null, null, null, (now() at time zone 'UTC')::date + 2, null,
                             'Follow up');
    if r ->> 'status_after' <> 'warm' then
      raise exception 'FAIL: Interested on a Cool off lead with no date: %', r;
    end if;
    perform pg_temp.act(admin, 'aal2', null);
    u := public.undo_activity((r ->> 'activity_id')::uuid);
    perform pg_temp.su();
    kept := (select next_action_at from public.companies where id = l);
    if (select lead_status from public.companies where id = l) <> 'cool_off'
       or kept is null or kept not between now() + interval '90 days' - interval '1 minute'
                                       and now() + interval '90 days' + interval '1 minute'
       or not (u -> 'restored' ->> 'status')::boolean
       or (u -> 'restored' ->> 'next_action_at')::boolean
       or (u -> 'lead' ->> 'next_action_at')::timestamptz is distinct from kept then
      raise exception 'FAIL: undo into Cool off with no date: (%, %), answer %',
        (select lead_status from public.companies where id = l), kept, u;
    end if;
    ran := true;
    raise exception 'undo' using errcode = 'TS001';
  exception when sqlstate 'TS001' then null;
  end;
  if not ran then raise exception 'FAIL: undo into Cool off with no date did not run'; end if;
end $$;

-- 7. Replays: one request id per author gives one entry, one task, one status change (threat 10) --------------------
do $$
declare
  l uuid := pg_temp.new_lead('00000000-0000-0000-0000-0000000000d1', 'cold', null, lead_name => 'Day4b replay');
begin
  perform set_config('t.replay_lead', l::text, false);
  perform set_config('t.replay_req', gen_random_uuid()::text, false);
end $$;
do $$
declare r jsonb;
begin
  perform pg_temp.act('00000000-0000-0000-0000-00000000000a');
  r := public.log_activity(current_setting('t.replay_lead')::uuid, 'call', 'interested', 'first', null, null,
                           (now() at time zone 'UTC')::date + 1, null, 'Follow up', current_setting('t.replay_req')::uuid);
  if (r ->> 'replayed')::boolean then raise exception 'FAIL: a first request answered as a replay'; end if;
  perform set_config('t.replay_first', r::text, false);
  perform pg_temp.su();
end $$;
do $$
declare
  r jsonb;
  first jsonb := current_setting('t.replay_first')::jsonb;
  l uuid := current_setting('t.replay_lead')::uuid;
begin
  -- log_activity_idempotent: the same request again (even with other values) answers the first result.
  perform pg_temp.act('00000000-0000-0000-0000-00000000000a');
  r := public.log_activity(l, 'call', 'not_interested', 'second', null, null, null, null, null,
                           current_setting('t.replay_req')::uuid);
  if not (r ->> 'replayed')::boolean or r - 'replayed' <> first - 'replayed' then
    raise exception 'FAIL: a replay answered % instead of %', r, first;
  end if;
  perform pg_temp.su();
  if (select count(*) from public.activities where company_id = l) <> 1
     or (select count(*) from public.tasks where company_id = l) <> 1
     or (select lead_status from public.companies where id = l) <> 'warm'
     or (select count(*) from public.audit_log where table_name = 'companies' and record_id = l::text
          and diff_json ? 'lead_status') <> 1 then
    raise exception 'FAIL: a replay logged or changed something again';
  end if;
  -- request_id_other_author_no_collision: another person's same id is their own request.
  perform pg_temp.act('00000000-0000-0000-0000-0000000000b1');
  r := public.log_activity(l, 'note', null, 'my own', null, null, null, null, null, current_setting('t.replay_req')::uuid);
  if (r ->> 'replayed')::boolean then raise exception 'FAIL: request ids collided across authors'; end if;
  perform pg_temp.su();
  -- A replay after the undo record is gone (cleared after 10 minutes) still answers the entry.
  delete from private.activity_undo where activity_id = (first ->> 'activity_id')::uuid;
  perform pg_temp.act('00000000-0000-0000-0000-00000000000a');
  r := public.log_activity(l, 'note', null, 'x', null, null, null, null, null, current_setting('t.replay_req')::uuid);
  if not (r ->> 'replayed')::boolean or r ->> 'activity_id' <> first ->> 'activity_id' or r ->> 'editable' is not null then
    raise exception 'FAIL: a late replay %', r;
  end if;
  perform pg_temp.su();
end $$;

-- 8. The timeline: keyset pages, filters, cut text, the task chip, whose entries, the undo window -------------------
do $$
declare
  l uuid := pg_temp.new_lead('00000000-0000-0000-0000-0000000000d1', lead_name => 'Day4b timeline');
  k uuid := pg_temp.new_contact(l, null, 'Timothée');
  at_same constant timestamptz := date_trunc('second', now()) - interval '1 hour';
  i integer;
begin
  perform set_config('t.tl_lead', l::text, false);
  -- 20 entries with the same time (one import, say), plus 5 older calls.
  for i in 1 .. 20 loop
    insert into public.activities (org_id, company_id, contact_id, type, outcome, body, user_id, created_at)
    select org_id, l, case when i = 1 then k end, (case when i % 2 = 0 then 'note' else 'email' end),
           (case when i % 2 = 0 then null else 'sent' end), 'Same time ' || i, '00000000-0000-0000-0000-0000000000b1', at_same
      from public.companies where id = l;
  end loop;
  for i in 1 .. 5 loop
    insert into public.activities (org_id, company_id, type, outcome, body, user_id, created_at)
    select org_id, l, 'call', 'no_answer', repeat('x', 1998 + i), '00000000-0000-0000-0000-0000000000d1',
           at_same - make_interval(mins => i)
      from public.companies where id = l;
  end loop;
end $$;
do $$
declare
  l uuid := current_setting('t.tl_lead')::uuid;
  seen uuid[] := '{}';
  page record;
  cur_at timestamptz;
  cur_id uuid;
  n integer;
  pages integer := 0;
  want uuid[];
  r jsonb;
begin
  perform pg_temp.act('00000000-0000-0000-0000-00000000000a');
  -- timeline_keyset_stable: pages of 7 over 25 entries (20 with the same time) give every entry once, in order.
  loop
    n := 0;
    for page in select * from public.list_lead_activities(l, null, cur_at, cur_id, 7) loop
      if page.id = any (seen) then raise exception 'FAIL: the timeline repeated an entry across pages'; end if;
      seen := seen || page.id;
      cur_at := page.created_at;
      cur_id := page.id;
      n := n + 1;
    end loop;
    pages := pages + 1;
    exit when n < 7 or pages > 10;
  end loop;
  want := array(select id from public.activities where company_id = l order by created_at desc, id desc);
  if seen <> want or cardinality(seen) <> 25 or pages <> 4 then
    raise exception 'FAIL: keyset pages gave % entries in % pages (want 25 in order)', cardinality(seen), pages;
  end if;
  -- Filters, cut text, contact name, author.
  if (select count(*) from public.list_lead_activities(l, array['call'])) <> 5
     or (select count(*) from public.list_lead_activities(l, array['note', 'email'], null, null, 100)) <> 20
     or exists (select 1 from public.list_lead_activities(l, array['call']) x join public.activities a on a.id = x.id
                 where x.body <> left(a.body, 2000) or x.truncated <> (char_length(a.body) > 2000))
     or (select count(*) from public.list_lead_activities(l, array['call']) x where x.truncated) <> 3
     or (select contact_name from public.list_lead_activities(l, array['email'], null, null, 100) x where x.contact_id is not null)
        <> 'Timothée'
     or exists (select 1 from public.list_lead_activities(l, null, null, null, 100) x
                 where x.is_mine or x.undo_until is not null
                    or x.user_first_name is distinct from (case when x.type = 'call' then 'Dee' else 'Bo' end)) then
    raise exception 'FAIL: timeline filters, text, contact or author';
  end if;
  -- get_activity has the whole text ("Show more").
  if exists (select 1 from public.list_lead_activities(l, array['call']) x join public.activities a on a.id = x.id
              where public.get_activity(x.id) ->> 'body' <> a.body) then
    raise exception 'FAIL: get_activity should return the whole text';
  end if;
  -- My own fresh entry: mine, with an undo window; its follow-up shows as the task chip.
  r := public.log_activity(l, 'call', 'interested', null, null, null, (now() at time zone 'UTC')::date + 2, null, 'Follow up');
  select * into page from public.list_lead_activities(l, null, null, null, 1);
  if page.id <> (r ->> 'activity_id')::uuid or not page.is_mine or page.undo_until <> now() + interval '120 seconds'
     or page.task_title <> 'Follow up' or page.task_due_date <> (now() at time zone 'UTC')::date + 2
     or page.task_done_at is not null then
    raise exception 'FAIL: my fresh entry in the timeline %', row_to_json(page);
  end if;
  -- Bad input: a half cursor, a limit out of range, unknown or empty kinds (bad_types_22023).
  perform pg_temp.expect_error(format('select * from public.list_lead_activities(%L, null, now(), null)', l), '22023', 'bad_cursor');
  perform pg_temp.expect_error(format('select * from public.list_lead_activities(%L, null, null, %L)', l, gen_random_uuid()),
                               '22023', 'bad_cursor');
  perform pg_temp.expect_error(format('select * from public.list_lead_activities(%L, null, null, null, 0)', l), '22023', 'bounds');
  perform pg_temp.expect_error(format('select * from public.list_lead_activities(%L, null, null, null, 101)', l), '22023', 'bounds');
  perform pg_temp.expect_error(format('select * from public.list_lead_activities(%L, %L)', l, '{call,fax}'), '22023', 'bad_types');
  perform pg_temp.expect_error(format('select * from public.list_lead_activities(%L, %L)', l, '{}'), '22023', 'bad_types');
  perform pg_temp.expect_error(format('select * from public.list_lead_activities(%L, %L)', l, $q${"'); drop table x; --"}$q$),
                               '22023', 'bad_types');
  perform pg_temp.su();
end $$;

-- 9. get_lead, extended: next call, marks, zone, attempts, tasks, the import (admins only) ---------------------------
do $$
declare
  admin constant uuid := '00000000-0000-0000-0000-00000000000a';
  d1 constant uuid := '00000000-0000-0000-0000-0000000000d1';
  l uuid := pg_temp.new_lead(d1, 'warm', now() + interval '2 days', lead_name => 'Day4b get_lead');
  t_first uuid;
  g jsonb;
  batch uuid;
begin
  perform pg_temp.new_task(l, admin, 'call', (now() at time zone 'UTC')::date + 1);
  perform pg_temp.new_task(l, admin, 'todo', (now() at time zone 'UTC')::date + 5);
  perform pg_temp.new_task(l, admin, 'todo');
  perform pg_temp.new_task(l, d1, 'todo', (now() at time zone 'UTC')::date - 3);   -- d1's, earlier: only d1 and admins see it
  t_first := pg_temp.new_task(l, admin, 'call', (now() at time zone 'UTC')::date - 9);   -- done: not counted
  update public.tasks set done_at = now() where id = t_first;
  insert into public.import_batches (org_id, filename, uploaded_by) values (current_setting('t.main_org')::uuid,
    'day4b-sheet.csv', admin) returning id into batch;
  update public.companies set import_batch_id = batch where id = l;
  perform pg_temp.act(admin);
  g := public.get_lead(l);
  if (g ->> 'next_action_at')::timestamptz <> now() + interval '2 days' or g ->> 'phone_wrong_at' is not null
     or g ->> 'call_zone_key' <> 'Europe/Paris' or (g ->> 'can_set_timezone')::boolean or (g ->> 'attempts')::integer <> 0
     or (g ->> 'open_task_count')::integer <> 4 or g -> 'next_task' ->> 'due_date' <> ((now() at time zone 'UTC')::date - 3)::text
     or g -> 'import' ->> 'filename' <> 'day4b-sheet.csv' or (g -> 'import' ->> 'id')::uuid <> batch then
    raise exception 'FAIL: get_lead for an admin %', g;
  end if;
  -- A rep sees only the tasks the task rules show them, and no import.
  perform pg_temp.act('00000000-0000-0000-0000-0000000000b1');
  g := public.get_lead(l);
  if (g ->> 'open_task_count')::integer <> 0 or g -> 'next_task' <> 'null'::jsonb or g -> 'import' <> 'null'::jsonb
     or (g ->> 'can_edit')::boolean then
    raise exception 'FAIL: get_lead for a rep %', g;
  end if;
  perform pg_temp.act(d1);
  g := public.get_lead(l);
  if (g -> 'next_task' ->> 'assignee_id')::uuid <> d1 or (g ->> 'open_task_count')::integer <> 1 then
    raise exception 'FAIL: get_lead for the owner %', g;
  end if;
  perform pg_temp.su();
end $$;

-- 10. Changing and deleting entries through the RPCs (threats 4 and 8) -----------------------------------------------
do $$
declare
  admin constant uuid := '00000000-0000-0000-0000-00000000000a';
  d1 constant uuid := '00000000-0000-0000-0000-0000000000d1';
  b1 constant uuid := '00000000-0000-0000-0000-0000000000b1';
  l uuid := pg_temp.new_lead(d1, lead_name => 'Day4b edit and delete');
  e_note uuid;
  e_call uuid;
begin
  perform pg_temp.act(b1);
  e_note := public.log_activity(l, 'note', null, 'first words') ->> 'activity_id';
  e_call := public.log_activity(l, 'call', 'connected', 'spoke') ->> 'activity_id';
  -- note_edit_marks_edited: the author changes the text, CRLF folded, marked edited; a call's text can be emptied.
  perform public.edit_activity(e_note, E'better\r\nwords');
  perform public.edit_activity(e_call, '   ');
  if (select body from public.activities where id = e_note) <> E'better\nwords'
     or (select edited_at from public.activities where id = e_note) is null
     or (select body from public.activities where id = e_call) is not null then
    raise exception 'FAIL: edit_activity';
  end if;
  perform pg_temp.expect_error(format('select public.edit_activity(%L, %L)', e_note, ' '), '22023', 'body_required');
  perform pg_temp.expect_error(format('select public.edit_activity(%L, %L)', e_note, repeat('y', 10001)), '22023', 'body_too_long');
  perform pg_temp.expect_error(format('select public.edit_activity(%L, %L)', e_note, 'PLANTED-5150' || chr(8238)),
                               '22023', 'body_chars', 'PLANTED-5150');
  -- admin_cannot_edit_others_entry, and a missing entry.
  perform pg_temp.act(admin);
  perform pg_temp.expect_error(format('select public.edit_activity(%L, %L)', e_note, 'admin words'), '42501', 'not_editable');
  perform pg_temp.expect_error(format('select public.edit_activity(%L, %L)', gen_random_uuid(), 'x'), '42501', 'not_editable');
  -- delete_note_asks_for_code: no code or a stale one gives step_up first; the author with a fresh code deletes; an
  -- admin may delete a colleague's entry with a fresh code; a rep may not.
  perform pg_temp.act(b1, 'aal2', null);
  perform pg_temp.expect_error(format('select public.delete_activity(%L)', e_note), '42501', 'step_up');
  perform pg_temp.act(b1, 'aal2', 660);
  perform pg_temp.expect_error(format('select public.delete_activity(%L)', e_note), '42501', 'step_up');
  perform pg_temp.act(d1, 'aal2', 30);
  perform pg_temp.expect_error(format('select public.delete_activity(%L)', e_note), '42501');
  perform pg_temp.expect_error(format('select public.delete_activity(%L)', gen_random_uuid()), 'P0002');
  perform pg_temp.act(b1, 'aal2', 30);
  perform public.delete_activity(e_note);
  perform pg_temp.act(admin, 'aal2', 30);
  perform public.delete_activity(e_call);
  perform pg_temp.su();
  if exists (select 1 from public.activities where id in (e_note, e_call)) then
    raise exception 'FAIL: delete_activity left an entry';
  end if;
end $$;

-- 11. The next call date: editors set it, at most 2 years ahead, checked only when it changes ------------------------
do $$
declare
  d1 constant uuid := '00000000-0000-0000-0000-0000000000d1';
  l uuid := pg_temp.new_lead(d1, lead_name => 'Day4b next call');
  r jsonb;
begin
  perform pg_temp.act(d1);
  r := public.set_lead_next_action(l, now() + interval '20 days');
  if (r ->> 'next_action_at')::timestamptz <> now() + interval '20 days' then raise exception 'FAIL: set_lead_next_action %', r; end if;
  r := public.set_lead_next_action(l, now() - interval '20 days');   -- no lower limit
  r := public.set_lead_next_action(l, null);
  if r ->> 'next_action_at' is not null then raise exception 'FAIL: clearing the next call'; end if;
  perform pg_temp.expect_error(format('select public.set_lead_next_action(%L, %L)', l, now() + interval '2 years 1 day'),
                               '22023', 'bounds');
  perform pg_temp.expect_error(format('update public.companies set next_action_at = %L where id = %L',
                                      now() + interval '3 years', l), '22023', 'bounds');
  perform pg_temp.expect_error(format('select public.set_lead_next_action(%L, now())', gen_random_uuid()), 'P0002');
  perform pg_temp.act('00000000-0000-0000-0000-0000000000b1');
  perform pg_temp.expect_error(format('select public.set_lead_next_action(%L, now())', l), '42501');
  perform pg_temp.su();
  -- overdue_lead_still_editable: a date beyond the limit (set by maintenance, or kept since) never blocks an edit that
  -- leaves it alone.
  update public.companies set next_action_at = now() + interval '3 years' where id = l;
  perform pg_temp.act(d1);
  perform public.update_lead(l, 'Day4b next call renamed', d1, 'warm', '+33 1 99 00 10 01', null, null, 'FR');
  update public.companies set next_action_at = next_action_at where id = l;
  perform pg_temp.su();
  if (select name from public.companies where id = l) <> 'Day4b next call renamed' then
    raise exception 'FAIL: an overdue or far lead could not be edited';
  end if;
end $$;

-- 12. Entering Cool off without a future date: back in 90 days (cool_off_entry_defaults_90_days, design 3.2 rule 5) --
do $$
declare
  d1 constant uuid := '00000000-0000-0000-0000-0000000000d1';
  admin constant uuid := '00000000-0000-0000-0000-00000000000a';
  l uuid;
  l2 uuid;
  until constant timestamptz := date_trunc('day', now()) + interval '45 days';
  batch uuid;
  r jsonb;
begin
  perform pg_temp.act(d1);
  l := public.create_lead('Day4b cool off new', null, 'cool_off');
  if (select next_action_at from public.companies where id = l) <> now() + interval '90 days' then
    raise exception 'FAIL: a new Cool off lead has no return date';
  end if;
  insert into public.companies (name, lead_status) values ('Day4b cool off direct', 'cool_off') returning id into l;
  if (select next_action_at from public.companies where id = l) <> now() + interval '90 days' then
    raise exception 'FAIL: a direct Cool off insert has no return date';
  end if;
  -- The edit form: from no date, or from an old (past) retry date, the lead comes back in 90 days; a future date stays.
  l := public.create_lead('Day4b cool off edit', null, 'cold');
  perform public.update_lead(l, 'Day4b cool off edit', d1, 'cool_off', null, null, null, null);
  if (select next_action_at from public.companies where id = l) <> now() + interval '90 days' then
    raise exception 'FAIL: Cool off from the edit form (no date)';
  end if;
  perform public.update_lead(l, 'Day4b cool off edit', d1, 'cold', null, null, null, null);
  perform public.set_lead_next_action(l, now() - interval '3 days');
  perform public.update_lead(l, 'Day4b cool off edit', d1, 'cool_off', null, null, null, null);
  if (select next_action_at from public.companies where id = l) <> now() + interval '90 days' then
    raise exception 'FAIL: Cool off with a past retry date would come back at once';
  end if;
  perform public.update_lead(l, 'Day4b cool off edit', d1, 'cold', null, null, null, null);
  perform public.set_lead_next_action(l, now() + interval '5 days');
  perform public.update_lead(l, 'Day4b cool off edit', d1, 'cool_off', null, null, null, null);
  if (select next_action_at from public.companies where id = l) <> now() + interval '5 days' then
    raise exception 'FAIL: a future date set before should stay';
  end if;
  -- Only entering Cool off sets the default: a Cool off lead's date can be cleared (it then waits, design D5).
  perform public.set_lead_next_action(l, null);
  if (select next_action_at from public.companies where id = l) is not null then
    raise exception 'FAIL: clearing a Cool off lead''s date put a default back';
  end if;
  -- bulk_update_cool_off_with_date: "Until when?" sets the date for every lead; without it, 90 days; only with Cool off.
  l := public.create_lead('Day4b bulk one', null, 'cold');
  l2 := public.create_lead('Day4b bulk two', null, 'warm');
  if public.bulk_update_leads(array[l, l2], 'cool_off', false, null, until) <> 2 then
    raise exception 'FAIL: Cool off until a date changed the wrong number of leads';
  end if;
  if (select count(*) from public.companies where id in (l, l2) and next_action_at = until and lead_status = 'cool_off') <> 2 then
    raise exception 'FAIL: Cool off until a date';
  end if;
  perform public.bulk_update_leads(array[l], 'cold');
  perform public.set_lead_next_action(l, null);
  perform public.bulk_update_leads(array[l], 'cool_off');
  if (select next_action_at from public.companies where id = l) <> now() + interval '90 days' then
    raise exception 'FAIL: bulk Cool off without a date';
  end if;
  perform pg_temp.expect_error(format('select public.bulk_update_leads(array[%L]::uuid[], %L, false, null, %L)', l, 'warm', until),
                               '22023', 'until_cool_off_only');
  perform pg_temp.expect_error(format('select public.bulk_update_leads(array[%L]::uuid[], null, true, %L, %L)', l, d1, until),
                               '22023', 'until_cool_off_only');
  perform pg_temp.expect_error(format('select public.bulk_update_leads(array[%L]::uuid[], %L, false, null, %L)', l, 'cool_off',
                                      now() + interval '3 years'), '22023', 'bounds');
  -- A return date that is not in the future is refused (lead_guard keeps a past date a statement writes, for undo).
  perform pg_temp.expect_error(format('select public.bulk_update_leads(array[%L]::uuid[], %L, false, null, %L)', l, 'cool_off',
                                      now() - interval '1 day'), '22023', 'bounds');
  perform pg_temp.expect_error(format('select public.bulk_update_leads(array[%L]::uuid[], %L, false, null, %L)', l, 'cool_off',
                                      now()), '22023', 'bounds');
  -- The Day 3a calls without the new argument still work.
  if public.bulk_update_leads(array[l], p_status => 'warm') <> 1 then raise exception 'FAIL: Day 3a bulk call'; end if;
  -- An imported Cool off row comes back in 90 days too.
  perform pg_temp.act(admin);
  batch := public.create_lead_import('day4b-cool-off.csv', null, 1, 2);
  perform public.stage_lead_import_rows(batch, '[{"row_no": 2, "name": "Day4b Imported Cool Off", "lead_status": "cool_off"}]');
  perform public.validate_lead_import(batch);
  r := public.commit_lead_import(batch);
  if r ->> 'status' <> 'imported'
     or (select next_action_at from public.companies where import_batch_id = batch) <> now() + interval '90 days'
     or (select updated_at = created_at from public.companies where import_batch_id = batch) is not true then
    raise exception 'FAIL: an imported Cool off lead % (and it must stay untouched for import undo)', r;
  end if;
  perform pg_temp.su();
  -- Maintenance sessions get the rule too (it is not limited to people).
  l := pg_temp.new_lead(d1, 'cool_off');
  if (select next_action_at from public.companies where id = l) <> now() + interval '90 days' then
    raise exception 'FAIL: a Cool off lead made by maintenance has no return date';
  end if;
  -- A new Cool off lead with a past date (an old retry date in a sheet) comes back in 90 days, not at once.
  l := pg_temp.new_lead(d1, 'cool_off', now() - interval '3 days');
  if (select next_action_at from public.companies where id = l) <> now() + interval '90 days' then
    raise exception 'FAIL: a new Cool off lead with a past date would come back at once';
  end if;
end $$;

-- 13. Tasks through the RPCs: create (idempotent), done and dismissed as switches with server times, the lead's list -
do $$
declare
  admin constant uuid := '00000000-0000-0000-0000-00000000000a';
  d1 constant uuid := '00000000-0000-0000-0000-0000000000d1';
  b1 constant uuid := '00000000-0000-0000-0000-0000000000b1';
  l uuid := pg_temp.new_lead(d1, lead_name => 'Day4b tasks');
  k uuid := pg_temp.new_contact(l);
  other uuid := pg_temp.new_lead(d1, lead_name => 'Day4b other lead');
  req constant uuid := gen_random_uuid();
  t1 uuid;
  t2 uuid;
  t3 uuid;
  r jsonb;
  r2 jsonb;
  ids uuid[];
begin
  perform pg_temp.act(d1);
  t1 := public.create_task('Call the buyer', l, k, 'call', (now() at time zone 'Europe/Paris')::date + 2, null, null, req);
  if public.create_task('Call the buyer again', l, null, 'todo', null, null, null, req) <> t1
     or (select count(*) from public.tasks where created_by = d1 and request_id = req) <> 1
     or (select assignee_id || ' ' || contact_id || ' ' || kind from public.tasks where id = t1) <> d1 || ' ' || k || ' call' then
    raise exception 'FAIL: create_task or its replay';
  end if;
  t2 := public.create_task('Meet', l, null, 'meeting', null, now() + interval '3 hours');
  t3 := public.create_task('Personal note to self');
  perform pg_temp.expect_error(format('select public.create_task(%L, %L, %L)', 'x', other, k), 'P0002');     -- contact of another lead
  perform pg_temp.expect_error(format('select public.create_task(%L, null, %L)', 'x', k), 'P0002');         -- contact without its lead
  perform pg_temp.expect_error(format('select public.create_task(%L, %L)', 'x', gen_random_uuid()), 'P0002');
  perform pg_temp.expect_error(format('select public.create_task(%L, %L, null, %L, null, null, %L)', 'x', l, 'todo', admin), '42501');
  perform pg_temp.expect_error(format('select public.create_task(%L, %L, null, %L)', 'x', l, 'meeting'), '22023', 'task_due');
  perform pg_temp.expect_error(format('select public.create_task(%L, %L, null, %L)', 'x', l, 'chore'), '22023', 'task_kind');
  perform pg_temp.expect_error(format('select public.create_task(%L, %L)', ' ', l), '22023', 'task_title');
  -- task_done_at_is_server_time, as a switch: done twice keeps the first time; undone empties it; done while dismissed
  -- is refused.
  r := public.set_task_done(t1, true);
  r2 := public.set_task_done(t1, true);
  if (r ->> 'done_at')::timestamptz <> now() or r2 <> r or (r ->> 'completed_by')::uuid <> d1 then
    raise exception 'FAIL: set_task_done % then %', r, r2;
  end if;
  r := public.set_task_done(t1, false);
  if r ->> 'done_at' is not null or r ->> 'completed_by' is not null then raise exception 'FAIL: undone %', r; end if;
  r := public.set_task_cancelled(t2, true);
  if (r ->> 'cancelled_at')::timestamptz <> now() then raise exception 'FAIL: set_task_cancelled %', r; end if;
  perform pg_temp.expect_error(format('select public.set_task_done(%L, true)', t2), '22023', 'state');
  perform pg_temp.expect_error(format('select public.set_task_done(%L, null)', t2), '22023', 'state');
  perform pg_temp.expect_error(format('select public.set_task_done(%L, true)', gen_random_uuid()), 'P0002');
  r := public.set_task_cancelled(t2, false);
  if r ->> 'cancelled_at' is not null then raise exception 'FAIL: un-dismiss %', r; end if;
  -- list_lead_tasks: open ones by due time (the meeting in 3 hours before the call in 2 days), undated last; done ones only
  -- when asked; dismissed never; other people's only for those the task rules allow.
  perform public.set_task_done(public.create_task('Done already', l), true);
  perform public.set_task_cancelled(public.create_task('Dismissed', l), true);
  perform public.create_task('Undated', l);
  ids := array(select x.id from public.list_lead_tasks(l) x);
  if cardinality(ids) <> 3 or ids[1] <> t2 or ids[2] <> t1
     or (select title from public.tasks where id = ids[3]) <> 'Undated'
     or (select count(*) from public.list_lead_tasks(l, true)) <> 4
     or (select count(*) from public.list_lead_tasks(l, false, 1)) <> 1
     or (select contact_name from public.list_lead_tasks(l) x where x.id = t1) <> 'Fakey' then
    raise exception 'FAIL: list_lead_tasks %', ids;
  end if;
  perform pg_temp.expect_error(format('select * from public.list_lead_tasks(%L, false, 0)', l), '22023', 'bounds');
  perform pg_temp.act(b1);
  if (select count(*) from public.list_lead_tasks(l, true)) <> 0 then raise exception 'FAIL: a rep listed another''s tasks'; end if;
  perform pg_temp.expect_error(format('select public.set_task_done(%L, true)', t1), 'P0002');
  perform pg_temp.act(admin);
  if (select count(*) from public.list_lead_tasks(l, true)) <> 4 then raise exception 'FAIL: an admin lists every task'; end if;
  perform pg_temp.su();
  if (select assignee_id from public.tasks where id = t3) <> d1 or (select company_id from public.tasks where id = t3) is not null then
    raise exception 'FAIL: a personal task';
  end if;
end $$;

-- 14. Audit: outcome status changes are logged; next call and wrong-number marks are not diffed; the zone is (threat 30)
do $$
declare
  admin constant uuid := '00000000-0000-0000-0000-00000000000a';
  d1 constant uuid := '00000000-0000-0000-0000-0000000000d1';
  l uuid := pg_temp.new_lead(d1, lead_name => 'Day4b audit');
  us uuid := pg_temp.new_lead(d1, country => 'US', lead_name => 'Day4b audit US');
  before_count bigint;
begin
  perform pg_temp.act(admin);
  perform public.log_activity(l, 'call', 'not_interested');
  perform public.log_activity(l, 'call', 'wrong_number', null, null, 'lead', null, null, 'Find');
  perform pg_temp.su();
  -- audit_outcome_status_change_logged, audit_queue_columns_not_diffed.
  if not exists (select 1 from public.audit_log where table_name = 'companies' and record_id = l::text and action = 'update'
                   and diff_json -> 'lead_status' = '{"old": "cold", "new": "cool_off"}'::jsonb and actor_id = admin)
     or exists (select 1 from public.audit_log where table_name = 'companies' and record_id = l::text and action = 'update'
                  and (diff_json ? 'next_action_at' or diff_json ? 'phone_wrong_at')) then
    raise exception 'FAIL: audit of an outcome';
  end if;
  select count(*) into before_count from public.audit_log where record_id in (l::text, us::text);
  perform pg_temp.act(d1);
  perform public.set_lead_next_action(l, now() + interval '7 days');
  update public.companies set phone_wrong_at = null where id = l;
  perform pg_temp.su();
  if (select count(*) from public.audit_log where record_id in (l::text, us::text)) <> before_count then
    raise exception 'FAIL: a next call or mark change was audited';
  end if;
  perform pg_temp.act(d1);
  perform public.set_lead_timezone(us, 'America/Denver');
  perform pg_temp.su();
  if not exists (select 1 from public.audit_log where record_id = us::text and diff_json -> 'timezone' ->> 'new' = 'America/Denver') then
    raise exception 'FAIL: a zone change must be audited';
  end if;
end $$;

-- 15. Flood guards reach log_activity and create_task (threat 32): rep g1 with 60 entries and 60 tasks in the last minute
do $$
declare
  g1 constant uuid := '00000000-0000-0000-0000-0000000000a9';
  l uuid := pg_temp.new_lead(g1, lead_name => 'Day4b flood');
begin
  insert into public.activities (org_id, company_id, type, body, user_id)
  select org_id, l, 'note', 'flood ' || n, g1 from public.companies, generate_series(1, 60) n where id = l;
  perform pg_temp.act(g1);
  perform pg_temp.expect_error(format('select public.log_activity(%L, %L, null, %L)', l, 'note', 'one more'), '22023', 'rate_limited');
  perform pg_temp.su();
  insert into public.tasks (org_id, company_id, title, assignee_id, created_by)
  select org_id, l, 'flood ' || n, g1, g1 from public.companies, generate_series(1, 60) n where id = l;
  perform pg_temp.act(g1);
  perform pg_temp.expect_error(format('select public.create_task(%L, %L)', 'one more', l), '22023', 'rate_limited');
  perform pg_temp.su();
  if (select count(*) from public.activities where company_id = l) <> 60 then
    raise exception 'FAIL: a refused entry was kept';
  end if;
end $$;

-- 16. log_activity's input rules, all constant errors (threats 27 and 29) -----------------------------------------------
do $$
declare
  admin constant uuid := '00000000-0000-0000-0000-00000000000a';
  l uuid := pg_temp.new_lead('00000000-0000-0000-0000-0000000000d1', lead_name => 'Day4b input rules');
  other_lead uuid := pg_temp.new_lead('00000000-0000-0000-0000-0000000000d1');
  other_k uuid := pg_temp.new_contact(other_lead);
  today_west constant date := ((now() at time zone 'UTC') - interval '12 hours')::date;
  today_east constant date := ((now() at time zone 'UTC') + interval '14 hours')::date;
  q constant text := 'select public.log_activity(%L, %L, %L, %L, %L, null, %L, %L, %L)';
begin
  perform pg_temp.act(admin);
  -- Kind and outcome.
  perform pg_temp.expect_error(format(q, l, 'call', null, null, null, null, null, null), '22023', 'outcome');
  perform pg_temp.expect_error(format(q, l, 'call', 'sent', null, null, null, null, null), '22023', 'outcome');
  perform pg_temp.expect_error(format(q, l, 'note', 'sent', 'x', null, null, null, null), '22023', 'outcome');
  perform pg_temp.expect_error(format(q, l, 'email', 'held', null, null, null, null, null), '22023', 'outcome');
  perform pg_temp.expect_error(format(q, l, 'fax', null, null, null, null, null, null), '22023', 'outcome');
  perform pg_temp.expect_error(format(q, l, null, null, null, null, null, null, null), '22023', 'outcome');
  -- Text: a note needs some; at most 10,000 characters; no hidden controls (constant errors, no text in the log).
  perform pg_temp.expect_error(format(q, l, 'note', null, E' \n\t ', null, null, null, null), '22023', 'body_required');
  perform pg_temp.expect_error(format(q, l, 'note', null, repeat('z', 10001), null, null, null, null), '22023', 'body_too_long');
  perform pg_temp.expect_error(format(q, l, 'note', null, 'PLANTED-9042' || chr(8238) || 'x', null, null, null, null),
                               '22023', 'body_chars', 'PLANTED-9042');
  -- Follow-ups.
  perform pg_temp.expect_error(format(q, l, 'call', 'interested', null, null, null, null, 'Follow up'), '22023', 'follow_up_required');
  perform pg_temp.expect_error(format(q, l, 'call', 'meeting_booked', null, null, today_east + 1, null, 'Meeting'),
                               '22023', 'follow_up_required');
  perform pg_temp.expect_error(format(q, l, 'meeting', null, null, null, today_east + 1, null, 'Meeting'), '22023', 'follow_up_required');
  perform pg_temp.expect_error(format(q, l, 'call', 'interested', null, null, today_east + 1, now() + interval '1 day', 'F'),
                               '22023', 'follow_up_range');
  perform pg_temp.expect_error(format(q, l, 'call', 'no_answer', null, null, today_east + 1, null, 'F'), '22023', 'follow_up_range');
  perform pg_temp.expect_error(format(q, l, 'call', 'do_not_contact', null, null, null, now() + interval '1 day', 'F'),
                               '22023', 'follow_up_range');
  perform pg_temp.expect_error(format(q, l, 'call', 'interested', null, null, today_west - 1, null, 'F'), '22023', 'follow_up_range');
  perform pg_temp.expect_error(format(q, l, 'call', 'interested', null, null, today_east + 367, null, 'F'), '22023', 'follow_up_range');
  perform pg_temp.expect_error(format(q, l, 'call', 'interested', null, null, null, now() - interval '6 minutes', 'F'),
                               '22023', 'follow_up_range');
  perform pg_temp.expect_error(format(q, l, 'call', 'interested', null, null, null, now() + interval '367 days', 'F'),
                               '22023', 'follow_up_range');
  -- The edges are accepted: today anywhere on earth, a year ahead anywhere, a time from 5 minutes ago.
  perform public.log_activity(l, 'call', 'interested', null, null, null, today_west, null, 'F');
  perform public.log_activity(l, 'call', 'interested', null, null, null, today_east + 366, null, 'F');
  perform public.log_activity(l, 'call', 'meeting_booked', null, null, null, null, now() - interval '4 minutes', 'M');
  -- The follow-up's title.
  perform pg_temp.expect_error(format(q, l, 'call', 'interested', null, null, today_east + 1, null, null), '22023', 'task_title');
  perform pg_temp.expect_error(format(q, l, 'call', 'interested', null, null, today_east + 1, null, '   '), '22023', 'task_title');
  perform pg_temp.expect_error(format(q, l, 'call', 'connected', null, null, today_east + 1, null, null), '22023', 'task_title');
  perform pg_temp.expect_error(format('select public.log_activity(%L, %L, %L, null, null, %L)', l, 'call', 'wrong_number', 'lead'),
                               '22023', 'task_title');
  perform pg_temp.expect_error(format('select public.log_activity(%L, %L, %L, null, null, %L)', other_lead, 'call',
                                      'wrong_number', 'lead'), '22023', 'task_title');   -- a working contact: no task, title still needed
  perform pg_temp.expect_error(format(q, l, 'call', 'interested', null, null, today_east + 1, null, 'PLANTED-3141' || chr(7)),
                               '22023', 'task_title', 'PLANTED-3141');
  -- Lead and contact: missing, or a contact of another lead (P0002).
  perform pg_temp.expect_error(format(q, gen_random_uuid(), 'note', null, 'x', null, null, null, null), 'P0002');
  perform pg_temp.expect_error(format(q, null, 'note', null, 'x', null, null, null, null), 'P0002');
  perform pg_temp.expect_error(format(q, l, 'note', null, 'x', other_k, null, null, null), 'P0002');
  perform pg_temp.su();
  -- A refused log left nothing behind (each refusal rolled back its whole call).
  if (select count(*) from public.activities where company_id = l) <> 3 or (select count(*) from public.tasks where company_id = l) <> 3 then
    raise exception 'FAIL: refused calls left entries or tasks';
  end if;
end $$;

-- 17. Another organisation sees and changes none of this (threat 2) ---------------------------------------------------
do $$
declare
  l uuid := current_setting('t.replay_lead')::uuid;
  e uuid := (select id from public.activities where company_id = current_setting('t.replay_lead')::uuid
              and user_id = '00000000-0000-0000-0000-0000000000b1' limit 1);
  t uuid := (select id from public.tasks where company_id = current_setting('t.replay_lead')::uuid limit 1);
begin
  perform pg_temp.act('00000000-0000-0000-0000-0000000000c1');
  if public.get_lead(l) is not null or public.get_activity(e) is not null
     or exists (select 1 from public.list_lead_activities(l)) or exists (select 1 from public.list_lead_tasks(l, true)) then
    raise exception 'FAIL: other_org: read a lead, an entry or a task';
  end if;
  perform pg_temp.expect_error(format('select public.log_activity(%L, %L, null, %L)', l, 'note', 'x'), 'P0002');
  perform pg_temp.expect_error(format('select public.undo_activity(%L)', e), '22023', 'undo_expired');
  perform pg_temp.expect_error(format('select public.edit_activity(%L, %L)', e, 'x'), '42501', 'not_editable');
  perform pg_temp.expect_error(format('select public.delete_activity(%L)', e), 'P0002');
  perform pg_temp.expect_error(format('select public.set_lead_timezone(%L, null)', l), 'P0002');
  perform pg_temp.expect_error(format('select public.set_lead_next_action(%L, null)', l), 'P0002');
  perform pg_temp.expect_error(format('select public.set_task_done(%L, true)', t), 'P0002');
  perform pg_temp.expect_error(format('select public.create_task(%L, %L)', 'x', l), 'P0002');
  if public.bulk_update_leads(array[l], 'customer') <> 0 then raise exception 'FAIL: other_org: bulk change'; end if;
  if exists (select 1 from private.activity_undo) then raise exception 'FAIL: other_org: read undo records'; end if;
  perform pg_temp.su();
end $$;

\echo 'outcome_attack: all checks passed'
