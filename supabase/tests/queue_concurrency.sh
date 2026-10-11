#!/bin/bash
# Day 4c work queue under concurrency (design sections 5.4 and 8.2, threat 14 and the lock order): several database
# sessions at once, three admins (Wyn, Xan, Yul) made here.
#  1. three_workers_distinct: three sessions work the team queue at the same time, 40 rounds each, on 120 leads that
#     sit at the head of the queue: each round claims the next lead (claim_next_lead, committed), then logs "no answer"
#     from the queue (log_activity, which releases the claim; the lead is back the next working day). No lead is served
#     twice, every one of the 120 is served once, and nothing deadlocks with log_activity's lock order.
#  2. claim_race_one_winner: one session claims a lead and holds its transaction 2 seconds; a second session claiming
#     the same lead waits for it, then gets false (one claim, the first session's).
#  3. expired_claim_taken_over_once: a lead with an expired claim; two sessions take it over at once: one wins.
#  4. fresh_claim_not_stolen: a live claim held by a teammate: claim_lead answers false at once.
#  5. claim_does_not_wait_for_the_lead: a call being logged holds the lead's row lock for 2 seconds; claiming that lead
#     meanwhile answers at once (nothing in the queue locks a lead, so serving never blocks editing).
#  6. contact_flag_two_edits_at_once: two sessions each remove the number of a different contact of the same lead (no
#     main number). The contact trigger locks the lead before it looks, so the second sees the first: the lead ends with
#     no contact number and no rank. Without the lock both would miss each other and the lead would keep a rank.
#  7. outcome_vs_contact_edit_no_deadlock: a wrong number on contact C1 (contact, then lead) while a teammate removes
#     contact C2's number and then changes C1 (contact C2, then the lead through the trigger, then C1);
#     deadlock_timeout 200 ms; both finish, C1's new number has no mark, and the lead's flag matches its contacts.
# Usage: queue_concurrency.sh "<libpq connection string>" (after queue_attack.sql). Used by scripts/db-test.sh and the
# CI "rls" job. Fixtures are made by the superuser connection; the probes run as the admins through the API role.
set -euo pipefail
CONN="${1:?connection string}"
W1=00000000-0000-0000-0000-0000000000e2
W2=00000000-0000-0000-0000-0000000000e3
W3=00000000-0000-0000-0000-0000000000e4

# Runs SQL as a user with two-factor (claims set the way Supabase does). -A -t: bare values.
as_user() {
  psql "$CONN" -X -q -A -t -v ON_ERROR_STOP=1 <<SQL
set role authenticated;
select set_config('request.jwt.claims', '{"sub":"$1","role":"authenticated","aal":"aal2"}', false) \g /dev/null
$2
SQL
}
as_owner() { psql "$CONN" -X -q -A -t -v ON_ERROR_STOP=1 -c "$1"; }
fail() { echo "FAIL: $*" >&2; exit 1; }
TMPDIR_QC=$(mktemp -d)
trap 'rm -rf "$TMPDIR_QC"' EXIT

as_owner "insert into auth.users (id, email, raw_user_meta_data) values
            ('$W1', 'wyn@test.invalid', '{\"first_name\":\"Wyn\"}'), ('$W2', 'xan@test.invalid', '{\"first_name\":\"Xan\"}'),
            ('$W3', 'yul@test.invalid', '{\"first_name\":\"Yul\"}');
          update public.profiles set role = 'admin' where id in ('$W1', '$W2', '$W3');" > /dev/null
# A lead owned by Wyn, made by the superuser: $1 name, $2 status, $3 next call (SQL), $4 phone (SQL).
new_lead() {
  as_owner "insert into public.companies (org_id, name, owner_id, lead_status, phone, country, next_action_at)
            select id, '$1', '$W1', '$2', $4, 'FR', $3 from public.orgs where name = 'TopStock Wholesale' returning id;"
}

# 1. Three workers, one team queue ----------------------------------------------------------------------------------
# 120 Negotiation leads due 1,000 days ago or more: ahead of every lead the earlier test files left in the queue.
as_owner "insert into public.companies (org_id, name, owner_id, lead_status, phone, country, next_action_at)
          select o.id, 'Race lead ' || g, '$W1', 'negotiation', '+33 1 99 00 50 01', 'FR', now() - make_interval(days => 1000 + g)
            from public.orgs o, generate_series(1, 120) g where o.name = 'TopStock Wholesale';" > /dev/null
