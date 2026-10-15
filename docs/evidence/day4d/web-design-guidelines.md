# Day 4d: Web Interface Guidelines review (Files tab)

Skill `web-design-guidelines`, rules fetched from the pinned commit
`vercel-labs/web-interface-guidelines@434b7f91364665f2f733b310ec54809bf8f37937` (`command.md`), 12 Oct 2026. Files:
`src/components/files/files-tab.tsx`, `src/components/files/use-files.ts`, the Files tab in
`src/components/lead/lead-page.tsx`, `src/app/(app)/files/unavailable/{page,loading}.tsx`, the Files messages.

## Findings and what was done

| # | Rule | Finding (before) | Fix |
|---|---|---|---|
| 1 | Never `outline-none` without a focus replacement | The tab's heading (`tabIndex=-1`, focused after a delete and after Try again) had `outline-none` | Removed: the global `:focus-visible` ring shows (e5f6d65) |
| 2 | Form controls need a label | The hidden file input had only `aria-describedby` (and showed up as a second, unlabelled "button" to assistive technology) | The input is `aria-hidden` and out of the tab order; the visible button, described by the limits, is the one control |
| 3 | No-break spaces in "10 MB" | The limits, the too-big and the space-full messages broke between number and unit | `10 MB` / `800 MB` / `10 Mo` with U+00A0, EN and FR (e5f6d65) |
| 4 | Error messages include the next step | "This file isn't really a PDF." said only the problem | Each refused type now says what to do ("Save or export it as a PDF again, then add it."; Word and Excel: "without macros"); too big: "Make it smaller, or split it." (e5f6d65) |
| 5 | `translate="no"` on identifiers | File names could be machine-translated by the browser | `translate="no"` on the name (e5f6d65) |
| 6 | Hydration safety for dates | The "this year?" test used the device clock | Uses next-intl's request-wide `now`; dates use `Intl` through `useFormatter` with the app's zone (e5f6d65). Verifier round 2 finding 12: the year itself was still read with `getFullYear()` (the process zone: UTC on the server, the device's in the browser), so around New Year the two disagreed; now both years are read through the formatter (`fileDateLabel` in `src/lib/files/dates.ts`, unit-tested at 00:30 on 1 January in Paris) |
| 7 | Focus never to `<body>` (verifier round 2, findings 8, 10, 11, 13) | Cancel unmounting at "checking" or swapping for Dismiss on error, "Show older files" unmounting after the last page, and the stuck delete's Retry becoming `disabled` while busy each dropped the focus to the page | The line's focus moves after the commit to its new button or to the line (`tabIndex=-1`); "Show older files" is one button that becomes Try again under an inline error, and after the last page the focus moves to the first file that arrived; Retry uses `aria-disabled`, so it keeps the focus through a failed retry |
| 8 | Status messages (WCAG 4.1.3; finding 14) | The polite region said only "`name` wasn't added"; files past 5 were not announced | "`name` wasn't added. `reason`", and one plural summary for the files past 5; the region keeps separate nodes so several outcomes in one render are all read; while the tab is hidden the toast says it too (finding 18) |
| 9 | Accessible names per control (finding 11) | The stuck delete's control was announced as "Retry" for every file | `aria-label` "Retry deleting `name`" / "Réessayer de supprimer `name`"; the upload line's Try again is "Try `name` again" |
| 10 | Error messages say what to do (finding 9) | A file the browser could not read was called fake ("isn't a real Word file") | Its own reason, "Couldn't read this file. Choose it again." / "Impossible de lire ce fichier. Choisissez-le à nouveau." |
| 11 | Loading and error states for every list (finding 10) | A failed older page showed nothing; no loading cue | Inline error with Try again (`isFetchNextPageError`) and two skeleton rows while the page loads |
| 12 | Drag and drop must not navigate (finding 17) | A file dropped outside the zone replaced the page | Window `dragover`/`drop` cancelled outside the zone while the tab is shown |
| 13 | Focus never to `<body>` (verifier round 3, finding 1) | Closing the Delete dialog (Escape, Cancel, a cancelled code, a failed delete) returned the focus to the menu item that opened it, which was gone | `onCloseAutoFocus` returns it to the row's Actions (or its Retry once stuck deleting, or the heading when the row is gone); e2e `delete dialog focus` |

## Checked and passing

- Accessibility: icon-only buttons (row menu, dismiss) have `aria-label`s naming the file; decorative icons
  `aria-hidden`; a polite live region announces uploading, checking, added, cancelled and refused (with the reason); the
  progress bar is `role="progressbar"` with values and a text value while checking, on a track visible in both themes
  (finding 15); the list is labelled by the heading; the drop zone
  has a real button (dropping is an extra), so nothing is pointer-only.
- Focus: dismissing a refused upload or a finished upload moves the focus to Choose files (never to `<body>`); a line
  changing state keeps the focus on the line or its new button; a delete moves it to the tab's heading, and closing the Delete dialog without deleting returns it to the row's Actions (Retry once stuck deleting); the step-up dialog returns it where it was (existing hook); menus return it to their
  trigger (Radix).
- Destructive action: delete asks for confirmation, then a fresh code (step-up).
- Links: rows are plain `<a>` to `/api/files/<id>` (Cmd-click and middle-click work; no prefetch on hover); new tabs
  have `rel="noopener noreferrer"` and a visually hidden "(opens in a new tab)".
- Content: long names keep their extension (the stem truncates with an ellipsis, `min-w-0` on the flex parents, full
  name in `title`); the meta line wraps; empty and error states are written out.
- Animation: transform and opacity only (rows rise 8 px, the progress bar's `scaleX` with the `smooth` spring);
  reduced motion: no rise, no layout move, instant progress; the drop zone's highlight is a colour transition listed
  explicitly (`transition-colors`).
- Typography: "…" in "Uploading…" and "Checking the file…"; curly quotes around the name in the delete dialog; sizes
  in DM Mono (fixed width digits).
- Locale: sizes through `Intl.NumberFormat` units (kB/MB, ko/Mo), dates through `Intl.DateTimeFormat`.
- Touch: 44 px targets on phones (Add file, row menu, dismiss, Try again, the whole file row through the stretched
  name link, the stuck delete's Retry at 44 by 44), measured by `phone_390_files` (the first review's "Retry meets
  44 px" was not measured; finding 16); `touch-action: manipulation` and the tap highlight are global.
- Not applicable: images (no previews: design section 12), virtualisation (pages of 50).

## Not changed (with reasons)

- Title Case for buttons and headings: DESIGN.md uses sentence case in both languages (Day 2 decision).
- URL state for the upload list: uploads are in-flight work, not navigable state; the tab itself is in `?tab=files`.

Unresolved: none.
