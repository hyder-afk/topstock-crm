# Analytics P1: database timings

Date: 17 Oct 2026. Branch `analytics`. Design budgets: `design.md` section 3.7.

## How it was measured

- **Seed.** The `scripts/db-perf.sh` seed, run in order: `perf_leads.sql`, `perf_day4.sql`, `perf_day5.sql`,
  `perf_stock.sql`, `perf_inventory.sql`, `perf_sales.sql`, then the new `supabase/tests/perf_analytics.sql`. That is
  30,015 leads, 300,008 activities over 2 years (a1, b4, c4), 15,000 tasks, 10,000 deals with 40,046 history rows, and
  10,050 sales with 30,150 lines over 200 days.
- **Database.** Local PostgreSQL 16 with the auth shim and every migration, row level security on, two-factor claims.
- **Method.** 5 warm-up runs, then the average of 5 timed runs (`pg_temp.time_case`). Each range ends on Paris today.
- **Who.**
  - Team: admin `0a`.
  - Own figures: rep `b4` as himself. For sales: admin `0a` picks `a6`, who recorded every seeded sale.
  - List quality: 20 imported batches over all 30,017 leads (round-robin), made inside a transaction that is rolled back.
- **Disk.** This VM had about 1 GB free, so the cluster ran with `fsync=off`, `wal_level=minimal` and
  `max_wal_size=64MB`. These settings affect writes and WAL size, not these read-only timings. The first attempt with
  the default settings ran out of disk while seeding. The rest of `db-perf.sh` (share, import, files, concurrency) was
  not re-run here, because this PR does not change those parts. `perf_analytics.sql` is wired into `db-perf.sh` right
  after `perf_sales.sql`, as the design says.

## Results (final migration, `jit = off`)

×3 is the projection for Supabase Free (design 3.7).

| Function | 30 d team | 30 d own | 90 d team | 90 d own | 365 d team | 365 d own | Local budget 30 / 90 / 365 |
|---|---|---|---|---|---|---|---|
| analytics_activity | 33.0 | 9.4 | 88.0 | 27.1 | **239.2** | 79.2 | 60 / 150 / 400 |
| analytics_pipeline | 10.1 | 6.3 | 18.4 | 10.4 | 58.5 | 28.5 | 40 / 60 / 120 |
| analytics_speed | 7.0 | 2.2 | 23.4 | 6.2 | 67.6 | 22.0 | 40 / 80 / 200 |
| analytics_call_times | 26.1 | 8.5 | 61.6 | 20.1 | 185.9 | 51.8 | 60 / 150 / 400 |
| analytics_sales (own = person a6) | 15.4 | 16.5 | 53.3 | 53.4 | 155.0 | 139.2 | 30 / 80 / 200 |

| Snapshot function | Team | Own / person | Budget |
|---|---|---|---|
| analytics_coverage (30 days idle) | 28.2 | 11.4 (rep b4) | 60 |
| analytics_batches (20 batches, 30,017 leads) | 335.1 | 94.5 (admin picks b4) | 400 |

All times are in milliseconds, and every case is within its local budget.

Page budgets with the ×3 margin (design 3.7):

| Check | Slowest | ×3 | Limit | Result |
|---|---|---|---|---|
| Slowest function at 90 days | activity team, 88.0 ms | 264 ms | under 1,000 ms | met |
| Slowest function at 365 days | activity team, 239.2 ms | 718 ms | under 1,500 ms | met |

## Second run: the full `scripts/db-perf.sh`, on a loaded machine

After disk space came back, the unmodified `bash scripts/db-perf.sh` ran end to end and exited 0. It used the default
cluster settings, the whole suite, and `perf_analytics.sql` after `perf_sales.sql`. The seed it reported was 300,458
activities, 30,018 leads, 10,020 deals and 10,050 sales.

Other sessions were running Playwright and tsc on the same 4-core VM at the time (load average about 11). These numbers
are therefore an upper bound, not a clean measurement:

