#!/bin/bash
# The client stock link under concurrency (Day 6e; design docs/evidence/day6/design.md section 11.2), as the anon role
# exactly as PostgREST calls the two functions.
#  1. share_request_parallel_one_task: 5 parallel requests on one link: 5 requests (the hourly cap is 5), 1 open task
#     for the lead, request_count 5, no error.
#  2. share_request_parallel_over_cap: 8 more parallel requests on a fresh link: at most 5 + the parallel overshoot the
#     design accepts (never more than 8), every other answer "slow_down", 1 open task.
#  3. share_view_parallel_counters: 40 parallel views on a fresh link: at most 30 + the overshoot answered "ok", the rest
#     "slow_down", open_count 1 (one open a 5-minute window), no deadlock.
# Usage: share_concurrency.sh "<libpq connection string>". Used by scripts/db-test.sh and the CI "db" job. Its fixtures
# (an admin, leads named "SHC …", one product) are its own.
set -euo pipefail
CONN="${1:?connection string}"
export PGOPTIONS='-c lock_timeout=20s'
WORKDIR="$(mktemp -d)"
trap 'rm -rf -- "$WORKDIR"' EXIT
ADMIN=00000000-0000-0000-0000-000000000901

as_user() {
  local now
  now=$(date +%s)
  psql "$CONN" -X -q -A -t -v ON_ERROR_STOP=1 <<SQL
set role authenticated;
select set_config('request.jwt.claims', '{"sub":"$1","role":"authenticated","aal":"aal2","amr":[{"method":"totp","timestamp":$now}]}', false) \g /dev/null
$2
SQL
}
as_anon() {
  psql "$CONN" -X -q -A -t -v ON_ERROR_STOP=1 <<SQL
set role anon;
select set_config('request.jwt.claims', '{"role":"anon"}', false) \g /dev/null
$1
SQL
}
as_owner() {
  psql "$CONN" -X -q -A -t -v ON_ERROR_STOP=1 <<SQL
select set_config('request.jwt.claims', '', false) \g /dev/null
$1
SQL
}
fail() { echo "FAIL: $*" >&2; exit 1; }
link() {  # a fresh link on lead $1; prints the token
  as_user "$ADMIN" "select public.create_share_link((select id from public.companies where name = '$1'), 'en') ->> 'token';"
}
request() {  # request <token> <n>: one request, prints its status
  as_anon "select public.share_request('$1', jsonb_build_object('lines', '[]'::jsonb, 'note', 'Parallel request $2',
             'name', null, 'idempotency_key', gen_random_uuid())) ->> 'status';"
}

as_owner "
insert into auth.users (id, email) values ('$ADMIN', 'shc-admin@test.invalid') on conflict do nothing;
update public.profiles set role = 'admin' where id = '$ADMIN';
insert into public.companies (org_id, name, owner_id)
select p.org_id, 'SHC Lead ' || g, p.id from public.profiles p, generate_series(1, 3) g where p.id = '$ADMIN';
update private.inventory_settings s set sharing_enabled = true
  from public.profiles p where p.id = '$ADMIN' and s.org_id = p.org_id;" >/dev/null
as_user "$ADMIN" "select public.create_product(p_name => 'SHC Bag', p_pieces_per_carton => 10, p_price_max => 2,
                    p_opening_qty => 100, p_opening_location => 'warehouse') \g /dev/null"

# 1. share_request_parallel_one_task --------------------------------------------------------------------------------------
TOK=$(link 'SHC Lead 1')
for n in 1 2 3 4 5; do ( request "$TOK" "$n" >"$WORKDIR/r$n.out" 2>&1 || true ) & done
wait
[ "$(cat "$WORKDIR"/r*.out | grep -c '^received$')" = "5" ] || fail "share_request_parallel_one_task: $(cat "$WORKDIR"/r*.out | tr '\n' ' ')"
counts=$(as_owner "select (select count(*) from private.stock_requests r join public.companies c on c.id = r.company_id
                             where c.name = 'SHC Lead 1') || '/' ||
                          (select count(*) from public.tasks t join public.companies c on c.id = t.company_id
                            where c.name = 'SHC Lead 1' and t.source_request_id is not null and t.done_at is null) || '/' ||
                          (select l.request_count from private.share_links l join public.companies c on c.id = l.company_id
                            where c.name = 'SHC Lead 1');")
[ "$counts" = "5/1/5" ] || fail "share_request_parallel_one_task: requests/open tasks/request_count = $counts"

# 2. share_request_parallel_over_cap -------------------------------------------------------------------------------------
TOK=$(link 'SHC Lead 2')
for n in $(seq 1 8); do ( request "$TOK" "$n" >"$WORKDIR/o$n.out" 2>&1 || true ) & done
wait
grep -l 'ERROR' "$WORKDIR"/o*.out >/dev/null 2>&1 && fail "share_request_parallel_over_cap: $(grep -h -m1 ERROR "$WORKDIR"/o*.out)"
ok=$(cat "$WORKDIR"/o*.out | grep -c '^received$' || true)
slow=$(cat "$WORKDIR"/o*.out | grep -c '^slow_down$' || true)
[ "$ok" -ge 5 ] && [ $((ok + slow)) = 8 ] || fail "share_request_parallel_over_cap: $ok received, $slow slowed down"
[ "$(request "$TOK" 9)" = "slow_down" ] || fail "share_request_parallel_over_cap: a later request passed the cap"
tasks=$(as_owner "select count(*) from public.tasks t join public.companies c on c.id = t.company_id
                   where c.name = 'SHC Lead 2' and t.source_request_id is not null and t.done_at is null;")
[ "$tasks" = "1" ] || fail "share_request_parallel_over_cap: $tasks open tasks"

# 3. share_view_parallel_counters ----------------------------------------------------------------------------------------
TOK=$(link 'SHC Lead 3')
for n in $(seq 1 40); do
  ( as_anon "select public.share_view('$TOK') ->> 'status';" >"$WORKDIR/v$n.out" 2>&1 || true ) &
done
wait
cat "$WORKDIR"/v*.out | grep -q '40P01\|ERROR' && fail "share_view_parallel_counters: $(grep -h -m1 'ERROR' "$WORKDIR"/v*.out)"
ok=$(cat "$WORKDIR"/v*.out | grep -c '^ok$' || true)
slow=$(cat "$WORKDIR"/v*.out | grep -c '^slow_down$' || true)
[ "$ok" -ge 30 ] && [ "$ok" -le 40 ] && [ $((ok + slow)) = 40 ] || fail "share_view_parallel_counters: $ok ok, $slow slowed down"
opens=$(as_owner "select l.open_count from private.share_links l join public.companies c on c.id = l.company_id
                   where c.name = 'SHC Lead 3';")
[ "$opens" = "1" ] || fail "share_view_parallel_counters: open_count $opens"
echo "share_concurrency: all checks passed ($ok of 40 parallel views answered, the rest slowed down)"
