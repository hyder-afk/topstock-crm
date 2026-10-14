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
- At 4x CPU the longest task during an advance is 58–112 ms (budget 50): React's render of the new card, Motion's
  slide and the focus's layout share the frame (README "Queue speed"). Haider is asked whether it waits for Day 7.
- The quick add's chips row scrolls sideways inside itself on phones with no fade at the edge (as the lead page's
  tab strip, kept for Day 7 in 4b).

## Verifier round (12 Oct 2026)

New and changed UI, checked on the code and on `screens/queue-released-*` and the re-taken `queue-*` shots:

| # | Item | Finding | Fix |
|---|---|---|---|
| 1 | Instant response | A card a teammate now holds leaves without any wait: the reserve (or the next claimed card) takes its place with the same `snappy` slide, so the swap reads as the usual advance; the toast says why | none needed |
| 4 | Spatial consistency | The claims-ended notice sits at the top of the start screen's own card (the place the person looks after coming back), above the intro; no modal, nothing covers the page | none needed |
| 6 | Restraint | One muted panel, a tiny amber dot (status colour as a dot only, DESIGN.md), one underlined link; no red: nothing failed, the leads simply went back | none needed |
| 9 | Accessibility | The notice is `role="status"` (read once, politely); Start has the focus, so ↩ carries on; the empty state's heading and the page title take the focus when what held it leaves (verifier finding 2), with the visible focus ring on keyboard use | — (fixed in this round) |
| 10 | Touch targets | The notice's link is 44 px tall on phones (32 px from tablet width); the task row's lead link has a 44 px tap area on phones without changing the row's height | — (fixed in this round) |

Unresolved: none.


## Review round 3 (12 Oct 2026)

Changed UI from the review findings, checked on the code and on the re-taken shots (`queue-followup-view-*`,
`queue-not-saved-*`, `queue-*`, `leads-queue-skeleton-*`, `more-*`, `more-skeleton-*`, `tasks-*`):

| # | Item | Finding | Fix |
|---|---|---|---|
| 1 | Instant response | At 390, tapping Interested, Book meeting, Connected or Do not contact only turned the key black: the follow-up and Confirm opened under the pad, below the fold and behind the dock (finding 15) | below 1024 the panel scrolls into view (smooth; instant with reduced motion) with a bottom scroll margin clear of the dock, and takes the focus; Cancel gives the focus back to the card's heading |
| 4 | Interruptible / spatial | U right after a mistaken key took back the outcome before it, and the restored card took no focus (findings 8, 9) | U waits for the latest outcome's save and takes back that one; the restored card's heading takes the focus |
| 6 | Restraint | "1 outcome not saved · Retry" lived only in the rail, so it vanished on the empty and start screens (finding 6) | one muted chip with an amber dot under the page title, in every phase |
| 7 | Calm | The queue's route skeleton was about 58 px short in French at 390 (finding 20), so the page jumped | the intro, scope switch and lunch line carry their own words invisibly on grey bars, so they wrap exactly like the page in both languages |
| 8 | Reduced motion | New tasks appeared with no entrance (finding 23) | a task added after the list first shows fades in and rises 8 px (`smooth`); with reduced motion the 120 ms fade only |
| 10 | Typography | Key hints could break between a key and its word ("U" / "annuler", finding 21) | no-break spaces inside each "key word" pair; lines break only at "·" (unit-checked) |
| 12 | Spatial consistency | — | The Tasks title count stays a quiet DM Mono number beside the h1; its meaning is now said to assistive tech and on hover ("5 tasks due today or overdue", finding 22) |

Unresolved: none (the speed budgets remain Haider's question, README Open risks).
