#!/bin/bash
# The stock sheet import under concurrency (Day 6c; design docs/evidence/day6/design.md sections 4.6, 7.7 and 11.2): a
# holder runs "begin; ...; pg_sleep; commit;" and the other session starts 0.5 s later. Every case checks the final
# state and ends with check_stock_integrity. A correction that takes stock out stands in for a sale (6d), as in 6a.
#  1. import_commit_vs_sale_target_respected: the check saw P at 100; a sale of 30 holds P's lock while the commit chunk
#     runs: with keep_crm P is kept (70); with use_sheet P is set to the sheet's 100 (an import row of +30).
#  2. import_commit_vs_waiting_sale_order: the commit chunk holds P; a sale waits for it and applies after: the level
#     says moved in the CRM (crm_moved true, last_onhand_batch_id cleared), and the undo keeps P (moved).
#  3. import_chunk_vs_sales_no_deadlock: a 40-product chunk while 3 sessions sell random products of it: no 40P01, no
#     unexpected error, integrity clean.
# Usage: stock_import_concurrency.sh "<libpq connection string>". Used by scripts/db-test.sh and the CI "db" job. Its
# fixtures (people, products named "IC …") are its own.
set -euo pipefail
CONN="${1:?connection string}"
IA=00000000-0000-0000-0000-000000000701   # admin who imports
IM=00000000-0000-0000-0000-000000000702   # manager who "sells"
export PGOPTIONS='-c lock_timeout=20s'
WORKDIR="$(mktemp -d)"
trap 'rm -rf -- "$WORKDIR"' EXIT

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
level() {  # level <product name> <warehouse|transit>: "on_hand/reserved"
  as_owner "select coalesce((select l.on_hand || '/' || l.reserved from public.stock_levels l
            join public.locations x on x.id = l.location_id join public.products p on p.id = l.product_id
            where p.name = '$1' and x.kind = '$2'), '0/0');"
}
pid() { as_owner "select id from public.products where name = '$1';"; }
integrity() {
  local rows
  rows=$(as_user "$IA" "select count(*) from public.check_stock_integrity();")
  [ "$rows" = "0" ] || fail "check_stock_integrity found $rows differences after $1"
}
# import <policy> <rows as SQL jsonb expression>: create, stage, check; prints the batch id.
import() {
  as_user "$IA" "
select public.create_stock_import('ic-' || gen_random_uuid() || '.csv', repeat('ab', 32), jsonb_array_length($2),
                                  (select max((r ->> 'row_no')::int) from jsonb_array_elements($2) r)) as b \gset
select public.stage_stock_import_rows(:'b', $2) \g /dev/null
select public.validate_stock_import(:'b', '$1') \g /dev/null
select :'b';"
}
commit_all() {
  as_user "$IA" "do \$\$ begin for i in 1..50 loop exit when public.commit_stock_import('$1') ->> 'status' = 'imported'; end loop; end \$\$;"
}
row() {  # row <n> <name> <place> <qty> <ppc> [price max]
  printf "jsonb_build_object('row_no','%s','name','%s','location_kind','%s','quantity','%s','pieces_per_carton','%s'%s)" \
    "$1" "$2" "$3" "$4" "$5" "${6:+,'price_max','$6'}"
}

as_owner "
insert into auth.users (id, email) values ('$IA', 'ic-admin@test.invalid'), ('$IM', 'ic-manager@test.invalid')
on conflict do nothing;
update public.profiles set role = 'admin' where id = '$IA';
update public.profiles set role = 'manager' where id = '$IM';" >/dev/null

# Products made by an import (so "moved in the CRM" starts false): IC 1 to IC 42, 100 pieces each in the warehouse.
rows="jsonb_build_array($(for i in $(seq 1 42); do printf '%s,' "$(row $((i + 1)) "IC $i" warehouse 100 10)"; done | sed 's/,$//'))"
B0=$(import keep_crm "$rows" | tail -1)
commit_all "$B0"
[ "$(level 'IC 1' warehouse)" = "100/0" ] || fail "setup: IC 1 is $(level 'IC 1' warehouse)"

