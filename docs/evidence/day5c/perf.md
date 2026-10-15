# Day 5c speed (design 8.6 P7, P8 and the Home browser rows)

## Database (P7, P8)

`scripts/db-perf.sh` copy without the import and P10 parts (port 54361), three full runs on the final migration (commit
4dda93b onwards): 30,015 leads, 300,000 entries, 15,000 tasks (10,552 open), 10,000 deals (2,000 open), 40,000 history
rows, plus 450 calls spread over the last 150 minutes for the three perf people. Each case 10 times to settle its plans,
then the average of 5 timed runs, in milliseconds. 4-vCPU VM shared with other sessions; run 3 overlapped a local
Playwright run.

| Case | Budget | Run 1 | Run 2 | Run 3 |
|---|---|---|---|---|
| P7 `home_summary` Team (admin) | 30 | 8.78 | 8.61 | 12.30 |
| P7 `home_summary` Mine (rep) | 25 | 5.78 | 6.22 | 7.54 |
| P7 `home_summary` Team, import week (30,015 leads made in the last 7 days; rolled back) | 45 | 15.58 | 16.85 | 20.69 |
| P8 `home_attention` Team | 10 | 9.14 | 6.13 | 7.08 |
| P8 `home_recent_activity` Team | 5 | 4.14 | 3.78 | **5.49** |
| `home_recent_activity` Mine | (none) | 4.03 | 3.71 | 5.56 |
| `home_today_tasks` (rep; 4c stand-in) | 4c P5 15 | 5.16 | 5.08 | 6.21 |
| `home_low_stock` stub (since decision B the `stock_alerts()` stub; `perf_day5.sql` calls it) | (none) | 0.00 | 0.00 | 0.00 |

Every budget met in runs 1 and 2; P8 recent activity missed by 0.5 ms in run 3 (the run that shared the CPU with
Playwright). The runs happened just after midnight in Paris, so "calls today" held about 130 of the 450 seeded calls;
the per-person index ranges are the same shape whatever the count.

**Plans (run 6, `auto_explain` with nested statements: these are the K-part timings).** `home_summary` Team: the
open-deal scan (`private.home_open_deals`, `deals_org_board_idx`, the lead read only for deals whose stage clock alone is
past the limit) is the largest part; K2/K3/Lost use `deals_org_closed_idx`; K4 is one `activities_user_created_idx`
range per person in the org (no Sort over activities); K5/K6 use `tasks_assignee_idx`; K7 `companies_created_keyset_idx`.
`home_recent_activity` Team: per person a `Limit` over `activities_user_created_idx` (a top-N sort of at most 8 rows per
person, never of the table), merged with `deal_stage_history_org_idx` read newest first. About 2 ms of its time is the
Day 5a history select policy (`exists (select 1 from deals ...)`, planned as a hashed subplan over the deals the caller
sees); that policy is Day 5a's and is not changed here.

**Fixed during the step.** The first version of the open-deal scan joined the lead for every open deal: P8 attention was
9.67 ms of 10 in the first run. It now reads the lead lazily, like `pipeline_summary` (4dda93b); the same three runs
give 6.1 to 9.1 ms.

**Generic-plan check.** The functions are plpgsql with Mine and Team as separate static statements; partial-index
predicates are written literally (`status = 'open'`, `status <> 'open'`), so a generic plan keeps the index. Run 6 plans
show the board, closed and per-person indexes after five warm runs.

## Browser (`tests/auth/home-perf.spec.ts`, PERF=1, Chromium, 4x CPU through CDP)

Local `next start` build, shared VM, one run of the spec (three samples per measure).

