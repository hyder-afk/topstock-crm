# Day 7b: no native pickers or popups, and list states

Built 15 Oct 2026 by the builder on local branch `day7b-local` (worktree `/home/user/topstock-crm-7`), from a2c05a8
(Day 6 6f13709 plus `day7-local`'s picker components). Not pushed, no PR. Scope: `docs/evidence/day7/plan.md`
section 4 row **7b**, UI only. Rule: Haider 15 Oct 2026, "do not keep any native pickers or popups on the app". Out of
scope here: plan items 24, 25, 47, 49, 28 and 42 (Day 7a or decided otherwise).

**Merged with Day 7a** (`day7a-local` 33f3347: main, Day 5, Team, Day 6 with its latest fixes, and the 7a security
work) at 35d5841, and again at a62b405 when Day 7a moved to 2e90b7a, then finished for the advisor: the "Leave site?" decision recorded and enforced by `check:native`,
the CLAUDE.md audits with three fixes, screenshots at every width, and the checks re-run on the merged code (sections
"Merge with Day 7a", "Audits", "Screenshots", "Checks").

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
   TypeScript parser, so a listed component's `title` prop (Card, ListState) or a `confirm` declared in an enclosing scope
   is not a finding. Rules, outside `src/components/ui`:

   | Rule | Fails on |
   |---|---|
   | `native-select` | a raw `<select>` |
   | `native-input` | `type` = date, time, datetime-local, month, week, color or search, on any element, in any spelling (`"x"`, `{"x"}`, a ternary, a template) |
   | `native-datalist` | `<datalist>` |
   | `title-tooltip` | `title=` on an HTML element, `motion.*`, or **any capitalised component not in `TITLE_PROP`** (fails closed; the 15 components whose own `title` prop is drawn as text: AttentionCard, AuthCard, Card, Column, DealRows, EmptyState, HomeCard, ListState, OpenDealSwitch, PipelineSnapshot, ReasonList, RecentActivity, Section, StatePanel, ValueSection); not `<svg><title>`, not an `<iframe>`'s name |
   | `input-type-computed` | a `type` on `input`/`Input` that is not a literal or a ternary of literals (`type={kind}`, `type={props.type}`, `` type={`${x}`} ``): the check cannot read it, so it cannot prove it is not a picker |
   | `native-disclosure` | a raw `<details>` or `<summary>` (use `Disclosure`) |
   | `native-dialog` | `confirm`/`alert`/`prompt` that **resolve to the browser's** (scope-aware: a bare name fails unless an enclosing scope declares it, so a local `confirm` in one function no longer covers a global call in another), called or passed as a value, or through `window`/`globalThis`/`self`/`top`/`parent`/`frames` by dot, `["…"]` or destructuring |
   | `form-validate` | a `<form>` without `noValidate` (or with `noValidate={false}`) |
   | `native-validity` | `reportValidity()` / `setCustomValidity()` |
   | `native-leave-prompt` | the browser's "Leave site?" prompt: `preventDefault()` or `returnValue =` in a `beforeunload` handler (inline, named and passed to `addEventListener("beforeunload", …)`, or typed `BeforeUnloadEvent`), or any `onbeforeunload =`; a `beforeunload` listener that never asks (the queue's goodbye beacon) is fine |
   | `stale-allowance` | an `ALLOWED` entry whose use is gone or moved |

   `ALLOWED` (in the script) holds the one native use kept: the lead import's "Leave site?" prompt in
   `src/components/import/import-workspace.tsx`, count 1, with a comment saying why (the builder's decision, taken
   under Haider's standing instruction; Haider to confirm). A second prompt in that file, the
   same prompt in any other file, or the prompt gone from that file each fail the check (unit-tested with a scratch
   tree in `native-controls.spec.ts`).

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

Before: the checker run over a2c05a8 (`git show a2c05a8:<file>` through `scanSource`), **87 findings in 43 files**,
not counting the kept "Leave site?" prompt; with today's rules it reports **88 in 44 files** (that prompt is the 88th,
in `import-workspace.tsx`; the stricter rules of the advisor round add nothing on a2c05a8: re-run 16 Oct, 88 in 44).
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

Left native on purpose (**decided**, see "Decided" below): the browser's "Leave site?" prompt while an import is
running (`import/import-workspace.tsx`, `beforeunload`). No page can draw its own dialog for a closing tab. It is the
only entry in `check:native`'s `ALLOWED`.

## Merge with Day 7a

