#!/bin/bash
# Day 4b outcomes under concurrency (design sections 5.2 and 8.2, threat 10 and the lock order): two database sessions at
# once, each holding its transaction open for 2 seconds while the other starts.
#  1. outcome_parallel_attempts: two "no answer" outcomes at once on a lead with 4 earlier tries. The second waits for
#     the first (the lead is locked), counts it, and is the 6th try in a row: the lead goes to Cool off for 30 days.
#  2. outcome_vs_contact_edit_no_deadlock: a wrong number on a contact while a teammate's transaction changes that contact
#     and then the lead (the order of a contact edit whose trigger updates the lead, as 4c's phone trigger will). Both
#     lock the contact before the lead, so the outcome waits, then marks the new number; nothing deadlocks.
#  3. outcome_replay_idempotent: the same request sent twice at once gives one entry, (a) for a call on a lead the
#     caller may change (the second waits for the lead's lock, then finds the first), and (b) for a note, which takes no
#     lock (the unique request index makes the second wait, then it answers the first).
#  4. outcome_contact_lock_order_no_deadlock: a wrong number on a contact and another call naming that contact, on one
#     lead, both queued behind a third session holding the contact. The wrong number is first in line for the contact,
#     the other call second. Unless every call naming a contact takes it before the lead (the insert lock takes the
#     contact FOR KEY SHARE, which a wrong number's FOR UPDATE blocks), the other call holds the lead while it waits for
#     the contact, the wrong number holds the contact while it waits for the lead, and one of them dies in a deadlock.
#  5. insert_lock_skips_refused_callers: the insert lock (DEFINER, so it passes row level security) locks nothing for a
#     session without two-factor, or a caller naming a lead or a contact of another organisation, whose insert is
#     refused anyway: while a third session holds that lead or contact, the refused insert answers at once instead of
#     waiting for it.
# Usage: outcome_concurrency.sh "<libpq connection string>" (after outcome_attack.sql). Used by scripts/db-test.sh and
# the CI "rls" job. Fixtures are made by the superuser connection; the probes run as the admin through the API role.
set -euo pipefail
CONN="${1:?connection string}"
ADMIN=00000000-0000-0000-0000-00000000000a
D1=00000000-0000-0000-0000-0000000000d1

# Runs SQL as the admin with two-factor (claims set the way Supabase does). -A -t: bare values.
as_admin() {
  psql "$CONN" -X -q -A -t -v ON_ERROR_STOP=1 <<SQL
set role authenticated;
select set_config('request.jwt.claims', '{"sub":"$ADMIN","role":"authenticated","aal":"aal2"}', false) \g /dev/null
$1
SQL
}
# Runs SQL as any user: $1 sub, $2 aal, $3 SQL.
as_user() {
  psql "$CONN" -X -q -A -t -v ON_ERROR_STOP=1 <<SQL
set role authenticated;
select set_config('request.jwt.claims', '{"sub":"$1","role":"authenticated","aal":"$2"}', false) \g /dev/null
$3
SQL
}
as_owner() { psql "$CONN" -X -q -A -t -v ON_ERROR_STOP=1 -c "$1"; }
fail() { echo "FAIL: $*" >&2; exit 1; }
TMPDIR_OC=$(mktemp -d)
trap 'rm -rf "$TMPDIR_OC"' EXIT

# A lead owned by rep d1 (the admin may change it), made by the superuser.
new_lead() {
  as_owner "insert into public.companies (org_id, name, owner_id, lead_status, phone, country)
            select id, '$1', '$D1', 'cold', $2, 'FR' from public.orgs where name = 'TopStock Wholesale' returning id;"
}

# 1. Parallel attempts ------------------------------------------------------------------------------------------------
lead1=$(new_lead 'Concurrency attempts' "'+33 1 99 00 20 01'")
as_owner "insert into public.activities (org_id, company_id, type, outcome, user_id, created_at)
          select org_id, id, 'call', 'no_answer', '$D1', now() - make_interval(hours => g)
            from public.companies, generate_series(2, 5) g where id = '$lead1';" > /dev/null
