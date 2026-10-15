# Day 5b speed (design 8.6: P5 in the database, the browser table)

## Database: P5 (`supabase/tests/perf_day5.sql` part 2, 8d120e4)

Seed and method as Day 5a (`docs/evidence/day5a/perf.md`): 30,015 leads, 300,000 activities, 15,000 tasks, 10,000 deals
and 40,000 history rows on a throwaway PostgreSQL 16; each case 10 times to settle, then the average of 5 timed runs,
in milliseconds; every round rolled back (so the 30-an-hour open limit and the data stay as they were). P5 runs as the
admin on perf_day4's two probe leads: the lead with 10,008 entries and a typical one (8 entries). "With a deal" is
`log_activity` Interested with `p_open_deal` (the call, its follow-up task and a deal at Lead in one transaction) and
`undo_activity` taking back both (answer `deal: removed`); "no deal" is the same call without the deal, this run's
baseline. Three full runs on 8d120e4 (a copy of `scripts/db-perf.sh` on port 54362 without the import and P10 parts,
which Day 5b does not touch), 4-vCPU cloud VM shared with other sessions.

| Case | Run 1 | Run 2 | Run 3 | Budget |
|---|---|---|---|---|
| P5 `log_activity` + deal, lead with 10,008 entries | 8.75 | 7.15 | 8.24 | ≤ 15 |
| P5 `undo_activity` removing the deal, same lead | 5.19 | 4.50 | 5.07 | ≤ 18 |
| P5 `log_activity` + deal, typical lead | 9.43 | 8.76 | 6.74 | ≤ 15 |
| P5 `undo_activity` removing the deal, typical lead | 5.58 | 5.32 | 4.28 | ≤ 18 |
| baseline `log_activity` Interested, no deal, lead with 10,008 entries | 7.70 | 7.11 | 7.50 | |
| baseline `undo_activity`, same lead | 5.31 | 4.73 | 5.10 | |
| baseline `log_activity`, typical lead | 8.88 | 6.55 | 5.87 | |
| baseline `undo_activity`, typical lead | 5.83 | 4.30 | 4.27 | |

**All met.** Against Day 4b's P4/P4b (`docs/evidence/day4b/perf.md`: P4 8.26–8.41, P4b 5.74–5.84 ms) the deal adds
about 0.5–1.5 ms to the log and nothing measurable to the undo; the same run's Day 4 cases (perf_day4, same session
data) were P4 `log_activity` 5.75–10.19 and P4b 4.17–7.41 ms, so the "within +10% of Day 4b" check holds on the averages
of the three runs (P5 log 7.15–9.43 against this run's P4 5.75–10.19; the spread is the shared VM, see Day 5a's note).

**Plan check (run 6, `auto_explain` for statements over 1 ms):** the activity insert (1.77 ms, its policy's deal check an
index scan on `deals_company_idx`, never executed when no deal is linked), the lead update (1.35 ms, `companies_pkey`)
and the task insert (1.03 ms); no sequential scan and no sort over activities; the deal insert and the undo's delete
stay under 1 ms.

Day 5a's P1–P4b and P6 ran in the same three runs (unchanged code paths for the board): P1 team 15.5–16.3 ms (25), P1
mine (rep) 17.6–18.4 ms (15; Day 5a's open item, unchanged), P2 2.6–4.9 (5), P3 5.2 (10), P4 6.2–10.3 (10; one move run
at 10.34), P4b 1.7–3.6, P6 `get_deal` 3.7–5.1 (5), `list_lead_deals` 1.7–2.9 (3), `get_lead` with the deals brief
3.9–4.4 ms (Day 4 P1 4.4–6.1 in the same runs: within + 2 ms).

## Browser (`tests/auth/day5-perf.spec.ts`, `PERF=1`, Chromium 156, 4x CPU slow-down through CDP)

Method: a rep-sized board for one admin (161 deals in Lead, 160 each in Qualified, Negotiations and Won in the last 30
days, all theirs), Chromium 156 headless at 1440 × 900, CPU slowed 4x through CDP (`Emulation.setCPUThrottlingRate`),
`next start` on the local stack, the cloud VM shared with other sessions. Each input is timed inside the page:
`performance.now()` at the input (a listener armed before it), then a MutationObserver or a frame loop until the change
is on screen, then the next frame. Extra JavaScript: the gzip bytes of the scripts a cold `/pipeline` loads, minus a cold
`/inventory` (the same shell). Final run on ee5312c (log kept in the session scratchpad,
`perf-browser-final.log`).

