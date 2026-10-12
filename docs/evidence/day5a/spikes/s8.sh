#!/bin/bash
P="psql -h /tmp/pg5a-spike -p 54363 -U postgres -X -q -A -t"
D=40000000-0000-0000-0000-0000000000b1
L=30000000-0000-0000-0000-0000000000b1
# (a) A holds FOR NO KEY UPDATE on the deal; B inserts an activity naming the deal (its FK check takes FOR KEY SHARE)
$P -c "begin; select 1 from public.deals where id='$D' for no key update; select pg_sleep(2); commit;" >/dev/null & a=$!
sleep 0.4
t0=$(date +%s.%N)
out=$($P -c "set lock_timeout='1s'; insert into public.activities (org_id, company_id, deal_id, type) select org_id, '$L', '$D', 'note' from public.deals where id='$D' returning 'inserted';" 2>&1)
echo "S8a activity insert (FK KEY SHARE) while deal held FOR NO KEY UPDATE: $out after $(echo "$(date +%s.%N) - $t0" | bc) s"
wait $a
# (b) A inserts an activity naming the deal and stays open (holds KEY SHARE); B locks FOR NO KEY UPDATE; C deletes the deal
$P -c "begin; insert into public.activities (org_id, company_id, deal_id, type) select org_id, '$L', '$D', 'note' from public.deals where id='$D'; select pg_sleep(2); rollback;" >/dev/null & a=$!
sleep 0.4
out=$($P -c "set lock_timeout='1s'; begin; select 'locked' from public.deals where id='$D' for no key update; rollback;" 2>&1)
echo "S8b FOR NO KEY UPDATE while an open activity insert holds KEY SHARE: $out"
out=$($P -c "set lock_timeout='1s'; begin; delete from public.deals where id='$D' returning 'deleted'; rollback;" 2>&1 | tr '\n' ' ')
echo "S8c DELETE while an open activity insert holds KEY SHARE: $out"
out=$($P -c "set lock_timeout='1s'; begin; update public.deals set value = 5 where id='$D' returning 'updated (no key)'; rollback;" 2>&1 | tr '\n' ' ')
echo "S8d plain UPDATE of a non-key column while KEY SHARE held: $out"
wait $a
# (e) A holds FOR NO KEY UPDATE; B deletes (must wait: conflicts)
$P -c "begin; select 1 from public.deals where id='$D' for no key update; select pg_sleep(2); rollback;" >/dev/null & a=$!
sleep 0.4
out=$($P -c "set lock_timeout='1s'; begin; delete from public.deals where id='$D'; rollback;" 2>&1 | tr '\n' ' ')
echo "S8e DELETE while FOR NO KEY UPDATE held: $out"
wait $a
