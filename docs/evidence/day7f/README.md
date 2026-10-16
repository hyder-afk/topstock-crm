# Day 7f: advisor follow-ups (time-zone test, ArrivalFocus, held deals, share.spec port, share_take Paris day)

Built 16 Oct 2026 by the builder on local branch `day7f-local` (worktree `/home/user/topstock-crm-7f`), from
`day7b-local` 0e895b5 (Day 6 + Day 7a + Day 7b). Not pushed, no PR. Small, self-contained fixes the advisor asked for in
earlier reviews, then the advisor's round on Day 7f itself (CHANGES NEEDED on bb66dd1: this evidence bundle, and the
time-zone test's superseding keyed on the full signature).

## What changed, and why

| # | What | Why | Commit |
|---|---|---|---|
| 1 | `tests/unit/sql-timezone.spec.ts`: fails when a migration takes a date or time of day in the session's zone (`current_date`, `current_time`, `localtime`, `localtimestamp`; an instant cast to date/time/timestamp or passed to `to_char`, `date`, `extract`/`date_part` other than epoch, or two-argument `date_trunc` at hour or coarser, without `at time zone`), outside comments and strings. Findings in a function that a later migration redefines with the **same name and argument types** are superseded; the live ones in applied migrations are allowlisted with a reason (task_guard's and expected_close's years-wide bounds, `date_trunc('week', p.transit_eta)` on a date) | The DB tests run on `PGTZ=Europe/Paris` and production sessions on UTC; a day computed in the session's zone once broke CI (log row of 15 Oct) | 375139f, 453045c, 4e26727 |
| 2 | `ArrivalFocus` (`src/components/shell/arrival-focus.tsx`): the 1.5 s loop stops on the first pointerdown or keydown; the pending target clears only when the window ends; Strict Mode's remount resumes the same window; `<main>` still counts as free | It must never move the focus after the person acts | 9689679 |
| 3 | Reopen and Delete left out where the database would refuse them: `get_deal` gains `stock_held` (definer `private.deal_held_by_stock`) and `delete_until` (migration `20261022120000_deal_sheet_actions.sql`, read-only); the sheet shows the reason where Reopen was, with a link to the lead's Stock tab, and its stepper is off; the sheet's, the card's and the lead row's menus drop Reopen/Delete; the creator's Delete goes after 120 s | Decision row of 15 Oct ("hiding them when held is a Day 7 follow-up"); Day 5 design line 1070; plan item 20's 120 s note. The server checks are unchanged | 6b92a87, this round |
| 4 | `share.spec` and both Playwright configs read the base URL (`PLAYWRIGHT_BASE_URL`, default `http://localhost:3100`) | A second checkout tests on another port; share routes check the Origin | a1a9ed1 |
| 5 | `private.share_take` counts its hour and day limits in the Paris day (`20261022130000_share_take_paris_day.sql`) | Builder decision (recommended): daily caps restarted at UTC midnight | 453045c |

## The held state (this bundle)

A won deal that a confirmed sale (or an active hold) names:

- **Sheet**: "Stock records hold this deal. Sort them out first." in the Reopen row's place, with a quiet
  "See the lead’s stock" button-link (`/leads/<id>?tab=stock`); the stage stepper is disabled and described by that
  sentence (`aria-describedby`). FR: "Des mouvements de stock retiennent cette affaire. Réglez-les d’abord." /
  "Voir le stock du prospect".
- **Sheet ⋯ menu**: Copy link only (no Delete).
- **Board card ⋯ / right-click menu**: Open lead, Copy link (no Reopen, no Delete, no leading separator); the Delete
  key does nothing. The board knows "held" once the sheet has loaded that deal (cached `get_deal`).
- **Lead Deals tab**: the held won deal's row has no ⋯ (its only item was Reopen).

Audits: [`apple-design-audit.md`](apple-design-audit.md) and [`web-guidelines-audit.md`](web-guidelines-audit.md)
(rules pinned at `434b7f91364665f2f733b310ec54809bf8f37937`). Fixes from them: the reason in the Reopen row's shape,
the stepper's `aria-describedby`, no leading separator in the card menu, a next-step link.

