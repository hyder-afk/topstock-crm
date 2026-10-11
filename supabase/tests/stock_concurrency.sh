#!/bin/bash
# The stock engine under concurrency (Day 6a; design docs/evidence/day6/design.md sections 4.6, 4.7 and 11.2): two to
# twenty database sessions at once. A holder runs "begin; ...; pg_sleep; commit;" and the other session starts 0.5 s
# later. Every case checks the final state, the error the losing session got, and ends with check_stock_integrity.
# Sales arrive in 6d; until then a correction that takes stock out stands in for a sale (same lock, same rule).
#  1. last_cartons_two_takers: 96 pieces, two people take 96 at once: one succeeds, the other gets insufficient_stock and
#     nothing of it is saved (not even its request id).
#  2. two_holds_last_stock: 96 available, two holds of 96: exactly one; the other over_reservation.
#  3. sale_vs_hold and reserve_vs_adjust_down: a hold of 96 against taking 96, in both orders: exactly one succeeds.
#  4. transfer_vs_reserve: Arrived racing a hold at transit, in both orders: holds move with the goods; I3 holds.
#  5. archive_vs_receive_race, in both orders: an archived product never has stock.
#  6. lock_timeout_busy: a level held 5 s: the second session gets 55P03 after about 3 s.
#  7. lock order: a transfer posted directly (both levels in one apply step) racing a session that locks the two levels
#     in location order; and the Arrived RPC racing a session holding the product's share lock that then needs a level.
#     Neither may end in a deadlock (40P01).
#  8. count_vs_receive: a count waits for a receipt and sets the exact number (the change is worked out under the lock).
#  9. reserve_vs_deal_lost, in both orders, (c) with an expired hold at the level and (d) with the hold inserted straight
#     into the ledger: a lost deal keeps no active hold, and no deadlock (40P01).
# 10. twenty_reservers_one_product: 240 pieces, 20 sessions each hold 24: exactly 10 succeed (wall clock printed).
# 11. random_ops_three_sessions: 3 sessions x 100 mixed operations on 5 products, one transaction each: no deadlock,
#     no unexpected error, integrity clean.
# Usage: stock_concurrency.sh "<libpq connection string>" [perf]. With "perf", only the timing cases run (I16: the 20
# sessions, and 3 sessions x 300 mixed operations on 20 hot products, per-operation times). Used by scripts/db-test.sh,
# the CI "rls" job and (perf) scripts/db-perf.sh. Its fixtures (people, leads, products) are its own.
set -euo pipefail
CONN="${1:?connection string}"
MODE="${2:-test}"
CA=00000000-0000-0000-0000-000000000601   # admin
CB=00000000-0000-0000-0000-000000000602   # admin
CM=00000000-0000-0000-0000-000000000603   # manager
CR1=00000000-0000-0000-0000-000000000604  # rep, owns lead B
CR2=00000000-0000-0000-0000-000000000605  # rep, owns lead D
LB=35000000-0000-0000-0000-0000000000b1
LD=35000000-0000-0000-0000-0000000000d1
DEAL=45000000-0000-0000-0000-0000000000b1
export PGOPTIONS='-c lock_timeout=20s'  # a lock that is never released fails the run instead of hanging it
WORKDIR="$(mktemp -d)"
trap 'rm -rf -- "$WORKDIR"' EXIT

