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

## Verifier round (12 Oct 2026): every finding, what changed, how it was checked

An independent verifier said NOT READY (one blocker, four should-fix items, seven nits). All are fixed below, each
behavioural fix with a test that fails without it (checked by building the app with the fix taken out: the three new
queue tests failed, then passed with it).

1. **Blocker: a lead on two screens.** `src/components/queue/use-queue.ts`: `take()` now reads `kept` from every
   claim answer (`lostKept` in `src/lib/queue.ts`); a kept card the database no longer holds for the caller leaves the
   screen at once (the quiet swap: the next card takes its place and the focus) with "A teammate is on that one now.
   Here's the next." (inside the "Logged" toast when it comes with a save, so one toast says both), and a fresh claim
   refills the reserve. Each card carries `claimedUntil` (the request's start plus 10 minutes, never later than the
   database's end), renewed by every claim call and by `renew_claims` (`renewedUntil`: only cards still held when the
   renewal was sent); `checkHeld()` runs every 15 s, when the tab comes back into view and before every key: a card
   that may no longer be held (`claimsStale`, 20 s margin) takes all cards off the screen, lets their claims go, and
   the start screen says "Your leads went back to the team" with a link "Log your call to {lead}" (a call made on that
   card can still be logged on its page) and Start focused. `renew_claims` answering null while cards are held does
   the same. A card read again when shown (after 15 s in reserve) that `get_lead.worked_by` says a teammate is working
   leaves with "{name} is on that one now. Here's the next." Tests: unit `lostKept`, `claimsStale`, `renewedUntil`;
   e2e `claims_end_cards_leave` (Playwright's page clock moves 10.5 minutes on, the claims are ended in the database
   and a teammate takes the lead on screen: the card goes, the notice and link show, Start has the focus, a digit logs
   nothing, Start again serves a lead held by this person and not the teammate's) and `lost_claim_quiet_swap` (a
   teammate holds the reserve: after 1 it leaves with the toast, the next card is held by this person and focused,
   nothing logged on the teammate's lead). The verifier's own probe, run again on the fixed build: focus after Start on
   the card heading, after Done for now on Start, A's next card held by A.
2. **Focus dropped to the page.** `src/components/queue/queue-workspace.tsx`: Start focuses the page title (it stays
   across the phases), then the first card's heading takes it; Done for now, Back to the start and the claims ending
   focus Start; the empty state's heading (`tabIndex -1`) takes the focus; while cards load after a loss the title
   holds it. Test: e2e `focus_never_drops_to_body` (Start with the pointer, Done for now, the empty state, Back to the
   start).
3. **Speed budgets (design 8.6).** Not met; measured again and two changes tried (below, "Queue speed"); **Haider is
   asked to decide** (Open risks, "Question for Haider").
4. **Daylight-saving time bomb.** `tests/auth/tasks.spec.ts` karachi_today_boundary: the Paris time and day of the
   task are worked out by the database (`to_char(... at time zone 'Europe/Paris', 'HH24:MI')` and the day difference),
   so it reads 22:00 after 25 Oct and 23:00 before.
5. **Phone target.** `src/components/tasks/task-row.tsx`: the lead link keeps its 24 px line (the row and its skeleton
   keep their height) and gets a tap area 10 px above and below on phones (`max-sm:before:-inset-y-2.5`), 44 px in
   all. Test: e2e `phone_lead_link_target` (at 390: the box stays 24 px, `elementFromPoint` 9 px above and below lands
   on the link).
6. **Nits.**
   - `tasks.spec.ts`: the comment now has its attempt: a made-up option "Mars/Olympus_Mons" is added to the list in
     the page and saved: an error alert, and the profile keeps Europe/Paris.
   - `queue-card.tsx`: "open until" uses `openUntilMinutes` (`src/lib/timezones.ts`): 12:00 before lunch with the lunch
     switch on in a European zone, else 18:00 (unit test).
   - `queue-card.tsx`: a follow-up's time is shown in the profile zone (the page reads `profiles.timezone`, as Tasks).
   - `src/lib/queue.ts` `emptyReason(..., anyHours)`: with "Show leads outside calling hours" on, the empty state is
     "all done", never the same offer again (unit test).
   - `supabase/migrations/20261013090000_tasks_queue.sql` (log_activity, wrong number): "another working number" needs
     a digit (`coalesce(v_lead.phone ~ '[0-9]', false)`, `k.phone ~ '[0-9]'`), so a "( )" number no longer blocks the
     find-the-right-number task. Test: `queue_attack.sql` 5b (digitless contact, digitless main line, a second real
     contact number still counts); mutation rows 86 and 87 caught, day4b row 65 re-pointed and caught
     (`mutations.md`).
   - `messages/fr.json` `Queue.reason.retryNth`: "Nouvel essai · 3e appel".
   - `src/app/(app)/leads/queue/page.tsx`: no "TopStock" fallback name; with no first name the script reads without a
     name (`Queue.script.enNoName` / `frNoName`, EN and FR).

**Verifier round checks** (on the head named in the table; the shared local stack was serving the 6a checkout, so
e2e ran on the isolated copy: README deviation 12):

| Check | Result |
|---|---|
| `db-test.sh` (a copy on port 54347) | all nine suites pass, including the new `queue_attack` 5b; advisors: no ERROR (WARN `set_user_role`, accepted); exit 0 |
| Mutations (throwaway worktree at 511df9c, port 54348) | day4c 86 and 87 caught, day4b 65 caught; exit 0 (`mutations.md`) |
| `npm run lint` / `npm run typecheck` | exit 0 (the 2 existing TanStack Virtual warnings) / exit 0 |
| `npm run test:unit` | 341 passed, exit 0 |
| E2E Chromium (isolated stack, port 3200) | `queue.spec.ts` 12 passed (3 new), `tasks.spec.ts` 8 passed (1 new), `queue-multi.spec.ts` 1 passed, `day4-security.spec.ts` 9 passed; exit 0 |
| Without the fixes (fix taken out, app rebuilt) | `claims_end_cards_leave`, `lost_claim_quiet_swap`, `focus_never_drops_to_body` each failed; restored and passed |
| Screenshots | "work queue" screens test re-run: 70 shots, none failed; `queue-released` added (`screens/README.md`) |
| Speed (PERF=1, 4x CPU) | table below, "Verifier round" column |
| gitleaks (`origin/main..HEAD`, on 81d0728) | 28 commits scanned, no leaks found, exit 0 |
| `npm audit --omit=dev` | found 0 vulnerabilities, exit 0 |
| Head | code and tests final on 3b55c1b (db-test, unit 341, lint, typecheck re-run there); the commits after it change only `docs/` |
| Not run here | WebKit, Semgrep, `journey.spec.ts` (CI); the whole auth suite (only the affected specs above) |

## Review round 3 (12 Oct 2026): the verifier's round 2 and the 24 confirmed review findings

The verifier's round 2 said NOT READY with two new should-fix items and a nit (the speed-budget question stays with
Haider, Open risks). The review's 24 confirmed findings (`day4c-findings.json`; 9 and 14 are the same focus issue, 10
and 17 the same lead-picker issue) were fixed alongside. Each behavioural fix has a test that fails without it: the
database ones through mutation rows 88 to 92 (`mutations.md`), the unit ones by running them on the old files, the e2e
ones by building the app with this round's app files taken back to 7b3fa92 (the new toast hook kept, so the tests can
find the toast) and running the new tests on it.

