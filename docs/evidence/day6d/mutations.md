# Day 6d mutations

`python3 scripts/db-mutations.py --set day6d` in a throwaway worktree (`git worktree add --detach`, removed afterwards)
whose `scripts/db-test.sh` copy listens on port 54382 (the real script's port is unchanged). Each row edits the live
definition (edits reach later redefinitions through `REDEFINERS`), runs the whole `db-test.sh` (every attack and
concurrency suite, advisors) and restores the migration. Design rows 27 to 36 plus the build's own protections; a
protection with two layers is also removed together with its second layer.

## Final run (code 1b78186, the 6d database as merged into this branch)

| # | Protection removed | Result | First failure |
|---|---|---|---|
| 1 | A sale ignores other clients' holds (no held-above-on-hand rule for ship; the CHECK fires instead) [design 27] | caught | FAIL: "select public.record_sale('5a000000-0000-0000-0000-0000000000b1', 'from_stock', |
| 2 | A sale may use any lead's holds (not only its own lead's) [design 27] | caught | FAIL: record_sale_partial_hold_use: the holds are active:15,active:20,fulfilled:0 |
| 3 | Reps sell below the minimum price (record_sale and the line guard, both layers) [design 28] | caught | FAIL: "select public.record_sale('5a000000-0000-0000-0000-0000000000b1', 'from_stock', |
| 4 | Reps sell below the minimum price in record_sale (the line guard refuses the same line) [design 28] | caught | FAIL: "select public.record_sale('5a000000-0000-0000-0000-0000000000b1', 'from_stock', |
| 5 | Reps write a line below the minimum price (the line guard; the table path) [design 28] | caught | FAIL: "insert into private.order_lines (order_id, position, product_id, product_name, quantity, unit_price) |
| 6 | The deal-lost trigger is dropped (a lost deal keeps its holds) [design 29] | caught | FAIL: release_deal_holds_lost must have no column list |
| 7 | The import undo misses sales (a lead with a sale counts as untouched) [design 30] | caught | FAIL: lead_import_untouched_counts_stock |
| 8 | A stock sheet opens Restock tasks [design 31] | caught | FAIL: low_stock_not_from_import (on hand 10) |
| 9 | System tasks keep the caller's claims (the rep becomes the creator) [design 32] | caught | reps can only create records they own |
| 10 | System tasks do not put the caller's claims back [design 33] | caught | new row violates row-level security policy for table "stock_movements" |
| 11 | A sale line may ship twice (no unique ship index) [design 34] | caught | FAIL: "insert into private.stock_movements (group_id, product_id, location_id, kind, qty, order_line_id) |
| 12 | Undo after 120 s without a code (record_sale's check and the order guard, both layers) [design 35] | caught | FAIL: "select public.undo_sale('2bb5fa1f-2f5f-448c-9ecd-08dbe3897b34')" succeeded, expected 22023 |
| 13 | Undo window in undo_sale only (the order guard still refuses: forbidden instead of undo_window) [design 35] | caught | FAIL: "select public.undo_sale('fccfc2fa-8864-4917-a3fc-083720215be0')" gave 42501 (hint "forbidden", only managers and admins cancel a sale |
| 14 | Undo window in the order guard only (a direct cancel by the creator after 120 s) [design 35] | caught | FAIL: "update private.orders set status = 'cancelled', cancel_reason = 'undo' where id = '56e1c630-57c4-465b-a2dc-b5998ba88369'" succeeded,  |
| 15 | task_guard without the new links in its cascade exception [design 36] | **NOT CAUGHT** (documented: two layers) | advisors: no ERROR-level findings |
| 16 | task_guard lets a client change a system link (the column grant refuses it first: two layers) | **NOT CAUGHT** (documented: two layers) | advisors: no ERROR-level findings |
| 17 | A sale line may be added to someone else's (or an earlier) sale | caught | FAIL: "insert into private.order_lines (order_id, position, product_id, product_name, quantity, unit_price) |
| 18 | A ship row needs no sale recorded now by the caller | caught | FAIL: "insert into private.stock_movements (group_id, product_id, location_id, kind, qty, order_line_id) |
| 19 | record_sale does not lock the lead (a non-editor may sell) | caught | FAIL: "select public.record_sale('5a000000-0000-0000-0000-0000000000d1', 'from_stock', |
| 20 | Undo does not put back the holds a sale used | caught | FAIL: undo_sale_restores_consumed_hold: {"status": "cancelled", "order_id": "fa365fb0-59f4-4a4f-a4ca-a5c76d73692f", "holds_restored": 0} (65 |
| 21 | The audit keeps a request's note | caught | FAIL: stock_request_note_masked_in_audit |
| 22 | A hold's whole row is writable by its editor (no extend guard) | caught | FAIL: hold write columns are {hold_until,remaining} |

day6d: 22 rows run: 20 caught, 2 documented two-layer rows not caught, 0 not as listed

The two rows not caught are documented two-layer rows: `task_guard`'s cascade exception and its "system links never
change" rule each stand behind the column grants on `public.tasks` (a client cannot name `source_product_id` or
`source_request_id` in an update at all), so removing either alone changes nothing a client can reach.

## Earlier runs

- Round 1 (code 2c5ee1c): 22 rows, 19 caught, 1 documented, 2 not as listed. Row 4 (reps below the minimum in
  `record_sale` only) was listed as a two-layer row but is caught: `record_sale` refuses before the line guard, with
  its own code (the test checks the hint). Row 16 (`task_guard` lets a client change a system link) was listed as
  caught but stands behind the column grant. The list was corrected (637b0a5) and both rows re-run: as listed.

## Re-runs of earlier days' rows whose functions 6d redefines (code 1b78186)

Every Day 3b, 4a and 6a row whose edit reaches a 6d redefinition (`lead_import_untouched`, `task_guard`, the stock
guard and apply step; found with `mirrored_edits`): 59 rows, all as listed.

### day3b

| # | Protection removed | Result | First failure |
|---|---|---|---|
| 18 | Undo: leads with an activity count as untouched | caught | FAIL: undo preview {"kept": 4, "tagged": 6, "removable": 2} |
| 19 | Undo: leads with a contact count as untouched | caught | FAIL: undo preview {"kept": 4, "tagged": 6, "removable": 2} |
| 20 | Undo: leads with a deal count as untouched | caught | FAIL: undo preview {"kept": 4, "tagged": 6, "removable": 2} |
| 21 | Undo: edited leads count as untouched | caught | FAIL: undo preview {"kept": 4, "tagged": 6, "removable": 2} |

day3b: 4 rows run: 4 caught, 0 documented two-layer rows not caught, 0 not as listed

### day4a

| # | Protection removed | Result | First failure |
|---|---|---|---|
| 10 | Import undo: leads with a task count as untouched | caught | FAIL: undo preview with a task {"kept": 0, "tagged": 2, "removable": 2} |
| 11 | Task guard: keeps the client's done_at | caught | FAIL: done takes the server's time and the caller: {"done_at":"2000-01-01T00:00:00+00:00","completed_by":"00000000-0000-0000-0000-0000000000 |
| 12 | Task guard: the source entry need not be the caller's | caught | FAIL: "insert into public.tasks (company_id, title, source_activity_id) values ('32000000-0000-0000-0000-0000000000b1', 'Not mine', '1e68895 |
| 14 | Task guard: no flood guard | caught | FAIL: "insert into public.tasks (title) values ('One too many')" succeeded, expected 22023 |
| 38 | Task guard: fixed fields editable | caught | FAIL: "insert into pg_temp.depth2 values ('update public.tasks set created_by = ''00000000-0000-0000-0000-0000000000b1'' where title = ''For |
| 39 | Task guard: creator left to the client | caught | FAIL: "insert into public.tasks (title) values ('One too many')" succeeded, expected 22023 |
| 40 | Task guard: done, completed by and dismissed kept from the client on insert | caught | new row for relation "tasks" violates check constraint "tasks_not_done_and_cancelled" |
| 41 | Task guard: no assignee left empty for an admin | caught | FAIL: a task with no assignee should be its creator's |
| 42 | Task guard: a done task takes a new client time | caught | FAIL: a done task took a client time |
| 43 | Task guard: completed_by changes without done | caught | FAIL: completed_by changed without done_at |
| 44 | Task guard: dismissed takes the client's time | caught | FAIL: dismissing takes the server's time |
| 45 | Task guard: a dismissed task takes a new client time | caught | FAIL: a dismissed task took a client time |
| 46 | Task guard: no done-and-dismissed pre-check | caught | FAIL: "update public.tasks set cancelled_at = now() where id = 'be721d97-d58e-4eb6-8a91-b892dd232e90'" gave 23514 (hint ""), expected 22023  |
| 47 | Task guard: no title pre-check | caught | FAIL: a personal task (trimmed title, no lead, kind todo) |
| 48 | Task guard: no kind pre-check | caught | FAIL: "insert into public.tasks (title, kind) values ('PLANTED-SECRET', 'chore')" gave 23514 (hint ""), expected 22023 (hint "task_kind") |
| 49 | Task guard: no date-or-time pre-check | caught | FAIL: "insert into public.tasks (title, due_date, due_at) values ('PLANTED-SECRET', current_date, now())" gave 23514 (hint ""), expected 220 |
| 50 | Task guard: no meeting-time pre-check | caught | FAIL: "insert into public.tasks (title, kind) values ('PLANTED-SECRET', 'meeting')" gave 23514 (hint ""), expected 22023 (hint "task_due") |
| 51 | Task guard: dates not bounded | caught | FAIL: "insert into public.tasks (title, due_date) values ('PLANTED-SECRET', current_date + 2000)" succeeded, expected 22023 |
| 52 | Task guard: dates checked even when unchanged (overdue tasks stuck) | caught | the date is out of range |
| 53 | Task guard: the source entry may be on another lead | caught | FAIL: "insert into public.tasks (company_id, title, source_activity_id) values ('32000000-0000-0000-0000-0000000000d1', 'Elsewhere', '5c7902 |
| 54 | Task guard: the source entry may be of any age | caught | FAIL: "insert into public.tasks (company_id, title, source_activity_id) values ('32000000-0000-0000-0000-0000000000b1', 'Old', '52000000-000 |
| 67 | Task guard: C1 controls pass the title pre-check | caught | FAIL: "insert into public.tasks (title) values ('PLANTED-SECRET |
| 81 | Task guard: flood window of one second (60 a second) | caught | FAIL: "insert into public.tasks (title) values ('One too many')" succeeded, expected 22023 |
| 82 | Task guard: flood window of two minutes | caught | too many tasks in a minute |
| 104 | Task guard: flood window of 45 seconds | caught | FAIL: "insert into public.tasks (title) values ('One too many')" succeeded, expected 22023 |

day4a: 25 rows run: 25 caught, 0 documented two-layer rows not caught, 0 not as listed

### day6a

| # | Protection removed | Result | First failure |
|---|---|---|---|
| 1 | No FOR UPDATE on the levels (two people take the last pieces) [design 1] | caught | 40P01: deadlock detected |
| 2 | No held-above-on-hand rule in the apply step and no CHECK backstop (both layers) [design 2] | caught | FAIL: "select pg_temp.mv('7a000000-0000-0000-0000-000000000001', 'reserve', 97, company => '33000000-0000-0000-0000-0000000000b1')" succeede |
| 3 | No held-above-on-hand rule in the apply step (the CHECK fires instead of a constant error) [design 2] | caught | FAIL: "select pg_temp.mv('7a000000-0000-0000-0000-000000000001', 'reserve', 97, company => '33000000-0000-0000-0000-0000000000b1')" gave 235 |
| 7 | No fresh code for corrections (adjust, count, receive) [design 5] | caught | FAIL: "select pg_temp.mv('7a000000-0000-0000-0000-000000000005', 'adjust_out', 1, reason => 'damaged')" succeeded, expected 42501 |
| 8 | No lead-editor check for a hold [design 6] | caught | FAIL: "select pg_temp.mv('7a000000-0000-0000-0000-000000000003', 'reserve', 5, company => '33000000-0000-0000-0000-0000000000a1')" succeeded |
| 9 | No deal-on-this-lead check, guard and apply step (both layers) [design 7] | caught | FAIL: "select pg_temp.mv('7a000000-0000-0000-0000-000000000003', 'reserve', 5, company => '33000000-0000-0000-0000-0000000000b1', deal => '4 |
| 10 | No deal-on-this-lead check in the guard (the apply step checks it again) [design 7] | **NOT CAUGHT** (documented: two layers) | advisors: no ERROR-level findings |
| 11 | No deal-on-this-lead check in the apply step (the guard checks it first) [design 7] | **NOT CAUGHT** (documented: two layers) | advisors: no ERROR-level findings |
| 12 | Levels locked in the opposite order [design 8] | caught | 40P01: deadlock detected |
| 13 | Arrived moves unheld pieces first [design 9] | caught | FAIL: transfer_moves_held_pieces_first: {"moved": 5, "levels": [{"on_hand": 805, "location": "warehouse", "reserved": 800, "available": 5},  |
| 15 | The guard trusts any current_user [design 11] | caught | FAIL: "insert into private.stock_movements (group_id, product_id, location_id, kind, |
| 16 | No FOR SHARE on the product in the apply step (archive racing a receipt) [design 12] | caught | FAIL: archive_vs_receive_race (b): stock was received into a product being archived |
| 17 | crm_moved worked out from ledger ids instead of under the lock [design 13] | caught | FAIL: holds must not mark a level as moved in the CRM |
| 19 | Rate guard at 10,000 a minute [design 15] | caught | FAIL: "select pg_temp.mv('7a000000-0000-0000-0000-000000000007', 'reserve', 1, |
| 23 | A transfer_in may reuse a departure that already arrived (guard and unique index, both layers) | caught | FAIL: "insert into private.stock_movements (group_id, product_id, location_id, kind, qty, pair_id) |
| 24 | No not-paired-yet check in the guard (the unique index refuses with 23505 instead of a constant error) | caught | FAIL: "insert into private.stock_movements (group_id, product_id, location_id, kind, qty, pair_id) |
| 27 | A hold for a deal does not lock the deal in the apply step (a hold inserted straight into the ledger keeps its lost deal's hold) | caught | FAIL: reserve_vs_deal_lost (d): a lost deal kept an active hold |
| 31 | No archived-product check in the guard (the apply step checks it again under the lock) | **NOT CAUGHT** (documented: two layers) | advisors: no ERROR-level findings |
| 32 | No archived-product check under the lock (archive racing a receipt) | caught | FAIL: archive_vs_receive_race (b): stock was received into a product being archived |
| 33 | No same-organisation check on the place in the guard (the places policy hides other organisations' places) | **NOT CAUGHT** (documented: two layers) | advisors: no ERROR-level findings |
| 34 | A transfer_out may leave from the warehouse | caught | FAIL: "insert into private.stock_movements (group_id, product_id, location_id, kind, qty, reason) |
| 35 | Anyone may release a hold | caught | FAIL: "select pg_temp.mv('7a000000-0000-0000-0000-000000000003', 'release', reservation => '68bd9531-f5d8-428e-9fe4-48206eafaf0d')" succeede |
| 36 | No end-date check for a hold in the guard (a direct insert) | caught | FAIL: "insert into private.stock_movements (group_id, product_id, location_id, kind, qty, |
| 37 | No note pre-check in the guard (the CHECK would put the note in the error) | caught | FAIL: "insert into private.stock_movements (group_id, product_id, location_id, kind, qty, reason, note) values |
| 47 | Import undo does not count holds (it would try to delete a lead with stock history) | caught | FAIL: undo preview with a hold {"kept": 0, "tagged": 2, "removable": 2} |
| 52 | No not-enough-stock rule in the apply step (the CHECK fires instead of a constant error) | caught | FAIL: "select pg_temp.mv('7a000000-0000-0000-0000-000000000001', 'adjust_out', 97, reason => 'lost')" gave 22023 (hint "below_reserved", sto |
| 59 | Reps correct stock (no manager check for receive, adjust and count in the guard) | caught | FAIL: "select pg_temp.mv('7a000000-0000-0000-0000-000000000005', 'receive', 1, reason => 'received')" succeeded, expected 42501 |
| 60 | A person may post an expire row | caught | FAIL: "insert into private.stock_movements (group_id, product_id, location_id, kind, |
| 62 | A place of another organisation is accepted (no same-organisation check and places readable by everyone, both layers) | caught | FAIL: "insert into private.stock_movements (group_id, product_id, location_id, kind, qty, reason) |
| 66 | The rate guard counts the system's deal-lost release rows | caught | FAIL: rate_guard_skips_deal_lost_releases: a row of g's was refused: too many stock changes in a minute |

day6a: 30 rows run: 26 caught, 4 documented two-layer rows not caught, 0 not as listed