p() { printf '7c000000-0000-0000-0000-0000000000%s' "$1"; }
# Runs SQL as a person with a fresh two-factor code (claims set the way Supabase does). Errors print their SQLSTATE.
as_user() {
  local now
  now=$(date +%s)
  psql "$CONN" -X -q -A -t -v ON_ERROR_STOP=1 <<SQL
\set VERBOSITY verbose
set role authenticated;
select set_config('request.jwt.claims', '{"sub":"$1","role":"authenticated","aal":"aal2","amr":[{"method":"totp","timestamp":$now}]}', false) \g /dev/null
$2
SQL
}
# Runs SQL as the owner with no claims (fixtures and checks).
as_owner() {
  psql "$CONN" -X -q -A -t -v ON_ERROR_STOP=1 <<SQL
\set VERBOSITY verbose
select set_config('request.jwt.claims', '', false) \g /dev/null
$1
SQL
}
fail() { echo "FAIL: $*" >&2; exit 1; }
# expect_refused <output> <sqlstate> [hint]: the losing session's output must carry this error.
expect_refused() {
  grep -q "ERROR:  $2" <<<"$1" || fail "expected $2, got: $(head -3 <<<"$1")"
  if [ -n "${3:-}" ]; then grep -q "HINT:  $3" <<<"$1" || fail "expected hint $3, got: $(head -4 <<<"$1")"; fi
}
level() {  # level <product> <warehouse|transit>: "on_hand/reserved"
  as_owner "select coalesce((select l.on_hand || '/' || l.reserved from public.stock_levels l join public.locations x
            on x.id = l.location_id where l.product_id = '$1' and x.kind = '$2'), '0/0');"
}
integrity() {
  local rows
  rows=$(as_user "$CA" "select count(*) from public.check_stock_integrity();")
  [ "$rows" = "0" ] || fail "check_stock_integrity found $rows differences after $1: $(as_user "$CA" "select string_agg(row_to_json(c)::text, ' ') from public.check_stock_integrity() c;")"
}
mv() {  # mv <sub> <product> <kind> <qty> [more named arguments]: post_stock_movement in its own transaction
  as_user "$1" "select public.post_stock_movement(p_product => '$2', p_kind => '$3', p_qty => $4${5:+, $5}) \g /dev/null"
}

# Fixtures --------------------------------------------------------------------------------------------------------------
as_owner "
insert into auth.users (id, email)
select ('00000000-0000-0000-0000-000000000' || n)::uuid, 'conc-' || n || '@test.invalid'
  from (select generate_series(601, 605)::text as n union all select generate_series(611, 630)::text) x
on conflict do nothing;
update public.profiles set role = 'admin' where id in ('$CA', '$CB');
update public.profiles set role = 'manager'
 where id = '$CM' or id in (select ('00000000-0000-0000-0000-000000000' || g)::uuid from generate_series(611, 630) g);
update public.profiles set role = 'rep' where id in ('$CR1', '$CR2');
insert into public.companies (id, org_id, name, owner_id)
select v.id::uuid, o.id, v.name, v.owner::uuid
  from (select id from public.orgs order by created_at limit 1) o,
       (values ('$LB', 'Conc B', '$CR1'), ('$LD', 'Conc D', '$CR2')) v (id, name, owner)
on conflict do nothing;
insert into public.deals (id, org_id, company_id, stage_id, owner_id)
select '$DEAL', o.id, '$LB', (select s.id from public.pipeline_stages s where s.org_id = o.id order by s.position limit 1), '$CR1'
  from (select id from public.orgs order by created_at limit 1) o
on conflict do nothing;
insert into public.products (id, org_id, name, pieces_per_carton)
select ('7c000000-0000-0000-0000-0000000000' || lpad(g::text, 2, '0'))::uuid, o.id, 'Concurrency ' || g, 48
  from (select id from public.orgs order by created_at limit 1) o, generate_series(1, 60) g
on conflict do nothing;" >/dev/null

# Each case starts from fresh stock: a product with no level yet gets its opening receipts.
opening() {  # opening <product> <warehouse pieces> <transit pieces>
  if [ "$(as_owner "select count(*) from public.stock_levels where product_id = '$1';")" != "0" ]; then return; fi
  [ "$2" -gt 0 ] && mv "$CA" "$1" receive "$2" "p_reason => 'received'"
  [ "$3" -gt 0 ] && mv "$CA" "$1" receive "$3" "p_location => 'transit', p_reason => 'received'"
  return 0
}

twenty_reservers() {  # twenty_reservers <product>: 20 sessions hold 24 each of 240; prints the wall clock in ms
  local t0 t1 ok refused i
  opening "$1" 240 0
  t0=$(date +%s%N)
  for i in $(seq 1 20); do
    ( as_user "$CB" "select public.post_stock_movement(p_product => '$1', p_kind => 'reserve', p_qty => 24, p_company => '$LB') \g /dev/null" \
        >"$WORKDIR/r$i.out" 2>&1 && echo ok >>"$WORKDIR/r$i.out" ) &
  done
  wait
  t1=$(date +%s%N)
  ok=$(cat "$WORKDIR"/r*.out | grep -c '^ok$' || true)
  refused=$(cat "$WORKDIR"/r*.out | grep -c 'HINT:  over_reservation' || true)
  rm -f "$WORKDIR"/r*.out
  [ "$ok" = "10" ] && [ "$refused" = "10" ] || fail "twenty_reservers_one_product: $ok succeeded, $refused refused (expected 10 and 10)"
  [ "$(level "$1" warehouse)" = "240/240" ] || fail "twenty_reservers_one_product: level $(level "$1" warehouse)"
  echo "$(( (t1 - t0) / 1000000 ))"
}

