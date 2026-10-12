# Day 6c: stock sheet import, 12 Oct 2026

Design: `docs/evidence/day6/design.md` (sections 3.3, 5.3, 7, 9, 11 and 13 "6c Stock sheet import"), with Haider's 11 Oct
answers: his sheet's columns (CATÉGORIE, PRIX PAR PCS MAX / MIN, QUANTITÉ, QTY PAR CARTON, PP, REVENTE MIN / MAX computed,
STATUS In Warehouse / In Transit), pieces only, prices excluding VAT, cost per piece = PP ÷ QUANTITÉ. Built on
`day6a-local` after 6b. The real sheet never entered the session: only its header row is used, with invented rows.

Commits: 6eb0b56 (database), 9eff852 (concurrency), 9eb7fa4 (mutation script: day6c set and redefinition mirroring),
4a8de7e (browser rules, fake sheets, unit tests), c46e565 (attack test for mutation 25), c93f167 (the page), 2f4b02f (e2e,
perf script), a1b011d (perf fixes and screen fixes), and this evidence commit.

## What changed

**Migration `supabase/migrations/20261018090000_stock_import.sql`** (sorts after 6b's `20261017090000`)

- `import_batches` takes `kind = 'stock'`; the one-writer index is per organisation **and kind**, so a lead import and
  a stock import can run together.
- `private.stock_import_staging` (the sheet's cleaned rows: RLS, restrictive `require_mfa`, admins with a fresh code
  only, column grants; `db_problem` generated from the products table's rules), `private.stock_import_changes` (what
  each import did to each product, for an exact undo), `products_import_column` (the only way to set
  `products.import_batch_id`), `private.stock_import_tally`.
- The batch guard's stock branch `private.stock_batch_step` (transitions of design 7.5, the transaction marker
  `topstock.stock_batch_op` as defence in depth, staging purged when an import closes), called by the recreated
  `private.import_batch_guard` (REBASE, from Day 3b).
- `private.lock_stock_import` (definer: product, then its levels, product by product in id order; uploader only while
  committing), `private.stock_undo_plan`, `private.stock_batch_for`.
- RPCs (invoker, static SQL): `create_stock_import`, `stage_stock_import_rows` (text pre-checks, constant errors),
  `validate_stock_import(p_batch, p_moved_policy keep_crm | use_sheet)`, `list_stock_import_issues`,
  `list_stock_import_changes`, `commit_stock_import(p_batch, p_max_rows default 125)`,
  `preview_stock_import_rollback`, `rollback_stock_import(p_batch, p_max_rows default 125)`, `discard_stock_import`,
  `list_stock_imports`.
- The 6a engine learns the sheet: `import_in` / `import_out` / `undo_in` / `undo_out` rows with compare-and-set, transfers
  tagged with the batch (stock the sheet now lists in the warehouse arrives as Arrived, holds included), import rows
  set "as the sheet says" (`crm_moved` false, `last_onhand_batch_id`), undo rows are CRM changes; import rows are not
  counted by the per-person rate guard. `nightly_stock_jobs` discards stock imports idle for 24 hours.
- Perf (a1b011d): the check's join back to the staging rows is hash-only (`enable_nestloop = off`, materialized CTE),
  set-based marks in the commit, indexes `stock_import_staging (batch_id, match_product_id)` and `stock_movements
  (import_batch_id, product_id)` (replacing 6a's batch-only index).

**App**

- Browser rules `src/lib/stock-import/` (`rules`, `headers`, `numbers`, `values`, `normalise`, `schema`, `types`): zero-click
  matching of Haider's header (accents and parentheses on or off; min/max read inside parentheses), French or English
  numbers detected per file with a live example, STATUS values with counts, every problem and warning of design 7.4,
  REVENTE tolerance max(0.50 €, 0.5 %), the swapped-columns banner, the stage payload (Zod strict, decimals as the exact
  text forms the database pre-checks). Day 3b's decode, parse, chunk and problems-file code is reused (the chunker now
  takes any row shape).
