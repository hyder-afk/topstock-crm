-- Lead import speed at Release 1 size (design section 6E): runs after perf_leads.sql on the same throwaway database
-- (30,015 leads, 10,015 contacts), as an admin with a fresh two-factor code, row level security on.
--  P1 add 30 chunks of 1,000 rows (5% already in the CRM, 2% repeated in the file, 1% problems, 1% name-only rows)
--  P2 check the whole file   P3 one page of the problems list   P4 import in 30 chunks with 281 leads added meanwhile
--  P5 touch 100 imported leads   P6 undo preview and undo in chunks of 2,000 (100 must stay)
--  P7 a 50,000-row file: add, check, discard.
\set ON_ERROR_STOP 1
\set QUIET 1
insert into auth.users (id, email) values ('00000000-0000-0000-0000-0000000000ad', 'perf-admin@test.invalid');
update public.profiles set role = 'admin' where id = '00000000-0000-0000-0000-0000000000ad';

-- Fresh code: set again before each part (a code counts as fresh for 10 minutes).
create function pg_temp.fresh_admin() returns void language sql as $$
  select set_config('request.jwt.claims', jsonb_build_object('sub', '00000000-0000-0000-0000-0000000000ad',
    'role', 'authenticated', 'aal', 'aal2',
    'amr', jsonb_build_array(jsonb_build_object('method', 'totp', 'timestamp', extract(epoch from now())::bigint)))::text,
    false)
$$;

-- One chunk of fake rows (row numbers first_row .. first_row + n - 1, data row i = row_no - 1).
create function pg_temp.fake_chunk(first_row integer, n integer, total integer) returns jsonb language sql as $$
  select jsonb_agg(case
    when i % 100 = 0 then jsonb_build_object('row_no', i + 1, 'problems', jsonb_build_array('email_invalid'))
    when i % 20 = 1 then jsonb_build_object('row_no', i + 1, 'name', 'Existing again ' || i, 'lead_status', 'cold',
                                            'email', 'contact' || (i * 7 % 30000 + 1) || '@example.com')
    when i % 50 = 2 then jsonb_build_object('row_no', i + 1, 'name', 'Repeat ' || i, 'lead_status', 'cold',
                                            'email', 'imp' || (i - 1) || '@example.org')
    when i % 100 = 3 then jsonb_build_object('row_no', i + 1, 'name', 'Name Only ' || (i % 37), 'lead_status', 'cold',
                                             'city', 'Lyon', 'country', 'FR')
    else jsonb_build_object('row_no', i + 1, 'name', 'Import Co ' || i, 'lead_status', 'warm',
                            'owner_id', '00000000-0000-0000-0000-0000000000ad',
                            'email', 'imp' || i || '@example.org', 'phone', '+44 20 7946 ' || lpad((i % 100000)::text, 5, '0'),
                            'city', (array['Paris', 'Lyon', 'Lille', 'Leeds', 'Gent'])[i % 5 + 1], 'country', 'FR',
                            'last_activity', to_char(timestamp '2025-01-01' + (i % 600) * interval '13 hours', 'YYYY-MM-DD"T"HH24:MI:SS'))
    end order by i)
  from generate_series(first_row - 1, least(first_row + n - 2, total)) as i
$$;

set role authenticated;
select pg_temp.fresh_admin() \g /dev/null

\echo '=== P1-P3: add 30,000 rows in chunks of 1,000, check, problems page (milliseconds) ==='
do $$
declare
  batch uuid;
  chunk jsonb;
  t0 timestamptz;
  ms numeric;
  total_ms numeric := 0;
  max_ms numeric := 0;
  r jsonb;
begin
  batch := public.create_lead_import('perf-30k.csv', null, 30000, 30001);
  for c in 0..29 loop
    chunk := pg_temp.fake_chunk(2 + c * 1000, 1000, 30000);
    t0 := clock_timestamp();
    perform public.stage_lead_import_rows(batch, chunk);
    ms := extract(epoch from clock_timestamp() - t0) * 1000;
    total_ms := total_ms + ms;
    max_ms := greatest(max_ms, ms);
  end loop;
  raise notice 'P1 add rows: 30 calls, average % ms, slowest % ms, total % ms', round(total_ms / 30, 1), round(max_ms, 1), round(total_ms);
  t0 := clock_timestamp();
  r := public.validate_lead_import(batch);
  raise notice 'P2 check 30,000 rows: % ms  (ready %, duplicates %, rejected %)',
    round(extract(epoch from clock_timestamp() - t0) * 1000, 1), r ->> 'ready', r ->> 'duplicates', r ->> 'rejected';
  t0 := clock_timestamp();
  perform count(*) from public.list_lead_import_issues(batch, 0, 1000);
  raise notice 'P3 problems page (1,000 rows): % ms', round(extract(epoch from clock_timestamp() - t0) * 1000, 1);
  perform set_config('perf.batch', batch::text, false);