| Finding | What changed | How it was checked |
|---|---|---|
| Verifier 1 (Done for now while a save is on its way: a hidden claim, or a jump to the empty state) and review 7 (Stop during an in-flight claim) | `use-queue.ts`: each run is a session (`sessionRef`, bumped by Start, Done for now, the claims ending and the page cache); every server call remembers its session; an answer for an earlier session never touches the cards, phase or summary, and lets the leads it claimed go (`release_claims`); a save started before Stop no longer claims; the phase is read from a ref set with the state (never a render behind) | e2e `stop_while_in_flight` (the outcome route held 1.5 s, then Done for now: no claim left, start screen kept; the last lead: no empty state; Start's own action held 1.5 s, then Done for now: no claim, no card) |
| Verifier 2 (U+237D in the English interface's French script) | `messages/en.json`: the three characters are U+202F | unit `messages.spec.ts`: no U+237D in either file, the scripts match across locales, French typography on en.json's French script |
| Verifier 3 (nit: second-tab wording) | Open risks reworded (the second tab's Start takes the first tab's live claims back; each tab's saves then delete the other's) | read |
| 1 (a claim renewed after its lead was reassigned) | Migration: the claim guard refuses renewing a claim on a lead the caller may no longer claim (42501 `scope`); `renew_claims` and `claim_next_lead`'s keep path let such a claim go first (the keep path also checks the queue scope), so `kept` leaves it out and the screen lets the card go | `queue_attack.sql` 9b (claim, reassign; a direct renewal is refused, the keep path drops it, `renew_claims` answers null, the new owner claims at once); mutation rows 88 to 91 caught |
| 2 (`claim_next_lead` deadlock when two admins' orders cross) | Migration: a lead's claim row changes only under that lead's advisory lock (lock order: the person, then the lead); the walk only tries it (`pg_try_advisory_xact_lock`) and skips a lead someone else is claiming; the caller's own claims (keep and reload paths, `renew_claims`, `release_claims`), `claim_lead` and `log_activity`'s release take it (several in lead id order); a lead deleted mid-claim is skipped too | `queue_concurrency.sh` case 11 (two admins with crossing follow-ups press Start together, 20 rounds: no failure, nothing held twice, at least 5 rounds really crossed; a held lead lock is skipped at once, under 1 s); mutation row 92 (no try-lock) caught with "deadlock detected"; case 9 now holds X with a raw claim row (no lead lock) |
| 3 (wrong-number task when the remaining number has no digits) | Already fixed in 881585a (log_activity step 7 uses the digit rule); the "dialled number is empty" check keeps `is null` (the lead page may still log a call on a digitless number; logging never depends on it) | `queue_attack.sql` 5b (main line "( )" plus a wrong contact: the task is made); mutation rows 86 and 87 caught again this round |
| 4 (U on the queue could undo a lead-page entry) | The queue's root carries `data-owns-undo` in every phase; the call panel's global U listener stands aside on such a page | e2e `undo_on_empty_screen and queue_owns_u` (a note logged on a lead page, G then Q, an outcome, U: the outcome is undone, the note stays) |
| 5 (U did nothing on the empty screen) and 8 (U right after a key undid the previous outcome) | U and Cmd/Ctrl+Z are handled on the empty state and the loading card; `undo()` targets the latest outcome pressed (`latestRef`): if it is still on its way, the undo job waits in the same chain for its save and then takes back that one, never the one before; `canUndo()` says whether there is one | e2e `undo_on_empty_screen…` (U on "Everyone due has been called." brings the lead back); `undo_latest_outcome` (A saved, B's save held 1.5 s, U at once: B comes back, A stays) |
| 6 (unsaved outcomes only in the rail) | The "1 outcome not saved · Retry" chip moved to the page header, shown in every phase; stored outcomes are retried on Start, on the error card's Retry and on the browser's `online` event; retries never claim a card | e2e `not_saved_in_every_phase` (every try fails on the last lead: the empty state shows the chip; Retry saves it once); screenshot `queue-not-saved` |
| 9 and 14 (focus dropped to `<body>`) | Round 2 fixed Start, Done for now, the empty state and Back to the start; now also: the restored card after Undo takes the focus (`advanced` on "undone"), the error card's Retry puts it on the title and then the first card, Cancel in a follow-up gives it to the heading; one polite live region stays mounted across phases (so "Logged … for …" is still read when the last card leaves); the empty state is no longer a `role=status` section holding buttons | e2e `undo_latest_outcome` and `undo_on_empty_screen…` (heading focused after U), `focus_never_drops_to_body` (round 2), `phone_followup_in_view` (Cancel: focus not on body) |
| 10 and 17 (picking a lead dropped the focus) | `lead-picker.tsx`: after a pick the chip's remove button takes the focus | e2e `lead_picker_focus` |
| 11 (a failed toggle left a filled check) | `task-row.tsx`: a row put back while fading out resets its check (`useIsPresent`), and the toggle's failure path resets it too | e2e `failed_toggle_reverts` (a second task keeps the list on screen; offline, then a refusal held 150 ms: the row is back with `aria-checked=false`, still so after the exit spring); fails on the old files |
| 12 (optimistic removal did not cancel refetches) | `removeTask` awaits `cancelQueries(["tasks"])` before the snapshot (as 4b's timeline); its three callers await it | unit `tasks-cache.spec.ts` (a read in flight lands after the removal: the row stays gone; fails without the cancel) |
| 13 (caches stale after queue outcomes and undo; time zone) | After a saved outcome or an undo: `refreshLead` (timeline, lead, lead tasks, leads list) and `refreshTasks`; saving the time zone invalidates `["tasks"]` | e2e `caches_after_outcome` (lead page, G then Q, Interested, back: the follow-up task and the entry show at once) |
| 15 (at 390 the follow-up and Do not contact question were off screen) | `queue-rail.tsx`: below 1024 the panel (`role=group`, named by the outcome) scrolls into view with a bottom scroll margin clear of the dock (smooth; instant with reduced motion) and takes the focus; at desktop width nothing moves | e2e `phone_followup_in_view` (Confirm and "Mark as do not contact" in view and not under the dock); screenshot `queue-followup-view` |
| 16 (Enter on a lead-less task's check completed it) | Enter on a check always calls `preventDefault`; it opens the lead when there is one | e2e `enter_on_task_without_lead` (Enter: still open; Space ticks it) |
| 18 (44 px lead link on phones) | Already fixed in 2d01de0 (tap area 10 px above and below) | e2e `phone_lead_link_target` passes again |
| 19 (each outcome announced twice; no "their time") | The "Logged" toast is shown but not read out (`quiet`: drawn outside the live region) unless it also says a card went to a teammate; the live message's next-lead time uses `Queue.theirTime`; the e2e toast helper finds the toast by `data-toast` | code review (web-design-guidelines addendum); e2e queue specs find the toast |
| 20 (queue skeleton 58 px short in French at 390) | `leads/queue/loading.tsx`: the intro, scope switch and lunch line carry their own words, invisible on grey bars (`box-decoration-break: clone`), so they wrap as the page does in either language | screenshots `leads-queue-skeleton-*` against `queue-start-*` |
| 21 (key hints broke between a key and its word) | No-break spaces inside each "key word" pair of `Queue.keysHint`, `Queue.confirmKeys`, `Tasks.keysHint` (EN and FR) | unit `messages.spec.ts` (no ordinary space inside a part) |
| 22 (the Tasks title count read as a bare number) | An sr-only sentence and a `title`: `Tasks.dueCount` ("5 tasks due today or overdue", FR plural) | unit `messages.spec.ts`; screenshots `tasks-*` |
| 23 (new tasks appeared with no entrance) | A task row added after the list first shows fades in and rises 8 px (`smooth`); reduced motion: the fade only; rows present at first draw do not move | visual (screens); no test can time an entrance reliably |
| 24 (no More screenshots in the 4c evidence) | `screens.spec.ts`: the route skeleton test also shoots More (EN light and FR dark, 390 and 1440); the app-shell test's `more-*` shots are kept here | `screens/README.md` |

**Review round 3 checks** (code final on 139a528; tests on 2aea16d: two e2e selectors in 4615c89, the stronger toggle test in 2aea16d):

| Check | Result |
|---|---|
| `db-test.sh` (a copy on port 54351) | re-run on the final code: all nine suites pass, including `queue_attack` 9b and `queue_concurrency` case 11; advisors: no ERROR (WARN `set_user_role`, accepted); exit 0 |
| Mutations (throwaway worktree at 68723f4, port 54352) | baseline passed; 34 rows (88 to 92 and every earlier row in a changed function): 29 caught, 5 documented two-layer rows, 0 not as listed; exit 0 |
| `npm run lint` / `npm run typecheck` | exit 0 (the 2 existing TanStack Virtual warnings) / exit 0 |
| `npm run test:unit` | 345 passed, exit 0 (4 new: three in `messages.spec.ts`, `tasks-cache.spec.ts`); the new ones fail on the old files (3 and 1 failed) |
| E2E Chromium, shared local stack (this worktree's `start.sh`, Next on 3100) | on 2aea16d: `tasks.spec.ts` and `queue.spec.ts` 29 passed (11 + 18; 3 and 6 new), exit 0; on 139a528: `queue-multi`, `day4-security`, `lead-page`, `shell`: 56 passed, 1 failed (the 4c CSP check waited for the empty state as a `role=status` section, which this round removed; its selector fixed in 4615c89, then 1 passed, exit 0) |
| Without the fixes (app files of 7b3fa92, rebuilt) | each new test run alone (`--grep`, a fresh server per run): `stop_while_in_flight`, `undo_latest_outcome`, `undo_on_empty_screen…`, `not_saved_in_every_phase`, `caches_after_outcome`, `phone_followup_in_view`, `lead_picker_focus` and `enter_on_task_without_lead` failed (exit 1 each). `failed_toggle_reverts` first passed there: alone in Today, its row left the list for the empty state and came back as a new row, which hid the bug. It now keeps a second task on the list and adds a refusal that arrives while the row fades out (request held 150 ms, then cut); on the old files it then failed (`aria-checked` "true"), on the fixed ones it passes (`tasks.spec.ts` re-run: see the E2E row). A first attempt ran while another checkout had restarted the shared stack (no Day 4c tables there) and was discarded |
| Screenshots | `screens.spec.ts` "app shell", "tasks page", "work queue", "route skeletons": 4 passed, exit 0 (a first run failed on the French Confirm name, "Confirmer", fixed in 4615c89); 54 kept shots replaced, 16 added (`screens/README.md`) |
| gitleaks / `npm audit --omit=dev` | gitleaks `origin/main..HEAD` on 2aea16d: 39 commits scanned, no leaks found, exit 0; gitleaks `dir` on `docs/evidence/day4c` and `docs/log.md` before the evidence commit: no leaks, exit 0 / `npm audit --omit=dev`: found 0 vulnerabilities, exit 0 |
| Not run here | WebKit, Semgrep, `journey.spec.ts` (CI); `day4-perf` and `day4-chunks` (PERF=1 only; the perf spec's toast hook changed to `data-toast`) |

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

| Measure | Server actions (33afb66's parent) | Route handlers, run 1 | run 2 | Verifier round, 3 runs (2d01de0, load 2.6–4.6) | Budget |
|---|---|---|---|---|---|
| Key to next card painted, p95 of 30 | 126 ms | 75 ms | 98 ms | 107 / 89 / 91 ms | 100 ms: met in 2 of 3 |
| Key to outcome saved, p95 of 30 | **616 ms** | 424 ms | 462 ms | 396 / 442 / 521 ms | recorded; over 400 ms triggered the D3 switch (applied) |
| Longest task during an advance | 97 ms | 73 ms | 112 ms | 71 / 103 / 58 ms | 50 ms: **missed** |
| Loading card shown in 10 keys pressed as fast as each card shows | 9 | 9 | 9 | 9 / 9 / 9 | at most 1: **missed** |

What was tried in the verifier round (each measured 3 times at 4x CPU, then left out because no gain showed through
the noise of this shared VM, whose load average went from 2.6 to 12 while other checkouts ran their tests):
- the card's lower part (contacts, notes, tasks, script) rendered a moment later with `useDeferredValue` (React can
  pause that render): longest task 66 / 134 / 81 ms (and 141–162 ms at load 11–12);
- no scroll when the new heading takes the focus on wide screens (the focus forced an 11 ms layout): 61 / 110 / 59 ms.
Where the time goes (Chrome's long-animation-frame entries over 15 advances, a scratch probe): React's render of the
new card (24–41 ms of script), Motion's frame loop for the slide (5–16 ms), the focus's layout (11 ms), then style,
layout and paint; no single script reaches 50 ms, the frame does. The 10-key burst cannot be met with one reserve
card: a key arrives every ~100 ms and one save-and-claim round trip takes ~300–450 ms here, so the reserve is empty
from the second key on. Key to saved is no budget (the D3 rule, already applied); it stays around 400–520 ms on this
VM with the `psql`-per-call REST stand-in.

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
    the 4d and 6b checkouts during this run. Cookies are not port-scoped, so every spec ran unchanged. The verifier
    round did the same (the shared stack was serving the 6a checkout).
13. **"Restart the queue" when the claims end means the start screen, not new claims at once** (verifier finding 1):
    the cards leave and the start screen says why, with Start focused (one ↩ to carry on). Claiming again by itself
    would let a laptop left open hold leads for ever (every 10 minutes a new claim), against design 5.4 ("a closed
    laptop holds at most 2 leads for at most 10 minutes"). An outcome key on a card that may no longer be held is not
    logged from the queue; the notice links to that lead's page, where the call is logged as usual (a claim never
    gates logging, design 5.4), so a long call is never lost.
14. **The lost-claim toast says "A teammate is on that one now"** without a name when the database's `kept` answer is
    what found it (the answer names no one); with the name ("Henri is on that one now") when the card was read again
    and `worked_by` names the teammate. The design's toast is "Henri is on that one. Here's the next."

## Not done here

- WebKit e2e (not installed here), Semgrep (blocked here), `journey.spec.ts` (needs Mailpit): CI.
- The advisor loop, `/security-review` and the PR: the lead builder's steps.

## Open risks

- **Queue speed budgets missed: Haider decides** (table above). The longest task during an advance is 58–112 ms at 4x
  CPU (budget 50); the 10-key burst shows the loading card on 9 keys of 10 (budget 1); key to saved is 396–521 ms
  (recorded only; the D3 switch it feeds is applied). At human pace (a call between keys) the reserve card is always
  ready and the next card paints in about 90 ms.

  **Question for Haider:** "The work queue misses two of its speed targets on our slowed-down test machine: a key
  press can keep the screen busy for up to about a tenth of a second (target: a twentieth), and if you press keys as
  fast as cards appear, a short loading card shows on most of them, because the next lead is fetched while you work.
  At normal pace, one call between keys, you will not see either. Do you accept this for now and let me look again in
  the Day 7 polish (my recommendation), or should I fix it before merging? Fixing the second one means holding two
  leads in reserve instead of one, so a laptop left open would hold three leads for up to 10 minutes instead of two."
- **A second tab of the same person:** its Start (`p_keep` null) takes the first tab's live claims back as its own
  cards (they are the same person's claims), and from then on each tab's saves keep only that tab's cards, so each
  deletes the other tab's claims (design 5.4: a claim call keeps only the cards its screen holds). The first tab's
  reserve card leaves at its next save (the `kept` check) and a card shown after 15 s is read again (`worked_by`), but
  an outcome key on its current card is still logged (a claim never gates logging), so the two tabs can show the same
  lead. Rare (one person, two queue tabs); the notice wording covers it ("or the queue was opened in another tab").
  (Wording corrected in review round 3: the earlier text said the second tab "ends" the first tab's claims.)
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
- **Playwright 1.64** (`/websites/playwright_dev`, verifier round): `page.clock.install()` before the page loads (time
  then flows), `clock.fastForward()` jumps ahead and fires due timers once ("closing the laptop lid"), used by
  `claims_end_cards_leave` and the `queue-released` shot.
- Not looked up (platform knowledge, noted): `fetch(..., { keepalive: true })` on `pagehide`, `PageTransitionEvent`
  `persisted`, cmdk's `commandScore` (read from `node_modules/cmdk/dist/command-score.js` to fix a palette match).
