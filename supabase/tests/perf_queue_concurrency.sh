#!/bin/bash
# Day 4c speed under concurrency (design 8.6 P10): three sessions at once, 100 rounds each, on the Release 1 size
# database scripts/db-perf.sh builds (30,015 leads, 300,000 activities). A round claims the next lead of the team queue
# (claim_next_lead, committed) and logs "no answer" from the queue (log_activity, which releases the claim), as the queue
# screen does. Each session alternates between two admins, so no one passes the 60-entries-a-minute flood guard. Calling
# hours as at the moment it runs ("outside calling hours too" only when no country is in hours).
# Prints the claim times (p50, p95, max) and the outcome times, and fails on a lead served twice, a deadlock or any error.
# Budget: p95 claim <= 60 ms, 0 duplicates, 0 deadlocks. Usage: perf_queue_concurrency.sh "<libpq connection string>".
set -euo pipefail
CONN="${1:?connection string}"
fail() { echo "FAIL: $*" >&2; exit 1; }
TMPDIR_PQ=$(mktemp -d)
trap 'rm -rf "$TMPDIR_PQ"' EXIT
psql "$CONN" -X -q -v ON_ERROR_STOP=1 -c "insert into auth.users (id, email) select ('00000000-0000-0000-0000-0000000000e' || g)::uuid,
    'perf-queue-' || g || '@test.invalid' from unnest(array['5','6','7','8','9','a']) g;
  update public.profiles set role = 'admin' where id::text like '00000000-0000-0000-0000-0000000000e_'
    and id::text > '00000000-0000-0000-0000-0000000000e4';" > /dev/null
ANY_HOURS=$(psql "$CONN" -X -q -A -t -c "select not exists (select 1 from unnest(private.call_zone_keys()) k
                                           where private.call_zone_open(k, now(), false));")
[ "$ANY_HOURS" = "t" ] && ANY=true || ANY=false
echo "P10: 3 sessions x 100 rounds, team queue, p_any_hours = $ANY"
session() {
  psql "$CONN" -X -q -A -t -v ON_ERROR_STOP=1 <<SQL 2> "$TMPDIR_PQ/s$3.err" > /dev/null
set deadlock_timeout = '200ms';
set role authenticated;
do \$\$
declare
  r jsonb;
  lead uuid;
  t0 timestamptz;
  who text;
begin
  for n in 1..100 loop
    who := case when n % 2 = 0 then '$1' else '$2' end;
    perform set_config('request.jwt.claims', '{"sub":"' || who || '","role":"authenticated","aal":"aal2"}', false);
    t0 := clock_timestamp();
    r := public.claim_next_lead('team', '{}'::uuid[], '{}', 1, $ANY);
    raise notice 'claim_ms % lead %', round(extract(epoch from clock_timestamp() - t0) * 1000, 3), r -> 'cards' -> 0 ->> 'id';
    lead := (r -> 'cards' -> 0 ->> 'id')::uuid;
    commit;
    exit when lead is null;
    t0 := clock_timestamp();
    perform public.log_activity(lead, 'call', 'no_answer', p_from_queue => true);
    commit;
    raise notice 'outcome_ms %', round(extract(epoch from clock_timestamp() - t0) * 1000, 3);
  end loop;
end \$\$;
SQL
}
session 00000000-0000-0000-0000-0000000000e5 00000000-0000-0000-0000-0000000000e6 1 & p1=$!
session 00000000-0000-0000-0000-0000000000e7 00000000-0000-0000-0000-0000000000e8 2 & p2=$!
session 00000000-0000-0000-0000-0000000000e9 00000000-0000-0000-0000-0000000000ea 3 & p3=$!
for s in 1 2 3; do
  eval "wait \$p$s" || fail "P10 session $s: $(grep -v NOTICE "$TMPDIR_PQ/s$s.err" | head -5)"
done
grep -ho 'claim_ms [0-9.]*' "$TMPDIR_PQ"/s*.err | awk '{print $2}' | sort -n > "$TMPDIR_PQ/claims"
grep -ho 'outcome_ms [0-9.]*' "$TMPDIR_PQ"/s*.err | awk '{print $2}' | sort -n > "$TMPDIR_PQ/outcomes"
grep -ho 'lead [0-9a-f-]\{36\}' "$TMPDIR_PQ"/s*.err | sort > "$TMPDIR_PQ/leads"
dups=$(uniq -d "$TMPDIR_PQ/leads" | wc -l)
deadlocks=$(cat "$TMPDIR_PQ"/s*.err | { grep -c 'deadlock' || true; })
pct() { awk -v p="$2" '{a[NR] = $1} END {i = int((NR * p + 99) / 100); if (i < 1) i = 1; print a[i]}' "$1"; }
echo "P10 claims: $(wc -l < "$TMPDIR_PQ/claims") (leads served: $(wc -l < "$TMPDIR_PQ/leads")), p50 $(pct "$TMPDIR_PQ/claims" 50) ms, p95 $(pct "$TMPDIR_PQ/claims" 95) ms, max $(tail -1 "$TMPDIR_PQ/claims") ms"
echo "P10 outcomes: $(wc -l < "$TMPDIR_PQ/outcomes"), p50 $(pct "$TMPDIR_PQ/outcomes" 50) ms, p95 $(pct "$TMPDIR_PQ/outcomes" 95) ms, max $(tail -1 "$TMPDIR_PQ/outcomes") ms"
echo "P10 duplicates: $dups, deadlocks: $deadlocks"
[ "$dups" -eq 0 ] || fail "P10: $dups leads served twice"
[ "$deadlocks" -eq 0 ] || fail "P10: $deadlocks deadlocks"
psql "$CONN" -X -q -c "delete from private.queue_claims where user_id::text like '00000000-0000-0000-0000-0000000000e_';" > /dev/null
