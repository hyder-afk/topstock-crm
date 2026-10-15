#!/bin/bash
# Day 5a deals under concurrency (design sections 5.2, 5.7 and 8.2 part 1; threats 11 and 13): two or three database
# sessions at once. Each holding session keeps its transaction open for 1 to 2 seconds while the other starts.
#  1. two_movers_one_conflict: A moves a deal and holds; B moves it from the same version: B waits for the row lock,
#     then gets a conflict result (no error), the deal is where A put it, history has one row for the two attempts.
#  2. win_vs_lose_one_closes: A wins, B loses the same deal at once: one closes it (won), the other is a conflict.
#  3. move_vs_update_value_one_conflict: A changes the value and holds; B's move from the old version is a conflict.
#  4. undo_vs_colleague_move_conflict: A moves (version 1); B moves it on and holds; A's Undo waits, then is a
#     conflict: the colleague's change is never undone.
#  5. open_deal_replay_parallel_once: the same open request twice at once gives one deal (the second waits for the
#     lead's lock, then finds the first).
#  6. move_replay_parallel_once: the same move request twice at once gives one history row (the second waits for the
#     deal's lock, sees the version moved, then finds the first move's record).
#  7. two_people_open_deal_same_lead: two people open deals on one lead at once: serialised by the lead lock, 2 deals,
#     2 open rows, the second answer counts 2 open deals.
#  8. move_not_blocked_by_activity_fk: an entry naming the deal is being saved (its foreign key check holds the deal FOR
#     KEY SHARE) while a move and a value change run: both go through at once (lock_timeout 1 s), because they lock the
#     deal FOR NO KEY UPDATE (spike S8; 5b's log_activity with a deal relies on it). A delete would wait.
#  9. history_chain_consistent: 3 sessions x 100 random stage changes over 20 deals (owner, manager and admin), each in
#     its own transaction, deadlock_timeout 200 ms: no deadlock and no error other than the rules' own refusals (a
#     conflict, or "unchanged" when a colleague just moved the deal to that stage, are results); history
#     rows = successful moves + 20 opens; versions strictly increase; status follows the stage. With "p10" as the second
#     argument only this case runs, timed (perf P10: p95 per move, on the perf seed's database).
# 10. fresh_session_move_with_request_id: a move that does not touch the lead, sent with a request id, as the first
#     move_deal call of a new connection (Lead -> Qualified, back, and a reopen of a won deal) answers "moved".
# Part 2 (Day 5b, migration 20261015120000_deal_links.sql; design 5.7 and 8.2 "5b"; threat 12). Global lock order
# contact, lead, deal: an entry naming a deal takes the deal FOR KEY SHARE (its foreign key) after the lead.
# 11. move_vs_log_activity_with_deal_no_deadlock: (a) a move that touches the lead waits for a call naming the deal that
#     holds the lead, then goes through; (b) a move that does not touch the lead holds the deal FOR NO KEY UPDATE and a
#     call naming the deal goes through at once (lock_timeout 500 ms).
# 12. undo_activity_vs_log_activity_with_deal_no_deadlock: an Undo of the call that opened a deal waits for the lead,
#     held by a colleague's note naming that deal; then removes the untouched deal (the note keeps, with no deal).
#     Deleting the deal before the lead lock deadlocks here (mutation 5b-3).
# 13. delete_deal_vs_log_activity_with_deal_no_deadlock: an admin's delete waits for the lead held by a call naming the
#     deal, then deletes it; the entry keeps, with no deal.
# 14. undo_activity_vs_move_same_lead_no_deadlock: a colleague moves the deal to Negotiations (lead, then deal) and
#     holds; the Undo of the call that opened it waits for the lead, then keeps the moved deal and leaves the lead as the
#     colleague's move set it.
# Usage: deal_concurrency.sh "<libpq connection string>" [p10]  (after deals_attack.sql). Used by scripts/db-test.sh, the
# CI "rls" job and (p10) scripts/db-perf.sh. Fixtures are made by the superuser; the probes run through the API role.
set -euo pipefail
CONN="${1:?connection string}"
MODE="${2:-all}"
ADMIN=00000000-0000-0000-0000-00000000000a
R1=00000000-0000-0000-0000-0000000005a1
M1=00000000-0000-0000-0000-0000000005b1
TMP_DC=$(mktemp -d)
trap 'rm -rf "$TMP_DC"' EXIT
fail() { echo "FAIL: $*" >&2; exit 1; }

