# Day 4d: Apple design audit (Files tab)

Skill `anthropic-skills:apple-design` (fluid interfaces: motion from the current value, interruptible, velocity and
springs; feedback; spatial consistency; restraint; materials; typography; reduced motion), applied to
`src/components/files/files-tab.tsx` and the screenshots in `screens/` (42 shots: the list at 390, 768, 1024, 1280, 1440
and 1728 in light and dark, English and French; the empty state, refused uploads, the delete confirmation, the row menu
and the unavailable page at 390 and 1440), 12 Oct 2026. DESIGN.md stays the source of truth.

## What holds

- **Restraint and hierarchy.** One card, the same surface and radius (20 outer, 12 inner) as the lead page's other
  cards; the drop zone is a dashed outline, not a second card; Signal Red is not used on this tab (Call keeps it); the
  only filled button is the neutral "Choose files"/"Add file". Status is a dot plus a word ("Couldn't finish deleting",
  amber dot; refusals, red dot).
- **Feedback within 100 ms.** Every button and the row menu scale to 0.97 on press; dropping highlights the zone at once;
  a chosen file shows its row immediately with the refusal or the progress bar (the checks before upload are local).
- **Motion from the current value, interruptible.** The progress bar animates `scaleX` with the `smooth` spring from
  wherever it is to the next reported fraction, so a burst of progress events retargets it instead of queueing; Cancel
  stops it at once. New rows rise 8 px and fade in; when a row leaves, the others move into place with layout
  transforms. Only transform and opacity animate.
- **Reduced motion.** No rise, no layout move, progress jumps; the drop-zone highlight is a colour change only.
- **Spatial consistency.** The tab sits between Stock and Details; the pill slides to it like the other tabs; a deep link
  to `?tab=files` scrolls the phone tab strip so "Fichiers" is whole (fixed in this round, below).
- **Typography.** Outfit for names and labels, DM Mono for sizes and the team space; long names keep their end visible
  (the stem truncates, the extension stays: "Catalogue complet des… .pdf"); French wraps where it is longer (limits on
  two lines at 390).
- **Touch.** 44 px targets on phones (Add file full width, row menus, dismiss, Retry), checked by
  `phone_390_files`; the delete confirmation is a bottom sheet on phones, a centred dialog from 640 px.
- **Dark mode.** The same tokens: the tile and drop-zone outline stay visible on the dark card, the menu uses the card
  material with its border.

## Findings and fixes (this round)

| # | Finding | Fix |
|---|---|---|
| 1 | At 390 a deep link to the Files tab left the selected "Fichiers" cut at the strip's edge (also Day 4b's "Détails" note) | `TabList` scrolls its own strip (never the page) so the selected tab is whole, on load and on every change; e2e check in `phone_390_files` |
| 2 | A refused file that was "not really a PDF" read the generic line, and sizes under 1 kB read "10 byte" | The refusal names the kind (PDF, photo, Word, Excel) with the next step; sizes under 1 kB read "1 kB" |
| 3 | File names were read as two words by screen readers ("Devis printemps 2026 .pdf"), because the stem and the extension are two flex items | One visually hidden full name; the two visible parts are hidden from assistive technology |

## Kept as they are (with reasons), for Day 7 polish

- The drop zone highlights by colour only while a file is dragged over it; a small lift (scale 1.01) would add depth,
  but the zone is a large target and colour is enough feedback here.
- The progress spring can overshoot by a hair past the reported fraction at the very end; the track clips it and the row
  turns to "Checking the file…" in the same moment.
- Rows have no swipe-to-delete on phones (design section 12: no swipe gestures until Day 7, accidental deletes).
- In full-page screenshots the floating dock sits over the last rows: it is fixed to the viewport, as on every screen
  (the page itself scrolls them clear).

Unresolved: none.