| Measure | Result (each run of the measure) | Budget | |
|---|---|---|---|
| Cold deep link `/pipeline`: LCP | 1,560 / 1,316 / 1,088 ms | ≤ 2,000 ms | met |
| Cold deep link: CLS | 0 / 0 / 0 | ≤ 0.05 | met |
| Extra JavaScript for the pipeline (dnd-kit core, context menu, board) | 53.6 KB gzip | ≤ 60 KB | met |
| Press feedback (pointer down to the 0.97 scale painted) | 42.8 / 24.2 / 36.4 ms | ≤ 100 ms | met |
| Pipeline → Home after the dock hover | 39.7 / 17.8 / 25.3 ms | ≤ 200 ms | met |
| Move painted in its new column (Shift+→ / Shift+←, 30 moves) | p95 584.5 ms (median ~410) | ≤ 100 ms p95 | **missed** |
| Drag frame time, 4 columns × 150 loaded cards (virtualised) | p95 23.5 / 22.7 / 23.2 ms | ≤ 16.7 ms | **missed** |
| Drag: longest task | 96 / 74 / 68 ms | ≤ 50 ms | **missed** |
| Settle finished after pointer up (from the up event to two still frames) | 690.8 / 709.5 / 668.8 ms | ≤ 450 ms | **missed** |
| Home → Pipeline after the dock hover (to the first card painted) | 2,109 / 1,645 / 2,168 ms | ≤ 200 ms | **missed** |
| Without a hover: time to the skeleton | 124.4 / 1,989.1 / 129.1 ms | ≤ 100 ms | **missed** |

**What the speed spec found and what was fixed** (24a6201, ee5312c; each step measured on the same board):