`git merge day7a-local` (33f3347) into `day7b-local` (adf799c), merge commit **35d5841**. Merge base 6f13709. Day 7a's
side brought 104 files (Day 6's PR #17 fixes for pipeline and files, the 7a security work, its evidence and
migration 20261021100000, the Paris time zone for DB tests). Seven files changed on both sides; four merged by
themselves, three conflicted:

| File | Conflict | Resolution |
|---|---|---|
| `src/app/(app)/more/page.tsx` | 7b added `noValidate` to the Sign out form; 7a wrapped it with "Sign out of all devices" beside it | both: 7a's row (Sign out + `SignOutEverywhere`, stacked on phones) with `noValidate` on the form |
| `tests/unit/messages.spec.ts` | each side added one namespace to the checked list | both: `Pickers` and `More` |
| `docs/log.md` | each side appended rows | both sides' rows kept, in time order: the Day 7 planning rows (Haider's no-native rule, scope A, picker components), then Day 7a's rows, then Day 7b's |
| `src/app/(app)/more/loading.tsx` | auto-merged | 7b's Administration-for-admins-only and 7a's two sign-out bars both present |
| `src/components/files/files-tab.tsx` | auto-merged | 7a's layout-effect focus fix for "Show older files" with 7b's change elsewhere in the file |
| `messages/en.json`, `fr.json` | auto-merged | 7a's `More.everywhere` and 7b's `Pickers` both present (`messages.spec.ts` checks EN/FR parity) |

Watched points:

- **Rate-limit route scan** (`tests/unit/rate-limit.spec.ts`): Day 7b added or changed no route under `src/app/api`,
  so the scan's 19 limited and 12 named non-list routes hold unchanged (unit run passes).
- **Pipeline board** (`board.tsx`, `column.tsx`, `pipeline-skeleton.tsx` from PR #17: CSS-only column height,
  `initialOffset` from the column's own scrollTop, `readScope` for a rep): Day 7b did not touch these three files (its
  pipeline edits are in `deal-card.tsx`, `deal-sheet.tsx`, `open-deal-sheet.tsx`), so 7a's versions stand as they were.
  `pipeline.spec.ts` re-run below.
