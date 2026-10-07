# CRM prototype v4: brand pack applied (7 Oct 2026)

Artifact: https://claude.ai/artifact/3ppCxqmfgKHs5uRidvcNv6 (version 6). Source: `docs/prototype/topstock-crm-prototype.html`.
Brand source: TopStock Brand Pack v9 (essentials copied to `docs/brand/`: README, tokens, logo SVGs, fonts with OFL licence).
This is the throwaway prototype, not the Next.js app. The app gets these choices through `DESIGN.md` on Day 1.

## What changed

- **Colour:** TopStock Black `#0E0E10`, Chalk White `#F5F3EF` page, white cards (light) / Charcoal `#1C1C21` cards (dark).
  Signal Red `#F2203E` is the single accent and fills only what you act on: the dock bead, the Call button, primary buttons, and the mark.
  Small text on any red fill is TopStock Black (4.64:1 on Signal Red, 5.65:1 on the system red of End call, Wrong number and the dock badge), the brand's rule. Status colours unchanged (CLAUDE.md tokens).
- **Type:** Outfit Regular 400 and Bold 700 only, the two weights the brand ships (-3% tracking on headings), DM Mono Medium (column heads, lot codes, container numbers, table numbers).
- **Logo:** the two PNG logos (about 45 KB of base64) replaced by the inline vector primary lockup (mark as the t). Mark always Signal Red,
  word follows the text colour, so one file serves light and dark. Width 184 px desktop, 180 px phone (brand minimum 180 px).
- **Sample data:** sold by the piece (Haider, 7 Oct 2026), with grades (for example "Denim jackets, grade A × 300 pcs"), lot codes,
  container numbers in the ISO 6346 shape the brand pack uses (TSWU 241708 3). All invented and labelled sample data.
- **Voice:** tagline "Small start. Same grade. Big orders." closes the Today screen.

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
| 10 | Typography | Outfit replaces the system stack. This conflicts with the plan, see open point 1. Outfit has proportional digits | Table numbers moved to DM Mono, right-aligned. KPI counters stay Outfit (single left-aligned numbers, no column to align) |
| 11 | Status never colour-only | Every status keeps its label; hot and brand red sit close in hue | kept labels on every status; brand red never used for a status |
| 12 | Spatial consistency | Dock bottom-centre on every width | none needed |

## Web interface guidelines (pinned rules, applied by hand)

Fixed: theme toggle and language chip had no accessible name; toast had no `aria-live`; dock was `role="tablist"` with plain buttons
(now a labelled `nav` with `aria-current`); no `theme-color`; search input had no label or `autocomplete="off"`; brand and code
tokens now `translate="no"`; search was a non-interactive span (now a button).

Advisor round 1 (CHANGES NEEDED), all fixed in version 4: white small text on red (End call, Wrong number, dock badge) now TopStock Black;
`prefers-contrast: more` restored (the brand tokens had overridden it; verified light and dark in Chromium with contrast emulation);
unused `--redt` token removed; logo SVG no longer has both `role="img"` and `aria-hidden`; page loads Outfit 400 and 700 only.

## Checks

- Screenshots in this folder (25, taken on version 5 after the advisor fixes; call-1440-light, leads-stock-1440-dark and v3-390-light retaken on version 6): 1440 light and dark (all four screens, call panel
  light and dark, lead Stock tab), Today and Inventory at 390, 768, 1024, 1280 and 1728 light, Today and Leads at 390 and 1280 in French dark.
  Fonts loaded from the brand pack files (Google Fonts is not on this VM's network list; the published page loads the same 400/700 weights from Google Fonts).
- Browser: the VM's preinstalled Chromium 1194 through a scratch config, not the pinned 1247 build (missing in this VM). WebKit was not run.
- No horizontal scroll at any captured width with the brand fonts loaded (scrollWidth equals the viewport at 390, 768, 1024, 1280, 1728).
  With the fonts blocked (fallback font, as on a first load before Outfit arrives): 390 on all four screens in EN and FR, after the
  Inventory title row was allowed to wrap (advisor round 3 found 402 px). Found and fixed on the way: the search box showed on phones and pushed
  the page to 551 px; the inventory buttons wrapped; the stock tiles stacked one per row; the stock table squeezed the grade column.
- Console: no errors except the local server's missing favicon.
- No em dashes in the page.

## Decisions (Haider, 7 Oct 2026)

1. **Brand palette and fonts adopted for the real app.** CLAUDE.md and the Master Plan still say black, white and greys and the system
   font stack (Master Plan lines 137 and 169, apple-design-audit item 10); Day 1's `DESIGN.md`, the CLAUDE.md design line and audit
   item 10 change to match. Fonts are self-hosted through next/font (no runtime Google Fonts request), only Outfit 400/700 and DM Mono 500.
2. **Stock is sold by the piece.** Sample data changed from bales to pieces (pairs for sneakers). Inventory counts pieces.

Advisor round 3 (CHANGES NEEDED), fixed in version 6: the lead Stock tab coloured availability with a fixed threshold of 10, so lots the
Inventory screen calls Low showed green with no label; it now uses each lot's low-stock level and says the status in words
("340 pieces available · Low"). A sample note still said "cartons"; sneakers now show "pairs" in the Stock tab.

French still covers headings and the dock only; full EN/FR comes with next-intl in the real build.
