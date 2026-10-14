# Day 5c: the Home dashboard, 14 to 15 Oct 2026

Built on `day5a-local` (in `/home/user/topstock-crm-5a`) after Day 5b, per `docs/evidence/day5/design.md` section 11
"5c" (with 3.3, 4.3, 4.5, 5.8, 6, 7.10 to 7.12, 8, 10 and Haider's 11 Oct answers in `docs/log.md`, which accept every
Day 5 recommendation, including open question 9: Team by default for admins, Mine remembered per device). Not merged,
not pushed. Days 4c, 4d and 6 are built elsewhere and not on this branch: see "Rebase points".

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
- `public.home_today_tasks(limit 6)`: a stand-in for Day 4c's `list_tasks` (REBASE).
- `public.home_low_stock(limit 5)`: a stub answering null, created only when absent (Day 6 replaces it, section 10).
- All SECURITY INVOKER, `search_path = ''`, static SQL with Mine and Team as separate statements, scope checked first,
  constant messages, revoked from public and anon.

**App**: `src/lib/home.ts` (Zod parts, the Day 6 `lowStockCard` contract, scope rule, helpers), `src/lib/home-server.ts`
(five parts in parallel with `allSettled`, each failing alone), `GET /api/home`, `GET /api/queue/summary` (stand-in until
4c), `src/components/home/*` (KPI row, count-up, Today, Work queue, Needs attention, Pipeline, Recent activity, Low stock,
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

## Deviations from the design

1. **Tasks**: Day 4c's `count_tasks` and `list_tasks` are not on this branch. K5/K6 are counted inside `home_summary`
   with 4c's bucket rules, and the Today card reads `home_today_tasks` (same rules, plus `overdue_days`). Both marked
   REBASE.
2. **`home_recent_activity` returns a table** (design 4.3 says jsonb), so its column list can be checked in `pg_proc`
   (design 8.1 `recent_activity_has_no_body`); it also returns `item_id` for list keys.
3. **The scope is remembered in a cookie** (`topstock.home.scope`), not `localStorage`: the server then renders the
   remembered scope, with no flash of Team figures for someone who chose Mine. Still per device; the database checks
   the scope on every call.
4. **One promise for the page** (all parts, each settled on its own) instead of one promise per part: the same fault
   isolation, one cache entry `['home', scope]`.
5. **The Work queue card before 4c**: `/api/queue/summary` exists (design: "only if 4c has none") and answers
   `{ready:false}` while `queue_summary` is missing; the card says "Counts will show here once the work queue is set up."
   Start calling links to `/leads/queue`, which 4c adds. The "G Q" hint is not shown (4c adds the shortcut).
6. **Today**: meeting times show in the profile zone only (no dual-zone label: the stand-in returns no lead zone).
   "Add a task" and "Open Tasks" link to `/tasks`, still Day 2's placeholder on this branch.
7. **`kpi-dates.spec.ts` (unit) not written**: no "today" or "this month" is computed in TypeScript; the zone rules live
   in SQL and are tested at fixed instants in `home_attack.sql` block 1 and in e2e `karachi_today_boundary`.
8. **Dates in English** follow `en` (US order: "Oct 13"), as the rest of the app does; the design's examples ("3 Oct")
   are British.
9. **KPI sub-lines** wrap to two lines below 1280 instead of being cut (audit fix); the cards' minimum height is kept.

## Rebase points (Day 4c, 4d, Day 6)

- `20261015150000_home_dashboard.sql`: in `home_summary`, the K5 counts become `public.count_tasks('mine')` (keep the
  meetings count); delete `public.home_today_tasks` (its grant, `home_attack.sql` block 9, mutation row 16 and the parity
  line) and make `fetchHome` call `list_tasks('overdue' / 'today', 'mine', 6)`. Marked `-- REBASE`.
- `src/lib/home-server.ts` (`fetchHome`, `fetchQueueSummary`): follow the above; `src/app/api/queue/summary/route.ts`
  **conflicts** with 4c's route of the same path: keep 4c's (it takes scope and lunch parameters) and drop the
  `{ready:false}` branch and the card's "not ready" message.
- Wire the Work queue card into 4c's queue pieces (4c's empty messages, the "G Q" hint) and point "Add a task" at 4c's
  Tasks page.
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
4. The 4c rebase touches `home_summary`, `fetchHome` and the queue route by hand.
5. During this step the shared local auth stack was taken over from the idle `topstock-crm-team` checkout as the task
   rules allow; the take-over script (copied from Day 5b) also stopped an isolated gateway on port 54421 that belonged
   to another session's stack. It was restarted at once with its own settings (health check 200); that session should
   check its stack if it saw an error around 21:55 UTC.

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
