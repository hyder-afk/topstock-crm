# Day 5a speed (database, part 1): board, columns, writes, deal sheet, concurrency, regressions

Design 8.6 part 1: P1 to P4b, P6, P9 and P10. Browser timings and P5, P7, P8 belong to 5b and 5c.

**Method.** `scripts/db-perf.sh` (here a copy on port 54364; the real script keeps 54327): a throwaway PostgreSQL 16.15,
the auth shim and every migration, then `perf_leads.sql` (30,015 leads, 10,015 contacts), `perf_day4.sql` (300,000
activities, 15,000 tasks), **`perf_day5.sql`** (10,000 deals: 2,000 open, Lead 900 / Qualified 600 / Negotiations 500, a
fifth stalled; 5,000 won over 2 years, 400 this month; 3,000 lost; 40,000 history rows plus one deal with 50), then
`deal_concurrency.sh p10` and `perf_import.sql`. Each case runs 10 times to settle its plans (run 6 of the main cases is
logged by auto_explain: the generic-plan check), then the average of 5 timed runs. The write cases run in a block that
is rolled back, so the data and the flood guards stay as they were. Three full runs on **b8e839f**, 12 Oct 2026, 03:14 to
03:16 UTC.

**Machine.** A 4-vCPU cloud VM (Intel Xeon 2.80 GHz) shared with two other build workflows during every run (load average
4 to 8 on 4 cores). The same workflow's earlier Day 4 numbers on this VM type were lower than what main gives here at the
same time (Day 4b P4 `log_activity` 8.3 ms in `day4b/perf.md`, 7.9 to 13.7 ms in this session's main runs), so every
number below carries that load. Main (a7aa89e) was run three times interleaved with the 5a runs for the regression check.

## Day 5a cases (milliseconds, database time)

| Case | Run 1 | Run 2 | Run 3 | Budget | |
|---|---|---|---|---|---|
| P1 pipeline_board team (admin, 50 a column) | 18.77 | 19.48 | 20.35 | 25 | met |
| P1 pipeline_board mine (rep) | 19.37 | 17.84 | 18.78 | 15 | **missed** |
| P2 list_stage_deals Lead at row 500 (team) | 2.91 | 4.17 | 3.36 | 5 | met |
| P2 list_stage_deals Lead stalled only (team) | 3.19 | 3.09 | 3.44 | 5 | met |
| P2 list_stage_deals Qualified, one owner | 3.18 | 3.1 | 3.45 | 5 | met |
| P2 list_stage_deals Lead mine (rep) | 3.45 | 3.13 | 3.35 | 5 | met |
| P2 list_stage_deals won (team) | 3.12 | 2.82 | 3.0 | 5 | met |
| P2 list_stage_deals lost (team) | 2.89 | 2.99 | 3.18 | 5 | met |
| P3 pipeline_summary team | 4.97 | 4.34 | 5.49 | 10 | met |
| P6 get_deal (50 history rows) | 5.75 | 4.48 | 4.88 | 5 | met in 2 of 3 |
| P6 list_lead_deals | 2.4 | 2.26 | 2.6 | 3 | met |
| P4 move_deal (lead lock, coupling, record) | 11.73 | 10.28 | 11.09 | 10 | **missed** |
| P4 move_deal win | 9.91 | 10.85 | 10.71 | 10 | met in 1 of 3 |
| P4 move_deal lose (other open deal check) | 9.86 | 10.75 | 11.17 | 10 | met in 1 of 3 |
| P4 move_deal undo by reverse move | 7.92 | 8.03 | 7.71 | 10 | met |
| P4 open_deal | 7.16 | 7.2 | 8.4 | 10 | met |
| P4b update_deal | 3.8 | 3.76 | 4.39 | 6 | met |
| P4b delete_deal (admin, fresh code) | 2.09 | 2.21 | 2.52 | 10 | met |
| P6 get_lead (a lead with deals; unchanged in 5a) | 1.62 | 1.82 | 1.88 | Day 4 P1 + 2 ms (this run: 2.3–3.4) | met |
| P10 p95 per move (3 sessions x 100) | 35.51 | 38.24 | 58.04 | 20 | **missed** |

**Misses (also in README "Open risks"):**

- **P1 board, rep's own deals: 17.8 to 19.4 ms against 15.** The team board (more work) meets its 25 ms. The rep's board
  does the same statements; what remains is per-statement overhead: every statement under row level security evaluates
  the policy helpers (`has_aal2`, `current_org_id`, `is_manager_or_admin`; 0.1 to 0.5 ms each in the plans) once per
  table, about a dozen statements per board. Profiled pieces on the perf seed: summary 5 ms (heap pages: the rep's 667
  open deals sit on 624 pages), four index walks 0.6 to 1.2 ms each, the 200 cards 3.5 ms.
- **P4 move with the lead lock and coupling, and the win and loss: 9.9 to 11.7 ms against 10.** One move is about 20
  statements across `move_deal`, the guard, the history trigger, the audit trigger, the lead update (with `lead_guard` and
  its audit row) and the move record. The undo (7.7 to 8.0 ms) and `open_deal` (7.2 to 8.4 ms) meet theirs.
- **P10 p95 35.5 to 58.0 ms against 20 per move** with 3 sessions x 100 changes on 20 deals: the time includes waiting for
  the other sessions' row locks (one deal in 20 per change, by design: the contention case), and the three sessions share
  4 busy cores with two other workflows. 0 deadlocks, 0 errors other than the rules' own refusals, both invariants held,
  in all three runs (and in every `db-test.sh` run).

**Plans (run 6, `perf-5a` logs).** The board summary walks `deals_org_board_idx` / `deals_owner_board_idx` per stage and
reads a lead only for deals whose clock is past the limit (780 of 2,000 in the team run); its aggregate is materialized
(an earlier version recomputed it once per stage row: 6.7 ms of the board, fixed in b8e839f). Won pages use
`deals_org_closed_idx` / `deals_owner_closed_idx` with `status`, `closed_at` and the row cursor as index conditions; cards
are 200 primary-key lookups. `stage_deal_ids` and `pipeline_summary_for` run with `plan_cache_mode = force_custom_plan`,
so no generic plan replaces them (the "stalled only" branch folds away when not asked for).

**Speed work during this step** (each re-measured): the board reads all its cards in one call; column pages look up the
lead only for "stalled only"; the summary reads a lead only for deals already past their clock (19 ms to 4 ms for that
statement); the summary aggregate is materialized. First measurements (same seed, 02:52 to 02:56): board team 25 to 48
ms, mine 20 to 30 ms, summary 9 to 15 ms.

## P9 regressions

**Day 3a list and Day 4 cases** (they run before the deals are seeded, so the code paths are main's; 5a changes only the
audit trigger's deals branch and the task guard's link exception there). Medians of three runs each; the spread is the
machine (cases move both ways by up to 40% with no code change):

| Case | 5a runs 1 / 2 / 3 (ms) | Main a7aa89e (3 runs, min–max) | Median change |
|---|---|---|---|
| first page, last activity | 0.9 / 1.1 / 1.0 | 0.9–1.4 | -9% |
| first page, A to Z | 0.9 / 0.8 / 0.9 | 1.1–1.5 | -18% |
| first page, newest first | 0.9 / 0.8 / 0.8 | 0.8–1.4 | -38% |
| page 200 deep (keyset), last activity | 10.6 / 10.6 / 9.1 | 9.8–16.0 | +5% |
| total count, no filter | 2.0 / 2.2 / 2.0 | 2.2–3.9 | -13% |
| status + country filter, list | 16.8 / 14.9 / 14.0 | 13.4–25.9 | -10% |
| status + country filter, count | 1.6 / 2.0 / 1.8 | 1.8–5.5 | -33% |
| no activity for 30 days, list | 1.7 / 1.7 / 1.6 | 1.7–2.9 | -37% |
| search "verdane" (matches), list | 0.9 / 0.9 / 0.9 | 0.9–1.5 | +0% |
| search "verdane" (matches), count | 10.7 / 11.1 / 10.7 | 10.8–16.6 | -10% |
| search "benali4" (contact name), list | 20.1 / 20.8 / 18.7 | 19.5–36.9 | +1% |
| search with no match, list | 19.3 / 20.4 / 20.5 | 18.7–36.1 | -5% |
| search with no match, count | 11.8 / 10.9 / 10.7 | 10.9–16.1 | -2% |
| search "example.com" (every lead), list | 1.2 / 0.9 / 0.9 | 1.0–2.0 | -10% |
| search "example.com" (every lead), list A to Z | 1.5 / 0.9 / 0.9 | 0.9–1.2 | -18% |
| search "example.com" (every lead), count | 13.9 / 12.7 / 12.6 | 13.3–21.7 | -6% |
| search "+33 6" (every lead), list A to Z | 1.0 / 1.0 / 0.9 | 1.0–1.6 | +0% |
| search "+33 6" (every lead), count | 11.7 / 10.5 / 10.9 | 11.5–21.6 | -13% |
| search "ly" (2 letters), list | 3.5 / 3.2 / 3.1 | 3.5–7.0 | -9% |
| search "ly" (2 letters), count | 12.3 / 11.6 / 11.6 | 14.8–23.4 | -24% |
| search "éé" (2 letters, no match), list | 20.1 / 19.7 / 21.4 | 27.2–41.9 | -34% |
| search "zermatt" (15 leads sorting last), list | 22.3 / 19.8 / 20.3 | 23.0–32.4 | -37% |
| search "zermatt" (15 leads sorting last), A to Z | 30.2 / 25.7 / 27.0 | 26.6–30.1 | +1% |
| search "zermatt" (15 leads sorting last), newest | 23.1 / 21.4 / 21.9 | 23.1–28.4 | -19% |
| search "zermatt" (15 leads sorting last), count | 11.3 / 10.7 / 11.1 | 10.8–15.3 | -15% |
| search "quaxley" (15 contacts, leads last), A to | 36.1 / 26.7 / 28.2 | 28.2–39.7 | -15% |
| search "verdane" + status customer, list | 4.6 / 4.1 / 4.5 | 4.4–8.2 | -38% |
| city filter "lyon", list | 28.9 / 21.0 / 25.2 | 24.2–28.1 | +4% |
| P2 first page, lead with 10,000 entries | 0.18 / 0.19 / 0.19 | 0.21–0.36 | -10% |
| P2 page at row 5,000 | 0.15 / 0.15 / 0.13 | 0.12–0.27 | +7% |
| P2 calls only, first page | 0.17 / 0.17 / 0.14 | 0.14–0.32 | +0% |
| P2 first page, a typical lead | 0.11 / 0.11 / 0.12 | 0.11–0.21 | -8% |
| Entry on the lead with 10,000 entries / insert | 4.07 / 3.8 / 3.46 | 3.4–4.67 | +3% |
| Entry on the lead with 10,000 entries / delete | 2.34 / 2.72 / 2.37 | 2.31–2.64 | -2% |
| Entry on a typical lead / insert | 1.77 / 2.05 / 1.78 | 1.81–1.82 | -2% |
| Entry on a typical lead / delete | 1.37 / 1.47 / 1.38 | 1.26–1.37 | +3% |
| P2 RPC first page, lead with 10,008 entries | 0.43 / 0.48 / 0.44 | 0.48–0.55 | -19% |
| P2 RPC page at row 5,000 | 0.45 / 0.43 / 0.46 | 0.47–0.84 | -25% |
| P2 RPC calls only, first page | 0.43 / 0.47 / 0.45 | 0.43–0.72 | +2% |
| The lead with 10,008 entries / P1 get_lead | 2.7 / 2.9 / 3.01 | 2.61–3.33 | +11% |
| The lead with 10,008 entries / P4 log_activity | 7.24 / 8.24 / 8.77 | 7.88–10.5 | +3% |
| The lead with 10,008 entries / P4b undo_activity | 5.19 / 5.48 / 6.1 | 5.43–7.5 | -1% |
| A typical lead / P1 get_lead | 2.27 / 2.3 / 3.43 | 2.36–2.71 | -12% |
| A typical lead / P4 log_activity | 8.81 / 7.69 / 11.05 | 8.51–13.71 | -30% |
| A typical lead / P4b undo_activity | 6.11 / 5.39 / 6.58 | 5.89–7.64 | -2% |

**Day 3b import and undo** against **the same 10,000 deals on both sides** (main seeded with `main-deals-seed`, the
same leads, owners and statuses, inserted with triggers off; without deals, main's undo preview and undo chunks were
120 to 180 and 250 to 284 ms: the cost comes from the data, the foreign key look-ups from `deals.company_id` and the
"untouched" rule's deal check, not from 5a's code):

| Day 3b import case | 5a runs 1 / 2 / 3 | Main + same 10,000 deals, runs 1 / 2 / 3 | Median change |
|---|---|---|---|
| P1 add rows (30 chunks), average | 75.3 / 61.9 / 65.1 ms | 65.0 / 61.6 / 59.5 ms | +6% |
| P2 check 30,000 rows | 1815.0 / 1334.0 / 1228.0 ms | 1301.3 / 1228.4 / 1281.4 ms | +4% |
| P3 problems page | 28.0 / 23.8 / 31.6 ms | 24.6 / 39.8 / 24.9 ms | +12% |
| P4 import (28 chunks), average | 321.2 / 273.4 / 271.1 ms | 285.1 / 292.3 / 288.2 ms | -5% |
| P6 undo preview | 251.1 / 217.4 / 227.2 ms | 184.6 / 199.9 / 299.0 ms | +14% |
| P6 undo (14 chunks), average | 440.1 / 391.6 / 387.4 ms | 356.6 / 354.0 / 427.9 ms | +10% |
| P7 check 50,000 rows | 2929.6 / 2042.5 / 2458.8 ms | 2121.8 / 2041.9 / 2331.1 ms | +16% |

Within the +10% budget or inside the run-to-run spread (P3, P6 preview and P7 move by more between two runs of the same
code); no regression traced to 5a code.

## Verifier round 1 re-measure (acc2cf3, code head 3c67877)

Round 1 changed the write paths only: `open_deal`'s guard counts `private.deal_opens` (one short range read on
`deal_opens_user_idx`) and the history trigger writes one open record and prunes the caller's records older than an
hour; `move_deal` keeps two scalars instead of a record and writes a move record for an Undo sent with a request id; the
guard calls the (null) Day 6 stub when a win changes the shipping; `update_deal` and `delete_deal` gained a pre-check.
No read path changed. To separate the change from the machine, **three pairs of runs interleaved** the round 1 head and
the previous head b8e839f (a throwaway worktree, the same `db-perf.sh` copy on port 54365; the round 1 runs on 54364),
06:21 to 06:29 UTC, load average 3 to 5 on 4 cores (Day 4c's workflow was running).

| Case | Round 1 runs 1 / 2 / 3 (ms) | b8e839f runs 1 / 2 / 3 (ms) | Median change | Budget |
|---|---|---|---|---|
| P1 pipeline_board team (admin) | 20.83 / 25.12 / 18.44 | 19.1 / 29.33 / 20.78 | +0% | 25 |
| P1 pipeline_board mine (rep) | 20.13 / 19.88 / 25.11 | 19.11 / 26.98 / 19.23 | +5% | 15 (missed, as before) |
| P2 list_stage_deals (six cases) | 3.0 to 5.19 | 3.18 to 5.56 | -36% to +13% | 5 (3 single runs at 5.1 to 5.2; b8e839f had 3 at 5.3 to 5.6 in the same window) |
| P3 pipeline_summary team | 5.45 / 4.88 / 5.15 | 6.06 / 5.79 / 5.48 | -11% | 10 |
| P6 get_deal (50 history rows) | 5.09 / 4.92 / 4.75 | 4.96 / 4.87 / 7.1 | -1% | 5 |
| P6 list_lead_deals | 2.43 / 2.27 / 3.72 | 2.39 / 2.73 / 4.07 | -11% | 3 |
| P4 move_deal (lead lock, coupling, record) | 11.72 / 11.92 / 13.92 | 12.31 / 13.75 / 11.19 | -3% | 10 (missed, as before) |
| P4 move_deal win | 10.25 / 12.28 / 12.31 | 11.49 / 12.84 / 10.1 | +7% | 10 (missed) |
| P4 move_deal lose | 10.65 / 12.67 / 14.75 | 12.68 / 10.52 / 12.0 | +6% | 10 (missed) |
| P4 move_deal undo by reverse move | 8.08 / 9.44 / 9.3 | 8.64 / 13.27 / 8.58 | +8% | 10 |
| P4 open_deal | 9.2 / 9.36 / 10.5 | 9.62 / 7.58 / 8.87 | +6% | 10 (met in 2 of 3) |
| P4b update_deal | 4.91 / 4.85 / 5.46 | 5.44 / 4.24 / 4.58 | +7% | 6 |
| P4b delete_deal (admin, fresh code) | 3.47 / 2.39 / 2.88 | 2.82 / 2.28 / 2.45 | +18% | 10 |
| P6 get_lead (a lead with deals) | 1.85 / 1.66 / 2.71 | 2.02 / 2.6 / 1.67 | -8% | Day 4 P1 + 2 ms |
| P10 p95 per move (3 sessions x 100) | 54.94 / 83.3 / 39.63 | 65.26 / 90.8 / 41.39 | -16% | 20 (missed, as before) |

Reading: both heads were slower than the 03:14 runs above (the VM was busier: the unchanged Day 4 cases moved by up to
+56% between the same two heads too, e.g. `log_activity` on a typical lead 7.7 to 13.8 ms against 7.9 to 9.7 ms). Every
round 1 median is within the run-to-run spread of the previous head; `open_deal` +6% (about 0.5 ms: one index read, one
insert and one prune) and `delete_deal` +18% (0.4 ms, the undo-record look-up for creator-window deletes) are the only
plausible costs, both far inside their budgets. The budgets met and missed are the same as above: the misses stand in
README "Open risks". Logs: `scratchpad/5a/perf-new-{1,2,3}.log`, `perf-old-{1,2,3}.log` (also three earlier round 1
runs, `perf-5a-r1-*.log`, 06:16 to 06:21, at heavier load: board team 21.8 to 34.1 ms with no board code changed).