- **Messages**: no key clashes; both namespaces checked for EN/FR parity.
- **Second merge**: the coordinator moved `day7a-local` to 2e90b7a (Day 6's PR #18 fixes: arrival focus retries for
  1.5 s, WebKit journey in two shards, Paris time zone for DB tests, a `nosemgrep` line). Merged again at **a62b405**;
  only `docs/log.md` conflicted (both sides' rows kept). `ci.yml` merged by itself: the matrix is chromium 1/2, 2/2 and
  webkit 1/2, 2/2, and 7b's `check:native` step stays in the quality job. 7b now sits on 2e90b7a.
- **`npm run check:native` after the merge: 0 findings.** Day 6 code reached 7b through its base (6f13709), so 7b's
  conversion already covered it; the 7a delta (`sign-out-everywhere.tsx`, the More page, files-tab, the pipeline
  files) adds no native control, `title=` or form without `noValidate` (7a's sheet uses the app's Dialog).

## List states

Every list in the plan's table, with its loading, empty and error state and the test that reaches each. "server" means
the first page comes with the page (the route's loading.tsx skeleton covers loading; a failed server read renders the
error state on arrival).

| List | Loading (no spinner) | Empty | Error (with retry) | Tests | Screenshot (state shown) |
|---|---|---|---|---|---|
| Leads | `leads/loading.tsx`, TableSkeleton, keyset loading row | "No leads yet" (admin: import / add; rep: add) and "No leads match" (Clear filters) | "Couldn't load leads" + Try again | day7b "list states: Leads" (skeleton, error, retry, no match, rep's empty org); leads.spec "120 leads … page by page" | list: `day3a/screens/leads-en-light-1440.png`; loading, empty, error: none |
| Lead timeline | TimelineSkeleton (route and older pages) | "Nothing logged yet" / "Nothing of this kind yet" | "Couldn't load the timeline" + Try again; older page error | day7b "list states: lead …"; lead-page.spec `timeline_older_page_error_waits_for_retry`, `timeline_pages_keyset` | list: `day4b/screens/lead-timeline-en-light-1440.png`; loading: `day4b/screens/lead-skeleton-en-light-1280.png` (route skeleton); empty, error: none |
| Lead tasks (Next step) | 44 px bar | "No next step" + date chips | alert + Try again | lead-page.spec `task_check_keeps_focus` (list); **day7b "list states: lead tasks (Next step) error after a failed refetch, then Try again"** (the tasks route answers 500, a date chip adds a task, the card's refetch fails, Try again shows the task) | none (the error is proven by the test) |
| Files | skeleton rows | "No files yet" | load error + Try again; older files error | files.spec `files_tab_empty_state`, older-files error, `delete_needs_fresh_code` Retry; files-screens | empty: `day4d/screens/files-empty-en-light-1440.png`; an upload that failed above the empty list: `day4d/screens/files-failed-en-light-1440.png`; load error: none |
| Lead deals | 3 rows `aria-busy` | "No deals yet" | "Couldn't load deals" + Retry | day7b "list states: lead …" (skeleton, error, empty); lead-page.spec `deals_stock_empty_states` | none |
| Pipeline columns | `pipeline/loading.tsx`; Show more loading | empty board / column / filtered | board error, column error | day5-screens "board errors … an empty board"; pipeline.spec `board_read_fails_shows_retry_and_recovers`, `column_read_fails_shows_retry_and_recovers` | loading: `day5b/screens/pipeline-loading-en-light-1440.png`; empty: `day5b/screens/empty-board-en-light-1440.png`; error: `day5b/screens/board-error-en-light-1440.png`, `column-error-en-light-1440.png` |
| Home cards | HomeBodySkeleton per card (Recent activity now 8 rows; Low stock matches) | new org empty states | card error isolated | home.spec `new_org_empty_states`, `card_error_isolated`; home-screens skeleton + Low stock skeleton; day7b "skeleton: Recent activity" | loading: **`day7b/screens/state-recent-skeleton-en-{light,dark}-{390,1440}.png`** (new, the 8 rows), `day5c/screens/home-loading-en-light-1440.png`, `home-low-stock-loading-en-light-1440.png`; empty: `day5c/screens/home-new-org-en-light-1440.png`; error: `day5c/screens/home-card-error-en-light-1440.png` |
| Tasks | TaskRowsSkeleton | per tab ("Nothing due today", "Nothing planned", …) | "Couldn't load these tasks" + Try again | day7b "list states: Tasks"; tasks.spec `quick_add_chips_buckets` (empty Today) | loading: `day4c/screens/tasks-skeleton-en-light-1440.png`; empty: `day4c/screens/tasks-done-empty-fr-dark-390.png`; error: none |
| Queue | QueueCardSkeleton; counts skeleton | all done, outside hours, none mine | queue error + Retry; counts error + Retry | queue.spec `focus_never_drops_to_body`, `outside_hours_state…`, `not_saved_in_every_phase`; day7b "list states: Inventory …, the queue's counts" | loading: `day4c/screens/leads-queue-skeleton-en-light-1440.png`; empty: `day4c/screens/queue-none-mine-en-light-1440.png`; error: none |
| Inventory stock table | `inventory/loading.tsx`, virtual rows | "No products match" / empty | "Couldn't load the stock" + Try again | inventory.spec `inventory_empty_and_error_states` | list: `day6b/screens/inventory-en-light-1440.png`; empty, error: none |
| Arriving, Reserved, Movements | RowsSkeleton | "Nothing in transit", "No holds", "No movements yet" / "No movements match" | ListState error + Try again | day7b "list states: Inventory tabs …" (skeleton, error, empty each); inventory.spec `movements_log_keyset` | loading: `day6b/screens/arriving-en-light-1440.png` (Arriving's skeleton rows); list: `day6b/screens/movements-en-light-1440.png`; empty, error: none |
| Sales, Requests (Inventory) | RowsSkeleton | "No sales yet", "No open requests" | ListState error + Try again | day7b "list states: Inventory tabs …" | list: `day6d/screens/sales-en-light-1440.png`, `requests-en-light-1440.png`; empty, error: none |
| Sales sections on a lead | StockTabSkeleton | "No sales …", "No stock held …", "No requests …" | ListState error + Try again | sales.spec `empty_sections_and_palette_record_sale` | list: `day6d/screens/lead-stock-en-light-1440.png`; empty ("No requests…", "No stock held…"): in `day7b/screens/state-share-links-error-en-light-1440.png`; error: none |
| Share links | bar skeleton | "No active link for this client" | "Couldn't load the links" + Try again (now an alert) | day7b "list states: lead …" | empty: `day6d/screens/lead-stock-en-light-1440.png`; error: **`day7b/screens/state-share-links-error-en-{light,dark}-{390,1440}.png`** (new); loading: none |
| Past imports (leads) | server (`leads/import/loading.tsx`) | "No imports yet" | "Couldn't load past imports" + Try again | import.spec (empty); **day7b "list states: past lead imports and past stock imports …"** (an unfinished upload; every server action on the page cut, as tasks.spec cuts them; Discard fails and so does the `listImports` refresh after it; Try again brings the list back) | list: `day3b/screens/import-choose-en-light-1440.png`; empty, error: none |
| Past stock imports | 3 rows | "No stock sheet imported yet" | error + Try again | day7b "list states: Inventory …" (empty); **day7b "list states: past lead imports and past stock imports …"** (the same with `listStockImports`) | list: `day6c/screens/choose-en-light-1440.png`; loading, empty, error: none |
| Team | `more/team/loading.tsx` | "No one here yet" (cannot happen: the viewer is always listed) | server read error + Retry | team-screens "team route skeleton"; error: **no browser test** (accepted residual: a server-component read, which a browser test cannot fail without a server switch) | loading: `team/screens/team-skeleton-en-light-1440.png`; error: none |
| More (skeleton) | `more/loading.tsx`, Administration for admins only | n/a | n/a | day7b "skeleton: More draws Administration for admins only" | **`day7b/screens/state-more-skeleton-admin-en-{light,dark}-{390,1440}.png`** and **`state-more-skeleton-rep-…`** (new; only the admin's has Administration); earlier `day4c/screens/more-skeleton-en-light-1440.png` |

Paths are under `docs/evidence/`. "none" means no screenshot of that state was taken on any day; the test named in the
row still reaches it. The four new sets (16 shots: EN, light and dark, 390 and 1440) come from `day7b.spec.ts` "state
screens", skipped unless `DAY7B_SCREENS=1` (no CI cost); local run 16 Oct, 4 passed, each shot checked for console
errors and sideways scroll, and looked at by eye.

## Screenshots: each picker closed and open, and the changed screens whole

`tests/auth/day7b.spec.ts` "screens: …", one test per picker; each shot is the picker and its panel with 24 px around
them, after a check for console errors and sideways scroll. Files: `docs/evidence/day7b/screens/<picker>-<en|fr>-<light|dark>-<width>-<closed|open>.png`
at 390, 768, 1024, 1280, 1440 and 1728 (8 pickers × 2 languages × 2 schemes × 6 widths × 2 states = **384 shots**).

The changed screens whole: `day7b.spec.ts` "changed screens" (Leads with its search, Add lead, lead Details with Next
call, lead Stock with Link options, Tasks quick add with a picked day, Inventory's toolbar, More with Time zone):
`screens/screen-<name>-<en|fr>-<light|dark>-<width>.png`, the visible screen at the same six widths, with the picker's
field scrolled to the middle (7 × 2 × 2 × 6 = **168 shots**). Every shot asserts no console error and no sideways
scroll.

**CI cost unchanged.** CI still takes the picker shots at 390 and 1440 only (the 128 it took before); the other widths
come from `DAY7B_WIDTHS`, and the whole-screen group is skipped unless `DAY7B_SCREENS=1`. Local evidence run (15 Oct,
isolated stack, Chromium 141): `DAY7B_WIDTHS=390,768,1024,1280,1440,1728 DAY7B_SCREENS=1 npx playwright test
tests/auth/day7b.spec.ts -g "screens: |changed screen"`, 15 passed in 10.5 min, 552 shots, committed under
`screens/` (18 MB). Retaken after the audit fixes: 35 of the earlier 128 shots changed (the Combobox's new focus
line; the calendars' today mark, now 16 Oct in Paris; small anti-aliasing differences), the other 93 are byte-identical.

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
| `stock-import.spec.ts` | `toHaveValue("fr"/"en")` on the Number style ×3 | `expectChosen` (found by this round's run, 747e17a) |
| `import.spec.ts` | `selectOption` ×12, `toHaveValue` on selects ×11, `inputValue()` | `choose(trigger, value)`, `expectChosen(trigger, value)` (the trigger's `data-value`, same value the hidden input submits), `getAttribute("data-value")` |
| `import-perf.spec.ts` | `select[aria-invalid]` + `selectOption` | `[role=combobox][aria-invalid]` + `choose`, looping until none is left |
| `screens.spec.ts` (lead import) | same as import-perf, ×2 | same as import-perf |
| `lead-page.spec.ts` | `selectOption("America/Chicago")`; `toHaveValue` on the native Next call field | `choose`; the hidden `next_action_at` input; focus still asserted on the field |
| `leads.spec.ts` | `selectOption` ×3 | `choose` ×3 (status by value, owner by words, country by value) |
| `lead-deals.spec.ts` | `selectOption` ×2 | `choose` ×2 |
| `tasks.spec.ts` | `fill` on the native date field; `selectOption` on the zone; a made-up `<option>` injected into the page to prove the server refuses an unknown zone | `pickDate`; `choose`; the save request is rewritten to the unknown zone on its way to the server, which still refuses it (the app's list can no longer be given an option in the page); `getByLabel("Time")` → `getByRole("combobox", { name: "Time", exact: true })` (the clock button's label also contains "time") |
| `home.spec.ts` | `toHaveAttribute("title", /\d/)` on Recent activity's time | the sr-only full time inside `<time>` has a digit, and no `title` |
| `lead-page.spec.ts` (advisor round 1) | `getByLabel("Next call", { exact: true })` | `getByRole("combobox", { name: "Next call", exact: true })`: the time box is now labelled by the same label plus "Time", so `getByLabel` found both |
| new `day7b.spec.ts` | | keyboard runs, list states, skeletons, screenshots; picker shot widths from `DAY7B_WIDTHS` (CI default 390 and 1440), whole changed screens and the list-state shots behind `DAY7B_SCREENS=1` (local evidence only); advisor round 1: error-plus-retry for lead tasks and both Past imports lists, the Next call date found by role combobox, its time box's name checked |
| new `tests/unit/native-controls.spec.ts` | | the source check, plus `native-leave-prompt` cases and the `ALLOWED` count (one kept use; a second or none fails); advisor round 1: planted breaks for `title=` on an unlisted component, a computed input `type`, and scope-aware `confirm`/`alert`/`prompt` (16 tests) |
| `tests/unit/pickers-render.spec.ts` (advisor round 1) | | the date triggers are comboboxes with a dialog popup and `aria-required`; DateTimePicker passes `required` to both halves and names its time box from the label plus "Time" |

## Audits (CLAUDE.md, every UI change)

Both run on the pickers and the changed screens, from the code and the 552 screenshots.

- **Apple design** (`apple-design-audit.md`; anthropic-skills:apple-design and `docs/apple-design-audit.md`'s 12
  items): three findings, all fixed in f3c98bc: (1) the field triggers (Select, Combobox, DatePicker, DateRangePicker)
  had no hover answer: their border now darkens on hover, not when disabled or invalid; (2) the Combobox's search box
  had no visible focus: the line under it takes the ring colour; (3) a Disclosure summary had no hover answer: its
  chevron darkens. Everything else passes (press feedback, settle from the trigger, reduced motion, solid panels, DM
  Mono digits, French without clipping, status never colour-only, focus back to the opener).
- **Web Interface Guidelines** (`web-guidelines-audit.md`; `.claude/skills/web-design-guidelines`, rules fetched from
  the pinned commit 434b7f9): the same three findings (hover on clickable buttons and summary, no `outline-none`
  without a replacement), fixed; accepted with reasons: two lists not virtualised (time zones 419, quarter hours 96),
  the kept `beforeunload` prompt (the rules ask for it), `type="text" role="searchbox"` (no native search field), and
  pattern placeholders without "…".
- **Combobox open time** (scratch Playwright probe on the isolated production build, 1440 × 900, More > Time zone, 7
  presses each, press to the first painted list): 419 options; CPU ×1: median **46 ms** (39 to 76); CPU ×4: median
  **242 ms** (217 to 402). Open item 4.

## Checks

Re-run on 15 and 16 Oct 2026 on the merged code (head a62b405 plus the stock-import.spec fix 747e17a), on this
builder's own isolated stack: Postgres 54570, GoTrue 9992, gateway 54571, Next 3600 (production build with that
stack's keys; a copy of `scripts/local-auth/start.sh` and `gateway.mjs` with those ports, scratch under
`/tmp/day7b-builder`), Chromium 141 (`/opt/pw-browsers/chromium-1194`). The Next build was redone after the second
Day 7a merge (arrival focus); specs that could see that change (team, team-screens, day7a, day7b, shell, queue,
stock-import and the batch below) ran on the new build.

| Check | Result |
|---|---|
| `npm run lint` | 0 errors (3 warnings, all existing: `useVirtualizer` in check-step, stock-table, leads-table) |
| `npm run typecheck` | pass |
| `npm run check:native` | 0 findings (the import's "Leave site?" prompt is the one `ALLOWED` use) |
| `npm run test:unit` | **644 passed** (incl. `native-controls.spec.ts` 13, `rate-limit.spec.ts`, `messages.spec.ts`) |
| `DB_TEST_PORT=54598 scripts/db-test.sh` | **all 26 suites pass** (7a's `day7a_attack` included), advisors **0 ERROR**; 3 WARN, all known and by design (anon EXECUTE on `share_view`/`share_request`, authenticated on `set_user_role`); INFO unindexed_foreign_keys 8 (Day 7a's accepted composite keys), unused_index 11 |
| `day7b.spec.ts` | 19 passed (5 keyboard-only, 4 list states, 2 skeletons, 8 picker screenshot tests at the CI widths); the evidence run: 15 passed (8 picker tests at six widths, 7 changed screens) |
| `day7a.spec.ts` | 6 passed (its users have fixed emails, so the re-run on the same database needed them removed first; CI starts fresh) |
| `pipeline.spec.ts` | 18 passed (PR #17's column height, `initialOffset` and `readScope` tests included) |
| `files.spec.ts` | 13 passed, 5 storage-only skipped (CI only) |
| `leads.spec.ts` / `lead-deals.spec.ts` / `lead-page.spec.ts` | 9 / 9 / 26 passed |
| `tasks.spec.ts` / `home.spec.ts` / `inventory.spec.ts` | 12 / 15 / 11 passed |
| `shell.spec.ts` / `sales.spec.ts` / `team.spec.ts` / `day4-security.spec.ts` | 21 / 11 / 5 / 9 passed |
| `import.spec.ts` | 11 passed (run alone: it counts every lead in the database) |
| `stock-import.spec.ts` | **failed first** on `toHaveValue` on the Number style (now the app's Select; the previous round had not run this spec); fixed in 747e17a with `expectChosen`, then 6 passed |
| `queue.spec.ts` | 20 passed without `call_keeps_claims`; that test fails on this machine before and after this step (this Chromium fires one `beforeunload` for two quick `tel:` links; recorded the same way in `docs/evidence/day5c/README.md`), left to CI |
| `day5-screens.spec.ts` / `home-screens.spec.ts` / `team-screens.spec.ts` | 5 / 4 / 4 passed |
| `screens.spec.ts` | 15 passed |
| `day5-security` / `import-security` / `files-screens` / `pipeline-multi` / `queue-multi` | 6 / 3 / 3 / 1 / 1 passed |
| `share.spec.ts` | 12 passed with a scratch copy that reads port 3600 where the spec hard-codes `localhost:3100` (unchanged spec: only those origin assertions differ here) |
| `journey.spec.ts` | not run: needs Mailpit, which this container lacks; CI runs it |
| `import-perf.spec.ts`, `*-perf`, `day4-chunks` | skipped without `PERF=1`, as in CI |
| WebKit | not run (not installed here; CI runs it in two shards) |

### Checks, advisor round 1 (16 Oct 2026)

Head 7f97e87 and after (code unchanged since), same isolated stack (54570/9992/54571/3600; restarted once after the
container restart, with a fresh production build), Chromium 141.

| Check | Result |
|---|---|
| `npm run lint` | 0 errors (the same 3 existing `useVirtualizer` warnings); also run by the pre-commit hook on every commit |
| `npm run typecheck` | pass (pre-commit hook and by hand) |
| `npm run check:native` | **0 findings** with the stricter rules |
| `npm run test:unit` | **649 passed** (644 before + 3 in `native-controls.spec.ts`, now 16, + 2 in `pickers-render.spec.ts`) |
| `day7b.spec.ts` | **21 passed**, 11 skipped (the evidence-only groups), twice (before and after the restart); the 3 new error-state tests included. Evidence: `DAY7B_SCREENS=1 -g "state screen"`: 4 passed, 16 shots |
| Specs with a DatePicker or DateTimePicker | `lead-page` 26, `inventory` 11, `sales` 11, `pipeline` 18, `lead-deals` 9, `queue` 20 (without `call_keeps_claims`, which fails on this machine before and after this step, see above), `tasks` 12, `screens` 15: **122 passed, 0 failed** (the first batch was cut by the container restart after 105; `tasks` and `screens` were run again in full on the restarted stack) |
| gitleaks 8.28.0, a2c05a8..HEAD | no leaks (46 commits) |
| npm audit (runtime, high) | 0 vulnerabilities |
| Semgrep | not run here (registry blocked by the proxy); CI job `semgrep` |
| WebKit, `journey.spec.ts` | not run (not installed / needs Mailpit); CI runs them |

## Deviations and choices

- TimePicker's English clock changed from 12-hour to 24-hour (the app's Day 4b decision); `pickers.md` updated.
- The Combobox trigger now has `role="combobox"` (was a plain button with a dialog popup), so every picker is reached
  the same way by screen readers and tests; Down/Up open it.
- The layout's `data-role` attribute exists only to shape a skeleton. The role is no secret to the person signed in
  (the command menu already hides admin commands from others); every page and the database still check it.
- Screenshots are clipped to the picker and its panel (24 px margin) instead of the whole screen, to keep the evidence
  small (128 shots).
- The changed-screens shots and the extra widths are a local evidence run, not CI (keeps the Actions budget; plan
  question 12).
- `check:native` allows exactly one native popup (`ALLOWED`); any other needs a new decision and an entry there.

## Advisor round 1 (16 Oct 2026): CHANGES NEEDED, fixed

1. **Three reachable error states now have browser tests** (`day7b.spec.ts`): lead tasks (the `/api/leads/<id>/tasks`
   route answers 500; a date chip adds a task and `refreshLead` invalidates the tasks; the alert shows; Try again shows
   the task), past lead imports and past stock imports (an unfinished upload inserted for the test; every server action
   on the page aborted with the same `next-action` POST interception tasks.spec uses; Discard fails and so does the
   `listImports` / `listStockImports` refresh after it; the alert shows; Try again brings the list back). Only Team stays
   an accepted residual (open item 3).
2. **Security evidence**: section "Security" below.
3. **A screenshot per list state**: the Screenshot column in "List states", and 16 new shots behind `DAY7B_SCREENS`
   for the states 7b changed (Recent activity's 8 rows, More's skeleton for an admin and for a rep, the share links'
   error). Taking them showed the More skeleton check must use visibility for the rep: the admin block is in the rep's
   page too, hidden by CSS, so `toHaveCount(0)` waited for the page (the existing test already used `toBeHidden`).
4. **ARIA**: the non-typed DatePicker and the DateRangePicker triggers are `role="combobox"` (as Select and Combobox),
   so their `aria-required` is allowed; Radix keeps `aria-haspopup="dialog"` and `aria-expanded` (APG date picker
   pattern). DateTimePicker already passed `required` to both halves (now unit-tested). Tests that looked for these
   triggers by role "button": `day7b.spec.ts`'s date-time-picker shot (now `combobox`); no other spec did.
5. **`check:native` fails closed** (rules table above): `title=` on any capitalised component outside `TITLE_PROP`
   (the 15 components named by the advisor; a scan of `src/` found exactly these 15 given `title=`, each with its own
   `title` prop drawn as text); a non-literal `type` on `input`/`Input` (`input-type-computed`); `confirm`/`alert`/
   `prompt` resolved by scope (enclosing functions, blocks, parameters, catch, hoisted `var`, imports), plus
   `window["alert"]`, destructuring from the global object and passing the global as a value. One planted-break unit
   test each. Run over `src/`: **0 findings**, so no code needed fixing; over a2c05a8: still 88 in 44 files.
   Not covered (recorded): a `type` arriving through a spread (`<input {...props} />`); `src/components/ui` stays exempt.
6. **Attribution**: the `docs/log.md` row is now Who = builder, "taken under Haider's standing instruction; Haider to
   confirm"; the comments in `check-native-controls.mjs` (`ALLOWED`) and `import-workspace.tsx` say the same. The
   enforcement is unchanged (`ALLOWED`, count 1).
7. **Minor**: `web-guidelines-audit.md` now cites `search-input.tsx:55` (and `import-workspace.tsx:192`, moved by the
   comment); the 87/43 note above says it excludes the kept prompt (88/44 with today's rules); DateTimePicker takes
   `labelId` and names its time box with `aria-labelledby` = the field's label + a hidden "Time", so lead Details reads
   "Next call Time" (the accessible name joins the two with a space; a comma would need a second message string, not
   worth it).

## Security

Range a2c05a8..HEAD (Day 7b, and Day 7a brought in by the two merges).

**/security-review** (done by hand following its method, 16 Oct; the 7b-only part is `git diff 2e90b7a HEAD`, 68
files, plus this round):

| Area | Finding |
|---|---|
| Injection | No new server action, API route or RPC (the rate-limit route scan holds 19 + 12). No user text reaches a PostgREST filter: the Combobox filters its options in the browser; SearchInput feeds the same `q` the existing routes already pass to RPCs. `check-native-controls.mjs` only parses repository files, never runs them. Test-only `sql()` strings use run ids and constants on the local stack (helpers refuse non-local URLs). |
| Authz | The app layout's `data-role` only shapes More's skeleton; the role is not a secret to the signed-in person, and every page, action and RLS policy checks it again. No authorisation moved to the client. |
| Input validation | Forms set `noValidate` and the auth fields dropped `required`/`pattern`/`minLength`: every auth action (`src/app/(auth)/actions.ts`) and the More actions still `safeParse` with Zod; hidden inputs carry the old value shapes into the same schemas (tasks.spec proves the server refuses an unknown zone sent past the picker). |
| XSS | No `dangerouslySetInnerHTML`, `innerHTML`, `eval` or `new Function` added; tooltips, disclosures, option labels and the new hidden "Time" span are React text. Lead links use server ids (`/leads/<uuid>`). |
| Secrets | None added; no env var read in client code; gitleaks clean (below). |
| Data exposure | No new data reaches the browser; errors shown are message keys, never raw errors. Day 7a's parts in the range (per-person list limit, auth cookie flags, sign-in audit rows via a security-invoker RPC with a definer guard and `search_path = ''`) were reviewed in Day 7a's own step and re-read here: no issue. |

Result: **no finding**.

- **gitleaks 8.28.0** (the Day 7c builder's binary, read-only use), `gitleaks git --log-opts="a2c05a8..HEAD"` with the
  repo's `.gitleaks.toml`: **no leaks found** (re-run after this round's commits, see "Checks, advisor round 1").
- **Semgrep 1.180.0** is installed, but the rule registry (semgrep.dev) is blocked by this container's proxy (403), so
  the CI `semgrep` job runs it (`p/default`, `p/typescript`, `p/nextjs`, `--error`).
- **npm audit** (`--omit=dev --audit-level=high`): **0 vulnerabilities** (the advisor's run: 0 high; re-run 16 Oct).

## Open items

1. **Not pushed, no PR** (as asked). CI has not run this code. The advisor's first review (CHANGES NEEDED) is answered
   in "Advisor round 1" below; it has not been re-run on this round yet.
2. **WebKit** was not run locally (Chromium only, as asked); the picker keyboard runs are Chromium only.
3. **Error state with no browser test: Team only** (accepted residual). Its list is read by the server component
   (`more/team/page.tsx`), so only a failed server read shows the error, which a browser test cannot cause without a
   server switch. Lead tasks, past lead imports and past stock imports are read again in the browser after the page
   loads, and now each has an error-plus-retry test in `day7b.spec.ts` (advisor round 1).
4. The time zone Combobox (419 options, cmdk, not virtualised) paints its list 46 ms after a press on this machine but
   about 240 ms with the CPU slowed 4× (a slow phone); the press itself answers at once. Left for the Day 7c phone
   pass (render the list lazily or virtualise it); recorded in `web-guidelines-audit.md`.
5. `import-perf.spec.ts` was not run locally (speed run, `PERF=1`; only the import status menus changed in it); `journey.spec.ts` needs Mailpit (CI only).
6. CI time: `day7b.spec.ts` adds about 5 minutes to a Chromium auth-journey half (about 2.5 for the 128 shots), the
   same as before this round; the extra widths and whole screens add nothing to CI. The 128 CI shots could move behind
   `DAY7B_WIDTHS` too if the Actions budget runs low (plan question 12).
7. Pages not photographed whole: the lead import's Match step (needs a file upload; its Combobox is the same component
   as More's and `import.spec.ts` drives it), the deal sheets and the sale/hold sheets (need made-up deals and stock;
   their Selects and DatePickers are the same components as in the picker shots).

## Decided

- **The browser's "Leave site?" prompt during a lead import STAYS**: the builder's decision, taken under Haider's
  standing instruction to take the builder's recommendation; **Haider to confirm** (`docs/log.md` 15 Oct). A web page cannot replace it with its own dialog when the tab is
  closing; without it a closed tab pauses the import silently (it can be resumed from Past imports). It is the only
  native popup left; `check:native` allows exactly that one use (`ALLOWED`, with the reason in a comment) and fails on
  any other.
