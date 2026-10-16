# Day 6b security review (12 Oct 2026)

Scope: `dafebf2..` the evidence commit: `supabase/migrations/20261017090000_inventory_reads.sql`, its attack test, the
Inventory routes, server actions, components and libraries (`src/app/(app)/inventory/**`, `src/app/api/inventory/**`,
`src/components/inventory/**`, `src/lib/inventory/**`, `src/lib/inventory-server.ts`), shared edits (step-up dialog,
palette, shortcuts, CSS, messages). Method: the `/security-review` checklist (CLAUDE.md SECURITY, Master Plan 8 A to F)
read against the diff, plus the design's threat rows that 6b touches (S1 to S6, S10 to S12).

## Result

No high-confidence vulnerability.

## What was checked

| Area | Finding |
|---|---|
| Row level security | No new table. The view `private.stock_rows` is `security_invoker`, so products, levels, holds and costs keep their own policies (and the restrictive `require_mfa`). `private` has no REST endpoint |
| RPCs | Every new function is `security invoker`, `set search_path = ''`, static SQL (no `format`/`execute`), `revoke ... from public, anon` then `grant execute ... to authenticated` (the attack test's catalog section checks all three). No new definer function |
| Costs | A rep's `cost_per_piece` is null through `product_costs` row level security (attack section 3; e2e `rep_sees_no_cost_column...` checks the column is absent and the API field null) |
| Deal names on holds | `get_product` and `list_reservations` show a hold's deal only when the caller can select that deal (attack section 8: rep b1 does not see a1's deal) |
| Search | The search text is an RPC argument, escaped for `LIKE` inside SQL (`%` and `_` literal: attack tests `Inv6b%Produit`, `Produit _1`); no PostgREST filter strings anywhere (`.or(` and `.filter(` absent from the new code) |
| Writes | Server actions: Zod `strictObject`, `requireSession()` (aal2), one RPC with explicit arguments, codes only back (`stockError()`); stock changes go through 6a's `post_stock_movement` only; settings and place names are admin-only in SQL; corrections, receipts, opening stock and archive ask for a fresh code (`has_recent_aal2(600)` in the engine; the dialog asks and retries the same request id) |
| Routes | GET only; `apiSession()` (401 without a session), Zod on params and query (400), `Cache-Control: private, no-store`, database errors mapped to codes (no raw message) |
| Output | No `dangerouslySetInnerHTML`; product names, categories and notes render as text (`translate="no"` on names); no `console.*` in the new code |
| Keys | No service key or secret in the diff (gitleaks on the final head); only the public URL and anon key are used by the browser |
| Denial of service | Page sizes capped in SQL (`bounds` hint: 1 to 100 rows, 50 for movements); keyset cursors validated (`bad_cursor`); the list RPCs plan per call so one slow generic plan cannot stick |

## Residual risks

1. The Inventory page shows prices per piece to every team role (design: reps see prices, not costs).
2. The perf misses in README open risk 1 are speed, not safety.