# Runs SQL as a user with two-factor and a code entered just now: $1 sub, $2 SQL. -A -t: bare values.
as_user() {
  psql "$CONN" -X -q -A -t -v ON_ERROR_STOP=1 <<SQL
set deadlock_timeout = '200ms';
set role authenticated;
select set_config('request.jwt.claims', '{"sub":"$1","role":"authenticated","aal":"aal2","amr":[{"method":"totp","timestamp":$(date +%s)}]}', false) \g /dev/null
$2
SQL
}
as_owner() { psql "$CONN" -X -q -A -t -v ON_ERROR_STOP=1 -c "$1"; }

# Fixtures: the fixture users must exist (deals_attack.sql makes r1 and m1; the perf seed makes them too).
[ "$(as_owner "select count(*) from public.profiles where id in ('$ADMIN', '$R1', '$M1');")" = "3" ] \
  || fail "fixture users missing (run after deals_attack.sql)"
new_lead() {
  as_owner "insert into public.companies (org_id, name, owner_id, lead_status, country)
            select id, '$1', '$R1', 'warm', 'FR' from public.orgs where name = 'TopStock Wholesale' returning id;"
}
# A deal of r1's on a lead, made through open_deal as r1 (so its history starts with the open row).
new_deal() {
  as_user "$R1" "select public.open_deal('$1', '$2') -> 'deal' ->> 'id';"
}
version() { as_owner "select version from public.deals where id = '$1';"; }
stage() { as_owner "select s.key from public.deals d join public.pipeline_stages s on s.id = d.stage_id where d.id = '$1';"; }
moves() { as_owner "select count(*) from public.deal_stage_history where deal_id = '$1' and kind <> 'open';"; }

