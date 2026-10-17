# db-budgets: compact budget table, fail on a miss (17 Oct 2026)

The `db-budgets` workflow (manual start; re-times the database speed budgets on a GitHub runner) went green on run
38983135615 but could not fail when a timing missed its budget, and its summary was up to 400 grepped raw lines of a
~170,000-line log. Now:

- `scripts/db-budget-table.mjs` (Node, no dependency) reads the logs, prints one Markdown table per log
  (label | measured | budget | OK/MISS), lists every line that mentions a budget but could not be read (never dropped),
  counts the plan headers it skips, and exits 1 on a miss or an "OVER BUDGET" line, else 2 when the check is incomplete,
  else 0. Incomplete means: a log missing or unreadable; any one log with no budget row (an empty table never passes);
  a line that mentions a budget but could not be read; or a required budget ID with fewer rows than `REQUIRED` lists
  (P1 2, P2 6, P3 1, P4 5, P4b 2, P5 4 (the two "with a deal" lines, two values each), P6 2, P7 3, P8 2, P11 3, I1 11,
  I2 1, I3 1, I4 3, I5 6, I6 3, I7 2, I8 1, I9 3, I10 1, I11 1, I12 1, I13 2, I14 1, I16 2, I17 2: the counts of the
  full local run below, over both logs; a script that adds a case needs no change, one that drops or renames a case
  must update the list). The missing IDs are listed under the table.
- `.github/workflows/db-budgets.yml`: both measuring steps use `shell: bash` (bash `-eo pipefail`), so a crash in
  `db-perf.sh` or the import block fails its step despite `| tee`; the summary step (`if: always()`, never fails itself) writes the table to the run
  summary and the log artifact; the last step reruns the parser and fails the job on a miss. Action pins unchanged.
- `tests/unit/db-budget-table.spec.ts`: 26 tests with sample lines of every perf script's output format, plus the exit 2
  cases (one empty log, an unreadable line, a missing or short required ID, a header budget that must not leak).

## What is compared

