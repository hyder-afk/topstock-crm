# Apple design audit: Day 7f, a won deal that stock records hold, 16 Oct 2026

Checklist: `docs/apple-design-audit.md` (12 items) and the apple-design skill (anthropic-skills:apple-design: motion
starts from the current value, interruptible, calm, restraint, spatial consistency). Scope: the held state Day 7f adds,
in `src/components/pipeline/deal-sheet.tsx` (reason row where Reopen was, stepper off, the ⋯ menu without Delete),
`stage-stepper.tsx`, `deal-menu.tsx` (card menu without Reopen and Delete), `board.tsx` (Delete key) and
`src/components/lead/deals-tab.tsx` (row menu gone). Read from the code and from the 48 screenshots in `screens/`
(sheet, sheet menu and card menu at 1280, 1440, 1728 and 390; light and dark; EN and FR).

| # | Item | Finding | Fix |
|---|---|---|---|
| 1 | Instant response | The new "See the lead’s stock" control is a quiet button (`buttonVariants({ variant: "quiet" })`): it tints on hover and presses at once like the Reopen button it replaces. The disabled stepper does not react, which is right for a control that does nothing | none (after the row fix below) |
| 2 | Tracks the finger | Nothing new is dragged | none |
| 3 | Momentum | Nothing new moves on release | none |
| 4 | Interruptible | Menus keep Radix's settle; the items are chosen when the menu opens, so nothing appears or vanishes in an open menu | none |
| 5 | Rubber-band | The sheet keeps its native scroll with `overscroll-contain` | none |
| 6 | Animate from the current value | No new motion; the menus still open from their ⋯ buttons | none |
| 7 | Calm | No new motion, no new colour: the reason is muted text, no red, no badge (the deal is fine, only locked) | none |
| 8 | Reduced motion | Nothing added that moves | none |
| 9 | Materials and depth | Unchanged: the sheet and menus are the floating layers they were | none |
| 10 | Typography | Outfit, the sheet's text size; French "Des mouvements de stock retiennent cette affaire. Réglez-les d’abord." wraps on two lines at 390 and the button "Voir le stock du prospect" fits on one line, no clipping (`sheet-fr-*-390.png`) | none |
| 11 | Status never colour-only | The lock is said in words, and the stepper's disabled state is tied to those words for screen readers (see fix 2) | see fix 2 |
| 12 | Spatial consistency | **Finding 1: the first build put the reason and an inline link in a paragraph.** At 1440 the line broke early ("Sort them out / first.") and at 390 the 44 px inline link made the second line taller than the first, so the row no longer looked like the Reopen row whose place it takes | `deal-sheet.tsx:246-260`: the reason is the Reopen row's shape (`flex flex-wrap items-center gap-2`): the muted sentence, then a quiet button-styled link to the lead's Stock tab, 44 px tall on phones and 36 px from `sm` like the Reopen button |

Further look-throughs (restraint and focus, from the skill):

- **Finding 2, the stepper's lock was silent for screen readers.** Its radios turn disabled with nothing saying why.
  Fix: `stage-stepper.tsx:34` takes `describedBy` (the reason's id, `deal-sheet.tsx:235`) and `aria-disabled` on the
  group; e2e checks `aria-describedby` points at the reason (pipeline.spec and day7f.spec).
- **Finding 3, a leading separator in the card menu.** With Reopen hidden, a won deal's card menu (an editor's) began
  with the separator line that used to sit under Reopen. Fix: `deal-menu.tsx:103` draws the separator only under items
  that are drawn above it; day7f.spec and pipeline.spec check the menu's first child is a menu item
  (`card-menu-*.png`: Open lead, Copy link).
- **Finding 4, a dead end.** The reason said "Sort them out first." without saying where. Fix: the "See the lead’s
  stock" link (`/leads/<id>?tab=stock`, prefetched on pointer enter), new message `Deals.sheet.heldStock` in EN and FR.
- **The sheet's ⋯ menu with one item** (Copy link) is kept: the menu stays where people look for it, and Delete coming
  back when the stock records go is in the same place. Kept.
- **The lead's Deals tab** loses the row's ⋯ button on a held won deal (its only item was Reopen). The row keeps its
  height and the rest of its layout; open rows already have no menu. Kept.
- **Disabled look.** The stepper keeps its 60 % opacity for disabled (the same as for a person who may not edit), the
  current stage still filled, so the deal's stage stays readable. Kept.

Result: four fixes (row shape, stepper description, leading separator, next step link); everything else passes.