# random_ops <sessions> <operations each> <first product> <products> <timing file prefix>: one transaction per operation,
# as 20 managers in turn; each line of output is "ok <ms>" or "err <sqlstate> <ms>".
random_ops() {
  local s
  for s in $(seq 1 "$1"); do
    {
      cat <<SQL
\set VERBOSITY verbose
set role authenticated;
select setseed(0.$s$s) \g /dev/null
create function pg_temp.op(i integer) returns text language plpgsql as \$\$
declare
  pr uuid := ('7c000000-0000-0000-0000-0000000000' || lpad(($3 + floor(random() * $4))::int::text, 2, '0'))::uuid;
  k integer := floor(random() * 7)::int;
  q integer := 1 + floor(random() * 40)::int;
  place text := case when random() < 0.7 then 'warehouse' else 'transit' end;
  h uuid;
  t0 timestamptz;
begin
  perform set_config('request.jwt.claims', jsonb_build_object('sub', '00000000-0000-0000-0000-000000000' || (611 + (i * $1 + $s) % 20),
    'role', 'authenticated', 'aal', 'aal2', 'amr', jsonb_build_array(jsonb_build_object('method', 'totp',
    'timestamp', extract(epoch from now())::bigint)))::text, false);
  if k = 4 then
    select r.id into h from private.stock_reservations r where r.product_id = pr and r.status = 'active' order by random() limit 1;
  end if;
  t0 := clock_timestamp();
  case k
    when 0 then perform public.post_stock_movement(p_product => pr, p_kind => 'receive', p_qty => q, p_location => place, p_reason => 'received');
    when 1 then perform public.post_stock_movement(p_product => pr, p_kind => 'adjust_out', p_qty => q, p_location => place, p_reason => 'damaged');
    when 2 then perform public.post_stock_movement(p_product => pr, p_kind => 'reserve', p_qty => q, p_location => place, p_company => '$LB');
    when 3 then perform public.post_stock_movement(p_product => pr, p_kind => 'reserve', p_qty => q, p_location => place, p_company => '$LD');
    when 4 then perform public.post_stock_movement(p_product => pr, p_kind => 'release', p_reservation => h);
    when 5 then perform public.post_stock_movement(p_product => pr, p_kind => 'transfer', p_qty => q);
    else perform public.post_stock_movement(p_product => pr, p_kind => 'count', p_location => place, p_target => floor(random() * 400)::int);
  end case;
  return 'ok ' || round(extract(epoch from clock_timestamp() - t0) * 1000, 2);
exception when others then
  return 'err ' || sqlstate || ' ' || round(extract(epoch from clock_timestamp() - t0) * 1000, 2);
end \$\$;
SQL
      for i in $(seq 1 "$2"); do echo "select pg_temp.op($i);"; done
    } | psql "$CONN" -X -q -A -t -v ON_ERROR_STOP=1 >"$WORKDIR/$5$s.out" 2>&1 &
  done
  wait
  if grep -q 'err 40P01' "$WORKDIR/$5"*.out; then fail "random operations: a deadlock (40P01)"; fi
  if grep -v '^ok \|^err 22023 \|^err P0002 ' "$WORKDIR/$5"*.out | grep -q .; then
    fail "random operations: unexpected output: $(grep -hv '^ok \|^err 22023 \|^err P0002 ' "$WORKDIR/$5"*.out | head -3)"
  fi
}
p95() {  # p95 <files...>: the 95th percentile of the "ok <ms>" times
  grep -h '^ok ' "$@" | awk '{print $2}' | sort -n | awk '{a[NR]=$1} END {i=int(NR*0.95); if (i<1) i=1; print a[i] " ms (of " NR " applied)"}'
}

