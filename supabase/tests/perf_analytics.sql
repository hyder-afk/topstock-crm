-- Analytics v1 P1 speed at Release 1 size (design docs/evidence/analytics/design.md section 3.7). Runs in
-- scripts/db-perf.sh right after perf_sales.sql, on the same throwaway database and its seed: 30,015 leads (created over
-- 900 days, none imported), 300,000 activities over 2 years by a1, b4 and c4, 15,000 tasks, 10,000 deals with 40,000
-- history rows, and 10,000 sales with 30,000 lines over 200 days (recorded by a6).
--  Cases: each of the seven functions for 30, 90 and 365 days (the range ends on Paris today), as admin 0a (perf_day5;
--         the team) and for one person: rep b4 for activity, call times, pipeline, speed and coverage (his own figures,
--         as himself), admin 0a picking a6 for sales (the person who recorded every sale). List quality: 20 imported
--         batches over the 30,015 leads (made inside a transaction rolled back at the end, so perf_import.sql meets the
--         database as before), team and one person.
--  Method: 5 runs to warm the caches, then the average of 5 timed runs, in milliseconds, with the design's local budget
--         and the x3 projection for Supabase Free (design 3.7: the slowest at 90 days x3 under 1 s, at 365 days x3 under
--         1.5 s). Every function forces custom plans (plan_cache_mode), so later runs cannot switch to a generic plan;
--         one auto_explain pass of the 365-day team activity and call-time reads shows the index paths.
\set ON_ERROR_STOP 1
\set QUIET 1

create function pg_temp.as_perf(sub text) returns void language sql as $$
  select set_config('request.jwt.claims', jsonb_build_object('sub', sub, 'role', 'authenticated', 'aal', 'aal2')::text, false)
$$;
-- Times one statement (5 warm runs, then the average of 5) and prints it next to its budget and the x3 projection.
create function pg_temp.time_case(label text, stmt text, budget numeric) returns numeric
language plpgsql as $$
declare
  t0 timestamptz;
  total numeric := 0;
  ms numeric;
begin
  for r in 1..10 loop
    t0 := clock_timestamp();
    execute stmt;
    if r > 5 then total := total + extract(epoch from clock_timestamp() - t0) * 1000; end if;
  end loop;
  ms := round(total / 5, 1);
  raise notice '% : % ms  x3 % ms  (budget % ms)%', rpad(label, 52), lpad(ms::text, 7), lpad((ms * 3)::text, 7), budget,
    case when ms > budget then '  OVER BUDGET' else '' end;
  return ms;
end;
$$;

select set_config('perf.admin', '00000000-0000-0000-0000-00000000000a', false),
       set_config('perf.rep', '00000000-0000-0000-0000-0000000000b4', false),
       set_config('perf.seller', '00000000-0000-0000-0000-0000000000a6', false) \g /dev/null
do $$
begin
  if (select role from public.profiles where id = current_setting('perf.admin')::uuid) <> 'admin'
     or (select role from public.profiles where id = current_setting('perf.rep')::uuid) <> 'rep'
     or (select org_id from public.profiles where id = current_setting('perf.seller')::uuid)
        <> (select org_id from public.profiles where id = current_setting('perf.admin')::uuid) then
    raise exception 'FAIL: perf_analytics needs perf_day5.sql (admin 0a), perf_day4.sql (rep b4) and perf_stock.sql (a6)';
  end if;
end $$;
select 'seed: ' || (select count(*) from public.activities) || ' activities, ' || (select count(*) from public.companies)
       || ' leads, ' || (select count(*) from public.deals) || ' deals, ' || (select count(*) from private.orders) || ' sales' as seed;

\echo '=== Analytics P1: warm averages (5 runs after 5), local PostgreSQL 16, row level security on ==='
set role authenticated;
do $$
declare
  admin constant text := current_setting('perf.admin');
  rep constant text := current_setting('perf.rep');
  seller constant text := current_setting('perf.seller');
  today constant date := (now() at time zone 'Europe/Paris')::date;
  days integer;
  span text;
  f text;
  b30 numeric; b90 numeric; b365 numeric;
  ms numeric;
  worst90 numeric := 0;
  worst365 numeric := 0;
