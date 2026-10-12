# Day 6b: the Inventory page, 12 Oct 2026

Design: `docs/evidence/day6/design.md` (sections 3.2, 5.2, 10.1, 10.3, 10.6, 10.7, 11 and 13 "6b Inventory page"), with
Haider's 11 Oct answers (pieces only, prices excluding VAT, cost per piece = PP ÷ QUANTITÉ). Built on `day6a-local`
after merging `origin/main` (Day 4b, merge commit 35b3a3f: the Day 4b outcome tests and the 6a stock tests both run).
Commits: dafebf2 (database), cfcbb3d (app), 0ce054a (perf), eb936f9 (audit fixes), and this evidence commit (with one
toolbar width fix).

## What changed

**Migration `supabase/migrations/20261017090000_inventory_reads.sql`** (sorts after 6a's `20261016090000`)

- `private.stock_rows`: a `security_invoker` view, one row per product with both levels, held pieces, `status_key`
  (`archived`, `sold_out`, `arriving`, `low`, `in_stock`) and the cost per piece through a left join on
  `private.product_costs` (so a rep's row level security gives null, never an error).
- Read RPCs (all `security invoker`, static SQL, `search_path = ''`, authenticated only, constant 22023 hints):
  `list_stock` (keyset on name, available or updated; filters all, in_warehouse, in_transit, low, sold_out, held,
  hidden, archived; category; search by name or `P-0042`; hints `bounds`, `bad_filter`, `bad_sort`, `bad_cursor`),
  `count_stock`, `stock_summary` (the four KPIs, filter counts and categories), `get_product` (levels, cost, holds with
  their deal only when the caller may see the deal, last 20 movements), `list_movements` and `list_reservations`
  (keyset, page first), `get_inventory_settings`.
- Writes: `update_inventory_settings(p_alert_assignee, p_hold_days)` and `rename_location(p_kind, p_name)` (admins),
  `set_product_eta`, `set_product_share_visible` (managers and admins; fresh code where the design asks).
- List RPCs set `plan_cache_mode = force_custom_plan` and read the page first in a materialized CTE (0ce054a): the
  generic plan joined before the limit and took 300 ms on "movements before id 100,000"; now 2 ms.

**App**

- `/inventory` (`src/app/(app)/inventory/page.tsx`, `loading.tsx`): KPI row, tabs Stock · Arriving · Reserved ·
  Movements, toolbar (search with `/`, filter chips with counts, category, sort, pieces/cartons toggle), the stock
  table (TanStack Virtual, server keyset pages through TanStack Query, layout chosen by the table's own width: wide
  table with cost from 1000 px, medium from 600 px, cards below), J/K and arrows, Enter opens.
- The product: a split panel at ≥ 1280 px (spring, transform and opacity), a right side sheet from 1024 to 1279 px, its
  own page `/inventory/p/[id]` below (`loading.tsx`); actions Arrived, Correct stock (count, add, take out), Receive,
  Edit, Hide from clients, Archive / Restore, release a hold with Undo (A and E keys).
  Added in the Day 6e verifier round (05f15dd): Record sale (`S`) and Hold (`R`) on the panel for everyone, listed in
  the `?` sheet (design 10.1); see `docs/evidence/day6e/README.md`.
- Dialogs: new product (opening stock is a receipt: fresh code), correct and receive (fresh code), Arrived (partial,
  holds move with the stock), ETA inline on Arriving with bulk Arrived.
- `/inventory/settings` (admins, `loading.tsx`): alert assignee, default hold length, place names.
- Routes `GET /api/inventory/{stock,summary,movements,reservations}` and `/api/inventory/products/[id]` (session, Zod,
  `private, no-store`); server actions in `src/app/(app)/inventory/actions.ts` and `settings/actions.ts` (Zod
  `strictObject`, explicit RPC arguments, codes only back, `stockError()` in `src/lib/inventory/errors.ts`).
- Shared: step-up dialog body for stock (`StepUp.bodyStock`), command palette (Stock movements, Inventory settings),
  shortcuts sheet (Inventory section), `globals.css` (side-sheet slide, `animate-panel`), EN and FR messages
  (`Inventory`, `InventorySettings`; French typography checked by `tests/unit/messages.spec.ts`).

## Check results

Code head for the checks: cfcbb3d + 0ce054a + eb936f9 (the evidence commit adds only a category menu width at ≥ 1280 px,
re-shot below).

| Check | Result |
|---|---|
| `bash scripts/db-test.sh` (copy on port 54381, after dafebf2) | exit 0: `rls_attack`, `import_attack`, `import_concurrency`, `activity_attack`, `activity_concurrency`, `outcome_attack`, `outcome_concurrency`, `stock_attack`, `stock_concurrency`, `inventory_attack`: all checks passed; `advisors: no ERROR-level findings` (WARN `set_user_role` as before; INFO 2 unindexed foreign keys, 11 unused indexes on a fresh database) |
| `supabase/tests/inventory_attack.sql` | 11 sections: catalog (invoker, `search_path`, authenticated only), access (aal1, no session, other organisation), costs (rep reads null), validation hints, filters and counts, keyset walks for every sort, panel/movements/holds, deal visibility on a hold, settings and the one-field product changes, archived, `ledger_sums_match_levels` |
| Perf I1 to I4 (`perf.md`, 3 runs) | I4 within budget in every run; I3 4.2–5.9 ms avg (p95 8.8 ms against 8 in 1 run). **I1 sort by updated over 20 ms p95 in 3 of 3 (22.1–40.1 ms), sort by available in 2 of 3 (24.4, 27.5; 19.98 in run 1), filter sold_out in 1 of 3 (29.2)**; **I2 over 15 ms p95 in 2 of 3 (15.4, 17.4)**. Open risk 1 |
| Playwright `tests/auth/inventory.spec.ts` (Chromium, shared local stack, fresh build) | 10 passed in one run: `stock_table_filters_and_panel`, `new_product_with_opening_stock_step_up`, `count_sets_quantity_then_movements_log`, `arrived_partial_moves_hold`, `movements_log_keyset`, `rep_sees_no_cost_column_and_no_manager_actions; get_routes_read_only`, `inventory_390_no_horizontal_scroll_and_product_page`, `inventory_keyboard_only`, `inventory_empty_and_error_states`, `admin_settings`. `screens` failed there on a missing trace file (a unit run started at the same time emptied `test-results/`), then passed alone, and again on the evidence build (no console errors, no horizontal scroll at any width) |
| Screenshots (`screens/`, 72) | Stock table at 390/768/1024/1280/1440/1728, product panel or sheet or page at the same widths, Arriving, Movements and the correction dialog at 1440 and 390; light and dark, EN and FR |
| Apple design audit and Web Interface Guidelines audit (`audits.md`) | findings fixed in eb936f9 and this commit; none open |
| `npm run lint` | 0 errors (3 warnings: TanStack Virtual and the React compiler, one of them the new stock table) |
| `npm run typecheck` | passed |
| `npm run test:unit` | 365 passed (includes `tests/unit/inventory.spec.ts` and the 6c rule specs) |
| `npm audit --omit=dev` | found 0 vulnerabilities |
| gitleaks (`origin/main..HEAD`) | run on the final head (reported with the step) |
| `/security-review` (`security-review.md`) | no high-confidence vulnerability |
| Not run here | WebKit and Semgrep (CI only), `journey.spec.ts` (needs Mailpit), Supabase MCP and dev advisors (no remote database by instruction) |

## Deviations from the design

1. **Two extra one-field RPCs**, `set_product_eta` and `set_product_share_visible`: the Arriving tab edits the date in
   place and the panel hides a product from clients without sending the whole product.
2. **`private.stock_rows` view** (security invoker) shared by `list_stock`, `count_stock` and `stock_summary`, so the
   status rule exists once.
3. **`plan_cache_mode = force_custom_plan`** on the list RPCs (design 11.6 asks for the generic-plan check; the generic
   plan was the slow one here).
4. **No KPI count-up animation**: numbers change in place (reduced motion and screen readers get the same).
5. **Stock table without TanStack Table**: a virtualised list with the same keyset paging; the columns are fixed and
   sorting is server side, so the table library added nothing.
6. **`/` is a capture-phase listener** on the toolbar (the global palette listener registered first otherwise took it).
7. **E2E names**: `adjust_with_step_up_dialog` is covered inside `count_sets_quantity_then_movements_log` and
   `new_product_with_opening_stock_step_up`; `inventory_get_routes_read_only` is part of the rep test. The inventory spec is not yet in the WebKit `testMatch` (CI WebKit runs the shared specs only).

## Rebase points (built before Day 4c, 4d and 5a are merged)

- None in 6b's migration: it only adds objects. 6a's REBASE (`private.lead_import_untouched`) still stands.
- `messages/*.json`, the command palette and the shortcuts sheet will conflict textually with 4c/4d/5a (new keys and
  rows side by side): keep both.

## Docs used (Context7)

`/tanstack/virtual` (useVirtualizer, scrollMargin, measureElement), `/tanstack/query` (useInfiniteQuery,
placeholderData, invalidateQueries), `/vercel/next.js/v16.2.9` (App Router loading.tsx, notFound, route handlers),
`/amannn/next-intl` (useTranslations, useFormatter), `/colinhacks/zod/v4.6.5` (strictObject, coerce).

## Incident

While the shared local auth stack was serving `/home/user/topstock-crm-4d`, an early version of the restart script's
"busy" check missed it and the inventory e2e ran its `beforeAll` seed against that stack's database: fake users and
fake products were created there (local throwaway database, fake data only; no real data, no remote database). The
check was tightened (processes whose working directory is the served checkout) and the run stopped. The 4d build has
since finished and the stack was rebuilt for this worktree.

## Open risks

1. **I1 sorts by available or updated, and I2, over budget on this machine** (p95 20–40 ms against 20; 15–17 ms
   against 15) at 5,000 products. The sorts read the whole view to order it; an index-backed sort needs stored
   "available" and "updated" columns on products. Recommendation: re-time on the dev project first (this runner is
   slower and loaded), then decide.
2. 6a's open risk (Arrived over 5 ms in 1 of 3 runs) is unchanged.