if [ "$MODE" = "perf" ]; then
  # I16, part 1: the twenty-session case, wall clock.
  ms=$(twenty_reservers "$(p 31)")
  echo "I16 twenty sessions holding the last pieces: wall clock ${ms} ms (budget 3,000 ms)"
  # I16, part 2: 3 sessions x 300 mixed operations on 20 hot products.
  for n in $(seq 41 60); do opening "$(p "$n")" 400 200; done
  t0=$(date +%s%N)
  random_ops 3 300 41 20 perf
  t1=$(date +%s%N)
  echo "I16 3 sessions x 300 mixed operations on 20 hot products: wall clock $(( (t1 - t0) / 1000000 )) ms; p95 $(p95 "$WORKDIR"/perf*.out) (budget 25 ms); refused $(cat "$WORKDIR"/perf*.out | grep -c '^err' || true); deadlocks 0"
  integrity "the perf operations"
  echo 'stock_concurrency (perf): integrity clean'
  exit 0
fi

# 1. last_cartons_two_takers ---------------------------------------------------------------------------------------------
opening "$(p 01)" 96 0
as_user "$CA" "begin;
select public.post_stock_movement(p_product => '$(p 01)', p_kind => 'adjust_out', p_qty => 96, p_reason => 'correction') \g /dev/null
select pg_sleep(2) \g /dev/null
commit;" & p1=$!
sleep 0.5
out=$(as_user "$CB" "select public.post_stock_movement(p_product => '$(p 01)', p_kind => 'adjust_out', p_qty => 96,
       p_reason => 'correction', p_request_id => 'c0ffee00-0000-0000-0000-0000000000c1') \g /dev/null" 2>&1) \
  && fail "last_cartons_two_takers: both sessions took the last 96 pieces"
wait $p1 || fail "last_cartons_two_takers: the first session failed"
expect_refused "$out" 22023 insufficient_stock
[ "$(level "$(p 01)" warehouse)" = "0/0" ] || fail "last_cartons_two_takers: level $(level "$(p 01)" warehouse)"
[ "$(as_owner "select count(*) from private.stock_movements where product_id = '$(p 01)' and kind = 'adjust_out';")" = "1" ] \
  || fail "last_cartons_two_takers: the losing session left a ledger row"
[ "$(as_owner "select count(*) from private.movement_requests where request_id = 'c0ffee00-0000-0000-0000-0000000000c1';")" = "0" ] \
  || fail "last_cartons_two_takers: the losing session left its request id"

# 2. two_holds_last_stock --------------------------------------------------------------------------------------------------
opening "$(p 02)" 96 0
as_user "$CR1" "begin;
select public.post_stock_movement(p_product => '$(p 02)', p_kind => 'reserve', p_qty => 96, p_company => '$LB') \g /dev/null
select pg_sleep(2) \g /dev/null
commit;" & p1=$!
sleep 0.5
out=$(as_user "$CR2" "select public.post_stock_movement(p_product => '$(p 02)', p_kind => 'reserve', p_qty => 96, p_company => '$LD') \g /dev/null" 2>&1) \
  && fail "two_holds_last_stock: both holds of the last 96 went through"
wait $p1 || fail "two_holds_last_stock: the first hold failed"
expect_refused "$out" 22023 over_reservation
[ "$(as_owner "select count(*) from private.stock_reservations where product_id = '$(p 02)' and status = 'active';")" = "1" ] \
  || fail "two_holds_last_stock: active holds"
[ "$(level "$(p 02)" warehouse)" = "96/96" ] || fail "two_holds_last_stock: level $(level "$(p 02)" warehouse)"

# 3. sale_vs_hold (a hold first, then 96 taken out) and reserve_vs_adjust_down (96 taken out first, then a hold) ----------
opening "$(p 03)" 96 0
as_user "$CR1" "begin;
select public.post_stock_movement(p_product => '$(p 03)', p_kind => 'reserve', p_qty => 96, p_company => '$LB') \g /dev/null
select pg_sleep(2) \g /dev/null
commit;" & p1=$!
sleep 0.5
out=$(as_user "$CA" "select public.post_stock_movement(p_product => '$(p 03)', p_kind => 'adjust_out', p_qty => 96, p_reason => 'correction') \g /dev/null" 2>&1) \
  && fail "sale_vs_hold: stock held for a client was taken out"
wait $p1 || fail "sale_vs_hold: the hold failed"
expect_refused "$out" 22023 below_reserved
[ "$(level "$(p 03)" warehouse)" = "96/96" ] || fail "sale_vs_hold: level $(level "$(p 03)" warehouse)"
opening "$(p 04)" 96 0
as_user "$CA" "begin;
select public.post_stock_movement(p_product => '$(p 04)', p_kind => 'adjust_out', p_qty => 96, p_reason => 'correction') \g /dev/null
select pg_sleep(2) \g /dev/null
commit;" & p1=$!
sleep 0.5
out=$(as_user "$CR2" "select public.post_stock_movement(p_product => '$(p 04)', p_kind => 'reserve', p_qty => 48, p_company => '$LD') \g /dev/null" 2>&1) \
  && fail "reserve_vs_adjust_down: a hold went through on stock that was taken out"
