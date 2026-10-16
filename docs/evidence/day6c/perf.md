# Day 6c performance: I12 to I14

`supabase/tests/perf_stock_import.sql` after `perf_stock.sql` (5,000 products "Perf product N", 10,000 levels, about
200,000 ledger rows, 600 active holds), on a throwaway PostgreSQL 16 (a reduced copy of `scripts/db-perf.sh` on port
54383: shim, migrations, 1,000 fake companies, `perf_stock.sql`, `perf_stock_import.sql`). The sheet: 5,000 rows, 4,000
products already in the CRM (warehouse 2,100 for stocked ones, transit 650 for transit-only ones, prices up 0.10) and
1,000 new; checked with policy `use_sheet` so every product is applied. Each RPC call is its own transaction, timed by
psql `\timing`. Shared cloud runner, other builds running.

## Before the fixes (run 0, code 2f4b02f, chunks of 250)

| Case (budget) | Result |
|---|---|
| I12 `validate_stock_import` 5,000 rows (1,000 ms) | **187,656 ms** |
| I13 `commit_stock_import`, 21 chunks of 250 (1,500 ms each, 30 s in all) | **1,949–4,421 ms per call, about 55 s in all** |
| I14 `rollback_stock_import`, chunks of 250 (1,500 ms each) | **1,579–2,931 ms per call** |

Why (auto_explain and `pg_stat_statements`, track all, `diag` runs): the staging rows are never analysed, so the planner
believed a batch had one row and joined the check's results back to the staging table in a nested loop that re-ran the
whole window query per staged row (5,000 × 5,000); the commit marked each product's staging rows with a scan of the whole
batch (no index on the product id); the undo plan summed a product's import rows through the batch index (every row of
the batch, per product).

Fixes (a1b011d): the results CTE is materialized and the check runs with `enable_nestloop = off` (hash joins only); the
"not in this sheet" count uses a materialized key list; the commit's per-product marks became two set-based statements
at the end of the chunk; indexes `stock_import_staging (batch_id, match_product_id)` and `stock_movements
(import_batch_id, product_id)` (replacing 6a's batch-only index); chunks of 125 products (the design's cap rule: "if a
chunk misses, the default drops to 125"; `COMMIT_CHUNK` and both RPC defaults).

## After the fixes (code a1b011d, chunks of 125), 3 runs

| Case (budget) | Run 1 | Run 2 | Run 3 |
|---|---|---|---|
| I12 validate, 5,000 rows (1,000 ms) | 723 ms | 579 ms | 532 ms |
| I13 commit, per call: max / p95 / median (1,500 ms) | 1,467 / 1,231 / 766 ms | 1,421 / 1,294 / 674 ms | 1,364 / 1,320 / 750 ms |
| I13 whole sheet, 40 calls (30 s) | **32.6 s** | **30.8 s** | **32.4 s** |
| I14 rollback, per call: max / p95 / median (1,500 ms) | 976 / 920 / 721 ms | 795 / 777 / 646 ms | 789 / 717 / 628 ms |
| I14 whole undo (no budget) | 30.0 s | 26.0 s | 25.5 s |
| Integrity after the undo | 0 rows | 0 rows | 0 rows |
| I17 `check_stock_integrity` (6a, 1,500 ms) | 243 ms | 233 ms | 233 ms |

Every call is within its budget; **the whole 5,000-row import takes 30.8–32.6 s against 30 s** (over in 3 of 3 runs, by
3–9 %). The first calls of a sheet (new products: product guard, cost, change rows and audit rows per product) are the
slowest. Open risk 2 in README: re-time on the dev project; the next lever is set-based creation of new products.

These runs overlapped with the Day 6d migration being written in the same folder; its first two parts (tables and
policies, no triggers on the ledger) may have been applied too, which does not touch the import's statements.
