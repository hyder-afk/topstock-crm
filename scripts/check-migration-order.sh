#!/bin/bash
# Migration order check (Day 5 design D35). deploy-dev-db runs `supabase db push --yes` without --include-all, which
# refuses a migration that sorts before one already applied. So every migration file a pull request adds must sort
# after the newest migration on the base branch; when the base moved, the new file is renamed at merge time.
# Usage: scripts/check-migration-order.sh [base-ref]   (default origin/main; CI passes origin/<base branch>). Needs the
# base ref and HEAD's history (CI: actions/checkout with fetch-depth 0). Also checks the name shape:
# 14 digits, an underscore, lowercase words, .sql.
set -euo pipefail
BASE="${1:-origin/main}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
if ! git rev-parse --verify -q "$BASE^{commit}" > /dev/null; then
  echo "migration order: base ref $BASE not found (fetch it first, e.g. actions/checkout with fetch-depth: 0)" >&2
  exit 2
fi
newest=$(git ls-tree --name-only "$BASE" supabase/migrations/ | sed 's#.*/##' | grep -E '\.sql$' | LC_ALL=C sort | tail -n 1)
added=$(git diff --name-only --diff-filter=A "$BASE...HEAD" -- supabase/migrations/ | sed 's#.*/##' | grep -E '\.sql$' \
        | LC_ALL=C sort || true)
status=0
for f in $added; do
  if ! [[ "$f" =~ ^[0-9]{14}_[a-z0-9_]+\.sql$ ]]; then
    echo "migration order: $f does not look like 20261015090000_name.sql" >&2
    status=1
  fi
  if [ -n "$newest" ] && ! [[ "$f" > "$newest" ]]; then
    echo "migration order: $f sorts at or before $newest, the newest migration on $BASE; rename it to sort after it" >&2
    status=1
  fi
done
if [ "$status" = 0 ]; then
  echo "migration order: ok (newest on $BASE: ${newest:-none}; added here: $(echo $added | tr ' ' ',' ))"
fi
exit "$status"
