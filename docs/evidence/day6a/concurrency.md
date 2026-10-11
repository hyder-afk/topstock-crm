# Day 6a concurrency: raw `stock_concurrency.sh` output, 11 Oct 2026

From `bash scripts/db-test.sh` on 6f37e23 (the final engine and test code), local PostgreSQL 16.15. The script prints
only its timing lines and the final verdict; every case checks the final levels, the losing session's SQLSTATE and
hint, and ends with `check_stock_integrity` (any failure stops the run with `FAIL: ...`). Cases: design 11.2 for 6a
(`supabase/tests/stock_concurrency.sh` header lists all 11). Perf mode (I16) output is in `perf.md`.

```text
twenty_reservers_one_product: 10 of 20 succeeded, wall clock 339 ms
random_ops_three_sessions: 275 applied, 25 refused, no deadlock
stock_concurrency: all checks passed
```
