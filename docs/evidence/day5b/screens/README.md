# Day 5b screenshots

Made by `tests/auth/day5-screens.spec.ts` (Chromium 156, local stack, `DAY5_SCREENS_DIR=docs/evidence/day5b/screens`)
on 14 Oct 2026, after the layout fixes (7d5d68c). The person is a rep, so the board holds only their own made-up deals.
Each shot: URL asserted, no console error, no sideways scroll. Names: `<screen>-<locale>-<scheme>-<width>.png`.

| Screen | Locales × schemes | Widths | Files |
|---|---|---|---|
| `pipeline` (the board) | en/fr × light/dark | 390, 768, 1024, 1280, 1440, 1728 | 24 |
| `deal-sheet` (Winter coats, Negotiations) | en/fr × light/dark | 390, 768, 1024, 1280, 1440, 1728 | 24 |
| `lead-deals` (the lead's Deals tab, full page) | en light, fr dark | 390, 1440 | 4 |
| `win-dialog` (key 4 on a Negotiations card) | en light, fr dark | 390, 1440 | 4 |
| `new-deal` (`?new=1`) | en light, fr dark | 390, 1440 | 4 |
| `call-open-deal` (Interested with a deal already open: the switch off, the reason shown) | en light, fr dark | 390, 1440 | 4 |
| `pipeline-loading` (`loading.tsx` during a held navigation) | en light, fr dark | 390, 1440 | 4 |
