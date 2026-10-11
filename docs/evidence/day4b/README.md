# Day 4b: the lead page (timeline, composer, call panel, outcomes, Undo), 11 Oct 2026

Design: `docs/evidence/day4/design.md` (sections 1, 2, 3.2, 3.5, 4.1, 5.1 to 5.3, 5.5, 6, 7.1 to 7.3, 7.7 to 7.10, 8,
10 "4b Lead page"). Local branch `day4b-local`, cut from PR #13's head (17d0354); `origin/main` with PR #13 as merged
(1004fa5) is merged in (2585163). Two parts: the database (build order items 1 to 3) and the app (items 4 to 8), then a
round on the verifier's 11 findings (speed, tests, evidence; see "Verifier round" below).

## What changed

**Database** (part 1; details in `docs/log.md`, `mutations.md`, `perf.md`)

- Zone map: `scripts/make-zone-map.mjs` with reviewed `scripts/zone-map.overrides.json` writes
  `src/lib/zone-map.generated.ts` and the zone-map block of the migration (parity: `tests/unit/zone-map.spec.ts`).
- Migration `supabase/migrations/20261012090000_lead_page.sql`: zone functions; `companies.timezone`,
  `next_action_at`, `phone_wrong_at` and `contacts.phone_wrong_at` with `lead_guard` and `contact_guard`; audit
  exclusions; `private.activity_undo`; the undo branches of the activity and task delete policies; `bulk_update_leads`
  with "Until when?"; `next_working_day`, `call_attempts`; the RPCs `get_lead` (extended), `list_lead_activities`,
  `get_activity`, `log_activity`, `undo_activity`, `edit_activity`, `delete_activity`, `set_lead_timezone`,
  `set_lead_next_action`, `create_task`, `set_task_done`, `set_task_cancelled`, `list_lead_tasks` (all SECURITY INVOKER,
  static SQL, revoked from anon).
- Tests: `supabase/tests/outcome_attack.sql` and `outcome_concurrency.sh` (in `db-test.sh` and `db.yml`); mutations
  (90 of 90 after the merge); perf part 2 (P1, P4, P4b).
- After the merge of `main` (Day 4a's review changed the insert lock to take the entry's contact FOR KEY SHARE, then
  the lead): `log_activity` now takes a contact it names but does not mark FOR KEY SHARE **before** the lead, so it
  keeps the contact-then-lead order (without it a wrong number on that contact and the call deadlocked:
  `outcome_concurrency.sh` case 4 reproduced it); and `private.lock_activity_lead` is redefined (the Day 4a advisor's
  carry-over): a signed-in session without two-factor, or naming a lead or a contact outside its organisation, locks
  nothing, since its insert is refused anyway (case 5). Mutation rows 87 to 90.

**App** (part 2)

- **Libraries with unit specs.** `src/lib/phone.ts` (`dialString`, `callHref`, `whatsappHref`: about 80 markets, trunk
  0 dropped or kept per country, "(0)", 00 and 011 prefixes, NANP); `mailtoHref` in `src/lib/leads.ts` (encoded parts,
  no line break in the subject, CRLF body cut at 1,500 characters); `src/lib/timezones.ts` (calling zone, span ends,
  calling hours with the lunch switch, next opening, next working day, wall-clock helpers that read clock-change gaps
  and overlaps as PostgreSQL does); `src/lib/activities.ts` (kinds, outcomes in pad order, follow-up rules, outcome keys
  by `event.code`, Zod strictObject requests); `src/lib/tasks.ts` (kinds, task requests, date chips in the viewer's
  zone, overdue); `src/lib/db-errors.ts` (SQLSTATE and hint to app codes, including 4a's `task_kind`, `task_due`,
  `not_editable`, `rate_limited`, `body_*`); `src/lib/drafts.ts`.
- **Server actions and routes.** `src/app/(app)/leads/[id]/actions.ts`: `logActivity`, `undoActivity`, `editActivity`,
  `deleteActivity`, `setLeadTimezone`, `setNextAction`, `createTask`, `setTaskDone`, `setTaskCancelled` (Zod
  strictObject, `requireSession()`, one RPC with named arguments, codes only). `setLeadsStatus` takes the Cool off
  return date. `GET /api/leads/[id]/activities` (keyset pages of 30, both cursor parts or 400, `no-store`),
  `GET /api/leads/[id]/tasks`, `GET /api/activities/[id]` (Show more).
