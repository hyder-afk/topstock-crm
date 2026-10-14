#!/bin/bash
# Role changes under concurrency (Team screen, verifier finding 2): two database sessions at once, the first holding its
# transaction open for 2 seconds while the second starts. Every organisation here is made for this test, with its own
# admins, so the counts are exact.
#  1. demote_each_other_keeps_an_admin: two admins, each demoting the other at the same moment. The second waits for the
#     first (the organisation's admin rows are locked before anyone counts them), then is refused (it is no longer an
#     admin, and the other is the last one). One admin is left, never none.
#  2. demoted_admin_cannot_demote: three admins, two demoting each other at once. The second session queues behind the
#     first on the admin rows, is checked again once it gets them, and is refused with 42501 because it was demoted
#     meanwhile; the other two admins stay. (The admin rows are locked in id order, before the target, so two calls
#     never take them in opposite orders; each call takes them all at its start, so no test can interleave two calls
#     between those locks, and a deadlock answer, 40P01, would fail this case.)
#  3. demoted_admin_cannot_promote: an admin promotes a rep while another admin is demoting them. Once the demotion
#     commits, the promotion is refused (the caller is checked again after the wait) and the rep stays a rep.
# Usage: team_concurrency.sh "<libpq connection string>" (after the migrations). Used by scripts/db-test.sh and the CI
# "rls" job. Fixtures are made by the superuser connection; the probes run through the API role with a fresh code.
set -euo pipefail
CONN="${1:?connection string}"
fail() { echo "FAIL: $*" >&2; exit 1; }
TMP_TC=$(mktemp -d)
trap 'rm -rf "$TMP_TC"' EXIT

# Runs SQL as $1 with two-factor and a code entered now (claims set the way Supabase does). Errors print their SQLSTATE.
as_user() {
  psql "$CONN" -X -q -A -t -v ON_ERROR_STOP=1 <<SQL
\set VERBOSITY verbose
set role authenticated;
select set_config('request.jwt.claims', '{"sub":"$1","role":"authenticated","aal":"aal2","amr":[{"method":"totp","timestamp":$(date +%s)}]}', false) \g /dev/null
$2
SQL
}
as_owner() { psql "$CONN" -X -q -A -t -v ON_ERROR_STOP=1 -c "$1"; }

# An organisation of its own with the given people: org_people <name> <id:role>...
org_people() {
  local name=$1 org spec
  shift
  org=$(as_owner "insert into public.orgs (name) values ('$name') returning id;" | head -n 1)
  for spec in "$@"; do
    as_owner "insert into auth.users (id, email) values ('${spec%%:*}', '${spec%%:*}@test.invalid');" > /dev/null
    as_owner "update public.profiles set org_id = '$org', role = '${spec#*:}' where id = '${spec%%:*}';" > /dev/null
  done
  echo "$org"
}
admins() { as_owner "select coalesce(string_agg(id::text, ' ' order by id), '') from public.profiles where org_id = '$1' and role = 'admin';"; }
role_of() { as_owner "select role from public.profiles where id = '$1';"; }

# 1. Two admins demote each other ---------------------------------------------------------------------------------------
X1=00000000-0000-0000-0000-0000000007a1
Y1=00000000-0000-0000-0000-0000000007b1
org1=$(org_people 'Race two admins' "$X1:admin" "$Y1:admin")
as_user "$X1" "begin;
select public.set_user_role('$Y1', 'rep') \g /dev/null
select pg_sleep(2) \g /dev/null
commit;" > /dev/null 2>"$TMP_TC/1a.err" & pa=$!
sleep 0.5
rb=0; as_user "$Y1" "select public.set_user_role('$X1', 'rep') \g /dev/null" > /dev/null 2>"$TMP_TC/1b.err" || rb=$?
wait $pa || fail "demote_each_other_keeps_an_admin: the first session failed: $(cat "$TMP_TC/1a.err")"
[ $rb != 0 ] || fail "demote_each_other_keeps_an_admin: both demotions committed (admins left: '$(admins "$org1")')"
grep -q '42501' "$TMP_TC/1b.err" || fail "demote_each_other_keeps_an_admin: the second session failed with: $(cat "$TMP_TC/1b.err")"
[ "$(admins "$org1")" = "$X1" ] || fail "demote_each_other_keeps_an_admin: admins left '$(admins "$org1")' (expected $X1)"

