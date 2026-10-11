-- Day 4 speed at Release 1 size (design docs/evidence/day4/design.md section 8.6), part 1 (Day 4a) and part 2 (Day 4b,
-- at the end: P1, P4, P4b). Runs after perf_leads.sql (30,015 leads, 10,015 contacts) and before perf_import.sql on the
-- same throwaway database, so the Day 3b import and undo (P7) are re-timed with 300,000 activities, 15,000 tasks and the
-- Day 4b lead facts in place. Used by scripts/db-perf.sh.
--  Seed: 300,000 activities (250,000 spread over every lead, 50,000 on 25 leads, one lead with 10,000) inserted with
--        triggers off (session_replication_role = replica), then the leads' last-activity dates set in one update;
--        15,000 tasks (5,000 per person, 30% done); vacuum analyze.
--  P2:   a timeline page (30 entries, newest first, keyset on (created_at, id)) on the lead with 10,000 entries: first
--        page, the page at row 5,000, and Calls only. list_lead_activities arrives in 4b; this runs the same static
--        query from a plpgsql function as a signed-in user, row level security on, so its plans are cached like the
--        RPC's will be. Each case runs 10 times with auto_explain (plans 6 and later are the generic-plan check), then
--        the average of 5 warm runs.
--  Also: logging one entry (activity guard: author, previous date, flood guard) and deleting the newest entry (the
--        D9 untouch trigger), each undone, as context for 4b's P4 and P4b.
\set ON_ERROR_STOP 1
\set QUIET 1
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000b4', 'perf-rep-b@test.invalid'),
  ('00000000-0000-0000-0000-0000000000c4', 'perf-rep-c@test.invalid');

-- Seed ----------------------------------------------------------------------------------------------------------------
set session_replication_role = replica;
create temporary table perf_leads as
select c.id, c.org_id, row_number() over (order by c.id) as n from public.companies c;
create temporary table perf_people (k integer primary key, id uuid not null);
insert into perf_people values (0, '00000000-0000-0000-0000-0000000000a1'), (1, '00000000-0000-0000-0000-0000000000b4'),
                               (2, '00000000-0000-0000-0000-0000000000c4');
-- Lead 1 gets 10,000 entries, leads 2 to 25 get 1,667 each (40,008), and 250,000 are spread over all 30,015 leads.
insert into public.activities (org_id, company_id, type, outcome, body, user_id, created_at, updated_at)
select l.org_id, l.id,
       (array['call','call','call','call','call','call','call','call','call','call','call','call',
              'email','email','email','whatsapp','meeting','note','note','note'])[g % 20 + 1],
       case when g % 20 < 12 then (array['no_answer','voicemail','wrong_number','not_interested','interested',
                                         'meeting_booked','do_not_contact','connected'])[g % 8 + 1]
            when g % 20 < 16 then 'sent'
            when g % 20 = 16 then 'held' end,
       case when g % 20 >= 17 then 'Note ' || g || ': asked for the spring catalogue and prices by the carton, call back.'
            when g % 20 < 12 and g % 3 = 0 then 'Spoke briefly, wants a quote.' end,
       p.id, ts, ts
  from (select g, case when g <= 10000 then 1
                       when g <= 50008 then 2 + (g - 10001) % 24
                       else 1 + (g::bigint * 7919) % 30015 end as lead_n,
               now() - ((g::bigint * 104729) % 63072000) * interval '1 second' as ts
          from generate_series(1, 300008) g) s
  join perf_leads l on l.n = s.lead_n
  join perf_people p on p.k = s.g % 3;
update public.companies c set last_activity_at = x.m
  from (select company_id, max(created_at) as m from public.activities group by company_id) x
 where x.company_id = c.id;
insert into public.tasks (org_id, company_id, title, kind, due_date, due_at, assignee_id, created_by, done_at, completed_by,
                          created_at, updated_at)
select l.org_id, l.id, 'Task ' || g,
       (array['call','todo','call','meeting','todo'])[g % 5 + 1],
       case when g % 5 <> 3 then current_date + (g % 60) - 20 end,
       case when g % 5 = 3 then now() + ((g % 60) - 20) * interval '1 day' end,
       p.id, p.id,
       case when g % 10 < 3 then now() - (g % 30) * interval '1 day' end,
       case when g % 10 < 3 then p.id end,
       now() - (g % 90) * interval '1 day', now() - (g % 90) * interval '1 day'
  from generate_series(1, 15000) g
  join perf_leads l on l.n = 1 + (g * 6151) % 30015
  join perf_people p on p.k = g % 3;
