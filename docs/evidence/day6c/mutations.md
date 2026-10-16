# Day 6c mutations

`python3 scripts/db-mutations.py --set day6c` in a throwaway worktree (`git worktree add --detach`, removed afterwards)
whose `scripts/db-test.sh` copy listens on port 54382 (the real script's port is unchanged). Each row edits the live
definition, runs the whole `db-test.sh` (every attack and concurrency suite, advisors) and restores the migration.

The script now also mirrors an edit into any later migration that redefines (create or replace) the function holding
the text (`REDEFINERS`, `mirrored_edits`): Day 6a redefines the lead import "untouched" rule and Day 6c the batch guard,
the stock guard, the apply step and the nightly job, so the Day 3b, 4a and 6a rows that edit those functions reach the
live definition. Day 3b's "one import at a time" row also edits the index 6c recreates.

## Round 1 (code 9eb7fa4)

| # | Protection removed | Result | First failure |
|---|---|---|---|
| 1 | The commit applies the delta seen at the check instead of the sheet's target [design 17] | caught | FAIL: import_commit_vs_sale_target_respected (use_sheet): 70/0, expected 100/0 |
| 2 | The commit does not re-read moved in the CRM under the lock (uses the check's value) [design 18] | caught | FAIL: import_commit_vs_sale_target_respected (keep_crm): 100/0, expected 70/0 |
| 3 | A place the sheet leaves out keeps its stock instead of going to 0 [design 19] | caught | FAIL: transit_to_warehouse_is_transfer: 500/0 500/100 |
| 4 | The undo plan ignores last_onhand_batch_id (reverses stock moved or re-imported since) [design 20] | caught | FAIL: kept reasons: SI Archived:held SI Both:undone SI Moved:undone SI Sold later:held SI Sold out:edited |
| 5 | The undo deletes the products the import created instead of archiving them [design 21] | caught | permission denied for table products |
| 6 | The batch guard keeps the stock working rows when an import closes [design 22] | caught | FAIL: discard left staged rows |
| 7 | No stock marker check in the batch guard (a lead RPC or a direct PATCH moves a stock batch) [design 23] | caught | FAIL: "update public.import_batches set status = 'discarded' where id = 'a43aa951-9d86-47a4-9ddf-13930ae1b474'" succeeded, expected 22023 |
| 8 | One writer per organisation again instead of per organisation and kind [design 24] | caught | FAIL: the one-writer index is not per (org_id, kind) |
| 9 | The lock helper lets any admin lock a committing import (no uploader check) [design 25] | **NOT CAUGHT** | advisors: no ERROR-level findings |

day6c: 9 rows run: 8 caught, 0 documented two-layer rows not caught, 1 not as listed

Row 9 was not caught: no test had a second admin try the lock helper on someone else's committing import. Added
`lock_helper_uploader_only` to `supabase/tests/stock_import_attack.sql` section 9 (c46e565).

## Round 2 (code 2f4b02f)

| # | Protection removed | Result | First failure |
|---|---|---|---|
| 9 | The lock helper lets any admin lock a committing import (no uploader check) [design 25] | caught | FAIL: "select private.lock_stock_import('1f650009-6d11-40e5-966b-241a6e336849', array[(select id from public.products where name = 'SI Lock  |

day6c: 1 rows run: 1 caught, 0 documented two-layer rows not caught, 0 not as listed

Design row 26 (REVENTE mismatch rejects instead of warning) lives in the browser rules: `tests/unit/stock-normalise.spec.ts`
("every warning code keeps the row" expects `resale_*_mismatch` rows to stay imported, and "REVENTE tolerance edges")
fail if a mismatch rejects the row. Checked by hand on 2f4b02f: making a REVENTE mismatch add a problem instead of a
warning in `src/lib/stock-import/normalise.ts` fails 5 unit tests (3 in `stock-normalise.spec.ts`, both sheets in
`stock-sample.spec.ts`); the file was restored after.

**Final: 9 of 9 database rows caught; row 26 caught by the unit tests.** Row 5 (the undo deletes new products) is
caught by the privilege layer (`authenticated` has no delete on products: "permission denied for table products"),
which is the intended backstop.

## Earlier sets re-run where 6c (and 6a) redefine their functions (code 9eb7fa4)

The rows whose text sits in a redefinition, now mirrored:

| # | Protection removed | Result | First failure |
|---|---|---|---|
| 17 | One import at a time: index not unique | caught | FAIL: "select public.commit_lead_import('d092ddb0-7b35-4c10-b111-c72e028ee5f5')" succeeded, expected 22023 |
| 18 | Undo: leads with an activity count as untouched | caught | FAIL: undo preview {"kept": 4, "tagged": 6, "removable": 2} |
| 19 | Undo: leads with a contact count as untouched | caught | FAIL: undo preview {"kept": 4, "tagged": 6, "removable": 2} |
| 20 | Undo: leads with a deal count as untouched | caught | FAIL: undo preview {"kept": 4, "tagged": 6, "removable": 2} |
| 21 | Undo: edited leads count as untouched | caught | FAIL: undo preview {"kept": 4, "tagged": 6, "removable": 2} |
| 30 | Working rows kept after the import | caught | FAIL: working rows kept after the import |
| 31 | Working rows kept after a direct discard | caught | FAIL: a direct discard left working rows |
| 32 | Working rows kept when an undo starts directly | caught | FAIL: a direct undo of a paused import left working rows |
| 35 | Undo of a paused import: working rows deleted before they are counted | caught | FAIL: the counts of a paused import were taken after its working rows were deleted: (0,0,"{""ready"": 0, ""by_name"": 0, ""by_email"": 0, "" |
| 37 | Counters not recounted at the end of an import | caught | import counts do not add up |

day3b: 10 rows run: 10 caught, 0 documented two-layer rows not caught, 0 not as listed

| # | Protection removed | Result | First failure |
|---|---|---|---|
| 10 | Import undo: leads with a task count as untouched | caught | FAIL: undo preview with a task {"kept": 0, "tagged": 2, "removable": 2} |

day4a: 1 rows run: 1 caught, 0 documented two-layer rows not caught, 0 not as listed

| # | Protection removed | Result | First failure |
|---|---|---|---|
| 1 | No FOR UPDATE on the levels (two people take the last pieces) [design 1] | **NOT CAUGHT** | advisors: no ERROR-level findings |
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
| 35 | Anyone may release a hold | caught | FAIL: "select pg_temp.mv('7a000000-0000-0000-0000-000000000003', 'release', reservation => 'ea20146f-dd49-40d7-9a1a-9af56b83a603')" succeede |
| 36 | No end-date check for a hold in the guard (a direct insert) | caught | FAIL: "insert into private.stock_movements (group_id, product_id, location_id, kind, qty, |
| 37 | No note pre-check in the guard (the CHECK would put the note in the error) | caught | FAIL: "insert into private.stock_movements (group_id, product_id, location_id, kind, qty, reason, note) values |
| 52 | No not-enough-stock rule in the apply step (the CHECK fires instead of a constant error) | caught | FAIL: "select pg_temp.mv('7a000000-0000-0000-0000-000000000001', 'adjust_out', 97, reason => 'lost')" gave 22023 (hint "below_reserved", sto |
| 54 | The nightly job opens a task every run | caught | FAIL: a second task the same day: {"tasks": 1, "expired": 0, "integrity_rows": 2, "requests_pruned": 0, "stock_imports_discarded": 0} |
| 59 | Reps correct stock (no manager check for receive, adjust and count in the guard) | caught | FAIL: "select pg_temp.mv('7a000000-0000-0000-0000-000000000005', 'receive', 1, reason => 'received')" succeeded, expected 42501 |
| 60 | A person may post an expire row | caught | FAIL: "insert into private.stock_movements (group_id, product_id, location_id, kind, |
| 62 | A place of another organisation is accepted (no same-organisation check and places readable by everyone, both layers) | caught | FAIL: "insert into private.stock_movements (group_id, product_id, location_id, kind, qty, reason) |
| 66 | The rate guard counts the system's deal-lost release rows | caught | FAIL: rate_guard_skips_deal_lost_releases: a row of g's was refused: too many stock changes in a minute |

day6a: 30 rows run: 25 caught, 4 documented two-layer rows not caught, 1 not as listed

Day 6a row 1 (no FOR UPDATE on the levels) was not caught in this run and caught in a re-run on 2f4b02f
(`40P01: deadlock detected` in `stock_concurrency.sh`): its detection depends on two sessions overlapping, so it is
timing-dependent on this loaded runner (open risk in README). The four documented two-layer rows behave as listed in
`docs/evidence/day6a/mutations.md`.

