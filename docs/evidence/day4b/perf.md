# Day 4b speed at Release 1 size: the lead page database part, 11 Oct 2026

Design: `docs/evidence/day4/design.md` section 8.6 (part 2: P1, P4, P4b). Re-runnable by anyone with
`bash scripts/db-perf.sh`:

1. a throwaway PostgreSQL 16.15 with the auth stand-in the security tests use and every migration, including
   `20261012090000_lead_page.sql`;
2. `supabase/tests/perf_leads.sql`: the Day 3a set (30,015 leads, 10,015 contacts) and the Day 3a list timings;
3. `supabase/tests/perf_day4.sql` part 1 (Day 4a): 300,008 activities and 15,000 tasks, the timeline query timed from a
   stand-in function (P2), and the context timings of one entry;
4. `supabase/tests/perf_day4.sql` **part 2 (new)**: the leads get the Day 4b facts in the design's mix, set with
   triggers off in one update (60% FR, 15% GB, 15% US of which two thirds with a picked zone, 10% DE/BE/ES; 8% with no
   main number; 3% with the main number marked wrong; 2% more Do not contact; Cool off leads with a return date; a fifth
   of the others with a next call within ±10 days). The busiest lead (10,008 entries) and a typical one (8 entries) then
   get what P4 needs: no main number, one contact with a number, the caller's call task due yesterday, and on the
   busiest lead 50 more open tasks. Then P1, P2 on the real RPC, P4 and P4b;
5. `supabase/tests/perf_import.sql`: the Day 3b import and undo, now with the Day 4b lead guard on every insert.

Everything runs as a signed-in admin with two-factor (the first perf user), row level security on. Each timed case runs
10 times to settle (PostgreSQL switches a plpgsql statement to a generic plan from its 6th run), then 5 timed runs are
averaged. Every P4/P4b run is rolled back, so each starts from the same lead and the flood guards never fill. Machine:
this cloud session, 4 vCPU, nothing else running (the mutation runs had finished).

## P1, P4, P4b (budgets: P1 ≤ 8 ms typical / ≤ 12 ms busiest; P4 ≤ 15 ms; P4b ≤ 15 ms)

P4 is `log_activity(…, 'call', 'wrong_number', …, p_contact, 'contact', …, 'Find the right number', p_request_id)` on
the lead's only number: it locks the contact then the lead, marks the contact, completes the due call task, makes
"find the right number" for today and writes the undo record. P4b is `undo_activity` on it, with no fresh code: it
consumes the record, clears the mark, deletes the task through the no-code branch, reopens the call task and deletes
the entry (the D9 trigger puts the last activity back). Average of 5 warm runs, milliseconds:

| Case | Run 1 | Run 2 | Run 3 | Run 4 | Budget |
|---|---|---|---|---|---|
| P1 `get_lead`, the lead with 10,008 entries | 2.85 | 2.54 | 2.84 | 2.86 | 12 |
| P1 `get_lead`, a typical lead | 2.55 | 2.36 | 3.62 | 2.76 | 8 |
| P4 `log_activity`, the lead with 10,008 entries | 9.08 | 7.64 | 8.34 | 9.66 | 15 |
| P4 `log_activity`, a typical lead | 8.45 | 7.64 | 11.70 | 8.37 | 15 |
| P4b `undo_activity`, the lead with 10,008 entries | 7.41 | 5.44 | 6.06 | 6.66 | 15 |
| P4b `undo_activity`, a typical lead | 5.86 | 5.47 | 7.63 | 5.98 | 15 |

Run 3 was noisier across the board (its import and checks below too); a fourth run was added rather than dropping it.

**Found by this measurement and fixed before these runs:** `get_lead` first took about 10 ms on the busiest lead. The
planner had inlined the caller's zone (`private.caller_zone()`, a profile read with an exception guard, about 0.2 ms)
into the next-task sort, so it ran once per open task (51 on that lead). An `offset 0` fence makes it run once: 2.5 to
2.9 ms (commit 36ca1d8).

## P2 on the real RPC (budget 5 / 8 / 10 ms)

Part 1 (Day 4a) timed the timeline query from a stand-in, since `list_lead_activities` did not exist yet; part 2 times
the RPC itself, with its joins (contact name, author, the follow-up task chip, the undo window). Busiest lead, average
of 5 warm runs, milliseconds:

| Case | Run 1 | Run 2 | Run 3 | Run 4 | Budget |
|---|---|---|---|---|---|
| First page | 0.44 | 0.45 | 0.45 | 0.70 | 5 |
| Page at row 5,000 (keyset) | 0.41 | 0.41 | 0.44 | 0.66 | 8 |
| Calls only, first page | 0.43 | 0.44 | 0.42 | 0.74 | 10 |

## Generic-plan check (run 6 of each, every inner statement logged by auto_explain)

