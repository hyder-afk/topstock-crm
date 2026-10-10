# /web-design-guidelines: Day 3b lead import, 10 Oct 2026

Rules: vercel-labs/web-interface-guidelines `command.md` at commit 434b7f9 (the pinned rules URL).
Files: src/components/import/*, src/components/auth/step-up-dialog.tsx, src/components/ui/dialog.tsx,
src/app/(app)/leads/import/*, src/app/(app)/not-found.tsx, the import entry points in src/components/leads and
src/components/shell, messages/{en,fr}.json (Import, StepUp, NotFound).
Plan overrides (docs/preflight.md): no spinners (skeletons, progress bars and press states instead); sentence case, not
Title Case.
Reviewed by the design and accessibility reviewer and the copy reviewer of the final review workflow; each finding was
re-checked by a skeptic before it was fixed.

## Found and fixed

src/components/auth/step-up-dialog.tsx - focus fell to the page after a wrong code (the field was disabled while checking) → the field stays enabled (read-only) and takes focus again; a lost connection freed the dialog and shows its message
src/components/import/import-workspace.tsx - focus fell to the page after a failed step, a file error or a discard → focus moves to the step heading or the alert
src/components/import/import-history.tsx - Undo's progress, result and errors were not announced → one live region from first open; the title says when the undo is done or paused; Close takes focus at the end
src/components/import/check-step.tsx - the rows list's scroll box could not be reached by keyboard (Safari) → `tabIndex={0}` with its label
src/components/import/check-step.tsx - filter chips were 36 px tall on phones → 44 px
src/components/import/check-step.tsx - the keyboard hint inside the red Import button was 3.9:1 → plain red background, 4.64:1
src/components/import/check-step.tsx - Discard was immediate → asks first ("Nothing was added to your CRM"), Keep it has the focus
src/components/import/match-step.tsx - the sticky action bar on phones could cover the focused control → scroll padding above the bar and the dock
src/components/import/match-step.tsx, check-step.tsx, import-history.tsx - long file names without spaces pushed the page sideways at 390 and were cut in the Undo dialog → wrap anywhere
src/components/import/progress.tsx - announced every chunk, and a full bar while still working → announced about every 10%; unknown length shows no number
src/components/import/import-history.tsx - Past imports' error state had no way to retry → Try again
src/components/import/choose-step.tsx - weak focus indicator on the drop zone, no press state → focus-visible ring and press state
src/app/(app)/leads/import/loading.tsx, src/app/(app)/leads/loading.tsx - skeletons did not match the final layouts (and the leads header showed one button where admins see two) → match
src/components/import/match-step.tsx - time zones shown as raw IANA ids, date order with fixed sample dates → readable localised names (Intl), a real date from the file in both options
messages/{en,fr}.json - missing plurals ("1 rows"), French at 0 and 1 in the Undo sentence, ordinary spaces before : ; ? ! in French, error copy for importing reused in Undo → plurals everywhere, narrow no-break spaces and typographic apostrophes (unit test), Undo's own wording

## Checked, no change

- Every control has a visible label or `aria-label`; the status, owner and country selects say which value they are for ("Status for “Hot lead”"); decorative icons are `aria-hidden`.
- Buttons for actions, links for navigation ("See these leads", "See leads" are real links with the import in the URL); no clickable divs.
- The code field: `inputMode="numeric"`, `autoComplete="one-time-code"`, `spellCheck={false}`, paste allowed, a real label; `autoFocus` only there (the dialog's single input).
- Errors are inline next to what failed and say what to do next; no raw database text reaches the screen.
- Animation: transform and opacity only, no `transition: all`, the progress bar grows from the left (`origin-left`), springs retarget mid-flight, everything collapses under reduced motion.
- Typography: one ellipsis character in loading text ("Reading the file…"); curly quotes; counts and row numbers in DM Mono; headings `text-balance`.
- Content: empty, loading and error states for Past imports and for the rows list; truncation with `min-w-0` where text is cut.
- Performance: the rows list is virtualised (up to 50,000 rows); value lists and the date guess are worked out once per column.
- Dates and numbers through next-intl (Intl), Europe/Paris on server and client; native selects have explicit colours in both themes.
- Touch: `touch-action: manipulation`, tap highlight and `color-scheme` set globally (Day 1); `overscroll-behavior: contain` on the rows list and the sheets.

## Accepted, noted

- Leaving the page within the app during a check or an import gives no warning (only closing or reloading the tab does): the work keeps running while the tab is open and Past imports shows its real state on return.
- The step-up and Undo dialogs keep their short CSS settle-in on desktop (too short to grab, as in Day 2).
