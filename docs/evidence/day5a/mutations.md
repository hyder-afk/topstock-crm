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
8bd6e4b and 3a21018; the tests changed only in the null-safe comparisons of 3a21018.

Run history (recorded, not hidden): the first run (on 4782724) was stopped at row 30: with the keyset mutation (`<=`) the
paging test looped for ever. The test now bounds its loop (96b3579). A second start stopped at its baseline: the 3-session
random run met an "unchanged" answer (a colleague had just moved the deal to that stage), a valid outcome the script now
accepts (8bd6e4b). Row 37 was first NOT CAUGHT on 8bd6e4b: the test compared `owner_id <> admin`, which is null, not
true, for an empty owner; the test file now uses null-safe comparisons for every column a mutation can empty.

## day5a (53 rows): 49 caught, 4 documented two-layer rows, 0 not as listed

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
| 53 | Undo: a win undone without the Day 6 block check | **NOT CAUGHT** (documented: two layers) | 8bd6e4b | advisors: no ERROR-level findings |

**The four documented two-layer rows**

- **20** `deals_value_bounds` without its NaN term: the bound `value <= 100000000` refuses NaN too (NaN sorts above
  every number, spike S6). Row 21 removes both and the superuser CHECK probe in block 0 catches it.
- **24** `move_deal` without the editor lock: the lead update still runs under the companies policy, which gives a
  non-editor 0 rows, so the lead is untouched (the reason D15 put the coupling in an INVOKER RPC). Row 25 (also SECURITY
  DEFINER) is caught.
- **39** the guard keeping the client's stage clock on insert: there is no insert grant on `stage_entered_at`, and its
  default is `now()`. Row 40 (with the grant) is caught.
- **53** undoing a win without the Day 6 block check: `deal_closing_blocked` returns null in 5a, so no test can tell; Day 6
  replaces the stub and its own tests cover the seam (design section 10).

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
