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
