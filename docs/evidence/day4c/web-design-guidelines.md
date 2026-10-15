# Web Interface Guidelines review: Day 4c, 12 Oct 2026

Rules pinned at
`https://raw.githubusercontent.com/vercel-labs/web-interface-guidelines/434b7f91364665f2f733b310ec54809bf8f37937/command.md`
(fetched for this review). Files: `src/components/tasks/*`, `src/components/queue/*`,
`src/components/shell/timezone-form.tsx`, `src/app/(app)/tasks/*`, `src/app/(app)/leads/queue/*`, the lead header's
"on this lead" line, and the routes `/api/tasks`, `/api/queue/*`. Plus the screenshots in `screens/`.

## Findings and fixes (8d2a3f7)

```text
## src/components/tasks/quick-add.tsx
quick-add.tsx (submit) - errors inline, but the focus stayed put on a refused Add → the first field to fix takes the focus (the title, or a meeting's time)

## src/components/tasks/task-row.tsx
task-row.tsx (li) - lists grow by pages of 50 with no off-screen skipping → content-visibility: auto with a 64 px intrinsic size per row

## src/components/tasks/tasks-workspace.tsx
tasks-workspace.tsx (tabs row) - bare key caps with no words → one line of words ("T new task · J/K move · …"), aria-hidden caps removed

## src/components/queue/queue-card.tsx
queue-card.tsx (place line) - "open until 18:00" built from a string → Intl, in the lead's zone
queue-card.tsx (contacts) - name truncated in a flex row on phones → wraps on its own line (min width), titles break-words

## src/components/queue/queue-rail.tsx
queue-rail.tsx (note) - textarea without autocomplete → autocomplete="off"

## src/components/queue/queue-workspace.tsx
queue-workspace.tsx (note sheet) - textarea without autocomplete → autocomplete="off"; autoFocus kept with its reason written next to it (the sheet opens only to type the note)
queue-workspace.tsx (scope switch) - overflowing segments hidden in a scroll strip (French at 390) → wraps

## src/components/leads/leads-workspace.tsx
leads-workspace.tsx (Work queue link) - prefetch={false} made a click wait for the server with no skeleton → default prefetch, which stops at the queue's loading skeleton (no data read, nothing claimed)
```

## Checked and passing

