# Apple design audit: Day 3b lead import, 10 Oct 2026

Checklist: docs/apple-design-audit.md (12 items) plus the apple-design skill's through-line (motion starts from the
current on-screen value, can be interrupted, and every touch answers at once). Screens: /leads/import at every step
(choose, match, check, results, importing, done), Past imports, the Undo, Discard and "Confirm it's you" dialogs, the
not-found page, and the leads screen's new entry points. Sources: the design and accessibility reviewer of the final
review workflow (code, DESIGN.md, probes in Chromium), its skeptic, and the screenshots in `screens/` (every import
step at 390, 768, 1024, 1280, 1440 and 1728, light and dark, English and French).

Refreshed for the final screens: a last review of everything changed after the first audit (live counts on Match, the
date order example, wider menus, the full-width wizard) by a design and accessibility reviewer and a skeptic per
finding, on the code and on screenshots retaken after the fixes below.

| # | Item | Finding | Fix |
|---|---|---|---|
| 1 | Instant response | Buttons press to 0.97; choosing a file shows "Reading the file…" with a bar at once; Check shows "Preparing…", then a sending bar; the code field submits on the 6th digit. At 30,000 rows on a 4x slower CPU the page froze for up to 1.4 s when cleaning rows and measuring chunks | Rows are cleaned in slices of 500, value lists are worked out once per column while the file is read, chunks are measured one at a time; time zone and country names are prepared while the file is read: the longest freeze is now 91–162 ms (perf.md). The drop zone gained a press state. The live counts on Match run 400 ms after the last choice, and Check file reuses them |
| 2 | Tracks the finger | The only drag is a file onto the drop zone, which highlights while the file is over it | none |
| 3 | Momentum | The rows list and the page scroll natively; the rows list keeps its scroll to itself (`overscroll-contain`) | none |
| 4 | Interruptible | The progress bar used a CSS tween | The bar is a Motion spring on `scaleX` (transform only), retargeted from its current value as each chunk lands; dialogs keep the short CSS settle (too short to grab, as in Day 2). A new choice on Match stops the count in progress; a choice made while Check file prepares is used, not lost |
| 5 | Rubber-band | Native edge bounce in the page and the rows list | none |
| 6 | Animate from current value | Dialogs on phones scaled in from the centre | Undo, Discard and "Confirm it's you" are bottom sheets on phones that rise from the bottom edge and sink back (320/200 ms, transform and opacity) |
| 7 | Calm | No constant motion. The progress announcements fired at every chunk, and "Looking for duplicates" showed a full bar while still working. Final review: the live counts line switched to "Counting the rows…" and back on every choice (two width changes) | One live region announces about every 10%; work of unknown length shows an empty track that pulses softly (only under `motion-safe`), never a full bar; skeletons match the final layout. The counts line keeps the last counts while a change is counted; "Counting the rows…" shows only before the first result |
| 8 | Reduced motion | The global block collapses transitions; skeleton pulses are `motion-safe` only | The spring jumps and the sheets appear at once under reduced motion |
| 9 | Materials and depth | Dialogs float (solid card, shadow); the wizard and the Past imports rail are flat cards on the page tone; no glass | none |
| 10 | Typography | Outfit for text, DM Mono for counts, row numbers and the tiles. Long file names without spaces pushed the page sideways at 390 and were cut in the Undo dialog; French strings used ordinary spaces before : ; ? !. Final review: with 248 px menus the column headers on Match were cut to one letter at 1024 ("C…") and five at 768; hints and result lines ran about 150 characters at 1440 once the wizard filled the width; French read "le 1 septembre" | File names wrap anywhere they appear; French uses narrow no-break spaces and typographic apostrophes (unit test). Match uses three columns (header, examples, menu) only from 1280; narrower, the examples sit under the header, and a header wraps instead of being cut. Menus are 248 px from 640 (the French labels fit) and full width at 390. Hints, the file line and the result lines keep a 65-character measure. French writes "le 1er septembre" |
| 11 | Status never colour-only | Every dot pairs with a word: tiles, history badges, notices, the "Matched" badge, each row's sentence in the rows list | none |
| 12 | Spatial consistency | A four-step stepper; Past imports on the right on desktop (now in line with the header's right edge), below on phones; focus moves to each step's heading. Focus fell to the page after a wrong code, a failed step, a file error, Discard and Undo | Focus returns to the code field after a wrong code, and to the step heading, the alert, or the button that opened a dialog everywhere else. After "Choose the file" on Results, focus goes to "Rows to look at". Results hides Discard once an import has started, as Past imports does |

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

Screen readers: the live counts are one status line that is always in the page (`role="status"`), heard once per
settled change and read as the Check button's description; the date order example is the menu's description and is
announced when the order changes, including "01/09/2023 is not a date in this order" when the sample does not read
that way.

## Accepted

- Leaving the page within the app while a check or an import runs: the work keeps going while the tab is open, nothing
  is shown on a page that is gone, and Past imports shows the import's real state on return ("Still running in this
  tab"). No in-app navigation warning.
- The date order example sits under the "Date order" label, left of the menu on wide screens: it reads as a sentence about
  the choice and is the menu's description for screen readers.
