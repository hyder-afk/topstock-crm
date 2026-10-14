-- Day 5c attack and behaviour tests: the Home dashboard's figures (design docs/evidence/day5/design.md sections 3.3, 4.3,
-- 5.8, 6 threats 1, 2, 18 and 24, 8.1 "5c"; migration 20261015150000_home_dashboard.sql). Runs last in
-- scripts/db-test.sh (CI job "rls"), after the earlier files, on the same database.
-- A separate org ("Home Org": admin Hana, reps Hugo and Hiro) holds the fixture, so its figures are exact numbers that
-- nothing else in the database can change, and so the TopStock org's rows prove that no figure crosses orgs. In the
-- TopStock org the figures are checked against a hand count of the rows (admin a: the org; rep r1: their own).
-- Probes run as a signed-in user through the API role. Each scenario runs in one block that is rolled back at the end
-- (raise TS001, caught); inside one block now() is one instant, so data is placed relative to it (the caller's day
-- start a second before and after, the month start a minute before and after); the day and month rule itself is
-- checked at fixed instants (31 Oct 2026 21:30 UTC is November in Karachi and October in Paris; 25 Oct 2026 is a
-- 25-hour day in Paris and 29 Mar 2026 a 23-hour one).
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
-- Fixture rows are written by the superuser with the tables' own triggers off (as earlier files do; foreign keys stay
-- on): no guard, no history row, no "last activity" touch, so every stage clock, close time and lead activity is
-- exactly as written. Inside a block the change is rolled back with it.
create function pg_temp.raw(on_ boolean) returns void
language plpgsql as $$
begin
  if on_ then
    alter table public.companies disable trigger user;
    alter table public.deals disable trigger user;
    alter table public.deal_stage_history disable trigger user;
    alter table public.activities disable trigger user;
    alter table public.tasks disable trigger user;
  else
    alter table public.companies enable trigger user;
    alter table public.deals enable trigger user;
    alter table public.deal_stage_history enable trigger user;
    alter table public.activities enable trigger user;
    alter table public.tasks enable trigger user;
  end if;
end;
$$;
-- A lead of `owner`'s org, created `age` ago, with its last activity `quiet` ago (null: never).
create function pg_temp.lead(owner uuid, age interval default interval '30 days', quiet interval default null,
                             batch uuid default null) returns uuid
language sql as $$
  insert into public.companies (org_id, name, owner_id, lead_status, country, created_at, last_activity_at, import_batch_id)
  select p.org_id, 'Home lead', owner, 'warm', 'FR', now() - age, now() - quiet, batch from public.profiles p where p.id = owner
  returning id
$$;
-- A deal of `owner` on a new lead (or `on_lead`), at `stage`, its clock `entered` ago. Closed stages take the status,
-- close time and what a closed deal needs.
create function pg_temp.deal(owner uuid, stage text, val numeric default null, entered interval default interval '1 hour',
                             close_on date default null, closed timestamptz default null, reason text default null,
                             on_lead uuid default null) returns uuid
language sql as $$
  insert into public.deals (org_id, company_id, stage_id, owner_id, created_by, title, value, status, stage_entered_at,
                            closed_at, expected_close, fulfilment, lost_reason, lost_note)
  select p.org_id, coalesce(on_lead, pg_temp.lead(owner)), s.id, owner, owner, 'Home deal', val,
         case stage when 'won' then 'won' when 'lost' then 'lost' else 'open' end, now() - entered,
         case when stage in ('won', 'lost') then coalesce(closed, now()) end, close_on,
         case when stage = 'won' then 'from_stock' end, case when stage = 'lost' then coalesce(reason, 'price') end,
         case when stage = 'lost' then 'SECRET-NOTE planted' end
    from public.profiles p join public.pipeline_stages s on s.org_id = p.org_id and s.key = stage
   where p.id = owner
  returning id
$$;
create function pg_temp.call(who uuid, at_ timestamptz, outcome text default 'no_answer', kind text default 'call',
                             on_lead uuid default null) returns uuid
language sql as $$
  insert into public.activities (org_id, company_id, user_id, type, outcome, body, created_at)
  select p.org_id, coalesce(on_lead, pg_temp.lead(who)), who, kind, case when kind = 'note' then null else outcome end,
         'SECRET-BODY planted', at_
    from public.profiles p where p.id = who
  returning id
$$;
create function pg_temp.task(who uuid, due_date date default null, due_at timestamptz default null,
                             kind text default 'todo', done boolean default false, cancelled boolean default false)
returns uuid language sql as $$
  insert into public.tasks (org_id, assignee_id, created_by, title, kind, due_date, due_at, done_at, cancelled_at)
  select p.org_id, who, who, 'Home task', kind, due_date, due_at, case when done then now() end,
         case when cancelled then now() end
    from public.profiles p where p.id = who
  returning id
$$;
-- The caller's day and month as home_summary sees them (zone from the profile).
create function pg_temp.win(who uuid) returns record
language sql as $$
  select h from private.home_window(now(), coalesce(nullif((select timezone from public.profiles where id = who), ''),
                                                     'Europe/Paris')) h
$$;