| Measure | Budget | Samples | |
|---|---|---|---|
| Cold deep link `/`: LCP | 2,000 ms | 1,732 / 1,664 / 1,532 | met |
| Cold deep link `/`: CLS | 0.02 | 0 / 0 / 0 | met |
| Layout-shift entries during the count-up | 0 | 0 / 0 / 0 | met |
| Longest frame in the first 1.2 s after the numbers exist (4x, divided by 4) | 8 ms | 26.2 / 25.9 / 18.7 | **missed** (see below) |
| Pipeline → Home after the dock hover | 200 ms | 432 / 432 / 441 | **missed** |
| Leads → Home without a hover: skeleton or content | 100 ms | 118 / 174 / 84 | **missed** (2 of 3) |
| Home's extra JavaScript (gzip, against the Inventory placeholder) | 20 KB | 9.1 KB | met |

**What the misses are.**

- *Longest frame.* The window starts when the KPI numbers are in the page, which is the server HTML, so it includes
  React's hydration of the whole page (the long frames). At 4x the hydration lands after 800 ms, so the count-up itself
  does not run in these samples (D29: it plays only when hydration is early); its frames write one text node per figure
  and cause no layout shift (0 entries). A measure that isolates the count-up needs a hook into the component; noted as
  a next step.
- *Pipeline → Home after the hover (about 430 ms).* The dock hover fills `['home', scope]` in the query cache, and Home
  renders from it at once, but Next 16.4 prefetches a dynamic route only up to its `loading.tsx` (design 2.1), so the
  click still waits for the page's server render (session check, profile, the figures' promise started again). This is
  the same limit the Day 5b report found for Home → Pipeline (about 2 s there, with a heavier board). Options for
  Haider: accept as the baseline (as for Day 4b), or a speed step that renders Home's shell from the client cache before
  the server answers (a client-side route shell; about half a day, touches the shared layout).
- *Skeleton without a hover (84 to 174 ms).* The skeleton is `loading.tsx`, prefetched with the link; the time is the
  router's work at 4x. Close to the budget; same cause as Day 5b's 124 to 129 ms.

**Decision A (Haider, 15 Oct 2026): "accept as baseline, polish in Day 7".** The three browser misses above and the
near-budget items (P8 recent activity 3.8 to 5.5 ms of 5, the skeleton) are the Day 5c baseline; the client-side route
shell and a count-up frame measure are Day 7 polish.


## Verifier round 1 (15 Oct): one run after the rebase onto Day 4c

`db-perf.sh` copy on port 54481, code at 083a348 (K5 from `count_tasks`, Today from `list_tasks`), one run: P7
home_summary Team 11.88 ms (30), Mine 6.57 ms (25), Team in the import week 23.96 ms (45); P8 home_attention 6.80 ms (10),
home_recent_activity Team 4.05 ms (5), Mine 3.80 ms; Today (list_tasks overdue + today, rep) 3.60 ms (4c's P5: 15 ms).
Every budget met. Browser numbers not re-measured (accepted as the baseline by Haider on 15 Oct, decision A; polish in
Day 7).


## Merge of Day 4d (15 Oct): one browser run on the merged head (advisor condition, decision A)

`tests/auth/home-perf.spec.ts`, `PERF=1`, code at d107fd2 (merge dd24bb6 of Day 4d's efbbbb4; no app code changed
after it); same method, local stack restarted from this worktree, Chrome Headless Shell 156.0.8078.4, 4x CPU through
CDP, the VM otherwise quiet. **The merged-head run is the record**; a second merged run and the pre-merge head 931af08
(scratch-copy build, same browser, minutes apart) were taken only to read the spread. Not tuned.

| Measure | Accepted baseline | **Merged head, run 1** | Merged head, run 2 | Pre-merge 931af08 | Budget |
|---|---|---|---|---|---|
| Cold deep link `/`: LCP | 1,732 / 1,664 / 1,532 ms | **1,008 / 932 / 1,116** | 1,108 / 992 / 984 | 1,032 / 1,016 / 1,060 | 2,000 (met) |
| Cold deep link `/`: CLS | 0 / 0 / 0 | **0 / 0 / 0** | 0 / 0 / 0 | 0 / 0 / 0 | 0.02 (met) |
| Layout-shift entries during the count-up | 0 / 0 / 0 | **0 / 0 / 0** | 0 / 0 / 0 | 0 / 0 / 0 | 0 (met) |
| Longest frame in the first 1.2 s (÷ 4) | 26.2 / 25.9 / 18.7 ms | **45.8 / 38.9 / 33.3** | 62.6 / 31.2 / 29.9 | 31.1 / 30.4 / 32.1 | 8 (missed, as accepted) |
| Pipeline → Home after the dock hover | 432 / 432 / 441 ms | **665.4 / 685.6 / 466.4** | 525.1 / 660.9 / 546.1 | 550.8 / 490.9 / 542.3 | 200 (missed, as accepted) |
| Leads → Home without a hover: skeleton or content | 118 / 174 / 84 ms | **149.7 / 345.8 / 175.8** | 249.6 / 154.9 / 226.2 | 179.4 / 150.5 / 115.4 | 100 (missed, as accepted) |
| Home's extra JavaScript (gzip) | 9.1 KB | **10.3 KB** | 10.3 KB | 10.3 KB | 20 (met) |

**Reading** (for Haider; nothing tuned):
- The met budgets stay met (LCP is faster than the baseline in all three runs, before and after the merge alike).
- Worse than the accepted baseline beyond its recorded spread, **and already so on the pre-merge build** (not from
  Day 4d): the longest frame in the first 1.2 s (30 to 63 against 19 to 26 ms), Pipeline → Home after the hover (466 to
  686 against 432 to 441 ms; pre-merge 491 to 551) and Home's extra JavaScript (10.3 against 9.1 KB, identical before
  and after the merge, under 20).
