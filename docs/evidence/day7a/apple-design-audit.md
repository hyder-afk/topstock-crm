# Apple design audit: Day 7a "Sign out of all devices" (More button and sheet), 15 Oct 2026

Checklist: docs/apple-design-audit.md (12 items) and the apple-design skill. Scope: the quiet button under Sign out on
More, its confirmation sheet, the More loading skeleton. Screens: `screens/more-*` and `screens/sheet-*` (390, 768,
1024, 1280, 1440, 1728; light and dark; EN and FR), retaken after the sheet text gained "Other devices lose access within
an hour at most."

| # | Item | Finding | Fix |
|---|---|---|---|
| 1 | Instant response | Button presses to 0.97 at once; the confirm is disabled with `aria-busy` while the action runs | none |
| 2 | Tracks the finger | No drag here | none |
| 3 | Momentum | Page scrolls natively | none |
| 4 | Interruptible | The sheet uses the shared dialog's short CSS settle (too short to grab, as everywhere else) | none |
| 5 | Rubber-band | Native edge bounce | none |
| 6 | Animate from current value | On phones the sheet rises from the bottom edge (320 ms) and sinks back (200 ms); on wider screens opacity + scale | none |
| 7 | Calm | No constant motion; one sheet, two buttons | none |
| 8 | Reduced motion | The global block collapses the sheet animation | none |
| 9 | Materials and depth | Solid card with the dialog shadow over a dimmed page; no glass | none |
| 10 | Typography | Outfit; title 20 px bold with tight tracking and `text-balance`; body 14 px muted; the longer body (one more sentence) wraps to 4-5 lines at 390 and keeps a short measure on desktop (440 px sheet) | none |
| 11 | Restraint | No red: the confirm is the neutral black button (red is reserved for brand fills); the entry button is quiet, below Sign out | none |
| 12 | Reach | On phones the two buttons are full width, stacked, Cancel nearest the thumb; 44 px minimum height | none |

Result: no change needed beyond the text.
