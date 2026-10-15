# Day 5c Apple design audit (Home)

Checked by hand on the final build, the screenshots in `screens/` and the e2e checks. DESIGN.md is the source of truth.

| Area | Finding | Result |
|---|---|---|
| Feedback | KPI cards, rows, the scope switch, check circles and Retry acknowledge a press with a scale on the `scale` property (Tailwind 4 writes `scale`, so the transitions name it, the Day 5b lesson) | ok |
| Count-up (D29) | the final number is in the server HTML; on the first Home of a tab with early hydration it counts from 0 in 0.7 s on the expo-out curve, under the CSS rise; later visits and reduced motion never count (e2e: frames recorded on the first hard load, none on the second visit, none with reduced motion); refreshes ease from the old value in 0.3 s; no re-render per frame | ok |
| No layout shift | the number sits over an invisible copy of its final text in DM Mono (each digit the same width); e2e CLS 0, perf 0 shift entries; unit test: no frame is wider than the final value, EN and FR | ok |
| Pipeline bar | ink tones at 30/60/100 %, no status colours; segments grow with `scaleX` on the `smooth` spring, 30 ms apart, first visit only, never under reduced motion; interruptible (stopped on unmount) | ok |
| Restraint | one red action (Start calling); status colours only as a dot plus words (Stalled, Low, Out of stock) or the red text token with words (Overdue, Close date passed) | ok |
| Spatial consistency | the skeleton is the page's own grid, card for card (KPIs 4 across from 1024, 2 x 2 below; cards 7 + 5 from 1024); the deal sheet opens over Home as on the board and the lead page and gives focus back to the row | ok |
| Typography | Outfit for text; DM Mono for figures, counts, times and values; the greeting keeps its word rise and its 36/40 size on phones | ok |
| Touch | 44 px targets on phones (checks, scope switch, links); Start calling 56 px full width at 390 (e2e) | ok |
| Fixed during the audit | KPI sub-lines and phone feed rows cut values ("4 20…"): they now wrap to two lines; the won value's separator left DM Mono (it looked spaced out); the card headings kept a visible focus ring when focus moves to them | fixed (6bd5a7d) |

Not done here: the Taste Skill pass (see README "Not done").

## Verifier round 1 and the 4c rebase (15 Oct)

- Start calling carries 4c's G Q key caps (on the red button: black-on-red caps, `bg-brand-foreground/10`, hidden on phones);
  the counts are 4c's queue_summary or "Nobody to call right now." (screens `v1-home-queue-*`, EN light and FR dark).
- Today: a meeting with a lead in another zone shows "{time} their time" under its time (muted, DM Mono), as the Tasks page.
- Needs attention: a row that leaves after a move hands the focus to the row now at its place (or the heading).
