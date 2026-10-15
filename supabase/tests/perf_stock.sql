-- Day 6a stock engine speed at Release 1 size, part 1 (design docs/evidence/day6/design.md section 11.6: I5, I7, I17;
-- I16 is stock_concurrency.sh "perf" and I18 the Day 3a, 3b and 4 files re-run around this one). Runs after
-- perf_leads.sql and perf_day4.sql and before perf_import.sql on the same throwaway database, so the Day 3b undo's
-- "untouched" rule (now also asking for holds) is re-timed with 5,000 holds in place. Used by scripts/db-perf.sh.
--  Seed: 5,000 products (60% with warehouse stock, 20% in transit only, 20% sold out), both places each (10,000
--        levels), 5,000 holds on 1,000 leads (600 active, the rest released or ended) and 200,000 ledger rows, written
--        with triggers off (session_replication_role = replica) and consistent with the levels and holds (every
--        level's version, snapshots and sums), then vacuum analyze. Orders, requests and links arrive with 6d and 6e.
--  I5:   post_stock_movement adjust_out, reserve and transfer (Arrived, 1 piece, moving one held piece) on products with
--        history, as an admin with a fresh code. Each case 15 runs, each undone (so the rate guard and the levels stay
--        put): runs 6 to 10 print their plans through auto_explain (the generic-plan check, as Day 4), then the
--        average and the slowest of runs 11 to 15.
--  I7:   Arrived of 300 pieces carrying 5 holds (all 5 move whole), same method.
--  I17:  check_stock_integrity() over the whole ledger: 0 rows; average of 5 runs after 2.
\set ON_ERROR_STOP 1
\set QUIET 1
insert into auth.users (id, email) values ('00000000-0000-0000-0000-0000000000a6', 'perf-stock-admin@test.invalid');
update public.profiles set role = 'admin' where id = '00000000-0000-0000-0000-0000000000a6';

-- Seed ----------------------------------------------------------------------------------------------------------------
select set_config('perf.org', (select id::text from public.orgs order by created_at limit 1), false) \g /dev/null
select set_config('perf.wh', (select id::text from public.locations where org_id = current_setting('perf.org')::uuid
                                and kind = 'warehouse'), false) \g /dev/null
select set_config('perf.tr', (select id::text from public.locations where org_id = current_setting('perf.org')::uuid
                                and kind = 'transit'), false) \g /dev/null
set session_replication_role = replica;
-- Products: n % 10 in 0..5 warehouse stock, 6..7 transit only, 8..9 sold out.
create temporary table perf_p as
select n, gen_random_uuid() as id, case when n % 10 < 6 then 'stock' when n % 10 < 8 then 'transit' else 'soldout' end as cat
  from generate_series(1, 5000) n;
insert into public.products (id, org_id, name, category, pieces_per_carton, reorder_point, price_min, price_max,
                             created_by, created_at, updated_at)
select p.id, current_setting('perf.org')::uuid, 'Perf product ' || p.n, (array['Shoes', 'Bags', 'Toys', 'Textile'])[p.n % 4 + 1],
       24, case when p.n % 3 = 0 then 100 end, 1.5 + (p.n % 50) / 10.0, 2.5 + (p.n % 50) / 10.0,
       '00000000-0000-0000-0000-0000000000a6', now() - interval '400 days', now() - interval '400 days'
  from perf_p p;
-- Levels: target on hand T and the number of on-hand rows N (an odd N ends with a receipt of T after pairs of +10/-10;
-- an even N is pairs only, net 0). 300 of the stocked levels get 21 rows, the rest 19; empty levels 18 or 20.
create temporary table perf_l as
select row_number() over (order by p.n, x.kind) as k, p.id as product_id, p.n, x.kind,
       case x.kind when 'warehouse' then current_setting('perf.wh')::uuid else current_setting('perf.tr')::uuid end as location_id,
       case when x.kind = 'warehouse' and p.cat = 'stock' then 2000 when x.kind = 'transit' and p.cat = 'transit' then 600
            else 0 end as t
  from perf_p p cross join (values ('warehouse'), ('transit')) x (kind);
alter table perf_l add column nrows integer;
update perf_l l set nrows = case when l.t > 0 then (case when l.n <= 500 and l.kind = 'warehouse' then 21 else 19 end)
                                 else (case when l.n % 2 = 0 then 18 else 20 end) end;
-- Holds: 5,000 on the 4,000 stocked levels (the first 1,000 get two), on 1,000 leads; 600 active.
create temporary table perf_leads as
select c.id, row_number() over (order by c.id) as n from public.companies c where c.org_id = current_setting('perf.org')::uuid;
create temporary table perf_h as
select h, gen_random_uuid() as id, l.product_id, l.location_id, 5 + h % 20 as q,
       case when h <= 600 then 'active' when h % 2 = 0 then 'released' else 'expired' end as status,
       (select id from perf_leads where n = 1 + (h * 37) % 1000) as company_id,
       now() - interval '30 days' + h * interval '1 minute' as at
  from generate_series(1, 5000) h
  join (select row_number() over (order by k) as j, product_id, location_id from perf_l where t > 0) l
    on l.j = 1 + (h - 1) % 4000;
insert into private.stock_reservations (id, org_id, product_id, location_id, company_id, quantity, remaining, status,
                                        hold_until, created_by, created_at, closed_at, closed_by, close_reason)
select h.id, current_setting('perf.org')::uuid, h.product_id, h.location_id, h.company_id, h.q,
       case when h.status = 'active' then h.q else 0 end, h.status,
       case when h.status = 'active' then current_date + 10 + h.h % 60 else current_date - 5 end,
       '00000000-0000-0000-0000-0000000000a6', h.at,
       case when h.status <> 'active' then h.at + interval '1 day' end,
       case when h.status = 'released' then '00000000-0000-0000-0000-0000000000a6'::uuid end,
       case h.status when 'released' then 'manual' when 'expired' then 'expired' end
  from perf_h h;
-- The ledger rows of each level in order (ord): on-hand rows first, then each hold's reserve and its closing row.
create temporary table perf_m as
select l.product_id, l.location_id, g as ord,
       case when g = l.nrows and l.t > 0 then 'receive' when g % 2 = 1 then 'receive' else 'adjust_out' end as kind,
       case when g = l.nrows and l.t > 0 then l.t else 10 end as qty,
       case when g = l.nrows and l.t > 0 then l.t when g % 2 = 1 then 10 else -10 end as d_on,
       0 as d_res,
       case when g % 2 = 1 or (g = l.nrows and l.t > 0) then 'received' else 'damaged' end as reason,
       null::uuid as reservation_id, null::uuid as company_id,
       '00000000-0000-0000-0000-0000000000a6'::uuid as user_id
  from perf_l l cross join lateral generate_series(1, l.nrows) g
union all
select h.product_id, h.location_id, 100 + h.h * 2, 'reserve', h.q, 0, h.q, null, h.id, h.company_id,
       '00000000-0000-0000-0000-0000000000a6'::uuid
  from perf_h h
union all
select h.product_id, h.location_id, 101 + h.h * 2, case h.status when 'released' then 'release' else 'expire' end, h.q, 0,
       -h.q, case h.status when 'released' then 'manual' else 'expired' end, h.id, h.company_id,
       case when h.status = 'released' then '00000000-0000-0000-0000-0000000000a6'::uuid end
  from perf_h h where h.status <> 'active';
insert into private.stock_movements (org_id, group_id, product_id, location_id, kind, qty, d_on_hand, d_reserved,
                                     on_hand_after, reserved_after, level_version, reason, company_id, reservation_id,
                                     user_id, created_at)
select current_setting('perf.org')::uuid, gen_random_uuid(), m.product_id, m.location_id, m.kind, m.qty, m.d_on, m.d_res,
       sum(m.d_on) over w, sum(m.d_res) over w, row_number() over w, m.reason, m.company_id, m.reservation_id, m.user_id,
       now() - interval '380 days' + (row_number() over (order by m.product_id, m.location_id, m.ord)) * interval '2 minutes'
  from perf_m m
window w as (partition by m.product_id, m.location_id order by m.ord rows between unbounded preceding and current row)
 order by m.product_id, m.location_id, m.ord;
insert into public.stock_levels (product_id, location_id, org_id, on_hand, reserved, version, updated_at)
select m.product_id, m.location_id, m.org_id, sum(m.d_on_hand), sum(m.d_reserved), count(*), max(m.created_at)
  from private.stock_movements m group by m.product_id, m.location_id, m.org_id;
set session_replication_role = origin;
vacuum analyze public.products;
vacuum analyze public.stock_levels;
vacuum analyze private.stock_movements;
vacuum analyze private.stock_reservations;
select 'seeded: ' || (select count(*) from public.products) || ' products, '
       || (select count(*) from public.stock_levels) || ' levels, '
       || (select count(*) from private.stock_movements) || ' ledger rows, '
       || (select count(*) from private.stock_reservations) || ' holds ('
       || (select count(*) from private.stock_reservations where status = 'active') || ' active), '
       || (select count(*) from public.products p where exists (select 1 from public.stock_levels l join public.locations x
             on x.id = l.location_id where l.product_id = p.id and x.kind = 'warehouse' and l.on_hand > 0)) || ' with warehouse stock';
select 'sizes: ' || string_agg(relname || ' ' || pg_size_pretty(pg_total_relation_size(oid)), ', ' order by relname)
  from pg_class where relname in ('products', 'stock_levels', 'stock_movements', 'stock_reservations', 'audit_log')
                  and relkind = 'r';

-- The products the timings use: a stocked product with two active holds at the warehouse, a transit-only product with
-- two active holds at transit (Arrived moves one held piece), and a fresh product for I7.
select set_config('perf.p_stock', (select l.product_id::text from perf_l l where l.kind = 'warehouse' and l.t > 0
                                     order by l.k offset 10 limit 1), false) \g /dev/null
select set_config('perf.p_transit', (select l.product_id::text from perf_l l where l.kind = 'transit' and l.t > 0
                                       order by l.k offset 10 limit 1), false) \g /dev/null
select set_config('perf.lead', (select id::text from perf_leads where n = 7), false) \g /dev/null

create function pg_temp.fresh() returns void language sql as $$
  select set_config('request.jwt.claims', jsonb_build_object('sub', '00000000-0000-0000-0000-0000000000a6',
    'role', 'authenticated', 'aal', 'aal2',
    'amr', jsonb_build_array(jsonb_build_object('method', 'totp', 'timestamp', extract(epoch from now())::bigint)))::text,
    false)
$$;
grant execute on function pg_temp.fresh() to authenticated;

-- I7 set-up (as the admin, through the RPC): 500 pieces in transit and 5 holds of 50 there.
set role authenticated;
select pg_temp.fresh() \g /dev/null
select set_config('perf.p_i7', public.create_product('Perf I7 arrived', 24, p_opening_qty => 500,
                                                     p_opening_location => 'transit')::text, false) \g /dev/null
select count(*) from (select public.post_stock_movement(current_setting('perf.p_i7')::uuid, 'reserve', 50, 'transit',
                                                        p_company => current_setting('perf.lead')::uuid)
                        from generate_series(1, 5)) x \g /dev/null

-- One timed operation, undone. Returns milliseconds.
create function pg_temp.timed(c integer) returns numeric language plpgsql as $$
declare
  t0 timestamptz;
  ms numeric;
  r jsonb;
begin
  begin
    t0 := clock_timestamp();
    case c
      when 1 then r := public.post_stock_movement(current_setting('perf.p_stock')::uuid, 'adjust_out', 3,
                                                  p_reason => 'damaged');
      when 2 then r := public.post_stock_movement(current_setting('perf.p_stock')::uuid, 'reserve', 4,
                                                  p_company => current_setting('perf.lead')::uuid);
      when 3 then r := public.post_stock_movement(current_setting('perf.p_transit')::uuid, 'transfer', 1);
      else r := public.post_stock_movement(current_setting('perf.p_i7')::uuid, 'transfer', 300);
    end case;
    ms := extract(epoch from clock_timestamp() - t0) * 1000;
    if c = 3 and (r ->> 'held_moved')::integer <> 1 then
      raise exception 'FAIL: I5 transfer moved % held pieces', r ->> 'held_moved';
    end if;
    if c = 4 and (r ->> 'held_moved')::integer <> 250 then
      raise exception 'FAIL: I7 moved % held pieces', r ->> 'held_moved';
    end if;
    raise exception 'undo' using errcode = 'TS001';
  exception when sqlstate 'TS001' then null;
  end;
  return ms;
end;
$$;
grant execute on function pg_temp.timed(integer) to authenticated;
reset role;

\echo '=== I5 and I7: runs 1 to 5 of each case (custom plans), not shown ==='
set role authenticated;
select pg_temp.fresh() \g /dev/null
do $$ begin for c in 1..4 loop for r in 1..5 loop perform pg_temp.timed(c); end loop; end loop; end $$;
reset role;  -- auto_explain settings need the superuser; the claims stay set
\echo '=== I5 and I7 plans: runs 6 to 10 of each case (generic plans from run 6), nested statements via auto_explain ==='
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
  for c in 1..4 loop
    for r in 6..10 loop
      raise notice 'PLAN % run %', (array['I5 adjust_out', 'I5 reserve', 'I5 transfer', 'I7 arrived 5 holds'])[c], r;
      perform pg_temp.timed(c);
    end loop;
  end loop;
end $$;
reset role;
set auto_explain.log_min_duration = -1;
\echo '=== I5 and I7 timings: average and slowest of runs 11 to 15, milliseconds ==='
set role authenticated;
do $$
declare
  ms numeric;
  total numeric;
  worst numeric;
begin
  for c in 1..4 loop
    total := 0;
    worst := 0;
    for r in 11..15 loop
      ms := pg_temp.timed(c);
      total := total + ms;
      worst := greatest(worst, ms);
    end loop;
    raise notice 'TIMING % : avg % ms, max % ms',
      rpad((array['I5 adjust_out (budget 5 ms)', 'I5 reserve (budget 5 ms)', 'I5 transfer, Arrived 1 piece (budget 5 ms)',
                  'I7 Arrived with 5 holds (budget 25 ms)'])[c], 46), round(total / 5, 2), round(worst, 2);
  end loop;
end $$;
reset role;

\echo '=== I17: check_stock_integrity over the whole ledger, average of 5 runs after 2 ==='
set role authenticated;
select pg_temp.fresh() \g /dev/null
do $$
declare
  t0 timestamptz;
  total numeric := 0;
  worst numeric := 0;
  ms numeric;
  n integer;
begin
  for r in 1..7 loop
    t0 := clock_timestamp();
    select count(*) into n from public.check_stock_integrity();
    ms := extract(epoch from clock_timestamp() - t0) * 1000;
    if n <> 0 then
      raise exception 'FAIL: check_stock_integrity found % differences in the seed', n;
    end if;
    if r > 2 then total := total + ms; worst := greatest(worst, ms); end if;
  end loop;
  raise notice 'TIMING % : avg % ms, max % ms, % rows over % ledger rows',
    rpad('I17 check_stock_integrity (budget 1,500 ms)', 46), round(total / 5, 1), round(worst, 1), n,
    (select count(*) from private.stock_movements);
end $$;
reset role;
-- The ledger still matches after the timed runs (each was undone; the I7 set-up was not).
do $$
begin
  if exists (select 1 from private.stock_integrity_rows(current_setting('perf.org')::uuid)) then
    raise exception 'FAIL: integrity after the timings';
  end if;
end $$;
\echo 'perf_stock: done'