| Run | Code | Move p95 | Drag frame p95 | Longest drag task | Settle |
|---|---|---|---|---|---|
| 2 | before (5707665 + audit fixes) | 1,315.6 ms | 21.8–27.1 ms | 134–138 ms | (hung: a listener race in the spec, fixed) |
| 3 | 24a6201: every card re-rendered on every board render (dnd-kit context rebuilt from new sensor option objects, a handlers context with a new identity, the board's "now" moving with each cache write); now constants, stable handlers, "now" per fetch, the optimistic write in the event, cached money formatters | 439.3 ms | 23.6–31.2 ms | 106–175 ms | 794–844 ms |
| 4 | ee5312c: card lists memoised per column, no neighbour layout animation while dragging in virtualised columns, a critically damped settle spring | 584.5 ms (noise on the shared VM; median ~410) | 22.7–23.5 ms | 68–96 ms | 669–710 ms |

Unthrottled, a keyboard move now paints in 70–110 ms (was 150–240 ms; profiling spec, not committed).

**Why the rest still misses, and what would fix it** (not done in this step):

- **Move and settle**: what remains is Motion's layout measurement of the two touched columns (about 50 cards each)
  and React rendering them, about 400 ms at 4x on this VM. Next steps: drop neighbour layout animation past ~20 cards
  per column (the S13 fallback), or virtualise from 20 loaded cards instead of 60.
- **Drag frames**: dnd-kit re-renders each droppable column on every pointer move (its public context carries the
  collision rects); the remaining fix is a column shell that does not re-render its list (the list is memoised now) and
  measuring droppables once per drag (`MeasuringStrategy.BeforeDragging`).
- **Home → Pipeline**: the route's server render (session, team, board promise) plus the first client render of 200
  cards at 4x. The dock hover warms the board data but not the route's RSC payload; next steps are `router.prefetch`
  of `/pipeline` on the dock hover and rendering columns' cards after the first paint.
- **Skeleton without a hover**: two of three runs took 124–129 ms (just over 100); one run waited ~2 s for the route
  (the shared VM; the skeleton is the route's `loading.tsx`, shown as soon as the router has the loading boundary).

Day 4b's precedent: Haider accepted the lead page's 4x numbers as the baseline (log, 11 Oct). These misses were listed
for his decision in the README ("Open risks"). **Decision A (Haider, 15 Oct 2026): "accept as baseline, polish in Day
7".** The numbers above are the Day 5b baseline; the next steps listed here are Day 7 polish.


## Verifier round 1 (15 Oct): one run after the rebase onto Day 4c

`db-perf.sh` copy on port 54481 (perf_leads, perf_day4, perf_day5; the import and queue concurrency parts left out),
code at 083a348, one run on a quiet machine. Every Day 5 database budget still met with Day 4c's `log_activity` and
`get_lead` bodies: P5 log_activity with a deal 8.37 / 8.96 ms (15), undo_activity 5.30 / 5.70 ms (18); P1 board team
19.96 ms (25), mine 14.84 ms (15); P2 2.3 to 3.9 ms (5); P3 4.93 ms (10); P4 6.1 to 8.7 ms (10); P4b 3.16 / 1.84 ms;
P6 get_deal 4.75 ms (5), list_lead_deals 2.04 ms (3); get_lead with deals 4.26 ms.
The browser numbers were not re-measured (verifier finding 5: accepted as the baseline by Haider on 15 Oct, decision A;
polish in Day 7).


## Merge of Day 4d (15 Oct): one browser run on the merged head (advisor condition, decision A)

`tests/auth/day5-perf.spec.ts`, `PERF=1`, code at d107fd2 (merge dd24bb6 of Day 4d's efbbbb4 plus the bidi-escape fix;
no app code changed after it), the same method as above: `next start` on the local stack restarted from this worktree,
Chrome Headless Shell 156.0.8078.4 (the build CI runs; the local default Chromium is 141), 4x CPU through CDP, 1440 ×
900, the VM otherwise quiet (no mutation or test run alongside; load 1 to 3). **The merged-head run is the record.**
Two more runs were taken only to read the spread and to see whether the merge itself moved anything: the merged head
again, and the pre-merge head 931af08 built from a scratch copy, both on the same browser minutes apart. Not tuned.

| Measure | Accepted baseline (ee5312c) | **Merged head, run 1** | Merged head, run 2 | Pre-merge 931af08 | Budget |
|---|---|---|---|---|---|
| Cold deep link `/pipeline`: LCP | 1,560 / 1,316 / 1,088 ms | **1,824 / 1,608 / 1,524** | 1,448 / 1,116 / 1,216 | 1,776 / 1,444 / 972 | ≤ 2,000 (met) |
| Cold deep link: CLS | 0 / 0 / 0 | **0.006 / 0.003 / 0.003** | 0 / 0.003 / 0.003 | 0.003 / 0 / 0.003 | ≤ 0.05 (met) |
| Extra JavaScript for the pipeline | 53.6 KB | **56.3 KB** | 56.3 KB | 56.3 KB | ≤ 60 (met) |
| Press feedback | 42.8 / 24.2 / 36.4 ms | **42.4 / 53.4 / 55.8** | 41.6 / 35.8 / 43.0 | 32.5 / 35.2 / 36.5 | ≤ 100 (met) |
| Pipeline → Home after the dock hover | 39.7 / 17.8 / 25.3 ms | **29.7 / 19.1 / 37.3** | 27.7 / 24.7 / 30.5 | 14.2 / 22.5 / 27.4 | ≤ 200 (met) |
| Move painted (30 moves): p95 (median) | 584.5 (~410) ms | **754.4 (432.5)** | 641.4 (398.3) | 713.0 (396.9) | ≤ 100 (missed, as accepted) |
| Drag frame time p95 | 23.5 / 22.7 / 23.2 ms | **26.6 / 25.3 / 28.5** | 25.3 / 25.0 / 25.4 | 23.6 / 25.0 / 24.4 | ≤ 16.7 (missed, as accepted) |
| Drag: longest task | 96 / 74 / 68 ms | **162 / 157 / 147** | 118 / 78 / 86 | 122 / 109 / 87 | ≤ 50 (missed, as accepted) |
| Settle after pointer up | 690.8 / 709.5 / 668.8 ms | **764.2 / 785.7 / 721.4** | 781.9 / 726.9 / 778.4 | 750.2 / 727.1 / 777.3 | ≤ 450 (missed, as accepted) |
| Home → Pipeline after the dock hover | 2,109 / 1,645 / 2,168 ms | **2,247 / 2,164 / 1,915** | 1,827 / 1,716 / 2,243 | 1,867 / 1,690 / 1,980 | ≤ 200 (missed, as accepted) |
| Without a hover: time to the skeleton | 124.4 / 1,989.1 / 129.1 ms | **177.5 / 138.0 / 189.6** | 117.8 / 144.9 / 171.6 | 93.1 / 110.6 / 101.0 | ≤ 100 (missed, as accepted) |

**Reading** (for Haider; nothing tuned):
- Every budget the baseline met is still met (LCP, CLS, extra JavaScript, press, Pipeline → Home); every accepted miss
  is still a miss of the same size class.
- Worse than the accepted baseline beyond its recorded spread, **and the same on the pre-merge build** (so not from
  Day 4d; they moved between ee5312c and 931af08, or with the browser and VM of this run): drag frame p95 (25 to 28.5
  against 22.7 to 23.5 ms), settle (721 to 786 against 669 to 710 ms), the pipeline's extra JavaScript (56.3 against
  53.6 KB, identical before and after the merge, still under 60) and a small non-zero CLS (0.003 to 0.006, under 0.05).
- The longest drag task of run 1 (147 to 162 ms against 68 to 96) did not repeat: 78 to 118 ms in run 2 and 87 to 122 ms
  before the merge, so it is read as run-to-run noise.
- **Possibly from the merge, not proven:** the skeleton without a hover was 118 to 190 ms in both merged runs against 93
  to 111 ms in the one pre-merge run (the baseline had 124 and 129 ms with one 1,989 ms outlier). The difference is about
  the size of this measure's run-to-run spread; flagged to Haider rather than investigated (decision A: Day 7 polish).