## Library documentation used (Context7)

- TanStack Query v5.90.3 (`/tanstack/query/v5.90.3`): `docs/reference/QueryClient.md` (`getQueryData`: synchronous,
  `undefined` when the query does not exist, no request) and `docs/framework/react/guides/disabling-queries.md`
  (`enabled: false`: no fetch on mount or in the background, initialises from cached data). Used for the board's
  `getQueryData(dealKey(id))` and the Deals tab's `useQuery({ enabled: false })` (reads the sheet's cached details,
  never fetches).
- PostgreSQL 16 (`/websites/postgresql_16`): `functions-datetime.html` section 9.9.2 `date_trunc(field, source
  [, time_zone])` (`text, timestamptz, text → timestamptz`; truncation "with respect to" the named zone, default the
  session's TimeZone). Used in `share_take` and as the allowed form in the time-zone test.
- Playwright v1.63.0 (`/microsoft/playwright/v1.63.0`): `docs/src/test-webserver-js.md` (`webServer.command`, `url`,
  `reuseExistingServer`; `use.baseURL` resolves relative `page.goto`) and `packages/playwright/src/index.ts` (the
  `baseURL` option fixture). Used for `PLAYWRIGHT_BASE_URL` in the configs and `test.info().project.use.baseURL` in specs.

## Checks (final code)

Isolated local stack: PostgreSQL 54620, GoTrue 9989, gateway 54621, app on 4000 (`PLAYWRIGHT_BASE_URL`), scratch
`/tmp/day7f-builder`; Chromium from `PW_CHROMIUM_PATH`.

| Check | Result |
|---|---|
| `npm run lint` | 0 errors (the 3 old `useVirtualizer` warnings) |
| `npm run typecheck` | 0 errors |
| `npm run check:native` | 0 findings |
| `npm run test:unit` | 692 passed |
| `scripts/db-test.sh` | exit 0, 25 suites, advisors 0 ERROR (3 old WARN) — on 453045c; re-run by the coordinator on bb66dd1 (exit 0); no SQL changed since |
| e2e chromium | pipeline + pipeline-multi + lead-deals + home + team 50/50; `DAY7F_SCREENS=1` day7f.spec 4/4 (48 shots, each asserting the state, clean console, no sideways scroll); share.spec 12/12 (previous round, unchanged since) |
| gitleaks 8.28.0 over 0e895b5..HEAD, `npm audit --omit=dev --audit-level=high` | no leaks, 0 vulnerabilities (previous round; re-run in the log row of this round) |
| Mutation | with the hiding logic disabled, the three held/120 s pipeline tests fail; without `20261022130000` the time-zone test and `share_take_day_bucket_is_the_paris_day` fail; `x.k(int)` is not superseded by `x.k(text)` |

## Residuals

1. The board's card menu and the lead's Deals tab know "held" only once the deal's details are loaded (the sheet's
   `get_deal`); a cold card still shows Reopen/Delete and the server answers with the reason. Dragging a held won card
   to an open stage opens the Reopen dialog and the server refuses.
2. The board's 120 s uses the browser clock against the server's `created_at`.
3. The Supabase dev-project advisors were not run from this session (no migration applied to dev); the local advisors
   are clean.
4. No WebKit run here (Chromium only on this machine); CI runs WebKit for pipeline and share.
5. 768/1024 not photographed: the held state does not change any layout (the reason row is the Reopen row's shape in
   the same sheet).

## Screenshots (`screens/`, 48)

`{sheet,sheet-menu,card-menu}-{en,fr}-{light,dark}-{1280,1440,1728,390}.png`, made by `tests/auth/day7f.spec.ts`
(`DAY7F_SCREENS=1`, optional `DAY7F_WIDTHS`) into `test-results/screens/day7f` and copied here.

- `sheet-*`: the held won deal's sheet (reason row, stepper off).
- `sheet-menu-*`: the sheet's ⋯ menu open (Copy link only).
- `card-menu-*`: the board card's ⋯ menu open (Open lead, Copy link); at 390 after switching to the Won tab.
