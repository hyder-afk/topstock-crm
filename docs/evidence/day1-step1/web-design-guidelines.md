# web-design-guidelines on src/ (Day 1 step 1, 9 Oct 2026). First real run of tool 5.

Rules: pinned `command.md` at web-interface-guidelines `434b7f9`, SHA-256 `d246b026…0234` (matches the pin in the skill).
Findings before fixes, then the fix. The design choice of sentence case (Apple style, DESIGN.md) is kept over the guideline's Title Case.

## src/app/layout.tsx
src/app/layout.tsx:41 - no skip link to main content → added skip link (`Common.skipToContent`) targeting `#main`

## src/components/settings-bar.tsx
src/components/settings-bar.tsx:27 - `role="radiogroup"` + `role="radio"` without arrow-key handling → switched to a labelled `role="group"` of `aria-pressed` toggle buttons (native keyboard behaviour)
src/components/settings-bar.tsx:36 - 36 px targets on touch → `min-h-11` on phones, 36 px from `sm`

## src/app/error.tsx
src/app/error.tsx:7 - hardcoded strings (CLAUDE.md conventions) → `Error` messages in en.json / fr.json
src/app/error.tsx:9 - button has no hover state → `hover:brightness-105`

## src/app/page.tsx
src/app/page.tsx:38 - brand tagline (kept in English on the French page) lacks `translate="no"` → added
src/components/logo.tsx:10 - brand name in the SVG label: `translate` is not a valid SVG attribute in React types; left as `aria-label`, no visible text to translate

## src/app/loading.tsx
src/app/loading.tsx:4 - skeleton has no text for screen readers → visually hidden "Loading…" (`Common.loading`)

✓ pass: theme-color meta, color-scheme per theme, focus-visible ring, reduced motion, no `transition: all`, explicit SVG size, status dot has a text label, no zoom blocking.
