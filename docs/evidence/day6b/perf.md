# Day 6b performance: I1 to I4

`supabase/tests/perf_inventory.sql`, run by `scripts/db-perf.sh` right after `perf_stock.sql` on the same throwaway
PostgreSQL 16 (5,000 products: 60 % with warehouse stock, 20 % in transit only, 20 % sold out; 10,000 levels; about
200,000 ledger rows; 5,000 holds). Each case runs 25 times through the RPC as an admin; runs 6 to 10 print their plans
(auto_explain); the p95 is the slowest but one of runs 11 to 25. The three runs below used a reduced copy of
`db-perf.sh` (the stock seed plus I1 to I4 and I17 only) on port 54382, on code 0ce054a (the list RPCs with
`force_custom_plan` and page-first CTEs). Machine: the shared cloud runner, other builds running (load 2 to 4).

Before 0ce054a, "I4 list_movements before mid id" took 300 ms (generic plan: the joins ran before the limit); a LATERAL
rewrite of the view was tried and was slower (reverted).

| Case (budget) | Run 1 p95 / avg | Run 2 p95 / avg | Run 3 p95 / avg |
|---|---|---|---|
| I1 list_stock sort name (20 ms) | 3.00 / 2.57 | 3.89 / 2.88 | 3.20 / 2.89 |
| I1 list_stock sort available (20 ms) | 19.98 / 18.16 | **24.41 / 19.57** | **27.53 / 20.74** |
| I1 list_stock sort updated (20 ms) | **22.05 / 18.92** | **40.05 / 26.90** | **28.98 / 20.78** |
| I1 list_stock filter in_warehouse (20 ms) | 2.96 / 2.64 | 7.32 / 3.77 | 2.99 / 2.77 |
| I1 list_stock filter in_transit (20 ms) | 3.50 / 3.27 | 3.99 / 3.61 | 3.58 / 3.48 |
| I1 list_stock filter low (20 ms) | 12.91 / 12.16 | 19.19 / 16.72 | 14.84 / 13.34 |
| I1 list_stock filter sold_out (20 ms) | 16.35 / 15.28 | **29.20 / 23.23** | 15.13 / 14.79 |
| I1 list_stock filter held (20 ms) | 9.03 / 7.38 | 13.87 / 11.20 | 13.19 / 8.28 |
| I1 list_stock search "product 12" (20 ms) | 4.46 / 3.88 | 5.05 / 4.04 | 6.90 / 5.12 |
| I1 list_stock category Bags (20 ms) | 3.88 / 3.10 | 6.82 / 3.78 | 3.05 / 2.82 |
| I1 count_stock all (20 ms) | 1.60 / 1.51 | 2.72 / 1.91 | 1.79 / 1.65 |
| I2 stock_summary (15 ms) | 11.62 / 11.08 | **15.36 / 11.85** | **17.42 / 13.58** |
| I3 get_product (8 ms) | 5.26 / 4.18 | **8.81 / 5.92** | 5.11 / 4.67 |
| I4 list_movements page 1 (5 ms) | 2.69 / 1.62 | 3.85 / 2.34 | 1.59 / 1.39 |
| I4 list_movements before mid id (8 ms) | 2.66 / 2.25 | 6.27 / 2.25 | 1.88 / 1.55 |
| I4 list_movements kind release (30 ms) | 3.36 / 2.51 | 4.83 / 3.27 | 2.52 / 2.36 |

Bold: over budget. **Over:** I1 sort by available (3 of 3), sort by updated (3 of 3), filter sold_out (1 of 3); I2 (2 of
3); I3 (1 of 3, 8.8 ms against 8). I4 within budget in every run. I17 (`check_stock_integrity`, 6a) 202–244 ms avg.

Why the two sorts miss: "available" (on hand minus held in the warehouse) and "updated" (the latest of the product and
its levels) are computed per row in `private.stock_rows`, so the first page of 100 needs every product read and sorted;
the name sort walks the `(org_id, name_key)` index. A fix is a stored sort column on products kept by the engine's apply
step (6a's definer trigger already writes the levels under the lock), which belongs with a 6a rebase; recommendation:
re-time on the dev project first (open risk 1 in README).