set session_replication_role = origin;
vacuum analyze public.activities;
vacuum analyze public.tasks;
vacuum analyze public.companies;
select 'seeded: ' || (select count(*) from public.activities) || ' activities, '
       || (select count(*) from public.tasks) || ' tasks, '
       || (select count(*) from public.activities where company_id = (select id from perf_leads where n = 1))
       || ' on the busiest lead';
select 'sizes: ' || string_agg(relname || ' ' || pg_size_pretty(pg_total_relation_size(oid)), ', ' order by relname)
  from pg_class where relname in ('activities', 'tasks', 'companies', 'audit_log');
select set_config('perf.heavy', (select id::text from perf_leads where n = 1), false) \g /dev/null
select set_config('perf.typical', (select id::text from perf_leads where n = 1000), false) \g /dev/null

-- The timeline page: the query list_lead_activities (4b) will run, static, keyset (created_at, id) newest first.
create function pg_temp.timeline_page(p_company uuid, p_types text[], p_before_at timestamptz, p_before_id uuid,
                                      p_limit integer)
returns table (id uuid, type text, outcome text, body text, created_at timestamptz)
language plpgsql stable set search_path = '' as $$
begin
  if p_before_at is null then
    return query
      select a.id, a.type, a.outcome, left(a.body, 2000), a.created_at
        from public.activities a
       where a.company_id = p_company and (p_types is null or a.type = any (p_types))
       order by a.created_at desc, a.id desc
       limit p_limit;
  else
    return query
      select a.id, a.type, a.outcome, left(a.body, 2000), a.created_at
        from public.activities a
       where a.company_id = p_company and (p_types is null or a.type = any (p_types))
         and (a.created_at, a.id) < (p_before_at, p_before_id)
       order by a.created_at desc, a.id desc
       limit p_limit;
  end if;
end;
$$;

-- The cursor for "row 5,000": the 5,000th entry of the busiest lead, newest first (read as the superuser).
select set_config('perf.cur_at', x.created_at::text, false), set_config('perf.cur_id', x.id::text, false)
  from (select a.created_at, a.id from public.activities a where a.company_id = current_setting('perf.heavy')::uuid
         order by a.created_at desc, a.id desc offset 4999 limit 1) x \g /dev/null

\echo '=== P2 plans: each case 10 times (runs 6 to 10 may use a generic plan), inner statement via auto_explain ==='
load 'auto_explain';
set auto_explain.log_min_duration = 0;
set auto_explain.log_analyze = on;
set auto_explain.log_nested_statements = on;
set auto_explain.log_timing = on;
set auto_explain.log_level = 'notice';
set client_min_messages = 'notice';
set role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000b4","role":"authenticated","aal":"aal2"}', false) \g /dev/null
do $$
declare
  heavy uuid := current_setting('perf.heavy')::uuid;
  cur_at timestamptz := current_setting('perf.cur_at')::timestamptz;
  cur_id uuid := current_setting('perf.cur_id')::uuid;
  n integer;
begin
  for r in 1..10 loop
    raise notice 'P2 plan check run %: first page', r;
    select count(*) into n from pg_temp.timeline_page(heavy, null, null, null, 30);
    raise notice 'P2 plan check run %: row 5,000', r;
    select count(*) into n from pg_temp.timeline_page(heavy, null, cur_at, cur_id, 30);
    raise notice 'P2 plan check run %: calls only', r;
    select count(*) into n from pg_temp.timeline_page(heavy, array['call'], null, null, 30);
  end loop;
end $$;
reset role;
set auto_explain.log_min_duration = -1;
set role authenticated;

\echo '=== P2 timings: average of 5 warm runs after 10, milliseconds ==='
do $$
declare
  heavy uuid := current_setting('perf.heavy')::uuid;
  typical uuid := current_setting('perf.typical')::uuid;
  cur_at timestamptz := current_setting('perf.cur_at')::timestamptz;
  cur_id uuid := current_setting('perf.cur_id')::uuid;
  t0 timestamptz;
  total numeric;
  n integer;
  c integer;
