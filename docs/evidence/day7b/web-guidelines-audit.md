# Web Interface Guidelines audit: Day 7b pickers and their call sites, 15 Oct 2026

Skill: `.claude/skills/web-design-guidelines` (Vercel Web Interface Guidelines), rules fetched from the pinned commit
`vercel-labs/web-interface-guidelines@434b7f91364665f2f733b310ec54809bf8f37937/command.md` (191 lines, read in full).
Files: `src/components/ui/{select,combobox,date-picker,calendar,time-picker,date-time-picker,tooltip,search-input,
disclosure,picker-styles}.tsx|ts`, `src/app/globals.css` (focus, floating panels, safety net), and the 47 call-site
files Day 7b changed (list in `README.md`, "Call sites, before and after"), with the screenshots in `screens/`.

## Findings (fixed)

```text
## src/components/ui/picker-styles.ts
src/components/ui/picker-styles.ts:5 - field triggers (Select, Combobox, DatePicker, DateRangePicker) are buttons with no hover: state → border darkens on hover (enabled, not invalid)

## src/components/ui/combobox.tsx
src/components/ui/combobox.tsx:163 - search input focus-visible:outline-none with no replacement → wrapper line takes the ring colour (focus-within:border-ring, :152)

## src/components/ui/disclosure.tsx
src/components/ui/disclosure.tsx:23 - summary (clickable) has no hover state → chevron darkens on hover
```

## Findings accepted (with the reason)

```text
src/components/ui/combobox.tsx:178 - options.map without virtualisation: up to about 400 time zones / 250 countries. Measured: see "Combobox open time" below; cmdk filters in memory, the list scrolls in a 320 px box. Kept.
src/components/ui/time-picker.tsx:211 - 96 quarter hours, not virtualised; short rows, one scroll box. Kept.
src/components/import/import-workspace.tsx:192 - beforeunload prompt: the rules ask for it ("Warn before navigation with unsaved changes"); it is the one native popup kept (builder's decision under Haider's standing instruction, Haider to confirm; docs/log.md, 15 Oct). Allowed exactly once by check:native.
src/components/ui/search-input.tsx:55 - type="text" role="searchbox" instead of type="search": Haider's no-native-popups rule (no WebKit clear cross or history bubble); enterKeyHint="search" keeps the phone keyboard's Search key.
src/components/ui/date-picker.tsx:181, time-picker.tsx:146 - placeholders are the pattern ("dd/mm/yyyy", "hh:mm"), no "…": an example pattern, as the rules ask.
```

## Passes (summary by area)

| Area | Result |
|---|---|
| Accessibility | Icon-only buttons (calendar, clock, clear search, month arrows) carry `aria-label`; decorative icons `aria-hidden`; every picker is named by its `<label htmlFor>` (id on the trigger or text box) or `aria-label`; month heading `aria-live="polite"`; range picker's "Now choose the end date." in `role="status"`; Select/Combobox chosen option read as value; Combobox chosen option says "chosen"; real `<button>`s, no `div onClick` (time list rows are `role="option"` in a WAI-ARIA combobox with `aria-activedescendant`, keyboard on the field) |
| Focus | Global `:focus-visible` outline (2 px ring, offset 2); focus returns to the trigger on close (Radix), to the text box for a typed DatePicker; Escape in a picker inside a dialog closes only the picker (TimePicker stops propagation, task edit checks `defaultPrevented`); the floating dock does not cover an opened panel except the one 390 px Link options shot noted in the README |
| Forms | Hidden inputs keep the native `name` and value shapes; `autoComplete="off"` and `spellCheck={false}` on typed date/time and search; `inputMode="numeric"` on typed dates and 24-hour times; every form `noValidate`, errors in `FormMessage` (live region) with `aria-invalid`, first invalid auth field focused (`auth/forms.tsx:33`) |
| Animation | `transform`/`opacity` only (`settle-in`/`settle-out`, press scale); no `transition: all` (lists name `transition-transform`, `transition-[color,transform]`); transform origin from Radix; reduced motion honoured globally |
| Typography | "…" in "Choose…", "Search…", "Loading…" (EN/FR); DM Mono with even digits for dates, times and the calendar; headings balanced globally |
| Content | Trigger text `truncate` with `min-w-0` on the flex children; empty list "No match" / "Aucun résultat"; no date → "Choose a date" |
| Touch | `touch-action: manipulation` on body; tap highlight set; list rows 44 px on phones (`min-h-11`, 36 px from 640 px); `overscroll-contain` on lists; no `autoFocus` outside a just-opened panel or sheet (Day 6 sale sheets focus their first field) |
| Layout | No sideways scroll at 390 to 1728 in any shot (each shot asserts it); panels keep 16 px from the edges (`collisionPadding`) |
| Dark mode | `color-scheme` set per theme on `<html>`; no native `<select>` left to theme |
| i18n | Dates and times through `Intl` (month names, weekday letters, Monday first in both languages); patterns from messages |
| Hydration | Controlled inputs have `onChange`; the calendar's today comes from the given zone |
| Anti-patterns | none found (no zoom lock, no paste blocking, no `outline-none` left without a replacement, no unlabeled inputs) |

## Combobox open time

Measured on the isolated production build (Chromium 141, 1440 × 900), More > Time zone (419 options), press to the
first painted list, 7 presses each (a scratch Playwright probe, not committed): CPU ×1 median 46 ms (39 to 76), CPU ×4
(CDP throttling, a slow phone) median 242 ms (217 to 402). The press itself answers at once (scale 0.99). Over the
200 ms route-change budget only on the slowed CPU; left for the Day 7c phone pass (README open item 4).
