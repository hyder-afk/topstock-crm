# Day 7: the app's own pickers (no native pickers or popups)

Built 15 Oct 2026 by the builder on local branch `day7-local`, ahead of scope A step 7b (`plan.md` section 4).
Rule: Haider 15 Oct 2026, "do not keep any native pickers or popups on the app".
This step builds the replacement components in `src/components/ui/` and a CSS safety net. Call sites are switched in
7b on the combined code (Day 5, Team and Day 6 merged), so the switch there is mechanical. The guide below says what
changes at each kind of call site.

## What the audit found (combined code)

| Native thing | Count | Replaced by |
|---|---|---|
| `ui/select.tsx`: a styled native `<select>` with `<option>` children | about 37 call sites | `Select`, rewritten in place: same API, so these sites need no change (see "Select" below) |
| Raw `<select>` (e.g. `task-row.tsx`, `shell/timezone-form.tsx`) | 13 | `Select`, or `Combobox` for long lists |
| `<input type="date">`, `type="time"`, `type="datetime-local"` | 15 | `DatePicker`, `TimePicker`, `DateTimePicker` |
| `title=` tooltips | about 27 | `Tooltip` on focusable things; visible or screen-reader text elsewhere |
| Browser validation bubbles (auth forms, status menu, quick add, hold sheet lack `noValidate`) | 4 places | `noValidate` + Zod + `FormMessage` |
| WebKit clear cross on `type="search"` (`leads-toolbar.tsx` twice) | 2+ | `SearchInput` |
| `<summary>` disclosure marker (`queue-card.tsx`) | 1 | CSS safety net + our own chevron |

## What was built

| File | What |
|---|---|
| `src/components/ui/select.tsx` | Select rewritten as a Radix listbox (`@radix-ui/react-select` 2.3.7), drop-in for the native one |
| `src/components/ui/combobox.tsx` | Searchable picker: Popover + cmdk (already in the app, 1.1.1); accent- and case-blind search; optional server search |
| `src/components/ui/calendar.tsx` | The month grid (WAI-ARIA date picker dialog keys), used by the date pickers |
| `src/components/ui/date-picker.tsx` | `DatePicker` (button or typed text box + calendar) and `DateRangePicker` (from/to) |
| `src/components/ui/time-picker.tsx` | `TimePicker`: WAI-ARIA combobox, 15-minute list + typed time |
| `src/components/ui/date-time-picker.tsx` | `DateTimePicker`: DatePicker + TimePicker, value `YYYY-MM-DDTHH:MM` |
| `src/components/ui/tooltip.tsx` | `Tooltip`, `TooltipProvider` (`@radix-ui/react-tooltip` 1.2.16); the provider is in `src/app/layout.tsx` |
| `src/components/ui/search-input.tsx` | `SearchInput`: `type="text"` + `role="searchbox"` + our own clear button |
| `src/components/ui/picker-styles.ts` | Shared trigger, floating panel and list item classes (DESIGN.md tokens) |
| `src/lib/pickers/{calendar,time,options,event}.ts` | Pure rules: calendar matrix, min/max, typed date and time parsing, option-children parsing, time list, search score, the onChange event shape |
| `src/app/globals.css` | Safety net: hides `::-webkit-search-cancel-button` and the other WebKit search parts, removes `<summary>` markers; tooltip and select origins for the existing `.floating-content` animation |
| `src/components/ui/popover.tsx` | Exports `PopoverAnchor` (used by the typed date field and the time field) |
| `src/components/ui/form-message.tsx` | Comment: every form sets `noValidate`; errors live here and in `aria-invalid` |
| `messages/en.json`, `messages/fr.json` | New `Pickers` namespace (24 strings), parity checked by `tests/unit/messages.spec.ts` |

Shared behaviour, all components:
- **Forms.** `name` submits through `<input type="hidden" name=… value=…>`, in the value shape the native field gave
  (`YYYY-MM-DD`, `HH:MM`, `YYYY-MM-DDTHH:MM`, the option value), so server actions reading `FormData` and the Zod
  schemas do not change. `form=` and `disabled` pass to the hidden input.
