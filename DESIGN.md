# DESIGN.md: TopStock CRM design system (source of truth)

Decided by Haider on 7 Oct 2026: the app uses the TopStock brand (Brand Pack v9, essentials in `docs/brand/`).
Apple-like behaviour (springs, calm motion, keyboard-first) on a TopStock look. Tokens live in `src/app/globals.css`.
Where this file and the Master Plan section 6 differ, this file wins.

## Colour
| Role | Light | Dark |
|---|---|---|
| Page background | `#F5F3EF` Chalk White | `#0E0E10` TopStock Black |
| Card / surface | `#FFFFFF` | `#1C1C21` Charcoal |
| Muted surface (wells, tracks, avatars) | `#EBE8E2` | `#2A2A30` |
| Selected segment | `#FFFFFF` | `#3A3A42` |
| Border | `#DDD9D2` | `#34343B` |
| Text | `#0E0E10` | `#F5F3EF` |
| Text muted | `#5A5A62` (6.2:1) | `#A8A8B0` |
| Primary (neutral) button | `#0E0E10` on chalk | `#F5F3EF` on black |
| **Brand accent: Signal Red** `#F2203E` | fills only | fills only |

- **One accent.** Signal Red fills only what you act on: the dock bead, the Call action, the primary button, and the logo mark.
  Small text on any red fill is TopStock Black (`#0E0E10`, 4.64:1). Never white text on red.
- **Status colours** appear only as small dots or labelled badges, never as the accent. Light text tokens: green `#15702F`,
  amber `#7C5300`, red `#B61C29`. Dark: `#30D158`, `#FFD60A`, `#FF6961`. Every status also carries a word or symbol.
- Deep Red `#B5122F` is for illustration shading only, never for type.

## Type
- **Outfit** Regular 400 for text, Bold 700 for headings (tracking -3%). **DM Mono** Medium 500 for codes, lot numbers,
  container numbers, column heads and numbers that line up.
- Self-hosted with `next/font/local` from `src/app/fonts/` (no Google request). Only these three files.
- Outfit has proportional digits: money and counts in tables use DM Mono, right-aligned.
- French runs about 20% longer: never fix label widths.

## Logo
- Primary lockup (the block-T mark as the first "t"), `src/components/logo.tsx`. Mark always Signal Red, word follows the text colour.
- Minimum width 180 px (brand rule); 184 px in the header. Use the submark tile below that.

## Shape and spacing
8pt grid. Radius: cards 20, controls 12, small 8, sheets 24. Page padding 32 desktop, 16 phone.
Borders and tone for depth; shadow only on floating layers (dock, popovers, call panel). Glass only on floating layers,
with a solid fallback under `prefers-reduced-transparency`.

## Motion
Springs, transform and opacity only, interruptible, starting from the current value. Entrances on first visit only.
`prefers-reduced-motion` removes entrances and stretch, keeps direct manipulation. Press feedback within 100 ms (scale 0.97).

## Taste Skill overrides (from docs/preflight.md)
shadcn/ui only (customised to these tokens, never default state); Lucide icons allowed; no image generation or stock images;
dials low variance 3, medium motion 5, medium-high density 7.

## Loading and speed
Every route has a `loading.tsx` skeleton matching the final layout. Every list has loading, empty and error states. No spinners.
