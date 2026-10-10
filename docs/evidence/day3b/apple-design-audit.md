# Apple design audit: Day 3b lead import, 10 Oct 2026

Checklist: docs/apple-design-audit.md (12 items) plus the apple-design skill's through-line (motion starts from the
current on-screen value, can be interrupted, and every touch answers at once). Screens: /leads/import at every step
(choose, match, check, results, importing, done), Past imports, the Undo, Discard and "Confirm it's you" dialogs, the
not-found page, and the leads screen's new entry points. Sources: the design and accessibility reviewer of the final
review workflow (code, DESIGN.md, probes in Chromium), its skeptic, and the screenshots in `screens/` (every import
step at 390, 768, 1024, 1280, 1440 and 1728, light and dark, English and French).

| # | Item | Finding | Fix |
|---|---|---|---|
| 1 | Instant response | Buttons press to 0.97; choosing a file shows "Reading the file…" with a bar at once; Check shows "Preparing…", then a sending bar; the code field submits on the 6th digit. At 30,000 rows on a 4x slower CPU the page froze for up to 1.4 s when cleaning rows and measuring chunks | Rows are cleaned in slices of 500, value lists are worked out once per column while the file is read, chunks are measured one at a time: the longest freeze is now 129–191 ms (perf.md). The drop zone gained a press state |
| 2 | Tracks the finger | The only drag is a file onto the drop zone, which highlights while the file is over it | none |
| 3 | Momentum | The rows list and the page scroll natively; the rows list keeps its scroll to itself (`overscroll-contain`) | none |
| 4 | Interruptible | The progress bar used a CSS tween | The bar is a Motion spring on `scaleX` (transform only), retargeted from its current value as each chunk lands; dialogs keep the short CSS settle (too short to grab, as in Day 2) |
| 5 | Rubber-band | Native edge bounce in the page and the rows list | none |
| 6 | Animate from current value | Dialogs on phones scaled in from the centre | Undo, Discard and "Confirm it's you" are bottom sheets on phones that rise from the bottom edge and sink back (320/200 ms, transform and opacity) |
| 7 | Calm | No constant motion. The progress announcements fired at every chunk, and "Looking for duplicates" showed a full bar while still working | One live region announces about every 10%; work of unknown length shows an empty track that pulses softly (only under `motion-safe`), never a full bar; skeletons match the final layout |
| 8 | Reduced motion | The global block collapses transitions; skeleton pulses are `motion-safe` only | The spring jumps and the sheets appear at once under reduced motion |
| 9 | Materials and depth | Dialogs float (solid card, shadow); the wizard and the Past imports rail are flat cards on the page tone; no glass | none |
| 10 | Typography | Outfit for text, DM Mono for counts, row numbers and the tiles. Long file names without spaces pushed the page sideways at 390 and were cut in the Undo dialog; French strings used ordinary spaces before : ; ? ! | File names wrap anywhere they appear; French uses narrow no-break spaces and typographic apostrophes (unit test); text blocks keep a 65-character measure |
| 11 | Status never colour-only | Every dot pairs with a word: tiles, history badges, notices, the "Matched" badge, each row's sentence in the rows list | none |
| 12 | Spatial consistency | A four-step stepper; Past imports on the right on desktop (now in line with the header's right edge), below on phones; focus moves to each step's heading. Focus fell to the page after a wrong code, a failed step, a file error, Discard and Undo | Focus returns to the code field after a wrong code, and to the step heading, the alert, or the button that opened a dialog everywhere else |

## Signal Red and status colours

Signal Red appears only as the one primary action per screen: "Import N leads" on the results, and "Import from a
spreadsheet" in the admin's empty leads list. The Undo, Discard, Check and "Confirm it's you" buttons are neutral.
The keyboard hint inside the red button reached only 3.9:1 on its darker fill; it now sits on plain red (black on
#F2203E, 4.64:1). Status colours appear only as small dots next to words.

## Touch and keyboard

All controls are at least 44 px tall on phones (the filter chips were 36 px and are fixed). Ctrl/Cmd+Enter runs the
step's main action on Match and Results; Tab order follows the screen; the rows list's scroll box can be focused and
scrolled from the keyboard (Safari needs it); the sticky action bar on phones no longer hides the focused control
(scroll padding above it).

## Accepted

- Leaving the page within the app while a check or an import runs: the work keeps going while the tab is open, nothing
  is shown on a page that is gone, and Past imports shows the import's real state on return ("Still running in this
  tab"). No in-app navigation warning.
- The design's live "Ready to check · Need fixing" preview on the matching screen is not built: it would clean every row
  again on each change.
