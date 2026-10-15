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
| `lose-dialog` (key 5 on a Negotiations card: the reason picker and the note) | en light, fr dark | 390, 1440 | 4 |
| `reopen-dialog` (a won deal's sheet, then Reopen…: back to which stage, leaves the month's won total) | en light, fr dark | 390, 1440 | 4 |
| `delete-dialog` (the Delete key on a card: the confirmation before the code) | en light, fr dark | 390, 1440 | 4 |
| `board-error` (the first read fails on the server: the board's own error with Retry, the shell standing) | en light, fr dark | 390, 1440 | 4 |
| `board-refresh-error` (a later read fails in the browser: `/api/pipeline/board` answers 502 via `page.route`, "Couldn't refresh" with Retry above the cards) | en light, fr dark | 390, 1440 | 4 |
| `column-error` (Show more in Lead: `/api/pipeline/stage` answers 502 via `page.route`, "Couldn't load more" with Retry in that column) | en light, fr dark | 390, 1440 | 4 |
| `empty-board` (a rep with no deal: the board's empty line and each column's) | en light, fr dark | 390, 1440 | 4 |

### Added 15 Oct 2026 (Day 5 advisor round, item 4)

The last seven rows come from two new tests in the same spec ("dialogs: …" and "board errors …"), run on the build of
d29be68 (Chromium 141). How each state is reached:
- `board-error`: the board's first read is a server read (the page hands the client a promise, design D32), which
  `page.route` cannot reach, so for these four shots the local stack's superuser takes `execute` on
  `public.pipeline_board` away from `authenticated` and gives it back in `finally` (checked after: granted again).
  This is `board.tsx`'s `BoardError` (the advisor's board.tsx:136).
- `board-refresh-error`: the advisor's `page.route` 502 on `/api/pipeline/board`, which the board reads in the
  browser on its 30 s refresh (run at once on Playwright's fake clock) and one retry: the "Couldn't refresh" status
  with Retry (`board.tsx` around line 595).
- `column-error`: `column.tsx`'s Show more failure (the advisor's column.tsx:214); 60 made-up deals are added to Lead
  for these shots and removed after.
- Shots that inject a 502 allow Chromium's own "Failed to load resource: the server responded with a status of 502"
  console line and nothing else; every other shot still fails on any console error, and every shot on sideways scroll.

Looked at all 28: the reason picker's eight reasons and the note at both widths; Reopen and Delete as phone sheets at 390 and centred dialogs at 1440; the board error with
the shell's dock; the refresh status at the toolbar's end (1440) and under the filters (390); "Couldn't load more ·
Retry" above "Showing 50 of 63" at the column's foot; the empty board's line with "Open the leads" and each column's
empty line. At 390 the Lose sheet is taller than the screen and scrolls inside (Cancel at the fold): as designed for
phone sheets, not changed here.

The matching e2e (`tests/auth/pipeline.spec.ts`): `board_read_fails_shows_retry_and_recovers` (the first read refused
on the server, then Retry renders the board; a later browser read 502 twice, then Retry brings a deal made meanwhile)
and `column_read_fails_shows_retry_and_recovers` (Show more 502, the loaded cards kept, then Retry shows 100).