end $$;

-- Teammates add 281 leads that the file also contains (late duplicates, skipped at import).
reset role;
do $$ begin perform set_config('request.jwt.claims', '', false); end $$;
insert into public.companies (org_id, name, email)
select (select id from public.orgs where name = 'TopStock Wholesale'), 'Added meanwhile ' || i, 'imp' || i || '@example.org'
  from generate_series(1005, 29005, 100) as i;  -- plain rows (i % 100 = 5): not a problem, repeat or name-only row
select 'late duplicates planted: ' || count(*) from public.companies where name like 'Added meanwhile %';
set role authenticated;
select pg_temp.fresh_admin() \g /dev/null

\echo '=== P4: import in chunks of 1,000 ==='
do $$
declare
  batch uuid := current_setting('perf.batch')::uuid;
  r jsonb;
  t0 timestamptz;
  ms numeric;
  total_ms numeric := 0;
  max_ms numeric := 0;
  calls integer := 0;
  late integer := 0;
begin
  loop
    t0 := clock_timestamp();
    r := public.commit_lead_import(batch, 1000);
    ms := extract(epoch from clock_timestamp() - t0) * 1000;
    calls := calls + 1;
    total_ms := total_ms + ms;
    max_ms := greatest(max_ms, ms);
    late := late + (r ->> 'late_duplicates')::integer;
    exit when r ->> 'status' = 'imported';
  end loop;
  raise notice 'P4 import: % calls, average % ms, slowest % ms, total % ms, late duplicates skipped %',
    calls, round(total_ms / calls, 1), round(max_ms, 1), round(total_ms), late;
  raise notice 'P4 result: %', (select jsonb_build_object('imported', imported, 'duplicates', duplicates, 'rejected', rejected,
                                                         'row_count', row_count)
                                 from public.import_batches where id = batch);
end $$;

\echo '=== P5-P6: touch 100 leads, undo preview, undo in chunks of 2,000 ==='
do $$
declare
  batch uuid := current_setting('perf.batch')::uuid;
  r jsonb;
  t0 timestamptz;
  ms numeric;
  total_ms numeric := 0;
  max_ms numeric := 0;
  calls integer := 0;
begin
  perform public.bulk_update_leads(array(select id from public.companies where import_batch_id = batch order by id limit 100),
                                   p_status => 'customer');
  t0 := clock_timestamp();
  r := public.preview_lead_import_rollback(batch);
  raise notice 'P6 undo preview: % ms  %', round(extract(epoch from clock_timestamp() - t0) * 1000, 1), r;
  loop
    t0 := clock_timestamp();
    r := public.rollback_lead_import(batch, 2000);
    ms := extract(epoch from clock_timestamp() - t0) * 1000;
    calls := calls + 1;
    total_ms := total_ms + ms;
    max_ms := greatest(max_ms, ms);
    exit when r ->> 'status' = 'rolled_back';
  end loop;
  raise notice 'P6 undo: % calls, average % ms, slowest % ms, total % ms, kept %',
    calls, round(total_ms / calls, 1), round(max_ms, 1), round(total_ms), r ->> 'kept';
  if (r ->> 'kept')::integer <> 100 then
    raise exception 'FAIL: undo should keep the 100 touched leads';
  end if;
end $$;

\echo '=== P7: a 50,000-row file: add, check, discard ==='
select pg_temp.fresh_admin() \g /dev/null
do $$
declare
  batch uuid;
  t0 timestamptz;
  ms numeric;
  total_ms numeric := 0;
  max_ms numeric := 0;
  r jsonb;
begin
  batch := public.create_lead_import('perf-50k.csv', null, 50000, 50001);
  for c in 0..49 loop
    t0 := clock_timestamp();
    perform public.stage_lead_import_rows(batch, pg_temp.fake_chunk(2 + c * 1000, 1000, 50000));
    ms := extract(epoch from clock_timestamp() - t0) * 1000;
    total_ms := total_ms + ms;
    max_ms := greatest(max_ms, ms);
  end loop;
  raise notice 'P7 add rows (including making each chunk): 50 calls, average % ms, slowest % ms', round(total_ms / 50, 1), round(max_ms, 1);
  t0 := clock_timestamp();
  r := public.validate_lead_import(batch);
  raise notice 'P7 check 50,000 rows: % ms  (ready %, duplicates %, rejected %)',
    round(extract(epoch from clock_timestamp() - t0) * 1000, 1), r ->> 'ready', r ->> 'duplicates', r ->> 'rejected';
  t0 := clock_timestamp();
  perform public.discard_lead_import(batch);
  raise notice 'P7 discard: % ms', round(extract(epoch from clock_timestamp() - t0) * 1000, 1);
end $$;
reset role;
