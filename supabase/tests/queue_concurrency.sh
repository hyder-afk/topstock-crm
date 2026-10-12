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
#     contact C2's number and then changes C1 (contact C2, then the lead through the trigger, then C1); both finish
#     (a deadlock would fail the run), C1's new number has no mark, and the lead's flag matches its contacts.
# (No "set deadlock_timeout": it needs a superuser, which the CI image's postgres role may not be; the default 1 s only
# makes a deadlock take a little longer to show.)
#  8. claim_cap_two_tabs: one person's two tabs claim at the same time; together they never hold more than 3 claims
#     (the claim guard's per-person lock makes the second tab wait and then see the first tab's claims).
#  9. second_look: a lead a teammate claims, calls and lets go while this session's claim waits (its candidates read
#     before) is let go again instead of served (claim_next_lead looks at the lead again after winning the claim). The
#     wait is on a claim row being written by a session that holds no lead lock (the superuser), since a claim taken
#     through the functions holds its lead's lock and the walk skips it instead of waiting.
# 10. lock_order_contact_then_lead: a teammate's transaction holds contact C (a name change), then changes the lead; a
#     wrong number on C waits for C before it takes the lead, so neither deadlocks (Day 4b's mutation reversing
#     log_activity's lock order is caught here).
# 11. crossing_orders_no_deadlock: two admins each have a due call task on a different Negotiation lead, so their queues
#     meet the same two leads in opposite orders (each one's follow-up first). Both press Start (two cards) at the same
#     instant, 20 rounds: nobody fails (before the lead locks, one of the two died with "deadlock detected" in almost
#     every round), each gets their own follow-up first, and no lead is held twice. A third case session then holds
#     the lead lock of a lead (a claim being taken) and a Start skips that lead at once instead of waiting.
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

# 8. One person in two tabs cannot pass 3 live claims ------------------------------------------------------------------
as_owner "delete from private.queue_claims where user_id = '$W2';" > /dev/null
l81=$(new_lead 'Race tab 1' warm null "'+33 1 99 00 50 81'")
l82=$(new_lead 'Race tab 2' warm null "'+33 1 99 00 50 82'")
l83=$(new_lead 'Race tab 3' warm null "'+33 1 99 00 50 83'")
l84=$(new_lead 'Race tab 4' warm null "'+33 1 99 00 50 84'")
as_user "$W2" "begin;
select public.claim_lead('$l81') \g /dev/null
select public.claim_lead('$l82') \g /dev/null
select pg_sleep(2) \g /dev/null
commit;" & pa=$!
sleep 0.5
if as_user "$W2" "select public.claim_lead('$l83') \g /dev/null
select public.claim_lead('$l84') \g /dev/null" 2> "$TMPDIR_QC/tab.err"; then
  fail "claim_cap_two_tabs: the second tab took a fourth claim"
fi
grep -q 'busy' "$TMPDIR_QC/tab.err" || fail "claim_cap_two_tabs: the second tab failed for another reason: $(cat "$TMPDIR_QC/tab.err")"
wait $pa || fail "claim_cap_two_tabs: the first tab failed"
got=$(as_owner "select count(*) from private.queue_claims where user_id = '$W2' and expires_at > now();")
[ "$got" = "3" ] || fail "claim_cap_two_tabs: $got live claims (expected 3)"

