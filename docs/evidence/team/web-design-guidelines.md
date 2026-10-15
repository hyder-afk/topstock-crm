# Team screen: Web Interface Guidelines review, 12 Oct 2026 (re-run 14 Oct 2026 on ed2ad60 and after the verifier round)

Skill `web-design-guidelines`, rules fetched from the pinned commit
`vercel-labs/web-interface-guidelines@434b7f91364665f2f733b310ec54809bf8f37937/command.md`. Files:
`src/components/team/team-list.tsx`, `src/components/team/team-entry.tsx`, `src/app/(app)/more/team/page.tsx`,
`src/app/(app)/more/team/loading.tsx` (and the More page row). Screenshots in `screens/` checked alongside.

## Findings and what was done

```text
## src/components/team/team-list.tsx

team-list.tsx (names, user id) - identifiers machine-translated → translate="no" on the name and the User ID (fixed, 330ceb8)
team-list.tsx (RoleMenu) - "Saving…" line grew the row while saving (layout shift) → removed; button dims, aria-busy, live region says it (fixed, 330ceb8)
team-list.tsx (No name yet row) - the role button's name says "Account c9b5074f" while the row shows "User ID c9b5074f" → kept: both carry the same 8 characters; "Role for Account …" reads better than "Role for User ID …"
team-list.tsx:ul - list not virtualised → kept: a team of 3 to 10 people (the page reads the organisation’s profiles, sorted on the server)

## src/app/(app)/more/team/page.tsx

page.tsx:h1 - outline-none → kept: the title only takes focus from code (tabIndex -1) when Try again replaces the error block; it is not a control
page.tsx (headings, buttons) - Title Case → kept: the app's house style is sentence case in both languages (EN and FR)

## src/components/ui/dialog.tsx (shared, not changed here)

dialog.tsx - no overscroll-behavior: contain on the sheet → kept: the confirmation never scrolls (four short lines); a shared-component change belongs to the Day 7 polish pass

## src/components/team/team-entry.tsx

✓ pass

## src/app/(app)/more/team/loading.tsx

✓ pass
```

Re-run 14 Oct: the rules were fetched again from the same pinned commit and every rule group checked against the
four files and the 50 screenshots in `screens/`. No new finding in the code; the e2e run found one behaviour bug
(a saved role shown as the old one after "Confirm it’s you", fixed in ed2ad60, see `apple-design-audit.md` row 11).

## Checked and passing

- Accessibility: every control is a `<button>` or `<Link>`; the role button's name says whose role and which
  ("Role for Henri Durand: Rep"); decorative icons `aria-hidden`; one polite live region (`role="status"`) for saving,
  saved, refused and cancelled; the refusal is also the button's `aria-describedby`; headings h1 > h2 in order.
- Focus: global `:focus-visible` ring; the role button is locked with `aria-disabled` (never `disabled`) while saving, so
  focus is never dropped; after the confirm, "Confirm it's you", a refusal or a cancel, focus returns to that row's role
  button (e2e checks each). Stepping yourself down is the one path where that button disappears (the Team page goes
  away): the focus goes to More's title (`h1#more-title`, `tabIndex={-1}`, through `ArrivalFocus`), never to
  `<body>`; e2e `demoting_yourself` checks it. (The 14 Oct text said "every path" before this existed: the verifier
  found the focus fell to `<body>` there; corrected.)
- Destructive action: every role change goes through a confirmation naming the person and the new role, with a warning
  when you step down.
- Locale: dates through next-intl `getFormatter` (Intl) on the server in the person's time zone, passed as text (no
  hydration mismatch); French with narrow no-break spaces and typographic apostrophes (unit test).
- Content: long names wrap (`break-words`); the dialog text `text-pretty`; empty and error states exist.
- Touch: role buttons and dialog buttons are 44 px tall at least (e2e measures the dialog at 390).
