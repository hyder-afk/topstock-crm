#!/bin/bash
# Day 5a spikes S6 to S9 (design 2.4): start|stop a throwaway PostgreSQL 16 on port 54363 with the auth shim and the
# migrations merged before Day 5 (core schema to lead page). Then: psql -h /tmp/pg5a-spike -p 54363 -U postgres -f s6.sql
# (and s7.sql, s9.sql in that order; bash s8.sh after s7.sql, which makes its fixtures). Local only, fake data.
set -euo pipefail
BIN=/usr/lib/postgresql/16/bin
ROOT="$(cd "$(dirname "$0")/../../../.." && pwd)"
W=/tmp/pg5a-spike
case "${1:-}" in
start)
  rm -rf "$W"; mkdir -p "$W"; chown postgres "$W"
  su postgres -c "$BIN/initdb -D $W/data -A trust -U postgres" >/dev/null
  su postgres -c "$BIN/pg_ctl -D $W/data -o '-p 54363 -k $W -c listen_addresses= -c deadlock_timeout=200ms' -l $W/log start -w" >/dev/null
  P="psql -h $W -p 54363 -U postgres -d postgres -X -q -v ON_ERROR_STOP=1"
  $P -f "$ROOT/supabase/tests/shim.sql"
  for f in "$ROOT"/supabase/migrations/20261009180000_*.sql "$ROOT"/supabase/migrations/2026101[0-2]*.sql; do $P -f "$f"; done
  echo started;;
stop) su postgres -c "$BIN/pg_ctl -D $W/data -m immediate stop" >/dev/null; rm -rf "$W"; echo stopped;;
*) echo "usage: $0 start|stop" >&2; exit 2;;
esac
