-- Day 6d sales and lead stock speed at Release 1 size (design docs/evidence/day6/design.md section 11.6: I6, I8). Runs
-- after perf_stock.sql (and perf_inventory.sql) on the same throwaway database (scripts/db-perf.sh), reusing its seed
-- (5,000 products, 10,000 levels, about 200,000 ledger rows, 5,000 holds) and its admin (a6).
--  Seed: 10,000 sales with 30,000 lines on the first 1,000 leads (half Warehouse inventory, half Supplier Stock; a
--        tenth cancelled) and 2,000 team requests with 4,000 lines, written with triggers off (the reads never join the
--        ledger, so the sales carry no ship rows); then one lead gets 50 sales of 3 lines (seeded the same way), 20
--        requests (seeded) and 20 holds (through post_stock_movement as the admin, so the levels stay exact).
--  I6:   record_sale with 1 / 10 / 20 Warehouse inventory lines (stocked products, max price) as the admin with a fresh
--        code; each run rolled back by a savepoint (the rate guards and the stock stay put).   ≤ 10 / 25 / 40 ms
--  I8:   get_lead_stock of that lead (50 sales, 20 holds, 20 requests).                       ≤ 15 ms
--  Also timed (no design budget; the Sales and Requests tabs and the Home card): list_sales page 1 (all leads),
--  list_stock_requests page 1 (open), stock_alerts.
-- Each case: runs 1 to 5 not shown, runs 6 to 10 print their plans through auto_explain (the generic-plan check, as
-- Day 4), then the p95 (the slowest but one) and the average of runs 11 to 25.
\set ON_ERROR_STOP 1
\set QUIET 1

select set_config('perf.org', (select id::text from public.orgs order by created_at limit 1), false) \g /dev/null
create temporary table perf_leads as
select c.id, row_number() over (order by c.id) as n from public.companies c where c.org_id = current_setting('perf.org')::uuid;
-- The stocked products (warehouse on hand 2,000, nothing held there by the I8 lead yet), in a fixed order.
create temporary table perf_stocked as
select row_number() over (order by p.name) as n, p.id, p.name, p.price_max
  from public.products p join public.stock_levels l on l.product_id = p.id
  join public.locations x on x.id = l.location_id and x.kind = 'warehouse'
 where l.on_hand = 2000 and l.reserved = 0 and p.name like 'Perf product %';
-- Two leads of their own (never in the bulk seed): I8's and the one I6 sells to.
with c as (insert into public.companies (org_id, name, owner_id)
           values (current_setting('perf.org')::uuid, 'Perf I8 lead', '00000000-0000-0000-0000-0000000000a6') returning id)
select set_config('perf.lead', c.id::text, false) from c \g /dev/null
with c as (insert into public.companies (org_id, name, owner_id)
           values (current_setting('perf.org')::uuid, 'Perf I6 lead', '00000000-0000-0000-0000-0000000000a6') returning id)
select set_config('perf.sale_lead', c.id::text, false) from c \g /dev/null

-- Seed ----------------------------------------------------------------------------------------------------------------
set session_replication_role = replica;
create temporary table perf_o as
select o, gen_random_uuid() as id,
       case when o <= 50 then current_setting('perf.lead')::uuid
            else (select id from perf_leads where n = 1 + (o * 7919) % 1000) end as company_id,
       case when o % 2 = 0 then 'from_stock' else 'direct_from_source' end as fulfilment,
       case when o % 10 = 3 then 'cancelled' else 'confirmed' end as status,
       now() - interval '200 days' + o * interval '27 minutes' as at
  from generate_series(1, 10050) o;
insert into private.orders (id, org_id, company_id, fulfilment, status, created_by, created_at, updated_at, cancelled_at,
                            cancelled_by, cancel_reason)
select o.id, current_setting('perf.org')::uuid, o.company_id, o.fulfilment, o.status,
       '00000000-0000-0000-0000-0000000000a6', o.at, o.at,
       case when o.status = 'cancelled' then o.at + interval '1 hour' end,
       case when o.status = 'cancelled' then '00000000-0000-0000-0000-0000000000a6'::uuid end,
       case when o.status = 'cancelled' then 'perf seed' end
  from perf_o o;