begin
  foreach f in array array['analytics_activity', 'analytics_pipeline', 'analytics_speed', 'analytics_call_times', 'analytics_sales'] loop
    b30 := case f when 'analytics_activity' then 60 when 'analytics_pipeline' then 40 when 'analytics_speed' then 40
                  when 'analytics_call_times' then 60 else 30 end;
    b90 := case f when 'analytics_activity' then 150 when 'analytics_pipeline' then 60 when 'analytics_speed' then 80
                  when 'analytics_call_times' then 150 else 80 end;
    b365 := case f when 'analytics_activity' then 400 when 'analytics_pipeline' then 120 when 'analytics_speed' then 200
                   when 'analytics_call_times' then 400 else 200 end;
    foreach days in array array[30, 90, 365] loop
      span := quote_literal(today - (days - 1)) || ', ' || quote_literal(today);
      perform pg_temp.as_perf(admin);
      ms := pg_temp.time_case(f || ' ' || days || 'd team (admin)', 'select public.' || f || '(' || span || ')',
                              case days when 30 then b30 when 90 then b90 else b365 end);
      if days = 90 then worst90 := greatest(worst90, ms); elsif days = 365 then worst365 := greatest(worst365, ms); end if;
      if f = 'analytics_sales' then
        ms := pg_temp.time_case(f || ' ' || days || 'd person (admin picks a6)',
                                'select public.' || f || '(' || span || ', ' || quote_literal(seller) || ')',
                                case days when 30 then b30 when 90 then b90 else b365 end);
      else
        perform pg_temp.as_perf(rep);
        ms := pg_temp.time_case(f || ' ' || days || 'd own (rep b4)', 'select public.' || f || '(' || span || ')',
                                case days when 30 then b30 when 90 then b90 else b365 end);
      end if;
      if days = 90 then worst90 := greatest(worst90, ms); elsif days = 365 then worst365 := greatest(worst365, ms); end if;
    end loop;
  end loop;
  perform pg_temp.as_perf(admin);
  perform pg_temp.time_case('analytics_coverage team (admin, 30 days idle)', 'select public.analytics_coverage()', 60);
  perform pg_temp.as_perf(rep);
  perform pg_temp.time_case('analytics_coverage own (rep b4)', 'select public.analytics_coverage()', 60);
  raise notice 'slowest at 90 days: % ms, x3 % ms (page budget: x3 under 1000 ms)%', worst90, worst90 * 3,
    case when worst90 * 3 >= 1000 then '  OVER' else '' end;
  raise notice 'slowest at 365 days: % ms, x3 % ms (page budget: x3 under 1500 ms)%', worst365, worst365 * 3,
    case when worst365 * 3 >= 1500 then '  OVER' else '' end;
end $$;
reset role;

\echo '=== List quality: 20 imported batches over the 30,015 leads (rolled back) ==='
begin;
set local session_replication_role = replica;  -- seed rows: no import guard, no audit rows
insert into public.import_batches (org_id, kind, filename, status, created_at, file_sha256)
select (select org_id from public.profiles where id = current_setting('perf.admin')::uuid), 'leads',
       'perf batch ' || g || '.csv', 'imported', now() - interval '800 days' + g * interval '1 day', repeat('f', 64)
  from generate_series(1, 20) g;
update public.companies c set import_batch_id = b.id
  from (select id, row_number() over (order by created_at) - 1 as k from public.import_batches where filename like 'perf batch %') b
 where b.k = (hashtext(c.id::text) & 2147483647) % 20;
set local session_replication_role = origin;
analyze public.companies;
set local role authenticated;
do $$
begin
  perform pg_temp.as_perf(current_setting('perf.admin'));
  perform pg_temp.time_case('analytics_batches 20 batches team (admin)', 'select public.analytics_batches()', 400);
  perform pg_temp.time_case('analytics_batches 20 batches person (picks b4)',
                            'select public.analytics_batches(' || quote_literal(current_setting('perf.rep')) || ')', 400);
  raise notice 'batches: % rows, % leads', jsonb_array_length(public.analytics_batches()),
    (select sum((e ->> 'leads')::integer) from jsonb_array_elements(public.analytics_batches()) e);
end $$;
rollback;
analyze public.companies;

\echo '=== Plans of the 365-day team activity and call-time reads (auto_explain, nested statements) ==='
load 'auto_explain';
set auto_explain.log_analyze = on;
set auto_explain.log_nested_statements = on;
set auto_explain.log_timing = off;
set auto_explain.log_level = 'notice';
set auto_explain.log_min_duration = 0;
set client_min_messages = 'notice';
set role authenticated;
select pg_temp.as_perf(current_setting('perf.admin')) \g /dev/null
select public.analytics_activity(((now() at time zone 'Europe/Paris')::date - 364), (now() at time zone 'Europe/Paris')::date) \g /dev/null
reset role;
set auto_explain.log_min_duration = -1;
set client_min_messages = 'warning';
do $$ begin perform set_config('request.jwt.claims', '', false); end $$;