- **onChange.** Called with `{ target: { name, value }, currentTarget: … }` when the person changes the value (not when
  a controlled `value` changes). Handlers written for the native field (`(e) => set(e.target.value)`) keep working;
  `onValueChange(value)` is there too.
- **No browser bubble.** `required` becomes `aria-required`; no native element carries `required`, `min`, `max` or
  `pattern`. Errors are ours: `aria-invalid` on the field (red border) and the text in `FormMessage`.
- **Labels.** `id` goes on the focusable trigger, so `<Label htmlFor={id}>` keeps naming it; every `aria-*` and
  `data-*` passes through (e.g. `data-focus="timezone"` in `details-tab.tsx`).
- **Look and motion.** Trigger is field height (44 px on phones, `min-h-11`), radius 12; panels are the solid card with
  border, shadow and radius 20, opening with the existing `settle-in` (transform + opacity) from the trigger, instant
  under `prefers-reduced-motion`. No Signal Red: selection uses the black/chalk primary, highlight uses `bg-muted`.
- **Phones.** Panels keep 16 px from the edges (`collisionPadding`, `max-w-[calc(100vw-32px)]`); list rows are 44 px
  high below `sm`; the typed fields use `inputMode="numeric"` where digits are expected.

### Select (`ui/select.tsx`)

Radix listbox. Keyboard as on a native select, also on the closed trigger: arrows, typeahead, Home/End, Enter/Space,
Escape. Reads the same `<option>` and `<optgroup>` children (fragments, arrays, `null` and `false` are fine; `disabled`
on an option or a group works; an option without `value` submits its text). Value rules match the native element: a
matching option wins; with no match the first enabled option shows and submits, unless `placeholder` is set and the
value is empty. `<option value="">` works (Radix forbids `""`, so it travels under an internal stand-in and comes back
as `""`). Extra props: `placeholder`, `onValueChange`, `contentClassName`.

Known detail: inside a `<form>` Radix also renders an inert copy of itself (`<select aria-hidden tabindex=-1>`,
visually hidden, **no name**, never opened, never submitted) for autofill. It is not a picker anyone sees. Tests must
not target it: e2e helpers click the trigger (`getByRole("combobox", { name })`) and then the option
(`getByRole("option", { name })`) instead of `selectOption`.

### Combobox (`ui/combobox.tsx`)

For long lists: countries, IANA time zones, teammates, deals. A field-like button (role `combobox`, a select-only
combobox whose popup is a dialog; Down or Up opens it; Day 7b) opens a popover with a search box and the list. Type to filter (accents and case ignored, every word must match the start of a word, a match inside a
word ranks lower), arrows move, Enter picks, Escape closes and focus returns to the button. Options by `options=[{
value, label, textValue?, keywords?, disabled? }]` or the same `<option>` children as Select. Server search: pass
`shouldFilter={false}`, `onSearchChange`, `loading` (skeleton rows, no spinner) and the rows you got, plus
`selectedLabel` for a chosen value that is not among them. Text: `placeholder`, `searchPlaceholder`, `emptyText`.

### DatePicker and DateRangePicker (`ui/date-picker.tsx`, `ui/calendar.tsx`)

A button shows the day in words ("jeu. 15 oct. 2026"), so 05/10 vs 10/05 is never ambiguous; it opens the month grid.
Grid: Monday first (`weekStartsOn`), month and weekday names from `Intl` in the page's locale, today marked (dot +
`aria-current="date"`, in `timeZone` if given), always 6 rows so the panel never jumps, days outside `min`/`max` dimmed
and `aria-disabled`, month buttons disabled at the bounds. Keys (WAI-ARIA date picker dialog): arrows a day or a
week, PageUp/PageDown a month, Shift+PageUp/PageDown a year, Home/End the start/end of the week, Enter or Space picks,
Escape closes; focus stays inside min and max. `typed` makes the field a text box in the locale's digit order
("15/10/2026" in French, "10/15/2026" in English) checked on blur or Enter, with Alt+Down or the calendar button for
the grid; an impossible or out-of-range day leaves the value empty and sets `aria-invalid` (the text stays). `clearable`
(default when not required) adds Clear. `DateRangePicker`: first pick is the start, second the end (either order),
`value={{ from, to }}`, `onValueChange`, hidden inputs via `fromName` and `toName`.

