# Day 5a mutations: each protection removed must make a database test fail

Method (design 8.3; `scripts/db-mutations.py`): for each row the migration is changed in place in a throwaway worktree
(`scratchpad/wt-5a-mut`, its own `db-test.sh` copy on port 54362), `scripts/db-test.sh` runs every suite (the RLS,
import, activity, outcome and deals attack tests, the four two-session tests, `deal_concurrency.sh`, the advisors), and
the migration is restored. A row is **caught** when the run fails. A row marked "documented: two layers" removes one of
two layers that stop the same thing, so no test can see it alone; the next row removes both layers and must be caught.
Before the runs, two baseline runs passed on the same head. Each caught row's first failure was read: it is the
protection's own test (or the catalog check that names it), not a timing flake. Another workflow was running on the
same VM at the same time, which is why every first failure was read.

Heads: the day5a set ran on **8bd6e4b** (rows 1 to 38 and 41 to 53, then numbered 1 to 52), the three rows changed after
it (37's test was null-unsafe and did not see the mutation; 39 is the two-layer row; 40 is its both-layers row) on
**3a21018**, the final code head; the earlier sets' re-aimed rows on 8bd6e4b. Nothing in the migration changed between
8bd6e4b and 3a21018; the tests changed only in the null-safe comparisons of 3a21018. After the runs, 0b9d470 and b8e839f changed
only `private.pipeline_summary_for` (speed: the lead read for clock-stalled deals only; the aggregate materialized), which
no mutation row edits; `db-test.sh` passes on b8e839f and every anchor is found once there (`--anchors`).

Run history (recorded, not hidden): the first run (on 4782724) was stopped at row 30: with the keyset mutation (`<=`) the
paging test looped for ever. The test now bounds its loop (96b3579). A second start stopped at its baseline: the 3-session
random run met an "unchanged" answer (a colleague had just moved the deal to that stage), a valid outcome the script now
accepts (8bd6e4b). Row 37 was first NOT CAUGHT on 8bd6e4b: the test compared `owner_id <> admin`, which is null, not
true, for an empty owner; the test file now uses null-safe comparisons for every column a mutation can empty.

## Team advisor finding (15 Oct): admin-only delete, rows 74 to 76 added, on 5f240f3

Code head 5f240f3 (ae157cf the fix, 5f240f3 the tests and rows). Copies of the worktree with `db-test.sh` on port 54497,
three run side by side to finish in time (rows 1 to 24, 25 to 39, 40 to 63 and 74 to 76; the first and third runs were
stopped by PID once their ranges were done). **Rows 64 to 73 were not re-run** (stopped at the deadline): they edit the
undo, owner and flood code, which this fix does not touch; `--anchors` finds every anchor of every set once.

Result: rows 1 to 63 and 74 to 76 (66 rows): **59 caught, 6 documented two-layer rows not caught (20, 24, 27, 28, 39,
63), and row 58 caught incidentally (fixture volume in deal_links_attack.sql / log_activity_interested_opens_deal, user r1 …05a1); still a documented two-layer row; not counted as a new catch**. The three new rows are caught by the new tests:

| 74 | Delete policy: a manager with a fresh code may delete (is_admin back to is_manager_or_admin) | caught | FAIL: deal_delete_manager_fresh_code_denied (direct) |
| 75 | delete_deal: a manager passes the role check (is_admin back to is_manager_or_admin; the policy then gives P0002) | caught | FAIL: "select public.delete_deal('4b1f5aaa-e09c-45a6-96b6-a1f0699eecb0')" gave P0002 (hint "", deal not found), expected 42501 (hint "<NULL> |
| 76 | Cards: Delete offered to managers (can_delete with is_manager_or_admin) | caught | FAIL: a manager is offered Delete |

**Row 58: caught incidentally, still a documented two-layer row** (confirmed 15 Oct on a scratch copy of the PR head, code 74ba153,
`db-test.sh` on port 54499, row 58 alone). The script prints "caught, but listed as NOT CAUGHT"; the catch is fixture
volume, not a test of the property, so it is not counted as a new catch and the row stays listed as two layers (the
statement-level recount, rows 66 to 73, is the real second layer). Exact cause: every suite up to `deal_concurrency`
passes (`deals_attack` in full: its 30+5+3+2 board deals in block 9 are rolled back and are not the cause); the
failure is `deal_links_attack.sql` block 3, test `log_activity_interested_opens_deal` (line 276), the first Interested
open by r1 (`00000000-0000-0000-0000-0000000005a1`). The mutated guard counts r1's live deals created in the last hour.
The file's setup empties `private.deal_opens` (line 120) but not `public.deals`: `deal_concurrency.sh` leaves 28
committed deals created by r1 (20 on "Concurrency chain", 8 on the other cases), and block 2 adds 3 more through
`pg_temp.su_deal(…, r1)` in its DECLARE section (initialisers run before the block's exception savepoint, so the TS001
undo does not remove them). 31 >= 30, so the open is refused with "too many deals opened in an hour". The real guard
counts `private.deal_opens` (0 for r1 at that point) and lets it through.

Row 14's anchor follows `is_admin` (title "no fresh code for admins"); it is caught by `deal_delete_stale_code_denied (direct)`.

| # | Protection removed | Result | First failure |
|---|---|---|---|
| 1 | Grant update (status) on deals | caught | FAIL: deal_update_columns_exact: {contact_id,expected_close,fulfilment,lost_note,lost_reason,owner_id,stage_id,status,title,value} |
| 2 | Grant update (stage_entered_at) on deals | caught | FAIL: deal_update_columns_exact: {contact_id,expected_close,fulfilment,lost_note,lost_reason,owner_id,stage_entered_at,stage_id,title,value} |
| 3 | Guard: no value_required pre-check (the won-shape CHECK answers with the row) | caught | FAIL: "select pg_temp.mv('a3c968b5-4e06-4edf-a83f-a2f9e840ab37', 'won', null, 'from_stock')" gave 23514 (hint "", new row for relation "deal |
| 4 | Guard: no fulfilment_required pre-check (the won-shape CHECK answers with the row) | caught | FAIL: "select pg_temp.mv('bbe74f9b-f9b6-4f49-ab19-4621037e79d0', 'won', 10)" gave 23514 (hint "", new row for relation "deals" violates chec |
| 5 | Guard: no lost-reason pre-check (the hint test fails although the CHECK still raises) | caught | FAIL: "update public.deals set stage_id = private.stage_id('lost') where id = 'c69a60f9-5028-4cad-ae4b-78d61bc54632'" gave 23514 (hint "", n |
| 6 | Guard: won and lost reachable from a closed deal (no reopen_first) | caught | FAIL: "update public.deals set stage_id = private.stage_id('lost'), lost_reason = 'timing' where id = '839b0280-9add-48d8-8004-66d6403652d0' |
| 7 | Guard: reopening a won deal needs no fresh code | caught | FAIL: "update public.deals set stage_id = private.stage_id('lead') where id = '44eb982c-a524-4034-8804-8f2ccc2abaa1'" succeeded, expected 42 |
| 8 | Undo candidate: ignores who made the change | caught | FAIL: reverse_by_other_user_is_ordinary_move / history_actor_forced {"deal": {"id": "0c0015e7-6071-45f9-b031-fb33135f4a6f", "city": null, "s |
| 9 | Undo candidate: ignores the 120-second window | caught | FAIL: transition_matrix qualified -> lead: {"deal": {"id": "b7e2b732-7be4-4b83-a55c-e46c69de5ec6", "city": null, "stage": "lead", "title": " |
| 10 | Undo candidate: ignores version_after (a colleague's change in between) | caught | FAIL: reverse_after_colleague_edit_is_ordinary |
| 11 | move_deal: no version compare | caught | FAIL: a stale move should be a conflict result {"deal": {"id": "c5ad60b0-3bee-4a9e-8306-ad4d80abdef5", "city": null, "stage": "negotiations" |
| 12 | History: insert granted to clients | caught | FAIL: deal_stage_history grants |
| 13 | History: actor taken from the deal's owner | caught | FAIL: reverse_by_other_user_is_ordinary_move / history_actor_forced {"deal": {"id": "5663d9c1-fd24-4b16-95da-daaa1bde2ae2", "city": null, "s |
| 14 | Delete policy: no fresh code for admins | caught | FAIL: deal_delete_stale_code_denied (direct) |
| 15 | Delete policy: the creator's branch without version = 0 (a moved deal deleted without a code) | caught | FAIL: a moved deal was deleted directly without a code |
| 16 | Deals: lead FK back to set null | caught | FAIL: lead FK restrict, company_id not null, tasks.deal_id set null |
| 17 | Tasks: deal FK back to cascade | caught | FAIL: lead FK restrict, company_id not null, tasks.deal_id set null |
| 18 | Task guard: deal_id not in the link-emptying exception | caught | this part of a task cannot change |
| 19 | Stages: the admin update policy and grant restored | caught | FAIL: stage_write_denied_even_admin (grants or policies) |
| 20 | Value CHECK: no NaN term (the 100,000,000 bound refuses NaN too: NaN sorts above every number) | **NOT CAUGHT** (documented: two layers) | advisors: no ERROR-level findings |
| 21 | Value CHECK: no NaN term and no bound (both layers of the backstop) | caught | FAIL: a deal CHECK let this through: insert into public.deals (org_id, company_id, stage_id, value) values ('9602d43b-a4b6-4115-89a3-9bb5a3c |
| 22 | move_deal: locks the deal FOR UPDATE (blocks behind an entry's key lock; spike S8) | caught | canceling statement due to lock timeout |
| 23 | Lead coupling: a win overrides Do not contact | caught | FAIL: coupling_table won on a do_not_contact lead (editor t): got customer, expected do_not_contact |
| 24 | Lead coupling: without the editor lock (row level security on the lead update still stops it) | **NOT CAUGHT** (documented: two layers) | advisors: no ERROR-level findings |
| 25 | Lead coupling: without the editor lock, and move_deal runs as its owner (both layers) | caught | FAIL: RPC rules broken by {"move_deal(uuid,text,integer,numeric,text,text,text,bigint,uuid)"} |
| 26 | Undo: the lead put back whatever it holds now | caught | FAIL: undo_restores_lead_only_if_unchanged |
| 27 | Guard: no open flood guard (since verifier round 2 the statement-level recount answers the same rate_limited) | **NOT CAUGHT** (documented: two layers) | advisors: no ERROR-level findings |
| 28 | Guard: no stage-change flood guard (since verifier round 2 the statement-level recount answers the same rate_limited) | **NOT CAUGHT** (documented: two layers) | advisors: no ERROR-level findings |
| 29 | Deals: request id index not unique | caught | FAIL: "insert into public.deals (company_id, request_id) values ('24fa2c0c-5e56-4564-8312-369756aada8e', '1b479358-c522-41ed-9254-2ccf23562b |
| 30 | Column keyset: <= instead of < (a deal repeated across pages) | caught | FAIL: list_stage_keyset_stable (recent team): 61 rows |
| 31 | pipeline_board: a rep's team is not mapped to their own deals (42501 on first paint) | caught | only managers and admins see the team's deals |
| 32 | Guard: an invisible stage answers P0002 instead of 42501 | caught | this stage is not one of your pipeline's |
| 33 | Guard: a lost note change is not a change (no version, no check) | caught | FAIL: "update public.deals set lost_note = 'quiet edit' where id = '614cb6ca-1d9d-48aa-b669-63b9035ed710'" succeeded, expected 22023 |
| 34 | Undo: the value is not restored from history (the client's or the won value stays) | caught | FAIL: undo_restores_clock_close_value_fulfilment {"deal": {"id": "4107f34a-eb0b-42fa-bbae-f50cc45f587b", "city": null, "stage": "negotiation |
| 35 | Guard: no Do not contact check on insert | caught | FAIL: "select public.open_deal('1467ceef-1ea8-4240-8a13-9999ef7ea463')" succeeded, expected 22023 |
| 36 | Guard: created_by left to the client (empty) | caught | FAIL: deal_opens_at_lead / deal_created_by_forced: {"id":"b01c7b7e-cd7c-449a-9271-72983ef37efb","org_id":"e8df1d7e-b9ad-4e1c-959a-d61afdf72b |
| 37 | Guard: an admin's deal left without an owner (G11) | caught | FAIL: owner_defaults_to_creator |
| 38 | Guard: a closed deal's value, shipping and dates editable | caught | FAIL: "update public.deals set value = 1 where id = 'f0ffc22c-e5fc-4a08-8459-b090c0e8102b'" succeeded, expected 22023 |
| 39 | Guard: the client's stage clock kept on insert (no insert grant on it, and its default is now()) | **NOT CAUGHT** (documented: two layers) | advisors: no ERROR-level findings |
| 40 | Guard: the client's stage clock kept on insert, and granted (both layers) | caught | FAIL: deal_insert_columns_exact: {company_id,contact_id,expected_close,fulfilment,owner_id,request_id,source_activity_id,stage_entered_at,ti |
| 41 | Deals select: no organisation check | caught | FAIL: admin should see both reps' files, nothing from the other org |
| 42 | History select: no deal visibility (a colleague's deal history readable) | caught | FAIL: rep_get_other_deal_null |
| 43 | Move records: a row for another person's change | caught | FAIL: "insert into private.deal_moves (history_id, org_id, user_id, deal_id, company_id) select 500, org_id, '00000000-0000-0000-0000-000000 |
| 44 | delete_deal: no fresh-code pre-check (no step_up hint) | caught | FAIL: "select public.delete_deal('835f6edd-a382-4255-bba6-4e9808ae9690')" gave 42501 (hint "", only an admin can delete a deal), expected 42 |
| 45 | update_deal: no field whitelist | caught | FAIL: "select public.update_deal('fc4b2196-552b-47d8-bd50-b85cb38e0857', 2, '{title,status}', 'x')" succeeded, expected 22023 |
| 46 | list_stage_deals: half a cursor accepted | caught | FAIL: "select * from public.list_stage_deals('lead', p_after_at => now())" succeeded, expected 22023 |
| 47 | Cards: stalled ignores the lead's last activity | caught | FAIL: stall case "lead/720/1/false/0" in UTC: stalled t, quiet 0 |
| 48 | Lead coupling: a loss rests the lead although another deal is open | caught | FAIL: coupling_table lost_other_open on a warm lead (editor t): got cool_off, expected warm |
| 49 | Audit: the version diffed | caught | FAIL: audit_version_not_diffed / audit_lost_note_masked |
| 50 | Audit: the lost note copied | caught | FAIL: audit_deal_insert_update_delete_rows / audit_deal_value_change_logged / audit_lost_note_masked: [{"diff": {"new": {"id": "16b58d44-9bb |
| 51 | open_deal: no lead lock (a non-editor's open reaches the policy; the answer loses its hint) | caught | FAIL: "select public.open_deal('32702652-4e44-47ff-a135-ae739178820d')" gave 42501 (hint "", new row violates row-level security policy for  |
| 52 | Guard: the value bound not checked on a same-stage change (the CHECK answers with the row) | caught | FAIL: "update public.deals set value = 'NaN' where id = '09e23e74-6a58-47cf-b408-9a5a37ed28cc'" gave 23514 (hint "", new row for relation "d |
| 53 | Undo: a win undone without the Day 6 block check | caught | FAIL: "select pg_temp.mv('e6c10efe-226c-4a32-88cc-a154ee36fa84', 'lead', undo_of => 627)" succeeded, expected 42501 |
| 54 | Guard: a win that changes the shipping skips the Day 6 block check | caught | FAIL: "select pg_temp.mv('4d7f0777-61ee-46cc-8961-09f5006db08a', 'won', 700, 'direct_from_source')" succeeded, expected 42501 |
| 55 | Guard: reopening a won deal without the Day 6 block check | caught | FAIL: "select pg_temp.mv('2bc03c16-166e-4aff-81a9-ba7d877a2125', 'negotiations')" succeeded, expected 42501 |
| 56 | Guard: a shipping change on the same stage without the Day 6 block check | caught | FAIL: "select public.update_deal('49de9e1e-5abd-43c0-803d-2dbcce261a8f', 1, '{fulfilment}', p_fulfilment => 'direct_from_source')" succeeded |
| 57 | delete_deal: no Day 6 block check | caught | FAIL: "select public.delete_deal('016fcd18-2a0b-4783-9e57-94f774bd2630')" succeeded, expected 42501 |
| 58 | Guard: the open flood guard counts live deals only (since verifier round 2 the statement-level recount counts the open records) | caught incidentally (fixture volume in `deal_links_attack.sql` / `log_activity_interested_opens_deal`, user r1 `…05a1`); still a documented two-layer row; not counted as a new catch | too many deals opened in an hour |
| 59 | History trigger: no open record written | caught | FAIL: an open should remove its author's open records older than an hour |
| 60 | Open records: insert granted to clients | caught | FAIL: private.deal_opens protections |
| 61 | move_deal: no move record for an Undo with a request id (a repeated Undo is not a replay) | caught | FAIL: undo_replay_returns_stored {"deal": {"id": "880171dc-9ba9-4944-bad7-a25a0b4fc770", "city": null, "stage": "lead", "title": "Owned", "v |
| 62 | Guard: a deal's owner can be emptied on update (G11) | caught | FAIL: "update public.deals set owner_id = null where id = 'b83bf1ae-78ad-4e66-a854-fbc81a188950'" succeeded, expected 22023 |
| 63 | update_deal: no owner pre-check (the guard answers the same 22023 owner_required) | **NOT CAUGHT** (documented: two layers) | advisors: no ERROR-level findings |

## Verifier round 2 (12 Oct): rows 66 to 73 added, the flood rows re-run, on 2de7f9c

The verifier's second NOT READY report (N1, N2) showed that one statement with many rows passed both flood limits: the
guard counts before each row, but the open records and history rows are written by the AFTER row trigger at the end of
the statement. Two statement-level AFTER triggers now count again after the statement (`private.deal_open_flood`,
`private.deal_move_flood`; block 15 of `deals_attack.sql`). Rows 66 to 73 are new. Rows 27, 28 and 58 (the guard's own
counts) are now **documented two-layer rows**: with the guard's count removed, the statement-level recount refuses the
same statement with the same 22023 `rate_limited`, so no test can tell; rows 71, 72 and 73 remove both layers and are
caught. Rows 59 and 60 (the open record and its grants) were re-run because the recount reads the same table. Throwaway
worktree `scratchpad/wt-5a-mut2` on **2de7f9c** (code head 35d9b51), its `db-test.sh` copy on port 54362; the baseline
run passed first; 07:04 to 07:19 UTC; the worktree was removed afterwards. Every caught row's first failure was read: it
is the protection's own test. Row 68's first failure is block 15's hidden-history move (the first move of the block); a
separate run of row 68 with that one check taken out failed at `bulk_patch_over_move_limit_refused` (the 150-deal
PATCH "succeeded"), so the bulk test catches it on its own. `--anchors` on 2de7f9c: every anchor of the four sets found
once (day3b 37, day4a 104, day4b 94, day5a 73).

### day5a (13 rows run: 10 caught, 3 documented two-layer rows not caught, 0 not as listed)

| # | Protection removed | Result | First failure |
|---|---|---|---|
| 27 | Guard: no open flood guard (since verifier round 2 the statement-level recount answers the same rate_limited) | **NOT CAUGHT** (documented: two layers) | advisors: no ERROR-level findings |
| 28 | Guard: no stage-change flood guard (since verifier round 2 the statement-level recount answers the same rate_limited) | **NOT CAUGHT** (documented: two layers) | advisors: no ERROR-level findings |
| 58 | Guard: the open flood guard counts live deals only (since verifier round 2 the statement-level recount counts the open records) | **NOT CAUGHT** (documented: two layers) | advisors: no ERROR-level findings |
| 59 | History trigger: no open record written | caught | FAIL: an open should remove its author's open records older than an hour |
| 60 | Open records: insert granted to clients | caught | FAIL: private.deal_opens protections |
| 66 | Open flood: no statement-level recount (a bulk insert passes the 30-an-hour limit) | caught | FAIL: "insert into public.deals (company_id) select '7c45703f-9233-4a30-85b8-19ed1b89cccc'::uuid from generate_series(1, 31)" succeeded, exp |
| 67 | Open flood: the statement-level recount allows 31 an hour | caught | FAIL: "insert into public.deals (company_id) select '98dc376d-4278-4b1c-86fe-6cff76161110'::uuid from generate_series(1, 31)" succeeded, exp |
| 68 | Stage flood: no statement-level recount (a bulk PATCH passes the 120-a-minute limit) | caught | FAIL: "update public.deals set stage_id = private.stage_id('qualified') where id = '26e82057-7bec-43c8-843e-9398dd7bd699'" succeeded, expect |
| 69 | Stage flood: the statement-level recount is INVOKER (history on a deal handed on is not counted) | caught | FAIL: flood trigger function private.deal_move_flood() must be DEFINER, search_path empty, revoked from everyone |
| 70 | Stage flood: the statement-level recount runs for edits that change no stage | caught | too many stage changes in a minute |
| 71 | Open flood: no guard and no statement-level recount (both layers of row 27) | caught | FAIL: "select public.open_deal('b3dd9056-33f7-4ce4-b784-2cbbea2f6009')" succeeded, expected 22023 |
| 72 | Stage flood: no guard and no statement-level recount (both layers of row 28) | caught | FAIL: "update public.deals set stage_id = private.stage_id('qualified') where id = '08119296-a6ed-42de-8a1a-e91788b30515'" succeeded, expect |
| 73 | Open flood: the guard counts live deals only, and no statement-level recount (both layers of row 58) | caught | FAIL: "select public.open_deal('813aabb2-3aae-4696-b6e4-23e93f58c0c6')" succeeded, expected 22023 |

Whole day5a set after round 2: **73 rows: 66 caught, 7 documented two-layer rows (20, 24, 27, 28, 39, 58, 63), 0 not as
listed**.

## Verifier round 1 (12 Oct): rows 54 to 65 added, the rows whose code changed re-run, on acc2cf3

The verifier's NOT READY report (findings 1 to 8) changed `move_deal` (lead fields in scalars, an Undo's own move record),
the guard (the Day 6 block check when a win or an undo changes the shipping, the open flood guard counting
`private.deal_opens`, an owner never emptied on update), the history trigger (the open record), `update_deal` (owner
pre-check), `delete_deal` (the creator window follows the policy's undo-record condition) and the bidi escapes in every
regex. Rows 54 to 65 are new; the earlier rows whose code or anchor changed were re-run: 7, 11, 22, 27, 37, 44, 46, the
lead-coupling rows 23 to 26 (their edits now name the scalar lead fields), 53 (now caught by block 13's blocking stub)
and day4a 67 (the `task_guard` title regex, back to `\u` escapes). Throwaway worktree `scratchpad/wt-5a-mut` on
**acc2cf3** (code head 3c67877), its `db-test.sh` copy on port 54362; the baseline run passed first; 03:47 to 04:11 UTC.
Every caught row's first failure was read: it is the protection's own test. `--anchors` on acc2cf3: every anchor of the
four sets found once (day3b 37, day4a 104, day4b 94, day5a 65).

### day5a (24 rows run: 22 caught, 2 documented two-layer rows not caught, 0 not as listed)

| # | Protection removed | Result | First failure |
|---|---|---|---|
| 7 | Guard: reopening a won deal needs no fresh code | caught | FAIL: "update public.deals set stage_id = private.stage_id('lead') where id = 'e85770fe-997b-4a11-b074-22759e2fdb03'" succeeded, expected 42 |
| 11 | move_deal: no version compare | caught | FAIL: a stale move should be a conflict result {"deal": {"id": "1a2f999d-4d34-4df3-b9c7-d0cd5ebc462f", "city": null, "stage": "negotiations" |
| 22 | move_deal: locks the deal FOR UPDATE (blocks behind an entry's key lock; spike S8) | caught | canceling statement due to lock timeout |
| 23 | Lead coupling: a win overrides Do not contact | caught | FAIL: coupling_table won on a do_not_contact lead (editor t): got customer, expected do_not_contact |
| 24 | Lead coupling: without the editor lock (row level security on the lead update still stops it) | **NOT CAUGHT** (documented: two layers) | advisors: no ERROR-level findings |
| 25 | Lead coupling: without the editor lock, and move_deal runs as its owner (both layers) | caught | FAIL: RPC rules broken by {"move_deal(uuid,text,integer,numeric,text,text,text,bigint,uuid)"} |
| 26 | Undo: the lead put back whatever it holds now | caught | FAIL: undo_restores_lead_only_if_unchanged |
| 27 | Guard: no open flood guard | caught | FAIL: "select public.open_deal('4de74139-e951-4e0a-b1e5-7e364e97674f')" succeeded, expected 22023 |
| 37 | Guard: an admin's deal left without an owner (G11) | caught | FAIL: owner_defaults_to_creator |
| 44 | delete_deal: no fresh-code pre-check (no step_up hint) | caught | FAIL: "select public.delete_deal('07d6bd3d-b1d8-42f6-800f-b71578feafe1')" gave 42501 (hint "", only a manager or an admin can delete a deal) |
| 46 | list_stage_deals: half a cursor accepted | caught | FAIL: "select * from public.list_stage_deals('lead', p_after_at => now())" succeeded, expected 22023 |
| 53 | Undo: a win undone without the Day 6 block check | caught | FAIL: "select pg_temp.mv('d848c15f-b8a3-4404-8c62-11acfdfb2643', 'lead', undo_of => 626)" succeeded, expected 42501 |
| 54 | Guard: a win that changes the shipping skips the Day 6 block check | caught | FAIL: "select pg_temp.mv('898c2d9d-c930-4129-af3c-f0e9b287b519', 'won', 700, 'direct_from_source')" succeeded, expected 42501 |
| 55 | Guard: reopening a won deal without the Day 6 block check | caught | FAIL: "select pg_temp.mv('204069ec-252d-4bbb-bdf5-142d189f0edd', 'negotiations')" succeeded, expected 42501 |
| 56 | Guard: a shipping change on the same stage without the Day 6 block check | caught | FAIL: "select public.update_deal('ad4d3fa9-dd86-417f-aa24-803aaab03f41', 1, '{fulfilment}', p_fulfilment => 'direct_from_source')" succeeded |
| 57 | delete_deal: no Day 6 block check | caught | FAIL: "select public.delete_deal('3effef39-d9c9-478a-8b57-5e0255f53652')" succeeded, expected 42501 |
| 58 | Guard: the open flood guard counts live deals only (open and delete in turn is not counted) | caught | FAIL: "select public.open_deal('f7eb6619-28a1-4836-85b1-aaebb1f43468')" succeeded, expected 22023 |
| 59 | History trigger: no open record written | caught | FAIL: an open should remove its author's open records older than an hour |
| 60 | Open records: insert granted to clients | caught | FAIL: private.deal_opens protections |
| 61 | move_deal: no move record for an Undo with a request id (a repeated Undo is not a replay) | caught | FAIL: undo_replay_returns_stored {"deal": {"id": "df316dd8-e485-45d6-a4bc-43b51f78b407", "city": null, "stage": "lead", "title": "Owned", "v |
| 62 | Guard: a deal's owner can be emptied on update (G11) | caught | FAIL: "update public.deals set owner_id = null where id = '3f5c8714-d993-40ee-a66a-31e58bbc8c5f'" succeeded, expected 22023 |
| 63 | update_deal: no owner pre-check (the guard answers the same 22023 owner_required) | **NOT CAUGHT** (documented: two layers) | advisors: no ERROR-level findings |
| 64 | update_deal: no owner pre-check, and the guard lets the owner be emptied (both layers) | caught | FAIL: "select public.update_deal('9541c056-1369-4f04-8515-50121bba79eb', 0, '{owner_id}', p_owner => null)" succeeded, expected 22023 |
| 65 | delete_deal: the creator's window ignores the call's undo record (a refused delete answers P0002) | caught | FAIL: "select public.delete_deal('dbc326c4-9cd2-4fda-97b6-619bedb9830b')" gave P0002 (hint "", deal not found), expected 42501 (hint "step_u |

### day4a (1 row run: 1 caught)

| # | Protection removed | Result | First failure |
|---|---|---|---|
| 67 | Task guard: C1 controls pass the title pre-check | caught | FAIL: "insert into public.tasks (title) values ('PLANTED-SECRET |

**Rows 63 and 64:** `update_deal`'s owner pre-check answers the same 22023 `owner_required` as the guard, so removing it
alone changes nothing a test can see (documented: two layers); row 64 removes both and is caught. **Row 53** was a
documented two-layer row before this round ("the stub returns null, so no test can tell"); the verifier showed a
superuser can swap the stub inside a rolled-back block, which block 13 now does at every call site, so 53 is caught.

## day5a (first run, 53 rows): 49 caught, 4 documented two-layer rows, 0 not as listed (row 53 caught since round 1: 50 caught, 3 documented; with rows 54 to 65 the set is 65 rows: 61 caught, 4 documented two-layer rows (20, 24, 39, 63), 0 not as listed; with rows 66 to 73 (round 2) 73 rows: 66 caught, 7 documented (20, 24, 27, 28, 39, 58, 63))

Rows 1 to 33 follow the design's list (8.3: its rows 20 and 23 split into one row per layer, so the design's 21 to 31 are
rows 22, 23 and 26 to 33 here); rows 34 onward are the builder's additions.

| # | Protection removed | Result | Head | First failure |
|---|---|---|---|---|
| 1 | Grant update (status) on deals | caught | 8bd6e4b | FAIL: deal_update_columns_exact: {contact_id,expected_close,fulfilment,lost_note,lost_reason,owner_id,stage_id,status,title,value} |
| 2 | Grant update (stage_entered_at) on deals | caught | 8bd6e4b | FAIL: deal_update_columns_exact: {contact_id,expected_close,fulfilment,lost_note,lost_reason,owner_id,stage_entered_at,stage_id,title,value} |
| 3 | Guard: no value_required pre-check (the won-shape CHECK answers with the row) | caught | 8bd6e4b | FAIL: "select pg_temp.mv('a25957f2-427e-4c72-b6b2-34c80e7d67a5', 'won', null, 'from_stock')" gave 23514 (hint "", new row for relation "deal |
| 4 | Guard: no fulfilment_required pre-check (the won-shape CHECK answers with the row) | caught | 8bd6e4b | FAIL: "select pg_temp.mv('e7be9f2b-15b5-475b-b0d9-973e0d8223da', 'won', 10)" gave 23514 (hint "", new row for relation "deals" violates chec |
| 5 | Guard: no lost-reason pre-check (the hint test fails although the CHECK still raises) | caught | 8bd6e4b | FAIL: "update public.deals set stage_id = private.stage_id('lost') where id = 'c9730aca-39b8-43f3-877b-4121e6559f1c'" gave 23514 (hint "", n |
| 6 | Guard: won and lost reachable from a closed deal (no reopen_first) | caught | 8bd6e4b | FAIL: "update public.deals set stage_id = private.stage_id('lost'), lost_reason = 'timing' where id = 'aee8731e-6428-4a2b-b32b-ff2ccbec0ad4' |
| 7 | Guard: reopening a won deal needs no fresh code | caught | 8bd6e4b | FAIL: "update public.deals set stage_id = private.stage_id('lead') where id = 'c487a02a-3bfb-4960-910e-a2432038926b'" succeeded, expected 42 |
| 8 | Undo candidate: ignores who made the change | caught | 8bd6e4b | FAIL: reverse_by_other_user_is_ordinary_move / history_actor_forced {"deal": {"id": "bb519e17-e9ed-47f0-80d5-7577ff7e6754", "city": null, "s |
| 9 | Undo candidate: ignores the 120-second window | caught | 8bd6e4b | FAIL: transition_matrix qualified -> lead: {"deal": {"id": "5091d9ae-bf9b-4ede-aa33-bef82ba99f45", "city": null, "stage": "lead", "title": " |
| 10 | Undo candidate: ignores version_after (a colleague's change in between) | caught | 8bd6e4b | FAIL: reverse_after_colleague_edit_is_ordinary |
| 11 | move_deal: no version compare | caught | 8bd6e4b | FAIL: a stale move should be a conflict result {"deal": {"id": "90660c71-e0de-4697-a7e9-48a46419df98", "city": null, "stage": "negotiations" |
| 12 | History: insert granted to clients | caught | 8bd6e4b | FAIL: deal_stage_history grants |
| 13 | History: actor taken from the deal's owner | caught | 8bd6e4b | FAIL: reverse_by_other_user_is_ordinary_move / history_actor_forced {"deal": {"id": "08851ef4-7b29-4421-a35f-3026c473cd00", "city": null, "s |
| 14 | Delete policy: no fresh code for managers and admins | caught | 8bd6e4b | FAIL: deal_delete_stale_code_denied (direct) |
| 15 | Delete policy: the creator's branch without version = 0 (a moved deal deleted without a code) | caught | 8bd6e4b | FAIL: a moved deal was deleted directly without a code |
| 16 | Deals: lead FK back to set null | caught | 8bd6e4b | FAIL: lead FK restrict, company_id not null, tasks.deal_id set null |
| 17 | Tasks: deal FK back to cascade | caught | 8bd6e4b | FAIL: lead FK restrict, company_id not null, tasks.deal_id set null |
| 18 | Task guard: deal_id not in the link-emptying exception | caught | 8bd6e4b | this part of a task cannot change |
| 19 | Stages: the admin update policy and grant restored | caught | 8bd6e4b | FAIL: stage_write_denied_even_admin (grants or policies) |
| 20 | Value CHECK: no NaN term (the 100,000,000 bound refuses NaN too: NaN sorts above every number) | **NOT CAUGHT** (documented: two layers) | 8bd6e4b | advisors: no ERROR-level findings |
| 21 | Value CHECK: no NaN term and no bound (both layers of the backstop) | caught | 8bd6e4b | FAIL: a deal CHECK let this through: insert into public.deals (org_id, company_id, stage_id, value) values ('a2802d7e-5fc0-4531-b3e6-cd79231 |
| 22 | move_deal: locks the deal FOR UPDATE (blocks behind an entry's key lock; spike S8) | caught | 8bd6e4b | canceling statement due to lock timeout |
| 23 | Lead coupling: a win overrides Do not contact | caught | 8bd6e4b | FAIL: coupling_table won on a do_not_contact lead (editor t): got customer, expected do_not_contact |
| 24 | Lead coupling: without the editor lock (row level security on the lead update still stops it) | **NOT CAUGHT** (documented: two layers) | 8bd6e4b | advisors: no ERROR-level findings |
| 25 | Lead coupling: without the editor lock, and move_deal runs as its owner (both layers) | caught | 8bd6e4b | FAIL: RPC rules broken by {"move_deal(uuid,text,integer,numeric,text,text,text,bigint,uuid)"} |
| 26 | Undo: the lead put back whatever it holds now | caught | 8bd6e4b | FAIL: undo_restores_lead_only_if_unchanged |
| 27 | Guard: no open flood guard | caught | 8bd6e4b | FAIL: "select public.open_deal('61fd0418-0348-4bbb-bb97-b27096e09211')" succeeded, expected 22023 |
| 28 | Guard: no stage-change flood guard | caught | 8bd6e4b | FAIL: "update public.deals set stage_id = private.stage_id('qualified') where id = '9cb070a2-aed3-40a9-904a-4110ed849a62'" succeeded, expect |
| 29 | Deals: request id index not unique | caught | 8bd6e4b | FAIL: "insert into public.deals (company_id, request_id) values ('4931276b-6f22-47bb-b732-42157addf0ef', 'ce154fb2-8daf-437e-b8b4-6e4682ddaf |
| 30 | Column keyset: <= instead of < (a deal repeated across pages) | caught | 8bd6e4b | FAIL: list_stage_keyset_stable (recent team): 61 rows |
| 31 | pipeline_board: a rep's team is not mapped to their own deals (42501 on first paint) | caught | 8bd6e4b | only managers and admins see the team's deals |
| 32 | Guard: an invisible stage answers P0002 instead of 42501 | caught | 8bd6e4b | this stage is not one of your pipeline's |
| 33 | Guard: a lost note change is not a change (no version, no check) | caught | 8bd6e4b | FAIL: "update public.deals set lost_note = 'quiet edit' where id = '3fc5c311-1583-47c4-bd59-57f1fe6b1f48'" succeeded, expected 22023 |
| 34 | Undo: the value is not restored from history (the client's or the won value stays) | caught | 8bd6e4b | FAIL: undo_restores_clock_close_value_fulfilment {"deal": {"id": "0ca63266-b493-4fdd-ab8d-2fcbc6ec086e", "city": null, "stage": "negotiation |
| 35 | Guard: no Do not contact check on insert | caught | 8bd6e4b | FAIL: "select public.open_deal('8046c276-415c-40a3-af09-2a6a22f467b9')" succeeded, expected 22023 |
| 36 | Guard: created_by left to the client (empty) | caught | 8bd6e4b | duplicate key value violates unique constraint "deal_moves_request_idx" |
| 37 | Guard: an admin's deal left without an owner (G11) | caught | 3a21018 | FAIL: owner_defaults_to_creator |
| 38 | Guard: a closed deal's value, shipping and dates editable | caught | 8bd6e4b | FAIL: "update public.deals set value = 1 where id = 'fd7ba502-016f-4f9b-8de4-cbffcf4b6360'" succeeded, expected 22023 |
| 39 | Guard: the client's stage clock kept on insert (no insert grant on it, and its default is now()) | **NOT CAUGHT** (documented: two layers) | 3a21018 | advisors: no ERROR-level findings |
| 40 | Guard: the client's stage clock kept on insert, and granted (both layers) | caught | 3a21018 | FAIL: deal_insert_columns_exact: {company_id,contact_id,expected_close,fulfilment,owner_id,request_id,source_activity_id,stage_entered_at,ti |
| 41 | Deals select: no organisation check | caught | 8bd6e4b | FAIL: admin should see both reps' files, nothing from the other org |
| 42 | History select: no deal visibility (a colleague's deal history readable) | caught | 8bd6e4b | FAIL: rep_get_other_deal_null |
| 43 | Move records: a row for another person's change | caught | 8bd6e4b | FAIL: "insert into private.deal_moves (history_id, org_id, user_id, deal_id, company_id) select 499, org_id, '00000000-0000-0000-0000-000000 |
| 44 | delete_deal: no fresh-code pre-check (no step_up hint) | caught | 8bd6e4b | FAIL: "select public.delete_deal('b2bb6955-b823-471f-96a8-2b2a8b086266')" gave 42501 (hint "", only a manager or an admin can delete a deal) |
| 45 | update_deal: no field whitelist | caught | 8bd6e4b | FAIL: "select public.update_deal('13e3c43e-d049-446b-8a86-e5cd30dd611e', 2, '{title,status}', 'x')" succeeded, expected 22023 |
| 46 | list_stage_deals: half a cursor accepted | caught | 8bd6e4b | FAIL: "select * from public.list_stage_deals('lead', p_after_at => now())" succeeded, expected 22023 |
| 47 | Cards: stalled ignores the lead's last activity | caught | 8bd6e4b | FAIL: stall case "lead/720/1/false/0" in UTC: stalled t, quiet 0 |
| 48 | Lead coupling: a loss rests the lead although another deal is open | caught | 8bd6e4b | FAIL: coupling_table lost_other_open on a warm lead (editor t): got cool_off, expected warm |
| 49 | Audit: the version diffed | caught | 8bd6e4b | FAIL: audit_version_not_diffed / audit_lost_note_masked |
| 50 | Audit: the lost note copied | caught | 8bd6e4b | FAIL: audit_deal_insert_update_delete_rows / audit_deal_value_change_logged / audit_lost_note_masked: [{"diff": {"new": {"id": "9b33e9ed-a73 |
| 51 | open_deal: no lead lock (a non-editor's open reaches the policy; the answer loses its hint) | caught | 8bd6e4b | FAIL: "select public.open_deal('01eb374f-5938-4745-bbfe-edcd076bfd72')" gave 42501 (hint "", new row violates row-level security policy for |
| 52 | Guard: the value bound not checked on a same-stage change (the CHECK answers with the row) | caught | 8bd6e4b | FAIL: "update public.deals set value = 'NaN' where id = 'cf7bda53-483c-449e-9ba4-91514cf0624e'" gave 23514 (hint "", new row for relation "d |
| 53 | Undo: a win undone without the Day 6 block check | **NOT CAUGHT** on 8bd6e4b (then listed as two layers); **caught** on acc2cf3 (round 1: block 13's blocking stub) | 8bd6e4b, acc2cf3 | 8bd6e4b: advisors: no ERROR-level findings; acc2cf3: see the round 1 table |

**The documented two-layer rows** (20, 24, 39; since round 1, 63; since round 2, 27, 28 and 58; 53 was one until round 1)

- **20** `deals_value_bounds` without its NaN term: the bound `value <= 100000000` refuses NaN too (NaN sorts above
  every number, spike S6). Row 21 removes both and the superuser CHECK probe in block 0 catches it.
- **24** `move_deal` without the editor lock: the lead update still runs under the companies policy, which gives a
  non-editor 0 rows, so the lead is untouched (the reason D15 put the coupling in an INVOKER RPC). Row 25 (also SECURITY
  DEFINER) is caught.
- **39** the guard keeping the client's stage clock on insert: there is no insert grant on `stage_entered_at`, and its
  default is `now()`. Row 40 (with the grant) is caught.
- **53** (until round 1) undoing a win without the Day 6 block check: listed as "the stub returns null, so no test can
  tell". Wrong: block 13 of `deals_attack.sql` swaps in a stub returning `'order'` inside a rolled-back block, and row 53
  is caught since round 1.
- **63** `update_deal` without its owner pre-check: the guard answers the same 22023 `owner_required`. Row 64 (both) is
  caught.
- **27, 28, 58** (since round 2) the guard's open and stage-change counts (removed, or for 58 counting live deals): the
  statement-level recount after the statement refuses the same statement with the same 22023 `rate_limited`, and the
  statement is rolled back either way. Rows 71, 72 and 73 remove both layers and are caught. The guard's count stays as
  the early refusal (before any row is written); the recount is the one that holds for multi-row statements.

## Earlier sets: the rows re-aimed at the Day 5a copies of `audit_row` and `task_guard` (8bd6e4b)

Day 5a recreates `private.audit_row` (from Day 4b's body) and `private.task_guard` (from Day 4a's), so the earlier rows
that mutated those functions now edit the live Day 5a copies (`Region` targets; rows whose text Day 5a changed have their
own Day 5a edit in `OVERRIDES_5A`). All 36 re-aimed rows were run: all caught. Every other earlier row is unchanged and
its anchor is still found exactly once (`python3 scripts/db-mutations.py --anchors`: day3b 37, day4a 104, day4b 94,
day5a 53 anchors found on 3a21018), so their last full results stand (Day 4b README: 94 of 94; Day 4a: 102 caught and 2
documented; Day 3b: 36 caught and 1 documented).

### day3b

| # | Protection removed | Result | First failure |
| 28 | Audit: full copy of imported leads | caught | FAIL: imported leads should each have one small audit row |
| 29 | Audit: search and key columns kept | caught | FAIL: search_text copied into the audit log |

### day4a

| # | Protection removed | Result | First failure |
| 9 | Audit: a deleted entry keeps its text | caught | FAIL: a deleted entry should be audited without its text, with its length: {"id": "6c05f762-9e22-401b-8afc-6c7dd5c16b85", "body": "AUDIT-MAR |
| 11 | Task guard: keeps the client's done_at | caught | FAIL: done takes the server's time and the caller: {"done_at":"2000-01-01T00:00:00+00:00","completed_by":"00000000-0000-0000-0000-0000000000 |
| 12 | Task guard: the source entry need not be the caller's | caught | FAIL: "insert into public.tasks (company_id, title, source_activity_id) values ('32000000-0000-0000-0000-0000000000b1', 'Not mine', 'ff6a281 |
| 14 | Task guard: no flood guard | caught | FAIL: "insert into public.tasks (title) values ('One too many')" succeeded, expected 22023 |
| 32 | Audit: an edit keeps the text | caught | FAIL: an edit should be audited as the text's lengths and edited_at: {"body": {"new": "AUDIT-MARKER second, longer words", "old": "AUDIT-MAR |
| 33 | Audit: new entries copied | caught | FAIL: an activity insert was copied into the audit log |
| 35 | Task guard: no link-emptying exception (a contact delete must then fail) | caught | this part of a task cannot change |
| 36 | Task guard: link-emptying exception without the depth condition | caught | FAIL: "update public.tasks set created_by = null where id = '392b28b0-6ff7-4863-a309-63070d9f20f6'" succeeded, expected 42501 |
| 37 | Task guard: link-emptying exception without created_by (the design's list: a person delete fails) | caught | this part of a task cannot change |
| 38 | Task guard: fixed fields editable | caught | FAIL: "insert into pg_temp.depth2 values ('update public.tasks set created_by = ''00000000-0000-0000-0000-0000000000b1'' where title = ''For |
| 39 | Task guard: creator left to the client | caught | FAIL: "insert into public.tasks (title) values ('One too many')" succeeded, expected 22023 |
| 40 | Task guard: done, completed by and dismissed kept from the client on insert | caught | new row for relation "tasks" violates check constraint "tasks_not_done_and_cancelled" |
| 41 | Task guard: no assignee left empty for an admin | caught | FAIL: a task with no assignee should be its creator's |
| 42 | Task guard: a done task takes a new client time | caught | FAIL: a done task took a client time |
| 43 | Task guard: completed_by changes without done | caught | FAIL: completed_by changed without done_at |
| 44 | Task guard: dismissed takes the client's time | caught | FAIL: dismissing takes the server's time |
| 45 | Task guard: a dismissed task takes a new client time | caught | FAIL: a dismissed task took a client time |
| 46 | Task guard: no done-and-dismissed pre-check | caught | FAIL: "update public.tasks set cancelled_at = now() where id = 'ad4c5a9e-fe44-49b6-83ad-0baeb8c01794'" gave 23514 (hint ""), expected 22023  |
| 47 | Task guard: no title pre-check | caught | FAIL: a personal task (trimmed title, no lead, kind todo) |
| 48 | Task guard: no kind pre-check | caught | FAIL: "insert into public.tasks (title, kind) values ('PLANTED-SECRET', 'chore')" gave 23514 (hint ""), expected 22023 (hint "task_kind") |
| 49 | Task guard: no date-or-time pre-check | caught | FAIL: "insert into public.tasks (title, due_date, due_at) values ('PLANTED-SECRET', current_date, now())" gave 23514 (hint ""), expected 220 |
| 50 | Task guard: no meeting-time pre-check | caught | FAIL: "insert into public.tasks (title, kind) values ('PLANTED-SECRET', 'meeting')" gave 23514 (hint ""), expected 22023 (hint "task_due") |
| 51 | Task guard: dates not bounded | caught | FAIL: "insert into public.tasks (title, due_date) values ('PLANTED-SECRET', current_date + 2000)" succeeded, expected 22023 |
| 52 | Task guard: dates checked even when unchanged (overdue tasks stuck) | caught | the date is out of range |
| 53 | Task guard: the source entry may be on another lead | caught | FAIL: "insert into public.tasks (company_id, title, source_activity_id) values ('32000000-0000-0000-0000-0000000000d1', 'Elsewhere', 'f10d72 |
| 54 | Task guard: the source entry may be of any age | caught | FAIL: "insert into public.tasks (company_id, title, source_activity_id) values ('32000000-0000-0000-0000-0000000000b1', 'Old', '52000000-000 |
| 67 | Task guard: C1 controls pass the title pre-check | caught | FAIL: "insert into public.tasks (title) values ('PLANTED-SECRET |
| 77 | Task guard: link-emptying exception lets a link move to another record (depth 2) | caught | FAIL: "insert into pg_temp.depth2 values ('update public.tasks set created_by = ''00000000-0000-0000-0000-0000000000b1'' where title = ''For |
| 78 | Task guard: link-emptying exception lets any column change (depth 2) | caught | FAIL: "insert into pg_temp.depth2 values ('update public.tasks set kind = ''call'' where title = ''For Fay''')" succeeded, expected 42501 |
| 81 | Task guard: flood window of one second (60 a second) | caught | FAIL: "insert into public.tasks (title) values ('One too many')" succeeded, expected 22023 |
| 82 | Task guard: flood window of two minutes | caught | too many tasks in a minute |
| 83 | Audit: a deleted entry without its length (D8) | caught | FAIL: a deleted entry should be audited without its text, with its length: {"id": "279b4d3d-0b89-45a3-af2f-0aba12604738", "type": "note", "o |
| 104 | Task guard: flood window of 45 seconds | caught | FAIL: "insert into public.tasks (title) values ('One too many')" succeeded, expected 22023 |

### day4b

| # | Protection removed | Result | First failure |
| 47 | Audit: next call and marks diffed | caught | FAIL: audit of an outcome |
