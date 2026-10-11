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
  - Expiry (D8): `expire_due_holds(product, place, deal)` before an RPC takes room (a hold for a deal locks the deal
    there first), `sweep_expired_holds()` at most once a minute per org, both over `expire_holds_for`; holds of a deal
    lost or deleted are released by `release_deal_holds` (on any update that leaves the deal lost, and before delete).
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
  corrections until 6d), and a `perf` mode for I16. Case 9 has four parts: a hold and a deal lost in both orders, (c)
  with an expired hold at the level (the deadlock the verifier found) and (d) a hold inserted straight into the ledger.
- `supabase/tests/import_attack.sql`: `import_fk_coverage` expects `private.stock_reservations`.
- `scripts/db-mutations.py`: `--set day6a`, 67 rows (design mutations 1 to 16 tagged `[design N]`, plus every
  protection the build added; two-layer protections split each way; rows 64 to 67 for the verifier's findings).
- `supabase/tests/perf_stock.sql` (new, part 1) and its `scripts/db-perf.sh` hook; `stock_concurrency.sh perf` at the
  end of `db-perf.sh`.
- `docs/evidence/day6a/spikes/`: spikes S2, S3, S6 and the throwaway S1 (results in `docs/log.md`).

## Check results

**After the verifier's findings (11 Oct): code head 47b68f9, branch head 61bb7e7** (later commits change only
documents). The first build's rows follow; each row says which commit it ran on.

| Check (round 2) | Result |
|---|---|
| `bash scripts/db-test.sh` (on 61bb7e7) | exit 0: `rls_attack`, `import_attack`, `import_concurrency`, `activity_attack`, `activity_concurrency`: all checks passed; `stock_attack: all checks passed` (`integrity_after_random_ops: 760 applied, 240 refused`); `stock_concurrency: all checks passed` (`twenty_reservers_one_product: 10 of 20 succeeded, wall clock 405 ms`, `random_ops_three_sessions: 275 applied, 25 refused, no deadlock`); `advisors: no ERROR-level findings` (WARN `set_user_role` as before, INFO 1 unindexed FK, 11 unused indexes) |
| Mutations round 3 (on 61bb7e7, throwaway worktree, removed after) | rows 12 to 15, 19, 22 to 27, 34, 49, 50, 56 and new 64 to 67: `day6a: 19 rows run: 18 caught, 1 documented two-layer rows not caught, 0 not as listed` (exit 0). **Final: 61 of 61 caught, 6 documented two-layer rows (67 rows)** |
| Perf set C (`perf.md`; 3 × `db-perf.sh` on 61bb7e7, plus 3 paired before/after runs of the trim) | **I5 Arrived 4.11 / 4.23 / 5.78 ms: over 5 ms in 1 of 3 full runs** (the busiest, load 3.3); the paired runs gave 3.79–4.07 ms after the trim against 4.62–7.98 ms before it; adjust 2.74–3.43 ms (one 37 ms stall in run 1), reserve 3.49–3.79 ms; I7 4.09–5.95 ms (25); I16 394–569 ms (3,000), p95 7.3–11.4 ms (25), 0 deadlocks; I17 205–222 ms (1,500) |
| `npm run lint` (on 61bb7e7) | exit 0, 0 errors (the 2 existing warnings) |
| `npm run typecheck` (on 61bb7e7) | exit 0 |
| `npm run test:unit` (on 61bb7e7) | 166 passed (exit 0) |
| `npm audit --omit=dev` (on 61bb7e7) | found 0 vulnerabilities |
| gitleaks (`origin/main..HEAD`) | run on the final head after the evidence commits (reported with this step) |
| Not run | Playwright (no UI change), Semgrep (CI only), I18 (the fixes do not touch the import or the lists) |

### First build (before the verifier)

Code head then: **6f37e23** (migration unchanged since 2b5b847; tests last changed in 6f37e23). Later commits change
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
3. **Expiry per place.** `expire_due_holds(p_product, p_location, p_deal)` ends due holds of one level only (the RPC
   never locks a level outside the lock order); Arrived passes no place and ends both places' holds of the product in
   location order first; a hold for a deal passes the deal, which is locked before any expiry row (deviation 6). Both run over a
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
6. **A hold for a deal locks the deal (`FOR SHARE`) first**, so a deal lost at the same moment either sees the hold and
   releases it, or makes the hold fail. The global lock order is therefore deal, product, levels, holds. The lock is
   taken twice:
   - in `post_stock_movement`, **before any expiry row**, through `expire_due_holds(product, place, deal)` (as
     postgres: an invoker `FOR SHARE` would need UPDATE on `deals` and pass its update policy). An expiry row locks
     the level, and a deal being lost locks the deal and then needs that level (`release_deal_holds`). The first build
     locked the deal only in the apply step, after the expiry rows, and the verifier reproduced a deadlock (40P01) with
     an expired hold at the level. Now case 9c covers it, with mutation row 64;
   - in the apply step, where the deal is re-checked under the lock. This also covers a hold inserted straight into the
     ledger (case 9d, mutation row 27).
   Design 4.6's "a waiting cycle cannot form" holds only with the deal first; the note under design 4.6 says so for 6d
   (a sale with a deal must lock it before its expiry rows too).
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
16. **I15 (the nightly job at size) is not measured in 6a**, although `nightly_stock_jobs` ships in 6a. Its parts are
    timed: the integrity checks (I17, about a fifth of their budget) and the expiry path (each RPC's expiry call, inside
    I5). The job as a whole is timed with 6c, which adds its batch clean-up.
