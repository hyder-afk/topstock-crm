# Day 4c screenshots: the Tasks page, the work queue, "on this lead"

Taken by `tests/auth/screens.spec.ts` (tests "tasks page: today with rows, overdue, inline edit, delete question,
team", "work queue: start screen, a card, a follow-up open, no leads of one's own", "lead page: a teammate on this lead
in the queue" and "tasks and queue: route skeletons") in the whole-suite run on **e8ce3c9**, 12 Oct 2026, production
build, Chromium, against the local auth stack (the isolated copy on port 3200: README, deviation 12). Made-up data: the
screenshot admin Inès Garnier (zone Europe/Paris) with seven tasks (a Do not contact lead's task, a call task at 23:30
on a London lead, one two days overdue, an undated one, a meeting in three days); queue leads "File Maison Verdane"
(a contact, three entries) and four "File Durand SARL" leads in a country in calling hours at the time of the run
(Pakistan here, so Karachi is the city; the queue follows the real clock); a second admin with no leads; "Atelier
Occupé" claimed by a teammate "Henri" for the worked-by line. Each shot waits for the real screen (or the skeleton, for
the skeleton shots) and fails on any console error or sideways scroll; none failed.

**Re-taken after the verifier's round** (12 Oct 2026, on 2d01de0 with the screens spec of the evidence commit, the
isolated local stack on port 3200): the test "work queue: start screen, a card, a follow-up open, the claims ended, no
leads of one's own" ran again (70 shots, none failed). It now parks the person's other leads (next call in 30 days,
put back afterwards) so the card is always "File Maison Verdane" whatever the clock (in the morning UTC, other
fixtures' Spanish Negotiation leads came first), and it adds `queue-released`: the start screen after the claims ended
(the page's own clock moved 10.5 minutes on), with the link to log the call. The kept `queue-*` shots here are from that
run (Lyon, France this time); the Tasks, worked-by and skeleton shots are unchanged (the Tasks change is a tap area
with no visible change).

| State | Matrix | Shots |
|---|---|---|
| `tasks` (Today with rows) | 390, 768, 1024, 1280, 1440, 1728 × light and dark × English and French | 24 |
| `tasks-overdue`, `tasks-edit` (inline edit, E), `tasks-delete` (the delete question; viewport shots) | English light at all six widths; French dark 390, 1280, 1440, 1728; English dark and French light 390 and 1440 | 14 each |
| `tasks-upcoming`, `tasks-done-empty` ("Nothing done yet."), `tasks-team` (initials) | English light and French dark at 390 and 1440 | 4 each |
| `queue-start` (scope, counts, lunch switch, Start) | all six widths × both themes × both languages | 24 |
| `queue-card` (a card with the rail) | all six widths × both themes × both languages | 24 |
| `queue-followup` (5 pressed: the follow-up chips open in the rail) | as `tasks-overdue` | 14 |
| `queue-released` ("Your leads went back to the team", with "Log your call to …"; Start has the focus) | English light and French dark at 390 and 1440 | 4 |
| `queue-none-mine` ("No leads are assigned to you" with "Work unassigned leads") | English light and French dark at 390 and 1440 | 4 |
| `lead-worked-by` ("Henri is on this lead in the queue (until …)") | English light and French dark at 390 and 1440 | 4 |
| `tasks-skeleton`, `leads-queue-skeleton` (route skeletons, the page's data request held; viewport shots) | English light and French dark; Tasks at 1024 and 1440, the queue at 390 and 1440 | 4 each |

160 Day 4c shots (the full matrix is the CI artifact "auth-screens"). This folder keeps 56: the Tasks page and the
queue's start screen and card at every width in English light, plus phone and desktop in the other combinations;
overdue, inline edit and the delete question at 390 and 1440; the follow-up, the empty states, the claims-ended state,
the worked-by line and all eight skeleton shots. Full-page shots on phones show the dock where the page ends (it is fixed to the screen).

**Re-taken in review round 3** (12 Oct 2026, on the round's head, the shared local stack started from this worktree,
Next on 3100): the tests "app shell", "tasks page", "work queue" and "tasks, queue and more: route skeletons" ran
again (4 passed, none of their shots failed on a console error or sideways scroll). Every kept shot except
`lead-worked-by-*` (unchanged) was replaced by its new version, and four states were added:

| State | Matrix | Shots |
|---|---|---|
| `queue-followup-view` (Interested pressed: at 390 the follow-up and Confirm come into view above the dock; at 1440 nothing moves) | English light and French dark at 390 and 1440 | 4 |
| `queue-not-saved` ("1 outcome not saved · Retry" in the header on the start screen) | English light and French dark at 390 and 1440 | 4 |
| `more` (time zone on More; from the app-shell test) | English light and French dark at 390 and 1440 kept (14 taken) | 4 |
| `more-skeleton` (More's route skeleton, data request held) | English light and French dark at 390 and 1440 | 4 |

`leads-queue-skeleton-*` now wraps as the page does: compare `leads-queue-skeleton-fr-dark-390` with
`queue-start-fr-dark-390`. 168 Day 4c shots plus 14 More shots this run; this folder now keeps 72.