wait $p1 || fail "reserve_vs_adjust_down: the correction failed"
expect_refused "$out" 22023 over_reservation
[ "$(level "$(p 04)" warehouse)" = "0/0" ] || fail "reserve_vs_adjust_down: level $(level "$(p 04)" warehouse)"

# 4. transfer_vs_reserve -------------------------------------------------------------------------------------------------
# a) transit 100 with 60 held; Arrived 100 holds its transaction; a hold of 50 at transit then fails (transit is empty).
opening "$(p 05)" 0 100
mv "$CR1" "$(p 05)" reserve 60 "p_location => 'transit', p_company => '$LB'"
as_user "$CM" "begin;
select public.post_stock_movement(p_product => '$(p 05)', p_kind => 'transfer', p_qty => 100) \g /dev/null
select pg_sleep(2) \g /dev/null
commit;" & p1=$!
sleep 0.5
out=$(as_user "$CR2" "select public.post_stock_movement(p_product => '$(p 05)', p_kind => 'reserve', p_qty => 50, p_location => 'transit', p_company => '$LD') \g /dev/null" 2>&1) \
  && fail "transfer_vs_reserve: a hold at transit went through after everything arrived"
wait $p1 || fail "transfer_vs_reserve: Arrived failed"
expect_refused "$out" 22023 over_reservation
[ "$(level "$(p 05)" transit)" = "0/0" ] && [ "$(level "$(p 05)" warehouse)" = "100/60" ] \
  || fail "transfer_vs_reserve (a): transit $(level "$(p 05)" transit), warehouse $(level "$(p 05)" warehouse)"
# b) a hold of 40 at transit holds its transaction; Arrived 100 waits, then moves all 100 held pieces.
opening "$(p 06)" 0 100
mv "$CR1" "$(p 06)" reserve 60 "p_location => 'transit', p_company => '$LB'"
as_user "$CR2" "begin;
select public.post_stock_movement(p_product => '$(p 06)', p_kind => 'reserve', p_qty => 40, p_location => 'transit', p_company => '$LD') \g /dev/null
select pg_sleep(2) \g /dev/null
commit;" & p1=$!
sleep 0.5
mv "$CM" "$(p 06)" transfer 100 || fail "transfer_vs_reserve (b): Arrived failed"
wait $p1 || fail "transfer_vs_reserve (b): the hold failed"
[ "$(level "$(p 06)" transit)" = "0/0" ] && [ "$(level "$(p 06)" warehouse)" = "100/100" ] \
  || fail "transfer_vs_reserve (b): transit $(level "$(p 06)" transit), warehouse $(level "$(p 06)" warehouse)"
[ "$(as_owner "select count(*) from private.stock_reservations r join public.locations l on l.id = r.location_id
               where r.product_id = '$(p 06)' and r.status = 'active' and l.kind = 'warehouse';")" = "2" ] \
  || fail "transfer_vs_reserve (b): both holds should have moved to the warehouse"
integrity "transfer_vs_reserve"

# 5. archive_vs_receive_race ---------------------------------------------------------------------------------------------
# a) a receipt holds its transaction; archiving waits and is refused (has_stock).
as_user "$CA" "begin;
select public.post_stock_movement(p_product => '$(p 07)', p_kind => 'receive', p_qty => 10, p_reason => 'received') \g /dev/null
select pg_sleep(2) \g /dev/null
commit;" & p1=$!
sleep 0.5
out=$(as_user "$CB" "select public.archive_product('$(p 07)') \g /dev/null" 2>&1) \
  && fail "archive_vs_receive_race (a): a product was archived while stock was being received"
wait $p1 || fail "archive_vs_receive_race (a): the receipt failed"
expect_refused "$out" 22023 has_stock
[ "$(as_owner "select (archived_at is null)::text from public.products where id = '$(p 07)';")" = "true" ] \
  && [ "$(level "$(p 07)" warehouse)" = "10/0" ] || fail "archive_vs_receive_race (a): final state"