-- Fixture: Home Org with its five stages (copied from the TopStock org's), admin Hana (5c0), reps Hugo (5c1) and Hiro
-- (5c2). Committed: the database is thrown away after the run.
do $$ begin perform set_config('request.jwt.claims', '', false); end $$;
insert into public.orgs (id, name) values ('00000000-0000-0000-0000-0000000005cc', 'Home Org');
insert into public.pipeline_stages (org_id, name, position, is_won, is_lost, key, stall_days)
select '00000000-0000-0000-0000-0000000005cc', s.name, s.position, s.is_won, s.is_lost, s.key, s.stall_days
  from public.pipeline_stages s join public.orgs o on o.id = s.org_id and o.name = 'TopStock Wholesale';
insert into auth.users (id, email, raw_user_meta_data) values
  ('00000000-0000-0000-0000-0000000005c0', 'home5c0@test.invalid', '{"first_name":"Hana"}'),
  ('00000000-0000-0000-0000-0000000005c1', 'home5c1@test.invalid', '{"first_name":"Hugo"}'),
  ('00000000-0000-0000-0000-0000000005c2', 'home5c2@test.invalid', '{"first_name":"Hiro"}');
insert into public.import_batches (id, org_id, filename, file_sha256)
values ('00000000-0000-0000-0000-0000000005cb', '00000000-0000-0000-0000-0000000005cc', 'home.csv', repeat('a', 64));
update public.profiles set org_id = '00000000-0000-0000-0000-0000000005cc', timezone = 'Europe/Paris',
       role = case id when '00000000-0000-0000-0000-0000000005c0' then 'admin'::public.app_role else 'rep'::public.app_role end
 where id in ('00000000-0000-0000-0000-0000000005c0', '00000000-0000-0000-0000-0000000005c1',
              '00000000-0000-0000-0000-0000000005c2');
do $$ begin
  if (select count(*) from public.pipeline_stages where org_id = '00000000-0000-0000-0000-0000000005cc') <> 5
     or (select count(*) from public.profiles where org_id = '00000000-0000-0000-0000-0000000005cc') <> 3
     or (select count(*) from public.profiles where id in ('00000000-0000-0000-0000-00000000000a',
           '00000000-0000-0000-0000-0000000005a1')) <> 2 then
    raise exception 'FAIL: Day 5c fixture (run after deals_attack.sql)';
  end if;
end $$;

-- 0. What the database itself says (threats 1, 18; design 3.3) -----------------------------------------------------------
do $$
declare
  f record;
  n integer;
begin
  -- Every Home function: SECURITY INVOKER, search_path '', callable by signed-in people only, static SQL.
  for f in select p.oid, p.oid::regprocedure::text as sig, p.prosecdef, p.proconfig, p.prosrc
             from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where (n.nspname = 'public' and p.proname in ('home_summary', 'home_attention', 'home_recent_activity',
                                                         'home_low_stock'))
               or (n.nspname = 'private' and p.proname in ('home_window', 'home_open_deals')) loop
    if f.prosecdef or not (f.proconfig @> array['search_path=""'])
       or not has_function_privilege('authenticated', f.oid, 'EXECUTE')
       or has_function_privilege('anon', f.oid, 'EXECUTE') or has_function_privilege('public', f.oid, 'EXECUTE')
       or f.prosrc ~* '\mexecute\M' or f.prosrc ~* 'format\s*\(' then
      raise exception 'FAIL: Home function rules broken by %', f.sig;
    end if;
  end loop;
  select count(*) into n from pg_proc p join pg_namespace s on s.oid = p.pronamespace
   where (s.nspname = 'public' and p.proname in ('home_summary', 'home_attention', 'home_recent_activity',
                                                'home_low_stock', 'home_today_tasks'))
      or (s.nspname = 'private' and p.proname in ('home_window', 'home_open_deals'));
  -- Six: the 5c stand-in home_today_tasks is gone since the 4c rebase (the Today card reads Day 4c's list_tasks).
  perform pg_temp.eq('Home functions', n, 6);
  -- recent_activity_has_no_body: the feed's columns are fixed by its return type, and none is an entry's text or a note.
  perform pg_temp.eq('home_recent_activity columns',
    (select array_to_string(p.proargnames[2:], ',') from pg_proc p where p.oid = 'public.home_recent_activity(text, integer)'::regprocedure),
    'p_limit,item_id,kind,type,outcome,to_stage,value,company_id,company_name,user_first_name,at');
  if (select p.prosrc from pg_proc p where p.oid = 'public.home_recent_activity(text, integer)'::regprocedure)
       ~* '\m(body|lost_note)\M' then
    raise exception 'FAIL: home_recent_activity reads an entry''s text or a lost note';
  end if;
  -- No view or materialised view came with the Home figures (they would bypass the row rules).
  if exists (select 1 from pg_class c join pg_namespace s on s.oid = c.relnamespace
              where s.nspname in ('public', 'private') and c.relkind in ('v', 'm')) then
    raise exception 'FAIL: a view or materialised view exists';
  end if;
  -- home_low_stock_stub_null: the stub (Day 6 replaces it) answers null.
  perform pg_temp.act('00000000-0000-0000-0000-0000000005c0');
  if public.home_low_stock() is not null or public.home_low_stock(3) is not null then
    raise exception 'FAIL: home_low_stock_stub_null';
  end if;
  perform pg_temp.su();
end $$;

-- 1. The caller's day and month at fixed instants (threat 24; mutations "month start in UTC", "day end = start + 24 h")
do $$
declare
  w record;
begin
  -- kpi_month_boundary_karachi_vs_paris: 31 Oct 2026 21:30 UTC is 1 Nov 02:30 in Karachi and 31 Oct 22:30 in Paris.
  select * into w from private.home_window('2026-10-31 21:30:00+00', 'Asia/Karachi');
  perform pg_temp.eq('Karachi today', w.today, date '2026-11-01');
  perform pg_temp.eq('Karachi day start', w.day_start, timestamptz '2026-10-31 19:00:00+00');
  perform pg_temp.eq('Karachi day end', w.day_end, timestamptz '2026-11-01 19:00:00+00');
  perform pg_temp.eq('Karachi month start', w.month_start, timestamptz '2026-10-31 19:00:00+00');
  select * into w from private.home_window('2026-10-31 21:30:00+00', 'Europe/Paris');
  perform pg_temp.eq('Paris today', w.today, date '2026-10-31');
  perform pg_temp.eq('Paris day start', w.day_start, timestamptz '2026-10-30 23:00:00+00');
  perform pg_temp.eq('Paris day end', w.day_end, timestamptz '2026-10-31 23:00:00+00');
  perform pg_temp.eq('Paris month start (summer time on 1 Oct)', w.month_start, timestamptz '2026-09-30 22:00:00+00');
  -- 25 Oct 2026: clocks go back in Paris, a 25-hour day; it stays one day.
  select * into w from private.home_window('2026-10-25 12:00:00+00', 'Europe/Paris');
  perform pg_temp.eq('25 Oct today', w.today, date '2026-10-25');
  perform pg_temp.eq('25 Oct day start', w.day_start, timestamptz '2026-10-24 22:00:00+00');
  perform pg_temp.eq('25 Oct day end (25 hours later)', w.day_end, timestamptz '2026-10-25 23:00:00+00');
  -- 29 Mar 2026: clocks go forward in Paris, a 23-hour day.
  select * into w from private.home_window('2026-03-29 12:00:00+00', 'Europe/Paris');
  perform pg_temp.eq('29 Mar day start', w.day_start, timestamptz '2026-03-28 23:00:00+00');
  perform pg_temp.eq('29 Mar day end (23 hours later)', w.day_end, timestamptz '2026-03-29 22:00:00+00');
  perform pg_temp.eq('29 Mar month start', w.month_start, timestamptz '2026-02-28 23:00:00+00');
  -- Karachi has no clock change: the same week is 24-hour days.
  select * into w from private.home_window('2026-10-25 12:00:00+00', 'Asia/Karachi');
  perform pg_temp.eq('Karachi 25 Oct day start', w.day_start, timestamptz '2026-10-24 19:00:00+00');
  perform pg_temp.eq('Karachi 25 Oct day end', w.day_end, timestamptz '2026-10-25 19:00:00+00');
  -- The first of a month is its own month start.
  select * into w from private.home_window('2026-11-01 00:30:00+00', 'Europe/Paris');
  perform pg_temp.eq('1 Nov month start', w.month_start, timestamptz '2026-10-31 23:00:00+00');
end $$;

-- 2. Signed in without two-factor, or not signed in (threat 1: home_aal1_blocked) --------------------------------------
do $$
declare
  stmt text;
begin
  perform pg_temp.act('00000000-0000-0000-0000-0000000005c0', 'aal1', null);
  foreach stmt in array array['select public.home_summary(''mine'')', 'select public.home_attention(''mine'')',
                              'select * from public.home_recent_activity(''mine'')'] loop
    perform pg_temp.expect_error(stmt, '42501');
  end loop;
  perform pg_temp.su();
  perform set_config('role', 'anon', false);
  foreach stmt in array array['select public.home_summary(''mine'')', 'select public.home_attention(''mine'')',
                              'select * from public.home_recent_activity(''mine'')', 'select public.home_low_stock()'] loop
    perform pg_temp.expect_error(stmt, '42501');  -- permission denied: anon has no EXECUTE
  end loop;
  perform pg_temp.su();
end $$;

-- 3. Scope and bounds (threat 18: rep_team_scope_42501; threat 28: bad_scope_22023, limit_bounds_22023) -----------------
do $$
declare
  stmt text;
begin
  perform pg_temp.act('00000000-0000-0000-0000-0000000005c1');  -- rep Hugo
  foreach stmt in array array['select public.home_summary(''team'')', 'select public.home_summary()',
                              'select public.home_attention(''team'')', 'select * from public.home_recent_activity()'] loop
    perform pg_temp.expect_error(stmt, '42501', 'scope');
  end loop;
  foreach stmt in array array['select public.home_summary(''all'')', 'select public.home_summary(null)',
                              'select public.home_attention(''everyone'')', 'select * from public.home_recent_activity(''x'')',
                              'select public.home_summary(''mine; drop table deals'')'] loop
    perform pg_temp.expect_error(stmt, '22023', 'bad_scope');
  end loop;
  foreach stmt in array array['select public.home_attention(''mine'', 0)', 'select public.home_attention(''mine'', 21)',
                              'select public.home_attention(''mine'', null)', 'select * from public.home_recent_activity(''mine'', 0)',
                              'select * from public.home_recent_activity(''mine'', 21)'] loop
    perform pg_temp.expect_error(stmt, '22023', 'limit');
  end loop;
  -- Mine is always allowed, for a rep too; a manager may ask for the team.
  perform public.home_summary('mine');
  perform pg_temp.act('00000000-0000-0000-0000-0000000005b1');  -- manager Mia (TopStock)
  perform public.home_summary('team');
  perform pg_temp.su();
end $$;

-- 4. home_kpi_fixture: exact figures in Home Org (threats 2, 18, 24) -------------------------------------------------------
do $$
declare
  hana constant uuid := '00000000-0000-0000-0000-0000000005c0';
  hugo constant uuid := '00000000-0000-0000-0000-0000000005c1';
  hiro constant uuid := '00000000-0000-0000-0000-0000000005c2';
  w record;
  s jsonb;
  t date;
  quiet_lead uuid;
begin
  perform pg_temp.raw(true);
  t := (select (now() at time zone 'Europe/Paris')::date);
  select * into w from private.home_window(now(), 'Europe/Paris');
  -- Open deals. Hugo: Lead 1000 (fresh); Qualified without a value, clock 20 days (stalled: limit 14); Negotiations
  -- 2500.50 closing in 3 days; Lead 50 stalled (10 days, limit 7) whose close date passed 2 days ago; Lead 75 with an old
  -- clock but a call on its lead an hour ago (not stalled: a contact resets the warning). Hiro: Qualified 400 closing in
  -- 10 days (not soon). Hana: Lead 100.
  perform pg_temp.deal(hugo, 'lead', 1000);
  perform pg_temp.deal(hugo, 'qualified', null, interval '20 days');
  perform pg_temp.deal(hugo, 'negotiations', 2500.50, interval '2 days', t + 3);
  perform pg_temp.deal(hugo, 'lead', 50, interval '10 days', t - 2);
  quiet_lead := pg_temp.lead(hugo, interval '30 days', interval '1 hour');
  perform pg_temp.deal(hugo, 'lead', 75, interval '10 days', null, null, null, quiet_lead);
  perform pg_temp.deal(hiro, 'qualified', 400, interval '1 day', t + 10);
  perform pg_temp.deal(hana, 'lead', 100);
  -- Closed deals. Won this month: Hugo 300 a minute after the month started, Hiro 200; won a minute before the month
  -- started: Hugo 999 (out of the month, in the 90 days). Lost in 90 days: Hugo price, Hiro timing, Hugo mistake (left
  -- out of the win rate); Hugo competitor 120 days ago (out).
  perform pg_temp.deal(hugo, 'won', 300, interval '1 day', null, w.month_start + interval '1 minute');
  perform pg_temp.deal(hiro, 'won', 200, interval '1 day', null, now() - interval '1 second');
  perform pg_temp.deal(hugo, 'won', 999, interval '40 days', null, w.month_start - interval '1 minute');
  perform pg_temp.deal(hugo, 'lost', null, interval '1 day', null, now() - interval '3 days', 'price');
  perform pg_temp.deal(hiro, 'lost', null, interval '1 day', null, now() - interval '4 days', 'timing');
  perform pg_temp.deal(hugo, 'lost', null, interval '1 day', null, now() - interval '5 days', 'mistake');
  perform pg_temp.deal(hugo, 'lost', null, interval '130 days', null, now() - interval '120 days', 'competitor');
  -- Calls: Hugo connected a second after his day started, no answer a second before it (yesterday), no answer now, and
  -- an email (not a call); Hiro interested now.
  perform pg_temp.call(hugo, w.day_start + interval '1 second', 'connected');
  perform pg_temp.call(hugo, w.day_start - interval '1 second', 'connected');
  perform pg_temp.call(hugo, now(), 'no_answer');
  perform pg_temp.call(hugo, now(), 'sent', 'email');
  perform pg_temp.call(hiro, now(), 'interested');
  -- Tasks: Hugo overdue yesterday (all-day), due today (all-day), a timed one an hour ago (overdue), a meeting later
  -- today, a done one and a dismissed one due today, one tomorrow; Hiro one due today; Hana one due today.
  perform pg_temp.task(hugo, t - 1);
  perform pg_temp.task(hugo, t);
  perform pg_temp.task(hugo, null, now() - interval '1 hour');
  perform pg_temp.task(hugo, null, now() + (w.day_end - now()) / 2, 'meeting');
  perform pg_temp.task(hugo, t, null, 'todo', true);
  perform pg_temp.task(hugo, t, null, 'todo', false, true);
  perform pg_temp.task(hugo, t + 1);
  perform pg_temp.task(hiro, t);
  perform pg_temp.task(hana, t);
  -- New leads in Home Org: every lead above was created 30 days ago; three in the last 7 days (two imported), one 8
  -- days ago.
  perform pg_temp.lead(hugo, interval '1 day');
  perform pg_temp.lead(hugo, interval '2 days', null, '00000000-0000-0000-0000-0000000005cb');
  perform pg_temp.lead(hiro, interval '6 days', null, '00000000-0000-0000-0000-0000000005cb');
  perform pg_temp.lead(hiro, interval '8 days');
  perform pg_temp.raw(false);

  -- admin_team_kpis_equal_org_rows (exact): Hana, Team.
  perform pg_temp.act(hana);
  s := public.home_summary('team');
  perform pg_temp.eq('team scope', s ->> 'scope', 'team');
  perform pg_temp.eq('team open count', (s -> 'open' ->> 'count')::integer, 7);
  perform pg_temp.eq('team open value', s -> 'open' ->> 'value', '4125.50');
  perform pg_temp.eq('team open no value', (s -> 'open' ->> 'no_value')::integer, 1);
  perform pg_temp.eq('team open stalled', (s -> 'open' ->> 'stalled')::integer, 2);
  perform pg_temp.eq('team closing soon', (s -> 'open' ->> 'closing')::integer, 1);
  perform pg_temp.eq('team close passed', (s -> 'open' ->> 'close_passed')::integer, 1);
  perform pg_temp.eq('team by stage', s -> 'open' -> 'by_stage',
    '[{"key":"lead","count":4,"value":"1225.00"},{"key":"qualified","count":2,"value":"400.00"},{"key":"negotiations","count":1,"value":"2500.50"}]'::jsonb);
  perform pg_temp.eq('team won this month', s -> 'won_month', '{"count":2,"value":"500.00"}'::jsonb);
  -- win_rate_excludes_mistake, win_rate_hidden_under_5: won 3, lost 2 (mistake out) in 90 days: 5 closed, rate 0.6.
  perform pg_temp.eq('team win rate', s -> 'win_rate', '{"won":3,"lost":2,"rate":0.6000}'::jsonb);
  perform pg_temp.eq('team lost 30 days', s -> 'lost_30',
    '{"count":3,"reasons":[{"code":"mistake","count":1},{"code":"price","count":1},{"code":"timing","count":1}]}'::jsonb);
  perform pg_temp.eq('team calls today', s -> 'calls_today', '{"count":3,"reached":2}'::jsonb);
  -- Tasks due is always the caller's own (mutation "Tasks due ignores mine"): Hana has one due today.
  perform pg_temp.eq('team tasks (always mine)', s -> 'tasks', '{"overdue":0,"today":1,"meetings":0}'::jsonb);
  perform pg_temp.eq('team new leads', s -> 'new_leads', '{"count":3,"imported":2}'::jsonb);
  perform pg_temp.eq('team today', (s ->> 'today')::date, t);
  perform pg_temp.eq('team zone', s ->> 'zone', 'Europe/Paris');

  -- rep_kpis_equal_own_rows (exact): Hugo, Mine.
  perform pg_temp.act(hugo);
  s := public.home_summary('mine');
  perform pg_temp.eq('Hugo open', (s -> 'open') - 'by_stage',
    '{"count":5,"value":"3625.50","no_value":1,"stalled":2,"closing":1,"close_passed":1}'::jsonb);
  perform pg_temp.eq('Hugo won this month', s -> 'won_month', '{"count":1,"value":"300.00"}'::jsonb);
  -- Under 5 closed deals the rate is not given: won 2, lost 1 (mistake out).
  perform pg_temp.eq('Hugo win rate', s -> 'win_rate', '{"won":2,"lost":1,"rate":null}'::jsonb);
  perform pg_temp.eq('Hugo calls today', s -> 'calls_today', '{"count":2,"reached":1}'::jsonb);
  perform pg_temp.eq('Hugo tasks', s -> 'tasks', '{"overdue":2,"today":2,"meetings":1}'::jsonb);
  perform pg_temp.eq('Hugo new leads (org-wide)', s -> 'new_leads', '{"count":3,"imported":2}'::jsonb);
  -- Hiro, Mine: only his own rows.
  perform pg_temp.act(hiro);
  s := public.home_summary('mine');
  perform pg_temp.eq('Hiro open', (s -> 'open') - 'by_stage',
    '{"count":1,"value":"400.00","no_value":0,"stalled":0,"closing":0,"close_passed":0}'::jsonb);
  perform pg_temp.eq('Hiro calls today', s -> 'calls_today', '{"count":1,"reached":1}'::jsonb);
  perform pg_temp.eq('Hiro tasks', s -> 'tasks', '{"overdue":0,"today":1,"meetings":0}'::jsonb);
  -- Hana, Mine.
  perform pg_temp.act(hana);
  s := public.home_summary('mine');
  perform pg_temp.eq('Hana mine open count', (s -> 'open' ->> 'count')::integer, 1);
  perform pg_temp.eq('Hana mine calls', s -> 'calls_today', '{"count":0,"reached":0}'::jsonb);

  -- A sixth closed deal for Hugo shows the rate in Mine too: won 2 + lost 1, plus 2 more lost = 5.
  perform pg_temp.su();
  perform pg_temp.raw(true);
  perform pg_temp.deal(hugo, 'lost', null, interval '1 day', null, now() - interval '1 day', 'competitor');
  perform pg_temp.deal(hugo, 'lost', null, interval '1 day', null, now() - interval '1 day', 'no_response');
  perform pg_temp.raw(false);
  perform pg_temp.act(hugo);
  perform pg_temp.eq('Hugo win rate from 5', public.home_summary('mine') -> 'win_rate', '{"won":2,"lost":3,"rate":0.4000}'::jsonb);
  perform pg_temp.su();
  raise exception 'undo' using errcode = 'TS001';
exception when sqlstate 'TS001' then perform pg_temp.su(); perform pg_temp.raw(false);
end $$;

-- 5. calls_today_profile_zone and the month boundary in the profile zone (threat 24) -----------------------------------
do $$
declare
  hugo constant uuid := '00000000-0000-0000-0000-0000000005c1';
  z text;
  w record;
  s jsonb;
begin
  foreach z in array array['Europe/Paris', 'Asia/Karachi', 'America/Los_Angeles'] loop
    perform pg_temp.su();
    perform pg_temp.raw(true);
    delete from public.activities where user_id = hugo;
    delete from public.deals where owner_id = hugo;
    update public.profiles set timezone = z where id = hugo;
    select * into w from private.home_window(now(), z);
    perform pg_temp.call(hugo, w.day_start - interval '1 second', 'connected');
    perform pg_temp.call(hugo, w.day_start, 'connected');
    perform pg_temp.call(hugo, w.day_start + interval '1 second', 'voicemail');
    perform pg_temp.deal(hugo, 'won', 10, interval '40 days', null, w.month_start - interval '1 second');
    perform pg_temp.deal(hugo, 'won', 20, interval '40 days', null, w.month_start);
    perform pg_temp.raw(false);
    perform pg_temp.act(hugo);
    s := public.home_summary('mine');
    perform pg_temp.eq('calls today in ' || z, s -> 'calls_today', '{"count":2,"reached":1}'::jsonb);
    perform pg_temp.eq('won this month in ' || z, s -> 'won_month', '{"count":1,"value":"20.00"}'::jsonb);
    perform pg_temp.eq('zone ' || z, s ->> 'zone', z);
    perform pg_temp.eq('today in ' || z, (s ->> 'today')::date, w.today);
  end loop;
  -- A zone the database does not know falls back to Paris (Day 4b caller_zone). Day 4c's check_profile_timezone refuses
  -- such a zone on save, so the row is written with triggers off (a zone saved before 4c, or one a later time zone
  -- database drops, can still be unknown).
  perform pg_temp.su();
  set local session_replication_role = replica;
  update public.profiles set timezone = 'Mars/Olympus' where id = hugo;
  set local session_replication_role = origin;
  perform pg_temp.act(hugo);
  perform pg_temp.eq('unknown zone', public.home_summary('mine') ->> 'zone', 'Europe/Paris');
  perform pg_temp.su();
  raise exception 'undo' using errcode = 'TS001';
exception when sqlstate 'TS001' then perform pg_temp.su(); perform pg_temp.raw(false);
end $$;

-- 6. Hand counts in the TopStock org (threats 2 and 18): admin a's Team and rep r1's Mine equal their rows; nothing
--    from Home Org (fixture rows added here) reaches either, and Home Org's admin sees none of TopStock's.
do $$
declare
  admin constant uuid := '00000000-0000-0000-0000-00000000000a';
  r1 constant uuid := '00000000-0000-0000-0000-0000000005a1';
  hana constant uuid := '00000000-0000-0000-0000-0000000005c0';
  topstock uuid := (select id from public.orgs where name = 'TopStock Wholesale');
  s jsonb;
  w record;
  want jsonb;
begin
  perform pg_temp.raw(true);
  -- Home Org rows that must stay out of the TopStock figures.
  perform pg_temp.deal(hana, 'lead', 5000);
  perform pg_temp.deal(hana, 'won', 7000, interval '1 day', null, now());
  perform pg_temp.call(hana, now(), 'connected');
  perform pg_temp.lead(hana, interval '1 hour');
  -- A TopStock call by r1 now, so the count is not trivially zero.
  perform pg_temp.call(r1, now(), 'interested');
  perform pg_temp.raw(false);
  select * into w from private.home_window(now(), 'Europe/Paris');

  perform pg_temp.act(admin);
  s := public.home_summary('team');
  perform pg_temp.su();
  select jsonb_build_object('count', count(*), 'value', coalesce(sum(value), 0)::numeric(16, 2)::text,
                            'no_value', count(*) filter (where value is null))
    into want from public.deals where org_id = topstock and status = 'open';
  perform pg_temp.eq('admin team open', jsonb_build_object('count', s -> 'open' -> 'count', 'value', s -> 'open' -> 'value',
                                                         'no_value', s -> 'open' -> 'no_value'), want);
  perform pg_temp.eq('admin team stalled', (s -> 'open' ->> 'stalled')::bigint,
    (select count(*) from public.deals d join public.pipeline_stages st on st.id = d.stage_id
       join public.companies c on c.id = d.company_id
      where d.org_id = topstock and d.status = 'open'
        and greatest(d.stage_entered_at, coalesce(c.last_activity_at, '-infinity')) < now() - make_interval(hours => 24 * st.stall_days)));
  select jsonb_build_object('count', count(*), 'value', coalesce(sum(value), 0)::numeric(16, 2)::text)
    into want from public.deals where org_id = topstock and status = 'won' and closed_at >= w.month_start;
  perform pg_temp.eq('admin team won', s -> 'won_month', want);
  perform pg_temp.eq('admin team calls', (s -> 'calls_today' ->> 'count')::bigint,
    (select count(*) from public.activities where org_id = topstock and type = 'call' and created_at >= w.day_start));
  perform pg_temp.eq('admin team new leads', (s -> 'new_leads' ->> 'count')::bigint,
    (select count(*) from public.companies where org_id = topstock and created_at >= now() - interval '7 days'));

  perform pg_temp.act(r1);
  s := public.home_summary('mine');
  perform pg_temp.su();
  select jsonb_build_object('count', count(*), 'value', coalesce(sum(value), 0)::numeric(16, 2)::text,
                            'no_value', count(*) filter (where value is null))
    into want from public.deals where owner_id = r1 and status = 'open';
  perform pg_temp.eq('r1 mine open', jsonb_build_object('count', s -> 'open' -> 'count', 'value', s -> 'open' -> 'value',
                                                      'no_value', s -> 'open' -> 'no_value'), want);
  perform pg_temp.eq('r1 mine calls', (s -> 'calls_today' ->> 'count')::bigint,
    (select count(*) from public.activities where user_id = r1 and type = 'call' and created_at >= w.day_start));
  perform pg_temp.eq('r1 mine tasks today+overdue',
    (s -> 'tasks' ->> 'overdue')::bigint + (s -> 'tasks' ->> 'today')::bigint,
    (select count(*) from public.tasks where assignee_id = r1 and done_at is null and cancelled_at is null
        and (due_date <= w.today or due_at < w.day_end)));

  -- kpi_ignores_other_org: Home Org's admin sees its own rows only.
  perform pg_temp.act(hana);
  s := public.home_summary('team');
  perform pg_temp.eq('Home Org open', s -> 'open' ->> 'value', '5000.00');
  perform pg_temp.eq('Home Org won', s -> 'won_month', '{"count":1,"value":"7000.00"}'::jsonb);
  perform pg_temp.eq('Home Org calls', s -> 'calls_today', '{"count":1,"reached":1}'::jsonb);
  perform pg_temp.eq('Home Org new leads', (s -> 'new_leads' ->> 'count')::integer, 1);  -- the other leads are 30 days old
  if exists (select 1 from jsonb_array_elements(public.home_attention('team', 20) -> 'items') i
              where (i ->> 'company_id')::uuid not in (select id from public.companies where org_id = '00000000-0000-0000-0000-0000000005cc'))
     or exists (select 1 from public.home_recent_activity('team', 20) r
                 where r.company_id not in (select id from public.companies where org_id = '00000000-0000-0000-0000-0000000005cc')) then
    raise exception 'FAIL: kpi_ignores_other_org (attention or recent)';
  end if;
  perform pg_temp.su();
  raise exception 'undo' using errcode = 'TS001';
exception when sqlstate 'TS001' then perform pg_temp.su(); perform pg_temp.raw(false);
end $$;

-- 7. attention_order (design 4.3): close passed, then most days over the limit, then soonest close; reasons; total ------
do $$
declare
  hana constant uuid := '00000000-0000-0000-0000-0000000005c0';
  hugo constant uuid := '00000000-0000-0000-0000-0000000005c1';
  t date := (now() at time zone 'Europe/Paris')::date;
  passed uuid; stalled_long uuid; stalled_short uuid; closing_2 uuid; closing_5 uuid; passed_stalled uuid;
  a jsonb;
begin
  perform pg_temp.raw(true);
  stalled_short := pg_temp.deal(hugo, 'lead', 10, interval '12 days');                 -- 5 days over the 7
  closing_5 := pg_temp.deal(hugo, 'qualified', 20, interval '1 day', t + 5);
  passed := pg_temp.deal(hugo, 'negotiations', 30, interval '1 day', t - 1);
  stalled_long := pg_temp.deal(hana, 'qualified', 40, interval '44 days');             -- 30 days over the 14
  closing_2 := pg_temp.deal(hana, 'lead', 50, interval '1 hour', t + 2);
  passed_stalled := pg_temp.deal(hugo, 'lead', 60, interval '9 days', t - 3);          -- passed and 2 days over
  perform pg_temp.deal(hugo, 'lead', 70, interval '1 hour', t + 8);                    -- not flagged
  perform pg_temp.deal(hugo, 'won', 80, interval '1 day', null, now());                -- closed: never flagged
  perform pg_temp.raw(false);
  perform pg_temp.act(hana);
  a := public.home_attention('team');
  perform pg_temp.eq('attention total', (a ->> 'total')::integer, 6);
  perform pg_temp.eq('attention order',
    (select array_agg((i ->> 'id')::uuid order by n) from jsonb_array_elements(a -> 'items') with ordinality x (i, n)),
    array[passed_stalled, passed, stalled_long, stalled_short, closing_2]);
  perform pg_temp.eq('attention reasons',
    (select array_agg(i ->> 'reason' order by n) from jsonb_array_elements(a -> 'items') with ordinality x (i, n)),
    array['overdue', 'overdue', 'stalled', 'stalled', 'closing']);
  -- Items are deal cards: the lead's name and the value as text, never the lost note.
  perform pg_temp.eq('attention card', a -> 'items' -> 2 ->> 'value', '40.00');
  perform pg_temp.eq('attention card lead', a -> 'items' -> 2 ->> 'company_name', 'Home lead');
  if a::text ~ 'SECRET' then raise exception 'FAIL: attention carries a note'; end if;
  a := public.home_attention('team', 2);
  perform pg_temp.eq('attention limit', jsonb_array_length(a -> 'items'), 2);
  perform pg_temp.eq('attention limit total', (a ->> 'total')::integer, 6);
  -- Mine: Hugo's own only.
  perform pg_temp.act(hugo);
  a := public.home_attention('mine', 20);
  perform pg_temp.eq('Hugo attention',
    (select array_agg((i ->> 'id')::uuid order by n) from jsonb_array_elements(a -> 'items') with ordinality x (i, n)),
    array[passed_stalled, passed, stalled_short, closing_5]);
  perform pg_temp.su();
  raise exception 'undo' using errcode = 'TS001';
exception when sqlstate 'TS001' then perform pg_temp.su(); perform pg_temp.raw(false);
end $$;

-- 8. Recent activity (threat 18: recent_activity_has_no_body, recent_hides_undo_pairs) ----------------------------------
do $$
declare
  hana constant uuid := '00000000-0000-0000-0000-0000000005c0';
  hugo constant uuid := '00000000-0000-0000-0000-0000000005c1';
  hiro constant uuid := '00000000-0000-0000-0000-0000000005c2';
  org constant uuid := '00000000-0000-0000-0000-0000000005cc';
  d_won uuid; d_moved uuid; d_lost uuid; d_hiro uuid;
  h_move bigint;
  rows_ jsonb;
begin
  perform pg_temp.raw(true);
  perform pg_temp.call(hugo, now() - interval '10 minutes', 'interested');
  perform pg_temp.call(hiro, now() - interval '20 minutes', 'no_answer');
  perform pg_temp.call(hugo, now() - interval '30 minutes', null, 'note');
  d_won := pg_temp.deal(hugo, 'won', 12400, interval '1 day', null, now() - interval '5 minutes');
  d_moved := pg_temp.deal(hugo, 'qualified', 10);
  d_lost := pg_temp.deal(hugo, 'lost', null, interval '1 day', null, now() - interval '15 minutes', 'other');
  d_hiro := pg_temp.deal(hiro, 'qualified', 10);
  insert into public.deal_stage_history (org_id, deal_id, actor_id, kind, from_stage, to_stage, value_after, version_after, created_at)
  values (org, d_won, hugo, 'won', 'negotiations', 'won', 12400, 3, now() - interval '5 minutes'),
         (org, d_lost, hugo, 'lost', 'lead', 'lost', null, 1, now() - interval '15 minutes'),
         (org, d_hiro, hiro, 'move', 'lead', 'qualified', null, 1, now() - interval '25 minutes');
  -- A move and its undo two minutes later: both are left out of the feed.
  insert into public.deal_stage_history (org_id, deal_id, actor_id, kind, from_stage, to_stage, version_after, created_at)
  values (org, d_moved, hugo, 'move', 'lead', 'qualified', 1, now() - interval '4 minutes') returning id into h_move;
  insert into public.deal_stage_history (org_id, deal_id, actor_id, kind, from_stage, to_stage, version_after, undoes, created_at)
  values (org, d_moved, hugo, 'undo', 'qualified', 'lead', 2, h_move, now() - interval '2 minutes');
  perform pg_temp.raw(false);

  perform pg_temp.act(hana);
  select jsonb_agg(to_jsonb(r)) into rows_ from public.home_recent_activity('team') r;
  perform pg_temp.eq('team feed kinds',
    (select array_agg(e ->> 'kind' || ':' || coalesce(e ->> 'outcome', e ->> 'to_stage', e ->> 'type') || ':' || (e ->> 'user_first_name')
                      order by n) from jsonb_array_elements(rows_) with ordinality x (e, n)),
    array['won:won:Hugo', 'activity:interested:Hugo', 'lost:lost:Hugo', 'activity:no_answer:Hiro', 'move:qualified:Hiro',
          'activity:note:Hugo']);
  perform pg_temp.eq('won row value', rows_ -> 0 ->> 'value', '12400.00');
  perform pg_temp.eq('won row lead', rows_ -> 0 ->> 'company_name', 'Home lead');
  if exists (select 1 from jsonb_array_elements(rows_) e where e ->> 'kind' <> 'won' and e ->> 'value' is not null) then
    raise exception 'FAIL: only won rows carry a value';
  end if;
  if rows_::text ~ 'SECRET' then raise exception 'FAIL: recent_activity_has_no_body (an entry text or a note)'; end if;
  -- The limit takes the newest rows.
  perform pg_temp.eq('feed limit', (select count(*) from public.home_recent_activity('team', 3))::integer, 3);
  perform pg_temp.eq('feed limit newest', (select array_agg(r.kind order by r.at desc) from public.home_recent_activity('team', 2) r),
    array['won', 'activity']);
  -- Mine: Hiro sees his own entry and move, nothing of Hugo's.
  perform pg_temp.act(hiro);
  perform pg_temp.eq('Hiro feed', (select array_agg(r.kind order by r.at desc) from public.home_recent_activity('mine') r),
    array['activity', 'move']);
  -- A rep's Mine never shows a colleague's deal change, even on a deal the rep owns: history rows are by actor.
  perform pg_temp.act(hugo);
  if exists (select 1 from public.home_recent_activity('mine', 20) r where r.user_first_name <> 'Hugo') then
    raise exception 'FAIL: Mine shows another person''s rows';
  end if;
  if (select jsonb_agg(to_jsonb(r)) from public.home_recent_activity('mine', 20) r)::text ~ 'SECRET' then
    raise exception 'FAIL: recent_activity_has_no_body (Mine)';
  end if;
  perform pg_temp.su();
  raise exception 'undo' using errcode = 'TS001';
exception when sqlstate 'TS001' then perform pg_temp.su(); perform pg_temp.raw(false);
end $$;

-- 9. Today's tasks after the 4c rebase: K5/K6 are Day 4c's count_tasks('mine') plus the day's meetings, always the
-- caller's own (an admin who may read every task gets none of a rep's), and the Today card's two reads are Day 4c's
-- list_tasks('overdue' / 'today', 'mine', 6) in that order (the route puts the day's meetings first).
do $$
declare
  hugo constant uuid := '00000000-0000-0000-0000-0000000005c1';
  hiro constant uuid := '00000000-0000-0000-0000-0000000005c2';
  t date := (now() at time zone 'Europe/Paris')::date;
  w record;
  overdue_old uuid; overdue_new uuid; today_all_day uuid; meeting uuid; call_later uuid;
  k jsonb;
begin
  select * into w from private.home_window(now(), 'Europe/Paris');
  perform pg_temp.raw(true);
  overdue_new := pg_temp.task(hugo, t - 1);
  overdue_old := pg_temp.task(hugo, t - 5);
  today_all_day := pg_temp.task(hugo, t);
  call_later := pg_temp.task(hugo, null, now() + (w.day_end - now()) * 3 / 4, 'call');
  meeting := pg_temp.task(hugo, null, now() + (w.day_end - now()) / 2, 'meeting');
  perform pg_temp.task(hugo, t + 1);                       -- tomorrow: not counted
  perform pg_temp.task(hugo, null, w.day_end, 'meeting');  -- tomorrow's first instant: not counted
  perform pg_temp.task(hugo, t, null, 'todo', true);       -- done
  perform pg_temp.task(hugo, t, null, 'todo', false, true);-- dismissed
  perform pg_temp.task(hiro, t);                           -- someone else's
  perform pg_temp.raw(false);
  perform pg_temp.act(hugo);
  k := public.home_summary('mine') -> 'tasks';
  perform pg_temp.eq('tasks overdue', (k ->> 'overdue')::integer, 2);
  perform pg_temp.eq('tasks today', (k ->> 'today')::integer, 3);
  perform pg_temp.eq('tasks meetings', (k ->> 'meetings')::integer, 1);
  perform pg_temp.eq('tasks = count_tasks', (k ->> 'overdue') || '/' || (k ->> 'today'),
                     (public.count_tasks('mine') ->> 'overdue') || '/' || (public.count_tasks('mine') ->> 'today'));
  perform pg_temp.eq('Today overdue list', (select array_agg(x.id order by x.sort_at, x.id)
                                               from public.list_tasks('overdue', 'mine', null, null, 6) x),
                     array[overdue_old, overdue_new]);
  perform pg_temp.eq('Today list', (select array_agg(x.id order by x.sort_at, x.id) from public.list_tasks('today', 'mine', null, null, 6) x),
                     array[today_all_day, meeting, call_later]);
  perform pg_temp.act(hiro);
  perform pg_temp.eq('Hiro today', (public.home_summary('mine') -> 'tasks' ->> 'today')::integer, 1);
  -- Always the caller's own: an admin, who may read every task in the org, counts none of these (Team or Mine).
  perform pg_temp.act('00000000-0000-0000-0000-0000000005c0');
  perform pg_temp.eq('Hana tasks, Team (always her own)', public.home_summary('team') -> 'tasks',
                     jsonb_build_object('overdue', 0, 'today', 0, 'meetings', 0));
  perform pg_temp.su();
  raise exception 'undo' using errcode = 'TS001';
exception when sqlstate 'TS001' then perform pg_temp.su(); perform pg_temp.raw(false);
end $$;

\echo 'home_attack.sql: all Day 5c checks passed'
