-- Day 6b inventory reads at Release 1 size (design docs/evidence/day6/design.md section 11.6: I1 to I4). Runs right
-- after perf_stock.sql on the same throwaway database (scripts/db-perf.sh), reusing its seed: 5,000 products (60 % with
-- warehouse stock, 20 % in transit only, 20 % sold out), 10,000 levels, about 200,000 ledger rows and 5,000 holds, and
-- its admin (a6). Each case runs 25 times as that admin through the RPC; runs 6 to 10 print their plans through
-- auto_explain (the generic-plan check, as Day 4), then the p95 (the slowest but one) and the average of runs 11 to 25.
--  I1  list_stock page 1 (100 rows): each sort (name, available, updated), each filter, a search, a category  ≤ 20 ms p95
--  I2  stock_summary                                                                                         ≤ 15 ms
--  I3  get_product (a product with history and holds)                                                         ≤ 8 ms
--  I4  list_movements page 1 / before id 100,000 / a kind filter (50 rows)                                  ≤ 5 / 8 / 30 ms
\set ON_ERROR_STOP 1
\set QUIET 1

select set_config('perf.p_hist', (select m.product_id::text from private.stock_movements m
                                    join private.stock_reservations r on r.product_id = m.product_id and r.status = 'active'
                                   group by m.product_id order by count(*) desc limit 1), false) \g /dev/null
select set_config('perf.mid_id', (select (max(id) / 2)::text from private.stock_movements), false) \g /dev/null

create function pg_temp.fresh() returns void language sql as $$
  select set_config('request.jwt.claims', jsonb_build_object('sub', '00000000-0000-0000-0000-0000000000a6',
    'role', 'authenticated', 'aal', 'aal2',
    'amr', jsonb_build_array(jsonb_build_object('method', 'totp', 'timestamp', extract(epoch from now())::bigint)))::text,
    false)
$$;
grant execute on function pg_temp.fresh() to authenticated;
create function pg_temp.case_name(c integer) returns text language sql immutable as $$
  select (array['I1 list_stock sort name', 'I1 list_stock sort available', 'I1 list_stock sort updated',
                'I1 list_stock filter in_warehouse', 'I1 list_stock filter in_transit', 'I1 list_stock filter low',
                'I1 list_stock filter sold_out', 'I1 list_stock filter held', 'I1 list_stock search "product 12"',
                'I1 list_stock category Bags', 'I1 count_stock all', 'I2 stock_summary', 'I3 get_product',
                'I4 list_movements page 1', 'I4 list_movements before mid id', 'I4 list_movements kind release'])[c]
$$;
create function pg_temp.run_case(c integer) returns numeric language plpgsql as $$
declare
  t0 timestamptz := clock_timestamp();
  n integer;
  j jsonb;
begin
  case c
    when 1 then select count(*) into n from public.list_stock(p_sort => 'name', p_limit => 101);
    when 2 then select count(*) into n from public.list_stock(p_sort => 'available', p_limit => 101);
    when 3 then select count(*) into n from public.list_stock(p_sort => 'updated', p_limit => 101);
    when 4 then select count(*) into n from public.list_stock(p_filter => 'in_warehouse', p_limit => 101);
    when 5 then select count(*) into n from public.list_stock(p_filter => 'in_transit', p_limit => 101);
    when 6 then select count(*) into n from public.list_stock(p_filter => 'low', p_limit => 101);
    when 7 then select count(*) into n from public.list_stock(p_filter => 'sold_out', p_limit => 101);
    when 8 then select count(*) into n from public.list_stock(p_filter => 'held', p_limit => 101);
    when 9 then select count(*) into n from public.list_stock(p_search => 'product 12', p_limit => 101);
    when 10 then select count(*) into n from public.list_stock(p_category => 'Bags', p_limit => 101);
    when 11 then n := public.count_stock();
    when 12 then j := public.stock_summary();
    when 13 then j := public.get_product(current_setting('perf.p_hist')::uuid);
    when 14 then select count(*) into n from public.list_movements(p_limit => 51);
    when 15 then select count(*) into n from public.list_movements(p_before_id => current_setting('perf.mid_id')::bigint, p_limit => 51);
    else select count(*) into n from public.list_movements(p_kinds => array['release'], p_limit => 51);
  end case;
  if (c in (1, 2, 3, 4) and n <> 101) or (c in (14, 15, 16) and n <> 51) then
    raise exception 'FAIL: % returned % rows', pg_temp.case_name(c), n;
  end if;
  return extract(epoch from clock_timestamp() - t0) * 1000;
end;
$$;
grant execute on function pg_temp.run_case(integer), pg_temp.case_name(integer) to authenticated;

set role authenticated;
select pg_temp.fresh() \g /dev/null
\echo '=== I1 to I4: runs 1 to 5 of each case (custom plans), not shown ==='
do $$ begin for c in 1..16 loop for r in 1..5 loop perform pg_temp.run_case(c); end loop; end loop; end $$;
reset role;
\echo '=== I1 to I4 plans: runs 6 to 10 of each case (generic plans from run 6), nested statements via auto_explain ==='
load 'auto_explain';
set auto_explain.log_min_duration = 0;
set auto_explain.log_analyze = on;
set auto_explain.log_nested_statements = on;
set auto_explain.log_timing = on;
set auto_explain.log_level = 'notice';
set client_min_messages = 'notice';
set role authenticated;
do $$
declare
  c integer;
begin
  foreach c in array array[1, 2, 6, 12, 13, 14, 15, 16] loop
    for r in 6..10 loop
      raise notice 'PLAN % run %', pg_temp.case_name(c), r;
      perform pg_temp.run_case(c);
    end loop;
  end loop;
end $$;
reset role;
set auto_explain.log_min_duration = -1;
set role authenticated;
\echo '=== I1 to I4 timings: p95 (2nd slowest of 15) and average of runs 11 to 25, milliseconds ==='
do $$
declare
  ms numeric[];
  budget numeric;
begin
  for c in 1..16 loop
    ms := '{}';
    for r in 11..25 loop
      ms := ms || pg_temp.run_case(c);
    end loop;
    budget := case when c <= 11 then 20 when c = 12 then 15 when c = 13 then 8 when c = 14 then 5 when c = 15 then 8 else 30 end;
    raise notice 'TIMING % : p95 % ms, avg % ms (budget % ms)', rpad(pg_temp.case_name(c), 38),
      round((select x from unnest(ms) x order by x desc offset 1 limit 1), 2),
      round((select avg(x) from unnest(ms) x), 2), budget;
  end loop;
end $$;
reset role;
\echo 'perf_inventory: done'
