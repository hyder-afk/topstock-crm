# /web-design-guidelines: Day 4b lead page, 11 Oct 2026

Rules: vercel-labs/web-interface-guidelines `command.md` at commit 434b7f9 (the pinned rules URL, fetched for this
review). Files: `src/components/lead/*`, `src/components/activity/*`, `src/components/ui/tabs.tsx`,
`src/components/ui/textarea.tsx`, `src/app/(app)/leads/[id]/*` (page, loading, not-found), the leads preview, workspace
and table changes, `src/components/shell/shortcuts-dialog.tsx`, `messages/{en,fr}.json` (LeadPage, QuickActions,
CallPanel, Composer, Outcomes, Timeline, Errors, Leads.until, Shortcuts). Plan overrides (docs/preflight.md): no
spinners (skeletons, "Saving…" text and press states instead); sentence case, not Title Case.
Reviewed by the builder on the code and on the screenshots in `screens/`; every fix below was checked again on new
screenshots and by the e2e suites. (Correction, 11 Oct: the call panel fix (11e9eda) had neither when this was first
written; `call_panel_each_outcome` now covers it and the lead page shots were taken again after it, on 08ba920.)

## Found and fixed

src/components/lead/details-tab.tsx - the time zone hint sat inside the select's label (read as part of its name) → a label with `htmlFor`, the hint tied with `aria-describedby`
src/components/lead/details-tab.tsx - hydration mismatch (React 418): country and zone names come from Intl, worded differently by the server's and the browser's data → the lead form and zone names are drawn in the browser only, with a placeholder of the form's shape first
src/components/activity/composer.tsx, outcome-pad.tsx, call-panel.tsx, details-tab.tsx - fields without `name` / `autocomplete` → names on every field, `autoComplete="off"` on note, subject and message
src/components/activity/composer.tsx - the kind selector's labels were cut with an ellipsis (French "Rendez-vous" in the rail) → labels may wrap; never cut
src/components/activity/call-panel.tsx - scroll inside the panel chained to the page; text got selected while dragging the handle → `overscroll-contain`; `select-none` on the handle
src/components/lead/lead-page.tsx - the phone composer sheet chained its scroll to the page → `overscroll-contain`
src/components/activity/timeline.tsx - entry titles were h4 directly under a card's h2 in Summary (a skipped level) → h3 there, h4 under the timeline's day headings (h3)
src/components/activity/timeline.tsx - the timeline filter lived only in React state → in the URL (`?filter=calls`), like the tab (`?tab=`), with `replaceState`
src/components/activity/call-panel.tsx - `aria-modal` on a region (not supported, ESLint jsx-a11y) → removed; the panel is a labelled region that does not trap focus
src/components/lead/local-time.tsx, timeline.tsx, outcome-pad.tsx, lead-cards.tsx, details-tab.tsx - times formatted as "02:43 PM" in English → `hourCycle: "h23"` everywhere (the design's "14:05")
src/components/lead/lead-cards.tsx - a Do not contact lead offered chips to plan a call → no chips there ("No next step.")
src/components/lead/lead-header.tsx - the place and the local time ran together on phones, with a "·" starting the second line → two lines on phones, one from tablet width
src/components/providers/query-provider.tsx - Zod 4's eval probe (`Function("")`) was reported as a CSP violation (`script-src`) in the browser → `z.config({ jitless: true })` (the same validation, no probe)
src/app/(app)/leads/[id]/not-found.tsx - a missing lead showed the app's generic not-found with "Go to Home" → the same words with "Back to leads"
src/components/activity/call-panel.tsx - closing the panel (✕, Esc, drag down) with an outcome picked but not saved dropped the call with no warning → every first close shows "Call not logged · Log it" (outcome and note kept); a second close or Don't log ends it
src/lib/drafts.ts, src/components/auth/forms.tsx - unsent note text stayed in a shared browser after signing out → the sign-in page clears every draft

## Checked, no change

- Icon-only buttons have `aria-label` (close the panel, entry options, edit a contact, previous and next lead, dismiss the log chip, task checks "Mark “…” done"); decorative icons are `aria-hidden`.
- Buttons for actions, links for navigation: Back, Open lead, J/K arrows and the import link are `<Link>`; Call, Email and WhatsApp are real `<a>` links (`tel:`, `mailto:`, `wa.me`) so long-press and copy work; no clickable div or span.
- Every control has a visible label or `aria-label`; the composer's limits are in `aria-describedby` (counter and the reason Save cannot run, `aria-live="polite"`).
- Toasts are one polite live region; logging errors are a toast that keeps the composer's text; the call panel's "Call not logged" is a status.
- Focus: the global `:focus-visible` ring; tabs use a roving tabindex with arrows, Home and End; End call moves focus to the pad; tab panels are focusable; dialogs return focus (Radix; the step-up dialog's own restore).
- Destructive actions: deleting an entry asks first and then needs a fresh code; outcomes, task checks and status changes have Undo; Do not contact names itself on the Save button.
- Animation: transform and opacity only, listed transitions (no `transition: all`), the panel's transform origin is the Call button, springs are interruptible, everything respects `prefers-reduced-motion`.
- Typography: "…" in placeholders and "Saving…"; curly quotes ("Mark “{title}” done"); counts, times, phone numbers and the timer in DM Mono with `tabular-nums` for the timer; headings `text-wrap: balance` (globals).
- Content: long names, notes, emails and addresses wrap (`break-words`, `break-all` for addresses); flex children have `min-w-0`; empty states for the timeline (all and filtered), next step, contacts, Deals and Stock; notes clamp at 6 lines with Show more (and the full text from `get_activity` past 2,000 characters).
- Performance: timeline pages of 30 with `content-visibility: auto` per row; no layout reads in render (the panel's origin is measured in an effect and on click); hover prefetch after 120 ms; the composer's draft is written 300 ms after typing stops.
- Touch: 44 px targets on phones, `touch-action: manipulation` and the tap highlight set globally, safe-area padding at the bottom of the phone call panel; the drag-to-close gesture has the ✕ button and Esc as alternatives.
- i18n: Intl for every date, time, relative time and number; zone and country names from Intl; phone numbers `translate="no"`; EN and FR keys checked for parity and French typography (`messages.spec.ts`).
- Hydration: times that depend on now or on the viewer's zone are drawn after mount (a placeholder of the same size first); `useSyncExternalStore` with server snapshots for the viewer's zone, the online state and the width.
- Dark mode: native selects, date and time inputs use the theme tokens; `color-scheme` set globally.

## Accepted, noted

- Leaving the page with text in the composer gives no warning: the draft is kept per lead and comes back (design 7.2).
- A missing lead is answered with the not-found screen but an HTTP 200: the page streams behind its loading skeleton (Next.js sends the status before the page knows), the same as other streamed routes.
- Native date and time pickers follow the browser's language and clock settings.

## Review round, 11 Oct 2026 (re-check on f2c900b)

Rules: the same pinned `command.md` (vercel-labs/web-interface-guidelines at 434b7f9), fetched again for this pass.
Files: the review round's changes in `src/components/activity/{call-panel,composer,timeline,outcome-pad}.tsx`,
`src/components/lead/{lead-page,lead-cards,details-tab,lead-header,local-time}.tsx`, `src/app/(app)/leads/[id]/loading.tsx`,
`src/components/ui/toast.tsx` (the states the fixes use) and `messages/{en,fr}.json` (`opensAtDay`, `CallPanel.calling`,
`CallPanel.queued`, `Composer.counter`, `Composer.mailCut`, `Timeline.errorOlder`, `Timeline.showMoreError`). Checked on the
code, on the screenshots taken again on f2c900b (`screens/`, 103 lead page shots, no console error, no sideways
scroll) and by the lead page e2e tests named below (Chromium, 9 of 9 passed on f2c900b this round).

### Focus moves (findings 8, 9, 15, 16, 17): pass

src/components/activity/call-panel.tsx:137, 258 - (15) closing, saving or "Call not logged" dropped focus to `<body>` → Save, Don't log and the second close put focus back on the Call button that opened the panel (or the button that started the waiting call; `<main>` if it is gone), "Call not logged" focuses Log it; only when focus was in the panel or lost (ff36402, 019b49f). Re-check: e2e `call_panel_focus_returns (WCAG 2.4.3) and second_call_waits_for_the_open_one` passed; `lead-call-*` shows the ring on the first pad key after End call, `lead-call-queued-*` on Save
src/components/lead/lead-cards.tsx:84 - (16) a checked task took its focused check away → focus moves first to the next task's check, else the previous, else the Next step heading (`tabIndex=-1`) (6ebd4d4). Re-check: e2e `task_check_keeps_focus` passed
src/components/lead/lead-cards.tsx:103-106 - (8) task Undo ignored a refused answer → the error toast says so (6ebd4d4). Re-check: same e2e, "a refused task Undo says so"
src/components/activity/composer.tsx:133 - (9) Meeting focused the first `[aria-pressed]` (the Note kind) → `[data-meeting-kind] [aria-pressed="true"]` (6cf80d8). Re-check: e2e `meeting_quick_action` passed
src/components/activity/timeline.tsx:536-544, 663 - (17) Escape, Cancel or a save ended the inline edit and dropped focus → Edit text focuses the text box (Radix's return to the trigger is prevented), closing focuses the entry's options button, unless the reader moved on (569e094). Re-check: e2e `timeline_edit_focus` passed

### Locale numbers (finding 21): pass

messages/en.json:805-806, messages/fr.json:805-806 - raw numbers in the counter and mail-cut lines → `{count, number}` / `{max, number}` (ff653a4). Re-check with next-intl on the real files: "9,500 of 10,000 characters", "9 500 caractères sur 10 000" (U+202F narrow no-break spaces, the Intl French group separator), "1,500" / "1 500" in the mail-cut line

### "ouvre lun. à 09:00" (finding 22): pass

src/components/lead/local-time.tsx:123, messages/fr.json:677 - "ouvre à lun. 09:00" → `opensAtDay` "… ouvre {day} à {time} ({relative})" with the weekday from `Intl.DateTimeFormat` (`weekday: "short"`), the time with `hourCycle: "h23"` (433648a). EN `opensAtDay` "opens {day} {time}". Re-check: `lead-hours-fr-light-390/1440`, `lead-hours-fr-dark-390/1440` (clock fixed to Sat 10 Oct 2026 12:00 UTC): "ouvre lun. à 09:00 (dans 2 jours)"; `lead-hours-en-light-1440`: "opens Mon 09:00 (in 2 days)"; e2e `calling hours that open on another day …` passed

### Tap targets (findings 19, 20): pass

src/components/lead/lead-page.tsx:312, src/components/lead/lead-cards.tsx:282 - (19) See the whole timeline and Add contact were 36 px on phones (`min-h-9` replaced the base `min-h-11` in tailwind-merge) → `min-h-11 sm:min-h-9` (bd48cdb, 91cc2d6); tailwind-merge now keeps both classes. Re-check: e2e `dnc_lead_logs_at_every_width` measures both ≥ 44 px at 390, and Add a note ≥ 44 px at 768 and 390
src/components/activity/outcome-pad.tsx:42 - (20) pad keys 44 px on phones, design 7.9 asks 56 → `min-h-14 sm:min-h-11` (4aa77ed). Re-check: `lead-call-*-390`, `lead-call-queued-*-390`; e2e `phone_return_how_did_it_go` measures ≥ 56 px at 390, `details_next_call_follows_an_outcome` < 48 px at 1440

### Call panel live regions and timer: pass

src/components/activity/call-panel.tsx:376 - the queued-call line is a `role="status"` paragraph that stays in the accessibility tree while empty (`sr-only`, not `display:none`), so its text is inserted into an existing live region and announced (77817a7). Polite, one sentence, no other text in it
src/components/activity/call-panel.tsx:380 - the timer is `role="timer"` with `aria-label` "Time since the call started" / "Temps depuis le début de l’appel" (an `aria-label` on a plain span is not allowed; `timer` takes an author name) (ba0e7ef). Its implicit `aria-live="off"` keeps the seconds from being read out; `tabular-nums` keeps the digits still
messages/fr.json:751 - "Appel de {who}" read as an incoming call → "Appel vers {who}" (5b308f7); `lead-call-fr-*` show it

### Timeline error, Try again and toast states: pass, with one nit below

src/components/activity/timeline.tsx:129-133 - first page failed: `role="alert"` with "Couldn’t load the timeline." and Try again (unchanged)
src/components/activity/timeline.tsx:146-161 - an older page that fails shows `role="alert"` "Couldn’t load older entries." with Try again; the observer waits for the press (no retry loop); the block stays drawn while it tries again (Try again `aria-disabled`, skeleton rows below) so the focused button is not lost mid-request (b91486b). Re-check: e2e `timeline_older_page_error_waits_for_retry` passed (no new request in 4 s; 60 entries and "That’s the whole history." after Try again)
src/components/activity/timeline.tsx:516-525 - Show more that fails (offline or an error answer) keeps the entry closed with Show more still focused and a polite toast "Couldn’t load the full text. Try again." (c720cc3). Re-check: e2e `timeline_show_more_failure_says_so` passed
src/components/ui/toast.tsx:38-40 - toasts are one `role="status" aria-live="polite"` region; error toasts name the next step ("Try again")

### Found in this pass (not fixed here; app code untouched)

src/components/activity/timeline.tsx:129-133, 146-161; src/components/lead/lead-page.tsx:321-325; src/components/lead/lead-cards.tsx:209-213 - nit (WCAG 2.4.3, the class of findings 15-17): when Try again succeeds, the `role="alert"` block holding the focused button unmounts and focus falls to `<body>`; a keyboard user pressing Try again on the older-page error lands at the top of the document instead of on the entries that just loaded. Fix: on success, focus the first newly loaded entry (older page) or the list/card heading (`tabIndex=-1`) when focus was on the Try again button (same `focusWithin`-style guard as the call panel)
src/components/ui/toast.tsx:55-57 - nit (same class): pressing a toast's action (task Undo, entry Undo) by keyboard runs it and unmounts the toast with the focused button, so focus falls to `<body>`. Fix: remember the element focused before the toast took focus (`relatedTarget` of the first focus event) and return to it, else `<main>`
src/components/activity/call-panel.tsx:396-399 - nit: "Call not logged" is a `role="status"` block mounted together with its text, and the focus then moves to Log it inside it; a live region added with its content is often not announced (VoiceOver, NVDA), and the button's name alone ("Log it") does not say why. Fix: `aria-describedby` on Log it pointing to the "Call not logged." paragraph (or put that sentence into the always-present status line at line 376)
src/components/activity/call-panel.tsx:73 - known nit, kept (log 11 Oct, group b): the focus fallback sets `outline: none` on `<main id="main">` permanently, which the rules flag ("never outline: none without a focus replacement") and which also removes the ring when the skip link targets `<main>`. Logged for the Day 7 polish pass (move the fallback into the layout, without the inline style)
src/components/activity/call-panel.tsx:339-343 - nit ("overlays must not cover the focused element"): on phones the call panel is a bottom sheet that does not trap focus, so a page control reached with Tab can sit under it; the import screen's `html:has(.import-action-bar) { scroll-padding-bottom }` pattern would keep it clear. Low impact (keyboard use on a phone during a call is rare); Day 7 candidate

### Checked, no change

- Copy: the new lines are sentence case per the plan override, active voice, and give the next step ("Finish logging this call first. The call to {who} opens next."; "Couldn’t load the full text. Try again."); curly apostrophes in both languages; "Saving…" / "Enregistrement…".
- Do not contact composer (finding 12): three kinds, no `mailto:` or `wa.me` link can render; buttons, not links, for the kinds; `aria-pressed` follows the effective kind (a stale Email/WhatsApp choice reads as Note).
- Skeleton (finding 18): `aria-busy="true"` with a visually hidden "Loading…"; no spinner; the action row matches the page at 1024 and 1280 (`lead-skeleton-*`). The 19 px header-line residual is recorded in apple-design-audit.md.
- Animation: nothing new animates except existing transitions; the pad keys list their transition properties (no `transition: all`); reduced motion unchanged.

**Follow-up (11 Oct, night):** the nits this re-run found are fixed in bad93a9 and b3d0f47 (skeleton's fourth header
line; focus after a successful Try again and after a keyboard toast Undo, with e2e checks; "Call not logged" read with
Log it through `aria-describedby`; a no-break space before the queued line's dot) or kept for Day 7 (phone call sheet
focus and scroll padding; `<main>` outline; the French "Détails" tab cut at 390 without a fade). See README "Review round".