17. **The deal-lost release fires on any update that leaves a deal lost** (`after update ... when (new.status = 'lost'
    and old.status is distinct from 'lost')`, no `of status`). An `UPDATE OF status` trigger fires only when status is
    named in the SET list, so a status set by a BEFORE trigger (for example a stage change that Day 5 turns into lost)
    released nothing (verifier finding; test `deal_lost_by_before_trigger_releases_holds` with a stand-in BEFORE trigger,
    catalog check for no column list, mutation row 65).
18. **The rate guard does not count the system's release rows** (`release` with `deal_lost` / `deal_deleted`). They
    carry the person who changed the deal, so losing a deal with many holds would have rate-limited its owner for a
    minute (test `rate_guard_skips_deal_lost_releases`, mutation row 66). A person cannot write those reasons: a
    person's release is always `manual`. The paired `transfer_in` of an Arrived is not checked either: its
    `transfer_out`, by the same person in the same transaction, was.
19. **`private.stock_integrity_rows(uuid)` is granted to `authenticated`**, which the design's grant list does not
    include, because the invoker `check_stock_integrity` calls it. It takes its organisation argument only from
    postgres (the nightly job, tests); any other caller gets its own organisation whatever it passes, and
    `check_stock_integrity` passes none (test `integrity_rows_ignore_client_org`, mutation row 67). `private` has no
    REST endpoint.
20. **Arrived trimmed** after the first timings: one expiry call for both places (expire_holds_for goes in level
    order), the two places read in one statement, what is left in transit and the held pieces moved taken from the
    rows' `RETURNING` snapshots (written under the lock) instead of reading the level and the ledger again.

## Open risks

1. **Arrived (I5 transfer) still over its 5 ms budget in 1 of 3 full runs after the trim** (set C: 4.11, 4.23 and
   5.78 ms; the first build took 4.7–7.3 ms, over in 5 of 6). Arrived writes two full ledger rows, and no plan is bad.
   The trim (47b68f9) was faster in each of the 3 paired before/after runs. **Haider decides:** accept it as it is (a manager
   action a few times a day per delivery, and I7 has a wide margin), or trim it further in 6b (build the answer's
   levels from the rows' snapshots, about 0.3 ms). Recommendation: re-time in CI or on dev first, and accept if it
   stays under about 6 ms.
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
6. **Day 5 contract**: the release-on-lost trigger keys on `deals.status = 'lost'`; Day 5 must leave it set when a deal
   is Closed/lost (design 12.1). Any update does, directly or through a BEFORE trigger; it need not name `status`.
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
6. **Day 5 contract** (design 12.1): Day 5 must leave `deals.status = 'lost'` on Closed/lost (directly or through a
   BEFORE trigger), which the release trigger keys on; re-run `deal_lost_releases_holds`,
   `deal_lost_by_before_trigger_releases_holds` and concurrency case 9 on the rebased branch.
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
That late lookup is a deviation from CLAUDE.md ("Context7 before writing code"), logged in `docs/log.md`.

Looked up **before** writing the verifier fixes (same library):

- **CREATE TRIGGER, notes** (`sql-createtrigger.html`): an `UPDATE OF column` trigger fires only when the column is a
  target in the SET list, and changes made by BEFORE UPDATE triggers are not considered; a row trigger's `WHEN` can
  read OLD and NEW. Hence `release_deal_holds_lost` has no column list and keeps its `WHEN`.
- **SELECT, locking clause** (`sql-select.html`) and **Row security policies** (`ddl-rowsecurity.html`): `FOR SHARE`
  needs UPDATE privilege as well, and a sub-select that must lock is best put in a security definer function. Hence the
  deal is locked inside `expire_due_holds` (definer), not by the invoker RPC.
- **Trigger functions in PL/pgSQL** (`plpgsql-trigger.html`): a BEFORE row trigger's modified NEW is the row stored and
  the one `INSERT ... RETURNING` returns. Hence the trimmed Arrived reads `on_hand_after` and `d_reserved` from
  `RETURNING`.
