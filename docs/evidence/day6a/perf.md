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

Two sets of three runs (A and B) were made on the first build's engine code (migration as of 2b5b847); set C (below
the I5 table) re-times I5, I7, I16 and I17 on the final code after the verifier's fixes and the Arrived trim. **Set B** (below, the reference) alternated each 6a run with a
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

### Re-timed after the verifier's findings, and Arrived trimmed (set C, code head 47b68f9)

The verifier asked for three more runs. A profile first (scratch harness: shim, migrations, `perf_leads.sql`,
`perf_stock.sql`, then 50 more Arrived calls under `pg_stat_statements` with `track = all`) showed where an Arrived
spends its time: the two ledger inserts (guard, apply step, audit row) about 3.8 ms of 6.4 ms, then two separate expiry
calls (0.6 ms), the result's level read (0.33 ms), re-reading the transit level (0.15 ms) and the arrival row
(0.18 ms), and two place lookups (0.27 ms). Every statement uses an index (the plans above), so no index or plan
change helps. The trim (47b68f9) has fewer statements, the same rows and the same locks:

- one expiry call for both places (`expire_holds_for` already goes in level order);
- the two places read in one statement;
- what is left in transit and the held pieces moved taken from the two rows' `RETURNING` snapshots, which the apply
  step writes under the lock;
- no rate count on the paired `transfer_in`.

**Paired runs, scratch harness** (the same seed without the Day 4 data and the import; before and after the trim run
in turn), I5 transfer average (slowest), ms:

| Run | Before the trim | After the trim |
|---|---|---|
| 1 | 7.98 (8.09) | 4.07 (4.21) |
| 2 | 4.62 (4.78) | 3.89 (4.37) |
| 3 | 5.55 (8.97) | 3.79 (4.34) |

In the same runs, adjust averaged 4.73 / 2.60 / 4.09 ms before and 2.65 / 2.56 / 3.38 ms after (it is not changed by
the trim; this shows the machine's noise). Arrived per adjust went from 1.36 to 1.78 times down to 1.12 to 1.54 times.

**Set C: `bash scripts/db-perf.sh` three times on the final code** (the full chain, as sets A and B; the machine's
load average rose from 0.9 to 3.3 during the set, as another session was working), average (slowest), ms:

| Case | Set C run 1 | Set C run 2 | Set C run 3 | Budget |
|---|---|---|---|---|
| I5 adjust_out | 11.29 (37.15: one stall) | 2.74 (3.16) | 3.43 (3.70) | 5 |
| I5 reserve | 3.79 (4.40) | 3.49 (7.01) | 3.72 (4.33) | 5 |
| I5 transfer (Arrived) | 4.11 (4.52) | 4.23 (4.75) | **5.78** (5.97) | 5 |
| I7 Arrived carrying 5 holds | 4.45 (6.33) | 4.09 (4.37) | 5.95 (6.34) | 25 |
| I17 check_stock_integrity | 222.3 (280.3) | 204.6 (269.5) | 215.1 (253.3) | 1,500 |

- **Arrived is within 5 ms in 2 of 3 full runs and in all 3 paired runs, and over in run 3 (5.78 ms)**, the busiest
  run (load 3.3), where adjust also took 3.43 ms. Arrived posts two ledger rows, so it costs about 1.5 to 1.7
  adjusts (runs 2 and 3), and the budget leaves no room for that on a loaded machine. **It stays an open risk** (README). Next:
  re-time in CI or on dev, then Haider decides whether to accept it or trim it in 6b. The next trim would build the
  answer's levels from the two rows' snapshots (about 0.3 ms).
- adjust run 1: one call of the five took 37 ms, a machine stall; the other four averaged 4.8 ms.
- I16 in set C: 20 sessions 394 / 569 / 564 ms (budget 3,000); 3 × 300 operations p95 7.34 / 11.39 / 10.29 ms
  (budget 25), 0 deadlocks, integrity 0 rows each run.

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
I15 (the nightly job at size: arrives with 6c's batch clean-up; its parts are I17 and the expiry RPC path; README
deviation 16). I18 was not re-run in set C: the fixes and the trim do not touch the import, the undo or the lead
lists.
