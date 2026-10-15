# Web Interface Guidelines audit: Day 7a "Sign out of all devices" (More button and sheet), 15 Oct 2026

Skill: web-design-guidelines (Vercel Web Interface Guidelines). Files: `src/components/shell/sign-out-everywhere.tsx`,
`src/app/(app)/more/page.tsx`, `src/app/(app)/more/loading.tsx`, `messages/en.json` and `fr.json` (`More.everywhere`).

| Area | Check | Result |
|---|---|---|
| Semantics | Real `<button type="button">` elements; Radix dialog gives `role="dialog"`, `aria-modal`, title and description wired by `DialogTitle` / `DialogDescription` | pass |
| Focus | Focus moves into the sheet, is trapped, and returns to the button on close (Radix); visible focus ring on controls | pass |
| Keyboard | Escape and Cancel close; Enter or Space activate buttons; no shortcut conflicts | pass |
| Busy state | Confirm disabled with `aria-busy` while pending; the sheet cannot be dismissed mid-request | pass |
| Errors | Inline, with words, in a live region (`FormMessage`), sheet stays open; no raw error text | pass |
| Copy | Says what happens, here and elsewhere, now honest about timing ("Other devices lose access within an hour at most." / "Les autres appareils perdent l’accès en une heure au plus."); confirm label is the action ("Sign out everywhere") | pass |
| i18n | All strings in messages; French typographic apostrophes; no hard-coded text | pass (unit `messages.spec.ts`) |
| Touch | 44 px minimum targets; phone sheet bottom-anchored with safe-area padding | pass |
| Layout | No horizontal scroll at 390 to 1728; buttons stack below 640 px | pass (screens) |
| Destructive confirm | A confirmation step, no native `confirm()` | pass |
| Loading | More's skeleton includes both sign-out buttons | pass |

Result: no findings.