worker() {
  psql "$CONN" -X -q -A -t -v ON_ERROR_STOP=1 <<SQL 2> "$TMPDIR_QC/w$2.err" > "$TMPDIR_QC/w$2.out"
set deadlock_timeout = '200ms';
set role authenticated;
select set_config('request.jwt.claims', '{"sub":"$1","role":"authenticated","aal":"aal2"}', false) \g /dev/null
do \$\$
declare
  r jsonb;
  lead uuid;
begin
  for n in 1..40 loop
    r := public.claim_next_lead('team', '{}'::uuid[], '{}', 1, true);
    lead := (r -> 'cards' -> 0 ->> 'id')::uuid;
    exit when lead is null;
    commit;
    raise notice 'served %', lead;
    perform public.log_activity(lead, 'call', 'no_answer', p_from_queue => true);
    commit;
  end loop;
end \$\$;
SQL
}
worker "$W1" 1 & p1=$!
worker "$W2" 2 & p2=$!
worker "$W3" 3 & p3=$!
wait $p1 || fail "three_workers_distinct: worker 1 failed: $(cat "$TMPDIR_QC/w1.err")"
wait $p2 || fail "three_workers_distinct: worker 2 failed: $(cat "$TMPDIR_QC/w2.err")"
wait $p3 || fail "three_workers_distinct: worker 3 failed: $(cat "$TMPDIR_QC/w3.err")"
grep -ho 'served [0-9a-f-]*' "$TMPDIR_QC"/w*.err | sort > "$TMPDIR_QC/served"
total=$(wc -l < "$TMPDIR_QC/served")
twice=$(uniq -d "$TMPDIR_QC/served" | wc -l)
[ "$twice" -eq 0 ] || fail "three_workers_distinct: $twice leads were served twice"
[ "$total" -eq 120 ] || fail "three_workers_distinct: $total rounds served (expected 120)"
for w in 1 2 3; do
  n=$(grep -c 'served' "$TMPDIR_QC/w$w.err" || true)
  [ "$n" -ge 1 ] || fail "three_workers_distinct: worker $w served nothing (no real race)"
