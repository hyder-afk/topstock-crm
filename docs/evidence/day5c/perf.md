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
| `home_low_stock` stub | (none) | 0.00 | 0.00 | 0.00 |

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


## Verifier round 1 (15 Oct): one run after the rebase onto Day 4c

`db-perf.sh` copy on port 54481, code at 083a348 (K5 from `count_tasks`, Today from `list_tasks`), one run: P7
home_summary Team 11.88 ms (30), Mine 6.57 ms (25), Team in the import week 23.96 ms (45); P8 home_attention 6.80 ms (10),
home_recent_activity Team 4.05 ms (5), Mine 3.80 ms; Today (list_tasks overdue + today, rep) 3.60 ms (4c's P5: 15 ms).
Every budget met. Browser numbers not re-measured (Haider's decision, Day 5b README "For Haider").
