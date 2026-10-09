#!/bin/bash
# Local-only Supabase Auth for screenshots and auth tests in cloud VMs where Docker is blocked.
# Builds Supabase Auth (GoTrue) from source at a pinned commit via the Go module proxy, runs it on a throwaway
# PostgreSQL 16, and puts a tiny gateway on :54321 that maps /auth/v1/* like the Supabase API gateway does.
# Fake users only. The JWT secret is random per run. Writes the env to use into $OUT/env (default /tmp/topstock-auth).
# CI does not use this: it runs the real Supabase stack (`supabase start`).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
OUT="${OUT:-/tmp/topstock-auth}"
GOTRUE_PIN="v1.11.1-0.20260922104245-ce9a8eee0cc0" # supabase/auth master commit ce9a8ee, 22 Sep 2026
BIN=/usr/lib/postgresql/16/bin
mkdir -p "$OUT"

if [ ! -x "$OUT/gotrue" ]; then
  GOFLAGS=-mod=mod go mod download -json "github.com/supabase/auth@$GOTRUE_PIN" > "$OUT/mod.json"
  SRC="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["Dir"])' "$OUT/mod.json")"
  rm -rf "$OUT/src" && cp -r "$SRC" "$OUT/src" && chmod -R u+w "$OUT/src"
  # The module zip omits the nested godotenv fork; the upstream release is used instead (local builds only).
  sed -i '/^replace github.com\/joho\/godotenv/d' "$OUT/src/go.mod"
  (cd "$OUT/src" && go build -mod=mod -o "$OUT/gotrue" .)
fi

PG="$(mktemp -d -p /tmp)"
chown postgres "$PG"
su postgres -c "$BIN/initdb -D $PG/data -A trust -U postgres" >/dev/null
su postgres -c "$BIN/pg_ctl -D $PG/data -o '-p 54330 -k $PG -c listen_addresses=127.0.0.1' -l $PG/log start -w" >/dev/null
psql -h 127.0.0.1 -p 54330 -U postgres -d postgres -X -q -v ON_ERROR_STOP=1 -f "$OUT/src/hack/init_postgres.sql"
psql -h 127.0.0.1 -p 54330 -U postgres -d postgres -X -q \
  -c "create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls; create role dashboard_user nologin;"

SECRET="$(openssl rand -hex 32)"
export GOTRUE_JWT_SECRET="$SECRET" GOTRUE_JWT_EXP=3600 GOTRUE_JWT_AUD=authenticated GOTRUE_JWT_DEFAULT_GROUP_NAME=authenticated \
  GOTRUE_JWT_ADMIN_ROLES=service_role GOTRUE_DB_DRIVER=postgres DB_NAMESPACE=auth \
  DATABASE_URL="postgres://supabase_auth_admin:root@127.0.0.1:54330/postgres?sslmode=disable" \
  GOTRUE_DB_MIGRATIONS_PATH="$OUT/src/migrations" API_EXTERNAL_URL="http://127.0.0.1:54321/auth/v1" \
  GOTRUE_API_HOST=127.0.0.1 PORT=9999 GOTRUE_SITE_URL="http://localhost:3100" \
  GOTRUE_DISABLE_SIGNUP=true GOTRUE_EXTERNAL_EMAIL_ENABLED=true GOTRUE_MAILER_AUTOCONFIRM=true \
  GOTRUE_MFA_TOTP_ENROLL_ENABLED=true GOTRUE_MFA_TOTP_VERIFY_ENABLED=true GOTRUE_PASSWORD_MIN_LENGTH=12 GOTRUE_LOG_LEVEL=warn
"$OUT/gotrue" migrate > "$OUT/migrate.log" 2>&1
nohup "$OUT/gotrue" serve > "$OUT/gotrue.log" 2>&1 < /dev/null &
nohup node "$ROOT/scripts/local-auth/gateway.mjs" > "$OUT/gateway.log" 2>&1 < /dev/null &
{
  echo "NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321"
  echo "NEXT_PUBLIC_SUPABASE_ANON_KEY=$(node "$ROOT/scripts/local-auth/jwt.mjs" "$SECRET" anon)"
  echo "SUPABASE_LOCAL_URL=http://127.0.0.1:54321"
  echo "SUPABASE_LOCAL_SERVICE_ROLE_KEY=$(node "$ROOT/scripts/local-auth/jwt.mjs" "$SECRET" service_role)"
} > "$OUT/env"
echo "$PG" > "$OUT/pgdir"
for _ in $(seq 1 20); do curl -fsS http://127.0.0.1:54321/auth/v1/health >/dev/null 2>&1 && break; sleep 0.5; done
echo "Local auth ready. Use: set -a; . $OUT/env; set +a  (then build and run: npx playwright test -c playwright.auth.config.ts tests/auth/screens.spec.ts)"