# b) archiving holds its transaction; the receipt waits on the product and is refused (product_archived).
as_user "$CB" "begin;
select public.archive_product('$(p 08)') \g /dev/null
select pg_sleep(2) \g /dev/null
commit;" & p1=$!
sleep 0.5
out=$(as_user "$CA" "select public.post_stock_movement(p_product => '$(p 08)', p_kind => 'receive', p_qty => 10, p_reason => 'received') \g /dev/null" 2>&1) \
  && fail "archive_vs_receive_race (b): stock was received into a product being archived"
wait $p1 || fail "archive_vs_receive_race (b): archiving failed"
expect_refused "$out" 22023 product_archived
[ "$(as_owner "select (archived_at is not null)::text from public.products where id = '$(p 08)';")" = "true" ] \
  && [ "$(as_owner "select count(*) from private.stock_movements where product_id = '$(p 08)';")" = "0" ] \
  || fail "archive_vs_receive_race (b): final state"

# 6. lock_timeout_busy -----------------------------------------------------------------------------------------------------
opening "$(p 09)" 50 0
as_user "$CA" "begin;
select public.post_stock_movement(p_product => '$(p 09)', p_kind => 'adjust_out', p_qty => 1, p_reason => 'sample') \g /dev/null
select pg_sleep(5) \g /dev/null
commit;" & p1=$!
sleep 0.5
t0=$(date +%s%N)
out=$(as_user "$CB" "select public.post_stock_movement(p_product => '$(p 09)', p_kind => 'adjust_out', p_qty => 1, p_reason => 'sample') \g /dev/null" 2>&1) \
  && fail "lock_timeout_busy: the second session did not wait for the lock"
t1=$(date +%s%N)
wait $p1 || fail "lock_timeout_busy: the holder failed"
expect_refused "$out" 55P03
waited=$(( (t1 - t0) / 1000000 ))
[ "$waited" -ge 2500 ] && [ "$waited" -le 4500 ] || fail "lock_timeout_busy: gave up after ${waited} ms, expected about 3,000"

# 7. Lock order --------------------------------------------------------------------------------------------------------------
# a) A transfer posted directly to the ledger locks both levels in its first apply step, in location order. Session X
#    takes the product's share lock and locks the lower-id level (no change, so the transfer's level insert does not
#    wait on it), waits, then locks the higher one: the order of every path that touches two levels (the expiry sweep,
#    Arrived's expiry). In location order the transfer waits behind X; in any other order the two deadlock.
opening "$(p 10)" 50 50
lo=$(as_owner "select id from public.locations where org_id = (select id from public.orgs order by created_at limit 1) order by id limit 1;")
hi=$(as_owner "select id from public.locations where org_id = (select id from public.orgs order by created_at limit 1) order by id desc limit 1;")
as_owner "begin;
select 1 from public.products where id = '$(p 10)' for share \g /dev/null
select 1 from public.stock_levels where product_id = '$(p 10)' and location_id = '$lo' for update \g /dev/null
select pg_sleep(2) \g /dev/null
select 1 from public.stock_levels where product_id = '$(p 10)' and location_id = '$hi' for update \g /dev/null
commit;" >"$WORKDIR/x.out" 2>&1 & p1=$!
sleep 0.5
as_user "$CM" "begin;
insert into private.stock_movements (group_id, product_id, location_id, kind, qty)
select g, '$(p 10)', l.id, 'transfer_out', 10 from public.locations l, (select 'c0ffee00-0000-0000-0000-0000000000c7'::uuid as g) x where l.kind = 'transit';
insert into private.stock_movements (group_id, product_id, location_id, kind, qty, pair_id)
select 'c0ffee00-0000-0000-0000-0000000000c7', '$(p 10)', l.id, 'transfer_in', 10,
       (select max(m.id) from private.stock_movements m where m.group_id = 'c0ffee00-0000-0000-0000-0000000000c7')
  from public.locations l where l.kind = 'warehouse';
commit;" >"$WORKDIR/y.out" 2>&1 || fail "lock order (a): the direct transfer failed: $(head -3 "$WORKDIR/y.out")"
wait $p1 || fail "lock order (a): the ordered session failed: $(head -3 "$WORKDIR/x.out")"
[ "$(level "$(p 10)" warehouse)" = "60/0" ] && [ "$(level "$(p 10)" transit)" = "40/0" ] \
  || fail "lock order (a): warehouse $(level "$(p 10)" warehouse), transit $(level "$(p 10)" transit)"
