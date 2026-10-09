# web-design-guidelines on Day 2 (9 Oct 2026)

Rules: pinned `command.md` at web-interface-guidelines `434b7f9` (SHA-256 `d246b026…0234`, unchanged).
Files: `src/components/shell/*`, `src/components/ui/{dialog,kbd}.tsx`, `src/app/(app)/**`, `src/lib/{nav,motion,shortcuts,use-platform}.ts`.
Kept by design: sentence case; no spinners (pending buttons show "Saving…").

## src/components/shell/dock.tsx
dock.tsx:nav - text selectable while dragging the bead → `select-none` on the dock
dock.tsx:bead - pointer-only control → intentional: the links carry the meaning (keyboard: arrows, Home/End, Enter; aria-current), the bead is `aria-hidden`
dock.tsx:links - shortcut hint → native `title` ("G then L"); `aria-keyshortcuts` cannot express key sequences, so not used here

## src/components/shell/command-palette.tsx
command-palette.tsx:input - non-auth field without `autocomplete="off"` → added, plus `spellCheck={false}`

## src/components/shell/shortcuts-dialog.tsx
shortcuts-dialog.tsx - opened from the keyboard, the panel itself took focus and drew a ring around the whole dialog → labelled close button (44 px) takes focus; the panel's own outline is suppressed (it is only focused programmatically)

✓ pass: dialogs have a title and description (Radix), focus trap and return, Escape and overlay close, `overscroll-behavior: contain` on the list;
palette placeholder ends with "…"; empty state; languages named in themselves with `lang`; profile fields have labels, `autocomplete`
(`given-name`, `family-name`), `maxLength`, inline status/error with `aria-describedby`; links for navigation, buttons for actions;
hover states on every control; 44 px targets on phones; dates via `Intl` (next-intl `format.dateTime`, Europe/Paris);
no `transition: all`; reduced motion honoured; no `dangerouslySetInnerHTML`; French spacing (non-breaking before `:` `?`) checked; no em dashes.