### TimePicker (`ui/time-picker.tsx`)

A WAI-ARIA combobox text box. Type "9", "915", "9:15", "9h15", "9:15 pm", or open the 15-minute list (`step`) with
Down, Alt+Down or the clock button; arrows and PageUp/PageDown move, Enter picks, Escape closes the list only (not a
dialog around it). Value always `HH:MM` 24-hour. Shows 24-hour in both languages (Day 7b: every time in the app is
24-hour, Day 4b decision 3); `hourCycle` can ask for the locale's own clock. `min`/`max` bound the list and the typed
time.

### DateTimePicker (`ui/date-time-picker.tsx`)

DatePicker + TimePicker in a `role="group"`. Value `YYYY-MM-DDTHH:MM`, or `""` while a half is missing (as the native
field). `min`/`max` take the same shape: their dates bound the calendar, their times bound the list on that first or
last day. `defaultTime` (e.g. "09:00") fills the time when a day is picked first. `id` goes on the date button.

### Tooltip (`ui/tooltip.tsx`)

Opens on hover after 500 ms (300 ms skip between neighbours) and at once on keyboard focus; closes on Escape, pointer
leave or blur; Radix links it with `aria-describedby` while it shows. Rules (in the file): a tooltip is a hint, never
the only name (icon buttons keep `aria-label`); only on focusable things; touch screens never show it, so nothing a
phone user needs may live only there. **A disabled button's reason must be visible text next to it**, never a tooltip
(a disabled button gets no hover or focus, and phones show no tooltips).

### SearchInput (`ui/search-input.tsx`)

`type="text"` + `role="searchbox"` + `enterKeyHint="search"`, an optional magnifier, and our own clear button (44 px
on phones) while there is text. Escape clears a filled box. The clear button fires a real React change event, so
`onChange={(e) => setSearch(e.target.value)}` handles both typing and clearing. `className` styles the input,
`wrapperClassName` the outer span, `label` gives an `aria-label` when no visible label names it.

### Safety net and forms

`globals.css` hides the WebKit search cancel/results parts on any `input[type="search"]` that slips back in, and removes
the `<summary>` marker (`list-style: none`, `::-webkit-details-marker`, `::marker`): a `<summary>` needs its own
chevron. Forms: every `<form>` gets `noValidate`; required, ranges and patterns are checked by the Zod schema and shown
in `FormMessage` with `aria-invalid` on the field (`ui/form-message.tsx` says so).

## Call-site migration guide (old → new)

