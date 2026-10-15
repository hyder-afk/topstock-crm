# Day 5b: the pipeline and deals on the lead page, 12 to 14 Oct 2026

Design: `docs/evidence/day5/design.md` (sections 2.4 spikes S10–S13, 3.2, 4.2, 4.4, 4.5, 5, 6, 7, 8, 9, 11 "5b" items 1
to 7; Haider's answers of 11 Oct in `docs/log.md`). Local branch `day5a-local` (the finished Day 5a deals database,
verifier READY) from b49fd9e. **15 Oct: rebased onto `origin/main` 5f1a966 (Day 4c merged)** and verifier round 1 fixed
(section "Verifier round 1"); Day 4d is not merged yet (see "Rebase points"). No push, no PR, no remote database; fake
data only.

## What changed

**Database: `supabase/migrations/20261015120000_deal_links.sql`** (design 3.2, 4.2, 5.1, 5.3; renamed at merge if
main moved, D35):

- entries name a deal again: `deal_id` back in the activities insert grant, behind a policy that allows only a deal
  the caller sees on the same lead;
- `log_activity` gains `p_deal`, `p_open_deal`, `p_deal_title`, `p_deal_value`: Interested and Book meeting open a deal
  at Lead in the same transaction, for people who may change the lead; a Do not contact lead or a caller over the
  30-an-hour open limit skips the deal and keeps the call (answer `deal: {opened: false, reason}`);
- `undo_activity` removes the deal the call opened while nobody touched it (`version = 0`), after the lead lock (order
  contact, lead, deal); answer `deal: removed | kept`;
- `get_lead` adds `deals {open_count, latest_open}` and `can_open_deal`.

Tests: `supabase/tests/deal_links_attack.sql`; `deal_concurrency.sh` part 2 (cases 11 to 14: a move vs a call naming
the deal, an Undo of the call that opened a deal vs a call, an admin's delete vs a call, an Undo vs a colleague's move
on the same lead; no deadlock, the right answer); Day 4 attack files re-run unchanged
(two fixture notes in `activity_attack.sql` and `rls_attack.sql`); wired into `scripts/db-test.sh` and `db.yml`.
Mutations: `mutations.md` (17 of 17 caught; Day 4a and 4b rows re-run against the Day 5b copies, all caught). P5 in
`supabase/tests/perf_day5.sql`.

**Libraries**: `src/lib/deals.ts` (types, Zod `strictObject` inputs, stage keys, the stall rule, `elapsedDays`),
`money.ts` (decimal strings, `parseMoney` EN/FR, cached `Intl` formatters), `pipeline-cache.ts` (optimistic board
moves, replace, restore), `deals-server.ts` (reads), `prefetch.ts` (board, deal, lead deals), `db-errors.ts` (Day 5
hints). Unit specs: `deals`, `days-in-stage`, `pipeline-cache`, `day5-parity`, `board-keys`, `coordinate-getter`,
`announcements`.

**Actions and routes** (design 4.4, 4.5): `src/app/(app)/pipeline/actions.ts` (open, move, win, lose, reopen, undo,
update, delete; each Zod first, then a two-factor session, then one RPC with named arguments); `logActivity` takes a
deal or opens one; GET `/api/pipeline/{board,stage,summary}`, `/api/deals/[id]`, `/api/leads/[id]/deals` (codes only,
`no-store`).

**UI** (design 7):

- `src/components/ui/context-menu.tsx` (Radix 2.3.7 on the menu tokens) and dropdown submenus;
- `src/components/pipeline/*`: board, column (virtualised past 60 loaded cards), deal card, the dragged copy, keyboard
  coordinate getter (column jumps), Lost band, toolbar (totals, Stalled only, sort), Win / Lose / Reopen / Delete
  dialogs (reopening a won deal and deleting ask for a fresh code), deal sheet (stepper, fields, path, history, linked
  entries), New deal, closed lists, settle, announcements (EN/FR), `use-pipeline` (one TanStack scope per deal,
  optimistic moves with Undo and conflicts), `use-board-keys` (Space/arrows drag, Shift+arrows, digits by key
  position, Enter opens, E, L, U, Delete);
- `pipeline/page.tsx` and `loading.tsx` replace the Day 2 placeholder (the board streams as a promise under a skeleton
  that matches it at every width);