insert into private.order_lines (order_id, org_id, position, product_id, product_name, quantity, unit_price)
select o.id, current_setting('perf.org')::uuid, g, s.id, s.name, 24 * (1 + (o.o + g) % 20), s.price_max
  from perf_o o cross join generate_series(1, 3) g
  join perf_stocked s on s.n = 1 + (o.o * 3 + g) % (select count(*) from perf_stocked);
create temporary table perf_r as
select r, gen_random_uuid() as id,
       case when r <= 20 then current_setting('perf.lead')::uuid
            else (select id from perf_leads where n = 1 + (r * 104729) % 1000) end as company_id,
       (array['new', 'in_progress', 'done', 'declined'])[1 + r % 4] as status,
       now() - interval '100 days' + r * interval '71 minutes' as at
  from generate_series(1, 2020) r;
insert into private.stock_requests (id, org_id, company_id, source, status, note, created_by, created_at, updated_at)
select r.id, current_setting('perf.org')::uuid, r.company_id, 'team', r.status, 'Perf request ' || r.r,
       '00000000-0000-0000-0000-0000000000a6', r.at, r.at
  from perf_r r;
insert into private.stock_request_lines (request_id, position, org_id, product_id, description, quantity, unit, pieces,
                                         availability)
select r.id, g, current_setting('perf.org')::uuid, case when g = 1 then s.id end,
       case when g = 2 then 'Something else ' || r.r end, 5 + r.r % 10, case when g = 1 then 'carton' else 'piece' end,
       case when g = 1 then 24 * (5 + r.r % 10) else 5 + r.r % 10 end, case when g = 1 then 'in_warehouse' else 'not_listed' end
  from perf_r r cross join generate_series(1, 2) g
  join perf_stocked s on s.n = 1 + r.r % (select count(*) from perf_stocked);
set session_replication_role = origin;
vacuum analyze private.orders;
vacuum analyze private.order_lines;
vacuum analyze private.stock_requests;
vacuum analyze private.stock_request_lines;

create function pg_temp.fresh() returns void language sql as $$
  select set_config('request.jwt.claims', jsonb_build_object('sub', '00000000-0000-0000-0000-0000000000a6',
    'role', 'authenticated', 'aal', 'aal2',
    'amr', jsonb_build_array(jsonb_build_object('method', 'totp', 'timestamp', extract(epoch from now())::bigint)))::text,
    false)
$$;
grant execute on function pg_temp.fresh() to authenticated;
grant select on perf_stocked to authenticated;

-- The I8 lead's 20 holds, through the engine (20 rows: under the per-person rate guard).
set role authenticated;
select pg_temp.fresh() \g /dev/null
select count(*) from (select public.post_stock_movement(s.id, 'reserve', 24, 'warehouse',
                                                        p_company => current_setting('perf.lead')::uuid)
                        from perf_stocked s where s.n between 101 and 120) x \g /dev/null
reset role;
select 'seeded: ' || (select count(*) from private.orders) || ' sales, '
       || (select count(*) from private.order_lines) || ' lines, '
       || (select count(*) from private.stock_requests) || ' requests, '
       || (select count(*) from private.stock_request_lines) || ' request lines; I8 lead: '
       || (select count(*) from private.orders where company_id = current_setting('perf.lead')::uuid) || ' sales, '
       || (select count(*) from private.stock_reservations where company_id = current_setting('perf.lead')::uuid
             and status = 'active') || ' active holds, '
       || (select count(*) from private.stock_requests where company_id = current_setting('perf.lead')::uuid) || ' requests';

create function pg_temp.case_name(c integer) returns text language sql immutable as $$
  select (array['I6 record_sale 1 line (budget 10 ms)', 'I6 record_sale 10 lines (budget 25 ms)',
                'I6 record_sale 20 lines (budget 40 ms)', 'I8 get_lead_stock (budget 15 ms)',
                'list_sales page 1, all leads', 'list_stock_requests page 1, open', 'stock_alerts'])[c]
$$;
create function pg_temp.lines(n integer) returns jsonb language sql stable as $$
  select jsonb_agg(jsonb_build_object('product_id', s.id, 'description', null, 'quantity', 48,
                                      'unit_price', s.price_max::text) order by s.n)
    from perf_stocked s where s.n between 1 and $1