- **Possibly from the merge, not proven:** the skeleton without a hover was 150 to 346 ms in the two merged runs against
  115 to 179 ms in the one pre-merge run (baseline 84 to 174); the same pattern as the pipeline's skeleton (Day 5b
  `perf.md`). Within this measure's spread on a shared VM; flagged to Haider (decision A: Day 7 polish).
- Seen once with the local Chromium 141 (not the record): one layout-shift entry during the count-up in 1 of 9 samples
  (CLS 0.004, under 0.02; the entry budget is 0); 0 in the other 8 samples on 141 and 0 in all 6 on Headless Shell 156.
  Not reproduced; listed for Day 7 with the count-up frame measure.


## Quiet re-run (15 Oct 2026)

The same quiet re-run as in `day5b/perf.md` ("Quiet re-run"); method, builds and browser are written there. In short:
- Browser: Chromium 141.0.7390.37 (`PW_CHROMIUM_PATH=/opt/pw-browsers/chromium`). This is what the baseline really used:
  the command that wrote `5c/home-perf1.log` on 14 Oct at 22:58 UTC set that path. The merge run above used Headless
  Shell 156.
- Command: `PERF=1 npx playwright test -c playwright.auth.config.ts --project=chromium tests/auth/home-perf.spec.ts`,
  with the stack env sourced, run from the 6008f4b worktree.
- Builds: a production build per head, a fresh `next start -p 3100` per run, the shared local stack.
- Order: A (6008f4b, merged) and B (931af08, pre-merge, `git archive` build) in turn, A, B, A, B, A, B. Each Home run
  directly followed that head's pipeline run.
- Machine: no other heavy job running. Nothing was tuned.

| Run | Head | `uptime` before (load 1 / 5 / 15 min) |
|---|---|---|
| 1 | A 6008f4b | 1.45 / 1.55 / 1.28 |
| 1 | B 931af08 | 1.41 / 1.59 / 1.32 |
| 2 | A | 0.79 / 1.23 / 1.26 |
| 2 | B | 1.01 / 1.22 / 1.26 |
| 3 | A | 1.10 / 1.41 / 1.33 |
| 3 | B | 1.28 / 1.45 / 1.35 |

Figures are min / median / max over the 9 samples per head (3 runs × 3 samples). Extra JavaScript has one value per run.

