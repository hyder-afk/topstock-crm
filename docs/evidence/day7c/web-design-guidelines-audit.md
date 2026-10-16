# Day 7c: web-design-guidelines audit of the PWA and safe-area change (16 Oct 2026)

Skill: `.claude/skills/web-design-guidelines`, rules fetched from the pinned commit
`vercel-labs/web-interface-guidelines@434b7f91364665f2f733b310ec54809bf8f37937/command.md` (191 lines, HTTP 200).
Scope: the files the PWA and safe-area change touches. Format as the rules ask (`file:line`, terse).

## src/app/globals.css

src/app/globals.css:98 - Safe Areas: body pads top/right/left insets with viewport-fit=cover ✓
src/app/globals.css:104 - FIXED: dialog scroll lock zeroed the safe-area padding (page jumped by the inset behind sheets); `body[data-scroll-locked]` keeps it
src/app/globals.css:11 - FIXED: `min-h-dvh` wrappers + top padding gave an unwanted scroll of 47 px; `min-h-safe-screen` = 100dvh − top inset
src/app/globals.css:95 - touch-action: manipulation ✓
src/app/globals.css:91 - -webkit-tap-highlight-color set intentionally ✓
src/app/globals.css:66,83 - color-scheme light/dark on :root ✓
src/app/globals.css:282 - overscroll-behavior: none on html only inside `@media (pointer: fine)` ✓

## src/app/layout.tsx

src/app/layout.tsx:39 - viewportFit "cover" ✓; no user-scalable=no / maximum-scale ✓
src/app/layout.tsx:41-42 - theme-color per scheme = page background (unit-tested against --background) ✓
src/app/layout.tsx:31 - appleWebApp statusBarStyle "default": system bar opaque, no content under it ✓

## src/app/manifest.ts

✓ pass (standalone, scope/start_url "/", any + maskable icons, theme/background = Chalk White; "TopStock" brand name kept)

## src/app/(app)/layout.tsx, src/app/(auth)/layout.tsx, src/app/(share)/layout.tsx, src/app/error.tsx

src/app/(app)/layout.tsx:22 - FIXED (P2): min-h-dvh → min-h-safe-screen
src/app/(auth)/layout.tsx:7 - FIXED (P2): same
src/app/(share)/layout.tsx:4 - FIXED (P2): same
src/app/error.tsx:9 - FIXED (P2): same

## src/components/pipeline/deal-sheet.tsx

src/components/pipeline/deal-sheet.tsx:88 - FIXED (P1): full-bleed bottom sheet below 1024 px now clears the top inset (max-h) and pads left/right insets (landscape notch)
src/components/pipeline/deal-sheet.tsx:201 - overscroll-behavior: contain on the sheet's scroller ✓; bottom inset padded once ✓

## src/components/activity/call-panel.tsx

src/components/activity/call-panel.tsx:369 - FIXED: phone panel max-h clears the top inset
src/components/activity/call-panel.tsx:371 - FIXED (P1): floating card ≥640 px keeps max(24px, right inset) from the notch side
src/components/activity/call-panel.tsx:363-365 - reduced-motion variant ✓; transform/opacity only ✓

## src/components/share/share-page.tsx

src/components/share/share-page.tsx:259 - FIXED (P1): fixed bottom bar pads max(16/24px, side inset) in landscape; bottom inset already max(12px, inset) ✓
src/components/share/share-page.tsx:171 - note (not from this change): content pb-32 (128 px) clears the bar; the bar grows by the bottom inset (+22 px at 34), still under 128 px. Focused fields near the bottom rely on that padding, no scroll-padding-bottom; left as is

## Outside this change

Rules on forms, copy and typography were not re-audited here: the change adds no text, control or animation.

Result: 7 findings, all fixed in this change; 0 open.
