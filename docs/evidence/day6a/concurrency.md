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

## Re-run after the verifier's findings (code head 47b68f9, branch head 61bb7e7)

Case 9 now has four parts: (a) and (b) as before, (c) a hold racing a deal lost with an expired hold at the level (the
verifier's 40P01; the hold must be refused with `deal_closed` and the deal lost, no deadlock, the expired hold still
there after the rollback), (d) a hold inserted straight into the ledger while the deal is lost (the apply step's own
deal lock). Output of `bash scripts/db-test.sh` (exit 0):

```text
twenty_reservers_one_product: 10 of 20 succeeded, wall clock 405 ms
random_ops_three_sessions: 275 applied, 25 refused, no deadlock
stock_concurrency: all checks passed
```

## Re-run after the verifier's second round (code head 96ff420)

Case 9 now has five parts: (e) Arrived of 50 holds the product's lock (and has moved the deal's transit holds: 30 moved
whole, 40 split into 20 at the warehouse and 20 left in transit) while the deal is lost. The deal must keep no active
hold, both levels must end with nothing held (transit 50/0, warehouse 50/0), and the split must have happened. Before
the fix, `bash scripts/db-test.sh` stopped with
`FAIL: reserve_vs_deal_lost (e): a lost deal kept an active hold: transit 50/0, warehouse 50/50`. After it (exit 0):

```text
twenty_reservers_one_product: 10 of 20 succeeded, wall clock 332 ms
random_ops_three_sessions: 283 applied, 17 refused, no deadlock
stock_concurrency: all checks passed
```
