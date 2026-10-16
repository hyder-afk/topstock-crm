# Day 6d performance: I6 and I8

`supabase/tests/perf_sales.sql` after `perf_stock.sql` (5,000 products, 10,000 levels, about 200,000 ledger rows,
5,000 holds of which 600 active), on a throwaway PostgreSQL 16: a reduced copy of `scripts/db-perf.sh` on port 54381
(shim, the migrations of commit 1ba0c7d, 30,000 fake companies, `perf_stock.sql`, `perf_sales.sql`). `db-perf.sh` now
runs `perf_sales.sql` after `perf_inventory.sql`.

Seed added by `perf_sales.sql`: 10,050 sales with 30,150 lines on the first 1,000 leads (half Warehouse inventory, half
Supplier Stock, a tenth cancelled) and 2,020 team requests with 4,040 lines; one lead of its own with 50 sales of 3 lines,
20 requests and 20 active holds (the holds through `post_stock_movement`, so the integrity check stays at 0 rows).

Method: each case runs 25 times as an admin with a fresh code; runs 1 to 5 are not shown, runs 6 to 10 print their plans
through auto_explain (the Day 4 generic-plan check; kept in the run logs, not committed), then the p95 (the slowest but
one) and the average of runs 11 to 25. Each `record_sale` is rolled back by a savepoint, so the per-person rate guards
and the stock stay put. Shared cloud runner with the 6d mutation run (another cluster) going at the same time.

## Results (ms, p95 / average)

| Case (budget) | Run 1 | Run 2 | Run 3 |
|---|---|---|---|
| I6 `record_sale` 1 line (10) | **10.74** / 8.78 | **10.86** / 8.67 | **23.63** / 15.82 |
| I6 `record_sale` 10 lines (25) | **37.99** / 30.23 | **42.16** / 29.46 | **113.25** / 61.78 |
| I6 `record_sale` 20 lines (40) | **80.50** / 55.84 | **50.06** / 46.02 | **82.55** / 59.62 |
| I8 `get_lead_stock` (15) | **19.71** / 14.09 | 12.68 / 10.81 | 14.43 / 12.11 |
| `list_sales` page 1, all leads (no budget) | 5.75 / 3.45 | 3.23 / 2.58 | 7.19 / 4.04 |
| `list_stock_requests` page 1, open (no budget) | 5.14 / 4.44 | 6.04 / 4.12 | 9.18 / 6.56 |
| `stock_alerts` (no budget; the Home card) | 17.77 / 15.22 | 47.67 / 25.93 | 54.84 / 27.58 |

Bold: over budget. The integrity check found 0 rows after every run.

## What changed during the build

- **I8 was 46.58 ms average (68.72 p95) before 1b78186.** `get_lead_stock` built each of the 20 requests with its own call
  of `private.request_json`, which called `private.product_availability` per line: 20 planned statements, each joining
  the companies table again under its policies. `private.requests_json(uuid[])` now reads the requests, their lines and
  the levels of the products they name in one set-based statement (also used by `get_stock_request`): about 10–14 ms.
- **I6 is over budget (about 2.3 ms a warehouse line).** The plans (auto_explain, run 10 of the 20-line case) put the time
  in the per-row work every sale line does through the 6a engine: the `ship` row's guard (the line, the order, the
  product, the place, the rate guard) and the definer apply step (the level lock, the holds used, the ledger row, the
  audit row and the Restock check), about 2.5 ms a line with auto_explain's own overhead; the order, the lines and the
  first-sale "Customer" status add about 6 ms once. 6a's own single movement (I5) measures 3–5 ms on this runner, so a
  20-line sale at 46–60 ms average is the engine's cost per row, not a missing index. The lever would be a set-based
  ship path (one guard and one apply call for all the lines of a sale), a change to the 6a engine's contract; it is
  listed as an open risk with the recommendation to re-time on the dev project first (the runner was shared with the
  mutation run here, see run 3).
