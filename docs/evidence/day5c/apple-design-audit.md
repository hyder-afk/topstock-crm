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

## Advisor item 3 (15 Oct): the Low stock card filled from Day 6's `stock_alerts()`

Order per CLAUDE.md: DESIGN.md (source of truth), then the Taste Skill (`design-taste-frontend`, dials from DESIGN.md:
low variance 3, medium motion 5, medium-high density 7; its section 13 puts dashboards out of scope, so only its
general rules were applied), then `anthropic-skills:apple-design` (this copy holds only its introduction: interfaces
that feel physical, motion from the current value, restraint and feedback; judged by those foundations), then the web
interface guidelines (`web-design-guidelines.md`). Looked at: `screens/home-low-stock-day6-*` before (scratch copies of
the old build, 24 shots) and after (24 shots), and `screens/home-low-stock-loading-*` (24 shots).

| Area | Finding | Result |
|---|---|---|
| Restraint (DESIGN.md "status colours only as small dots or labelled badges"; Taste 9.F "no decorative dots on every row"; apple-design restraint) | the amber dot plus "Low" on every product row repeated what the card's title and its count line ("3 low · …") already say: every listed product is low by definition (Day 6's `sample` holds low products only). Five identical badges were noise, and the amber column drew the eye away from the figures | **fixed (d29be68)**: badge removed; status colour stays where it carries a state (the follow-up dots for late arrivals and holds ending) |
| Copy (sentence case) | "+300 In Transit" was Title Case mid-line, between sentence-case lines ("120 available · reorder at 200", "2 arrivals past their expected date"). "In Transit" is the Day 6 status name (log 11 Oct), right on a status label, not inside a line | **fixed (d29be68)**: EN "+300 in transit"; FR was already "+300 en transit"; unit test pins both |
| Loading skeleton (DESIGN.md and CLAUDE.md: skeletons match the final layout; Taste 4.5) | the card's loading state and Home's `loading.tsx` drew 3 generic one-line rows with no header action: shorter than the filled card (count line, 3 two- or three-line product rows, follow-up lines) and a different shape | **fixed (d29be68)**: `LowStockSkeleton` draws the action, the count line, three product rows (name, figures; first and last with a transit line) and three follow-up lines, with the real rows' paddings and minimum heights. `home-screens` measures it against the filled card where the card is full width (390, 768: within 20 px, every locale and scheme); from 1024 the grid row stretches both to Recent activity's height |
| Spacing (8pt grid) | three-line rows (name, figures, transit) had no vertical padding, so "+300 in transit" sat against the next product's name (seen at 1024 and 1280) | **fixed (d29be68)**: rows `py-2` (8 px), minimum heights kept (56 px phones, 48 px from 768) |
| Figures cut (advisor: DM Mono line at 1024 and 1280, `lg:col-span-5`) | not cut with the fixture at any width (`home-screens` now checks every text line of every product row: `scrollWidth` within `clientWidth`), but the line was `truncate`, so a longer French line or 5-digit figures could have hidden a number | **fixed (d29be68)**: the figures and transit lines wrap (`break-words`), the product name alone truncates; removing the badge also gives the line the row's full width |
| Typography | Outfit for names and counts, DM Mono for the figures that line up, muted Outfit for stock in transit; hierarchy by weight and tone, no new sizes | ok |
| Motion and feedback | no motion in this card (it is read, not manipulated); links keep their hover tone and the global focus ring; skeleton pulse off under reduced motion (`motion-safe:`) | ok |
| Kept on purpose | the middle dot in the count line ("3 low · 1 sold out · 2 deals waiting": two dots; Taste 9.F rations it to one per line) is the app-wide metadata separator (KPI sub-lines, feed rows, deal cards), so changing it here alone would break consistency | no change |
