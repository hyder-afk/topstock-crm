# Day 7c part 2: /apple-design audit of the French and phone pass (16 Oct 2026)

Skill: `anthropic-skills:apple-design` (Apple's fluid-interface principles from *Designing Fluid Interfaces*, WWDC
2018, translated to the web, plus the foundations: feedback, spatial consistency, restraint; Apple's 44 pt minimum
hit target). Scope: the screens part 2 changes, at 390 x 844 in EN and FR, light and dark. Evidence: `phone/` (48
route shots and 18 sheet shots) and the CI checks in `tests/auth/phone.spec.ts`.

## What was checked, and the verdict

| Principle | What we looked at | Verdict |
|---|---|---|
| Direct manipulation needs a finger-sized target (44 pt) | Every link, button, field and control on 12 routes and 9 sheets, measured by hit-testing (what a tap really reaches, pseudo-element extensions included) | **Nine gaps, fixed.** Today card task link (20 px), deal sheet title link (25 px), product name link (36 px), Views / Columns (40 px wide), the in-field buttons of the date, time and search fields (40 px), EN / FR segments (41-42 px), and the timeline's entry menu, 44 px drawn but only 40 px tappable because 4 px sat outside a `content-visibility` row that clips. Links grew their hit area with a phone-only pseudo-element, so rows keep their height and their skeletons still match. Now enforced in CI on every route and sheet, EN and FR |
| Spatial consistency: the dock floats over content, never hides it | The page's end at each route, scrolled to the bottom | **Pass.** `main` keeps `pb-36`; the last content ends above the dock on all 12 routes in both languages (CI) |
| Content clears the hardware | Emulated 47 / 34 insets (Chromium) | **Pass, now in CI** (`phone_safe_areas`): header below the status bar, dock 16 px above the home indicator, deal sheet's top below the notch |
| Sheets belong to the screen they rise over | Add lead, new deal, deal sheet, Lose, note, call panel after the call (its tallest state), record sale, hold stock, command menu | **Pass.** Each fits inside the 390 x 844 viewport, scrolls inside itself, 44 px targets, whole labels (CI). The Lose dialog over the deal sheet and its Escape order behave (two presses close both) |
| Legibility and restraint with longer French | Every route and sheet in French | **Three fixes.** The stalled reason on Home lost its day count to an ellipsis (now two lines, `text-pretty`); the pipeline's lost line left a "·" hanging at a line end (the link now takes its own line on phones); the queue's scope control broke into two uneven rows (now one row of three, the long middle label wrapping inside its segment). No control or heading label is cut anywhere (CI check) |
| Continuity: a strip that scrolls says so | Tab strips (lead page, inventory, tasks) and chip rows (stock filters, quick-add dates, sales, share, pipeline owners and stage tabs) | **Added.** An edge fades only while more items lie past it (`edge-fade`, a mask driven by the strip's own scroll position; no motion of its own, so reduced motion is unaffected, and no fade where the strip fits). A tab revealed by the keyboard or a deep link now lands clear of the fade (`revealTab` leaves 24 px, except at the strip's ends), and the snapped first item no longer sits flush in the fade (`scroll-px`) |
| Feedback within 100 ms | The changed controls | **Pass, unchanged.** They keep `active:scale-[0.97]` (or the row's `0.99`) and their colour transitions; the new hit areas belong to the same element, so the press shows on the visible control |
| Motion | Nothing new animates; the sheets' rise and the pill's spring are unchanged | **Pass** |

## Left open

- A real iPhone check (Safari's own insets, standalone mode) still needs a device: Haider's phone on the Vercel
  preview after the push. The emulated insets prove the CSS.
- Data inside list rows (lead and product names, notes) may still truncate by design; the CI label check covers
  controls and headings, the screenshots cover the rest.

Verdict: **pass after the fixes above.**
