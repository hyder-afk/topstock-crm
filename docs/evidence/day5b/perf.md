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

Day 4b's precedent: Haider accepted the lead page's 4x numbers as the baseline (log, 11 Oct). These misses are listed
for his decision in the README ("Open risks") rather than accepted here.