if [ "$MODE" = "all" ]; then
# 1. Two movers, one conflict ------------------------------------------------------------------------------------------
lead=$(new_lead 'Concurrency movers')
deal=$(new_deal "$lead" 'Two movers')
as_user "$ADMIN" "begin;
select public.move_deal('$deal', 'qualified', 0) \g /dev/null
select pg_sleep(1) \g /dev/null
commit;" & pa=$!
sleep 0.4
out=$(as_user "$M1" "select (r ->> 'result') || ' ' || (r -> 'deal' ->> 'stage') || ' ' || (r ->> 'changed_by_first_name')
                     from public.move_deal('$deal', 'negotiations', 0) r;") || fail "two_movers_one_conflict: B failed"
wait $pa || fail "two_movers_one_conflict: A failed"
[ "$out" = "conflict qualified Ada" ] && [ "$(stage "$deal")" = "qualified" ] && [ "$(version "$deal")" = "1" ] \
  && [ "$(moves "$deal")" = "1" ] || fail "two_movers_one_conflict: B '$out', stage $(stage "$deal"), $(moves "$deal") moves"

# 2. Win against lose ---------------------------------------------------------------------------------------------------
lead=$(new_lead 'Concurrency win lose')
deal=$(new_deal "$lead" 'Win or lose')
as_user "$ADMIN" "begin;
select public.move_deal('$deal', 'won', 0, 900, 'from_stock') \g /dev/null
select pg_sleep(1) \g /dev/null
commit;" & pa=$!
sleep 0.4
out=$(as_user "$M1" "select public.move_deal('$deal', 'lost', 0, p_lost_reason => 'price') ->> 'result';") \
  || fail "win_vs_lose_one_closes: the loser failed"
wait $pa || fail "win_vs_lose_one_closes: the winner failed"
got=$(as_owner "select status || ' ' || value || ' ' || coalesce(lost_reason, '-') from public.deals where id = '$deal';")
[ "$out" = "conflict" ] && [ "$got" = "won 900.00 -" ] && [ "$(moves "$deal")" = "1" ] \
  || fail "win_vs_lose_one_closes: second '$out', deal '$got'"

# 3. A value change against a move --------------------------------------------------------------------------------------
lead=$(new_lead 'Concurrency value')
deal=$(new_deal "$lead" 'Value or move')
as_user "$ADMIN" "begin;
select public.update_deal('$deal', 0, '{value}', p_value => 4200) \g /dev/null
select pg_sleep(1) \g /dev/null
commit;" & pa=$!
sleep 0.4
out=$(as_user "$M1" "select public.move_deal('$deal', 'qualified', 0) ->> 'result';") \
  || fail "move_vs_update_value_one_conflict: the mover failed"
wait $pa || fail "move_vs_update_value_one_conflict: the editor failed"
[ "$out" = "conflict" ] && [ "$(stage "$deal")" = "lead" ] && [ "$(as_owner "select value from public.deals where id = '$deal';")" = "4200.00" ] \
  || fail "move_vs_update_value_one_conflict: mover '$out'"

# 4. An undo against a colleague's move ---------------------------------------------------------------------------------
lead=$(new_lead 'Concurrency undo')
deal=$(new_deal "$lead" 'Undo or move')
hid=$(as_user "$ADMIN" "select public.move_deal('$deal', 'qualified', 0) ->> 'history_id';")
as_user "$M1" "begin;
select public.move_deal('$deal', 'negotiations', 1) \g /dev/null
select pg_sleep(1) \g /dev/null
commit;" & pa=$!
sleep 0.4
out=$(as_user "$ADMIN" "select public.move_deal('$deal', 'lead', 1, p_undo_of => $hid) ->> 'result';") \
  || fail "undo_vs_colleague_move_conflict: the undo failed"
wait $pa || fail "undo_vs_colleague_move_conflict: the colleague failed"
[ "$out" = "conflict" ] && [ "$(stage "$deal")" = "negotiations" ] \
  && [ "$(as_owner "select count(*) from public.deal_stage_history where deal_id = '$deal' and kind = 'undo';")" = "0" ] \
  || fail "undo_vs_colleague_move_conflict: undo '$out', stage $(stage "$deal")"

# 5. The same open request twice at once ---------------------------------------------------------------------------------
lead=$(new_lead 'Concurrency open replay')
req=$(as_owner "select gen_random_uuid();")
as_user "$R1" "begin;
select public.open_deal('$lead', 'Once', p_request_id => '$req') \g /dev/null
select pg_sleep(1) \g /dev/null
commit;" & pa=$!
sleep 0.4
out=$(as_user "$R1" "select public.open_deal('$lead', 'Once', p_request_id => '$req') ->> 'replayed';") \
  || fail "open_deal_replay_parallel_once: the second failed"
wait $pa || fail "open_deal_replay_parallel_once: the first failed"
[ "$out" = "true" ] && [ "$(as_owner "select count(*) from public.deals where company_id = '$lead';")" = "1" ] \
  || fail "open_deal_replay_parallel_once: replayed '$out'"

# 6. The same move request twice at once ---------------------------------------------------------------------------------
lead=$(new_lead 'Concurrency move replay')
deal=$(new_deal "$lead" 'Move once')
req=$(as_owner "select gen_random_uuid();")
as_user "$R1" "begin;
select public.move_deal('$deal', 'negotiations', 0, p_request_id => '$req') \g /dev/null
select pg_sleep(1) \g /dev/null
commit;" & pa=$!
sleep 0.4
out=$(as_user "$R1" "select public.move_deal('$deal', 'negotiations', 0, p_request_id => '$req') ->> 'replayed';") \
  || fail "move_replay_parallel_once: the second failed"
wait $pa || fail "move_replay_parallel_once: the first failed"
[ "$out" = "true" ] && [ "$(moves "$deal")" = "1" ] || fail "move_replay_parallel_once: replayed '$out', $(moves "$deal") moves"

# 7. Two people open a deal on one lead at once ---------------------------------------------------------------------------
lead=$(new_lead 'Concurrency two opens')
as_user "$ADMIN" "begin;
select public.open_deal('$lead', 'First') \g /dev/null
select pg_sleep(1) \g /dev/null
commit;" & pa=$!
sleep 0.4
out=$(as_user "$M1" "select public.open_deal('$lead', 'Second') ->> 'open_deal_count';") \
  || fail "two_people_open_deal_same_lead: the second failed"
wait $pa || fail "two_people_open_deal_same_lead: the first failed"
[ "$out" = "2" ] && [ "$(as_owner "select count(*) from public.deal_stage_history h join public.deals d on d.id = h.deal_id
                                    where d.company_id = '$lead' and h.kind = 'open';")" = "2" ] \
  || fail "two_people_open_deal_same_lead: second answer counted '$out'"

# 8. A move and a value change are not blocked by an entry's foreign key lock on the deal ------------------------------
lead=$(new_lead 'Concurrency FK lock')
deal=$(new_deal "$lead" 'Not blocked')
psql "$CONN" -X -q -A -t -v ON_ERROR_STOP=1 -c "begin;
  insert into public.activities (org_id, company_id, deal_id, type, body)
  select org_id, company_id, id, 'note', 'held' from public.deals where id = '$deal';
  select pg_sleep(2); rollback;" > /dev/null & pa=$!
sleep 0.5
out=$(as_user "$R1" "set lock_timeout = '1s';
select public.move_deal('$deal', 'qualified', 0) ->> 'result';
select public.update_deal('$deal', 1, '{value}', p_value => 10) ->> 'result';" | tr '\n' ' ') \
  || fail "move_not_blocked_by_activity_fk: the move or the value change waited for the entry's key lock"
out_del=$(psql "$CONN" -X -q -A -t -c "set lock_timeout = '500ms'; begin; delete from public.deals where id = '$deal'; rollback;" 2>&1 || true)
wait $pa || fail "move_not_blocked_by_activity_fk: the entry session failed"
[ "$out" = "moved updated " ] || fail "move_not_blocked_by_activity_fk: '$out'"
case "$out_del" in *"lock timeout"*) ;; *) fail "move_not_blocked_by_activity_fk: a delete should wait for the key lock ('$out_del')";; esac

