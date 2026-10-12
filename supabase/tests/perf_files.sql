-- Day 4d speed (design docs/evidence/day4/design.md section 8.6, P11): begin_file_upload and finish_file_upload with
-- 5,000 files already stored (stand-in objects), as a signed-in rep, row level security on. Runs after perf_leads.sql
-- (30,015 leads) on the same throwaway database (scripts/db-perf.sh). Locally storage.objects is
-- supabase/tests/storage_shim.sql's stand-in, with the real schema's unique (bucket_id, name) index.
--  Seed: 5,000 ready files with their objects (1,000 on one lead, 4,000 over 400 leads), inserted with triggers off.
--  P11:  one round = take_stale_uploads (the stale clean-up, its own call since verifier 4d round 2 finding 4), then
--        begin_file_upload (pre-checks, the insert guard's limits and the team-space sum under the advisory lock), the
--        bytes (not timed), finish_file_upload (the update guard's object match), each timed on its own; rolled
--        back, so the hourly limit and the space never fill. 10 rounds to settle the plans, then the average of 5;
--        round 6 logs every inner statement's plan (auto_explain), the generic-plan check.
\set ON_ERROR_STOP 1
\set QUIET 1
insert into auth.users (id, email) values ('00000000-0000-0000-0000-0000000000f9', 'perf-files-rep@test.invalid');

set session_replication_role = replica;
create temporary table perf_file_leads as
select c.id, c.org_id, row_number() over (order by c.id) as n from public.companies c order by c.id limit 401;
insert into public.files (id, org_id, company_id, name, mime, size, uploaded_by, status, ready_at, storage_path, created_at, updated_at)
select x.id, l.org_id, l.id, 'Catalogue ' || x.g || '.pdf', 'application/pdf', 100000 + x.g, '00000000-0000-0000-0000-0000000000f9',
       'ready', now(), l.org_id || '/' || l.id || '/' || x.id || '.pdf', now() - x.g * interval '1 minute', now() - x.g * interval '1 minute'
  from (select g, gen_random_uuid() as id from generate_series(1, 5000) g) x
  join perf_file_leads l on l.n = case when x.g <= 1000 then 1 else 2 + x.g % 400 end;
insert into storage.objects (bucket_id, name, owner, metadata)
select 'lead-files', f.storage_path, f.uploaded_by, jsonb_build_object('size', f.size, 'mimetype', f.mime) from public.files f;
set session_replication_role = origin;
vacuum analyze public.files;
vacuum analyze storage.objects;
select set_config('perf.lead', (select id::text from perf_file_leads where n = 1), false) \g /dev/null
select 'files seeded: ' || count(*) || ' ready, ' || pg_size_pretty(sum(size)::bigint) || ' declared; objects: '
       || (select count(*) from storage.objects) from public.files;

-- One upload round, rolled back; the three times (ms) come back in perf.take, perf.begin and perf.finish.
create function pg_temp.upload_round(lead uuid) returns void
language plpgsql as $$
declare
  t0 timestamptz;
  r jsonb;
  ms_take numeric;
  ms_begin numeric;
  ms_finish numeric;
begin
  begin
    t0 := clock_timestamp();
    perform public.take_stale_uploads();
    ms_take := extract(epoch from clock_timestamp() - t0) * 1000;
    t0 := clock_timestamp();
    r := public.begin_file_upload(lead, 'Devis printemps.pdf', 'application/pdf', 250000);
    ms_begin := extract(epoch from clock_timestamp() - t0) * 1000;
    insert into storage.objects (bucket_id, name, owner, metadata)
    values ('lead-files', r ->> 'path', (select auth.uid()), '{"size": 250000, "mimetype": "application/pdf"}');
    t0 := clock_timestamp();
    perform public.finish_file_upload((r ->> 'id')::uuid);
    ms_finish := extract(epoch from clock_timestamp() - t0) * 1000;
    raise exception 'undo' using errcode = 'TS001';
  exception when sqlstate 'TS001' then null;
  end;
  perform set_config('perf.take', ms_take::text, false);
  perform set_config('perf.begin', ms_begin::text, false);
  perform set_config('perf.finish', ms_finish::text, false);
end;
$$;

set role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000f9","role":"authenticated","aal":"aal2"}', false) \g /dev/null
\echo '=== P11 plan check: 5 rounds to settle, then round 6 with every inner statement logged (auto_explain) ==='
do $$ begin for r in 1..5 loop perform pg_temp.upload_round(current_setting('perf.lead')::uuid); end loop; end $$;
reset role;
load 'auto_explain';
set auto_explain.log_min_duration = 0;
set auto_explain.log_analyze = on;
set auto_explain.log_nested_statements = on;
set auto_explain.log_timing = on;
set auto_explain.log_level = 'notice';
set client_min_messages = 'notice';
set role authenticated;
select pg_temp.upload_round(current_setting('perf.lead')::uuid);
reset role;
set auto_explain.log_min_duration = -1;
set role authenticated;

\echo '=== P11 timings: average of 5 warm rounds after 10, milliseconds (budget 10 ms each) ==='
do $$
declare
  t numeric := 0;
  b numeric := 0;
  f numeric := 0;
begin
  for r in 1..15 loop
    perform pg_temp.upload_round(current_setting('perf.lead')::uuid);
    if r > 10 then
      t := t + current_setting('perf.take')::numeric;
      b := b + current_setting('perf.begin')::numeric;
      f := f + current_setting('perf.finish')::numeric;
    end if;
  end loop;
  raise notice 'P11 take_stale_uploads : % ms', round(t / 5, 2);
  raise notice 'P11 begin_file_upload  : % ms', round(b / 5, 2);
  raise notice 'P11 finish_file_upload : % ms', round(f / 5, 2);
end $$;
reset role;
