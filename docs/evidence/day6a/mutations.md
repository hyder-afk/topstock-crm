# Day 6a mutations, 11 Oct 2026

Design: `docs/evidence/day6/design.md` section 11.3 (6a mutations 1 to 16), plus every protection the 6a build added.
Runner: `python3 scripts/db-mutations.py --set day6a [numbers...]`, in a throwaway `git worktree` (removed after each
round). For each row the migration is changed in place, `scripts/db-test.sh` runs every database test (migrations, RLS,
import and activity attack tests and their concurrency scripts, `stock_attack.sql`, `stock_concurrency.sh`, advisors),
and the migration is restored. A row is **caught** when the run fails. Rows tagged `[design N]` are the design's list.

A protection with two layers gets one row per layer and one row removing both. A layer that stands behind another one
(the other layer stops the same thing first, so no test can see it alone) is listed as **NOT CAUGHT (documented: two
layers)**: it must stay not caught, and its both-layers row must be caught. The runner exits 1 when any row does not
behave as listed.

## Rounds

- **Round 1, on fa74b6c** (rows 1 to 61): `day6a: 61 rows run: 52 caught, 5 documented two-layer rows not caught, 4 not
  as listed` (exit 1). The 4 rows not as listed were missing tests, fixed in 651d8ee and 6f37e23:
  - row 12 (levels locked in the opposite order): concurrency case 7a used a session that changed the lower level, so
    the transfer's level insert waited on it and the transfer never held a level out of order. Case 7a now locks the
    levels without changing them; out of order, the two sessions deadlock (40P01);
  - row 13 (Arrived moves free pieces first): every transfer test had transit fully held. New
    `transfer_moves_held_pieces_first` (10 in transit, 4 held, Arrived of 5 must carry the 4 held pieces);
  - row 33 (no same-organisation check on the place in the guard): the guard reads places under the caller's RLS, so
    another organisation's place is already invisible. Reclassified as a documented two-layer row (behind
    `locations_select`); new row 62 removes both layers (caught by the existing other-organisation place probe) and
    row 63 the policy alone (caught);
  - row 44 (reps see costs): `rep_cost_null` ran before any cost existed. It now runs again once costs exist.
- **Round 2, on 6f37e23** (rows 4, 10, 11, 12, 13, 25, 31, 33, 44, 62, 63: the 4 rows above, the 2 new ones, and every
  documented two-layer row, since stricter tests could have made one of them caught):
  `day6a: 11 rows run: 5 caught, 6 documented two-layer rows not caught, 0 not as listed` (exit 0).
  The rows caught in round 1 were not re-run: the later commits only add checks (and case 7a now fails in more cases),
  so a run that failed before still fails.

**Result on the final code: 57 of 57 caught; the 6 documented two-layer rows not caught, as listed.** Each
documented row's protection is still proved by its pair:

| Documented row | Stands behind | Pair that is caught |
|---|---|---|
| 4 `reserved <= on_hand` CHECK | the apply step's held-above-on-hand rule | 2 (both), 3 (rule alone: the CHECK's raw error fails the constant-error probe) |
| 10 deal check in the guard | the same check in the apply step, under the deal lock | 9 (both) |
| 11 deal check in the apply step | the guard's check (no race reaches it: the deal row is locked) | 9 (both); 27 (the deal lock) |
| 25 unique index on `pair_id` | the guard's not-paired-yet check | 23 (both), 24 (guard alone: the index answers 23505, not the constant error) |
| 31 archived check in the guard | the same check under the lock | 32 (lock layer alone, caught by the archive-versus-receipt race the guard cannot see) |
| 33 same-organisation place check | `locations_select` (RLS) | 62 (both), 63 (policy alone) |

Notes on first failures: row 14's first line is the error the next statement raised (`stock is held`: a due hold not
ended first); row 22's is the probe's `SET CONSTRAINTS` naming the deferred trigger that the mutation dropped (the same probe
then checks that a lone transfer_out is refused with hint `pair`; without the trigger nothing refuses it); rows 45 and 58 fail on a row level security
error in a probe: the loosened USING clause lets a manager's update reach the unchanged WITH CHECK clause, which a
probe expecting no change does not survive. Each is still a failing check of that protection.

## Table (final)

