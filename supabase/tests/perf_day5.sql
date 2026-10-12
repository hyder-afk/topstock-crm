-- Day 5 speed at Release 1 size (design docs/evidence/day5/design.md section 8.6), part 1 (Day 5a: P1 to P4b, P6; P9 is
-- the Day 3a, Day 4 and Day 3b cases of the same run, read against a run of main; P10 is deal_concurrency.sh p10, run by
-- scripts/db-perf.sh right after this file). Runs after perf_leads.sql and perf_day4.sql (30,015 leads, 300,000
-- activities, 15,000 tasks) and before perf_import.sql, so the import and its undo are timed with 10,000 deals in place.
--  Seed: 10,000 deals: 2,000 open (Lead 900, Qualified 600, Negotiations 500; a fifth with an old stage clock on a lead
--        with no recent activity, so stalled), 5,000 won over 2 years (400 this month), 3,000 lost; 4 history rows each
--        (40,000) plus one deal with 50, inserted as the superuser with triggers off, then vacuum analyze. Owners: the
--        three perf people (a1 is the admin, b4 and c4 are reps).
--  Method: each case 10 times to settle its plans (run 6 logged by auto_explain for the main cases: the generic-plan
--        check), then the average of 5 timed runs, in milliseconds. Write cases run in a block rolled back at the end, so
--        the database and the flood guards stay as they were.
\set ON_ERROR_STOP 1
\set QUIET 1
insert into auth.users (id, email, raw_user_meta_data) values
  ('00000000-0000-0000-0000-00000000000a', 'perf-admin-5@test.invalid', '{"first_name":"Ada"}'),
  ('00000000-0000-0000-0000-0000000005a1', 'perf-rep-5@test.invalid', '{"first_name":"Rae"}'),
  ('00000000-0000-0000-0000-0000000005b1', 'perf-mgr-5@test.invalid', '{"first_name":"Mia"}');
update public.profiles set role = 'admin' where id = '00000000-0000-0000-0000-00000000000a';
update public.profiles set role = 'manager' where id = '00000000-0000-0000-0000-0000000005b1';

-- Seed ----------------------------------------------------------------------------------------------------------------
set session_replication_role = replica;
create temporary table perf_leads5 as
select c.id, c.org_id, row_number() over (order by c.id) as n from public.companies c;
create temporary table perf_people5 (k integer primary key, id uuid not null);
insert into perf_people5 values (0, '00000000-0000-0000-0000-0000000000a1'), (1, '00000000-0000-0000-0000-0000000000b4'),
                                (2, '00000000-0000-0000-0000-0000000000c4');
create temporary table perf_stage5 as
select s.key, s.id, s.org_id, s.stall_days from public.pipeline_stages s join public.orgs o on o.id = s.org_id
 where o.name = 'TopStock Wholesale';
-- Deal g: 1..900 Lead, 901..1500 Qualified, 1501..2000 Negotiations, 2001..7000 won, 7001..10000 lost.
create temporary table perf_deals5 as
select g, gen_random_uuid() as id,
       case when g <= 900 then 'lead' when g <= 1500 then 'qualified' when g <= 2000 then 'negotiations'
            when g <= 7000 then 'won' else 'lost' end as stage,
       1 + (g::bigint * 7919) % 30015 as lead_n,
       g % 3 as person
  from generate_series(1, 10000) g;
insert into public.deals (id, org_id, company_id, stage_id, owner_id, created_by, title, value, currency, expected_close,
                          status, fulfilment, lost_reason, lost_note, stage_entered_at, closed_at, version, created_at,
                          updated_at)
