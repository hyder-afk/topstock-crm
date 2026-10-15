# Day 5b mutations (design 8.3)

Each row removes one Day 5b protection from a copy of the migrations (`scripts/db-mutations.py`, set `day5b`, run in a
throwaway worktree with its own `db-test.sh` copy on port 54362; the worktree was removed afterwards) and runs the whole
database suite. A row is **caught** when at least one check fails. Run on cd9a4db (the Day 5b migration and tests as
committed; neither has changed since, `git diff cd9a4db HEAD -- supabase scripts .github` touches only
`supabase/tests/perf_day5.sql`, the P5 timing block).

Earlier rows that aim inside `log_activity`, `undo_activity`, `get_lead` or the activities insert policy (Day 4a and
Day 4b sets) now follow the live Day 5b copies (`db-mutations.py` moves an edit aimed at a Day 4 function that Day 5b
recreates to the Day 5b copy; REBASE: and again at the 4c rebase). Those rows were re-run against the Day 5b copies:
**Day 4a: 1 row run, 1 caught; Day 4b: 45 rows run, 45 caught**, 0 documented two-layer rows not caught, 0 not as
listed (the re-run log stayed in the session scratchpad, `mut-relive-4a.md` and `mut-relive-4b.md`).


### day5b

| # | Protection removed | Result | First failure |
|---|---|---|---|
| 1 | Activities insert policy: no same-lead deal check | caught | FAIL: linked to a record the caller cannot use: insert into public.activities (company_id, deal_id, type) values ('30000000-0000-0000-0000-0 |
| 2 | undo_activity: removes the deal without version = 0 (a moved deal goes too) | caught | FAIL: undo_activity_vs_move_same_lead_no_deadlock: undo answered 'removed negotiation', stage |
| 3 | undo_activity: deletes the deal before the lead lock (deadlock test) | caught | FAIL: undo_activity_vs_log_activity_with_deal_no_deadlock: a deadlock |
| 4 | Deal delete policy: creator branch without the activity-undo condition | caught | FAIL: deal_direct_delete_refused_while_activity_undo_record |
| 5 | log_activity: opens deals for people who may not change the lead | caught | new row violates row-level security policy for table "deals" |
| 6 | log_activity: opens a deal on a Do not contact lead (the guard refuses the whole call) | caught | this lead asked not to be contacted |
| 7 | log_activity: no open-rate check before the deal (the guard refuses the whole call) | caught | too many deals opened in an hour |
| 8 | log_activity: a deal opens from any outcome | caught | FAIL: "select public.log_activity(p_company => '06f31236-5ca7-4162-8c86-cb7c35eaf500', p_type => 'call', p_outcome => 'no_answer', p_open_de |
| 9 | log_activity: no deal title pre-check (a skipped open never checks it) | caught | FAIL: "select pg_temp.interested('0698500e-027b-4cee-9e2e-a205cf0d16d0', true, 'interested', 'Bad\u202E')" succeeded, expected 22023 |
| 10 | log_activity: no deal value pre-check (3 decimals rounded by the column) | caught | FAIL: "select pg_temp.interested('1c5ea6ec-7244-4965-b6d9-d336b6f18ff1', true, 'interested', null, 1.005)" succeeded, expected 22023 |
| 11 | log_activity: no same-lead check for a linked deal (the policy answers 42501 instead of P0002) | caught | FAIL: "select public.log_activity(p_company => 'f38ad7b7-086f-4dc1-8e07-27d56cef148e', p_type => 'note', p_body => 'x', p_deal => '45b05051- |
| 12 | undo_activity: never removes the deal the call opened | caught | FAIL: undo_activity_vs_log_activity_with_deal_no_deadlock: undo answered 'kept' |
| 13 | log_activity: the undo record forgets the deal | caught | FAIL: undo_activity_vs_log_activity_with_deal_no_deadlock: undo answered '' |
| 14 | Replay answer without the opened deal | caught | FAIL: log_activity_open_deal_replay {"deal": null, "deal_id": null, "task_id": "c4fe7c7f-491e-41dc-ad69-ec4783268ed2", "editable": true, "re |
| 15 | get_lead: can_open_deal ignores Do not contact | caught | FAIL: can_open_deal on a DNC lead |
| 16 | get_lead: open_count counts closed deals too | caught | FAIL: get_lead deals for the owner {"open_count": 3, "latest_open": {"id": "fc4e5119-10c3-4fd9-8da0-e25eace3feaa", "stage": "qualified", "ti |
| 17 | log_activity runs as its owner (DEFINER: deals and links for anyone) | caught | FAIL: RPC rules broken by {"log_activity(uuid,text,text,text,uuid,text,date,timestamp with time zone,text,uuid,boolean,uuid,boolean,text,num |

day5b: 17 rows run: 17 caught, 0 documented two-layer rows not caught, 0 not as listed

Result: **17 of 17 caught**, exit 0.


## Verifier round 1 (15 Oct): after the rebase onto Day 4c

Run from a throwaway worktree of cad5528 (removed afterwards) with its `db-test.sh` on port 54482. Rows re-run: every row
whose edit is aimed at a function the rebase re-copied (`audit_row` in 5a; `log_activity`, `get_lead`, `queue_card`,
the insert policy in 5b), in every set, Day 4c's own included, plus the new 5b rows 18 to 20. Before running,
`--anchors` found every edit once, and a new check confirmed every edit lands in a live definition (it found day4a 25
still editing the dropped 4a insert policy: re-aimed to the 5b copy).

**Result: 87 rows, 86 caught, 1 documented two-layer row not caught (day4c 55, as listed by Day 4c), 0 not as listed.**

### day5b (15 rows)

| # | Protection removed | Result | First failure |
|---|---|---|---|
| 1 | Activities insert policy: no same-lead deal check | caught | FAIL: linked to a record the caller cannot use: insert into public.activities (company_id, deal_id, type) values ('30000000-0000-0000-0000-0 |
| 5 | log_activity: opens deals for people who may not change the lead | caught | new row violates row-level security policy for table "deals" |
| 6 | log_activity: opens a deal on a Do not contact lead (the guard refuses the whole call) | caught | this lead asked not to be contacted |
| 7 | log_activity: no open-rate check before the deal (the guard refuses the whole call) | caught | too many deals opened in an hour |
| 8 | log_activity: a deal opens from any outcome | caught | FAIL: "select public.log_activity(p_company => '41171180-174a-4a28-b669-c8d5b30414d1', p_type => 'call', p_outcome => 'no_answer', p_open_de |
| 9 | log_activity: no deal title pre-check (a skipped open never checks it) | caught | FAIL: "select pg_temp.interested('47c1395d-7d29-446c-be97-3ac74dd30193', true, 'interested', 'Bad\u202E')" succeeded, expected 22023 |
| 10 | log_activity: no deal value pre-check (3 decimals rounded by the column) | caught | FAIL: "select pg_temp.interested('820e2dae-a734-4d7a-a781-28b6da26f5ba', true, 'interested', null, 1.005)" succeeded, expected 22023 |
| 11 | log_activity: no same-lead check for a linked deal (the policy answers 42501 instead of P0002) | caught | FAIL: "select public.log_activity(p_company => 'fc9fa290-7449-4e66-a3d5-096d9d75dc8c', p_type => 'note', p_body => 'x', p_deal => '00d04c09- |
| 13 | log_activity: the undo record forgets the deal | caught | FAIL: undo_activity_vs_log_activity_with_deal_no_deadlock: undo answered '' |
| 15 | get_lead: can_open_deal ignores Do not contact | caught | FAIL: can_open_deal on a DNC lead |
| 16 | get_lead: open_count counts closed deals too | caught | FAIL: get_lead deals for the owner {"open_count": 3, "latest_open": {"id": "f5215fa1-4076-47a5-b291-b206e1177c49", "stage": "qualified", "ti |
| 17 | log_activity runs as its owner (DEFINER: deals and links for anyone) | caught | FAIL: RPC rules broken by {"log_activity(uuid,text,text,text,uuid,text,date,timestamp with time zone,text,uuid,boolean,uuid,boolean,text,num |
| 18 | Queue card: open_deal counts closed deals too | caught | FAIL: claim_card_open_deal_count for the owner {"count": 3, "latest": {"id": "a932fb48-2879-4c95-bd5e-118b8d0d9f5f", "stage": "won", "value" |
| 19 | Queue card: open_deal's newest is the oldest | caught | FAIL: claim_card_open_deal_count for the owner {"count": 2, "latest": {"id": "a396c7f8-bee5-4054-869d-7c0c926e34c8", "stage": "lead", "value |
| 20 | Queue card runs as its owner (DEFINER: every deal in the org counted for a rep) | caught | FAIL: function rules broken by {"private.queue_card(uuid,text,boolean)"} |

### day4c (10 rows)

| # | Protection removed | Result | First failure |
|---|---|---|---|
| 54 | log_activity: a call from the queue keeps its claim | caught | FAIL: p_from_queue must release the caller's claim, and only then |
| 55 | log_activity: a call from the queue releases anyone's claim (the delete policy still stops it) | **NOT CAUGHT** (documented: two layers) | advisors: no ERROR-level findings |
| 56 | log_activity and the delete policy: a call from the queue releases a teammate's claim (both layers) | caught | FAIL: claim_delete_other_fresh_zero_rows |
| 57 | log_activity: the lead locked FOR UPDATE again (a claim waits for the call) | caught | FAIL: claim_does_not_wait_for_the_lead: the claim waited 1570 ms for the lead |
| 58 | get_lead: worked_by names the caller | caught | FAIL: the caller's own claim is not "worked by" |
| 59 | get_lead: worked_by from an expired claim | caught | FAIL: worked_by for an expired claim |
| 65 | Audit: call_zone and queue_rank stored | caught | FAIL: a next call or mark change was audited |
| 66 | Audit: the contact flag diffed | caught | FAIL: the contact flag wrote an audit row for the lead |
| 86 | Wrong number: a contact number without a digit counts as another working number (no find-the-number task) | caught | FAIL: wrong main line with only a digitless contact number: task <NULL> rank <NULL> |
| 87 | Wrong number: a main line without a digit counts as another working number (no find-the-number task) | caught | FAIL: wrong contact number with a digitless main line: task <NULL> rank <NULL> |

### day4b (35 rows)

| # | Protection removed | Result | First failure |
|---|---|---|---|
| 4 | Outcome decisions applied for people who may not change the lead | caught | FAIL: a rep took or changed an unassigned lead {"deal": null, "deal_id": null, "task_id": "48519c17-72b4-4903-9f58-8a5f522b9986", "editable" |
| 5 | Lock order reversed in log_activity: lead, then contact (deadlock test) | caught | deadlock detected |
| 11 | Wrong number: the dialled contact marked without the editor's lock (code claims a mark) | caught | FAIL: a rep marked a colleague's contact, or got no task {"deal": null, "deal_id": null, "task_id": null, "editable": false, "replayed": fal |
| 12 | log_activity runs as its owner (marks and decisions for anyone, as a definer trigger would) | caught | FAIL: RPC rules broken by {"log_activity(uuid,text,text,text,uuid,text,date,timestamp with time zone,text,uuid,boolean,uuid,boolean,text,num |
| 31 | log_activity: no second replay check after the lock, and no unique-violation answer (both layers) | caught | duplicate key value violates unique constraint "activities_author_request_idx" |
| 32 | log_activity: no unique-violation answer (a concurrent duplicate fails) | caught | duplicate key value violates unique constraint "activities_author_request_idx" |
| 47 | Audit: next call and marks diffed | caught | FAIL: audit of an outcome |
| 49 | Outcomes: the 6th try counts from 7 (>= 6) | caught | FAIL: after {no_answer,voicemail,no_answer,no_answer,voicemail} then no_answer: (cold, 2026-10-16 07:00:00+00), expected (cool_off, 2026-11- |
| 50 | Outcomes: the 6th try sends any status to Cool off | caught | FAIL: after {no_answer,no_answer,no_answer,no_answer,no_answer} then no_answer: (cool_off, 2026-11-14 00:59:05.56977+00), expected (negotiat |
| 51 | Outcomes: voicemail waits one working day like no answer | caught | FAIL: voicemail on cold: lead (cold, 2026-10-16 07:00:00+00), answer {"deal": null, "deal_id": null, "task_id": null, "editable": true, "rep |
| 52 | Outcomes: Not interested moves Negotiation to Cool off | caught | FAIL: not_interested on negotiation: lead (cool_off, 2027-01-13 00:59:58.083394+00), answer {"deal": null, "deal_id": null, "task_id": null, |
| 53 | Outcomes: Interested moves a lead down (Negotiation to Warm) | caught | FAIL: interested on negotiation: lead (warm, 2026-10-18 07:00:00+00), answer {"deal": null, "deal_id": null, "task_id": "c7fa2ada-d69b-427a- |
| 54 | Outcomes: Book meeting moves Negotiation to Warm | caught | FAIL: meeting_booked on negotiation: lead (warm, 2026-10-19 03:00:00+00), answer {"deal": null, "deal_id": null, "task_id": "6c27783e-41c1-4 |
| 55 | Outcomes: Do not contact keeps the next call | caught | FAIL: do_not_contact on cold: lead (do_not_contact, 2026-10-18 01:01:17+00), answer {"deal": null, "deal_id": null, "task_id": null, "editab |
| 56 | Outcomes: Spoke without a follow-up keeps the next call (no 30 days) | caught | FAIL: connected on cold: lead (cold, 2026-10-18 01:01:44+00), answer {"deal": null, "deal_id": null, "task_id": null, "editable": true, "rep |
| 57 | Outcomes: back on the follow-up day itself, not the day after | caught | FAIL: meeting_booked on cold: lead (warm, 2026-10-18 03:02:00+00), answer {"deal": null, "deal_id": null, "task_id": "779bc304-a1a0-41e0-8d1 |
| 58 | Outcomes: a follow-up date read in Paris for every lead (not its zone) | caught | FAIL: interested on a US lead (zone <NULL>): {"deal": null, "deal_id": null, "task_id": "f3385f16-8819-47c0-89bf-ab1db2b869b1", "editable":  |
| 59 | Outcomes: an owned lead taken over too | caught | FAIL: interested on cold: lead (warm, 2026-10-18 07:00:00+00), answer {"deal": null, "deal_id": null, "task_id": "2cbe3248-7316-4ad4-869b-3d |
| 60 | Outcomes: Spoke takes over an unassigned lead too | caught | FAIL: connected on a lead owned by <NULL>: owner 00000000-0000-0000-0000-00000000000a, answer {"deal": null, "deal_id": null, "task_id": nul |
| 61 | Tasks: a call completes every open call task, due or not | caught | FAIL: no_answer on cold: the future call task (done 2026-10-15 01:03:58.067733+00, dismissed <NULL>) |
| 62 | Tasks: a call completes to-dos too | caught | FAIL: a call completed ["260d8da1-c7b0-4d3c-a6a0-05613555f6bc", "d1f7eee5-bb37-48b3-99b6-a4d3e3b4a7cd", "da659ca6-e296-4f4c-96fe-92123cc6fa2 |
| 63 | Tasks: a call completes a colleague's call tasks | caught | FAIL: a call completed ["3ac3062a-06a4-4a4e-a5a6-0cc1c155bc3b", "3ba380df-0753-4e2b-a1ac-4f926c4429a1", "8f592a68-fae8-4edc-b292-71484b75e43 |
| 64 | Tasks: Do not contact dismisses nothing | caught | FAIL: do_not_contact on cold: the future call task (done <NULL>, dismissed <NULL>) |
| 65 | Tasks: 'find the right number' although another number works | caught | FAIL: wrong main line with a working contact {"deal": null, "deal_id": null, "task_id": "6f073d66-4a59-4211-b9eb-30a326651e87", "editable":  |
| 66 | Tasks: 'find the right number' always for the caller (not the owner) | caught | FAIL: wrong_number on cold: the task made {"id":"7780ff45-161f-4dd7-b196-01b6ea50c4f4","org_id":"5bfe6dab-c5be-4fa6-b7f9-cb86f6119546","cont |
| 67 | Input: Interested without a follow-up | caught | FAIL: "select public.log_activity('44901b17-2922-459a-b1a9-1740ef503731', 'call', 'interested', NULL, NULL, null, NULL, NULL, 'Follow up')"  |
| 68 | Input: follow-up dates and times not bounded | caught | FAIL: "select public.log_activity('fd04a4a2-92bf-43b9-afa1-acf7b491d7fe', 'call', 'interested', NULL, NULL, null, '2026-10-13', NULL, 'F')"  |
| 69 | Input: a follow-up on an outcome that takes none | caught | FAIL: "select public.log_activity('c6f0f8c4-52f1-48c7-a73c-3cf8d81604fe', 'call', 'no_answer', NULL, NULL, null, '2026-10-16', NULL, 'F')" s |
| 70 | Input: Wrong number without a title up front | caught | FAIL: "select public.log_activity('296bde0a-ee92-4074-a0e2-7602feca3039', 'call', 'wrong_number', null, null, 'lead')" succeeded, expected 2 |
| 71 | Input: a note without text | caught | FAIL: "select public.log_activity('25982c8f-dfca-4bbb-bf8f-4ed686dc5c6c', 'note', NULL, ' |
| 72 | Input: no check of the dialled number | caught | FAIL: "select public.log_activity('38348762-9541-4871-b925-c78e678abe92', 'call', 'wrong_number', null, null, null, null, null, 'Find')" gav |
| 73 | Input: an empty dialled number accepted | caught | FAIL: "select public.log_activity('960bc067-902d-43af-a541-fcd74295f76b', 'call', 'wrong_number', null, null, 'lead', null, null, 'Find')" s |
| 74 | Input: a contact of another lead (the policy answers 42501 instead of P0002) | caught | FAIL: "select public.log_activity('42f7c904-bfed-450f-871b-1883a7784620', 'note', NULL, 'x', '89f68a2b-a89d-492a-b722-3e2661d1e2a4', null, N |
| 79 | get_lead: anyone may set the zone | caught | FAIL: a non-editor may set the zone |
| 87 | log_activity: a call naming a contact it does not mark takes the lead first (deadlock test) | caught | deadlock detected |

### day4a (6 rows)

| # | Protection removed | Result | First failure |
|---|---|---|---|
| 1 | Activities insert policy: manager exception back (G1) | caught | FAIL: "insert into public.activities (company_id, type) values ('32000000-0000-0000-0000-0000000000b1', 'note')" succeeded, expected 42501 |
| 9 | Audit: a deleted entry keeps its text | caught | FAIL: a deleted entry should be audited without its text, with its length: {"id": "bf572d0d-82b0-4251-8d95-0a235bfcb29e", "body": "AUDIT-MAR |
| 25 | Activities insert policy: a contact of another lead | caught | FAIL: linked to a record the caller cannot use: insert into public.activities (company_id, contact_id, type) values ('30000000-0000-0000-000 |
| 32 | Audit: an edit keeps the text | caught | FAIL: an edit should be audited as the text's lengths and edited_at: {"body": {"new": "AUDIT-MARKER second, longer words", "old": "AUDIT-MAR |
| 33 | Audit: new entries copied | caught | FAIL: an activity insert was copied into the audit log |
| 83 | Audit: a deleted entry without its length (D8) | caught | FAIL: a deleted entry should be audited without its text, with its length: {"id": "b5413d5a-b3a1-4482-91df-440bfc8f6385", "type": "note", "o |

### day3b (2 rows)

| # | Protection removed | Result | First failure |
|---|---|---|---|
| 28 | Audit: full copy of imported leads | caught | FAIL: imported leads should each have one small audit row |
| 29 | Audit: search and key columns kept | caught | FAIL: search_text copied into the audit log |

### day5a (2 rows)

| # | Protection removed | Result | First failure |
|---|---|---|---|
| 49 | Audit: the version diffed | caught | FAIL: audit_version_not_diffed / audit_lost_note_masked |
| 50 | Audit: the lost note copied | caught | FAIL: audit_deal_insert_update_delete_rows / audit_deal_value_change_logged / audit_lost_note_masked: [{"diff": {"new": {"id": "e36ddba3-67b |
