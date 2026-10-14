# Day 5b: the pipeline and deals on the lead page, 12 to 14 Oct 2026

Design: `docs/evidence/day5/design.md` (sections 2.4 spikes S10–S13, 3.2, 4.2, 4.4, 4.5, 5, 6, 7, 8, 9, 11 "5b" items 1
to 7; Haider's answers of 11 Oct in `docs/log.md`). Local branch `day5a-local` (the finished Day 5a deals database,
verifier READY) from b49fd9e. **Day 4c and 4d are not merged here**: see "Rebase points". No push, no PR, no remote
database; fake data only.

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
  missed for move paint, drag frames, settle, Home → Pipeline and the skeleton (`perf.md`).
- **gitleaks** (`origin/main..HEAD`): no leaks found. **npm audit --omit=dev**: 0 vulnerabilities.
- **Spikes**: S10, S12, S13 passed; S11 passed on Chromium touch emulation (WebKit in CI only).
- **/security-review**: no findings (`security-review.md`). **Apple design** and **web interface guidelines** audits:
  fixes made, unresolved none (`apple-design-audit.md`, `web-design-guidelines.md`).
- Not run here: WebKit, Semgrep (CI only), `journey.spec.ts` (Mailpit), `screens.spec.ts` (Day 2–4 evidence; CI
  artifact).

## Deviations from the design

1. **Queue pieces wait for 4c** (the host is not on this branch): `interested_opens_deal_in_queue`, the queue card's
   "Deal open: Negotiations · €18,400" line, and `claim_next_lead`'s `open_deal {count, latest}`. The call panel's
   switch, which the queue reuses, is built and tested.
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

## Rebase points (Day 4c and 4d)

- `supabase/migrations/20261015120000_deal_links.sql`: `public.log_activity`, `public.undo_activity` and
  `public.get_lead` are copies of the merged Day 4b bodies plus Day 5b, each marked `-- REBASE: re-copy after 4c/4d
  merge`. Day 4c redefines `log_activity` (`p_from_queue` releases the claim) and `get_lead` (queue fields): re-copy
  4c's bodies and re-apply the Day 5b parts; add `open_deal {count, latest}` to 4c's `claim_next_lead` cards.
- `scripts/db-mutations.py`: rows aimed inside those functions follow the Day 5b copies; at the rebase they must follow
  the re-copied bodies (marked `REBASE:`).
- Queue UI: wire the "Open a deal" switch and the "Deal open" line into 4c's queue card; add
  `interested_opens_deal_in_queue` to `lead-deals.spec.ts`.
- `/api/queue/summary` is a 5c item (create only if 4c has none); not touched here.
- `src/lib/deals.ts` `LeadDealsBrief` is shared with 4c's claim cards at the rebase.
- `tests/auth/helpers.ts` `seedLeads` now deletes deals first: keep that line when 4c/4d change the helper.

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
  (100). Already cut by about a half to two thirds in 24a6201 and ee5312c; the next steps are listed in `perf.md`. For
  Haider: fix further before merge, or accept as the baseline as with Day 4b (recommendation: one more speed step on
  the move and the route before the 5b PR, since the board is used all day).
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