- **The lead page** `/leads/[id]` (page, `loading.tsx` skeleton block for block, a not-found with Back to leads):
  - header: name, status menu (Cool off asks "Until when?"), owner menu for managers and admins, city · country ·
    the lead's local time ("good time to call" or "outside calling hours · opens 09:00 (in 50 min)"; a span shows its
    range, "time zone not set" and Set time zone; both clocks when the viewer's zone differs), next call, last call,
    tries in a row;
  - quick actions: Call (red, opens the call panel), WhatsApp (`wa.me` from `dialString`, or the "add the country
    code" hint), Email (mail app, or a menu of the addresses), Meeting, Note; a one-tap "Log email" / "Log WhatsApp
    message" chip; hints for missing channels; a Do not contact lead shows a banner instead;
  - WAI-ARIA tabs (`src/components/ui/tabs.tsx`, Motion `layoutId` pill; each panel in a React Activity boundary,
    deviation 17): Summary (Next step with the open tasks and
    the next call attempt, contacts on phones, the latest three entries, the deals placeholder), Timeline, Deals and
    Stock ("nothing yet"), Details (the lead form, the time zone from the closed list, the next call date, the import
    for admins, contacts on phones); Files hidden until 4d (D16); `?tab=` and `?filter=` in the URL;
  - timeline: 30 a page with an observer and a Show older button, day groups in the viewer's zone, text only
    (`dir="auto"`, never HTML, never auto-linked), 6-line clamp with Show more, filters, edit by the author ("Edited"),
    Undo for 2 minutes, delete after a confirmation and a fresh code (`useStepUp`), managers and admins may delete others'
    entries; up to 120 loaded entries `content-visibility: auto` per row, past 120 a feed virtualised with TanStack
    Virtual (design D13's fallback, deviation 16);
  - composer (`src/components/ui/textarea.tsx`; the rail from 1024, a sheet below): note, call (the shared outcome
    pad), email (opens the mail app with the encoded link, then logs `email · sent` with the subject), WhatsApp, meeting
    (book with a date and a time, held, no-show), follow-up chips with both clocks, Cmd/Ctrl+Enter, the reason Save
    cannot run, a draft per lead (cleared on save and on the sign-in page), offline keeps the text;
  - the call panel (`CallPanelProvider` in `src/app/(app)/layout.tsx`): survives navigation; timer; End call; outcome
    keys 1 to 7 and 0 by key position; the follow-up picker; Esc gives "Call not logged · Log it"; drag down to close;
    "How did it go? · Away about 3 min" after the phone app; Undo in a 10-second toast; U or Cmd/Ctrl+Z within 2 minutes.
- **Leads list.** The preview gains Open lead (and O), its Call opens the call panel, its status menu asks "Until
  when?"; rows prefetch the lead, its first timeline page and the route after a 120 ms hover; below desktop width a tap
  opens the lead page; Back restores the list URL and scroll; J and K walk the list from the lead page ("3 of 60").
- **Messages** EN and FR for LeadPage, QuickActions, CallPanel, Composer, Outcomes, Timeline, Errors, Leads.until,
  Shortcuts (an "On a lead" section) and StepUp.bodyDelete; French typography checked by `messages.spec.ts`.
- **Tests.** Unit: `phone`, `call-window` (61 cases, written to be shared with 4c's SQL, plus the jump walk checked
  against the 15-minute walk around every 2026 clock change), `next-working-day` (the SQL
  test's own cases), `activities`, `outcome-keys`, `tasks`, `db-errors`, `day4-parity`, `messages` (new namespaces).
  E2E: `tests/auth/lead-page.spec.ts` (Chromium and WebKit), `tests/auth/day4-security.spec.ts` (4b scope), lead page
  shots in `tests/auth/screens.spec.ts`, `tests/auth/day4-perf.spec.ts` and `tests/auth/day4-chunks.spec.ts` (PERF=1
  only); the Day 3b import spec's `openImport()` waits for the page's requests in flight before navigating again (WebKit
  flake, deviation 15, unproven until CI).

## Check results

### Final checks on the PR head (after the review round)

Code checks on **f2c900b** (all 22 review fixes merged), then the audit fixes on **bad93a9** (focus after Try again
and toast Undo, the skeleton's fourth header line, "Call not logged" read with Log it, a no-break space before the
queued line's dot); local auth stack restarted for this checkout with the final migrations, 11 Oct 2026, night.

| Check | Result |
|---|---|
| `bash scripts/db-test.sh` (f2c900b) | all 7 suites pass: rls_attack, import_attack, import_concurrency, activity_attack, activity_concurrency, outcome_attack (new blocks 6b and 6c), outcome_concurrency; advisors: no ERROR-level findings (WARN `set_user_role`, accepted; INFO `unindexed_foreign_keys` 2, `unused_index` 2); exit 0 |
| Mutations (`mutations.md`) | Day 4b: **94 of 94 caught, 0 not as listed** on f2c900b (the whole set, run once on the final migration in a throwaway worktree after a passing baseline; ~75 min). Day 4a and Day 3b: every row's anchor found exactly once on f2c900b (104 and 37 rows), so their last full results stand (Day 4a on c4fb0b9: 102 caught, 2 documented two-layer rows; Day 3b: 36 caught, 1 documented two-layer row) |
| `npm run lint` | exit 0: 0 errors, the 2 existing React Compiler warnings |
| `npm run typecheck` | exit 0 |
| `npm run test:unit` | 321 passed |
| Playwright, local auth stack, Chromium, the whole auth suite (f2c900b) | **85 passed, 3 skipped** (PERF-only and engine-only), 21.7 min. One failure: `journey.spec.ts` "invite, password, two-factor setup" stops at `MAILPIT_URL is not set` (the local stack has no Mailpit; CI has it and passes it), and its 4 dependent tests did not run |
| Playwright, `lead-page.spec.ts` after the audit fixes (bad93a9) | **26 passed** on 8108844 (the app code of bad93a9; b3d0f47 and 8108844 change only tests): includes the two new focus checks (Try again, keyboard toast Undo); the owner menu test now picks the checked owner, since this reused local stack holds several people with the same made-up name |
| `/security-review` (f2c900b) | **no findings** (`security-review.md`, section "`/security-review` on f2c900b") |
| gitleaks (`origin/main..f2c900b`) | 81 commits scanned (git counts 88 with merge commits), no leaks found, exit 0 |
| `npm audit --omit=dev` | found 0 vulnerabilities. Full `npm audit`: the 5 known high advisories in dev-only lint tooling (`braces`/`micromatch` via `eslint-config-next`, GHSA-vfj7-8cjw-p6xm), logged on 9 Oct, not shipped |
| CI on f2c900b (run 38173336731 and its siblings) | all 7 green: quality, semgrep, gitleaks `scan`, `rls` (with the outcome suites), auth-journey **chromium** (incl. `journey.spec.ts` with Mailpit) and **webkit**, Vercel preview |
| Screenshots (`screens/README.md`) | taken again on f2c900b: 173 shots (103 lead page), no console error or sideways scroll; 49 kept (30 replaced, 19 new review-round states); the skeleton shots re-taken on bad93a9 after its fourth header line |
| Apple design audit / Web Interface Guidelines | re-run on the review-round changes (dated sections in both files); the false "every phone control is 44 px" claim corrected; their new nits fixed in bad93a9 or kept for Day 7 (below) |

### Earlier checks (before the review round)

Code checks on commit **434522c** (the last code commit before the chunk spec 08ba920, which only adds a PERF-only
test; the commits after that change only `docs/`), local auth stack restarted for this worktree with the merged
migrations, 11 Oct 2026, evening.

| Check | Result |
|---|---|
| `bash scripts/db-test.sh` | rls_attack, import_attack, import_concurrency, activity_attack, activity_concurrency (new from `main`), outcome_attack and outcome_concurrency (new cases 4 and 5) all pass; advisors: no ERROR-level findings (WARN `set_user_role`, accepted; INFO `unindexed_foreign_keys` 2, `unused_index` 2); exit 0 |
| Mutations (`mutations.md`, throwaway worktree) | Day 4b **90 of 90** caught (c4fb0b9; row 90 on 8d4ff18); Day 4a as merged: 102 caught, 2 documented two-layer rows (96, 100), 0 not as listed; Day 3b: 36 caught, 1 documented two-layer row (4) |
| Perf, database (`perf.md`, one run on 08ba920) | P1 2.44–2.72 ms (8 / 12), P4 8.26–8.41 ms (15), P4b 5.74–5.84 ms (15), P2 0.44–0.49 ms (5 / 8 / 10) |
| `npm run lint` | exit 0: 0 errors, 2 warnings (the existing React Compiler notes on TanStack Virtual in the import check step and the leads table) |
| `npm run typecheck` | exit 0 |
| `npm run test:unit` | 321 passed, exit 0 |
| Playwright, signed out (`playwright.config.ts`) | 20 passed, exit 0 |
| Playwright, local auth stack, Chromium, every auth suite except `journey.spec.ts` and `screens.spec.ts` (`--grep-invert "screens\|journey"`) | 64 passed, 2 skipped (`day4-perf` and `import-perf` need PERF=1), exit 0 (8.2 min), on 434522c; includes the new `timeline_virtualised_past_120`, the close-with-outcome case in `call_panel_each_outcome`, `cross_site_action_refused` with its positive replay, and `import` with the flake fix |
| Screenshots | taken again on the code of 08ba920: the 84 lead page shots (plus the leads and shortcuts tests), no console error or sideways scroll; the kept set in `screens/` replaced |
| Lead page speed (`day4-perf.spec.ts`, PERF=1, Chromium, 4x CPU, timed inside the page, 3 runs per invocation, two invocations on 434522c) | see the table below: LCP and CLS met (LCP missed once, on the first page after the server started); tab switch, route change and the 1,000-entry scroll **missed** (Open risks) |
| Route chunk (`day4-chunks.spec.ts`, PERF=1) | **28.5 KB gzip** over the app shell (2 files; shell 339.8 KB, lead page 366.8 KB): within the 60 KB budget. Method: the JavaScript a deep link to a lead loads minus what `/more` loads, gzip -9 from `.next`. Same method on the previous head 13fea94: 19.4 KB; on `main` (1004fa5) the shell is 334.1 KB, so the lead page is 32.7 KB over `main`'s shell. The earlier "79 KB" had no recorded method and could not be reproduced |
| gitleaks (`origin/main..08ba920`) | 35 commits scanned (git counts 36 with the merge commit), no leaks found, exit 0. The previous figures were 22 commits at 509e6ab and 24 at 13fea94 |
| `npm audit --omit=dev` | found 0 vulnerabilities, exit 0 |
| Apple design audit / Web Interface Guidelines | `apple-design-audit.md`, `web-design-guidelines.md` (unresolved: none; one claim corrected) |
| Security review | `security-review.md`: threat rows 1 to 12, 15 (undo records), 16, 18, 19, 26 to 30, 32, 33 re-checked with their tests; residual risks |
| Semgrep | not run locally (semgrep.dev is blocked here); CI's `semgrep` job |
| WebKit e2e | not installed here; CI's auth-journey (webkit) runs `lead-page.spec.ts` and `import.spec.ts` |

**Lead page speed** (design 8.6; 4x CPU slow-down on this 4-vCPU cloud VM; each value one run; invocation A then B):

| Measure | A (3 runs) | B (3 runs) | Budget | |
|---|---|---|---|---|
| Cold deep link LCP | 2,288 / 1,220 / 1,008 ms | 556 / 1,264 / 676 ms | 2,000 ms | met, except A's first run (the first page served after `next start`) |
| CLS | 0.004 / 0.049 / 0.049 | 0.049 / 0.049 / 0.049 | 0.05 | met, only just |
| Tab switch, Summary to Timeline | 105 / 155 / 133 ms | 136 / 152 / 118 ms | 100 ms | **missed** (was 691–938 ms by the same in-page method before this round) |
| Route change from the list after hover prefetch | 334 / 262 / 231 ms | 274 / 226 / 209 ms | 200 ms | **missed** (was 463–578 ms) |
| 1,000-entry timeline scroll, frame p50 | 31.4 / 28.3 / 27.6 ms | 30.2 / 25.9 / 24.5 ms | 16.7 ms | **missed** (was 80.5 ms; 60 fps not reached) |
| same, frame p95 | 52.2 / 43.9 / 45.5 ms | 46.8 / 43.7 / 40.4 ms | 20 ms | **missed** (was 115.3 ms) |
| Longest task while scrolling | 69 / 68 / 56 ms | 128 / 114 / 91 ms | (recorded) | |

How the misses were worked on (profiles with source maps, Chrome traces): the 6-line clamp read `scrollHeight` per entry
(a forced layout each: 428 ms of the old tab switch); every reveal drew all entries again because each part kept its own
clock; Radix menus and Motion on every entry; the Summary-to-Timeline switch drew the whole page again; Motion measured
the tab pill in the click's frame; Playwright's trace ran inside the old timings; the route change ran the page's code,
parsed its ICU messages and walked calling hours 15 minutes at a time on the click. What is left is mostly the browser's
own style, layout and paint at 4x CPU (roughly half of the remaining tab switch in the Chrome trace, and most of each
scroll frame).

## Review round and PR #14 CI fixes (11 Oct 2026, night)

**Review workflow** (four lenses: security, database, app, design; a skeptic per finding): 23 findings. Security: none.
22 confirmed, 1 refuted (a wrong-number mark lands on the number stored at save time, not the one dialled: the skeptic
judged it a limit of the approved design, not a defect; kept). The 22 were fixed in five worktrees split by file, each
checked by an independent verifier (two rounds where it asked), then merged:

| Group | Findings | Commits |
|---|---|---|
| a, database | 1 (undo into Cool off kept the date it should restore) | eb2b2f2, fd6be15, 8d53300, f81e535, 59ded10, 44d90e6, 5d6bac1 |
| b, call panel | 3 (second Call dropped an unsaved call), 14 (FR heading), 15 (focus on close), 23 (timer label), plus the verifier's queued-status announcement | 5b308f7, ba0e7ef, ff36402, 89e99eb, 019b49f, e1e068a, 77817a7 |
| c, timeline | 4 (older page error, no retry loop), 6 (day group keys), 10 (Show more failure), 17 (edit focus) | b91486b, 0b3bb5e, c720cc3, 569e094 |
| d, composer and page | 7, 9 (phone quick actions, Meeting focus and 10:00), 12, 13 (Do not contact), 18 (skeleton at 1024/1280), 19 (44 px phone targets) | 851555b, 6cf80d8, 5a04098, ae43dc0, bd48cdb, e0007be, 795cb88, 91cc2d6, 6682a8e, 69d29ea |
| e, cards, header, pad, i18n | 5 (Details next call), 8 (task Undo answer), 11 (same owner), 16 (task check focus), 20 (56 px pad keys), 21 (locale counters), 22 (French calling hours) | 754bacc, a25d5c7, 4aa77ed, 6ebd4d4, ff653a4, 433648a, 5974aa8 |

New e2e tests in `tests/auth/lead-page.spec.ts` (from b91486b, 0b3bb5e, c720cc3, 569e094, 89e99eb, e1e068a, 795cb88,
69d29ea, 5974aa8): the older-page error waits for Try again; an open edit survives a new entry; Show more failure;
edit focus; a second Call waits and keys during the exit do not log twice; Do not contact logs at 1440, 768 and 390
without Email or WhatsApp; Meeting focus and the phone draft; 44 px phone targets; task check focus, refused task Undo,
same owner, next call after an outcome, opening on another day, 56 px pad keys. `outcome_attack.sql` blocks 6b and 6c
and the section 12 bounds cases; mutation rows 91 to 94.

**Audit fixes after the review round** (bad93a9; from the re-run Apple and web-guidelines audits): a successful Try
again (timeline, older page, Recent card, Next step card) moves the focus into the timeline or to the card title instead
of the top of the page (`src/lib/focus.ts`); a toast action pressed from the keyboard returns the focus to where it was
(`toast.tsx`); the skeleton has the page's fourth header line (no 19 px drop); "Call not logged" is read with Log it
(`aria-describedby`); a no-break space keeps the queued line's dot off the start of a row. Two e2e checks added (focus
after Try again; focus after a keyboard Undo).

**PR #14 CI fixes** (before the review round; docs/log.md): (1) the Casablanca calling-hours unit case moved to an
instant open under either Morocco offset (CI's ICU time zone data differs); (2) the timeline virtualizer measures rows
on the next frame (`useAnimationFrameWithResizeObserver`), after WebKit reported "ResizeObserver loop completed with
undelivered notifications"; (3) `settled()` in `tests/auth/helpers.ts` lets in-flight requests finish before a test
leaves a page (shared with the import tests); (4) **an accepted relaxation of the clean-console rule, test-only:**
`isCancelledPrefetch()` in `tests/auth/helpers.ts`, used only by `lead-page.spec.ts`, ignores exactly
`^(?:Fetch API cannot load )?(?:http:)?//?localhost:3100/[^\s?]*\?_rsc=[\w-]+ due to access control checks\.$`:
WebKit's wording for a fetch the page itself cancelled, here Next.js cancelling its own same-origin RSC link prefetches
when a server action refreshes the page (Chromium logs nothing). Every other console error still fails. CI WebKit
passed with it on 390e267 and f2c900b.

**Kept for Day 7 polish** (logged): a Call pressed while the open call is still "Calling" replaces it; the focus
fallback sets `tabindex=-1` and no outline on `<main>`, the skip link's target; the phone call sheet does not trap focus
and can cover a control reached with Tab (a `scroll-padding-bottom` rule); at 390 in French the fifth tab ("Détails") is
cut at the edge of the scrolling tab strip with no fade.

## Docs used

Context7 pages consulted before coding (the builder's lookups, design 8.7):
- **Next.js 16**: dynamic `params` promises in pages and route handlers, `loading.tsx`, `notFound`,
  `useRouter().prefetch`.
- **TanStack Query v5**: infinite queries with `initialData`, `prefetchInfiniteQuery`, optimistic
  `setQueryData` and rollback.
- **Motion**: `layoutId` with `LayoutGroup`, `AnimatePresence`, drag and `onDragEnd` velocity,
  reduced motion.
- **next-intl 4.14**: `useFormatter` `dateTime` with a per-call `timeZone`, `relativeTime` with
  `now`, `useNow`.
- **Playwright** (`/websites/playwright_dev`, class Page): `page.waitForLoadState`: "If the state has been already
  reached while loading current document, the method resolves immediately", and `networkidle` is discouraged; so the
  import flake fix counts the page's own requests (`request` / `requestfinished` / `requestfailed`) instead.

Verifier round (looked up by this builder in Context7):
- **TanStack Virtual** (`/tanstack/virtual`): `docs/api/virtualizer.md` (`measureElement` with `data-index`,
  `scrollMargin` for a window virtualiser with content above the list, `rangeExtractor`, `getItemKey`),
  `docs/introduction.md` (the basic React example), `docs/chat.md` (dynamic heights with transforms), the React
  Compiler e2e note on `directDomUpdates` (issue #736); the installed 3.14.13 typings for `useWindowVirtualizer`,
  `directDomUpdates` and `directDomUpdatesMode`.
- **Next.js 16.2** (`/vercel/next.js/v16.2.9`): `docs/01-app/03-api-reference/02-components/link.mdx` (`prefetch`:
  `null`/auto prefetches a dynamic route down to `loading.js`, `true` prefetches it in full),
  `docs/01-app/02-guides/prefetching.mdx` (hover-triggered prefetching), `use-router.mdx` (`router.prefetch` options),
  `staleTimes.mdx` (a full prefetch is kept 5 minutes); the installed 16.4.0 `prefetch.js` (`router.prefetch` defaults
  to the partial kind, so Open lead uses `<Link prefetch>`).
- **React** (`/reactjs/react.dev`): `reference/react/Activity.md` (hidden boundaries pre-render at a lower priority
  without their Effects, `display: none`, state kept; tabs as the example).
- **next-intl 4.14** (`/amannn/next-intl/v4.14.7`): `docs/usage/plugin.mdx` and RFC 002 (experimental
  `messages.precompile`; `t.raw` not supported).

## Deviations from the design

Database part (each tested and covered by a mutation; `docs/log.md`, 11 Oct): zone offsets from the system tzdata, not
Node's ICU; single-zone countries need no override; the Indonesia span written east first; Chile offers Punta_Arenas;
no calling zone for Antarctica and the US minor islands (Europe/Paris); two extra generated helpers; the Cool off
default also when the date is in the past; follow-up dates bounded by "today anywhere on earth" to a year ahead;
non-call entries take an optional follow-up; Wrong number needs `p_dialled` and the task title up front; Do not contact
completes the caller's due call tasks first; undo restores marks and tasks only while they carry the entry's own time,
consumes its record with DELETE … RETURNING, and records can be written only for one's own entry; `contact_guard` is
BEFORE UPDATE only; `get_lead` works out the caller's zone once; the outcome concurrency cases are a 4b script;
`activity_attack.sql` section 11 ages its entries first; `p_from_queue` acts from 4c.

App part:
1. **Next step lists the open tasks, up to 20** (then the next call attempt); with more it says "Showing the first 20
   open tasks." (the list asks for 21). The design had a Next step card in Summary and a "next task" card in the rail,
   which showed the same task twice on every lead with one task; the rail keeps the composer and the contacts.
2. **"14:05 local time"** instead of "14:05 in Lyon": the city and country start the same line. A span reads
   "02:00–05:00 local time · time zone not set · Set time zone".
3. **24-hour times in both languages**, as in the design's examples (English Intl defaults to "2:05 PM").
4. **The actions sit beside the header from 1280** and under it below (at 1024 they squeezed the header).
5. **The lead's name travels with `logActivity`** only to word the follow-up task's title, which the server writes from
   the messages in the caller's language ("Follow up with {lead}"). A task title is text anyone may type, so it carries
   no authority, and it saves a second database call per outcome.
6. **Two more routes**: `GET /api/activities/[id]` for Show more and `GET /api/leads/[id]/tasks` for the tasks.
7. **The timeline filter is in the URL** (`?filter=`) like the tab (Web Interface Guidelines).
8. **Below desktop width a tap opens the lead page** (design 7.1). Day 3a's phone e2e test ("the lead full screen
   with a way back") now checks that page and its Back link; no other existing test changed.
9. **Drafts are cleared on the sign-in page**, so unsent note text does not stay in a shared browser.
10. **Details draws the lead form and zone names after hydration**: Node's and Chromium's Intl data word some country
    and zone names differently, which made React report hydration error 418.
11. **`z.config({ jitless: true })` in the browser**: Zod 4 probes `Function("")` once; our CSP has no
    `unsafe-eval`, so the browser reported a `script-src` violation (found by `day4-security`'s CSP check).
12. **No call-planning chips on a Do not contact lead.** French "Save" is "Enregistrer" (the long form wrapped in the
    button).
13. **A missing lead returns the not-found screen with HTTP 200**: the page streams behind its loading skeleton, so
    Next.js has sent the status before `notFound()` runs (the screen and its words are the same for missing, not
    visible and malformed ids).

14. **Closing the call panel before Save always asks first**, also when an outcome is already picked: the first close
    (✕, Esc or a drag down) shows "Call not logged · Log it" with the outcome and note kept; a second close or Don't log
    ends it (design 7.3 only names the case without an outcome; closing with one picked used to drop the call silently).
15. **Day 3b import e2e flake (WebKit)**: `openImport()` in `tests/auth/import.spec.ts` now waits until the page has no
    request in flight before it navigates again, so a Past-imports refresh (server action POST) is not cut off (WebKit
    logs "Fetch API cannot load … due to access control checks" for a cut-off fetch). The suggested
    `waitForLoadState("networkidle")` was not used: it resolves at once once the document has reached that state
    (Playwright docs), so it cannot wait for a later request. The console-error check is unchanged. **Proven in CI:**
    auth-journey (webkit) passed `import.spec.ts` on 390e267 (run 38169762862) and on f2c900b; the helper is now
    `settled()` in `tests/auth/helpers.ts`, shared with the lead page tests. The request tracking starts at the first `openImport()`, which
    holds because every test calls it on a fresh page.
16. **The timeline is virtualised past 120 loaded entries** (D13's fallback, since the 1,000-entry scroll missed 60
    fps): a `role="feed"` of articles with `aria-posinset` / `aria-setsize` (-1 while older pages remain), a day heading
    row where the day changes, rows measured and positioned by TanStack Virtual against the window. Up to 120 the whole
    list stays in the page (content-visibility), so the find bar and reading order are as before for ordinary leads.
    Past 120 the find bar sees only the rows near the window, and Tab moves through the drawn rows then on to "Show
    older"/the end text; screen readers get each article's position in the whole list. Rows being edited or asking to
    delete stay drawn when scrolled away; what Show more opened is remembered.
17. **Tab panels are React Activity boundaries**: every panel is in the page, the hidden ones drawn in the background
    (no Effects, `display: none`), so a tab switch reveals a ready panel and a panel keeps its state when the reader
    comes back. The design only said tabs draw from cached data.
18. **next-intl message precompilation** (`experimental.messages.precompile`, next-intl 4.14): messages are compiled at
    build time instead of parsed in the browser on first use. Experimental in the library; `t.raw` is not used anywhere.
19. **The entry menu is a plain button until pressed** (it becomes the Radix menu, opened, on a press or Enter, Space or
    Down), and the delete dialog mounts the first time it is asked for: a Radix menu and dialog per entry cost the tab
    switch and the scroll. Motion animates only a just-logged entry.
20. **The tab pill moves one frame after the panel shows** (Motion measured it in the click's frame, which doubled the
    layout work).
21. **The speed spec times inside the page** (performance.now() before a DOM click, a MutationObserver, then the painted
    frame), runs each measure 3 times, asserts every design 8.6 budget with `expect.soft`, and turns Playwright's trace
    off for that spec (its DOM snapshots ran inside the old timings).
22. **The client's text rule refuses C1 controls** (U+0080 to U+009F), as Day 4a's CHECK does since its review
    (`day4-parity` failed after the merge until it did).

## Not done here

- 4c: "Henri is on this lead", the queue, the Tasks page, the profile zone (`caller_zone()` reads the profile already);
  4d: Files (hidden, D16).
- WebKit e2e (not installed here), Semgrep (blocked), `journey.spec.ts` (needs Mailpit): CI.
- The design's browser speed budgets for the queue (4c). The lead page's are measured locally (PERF=1, speed table
  above), not in CI; three of them are missed (Open risks).
- (Done since: `/security-review` ran on f2c900b, no findings; the advisor loop runs on the PR.)

## Open risks

- **Lead page speed budgets missed: Haider accepted them as the baseline on 11 Oct 2026** ("Accept baseline, merge",
  docs/log.md); the PERF spec guards against regressions and the budgets are revisited in Day 7 (CI hardware or
  Haider's Mac). The numbers: On this 4-vCPU cloud VM at 4x CPU slow-down, timed
  inside the page, 6 runs over two invocations on 434522c: tab switch **105–155 ms** (budget 100 ms), route change after
  the hover prefetch **209–334 ms** (200 ms), 1,000-entry timeline frame p50 **24.5–31.4 ms** and p95 **40.4–52.2 ms**
  (60 fps: 16.7 ms; the spec reads 60 fps as p50 ≤ 16.7 ms and p95 ≤ 20 ms). Each is 2 to 6 times faster than before
  this round, and D13's fallback (TanStack Virtual) is in. What is left is mostly the browser's style, layout and paint
  at 4x CPU. Haider chose option (a) of three (accept as the baseline; keep working; relax the budgets for 4x CPU).
- **LCP and CLS pass narrowly**: CLS 0.049 on most runs (a shift when the header's local time and the relative times
  appear after hydration); one LCP of 2,288 ms on the first page served after `next start`.
- **next-intl precompilation is experimental** in the library; a library update could change its output. The e2e suites
  (EN and FR) and the French screenshots pass with it.
- **Virtualised timelines (past 120 entries)**: the browser's find bar only sees rows near the window (deviation 16).
- (Closed: the WebKit import flake fix passed CI's WebKit run on 390e267 and f2c900b; deviation 15.)
- **tzdata differences** between PostgreSQL, Node (server render) and browsers: western Canada from November 2026 is a
  live case; parity tests use fixed instants. Times that depend on the viewer render after mount.
- **CI's Postgres 17 image** may lack a zone of the map (`zone_map_zones_exist` fails visibly); the 4a role behaviours
  (SET ROLE in temp functions, trigger disabling as owner) are proved only in CI.
- **Drafts** live in this browser's storage until saved, cleared on the sign-in page, or pushed out by the 50 most
  recent; a device left signed in keeps them.
- **The call timer and "away about N min"** are shown only, never stored (design section 12).
- **Server actions run one at a time per client** (Next.js): a slow save holds the next one; the queue's single
  combined action is 4c's answer (D3).
- **Accepted:** splinter INFO for the unindexed `activity_undo_org_id_fkey`; flood guards count per transaction snapshot.
- **Merged, not rebased:** `origin/main` (1004fa5) is merged into this branch (2585163) with its conflicts resolved
  (`db.yml`, `db-test.sh`, `db-mutations.py`, `docs/log.md`); the PR will show the merge commit.
