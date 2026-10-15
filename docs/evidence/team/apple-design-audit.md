# Team screen: Apple design audit, 12 Oct 2026 (re-run 14 Oct 2026 on ed2ad60 and after the verifier round)

Skill `anthropic-skills:apple-design` (Designing Fluid Interfaces; feedback, spatial consistency, restraint), applied
to `src/components/team/*`, `src/app/(app)/more/team/*` and the screenshots in `screens/` (every width, light and
dark, English and French; first taken 14 Oct on ed2ad60; then on bc79fa6, the merge with main, on 15 Oct;
then on 2ab9969, after the merge with Day 4d and Day 5, also 15 Oct; the current set on 74ba153 code, 15 Oct, with the
634da7a wording (deal delete admin-only: the admin line gains "plus deleting deals" / "plus la suppression des
affaires", the manager line drops deals). Looked at one 390 and one 1440 French shot for the longer admin line:
`team-menu-fr-dark-390` (role menu) and `team-fr-light-1440` (list column and Roles card), plus `team-menu-fr-dark-1440`:
still three lines at most in the 36ch column and the 390 role menu, nothing clipped). DESIGN.md is the source of truth where they
differ. The 14 Oct re-run looked at the screenshots one by one (the 12 Oct round had no saved set) and at the e2e run that found row 11.

| # | Principle | Finding | Outcome |
|---|---|---|---|
| 1 | Immediate feedback (< 100 ms) | Confirm shows the new role on the row at once (optimistic); the database answer only confirms or puts it back | pass |
| 2 | Feedback without layout jumps | A "Saving…" line appeared under the name while saving, pushing the row down then back | **fixed** (330ceb8): the role button dims and is marked busy; the live region says "Saving the new role for …" |
| 3 | Spatial consistency | Every way out of the flow (confirm, cancel, Escape, "Confirm it's you", refusal) returns the focus to the same row's role button, the place the person started. Stepping yourself down removes that button with the page: the focus fell to `<body>` on More (verifier finding 1) | pass for the row paths (e2e checks four of them); **fixed** (verifier round) for stepping down: the focus lands on More's title, e2e `demoting_yourself` checks it |
| 4 | Physical press | Role and dialog buttons scale to 0.97 on press (shared `buttonVariants`); More's Team row uses the same hover/active tone as More's other rows | pass |
| 5 | Motion | Only the shared menu and dialog motion (opacity + scale, the phone sheet rising from the bottom edge, both off under reduced motion); no new animation | pass |
| 6 | Restraint, one accent | No Signal Red on the screen: role changes are not the page's primary action, so Confirm is the neutral button (as the status menu's "Until when?"); "You" is a grey label; the step-down warning a small amber dot with words | pass |
| 7 | Clear consequence before commit | The confirmation names the person and the new role ("Henri Durand becomes an admin.") and says what the role can do; stepping down yourself warns that the admin screens go at once | pass |
| 8 | Reach on phones | The confirmation is a bottom sheet at 390 with 44 px buttons; role buttons 44 px | pass |
| 9 | Density (DESIGN.md dial 7) | Desktop rows put the role's description in its own column from 1280 (xl) and keep the role button aligned at the right edge; phones keep name, date and button | pass |
| 10 | Skeleton honesty | The route skeleton has the same blocks (back link, title, sentence, three rows with a 44 px button, roles card) | pass (screens `team-skeleton-*`) |
| 11 | Spatial consistency (state stays where you put it) | After "Confirm it’s you", the saved role flipped back to the old one on screen: the code check renews the session cookies, so Next.js draws the page again, and that drawing (read before the change) replaced the row's new role. The database was right; the screen was not (e2e `stale_code_asks_for_a_code` caught it) | **fixed** (ed2ad60): a role set here stays shown until the server's list shows it, and the list is refreshed after a save; the e2e checks the row after the redraw |
| 12 | State stays true (verifier findings 3 to 5) | The ed2ad60 rule (keep a local role until the list shows it) could keep a role a colleague had changed again; one saving slot for the whole list unlocked a row still saving when another finished; a lost answer after a commit put the old role back | **fixed** (verifier round): each row has its own save (number and state); a local role is dropped by the first list read after the database answered (server times compared), whatever it shows; a lost answer reads the list again and says "Couldn’t confirm the change…" (unit tests in `tests/unit/team.spec.ts`, red on the old rules first) |

Kept: the menu and dialog motion is the shared CSS (keyframes on opacity and transform, cut under reduced motion), not
a spring; nothing on this screen is dragged or flung, so there is no velocity to carry. The confirmation opens with the
focus on Cancel (Radix's first control): the safe choice for a change of rights, one Tab from Confirm.

Kept: a refused change puts the role back without a motion of its own (the words under the row and the announcement
say why; a shake would add motion the rest of the app does not use).
