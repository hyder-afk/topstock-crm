# Day 4c: the Tasks page and the work queue, 12 Oct 2026

Design: `docs/evidence/day4/design.md` (sections 1, 2 with D1 to D17, 3.3, 4.2, 5.4 to 5.6, 6, 7.4, 7.5, 7.7 to 7.10,
8, 10 "4c Tasks and work queue", 11 with Haider's answers of 11 Oct). Local branch `day4c-local`, cut from `main`
a7aa89e (Day 4a and Day 4b merged). Two parts: the database (build order items 1 to 3; `mutations.md`, `perf.md`,
`docs/log.md`) and the app (items 4 to 7, this file). Nothing pushed; the lead builder opens the PR.

## What changed

**Database** (part 1, summarised; details in `docs/log.md` 12 Oct, `mutations.md`, `perf.md`)

- Migration `supabase/migrations/20261013090000_tasks_queue.sql`: `has_contact_phone` kept by a contact trigger (with
  backfill), generated `call_zone` and `queue_rank` with the owner, team and unassigned queue indexes, calling hours
  (`call_zone_keys`, `call_zone_open`, `open_call_zones`), private `queue_claims` with its guard (10 minutes, 3 per
  person, one lead per person at a time), task indexes, the profile zone check, and the RPCs `claim_next_lead`,
  `claim_lead`, `renew_claims`, `release_claims`, `queue_summary`, `list_tasks`, `count_tasks`, `update_task`,
  `delete_task`, `set_my_timezone`; `get_lead` gains `worked_by`; `log_activity` releases the caller's claim when the
  call came from the queue.
- Tests: `queue_attack.sql`, `queue_concurrency.sh` (in `db-test.sh` and `db.yml`), mutations, perf part 3.

**App** (part 2)

- **Libraries with unit specs.** `src/lib/queue.ts` (scopes, reasons, card and summary types, Zod strictObject
  requests, claim counts, this session's skips, the keys by `event.code`/`event.key`, the not-saved outcome store in
  `sessionStorage['topstock.queue.pending']` keyed by request id, the lunch switch, the first zone to open, the empty
  states); `src/lib/http.ts` (`assertSameOrigin`: Origin against `x-forwarded-host`/Host, or `Sec-Fetch-Site:
  same-origin` without an Origin; `readJsonBody`: JSON only, byte limit, parse); `src/lib/tasks.ts` (buckets, tabs,
  scopes, `list_tasks` rows, the GET parameters, `updateTaskInput`, `bucketOf` and `dueParts` in the person's zone);
  `src/lib/queue-server.ts` and `src/lib/tasks-server.ts` (server-only reads and writes shared by actions and routes);
  `src/lib/db-errors.ts` gains the hints `bad_bucket` and `timezone`. Unit: `queue.spec.ts`, `http.spec.ts`, additions
  to `tasks.spec.ts` (Paris and Karachi buckets and labels), `messages.spec.ts` (Queue, Tasks, Profile, Palette:
  key parity, French typography, plurals and ordinals).
- **Server actions and routes.** `src/app/(app)/leads/queue/actions.ts`: `startQueue`, `undoOutcome`
  (`undo_activity` then `claim_lead`), `renewClaims`, `releaseClaims`. Route handlers: `POST /api/queue/outcome`
  (`log_activity` with `p_from_queue`, then `claim_next_lead` with the card the screen keeps), `POST /api/queue/next`
  (Skip, or the reserve ran dry), `POST /api/queue/release` (pagehide, `keepalive`), `GET /api/queue/summary`.
  `src/app/(app)/tasks/actions.ts`: `createTask`, `updateTask`, `setTaskDone`, `setTaskCancelled`, `deleteTask`;
  `GET /api/tasks`. `src/app/(app)/more/actions.ts`: `saveTimezone` (`set_my_timezone`). Every one: Zod strictObject,
  `requireSession()`/`apiSession()` (aal2), RPC arguments named one by one, codes only; the routes check the origin, the
  content type and the size, and are never cached.
- **Tasks page** `/tasks` (replaces the placeholder and its skeleton): Today · Overdue · Upcoming · Done with counts
  (`count_tasks`) in the person's own time zone, Mine / Team for managers and admins, quick add (Today, Tomorrow, Next
  week, Pick a date, an optional time, To-do / Call / Meeting, a meeting needs a time, Link a lead as a combobox),
  56 px rows (round check, title, lead link, due label in DM Mono, "10:00 their time" on call tasks, Overdue in the red
  token with the word, kind, initials in Team, Do not contact note, a menu with Edit, Dismiss, Delete), Done and
  Dismiss at once with Undo, inline edit (E), Delete asks first and then for a fresh code (`useStepUp`, new body text),
  keys T, J/K, X/Space, E, D, ⌫, ↩; loading rows, an empty line per tab, an error with Try again, Show more (keyset).
- **Work queue** `/leads/queue` (page, `loading.tsx`, `src/components/queue/*`, `use-queue.ts`): the start screen
  (intro, scope for admins, the counts in DM Mono, the lunch switch remembered for the session, Start ↩); working: the
  card (reason, status, owner, the lead's local time and "open until", the main number in large DM Mono with its red
  Call, contacts with their own Call, the last 3 notes, my open tasks, the script in English or French by country with
  a switch, the next lead) and the rail (the shared 4b outcome pad as a list, follow-ups inline for 5, 6 and 0 with ↩
  and Esc, a second ↩ for 7, the note (N; a sheet on phones), Skip (S), this session's counts, "1 outcome not saved ·
  Retry"); the engine keeps the card on screen and one claimed card in reserve, runs every server call in order (the
  card to keep is worked out when the call starts), keeps an outcome until saved (retries at 0.5, 1 and 2 s, replay-safe
  request id), renews claims every 4 minutes while visible and in use, releases them on pagehide (keepalive) and when
  the queue is left in the app, starts again after the browser's page cache; Undo (U, Cmd/Ctrl+Z, the toast) brings
  the lead back; a reserve card is read again when shown (a lead marked Do not contact meanwhile gets a banner and only
  7 and Skip work); empty states: all done (later today, no number), outside hours (which zone opens next, "Show leads
  outside calling hours"), no leads of one's own ("Work unassigned leads" for admins). Motion: out to the left, in from
  the right (`snappy`), a 120 ms fade with reduced motion; the leaving card is inert and hidden from assistive tech;
  focus to the new card's heading after each advance; one polite message per advance.
- **Elsewhere.** The lead page: "Henri is on this lead in the queue (until 10:24)" from `get_lead.worked_by`. More:
  "Your time zone" (closed list drawn on the server, "Use this device's zone"). Entry points: Work queue in the leads
  header, Cmd+K "Start work queue", G then Q; the shortcuts dialog gains Work queue and Tasks sections.
- **Messages** EN and FR: `Queue`, `Tasks`, `Profile.timezone*`, `Shortcuts.*`, `Palette.startQueue`,
  `Leads.workQueue`, `LeadPage.workedBy`, `Errors.hint.{bad_bucket,timezone}`, `StepUp.bodyDeleteTask` (French
  typography checked by `messages.spec.ts`).
- **E2E.** `tests/auth/tasks.spec.ts` (quick_add_chips_buckets, toggle_done_undo, dismiss_and_undo,
  karachi_today_boundary, team_scope_admin_only, delete_needs_code, keyboard_only), `tests/auth/queue.spec.ts`
  (keys_each_outcome and keyboard_only, azerty_digits, skip_and_undo and undo_reclaims_lead, interested_chips_enter and
  meeting_requires_time, outside_hours_state_then_show_outside and dnc_never_served, note_typing_does_not_trigger_keys,
  offline_outcome_retried_once, pagehide_releases_claims, rep_sees_only_mine with the worked-by line),
  `tests/auth/queue-multi.spec.ts` (three people, 30 leads), `day4-security.spec.ts` (rep scope 403, private claims
  table, the release and key-path routes refuse other origins, form posts, oversized and unknown fields; no console
  error or CSP violation on the 4c pages), `day4-perf.spec.ts` and `day4-chunks.spec.ts` (PERF=1), screenshots in
  `screens.spec.ts`. WebKit's `testMatch` gains `queue`, `queue-multi` and `tasks`. Calling hours follow the real clock
  (the database's `now()`), so queue fixtures pick a country in hours at run time (`countryInHours` in
  `tests/auth/helpers.ts`), or use "Show leads outside calling hours" when every zone is closed.

## Check results

App checks on **e8ce3c9** (the last code commit; the commits after it change only `docs/`). Database part: as
reported for part 1 (`mutations.md`, `perf.md`), re-run below on this head.

| Check | Result |
|---|---|
| `bash scripts/db-test.sh` | all nine suites pass (rls_attack, import_attack, import_concurrency, activity_attack, activity_concurrency, outcome_attack, outcome_concurrency, queue_attack, queue_concurrency); advisors: no ERROR-level findings (WARN `set_user_role`, accepted); exit 0 |
| `npm run lint` | exit 0: 0 errors, the 2 existing React Compiler warnings (TanStack Virtual) |
| `npm run typecheck` | exit 0 |
| `npm run test:unit` | 338 passed, exit 0 (322 before this part: `queue.spec.ts`, `http.spec.ts`, the Tasks cases and the messages cases are new) |
| Playwright, local auth stack, Chromium, the whole auth suite (e8ce3c9) | **111 passed, 5 skipped** (PERF-only: day4-chunks 2, day4-perf 2, import-perf 1), 32.9 min. One failure, as expected: `journey.spec.ts` "invite, password, two-factor setup" stops at `MAILPIT_URL is not set` (no Mailpit locally; CI has it), and its 4 dependent tests did not run. New: tasks 7, queue 9, queue-multi 1, day4-security +4, screens +4. An earlier whole-suite run on 8d2a3f7 found 3 real failures, fixed in e8ce3c9: the Tasks h1 carried its count (`shell.spec` expects "Tasks"), the palette's new item matched "dark", and the focus after an inline edit (a race); plus the time zone form's second status region on More (found by `shell.spec` re-run). The import spec's failure in that run was this builder running the unit tests at the same time (they empty `test-results`), not the app |
| Speed, queue (PERF=1, Chromium, 4x CPU) | see the table below |
| Route chunks (PERF=1) | queue **15 KB** gzip over the app shell (budget 40); Tasks **0 KB** extra by this method (the dock's Tasks link prefetches the route's code on `/more`, so the method cannot separate it; budget 35) |
| gitleaks (`origin/main..HEAD`) | 21 commits scanned (through the evidence commit), no leaks found, exit 0 |
| `npm audit --omit=dev` | found 0 vulnerabilities, exit 0 |
| Screenshots (`screens/README.md`) | 156 Day 4c shots in the whole-suite run on e8ce3c9 (no console error, no sideways scroll); 52 kept |
| Apple design audit / Web Interface Guidelines | `apple-design-audit.md`, `web-design-guidelines.md` (findings fixed in 8d2a3f7; unresolved: none) |
| Semgrep | not run locally (CI's `semgrep` job) |
| WebKit e2e | not installed here; CI's auth-journey (webkit) runs the queue and Tasks specs |

**Queue speed** (design 8.6 and D3; this 4-vCPU cloud VM, load average about 4 from other checkouts' test runs, 4x CPU
slow-down, timed inside the page; the local REST stand-in starts one `psql` per database call, which real PostgREST
does not):

| Measure | Server actions (33afb66's parent) | Route handlers, run 1 | run 2 | Budget |
|---|---|---|---|---|
| Key to next card painted, p95 of 30 | 126 ms | 75 ms | 98 ms | 100 ms: met after the switch |
| Key to outcome saved, p95 of 30 | **616 ms** | 424 ms | 462 ms | recorded; over 400 ms triggered the D3 switch |
| Longest task during an advance | 97 ms | 73 ms | 112 ms | 50 ms: **missed** |
| Loading card shown in 10 keys pressed as fast as each card shows | 9 | 9 | 9 | at most 1: **missed** (see Open risks) |

## Deviations from the design

1. **D3's switch rule applied** (measured above): the outcome-plus-next-card call and the next-card call are POST
   route handlers (`/api/queue/outcome`, `/api/queue/next`) with the design's `assertSameOrigin`, JSON only, size
   limits, Zod and codes only. Start, Undo, renewal and release stay server actions (off the key path).
2. **One more route:** `GET /api/queue/summary` gives the start screen's counts when the scope or the lunch switch
   changes (read only; no claim on GET or render).
3. **The queue's Call is a plain `tel:` link**, not the 4b call panel: the rail's outcome pad (the 4b component) logs
   the call, so there is one place to log and a call is never logged twice. The follow-up picker is 4b's too.
4. **"Today's stats" are this session's** ("This session: 23 calls · 4 talks", kept per day in this tab's storage), not
   the database's (no new RPC).
5. **Work queue sits in the leads header** beside Import and Add (not inside the filter toolbar), and uses Next's
   default prefetch, which stops at the queue's loading skeleton (no data read, nothing claimed). With
   `prefetch={false}` a click showed nothing until the server answered.
6. **Link a lead** reuses the leads list search (`GET /api/leads?q=`, the first 8 names) instead of a limit-8 call.
7. **Tasks labels** ("Today", "Tomorrow 10:00") follow the profile's zone, like the buckets (the lead page's task card
   keeps 4b's browser zone).
8. **Delete asks first** ("Delete this task?"), then for a fresh code if the last one is over 10 minutes old.
9. **On phones the pad follows the card's head** (name, place, red Call) instead of resting fixed above the dock: no
   content scrolls under it, and it stays within reach.
10. **The not-saved chip appears only after the last retry** (0.5, 1, 2 s); an outcome being tried is not counted.
11. **The reason chip is hidden for Warm and Negotiation** (the status badge says it); it shows for a follow-up, a
    retry (with its try number), a lead back from Cool off and a first call.
12. **Local e2e ran on a second, isolated local stack** (gateway 54421, PostgreSQL 54430, Supabase Auth 9997, Next on
    3200; scratch copies of `start.sh` and `gateway.mjs`, not committed) because the shared stack on 3100 was serving
    the 4d and 6b checkouts during this run. Cookies are not port-scoped, so every spec ran unchanged.

## Not done here

- WebKit e2e (not installed here), Semgrep (blocked here), `journey.spec.ts` (needs Mailpit): CI.
- The advisor loop, `/security-review` and the PR: the lead builder's steps.

## Open risks

- **Queue speed budgets partly missed** (table above): the longest task during an advance is 73–112 ms at 4x CPU
  (budget 50: the new card's render, mostly Intl formatting of its contacts, notes and tasks); the 10-key burst shows
  the loading card on nearly every key, because a key arrives before one save-and-claim round trip (about 300–450 ms
  here) can refill the single reserve card. Holding two in reserve would only move the problem two keys later and would
  let a closed laptop hold three leads (the design says two). At human pace (a call between keys) the reserve is always
  full. Key to saved stays a little over 400 ms after the switch on this loaded VM with the `psql`-per-call REST
  stand-in; the CI or a real Supabase project will tell.
- **Calling hours in e2e follow the real clock:** the outside-hours test is skipped when no listed country is closed
  (never in practice), and every queue test uses "Show leads outside calling hours" when every zone is closed
  (weekends), so the in-hours path is then not exercised.
- **WebKit** runs the queue (three contexts too) and Tasks specs for the first time in CI.
- **The route-chunk method** cannot measure the Tasks page (its code is prefetched by the dock on the reference page).
- **`count_leads` for Mine** is read on every queue page load (to word "No leads are assigned to you"); cheap with the
  owner filter, measured only through the e2e.

## Docs used

Context7 pages consulted before coding:
- **Next.js 16.2** (`/vercel/next.js/v16.2.9`): `docs/01-app/03-api-reference/03-file-conventions/route.mdx` (route
  handlers, `request.text()`, reading headers), `docs/01-app/03-api-reference/04-functions/next-response.mdx`
  (`NextResponse.json` with status and headers), `proxyClientMaxBodySize.mdx` (the body stays readable in the handler).
- **Motion** (`/websites/motion_dev`): AnimatePresence `mode="popLayout"` (the parent needs a non-static position),
  unique keys for exit animations, `layout` with exit animations.
- Reused from Day 4b's lookups (README "Docs used" there): TanStack Query v5 infinite queries and optimistic
  `setQueryData`, next-intl `useFormatter`, Next.js `Link` prefetch (`prefetch` default stops at `loading.js` for a
  dynamic route), Playwright `page.route` and `page.close({ runBeforeUnload })`.
- Not looked up (platform knowledge, noted): `fetch(..., { keepalive: true })` on `pagehide`, `PageTransitionEvent`
  `persisted`, cmdk's `commandScore` (read from `node_modules/cmdk/dist/command-score.js` to fix a palette match).