- **Accessibility:** icon-only buttons have `aria-label` (task menu, unlink a lead, phone note); every field is
  labelled (quick add, edit, lead search, note, time zone); actions are `<button>`, navigation is `<a>`/`<Link>` (lead
  links, Back to leads, the card's Call is a `tel:` link); decorative icons `aria-hidden`; toasts and the queue's
  "Logged … Next: …" message are polite live regions; headings in order (h1 page, h2 card name and "How did it go?",
  h3 card sections); the leaving card is `inert` and hidden from assistive tech; the lead picker is a WAI-ARIA combobox
  (`aria-expanded`, `aria-controls`, `aria-activedescendant`, options with `aria-selected`).
- **Focus:** visible rings from the global focus style; no `outline-none` without a replacement; the focus is moved
  after every removal (see the Apple audit's "Touch and keyboard").
- **Forms:** names on every input; `autocomplete="off"` on non-auth fields; placeholders end with "…"; Add, Save,
  Retry and Confirm stay enabled with `aria-disabled` and say why (needs a title, a meeting needs a time); no paste
  blocking.
- **Animation:** transform and opacity only (card slide, row fade and layout); listed transition properties, never
  `all`; reduced motion handled; interruptible springs.
- **Typography:** "…" everywhere, curly quotes and apostrophes (French typography checked by `messages.spec.ts`),
  DM Mono (fixed-width digits) for counts and times; "Loading…", "Saving…", "Adding…", "Starting…".
- **Content:** long titles and lead names `break-words`; `min-w-0` on flex children; an empty state per tab
  ("Nothing due today." …) and per queue end (all done, outside hours with the next opening, no leads of one's own).
- **Navigation and state:** the Tasks tab and scope are in the URL (`?tab=`, `?scope=`, written with
  `replaceState`); the queue's state is deliberately not in the URL (claims start on an explicit Start, design 4.2).
  Destructive actions: Delete asks first and needs a fresh code; Done, Dismiss and outcomes have Undo.
- **Touch:** `touch-action: manipulation` and the tap highlight are set globally; sheets use `overscroll-behavior:
  contain`; no gesture-only action.
- **Dark mode:** `color-scheme` per theme; native selects (time zone, assignee) have explicit background and text.
- **Locale:** every date, time and number through Intl (`useFormatter`, ICU plurals and ordinals); phone numbers and
  zone names `translate="no"` where shown as codes.
- **Hydration:** times that depend on the viewer render after mount (`useClientNow`); the time zone list is drawn on
  the server and sent to the form, so the browser's own list never changes the options.

## Not followed, on purpose

- **Title Case for headings and buttons:** the project writes sentence case (Master Plan override, as in every earlier
  step).
- **Virtualising lists over 50:** task pages of 50 use `content-visibility: auto` instead (design D13's approach).

Unresolved: none.

## Verifier round (12 Oct 2026)

Files: `src/components/queue/use-queue.ts`, `src/components/queue/queue-workspace.tsx`, `src/components/queue/queue-card.tsx`,
`src/components/tasks/task-row.tsx`, `src/app/(app)/leads/queue/page.tsx`, `messages/*.json`; rules as pinned above.

```text
## src/components/queue/queue-workspace.tsx
- Focus management: focus moved programmatically only to the element that replaces the one that left (card heading,
  page title, Start, empty-state heading); never to <body>. pass
- Live regions: the claims-ended notice is role=status (polite); the lost-claim message goes through the one toast
  region (no second live region). pass
- Link text: "Log your call to {lead}" names its destination; the lead name keeps dir="auto". pass
- Touch: the notice link min-h-11 below 640 px. pass
## src/components/tasks/task-row.tsx
- Hit target: 44 px tap area on phones via a pseudo-element (the visual line stays 24 px). pass
## src/components/queue/queue-card.tsx
- Dates/times: Intl in the lead's zone ("open until") and the profile zone (follow-up time); no hand-made formats. pass
## messages/*.json
- No hardcoded strings: the script without a name, the notice and the named toast are messages in EN and FR; French
  narrow no-break space before ":" and "?" (unit-checked). pass
```

Unresolved: none.


## Review round 3 (12 Oct 2026)

Files: `src/components/queue/{use-queue.ts,queue-workspace.tsx,queue-rail.tsx}`, `src/components/ui/toast.tsx`,
`src/components/activity/call-panel.tsx`, `src/components/tasks/{task-row.tsx,tasks-workspace.tsx,lead-picker.tsx,use-tasks.ts}`,
`src/app/(app)/leads/queue/loading.tsx`, `src/components/shell/timezone-form.tsx`, `messages/*.json`.

```text
## src/components/queue/queue-workspace.tsx
- Live regions: one polite region kept mounted across start, working and empty, so "Logged … for …" survives the
  switch to the empty state; the "Logged" toast is drawn outside the toast live region (quiet), so each outcome is read
  once; it is read when it also says a card went to a teammate. pass (finding 19)
- Spoken times: the next lead's time says "their time" (Queue.theirTime). pass
- Empty state: no role=status on a section holding buttons; its heading (tabIndex -1, aria-labelledby) takes the focus. pass
- Focus: the restored card after Undo, the error card's Retry (title, then the first card) and Cancel in the follow-up
  never leave the focus on <body>. pass (findings 9, 14)
- Keyboard: U and Cmd/Ctrl+Z work on the empty state and the loading card; the page owns U (data-owns-undo) so the
  lead page's global listener stands aside. pass (findings 4, 5)
## src/components/queue/queue-rail.tsx
- Below 1024 the follow-up / Do not contact panel (role=group, named by the outcome) scrolls into view with
  scroll-margin clear of the fixed dock and takes the focus. pass (finding 15)
## src/components/tasks/tasks-workspace.tsx, task-row.tsx, lead-picker.tsx
- Enter on a role=checkbox button never toggles (WAI-ARIA checkbox: Space only; X is the page's key). pass (finding 16)
- The title count has an sr-only sentence (ICU plural, EN and FR) and a title. pass (finding 22)
- After picking a lead the chip's remove button takes the focus. pass (findings 10, 17)
- A row restored while fading out shows its real state (aria-checked). pass (finding 11)
## src/app/(app)/leads/queue/loading.tsx
- Skeleton text is aria-hidden and transparent; one sr-only "Loading". pass
## messages/*.json
- No U+237D; no-break spaces inside key hints; French narrow no-break spaces (unit-checked). pass
```

Unresolved: none.
