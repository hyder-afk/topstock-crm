#!/bin/bash
# Sales under concurrency (Day 6d; design docs/evidence/day6/design.md section 11.2): two to twenty psql sessions. A
# holder runs "begin; ...; pg_sleep; commit;" and the other session starts 0.5 s later. Every case checks the final
# state and ends with check_stock_integrity.
#  1. last_cartons_two_sellers: 96 pieces; A and B each sell 96: one sale, one ship row, on hand 0; B's sale row does
#     not exist.
#  2. two_sellers_both_fit: 96; A and B sell 48 each, then C sells 1: A and B succeed, C fails.
#  3. twenty_sellers_one_product: 240 pieces; 20 sessions sell 24 each: exactly 10 sales, on hand 0.
#  4. sale_vs_hold: available 96; A holds 96 for lead 1 while B sells 96 to lead 2: exactly one succeeds.
#  5. crossed_lines_no_deadlock: sales of (P1, P2) and (P2, P1), 25 rounds in two sessions: all succeed, no 40P01.
#  6. transfer_vs_sell_no_deadlock: 25 rounds of Arrived racing sales on one product: no 40P01.
#  7. expiry_vs_sale: a hold that ended yesterday; the sweep and a sale to its lead race: exactly one path uses or ends
#     it, integrity holds.
#  8. sale_vs_deal_shipping_change (Day 6 deal_stock_blocks), in both orders: (a) the deal's owner switches it to
#     Supplier Stock in an open transaction while a warehouse sale names it: the sale waits on the deal and is refused
#     (22023 fulfilment); (b) the sale is open while the owner switches the shipping: the switch waits and is refused
#     (42501 blocked_sales). Never a warehouse sale on a Supplier Stock deal.
# Usage: sales_concurrency.sh "<libpq connection string>". Used by scripts/db-test.sh and the CI "db" job. Its fixtures
# (20 managers, leads and products named "SC …") are its own.
set -euo pipefail
CONN="${1:?connection string}"
export PGOPTIONS='-c lock_timeout=20s'
WORKDIR="$(mktemp -d)"
trap 'rm -rf -- "$WORKDIR"' EXIT
U() { printf '00000000-0000-0000-0000-0000000008%02d' "$1"; }   # seller n (1..20)
ADMIN=00000000-0000-0000-0000-000000000801

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
as_owner() {
  psql "$CONN" -X -q -A -t -v ON_ERROR_STOP=1 <<SQL
select set_config('request.jwt.claims', '', false) \g /dev/null
$1
SQL
}
fail() { echo "FAIL: $*" >&2; exit 1; }
pid() { as_owner "select id from public.products where name = '$1';"; }
lead() { as_owner "select id from public.companies where name = '$1';"; }
level() {  # "on_hand/reserved" at the warehouse
  as_owner "select coalesce((select l.on_hand || '/' || l.reserved from public.stock_levels l
            join public.locations x on x.id = l.location_id join public.products p on p.id = l.product_id
            where p.name = '$1' and x.kind = '${2:-warehouse}'), '0/0');"
}
integrity() {
  local rows
  rows=$(as_user "$ADMIN" "select count(*) from public.check_stock_integrity();")
  [ "$rows" = "0" ] || fail "check_stock_integrity found $rows differences after $1"
}
receive() { as_user "$ADMIN" "select public.post_stock_movement('$(pid "$1")', 'receive', $2, '${3:-warehouse}', 'received') \g /dev/null"; }
sale() {  # sale <seller n> <lead name> <product:qty>... (prints nothing; errors go to stderr)
  local who=$1 company=$2; shift 2
  local lines=""
  for pq in "$@"; do
    lines="$lines,jsonb_build_object('product_id', '$(pid "${pq%%:*}")', 'quantity', '${pq##*:}', 'unit_price', '3')"
  done
  as_user "$(U "$who")" "select public.record_sale('$(lead "$company")', 'from_stock', jsonb_build_array(${lines#,})) \g /dev/null"
}
orders() { as_owner "select count(*) from private.orders o join private.order_lines ol on ol.order_id = o.id
                     join public.products p on p.id = ol.product_id where p.name = '$1' and o.status = 'confirmed';"; }

as_owner "
insert into auth.users (id, email)
select ('00000000-0000-0000-0000-0000000008' || lpad(g::text, 2, '0'))::uuid, 'sc-' || g || '@test.invalid'
  from generate_series(1, 20) g on conflict do nothing;
update public.profiles set role = 'manager'
 where id in (select ('00000000-0000-0000-0000-0000000008' || lpad(g::text, 2, '0'))::uuid from generate_series(2, 20) g);
update public.profiles set role = 'admin' where id = '$ADMIN';
insert into public.companies (org_id, name, owner_id)
select p.org_id, 'SC Lead ' || g, p.id from public.profiles p, generate_series(1, 2) g where p.id = '$ADMIN';
insert into public.products (org_id, name, pieces_per_carton, price_min, price_max)
select p.org_id, 'SC P' || g, 12, 1, 3 from public.profiles p, generate_series(1, 9) g where p.id = '$ADMIN';" >/dev/null

# 1. last_cartons_two_sellers --------------------------------------------------------------------------------------------
receive 'SC P1' 96
( as_user "$(U 2)" "begin;
   select public.record_sale('$(lead 'SC Lead 1')', 'from_stock', jsonb_build_array(jsonb_build_object('product_id', '$(pid 'SC P1')', 'quantity', '96', 'unit_price', '3'))) \g /dev/null
   select pg_sleep(2) \g /dev/null
   commit;" >"$WORKDIR/a.out" 2>&1 ) &
sleep 0.5
if sale 3 'SC Lead 2' 'SC P1:96' 2>"$WORKDIR/b.out"; then fail "last_cartons_two_sellers: B sold too"; fi
wait
grep -q 'insufficient_stock' "$WORKDIR/b.out" || fail "last_cartons_two_sellers: B got $(grep -m1 ERROR "$WORKDIR/b.out")"
[ "$(level 'SC P1')" = "0/0" ] && [ "$(orders 'SC P1')" = "1" ] || fail "last_cartons_two_sellers: $(level 'SC P1'), $(orders 'SC P1') sales"
integrity last_cartons_two_sellers

# 2. two_sellers_both_fit ------------------------------------------------------------------------------------------------
receive 'SC P2' 96
( as_user "$(U 2)" "begin;
   select public.record_sale('$(lead 'SC Lead 1')', 'from_stock', jsonb_build_array(jsonb_build_object('product_id', '$(pid 'SC P2')', 'quantity', '48', 'unit_price', '3'))) \g /dev/null
   select pg_sleep(2) \g /dev/null
   commit;" >"$WORKDIR/a.out" 2>&1 ) &
sleep 0.5
sale 3 'SC Lead 2' 'SC P2:48' || fail "two_sellers_both_fit: B failed"
wait
if sale 4 'SC Lead 1' 'SC P2:1' 2>/dev/null; then fail "two_sellers_both_fit: C sold from nothing"; fi
[ "$(level 'SC P2')" = "0/0" ] && [ "$(orders 'SC P2')" = "2" ] || fail "two_sellers_both_fit: $(level 'SC P2')"
integrity two_sellers_both_fit

# 3. twenty_sellers_one_product ------------------------------------------------------------------------------------------
receive 'SC P3' 240
P3=$(pid 'SC P3'); L1=$(lead 'SC Lead 1')
for n in $(seq 1 20); do
  ( as_user "$(U "$n")" "select public.record_sale('$L1', 'from_stock', jsonb_build_array(jsonb_build_object('product_id', '$P3', 'quantity', '24', 'unit_price', '3'))) \g /dev/null" \
      >"$WORKDIR/t$n.out" 2>&1 || true ) &
done
wait
cat "$WORKDIR"/t*.out | grep -q '40P01' && fail "twenty_sellers_one_product: a deadlock"
[ "$(orders 'SC P3')" = "10" ] && [ "$(level 'SC P3')" = "0/0" ] || fail "twenty_sellers_one_product: $(orders 'SC P3') sales, $(level 'SC P3')"
[ "$(cat "$WORKDIR"/t*.out | grep -c 'insufficient_stock\|reserved_by_others')" = "10" ] || fail "twenty_sellers_one_product: refusals were not constant errors"
integrity twenty_sellers_one_product

# 4. sale_vs_hold --------------------------------------------------------------------------------------------------------
receive 'SC P4' 96
( as_user "$(U 2)" "begin;
   select public.post_stock_movement('$(pid 'SC P4')', 'reserve', 96, p_company => '$(lead 'SC Lead 1')') \g /dev/null
   select pg_sleep(2) \g /dev/null
   commit;" >"$WORKDIR/a.out" 2>&1 ) &
sleep 0.5
sale 3 'SC Lead 2' 'SC P4:96' 2>"$WORKDIR/b.out" && B=ok || B=refused
wait
A=$(grep -q ERROR "$WORKDIR/a.out" && echo refused || echo ok)
[ "$A$B" = "okrefused" ] || [ "$A$B" = "refusedok" ] || fail "sale_vs_hold: hold $A, sale $B"
integrity sale_vs_hold

# 5. crossed_lines_no_deadlock -------------------------------------------------------------------------------------------
receive 'SC P5' 500; receive 'SC P6' 500
P5=$(pid 'SC P5'); P6=$(pid 'SC P6')
for s in 5 6; do
  ops=$(for i in $(seq 1 25); do
    if [ "$s" = 5 ]; then a=$P5; b=$P6; else a=$P6; b=$P5; fi
    printf '%s\n' "select public.record_sale('$L1', 'from_stock', jsonb_build_array(jsonb_build_object('product_id', '$a', 'quantity', '1', 'unit_price', '3'), jsonb_build_object('product_id', '$b', 'quantity', '1', 'unit_price', '3'))) \g /dev/null"
  done)
  ( as_user "$(U "$s")" "$ops" >"$WORKDIR/x$s.out" 2>&1 || true ) &
done
wait
cat "$WORKDIR"/x*.out | grep -q '40P01' && fail "crossed_lines_no_deadlock: a deadlock"
cat "$WORKDIR"/x*.out | grep -q 'ERROR' && fail "crossed_lines_no_deadlock: $(cat "$WORKDIR"/x*.out | grep -m1 -A2 ERROR)"
[ "$(level 'SC P5')" = "450/0" ] && [ "$(level 'SC P6')" = "450/0" ] || fail "crossed_lines_no_deadlock: $(level 'SC P5') $(level 'SC P6')"
integrity crossed_lines_no_deadlock

# 6. transfer_vs_sell_no_deadlock ----------------------------------------------------------------------------------------
receive 'SC P7' 300; receive 'SC P7' 500 transit
P7=$(pid 'SC P7')
ops=$(for i in $(seq 1 25); do printf '%s\n' "select public.post_stock_movement('$P7', 'transfer', 20, 'transit') \g /dev/null"; done)
( as_user "$(U 7)" "$ops" >"$WORKDIR/arr.out" 2>&1 || true ) &
ops=$(for i in $(seq 1 25); do printf '%s\n' "select public.record_sale('$L1', 'from_stock', jsonb_build_array(jsonb_build_object('product_id', '$P7', 'quantity', '4', 'unit_price', '3'))) \g /dev/null"; done)
( as_user "$(U 8)" "$ops" >"$WORKDIR/sell.out" 2>&1 || true ) &
wait
cat "$WORKDIR/arr.out" "$WORKDIR/sell.out" | grep -q '40P01' && fail "transfer_vs_sell_no_deadlock: a deadlock"
cat "$WORKDIR/arr.out" "$WORKDIR/sell.out" | grep -q 'ERROR' && fail "transfer_vs_sell_no_deadlock: $(cat "$WORKDIR/arr.out" "$WORKDIR/sell.out" | grep -m1 -A2 ERROR)"
[ "$(level 'SC P7')" = "700/0" ] && [ "$(level 'SC P7' transit)" = "0/0" ] || fail "transfer_vs_sell_no_deadlock: $(level 'SC P7') $(level 'SC P7' transit)"
integrity transfer_vs_sell_no_deadlock

# 7. expiry_vs_sale ------------------------------------------------------------------------------------------------------
receive 'SC P8' 50
as_user "$(U 9)" "select public.post_stock_movement('$(pid 'SC P8')', 'reserve', 50, p_company => '$L1') \g /dev/null" >/dev/null
as_owner "update private.stock_reservations set hold_until = current_date - 1 where product_id = '$(pid 'SC P8')';" >/dev/null
( as_owner "begin;
   select private.expire_holds_for(p.org_id, p.id, null, 100) from public.products p where p.id = '$(pid 'SC P8')' \g /dev/null
   select pg_sleep(1) \g /dev/null
   commit;" >"$WORKDIR/exp.out" 2>&1 || true ) &
sleep 0.3
sale 9 'SC Lead 1' 'SC P8:50' 2>"$WORKDIR/s.out" || true
wait
st=$(as_owner "select string_agg(status, ',') from private.stock_reservations where product_id = '$(pid 'SC P8')';")
case "$st" in expired|fulfilled) ;; *) fail "expiry_vs_sale: the hold is $st";; esac
grep -q '40P01' "$WORKDIR/s.out" "$WORKDIR/exp.out" && fail "expiry_vs_sale: a deadlock"
[ "$(level 'SC P8')" = "0/0" ] || fail "expiry_vs_sale: $(level 'SC P8') (the sale either used the hold or sold the freed pieces)"
integrity expiry_vs_sale
# 8. sale_vs_deal_shipping_change ----------------------------------------------------------------------------------------
receive 'SC P9' 50
D8=$(as_owner "insert into public.deals (org_id, company_id, stage_id, owner_id, status, fulfilment, title)
  select c.org_id, c.id, (select s.id from public.pipeline_stages s where s.org_id = c.org_id and s.key = 'lead'),
         '$ADMIN', 'open', 'from_stock', 'SC Deal 8' from public.companies c where c.name = 'SC Lead 1' returning id;" | head -n 1)
sale_on_deal="select public.record_sale('$L1', 'from_stock', jsonb_build_array(jsonb_build_object('product_id', '$(pid 'SC P9')', 'quantity', '1', 'unit_price', '3')), p_deal => '$D8') \g /dev/null"
mismatch() { as_owner "select count(*) from private.orders o join public.deals d on d.id = o.deal_id
                       where d.id = '$D8' and o.status = 'confirmed' and o.fulfilment <> d.fulfilment;"; }
# a) the switch first
( as_user "$ADMIN" "begin;
   update public.deals set fulfilment = 'direct_from_source' where id = '$D8';
   select pg_sleep(1.5) \g /dev/null
   commit;" >"$WORKDIR/d8a.out" 2>&1 ) &
sleep 0.5
if as_user "$(U 2)" "$sale_on_deal" 2>"$WORKDIR/s8a.out" >/dev/null; then fail "sale_vs_deal_shipping_change (a): a warehouse sale named a Supplier Stock deal"; fi
wait
grep -q 'HINT:  fulfilment' "$WORKDIR/s8a.out" || fail "sale_vs_deal_shipping_change (a): the sale got $(grep -m1 ERROR "$WORKDIR/s8a.out")"
[ "$(mismatch)" = "0" ] || fail "sale_vs_deal_shipping_change (a): a sale does not match its deal"
# b) the sale first (the deal back to Warehouse with nothing on it)
as_user "$ADMIN" "update public.deals set fulfilment = 'from_stock' where id = '$D8';" >/dev/null
( as_user "$(U 2)" "begin;
   $sale_on_deal
   select pg_sleep(1.5) \g /dev/null
   commit;" >"$WORKDIR/s8b.out" 2>&1 ) &
sleep 0.5
if as_user "$ADMIN" "update public.deals set fulfilment = 'direct_from_source' where id = '$D8';" 2>"$WORKDIR/d8b.out" >/dev/null; then
  fail "sale_vs_deal_shipping_change (b): the shipping changed under a warehouse sale"
fi
wait
grep -q 'ERROR' "$WORKDIR/s8b.out" && fail "sale_vs_deal_shipping_change (b): the sale failed: $(grep -m1 ERROR "$WORKDIR/s8b.out")"
grep -q 'HINT:  blocked_sales' "$WORKDIR/d8b.out" || fail "sale_vs_deal_shipping_change (b): the switch got $(grep -m1 -A2 ERROR "$WORKDIR/d8b.out")"
[ "$(mismatch)" = "0" ] || fail "sale_vs_deal_shipping_change (b): a sale does not match its deal"
integrity sale_vs_deal_shipping_change
echo "sales_concurrency: all checks passed"
