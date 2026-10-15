# Day 5c: the Home dashboard, 14 to 15 Oct 2026

Built on `day5a-local` (in `/home/user/topstock-crm-5a`) after Day 5b, per `docs/evidence/day5/design.md` section 11
"5c" (with 3.3, 4.3, 4.5, 5.8, 6, 7.10 to 7.12, 8, 10 and Haider's 11 Oct answers in `docs/log.md`, which accept every
Day 5 recommendation, including open question 9: Team by default for admins, Mine remembered per device). Not merged,
not pushed. **15 Oct: rebased onto `origin/main` 5f1a966 (Day 4c merged)** and verifier round 1 fixed (section
"Verifier round 1"). Days 4d and 6 are built elsewhere and not on this branch: see "Rebase points".

## What changed

**Database** (`supabase/migrations/20261015150000_home_dashboard.sql`; no tables, no views):
- `private.home_window(at, zone)`: today's date, day start and end (the next local midnight, so a 23 or 25 hour day stays
  one day) and month start, in the caller's profile zone (`private.caller_zone`). The one place the bounds are computed.
- `private.home_open_deals(owner)`: the open deals in scope with stage, value, close date and Day 5a's stall rule (the
  lead read only when the stage clock alone is past the limit).
- `public.home_summary(scope)`: K1 open pipeline (count, value, without a value, stalled) and by stage; K2 won this month
  (current status); K3 win rate over 90 days (Opened by mistake left out; the rate only from 5 closed deals); the Lost
  line (30 days, by reason); K4 calls today and how many reached someone (Team: one index range per person); K5 tasks
  due and K6 meetings today (always the caller's own); K7 new leads in 7 days (org-wide), with how many were imported.
- `public.home_attention(scope, limit 5)`: open deals past their close date, stalled, or closing within 7 days; close
  date passed first, then most days over the limit, then soonest close; each a Day 5a deal card plus its reason.
- `public.home_recent_activity(scope, limit 8)`: entries and deal changes merged, newest first, undo pairs left out; the
  return type has no entry text and no lost note.
- ~~`public.home_today_tasks(limit 6)`~~: removed at the 4c rebase; the Today card reads Day 4c's `list_tasks` and
  `count_tasks`, and K5's overdue and today counts are `count_tasks('mine')` (the day's meetings still counted here).
- `public.home_low_stock(limit 5)`: a stub answering null, created only when absent (Day 6 replaces it, section 10).
- All SECURITY INVOKER, `search_path = ''`, static SQL with Mine and Team as separate statements, scope checked first,
  constant messages, revoked from public and anon.

**App**: `src/lib/home.ts` (Zod parts, the Day 6 `lowStockCard` contract, scope rule, helpers), `src/lib/home-server.ts`
(the parts in parallel with `allSettled`, each failing alone; since the 4c rebase Today is built from `list_tasks`
overdue and today plus `count_tasks`), `GET /api/home`, Day 4c's `GET /api/queue/summary` (5c's stand-in dropped at the
rebase), `src/components/home/*` (KPI row, count-up, Today, Work queue, Needs attention, Pipeline, Recent activity, Low stock,
scope switch and provider, data hooks, skeleton, the lazily loaded deal sheet), `(app)/page.tsx` and `(app)/loading.tsx`
rebuilt block for block with the "Hello {first_name}" / "Bonjour" greeting kept, the dock warming Home on hover and
focus, lead-page writes refreshing Home, messages EN and FR.

**Behaviour**: the greeting paints first; the figures stream under the cards' skeleton (or render at once from the query
cache after a dock hover); refetch on focus and every 60 s while visible; every card has its own loading, empty and error
state; a failed refresh keeps the old figures and says how old they are; ticking a task is instant with Undo; a Needs
attention row opens the deal sheet over Home (`?deal=`); Team · Mine for managers and admins, remembered on the device
(a cookie, so the server renders the remembered scope); the count-up plays once per tab when hydration is early and
never under reduced motion.

## Spike S14 (design 2.4; throwaway spec, never committed; logged in `docs/log.md`)

Question: does a server-passed promise read with `use()` (only when the cache is empty) stream without blocking the
shell or the greeting? Method: a throwaway Playwright spec held `lock table public.deals in access exclusive mode` for 4
s in a second session (so every figure waited), then opened Home by a hard load and by a client navigation from Leads.
Result: the greeting painted at 303 to 503 ms with the cards' skeleton (10 blocks, 0 KPI links) while the lock was held,
and the cards streamed in at 3.9 to 4.0 s when it was released, both ways. Decision: keep D32 as designed (no fallback to
fetching on mount).

## Checks

- **db** (`db-test.sh` copy on port 54361; every suite, then `home_attack.sql`): all pass; advisors 0 ERROR (the accepted
  `set_user_role` WARN; INFO counts unchanged from Day 5b).