- `/inventory/import` (admins; everyone else 404; `loading.tsx`): Choose · Match · Check · Import, Past imports with
  Undo (preview, then chunks with a progress bar), Continue (a paused import) and Discard. Check: tiles (New products ·
  Updated · Kept (changed in the CRM) · Can't import), repeated and unchanged, pieces before → after per place, warnings
  with counts, "In the CRM but not in this sheet", "Use the sheet's quantities" / "Keep the CRM's numbers", rows to look
  at with the problems file, the change table (200 a page, TanStack Query). Step-up on every write; chunks halve after a
  timeout. Entry points: "Import sheet" on Inventory (admins) and the command palette.
- Routes `GET /api/stock-imports/[id]/issues` and `/changes`; server actions in `src/app/(app)/inventory/import/actions.ts`;
  `stockImportError()` (lock timeouts are "busy").
- Messages `StockImport` in EN and FR (French typography checked), `Inventory.importSheet`, `Palette.importStock`.
- Fake sheets: `scripts/make-fake-stock.mjs` (seeded, `--check`, `--rows N --out` for perf) writes
  `tests/fixtures/stock/` (`stock-40-fake.csv` and its Windows-1252 twin, English, parentheses-only, re-import,
  `expected.json`).

## Check results

| Check | Result |
|---|---|
| `bash scripts/db-test.sh` (copy on port 54381, on a1b011d) | exit 0: every suite passed (`rls_attack`, `import_attack`, `import_concurrency`, `activity_attack`, `activity_concurrency`, `outcome_attack`, `outcome_concurrency`, `stock_attack`, `stock_concurrency`, `inventory_attack`, `stock_import_attack`, `stock_import_concurrency`); `advisors: no ERROR-level findings` (WARN `set_user_role` as before; INFO 2 unindexed foreign keys, 11 unused indexes) |
| `supabase/tests/stock_import_attack.sql` | 11 sections: catalog, role matrix, staging shape and constant errors, every check rule on a crafted sheet, the commit (new, restored, kept, transfers, cost, tags), transit to warehouse as a transfer with holds, below_reserved, use_sheet, the undo (reverses untouched products, keeps moved and held ones, archives new products, restores prices unless edited), lead and stock flows never cross and run together, gates on products, the ledger and the lock helper (now with `lock_helper_uploader_only`), the nightly discard, `ledger_sums_match_levels` |
| `supabase/tests/stock_import_concurrency.sh` | 3 cases (`import_commit_vs_sale_target_respected` with both policies, `import_commit_vs_waiting_sale_order`, `import_chunk_vs_sales_no_deadlock`): passed in every db-test run |
| Mutations (`mutations.md`) | day6c: 9 of 9 database rows caught (row 25 after the new test); design row 26 caught by 5 unit tests. Re-runs of the Day 3b (10), 4a (1) and 6a (30) rows whose functions 6a/6c redefine: all as listed, except 6a row 1, caught in a re-run only (timing-dependent) |
| Perf I12 to I14 (`perf.md`, 3 runs) | I12 532–723 ms (budget 1,000); I13 per call max 1,364–1,467 ms (1,500), **whole 5,000 rows 30.8–32.6 s (30 s)**; I14 per call max 789–976 ms (1,500). Before the fixes: I12 188 s, I13 up to 4.4 s a call |
| `npm run test:unit` | 365 passed (stock specs: headers, numbers, values, normalise, schema, sample, parity) |
| Playwright `tests/auth/stock-import.spec.ts` (Chromium, shared local stack, build of a1b011d) | 6 passed: zero-click import of the 40-row sheet with the problems file and the step-up dialog; re-import (kept, use sheet, arrived as a transfer); undo with preview; Windows-1252, parentheses-only and English sheets; rep 404 and staging not exposed; screens |
| Screenshots (`screens/`, 72) | Choose, Match and Check at 390/768/1024/1280/1440/1728, light and dark, EN and FR; no console errors, no horizontal scroll |
| Audits (`audits.md`) | findings fixed in a1b011d; none open |
| `npm run lint` | 0 errors (3 existing warnings) |
| `npm run typecheck` | passed |
| `npm audit --omit=dev` | found 0 vulnerabilities |
| gitleaks (`origin/main..HEAD`, 46 commits) | no leaks found |
| `/security-review` (`security-review.md`) | no high-confidence vulnerability |
| Not run here | WebKit and Semgrep (CI only); Supabase MCP and dev advisors (no remote database by instruction) |

## Deviations from the design

1. **Lead imports count only lead batches against their own open cap** (`import_batch_guard`, REBASE): with stock
   batches in the same table, a stock import would otherwise block lead imports.
2. **Blank cells keep the product's value** (prices, carton, PP); the sheet's two prices replace both only when they stay
   in order.
3. **Undo rows count as CRM changes** (`crm_moved` true): a product undone is "moved in the CRM" for the next sheet.
4. **A cost that was empty before the import is not removed by the undo** (`authenticated` has no delete on
   `product_costs`); a cost the import changed is restored.
5. **`stock_attack.sql` changed for 6c** (insert columns now include `import_batch_id`; the products policies list
   includes `products_import_column`).
6. **No TypeScript name key and no `stock-key-parity.spec.ts`**: the browser never groups rows; repeated rows and
   matches are decided by `private.product_name_key` only.
7. **Decimals use the database's exact patterns** (`^[0-9]{1,8}(\.[0-9]{1,4})?$` for prices, 13 digits for PP) rather than
   the design's single `^\d{1,10}(\.\d{1,4})?$`.
8. **`prices_differ` is counted per row** (both rows of the product carry it), so the warning reads in rows.
9. **Chunks of 125 products** for commit and undo (the design's cap rule after 250 missed 1.5 s); the check runs with
   nested loops off.
10. **Past imports hide discarded checks**; a checked import cannot be reopened from Past imports (Discard only); a paused
    import can be continued. The Done screen says added · updated · kept (not "quantities set").
11. **The Choose step is a stock copy of Day 3b's** (5,000-row limit, stock texts) rather than a kind-aware shared
    component, so the lead import stays byte-identical; the stepper and the Discard dialog are shared.
12. **E2E names grouped**: `stock-import-security.spec.ts` is folded into `stock-import.spec.ts`; the local gateway
    answers 400 for a private table (real PostgREST answers 404), both accepted.
13. **Mutation script**: edits now reach later redefinitions automatically (`REDEFINERS`); Day 3b's "one import at a
    time" row also edits the index 6c recreates.

## Rebase points (built before Day 4c, 4d and 5a are merged)

- `private.import_batch_guard` (from Day 3b's lead import migration): recreated here with the stock dispatch.
- `private.stock_movement_a_guard`, `private.stock_movement_b_apply`, `private.nightly_stock_jobs` (from 6a, unmerged):
  redefined here; 6d redefines the first two again.
- 6a's `movements_batch_idx` is replaced by `movements_batch_product_idx`.

## Docs used (Context7)

`/tanstack/query` (useInfiniteQuery v5: initialPageParam, getNextPageParam, fetchNextPage, hasNextPage), `/vercel/next.js/v16.2.9`
(route handlers, loading.tsx, notFound), `/amannn/next-intl` (ICU plurals, useFormatter), `/colinhacks/zod/v4.6.5`
(strictObject, superRefine). papaparse is used only through Day 3b's `parse.ts` (unchanged).

## Open risks

1. **The whole 5,000-row import is 3–9 % over its 30 s budget on this runner** (every call is within 1.5 s). Next lever:
   set-based creation of new products. Recommendation: re-time on the dev project first.
2. 6b's open risk (two list sorts and the summary over budget at 5,000 products) is unchanged.
3. Day 6a mutation row 1 is caught by the concurrency test only when two sessions overlap: timing-dependent on a loaded
   runner.
4. WebKit now runs the inventory and stock import specs in CI (`testMatch` matches `inventory` and `import`); they were
   run here in Chromium only.
