# Day 7c part 2: web-design-guidelines audit of the French and phone pass (16 Oct 2026)

Skill: `.claude/skills/web-design-guidelines`, rules fetched from the pinned commit
`vercel-labs/web-interface-guidelines@434b7f91364665f2f733b310ec54809bf8f37937/command.md` (191 lines, HTTP 200,
sha256 `d246b026…0e0234`). Scope: every file part 2 changes (commits 107529e, 07b1599, 2e3e882) plus the screens they
sit on, read in code and in the 390 screenshots (`phone/`). Format as the rules ask (`file:line`, terse).

## messages/fr.json

messages/fr.json - FIXED: 12 numbers wrote thousands / units with ordinary spaces ("1 000 000 €", "15 Mo"): could
wrap mid-number; now U+202F thousands and U+00A0 before the unit, as Intl writes fr-FR (rule "Non-breaking spaces:
10&nbsp;MB")
messages/fr.json - "…" not "..." ✓ (now a test); curly apostrophes ✓ (test); « » with U+202F ✓ (test)
messages/fr.json - no English left: every value equal to English is on a named allowlist (brand, tagline, words spelt
the same, "pcs" per Haider 11 Oct) ✓ (test)

## src/app/global-error.tsx

src/app/global-error.tsx:10,13 - FIXED: French half of the bilingual fallback marked `lang="fr"` (screen readers
switch voice)

## src/components/home/today-card.tsx

src/components/home/today-card.tsx:59 - FIXED: task link 20 px tall on phones; pseudo-element hit area 44 px (row
height and skeleton unchanged); text keeps `truncate` inside, `min-w-0` on the flex child ✓

## src/components/home/attention-card.tsx

src/components/home/attention-card.tsx:30 - FIXED (Content Handling): French stalled reason truncated before the day
count; `line-clamp-2 text-pretty`, dot aligned to the first line

## src/components/leads/leads-toolbar.tsx

src/components/leads/leads-toolbar.tsx:39 - FIXED: icon-only Views / Columns 40 px wide on phones → `min-w-11`;
icon buttons keep their sr-only labels ✓

## src/components/ui/date-picker.tsx, time-picker.tsx, search-input.tsx

src/components/ui/time-picker.tsx:196 - FIXED: in-field button 40 px → 44 px on phones (flush right, field keeps
pr-12 so text never runs under it)
src/components/ui/date-picker.tsx:216 - FIXED: same
src/components/ui/search-input.tsx:88 - FIXED: same (clear button; field pr-11)
src/components/ui/time-picker.tsx:196 - icon button `aria-label` ✓, `transition-transform` listed ✓

## src/components/settings-bar.tsx

src/components/settings-bar.tsx:41 - FIXED: EN / FR segments 41-42 px wide → `min-w-11` on phones

## src/components/inventory/stock-table.tsx, stock-toolbar.tsx

src/components/inventory/stock-table.tsx:190 - FIXED: product name link 36 px tall → `min-h-11 justify-center`
(fits the 96 px phone row and the 64 px desktop row)
src/components/inventory/stock-toolbar.tsx:139 - FIXED: chip row snapped its first chip flush to the screen edge
(snap-start without scroll padding); `scroll-px-4` on phones; edge fade added

## src/components/activity/timeline.tsx

src/components/activity/timeline.tsx:788 - FIXED: entry menu's `-mr-1` put 4 px outside its `content-visibility:
auto` row, which clips paint and hit-testing: only 40 px tappable; margin on `sm` and up only

## src/components/pipeline/deal-sheet.tsx, board.tsx, board-toolbar.tsx

src/components/pipeline/deal-sheet.tsx:197 - FIXED: lead link in the sheet title 25 px tall → phone hit area 45 px
src/components/pipeline/board.tsx:761 - FIXED: a "·" separator was left hanging at a line end in French; on phones
the link takes its own line
src/components/pipeline/board.tsx:667, board-toolbar.tsx:94 - edge fades on the stage tabs and owner chips ✓

## src/components/queue/queue-workspace.tsx, src/app/(app)/leads/queue/loading.tsx

src/components/queue/queue-workspace.tsx:521 - FIXED: French "Les miens + sans responsable" broke the segmented
control into two uneven rows; phones: one row of three, middle label wraps (`text-balance`); skeleton matches
(loading.tsx:29)

## src/app/globals.css, src/components/ui/tabs.tsx (edge fades)

src/app/globals.css:45 - edge fade = mask only (no layout, no motion); scroll-driven, so reduced motion is not
affected and a strip that does not overflow has no fade ✓
src/components/ui/tabs.tsx:105 - `scroll-px-1` so the snapped first tab is not inside the fade ✓
src/components/ui/tabs.tsx:24 - FIXED (Focus States, "overlays must not cover the focused element"): a tab revealed by
the keyboard or a deep link could land inside the 24 px fade; `revealTab` now leaves the fade's width clear, except at
the strip's ends (where no fade shows)

## Checked, nothing to change

- Touch: `touch-action: manipulation`, tap highlight, `overscroll-behavior: contain` on the sheets and strips ✓
- Safe areas: header below a 47 px status bar, dock 16 px above a 34 px home indicator, deal sheet below the notch
  (now a CI test, `phone_safe_areas`) ✓
- Locale: dates and numbers through Intl (`useFormatter`, `formatMoney`); no hardcoded format in the changed files ✓
- No `transition: all`, no `outline-none` without replacement, no `user-scalable=no`, no new `autoFocus` ✓
- Hardcoded strings: none outside the ten named exceptions (now a test, `hardcoded-strings.spec.ts`) ✓

## Advisor round 1 additions (16 Oct 2026)

src/app/globals.css (`html:has([data-call-panel])`) - FIXED (Focus States: "overlays must not cover the focused
element"): the phone call panel hid controls reached with Tab; scroll-padding-bottom and main's padding follow its
height (ResizeObserver in call-panel.tsx); CI test `phone_call_panel_tab`
src/app/globals.css (`@utility edge-fade`) - FIXED (same rule): `scroll-padding-inline: 24px`, so a focused or snapped
chip stops clear of the fade; revealTab reads the real snap stops
messages/fr.json, messages/en.json - FIXED (Forms: placeholders show an example pattern, whole): inventory and leads
search placeholders were cut at 390 / 768; now measured in CI
src/components/inventory/bits.tsx:170 - FIXED (Content Handling): figure labels truncated; they wrap
src/components/share-links/sharing-settings.tsx - FIXED: client links' lead link 20 px with its tap area clipped by
`truncate`; 44 px on phones
src/components/inventory/stock-toolbar.tsx - FIXED: search below 1024 px takes its own row