$$;
create function pg_temp.run_case(c integer) returns numeric language plpgsql as $$
declare
  t0 timestamptz;
  ms numeric;
  j jsonb;
  n integer;
  lines jsonb := case c when 1 then pg_temp.lines(1) when 2 then pg_temp.lines(10) when 3 then pg_temp.lines(20) end;
begin
  if c <= 3 then
    begin
      t0 := clock_timestamp();
      j := public.record_sale(p_company => current_setting('perf.sale_lead')::uuid, p_fulfilment => 'from_stock',
                              p_lines => lines, p_request_id => gen_random_uuid());
      ms := extract(epoch from clock_timestamp() - t0) * 1000;
      if (select count(*) from private.order_lines where order_id = (j ->> 'order_id')::uuid) <> jsonb_array_length(lines) then
        raise exception 'FAIL: % wrote the wrong lines: %', pg_temp.case_name(c), j;
      end if;
      raise exception 'undo' using errcode = 'TS001';
    exception when sqlstate 'TS001' then null;
    end;
    return ms;
  end if;
  t0 := clock_timestamp();
  case c
    when 4 then j := public.get_lead_stock(current_setting('perf.lead')::uuid);
    when 5 then select count(*) into n from public.list_sales(p_limit => 51);
    when 6 then select count(*) into n from public.list_stock_requests(p_status => array['new', 'in_progress'], p_limit => 51);
    else j := public.stock_alerts();
  end case;
  ms := extract(epoch from clock_timestamp() - t0) * 1000;
  if c = 4 and (jsonb_array_length(j -> 'sales') <> 20 or jsonb_array_length(j -> 'holds') <> 20
                or jsonb_array_length(j -> 'requests') <> 20 or (j ->> 'sales_count')::integer <> 50) then
    raise exception 'FAIL: get_lead_stock returned % sales, % holds, % requests', jsonb_array_length(j -> 'sales'),
      jsonb_array_length(j -> 'holds'), jsonb_array_length(j -> 'requests');
  end if;
  if c in (5, 6) and n <> 51 then
    raise exception 'FAIL: % returned % rows', pg_temp.case_name(c), n;
  end if;
  return ms;
end;
$$;
grant execute on function pg_temp.run_case(integer), pg_temp.case_name(integer), pg_temp.lines(integer) to authenticated;

set role authenticated;
select pg_temp.fresh() \g /dev/null
\echo '=== I6 and I8: runs 1 to 5 of each case (custom plans), not shown ==='
do $$ begin for c in 1..7 loop for r in 1..5 loop perform pg_temp.run_case(c); end loop; end loop; end $$;
reset role;
\echo '=== I6 and I8 plans: runs 6 to 10 of each case (generic plans from run 6), nested statements via auto_explain ==='
load 'auto_explain';
set auto_explain.log_min_duration = 0;
set auto_explain.log_analyze = on;
set auto_explain.log_nested_statements = on;
set auto_explain.log_timing = on;
set auto_explain.log_level = 'notice';
set client_min_messages = 'notice';
set role authenticated;
do $$
begin
  for c in 1..7 loop
    for r in 6..10 loop
      raise notice 'PLAN % run %', pg_temp.case_name(c), r;
      perform pg_temp.run_case(c);
    end loop;
  end loop;
end $$;
reset role;
set auto_explain.log_min_duration = -1;
set role authenticated;
\echo '=== I6 and I8 timings: p95 (2nd slowest of 15) and average of runs 11 to 25, milliseconds ==='
do $$
declare
  ms numeric[];
begin
  for c in 1..7 loop
    ms := '{}';
    for r in 11..25 loop
      ms := ms || pg_temp.run_case(c);
    end loop;
    raise notice 'TIMING % : p95 % ms, avg % ms', rpad(pg_temp.case_name(c), 40),
      round((select x from unnest(ms) x order by x desc offset 1 limit 1), 2),
      round((select avg(x) from unnest(ms) x), 2);
  end loop;
end $$;
reset role;
-- The ledger still matches (every sale was rolled back; the 20 holds went through the engine).
do $$
begin
  if exists (select 1 from private.stock_integrity_rows(current_setting('perf.org')::uuid)) then
    raise exception 'FAIL: integrity after the sales timings';
  end if;
end $$;
\echo 'perf_sales: done'