done
got=$(as_owner "select count(*) filter (where c.name like 'Race lead %' and c.next_action_at > now()) || ' '
                       || (select count(*) from public.activities a join public.companies k on k.id = a.company_id
                            where k.name like 'Race lead %') || ' '
                       || (select count(*) from private.queue_claims q join public.companies k on k.id = q.company_id
                            where k.name like 'Race lead %')
                  from public.companies c;")
[ "$got" = "120 120 0" ] || fail "three_workers_distinct: leads moved / entries / claims left = '$got' (expected '120 120 0')"

# 2. Two sessions claim one lead -------------------------------------------------------------------------------------
lead2=$(new_lead 'Race one winner' warm null "'+33 1 99 00 50 02'")
as_user "$W1" "begin;
select public.claim_lead('$lead2') \g /dev/null
select pg_sleep(2) \g /dev/null
commit;" & pa=$!
sleep 0.5
start=$(date +%s%N)
second=$(as_user "$W2" "select public.claim_lead('$lead2');")
waited=$(( ($(date +%s%N) - start) / 1000000 ))
wait $pa || fail "claim_race_one_winner: the first session failed"
[ "$second" = "f" ] || fail "claim_race_one_winner: the second session got '$second' (expected f)"
[ "$waited" -ge 800 ] || fail "claim_race_one_winner: the second session did not wait (${waited} ms): no real race"
got=$(as_owner "select string_agg(user_id::text, ',') from private.queue_claims where company_id = '$lead2';")
[ "$got" = "$W1" ] || fail "claim_race_one_winner: claims on the lead: '$got'"

# 3. An expired claim taken over by two sessions at once --------------------------------------------------------------
lead3=$(new_lead 'Race expired claim' warm null "'+33 1 99 00 50 03'")
as_owner "insert into private.queue_claims (company_id, org_id, user_id, expires_at)
          select id, org_id, '$W3', now() - interval '1 minute' from public.companies where id = '$lead3';" > /dev/null
as_user "$W1" "begin;
select public.claim_lead('$lead3') \g /dev/null
select pg_sleep(2) \g /dev/null
commit;" & pa=$!
sleep 0.5
second=$(as_user "$W2" "select public.claim_lead('$lead3');")
wait $pa || fail "expired_claim_taken_over_once: the first session failed"
[ "$second" = "f" ] || fail "expired_claim_taken_over_once: the second session got '$second' (expected f)"
got=$(as_owner "select string_agg(user_id::text, ',') from private.queue_claims where company_id = '$lead3';")
[ "$got" = "$W1" ] || fail "expired_claim_taken_over_once: claims on the lead: '$got'"

# 4. A live claim is not taken over ----------------------------------------------------------------------------------
got=$(as_user "$W3" "select public.claim_lead('$lead2');")
[ "$got" = "f" ] || fail "fresh_claim_not_stolen: got '$got'"

# 5. Claiming never waits for a lead being edited --------------------------------------------------------------------
lead5=$(new_lead 'Race lead lock' cold null "'+33 1 99 00 50 05'")
as_user "$W1" "begin;
select public.log_activity('$lead5', 'call', 'no_answer') \g /dev/null
select pg_sleep(2) \g /dev/null
commit;" & pa=$!
sleep 0.5
start=$(date +%s%N)
got=$(as_user "$W2" "select public.claim_lead('$lead5');")
took=$(( ($(date +%s%N) - start) / 1000000 ))
wait $pa || fail "claim_does_not_wait_for_the_lead: the call failed"
[ "$got" = "t" ] || fail "claim_does_not_wait_for_the_lead: got '$got'"
[ "$took" -lt 1000 ] || fail "claim_does_not_wait_for_the_lead: the claim waited ${took} ms for the lead"

# 6. Two contacts' numbers removed at once ---------------------------------------------------------------------------
lead6=$(new_lead 'Race contact flag' cold null null)
c61=$(as_owner "insert into public.contacts (org_id, company_id, first_name, phone)
                select org_id, id, 'Ana', '+33 6 39 98 50 61' from public.companies where id = '$lead6' returning id;")
c62=$(as_owner "insert into public.contacts (org_id, company_id, first_name, phone)
                select org_id, id, 'Ben', '+33 6 39 98 50 62' from public.companies where id = '$lead6' returning id;")
got=$(as_owner "select has_contact_phone || ' ' || coalesce(queue_rank::text, '-') from public.companies where id = '$lead6';")
[ "$got" = "true 3" ] || fail "contact_flag_two_edits_at_once: fixture '$got'"
as_user "$W1" "begin;
update public.contacts set phone = null where id = '$c61';
select pg_sleep(2) \g /dev/null
commit;" & pa=$!
sleep 0.5
as_user "$W2" "update public.contacts set phone = null where id = '$c62';" > /dev/null || fail "contact_flag_two_edits_at_once: second edit failed"
wait $pa || fail "contact_flag_two_edits_at_once: the first edit failed"
got=$(as_owner "select has_contact_phone || ' ' || coalesce(queue_rank::text, '-') from public.companies where id = '$lead6';")
[ "$got" = "false -" ] || fail "contact_flag_two_edits_at_once: the lead says '$got' (expected 'false -': no number left)"

# 7. A wrong number on a contact against a teammate's contact edits: no deadlock --------------------------------------
lead7=$(new_lead 'Race outcome contacts' cold null null)
c71=$(as_owner "insert into public.contacts (org_id, company_id, first_name, phone)
                select org_id, id, 'Cleo', '+33 6 39 98 50 71' from public.companies where id = '$lead7' returning id;")
c72=$(as_owner "insert into public.contacts (org_id, company_id, first_name, phone)
                select org_id, id, 'Dino', '+33 6 39 98 50 72' from public.companies where id = '$lead7' returning id;")
psql "$CONN" -X -q -A -t -v ON_ERROR_STOP=1 > /dev/null <<SQL & pa=$!
set deadlock_timeout = '200ms';
set role authenticated;
select set_config('request.jwt.claims', '{"sub":"$W1","role":"authenticated","aal":"aal2"}', false) \g /dev/null
begin;
select public.claim_lead('$lead7') \g /dev/null
select public.log_activity('$lead7', 'call', 'wrong_number', null, '$c71', 'contact', null, null, 'Find the right number',
                           gen_random_uuid(), true) \g /dev/null
select pg_sleep(2) \g /dev/null
commit;
SQL
sleep 0.5
psql "$CONN" -X -q -A -t -v ON_ERROR_STOP=1 > /dev/null <<SQL || fail "outcome_vs_contact_edit_no_deadlock: the contact edits failed"
set deadlock_timeout = '200ms';
set role authenticated;
select set_config('request.jwt.claims', '{"sub":"$W2","role":"authenticated","aal":"aal2"}', false) \g /dev/null
begin;
update public.contacts set phone = null where id = '$c72';
update public.contacts set phone = '+33 6 39 98 50 73' where id = '$c71';
commit;
SQL
wait $pa || fail "outcome_vs_contact_edit_no_deadlock: the outcome failed"
got=$(as_owner "select (k.phone_wrong_at is null)::text || ' ' || c.has_contact_phone || ' ' || coalesce(c.queue_rank::text, '-') || ' '
                       || (select count(*) from private.queue_claims q where q.company_id = c.id)
                  from public.companies c join public.contacts k on k.id = '$c71' where c.id = '$lead7';")
[ "$got" = "true true 3 0" ] || fail "outcome_vs_contact_edit_no_deadlock: '$got' (expected 'true true 3 0')"
bad=$(as_owner "select count(*) from public.companies c
                 where c.has_contact_phone is distinct from exists (select 1 from public.contacts k
                        where k.company_id = c.id and k.phone ~ '[0-9]' and k.phone_wrong_at is null);")
[ "$bad" = "0" ] || fail "has_contact_phone_consistent after the races: $bad leads"

as_owner "delete from private.queue_claims;" > /dev/null
echo "queue_concurrency: all checks passed"