After 5 settling runs, run 6 of P1, P2 and P4/P4b on the busiest lead ran with `auto_explain` logging every statement
inside the functions and their triggers (about 260 plans, printed by `scripts/db-perf.sh`).

- **`list_lead_activities`** runs on a generic plan (`$1`…`$4` in the conditions) and keeps the keyset index as an index
  condition: `Index Scan using activities_company_keyset_idx … Index Cond: ((company_id = $1) AND (ROW(created_at, id)
  < ROW($3, $4)))`, stopping at 30 rows, then one primary-key probe per row for the contact and the follow-up task. It
  needs no `force_custom_plan`.
- **`get_lead`** reads the lead by primary key, its contacts by `contacts_company_idx`, its open tasks by
  `tasks_company_idx`, and `call_attempts` walks `activities_company_keyset_idx` newest first and stops at the 6th call.
- **`log_activity` and `undo_activity`**: every statement is a primary-key or short index read
  (`activities_author_request_idx` for the replay checks, `activities_user_created_idx` for the flood guard,
  `tasks_company_idx` for the due tasks, `tasks_created_by_idx` for the task flood guard, `tasks_source_activity_idx`
  when the entry goes). The only sequential scans are on `private.activity_undo`, which holds at most the last 10
  minutes of undo records (empty here): the clean-up delete and the "no undo record" check of the delete policies.
  Every sort is of one row (the task id lists), in memory.

## Context: the Day 3b import and undo with the Day 4b lead guard (P7 is 4c's budget, with the stored zone)

4b adds `lead_guard` to every lead insert and update, so the import's insert path changed. This session's machine is
slower than the one the Day 4a numbers came from, so the comparison is made on the same machine: three runs of Day 4a's
own code (commit 17d0354) right after the Day 4b runs.

| Step | Day 4b runs 1 / 2 / 3 / 4 | Day 4a code, same machine, 3 runs | Day 4a perf.md |
|---|---|---|---|
| Import, 28 calls of 1,000 (average) | 277.8 / 257.1 / 361.4 / 286.8 ms | 280.7 / 265.4 / 264.8 ms | 174–183 ms |
| Undo, 14 calls of 2,000 (average) | 236.7 / 232.1 / 234.4 / 260.2 ms | 226.4 / 229.4 / 250.9 ms | 139–158 ms |
| Undo preview | 105.9 / 108.4 / 174.1 / 114.9 ms | 109.0 / 106.1 / 116.2 ms | 80–90 ms |
| Add rows, 30 calls (average) | 68.2 / 60.9 / 65.5 / 67.4 ms | 61.4 / 65.7 / 63.9 ms | 43.7–44.4 ms |
| Check 30,000 rows | 1,485 / 1,212 / 1,298 / 1,439 ms | 1,299 / 1,242 / 1,190 ms | 866–916 ms |
| Check 50,000 rows | 2,427 / 2,280 / 2,685 / 2,430 ms | 2,303 / 2,238 / 2,032 ms | 1,382–1,695 ms |

Every run gave the Day 3b results exactly (27,356 imported, 281 late duplicates skipped, 2,344 duplicates, 300
rejected; the undo removed 27,256 and kept 100). On the same machine the Day 4b import and undo chunks sit within the
Day 4a code's own spread (runs 1, 2 and 4); run 3 had one 828 ms import call. The lead guard does not show at this
size. The design's P7 (with 4c's stored `call_zone` and `queue_rank`, which recompute on every insert) is re-timed in
4c against these same-machine numbers.

## Part 1 cases, same runs (context)

| Case | Day 4b runs 1 / 2 / 3 / 4 | Day 4a code, same machine | Day 4a perf.md |
|---|---|---|---|
| P2 stand-in, first page / row 5,000 / calls only | 0.20–0.29 / 0.13–0.30 / 0.14–0.33 ms | 0.20–0.22 / 0.13–0.15 / 0.14–0.18 ms | 0.08–0.19 ms |
| One entry logged directly, busiest lead: insert / delete | 3.4–5.5 / 2.4–3.7 ms | 3.3–3.6 / 1.9–2.2 ms | 2.4–3.8 / 1.5–2.3 ms |
| One entry logged directly, typical lead: insert / delete | 1.7–3.0 / 1.4–2.2 ms | 1.7–2.3 / 1.3–1.8 ms | 1.2–1.3 / 1.0–1.1 ms |

A direct insert now also runs `lead_guard` (the touch trigger updates the lead), and a direct delete checks the undo
branch of the delete policy; both stay a few milliseconds.

## Sizes after seeding

`activities` 99 MB, `companies` 47–48 MB, `tasks` 4.3 MB, `audit_log` 31 MB, as on Day 4a: the Day 4b columns add no
index, and `next_action_at` and `phone_wrong_at` changes write no audit diff (design 3.5).
