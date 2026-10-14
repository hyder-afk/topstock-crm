# Day 5b web interface guidelines audit (Skill `web-design-guidelines`)

Rules: `vercel-labs/web-interface-guidelines` at the pinned commit 434b7f91364665f2f733b310ec54809bf8f37937
(`command.md`, fetched 14 Oct 2026). Files: `src/components/pipeline/*.tsx`, `src/components/lead/deals-tab.tsx`,
`deal-chip.tsx`, `deal-summary-card.tsx`, `src/components/activity/call-panel.tsx` (the Day 5b part). Run on 42fda4c's
parent, fixes in 42fda4c, d066c8e and the layout commit after it.

## Findings

src/components/pipeline/open-deal-sheet.tsx
- 180, 253, 263, 272, 280, 294, 308: inputs and selects without `name` → **fixed** (`lead_search`, `deal_title`,
  `deal_value`, `expected_close`, `contact`, `fulfilment`, `owner`)
- 219: `outline-none` on the lead results' options → kept: the option is the listbox's active descendant and shows
  `focus:bg-muted` as its replacement

src/components/pipeline/deal-sheet.tsx
- 466, 522, 588, 243, 284: fields without `name` → **fixed**
- close: focus returned to the page body when the sheet was opened from the lead page → **fixed** (focus goes back to
  the opener, or the deal's card or row)

src/components/lead/deal-chip.tsx
- 52: the composer's deal select without `name` → **fixed** (`about_deal`)

messages/en.json, messages/fr.json
- `Deals.fields.titlePlaceholder`: an example placeholder without the ellipsis → **fixed** ("e.g. Denim jackets, 2
  pallets…", "ex. Vestes en jean, 2 palettes…")

src/components/pipeline/deal-card.tsx, stage-stepper.tsx, board-toolbar.tsx, deal-sheet.tsx, closed-deals.tsx,
lose-dialog.tsx, win-dialog.tsx, src/components/lead/deals-tab.tsx
- transitions listed `transform` while the press writes the `scale` property (Tailwind 4) → **fixed**
- deal-card.tsx: the next-stage chip could overflow a narrow card (1024, French) → **fixed** (`min-w-0 truncate`, the
  value `shrink-0 whitespace-nowrap`)

src/components/pipeline/board.tsx
- drag: text could be selected during a drag → **fixed** (`select-none` while dragging)

src/components/pipeline/column.tsx, pipeline-skeleton.tsx
- the Lost line under the columns sat behind the floating dock at 768 and 1024 → **fixed** (the columns end 216 px
  above the viewport's bottom; the skeleton matches); the skeleton's phone stage tabs scrolled the page sideways at
  390 → **fixed** (`overflow-hidden`; found by the screenshot spec's sideways-scroll check)

src/components/activity/call-panel.tsx
- 473: the switch knob's transition ran under reduced motion → **fixed** (`motion-reduce:transition-none`)

src/components/pipeline/delete-dialog.tsx
- 24: `autoFocus` on Cancel → kept (justified: a destructive dialog starts on the safe choice)

## Checked and passing

- Icon-only buttons carry names (⋯ "More actions for {lead}", Close, the composer chip's ×, the header chip's
  "Show this lead's deals"); decorative icons are `aria-hidden`.
- Real links for navigation ("Open on the board", "Open lead", the dock); buttons for actions; no clickable divs.
- Every list has loading, empty and error states (board, columns, Show more, the Deals tab, the deal sheet, closed
  lists); skeletons, no spinners; errors carry a next step ("Couldn't load deals · Retry").
- Async updates announced politely (toasts), drag announcements assertive through dnd-kit's live region.
- Large lists virtualised (columns past 60 loaded cards); keyset pages of 50.
- Money and dates through `Intl` (`formatMoney`, next-intl `useFormatter`), French typography in messages.
- URL reflects state (`?deal=`, `?stalled=1`, `?new=1`, `?tab=deals&deal=`).
- Destructive actions confirm (Delete with a fresh code) or offer Undo (moves, opens, Interested).
- Touch: `touch-action: manipulation` on the card's main button; 44 px targets at phone width (stepper segments, chips,
  row menus, "Open a deal" full width at 390, checked in `lead-deals.spec.ts`); a tap and the keyboard can do whatever a
  drag does (stepper, Shift+arrows, digits, the menu).
- No `transition: all`, no zoom lock, no paste blocking, no `dangerouslySetInnerHTML`.

Unresolved: none.
