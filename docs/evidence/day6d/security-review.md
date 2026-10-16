# Day 6d security review (12 Oct 2026)

Scope: every 6d commit (5bda95a to 1ba0c7d): `supabase/migrations/20261019090000_sales_requests.sql`, `sales_attack.sql`,
`sales_concurrency.sh`, `perf_sales.sql`, `scripts/db-mutations.py` (day6d set), `src/lib/sales/**`,
`src/lib/sales-server.ts`, `src/app/(app)/inventory/sales/actions.ts`, `src/app/api/inventory/{sales,requests,alerts}/**`,
`src/components/sales/**`, `src/components/lead/stock-tab.tsx`, the Inventory tabs, messages. Method: the
`/security-review` checklist (CLAUDE.md SECURITY, Master Plan 8 A to F) read against the diff, with the design's threat
rows S2, S5, S6, S7, S9, S10, T1, T2, A2 and A3.

## Result

No high-confidence vulnerability.

## What was checked

| Area | Finding |
|---|---|
| Row level security | The five new tables are in `private` (no REST endpoint), RLS on, restrictive `require_mfa`, every grant revoked then column grants only (orders: the client's columns; lines: no `below_min`, no totals; costs: select for managers and admins only) |
| Who may do what | Selling needs an editor of the lead (owner, manager, admin; the lead row locked FOR UPDATE under its update policy); reps cannot sell below the minimum (the RPC and the line guard, two layers, both mutation-tested); Undo by the seller within 120 s; Cancel later by a manager or admin with a code from the last 10 minutes and a reason (`has_recent_aal2(600)`) |
| Stock rules | A sale moves stock only through the 6a engine (`ship` rows, unique per line; `return` rows on undo or cancel); the guard refuses a ship row without a line of a sale recorded now by the caller; holds of the same lead are used first and put back on undo; integrity is clean after every concurrency case (last cartons, twenty sellers, crossed lines, Arrived vs sales, expiry vs sale) |
| Definer code | Trigger functions only (`order_line_cost_snapshot`, `stock_low_automation`, `hold_arrived_task`, `audit_sales_row`, the apply step) plus `private.insert_system_task` called by them: owner postgres, `search_path = ''`, static SQL, revoked from public, anon and authenticated. System tasks clear the caller's claims for the one insert and put them back (mutations 9 and 10) |
| Input | Server actions parse with `z.strictObject` and call ONE RPC with explicit arguments; the RPCs pre-check every value as text with constant messages (no user text in errors; `sales_attack` checks the marker never appears); JSON lines are read with `jsonb_array_elements`, never interpolated; no PostgREST filter strings |
| Errors and logs | `stockError()` maps SQLSTATE and hint to codes; the request note and requester name are hidden from the audit (`audit_sales_row`); no `console` in the sales code (ESLint scope) |
| Abuse | 60 sales and 60 requests a minute per person; 50 lines a sale, 20 a request; one open Restock task per product and one open request task per lead (partial unique indexes) |
| Output | No `dangerouslySetInnerHTML`; names and notes render as text (`dir="auto"`, `translate="no"` for product names) |
| Keys and data | No secret in the diff (gitleaks: no leaks); every fixture and seed is invented |

## Residual risks

1. A 20-line sale takes 46–60 ms on this runner (budget 40 ms; perf.md): a slower Undo-able action, not a correctness
   risk.
2. `task_guard`'s cascade exception and its "system link" rule are each behind a second layer (column grants), so their
   mutations are documented as two-layer rows (not caught alone).