# 1. import_commit_vs_sale_target_respected -----------------------------------------------------------------------------
for policy in keep_crm use_sheet; do
  name=$([ "$policy" = keep_crm ] && echo "IC 1" || echo "IC 2")
  B=$(import "$policy" "jsonb_build_array($(row 2 "$name" warehouse 100 10 3.5))" | tail -1)
  ( as_user "$IM" "begin;
     select public.post_stock_movement(p_product => '$(pid "$name")', p_kind => 'adjust_out', p_qty => 30, p_reason => 'sample') \g /dev/null
     select pg_sleep(2) \g /dev/null
     commit;" >"$WORKDIR/sale.out" 2>&1 ) &
  sleep 0.5
  commit_all "$B" >"$WORKDIR/commit.out" 2>&1 || fail "import_commit_vs_sale ($policy): commit failed: $(head -3 "$WORKDIR/commit.out")"
  wait
  want=$([ "$policy" = keep_crm ] && echo "70/0" || echo "100/0")
  [ "$(level "$name" warehouse)" = "$want" ] || fail "import_commit_vs_sale_target_respected ($policy): $(level "$name" warehouse), expected $want"
  [ "$(as_owner "select price_max from public.products where name = '$name';")" = "3.5000" ] \
    || fail "import_commit_vs_sale_target_respected ($policy): prices not updated"
  integrity "import_commit_vs_sale ($policy)"
done

# 2. import_commit_vs_waiting_sale_order --------------------------------------------------------------------------------
B=$(import use_sheet "jsonb_build_array($(row 2 'IC 3' warehouse 150 10))" | tail -1)
( as_user "$IA" "begin;
   select public.commit_stock_import('$B') \g /dev/null
   select pg_sleep(2) \g /dev/null
   commit;" >"$WORKDIR/hold.out" 2>&1 ) &
sleep 0.5
as_user "$IM" "select public.post_stock_movement(p_product => '$(pid 'IC 3')', p_kind => 'adjust_out', p_qty => 10, p_reason => 'sample') \g /dev/null" \
  >"$WORKDIR/late.out" 2>&1 || fail "import_commit_vs_waiting_sale_order: the sale failed: $(head -3 "$WORKDIR/late.out")"
wait
grep -q ERROR "$WORKDIR/hold.out" && fail "import_commit_vs_waiting_sale_order: the commit failed: $(head -3 "$WORKDIR/hold.out")"
[ "$(level 'IC 3' warehouse)" = "140/0" ] || fail "import_commit_vs_waiting_sale_order: $(level 'IC 3' warehouse)"
[ "$(as_owner "select crm_moved::text || '/' || coalesce(last_onhand_batch_id::text, 'none') from public.stock_levels l
     join public.locations x on x.id = l.location_id where l.product_id = '$(pid 'IC 3')' and x.kind = 'warehouse';")" = "true/none" ] \
  || fail "import_commit_vs_waiting_sale_order: the level does not say moved in the CRM"
plan=$(as_user "$IA" "select qty from private.stock_undo_plan('$B', '$(pid 'IC 3')');")
[ "$plan" = "moved" ] || fail "import_commit_vs_waiting_sale_order: the undo would $plan"
integrity "import_commit_vs_waiting_sale_order"

# 3. import_chunk_vs_sales_no_deadlock ----------------------------------------------------------------------------------
rows="jsonb_build_array($(for i in $(seq 3 42); do printf '%s,' "$(row $i "IC $i" warehouse $((200 + i)) 10)"; done | sed 's/,$//'))"
B=$(import use_sheet "$rows" | tail -1)
ids=$(as_owner "select string_agg(quote_literal(id), ',') from public.products where name ~ '^IC ([3-9]|[1-3][0-9]|4[0-2])$';")
for s in 1 2 3; do
  # One transaction per sale (each DO block commits on its own), as each RPC call is through the API.
  ops=$(for i in $(seq 1 20); do printf '%s\n' "do \$\$ declare ps uuid[] := array[$ids]::uuid[]; begin
    perform public.post_stock_movement(p_product => ps[1 + floor(random() * cardinality(ps))::int], p_kind => 'adjust_out',
                                       p_qty => 1, p_reason => 'sample');
    exception when sqlstate '22023' or sqlstate '55P03' then null;   -- short or busy: fine (not a deadlock)
    end \$\$;"; done)
  ( as_user "$IM" "select setseed(0.$s) \g /dev/null
$ops" >"$WORKDIR/s$s.out" 2>&1 ) &
done
commit_all "$B" >"$WORKDIR/chunk.out" 2>&1 || true
wait
cat "$WORKDIR"/s*.out "$WORKDIR/chunk.out" | grep -q '40P01' && fail "import_chunk_vs_sales_no_deadlock: a deadlock"
cat "$WORKDIR"/s*.out "$WORKDIR/chunk.out" | grep -q 'ERROR' && fail "import_chunk_vs_sales_no_deadlock: $(cat "$WORKDIR"/s*.out "$WORKDIR/chunk.out" | grep -m1 -A2 ERROR)"
[ "$(as_owner "select status from public.import_batches where id = '$B';")" = "imported" ] || fail "import_chunk_vs_sales_no_deadlock: not imported"
integrity "import_chunk_vs_sales_no_deadlock"
echo "stock_import_concurrency: all checks passed"