# 10. fresh_session_move_with_request_id: a move that does not touch the lead, with a request id (5b always sends one),
#     as the first move_deal call of a new connection (a pooled PostgREST connection starts like this). Each as_user is a
#     new session. Lead -> Qualified, Qualified -> Lead, and reopening a won deal into Qualified (with a fresh code).
lead=$(new_lead 'Concurrency fresh session')
deal=$(new_deal "$lead" 'Fresh session')
out=$(as_user "$R1" "select public.move_deal('$deal', 'qualified', 0, p_request_id => gen_random_uuid()) ->> 'result';") \
  || fail "fresh_session_move_with_request_id: Lead -> Qualified failed"
[ "$out" = "moved" ] || fail "fresh_session_move_with_request_id: Lead -> Qualified '$out'"
as_owner "update public.deal_stage_history set created_at = created_at - interval '300 seconds' where deal_id = '$deal';" > /dev/null
out=$(as_user "$R1" "select public.move_deal('$deal', 'lead', 1, p_request_id => gen_random_uuid()) ->> 'result';") \
  || fail "fresh_session_move_with_request_id: Qualified -> Lead failed"
[ "$out" = "moved" ] || fail "fresh_session_move_with_request_id: Qualified -> Lead '$out'"
as_user "$R1" "select public.move_deal('$deal', 'won', 2, 300, 'from_stock') \g /dev/null" > /dev/null
as_owner "update public.deal_stage_history set created_at = created_at - interval '300 seconds' where deal_id = '$deal';" > /dev/null
out=$(as_user "$R1" "select public.move_deal('$deal', 'qualified', 3, p_request_id => gen_random_uuid()) ->> 'result';") \
  || fail "fresh_session_move_with_request_id: reopening Won -> Qualified failed"
