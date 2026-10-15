# Team screenshots: More > Team

Taken by `tests/auth/team-screens.spec.ts` against the local auth stack (production build), on made-up people in an
organisation made for the run: Inès Garnier (admin, the signed-in person), Malo Perrin (manager), Sofia Lambert (rep)
and one account without a name yet (rep). Each shot waits for the real screen (not the skeleton, except the skeleton
shots) and fails on any console error or sideways scroll.

**Current set: taken on 15 Oct 2026 on 2ab9969** (after the merge of Day 5 with 4c and 4d, 4711172; the manager and
rep role descriptions now name deals and files). Run: `team-screens.spec.ts`, Chrome Headless Shell 156, 4 tests
passed, 50 shots, no console error (cancelled prefetches filtered with `isCancelledPrefetch`, each page `settled()`
before it closes, as `lead-page.spec.ts`), no sideways scroll. Previous sets: 15 Oct on bc79fa6 (the merge of main
5f1a966), 14 Oct 2026 on 6d07187 (verifier round), same 50 file names.

| State | Matrix | Shots |
|---|---|---|
| `team` (the list, full page) | 390, 768, 1024, 1280, 1440, 1728 × light and dark × English and French | 24 |
| `team-skeleton` (route `loading.tsx`, held on the way in from More) | 390, 1024, 1440 × English light and French dark | 6 |
| `team-menu` (the role menu with each role's description) | 390 and 1440 × English light and French dark | 4 |
| `team-confirm-self` (the confirmation for your own step-down, with the warning) | same | 4 |
| `team-step-up` ("Confirm it’s you" after Confirm, code older than 10 minutes) | same | 4 |
| `team-last-admin` (refused: the row goes back to Admin and says why) | same | 4 |
| `more-admin` (More with the Administration > Team row) | same | 4 |

The dock is fixed to the bottom of the window, so on full-page shots it sits over the content at the window's height
(here the Roles card or the last row); in the app the page scrolls past it (bottom padding of the app shell).