begin
  for c in 1..4 loop
    for r in 1..15 loop  -- 10 to settle the plan, then 5 timed
      t0 := clock_timestamp();
      case c
        when 1 then select count(*) into n from pg_temp.timeline_page(heavy, null, null, null, 30);
        when 2 then select count(*) into n from pg_temp.timeline_page(heavy, null, cur_at, cur_id, 30);
        when 3 then select count(*) into n from pg_temp.timeline_page(heavy, array['call'], null, null, 30);
        else select count(*) into n from pg_temp.timeline_page(typical, null, null, null, 30);
      end case;
      if r = 11 then total := 0; end if;
      if r > 10 then total := total + extract(epoch from clock_timestamp() - t0) * 1000; end if;
    end loop;
    if c <> 4 and n <> 30 then raise exception 'FAIL: page size %', n; end if;
    raise notice '% : % ms (% rows)',
      rpad((array['P2 first page, lead with 10,000 entries', 'P2 page at row 5,000', 'P2 calls only, first page',
                  'P2 first page, a typical lead'])[c], 44), round(total / 5, 2), n;
  end loop;
end $$;

\echo '=== Context for 4b: log one entry (guards) and delete the newest (D9 untouch), each undone; 5 runs ==='
select set_config('request.jwt.claims', jsonb_build_object('sub', '00000000-0000-0000-0000-0000000000b4', 'role', 'authenticated',
  'aal', 'aal2', 'amr', jsonb_build_array(jsonb_build_object('method', 'totp', 'timestamp', extract(epoch from now())::bigint)))::text,
  false) \g /dev/null
do $$
declare
  lead uuid;
  t0 timestamptz;
  ins numeric;
  del numeric;
  v uuid;
  k integer;
begin
  for k in 1..2 loop
    lead := case k when 1 then current_setting('perf.heavy')::uuid else current_setting('perf.typical')::uuid end;
    ins := 0;
    del := 0;
    for r in 1..5 loop
      begin
        t0 := clock_timestamp();
        insert into public.activities (company_id, type, outcome, body)
        values (lead, 'call', 'connected', 'Timing probe') returning id into v;
        ins := ins + extract(epoch from clock_timestamp() - t0) * 1000;
        t0 := clock_timestamp();
        delete from public.activities where id = v;
        del := del + extract(epoch from clock_timestamp() - t0) * 1000;
        if (select last_activity_at from public.companies where id = lead)
           is distinct from (select max(created_at) from public.activities where company_id = lead) then
          raise exception 'FAIL: the lead''s date did not go back';
        end if;
        raise exception 'undo' using errcode = 'TS001';
      exception when sqlstate 'TS001' then null;
      end;
    end loop;
    raise notice '% : insert % ms, delete % ms',
      rpad(case k when 1 then 'Entry on the lead with 10,000 entries' else 'Entry on a typical lead' end, 44),
      round(ins / 5, 2), round(del / 5, 2);
  end loop;
end $$;
reset role;
do $$ begin perform set_config('request.jwt.claims', '', false); end $$;

