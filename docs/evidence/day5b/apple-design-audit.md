# Day 5b Apple design audit (Skill `anthropic-skills:apple-design`)

Scope: the pipeline board, deal card and dragged copy, drop, settle and Undo, the deal sheet, Win / Lose / Reopen /
Delete dialogs, New deal, the lead's Deals tab, Summary card and header chip, and the call panel's "Open a deal" switch
(`src/components/pipeline/*`, `src/components/lead/deal*.tsx`, `src/components/lead/deals-tab.tsx`,
`src/components/activity/call-panel.tsx`). Checked by reading the code against the skill (motion starts from the
on-screen value, follows the hand 1:1, can be grabbed at any instant, springs over curves, reduced motion, feedback
within 100 ms, restraint in materials and type), by hand in the screenshots (`screens/`), and by the e2e and speed
specs named below. Run on 42fda4c and re-checked after the fixes (d066c8e and the layout commit that follows it).

## Findings and what was done

| # | Area | Finding | Result |
|---|---|---|---|
| 1 | Press feedback | Cards, stepper segments, toolbar chips and sheet buttons press to 0.97, but their transitions named `transform`; Tailwind 4 writes `scale-*` as the CSS `scale` property, so the press snapped in and out instead of easing | **Fixed** (42fda4c): the transitions name `scale`; the card's eases 150 ms and has none under reduced motion. Press feedback measured in `day5-perf.spec.ts` (`pressMs`) |
| 2 | Drag tracking | The dragged copy (`DragOverlay`, `dropAnimation={null}`) is under the pointer 1:1 from the 6 px mouse activation or the 250 ms touch hold (tolerance 8); lifted 3% with the floating-layer shadow on a spring; an 8 ms haptic on pick-up where the browser allows it after a user gesture | Pass |
| 3 | Drop and settle | The card is already in its new column when the pointer comes up (optimistic, `applyMove`); it starts where the copy was let go and springs home (`springs.smooth`, transform only). Brought into view first when a virtualised column would not draw it | Pass. Settle time measured (`settleMs`, budget 450 ms) |
| 4 | Interruptible | Motion's `animate` starts from the current value, so a second drop or a quick second move mid-settle carries on from where the card is; a second move on the same card queues behind the first (TanStack scope, spike S12) and never snaps back. `quick_second_move_same_card_no_conflict` and `pipeline-multi.spec.ts` cover it | Pass |
| 5 | Momentum | Not applicable on the board: a card is placed, not flicked. The phone stage tabs and columns use native scroll snapping (system momentum); the deal sheet and dialogs keep Day 2's sheet spring and drag-to-dismiss | Pass |
| 6 | Velocity on release | The settle does not inherit the pointer's release velocity (dnd-kit does not report it); the distance is a few hundred pixels at most and the spring is near critically damped, so it reads as a settle, not a throw | Accepted (noted for the dnd-kit `@dnd-kit/react` move, design 9) |
| 7 | Reduced motion | No travel: the settle is a 120 ms fade, neighbours do not slide (`layout` off), the Lost band fades, the stage-tab pill jumps, scrolling to a column is instant; the switch knob and card press have no transition. `reduced_motion_no_settle` checks the card is untransformed after a move | **Fixed** for the knob and the card press (42fda4c); the rest passed |
| 8 | Neighbour motion | Cards around a move slide with `layout="position"` inside the virtual rows (spike S13: the layout transform composes with the row's `translateY`); off while dragging so the column does not shuffle under the pointer | Pass |
| 9 | Text selection while dragging | A long drag across the board could select card text | **Fixed** (42fda4c): the board is `select-none` while a drag is on |
| 10 | Focus after the sheet | Closing the deal sheet opened from the lead's Deals tab left focus on the page body | **Fixed** (d066c8e): focus goes back to what opened the sheet, or to that deal's card or row; `lead-deals.spec.ts` checks it |
| 11 | Layout at tablet width | The Lost line under the columns sat behind the floating dock at 768 and 1024; at 1024 in French the "→ Marquer gagnée" chip pushed the card's ⋯ outside its card | **Fixed** (layout commit after d066c8e): the columns leave room for the dock (skeleton the same, block for block); the chip truncates and the value never wraps |
| 12 | Materials and colour | One accent (Signal Red) on New deal, the dock bead and Call; status as small dots with labelled text (Stalled amber, Do not contact red); cards are flat with a hairline, only the dragged copy floats | Pass |
| 13 | Typography | Lead name 15/20 bold, title 13/20 muted, money in DM Mono with tabular figures, column summaries in DM Mono; French money with narrow no-break spaces and the euro after the amount (screens FR) | Pass |
| 14 | Feedback | Every move answers at once on screen, then in the live region (EN and FR, `announcements_live_region_en_fr`), with a toast and Undo; a conflict names who moved it | Pass |

Unresolved: none blocking. Item 6 is an accepted limitation of dnd-kit 6.

## Verifier round 1 and the 4c rebase (15 Oct)

| Area | Change | Result |
|---|---|---|
| Spatial consistency | Lose or Delete on a focused card: the focus goes to the next card in the same column (else the one before, else the column heading), so the keyboard user stays where the card was; Reopen from the card menu starts at the stage the deal came from | Pass (`lose_and_delete_focus_stays_in_column`) |
| Restraint | The queue's Open a deal switch is the call panel's own (one shared component, same 44 px row, D key cap, knob without motion under reduced motion); the card's deal line is plain text under the location line, no new colour | Pass (screens `v1-queue-open-deal-*`) |
| Feedback | Queue toast says "deal opened in Lead" or why not; Undo says when the deal was kept | Pass (`interested_opens_deal_in_queue`) |
