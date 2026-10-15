# Day 6d: sales, holds, requests and the stock automations, 12 Oct 2026

Design: `docs/evidence/day6/design.md` (sections 3.4, 4.5, 5.4, 6.1 to 6.9, 9, 10.2 to 10.4, 11 and 13 "6d Sales,
holds, lead Stock tab, automations"), with Haider's 11 Oct answers: all 21 recommendations accepted, prices excluding
VAT, pieces only, two sale types (Supplier Stock from Pakistan to the client's country; Warehouse inventory from
France), the team records sales (quantity, lead, price). Built on `day6a-local` after 6c. Fake data only.

Commits: 5bda95a (database and `sales_attack.sql`), 534f607 (concurrency), 2c5ee1c (mutation set), 5e9f0ab (app),
637b0a5 (e2e and picker fixes), 1b78186 (perf, set-based request reads), 1ba0c7d (audit fixes), and this evidence
commit.

## What changed

**Migration `supabase/migrations/20261019090000_sales_requests.sql`** (sorts after 6c's `20261018090000`)

- `private.orders` ("sales": number, lead, optional deal and request, type, status confirmed/cancelled, Supplier Stock
  ship-to country and note, the lead status a first sale replaced), `private.order_lines` (pieces, price per piece
  excluding VAT, line total generated, `below_min` set by the guard), `private.order_line_costs` (cost snapshot,
  managers and admins), `private.stock_requests` and `private.stock_request_lines` (team-logged now, client link in
  6e). RLS on, restrictive `require_mfa`, column grants only.
- `record_sale` (one transaction: the lead locked FOR UPDATE, the order, its lines, one `ship` row per warehouse line in
  product order through the 6a engine, which uses the lead's holds first; the first confirmed sale makes the lead a
  Customer, never from Do not contact or Disqualified), `undo_sale` (the seller within 120 s: returns, holds put back,
  lead status put back), `cancel_sale` (managers and admins, fresh code, a reason), `extend_reservation`,
  `list_sales`, `get_sale`, `get_lead_stock`, `list_lead_deals_for_stock`, `log_stock_request`,
  `set_stock_request_status`, `list_stock_requests`, `get_stock_request`, `stock_alerts`. All invoker, static SQL,
  constant pre-check messages, `search_path = ''`.
- The engine learns `ship` and `return` (REBASE of 6c's guard and apply step): a ship row needs a line of a warehouse
  sale recorded now by the caller, at most one per line (unique index), and uses the lead's holds first
  (`stock_hold_uses`).
- Automations (definer triggers, revoked): Restock task when a CRM movement takes the warehouse available to the
  reorder point or below (one open per product; imports, undo and expiry never do); "Arrived: record the sale of …"
  for the hold's creator when Arrived moves a hold to the warehouse; both through `private.insert_system_task`, which
  clears the caller's claims for the one insert and puts them back. `task_guard` (REBASE of 4a) keeps the new system
  links (`source_product_id`, `source_request_id`) unchangeable except to null by a cascade.
- `lead_import_untouched` (REBASE): a lead with a sale or a request is touched. Audit: `audit_sales_row` hides the
  request note, the requester's name and the idempotency key.
- Perf (1b78186): `private.requests_json(uuid[])` reads a lead's requests, their lines and live availability in one
  statement (I8 46 ms to about 12 ms).

**App**

- `src/lib/sales/` (schemas, dates, types, rank), `src/lib/sales-server.ts`, actions in
  `src/app/(app)/inventory/sales/actions.ts`, routes `GET /api/inventory/{sales,requests}[/id]`,
  `/api/inventory/alerts`, `/api/leads/[id]/stock`.
- The record-sale sheet (Warehouse inventory or Supplier Stock, product search with live availability and the lead's
  held pieces, pcs or cartons, price per piece prefilled with the max, below-minimum confirmation for managers and
  admins, ⌘/Ctrl + Enter, Undo in the toast), the hold sheet, the log-a-request sheet.
- The lead's Stock tab (Wants with live availability, Reserved with Sell / Extend / Release, Bought with the total and
  "Show all"); Inventory › Sales (type chips in the URL, detail with lines, Undo or Cancel with a reason and a code)
  and › Requests (status chips in the URL, Record sale prefilled, In progress, Done, Decline); the Requests badge;
  Cmd+K "Record sale…" and "Stock requests".
  Added in the Day 6e verifier round (05f15dd): Cmd+K "Hold stock…" (the hold sheet now picks its lead when opened
  without one) and the product panel's Record sale (`S`) and Hold (`R`); see `docs/evidence/day6e/README.md`.
- Messages `Sales` in EN and FR (French typography checked by `messages.spec.ts`).

## Check results

| Check | Result |
|---|---|
| `bash scripts/db-test.sh` (copy on port 54381, on 1b78186) | exit 0: every suite passed (`rls_attack`, `import_attack`, `import_concurrency`, `activity_attack`, `activity_concurrency`, `outcome_attack`, `outcome_concurrency`, `stock_attack`, `stock_concurrency`, `inventory_attack`, `stock_import_attack`, `stock_import_concurrency`, `sales_attack`, `sales_concurrency`); `advisors: no ERROR-level findings` (WARN `set_user_role` as before; INFO 2 unindexed foreign keys, 10 unused indexes) |
| `supabase/tests/sales_attack.sql` | 12 sections: catalog and grants, the role matrix (rep on another lead, below minimum, cancel windows), record_sale (holds used first and partly, idempotent, 51 lines, duplicate product, bad values with constant errors), Supplier Stock (no stock change, ship-to country), undo and cancel (holds and lead status put back), holds (extend bounds), requests (team, status changes, note masked in the audit), automations (Restock once per product, never from an import; Arrived task; claims cleared and restored), the table path (direct inserts refused), lead delete with a request task, `lead_delete_blocked_by_stock_history`, `ledger_sums_match_levels` |
| `supabase/tests/sales_concurrency.sh` | 7 cases (last cartons, both fit, twenty sellers, sale vs hold, crossed lines, Arrived vs sales, expiry vs sale): passed in every db-test run; integrity 0 rows after each |
| Mutations (`mutations.md`) | day6d: 22 rows, 20 caught, 2 documented two-layer rows, 0 not as listed (final run on 1b78186); re-runs of the earlier rows 6d's redefinitions reach (Day 3b 4, Day 4a 25, Day 6a 30): all as listed |
| Perf I6 and I8 (`perf.md`, 3 runs) | **I6 1 / 10 / 20 lines: average 8.7–15.8 / 29.5–61.8 / 46.0–59.6 ms (budgets 10 / 25 / 40)**; I8 average 10.8–14.1 ms (15), p95 over in 1 of 3 |
| `npm run test:unit` | 377 passed |
| Playwright `tests/auth/sales.spec.ts` (Chromium, shared local stack, build of 1ba0c7d) | 10 passed: keyboard sale and Undo, Supplier Stock, below minimum confirmed, hold then Sell (the hold used), team request answered from the inbox, old sale cancelled behind "Confirm it's you", rep read-only, empty sections and Cmd+K, URL filters, screens |
| Screenshots (`screens/`, 80) | Stock tab and Sales at 390/768/1024/1280/1440/1728; sheets and Requests at 390 and 1440; light and dark, EN and FR; no console errors, no horizontal scroll |
| Audits (`audits.md`) | findings fixed in 637b0a5 and 1ba0c7d; none open |
| `npm run lint` | 0 errors (3 existing warnings) |
| `npm run typecheck` | passed |
| `npm audit --omit=dev` | found 0 vulnerabilities |
| gitleaks (`origin/main..HEAD`) | no leaks found |
| `/security-review` (`security-review.md`) | no high-confidence vulnerability |
| Not run here | WebKit (CI only; `testMatch` now includes `sales`) and Semgrep (CI only); Supabase MCP and dev advisors (no remote database by instruction) |

## Deviations from the design

1. **The Home card is handed to Day 5** (design 12.1, case 2): `stock_alerts()` and `GET /api/inventory/alerts` are
   ready (low, sold out, arriving late, new requests, holds ending soon); Day 5 builds the Home dashboard in parallel.
2. **Sales and requests are not logged on the lead's timeline** (open question 19, accepted).
3. **E2E names grouped:** `lead-stock.spec.ts`'s Wants / Reserved / Bought checks are in `sales.spec.ts`; the design's
   `concurrent_sale_shows_only_n_left`, `deal_lost_releases_hold` and `restock_task_appears_in_tasks` are covered by
   `sales_concurrency.sh` and `sales_attack.sql` (the Tasks page is Day 4c, not merged).
4. **`private.requests_json(uuid[])`** replaces the design's per-request `request_json` and `product_availability`
   helpers (perf I8).
5. **The pickers' list opens on typing, a click or the Down arrow**, not on focus (it covered the next fields).
6. **No per-product "pairs" word**: pieces only (Haider, 11 Oct).

## Rebase points (built before Day 4c, 4d and 5a are merged)

- `private.task_guard` (from Day 4a's `20261011120000_activity_hardening.sql`; Day 4c left it as it was, and Day 5a's
  `20261015090000_deals_pipeline.sql` redefines it: `deal_id` joins the referential exception, so a deleted deal can
  empty the link. Re-copy from Day 5a's merged body at the rebase. Corrected 15 Oct 2026: this line said Day 4c.)
- `private.lead_import_untouched` (from 6a, unmerged).
- `private.stock_movement_a_guard`, `private.stock_movement_b_apply` (from 6c, unmerged); `private.movement_request_guard`
  and the `movement_requests` kind check (from 6a, unmerged).
- Day 5 must set `deals.status = 'lost'` when a deal enters Closed/lost (design 12.1); `list_lead_deals_for_stock` is
  dropped if Day 5 ships an equivalent.
- **`stock_alerts()` and Day 5c (Haider's decision B, 15 Oct 2026):** Day 5's Home low stock card reads this
  function ("use Day 6's version (stock_alerts), since it belongs to the stock module, and change the Home card to
  read it"). Day 5 merges first, and its migration `20261015150000_home_dashboard.sql` creates a null-returning stub
  with the same signature (plpgsql, stable, invoker, `search_path = ''`, the same two-factor check, authenticated
  only) when the function is absent. So 6d now uses `create or replace function public.stock_alerts()` (with a note in
  the migration header's "Redefines" list); the grant loop in section 8 is unchanged. Checked: `db-test.sh` copy on port
  54493 passes as it is and with the 5c stub created just before this migration (`sales_attack.sql`
  `stock_alerts_counts` reads the real body; the RPC rule loop still finds 13 authenticated-only invokers). The day6d
  mutation anchors are unchanged (24 edits on this file, every one found as often as before).
- **Day 5's tests that read `stock_alerts()`** (Day 5 advisor, 15 Oct 2026): four places on day5a-local assumed the
  5c stub's null and would break once this function replaces it; Day 5 made them work on either body (commit ceca0b5
  on day5a-local), so nothing changes here, but check them after the rebase: `supabase/tests/home_attack.sql`
  block 0 (`stock_alerts_stub_null`: null or exactly this function's keys and sample fields), and
  `tests/auth/home.spec.ts` "low_stock_placeholder_when_null (or Day 6's live card)", `card_error_isolated` and
  "low_stock_filled_from_day6_stock_alerts" (each reads the installed body: the stub's `return null;`, or this
  function's `from private.stock_rows` and `'sample'`; any other body fails). If this body changes its keys, its
  `from private.stock_rows` read or its `'sample'` key, update those helpers (`installedStockAlerts`) and the
  `home_attack.sql` key lists with it.

## Hosted dev pre-check (15 Oct 2026)

pg_cron on the DEV project, read through the read-only Supabase MCP (`swhkafqlmfhvgpsgdqjp`, `read_only=true`;
nothing written):

| Query | Hosted dev answer |
|---|---|
| `select * from pg_extension where extname = 'pg_cron';` | no row: **not installed** |
| `select name, default_version, installed_version from pg_available_extensions where name = 'pg_cron';` | `pg_cron`, default 1.6.4, installed null: **available** |

**Consequence.** 6a's migration schedules `topstock-nightly-stock` (`10 1 * * *` UTC, `private.nightly_stock_jobs()`)
only `if exists (select 1 from pg_extension where extname = 'pg_cron')`, and runs once. With dev as it is today the
dev deploy creates no schedule, and enabling pg_cron **after** that deploy does not add one: it would need a manual
`cron.schedule` call or a later migration. Holds still end on every RPC and page-load sweep, but what only the
nightly job does (as 6c defines it) would not run on dev: the integrity check and its "Stock check found a
difference" task, pruning movement requests older than 7 days, and discarding stock imports left open for 24 hours
together with their working rows (which hold costs). To decide (HAIDER DECIDES, recommendation): enable pg_cron on the dev project (Database, Extensions)
before Day 6 merges, and the same on production before the production deploy.

## Docs used (Context7)

`/tanstack/query` (useInfiniteQuery v5, invalidateQueries), `/vercel/next.js/v16.2.9` (route handlers, server actions,
loading.tsx), `/amannn/next-intl` (ICU plurals, useFormatter, relativeTime), `/colinhacks/zod/v4.6.5` (strictObject,
refine), PostgreSQL 17 manual (row locks FOR UPDATE / FOR SHARE, partial unique indexes, ON CONFLICT DO NOTHING).

## Open risks

1. **I6 is over budget** (about 2.3 ms a warehouse line through the 6a engine's per-row guard and apply step; perf.md).
   Lever: a set-based ship path. Recommendation: re-time on the dev project first.
2. I8's p95 brushes 15 ms on a loaded runner (average 11–14 ms).
