#!/bin/bash
# Gate 1 two-user attack test as ONE run (Master Plan section 8 "Two-user attack test" steps 1 to 8; Day 7d). Local and
# throwaway only: it needs the local auth stack (scripts/local-auth/start.sh, its env file sourced) and a production
# build of the app started on PLAYWRIGHT_BASE_URL. Fake people and fake data only. Never against a Supabase project.
#   1. SQL: scripts/db-test.sh (every *_attack.sql, the concurrency scripts including twenty_reservers_one_product,
#      gate1_attack.sql, the advisors) on its own scratch PostgreSQL (DB_TEST_PORT).
#   2. Playwright: tests/auth/gate1.spec.ts and every existing spec the step map points at, Chromium.
#   3. Playwright: the signed-out checks (tests/e2e/signed-out.spec.ts) and the unit route inventory.
# The step-to-test map is docs/evidence/day7d/two-user-map.md. Usage:
#   set -a; . <stack>/env; set +a; PLAYWRIGHT_BASE_URL=http://localhost:4100 DB_TEST_PORT=54669 bash scripts/gate1-run.sh
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
for v in SUPABASE_LOCAL_URL SUPABASE_LOCAL_DB_URL NEXT_PUBLIC_SUPABASE_ANON_KEY PLAYWRIGHT_BASE_URL; do
  [ -n "${!v:-}" ] || { echo "gate1-run: $v is not set (source the local stack's env first)" >&2; exit 2; }
done
case "$SUPABASE_LOCAL_URL" in http://127.0.0.1:*|http://localhost:*) ;; *) echo "gate1-run: not a local stack" >&2; exit 2 ;; esac
status=0
echo "== 1. SQL attack suites (scripts/db-test.sh)"
bash scripts/db-test.sh || status=1
echo "== 2. Two-user browser and API run (Chromium)"
npx playwright test -c playwright.auth.config.ts --project=chromium --workers=1 \
  tests/auth/gate1.spec.ts tests/auth/day4-security.spec.ts tests/auth/day5-security.spec.ts \
  tests/auth/import-security.spec.ts tests/auth/day7a.spec.ts tests/auth/team.spec.ts \
  tests/auth/files.spec.ts tests/auth/leads.spec.ts tests/auth/tasks.spec.ts tests/auth/stock-import.spec.ts \
  tests/auth/inventory.spec.ts tests/auth/share.spec.ts || status=1
# The sign-in journey reads invitation and reset e-mails from the stack's mail inbox (MAILPIT_URL, CI's supabase start);
# the local stand-in has none, so only its two mail-free tests run there.
if [ -n "${MAILPIT_URL:-}" ]; then
  npx playwright test -c playwright.auth.config.ts --project=chromium tests/auth/journey.spec.ts || status=1
else
  echo "gate1-run: no MAILPIT_URL, journey.spec.ts runs its mail-free tests only (the rest in CI)"
  npx playwright test -c playwright.auth.config.ts --project=chromium tests/auth/journey.spec.ts -g "unknown address|nobody can sign up" || status=1
fi
echo "== 3. Signed-out checks and the route inventory"
npx playwright test tests/e2e/signed-out.spec.ts || status=1
npx playwright test -c playwright.unit.config.ts tests/unit/route-inventory.spec.ts tests/unit/file-sniff.spec.ts || status=1
echo "gate1-run: exit $status"
exit $status