# 2. Three admins, two demote each other: the one demoted first cannot act ---------------------------------------------
X2=00000000-0000-0000-0000-0000000007a2
Y2=00000000-0000-0000-0000-0000000007b2
Z2=00000000-0000-0000-0000-0000000007c2
org2=$(org_people 'Race three admins' "$X2:admin" "$Y2:admin" "$Z2:admin")
as_user "$X2" "begin;
select public.set_user_role('$Y2', 'manager') \g /dev/null
select pg_sleep(2) \g /dev/null
commit;" > /dev/null 2>"$TMP_TC/2a.err" & pa=$!
sleep 0.5
rb=0; as_user "$Y2" "select public.set_user_role('$X2', 'manager') \g /dev/null" > /dev/null 2>"$TMP_TC/2b.err" || rb=$?
wait $pa || fail "demoted_admin_cannot_demote: the first session failed: $(cat "$TMP_TC/2a.err")"
[ $rb != 0 ] || fail "demoted_admin_cannot_demote: an admin demoted meanwhile still demoted another (admins left: '$(admins "$org2")')"
grep -q '40P01' "$TMP_TC/2b.err" && fail "demoted_admin_cannot_demote: deadlock: $(cat "$TMP_TC/2b.err")"
grep -q '42501' "$TMP_TC/2b.err" || fail "demoted_admin_cannot_demote: the second session failed with: $(cat "$TMP_TC/2b.err")"
[ "$(admins "$org2")" = "$X2 $Z2" ] || fail "demoted_admin_cannot_demote: admins left '$(admins "$org2")' (expected $X2 $Z2)"
[ "$(role_of "$Y2")" = "manager" ] || fail "demoted_admin_cannot_demote: $Y2 is '$(role_of "$Y2")' (expected manager)"

# 3. A demoted admin's promotion is refused after the wait ------------------------------------------------------------
X3=00000000-0000-0000-0000-0000000007a3
Y3=00000000-0000-0000-0000-0000000007b3
R3=00000000-0000-0000-0000-0000000007d3
org3=$(org_people 'Race promotion' "$X3:admin" "$Y3:admin" "$R3:rep")
as_user "$X3" "begin;
select public.set_user_role('$Y3', 'rep') \g /dev/null
select pg_sleep(2) \g /dev/null
commit;" > /dev/null 2>"$TMP_TC/3a.err" & pa=$!
sleep 0.5
rb=0; as_user "$Y3" "select public.set_user_role('$R3', 'admin') \g /dev/null" > /dev/null 2>"$TMP_TC/3b.err" || rb=$?
wait $pa || fail "demoted_admin_cannot_promote: the first session failed: $(cat "$TMP_TC/3a.err")"
[ $rb != 0 ] || fail "demoted_admin_cannot_promote: the promotion committed after its author was demoted"
grep -q '42501' "$TMP_TC/3b.err" || fail "demoted_admin_cannot_promote: the second session failed with: $(cat "$TMP_TC/3b.err")"
[ "$(role_of "$R3")" = "rep" ] && [ "$(admins "$org3")" = "$X3" ] \
  || fail "demoted_admin_cannot_promote: $R3 is '$(role_of "$R3")', admins '$(admins "$org3")'"
[ "$(as_owner "select count(*) from public.audit_log where action = 'role_change' and org_id = '$org3';")" = "1" ] \
  || fail "demoted_admin_cannot_promote: expected exactly one audited role change"

echo 'team_concurrency: all checks passed'