- **mutations** (`--set day5c`, worktree on port 54362, removed): 17 of 17 caught (`mutations.md`).
- **DB speed** (3 runs): every P7/P8 budget met in runs 1 and 2; P8 recent activity 5.49 ms of 5 in run 3 (`perf.md`).
- **lint** 0 errors (the 2 known warnings in files Day 5c does not touch); **typecheck** clean; **unit** 400 passed.
- **e2e, local Chromium** (gateway stand-in, not real PostgREST): `home.spec` 13 passed; with `shell`, `lead-page`,
  `lead-deals`, `pipeline`, `pipeline-multi`, `day5-security` and `leads`: 93 passed. `home-screens` 2 passed (45 shots).
- **Browser speed** (`home-perf.spec`, 4x CPU): LCP 1.5 to 1.7 s, CLS 0, Home extra JS 9.1 KB gzip met; Pipeline → Home
  after the hover about 430 ms, the skeleton without a hover 84 to 174 ms and the first-seconds longest frame missed
  (`perf.md`, with causes).
- **gitleaks** (`origin/main..HEAD`, 64 commits): no leaks. **npm audit --omit=dev**: 0 vulnerabilities.
- **Security review** by hand (`security-review.md`): no open findings.
- **Audits**: `apple-design-audit.md`, `web-design-guidelines.md` (fixes made, none unresolved).

## Verifier round 1 (15 Oct): fixes

Verifier verdict on b6b360b: NOT READY. The Day 5c findings (the shared ones, 3, 4, 6 to 8, are in the Day 5b README):

| # | Finding | Change | Check |
|---|---|---|---|
| 1 | 4c on main: `/api/queue/summary` conflict, `home_today_tasks` and K5 duplicated 4c | Rebased; 4c's route kept, the `{ready:false}` branch and message dropped, "G Q" on Start calling; K5 from `count_tasks('mine')`; Today from `list_tasks` + `count_tasks` (`buildToday`, `overdueDays`), meetings with "their time"; `home_today_tasks` removed (361e6a4, cad5528) | `home_attack.sql` block 9 rewritten (an admin's Team counts none of a rep's tasks); `home-today.spec.ts` (4 unit tests); `day5-parity`; mutations day5c 17 of 17 (rows 7 and 16 re-aimed); e2e `queue_card_loads_after_paint` reads the real 4c answer |
| 2 | Closing the deal sheet over Home dropped focus to `<body>` when the move took the deal out of Needs attention; `home.spec` failed 2 of 2 | The sheet always prevents Radix's default and falls back to the deal's row, the row now at the opener's place (or the one before), then the card heading; Needs attention keeps the focus when a refetch drops the focused row (e4e1f50) | `attention_opens_deal_sheet and refetch_after_move` now checks both orders (refetch held until after the close; refetch while the sheet is open) with `toBeFocused`: red on the old code, green after; the full `home.spec` 13 of 13 |
| 5 | Pipeline → Home ~430 ms and two more Home misses | Not changed: Haider's decision (Day 5b README, "For Haider") | — |

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

## Deviations from the design

