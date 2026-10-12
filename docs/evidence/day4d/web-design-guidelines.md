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
| 6 | Hydration safety for dates | The "this year?" test used the device clock | Uses next-intl's request-wide `now` (server and browser agree); dates use `Intl` through `useFormatter` with the app's zone (e5f6d65) |

## Checked and passing

- Accessibility: icon-only buttons (row menu, dismiss) have `aria-label`s naming the file; decorative icons
  `aria-hidden`; a polite live region announces uploading, checking, added, cancelled and refused; the progress bar is
  `role="progressbar"` with values and a text value while checking; the list is labelled by the heading; the drop zone
  has a real button (dropping is an extra), so nothing is pointer-only.
- Focus: dismissing a refused upload or a finished upload moves the focus to Choose files (never to `<body>`); a delete
  moves it to the tab's heading; the step-up dialog returns it where it was (existing hook); menus return it to their
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
- Touch: 44 px targets on phones (Add file, row menu, dismiss, Retry), `touch-action: manipulation` and the tap
  highlight are global.
- Not applicable: images (no previews: design section 12), virtualisation (pages of 50).

## Not changed (with reasons)

- Title Case for buttons and headings: DESIGN.md uses sentence case in both languages (Day 2 decision).
- URL state for the upload list: uploads are in-flight work, not navigable state; the tab itself is in `?tab=files`.

Unresolved: none.