as_admin "begin;
select public.log_activity('$lead1', 'call', 'no_answer') \g /dev/null
select pg_sleep(2) \g /dev/null
commit;" & pa=$!
sleep 0.5
as_admin "select public.log_activity('$lead1', 'call', 'no_answer') \g /dev/null" & pb=$!
wait $pa || fail "outcome_parallel_attempts: the first session failed"
wait $pb || fail "outcome_parallel_attempts: the second session failed"
got=$(as_owner "select lead_status || ' ' || (next_action_at = (select max(created_at) from public.activities where company_id = c.id) + interval '30 days')
                       || ' ' || private.call_attempts(c.id) from public.companies c where c.id = '$lead1';")
[ "$got" = "cool_off true 6" ] || fail "outcome_parallel_attempts: two parallel tries gave '$got' (expected 'cool_off true 6')"

# 2. A wrong number against a contact edit: no deadlock ---------------------------------------------------------------
lead2=$(new_lead 'Concurrency contact' "null")
contact2=$(as_owner "insert into public.contacts (org_id, company_id, first_name, phone)
                     select org_id, id, 'Racey', '+33 6 39 98 20 02' from public.companies where id = '$lead2' returning id;")
as_admin "begin;
update public.contacts set phone = '+33 6 39 98 20 03' where id = '$contact2';
select pg_sleep(2) \g /dev/null
update public.companies set name = 'Concurrency contact renamed' where id = '$lead2';
commit;" & pa=$!
sleep 0.5
marked=$(as_admin "select public.log_activity('$lead2', 'call', 'wrong_number', null, '$contact2', 'contact', null, null,
                   'Find the right number') ->> 'wrong_number_marked';") \
  || fail "outcome_vs_contact_edit_no_deadlock: the outcome session failed (deadlock?)"
wait $pa || fail "outcome_vs_contact_edit_no_deadlock: the contact session failed (deadlock?)"
got=$(as_owner "select k.phone || ' ' || (k.phone_wrong_at is not null) || ' ' || c.name
                  from public.contacts k join public.companies c on c.id = k.company_id where k.id = '$contact2';")
[ "$marked" = "true" ] && [ "$got" = "+33 6 39 98 20 03 true Concurrency contact renamed" ] \
  || fail "outcome_vs_contact_edit_no_deadlock: marked '$marked', contact and lead '$got'"

# 3. The same request twice at once -----------------------------------------------------------------------------------
replay() {  # $1: label, $2: SQL call with :req for the request id
  local lead req pa out count
  lead=$(new_lead "Concurrency replay $1" "'+33 1 99 00 20 04'")
  req=$(as_owner "select gen_random_uuid();")
  local call=${2//:lead/$lead}
  call=${call//:req/$req}
  as_admin "begin;
select $call \g /dev/null
select pg_sleep(2) \g /dev/null
commit;" & pa=$!
  sleep 0.5
  out=$(as_admin "select ($call) ->> 'replayed';") || fail "outcome_replay_idempotent ($1): the second session failed"
  wait $pa || fail "outcome_replay_idempotent ($1): the first session failed"
  count=$(as_owner "select count(*) from public.activities where company_id = '$lead' and request_id = '$req';")
  [ "$out" = "true" ] && [ "$count" = "1" ] || fail "outcome_replay_idempotent ($1): replayed '$out', $count entries"
}
replay call "public.log_activity(':lead', 'call', 'connected', null, null, null, null, null, null, ':req')"
replay note "public.log_activity(':lead', 'note', null, 'twice', null, null, null, null, null, ':req')"

# 4. Every call naming a contact takes it before the lead -----------------------------------------------------------
lead4=$(new_lead 'Concurrency lock order' "'+33 1 99 00 20 05'")
contact4=$(as_owner "insert into public.contacts (org_id, company_id, first_name, phone)
                     select org_id, id, 'Queued', '+33 6 39 98 20 05' from public.companies where id = '$lead4' returning id;")
psql "$CONN" -X -q -A -t -v ON_ERROR_STOP=1 -c "begin; select 1 from public.contacts where id = '$contact4' for update;
  select pg_sleep(2); commit;" > /dev/null & ph=$!
sleep 0.4
as_admin "select public.log_activity('$lead4', 'call', 'wrong_number', null, '$contact4', 'contact', null, null,
          'Find the right number') \g /dev/null" > /dev/null 2>"$TMPDIR_OC/wrong.err" & pa=$!
sleep 0.4
as_admin "select public.log_activity('$lead4', 'call', 'no_answer', null, '$contact4') \g /dev/null" \
  > /dev/null 2>"$TMPDIR_OC/other.err" & pb=$!
wait $ph || fail "outcome_contact_lock_order_no_deadlock: the holding session failed"
ra=0; wait $pa || ra=$?
rb=0; wait $pb || rb=$?
[ $ra = 0 ] && [ $rb = 0 ] || fail "outcome_contact_lock_order_no_deadlock: wrong number exit $ra, other call exit $rb: \
$(cat "$TMPDIR_OC/wrong.err" "$TMPDIR_OC/other.err")"
got=$(as_owner "select count(*) || ' ' || (select (phone_wrong_at is not null)::text from public.contacts where id = '$contact4')
                  from public.activities where company_id = '$lead4';")
[ "$got" = "2 true" ] || fail "outcome_contact_lock_order_no_deadlock: entries and mark '$got' (expected '2 true')"

# 5. The insert lock skips callers whose insert is refused ------------------------------------------------------------
lead5=$(new_lead 'Concurrency refused lock' "null")
contact5=$(as_owner "insert into public.contacts (org_id, company_id, first_name)
                     select org_id, id, 'Held' from public.companies where id = '$lead5' returning id;")
other5=$(as_owner "insert into public.companies (org_id, name, lead_status)
                   values ('00000000-0000-0000-0000-0000000000cc', 'Other org lead', 'cold') returning id;")
quick_refusal() {  # $1 label, $2 sub, $3 aal, $4 "table id" held for 3 s (NO KEY UPDATE), $5 the refused insert
  local ph t0 t1 out
  psql "$CONN" -X -q -A -t -v ON_ERROR_STOP=1 -c "begin; select 1 from public.${4% *} where id = '${4#* }' for no key update;
    select pg_sleep(3); commit;" > /dev/null & ph=$!
  sleep 0.4
  t0=$(date +%s%N)
  out=$(as_user "$2" "$3" "$5" 2>&1) && fail "insert_lock_skips_refused_callers ($1): the insert was accepted"
  t1=$(date +%s%N)
  wait $ph || fail "insert_lock_skips_refused_callers ($1): the holding session failed"
  case "$out" in *"row-level security"*) ;; *) fail "insert_lock_skips_refused_callers ($1): unexpected error: $out";; esac
  [ $(( (t1 - t0) / 1000000 )) -lt 1500 ] \
    || fail "insert_lock_skips_refused_callers ($1): the refusal took $(( (t1 - t0) / 1000000 )) ms (it waited for a lock)"
}
quick_refusal 'no two-factor' "$ADMIN" aal1 "companies $lead5" \
  "insert into public.activities (company_id, type, body) values ('$lead5', 'note', 'locked?');"
quick_refusal 'a lead of another organisation' 00000000-0000-0000-0000-0000000000c1 aal2 "companies $lead5" \
  "insert into public.activities (company_id, type, body) values ('$lead5', 'note', 'locked?');"
quick_refusal "a contact of another organisation" 00000000-0000-0000-0000-0000000000c1 aal2 "contacts $contact5" \
  "insert into public.activities (company_id, contact_id, type, body) values ('$other5', '$contact5', 'note', 'locked?');"

echo 'outcome_concurrency: all checks passed'