- dock prefetch of the board (`onPointerEnter`/`onFocus`), `useShell().isChordPending`;
- lead page: Deals tab, Summary deal card, header deal chip, the deal sheet over the page (`?deal=`), New deal, the
  composer's "About: the deal" chip, the call panel's "Open a deal" switch (`D`) for Interested and Book meeting with an
  optional title and value, deal toasts and one Undo for both;
- Cmd+K "New deal" and "Show stalled deals"; the shortcuts list's Pipeline section;
- messages EN and FR (French typography checked; `messages.spec.ts` parity).

**E2E** (`tests/auth`): `pipeline.spec.ts` (11 tests), `lead-deals.spec.ts` (6), `pipeline-multi.spec.ts` (1),
`day5-security.spec.ts` (6), `day5-perf.spec.ts` (`PERF=1`), `day5-screens.spec.ts`; WebKit's `testMatch` gains
`pipeline` and `lead-deals`; `seedLeads` clears deals first (a deal keeps its lead).

## Spikes (design 2.4; throwaway `/spike` page, never committed; re-run 14 Oct on this worktree for the log)

| # | Question | Result | Decision |
|---|---|---|---|
| S10 | dnd-kit 6.3.1 under React 19.3 StrictMode and Next 16.4: SSR ids, overlay, CSP, live region; a drag from a virtualised column whose source card scrolls away | `DndContext id="pipeline-board"`: `aria-describedby` points at the hidden instructions (1 element); one live region; the card at row 150 picked up, its column scrolled to the top mid-drag, the source **stayed mounted** (rangeExtractor keeps the active index), dropped on column b ("Moved a150 to b."); keyboard pick-up shows the overlay; **0 console errors, 0 CSP violations** | Columns virtualised past 60 loaded cards with the active index always drawn (`column.tsx`) |
| S11 | `TouchSensor` (250 ms, tolerance 8) against `scroll-snap-type: x mandatory` at 390 | Chromium touch emulation (CDP touch events): a swipe scrolls the board (0 → 463 px) without lifting; a 400 ms hold lifts (overlay shown) and the drag lands on the next column. **WebKit not run** (not installed locally; CI only) | Long press lifts on the card itself; the stage stepper stays the main phone path. A WebKit long-press e2e is not written (see "Not done") |
| S12 | TanStack Query 5.103.2: do `scope: {id: 'deal-'+id}` mutations run in series, with `mutationFn` reading the latest cached version at run time? | Yes: three moves on one deal ran one at a time (max in flight 1), reading v0, v1, v2; another deal's scope ran in parallel; a failure does **not** cancel the next queued mutation in its scope | `use-pipeline.ts` uses scopes, reads the version when each runs, and drops queued moves itself after a failure or a conflict (a generation counter) |
| S13 | Motion `layout="position"` on cards inside TanStack Virtual rows (`translateY`), and the settle | After an insert at the top, card a0's own transform eased from −128 px to 0 over ~400 ms while its row kept `translateY(128px)`: the two compose | Neighbours keep `layout="position"` in virtualised columns (off while dragging and under reduced motion) |

## Checks (on the head named in the last line of this section)

Code at ee5312c, tests at 409403b (the docs commit after them changes no code).

- **lint**: 0 errors (2 warnings, both pre-existing: TanStack Virtual in `import/check-step.tsx` and
  `leads/leads-table.tsx`); **typecheck**: clean (also run by the pre-commit hook on every commit).
- **unit** (`npm run test:unit`): **385 passed**.
- **db** (`scripts/db-test.sh` copy on port 54361, ee5312c): all 10 suites pass (`rls_attack`, `import_attack`,
  `import_concurrency`, `activity_attack`, `activity_concurrency`, `outcome_attack`, `outcome_concurrency`,
  `deals_attack`, `deal_concurrency` incl. part 2 and `history_chain_consistent` with 0 deadlocks, `deal_links_attack`);
  advisors 0 ERROR (the accepted `set_user_role` WARN; INFO `unindexed_foreign_keys` 3, `unused_index` 3, as Day 5a).
- **mutations**: day5b 17 of 17 caught; Day 4a 1 of 1 and Day 4b 45 of 45 re-run against the Day 5b copies, all caught
  (`mutations.md`).
