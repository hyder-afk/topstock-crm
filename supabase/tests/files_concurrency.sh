#!/bin/bash
# The team's file space under concurrency (Day 4d, design 5.7 and 8.2, threat 25): two database sessions at once.
#  1. quota_race: the space is lowered to what is stored now plus 15 MB. Session 1 starts a 10 MB upload and holds its
#     transaction; session 2 starts another 10 MB upload meanwhile. Session 2 waits for session 1 (the advisory lock in
#     private.file_guard_insert) and is refused with hint "quota": one upload wins, never both.
#  2. pending_race: a person with 4 uploads waiting starts two more from two tabs at once: one is accepted, the other
#     refused with hint "too_many_pending" (the same lock orders them), never 6 waiting.
# Usage: files_concurrency.sh "<libpq connection string>" (run after files_attack.sql, which adds reps g1 and h1 and the
# leads 35000000-...-a1/a2). Used by scripts/db-test.sh and the CI "rls" job.
set -euo pipefail
CONN="${1:?connection string}"
G1=00000000-0000-0000-0000-0000000000f4
D1=00000000-0000-0000-0000-0000000000d1
A1=00000000-0000-0000-0000-0000000000a1
LEAD=35000000-0000-0000-0000-0000000000a2
MB10=10485760
export PGOPTIONS='-c lock_timeout=20s'  # a lock that is never released fails the run instead of hanging it

as_user() {
  local now
  now=$(date +%s)
  psql "$CONN" -X -q -A -t -v ON_ERROR_STOP=1 <<SQL
set role authenticated;
select set_config('request.jwt.claims', '{"sub":"$1","role":"authenticated","aal":"aal2","amr":[{"method":"totp","timestamp":$now}]}', false) \g /dev/null
$2
SQL
}
as_owner() {
  psql "$CONN" -X -q -A -t -v ON_ERROR_STOP=1 <<SQL
select set_config('request.jwt.claims', '', false) \g /dev/null
$1
SQL
}
fail() { echo "FAIL: $*" >&2; exit 1; }
TMP="$(mktemp -d)"
trap 'rm -rf -- "$TMP"' EXIT

# 1. quota_race -------------------------------------------------------------------------------------------------------
as_owner "do \$\$ begin
  execute format('create or replace function private.file_quota_bytes() returns bigint language sql stable set search_path = %L as %L',
    '', format('select %s::bigint', private.org_storage_bytes((select id from public.orgs where name = 'TopStock Wholesale')) + 15728640));
end \$\$;"
as_user "$G1" "begin;
select public.begin_file_upload('$LEAD', 'race one.pdf', 'application/pdf', $MB10) \g /dev/null
select pg_sleep(3) \g /dev/null
commit;" & p1=$!
sleep 1
if as_user "$D1" "select public.begin_file_upload('$LEAD', 'race two.pdf', 'application/pdf', $MB10);" >"$TMP/out2" 2>"$TMP/err2"; then
  wait $p1 || true
  fail "quota_race: both 10 MB uploads were accepted with 15 MB left"
fi
wait $p1 || fail "quota_race: the first upload failed"
grep -q "HINT:  quota" "$TMP/err2" || fail "quota_race: the second upload failed for another reason: $(head -c 300 "$TMP/err2")"
[ "$(as_owner "select count(*) from public.files where name like 'race %' and status = 'pending';")" = "1" ] \
  || fail "quota_race: expected exactly one waiting upload"
as_owner "create or replace function private.file_quota_bytes() returns bigint language sql stable set search_path = '' as \$\$
  select 838860800::bigint
\$\$;"
as_user "$G1" "select public.abort_file_upload(id) from public.files where name = 'race one.pdf' \g /dev/null
select public.finish_file_delete(id) from public.files where name = 'race one.pdf' \g /dev/null"

# 2. pending_race (manager a1: no earlier upload, so the rate limit is far) --------------------------------------------
as_user "$A1" "select public.begin_file_upload('$LEAD', 'wait ' || i || '.pdf', 'application/pdf', 10) from generate_series(1, 4) i \g /dev/null"
as_user "$A1" "begin;
select public.begin_file_upload('$LEAD', 'wait tab one.pdf', 'application/pdf', 10) \g /dev/null
select pg_sleep(3) \g /dev/null
commit;" & p1=$!
sleep 1
if as_user "$A1" "select public.begin_file_upload('$LEAD', 'wait tab two.pdf', 'application/pdf', 10);" >"$TMP/out3" 2>"$TMP/err3"; then
  wait $p1 || true
  fail "pending_race: six uploads waiting for one person"
fi
wait $p1 || fail "pending_race: the first tab's upload failed"
grep -q "HINT:  too_many_pending" "$TMP/err3" || fail "pending_race: refused for another reason: $(head -c 300 "$TMP/err3")"
[ "$(as_owner "select count(*) from public.files where name like 'wait %' and status = 'pending' and uploaded_by = '$A1';")" = "5" ] \
  || fail "pending_race: expected exactly 5 waiting uploads"
as_user "$A1" "select public.abort_file_upload(id) from public.files where name like 'wait %' and uploaded_by = '$A1' \g /dev/null
select public.finish_file_delete(id) from public.files where name like 'wait %' and uploaded_by = '$A1' \g /dev/null"

echo "files_concurrency: all checks passed"
