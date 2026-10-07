# CRM prototype v4: brand pack applied (7 Oct 2026)

Artifact: https://claude.ai/artifact/3ppCxqmfgKHs5uRidvcNv6 (version 3). Source: `docs/prototype/topstock-crm-prototype.html`.
Brand source: TopStock Brand Pack v9 (essentials copied to `docs/brand/`: README, tokens, logo SVGs, fonts with OFL licence).
This is the throwaway prototype, not the Next.js app. The app gets these choices through `DESIGN.md` on Day 1.

## What changed

- **Colour:** TopStock Black `#0E0E10`, Chalk White `#F5F3EF` page, white cards (light) / Charcoal `#1C1C21` cards (dark).
  Signal Red `#F2203E` is the single accent and fills only what you act on: the dock bead, the Call button, primary buttons, and the mark.
  Type on red is TopStock Black (4.64:1, the brand's rule for small text on red). Status colours unchanged (CLAUDE.md tokens).
- **Type:** Outfit (UI and headings, -3% tracking on headings), DM Mono (column heads, lot codes, container numbers, table numbers).
- **Logo:** the two PNG logos (about 45 KB of base64) replaced by the inline vector primary lockup (mark as the t). Mark always Signal Red,
  word follows the text colour, so one file serves light and dark. Width 184 px desktop, 180 px phone (brand minimum 180 px).
- **Sample data in the brand's units:** graded bales with weight (for example "Denim jackets, grade A · 45 kg"), lot codes,
  container numbers in the ISO 6346 shape the brand pack uses (TSWU 241708 3). All invented and labelled sample data.
- **Voice:** tagline "Small start. Same grade. Big orders." closes the Today screen. "Sample order" became "Test bale".

## Apple design audit (docs/apple-design-audit.md, 12 items)

| # | Item | Finding | Fix |
|---|---|---|---|
| 1 | Instant response | New search button had no press state | `:active` scale 0.98 added; buttons, chips, cards already had one |
| 2 | Tracks the finger | Dock bead and call panel drag unchanged, 1:1 with hysteresis | none needed |
| 3 | Momentum | Bead and call panel project velocity, spring snap | none needed |
| 4 | Interruptible | Springs start from the current value | none needed |
| 5 | Rubber-band | Bead and call panel rubber-band at the ends | none needed |
| 6 | Animate from current value | Tab pill, FLIP on Kanban, call panel grows from the Call button | Tab pill colour moved to its own token so it reads on the new grounds |
| 7 | Calm | Tabs used `transition: all` | changed to `transition: color` |
| 8 | Reduced motion | New hover and press transitions were not covered | added to the reduced-motion block |
| 9 | Materials | Glass only on the dock and call panel; tint retuned to Chalk / Charcoal | none further |
| 10 | Typography | Outfit replaces the system stack (brand decision). Outfit has proportional digits | Table numbers moved to DM Mono, right-aligned. KPI counters stay Outfit (single left-aligned numbers, no column to align) |
| 11 | Status never colour-only | Every status keeps its label; hot and brand red sit close in hue | kept labels on every status; brand red never used for a status |
| 12 | Spatial consistency | Dock bottom-centre on every width | none needed |

## Web interface guidelines (pinned rules, applied by hand)

Fixed: theme toggle and language chip had no accessible name; toast had no `aria-live`; dock was `role="tablist"` with plain buttons
(now a labelled `nav` with `aria-current`); no `theme-color`; search input had no label or `autocomplete="off"`; brand and code
tokens now `translate="no"`; search was a non-interactive span (now a button).

## Checks

- Screenshots in this folder: 1440 light and dark (all four screens), 1280, 768 and 1728 in French, 390 phone light and French dark.
  Fonts loaded from the brand pack files (Google Fonts is not on this VM's network list; the published page loads them from Google Fonts).
- No horizontal scroll at 390 on any screen (scrollWidth 390). Found and fixed on the way: the search box showed on phones and pushed
  the page to 551 px; the inventory buttons wrapped; the stock tiles stacked one per row; the stock table squeezed the grade column.
- Console: no errors except the local server's missing favicon.
- No em dashes in the page.

## Open points (Haider decides)

1. **Brand vs current design rules.** CLAUDE.md and the Master Plan say black, white and greys with pure white / pure black backgrounds.
   The prototype now uses the brand palette (Chalk page, TopStock Black, Signal Red accent). If approved, Day 1's `DESIGN.md` and the
   CLAUDE.md design line change to match.
2. **Products.** The brand pack describes graded second-hand clothing in bales; the sample data now uses bales, grades and kg.
   Correct this if your stock is sold differently.
3. French covers headings and the dock only, as before; full EN/FR comes with next-intl in the real build.