| # | Protection removed | Result | First failure | Run |
|---|---|---|---|---|
| 1 | No FOR UPDATE on the levels (two people take the last pieces) [design 1] | caught | FAIL: twenty_reservers_one_product: 10 succeeded, 3 refused (expected 10 and 10) | 1 (fa74b6c) |
| 2 | No held-above-on-hand rule in the apply step and no CHECK backstop (both layers) [design 2] | caught | FAIL: "select pg_temp.mv('7a000000-0000-0000-0000-000000000001', 'reserve', 97, company => '33000000-0000-0000-0000-0000000000b1')" succeede | 1 (fa74b6c) |
| 3 | No held-above-on-hand rule in the apply step (the CHECK fires instead of a constant error) [design 2] | caught | FAIL: "select pg_temp.mv('7a000000-0000-0000-0000-000000000001', 'reserve', 97, company => '33000000-0000-0000-0000-0000000000b1')" gave 235 | 1 (fa74b6c) |
| 4 | No reserved <= on_hand CHECK on the levels (backstop behind the apply step) [design 2] | **NOT CAUGHT** (documented: two layers) | advisors: no ERROR-level findings | 2 (6f37e23) |
| 5 | UPDATE on stock_levels granted to authenticated [design 3] | caught | FAIL: public.stock_levels must be read-only for authenticated | 1 (fa74b6c) |
| 6 | No append-only trigger on the ledger [design 4] | caught | FAIL: "update private.stock_movements set note = 'x'" succeeded, expected 42501 | 1 (fa74b6c) |
| 7 | No fresh code for corrections (adjust, count, receive) [design 5] | caught | FAIL: "select pg_temp.mv('7a000000-0000-0000-0000-000000000005', 'adjust_out', 1, reason => 'damaged')" succeeded, expected 42501 | 1 (fa74b6c) |
| 8 | No lead-editor check for a hold [design 6] | caught | FAIL: "select pg_temp.mv('7a000000-0000-0000-0000-000000000003', 'reserve', 5, company => '33000000-0000-0000-0000-0000000000a1')" succeeded | 1 (fa74b6c) |
| 9 | No deal-on-this-lead check, guard and apply step (both layers) [design 7] | caught | FAIL: "select pg_temp.mv('7a000000-0000-0000-0000-000000000003', 'reserve', 5, company => '33000000-0000-0000-0000-0000000000b1', deal => '4 | 1 (fa74b6c) |
| 10 | No deal-on-this-lead check in the guard (the apply step checks it again) [design 7] | **NOT CAUGHT** (documented: two layers) | advisors: no ERROR-level findings | 2 (6f37e23) |
| 11 | No deal-on-this-lead check in the apply step (the guard checks it first) [design 7] | **NOT CAUGHT** (documented: two layers) | advisors: no ERROR-level findings | 2 (6f37e23) |
| 12 | Levels locked in the opposite order [design 8] | caught | 40P01: deadlock detected | 2 (6f37e23); round 1: NOT CAUGHT |
| 13 | Arrived moves unheld pieces first [design 9] | caught | FAIL: transfer_moves_held_pieces_first: {"moved": 5, "levels": [{"on_hand": 805, "location": "warehouse", "reserved": 800, "available": 5},  | 2 (6f37e23); round 1: NOT CAUGHT |
| 14 | The RPC does not end due holds before it writes [design 10] | caught | stock is held | 1 (fa74b6c) |
| 15 | The guard trusts any current_user [design 11] | caught | FAIL: "insert into private.stock_movements (group_id, product_id, location_id, kind, | 1 (fa74b6c) |
| 16 | No FOR SHARE on the product in the apply step (archive racing a receipt) [design 12] | caught | FAIL: archive_vs_receive_race (b): stock was received into a product being archived | 1 (fa74b6c) |
| 17 | crm_moved worked out from ledger ids instead of under the lock [design 13] | caught | FAIL: holds must not mark a level as moved in the CRM | 1 (fa74b6c) |
| 18 | The count's change worked out in the RPC (before the lock) [design 14] | caught | FAIL: count up to 120: {"levels": [{"on_hand": 120, "location": "warehouse", "reserved": 40, "available": 80}, {"on_hand": 0, "location": "t | 1 (fa74b6c) |
| 19 | Rate guard at 10,000 a minute [design 15] | caught | FAIL: "select pg_temp.mv('7a000000-0000-0000-0000-000000000007', 'reserve', 1, | 1 (fa74b6c) |
| 20 | No audit row for ledger rows [design 16] | caught | FAIL: movement_audit_minimal: <NULL> | 1 (fa74b6c) |
| 21 | The ledger's audit row copies the whole row (the note's text included) [design 16] | caught | FAIL: movement_audit_minimal: {"new": {"id": 249, "qty": 3, "kind": "adjust_out", "note": "MARK4 broken in the van", "org_id": "386a57ed-6a3 | 1 (fa74b6c) |
| 22 | A transfer_out with no transfer_in is accepted (no deferred pairing check) | caught | constraint "stock_movements_transfer_paired" does not exist | 1 (fa74b6c) |
| 23 | A transfer_in may reuse a departure that already arrived (guard and unique index, both layers) | caught | FAIL: "insert into private.stock_movements (group_id, product_id, location_id, kind, qty, pair_id) | 1 (fa74b6c) |
| 24 | No not-paired-yet check in the guard (the unique index refuses with 23505 instead of a constant error) | caught | FAIL: "insert into private.stock_movements (group_id, product_id, location_id, kind, qty, pair_id) | 1 (fa74b6c) |
| 25 | No unique index on pair_id (backstop behind the guard) | **NOT CAUGHT** (documented: two layers) | advisors: no ERROR-level findings | 2 (6f37e23) |
| 26 | Arrived takes no product lock before the levels (deadlock with a movement holding the product's share lock) | caught | 40P01: deadlock detected | 1 (fa74b6c) |
| 27 | A hold for a deal does not lock the deal (a deal lost at the same moment keeps an active hold) | caught | FAIL: reserve_vs_deal_lost (a): a lost deal kept an active hold | 1 (fa74b6c) |
| 28 | Archive with stock left | caught | FAIL: "select public.archive_product('e832b25f-d37c-4517-ae27-b6569cbf58ab')" succeeded, expected 22023 | 1 (fa74b6c) |
| 29 | Archive without a fresh code in the product guard (a direct update) | caught | FAIL: "update public.products set archived_at = now() where id = '7a000000-0000-0000-0000-000000000009'" succeeded, expected 42501 | 1 (fa74b6c) |
| 30 | A manager restores an archived product (product guard) | caught | FAIL: "update public.products set archived_at = null where id = '7a000000-0000-0000-0000-000000000009'" succeeded, expected 42501 | 1 (fa74b6c) |
| 31 | No archived-product check in the guard (the apply step checks it again under the lock) | **NOT CAUGHT** (documented: two layers) | advisors: no ERROR-level findings | 2 (6f37e23) |
| 32 | No archived-product check under the lock (archive racing a receipt) | caught | FAIL: archive_vs_receive_race (b): stock was received into a product being archived | 1 (fa74b6c) |
| 33 | No same-organisation check on the place in the guard (the places policy hides other organisations' places) | **NOT CAUGHT** (documented: two layers) | advisors: no ERROR-level findings | 2 (6f37e23); round 1: NOT CAUGHT |
| 34 | A transfer_out may leave from the warehouse | caught | FAIL: "insert into private.stock_movements (group_id, product_id, location_id, kind, qty, reason) | 1 (fa74b6c) |
| 35 | Anyone may release a hold | caught | FAIL: "select pg_temp.mv('7a000000-0000-0000-0000-000000000003', 'release', reservation => 'ce81feaa-c20c-43fd-aaf7-c97d958b45e2')" succeede | 1 (fa74b6c) |
| 36 | No end-date check for a hold in the guard (a direct insert) | caught | FAIL: "insert into private.stock_movements (group_id, product_id, location_id, kind, qty, | 1 (fa74b6c) |
| 37 | No note pre-check in the guard (the CHECK would put the note in the error) | caught | FAIL: "insert into private.stock_movements (group_id, product_id, location_id, kind, qty, reason, note) values | 1 (fa74b6c) |
| 38 | No product name pre-check (the CHECK would put the name in the error) | caught | FAIL: "insert into public.products (name, pieces_per_carton) values ('MARK3' // chr(9) // 'tab', 12)" gave 23514 (hint "", new row for relat | 1 (fa74b6c) |
| 39 | No name_taken pre-check (the unique index answers instead) | caught | FAIL: "insert into public.products (name, pieces_per_carton) values ('stock TEST 01', 12)" gave 23505 (hint "", duplicate key value violates | 1 (fa74b6c) |
| 40 | A retry with the same request id posts again | caught | FAIL: idempotent_request_id: {"levels": [{"on_hand": 10, "location": "warehouse", "reserved": 0, "available": 10}, {"on_hand": 0, "location" | 1 (fa74b6c) |
| 41 | Request ids readable by everyone | caught | FAIL: a person sees another person's request ids | 1 (fa74b6c) |
| 42 | Levels readable across organisations | caught | FAIL: the other org sees this org's stock | 1 (fa74b6c) |
| 43 | Reps may create products (policy) | caught | FAIL: "insert into public.products (name, pieces_per_carton) values ('Rep product', 12)" succeeded, expected 42501 | 1 (fa74b6c) |
| 44 | Reps see costs (policy) | caught | FAIL: rep_cost_null: a rep sees costs | 2 (6f37e23); round 1: NOT CAUGHT |
| 45 | Managers change the settings (policy) | caught | new row violates row-level security policy for table "inventory_settings" | 1 (fa74b6c) |
| 46 | The alert assignee may be outside the organisation | caught | FAIL: "update private.inventory_settings set alert_assignee_id = '00000000-0000-0000-0000-0000000000c1'" succeeded, expected 22023 | 1 (fa74b6c) |
| 47 | Import undo does not count holds (it would try to delete a lead with stock history) | caught | FAIL: undo preview with a hold {"kept": 0, "tagged": 2, "removable": 2} | 1 (fa74b6c) |
| 48 | Holds deleted with their lead (on delete cascade) | caught | FAIL: hold foreign key actions | 1 (fa74b6c) |
| 49 | A lost deal keeps its holds (trigger dropped) | caught | FAIL: deal_lost_releases_holds | 1 (fa74b6c) |
| 50 | A deleted deal keeps its holds (trigger dropped) | caught | FAIL: deal_delete_releases_holds | 1 (fa74b6c) |
| 51 | The page-load sweep is not throttled | caught | FAIL: a second sweep within a minute should do nothing | 1 (fa74b6c) |
| 52 | No not-enough-stock rule in the apply step (the CHECK fires instead of a constant error) | caught | FAIL: "select pg_temp.mv('7a000000-0000-0000-0000-000000000001', 'adjust_out', 97, reason => 'lost')" gave 22023 (hint "below_reserved", sto | 1 (fa74b6c) |
| 53 | The public RPCs keep PUBLIC execute (anon could call them) | caught | FAIL: execute rights on public.post_stock_movement(uuid, text, integer, text, text, text, uuid, uuid, uuid, date, integer, uuid) | 1 (fa74b6c) |
| 54 | The nightly job opens a task every run | caught | FAIL: a second task the same day: {"tasks": 1, "expired": 0, "integrity_rows": 2, "requests_pruned": 0} | 1 (fa74b6c) |
| 55 | A settings change of the sweep time alone is audited | caught | FAIL: a sweep alone should not be audited | 1 (fa74b6c) |
| 56 | Anyone signed in runs the stock check | caught | FAIL: "select * from public.check_stock_integrity()" succeeded, expected 42501 | 1 (fa74b6c) |
| 57 | The product's creator comes from the client | caught | FAIL: product_insert_server_fields: {"org_id":"4ffac45a-3b1e-438c-b566-dbe639c555ea","created_by":null,"archived_at":null,"name":"Server fie | 1 (fa74b6c) |
| 58 | Managers rename places (policy) | caught | new row violates row-level security policy for table "locations" | 1 (fa74b6c) |
| 59 | Reps correct stock (no manager check for receive, adjust and count in the guard) | caught | FAIL: "select pg_temp.mv('7a000000-0000-0000-0000-000000000005', 'receive', 1, reason => 'received')" succeeded, expected 42501 | 1 (fa74b6c) |
| 60 | A person may post an expire row | caught | FAIL: "insert into private.stock_movements (group_id, product_id, location_id, kind, | 1 (fa74b6c) |
| 61 | No two-factor policy on the levels, ledger, holds, hold uses and request ids | caught | FAIL: public.stock_levels lacks the restrictive two-factor policy | 1 (fa74b6c) |
| 62 | A place of another organisation is accepted (no same-organisation check and places readable by everyone, both layers) | caught | FAIL: "insert into private.stock_movements (group_id, product_id, location_id, kind, qty, reason) | 2 (6f37e23) |
| 63 | Places readable across organisations (policy) | caught | FAIL: the other org sees this org's stock | 2 (6f37e23) |

Raw runner output: round 1 and round 2 count lines as quoted above.