[ "$out" = "moved" ] && [ "$(stage "$deal")" = "qualified" ] \
  || fail "fresh_session_move_with_request_id: reopening '$out', stage $(stage "$deal")"

# Part 2 (Day 5b) ---------------------------------------------------------------------------------------------------------
# Part 2 opens its deals as manager m1 (an editor of r1's leads), so r1's 30-an-hour open limit is left to case 9.
new_deal_m1() {
  as_user "$M1" "select public.open_deal('$1', '$2') -> 'deal' ->> 'id';"
}
# An Interested call by m1 on a lead that opens a deal; prints "<activity id> <deal id>".
interested_open() {
  as_user "$M1" "select (r ->> 'activity_id') || ' ' || (r -> 'deal' ->> 'id') from public.log_activity(
    p_company => '$1', p_type => 'call', p_outcome => 'interested', p_follow_up_date => current_date + 1,
    p_task_title => 'Follow up', p_open_deal => true) r;"
}
deadlocked() { grep -q 'deadlock\|40P01' "$@" 2>/dev/null; }

# 11a. A move that touches the lead against a call naming the deal (the call holds the lead first).
lead=$(new_lead 'Concurrency move vs call')
deal=$(new_deal_m1 "$lead" 'Move vs call')
as_user "$ADMIN" "begin;
select 1 from public.companies where id = '$lead' for update \g /dev/null
select pg_sleep(0.8) \g /dev/null
select public.log_activity(p_company => '$lead', p_type => 'call', p_outcome => 'no_answer', p_deal => '$deal') \g /dev/null
commit;" > /dev/null 2> "$TMP_DC/c11a.err" & pa=$!
sleep 0.3
out=$(as_user "$M1" "select public.move_deal('$deal', 'negotiations', 0) ->> 'result';" 2> "$TMP_DC/c11a.b.err") \
  || fail "move_vs_log_activity_with_deal_no_deadlock (a): the move failed: $(cat "$TMP_DC/c11a.b.err")"
wait $pa || fail "move_vs_log_activity_with_deal_no_deadlock (a): the call failed: $(cat "$TMP_DC/c11a.err")"
[ "$out" = "moved" ] && [ "$(as_owner "select count(*) from public.activities where deal_id = '$deal';")" = "1" ] \
  || fail "move_vs_log_activity_with_deal_no_deadlock (a): move '$out'"