1. **Tasks** (since the 4c rebase): K5's overdue and today are Day 4c's `count_tasks('mine')`; K6 (the day's meetings)
   is counted in `home_summary`. The Today card reads `list_tasks('overdue' / 'today', 'mine', 6)` and orders the day's
   meetings first in TypeScript; "Overdue · N days" is counted from `home_summary`'s own `today` in the profile zone
   (`overdueDays`, unit-tested at unambiguous instants), and shows "Overdue" alone if the summary failed.
2. **`home_recent_activity` returns a table** (design 4.3 says jsonb), so its column list can be checked in `pg_proc`
   (design 8.1 `recent_activity_has_no_body`); it also returns `item_id` for list keys.
3. **The scope is remembered in a cookie** (`topstock.home.scope`), not `localStorage`: the server then renders the
   remembered scope, with no flash of Team figures for someone who chose Mine. Still per device; the database checks
   the scope on every call.
4. **One promise for the page** (all parts, each settled on its own) instead of one promise per part: the same fault
   isolation, one cache entry `['home', scope]`.
5. **The Work queue card** reads Day 4c's `GET /api/queue/summary` (Mine, no lunch skip); when both counts are 0 it says
   "Nobody to call right now." Start calling shows 4c's "G Q" key caps and
   `aria-keyshortcuts="G Q"`.
6. **Today**: a meeting shows its time in the profile zone and, when the lead's calling zone differs, "{time} their time"
   (`list_tasks` gives the lead's zone). "Add a task" and "Open Tasks" go to Day 4c's Tasks page (its quick add is at the
   top; T focuses it).
7. **`kpi-dates.spec.ts` (unit) not written**: no "today" or "this month" is computed in TypeScript; the zone rules live
   in SQL and are tested at fixed instants in `home_attack.sql` block 1 and in e2e `karachi_today_boundary`.
8. **Dates in English** follow `en` (US order: "Oct 13"), as the rest of the app does; the design's examples ("3 Oct")
   are British.
9. **KPI sub-lines** wrap to two lines below 1280 instead of being cut (audit fix); the cards' minimum height is kept.

## Rebase points (Day 4c done 15 Oct; Day 4d and Day 6 open)

Done at the 4c rebase (361e6a4, cad5528): `home_summary` K5 from `count_tasks('mine')`; `home_today_tasks` removed (its
grant, `home_attack.sql` block 9 rewritten against `count_tasks`/`list_tasks`, mutation rows 7 and 16 re-aimed, the parity
line now checks `list_tasks`' bounds); `fetchHome` reads `list_tasks` and `count_tasks`; 4c's `/api/queue/summary` kept and
5c's dropped with its `{ready:false}` branch and message; the card shows the "G Q" hint; "Add a task" goes to 4c's Tasks
page. 4c's `check_profile_timezone` refuses an unknown zone on save, so `home_attack.sql` writes its unknown-zone case
with triggers off. The 5a `sql-bidi` spec scans every file: two raw bidi characters in 4c's tests (`tests/unit/tasks.spec.ts`,
`supabase/tests/queue_attack.sql`) are now written as escapes.

- Day 6: the contract in design section 10 says `home_low_stock(p_limit)` with `{low, out, deals_waiting, items}`; Day 6's
  design and its 6d build name `stock_alerts()` with a different shape (`sold_out`, `requests_new`, `sample`, ...). The
  two must be agreed before either database PR merges (open risk 1). The stub is created only when absent, so whichever
  merges first works.
- Rename the migration at merge if main moved (D35).

## Not done (and why)

- WebKit (`home` is now in the WebKit `testMatch`) and Semgrep: CI only.
- `journey.spec` (needs Mailpit), the Day 2 to 4 `screens.spec` and the import specs were not re-run locally (Day 5c
  does not touch them).
- The Taste Skill pass.
- The advisor loop, REPORT, merge, dev deploy and dev-dashboard advisors (Haider decides merges; no remote database
  from this session).
- A browser measure that isolates the count-up's own frames (see `perf.md`).

## Open risks

1. **Day 6 contract mismatch** (`home_low_stock` vs `stock_alerts`), above.
2. **Route speed**: Pipeline → Home after the hover is about 430 ms against 200 ms (Next 16.4 prefetches dynamic routes
   only to `loading.tsx`); the same limit as Day 5b's Home → Pipeline. Haider to choose: accept as the baseline or a
   speed step.
3. **P8 recent activity** sits close to its 5 ms budget (3.8 to 5.5 ms); about 2 ms is Day 5a's history select policy.
4. ~~The 4c rebase touches `home_summary`, `fetchHome` and the queue route by hand.~~ Done 15 Oct and tested; the 4d
   rebase will touch the same `-- REBASE` blocks in the Day 5 migrations again.
5. During this step the shared local auth stack was taken over from the idle `topstock-crm-team` checkout as the task
   rules allow; the take-over script (copied from Day 5b) also stopped an isolated gateway on port 54421 that belonged
   to another session's stack. It was restarted at once with its own settings (health check 200); that session should
   check its stack if it saw an error around 21:55 UTC. The take-over scripts (`5b/take-stack.sh`, `5c/take-stack.sh` in
   the session scratchpad, never in the repo) were deleted on 15 Oct (verifier finding 8); this round restarted only the
   shared stack's own gotrue and gateway, by PID, after checking they served this worktree and nothing else used them.

## Docs used (Context7 and others)

- Next.js (`/vercel/next.js`): passing an unawaited promise from a server component and reading it with `use()` under
  Suspense (streaming; spike S14).
- TanStack Query (`/tanstack/query`): `initialData` with `initialDataUpdatedAt`, `staleTime`, `refetchInterval` (paused in
  the background), `placeholderData: keepPreviousData`.
- Motion (`/websites/motion_dev`): `animate(from, to, { onUpdate })` for the count-up, motion value events,
  `useReducedMotion` (read directly from the media query in the count-up's layout effect instead, so a settling hook
  value cannot restart the count).
- next-intl (`/amannn/next-intl`): `useFormatter` `relativeTime(date, now)`, `number` with currency, ICU plurals.
- PostgreSQL 16 (`/websites/postgresql_16`): `AT TIME ZONE` both ways, `date_trunc` with a zone, interval arithmetic
  across clock changes (`+ interval '1 day'` vs `'24 hours'`).
- React docs: transitions during hydration (selective hydration) for the scope switch.
- Vercel web interface guidelines at 434b7f9 (`web-design-guidelines.md`).
