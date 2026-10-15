-- Day 6e client stock link speed (design docs/evidence/day6/design.md section 11.6: I9 to I11). Runs after
-- perf_stock.sql on the same throwaway database (scripts/db-perf.sh), reusing its seed: 5,000 products, 3,000 with
-- warehouse stock and 1,000 in transit only, so a link that shows arriving stock lists 2,000 items (the cap) — I10.
--  Seed: sharing on; 60 links on 60 leads with known tokens (tss_ and 43 characters), as the owner (the guard's
--        maintenance path), so each timed call can use a link of its own (a link takes 30 views a minute and 5
--        requests an hour).
--  I9:   share_view as anon: a valid link (2,000 items) / a well-formed unknown token / a malformed one.  ≤ 40 / 3 / 1 ms
--  I10:  the valid answer's size (raw here; gzip in scripts/db-perf.sh's output by the caller).          ≤ 150 KB / 35 KB
--  I11:  share_request as anon with 5 product lines (the request, its lines, the counters and the task).        ≤ 20 ms
-- Each case: runs 1 to 5 not shown, runs 6 to 10 print their plans through auto_explain, then the p95 (the slowest but
-- one) and the average of runs 11 to 25.
\set ON_ERROR_STOP 1
\set QUIET 1

select set_config('perf.org', (select id::text from public.orgs order by created_at limit 1), false) \g /dev/null
update private.inventory_settings set sharing_enabled = true where org_id = current_setting('perf.org')::uuid;
insert into private.share_links (org_id, company_id, token_hash, token_hint, language, expires_at, created_by)
select current_setting('perf.org')::uuid, c.id, sha256(convert_to('tss_' || lpad(c.n::text, 43, 'P'), 'UTF8')),
       right(lpad(c.n::text, 43, 'P'), 4), 'fr', now() + interval '30 days', '00000000-0000-0000-0000-0000000000a6'
  from (select id, row_number() over (order by id) as n from public.companies
         where org_id = current_setting('perf.org')::uuid order by id limit 60) c;
select 'seeded: ' || (select count(*) from private.share_links) || ' links; a link lists '
       || jsonb_array_length(private.share_items(current_setting('perf.org')::uuid, true)) || ' items';

create function pg_temp.tok(n integer) returns text language sql immutable as $$ select 'tss_' || lpad(n::text, 43, 'P') $$;
create function pg_temp.case_name(c integer) returns text language sql immutable as $$
  select (array['I9 share_view valid, 2,000 items (budget 40 ms)', 'I9 share_view unknown token (budget 3 ms)',
                'I9 share_view malformed token (budget 1 ms)', 'I11 share_request 5 lines + task (budget 20 ms)'])[c]
$$;
-- The five products a request names: visible, in the warehouse.
create temporary table perf_req_products as
select (i ->> 0)::integer as num from jsonb_array_elements(private.share_items(current_setting('perf.org')::uuid, true)) i
 where (i ->> 5)::integer > 0 limit 5;
grant select on perf_req_products to anon;
create function pg_temp.run_case(c integer, r integer) returns numeric language plpgsql as $$
declare
  t0 timestamptz;
  j jsonb;
  payload jsonb;
begin
  if c = 4 then
    payload := jsonb_build_object('lines', (select jsonb_agg(jsonb_build_object('product_number', p.num, 'description', null,
                                                                              'quantity', '2', 'unit', 'carton'))
                                              from perf_req_products p),
                                  'note', 'Perf request', 'name', null, 'idempotency_key', gen_random_uuid());
  end if;
  t0 := clock_timestamp();
  case c
    when 1 then j := public.share_view(pg_temp.tok(r));                      -- links 1 to 25: one each
    when 2 then j := public.share_view('tss_' || repeat('U', 43));
    when 3 then j := public.share_view('not a token');
    else j := public.share_request(pg_temp.tok(30 + r), payload);           -- links 31 to 55
  end case;
  if (c = 1 and (j ->> 'status' <> 'ok' or jsonb_array_length(j -> 'items') <> 2000))
     or (c in (2, 3) and j ->> 'status' <> 'inactive') or (c = 4 and j ->> 'status' <> 'received') then
    raise exception 'FAIL: % run % answered %', pg_temp.case_name(c), r, left(j::text, 200);
  end if;
  return extract(epoch from clock_timestamp() - t0) * 1000;
end;
$$;
grant execute on function pg_temp.run_case(integer, integer), pg_temp.case_name(integer), pg_temp.tok(integer) to anon;

set role anon;
select set_config('request.jwt.claims', '{"role":"anon"}', false) \g /dev/null
\echo '=== I9 and I11: runs 1 to 5 of each case, not shown ==='
do $$ begin for c in 1..4 loop for r in 1..5 loop perform pg_temp.run_case(c, r); end loop; end loop; end $$;
reset role;
\echo '=== I9 and I11 plans: runs 6 to 10 (generic plans from run 6), nested statements via auto_explain ==='
load 'auto_explain';
set auto_explain.log_min_duration = 0;
set auto_explain.log_analyze = on;
set auto_explain.log_nested_statements = on;
set auto_explain.log_timing = on;
set auto_explain.log_level = 'notice';
set client_min_messages = 'notice';
set role anon;
do $$
begin
  for c in 1..4 loop
    for r in 6..10 loop
      raise notice 'PLAN % run %', pg_temp.case_name(c), r;
      perform pg_temp.run_case(c, r);
    end loop;
  end loop;
end $$;
reset role;
set auto_explain.log_min_duration = -1;
set role anon;
\echo '=== I9 and I11 timings: p95 (2nd slowest of 15) and average of runs 11 to 25, milliseconds ==='
do $$
declare
  ms numeric[];
begin
  for c in 1..4 loop
    ms := '{}';
    for r in 11..25 loop
      ms := ms || pg_temp.run_case(c, r);
    end loop;
    raise notice 'TIMING % : p95 % ms, avg % ms', rpad(pg_temp.case_name(c), 48),
      round((select x from unnest(ms) x order by x desc offset 1 limit 1), 2), round((select avg(x) from unnest(ms) x), 2);
  end loop;
end $$;
\echo '=== I10: the size of a full answer (2,000 items), bytes ==='
do $$
declare
  j jsonb := public.share_view(pg_temp.tok(60));
begin
  raise notice 'SIZE I10 share_view raw : % bytes (budget 153,600)', octet_length(j::text);
end $$;
reset role;
\echo 'perf_share: done'