| Function | 30 d team | 30 d own | 90 d team | 90 d own | 365 d team | 365 d own |
|---|---|---|---|---|---|---|
| analytics_activity | 41.2 | 14.9 | 113.7 | 27.4 | 394.4 | 93.3 |
| analytics_pipeline | 16.6 | 10.5 | 23.0 | 11.1 | 105.5 | 31.3 |
| analytics_speed | 7.2 | 2.2 | 26.5 | 7.5 | 105.7 | 45.2 |
| analytics_call_times | 55.3 | 40.7 | 100.3 | 37.6 | 261.0 | 113.4 |
| analytics_sales (own = person a6) | 39.9 | 17.3 | 118.4 | 98.6 | 171.0 | 234.4 |

| Snapshot function | Team | Own / person |
|---|---|---|
| analytics_coverage | 39.5 | 9.1 |
| analytics_batches (20 batches) | 481.3 | 175.8 |

What the loaded run shows:
- **Page budgets with ×3: still met.**
  - Slowest at 90 days: sales team 118.4 ms, ×3 = 355 ms (under 1 s).
  - Slowest at 365 days: activity team 394.4 ms, ×3 = 1,183 ms (under 1.5 s).
- **Per-function local budgets: five over under load** (four sales cases plus batches team).
  - sales: 30 d team, 90 d team and person, 365 d person.
  - batches team.
- **The noise is visible:**
  - sales for one person at 365 days (234 ms) came out slower than the whole team (171 ms), although it reads a
    subset of the same rows;
  - the 30-day call-time read for one rep took 41 ms here and 8.5 ms in the first run.
- **The first table is the measurement of record.** Re-time on a quiet runner before P3's page timing:
  `bash scripts/db-perf.sh`, which includes `perf_analytics.sql`.
- **Activity at 365 days is close to the 400 ms covering-index threshold under load (394 ms).** The rule was not
  crossed in either run, so the index is still not added. Adding it is the first lever if a quiet re-run crosses
  400 ms.

## Covering index: not added

- The design rule is to add `activities_user_created_cover_idx` only if `analytics_activity` or `analytics_call_times`
  takes more than 400 ms at 365 days.
- They measured 239.2 ms and 185.9 ms, so the index is not added.
- The plan, from the auto_explain pass in `perf_analytics.sql`:
  - The team branch reads `activities_user_created_idx` once per member of the organisation: a bitmap index scan,
    8 loops, about 16,000 rows each.
  - It reads the authorless entries through the new `activities_no_author_idx`: 1 loop, 0 rows.
  - There is no sequential scan of activities.

## One change made because of a measurement: `jit = off`

- **First run, with JIT on (the PostgreSQL default).** `analytics_sales` was over budget: 106 ms at 90 days (budget 80)
  and 202 ms at 365 days (budget 200).
- **Cause, from auto_explain.**
  - Row level security on `private.orders` and `private.order_lines` adds subplans. These raise the planner's cost
    estimate of the sale-lines read to about 142,000, which is past `jit_above_cost`.
  - JIT then took 58 ms (`Emission 48.9 ms`) for a read that itself took 28 ms.
- **Fix.** Every block function and source helper now runs with `set jit = off`. These reads aggregate at most about
  150,000 rows, so compiling never pays back.
- **Before and after, on the same database.**

  | Read | JIT on | JIT off |
  |---|---|---|
  | sales, 90 d | 115.9 ms | 51.3 ms |
  | sales, 365 d | 217.4 ms | 139.8 ms |
  | activity, 365 d | 242.7 ms | 248.0 ms |
  | pipeline, 365 d | 65.4 ms | 66.4 ms |

  Activity and pipeline did not change.
- `analytics_attack.sql` section 0 now checks `jit=off` together with `plan_cache_mode=force_custom_plan` on all
  eleven planned functions.

## Watch item

- `analytics_batches` for the team takes 335 ms locally: within its 400 ms budget, but about 1 s at ×3.
- It makes one index probe on activities and one on deals for each lead in the 20 batches (30,017 leads here, the full
  Release 1 size).
- It is a "Right now" block for admins only, and P3 renders it.
- If P3's page timing shows it as the slowest block, the cheap next step is a partial index on `companies
  (import_batch_id) include (owner_id)`, or caching the block for a few minutes. Neither is needed by the budgets in
  P1.
