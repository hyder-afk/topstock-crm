# Day 4d: Apple design audit (Files tab)

Skill `anthropic-skills:apple-design` (fluid interfaces: motion from the current value, interruptible, velocity and
springs; feedback; spatial consistency; restraint; materials; typography; reduced motion), applied to
`src/components/files/files-tab.tsx` and the screenshots in `screens/` (66 shots: the list at 390, 768, 1024, 1280, 1440
and 1728 in light and dark, English and French; the empty state, refused uploads, the delete confirmation, the row menu
and the unavailable page at 390 and 1440; since verifier round 2 an upload's line while uploading, while checking and
after a failed check at 390 and 1440 in light and dark, English and French), 12 Oct 2026. DESIGN.md stays the source of
truth. Re-checked against the new shots after verifier round 2 (section at the end).

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
- **Touch.** 44 px targets on phones: Add file (full width), row menus, dismiss, Try again, the whole file row (the
  name's link is stretched over the line on phones) and the stuck delete's Retry (44 by 44 since verifier round 2; the
  first audit claimed it without measuring it). All measured by `phone_390_files`. The delete confirmation is a bottom
  sheet on phones, a centred dialog from 640 px.
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

## Verifier round 2 (findings 13 to 18 of `day4d-findings.json`): re-checked against the new shots

The first audit described the progress bar without a screenshot of it, which is how its invisible light-mode track was
missed. The upload shots (`files-uploading-*`, `files-checking-*`, `files-failed-*`) now show each state.

| # | Finding | Fix | Seen in |
|---|---|---|---|
| 15 | The progress track (`bg-background` #F5F3EF) on the upload line (`bg-muted/60` on white, about #F3F1EE) was about 1.02:1: a 30% bar read as a black line from nowhere | The upload line is the card colour with a border token, and the track is the muted surface (DESIGN.md: "Muted surface (wells, tracks)"), 8 px tall as the import bar: #EBE8E2 on #FFFFFF (about 1.2:1, the same as the import's `ProgressBar`) in light, #2A2A30 on #1C1C21 in dark; the bar itself is TopStock Black / Chalk on it (over 15:1) | `files-uploading-*` at about 40%: the track's full length shows in both themes |
| 13 | Focus fell to the page when Cancel went (checking) or changed (error) | The line's focus moves with it: to the line itself while checking, to Try again or Dismiss on error, to the new Cancel on Try again, to Choose files when the line goes | e2e `upload line focus` |
| 14 | Refusal reasons were not announced; files past 5 were refused silently | The status line says "`name` wasn't added. `reason`" (the same words as the line) and once "2 files weren't added: up to 5 at a time." (ICU plural, EN and FR); it keeps the last few messages as separate nodes so a burst is read out whole | e2e `announcements` |
| 16 | The name link was 24 px tall on phones; the EN "Retry" about 36 px wide, with no press feedback | Phones: the link's `::after` covers the line (icon, name, meta), the menu sits above it; the line tints on press. Retry: 44 by 44 minimum, scale 0.97 on press | `files-list-*-390`, e2e `phone_390_files` |
| 17 | A file dropped just outside the zone opened in the tab, leaving the lead page | While the tab is shown, `dragover` and `drop` on the window are cancelled outside the zone (cursor shows "not allowed"); removed while another tab is shown | e2e `hidden tab` (dispatched drag events) |
| 18 | Outcomes while the tab was hidden were silent | A final outcome while hidden also shows as the app's toast (outside the hidden boundary); the line waits for the tab | e2e `hidden tab` |
| 19 | Closing the Delete dialog dropped the focus to the page (verifier round 3, finding 1) | The dialog closes back onto the row's Actions (Retry once stuck deleting, the heading when the row is gone): spatial consistency, the focus returns where the action started | e2e `delete dialog focus` |

Also seen in the shots: Try again sits before Dismiss on a failed line, in bold text-style (not a second filled button),
so the line keeps one quiet control group; "Checking the file…" keeps the full bar, so the change of state is the label,
not a jump.

Unresolved: none.
