#!/bin/bash
# Local RLS test: throwaway PostgreSQL 16 cluster + auth shim + migrations + attack tests + Supabase advisors.
# No keys; the only network call fetches the pinned advisor rules (scripts/db-advisors.sh).
# CI runs the same migrations and tests against the real Supabase Postgres image.
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
su postgres -c "$BIN/pg_ctl -D $WORK/data -o '-p 54329 -k $WORK -c listen_addresses=' -l $WORK/log start -w" >/dev/null
PSQL="psql -h $WORK -p 54329 -U postgres -d postgres -X -q -v ON_ERROR_STOP=1"
$PSQL -f "$ROOT/supabase/tests/shim.sql"
for f in "$ROOT"/supabase/migrations/*.sql; do $PSQL -f "$f"; done
$PSQL -f "$ROOT/supabase/tests/rls_attack.sql"
$PSQL -f "$ROOT/supabase/tests/import_attack.sql"
bash "$ROOT/supabase/tests/import_concurrency.sh" "host=$WORK port=54329 user=postgres dbname=postgres"
$PSQL -f "$ROOT/supabase/tests/activity_attack.sql"
bash "$ROOT/supabase/tests/activity_concurrency.sh" "host=$WORK port=54329 user=postgres dbname=postgres"
$PSQL -f "$ROOT/supabase/tests/outcome_attack.sql"
bash "$ROOT/supabase/tests/outcome_concurrency.sh" "host=$WORK port=54329 user=postgres dbname=postgres"
$PSQL -f "$ROOT/supabase/tests/stock_attack.sql"
bash "$ROOT/supabase/tests/stock_concurrency.sh" "host=$WORK port=54329 user=postgres dbname=postgres"
$PSQL -f "$ROOT/supabase/tests/inventory_attack.sql"
bash "$ROOT/scripts/db-advisors.sh" -h "$WORK" -p 54329 -U postgres -d postgres
