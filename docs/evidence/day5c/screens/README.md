# Day 5c screenshots (Home)

Made by `tests/auth/home-screens.spec.ts` (Chromium 141, local stack, `DAY5C_SCREENS_DIR=docs/evidence/day5c/screens`),
except `v1-home-queue-*` (verifier round 1, `day5-screens.spec.ts`). The person is an admin in an org made for the run,
so the figures are the fixture's. Each shot: URL asserted, no console error, no sideways scroll (a shot fails on
either). Names: `<screen>-<locale>-<scheme>-<width>.png`. The full matrix is 390, 768, 1024, 1280, 1440, 1728 ×
en/fr × light/dark (24 files).

| Screen | Locales × schemes | Widths | Files | Last taken |
|---|---|---|---|---|
| `home` (with data, before Day 6: Low stock shows its placeholder) | en/fr × light/dark | full | 24 | 14 Oct (cff0ea2) |
| `home-new-org` (a new org's empty states) | en light, fr dark | 390, 1440 | 4 | 14 Oct (cff0ea2) |
| `home-card-error` (Needs attention failing alone) | en light, fr dark | 390, 1440 | 4 | 14 Oct (cff0ea2) |
| `home-deal-sheet` (the deal sheet over Home) | en light, fr dark | 390, 1440 | 4 | 14 Oct (cff0ea2) |
| `home-loading` (`loading.tsx` during a held navigation, first screen) | en light, fr dark | 390, 1440 | 4 | 14 Oct (cff0ea2); re-taken 15 Oct for item 3, byte-identical (the Low stock card is below the fold) |
| `home-queue-before-4c` | en light | 1440 | 1 | 14 Oct (cff0ea2) |
| `home-low-stock-day6` (Low stock filled from Day 6's `stock_alerts()` shape: 3 products, 2 with stock in transit, 3 follow-up lines) | en/fr × light/dark | full | 24 | 15 Oct, advisor items 2 and 3 (was en light and fr dark at 390 and 1440 only) |
| `home-low-stock-loading` (`loading.tsx` full page: the Low stock skeleton beside the other cards' skeletons) | en/fr × light/dark | full | 24 | 15 Oct, advisor item 3 (new) |
| `v1-home-queue` (Work queue card with Day 4c's counts) | en light, fr dark | 390, 1440 | 4 | 15 Oct (verifier round 1, feaa316) |

The Low stock shots also check, before each screenshot, that no text line of a product row is cut (`scrollWidth` within
`clientWidth`), and the loading shots that the skeleton card's height is within 20 px of the filled card's at 390 and
768 (full-width card; from 1024 the grid row stretches both cards to Recent activity's height). Looked at: every
Low stock width in EN and FR, with 1024 and 1280 (the card at 5 of 12 columns) closest: the figures line fits whole,
no "Low" badge, "+300 in transit" / "+300 en transit", rows no longer touching; the skeleton beside the filled card at
390 (same blocks, same rows).

The whole spec re-ran on d29be68 (4 passed, 93 shots, every check above); only the sets item 3 affects were kept, the
others left as committed (the rest of Home did not change; new copies differ only in times such as "13 minutes ago").