select d.id, l.org_id, l.id, s.id, p.id, p.id, 'Perf deal ' || d.g,
       case when d.stage = 'won' then 500 + (d.g * 37) % 49500 when d.g % 5 = 0 then null else 500 + (d.g * 37) % 49500 end,
       'EUR',
       case when d.g % 4 = 0 then current_date + (d.g % 40) - 10 end,
       case when d.stage in ('won', 'lost') then d.stage else 'open' end,
       case when d.stage = 'won' then (array['from_stock', 'direct_from_source'])[d.g % 2 + 1] end,
       case when d.stage = 'lost' then (array['price', 'timing', 'no_stock', 'competitor', 'no_response', 'shipping', 'mistake',
                                              'other'])[d.g % 8 + 1] end,
       case when d.stage = 'lost' and d.g % 8 = 7 then 'Chose a local supplier' end,
       -- open: a fifth stalled (clock 60 days back), the rest moved in the last 4 days; closed: the close time
       case when d.stage in ('lead', 'qualified', 'negotiations') then
              case when d.g % 5 = 0 then now() - interval '60 days' else now() - (d.g % 96) * interval '1 hour' end
            when d.stage = 'won' and d.g <= 2400 then
              date_trunc('month', now()) + ((d.g * 104729) % greatest(extract(epoch from now() - date_trunc('month', now()))::bigint, 1)) * interval '1 second'
            else now() - interval '32 days' - ((d.g::bigint * 104729) % 60000000) * interval '1 second' end,
       case when d.stage = 'won' and d.g <= 2400 then
              date_trunc('month', now()) + ((d.g * 104729) % greatest(extract(epoch from now() - date_trunc('month', now()))::bigint, 1)) * interval '1 second'
            when d.stage in ('won', 'lost') then now() - interval '32 days' - ((d.g::bigint * 104729) % 60000000) * interval '1 second' end,
       3,
       now() - interval '800 days', now() - interval '1 day'
  from perf_deals5 d
  join perf_leads5 l on l.n = d.lead_n
  join perf_stage5 s on s.key = d.stage
  join perf_people5 p on p.k = d.person;
