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


## Quiet re-run (15 Oct 2026)

Why: the merge run above was compared on a different browser from the baseline and partly overlapped other jobs.
This re-run uses the baseline's own browser and command line on a quiet machine, with three runs on each head taken
in turn. Nothing was tuned and no app or test code was changed.

**Browser actually used by the baseline: Chromium 141.0.7390.37** (`PW_CHROMIUM_PATH=/opt/pw-browsers/chromium`, the
full Playwright build `chromium-1194` run headless). The text above says "Chromium 156", but the command that produced
the accepted figures (`e2e-perf4.log`, copied as `perf-browser-final.log`, 14 Oct 20:58 UTC) set
`PW_CHROMIUM_PATH=/opt/pw-browsers/chromium`. The merge run above used Chrome Headless Shell 156.0.8078.4, a different
browser. This re-run uses the baseline's browser.

**Method.** The command line was the baseline's: `set -a; . /tmp/topstock-auth/env; set +a;
PW_CHROMIUM_PATH=/opt/pw-browsers/chromium PERF=1 npx playwright test -c playwright.auth.config.ts --project=chromium
tests/auth/day5-perf.spec.ts`, run from the 6008f4b worktree, so both heads ran the same test code. Each head ran as a
production build (`next build`, then `next start -p 3100`) against the shared local stack (Postgres 54330, gateway
54321, merged-head schema):
- **A** = 6008f4b, built in place.
- **B** = pre-merge 931af08, built from a `git archive` copy. Its `node_modules` is a hard-linked copy, because Turbopack
  refuses a symlinked `node_modules`. `package-lock.json` is the same on both heads.

Every run had a fresh `next start`. The order was A, B, A, B, A, B, with each pipeline run followed by a Home run on
the same head (see `day5c/perf.md`). Before each run the script waited until no other Playwright, `next build`, db-test,
mutation, db-perf or extra Postgres job was running; none was found. The 4-vCPU VM ran only this script. The 1-minute load
before each run, below, includes the tail of the previous run (the browser and server of this script).

| Run | Head | `uptime` before (load 1 / 5 / 15 min) |
|---|---|---|
| 1 | A 6008f4b | 0.76 / 0.74 / 0.98 |
| 1 | B 931af08 | 1.58 / 1.27 / 1.14 |
| 2 | A | 1.00 / 1.45 / 1.30 |
| 2 | B | 0.95 / 1.36 / 1.30 |
| 3 | A | 0.55 / 1.02 / 1.18 |
| 3 | B | 1.61 / 1.44 / 1.31 |

Figures are min / median / max over the 9 samples per head (3 runs × 3 samples). For move p95 and extra JavaScript
there is one value per run, so 3 values. Baseline figures are min / median / max of its 3 samples.

| Measure | Accepted baseline (ee5312c) | A: 6008f4b (merged) | B: 931af08 (pre-merge) | Budget | Reading |
|---|---|---|---|---|---|
| Cold deep link `/pipeline`: LCP | 1,088 / 1,316 / 1,560 ms | 1,184 / 1,308 / 1,888 | 1,012 / 1,196 / 1,688 | ≤ 2,000 (met) | within baseline (same median; one slow first sample per run on both heads) |
| Cold deep link: CLS | 0 / 0 / 0 | 0 / 0.003 / 0.004 | 0 / 0.002 / 0.007 | ≤ 0.05 (met) | worse on both heads (not the merge) |
| Extra JavaScript for the pipeline | 53.6 KB | 56.3 / 56.3 / 56.3 | 56.3 / 56.3 / 56.3 | ≤ 60 (met) | worse on both heads: code that landed before 931af08, not the merge (byte count, the environment does not change it) |
| Press feedback | 24.2 / 36.4 / 42.8 ms | 31.6 / 40.4 / 57.2 | 31.7 / 38.2 / 55.7 | ≤ 100 (met) | slightly worse on both heads (not the merge) |
| Pipeline → Home after the dock hover | 17.8 / 25.3 / 39.7 ms | 18.4 / 25.0 / 36.0 | 16.4 / 21.2 / 37.3 | ≤ 200 (met) | within baseline |
| Move painted, p95 of 30 moves | 584.5 ms (one run) | 594.2 / 619.8 / 667.9 | 592.9 / 598.5 / 652.2 | ≤ 100 (missed, as accepted) | worse on both heads (+2 to 14 %, not the merge) |
| Move painted, median of 30 moves | ~410 ms | 412.5 / 444.6 / 446.5 | 431.8 / 434.2 / 456.8 | | worse on both heads (not the merge) |
| Drag frame time p95 | 22.7 / 23.2 / 23.5 ms | 23.7 / 24.1 / 25.9 | 23.1 / 24.1 / 26.0 | ≤ 16.7 (missed, as accepted) | worse on both heads (not the merge) |
| Drag: longest task | 68 / 74 / 96 ms | 107 / 128 / 168 | 97 / 124 / 195 | ≤ 50 (missed, as accepted) | worse on both heads (not the merge) |
| Settle after pointer up | 668.8 / 690.8 / 709.5 ms | 733.9 / 782.0 / 837.0 | 714.7 / 745.8 / 831.0 | ≤ 450 (missed, as accepted) | worse on both heads (not the merge; A's median is 36 ms above B's, but the two ranges overlap almost fully) |
| Home → Pipeline after the dock hover | 1,645 / 2,109 / 2,168 ms | 1,712 / 2,052 / 2,647 | 1,552 / 2,143 / 2,456 | ≤ 200 (missed, as accepted) | within baseline (same median; max higher on both heads) |
| Without a hover: time to the skeleton | 124.4 / 129.1 / 1,989.1 ms | 108.5 / 133.9 / 220.0 | 113.9 / 164.9 / 213.2 | ≤ 100 (missed, as accepted) | worse on both heads (not the merge; pre-merge median is the higher one) |

Per-run figures (run 1 / 2 / 3; drag, settle, press, routes and skeleton list their three samples per run):
- A: LCP 1,728·1,184·1,308 / 1,888·1,260·1,192 / 1,460·1,516·1,224. Move p95 594.2 / 667.9 / 619.8. Drag p95
  24.1·25.9·24.0 / 23.7·24.0·23.7 / 25.1·24.7·25.0. Longest task 141·134·111 / 168·127·107 / 128·117·133. Settle
  782.0·829.6·763.1 / 837.0·786.2·788.2 / 733.9·740.9·746.6. Home → Pipeline 2,052·1,754·1,712 / 2,079·2,127·2,186 /
  2,045·1,950·2,647. Skeleton 132.2·161.7·133.1 / 215.3·159.7·220.0 / 133.9·123.5·108.5.
- B: LCP 1,660·1,196·1,144 / 1,688·1,156·1,084 / 1,564·1,244·1,012. Move p95 598.5 / 592.9 / 652.2. Drag p95
  25.7·24.1·24.1 / 26.0·25.1·25.2 / 23.4·23.1·23.6. Longest task 195·128·97 / 124·135·113 / 98·155·116. Settle
  741.7·808.7·750.2 / 766.3·735.6·721.4 / 831.0·745.8·714.7. Home → Pipeline 2,217·2,223·2,132 / 1,972·1,552·2,346 /
  2,456·2,129·2,143. Skeleton 164.9·187.5·113.9 / 199.6·115.5·123.4 / 213.2·195.2·131.1.

Each run failed only on the budgets listed as missed above. No other error appeared. Logs are in the session scratchpad
(`quiet/day5-perf-{A,B}-{1,2,3}.log`, `quiet/summary.txt`).

**Plain reading.**
- **Worse only after the merge: none.** On every measure the merged head and the pre-merge head fall in the same range.
  The earlier "possibly from the merge" skeleton figure does not hold: on a quiet machine the pre-merge median is 165 ms
  and the merged median is 134 ms.
- **Within the baseline:** LCP, Pipeline → Home after the hover, and Home → Pipeline after the hover (same medians as
  the baseline). Every budget the baseline met is still met.
- **Worse than the baseline on both heads,** so the cause is the environment or code that landed before 931af08, not
  Day 4d:
  - drag frame p95: about +1 ms
  - longest drag task: about 125 against 74 ms median
  - settle: about 750 to 780 against 691 ms
  - move p95: 593 to 668 against 585 ms
  - skeleton: about 134 to 165 against 129 ms
  - press feedback: slightly higher, still under budget
  - a small CLS: up to 0.007, still under budget
  - extra JavaScript: 56.3 against 53.6 KB, still under budget
- The extra JavaScript is a byte count, so its rise is code, not the environment. For the timings, this run cannot tell
  environment drift from code between ee5312c and 931af08: that would need ee5312c built and run on the same machine,
  which was not done here. One sign that the machine behaves differently from the baseline's: each drag now records 317
  to 367 frames against 210 to 246 in the baseline, on both heads.
- The measures that are worse than the accepted figures go back to Haider. They are not caused by the merge.

### Second pass: the baseline commit on this machine (15 Oct 2026)

Why: to find out whether the "worse on both heads" rows above come from the machine or from code between the
baseline and 931af08. The baseline commit was built and measured on this machine today, in turn with 6008f4b
(C, A, C, A, C, A).

**Which commit.** The accepted pipeline figures came from **ee5312c** (log row "Day 5b checks (code ee5312c, tests
409403b)"; "Final run on ee5312c" above). The spec existed only in the working tree then and was committed with no app
change in 409403b. So C was built from **409403b**: the app code of ee5312c, plus that spec, byte-identical to today's.
ee5312c is on the line before the Day 4c rebase (the reflog shows "rebase (finish) onto 5f1a966" at 23:26 on 14 Oct),
so it is not an ancestor of 931af08. Its rebased copy is 3f3efd5. (Home's baseline came from e3baf1b; see
`day5c/perf.md`.)

**Database: the merged stack cannot run C fairly.** ee5312c predates Day 4c and 4d. The merged schema has 4c's queue
tables and the rebased `log_activity`, `get_lead` and `audit_row`, and today's test helpers clear `public.files`, which
the old schema does not have. So C ran on a throwaway stack built from **e3baf1b's migrations**: 409403b's own, plus
Day 5c's migration, which only adds functions and no table, index or policy.

To keep the comparison fair, **A was also run on a fresh throwaway stack**, built from 6008f4b's migrations. Both
stacks used:
- the shared stack's GoTrue build
- `scripts/local-auth`'s gateway, with only its GoTrue port made settable
- their own ports (54391/54381/9991 and 54392/54382/9992)

The shared stack was not touched. In a first attempt the copied gateways still forwarded auth calls to the shared
GoTrue on port 9999. That GoTrue refused them (bad_jwt) before anything was created, so nothing was written to the
shared stack. That attempt was thrown away, and its two failed runs are not counted.

**Builds and runs.** Each of C (409403b), C-Home (e3baf1b) and A (6008f4b) was built from a `git archive` copy with a
hard-linked `node_modules` (`package-lock.json` is the same on all three). Each build used its own stack's environment,
because `NEXT_PUBLIC_*` values are baked in at build time. Every run had a fresh `next start -p 3100`, with tests run
from that commit's own tree, as the baseline did. Browser and command were as in the first pass (Chromium 141,
`PW_CHROMIUM_PATH=/opt/pw-browsers/chromium PERF=1 npx playwright test -c playwright.auth.config.ts --project=chromium
tests/auth/day5-perf.spec.ts`). Before each run the script checked that no other heavy job or extra Postgres was
running; none was found. The gaps between runs were about 10 s, so the 1-minute load before a run carries more of this
script's previous run than in the first pass. C and A were affected alike.

| Run | Head | `uptime` before (1 / 5 / 15 min) |
|---|---|---|
| 1 | C 409403b (ee5312c) | 0.55 / 0.89 / 1.05 |
| 1 | A 6008f4b | 1.26 / 1.14 / 1.12 |
| 2 | C | 3.36 / 2.24 / 1.57 |
| 2 | A | 1.39 / 1.91 / 1.56 |
| 3 | C | 3.08 / 2.33 / 1.80 |
| 3 | A | 1.50 / 2.00 / 1.76 |

Figures are min / median / max over the 9 samples per head (3 values for move p95 and extra JS).

| Measure | Accepted baseline (ee5312c, 14 Oct) | **C: ee5312c today** | A: 6008f4b today (fresh stack) | Verdict |
|---|---|---|---|---|
| Cold deep link: LCP | 1,088 / 1,316 / 1,560 ms | 1,016 / 1,348 / 1,664 | 872 / 1,380 / 1,700 | within baseline |
| Cold deep link: CLS | 0 / 0 / 0 | 0 / 0.003 / 0.007 | 0 / 0.003 / 0.003 | **environment** (the baseline commit shows it too) |
| Extra JavaScript | 53.6 KB | **53.6** | 56.3 | **code** after ee5312c (see below) |
| Press feedback | 24.2 / 36.4 / 42.8 ms | 25.1 / 34.2 / 42.0 | 26.0 / 39.8 / 62.8 | unclear: C matches the baseline; A's median is about 5 ms higher with the ranges overlapping; under budget |
| Pipeline → Home after the hover | 17.8 / 25.3 / 39.7 ms | 15.8 / 26.6 / 33.5 | 21.5 / 25.5 / 38.5 | within baseline |
| Move painted p95 | 584.5 ms | 570.3 / 610.0 / 669.0 | 558.1 / 563.3 / 690.2 | **environment** |
| Move painted median | ~410 ms | 434.3 / 468.8 / 481.1 | 409.1 / 428.9 / 528.5 | **environment** |
| Drag frame p95 | 22.7 / 23.2 / 23.5 ms | 23.3 / 25.4 / 27.1 | 23.3 / 24.4 / 26.8 | **environment** |
| Drag: longest task | 68 / 74 / 96 ms | 114 / 136 / 216 | 122 / 141 / 194 | **environment** |
| Settle after pointer up | 668.8 / 690.8 / 709.5 ms | 718.7 / 775.8 / 870.1 | 625.9 / 767.1 / 842.2 | **environment** |
| Home → Pipeline after the hover | 1,645 / 2,109 / 2,168 ms | 1,893 / 2,215 / 2,941 | 1,897 / 2,190 / 2,651 | same on both heads (environment) |
| Skeleton without a hover | 124.4 / 129.1 / 1,989.1 ms | 111.6 / 169.2 / 1,974 | 75.0 / 120.6 / 196.4 | **environment** (C has two ~1.9 s outliers, as the baseline had one) |
| Frames recorded per drag | 210 / 232 / 246 | 316 / 338 / 369 | 327 / 345 / 409 | environment |

On its fresh stack, A falls within its own range from the first pass on every measure, so the stack type did not move
the pipeline figures.

**Plain reading.**
- **Every timing that was worse on both heads is the environment.** Today, on this machine, the commit Haider accepted
  is as slow as the later heads: move p95, drag frame p95, longest drag task, settle, the skeleton, and the small CLS.
  It reproduces the gaps between yesterday's figures and today's. The same holds for press feedback: C matches its
  baseline and A's small rise is within the spread.
- **The only code effect is the pipeline's extra JavaScript, +2.7 KB gzip** (53.6 to 56.3 KB, budget 60). A static
  comparison of the route-only client chunks gives about +2.2 KB. The new code is a focus-keeping hook (`focusin` /
  `focusout`) and `data-column-heading`. Most likely from (not tuned):
  - e4e1f50, verifier round 1, findings 2 to 4: `src/lib/use-keep-focus.ts`, `src/lib/focus-return.ts`,
    `src/components/pipeline/board.tsx`, `lose-dialog.tsx`, `deal-sheet.tsx`
  - e70d3ae and 916f610, finding 7: `src/lib/last-move.ts`, `src/lib/undo-pick.ts`,
    `src/components/pipeline/deal-flows.tsx`
  - 083a348 (the queue card's Open a deal), in `deal-flows.tsx` and `use-pipeline.ts`
- **Nothing here comes from the merge.**

Logs are in the session scratchpad: `quiet/summary2.txt`, `quiet/day5-perf-{C,Afresh}-{1,2,3}.log`, and the scripts
`quiet/run2.sh` and `quiet/stack.sh`. (The first pass's per-run A logs were overwritten by this pass's file names;
their results are kept in `quiet/summary.txt`.)
