# Day 5c mutations (design 8.3 "5c" plus ten more)

Run with `python3 scripts/db-mutations.py --set day5c` in a throwaway worktree (`scratchpad/wt5c`, its `db-test.sh` copy on port 54362, removed afterwards), on the final migration and `home_attack.sql` (commits 4dda93b and 9e1f3d0). Each row edits the live definition, runs the whole `db-test.sh` (every attack file, the concurrency scripts, advisors) and restores it. A row is caught when the run fails.

First run (on ea0bcf2): 16 of 17 caught. Row 16 (today's tasks for everyone) survived: a rep cannot read other people's tasks, so the rep's view could not tell. Fixed in 9e1f3d0 by checking as an admin, who may read every task in the org. Second run below, on the final code: 17 of 17 caught. Day 5c adds functions only, so no earlier row (Day 3b to Day 5b) moves or needs a re-run; `--anchors` finds every earlier set's anchors once.

## Result (final code)

| # | Protection removed | Result | First failure |
|---|---|---|---|
| 1 | home_summary: no scope check (a rep asking for the team gets the org's figures) | caught | FAIL: "select public.home_summary('team')" succeeded, expected 42501 |
| 2 | Month start in UTC, not the profile zone | caught | FAIL: Karachi month start is 2026-10-01 00:00:00+00, expected 2026-10-31 19:00:00+00 |
| 3 | Day end = day start + 24 h (a 23 or 25 hour day) | caught | FAIL: 25 Oct day end (25 hours later) is 2026-10-25 22:00:00+00, expected 2026-10-25 23:00:00+00 |
| 4 | Win rate counts Opened by mistake | caught | FAIL: team win rate is {"won": 3, "lost": 3, "rate": 0.5000}, expected {"won": 3, "lost": 2, "rate": 0.6000} |
| 5 | The feed selects the entry's text | caught | FAIL: home_recent_activity reads an entry's text or a lost note |
| 6 | home_summary runs as its owner (SECURITY DEFINER: past the row rules) | caught | FAIL: Home function rules broken by home_summary(text) |
| 7 | Tasks due ignores Mine (the org's tasks in Team) | caught | FAIL: team tasks (always mine) is {"today": 4, "overdue": 2, "meetings": 1}, expected {"today": 1, "overdue": 0, "meetings": 0} |
| 8 | Stalled ignores the lead's last activity (Team) | caught | FAIL: team open stalled is 3, expected 2 |
| 9 | Calls today from midnight UTC (Mine) | caught | FAIL: Hugo calls today is {"count": 3, "reached": 2}, expected {"count": 2, "reached": 1} |
| 10 | Win rate shown from 3 closed deals | caught | FAIL: Hugo win rate is {"won": 2, "lost": 1, "rate": 0.6667}, expected {"won": 2, "lost": 1, "rate": null} |
| 11 | home_attention: no scope check | caught | FAIL: "select public.home_attention('team')" succeeded, expected 42501 |
| 12 | home_attention: closing soon means 30 days | caught | FAIL: attention total is 7, expected 6 |
| 13 | home_attention: close date passed not first | caught | FAIL: attention order is {1801fc76-c436-4f86-aea7-b9727d03e84d,ec6414f6-4779-4883-beec-793603abcb19,44e88547-b2f2-472f-80dc-596203ab09bd,baa |
| 14 | home_recent_activity: no scope check | caught | FAIL: "select * from public.home_recent_activity()" succeeded, expected 42501 |
| 15 | home_recent_activity: undo pairs shown (Team) | caught | FAIL: team feed kinds is {undo:lead:Hugo,move:qualified:Hugo,won:won:Hugo,activity:interested:Hugo,lost:lost:Hugo,activity:no_answer:Hiro,mo |
| 16 | home_today_tasks: everyone's tasks | caught | FAIL: Hana today (always her own) is 6, expected 0 |
| 17 | home_low_stock stub callable by anon | caught | FAIL: Home function rules broken by home_low_stock(integer) |

day5c: 17 rows run: 17 caught, 0 documented two-layer rows not caught, 0 not as listed

Design rows 1 to 7 are rows 1 to 7 here. Row 2 and row 3 edit `private.home_window`, the one place the day and month bounds are computed; the fixed-instant checks catch both.


## Verifier round 1 (15 Oct): after the rebase onto Day 4c

All 17 rows re-run (throwaway worktree of cad5528 on port 54482, removed). Row 7 now removes the caller filter from the
day's meetings (overdue and today come from Day 4c's `count_tasks('mine')`), and row 16 (it aimed at the removed
`home_today_tasks`) makes Team call `count_tasks('team')`. **17 of 17 caught.**

| # | Protection removed | Result | First failure |
|---|---|---|---|
| 1 | home_summary: no scope check (a rep asking for the team gets the org's figures) | caught | FAIL: "select public.home_summary('team')" succeeded, expected 42501 |
| 2 | Month start in UTC, not the profile zone | caught | FAIL: Karachi month start is 2026-10-01 00:00:00+00, expected 2026-10-31 19:00:00+00 |
| 3 | Day end = day start + 24 h (a 23 or 25 hour day) | caught | FAIL: 25 Oct day end (25 hours later) is 2026-10-25 22:00:00+00, expected 2026-10-25 23:00:00+00 |
| 4 | Win rate counts Opened by mistake | caught | FAIL: team win rate is {"won": 3, "lost": 3, "rate": 0.5000}, expected {"won": 3, "lost": 2, "rate": 0.6000} |
| 5 | The feed selects the entry's text | caught | FAIL: home_recent_activity reads an entry's text or a lost note |
| 6 | home_summary runs as its owner (SECURITY DEFINER: past the row rules) | caught | FAIL: Home function rules broken by home_summary(text) |
| 7 | Tasks due ignores Mine (the org's meetings in Team) | caught | FAIL: team tasks (always mine) is {"today": 1, "overdue": 0, "meetings": 1}, expected {"today": 1, "overdue": 0, "meetings": 0} |
| 8 | Stalled ignores the lead's last activity (Team) | caught | FAIL: team open stalled is 3, expected 2 |
| 9 | Calls today from midnight UTC (Mine) | caught | FAIL: Hugo calls today is {"count": 1, "reached": 0}, expected {"count": 2, "reached": 1} |
| 10 | Win rate shown from 3 closed deals | caught | FAIL: Hugo win rate is {"won": 2, "lost": 1, "rate": 0.6667}, expected {"won": 2, "lost": 1, "rate": null} |
| 11 | home_attention: no scope check | caught | FAIL: "select public.home_attention('team')" succeeded, expected 42501 |
| 12 | home_attention: closing soon means 30 days | caught | FAIL: attention total is 7, expected 6 |
| 13 | home_attention: close date passed not first | caught | FAIL: attention order is {79ba8eb3-4cdc-4a74-b58e-b88c5ae98e37,4e26b4d1-2aa9-4f21-a597-e495d4bf8cc3,b9b75ce7-c8d9-4ba4-92c5-e274573e0ed9,291 |
| 14 | home_recent_activity: no scope check | caught | FAIL: "select * from public.home_recent_activity()" succeeded, expected 42501 |
| 15 | home_recent_activity: undo pairs shown (Team) | caught | FAIL: team feed kinds is {undo:lead:Hugo,move:qualified:Hugo,won:won:Hugo,activity:interested:Hugo,lost:lost:Hugo,activity:no_answer:Hiro,mo |
| 16 | home_summary tasks: Team counts everyone's tasks (count_tasks('team') for Team) | caught | FAIL: team tasks (always mine) is {"today": 4, "overdue": 2, "meetings": 0}, expected {"today": 1, "overdue": 0, "meetings": 0} |
| 17 | home_low_stock stub callable by anon | caught | FAIL: Home function rules broken by home_low_stock(integer) |