-- The stalled fifth sits on leads with no activity for 90 days (the rule also reads the lead's last activity).
update public.companies c set last_activity_at = now() - interval '90 days'
  from perf_deals5 d join perf_leads5 l on l.n = d.lead_n
 where c.id = l.id and d.g <= 2000 and d.g % 5 = 0;
-- History: open (lead), then three moves ending at the deal's stage; versions 0 to 3.
insert into public.deal_stage_history (org_id, deal_id, actor_id, kind, from_stage, to_stage, value_before, value_after,
                                       lost_reason, version_after, created_at)
select l.org_id, d.id, p.id,
       case when step.k = 0 then 'open' when step.k = 3 and d.stage in ('won', 'lost') then d.stage else 'move' end,
       case step.k when 0 then null else (case d.stage
              when 'lead' then array['lead', 'qualified', 'negotiations']
              when 'qualified' then array['lead', 'negotiations', 'lead']
              when 'negotiations' then array['lead', 'qualified', 'lead']
              else array['lead', 'qualified', 'negotiations'] end)[step.k] end,
       (case d.stage
          when 'lead' then array['lead', 'qualified', 'negotiations', 'lead']
          when 'qualified' then array['lead', 'negotiations', 'lead', 'qualified']
          when 'negotiations' then array['lead', 'qualified', 'lead', 'negotiations']
          else array['lead', 'qualified', 'negotiations', d.stage] end)[step.k + 1],
       null, null, case when step.k = 3 and d.stage = 'lost' then 'price' end, step.k,
       now() - interval '800 days' + step.k * interval '1 day'
  from perf_deals5 d
  join perf_leads5 l on l.n = d.lead_n
  join perf_people5 p on p.k = d.person
 cross join generate_series(0, 3) as step (k);
set session_replication_role = origin;
vacuum analyze public.deals;
vacuum analyze public.deal_stage_history;
vacuum analyze public.companies;
select 'seeded: ' || count(*) || ' deals (' || count(*) filter (where status = 'open') || ' open: '
       || (select count(*) from public.deals d join public.pipeline_stages s on s.id = d.stage_id where s.key = 'lead')
       || ' Lead, ' || (select count(*) from public.deals d join public.pipeline_stages s on s.id = d.stage_id where s.key = 'qualified')
       || ' Qualified, ' || (select count(*) from public.deals d join public.pipeline_stages s on s.id = d.stage_id where s.key = 'negotiations')
       || ' Negotiations; ' || count(*) filter (where status = 'won') || ' won, '
       || count(*) filter (where status = 'won' and closed_at >= date_trunc('month', now())) || ' this month; '
       || count(*) filter (where status = 'lost') || ' lost), '
       || (select count(*) from public.deal_stage_history) || ' history rows'
  from public.deals;

-- The probes: a Lead page at row 500 (team), a deal with 50 history rows, and leads for the write cases (admin a1 may
-- change every lead; each lead is set to Negotiation, so a loss runs the other-open-deal check).
select set_config('perf.cur_at', x.stage_entered_at::text, false), set_config('perf.cur_id', x.id::text, false)
  from (select d.stage_entered_at, d.id from public.deals d join public.pipeline_stages s on s.id = d.stage_id
         where d.status = 'open' and s.key = 'lead' order by d.stage_entered_at desc, d.id desc offset 499 limit 1) x \g /dev/null
select set_config('perf.hist_deal', (select id::text from perf_deals5 where g = 1505), false) \g /dev/null
insert into public.deal_stage_history (org_id, deal_id, actor_id, kind, from_stage, to_stage, version_after, created_at)
select d.org_id, d.id, '00000000-0000-0000-0000-0000000000a1', 'move',
       case when k % 2 = 1 then 'negotiations' else 'qualified' end, case when k % 2 = 1 then 'qualified' else 'negotiations' end,
       3 + k, now() - interval '700 days' + k * interval '1 hour'
  from public.deals d cross join generate_series(1, 46) k where d.id = current_setting('perf.hist_deal')::uuid;
update public.deals set version = 49 where id = current_setting('perf.hist_deal')::uuid;
select set_config('perf.q_deal', (select id::text from perf_deals5 where g = 905), false),   -- Qualified
       set_config('perf.n_deal', (select id::text from perf_deals5 where g = 1503), false),  -- Negotiations
       set_config('perf.open_lead', (select l.id::text from perf_leads5 l where l.n = 4242), false) \g /dev/null
update public.companies set lead_status = 'negotiation'
 where id in (select company_id from public.deals where id in (current_setting('perf.q_deal')::uuid, current_setting('perf.n_deal')::uuid))
    or id = current_setting('perf.open_lead')::uuid;
vacuum analyze public.deal_stage_history;
vacuum analyze public.companies;

create function pg_temp.as_perf(sub text, fresh boolean default true) returns void language sql as $$
  select set_config('request.jwt.claims', jsonb_build_object('sub', sub, 'role', 'authenticated', 'aal', 'aal2',
    'amr', case when fresh then jsonb_build_array(jsonb_build_object('method', 'totp',
                                                                     'timestamp', extract(epoch from now())::bigint))
                else '[]'::jsonb end)::text, false)
$$;

-- One round of the write cases, rolled back; each time in milliseconds goes to perf.w<n> (set after the rollback).
--  1 move Qualified -> Negotiations (lead lock, guard, history, coupling, move record, with a request id)
--  2 win (Negotiations -> Won)   3 lose (the other-open-deal check)   4 undo by move (the reverse of 1, within 120 s)
--  5 open_deal   6 update_deal (value)   7 delete_deal (admin, fresh code)
create function pg_temp.write_round() returns void
language plpgsql as $$
declare
  q constant uuid := current_setting('perf.q_deal')::uuid;
  n constant uuid := current_setting('perf.n_deal')::uuid;
  t0 timestamptz;
  ms numeric[] := array[0, 0, 0, 0, 0, 0, 0];
  r jsonb;
  v integer;
begin
  begin
    t0 := clock_timestamp();
    r := public.move_deal(q, 'negotiations', (select version from public.deals where id = q), p_request_id => gen_random_uuid());
    ms[1] := extract(epoch from clock_timestamp() - t0) * 1000;
    if r ->> 'result' <> 'moved' then raise exception 'FAIL: P4 move %', r; end if;
    t0 := clock_timestamp();
    r := public.move_deal(q, 'qualified', (r -> 'deal' ->> 'version')::integer, p_undo_of => (r ->> 'history_id')::bigint);
    ms[4] := extract(epoch from clock_timestamp() - t0) * 1000;
    if not (r ->> 'undone')::boolean then raise exception 'FAIL: P4 undo %', r; end if;
    v := (select version from public.deals where id = n);
    t0 := clock_timestamp();
    r := public.move_deal(n, 'won', v, 12400, 'from_stock');
    ms[2] := extract(epoch from clock_timestamp() - t0) * 1000;
    if r -> 'deal' ->> 'status' <> 'won' then raise exception 'FAIL: P4 win %', r; end if;
    t0 := clock_timestamp();
    r := public.move_deal(q, 'lost', (select version from public.deals where id = q), p_lost_reason => 'price');
    ms[3] := extract(epoch from clock_timestamp() - t0) * 1000;
    if r -> 'deal' ->> 'status' <> 'lost' then raise exception 'FAIL: P4 lose %', r; end if;
    t0 := clock_timestamp();
    r := public.open_deal(current_setting('perf.open_lead')::uuid, 'Perf open', 900, p_request_id => gen_random_uuid());
    ms[5] := extract(epoch from clock_timestamp() - t0) * 1000;
    if r -> 'deal' ->> 'stage' <> 'lead' then raise exception 'FAIL: P4 open %', r; end if;
    t0 := clock_timestamp();
    r := public.update_deal((r -> 'deal' ->> 'id')::uuid, 0, '{value}', p_value => 1100);
    ms[6] := extract(epoch from clock_timestamp() - t0) * 1000;
    if r ->> 'result' <> 'updated' then raise exception 'FAIL: P4b update %', r; end if;
    t0 := clock_timestamp();
    perform public.delete_deal(n);
    ms[7] := extract(epoch from clock_timestamp() - t0) * 1000;
    raise exception 'undo' using errcode = 'TS001';
  exception when sqlstate 'TS001' then null;
  end;
  for i in 1..7 loop
    perform set_config('perf.w' || i, ms[i]::text, false);
  end loop;
end;
$$;

\echo '=== Plan check: 5 runs to settle, then run 6 of the main cases with every inner statement logged (auto_explain) ==='
load 'auto_explain';
set auto_explain.log_analyze = on;
set auto_explain.log_nested_statements = on;
set auto_explain.log_timing = on;
set auto_explain.log_level = 'notice';
set auto_explain.log_min_duration = -1;
set client_min_messages = 'notice';
set role authenticated;
select pg_temp.as_perf('00000000-0000-0000-0000-0000000000a1') \g /dev/null
do $$
begin
  for r in 1..5 loop
    perform public.pipeline_board('team');
    perform count(*) from public.list_stage_deals('lead', 'team', null, false, 'recent', current_setting('perf.cur_at')::timestamptz,
                                                  current_setting('perf.cur_id')::uuid, 50);
    perform public.get_deal(current_setting('perf.hist_deal')::uuid);
    perform pg_temp.write_round();
  end loop;
end $$;
reset role;
set auto_explain.log_min_duration = 1;  -- run 6: inner statements slower than 1 ms
set role authenticated;
\echo '--- P1 run 6: pipeline_board team (admin)'
select jsonb_array_length(public.pipeline_board('team') -> 'stages') as columns;
\echo '--- P2 run 6: list_stage_deals, Lead page at row 500 (team)'
select count(*) from public.list_stage_deals('lead', 'team', null, false, 'recent', current_setting('perf.cur_at')::timestamptz,
                                             current_setting('perf.cur_id')::uuid, 50);
\echo '--- P6 run 6: get_deal with 50 history rows'
select public.get_deal(current_setting('perf.hist_deal')::uuid) is not null as found;
\echo '--- P4 and P4b run 6: the write round'
select pg_temp.write_round();
reset role;
set auto_explain.log_min_duration = -1;

\echo '=== Timings: average of 5 warm runs after 10, milliseconds ==='
set role authenticated;
do $$
declare
  t0 timestamptz;
  total numeric;
  n integer;
  c integer;
  j jsonb;
  label text;
  budget numeric;
  admin constant text := '00000000-0000-0000-0000-0000000000a1';
  rep constant text := '00000000-0000-0000-0000-0000000000b4';
begin
  for c in 1..11 loop
    perform pg_temp.as_perf(case when c in (2, 6) then rep else admin end);
    for r in 1..15 loop
      t0 := clock_timestamp();
      case c
        when 1 then j := public.pipeline_board('team');
        when 2 then j := public.pipeline_board('mine');
        when 3 then select count(*) into n from public.list_stage_deals('lead', 'team', null, false, 'recent',
                      current_setting('perf.cur_at')::timestamptz, current_setting('perf.cur_id')::uuid, 50);
        when 4 then select count(*) into n from public.list_stage_deals('lead', 'team', null, true);
        when 5 then select count(*) into n from public.list_stage_deals('qualified', 'team', '00000000-0000-0000-0000-0000000000b4');
        when 6 then select count(*) into n from public.list_stage_deals('lead', 'mine');
        when 7 then select count(*) into n from public.list_stage_deals('won');
        when 8 then select count(*) into n from public.list_stage_deals('lost');
        when 9 then j := public.pipeline_summary('team');
        when 10 then j := public.get_deal(current_setting('perf.hist_deal')::uuid);
        else select count(*) into n from public.list_lead_deals((select company_id from public.deals
                                                                   where id = current_setting('perf.hist_deal')::uuid));
      end case;
      if r = 11 then total := 0; end if;
      if r > 10 then total := total + extract(epoch from clock_timestamp() - t0) * 1000; end if;
    end loop;
    label := (array['P1 pipeline_board team (admin, 50 a column)', 'P1 pipeline_board mine (rep)',
                    'P2 list_stage_deals Lead at row 500 (team)', 'P2 list_stage_deals Lead stalled only (team)',
                    'P2 list_stage_deals Qualified, one owner', 'P2 list_stage_deals Lead mine (rep)',
                    'P2 list_stage_deals won (team)', 'P2 list_stage_deals lost (team)', 'P3 pipeline_summary team',
                    'P6 get_deal (50 history rows)', 'P6 list_lead_deals'])[c];
    budget := (array[25, 15, 5, 5, 5, 5, 5, 5, 10, 5, 3])[c];
    raise notice '% : % ms (budget % ms)%', rpad(label, 46), round(total / 5, 2), budget,
      case when c = 1 then ' ' || (j -> 'open_total' ->> 'count') || ' open, ' || jsonb_array_length(j -> 'stages' -> 0 -> 'cards') || ' cards in Lead'
           when c = 2 then ' ' || (j -> 'open_total' ->> 'count') || ' open'
           when c = 9 then ' stalled ' || (select string_agg(e ->> 'stalled', '/') from jsonb_array_elements(j -> 'stages') e)
           when c in (3, 4, 5, 6, 7, 8, 11) then ' ' || n || ' rows' else '' end;
  end loop;
end $$;

do $$
declare
  w numeric[] := array[0, 0, 0, 0, 0, 0, 0];
begin
  perform pg_temp.as_perf('00000000-0000-0000-0000-0000000000a1');
  for r in 1..15 loop
    perform pg_temp.write_round();
    if r > 10 then
      for i in 1..7 loop
        w[i] := w[i] + current_setting('perf.w' || i)::numeric;
      end loop;
    end if;
  end loop;
  raise notice '% : % ms (budget 10 ms)', rpad('P4 move_deal (lead lock, coupling, record)', 46), round(w[1] / 5, 2);
  raise notice '% : % ms (budget 10 ms)', rpad('P4 move_deal win', 46), round(w[2] / 5, 2);
  raise notice '% : % ms (budget 10 ms)', rpad('P4 move_deal lose (other open deal check)', 46), round(w[3] / 5, 2);
  raise notice '% : % ms (budget 10 ms)', rpad('P4 move_deal undo by reverse move', 46), round(w[4] / 5, 2);
  raise notice '% : % ms (budget 10 ms)', rpad('P4 open_deal', 46), round(w[5] / 5, 2);
  raise notice '% : % ms (budget 6 ms)', rpad('P4b update_deal', 46), round(w[6] / 5, 2);
  raise notice '% : % ms (budget 10 ms)', rpad('P4b delete_deal (admin, fresh code)', 46), round(w[7] / 5, 2);
end $$;

\echo '=== P6/P9: get_lead on a lead with deals (unchanged by 5a; 5b adds the deals brief), average of 5 after 10 ==='
do $$
declare
  t0 timestamptz;
  total numeric := 0;
  lead uuid := (select company_id from public.deals where id = current_setting('perf.hist_deal')::uuid);
begin
  perform pg_temp.as_perf('00000000-0000-0000-0000-0000000000a1');
  for r in 1..15 loop
    t0 := clock_timestamp();
    perform public.get_lead(lead);
    if r > 10 then total := total + extract(epoch from clock_timestamp() - t0) * 1000; end if;
  end loop;
  raise notice '% : % ms', rpad('P6 get_lead (a lead with deals)', 46), round(total / 5, 2);
end $$;
reset role;
do $$ begin perform set_config('request.jwt.claims', '', false); end $$;