-- =====================================================================================================================
-- Part 2 (Day 4b; design 8.6 P1, P4, P4b). Lead facts in the design's mix, set with triggers off in one update: 60% FR,
-- 15% GB, 15% US (two thirds with a picked zone), 10% DE/BE/ES; 8% with no main number; 3% with the main number marked
-- wrong; 2% Do not contact; Cool off leads with a return date; a fifth of the others with a next call within +-10 days.
-- The busiest lead (10,008 entries) and a typical one (8) then get what P4 needs: no main number, one contact with a
-- number, the caller's call task due yesterday, and (busiest only) 50 more open tasks.
--  P1:  get_lead on both, as the admin (perf user a1: the first user, so admin), 10 runs to settle plans (run 6 logged
--       for the busiest lead: generic-plan check), then the average of 5.
--  P4:  log_activity "wrong number" on the contact: it locks contact and lead, marks the contact, completes the due call
--       task and makes "find the right number"; with a request id, as the app sends. P4b: undo_activity on it. Each run
--       rolled back; 10 runs, then 5 timed; runs 6 to 10 log any statement inside them slower than 1 ms (auto_explain).
-- =====================================================================================================================
\echo '=== Part 2 (Day 4b): lead facts ==='
set session_replication_role = replica;
update public.companies c
   set country = case when x.b < 60 then 'FR' when x.b < 75 then 'GB' when x.b < 90 then 'US' when x.b < 94 then 'DE'
                      when x.b < 97 then 'BE' else 'ES' end,
       timezone = case when x.b between 75 and 84
                       then (array['America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles'])[x.n % 4 + 1] end,
       phone = case when x.b2 < 8 then null else c.phone end,
       phone_wrong_at = case when x.b2 between 8 and 10 then now() - interval '3 days' end,
       lead_status = case when x.b2 between 11 and 12 then 'do_not_contact' else c.lead_status end,
       next_action_at = case when c.lead_status = 'cool_off' then now() + (x.n % 90) * interval '1 day'
                             when x.n % 5 = 0 then now() + ((x.n % 21) - 10) * interval '1 day' end
  from (select id, n, n % 100 as b, (n / 100) % 100 as b2 from perf_leads) x
 where x.id = c.id;
update public.companies set phone = null, phone_wrong_at = null, lead_status = 'cold', next_action_at = null,
                            owner_id = '00000000-0000-0000-0000-0000000000a1', country = 'FR', timezone = null
 where id in (current_setting('perf.heavy')::uuid, current_setting('perf.typical')::uuid);
update public.contacts set phone = null   -- a contact from the Day 3a seed may sit on one of them: its number goes
 where company_id in (current_setting('perf.heavy')::uuid, current_setting('perf.typical')::uuid);
insert into public.contacts (org_id, company_id, first_name, phone)
select org_id, id, 'Probe', '+33 6 39 98 30 01' from public.companies
 where id in (current_setting('perf.heavy')::uuid, current_setting('perf.typical')::uuid);