| Old | New | Change at the call site |
|---|---|---|
| `<Select …><option …/></Select>` from `@/components/ui/select` | same | **None.** Optional: `placeholder` instead of a first `<option value="">` |
| `<select id name value onChange disabled className="…">` (raw) | `<Select id name value onChange disabled>` | Import `Select`; drop the field classes (width only via `className`); keep the `<option>`s |
| Raw or `ui` select with a long list (countries, ~400 zones, teammates, deals) | `<Combobox id name value onChange options={…} searchPlaceholder={t(…)} />` | Import; `<option>` children also work. For server search add `shouldFilter={false}`, `onSearchChange`, `loading`, `selectedLabel` |
| `<input type="date" name value min max onChange>` | `<DatePicker name value min max onChange />` | Same props; value stays `YYYY-MM-DD`. Use `typed` where people type dates fast (filters, quick add). Drop the field classes |
| Two date inputs for from/to (filters) | `<DateRangePicker value={{from,to}} onValueChange fromName toName />` | Handler takes `{ from, to }` |
| `<input type="time" name value onChange disabled aria-invalid>` | `<TimePicker name value onChange disabled aria-invalid />` | Same props; value stays `HH:MM`. `step` defaults to 15 |
| `<input type="datetime-local" id name value min max onChange>` | `<DateTimePicker id name value min max onChange />` | Same props and shape. `data-focus` passes through to the group; move it to the field you focus if needed |
| `<input type="search" …>` or `<Input type="search">` | `<SearchInput … />` | Remove `type`; remove a hand-made magnifier (`icon` draws it) and an Escape-to-clear handler (built in) |
| `title="…"` on a button, link or chip | `<Tooltip content="…"><button …/></Tooltip>` | Keep `aria-label` on icon buttons |
| `title="…"` on text (`<time title={absolute}>`, a name) | Visible text, or `<span className="sr-only">` | Do not make text focusable just for a tooltip |
| `title` explaining a disabled button | Visible text beside it, linked by `aria-describedby` | Never a tooltip |
| `<form>` without `noValidate`, `required`/`min`/`max`/`pattern` on inputs | `<form noValidate>` + Zod + `FormMessage` + `aria-invalid` | Keep `required` only as `aria-required` (the pickers do this) |
| `<summary>` with the browser triangle | `<summary>` + our own `ChevronDown` (rotates on `[open]`) | The marker is already hidden globally |
| `<label>` wrapping a native date/time input | Prefer `<Label htmlFor={id}>` + `id` on the picker | Wrapping still names the trigger, but `htmlFor` is clearer |

**Tests at the call sites (7b).** Replace `page.selectOption(…)` (21 uses in `tests/auth/screens`, `import`,
`import-perf`, `lead-page`, `leads`, `tasks`) with a click on `getByRole("combobox", { name })` and then
`getByRole("option", { name })`; replace `fill("2026-10-15")` on a date field with the calendar or the `typed` text
box; assert submitted values through the hidden input or the server result. Add a source check that fails on
`<select`, `type="date|time|datetime-local|search"` and ` title=` in `src/` outside `components/ui`.

## Dependencies added (exact pins)

| Package | Version | Why |
|---|---|---|
| `@radix-ui/react-select` | 2.3.7 | Select listbox; same Radix family as the installed popover 1.1.23 and dropdown-menu 2.1.24 (react-primitive 2.1.10, react-slot 1.3.3, popper 1.3.7, dismissable-layer 1.1.19 deduped) |
| `@radix-ui/react-tooltip` | 1.2.16 | Tooltip; same family |

Also pulled in: `@radix-ui/number`, `@radix-ui/react-use-previous`, `@radix-ui/react-visually-hidden` (lockfile).
cmdk 1.1.1 was already a dependency. Context7 was read for Radix Select (value rules, `position="popper"`,
placeholder), Radix Tooltip (provider delays, `data-state` values, origin variable, keys) and cmdk (filter signature
with keywords, `shouldFilter`, controlled search).

## Evidence (15 Oct 2026, `day7-local`)

| Check | Result |
|---|---|
| `npm run typecheck` | pass |
| `npm run lint` | 0 errors (2 warnings, both existing, not in these files) |
| `npm run test:unit` | all pass, incl. `tests/unit/pickers.spec.ts` (calendar matrix, arithmetic, min/max, focus keys, typed dates per locale, time list, typed times, option-children parsing, value resolution, search score) and `tests/unit/pickers-render.spec.ts` (server render of every component in EN and FR: no native select/date/time/search input or `title`, hidden input name and value shape, `id` and `aria-*` on the trigger) |
| `npm audit --omit=dev` | 0 vulnerabilities. Full `npm audit`: the 5 known high advisories in dev-only lint tooling (`braces` via `eslint-config-next`, logged 9 Oct); the new packages add none |

Not done here (7b, on the combined code): browser screenshots and the `/apple-design` and web-design-guidelines audits
of each picker at the call sites, keyboard-only runs in Chromium and WebKit, and the e2e moves above.