- **DB speed**: P5 met in three runs (`perf.md`).
- **e2e, local Chromium 156** (shared auth stack serving this worktree, `next start` on 3100): the Day 5b specs
  `pipeline` 11, `lead-deals` 6, `pipeline-multi` 1 (three runs in a row), `day5-security` 6, all passed on the final
  build; the broad run of every auth spec except `journey` (Mailpit), the speed specs and the screenshot specs: 83
  passed, 1 skipped (by design), and two files stopped in `beforeAll` — `import.spec` (its fixture reset hit the deals
  foreign key: fixed in 409403b) and `day4-security` (a Playwright trace-file copy error) — both re-run with
  `import-security`: **19 passed**. Earlier on the same day: `lead-page` + `leads` 35 passed, `shell` + `day4-security`
  passed.
- **Screens**: `day5-screens.spec.ts` 3 passed, 68 files in `screens/`.
- **Browser speed**: `day5-perf.spec.ts` run; budgets met for LCP, CLS, extra JS, press feedback, Pipeline → Home;
  missed for move paint, drag frames, settle, Home → Pipeline and the skeleton (`perf.md`). **Accepted as the baseline
  by Haider on 15 Oct (decision A); polish in Day 7.**
- **gitleaks** (`origin/main..HEAD`): no leaks found. **npm audit --omit=dev**: 0 vulnerabilities.
- **Spikes**: S10, S12, S13 passed; S11 passed on Chromium touch emulation (WebKit in CI only).
- **/security-review**: no findings (`security-review.md`). **Apple design** and **web interface guidelines** audits:
  fixes made, unresolved none (`apple-design-audit.md`, `web-design-guidelines.md`).
- Not run here: WebKit, Semgrep (CI only), `journey.spec.ts` (Mailpit), `screens.spec.ts` (Day 2–4 evidence; CI
  artifact).

## Verifier round 1 (15 Oct): fixes

Verifier verdict on b6b360b: NOT READY. Every finding, what changed and how it was checked (red = the new test failed on
the code before the fix, built and run here; green = it passes after):

| # | Finding | Change | Check |
|---|---|---|---|
| 1 | Day 4c merged on main; Day 5 recreated 4b bodies of `log_activity`, `undo_activity`, `get_lead`; `/api/queue/summary` conflicts; Home duplicated 4c's task functions | Branch rebased onto `origin/main` 5f1a966 (65 commits; conflicts resolved per file: logs, CI and db-test lists, messages merged key by key). `audit_row`, `log_activity`, `get_lead` re-copied from 4c with the Day 5 parts (361e6a4); `queue_card` gains `open_deal`; the queue's switch and deal line built (deviation 1); Home reads `count_tasks`/`list_tasks` and 4c's route (Day 5c README). 4c's own tests and mutation rows now run against the Day 5 copies | `db-test.sh` copy: all suites incl. 4c's `queue_attack`/`queue_concurrency` and the new `deal_links_attack` block 8; mutations below; e2e `interested_opens_deal_in_queue` red then green |
| 3 | Lose or Delete on the board dropped focus to `<body>` | Neighbour card, else the column heading (`tabIndex=-1`); the Lose dialog leaves the focus to the board; a keep-focus safety net on the board (e4e1f50) | `pipeline.spec` `lose_and_delete_focus_stays_in_column…` red then green |
| 4 | Reopen from the Deals tab and the card menu always went to Negotiations (and changed the lead's status); focus dropped | `reopenFromHistory` reads `get_deal`'s history (the chooser opens if it cannot); the Deals tab focuses the reopened row (e4e1f50) | `lead-deals.spec` `reopen_from_deals_tab_uses_closing_stage` (stage Qualified, lead Warm, row focused) red then green; pipeline test checks the menu's dialog starts at Qualified |
| 6 | "Open it now" missing, key unused | Not built, with the reason (deviation 8); key removed | `messages.spec` key parity |
| 7 | U / ⌘Z on the lead page never undid a deal move | `newerUndo` picks the newer of the last entry and the last move (unit-tested); the call panel takes the entry only when it is newer, and `useDealFlows({ undoKey })` on the lead page and in Home's deal sheet takes the move (the last move is a small store, `src/lib/last-move.ts`, so the layout does not load the pipeline's code; e70d3ae, 916f610) | `lead-deals.spec` `u_on_lead_page_undoes_the_newer_deal_move` red (U took the entry) then green; `undo-pick.spec` |
| 5 | Speed misses (builder-reported) | Not changed: **Haider's decision A (15 Oct): accepted as the baseline, polish in Day 7** (below) | — |
| 8 | Scratchpad take-over script | `5c/take-stack.sh` and its original `5b/take-stack.sh` deleted (never in the repo) | — |