# 9. A lead a teammate called while this claim waited is not served -------------------------------------------------
# Yul's queue holds X then L. An open transaction writes a claim on X (without the lead's lock, as the superuser), so
# Yul's claim_next_lead (two cards) reads both candidates and waits on X; meanwhile Wyn claims L, calls it (no answer:
# back the next working day) and lets it go. When that transaction rolls back, Yul gets X, then claims L: the second
# look sees Wyn's call, and L is let go instead of served.
as_owner "delete from private.queue_claims where user_id in ('$W1', '$W2', '$W3');" > /dev/null
l9x=$(as_owner "insert into public.companies (org_id, name, owner_id, lead_status, phone, country, next_action_at)
                select id, 'Race second look X', '$W3', 'negotiation', '+33 1 99 00 50 91', 'FR', now() - interval '3000 days'
                  from public.orgs where name = 'TopStock Wholesale' returning id;")
l9l=$(as_owner "insert into public.companies (org_id, name, owner_id, lead_status, phone, country, next_action_at)
                select id, 'Race second look L', '$W3', 'negotiation', '+33 1 99 00 50 92', 'FR', now() - interval '2999 days'
                  from public.orgs where name = 'TopStock Wholesale' returning id;")
psql "$CONN" -X -q -A -t -v ON_ERROR_STOP=1 > /dev/null <<SQL & pc=$!
begin;
insert into private.queue_claims (company_id, org_id, user_id, expires_at)
select id, org_id, '$W2', now() + interval '10 minutes' from public.companies where id = '$l9x';
select pg_sleep(3) \g /dev/null
rollback;
SQL
sleep 0.5
as_user "$W3" "select string_agg(c ->> 'id', ',') from jsonb_array_elements(
                 public.claim_next_lead('mine', '{}'::uuid[], '{}', 2, true) -> 'cards') c;" > "$TMPDIR_QC/second.out" & pb=$!
sleep 0.5
as_user "$W1" "select public.claim_lead('$l9l') \g /dev/null" > /dev/null
as_user "$W1" "select public.log_activity('$l9l', 'call', 'no_answer', p_from_queue => true) \g /dev/null" > /dev/null
wait $pc || fail "second_look: the holding session failed"
wait $pb || fail "second_look: the queue session failed"
got=$(cat "$TMPDIR_QC/second.out")
[ "$got" = "$l9x" ] || fail "second_look: the queue served '$got' (expected only X; L was just called by a teammate)"
got=$(as_owner "select count(*) from private.queue_claims where company_id = '$l9l';")
[ "$got" = "0" ] || fail "second_look: L kept a claim"

# 10. Lock order contact, then lead, with the contact trigger in place --------------------------------------------------
# A teammate's transaction takes contact C (a name change: the contact trigger does not fire), then changes the lead. A
# wrong number on C must wait for C before it takes the lead; if it took the lead first, the teammate would wait for the
# lead while the call waits for C (a deadlock). Day 4b's case 2 used a number change, which now takes the lead at once
# through the contact trigger, so it no longer tells the two orders apart.
lead10=$(new_lead 'Race lock order' cold null "'+33 1 99 00 51 01'")
c10=$(as_owner "insert into public.contacts (org_id, company_id, first_name, phone)
                select org_id, id, 'Elio', '+33 6 39 98 51 01' from public.companies where id = '$lead10' returning id;")
as_user "$W2" "begin;
update public.contacts set first_name = 'Elio2' where id = '$c10';
select pg_sleep(1.5) \g /dev/null
update public.companies set name = 'Race lock order renamed' where id = '$lead10';
commit;" > /dev/null 2> "$TMPDIR_QC/order-edit.err" & pa=$!
sleep 0.4
as_user "$W1" "select public.log_activity('$lead10', 'call', 'wrong_number', null, '$c10', 'contact', null, null,
               'Find the right number') \g /dev/null" > /dev/null 2> "$TMPDIR_QC/order-call.err" & pb=$!
ra=0; wait $pa || ra=$?
rb=0; wait $pb || rb=$?
[ $ra = 0 ] && [ $rb = 0 ] || fail "lock_order_contact_then_lead: edit exit $ra, call exit $rb: \
$(cat "$TMPDIR_QC/order-edit.err" "$TMPDIR_QC/order-call.err")"
got=$(as_owner "select c.name || ' ' || (k.phone_wrong_at is not null)::text from public.companies c
                  join public.contacts k on k.id = '$c10' where c.id = '$lead10';")
[ "$got" = "Race lock order renamed true" ] || fail "lock_order_contact_then_lead: '$got'"

# 11. Two admins whose queues meet the same leads in opposite orders --------------------------------------------------
# Wyn's call task is on A, Xan's on B: Wyn walks A then B, Xan B then A (both Negotiation leads due 9,000 days ago, so
# they lead every other part of the queue). A controller session holds an advisory lock that both wait on, then lets
# go, so both claim_next_lead calls (two cards, one statement each) start within a millisecond or so.
as_owner "delete from private.queue_claims;" > /dev/null
l11a=$(as_owner "insert into public.companies (org_id, name, owner_id, lead_status, phone, country, next_action_at)
                 select id, 'Race cross A', '$W3', 'negotiation', '+33 1 99 00 51 11', 'FR', now() - interval '9000 days'
                   from public.orgs where name = 'TopStock Wholesale' returning id;")
l11b=$(as_owner "insert into public.companies (org_id, name, owner_id, lead_status, phone, country, next_action_at)
                 select id, 'Race cross B', '$W3', 'negotiation', '+33 1 99 00 51 12', 'FR', now() - interval '9000 days'
                   from public.orgs where name = 'TopStock Wholesale' returning id;")
as_owner "insert into public.tasks (org_id, company_id, title, kind, due_date, assignee_id, created_by)
          select c.org_id, c.id, 'Race cross call', 'call', current_date - 1, x.who, x.who
            from public.companies c join (values ('$l11a'::uuid, '$W1'::uuid), ('$l11b'::uuid, '$W2'::uuid)) x(lead, who)
              on x.lead = c.id;" > /dev/null
starter() {
  psql "$CONN" -X -q -A -t -v ON_ERROR_STOP=1 <<SQL > "$TMPDIR_QC/x$2.out" 2> "$TMPDIR_QC/x$2.err"
set role authenticated;
select set_config('request.jwt.claims', '{"sub":"$1","role":"authenticated","aal":"aal2"}', false) \g /dev/null
select (select string_agg(c ->> 'id', ',') from jsonb_array_elements(r -> 'cards') c)
  from (select pg_advisory_xact_lock_shared(911011), public.claim_next_lead('team', null, '{}', 2, true) as r) s;
SQL
}
for round in $(seq 1 20); do
  as_owner "delete from private.queue_claims;" > /dev/null
  psql "$CONN" -X -q -A -t -v ON_ERROR_STOP=1 > /dev/null <<SQL & pg=$!
begin;
select pg_advisory_xact_lock(911011) \g /dev/null
select pg_sleep(0.6) \g /dev/null
commit;
SQL
  sleep 0.3
  starter "$W1" 1 & s1=$!
  starter "$W2" 2 & s2=$!
  r1=0; wait $s1 || r1=$?
  r2=0; wait $s2 || r2=$?
  wait $pg || fail "crossing_orders_no_deadlock: the controller failed"
  [ $r1 = 0 ] && [ $r2 = 0 ] || fail "crossing_orders_no_deadlock: round $round: Wyn exit $r1, Xan exit $r2: \
$(cat "$TMPDIR_QC/x1.err" "$TMPDIR_QC/x2.err")"
  first1=$(cut -d, -f1 "$TMPDIR_QC/x1.out"); first2=$(cut -d, -f1 "$TMPDIR_QC/x2.out")
  [ "$first1" = "$l11a" ] && [ "$first2" = "$l11b" ] || fail "crossing_orders_no_deadlock: round $round: first cards \
'$first1' / '$first2' (expected each one's own follow-up)"
  dup=$(tr ',' '\n' < "$TMPDIR_QC/x1.out" | cat - <(tr ',' '\n' < "$TMPDIR_QC/x2.out") | grep -c . || true)
  uniq_n=$(tr ',' '\n' < "$TMPDIR_QC/x1.out" | cat - <(tr ',' '\n' < "$TMPDIR_QC/x2.out") | grep . | sort -u | wc -l)
  [ "$dup" = "$uniq_n" ] || fail "crossing_orders_no_deadlock: round $round: a lead was served to both"
done
# A lead whose lock is held (a claim being taken elsewhere) is skipped at once, never waited for.
as_owner "delete from private.queue_claims;" > /dev/null
psql "$CONN" -X -q -A -t -v ON_ERROR_STOP=1 > /dev/null <<SQL & ph=$!
begin;
select pg_advisory_xact_lock(hashtextextended('queue_claim:' || '$l11a', 0)) \g /dev/null
select pg_sleep(2) \g /dev/null
commit;
SQL
sleep 0.4
start=$(date +%s%N)
got=$(as_user "$W1" "select (select string_agg(c ->> 'id', ',') from jsonb_array_elements(r -> 'cards') c)
                     from (select public.claim_next_lead('team', null, '{}', 1, true) as r) s;")
took=$(( ($(date +%s%N) - start) / 1000000 ))
wait $ph || fail "crossing_orders_no_deadlock: the holding session failed"
[ "$took" -lt 1000 ] || fail "crossing_orders_no_deadlock: Start waited ${took} ms for a lead being claimed"
[ -n "$got" ] && [ "$got" != "$l11a" ] || fail "crossing_orders_no_deadlock: Start served '$got' (expected another lead)"
as_owner "update public.companies set lead_status = 'disqualified' where id in ('$l11a', '$l11b');
          update public.tasks set cancelled_at = now() where title = 'Race cross call';" > /dev/null

as_owner "delete from private.queue_claims;" > /dev/null
echo "queue_concurrency: all checks passed"
