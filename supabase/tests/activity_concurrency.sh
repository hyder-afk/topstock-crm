#!/bin/bash
# Last activity under concurrency (Day 4 decision D9; design docs/evidence/day4/design.md section 3.1): two database
# sessions at once on one lead, which has a date from the sheet (15 Jan 2026).
#  1. Two deletes at once (two undos, or a delete and an undo), in both orders: the lead goes back to the sheet's date,
#     not to the time of an entry that is gone.
#  2. An entry whose transaction started before the newest entry, still open when the newest entry is deleted: the lead
#     goes back to that entry's time, not to the sheet's date while the entry exists. It is logged by rep d1 on rep b1's
#     lead (d1 may log there but not change the lead), so the lead lock must hold for people who cannot change the lead.
#  3. Lock order contact, then lead (design 5.2): a session that locks a contact and then its lead (as 4b's log_activity
#     will) and a plain entry naming that contact, at once: both finish, neither is cancelled as a deadlock.
# Usage: activity_concurrency.sh "<libpq connection string>" (run after activity_attack.sql, which adds rep d1). Used by
# scripts/db-test.sh and the CI "rls" job.
set -euo pipefail
CONN="${1:?connection string}"
ADMIN=00000000-0000-0000-0000-00000000000a
B1=00000000-0000-0000-0000-0000000000b1
D1=00000000-0000-0000-0000-0000000000d1
SHEET='2026-01-15 10:00:00+00'
export PGOPTIONS='-c lock_timeout=20s'  # a lock that is never released fails the run instead of hanging it

# Runs SQL as a person with a fresh two-factor code (claims set the way Supabase does). -A -t: bare values.
as_user() {
  local now
  now=$(date +%s)
  psql "$CONN" -X -q -A -t -v ON_ERROR_STOP=1 <<SQL
set role authenticated;
select set_config('request.jwt.claims', '{"sub":"$1","role":"authenticated","aal":"aal2","amr":[{"method":"totp","timestamp":$now}]}', false) \g /dev/null
$2
SQL
}
# Runs SQL as the superuser with no claims (fixtures and checks: the guards step aside, row level security does not apply).
as_owner() {
  psql "$CONN" -X -q -A -t -v ON_ERROR_STOP=1 <<SQL
select set_config('request.jwt.claims', '', false) \g /dev/null
$1
SQL
}
fail() { echo "FAIL: $*" >&2; exit 1; }
new_lead() {
  as_owner "insert into public.companies (org_id, name, owner_id, last_activity_at)
            select id, '$1', '$B1', timestamptz '$SHEET' from public.orgs where name = 'TopStock Wholesale' returning id;"
}
log_call() {  # log_call <person> <lead>: one entry in its own transaction; prints its id
  as_user "$1" "insert into public.activities (company_id, type, outcome) values ('$2', 'call', 'no_answer') returning id;"
}
lead_date_is_sheet() {
  as_owner "select count(*) from public.companies where id = '$1' and last_activity_at = timestamptz '$SHEET';"
}

# 1. Two deletes at once ----------------------------------------------------------------------------------------------
# a) Session 1 deletes the newest entry B and holds its transaction; session 2 deletes the older entry A meanwhile.
lead=$(new_lead 'D9 race, newest first')
a=$(log_call "$B1" "$lead")
b=$(log_call "$B1" "$lead")
as_user "$B1" "begin;
delete from public.activities where id = '$b';
select pg_sleep(3) \g /dev/null
commit;" & p1=$!
sleep 1
as_user "$ADMIN" "delete from public.activities where id = '$a';" || fail "second delete (newest first) failed"
wait $p1 || fail "first delete (newest first) failed"
left=$(as_owner "select count(*) from public.activities where company_id = '$lead';")
[ "$left" = "0" ] || fail "parallel deletes (newest first) left $left entries"
[ "$(lead_date_is_sheet "$lead")" = "1" ] || fail "parallel deletes (newest first) left the lead on $(as_owner "select last_activity_at from public.companies where id = '$lead';"), expected the sheet's date"

