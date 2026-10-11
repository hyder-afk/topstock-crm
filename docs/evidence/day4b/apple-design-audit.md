# Apple design audit: Day 4b lead page, 11 Oct 2026

Checklist: docs/apple-design-audit.md (12 items) plus the apple-design skill's through-line (motion starts from the
current on-screen value, can be interrupted, and every touch answers at once). Screens: `/leads/[id]` (Summary,
Timeline, Deals, Stock, Details), the call panel (calling, outcome pad, "Call not logged", "How did it go?"), the
composer (rail and phone sheet), "Until when?", the delete confirmation and "Confirm it's you", a Do not contact lead,
the not-found page, and the leads preview's Open lead. Done by the builder on the code (DESIGN.md, design section 7)
and on the screenshots in `screens/` (84 lead page shots at 390, 768, 1024, 1280, 1440 and 1728, light and dark,
English and French), taken again after the fixes below. Re-checked after the review round on f2c900b (103 lead page
shots): see "Review round, 11 Oct 2026" at the end, which also corrects the touch-target claim under "Touch and
keyboard".

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

Controls are at least 44 px tall on phones (chips, tabs, menu items, task checks, the back link, the J/K arrows, and,
since the review round, See the whole timeline and Add contact); the outcome pad's keys are 56 px on phones and 44 px
from tablet width (design 7.9); the five quick actions are 48 px circles.
**Correction (review round, 11 Oct 2026):** this paragraph first said every phone control, pad keys included, was at
least 44 px, as if that met the design. It was wrong twice: See the whole timeline and Add contact were 36 px at every
width (their `min-h-9` replaced the button's base `min-h-11` through tailwind-merge; finding 19), and the pad keys were
44 px where design 7.9 asks 56 px for the pad (finding 20). Both fixed and re-checked (Review round below). Keyboard: Tab order follows the screen; tabs move with arrows,
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

## Review round, 11 Oct 2026 (re-check on f2c900b)

The Day 4b review workflow (four lenses, a skeptic per finding) confirmed 22 findings; the ones below touch the UI.
Re-checked with the apple-design skill's through-line and the 12-item checklist on the code at f2c900b
(`src/components/activity/{call-panel,composer,timeline,outcome-pad}.tsx`, `src/components/lead/{lead-page,lead-cards,
details-tab,lead-header,local-time}.tsx`, `src/app/(app)/leads/[id]/loading.tsx`), on the screenshots taken again on
f2c900b (`screens/`, 103 lead page shots including 17 new review-round shots; no console error, no sideways scroll),
and on the lead page e2e tests named below (Chromium, 9 of 9 passed on f2c900b this round).

| # | Finding | Fix (commit) | Re-check |
|---|---|---|---|
| 7 | Phones: a saved note draft beat the Meeting quick action in the composer sheet, and Book a meeting started with no time (desktop got 10:00) | The quick action is applied on mount too, after the draft restore: its kind wins, the draft's text stays, Book a meeting starts at 10:00; a quick action is cleared when the sheet closes or the window crosses 1024 px (851555b, 6682a8e) | Pass. `composer.tsx` `seenMode` starts at null; e2e `meeting_quick_action` passed (phone: Meeting over a note draft, 10:00) |
| 8 | A refused task Undo closed the toast and said nothing; the task stayed done | Undo reads the answer and shows the error toast (6ebd4d4) | Pass. `lead-cards.tsx` Undo checks `again.ok`; e2e `task_check_keeps_focus … a refused task Undo says so` passed |
| 9 | The Meeting quick action focused the composer's Note kind button (first `[aria-pressed]`), so Space switched away from Book a meeting | Focus goes to the pressed meeting choice (`[data-meeting-kind] [aria-pressed="true"]`) (6cf80d8) | Pass. e2e `meeting_quick_action` checks the focus at 1440 |
| 12 | The composer still offered Email and WhatsApp on a Do not contact lead (mailto: and wa.me links) | Three kinds only (Note, Call, Meeting); a draft or choice of Email/WhatsApp reads as a note (5a04098) | Pass. `lead-dnc-note-*` (390, 768) and `lead-dnc-*-1440` (rail) show three equal segments; the screens spec asserts no Email/WhatsApp button; e2e `dnc_lead_logs_at_every_width` asserts no link in the sheet |
| 13 | A Do not contact lead could not be logged at all from 640 to 1023 px ("Add a note" was `sm:hidden`, the rail starts at 1024) | "Add a note" shows below 1024 (`lg:hidden`) (ae43dc0) | Pass. `lead-dnc-en-light-768` / `lead-dnc-fr-dark-768` show it under the banner; e2e logs a note at 768 and 390 |
| 16 | Checking a task removed the focused check: focus fell to the page | Focus moves first to the next task's check, else the previous, else the Next step heading (`tabIndex=-1`) (6ebd4d4) | Pass. e2e `task_check_keeps_focus` passed |
| 18 | The route skeleton put the actions beside the header from 1024; the page does so from 1280, so the content jumped about 64 px at 1024–1279 | Skeleton uses `xl:flex-row` like the page (e0007be) | Pass for the action row: `lead-skeleton-*-1024` has the five action blocks under the header, `lead-skeleton-*-1280` beside it, matching `lead-en-light-1024` / `-1280`. Measured (DOM, held navigation): tab strip at 324 px in the skeleton at 1024, 260 at 1280. **Residual, nit:** the page's tab strip is at 343 / 279 px, 19 px lower at every desktop width, because the header's facts line ("Next call in 1 day · Last call: Interested", shown for any lead with a next call or a logged call) has no bar in the skeleton (see Defects below) |
| 19 | See the whole timeline and Add contact were 36 px tall on phones | `min-h-11 sm:min-h-9` on both (bd48cdb, 91cc2d6) | Pass. tailwind-merge now keeps `min-h-11` (checked in node); e2e `dnc_lead_logs_at_every_width` measures both at ≥ 44 px at 390 |
| 20 | Pad keys 44 px on phones; design 7.9 asks 56 px for the pad | `min-h-14 sm:min-h-11` (4aa77ed) | Pass. `lead-call-*-390` and `lead-call-queued-*-390` show 56 px keys in a 2 × 4 grid (French labels fit on one line); e2e `phone_return_how_did_it_go` measures ≥ 56 px at 390 and `details_next_call_follows_an_outcome` < 48 px at 1440 |
| 21 | The character counter and the mail-cut line printed raw numbers ("9500 caractères sur 10000") | `{count, number}` / `{max, number}` in both languages (ff653a4) | Pass. next-intl renders "9,500 of 10,000 characters" and "9 500 caractères sur 10 000" (narrow no-break spaces, U+202F), mail cut "1,500" / "1 500"; DM Mono kept for the counter |
| 22 | French read "ouvre à lun. 09:00" when calling hours open on another day | A second key, `opensAtDay` "… ouvre {day} à {time} ({relative})", with the weekday from Intl (433648a) | Pass. `lead-hours-fr-*` (clock fixed to a Saturday): "ouvre lun. à 09:00 (dans 2 jours)"; `lead-hours-en-light-1440`: "opens Mon 09:00 (in 2 days)"; every French shot taken on this Sunday evening reads the same; e2e `calling hours that open on another day …` passed |
| — | Call panel (finding 15 group): FR heading "Appel de {who}" read as an incoming call; a second Call dropped an open outcome step; the queued-call status was `display:none` while empty, so its first message was not announced | "Appel vers {who}" (5b308f7); the second call waits behind the open one and is named in a status line, focus goes to what finishes the open call (89e99eb, 019b49f); the status line stays in the accessibility tree while empty (`sr-only`, not hidden) (77817a7) | Pass. `lead-call-fr-dark-*` heading "Appel vers Maison Verdane"; `lead-call-queued-*`: the panel keeps Voicemail picked, shows "Finish logging this call first. The call to Maison Verdane · Amélie Laurent opens next." / "Finissez d’abord de noter cet appel. L’appel vers … s’ouvrira ensuite." and the focus ring is on Save; e2e `call_panel_focus_returns … second_call_waits_for_the_open_one` passed. Calm: the line appears without motion; the panel is anchored at the bottom, so the line grows it upwards and the pad under the finger does not move |

Checklist items touched by these fixes, re-checked: 1 (pad keys and chips still press to 0.97); 6 and 12 (the waiting
call never moves or replaces the open panel; the sheet still rises from the bottom on phones); 7 (no new motion: the
queued line, the error states and the toasts appear without animation beyond the toast's existing entrance; skeletons,
no spinner); 10 (French "Appel vers", "ouvre lun. à", locale numbers; no clipped label in the new shots); 12 (skeleton
and page agree on where the actions sit at 1024 and 1280).

### Defects and nits found in this re-check (not fixed here; app code untouched)

1. **Nit: the skeleton has no bar for the header's facts line.** `src/app/(app)/leads/[id]/loading.tsx:21-23` draws
   three header bars (name, status, place); the page draws a fourth line when the lead has a next call or a logged call
   (`src/components/lead/lead-header.tsx:112`), so everything under the header moves down 19 px when the page replaces
   the skeleton (measured at 1024, 1280 and 1440). Fix: add `` <div className={`h-5 w-52 ${bar}`} /> `` after the place
   bar (most leads in use have a next call or a last call), or accept the 19 px.
2. **Nit: the queued line can start a row with "·".** `lead-call-queued-en-light-390` wraps "… The call to Maison
   Verdane / · Amélie Laurent opens next." (the same break the lead header avoided on phones). `whoOf` in
   `src/components/activity/call-panel.tsx:78` joins with `" · "`; fix: `"\u00a0· "` (no-break space before the dot)
   so the dot stays at the end of the first line (the panel heading uses the same string).

## Review round: accepted

- The queued-call line is the same weight as the heading (both bold, 14 px): kept, it is the one instruction in the
  panel at that moment.
- Phone tab strip: in French the fifth tab ("Détails") is cut at the screen edge at 390 (the strip scrolls sideways,
  no edge fade). Not a review-round change; noted for the Day 7 polish pass.

**Follow-up (11 Oct, night):** the nits this re-run found are fixed in bad93a9 and b3d0f47 (skeleton's fourth header
line; focus after a successful Try again and after a keyboard toast Undo, with e2e checks; "Call not logged" read with
Log it through `aria-describedby`; a no-break space before the queued line's dot) or kept for Day 7 (phone call sheet
focus and scroll padding; `<main>` outline; the French "Détails" tab cut at 390 without a fade). See README "Review round".
