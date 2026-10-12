# Apple design audit: Day 4c Tasks page and work queue, 12 Oct 2026

Checklist: `docs/apple-design-audit.md` (12 items) plus the apple-design skill's through-line (motion starts from the
current on-screen value, can be interrupted, and every touch answers at once). Screens: `/tasks` (Today, Overdue,
Upcoming, Done, quick add, inline edit, the delete question, Team), `/leads/queue` (start screen, a card with the
outcome rail, a follow-up open, "No leads are assigned to you"), the lead page's "Henri is on this lead" line, More's
time zone form, and the two route skeletons. Done by the builder on the code (DESIGN.md, design sections 7.4, 7.5,
7.7 to 7.10) and on the screenshots in `screens/` (390, 768, 1024, 1280, 1440 and 1728, light and dark, English and
French). Findings were fixed in 8d2a3f7 and the shots taken again (see `screens/README.md`).

| # | Item | Finding | Fix |
|---|---|---|---|
| 1 | Instant response | Buttons, chips, tabs, scope segments, pad keys, the task check (0.94) and menu triggers press within 100 ms. Done, Dismiss and Delete take the row away at once (optimistic, Undo in the toast); an outcome shows the next card at once from the reserve (measured: key to next card painted p95 75–98 ms at 4x CPU after the D3 switch). The lunch switch had no press state | `active:scale-[0.97]` on the switch |
| 2 | Tracks the finger | No drag on these screens (design 7.5: no swipe gestures on task rows, accidental completions) | none |
| 3 | Momentum | Not applicable (no throw or drag) | none |
| 4 | Interruptible | The card advance is a Motion spring (`snappy`); a key mid-flight starts the next card while the leaving one keeps animating from where it is (`AnimatePresence mode="popLayout"`). Task rows leave with a fade and the list closes the gap with `layout="position"` springs, retargeted when another row leaves | none |
| 5 | Rubber-band | Not applicable | none |
| 6 | Animate from current value | Cards exit to the left and enter from the right (forward in the queue); the Tasks tab pill reuses the hand-built tabs (`layoutId`, `smooth`); the check fills before the row leaves (160 ms), so the eye sees what happened | none |
| 7 | Calm | No constant motion; skeletons only (route skeletons for both pages, card skeleton while a card is claimed, task row skeletons per tab, count skeletons on the start screen). The queue card repeated the status ("Warm lead" chip next to the "Warm (in progress)" badge); the Tasks page showed six bare key caps (T J K X E D) with no words | The reason chip shows only when it adds to the status (follow-up, retry with its try number, back from Cool off, first call); the key hint is one line of words at desktop width ("T new task · J/K move · …"), the full list is in "?" |
| 8 | Reduced motion | The card swap becomes a 120 ms fade (no slide), rows leave without the layout spring, the global block collapses CSS transitions, skeleton pulses are `motion-safe` | none |
| 9 | Materials and depth | Flat cards on the page tone; shadow only on dialogs, menus and the lead picker's list (floating layers); no new glass | none |
| 10 | Typography | Outfit for text, DM Mono for counts (tab counts, "5 to call now"), times ("10:42 their time", due labels), phone numbers (28 px on the card) and the session counts. French: the scope switch's third option ("Équipe") was off the edge at 390 inside a scrolling strip; "0 de plus plus tard aujourd’hui" read badly; contact names were cut to "A…" on phones | The scope switch wraps instead of scrolling; "0 autres plus tard aujourd’hui"; a contact's name takes its own line when the row is narrow |
| 11 | Status never colour-only | Overdue: the word in the red text token; Do not contact tasks: red dot plus "Asked not to be contacted"; outside calling hours: amber dot plus the words, in bold; "Henri is on this lead": amber dot plus the sentence; the pad's chosen outcome is the neutral fill with its key | none |
| 12 | Spatial consistency | The queue lives under Leads (the dock bead stays on Leads); the card and the rail keep their places across cards (the rail sticky at 1440); on phones the pad comes right after the card head, within reach. At 1440 the card head and its details had a tall gap between them (the rail spans two grid rows and stretched the first) | `grid-rows-[auto_1fr]`: the head keeps its height, the details follow it |

## Signal Red and status colours

Signal Red fills only the main line's Call on the queue card (the screen's one call action, black text on red) and
Start on the queue's start screen (its one primary button); the dock bead stays as it is. Add, Confirm, Save, Retry
and "Delete task" are neutral fills; contacts' Call buttons are quiet. Status colours appear only as small dots next to
words and as the red text token for "Overdue" and the menu's Delete.

## Touch and keyboard

Phone targets: task checks 44 px, menu triggers 44 px, chips and segments 44 px (36 px from tablet width), pad keys
56 px (design 7.9), the card's Call 56 px and full width, the lead picker's options 44 px. Keyboard: every action has a
key (queue: 1–7, 0, S, N, C, U, Cmd/Ctrl+Z, ↩ and Esc in a follow-up; Tasks: T, J/K, X or Space, E, D, ⌫, ↩), digits by
key position (AZERTY), keys quiet while typing and in dialogs. The focus never drops to the page: after an advance it
goes to the new card's heading; after Done, Dismiss or Delete to the next task's check (else the previous one, else the
list); the delete question gives it back to the row (or its neighbour after a delete); Esc in the note returns to the
heading. Both are covered by e2e (`queue.spec.ts` keys_each_outcome, note typing; `tasks.spec.ts` keyboard_only).

## Kept as they are (noted)

- The phone note opens a sheet whose field takes the focus at once (the sheet exists only to type the note).
- At 4x CPU the longest task during an advance is 73–112 ms (budget 50): the new card's render (Intl formatting of the
  contacts, notes and tasks). Recorded in the README's speed table; Day 7 polish.
- The quick add's chips row scrolls sideways inside itself on phones with no fade at the edge (as the lead page's
  tab strip, kept for Day 7 in 4b).