| Output format (script) | Compared |
|---|---|
| `label : x ms (budget y ms) ...` (perf_day5) | the one value |
| `TIMING label : p95 x ms, avg y ms (budget z ms)` (perf_inventory); `TIMING label (budget z ms) : p95 x ms, avg y ms` (perf_sales, perf_share) | **p95** |
| `TIMING label (budget z ms) : avg x ms, max y ms` (perf_stock I5, I7, I17) | the **average** (the 6a budgets are on averages, `day6a/perf.md`) |
| `label : log_activity x ms, undo_activity y ms (budget 15 / 18 ms)` (perf_day5 P5) | in order: log_activity against 15, undo_activity against 18 (`day5/design.md` P5 "≤ 15 / ≤ 18 ms", `day5b/perf.md`) |
| `... (baseline)` | informational row, never a miss |
| `SIZE label : n bytes (budget 153,600)` (perf_share I10) | bytes (a budget with no unit takes the value's unit) |
| `=== ... (budget 10 ms each) ===` then `label : x ms` lines (perf_files P11) | the header budget, for each line after it; the first timing line must come within 3 lines of the header, else the header is listed as unreadable |
| `label: wall clock x ms (budget 3,000 ms)`; `...: wall clock x ms; p95 y ms (...) (budget 25 ms)` (stock_concurrency I16) | the wall clock; p95 when the line has one |
| `TIMING label (budget 1,500 ms each, 30 s in all):` then psql `Time:` lines (perf_stock_import I12 to I14) | slowest call against "each", the sum against "in all"; a `Time:` line right after another one is `\gexec`'s own query, left out |

Commas in numbers (`1,500`, `153,600`) are read as thousands. A line with a budget that matches none of these (two
values and neither is p95 or avg, a budget with no number, two budget clauses, units that differ) is listed as
unreadable with the reason.

**Not judged** (their output has no budget, so nothing to compare): perf_leads, perf_day4, perf_import, the P10 queue
(`perf_queue_concurrency.sh`; its budget "p95 claim ≤ 60 ms" is only in the script's comment), the deal_concurrency p95,
the perf_sales lines with no design budget, and `Today: list_tasks ... (4c P5: 15 ms)` in perf_day5 (the line names a
budget from Day 4c without the word "budget"). Making them judged means printing "(budget N ms)" in those scripts.

## Local end-to-end run

The two blocks exactly as the workflow runs them: `PGTZ=Europe/Paris sudo -E bash scripts/db-perf.sh` (full, 135 s),
then the workflow's stock import block (100 s), logs teed to the session scratch folder, then
`node scripts/db-budget-table.mjs db-perf.log stock-import-perf.log` (exit 1: 9 misses). Each block runs its own
throwaway PostgreSQL 16 cluster (`initdb` in a `mktemp` folder; ports 54327 and 54383 with `listen_addresses=` empty, so
only a Unix socket inside that folder: no clash possible); no other PostgreSQL was running. Both clusters stopped and their
folders deleted. Logs: 142,307 and 27,044 lines.

Machine: 4 cores (`nproc`), 16 GB; nothing else running. `uptime` load averages (1 / 5 / 15 min): before 0.41 / 0.70 / 1.06,
between the blocks 1.02 / 0.85 / 1.07, after 1.02 / 0.91 / 1.06. A first run a few minutes earlier overlapped `npm ci`
for 17 s and was discarded (db-perf.log only, 9 misses: P6 list_lead_deals and I6 1 / 10 lines missed there, I1 sort
available / updated did not).

The misses are the ones the day evidence already records on this kind of machine (`day5a/perf.md`: P1 mine and P4
move_deal missed; `day6a/perf.md`: I5 transfer; `day6b/perf.md`: I1 sort available / updated; `day6d/perf.md`: I6 20
lines). On a runner as slow as this VM the job now fails on them: that is the point of the change; whether those budgets
or the code change is a separate decision.

Parser output, unchanged:

**71 budgets checked: 62 OK, 9 missed** (4 informational).

Measured: p95 where a line gives p95 and avg; the average where it gives avg and max (I5, I7, I17); "budget a / b" pairs a and b with the two values in order (P5); I12 to I14: the slowest psql call against "each", the sum against "in all".

#### db-perf.log

| Label | Measured | Budget | Result |
|---|--:|--:|:-:|
| P1 pipeline_board team (admin, 50 a column) | 16.48 ms | 25 ms | OK |
| P1 pipeline_board mine (rep) | 20.6 ms | 15 ms | **MISS** |
| P2 list_stage_deals Lead at row 500 (team) | 3.31 ms | 5 ms | OK |
| P2 list_stage_deals Lead stalled only (team) | 3.57 ms | 5 ms | OK |
| P2 list_stage_deals Qualified, one owner | 3.44 ms | 5 ms | OK |
| P2 list_stage_deals Lead mine (rep) | 3.58 ms | 5 ms | OK |
| P2 list_stage_deals won (team) | 3.02 ms | 5 ms | OK |
| P2 list_stage_deals lost (team) | 3.3 ms | 5 ms | OK |
| P3 pipeline_summary team | 5.8 ms | 10 ms | OK |
| P6 get_deal (50 history rows) | 4.61 ms | 5 ms | OK |
| P6 list_lead_deals | 2.29 ms | 3 ms | OK |
| P4 move_deal (lead lock, coupling, record) | 12.58 ms | 10 ms | **MISS** |
| P4 move_deal win | 10.65 ms | 10 ms | **MISS** |
| P4 move_deal lose (other open deal check) | 10.81 ms | 10 ms | **MISS** |
| P4 move_deal undo by reverse move | 8.52 ms | 10 ms | OK |
| P4 open_deal | 8.92 ms | 10 ms | OK |
| P4b update_deal | 4.69 ms | 6 ms | OK |
| P4b delete_deal (admin, fresh code) | 3.52 ms | 10 ms | OK |
| The lead with 10,008 entries, no deal, log_activity | 7.3 ms | baseline | info |
| The lead with 10,008 entries, no deal, undo_activity | 5.1 ms | baseline | info |
| The lead with 10,008 entries, with a deal, log_activity | 9.46 ms | 15 ms | OK |
| The lead with 10,008 entries, with a deal, undo_activity | 6.55 ms | 18 ms | OK |
| A typical lead, no deal, log_activity | 6.94 ms | baseline | info |
| A typical lead, no deal, undo_activity | 4.91 ms | baseline | info |
| A typical lead, with a deal, log_activity | 13.17 ms | 15 ms | OK |
| A typical lead, with a deal, undo_activity | 8.95 ms | 18 ms | OK |
| P7 home_summary team (admin) | 12.82 ms | 30 ms | OK |
| P7 home_summary mine (rep) | 7.75 ms | 25 ms | OK |
| P8 home_attention team | 7.44 ms | 10 ms | OK |
| P8 home_recent_activity team | 4.19 ms | 5 ms | OK |
| P7 home_summary team, import week | 32.83 ms | 45 ms | OK |
| I5 adjust_out | avg 3.56 ms | 5 ms | OK |
| I5 reserve | avg 3.76 ms | 5 ms | OK |
| I5 transfer, Arrived 1 piece | avg 6.54 ms | 5 ms | **MISS** |
| I7 Arrived with 5 holds | avg 9.27 ms | 25 ms | OK |
| I17 check_stock_integrity | avg 154.7 ms | 1,500 ms | OK |
| I1 list_stock sort name | p95 3.53 ms | 20 ms | OK |
| I1 list_stock sort available | p95 22.68 ms | 20 ms | **MISS** |
| I1 list_stock sort updated | p95 23.23 ms | 20 ms | **MISS** |
| I1 list_stock filter in_warehouse | p95 2.43 ms | 20 ms | OK |
| I1 list_stock filter in_transit | p95 3.09 ms | 20 ms | OK |
| I1 list_stock filter low | p95 10.71 ms | 20 ms | OK |
| I1 list_stock filter sold_out | p95 16.59 ms | 20 ms | OK |
| I1 list_stock filter held | p95 6.82 ms | 20 ms | OK |
| I1 list_stock search "product 12" | p95 4.32 ms | 20 ms | OK |
| I1 list_stock category Bags | p95 3.15 ms | 20 ms | OK |
| I1 count_stock all | p95 1.37 ms | 20 ms | OK |
| I2 stock_summary | p95 9.77 ms | 15 ms | OK |
| I3 get_product | p95 2.26 ms | 8 ms | OK |
| I4 list_movements page 1 | p95 1.5 ms | 5 ms | OK |
| I4 list_movements before mid id | p95 1.72 ms | 8 ms | OK |
| I4 list_movements kind release | p95 2.68 ms | 30 ms | OK |
| I6 record_sale 1 line | p95 8.07 ms | 10 ms | OK |
| I6 record_sale 10 lines | p95 23.33 ms | 25 ms | OK |
| I6 record_sale 20 lines | p95 41.51 ms | 40 ms | **MISS** |
| I8 get_lead_stock | p95 8.64 ms | 15 ms | OK |
| I9 share_view valid, 2,000 items | p95 30.05 ms | 40 ms | OK |
| I9 share_view unknown token | p95 0.09 ms | 3 ms | OK |
| I9 share_view malformed token | p95 0.01 ms | 1 ms | OK |
| I11 share_request 5 lines + task | p95 9.52 ms | 20 ms | OK |
| I10 share_view raw | 125,333 bytes | 153,600 bytes | OK |
| P11 take_stale_uploads | 0.66 ms | 10 ms | OK |
| P11 begin_file_upload | 8.25 ms | 10 ms | OK |
| P11 finish_file_upload | 5 ms | 10 ms | OK |
| I16 twenty sessions holding the last pieces | wall clock 337 ms | 3,000 ms | OK |
| I16 3 sessions x 300 mixed operations on 20 hot products | p95 5.79 ms | 25 ms | OK |

#### stock-import-perf.log

| Label | Measured | Budget | Result |
|---|--:|--:|:-:|
| I5 adjust_out | avg 2.49 ms | 5 ms | OK |
| I5 reserve | avg 2.65 ms | 5 ms | OK |
| I5 transfer, Arrived 1 piece | avg 5.18 ms | 5 ms | **MISS** |
| I7 Arrived with 5 holds | avg 6.22 ms | 25 ms | OK |
| I17 check_stock_integrity | avg 171.8 ms | 1,500 ms | OK |
| I12 validate_stock_import 5,000 rows | 538.38 ms | 1,000 ms | OK |
| I13 commit_stock_import chunks of 125, slowest of 41 calls | 973.9 ms | 1,500 ms | OK |
| I13 commit_stock_import chunks of 125, all 41 calls | sum 22,988.72 ms | 30 s | OK |
| I14 rollback_stock_import chunks of 125, slowest of 41 calls | 618.67 ms | 1,500 ms | OK |

**Lines that mention a budget but could not be read (0):** none.

Not measurements, skipped: 40 PLAN header lines.

## Checks

| Check | Result |
|---|---|
| `npm run lint` | 0 errors (3 warnings, unchanged on main: `useVirtualizer` in check-step, stock-table, leads-table) |
| `npm run typecheck` | clean |
| Unit (`npm run test:unit`) | `db-budget-table.spec.ts` 26 passed; full suite 771 passed |
| Parser on the local logs above | 71 budgets, 62 OK, 9 missed, 0 unreadable, no required ID missing; exit 1 |
| Workflow steps simulated locally (`RUNNER_TEMP`, `GITHUB_STEP_SUMMARY` set) | summary step exit 0 with the table written; fail step exit 1; with the stock log removed the summary names it and the fail step still fails |
| Semgrep `p/github-actions` + `p/javascript` on the workflow and the script | no findings (run by the advisor; the registry is blocked by this session's proxy, so the builder could not rerun it) |
| gitleaks | not installed here; runs in CI |
| /security-review | see PR |