Finding 2 (Home) is in the Day 5c README. **For Haider (finding 5):** the six Day 5b browser misses at 4x CPU (move
painted ~585 ms p95 vs 100, drag frames ~23 ms vs 16.7, settle ~690 ms vs 450, Home → Pipeline after the hover ~2 s vs
200, the skeleton 124–129 ms vs 100, long tasks up to 96 ms vs 50) were not re-measured in this round (the code paths of
a move did not change; the board gained one layout effect). Recommendation was one more speed step on the move and the
route before the 5b PR, or accept them as the baseline, as with Day 4b and 4c. **Decision A (Haider, 15 Oct 2026):
"accept as baseline, polish in Day 7".** The misses are the Day 5 baseline; the next steps listed in `perf.md` move to
Day 7 polish.

**Checks for this round** (worktree at 6b15b08 for code and tests; docs commit after):
- **lint** exit 0: 0 errors, the 2 known warnings; **typecheck** exit 0 (also the pre-commit hook on every commit);
  **unit** 432 passed (new: `home-today.spec.ts` 4, `undo-pick.spec.ts` 3; the 5a `sql-bidi` spec caught two raw bidi
  characters in 4c's tests at the rebase, now escapes).
- **db** (`db-test.sh` copy on port 54481): exit 0, every suite incl. 4c's `queue_attack`/`queue_concurrency`,
  `deal_concurrency` 0 deadlocks, `deal_links_attack` with block 8, `home_attack` with block 9; advisors 0 ERROR (WARN
  `set_user_role` as before; INFO `unindexed_foreign_keys` 5, `unused_index` 2: main's 4c baseline). `plpgsql_check`: 85
  functions, no finding. `check-migration-order.sh origin/main`: ok.
- **mutations** (throwaway worktree of cad5528 on port 54482, removed): 87 affected rows, 86 caught, 1 documented
  two-layer row (day4c 55, as Day 4c lists it); `--anchors`: every row of every set found once; every edit lands in a
  live definition. Details in `mutations.md` (5b and 5c).
- **DB speed** (one run, `db-perf.sh` copy on 54481): every Day 5 budget met (`perf.md`).
- **e2e, local Chromium, shared stack serving this worktree** (`--trace off` after Playwright's trace-copy error broke two
  `beforeAll`s in the first run): red then green for the five new or tightened tests (home attention, pipeline focus and
  reopen, lead-deals reopen, U order, queue deals). Final build: `home` 13, `pipeline` 12, `pipeline-multi` 1,
  `lead-deals` 9, `day5-security` 6, `queue-multi` 1, `tasks` 12, `lead-page` 26, `shell` 21 passed; `leads` 9 passed
  after its filtered-count read was made to wait (6b15b08). `queue.spec`: 20 of 20 passed in a full run with
  `call_keeps_claims` left out; its start key (↩ on the start screen) misses sometimes on this machine, **also on
  origin/main** (1 of 2 full runs failed the same way there); `call_keeps_claims` fails here on origin/main too (3 of 3:
  this Chromium fires one beforeunload for two quick tel: links, not CI's Headless Shell 156). Both left to CI.
- **Screens**: `screens/v1-queue-open-deal-*` (EN light, FR dark; 1440 and 390, no sideways scroll) and Day 5c's
  `screens/v1-home-queue-*`.
- **gitleaks** (`origin/main..HEAD`): no leaks. **npm audit --omit=dev**: 0 vulnerabilities.
- Not run here: WebKit, Semgrep (CI), the browser speed specs (finding 5), the Taste Skill pass, the advisor loop.

## Advisor round (15 Oct, on 5f1a966..ea75fbf: CHANGES NEEDED; item 4 here, items 1 to 3 in the 5c README)

**Pipeline evidence gaps** (`tests/auth/day5-screens.spec.ts`, `tests/auth/pipeline.spec.ts`; `screens/README.md`):
- 28 new shots in EN light and FR dark at 390 and 1440, like the Win dialog: the Lose dialog with its reason picker,
  the Reopen dialog (a won deal), the Delete confirmation, the board's own error (the first read fails), the refresh
  error (`/api/pipeline/board` answers 502 via `page.route`), the column error (Show more: `/api/pipeline/stage` 502),
  and an empty board (a second rep with no deal).
- The board's first read happens on the server (D32), out of `page.route`'s reach: `BoardError` is reached by taking
  `execute` on `pipeline_board` from `authenticated` for a moment on the local stack (given back in `finally`, checked);
  the browser-side read is the advisor's `page.route` 502. Both are covered.
- e2e: `board_read_fails_shows_retry_and_recovers` (server read refused: the error with Retry, the shell standing, no
  database text; Retry after the grant is back renders the board; then the 30 s refresh on Playwright's fake clock
  gets 502 twice (one retry): "Couldn't refresh" with Retry, the cards kept; Retry once the route answers brings a deal
  made meanwhile) and `column_read_fails_shows_retry_and_recovers` (Show more 502: "Couldn't load more" with Retry in
  that column only, the loaded cards kept; Retry shows 100). Both allow only Chromium's console line for the 502s they
  inject, and count them (2 and 1).
- Checks: `pipeline.spec` 15 passed, `pipeline-multi` 1, `shell` 20 (36 passed); `day5-screens` 5 passed (full run,
  96 shots, into a scratch folder; the 28 new ones copied here).

## Deviations from the design

1. ~~Queue pieces wait for 4c~~: built at the 4c rebase (15 Oct): `claim_next_lead`'s cards carry `open_deal {count,
   latest}` (4c's `private.queue_card` re-copied in `deal_links.sql`), the queue card shows "Deal open: Qualified ·
   €6,800", and Interested / Book meeting in the queue have the same "Open a deal" switch as the call panel (one shared
   `OpenDealSwitch`, D toggles it); `interested_opens_deal_in_queue` is in `lead-deals.spec.ts`.
2. **Conflict toast** names the colleague by first name ("Anouk moved this to Qualified a moment ago."), as
   `move_deal` answers `changed_by_first_name`.
3. **Money on cards and chips in whole euros** (design 7.2: "€22,000"); the deal sheet and the Win dialog show cents.
4. **Screens**: the full matrix for the board and the deal sheet (6 widths × light/dark × EN/FR = 48), and a
   representative set (lead Deals tab, Win dialog, New deal, call panel switch, the loading skeleton) in EN light and FR
   dark at 390 and 1440 (68 files). The design's other states (empty board, error, mid-drag Lost band, Lose dialog,
   conflict toast, Deals tab none/closed/read-only) are covered by e2e assertions, not screenshots.
5. **Local e2e** runs against `scripts/local-auth/gateway.mjs` (not PostgREST); the checks that hold only on real
   PostgREST are marked in `day5-security.spec.ts` and asserted in CI.
6. **Columns end 216 px above the viewport** (design: 152) so the Lost line clears the floating dock at tablet widths.
7. **Speed work beyond the design** (found by `day5-perf.spec.ts`, 24a6201): stable dnd-kit options and card
   handlers, "now" refreshed per fetch, the optimistic write in the event, cached money formatters. See `perf.md`.
8. **No "Open it now" after a skipped deal** (design 7.9; verifier finding 6). A call skips the deal for three reasons
   only: the caller may not change the lead, the lead is Do not contact, or the hourly open limit is reached. `open_deal`
   refuses all three in the same way (42501 `lead_not_editable`, the guard's `dnc`, the open flood's `rate_limited`), so
   the button could only fail. The skip is worded in the toast (as before); the unused `Outcomes.openItNow` key is
   removed (EN and FR).
9. **Reopen from a list** (the board's card menu, the lead's Deals tab) reads the deal's history first (`get_deal`, cached
   for the sheet) to start at the stage it was closed from, as the sheet does; if that read fails, the stage chooser
   opens instead of guessing (verifier finding 4).

## Rebase points (Day 4c done 15 Oct; Day 4d merged in 15 Oct)

Done at the 4c rebase (commits 361e6a4 and after):
- `20261015120000_deal_links.sql`: `public.log_activity` and `public.get_lead` re-copied from Day 4c's merged bodies (4c's
  FOR NO KEY UPDATE lead lock, its digit rule for a working number, `p_from_queue` releasing the caller's claim,
  `worked_by`) with the Day 5b parts applied again; `public.undo_activity` stays Day 4b's (4c did not change it);
  `private.queue_card` (4c) re-copied with `open_deal`. Day 4c's `queue_attack.sql` and `queue_concurrency.sh` run against
  these copies in `db-test.sh` and pass.
- `scripts/db-mutations.py`: Day 4c's set merged in; rows aimed at those functions follow the live 5b copies (a check that
  every edit lands in a live definition found one older row, day4a 25, still editing the dropped 4a insert policy:
  re-aimed). Mutation results in `mutations.md` ("Verifier round 1").
- Queue UI: the switch and the deal line (deviation 1); `src/lib/queue.ts` `QueueCard.open_deal`.
- `tests/auth/helpers.ts` keeps `seedLeads`' `delete from public.deals` (merged cleanly).

~~Still open for Day 4d (PR #16): every block marked `-- REBASE: re-copy after 4d merge`.~~ **Resolved 15 Oct** at the
merge of 4d's final head efbbbb4 (merge commit dd24bb6; `docs/evidence/day5c/README.md`, "Merge of Day 4d"): 4d's
migration redefines none of `public.log_activity`, `public.undo_activity`, `public.get_lead` or `private.queue_card`
(nor 5a's `audit_row` and `task_guard`), so every `-- REBASE` block keeps its body unchanged (no SQL edit at the merge;
the in-file markers stay as pointers for the next re-copy). `scripts/db-mutations.py` carries 4d's `day4d` set and its
re-aim of the "untouched" rule rows to the 4d migration; no 4d row aims inside a function Day 5b recreates. `seedLeads`
deletes files, then deals, then leads.

## Not done (and why)

- **WebKit e2e** (pipeline and lead-deals were added to its `testMatch`) and **Semgrep**: CI only (not installed here;
  semgrep.dev blocked). `journey.spec.ts` needs Mailpit (CI).
- **S11 on WebKit** and a `phone_long_press_drag` WebKit test: no local WebKit; Chromium touch emulation passed.
- **Taste Skill pass** (design 11 5b.7): not run in this session; the Apple design and web interface guidelines audits
  were (`apple-design-audit.md`, `web-design-guidelines.md`).
- **The `advisor` loop, REPORT, merge, `deploy-dev-db` and dev advisors** (design 11 5b.8): after this step, by the
  lead session and Haider.
- 5c (Home) is not part of this step.

## Open risks

- dnd-kit 6.x has had no release since Dec 2024 (design 9); the spikes passed on React 19.3 and Next 16.4.
- P1 `pipeline_board` mine (rep) stays over its 15 ms budget (17.6–18.4 ms; Day 5a's open item, unchanged).
- **Browser speed misses at 4x CPU** (`perf.md`): move painted p95 ~585 ms (100), drag frames p95 ~23 ms (16.7) with
  long tasks up to 96 ms (50), settle ~690 ms (450), Home → Pipeline after the hover ~2 s (200), skeleton 124–129 ms
  (100). Already cut by about a half to two thirds in 24a6201 and ee5312c; the next steps are listed in `perf.md`.
  **Accepted as the baseline by Haider on 15 Oct (decision A: "accept as baseline, polish in Day 7")**; the risk left
  is that the board feels slower than budget at 4x CPU until the Day 7 polish (real Macs are much faster than 4x).
- The REBASE copies above must be redone by hand when 4c merges.

## Docs used (Context7 and others)

- dnd-kit (`/websites/dndkit`): `DragOverlay` `dropAnimation={null}`, accessibility announcements and screen reader
  instructions; `useSensor` options (S10).
- Radix Primitives (`/websites/radix-ui_primitives`): Dialog/AlertDialog `Content` `onCloseAutoFocus` (focus back to
  the opener), ContextMenu.
- TanStack Query (`/tanstack/query`): mutation `scope` (serial per id; S12), `cancelQueries` before optimistic writes.
- TanStack Virtual (`/tanstack/virtual`): `rangeExtractor` with `defaultRangeExtractor` (S10), `measureElement`.
- Tailwind CSS v4 (`/websites/tailwindcss`, upgrade guide): `scale-*`, `translate-*` write the individual `scale` and
  `translate` properties, so transitions must name them (audit fix).
- Motion: `animate` from the current value, `layout="position"`, `useReducedMotion` (design 7.4; S13).
- next-intl: ICU plurals, `useFormatter`; MDN `Intl.NumberFormat` (fr-FR currency), `KeyboardEvent.code` (digits by
  key position) and `.key` (`D`).
- Vercel web interface guidelines at 434b7f9 (`web-design-guidelines.md`).
