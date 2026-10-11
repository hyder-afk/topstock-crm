#!/bin/bash
# Spike S5: throwaway PG16 cluster, shim + current migrations, then spike.sql. Local only.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../../../.." && pwd)"
BIN=/usr/lib/postgresql/16/bin
WORK="$(mktemp -d -p /tmp)"
chown postgres "$WORK"
cleanup() { su postgres -c "$BIN/pg_ctl -D $WORK/data -m immediate stop" >/dev/null 2>&1 || true; case "$WORK" in /tmp/tmp.*) rm -rf -- "$WORK";; esac; }
trap cleanup EXIT
su postgres -c "$BIN/initdb -D $WORK/data -A trust -U postgres" >/dev/null
su postgres -c "$BIN/pg_ctl -D $WORK/data -o '-p 54326 -k $WORK -c listen_addresses=' -l $WORK/log start -w" >/dev/null
PSQL="psql -h $WORK -p 54326 -U postgres -d postgres -X -q -v ON_ERROR_STOP=1"
$PSQL -c "select version()" -At
$PSQL -f "$ROOT/supabase/tests/shim.sql"
for f in "$ROOT"/supabase/migrations/2026100*.sql "$ROOT"/supabase/migrations/20261010*.sql; do $PSQL -f "$f"; done
$PSQL -f "$(dirname "$0")/spike.sql"