| Measure | Accepted baseline | A: 6008f4b (merged) | B: 931af08 (pre-merge) | Budget | Reading |
|---|---|---|---|---|---|
| Cold deep link `/`: LCP | 1,532 / 1,664 / 1,732 ms | 508 / 900 / 1,444 | 460 / 960 / 2,288 | 2,000 | within baseline (faster on both heads); one pre-merge sample over budget (2,288, run 1) |
| Cold deep link `/`: CLS | 0 / 0 / 0 | 0 / 0 / 0 | 0 / 0 / 0.004 | 0.02 (met) | within baseline on the merged head; one pre-merge sample 0.004 |
| Layout-shift entries during the count-up | 0 / 0 / 0 | 0 / 0 / 0 | 0 / 0 / 1 | 0 | within baseline on the merged head; one entry in 1 of 9 pre-merge samples (the one seen before on Chromium 141) |
| Longest frame in the first 1.2 s (÷ 4) | 18.7 / 25.9 / 26.2 ms | 26.0 / 34.1 / 49.3 | 26.0 / 32.7 / 68.3 | 8 (missed, as accepted) | worse on both heads (not the merge) |
| Pipeline → Home after the dock hover | 431.7 / 432.3 / 441.0 ms | 448.5 / 592.1 / 627.3 | 454.1 / 555.1 / 725.6 | 200 (missed, as accepted) | worse on both heads (not the merge) |
| Leads → Home without a hover: skeleton or content | 83.9 / 118.0 / 174.2 ms | 113.8 / 260.1 / 398.4 | 128.5 / 255.1 / 346.2 | 100 (missed, as accepted) | worse on both heads (not the merge; same median) |
| Home's extra JavaScript (gzip) | 9.1 KB | 10.3 / 10.3 / 10.3 | 10.3 / 10.3 / 10.3 | 20 (met) | worse on both heads: code that landed before 931af08, not the merge (byte count) |

Per-run samples (run 1 / 2 / 3):
- A:
  - LCP 1,444·516·548 / 952·508·900 / 1,224·972·508
  - longest frame 34.1·29.8·35.8 / 49.3·30.5·26.0 / 27.6·34.3·39.0
  - Pipeline → Home 583.6·592.1·627.3 / 597.7·595.3·603.7 / 572.8·562.0·448.5
  - skeleton 270.3·340.0·302.9 / 260.1·113.8·398.4 / 243.0·179.1·157.8
- B:
  - LCP 996·460·2,288 / 1,260·548·568 / 460·960·1,412
  - CLS 0.004·0·0 / 0·0·0 / 0·0·0
  - count-up shifts 1·0·0 / 0·0·0 / 0·0·0
  - longest frame 35.7·27.9·68.3 / 26.0·30.0·33.9 / 41.6·28.0·32.7
  - Pipeline → Home 725.6·555.1·531.7 / 508.8·683.2·644.6 / 454.1·500.2·606.1
  - skeleton 192.2·270.6·128.6 / 296.5·255.1·346.2 / 289.5·128.5·166.9

Only budget assertions failed. Logs are `quiet/home-perf-{A,B}-{1,2,3}.log` in the session scratchpad.

**Plain reading.**
- **Worse only after the merge: none.** The merged head matches or beats the pre-merge head on every Home measure. The
  three samples outside a budget the baseline met were all on the pre-merge head: LCP 2,288 ms, CLS 0.004 and one
  count-up shift.
- The earlier "possibly from the merge" skeleton figure does not hold: on a quiet machine both heads have the same
  median, 260 against 255 ms.
- **Within the baseline:** LCP (faster than the baseline on both heads), CLS and count-up shifts on the merged head.
- **Worse than the baseline on both heads,** so the cause is the environment or code that landed before 931af08, not
  Day 4d:
  - the early longest frame: about 33 to 34 against 26 ms median
  - Pipeline → Home after the hover: about 555 to 592 against 432 ms
  - the skeleton without a hover: about 255 to 260 against 118 ms
  - Home's extra JavaScript: 10.3 against 9.1 KB, code, still under budget
- These go back to Haider as worse than the accepted figures. They are not caused by the merge.
