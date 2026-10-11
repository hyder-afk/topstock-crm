# Day 6a speed at Release 1 size: the stock engine, 11 Oct 2026

Design: `docs/evidence/day6/design.md` section 11.6, part 1 for 6a (I5, I7, I16, I17, I18). Re-runnable with
`bash scripts/db-perf.sh`:

1. a throwaway PostgreSQL 16.15 with the auth stand-in and every migration, including
   `20261016090000_stock_engine.sql`;
2. `perf_leads.sql` (30,015 leads, Day 3a list timings) and `perf_day4.sql` (300,008 activities, 15,000 tasks, Day 4
   timeline timings), unchanged;
3. `perf_stock.sql` (new): 5,000 products (3,000 with warehouse stock, 1,000 in transit only, 1,000 sold out), both
   places each (10,000 levels), 5,000 holds on 1,000 leads (600 active, the rest released or ended), 200,000 ledger
   rows; written with triggers off (`session_replication_role = replica`, as on Day 4), consistent with every
   integrity check (`check_stock_integrity` returns 0 rows on the seed), then `vacuum analyze`. Then I5, I7 and I17 as
   an admin with a fresh code, row level security on;
4. `perf_import.sql` (Day 3b import and undo), now **after** the stock seed, so the undo's "untouched" rule (which
   now also asks for holds) runs with 5,000 holds in place;
5. `stock_concurrency.sh perf` (I16): 20 sessions holding the last pieces, then 3 sessions of 300 mixed operations
   each on 20 hot products.

Machine: this cloud session, 4 vCPU, **shared with another session running Playwright at the same time**, so timings
vary by about ±30% between runs (see I18). Sizes after the seed: `stock_movements` 90 MB at 200,000 rows with its 9
indexes (design estimate: about 15 MB a year at 50,000 rows), `products` 2.5 MB, `stock_levels` 2.0 MB,
`stock_reservations` 2.3 MB.

Two sets of three runs were made on the final engine code (the commits after 1887db3 change only tests and
documents; the migration is unchanged since 2b5b847). **Set B** (below, the reference) alternated each 6a run with a
run of `origin/main` (1004fa5, Day 4a) so I18 compares like with like. Set A, three 6a runs one after the other a few
minutes earlier, is listed for the spread.

## I5, I7: post_stock_movement (budget 5 ms each; Arrived with 5 holds 25 ms)

Each case: 15 calls, each undone (so levels, holds and the rate guard stay put); runs 1 to 5 settle, runs 6 to 10
print their plans, runs 11 to 15 are timed. Average (slowest), milliseconds:

