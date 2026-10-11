# Day 6a: stock engine (database only), 11 Oct 2026

Design: `docs/evidence/day6/design.md` (sections 3.0, 3.1, 3.6, 4, 5.1, 9, 11 and 13 "6a Stock engine"), with Haider's
11 Oct answers (`docs/log.md`): units are pieces only, client prices exclude VAT, cost per piece = PP ÷ QUANTITÉ, all
Day 6 recommendations accepted. Branch `day6a-local` (local build branch; the PR branch name in design 13 is
`day6a-stock-engine`). No screen changes: nothing in `src/` calls the new RPCs yet (6b does).

## What changed

**Migration `supabase/migrations/20261016090000_stock_engine.sql`** (timestamp after every Day 4b to 4d and Day 5
migration; 4b's is `20261012090000`)

- **Part 1: products, places, costs, settings.**
  - `private.product_name_key(name)`: the "same product" key (D13), a fixed fold map with code point ranges only, so
    ICU and libc give the same key; granted to `authenticated` for the generated column.
  - `public.locations`: one `Warehouse France` and one `In transit` per organisation (D35), seeded for every existing
    organisation and by an AFTER INSERT trigger on `orgs`; admins rename them (name only, `location_guard`).
  - `public.products`: name (CATÉGORIE), `name_key` (unique per org, archived included), category, pieces per carton,
    cartons per pallet, reorder point, `price_min` / `price_max` (EUR per piece, **excluding VAT**), expected arrival,
    hide-from-clients, archive time, import batch, search text. **No unit column**: pieces only (Haider, 11 Oct).
    `product_guard` (invoker): constant pre-checks with hints `product_name`, `category`, `carton`, `pallet`, `reorder`,
    `price`, `price_order`, `eta`, `name_taken`; insert sets `created_by`; `created_by` and `import_batch_id` never
    change; archive needs a fresh code and no stock anywhere (`has_stock`); restore is admin with a fresh code.
  - `private.product_costs`: cost per piece (PP ÷ QUANTITÉ when it comes from a sheet in 6c), managers and admins only.
  - `private.inventory_settings`: alert assignee (seeded: the oldest admin), default hold length 14 days (1 to 90),
    sweep throttle; admins change the first two; the assignee must be in the organisation.
  - RLS on, restrictive `require_mfa`, every grant revoked then column grants only (design 3.1 table).
- **Part 2: levels, ledger, holds, engine** (design 4).
  - `public.stock_levels` (select only for clients), `private.stock_reservations` (holds), `private.stock_movements`
    (the append-only ledger), `private.stock_hold_uses` (6d writes it), `private.movement_requests` (idempotency).
  - `stock_movement_a_guard` (invoker, runs first): server fields, the product's org read under the caller's RLS, place
    of the org and of the right kind, constant pre-checks, the per-kind table of design 4.3 (who, fresh code,
    document), transfer pairing, the rate guard (121st row in 60 s refused). Trusted means `current_user = 'postgres'`.
  - `stock_movement_b_apply` (definer, owner postgres, execute revoked): lock order deal (a hold for a deal), product
    `FOR SHARE`, levels `FOR UPDATE` in location order, holds; the rules of design 4.5 on the locked level; holds
    created, released, ended, and moved oldest first by Arrived (a split keeps creator, lead, deal, end date and age);
    `version`, `crm_moved`, `last_onhand_batch_id` and the row's snapshot written under the lock (D5).
  - `stock_movement_immutable` (update, delete, truncate, every role); `stock_movements_transfer_paired` (deferred:
    a departure from transit needs its arrival in the same transaction).
  - Expiry (D8): `expire_due_holds(product, place)` before an RPC takes room, `sweep_expired_holds()` at most once a
    minute per org, both over `expire_holds_for`; holds of a deal lost or deleted are released by `release_deal_holds`.
- **Part 3: RPCs, integrity, nightly job, audit, import undo.**
  - `post_stock_movement` (design 4.2), `create_product` (opening stock is a receipt with a fresh code; idempotent),
    `update_product`, `set_product_cost`, `archive_product`, `restore_product`, `release_expired_reservations`,
    `check_stock_integrity` (admins; checks `ledger_vs_levels`, `ledger_vs_reserved`, `holds_vs_reserved`, `versions`,
    `bounds`). All invoker, static SQL, `lock_timeout = 3s`, the Day 3a revoke/grant loop (authenticated only).
  - `private.nightly_stock_jobs()`: ends due holds in every org, runs the checks and opens at most one task a day for
    the alert assignee when they find a difference, prunes request ids older than 7 days. Scheduled at 01:10 UTC only
    where pg_cron is already installed (spike S6: not on the local runner).
  - `private.audit_inventory_row`: one minimal audit row per ledger row (never the note), diffs for costs and settings
    (a sweep-time change alone writes nothing); products and places use the shared `audit_row`.
  - `private.lead_import_untouched` (REBASE): a lead with a hold has stock history, so an import undo keeps it.

**Tests and scripts**

- `supabase/tests/stock_attack.sql` (new; `scripts/db-test.sh`, `.github/workflows/db.yml`): the design's 11.1 cases for
  6a in 9 sections (catalog, name key, access, validation, rules, transfers, permissions, holds and deals, other rules,
  1,000 random operations, ledger sums in every organisation), plus "products has no unit column".
- `supabase/tests/stock_concurrency.sh` (new; same hooks): 11 cases of design 11.2 for 6a (sales stand in as
  corrections until 6d), and a `perf` mode for I16.
- `supabase/tests/import_attack.sql`: `import_fk_coverage` expects `private.stock_reservations`.
- `scripts/db-mutations.py`: `--set day6a`, 61 rows (design mutations 1 to 16 tagged `[design N]`, plus every
  protection the build added; two-layer protections split each way).
- `supabase/tests/perf_stock.sql` (new, part 1) and its `scripts/db-perf.sh` hook; `stock_concurrency.sh perf` at the
  end of `db-perf.sh`.
- `docs/evidence/day6a/spikes/`: spikes S2, S3, S6 and the throwaway S1 (results in `docs/log.md`).

## Check results

Final code head: **6f37e23** (migration unchanged since 2b5b847; tests last changed in 6f37e23). Later commits change
only documents. Each row says which commit it ran on.

| Check | Result |
|---|---|
| Spikes S2, S3, S6, throwaway S1 (PG 16.15) | all hold; pg_cron not on the local runner; results in `docs/log.md` and `spikes/` |
| `bash scripts/db-test.sh` (on 6f37e23) | `rls_attack: all checks passed`, `import_attack: all checks passed`, `import_concurrency: all checks passed`, `activity_attack: all checks passed`, `activity_concurrency: all checks passed`, `stock_attack: all checks passed` (`integrity_after_random_ops: 724 applied, 276 refused`), `stock_concurrency: all checks passed` (`twenty_reservers_one_product: 10 of 20 succeeded`, `random_ops_three_sessions: 275 applied, 25 refused, no deadlock`), `advisors: no ERROR-level findings` (exit 0). Raw concurrency output: `concurrency.md` |
| Advisors (splinter, local) | WARN `authenticated_security_definer_function_executable` on `set_user_role` (accepted Day 1); INFO `unindexed_foreign_keys: 1` (`activities_org_id_fkey`, accepted in 4a; no new table has one, private schema checked by query too); INFO `unused_index: 11` (fresh database). No new WARN: the new definer code is in `private` |
| Mutations, Day 6a (`mutations.md`) | Round 1 on fa74b6c: `day6a: 61 rows run: 52 caught, 5 documented two-layer rows not caught, 4 not as listed` (4 missing tests, fixed). Round 2 on 6f37e23: `day6a: 11 rows run: 5 caught, 6 documented two-layer rows not caught, 0 not as listed` (exit 0). **Final: 57 of 57 caught; 6 documented two-layer rows not caught, each with its both-layers row caught** (63 rows) |
| Perf (`perf.md`, 3 runs alternated with `origin/main`, plus 3 earlier runs) | I5 adjust 2.4–4.3 ms and reserve 2.7–4.6 ms (budget 5); **I5 transfer 4.7–5.8 ms (6.7–7.3 in the earlier set): over the 5 ms budget in 5 of 6 runs**; I7 4.7–8.2 ms (25); I16 20 sessions 355–397 ms (3,000), 3×300 operations p95 7.1–8.0 ms (25), 0 deadlocks, integrity 0 rows; I17 196–279 ms (1,500); I18 within the machine's ±30% noise, not provable at +10% here (undo preview −4%, import chunk +10%, undo chunk +18%, unaffected Check +19%). Generic plans from run 6, no sequential scan |
| `npm run lint` (on 6f37e23) | 0 errors (2 existing warnings: TanStack Virtual and the React compiler) |
| `npm run typecheck` (on 6f37e23) | passed |
| `npm run test:unit` (on 6f37e23) | 166 passed |
| Playwright e2e | not run: no app or UI change in 6a (nothing in `src/` changed); CI's `auth-journey` runs it on the PR |
| Semgrep | not run locally (semgrep.dev blocked by this session's egress policy); CI's `semgrep` job |
| gitleaks (`origin/main..HEAD`) | on 6f37e23: `no leaks found` (exit 0, 14 commits scanned); re-run on the final head after the evidence commits: clean (reported with this step) |
| `npm audit --omit=dev` (on 6f37e23) | found 0 vulnerabilities |
| `/security-review` (`security-review.md`) | no high-confidence vulnerability; design threat rows S1 to S12 and A1 to A3 re-checked for 6a; residual risks listed |
| Supabase MCP pre-check and dev advisors | not done in this build (no MCP, no remote database by instruction): for the lead builder before merge (design 11.7) |

## Deviations from the design (each logged in `docs/log.md`)

1. **No unit column** (`products.unit`, its CHECK, the guard's `unit` hint, the grants and `p_unit` in `create_product`
   and `update_product`): Haider, 11 Oct, units are pieces only ("pcs"). Design 3.1, 5.1 and 8.5 (`share_items`) still
   show it; 6b and 6e drop it from `list_stock`, `share_items` and the client payload.
2. **Ledger rows with no person**: `expire`, and `release` with reason `deal_lost` or `deal_deleted` (a deal lost or
   deleted by a maintenance session). Design 3.1 allowed only `expire`; a deal changed with no signed-in user would
   otherwise fail.
3. **Expiry per place.** `expire_due_holds(p_product, p_location)` ends due holds of one level only (the RPC never
   locks a level outside the lock order); Arrived ends both places' holds in location order first. Both run over a
   new definer helper `private.expire_holds_for(org, product, place, limit)` (owner postgres, revoked from everyone).
   The design listed four definer helpers; 6a adds this one, `seed_org_inventory` (and its trigger), the deferred
   `stock_transfer_paired` and the audit trigger, all with no client grant.
4. **Transfers are paired three ways:** the guard (same group, product, quantity, person and transaction, not paired
   yet), a unique index on `pair_id`, and the deferred constraint trigger refusing a departure with no arrival. The
   design named only the guard's check.
5. **Arrived locks the product first** (`FOR NO KEY UPDATE` in the RPC, before any level), because it may clear the
   product's expected date after moving the stock; without it, Arrived and a movement holding the product's share lock
   deadlocked (`stock_concurrency.sh` case 7, mutation row 26). Arrived clears `transit_eta` when transit is empty.
   The RPC also checks manager or admin before the lock (a rep gets `forbidden`, not "not found").
6. **A hold for a deal locks the deal (`FOR SHARE`) first** in the apply step and re-checks it there, so a deal lost at
   the same moment either sees the hold and releases it, or makes the hold fail (case 9, mutation row 27). The global
   lock order is therefore deal, product, levels, holds.
7. **`stock_hold_uses.org_id`** added, so its select policy can be org-scoped like every other table.
8. **Audit through a new `private.audit_inventory_row`** for the ledger, costs and settings instead of new branches in
   the shared `private.audit_row` (design 3.6). The shared function stays as Day 4a left it (and as 4b redefines it),
   so 6a has one less shared function to rebase. Levels and holds are not audited (the ledger is their record).
9. **`check_stock_integrity` adds `ledger_vs_reserved`**; `ship_lines` (I7) arrives with sales in 6d.
10. **The nightly job** does not yet discard stale stock batches or prune `share_rate` (6c, 6e add them); its task
    title is a constant in English or French by the assignee's language.
11. **`create_product` is idempotent** (`movement_requests.kind` includes `create_product`).
12. **Safe text refuses C1 controls** too (`\u007F-\u009F`), as Day 4a decided; the design's rule named C0 only.
13. **6a refuses `order_line_id` and `import_batch_id`** on ledger rows and the kinds `ship`, `return`, `import_*`,
    `undo_*` (their document checks arrive with 6c and 6d).
14. **Extra indexes** for foreign keys, RLS and the rate guard: `stock_levels_org_idx`, `inventory_settings_assignee_idx`,
    reservations by product, place, org, split and restore, `movements_user_created_idx`, `movements_pair_once_idx`,
    `hold_uses_reservation_idx`, `hold_uses_org_idx`, `product_costs_org_idx`, `movement_requests_created_idx`.
15. **perf_stock.sql runs before perf_import.sql** in `db-perf.sh`, so the Day 3b undo (I18) is re-timed with 5,000
    holds in place; its seed is written with triggers off, consistent with every integrity check.

## Open risks

1. **Arrived (I5 transfer) over its 5 ms budget** on this shared machine (4.7–7.3 ms; adjust and reserve within).
   Two full ledger rows per Arrived; no bad plan. Re-time on a quiet machine; if still over, either accept (a manager
   action a few times a day; I7 has a wide margin) or trim in 6b (for example one role lookup per call instead of per
   row). Haider decides only if it stays over after the re-time.
2. **I18 not provable at +10% here**: the machine's run-to-run noise (±30% on cases 6a does not touch) is larger than
   the budget. The rule change itself shows no cost (undo preview −4%). Re-time P7 and the undo on a quiet machine or
   in CI before Gate 1.
3. **Not checked against hosted Supabase**: no read-only MCP pre-check on dev and no dev advisors in this build (by
   instruction). CI runs all tests on the Supabase Postgres image; the lead builder runs the dev pre-check (`select
   count(*) from import_batches where kind = 'stock'`, extensions) before merge and the advisors after
   `deploy-dev-db`.
4. **pg_cron**: the nightly job is scheduled only where the extension already exists; dev and production need it
   enabled (Supabase dashboard) for the 03:10 run, otherwise expiry still happens on every RPC and page-load sweep.
5. **Semgrep** is CI-only; **Playwright** not run (no UI change).
6. **Day 5 contract**: the release-on-lost trigger keys on `deals.status = 'lost'`; Day 5 must set it (design 12.1).
7. **Shared-function rebase** (list below): `lead_import_untouched` and the FK-coverage test must be re-copied after
   4c, 4d and Day 5 merge, or an import undo could delete a lead that 4c/4d data points at (the FK coverage test would
   fail first).

## Rebase before merge

6a was built on `origin/main` at 1004fa5 (Day 4a). Before its PR merges, after Day 4b to 4d and Day 5 have merged:

1. **`private.lead_import_untouched`** (migration line marked `-- REBASE:`): re-copy from the newest definition
   (4c adds `queue_claims`, 4d `files`, Day 5 possibly more), keeping the `not exists` on `private.stock_reservations`.
2. **`supabase/tests/import_attack.sql` `import_fk_coverage`**: the array follows the newest version (4c, 4d tables
   that reference leads) plus `private.stock_reservations`.
3. **Migration timestamp**: `20261016090000` must still sort after every merged migration; rename if a later one landed.
4. **`private.audit_row`** is not redefined by 6a, but 4b redefines it and 6a attaches it to `products` and `locations`:
   re-run `stock_attack.sql` section 7 and `movement_audit_minimal` on the rebased branch.
5. **`public.tasks` and `private.task_guard`** (4c): `nightly_stock_jobs` inserts a system task (`kind 'todo'`,
   `due_date`, no `created_by`); re-run its test after 4c's task changes.
6. **Day 5 contract** (design 12.1): Day 5 must set `deals.status = 'lost'` on Closed/lost, which the release trigger
   keys on; re-run `deal_lost_releases_holds` and concurrency case 9 on the rebased branch.
7. **Merge conflicts expected** in `scripts/db-test.sh`, `.github/workflows/db.yml`, `scripts/db-mutations.py` (`SETS`),
   `scripts/db-perf.sh` and `docs/log.md`: keep every day's lines.
8. Re-run `db-test.sh`, the Day 3b, 4a and 6a mutation sets and `db-perf.sh` after the rebase.

## Docs used (Context7, PostgreSQL 17 manual `/websites/postgresql_17`)

- **Explicit locking, row-level locks** (`explicit-locking.html`, table 13.3): FOR SHARE conflicts with FOR NO KEY UPDATE
  and FOR UPDATE but not with another FOR SHARE (many movements of one product at once, archive waits); FOR NO KEY
  UPDATE (Arrived's product lock) does not block FOR KEY SHARE (foreign-key checks).
- **Read Committed** (`transaction-iso.html` 13.2.1): a SELECT FOR UPDATE that waited locks and returns the updated row,
  which is why the rules are checked after the lock (spike S2 (f) saw the same on 16.15).
- **CREATE TRIGGER** (`sql-createtrigger.html`): same-event triggers fire in name order (`a_guard` before `b_apply`);
  constraint triggers are AFTER ROW and may be deferred to commit (`stock_movements_transfer_paired`).
- **CREATE FUNCTION, writing SECURITY DEFINER functions safely** (`sql-createfunction.html`): pinned `search_path`,
  execute revoked from PUBLIC in the same migration.
- **plan_cache_mode and PREPARE notes** (`runtime-config-query.html`, `sql-prepare.html`): five custom plans, then a
  generic plan if not costlier; the basis of perf.md's generic-plan check.
- **ALTER TABLE, trigger firing and `session_replication_role`** (`sql-altertable.html`): the perf seed writes with
  triggers off in replica mode.

These lookups were made while finishing 6a (evidence and perf); the engine itself was built against the design and
checked empirically by spikes S2, S3 and S6 on PostgreSQL 16.15. CI runs every test on the Supabase Postgres image.
