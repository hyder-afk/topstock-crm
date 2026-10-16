# Day 7c: /apple-design audit of the PWA and safe-area change (16 Oct 2026)

Skill: `anthropic-skills:apple-design` (Apple's fluid-interface principles from *Designing Fluid Interfaces*, WWDC
2018, translated to the web: motion starts from the on-screen value, inherits velocity, can be grabbed and reversed;
plus the foundations: feedback, spatial consistency, restraint). Scope: the Day 7c PWA basics and safe areas only
(`src/app/globals.css`, `src/app/layout.tsx`, `src/app/manifest.ts`, and the follow-up fixes below). Evidence:
`screens/` (112 shots plus 2 "before" shots) and `screens/measurements.json`, `screens/measurements-768-1024.json`.

## What was checked, and the verdict

| Principle | What we looked at | Verdict |
|---|---|---|
| Spatial consistency: the page behind a sheet stays where it was | Opening the deal sheet with insets emulated (portrait top 47) | **Was broken, fixed.** Radix's scroll lock (react-remove-scroll-bar) rewrites the body's padding from its margins while a dialog is open, so the safe-area padding dropped to 0 and the whole page jumped up by 47 px behind the sheet (`before-fix-insets-portrait-deal-sheet-en-light.png`: body padding 0). Now `body[data-scroll-locked]` keeps the three insets (`globals.css:104`); measured: body padding stays 47 with the sheet open (`insets-portrait-deal-sheet-*`) |
| Content never sits under hardware (notch, status bar, home indicator) | Every screen at 390 x 844 (top 47, bottom 34) and 844 x 390 (left and right 47, bottom 21) | **Two gaps, fixed.** (1) The phone deal sheet rose to 12 px from the top, so its grabber and title sat under the status bar (before shot); its height is now `100dvh - max(12px, top inset)`, top edge measured at 47. (2) In landscape the full-width deal sheet's text started 21 px from the edge, under the notch; it now pads the side insets (content at 68 px from the left and 60 px from the right, measured). The call panel's floating card (640 px and up) keeps `max(24px, right inset)` from the right edge and its phone height clears the top inset; the share page's fixed bar pads `max(16 / 24px, side inset)` |
| No doubled insets | The phone deal sheet and the dock at portrait insets | **Pass.** The body pads top, left and right only; the sheet pads the bottom inset once (34, no descendant adds another 30 px or more: `bigBottomSpacing: []`), the dock floats 16 + 34 = 50 px from the bottom |
| Restraint: a page is as tall as the screen, not taller | Full-height wrappers inside the padded body | **Was broken (README P2), fixed.** `min-h-dvh` wrappers plus the body's 47 px top padding made every page 47 px taller than the screen, so even a short page scrolled. The four wrappers now use `min-h-safe-screen` (`100dvh` less the top inset, `globals.css:11`); measured overflow 0 on every inset shot (it was 47) |
| Motion | The change adds no animation. The sheet's rise (`deal-sheet` keyframes, transform and opacity) and the call panel's spring (`springs.sheet`, drag to dismiss with projected velocity, reduced-motion variant `call-panel.tsx:352-365`) are unchanged; only their edges moved | **Pass, unchanged** |
| Full-screen look from the home screen | `appleWebApp` capable, title "TopStock", status bar "default"; `display: standalone`; theme colours equal the page backgrounds | **Pass.** "default" keeps the system status bar opaque, so the top inset is 0 in standalone and content is not drawn under it; the translucent style would need the top inset everywhere (now handled anyway) |
| Feedback and legibility | Light and dark, EN and FR, 390 to 1728 (plus 768 and 1024 for the sheet's range) | **Pass.** No clipped French strings in the shots, no sideways scroll (0 on all 112 measured shots), no console errors |

## Left for part 2 (real device)

- The emulated insets prove the CSS; a real iPhone in standalone (part 2's phone pass) confirms Safari's own values,
  the landscape home-indicator inset and the status bar colour.
- P3 stays: one manifest theme colour, so the splash is Chalk White in dark mode too.

Verdict: **pass after the three fixes above** (scroll-lock jump, P2 full-height overflow, P1 sheet under status bar and
notch).