| Case | Set B run 1 | Set B run 2 | Set B run 3 | Set A runs 1 / 2 / 3 (avg) | Budget |
|---|---|---|---|---|---|
| I5 adjust_out (fresh code, 20-row history) | 4.10 (4.25) | 2.44 (2.71) | 4.33 (5.05) | 3.78 / 3.65 / 2.49 | 5 |
| I5 reserve (a lead's hold) | 4.33 (4.55) | 2.67 (2.76) | 4.62 (4.85) | 3.45 / 4.52 / 2.47 | 5 |
| I5 transfer (Arrived 1 piece, moves 1 held piece) | **5.76** (7.16) | 4.68 (4.97) | **5.76** (7.93) | **7.25 / 7.13 / 6.69** | 5 |
| I7 Arrived 300 pieces carrying 5 holds | 5.72 (6.97) | 4.69 (4.88) | 5.91 (7.00) | 7.54 / 7.66 / 8.22 | 25 |

- **adjust and reserve: within budget** in every run (2.4 to 4.6 ms average).
- **Arrived (transfer) misses the 5 ms budget in 5 of 6 runs** (4.68 to 7.25 ms). It posts two ledger rows (transit
  out, warehouse in), each with the full guard, apply step, audit row and a level lock, and first ends due holds at
  both places and locks the product; one ledger row costs about as much as a whole adjust. In the quietest run (set
  B run 2) everything was about 40% faster and Arrived took 4.68 ms. Arrived is a manager action used a few times a
  day per delivery; I7 (25 ms) holds with a wide margin. Recorded as an open risk (README) rather than optimised in
  6a: the cost is spread over many small statements (no plan is wrong, see below), and the budget should be re-read
  on a quiet machine (CI or dev) before deciding.
- **Generic-plan check.** Runs 6 to 10 of each case printed every nested statement's plan (1,580 plans per run). From
  run 6 the plans show parameters (`$1`, `$17` ...), that is PostgreSQL switched to generic plans, and every one of
  them is an index scan or a bitmap scan on a primary key or one of the new indexes: `stock_levels_pkey`,
  `products_pkey`, `locations_pkey`, `locations_org_id_kind_key`, `movements_user_created_idx` (rate guard),
  `movements_pair_once_idx` and `stock_movements_pkey` (transfer pairing), `reservations_fifo_idx` (holds moved by
  Arrived), `stock_reservations_pkey`, `companies_pkey`, `profiles_pkey` (role helpers). **No sequential scan** of any
  table in any of the plans. So the stock RPCs need no `force_custom_plan`.

## I16: concurrency (budget 3 s wall clock; p95 25 ms, 0 deadlocks, integrity 0 rows)

| Case | Set B run 1 | Set B run 2 | Set B run 3 | Set A runs 1 / 2 / 3 |
|---|---|---|---|---|
| 20 sessions hold 24 each of 240 (10 must succeed) | 355 ms | 377 ms | 375 ms | 397 / 368 / 376 ms |
| 3 sessions × 300 mixed operations on 20 hot products: wall clock | 1,581 ms | 1,618 ms | 1,888 ms | 1,574 / 1,913 / 1,579 ms |
| same: p95 per operation (applied) | 7.12 ms (827) | 7.51 ms (838) | 7.99 ms (841) | 7.36 / 7.36 / 7.16 ms |
| refused (constant 22023 / P0002 errors: not enough stock, held, nothing to release) | 73 | 62 | 59 | 66 / 58 / 66 |

Every run: exactly 10 of 20 holds succeeded and 10 got `over_reservation`; no deadlock (the script fails on any
40P01) and no unexpected error; `check_stock_integrity` 0 rows afterwards. **Within budget.**

## I17: check_stock_integrity at 200,006 ledger rows (budget 1,500 ms)

Average (slowest) of 5 runs after 2, as an admin, 0 rows each time: set B 279.0 (332.2), 230.6 (294.0), 279.3 (351.2)
ms; set A 247.9, 202.7, 195.3 ms. **Within budget** (about a fifth of it). The nightly job runs the same checks per
organisation.

## I18: Day 3a, 3b and 4 timings re-run (budget: within +10%)

Set B, average of the three runs each, milliseconds (6a against `origin/main` run in turn on the same machine):

| Step | origin/main | 6a | Change |
|---|---|---|---|
| Import chunk (1,000 leads, 28 calls), average | 275.0 | 301.9 | +10% |
| Undo chunk (2,000 leads, 14 calls), average | 237.5 | 280.5 | +18% |
| Undo preview (evaluates the "untouched" rule for all 27,356 imported leads in one statement) | 144.1 | 138.0 | −4% |
| Add rows (1,000 per call), average | 66.8 | 70.4 | +5% |
| Check 30,000 rows | 1,233.6 | 1,469.9 | +19% |
| Check 50,000 rows | 2,470.6 | 2,622.1 | +6% |

Every run gave the Day 3b results exactly (27,356 imported, 281 late duplicates skipped, 300 rejected; the undo kept
the 100 worked-on leads).

- **The machine's noise is larger than the budget.** The Check (which 6a does not touch: it reads only the staging
  rows and leads) is +19%, and the Day 3a leads-list cases, which run before any stock data exists and read nothing
  6a changed, range from −23% to +38% case by case between the two builds (Day 4 timeline and entry timings from −19%
  to +23%). So these runs cannot show a +10% change either way.
- **What 6a really adds to the undo:** one `not exists` on `stock_reservations` (index `reservations_company_idx`) in
  the "untouched" rule, and, for each deleted lead, the foreign-key check from `stock_reservations` (`on delete
  restrict`, same index). The preview, which runs the changed rule over every imported lead in one statement, shows no
  increase (−4%). The undo chunk's +18% sits inside the spread of the unaffected cases.
- Recorded as an open risk: re-time P7 and the undo on a quiet machine (or in CI's db job) before Gate 1.

## Not measured in 6a

I1 to I4 (inventory reads, 6b), I6 and I8 (sales, 6d), I9 to I11 (client link, 6e), I12 to I14 (stock import, 6c),
I15 (the nightly job at size: arrives with 6c's batch clean-up; its parts are I17 and the expiry RPC path).
