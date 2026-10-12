-- Day 6c stock sheet import at Release 1 size (design docs/evidence/day6/design.md section 11.6: I12 to I14). Runs
-- after perf_stock.sql on the same throwaway database (scripts/db-perf.sh), reusing its seed (5,000 products "Perf
-- product N", 10,000 levels, about 200,000 ledger rows, 600 active holds) and its admin (a6). A 5,000-row sheet: 4,000
-- products already in the CRM (warehouse 2,100 for stocked ones, transit 650 for transit-only ones, prices up 0.10)
-- and 1,000 new ones. Each RPC call runs in its own transaction (psql autocommit), timed by \timing:
--  I12  validate_stock_import at 5,000 rows (policy use_sheet: every product is applied)        ≤ 1,000 ms
--  I13  commit_stock_import chunks of 125 products (the cap rule; 250 missed) / the whole sheet                             ≤ 1,500 ms per call / ≤ 30 s
--  I14  rollback_stock_import chunks of 125                                                     ≤ 1,500 ms per call
-- The lines starting "TIMING" are what perf.md records.
\set ON_ERROR_STOP 1
\set QUIET 1
select set_config('request.jwt.claims', jsonb_build_object('sub', '00000000-0000-0000-0000-0000000000a6',
  'role', 'authenticated', 'aal', 'aal2',
  'amr', jsonb_build_array(jsonb_build_object('method', 'totp', 'timestamp', extract(epoch from now())::bigint)))::text,
  false) \g /dev/null
set role authenticated;
select public.create_stock_import('perf-stock-5000.csv', repeat('cd', 32), 5000, 5001) as batch \gset
-- The rows, in five calls of 1,000 (row r: 2..5001; product n = r - 1).
select public.stage_stock_import_rows(:'batch', (
  select jsonb_agg(jsonb_build_object(
           'row_no', (n + 1)::text,
           'name', case when n <= 4000 then 'Perf product ' || n else 'Perf import new ' || n end,
           'location_kind', case when n <= 4000 and n % 10 in (6, 7) then 'transit' else 'warehouse' end,
           'quantity', case when n > 4000 then '240' when n % 10 in (6, 7) then '650' else '2100' end,
           'pieces_per_carton', '24',
           'price_min', round(1.6 + (n % 50) / 10.0, 2)::text,
           'price_max', round(2.6 + (n % 50) / 10.0, 2)::text,
           'total_cost', (1000 + n % 7)::text,
           'fixes', '[]'::jsonb) order by n)
    from generate_series(1 + 1000 * c, 1000 * (c + 1)) n)) as staged
  from generate_series(0, 4) c \g /dev/null
\timing on
\echo 'TIMING I12 validate_stock_import 5,000 rows (budget 1,000 ms):'
select public.validate_stock_import(:'batch', 'use_sheet') ->> 'status' as status;
\echo 'TIMING I13 commit_stock_import chunks of 125 (budget 1,500 ms each, 30 s in all):'
select format('select public.commit_stock_import(%L, 125) ->> %L as remaining', :'batch', 'remaining') from generate_series(1, 41) \gexec
\timing off
select 'TIMING I13 status ' || status || ', ' || imported || ' products' from public.import_batches where id = :'batch';
\timing on
\echo 'TIMING I14 rollback_stock_import chunks of 125 (budget 1,500 ms each):'
select format('select public.rollback_stock_import(%L, 125) ->> %L as status', :'batch', 'status') from generate_series(1, 41) \gexec
\timing off
select 'TIMING I14 status ' || status || ', kept ' || kept from public.import_batches where id = :'batch';
reset role;
select 'TIMING integrity rows after: ' || count(*) from public.check_stock_integrity();
