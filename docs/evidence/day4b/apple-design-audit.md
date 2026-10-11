# Apple design audit: Day 4b lead page, 11 Oct 2026

Checklist: docs/apple-design-audit.md (12 items) plus the apple-design skill's through-line (motion starts from the
current on-screen value, can be interrupted, and every touch answers at once). Screens: `/leads/[id]` (Summary,
Timeline, Deals, Stock, Details), the call panel (calling, outcome pad, "Call not logged", "How did it go?"), the
composer (rail and phone sheet), "Until when?", the delete confirmation and "Confirm it's you", a Do not contact lead,
the not-found page, and the leads preview's Open lead. Done by the builder on the code (DESIGN.md, design section 7)
and on the screenshots in `screens/` (84 lead page shots at 390, 768, 1024, 1280, 1440 and 1728, light and dark,
English and French), taken again after the fixes below.

| # | Item | Finding | Fix |
|---|---|---|---|
| 1 | Instant response | Every button, chip, tab, pad key, quick action, menu trigger and task check presses to 0.97 within 100 ms. Logging is optimistic: the entry shows in the timeline at once (dimmed, "Saving…") and the toast follows the server's answer; a task check removes the task at once with Undo | none |
| 2 | Tracks the finger | The call panel's header is a drag handle (Motion `drag="y"`): it follows the pointer 1:1 downwards | none |
| 3 | Momentum | Releasing the panel projects the velocity (`project()` from `src/lib/motion.ts`, deceleration 0.99): a flick closes it, a short pull springs back (`dragSnapToOrigin`) | none |
| 4 | Interruptible | The tab pill (`layoutId`, `smooth` spring), the panel's entrance and exit (`sheet` spring) and the timeline rows' rise are Motion springs that retarget from where they are | none |
| 5 | Rubber-band | Pulling the panel up stopped dead | A little elasticity upwards (0.08) and more downwards (0.6) |
| 6 | Animate from current value | The call panel scales up from the Call button that opened it (transform origin from that button's centre); the tab pill slides from the previous tab (one frame after the panel shows, so the switch stays within budget); the phone sheets rise from the bottom edge | none |
| 7 | Calm | No constant motion: the local time is refreshed every 30 s silently (not a live region); new timeline entries rise 8 px once, entries already there never animate (a remount by filter does not replay it); skeletons only (route skeleton, timeline rows, the Details form placeholder), no spinner. Summary's latest entries were cards inside a card | Summary's latest entries are rows divided by lines; Next step lists the open tasks once instead of a second "Open tasks" card showing the same task |
| 8 | Reduced motion | The tab pill moves instantly, the panel only fades (120 ms), new rows do not rise; the global block collapses CSS transitions; skeleton pulses are `motion-safe` only. Dragging the panel still works | none |
| 9 | Materials and depth | Glass only on the call panel (a floating layer, like the dock), with the solid fallback under `prefers-reduced-transparency` and without backdrop-filter support (`.dock-glass`); cards are flat on the page tone, shadows only on the panel, menus and dialogs | none |
| 10 | Typography | Outfit for text, DM Mono for times, the timer, phone numbers, counts ("3 of 60") and due labels. Times showed "02:43 PM" in English; the clock line set "there" and "for you" in DM Mono with the times; the composer's kind selector wrapped "Meeting" to a second row in the 360 px rail and would have cut "Rendez-vous"; French "Enregistrer dans l'historique" wrapped inside the button next to its key hint | 24-hour times in both languages (the design's "14:05"); only the times are in DM Mono (rich text); five equal segments with an icon and a short label, French labels may wrap and are never cut; French Save is "Enregistrer". French typography (narrow no-break spaces, typographic apostrophes) is checked by `messages.spec.ts` |
| 11 | Status never colour-only | Status badge: dot and word; local time: a green or grey dot with "good time to call" / "outside calling hours"; Do not contact: red dot and a sentence; overdue tasks: the word "Overdue" in the red text token; a wrong number is struck through with "Marked wrong" | none |
| 12 | Spatial consistency | The call panel lives bottom right above the dock (a bottom sheet on phones) on every page and survives navigation; the composer is the rail's first card from 1024 and a sheet below; the dock stays bottom centre. At 1024 the five actions squeezed the header beside them | The actions sit beside the header from 1280 and under it below; Back returns to the same list URL and scroll position |

## Signal Red and status colours

Signal Red fills only the Call action (quick actions, black text on red, 4.64:1) and stays the one accent: the
composer's Save, End call, the pad's selected outcome, "Set Cool off" and the delete confirmation are neutral fills.
Status colours appear only as small dots next to words, and the red text token for "Overdue" and the delete menu item.

## Touch and keyboard

Controls are at least 44 px tall on phones (pad keys, chips, tabs, menu items, task checks, the back link and the
J/K arrows); the five quick actions are 48 px circles. Keyboard: Tab order follows the screen; tabs move with arrows,
Home and End; J and K walk the list the lead came from; O opens the previewed lead; digits 1 to 7 and 0 pick an outcome
by key position (AZERTY works); Cmd/Ctrl+Enter saves; Esc closes the panel ("Call not logged · Log it" first); U or
Cmd/Ctrl+Z undoes the last entry within 2 minutes. The "?" list has a new "On a lead" section.

## Accepted

- The design's examples write "14:05 in Lyon"; the page shows "14:05 local time" because the city and country are
  already at the start of the same line ("Lyon · France · 14:05 local time · good time to call").
- The native date and time pickers follow the browser's language (an English browser shows "10/12/2026, 05:14 PM" in
  the Details date field); the values the app writes are the same.
- The call panel covers part of the rail on desktop while a call is open: it is a floating layer by design and can be
  dragged down or closed; it does not block the page.
