#!/bin/bash
# Lead import under concurrency (design section 4, threats 17 and 19): two database sessions at once.
#  1. Two import calls on the same import at the same time add every lead exactly once.
#  2. An undo that runs while a teammate is adding a contact to an imported lead waits, then keeps that lead.
# Usage: import_concurrency.sh "<libpq connection string>" (run after import_attack.sql, which leaves admin
# 00000000-0000-0000-0000-00000000000a with no open import). Used by scripts/db-test.sh and the CI "rls" job.
set -euo pipefail
CONN="${1:?connection string}"
ADMIN=00000000-0000-0000-0000-00000000000a

# Runs SQL as the admin with a fresh two-factor code (claims set the way Supabase does). -A -t: bare values.
as_admin() {
  local now
  now=$(date +%s)
  psql "$CONN" -X -q -A -t -v ON_ERROR_STOP=1 <<SQL
set role authenticated;
select set_config('request.jwt.claims', '{"sub":"$ADMIN","role":"authenticated","aal":"aal2","amr":[{"method":"totp","timestamp":$now}]}', false) \g /dev/null
$1
SQL
}
fail() { echo "FAIL: $*" >&2; exit 1; }

# 1. Parallel import calls -------------------------------------------------------------------------------------------
batch=$(as_admin "select public.create_lead_import('parallel.csv', null, 300, 301);")
as_admin "select public.stage_lead_import_rows('$batch', (select jsonb_agg(jsonb_build_object('row_no', g + 1,
  'name', 'Parallel ' || g, 'lead_status', 'cold', 'email', 'parallel' || g || '@example.com'))
  from generate_series(1, 300) g)) \g /dev/null
select public.validate_lead_import('$batch') \g /dev/null"
call_loop() {
  for _ in 1 2 3 4; do as_admin "select public.commit_lead_import('$batch', 50) \g /dev/null"; done
}
call_loop & p1=$!
call_loop & p2=$!
wait $p1 || fail "first import session failed"
wait $p2 || fail "second import session failed"
as_admin "select public.commit_lead_import('$batch', 2000) \g /dev/null"
got=$(as_admin "select count(*) || ' ' || count(distinct email) from public.companies where import_batch_id = '$batch';")
[ "$got" = "300 300" ] || fail "parallel import added '$got' leads (expected 300 300)"
status=$(as_admin "select status from public.import_batches where id = '$batch';")
[ "$status" = "imported" ] || fail "parallel import ended as $status"

# 2. Undo while a contact is being added ------------------------------------------------------------------------------
batch2=$(as_admin "select public.create_lead_import('race.csv', null, 1, 2);")
as_admin "select public.stage_lead_import_rows('$batch2', '[{\"row_no\": 2, \"name\": \"Race Lead\", \"lead_status\": \"cold\"}]') \g /dev/null
select public.validate_lead_import('$batch2') \g /dev/null
select public.commit_lead_import('$batch2') \g /dev/null"
lead=$(as_admin "select id from public.companies where import_batch_id = '$batch2';")
# Session A adds a contact and holds its transaction open for 3 seconds.
as_admin "begin;
select public.add_contact('$lead', 'Late', 'Contact') \g /dev/null
select pg_sleep(3) \g /dev/null
commit;" & pa=$!
sleep 1
# Session B undoes meanwhile: it must wait for A, then see the contact and keep the lead.
result=$(as_admin "select public.rollback_lead_import('$batch2');")
wait $pa || fail "contact session failed"
kept=$(as_admin "select count(*) from public.companies where id = '$lead';")
contacts=$(as_admin "select count(*) from public.contacts where company_id = '$lead';")
[ "$kept" = "1" ] && [ "$contacts" = "1" ] || fail "undo removed a lead that got a contact meanwhile ($result)"
case "$result" in *'"kept": 1'*) ;; *) fail "undo should report 1 kept lead ($result)" ;; esac

echo 'import_concurrency: all checks passed'