# b) Session 1 deletes the older entry A and holds its transaction; session 2 deletes the newest entry B meanwhile.
lead=$(new_lead 'D9 race, oldest first')
a=$(log_call "$B1" "$lead")
b=$(log_call "$B1" "$lead")
as_user "$ADMIN" "begin;
delete from public.activities where id = '$a';
select pg_sleep(3) \g /dev/null
commit;" & p1=$!
sleep 1
as_user "$B1" "delete from public.activities where id = '$b';" || fail "second delete (oldest first) failed"
wait $p1 || fail "first delete (oldest first) failed"
left=$(as_owner "select count(*) from public.activities where company_id = '$lead';")
[ "$left" = "0" ] || fail "parallel deletes (oldest first) left $left entries"
[ "$(lead_date_is_sheet "$lead")" = "1" ] || fail "parallel deletes (oldest first) left the lead on $(as_owner "select last_activity_at from public.companies where id = '$lead';"), expected the sheet's date"

# 2. An entry from a transaction that started before the newest entry ------------------------------------------------
# Rep d1's transaction starts (its entry will carry this start time), then rep b1 logs B, then d1 logs C (older than B,
# so the touch trigger leaves the lead on B) and holds its transaction; b1 deletes B meanwhile.
lead=$(new_lead 'D9 race, early entry')
as_user "$D1" "begin;
select pg_sleep(2) \g /dev/null
insert into public.activities (company_id, type, body) values ('$lead', 'note', 'started early');
select pg_sleep(4) \g /dev/null
commit;" & p1=$!
sleep 1
b_row=$(as_user "$B1" "insert into public.activities (company_id, type, outcome) values ('$lead', 'call', 'voicemail') returning id || ' ' || created_at;")
b=${b_row%% *}
b_at=${b_row#* }
sleep 2
as_user "$B1" "delete from public.activities where id = '$b';" || fail "deleting the newest entry failed"
wait $p1 || fail "the early entry's session failed"
early=$(as_owner "select count(*) from public.activities where company_id = '$lead' and body = 'started early'
                    and created_at < timestamptz '$b_at';")
[ "$early" = "1" ] || fail "the early entry is missing or not older than the deleted one (the race did not happen)"
ok=$(as_owner "select count(*) from public.companies c where c.id = '$lead' and c.last_activity_at =
                 (select a.created_at from public.activities a where a.company_id = c.id and a.body = 'started early');")
[ "$ok" = "1" ] || fail "deleting the newest entry left the lead on $(as_owner "select last_activity_at from public.companies where id = '$lead';") while an entry from $(as_owner "select created_at from public.activities where company_id = '$lead';") is still there"

# 3. Lock order: contact, then lead -------------------------------------------------------------------------------------
# Session 1 locks the contact, waits, then locks the lead (log_activity's order). Rep b1 meanwhile logs an entry naming
# that contact. With the lead locked first, b1 would hold the lead while waiting for the contact and session 1 would
# wait for the lead: PostgreSQL would cancel one of them (40P01).
lead=$(new_lead 'Lock order')
contact=$(as_owner "insert into public.contacts (org_id, company_id, first_name)
                    select org_id, id, 'Lock order contact' from public.companies where id = '$lead' returning id;")
as_owner "begin;
select 1 from public.contacts where id = '$contact' for update \g /dev/null
select pg_sleep(2) \g /dev/null
select 1 from public.companies where id = '$lead' for update \g /dev/null
commit;" & p1=$!
sleep 1
as_user "$B1" "insert into public.activities (company_id, contact_id, type, outcome) values ('$lead', '$contact', 'call', 'no_answer');" \
  || fail "an entry naming a contact failed while the contact and its lead were being locked in order (deadlock?)"
wait $p1 || fail "the contact-then-lead session failed (deadlock?)"
[ "$(as_owner "select count(*) from public.activities where company_id = '$lead';")" = "1" ] || fail "the lock-order entry is missing"

echo 'activity_concurrency: all checks passed'
