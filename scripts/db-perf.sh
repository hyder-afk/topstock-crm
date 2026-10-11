#!/bin/bash
# Leads list speed at Release 1 size: throwaway PostgreSQL 16 + auth shim + migrations + 30k fake leads, then timings
# and query plans of the list and count functions as a signed-in rep (supabase/tests/perf_leads.sql), then 300k
# activities and 15k tasks with the Day 4 timeline timings (supabase/tests/perf_day4.sql), then the lead import at 30k
# and 50k rows as an admin, with those activities and tasks in place (supabase/tests/perf_import.sql). Day 6a adds the
# stock engine timings (supabase/tests/perf_stock.sql: 5,000 products, 200,000 ledger rows, 5,000 holds) before the
# import, so the import's undo runs with holds in place, and the stock concurrency timings (stock_concurrency.sh perf)
# at the end. Local only.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BIN=/usr/lib/postgresql/16/bin
WORK="$(mktemp -d -p /tmp)"
chown postgres "$WORK" 2>/dev/null || true
cleanup() {
  su postgres -c "$BIN/pg_ctl -D $WORK/data -m immediate stop" >/dev/null 2>&1 || true
  case "${WORK:?}" in /tmp/tmp.*) rm -rf -- "${WORK:?}" ;; esac  # only ever the mktemp folder
}
trap cleanup EXIT
su postgres -c "$BIN/initdb -D $WORK/data -A trust -U postgres" >/dev/null
su postgres -c "$BIN/pg_ctl -D $WORK/data -o '-p 54327 -k $WORK -c listen_addresses=' -l $WORK/log start -w" >/dev/null
PSQL="psql -h $WORK -p 54327 -U postgres -d postgres -X -q -v ON_ERROR_STOP=1"
$PSQL -f "$ROOT/supabase/tests/shim.sql"
for f in "$ROOT"/supabase/migrations/*.sql; do $PSQL -f "$f"; done
$PSQL -f "$ROOT/supabase/tests/perf_leads.sql" 2>&1
$PSQL -f "$ROOT/supabase/tests/perf_day4.sql" 2>&1
$PSQL -f "$ROOT/supabase/tests/perf_stock.sql" 2>&1
$PSQL -f "$ROOT/supabase/tests/perf_import.sql" 2>&1
bash "$ROOT/supabase/tests/stock_concurrency.sh" "host=$WORK port=54327 user=postgres dbname=postgres" perf 2>&1