# 11b. A move that does not touch the lead holds the deal; a call naming the deal is not blocked by it.
lead=$(new_lead 'Concurrency held move vs call')
deal=$(new_deal_m1 "$lead" 'Held move vs call')
as_user "$M1" "begin;
select public.move_deal('$deal', 'qualified', 0) \g /dev/null
select pg_sleep(1.5) \g /dev/null
commit;" > /dev/null 2> "$TMP_DC/c11b.err" & pa=$!
sleep 0.4
out=$(as_user "$ADMIN" "set lock_timeout = '500ms';
select public.log_activity(p_company => '$lead', p_type => 'call', p_outcome => 'no_answer', p_deal => '$deal') ->> 'deal_id';" 2>&1) \
  || fail "move_vs_log_activity_with_deal_no_deadlock (b): the call waited for the held move: $out"
wait $pa || fail "move_vs_log_activity_with_deal_no_deadlock (b): the move failed: $(cat "$TMP_DC/c11b.err")"
[ "$out" = "$deal" ] || fail "move_vs_log_activity_with_deal_no_deadlock (b): call answered '$out'"

# 12. Undo of the call that opened a deal against a colleague's note naming that deal (the note holds the lead first).
lead=$(new_lead 'Concurrency undo vs call')
read -r act deal <<< "$(interested_open "$lead")"
[ -n "$deal" ] || fail "undo_activity_vs_log_activity_with_deal_no_deadlock: no deal opened"
as_user "$ADMIN" "begin;
select 1 from public.companies where id = '$lead' for update \g /dev/null
select pg_sleep(0.8) \g /dev/null
select public.log_activity(p_company => '$lead', p_type => 'note', p_body => 'held note', p_deal => '$deal') \g /dev/null
commit;" > /dev/null 2> "$TMP_DC/c12.err" & pa=$!
sleep 0.3
rc=0; out=$(as_user "$M1" "select public.undo_activity('$act') ->> 'deal';" 2> "$TMP_DC/c12.b.err") || rc=$?
rca=0; wait $pa || rca=$?
deadlocked "$TMP_DC/c12.err" "$TMP_DC/c12.b.err" && fail "undo_activity_vs_log_activity_with_deal_no_deadlock: a deadlock"
[ "$rc" = "0" ] && [ "$rca" = "0" ] \
  || fail "undo_activity_vs_log_activity_with_deal_no_deadlock: undo $rc ($(cat "$TMP_DC/c12.b.err")), note $rca ($(cat "$TMP_DC/c12.err"))"
[ "$out" = "removed" ] && [ "$(as_owner "select count(*) from public.deals where id = '$deal';")" = "0" ] \
  && [ "$(as_owner "select count(*) from public.activities where company_id = '$lead' and type = 'note' and deal_id is null;")" = "1" ] \
  || fail "undo_activity_vs_log_activity_with_deal_no_deadlock: undo answered '$out'"

# 13. An admin's delete against a call naming the deal (the call holds the lead first).
lead=$(new_lead 'Concurrency delete vs call')
deal=$(new_deal_m1 "$lead" 'Delete vs call')
as_user "$M1" "begin;
select 1 from public.companies where id = '$lead' for update \g /dev/null
select pg_sleep(0.8) \g /dev/null
select public.log_activity(p_company => '$lead', p_type => 'call', p_outcome => 'voicemail', p_deal => '$deal') \g /dev/null
commit;" > /dev/null 2> "$TMP_DC/c13.err" & pa=$!
sleep 0.3
rc=0; as_user "$ADMIN" "select public.delete_deal('$deal');" > /dev/null 2> "$TMP_DC/c13.b.err" || rc=$?
rca=0; wait $pa || rca=$?
deadlocked "$TMP_DC/c13.err" "$TMP_DC/c13.b.err" && fail "delete_deal_vs_log_activity_with_deal_no_deadlock: a deadlock"
[ "$rc" = "0" ] && [ "$rca" = "0" ] \
  || fail "delete_deal_vs_log_activity_with_deal_no_deadlock: delete $rc ($(cat "$TMP_DC/c13.b.err")), call $rca ($(cat "$TMP_DC/c13.err"))"
[ "$(as_owner "select count(*) from public.deals where id = '$deal';")" = "0" ] \
  && [ "$(as_owner "select count(*) from public.activities where company_id = '$lead' and deal_id is null;")" = "1" ] \
  || fail "delete_deal_vs_log_activity_with_deal_no_deadlock: the deal or the entry"

# 14. Undo of the call that opened a deal against a colleague's move of that deal to Negotiations (lead, then deal).
lead=$(new_lead 'Concurrency undo vs move')
as_owner "update public.companies set lead_status = 'cold' where id = '$lead';" > /dev/null
read -r act deal <<< "$(interested_open "$lead")"
as_user "$ADMIN" "begin;
select public.move_deal('$deal', 'negotiations', 0) \g /dev/null
select pg_sleep(1) \g /dev/null
commit;" > /dev/null 2> "$TMP_DC/c14.err" & pa=$!
sleep 0.3
rc=0; out=$(as_user "$M1" "select (r ->> 'deal') || ' ' || (r -> 'lead' ->> 'lead_status') from public.undo_activity('$act') r;" 2> "$TMP_DC/c14.b.err") || rc=$?
rca=0; wait $pa || rca=$?
deadlocked "$TMP_DC/c14.err" "$TMP_DC/c14.b.err" && fail "undo_activity_vs_move_same_lead_no_deadlock: a deadlock"
[ "$rc" = "0" ] && [ "$rca" = "0" ] \
  || fail "undo_activity_vs_move_same_lead_no_deadlock: undo $rc ($(cat "$TMP_DC/c14.b.err")), move $rca ($(cat "$TMP_DC/c14.err"))"
[ "$out" = "kept negotiation" ] && [ "$(stage "$deal")" = "negotiations" ] \
  || fail "undo_activity_vs_move_same_lead_no_deadlock: undo answered '$out', stage $(stage "$deal")"
fi

# 9. history_chain_consistent: 3 sessions x 100 random moves over 20 deals ----------------------------------------------
lead=$(new_lead 'Concurrency chain')
as_owner "create table if not exists public.conc_deals (n integer primary key, id uuid not null);
          grant select on public.conc_deals to authenticated; truncate public.conc_deals;" > /dev/null
for n in $(seq 1 20); do
  id=$(new_deal "$lead" "Chain $n")
  as_owner "insert into public.conc_deals values ($n, '$id');" > /dev/null
done
# One random stage change in its own transaction: the result, or the refusal's hint; and its time in milliseconds.
cat > "$TMP_DC/session.sql" <<'SQL'
create function pg_temp.random_move() returns text language plpgsql as $$
declare
  v_id uuid;
  v_ver integer;
  v_from text;
  v_to text;
  r jsonb;
  t0 timestamptz := clock_timestamp();
  hint text;
  v_n integer := 1 + floor(random() * 20)::integer;  -- once: random() in a WHERE clause is drawn again per row
begin
  select c.id into v_id from public.conc_deals c where c.n = v_n;
  select d.version, s.key into v_ver, v_from from public.deals d join public.pipeline_stages s on s.id = d.stage_id
   where d.id = v_id;
  v_to := (array['lead', 'qualified', 'negotiations', 'won', 'lost'])[1 + floor(random() * 5)::integer];
  if v_to = v_from then
    return 'same 0';
  end if;
  begin
    r := public.move_deal(v_id, v_to, v_ver, case when v_to = 'won' then 500 end,
                          case when v_to = 'won' then 'from_stock' end, case when v_to = 'lost' then 'timing' end);
  exception when others then
    get stacked diagnostics hint = pg_exception_hint;
    return 'refused:' || coalesce(nullif(hint, ''), sqlstate) || ' ' || round(extract(epoch from clock_timestamp() - t0) * 1000, 2);
  end;
  return (r ->> 'result') || ' ' || round(extract(epoch from clock_timestamp() - t0) * 1000, 2);
end;
$$;
SQL
for i in $(seq 1 100); do echo "select pg_temp.random_move();" >> "$TMP_DC/session.sql"; done
run_session() {  # $1 sub, $2 output file
  { echo "set deadlock_timeout = '200ms';"
    echo "set role authenticated;"
    echo "select set_config('request.jwt.claims', '{\"sub\":\"$1\",\"role\":\"authenticated\",\"aal\":\"aal2\",\"amr\":[{\"method\":\"totp\",\"timestamp\":$(date +%s)}]}', false) \\g /dev/null"
    cat "$TMP_DC/session.sql"; } | psql "$CONN" -X -q -A -t -v ON_ERROR_STOP=1 > "$2" 2> "$2.err"
}
before=$(as_owner "select count(*) from public.deal_stage_history h join public.conc_deals c on c.id = h.deal_id;")
run_session "$R1" "$TMP_DC/s1.out" & p1=$!
run_session "$ADMIN" "$TMP_DC/s2.out" & p2=$!
run_session "$M1" "$TMP_DC/s3.out" & p3=$!
wait $p1 || fail "history_chain_consistent: session 1 failed: $(cat "$TMP_DC/s1.out.err")"
wait $p2 || fail "history_chain_consistent: session 2 failed: $(cat "$TMP_DC/s2.out.err")"
wait $p3 || fail "history_chain_consistent: session 3 failed: $(cat "$TMP_DC/s3.out.err")"
cat "$TMP_DC"/s?.out > "$TMP_DC/all.out"
[ "$(wc -l < "$TMP_DC/all.out")" = "300" ] || fail "history_chain_consistent: $(wc -l < "$TMP_DC/all.out") results, expected 300"
if grep -v -E '^(moved|conflict|unchanged|same|refused:(reopen_first|rate_limited)) ' "$TMP_DC/all.out" | grep -q .; then
  fail "history_chain_consistent: unexpected outcomes: $(grep -v -E '^(moved|conflict|unchanged|same|refused:(reopen_first|rate_limited)) ' "$TMP_DC/all.out" | sort | uniq -c | tr '\n' ';')"
fi
grep -q 'deadlock\|40P01' "$TMP_DC"/s?.out.err && fail "history_chain_consistent: a deadlock"
moved=$(grep -c '^moved ' "$TMP_DC/all.out" || true)
after=$(as_owner "select count(*) from public.deal_stage_history h join public.conc_deals c on c.id = h.deal_id;")
[ "$((after - before))" = "$moved" ] || fail "history_chain_consistent: $((after - before)) history rows for $moved moves"
bad=$(as_owner "select count(*) from (
  select h.deal_id, h.from_stage, h.version_after, lag(h.to_stage) over w as prev_to, lag(h.version_after) over w as prev_v,
         row_number() over w as rn, row_number() over (partition by h.deal_id order by h.id desc) as rn_desc, h.to_stage
    from public.deal_stage_history h join public.conc_deals c on c.id = h.deal_id
  window w as (partition by h.deal_id order by h.id)) x
  join public.deals d on d.id = x.deal_id join public.pipeline_stages s on s.id = d.stage_id
 where (x.rn > 1 and (x.from_stage is distinct from x.prev_to or x.version_after <= x.prev_v))
    or (x.rn_desc = 1 and (x.to_stage <> s.key or x.version_after <> d.version));")
bad2=$(as_owner "select count(*) from public.deals d join public.pipeline_stages s on s.id = d.stage_id
                  join public.conc_deals c on c.id = d.id
                 where d.status <> case s.key when 'won' then 'won' when 'lost' then 'lost' else 'open' end
                    or (d.status = 'open') <> (d.closed_at is null);")
[ "$bad" = "0" ] && [ "$bad2" = "0" ] || fail "history_chain_consistent: $bad chain rows and $bad2 deals break the invariants"
summary=$(sed 's/ .*//' "$TMP_DC/all.out" | sort | uniq -c | awk '{printf "%s %s, ", $1, $2}')
p95=$(grep -E '^(moved|conflict) ' "$TMP_DC/all.out" | awk '{print $2}' | sort -n | awk '{a[NR]=$1} END {i=int(NR*0.95); if (i<1) i=1; print a[i]}')
as_owner "drop table public.conc_deals;" > /dev/null
echo "history_chain_consistent: ${summary}p95 ${p95} ms per move or conflict, 0 deadlocks"
if [ "$MODE" = "all" ]; then
  echo 'deal_concurrency: all checks passed'
fi
