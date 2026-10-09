#!/bin/bash
# Supabase security + performance advisors (splinter, the lints behind the dashboard's Advisors) against a database.
# Usage: scripts/db-advisors.sh <psql connection args...>. Fails on any ERROR-level finding; WARN/INFO are printed.
# splinter is downloaded at a pinned commit and checked against its SHA-256 (not vendored: the repo has no licence file).
set -euo pipefail
SPLINTER_COMMIT=fccca4b1c4d8b48b8ccd69bd6b30e84adcb92975
SPLINTER_SHA256=d8d558baad3e03832e521c527907fa50a9a172fabd899dd0f5c2504a5a0e9349
CACHE="${TMPDIR:-/tmp}/splinter-$SPLINTER_COMMIT.sql"
if [ ! -f "$CACHE" ]; then
  curl -fsSL "https://raw.githubusercontent.com/supabase/splinter/$SPLINTER_COMMIT/splinter.sql" -o "$CACHE.part"
  mv "$CACHE.part" "$CACHE"
fi
echo "$SPLINTER_SHA256  $CACHE" | sha256sum -c --quiet
# Columns: name, title, level, facing, categories, description, detail, remediation, metadata, cache_key.
OUT="$(psql "$@" -X -q -A -t -F $'\t' -v ON_ERROR_STOP=1 --single-transaction -f "$CACHE")"
if [ -z "$OUT" ]; then
  echo "advisors: no findings"
  exit 0
fi
# WARN and ERROR in full; INFO (e.g. unused_index on an empty database) as counts per lint.
printf '%s\n' "$OUT" | awk -F'\t' '$3 != "INFO" { printf "%-5s %s: %s\n", $3, $1, $7 }'
printf '%s\n' "$OUT" | awk -F'\t' '$3 == "INFO" { n[$1]++ } END { for (k in n) printf "INFO  %s: %d\n", k, n[k] }'
if printf '%s\n' "$OUT" | awk -F'\t' '$3 == "ERROR" { found = 1 } END { exit !found }'; then
  echo "advisors: ERROR-level findings above"
  exit 1
fi
echo "advisors: no ERROR-level findings"
