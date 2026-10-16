# Web Interface Guidelines audit: Day 7f held deal state, 16 Oct 2026

Skill: `.claude/skills/web-design-guidelines` (Vercel Web Interface Guidelines), rules fetched from the pinned commit
`vercel-labs/web-interface-guidelines@434b7f91364665f2f733b310ec54809bf8f37937/command.md` (191 lines, read in full;
byte-identical to the copy Day 7b used). Files: `src/components/pipeline/{deal-sheet,stage-stepper,deal-menu,board}.tsx`,
`src/components/lead/deals-tab.tsx`, `src/lib/deals.ts` (deleteOffered, reopenOffered, freeDeleteUntil),
`messages/{en,fr}.json` (`Errors.blocked`, `Deals.sheet.heldStock`), with the screenshots in `screens/`.

## Findings (fixed)

```text
## src/components/pipeline/deal-sheet.tsx
src/components/pipeline/deal-sheet.tsx:246 - error message states the problem but no next step ("Sort them out first." — where?) → link to the lead's Stock tab, "See the lead’s stock" (Deals.sheet.heldStock, EN/FR)
src/components/pipeline/deal-sheet.tsx:249 - inline link in running text: 44 px target stretched the line on phones → own row, quiet button style, min-h-11 / sm:min-h-9

## src/components/pipeline/stage-stepper.tsx
src/components/pipeline/stage-stepper.tsx:34 - disabled radiogroup with no accessible reason → aria-describedby (the reason's id) + aria-disabled

## src/components/pipeline/deal-menu.tsx
src/components/pipeline/deal-menu.tsx:103 - empty UI: menu could start with a separator when Reopen is hidden → separator only under drawn items
```

## Findings accepted (with the reason)

```text
src/components/pipeline/deal-sheet.tsx:256 - button label sentence case, not Title Case: DESIGN.md sets sentence case for the whole app (EN and FR); kept as everywhere else.
src/components/pipeline/board.tsx:378 - held is read from the cache (getQueryData) when the menu opens: a card whose details were never loaded still shows Reopen/Delete and the server answers with Errors.blocked. Hiding on a guess would hide actions that work; prefetching every card's details on hover is a traffic change for another step. Residual in README.
src/components/pipeline/board.tsx:379 - the 120 s window uses the browser clock against the server's created_at: a skewed clock shows or hides Delete a few seconds early or late; the server decides either way.
```

## Passes (summary by area)

| Area | Result |
|---|---|
| Accessibility | The new control is a real `<Link>` (`<a href>`), named by its text; the reason is plain text read with the stepper (`aria-describedby`); menus keep Radix's roles and labels; no `div onClick` |
| Focus | Global `:focus-visible` ring on the link; the Delete key on a held card does nothing (no dialog opens, focus stays on the card); closing the sheet returns focus as before |
| Forms | No new inputs |
| Animation | No new animation; existing quiet-button press (`active:scale`) and menu settle only (transform/opacity) |
| Typography | Curly apostrophes in EN and FR (`lead’s`, `d’abord`); no "..." |
| Content handling | The reason row wraps (`flex-wrap`); long French text wraps on two lines at 390 without clipping; the row exists only when the state applies |
| Navigation & state | Deep link to `?tab=stock`, prefetched on pointer enter; Cmd/Ctrl-click works (real link) |
| Hydration | `SheetDeleteItem` reads `Date.now()` in a `useState` initialiser inside menu content that only mounts on open (never server-rendered); the Deals tab rows render only after the client list fetch, so `useQuery({ enabled: false })` cannot differ between server and client |
| Dark mode, i18n | Screens in light and dark, EN and FR at 1280/1440/1728/390: no sideways scroll, clean console (asserted in `tests/auth/day7f.spec.ts`) |
| Touch | 44 px target for the link on phones; the card's ⋯ button is 44 px below `lg` (unchanged) |