-- (Made an hour ago, and part 1's tasks "made today" moved back too, so the timed runs stay under the 60-a-minute guard.)
update public.tasks set created_at = created_at - interval '1 hour', updated_at = updated_at - interval '1 hour'
 where created_at > now() - interval '1 minute';
insert into public.tasks (org_id, company_id, title, kind, due_date, assignee_id, created_by, created_at, updated_at)
select org_id, id, 'Due call', 'call', current_date - 1, '00000000-0000-0000-0000-0000000000a1',
       '00000000-0000-0000-0000-0000000000a1', now() - interval '1 hour', now() - interval '1 hour'
  from public.companies where id in (current_setting('perf.heavy')::uuid, current_setting('perf.typical')::uuid);
insert into public.tasks (org_id, company_id, title, kind, due_date, assignee_id, created_by, created_at, updated_at)
select org_id, id, 'Open task ' || g, 'todo', current_date + g, '00000000-0000-0000-0000-0000000000a1',
       '00000000-0000-0000-0000-0000000000a1', now() - interval '1 hour', now() - interval '1 hour'
  from public.companies, generate_series(1, 50) g where id = current_setting('perf.heavy')::uuid;
set session_replication_role = origin;
vacuum analyze public.companies;
vacuum analyze public.contacts;
vacuum analyze public.tasks;
select set_config('perf.heavy_contact', (select id::text from public.contacts
                                          where company_id = current_setting('perf.heavy')::uuid and first_name = 'Probe'), false),
       set_config('perf.typical_contact', (select id::text from public.contacts
                                            where company_id = current_setting('perf.typical')::uuid and first_name = 'Probe'), false) \g /dev/null
select 'lead facts: ' || count(*) filter (where country = 'FR') || ' FR, ' || count(*) filter (where country = 'US') || ' US ('
       || count(*) filter (where timezone is not null) || ' with a zone), ' || count(*) filter (where phone is null)
       || ' with no main number, ' || count(*) filter (where phone_wrong_at is not null) || ' marked wrong, '
       || count(*) filter (where lead_status = 'do_not_contact') || ' do not contact, '
       || count(*) filter (where next_action_at is not null) || ' with a next call'
  from public.companies;


-- One outcome and its undo on a lead, rolled back; the times in milliseconds come back in perf.p4 and perf.p4b (set
-- after the rollback, which would undo them).
create function pg_temp.outcome_round(lead uuid, contact uuid) returns void
language plpgsql as $$
declare
  t0 timestamptz;
  r jsonb;
  u jsonb;
  ms4 numeric;
  ms4b numeric;
begin
  begin
    t0 := clock_timestamp();
    r := public.log_activity(lead, 'call', 'wrong_number', 'Timing probe', contact, 'contact', null, null,
                             'Find the right number', gen_random_uuid());
    ms4 := extract(epoch from clock_timestamp() - t0) * 1000;
    if jsonb_array_length(r -> 'completed_task_ids') <> 1 or r ->> 'task_id' is null
       or not (r ->> 'wrong_number_marked')::boolean or not (r ->> 'editable')::boolean then
      raise exception 'FAIL: P4 did not do all its work: %', r;
    end if;
    t0 := clock_timestamp();
    u := public.undo_activity((r ->> 'activity_id')::uuid);
    ms4b := extract(epoch from clock_timestamp() - t0) * 1000;
    if not (u ->> 'task_deleted')::boolean or (u ->> 'tasks_reopened')::integer <> 1
       or not (u -> 'restored' ->> 'contact_phone_wrong')::boolean then
      raise exception 'FAIL: P4b did not undo everything: %', u;
    end if;
    raise exception 'undo' using errcode = 'TS001';
  exception when sqlstate 'TS001' then null;
  end;
  perform set_config('perf.p4', ms4::text, false);
  perform set_config('perf.p4b', ms4b::text, false);
end;
$$;

\echo '=== P1, P4, P4b plan check: 5 runs to settle, then run 6 with every inner statement logged (auto_explain) ==='
set auto_explain.log_min_duration = -1;
set role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated","aal":"aal2"}', false) \g /dev/null
do $$
begin
  for r in 1..5 loop
    perform public.get_lead(current_setting('perf.heavy')::uuid);
    perform pg_temp.outcome_round(current_setting('perf.heavy')::uuid, current_setting('perf.heavy_contact')::uuid);
  end loop;
end $$;
reset role;
set auto_explain.log_min_duration = 0;
set role authenticated;
\echo '--- P1 run 6: get_lead, the lead with 10,008 entries'
select public.get_lead(current_setting('perf.heavy')::uuid) is not null as found;
\echo '--- P4 and P4b run 6: log_activity (wrong number on the contact) and undo_activity, the lead with 10,008 entries'
select pg_temp.outcome_round(current_setting('perf.heavy')::uuid, current_setting('perf.heavy_contact')::uuid);
reset role;
set auto_explain.log_min_duration = -1;
set role authenticated;

\echo '=== P1, P4, P4b timings: average of 5 warm runs after 10, milliseconds ==='
do $$
declare
  t0 timestamptz;
  g numeric;
  p4 numeric;
  p4b numeric;
  k integer;
  lead uuid;
  contact uuid;
begin
  for k in 1..2 loop
    lead := case k when 1 then current_setting('perf.heavy')::uuid else current_setting('perf.typical')::uuid end;
    contact := case k when 1 then current_setting('perf.heavy_contact')::uuid else current_setting('perf.typical_contact')::uuid end;
    g := 0;
    p4 := 0;
    p4b := 0;
    for r in 1..15 loop
      t0 := clock_timestamp();
      perform public.get_lead(lead);
      if r > 10 then g := g + extract(epoch from clock_timestamp() - t0) * 1000; end if;
      perform pg_temp.outcome_round(lead, contact);
      if r > 10 then
        p4 := p4 + current_setting('perf.p4')::numeric;
        p4b := p4b + current_setting('perf.p4b')::numeric;
      end if;
    end loop;
    raise notice '% : P1 get_lead % ms, P4 log_activity % ms, P4b undo_activity % ms',
      rpad(case k when 1 then 'The lead with 10,008 entries' else 'A typical lead' end, 30),
      round(g / 5, 2), round(p4 / 5, 2), round(p4b / 5, 2);
  end loop;
end $$;
reset role;
do $$ begin perform set_config('request.jwt.claims', '', false); end $$;