# b) Session X holds the product's share lock (as a movement's apply step does), waits, then needs the transit level.
#    Arrived empties transit and clears the expected date: it takes the product lock first, so it waits behind X instead
#    of holding the levels while waiting for the product.
opening "$(p 11)" 0 30
as_owner "update public.products set transit_eta = current_date + 5 where id = '$(p 11)';" >/dev/null
as_owner "begin;
select 1 from public.products where id = '$(p 11)' for share \g /dev/null
select pg_sleep(2) \g /dev/null
select 1 from public.stock_levels l join public.locations x on x.id = l.location_id
 where l.product_id = '$(p 11)' and x.kind = 'transit' for update \g /dev/null
commit;" >"$WORKDIR/x.out" 2>&1 & p1=$!
sleep 0.5
mv "$CM" "$(p 11)" transfer 30 >"$WORKDIR/y.out" 2>&1 || fail "lock order (b): Arrived failed: $(head -3 "$WORKDIR/y.out")"
wait $p1 || fail "lock order (b): the share-lock session failed: $(head -3 "$WORKDIR/x.out")"
[ "$(as_owner "select coalesce(transit_eta::text, 'cleared') from public.products where id = '$(p 11)';")" = "cleared" ] \
  || fail "lock order (b): the expected date was not cleared"
integrity "the lock order cases"

# 8. count_vs_receive ------------------------------------------------------------------------------------------------------
opening "$(p 12)" 40 0
as_user "$CA" "begin;
select public.post_stock_movement(p_product => '$(p 12)', p_kind => 'receive', p_qty => 10, p_reason => 'received') \g /dev/null
select pg_sleep(2) \g /dev/null
commit;" & p1=$!
sleep 0.5
mv "$CB" "$(p 12)" count null "p_target => 55" || fail "count_vs_receive: the count failed"
wait $p1 || fail "count_vs_receive: the receipt failed"
[ "$(level "$(p 12)" warehouse)" = "55/0" ] || fail "count_vs_receive: on hand $(level "$(p 12)" warehouse), expected the counted 55"

# 9. reserve_vs_deal_lost ------------------------------------------------------------------------------------------------------
# a) a hold for the deal holds its transaction; the deal is lost meanwhile: its trigger waits and releases the hold.
opening "$(p 13)" 100 0
as_owner "update public.deals set status = 'open', lost_reason = null where id = '$DEAL';" >/dev/null
as_user "$CR1" "begin;
select public.post_stock_movement(p_product => '$(p 13)', p_kind => 'reserve', p_qty => 30, p_company => '$LB', p_deal => '$DEAL') \g /dev/null
select pg_sleep(2) \g /dev/null
commit;" & p1=$!
sleep 0.5
as_user "$CR1" "update public.deals set status = 'lost', lost_reason = 'price' where id = '$DEAL';" >/dev/null \
  || fail "reserve_vs_deal_lost (a): losing the deal failed"
wait $p1 || fail "reserve_vs_deal_lost (a): the hold failed"
[ "$(as_owner "select count(*) from private.stock_reservations where deal_id = '$DEAL' and status = 'active';")" = "0" ] \
  && [ "$(level "$(p 13)" warehouse)" = "100/0" ] || fail "reserve_vs_deal_lost (a): a lost deal kept an active hold"
# b) the deal is being lost; a hold for it waits on the deal and is refused.
as_owner "update public.deals set status = 'open', lost_reason = null where id = '$DEAL';" >/dev/null
as_user "$CR1" "begin;
update public.deals set status = 'lost', lost_reason = 'price' where id = '$DEAL';
select pg_sleep(2) \g /dev/null
commit;" & p1=$!
sleep 0.5
out=$(as_user "$CR1" "select public.post_stock_movement(p_product => '$(p 13)', p_kind => 'reserve', p_qty => 30, p_company => '$LB', p_deal => '$DEAL') \g /dev/null" 2>&1) \
  && fail "reserve_vs_deal_lost (b): a hold went through for a deal being lost"
wait $p1 || fail "reserve_vs_deal_lost (b): losing the deal failed"
expect_refused "$out" 22023 deal_closed
[ "$(as_owner "select count(*) from private.stock_reservations where deal_id = '$DEAL' and status = 'active';")" = "0" ] \
  || fail "reserve_vs_deal_lost (b): a lost deal has an active hold"
