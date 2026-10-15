#!/bin/bash
# Day 6a spikes S2, S3 and S6 (design docs/evidence/day6/design.md section 2.4): a throwaway PG16 cluster, the auth shim
# and the migrations merged before 6a, then s2_s3.sql and the two-session part of S2 (f). Local only; no keys, no network.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../../../.." && pwd)"
HERE="$(cd "$(dirname "$0")" && pwd)"
BIN=/usr/lib/postgresql/16/bin
WORK="$(mktemp -d -p /tmp)"
chown postgres "$WORK"
cleanup() { su postgres -c "$BIN/pg_ctl -D $WORK/data -m immediate stop" >/dev/null 2>&1 || true; case "$WORK" in /tmp/tmp.*) rm -rf -- "$WORK";; esac; }
trap cleanup EXIT
su postgres -c "$BIN/initdb -D $WORK/data -A trust -U postgres" >/dev/null
su postgres -c "$BIN/pg_ctl -D $WORK/data -o '-p 54325 -k $WORK -c listen_addresses=' -l $WORK/log start -w" >/dev/null
PSQL="psql -h $WORK -p 54325 -U postgres -d postgres -X -q -v ON_ERROR_STOP=1"
$PSQL -At -c "select version()"
$PSQL -f "$ROOT/supabase/tests/shim.sql"
for f in "$ROOT"/supabase/migrations/2026100*.sql "$ROOT"/supabase/migrations/20261010*.sql \
         "$ROOT"/supabase/migrations/20261011120000_activity_hardening.sql; do $PSQL -f "$f"; done
$PSQL -f "$HERE/s2_s3.sql"

echo '--- S2 (f): after waiting on FOR UPDATE, READ COMMITTED re-reads the latest row'
# Session 1 takes 10 pieces and holds its transaction for 2 s; session 2 (an authenticated user whose insert fires the
# definer apply trigger) waits on the level lock, then must see on_hand 90, not the 100 it would have read before.
$PSQL -c "update spike.levels set on_hand = 100 where product_id = 1"
$PSQL <<'SQL' &
begin;
update spike.levels set on_hand = on_hand - 10 where product_id = 1;
select pg_sleep(2) \g /dev/null
commit;
SQL
sleep 0.5
$PSQL -At <<'SQL'
set role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000f2","role":"authenticated"}', false) \g /dev/null
insert into spike.ledger (product_id, kind, qty) values (1, 'take', 5);
reset role;
select 'S2 (f) apply saw on_hand ' || seen_on_hand || ' after the wait (expect 90); level now ' ||
       (select on_hand from spike.levels where product_id = 1) || ' (expect 85)'
  from spike.log where what = 'apply' order by n desc limit 1;
SQL
wait
echo '--- S6: is pg_cron available on this server?'
$PSQL -At -c "select coalesce((select 'available, default_version ' || default_version || ', installed ' || coalesce(installed_version, 'no') from pg_available_extensions where name = 'pg_cron'), 'not available')"
