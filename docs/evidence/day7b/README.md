# Day 7b: no native pickers or popups, and list states

Built 15 Oct 2026 by the builder on local branch `day7b-local` (worktree `/home/user/topstock-crm-7`), from a2c05a8
(Day 6 6f13709 plus `day7-local`'s picker components). Not pushed, no PR. Scope: `docs/evidence/day7/plan.md`
section 4 row **7b**, UI only. Rule: Haider 15 Oct 2026, "do not keep any native pickers or popups on the app". Out of
scope here: plan items 24, 25, 47, 49, 28 and 42 (Day 7a or decided otherwise).

The step was restarted after an interrupted builder (17:46 UTC): its 34 uncommitted files were read hunk by hunk and
kept where sound (all of them were), with three fixes on top: a missing message key (`Leads.until.needDate`, the Cool
off date error), an unused import, and the stock search moved onto `SearchInput` instead of a hand-made copy.

## What changed

1. **Call sites** use the app's own components (`src/components/ui/{select,combobox,date-picker,time-picker,
   date-time-picker,tooltip,search-input,disclosure}.tsx`). Values keep the native shapes (`YYYY-MM-DD`, `HH:MM`,
   `YYYY-MM-DDTHH:MM`, the option value), so no server action or Zod schema changed.
2. **CI source check** `scripts/check-native-controls.mjs` (`npm run check:native`, in the `quality` job after
   typecheck, and in `npm run verify`), unit-tested by `tests/unit/native-controls.spec.ts` (each rule shown failing on
   a planted break and quiet on its look-alikes, then a scan of `src/` that must be empty). It reads the code with the
   TypeScript parser, so a component prop called `title` (Card, ListState) or a local function called `confirm` is not
   a finding. Rules, outside `src/components/ui`:

   | Rule | Fails on |
   |---|---|
   | `native-select` | a raw `<select>` |
   | `native-input` | `type` = date, time, datetime-local, month, week, color or search, on any element, in any spelling (`"x"`, `{"x"}`, a ternary, a template) |
   | `native-datalist` | `<datalist>` |
   | `title-tooltip` | `title=` on an HTML element, `motion.*`, or a component that hands it to one (Link, Button, Input, Textarea, Label, Kbd, Image); not `<svg><title>`, not an `<iframe>`'s name |
   | `native-disclosure` | a raw `<details>` or `<summary>` (use `Disclosure`) |
   | `native-dialog` | `confirm`/`alert`/`prompt`, bare (unless the file declares that name) or through `window`/`globalThis`/`self` |
   | `form-validate` | a `<form>` without `noValidate` (or with `noValidate={false}`) |
   | `native-validity` | `reportValidity()` / `setCustomValidity()` |

3. **Picker fixes found at the call sites** (all in `src/components/ui`): the Combobox trigger is a select-only
   combobox (`role="combobox"`, Down/Up open it); TimePicker reads 24-hour in both languages, as every time in the app
   does (Day 4b decision 3; it showed "10:00 AM" next to "10:00 there · 11:00 for you"); a typed DatePicker's calendar
   gives focus back to the text box it was opened from; a typed time counts as soon as it is a valid time (the queue's
   meeting Confirm stayed disabled until the field lost focus); Select and Combobox triggers carry `data-value` and their
   options `data-option` (tests pick and read by value, as `selectOption` did).
4. **Long lists on Combobox** (searchable, accents and case ignored): country in the lead form (about 250), country
   and time zone in the import's Match step (about 250 and 400). More's time zone was already moved by the previous
   builder.
5. **Skeletons that match**: Recent activity draws the 8 rows the card holds (was 4) in the card and in Home's
   loading.tsx; More's loading.tsx draws Administration for admins only (the app layout carries `data-role`, used only
   for this; every page and the database check the role again). Low stock's skeleton already matched the Day 6 card
   (`home-screens.spec.ts` "Low stock loading skeleton matches the filled card").
6. **e2e tests** pick like a person: `tests/auth/helpers.ts` gains `choose()` (click the combobox, then the option by
   value or words), `expectChosen()` and `pickDate()`. No test was skipped, weakened or deleted (details below).
7. **Forms**: every `<form>` sets `noValidate`; the auth fields keep `required` only as `aria-required` and drop
   `pattern` and `minLength` (the server actions already check every field with Zod and show the error in
   `FormMessage` with `aria-invalid`).

## Call sites, before and after

Before: the checker run over a2c05a8 (`git show a2c05a8:<file>` through `scanSource`), **87 findings in 43 files**.
After: **0** (`npm run check:native`, and the last test of `native-controls.spec.ts`).

| File | Before (rule × count) | After |
|---|---|---|
| `app/(app)/more/page.tsx` | form-validate 1 | `noValidate` |
| `activity/call-panel.tsx` | form-validate 1 | `noValidate` |
| `activity/composer.tsx` | form-validate 1 | `noValidate` |
| `activity/outcome-pad.tsx` | native-input 2 (date, time), title 1 | DatePicker, TimePicker, Tooltip on the date chips |
| `activity/timeline.tsx` | title 1, form-validate 1 | absolute time as sr-only text; `noValidate` |
| `auth/forms.tsx` | form-validate 8 | `noValidate`; `aria-required`, no `pattern`/`minLength` |
| `auth/step-up-dialog.tsx` | form-validate 1 | `noValidate` |
| `files/files-tab.tsx` | title 1 | the name is already sr-only text |
| `home/recent-activity.tsx` | title 1 | sr-only full time |
| `import/check-step.tsx` | title 1 | the name wraps |
| `import/import-history.tsx` | title 1 | full name as sr-only text, the shortened one hidden from screen readers |
| `import/match-step.tsx` | title 2 | examples and values wrap; country and time zone on Combobox |
| `inventory/product-form.tsx` | native-input 1 (ETA) | DatePicker `typed` |
| `inventory/product-panel.tsx` | title 2 | sr-only time; the Archive reason is visible text linked by `aria-describedby` |
| `inventory/stock-table.tsx` | title 1 | on hand / held as sr-only text |
| `inventory/stock-toolbar.tsx` | native-input 1 (search) | SearchInput (keeps its `/` hint) |
| `inventory/tab-lists.tsx` | native-input 3 (ETA, from, to), title 1 | DatePicker `typed` ×3; sr-only time |
| `lead/deal-chip.tsx` | native-select 1 | Select |
| `lead/details-tab.tsx` | native-input 1 (datetime-local) | DateTimePicker (`defaultTime` 09:00, lead's zone) |
| `lead/lead-page.tsx` | title 2 | Tooltip on previous/next lead |
| `lead/status-menu.tsx` | native-input 1, form-validate 1 | DatePicker; `noValidate` with the error in FormMessage |
| `leads/lead-preview.tsx` | title 1 | sr-only full time |
| `leads/leads-toolbar.tsx` | native-input 2 (search), form-validate 1 | SearchInput ×2; `noValidate` |
| `pipeline/deal-card.tsx` | title 2 | the stalled hint was already sr-only; owner initials are `aria-hidden` (owner named elsewhere) |
| `pipeline/deal-sheet.tsx` | native-select 2, native-input 1, title 1 | Select ×2, DatePicker, sr-only time |
| `pipeline/open-deal-sheet.tsx` | native-select 3, native-input 1 | Select ×3, DatePicker |
| `queue/queue-card.tsx` | native-disclosure 2, title 1 | Disclosure; sr-only time |
| `sales/hold-and-request-sheets.tsx` | native-select 1, native-input 1, form-validate 2 | Select, DatePicker, `noValidate` |
| `sales/record-sale-sheet.tsx` | native-select 1, form-validate 1 | Select, `noValidate` |
| `sales/sales-tabs.tsx` | form-validate 1 | `noValidate` |
| `share-links/link-card.tsx` | native-disclosure 2, native-select 2 | Disclosure, Select ×2 |
| `share/share-list.tsx` | native-input 1 (search) | SearchInput |
| `share/share-request.tsx` | form-validate 2 | `noValidate` |
| `shell/dock.tsx` | title 1 | Tooltip ("G then L") |
| `shell/profile-form.tsx` | form-validate 1 | `noValidate` |
| `shell/timezone-form.tsx` | native-select 1, form-validate 1 | Combobox (about 400 zones), `noValidate` |
| `stock-import/bits.tsx`, `stock-history.tsx`, `stock-match.tsx` | title 1 each | names and examples wrap |
| `tasks/quick-add.tsx` | native-input 2, title 1, form-validate 1 | DatePicker `typed`, TimePicker, Tooltip on chips, `noValidate` |
| `tasks/task-row.tsx` | native-input 2, native-select 1, title 1, form-validate 1 | DatePicker `typed`, TimePicker, Select, `noValidate`; Escape lets an open picker close first |
| `tasks/tasks-workspace.tsx` | title 1 | the count is already sr-only text |
| `team/team-list.tsx` | form-validate 1 | `noValidate` |

Not findings, also moved: about 37 `ui/select` call sites (already the app's Select since `day7-local`, same API, no
change needed); lead form country and import country/time zone (Select → Combobox).

Left native on purpose (not in the 7b list; HAIDER DECIDES below): the browser's "Leave site?" prompt while an
import is running (`import/import-workspace.tsx`, `beforeunload`). No page can draw its own dialog for a closing tab.

## List states

Every list in the plan's table, with its loading, empty and error state and the test that reaches each. "server" means
the first page comes with the page (the route's loading.tsx skeleton covers loading; a failed server read renders the
error state on arrival).

| List | Loading (no spinner) | Empty | Error (with retry) | Tests |
|---|---|---|---|---|
| Leads | `leads/loading.tsx`, TableSkeleton, keyset loading row | "No leads yet" (admin: import / add; rep: add) and "No leads match" (Clear filters) | "Couldn't load leads" + Try again | day7b "list states: Leads" (skeleton, error, retry, no match, rep's empty org); leads.spec "120 leads … page by page" |
| Lead timeline | TimelineSkeleton (route and older pages) | "Nothing logged yet" / "Nothing of this kind yet" | "Couldn't load the timeline" + Try again; older page error | day7b "list states: lead …"; lead-page.spec `timeline_older_page_error_waits_for_retry`, `timeline_pages_keyset` |
| Lead tasks (Next step) | 44 px bar | "No next step" + date chips | alert + Retry | lead-page.spec `task_check_keeps_focus` (list); error state reached only when the page's server read fails: **no browser test** (open item 3) |
| Files | skeleton rows | "No files yet" | load error + Try again; older files error | files.spec `files_tab_empty_state`, older-files error, `delete_needs_fresh_code` Retry; files-screens |
| Lead deals | 3 rows `aria-busy` | "No deals yet" | "Couldn't load deals" + Retry | day7b "list states: lead …" (skeleton, error, empty); lead-page.spec `deals_stock_empty_states` |
| Pipeline columns | `pipeline/loading.tsx`; Show more loading | empty board / column / filtered | board error, column error | day5-screens "board errors … an empty board"; pipeline.spec `board_read_fails_shows_retry_and_recovers`, `column_read_fails_shows_retry_and_recovers` |
| Home cards | HomeBodySkeleton per card (Recent activity now 8 rows; Low stock matches) | new org empty states | card error isolated | home.spec `new_org_empty_states`, `card_error_isolated`; home-screens skeleton + Low stock skeleton; day7b "skeleton: Recent activity" |
| Tasks | TaskRowsSkeleton | per tab ("Nothing due today", "Nothing planned", …) | "Couldn't load these tasks" + Try again | day7b "list states: Tasks"; tasks.spec `quick_add_chips_buckets` (empty Today) |
| Queue | QueueCardSkeleton; counts skeleton | all done, outside hours, none mine | queue error + Retry; counts error + Retry | queue.spec `focus_never_drops_to_body`, `outside_hours_state…`, `not_saved_in_every_phase`; day7b "list states: Inventory …, the queue's counts" |
| Inventory stock table | `inventory/loading.tsx`, virtual rows | "No products match" / empty | "Couldn't load the stock" + Try again | inventory.spec `inventory_empty_and_error_states` |
| Arriving, Reserved, Movements | RowsSkeleton | "Nothing in transit", "No holds", "No movements yet" / "No movements match" | ListState error + Try again | day7b "list states: Inventory tabs …" (skeleton, error, empty each); inventory.spec `movements_log_keyset` |
| Sales, Requests (Inventory) | RowsSkeleton | "No sales yet", "No open requests" | ListState error + Try again | day7b "list states: Inventory tabs …" |
| Sales sections on a lead | StockTabSkeleton | "No sales …", "No stock held …", "No requests …" | ListState error + Try again | sales.spec `empty_sections_and_palette_record_sale` |
| Share links | bar skeleton | "No active link for this client" | "Couldn't load the links" + Try again (now an alert) | day7b "list states: lead …" |
| Past imports (leads) | server (`leads/import/loading.tsx`) | "No imports yet" | "Couldn't load past imports" + Try again | import.spec (empty); error after a failed refresh: **no browser test** (open item 3) |
| Past stock imports | 3 rows | "No stock sheet imported yet" | error + Try again | day7b "list states: Inventory …" (empty); error: **no browser test** (open item 3) |
| Team | `more/team/loading.tsx` | "No one here yet" (cannot happen: the viewer is always listed) | server read error + Retry | team-screens "team route skeleton"; error: **no browser test** (open item 3) |
| More (skeleton) | `more/loading.tsx`, Administration for admins only | n/a | n/a | day7b "skeleton: More draws Administration for admins only" |

## Screenshots: each picker closed and open

`tests/auth/day7b.spec.ts` "screens: …", one test per picker; each shot is the picker and its panel with 24 px around
them, after a check for console errors and sideways scroll. Files: `docs/evidence/day7b/screens/<picker>-<en|fr>-<light|dark>-<390|1440>-<closed|open>.png`
(8 pickers × 2 languages × 2 schemes × 2 widths × 2 states = 128 shots).

| Picker | Where | Open shows |
|---|---|---|
| `select` | Leads > Add lead > Lead status | the listbox, chosen option ticked |
| `combobox` | More > Time zone | search "paris" and the filtered list |
| `date-picker` | Tasks > quick add > Pick a date (typed) | the month grid (Alt+Down) |
| `time-picker` | Tasks > quick add > Time | the 15-minute list |
| `date-time-picker` | Lead > Details > Next call | the month grid from the date button |
| `tooltip` | the dock | "G then L" on keyboard focus |
| `search-input` | Leads search | our own clear button |
| `disclosure` | Lead > Stock > Link options | the options, chevron turned |

Result (15 Oct 2026, Chromium 141 at `/opt/pw-browsers/chromium-1194`): 8 of 8 tests passed, 128 shots, no console
error and no sideways scroll in any of them. Reviewed by eye on a sample in both schemes and widths: the panels open
from their trigger with 16 px from the screen edges at 390; the Select ticks the chosen option; the Combobox filters
"paris" to Europe/Paris; the calendars start on Monday with French month and weekday names in French; the time list is
24-hour; the tooltip sits above the dock link; the clear button shows only with text; the disclosure's chevron turns.
At 390 the floating dock covers the bottom of the opened Link options in one shot, as it does on the page itself
(scrolling clears it).

## Keyboard-only runs (Chromium, `tests/auth/day7b.spec.ts` "keyboard only: …")

Nothing inside a picker is clicked; each step asserts focus and the submitted value.

| Picker | Keys proven |
|---|---|
| Select | focus → Enter opens on the chosen option → Down → Enter picks, focus back on the trigger → Space opens → Escape closes, dialog stays, value kept → typeahead `n` picks Negotiation on the closed trigger |
| Combobox | focus → Enter opens with focus in the search → type "tokyo" → Enter picks Asia/Tokyo (trigger and hidden input), focus back → Down opens → "SAO" finds "São Paulo" (accents and case ignored) → Escape closes, value kept |
| DatePicker (typed) | type 10/20/2026 + Enter → 2026-10-20 → Alt+Down opens on that day → Right, Down, PageDown → Enter picks 2026-11-28, focus back in the text box → Alt+Down, Left, Escape: no change, focus back → 02/31/2026 refused in place (`aria-invalid`, empty value) |
| TimePicker | type 915 + Enter → 09:15 → Down opens on 09:15 → Down → Enter picks 09:30, focus stays → Down, Escape closes only the list |
| DateTimePicker | focus the date button → Enter opens the grid → Right → Enter → the day with 09:00 → Tab to the time → 1030 + Enter → `…T10:30` |
| Tooltip | focus on a dock link shows "G then L" at once as its description (name stays "Leads") → Escape hides it |
| SearchInput | type → URL `q=` → Escape empties → type → Tab reaches our clear button → Enter empties, focus back in the box |
| Disclosure | focus the summary → Enter opens → Space closes; no browser triangle (`list-style: none`), one chevron |

## Tests changed (none skipped, weakened or deleted)

| Spec | Was | Now |
|---|---|---|
| `import.spec.ts` | `selectOption` ×12, `toHaveValue` on selects ×11, `inputValue()` | `choose(trigger, value)`, `expectChosen(trigger, value)` (the trigger's `data-value`, same value the hidden input submits), `getAttribute("data-value")` |
| `import-perf.spec.ts` | `select[aria-invalid]` + `selectOption` | `[role=combobox][aria-invalid]` + `choose`, looping until none is left |
| `screens.spec.ts` (lead import) | same as import-perf, ×2 | same as import-perf |
| `lead-page.spec.ts` | `selectOption("America/Chicago")`; `toHaveValue` on the native Next call field | `choose`; the hidden `next_action_at` input; focus still asserted on the field |
| `leads.spec.ts` | `selectOption` ×3 | `choose` ×3 (status by value, owner by words, country by value) |
| `lead-deals.spec.ts` | `selectOption` ×2 | `choose` ×2 |
| `tasks.spec.ts` | `fill` on the native date field; `selectOption` on the zone; a made-up `<option>` injected into the page to prove the server refuses an unknown zone | `pickDate`; `choose`; the save request is rewritten to the unknown zone on its way to the server, which still refuses it (the app's list can no longer be given an option in the page); `getByLabel("Time")` → `getByRole("combobox", { name: "Time", exact: true })` (the clock button's label also contains "time") |
| `home.spec.ts` | `toHaveAttribute("title", /\d/)` on Recent activity's time | the sr-only full time inside `<time>` has a digit, and no `title` |
| new `day7b.spec.ts` | | keyboard runs, list states, skeletons, screenshots |
| new `tests/unit/native-controls.spec.ts` | | the source check |

## Checks

Run on 15 Oct 2026 on the isolated local stack (Postgres 54570, GoTrue 9992, gateway 54571, Next 3600; built with
that stack's keys), Chromium only.

| Check | Result |
|---|---|
| `npm run lint` | 0 errors (3 warnings, all existing: `useVirtualizer` in check-step, stock-table, leads-table) |
| `npm run typecheck` | pass |
| `npm run check:native` | 0 findings; a planted `<select>` in `lead/deal-chip.tsx` made it exit 1 (reverted) |
| `npm run test:unit` | 630 passed (incl. `native-controls.spec.ts` 11, `pickers-render.spec.ts` 9, `messages.spec.ts` 10) |
| `day7b.spec.ts` | 19 passed: 5 keyboard-only runs, 4 list-state tests, 2 skeleton tests, 8 screenshot tests (the last ones in their own run) |
| `leads.spec.ts` | 9 passed |
| `lead-deals.spec.ts` | 9 passed |
| `lead-page.spec.ts` | 26 passed (re-run after the TimePicker change) |
| `tasks.spec.ts` | 12 passed (re-run after the TimePicker change) |
| `import.spec.ts` | 11 passed (run alone: it counts every lead in the database, so a concurrent run of another spec broke one count once) |
| `queue.spec.ts` | 20 passed; `call_keeps_claims` fails on this machine before and after this step (this Chromium fires one `beforeunload` for two quick `tel:` links; recorded the same way on origin/main in `docs/evidence/day5c/README.md`), left to CI |
| `home.spec.ts` | 15 passed |
| `inventory.spec.ts` | 11 passed |
| `sales.spec.ts` | 11 passed |
| `shell.spec.ts` | 21 passed (dock Tooltip) |
| `pipeline.spec.ts` | 16 passed |
| `share.spec.ts` | 12 passed with a throwaway copy that reads port 3600 where the spec hard-codes `localhost:3100` (two assertions on the link's origin); unchanged spec: those assertions fail here only for the port |
| `day4-security.spec.ts` | 9 passed |
| `team.spec.ts` | 5 passed |
| `screens.spec.ts`, `import-perf.spec.ts` | not run (their only change is the `choose()` swap on the import status menus, proven by `import.spec.ts`); left to CI |
| WebKit | not run (Chromium only, as asked) |

## Deviations and choices

- TimePicker's English clock changed from 12-hour to 24-hour (the app's Day 4b decision); `pickers.md` updated.
- The Combobox trigger now has `role="combobox"` (was a plain button with a dialog popup), so every picker is reached
  the same way by screen readers and tests; Down/Up open it.
- The layout's `data-role` attribute exists only to shape a skeleton. The role is no secret to the person signed in
  (the command menu already hides admin commands from others); every page and the database still check it.
- Screenshots are clipped to the picker and its panel (24 px margin) instead of the whole screen, to keep the evidence
  small (128 shots).
- `/apple-design` and web-design-guidelines audits of the pickers at their call sites were not run in this session
  (open item 4).

## Open items

1. **Not pushed, no PR, no advisor run** (as asked). CI has not run this code.
2. **WebKit** was not run locally (Chromium only, as asked); the picker keyboard runs are Chromium only.
3. **Error states with no browser test**: lead tasks (Next step), past lead imports after a failed refresh, past stock
   imports, Team. Each exists in code (alert + retry) but is reached only when the page's own server read fails, which
   a browser test cannot cause without a server switch.
4. `/apple-design` and web-design-guidelines audits, and the 1280/1728 (and 768/1024) screenshots CLAUDE.md asks for a
   UI change, remain for the PR.
5. `screens.spec.ts` and `import-perf.spec.ts` were not run locally (only the import status menus changed in them).
6. CI time: `day7b.spec.ts` adds about 5 minutes to a Chromium auth-journey half (about 2.5 for the 128 shots); the
   shots could move behind a flag if the Actions budget runs low (plan question 12).

## HAIDER DECIDES

- **The browser's "Leave site?" prompt during a lead import** is the one native popup left. A web page cannot replace
  it with its own dialog when the tab is closing; without it a closed tab pauses the import silently (it can be
  resumed from Past imports). **Recommended: keep it.**