# c) as (b), with an expired hold (no deal) at the same level: the hold's RPC would end it first, which locks the level.
#    The deal is locked first (by an unrelated change), then lost, which needs that level to release the deal's hold.
#    The hold's RPC locks the deal before any expiry row, so it waits and is refused: never a deadlock (40P01).
opening "$(p 15)" 100 0
as_owner "update public.deals set status = 'open', lost_reason = null where id = '$DEAL';" >/dev/null
mv "$CR1" "$(p 15)" reserve 10 "p_company => '$LB', p_deal => '$DEAL'" || fail "reserve_vs_deal_lost (c): the deal's hold failed"
mv "$CR1" "$(p 15)" reserve 5 "p_company => '$LB'" || fail "reserve_vs_deal_lost (c): the hold to expire failed"
as_owner "update private.stock_reservations set hold_until = current_date - 1
           where product_id = '$(p 15)' and deal_id is null and status = 'active';" >/dev/null
as_user "$CR1" "begin;
update public.deals set value = value + 1 where id = '$DEAL';
select pg_sleep(2) \g /dev/null
update public.deals set status = 'lost', lost_reason = 'price' where id = '$DEAL';
commit;" >"$WORKDIR/x.out" 2>&1 & p1=$!
sleep 0.5
out=$(as_user "$CR1" "select public.post_stock_movement(p_product => '$(p 15)', p_kind => 'reserve', p_qty => 30, p_company => '$LB', p_deal => '$DEAL') \g /dev/null" 2>&1) \
  && fail "reserve_vs_deal_lost (c): a hold went through for a deal being lost"
wait $p1 || fail "reserve_vs_deal_lost (c): losing the deal failed: $(head -3 "$WORKDIR/x.out")"
expect_refused "$out" 22023 deal_closed
[ "$(as_owner "select count(*) from private.stock_reservations where product_id = '$(p 15)' and status = 'active';")" = "1" ] \
  && [ "$(level "$(p 15)" warehouse)" = "100/5" ] \
  || fail "reserve_vs_deal_lost (c): final state $(level "$(p 15)" warehouse)"
# d) as (a), with the hold inserted straight into the ledger (a client may insert ledger rows; no RPC, so no lock before
#    the apply step): the apply step's own deal lock makes the deal lost wait and release the hold.
opening "$(p 16)" 100 0
as_owner "update public.deals set status = 'open', lost_reason = null where id = '$DEAL';" >/dev/null
as_user "$CR1" "begin;
insert into private.stock_movements (group_id, product_id, location_id, kind, qty, company_id, deal_id, hold_until)
select gen_random_uuid(), '$(p 16)', l.id, 'reserve', 30, '$LB', '$DEAL', current_date + 7
  from public.locations l where l.kind = 'warehouse';
select pg_sleep(2) \g /dev/null
commit;" >"$WORKDIR/x.out" 2>&1 & p1=$!
sleep 0.5
as_user "$CR1" "update public.deals set status = 'lost', lost_reason = 'price' where id = '$DEAL';" >/dev/null \
  || fail "reserve_vs_deal_lost (d): losing the deal failed"
wait $p1 || fail "reserve_vs_deal_lost (d): the direct hold failed: $(head -3 "$WORKDIR/x.out")"
[ "$(as_owner "select count(*) from private.stock_reservations where deal_id = '$DEAL' and status = 'active';")" = "0" ] \
  && [ "$(level "$(p 16)" warehouse)" = "100/0" ] || fail "reserve_vs_deal_lost (d): a lost deal kept an active hold"
integrity "reserve_vs_deal_lost"

# 10. twenty_reservers_one_product ---------------------------------------------------------------------------------------------
ms=$(twenty_reservers "$(p 14)")
echo "twenty_reservers_one_product: 10 of 20 succeeded, wall clock ${ms} ms"

# 11. random_ops_three_sessions ------------------------------------------------------------------------------------------------
for n in 21 22 23 24 25; do opening "$(p "$n")" 300 100; done
random_ops 3 100 21 5 rand
echo "random_ops_three_sessions: $(cat "$WORKDIR"/rand*.out | grep -c '^ok' || true) applied, $(cat "$WORKDIR"/rand*.out | grep -c '^err' || true) refused, no deadlock"
integrity "the random operations"

echo 'stock_concurrency: all checks passed'
