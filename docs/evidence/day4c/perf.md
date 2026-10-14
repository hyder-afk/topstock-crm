# Day 4c speed at Release 1 size: the work queue and Tasks database part, 12 Oct 2026

Design: `docs/evidence/day4/design.md` section 8.6 (part 3: P3, P3b, P3c, P5, P6, P9, P10) and its generic-plan
check. Re-runnable by anyone with `bash scripts/db-perf.sh`:

1. a throwaway PostgreSQL 16 with the auth stand-in the security tests use and every migration, including
   `20261013090000_tasks_queue.sql`;
2. `supabase/tests/perf_leads.sql`: the Day 3a set (30,015 leads, 10,015 contacts) and the Day 3a list timings;
3. `supabase/tests/perf_day4.sql` parts 1 and 2 (Day 4a, 4b): 300,008 activities, 15,000 tasks, the Day 4b lead facts;
   P1, P2, P4, P4b;
4. `supabase/tests/perf_day4.sql` **part 3 (new)**, described below;
5. `supabase/tests/perf_import.sql`: the Day 3b import and undo (P7 context);
6. `supabase/tests/perf_queue_concurrency.sh` **(new, P10)**: three sessions at once, 100 rounds each.

Everything runs signed in with two-factor, row level security on. Each timed case runs 10 times to settle (PostgreSQL
switches a plpgsql statement to a generic plan from its 6th run when that plan is not worse), then 5 timed runs are
averaged. Every claim is rolled back after it is timed, so each run starts from the same queue. Machine: this cloud
session, 4 vCPU; other sessions of this project were running their own work on the same machine at times (run 2 is the
noisiest).

## Part 3 seed (calling hours follow the real clock)

`claim_next_lead` reads `now()`, so the seed picks, at the moment it runs, a country in hours and one outside hours, and
sets the leads' countries from them: 60% in hours, 20% the US (half with a picked zone, America/Chicago), 20% outside
hours. The three runs were at 00:46, 00:47 and 00:48 UTC on Monday 12 Oct: Fiji (FJ, 12:46 local) in hours, Andorra
(AD, 02:46) outside, the US span outside, so about 40% of the leads were outside hours, as the design asks. (On a
weekend moment with no country in hours, the typical cases would run "outside calling hours too" and the run says so.)

- The perf admin a1 owns about 10,000 leads and has call tasks due (part 1's tasks), so his queue starts with follow-ups.
- The perf rep b4 gets about 6,650 of the unassigned leads for the worst case P3b: all first calls (rank 3), 90% never
  called and outside hours (they sit at the head of the rank 3 walk), 10% called before and in hours.
- A new perf admin a2 gets about 3,350 unassigned leads and has no task, so his queue walks the ranks (Team, Mine +
  unassigned, 200 skipped). About 10,000 leads stay unassigned.
- has_contact_phone is recomputed (parts 1 and 2 seed with triggers off); 200 live claims by the perf rep c4 across the
  team. Queue facts after the seed (run 1): 18,323 leads with a rank (3,057 / 3,043 / 3,672 / 8,551 at ranks 0 to 3),
  5,267 callable now.

## Results (milliseconds, average of 5 warm runs)

| Case | Run 1 | Run 2 | Run 3 | Budget |
|---|---|---|---|---|
| P3 `claim_next_lead` Mine, a1, Start (2 cards, from his due follow-ups) | 12.35 | 12.06 | 10.48 | 25 |
| P3b worst case, b4, 1 card (the rank 3 walk past about 5,500 leads outside hours) | 13.91 | 17.07 | 13.09 | 60 |
| P3c Team, a2, 2 cards | 9.11 | 9.73 | 8.99 | 40 |
| P3c Mine + unassigned, a2, 2 cards (Merge Append) | 9.70 | 10.62 | 8.79 | 40 |
| P3c Mine, a2, 200 skipped, 1 card | 8.29 | 7.72 | 7.23 | 30 |
| P5 `list_tasks` Overdue (a1, 50 of 1,252) | 3.58 | 4.05 | 3.78 | 15 |
| P5 `list_tasks` Today | 0.88 | 1.76 | 0.92 | 15 |
| P5 `list_tasks` Upcoming (50 of 2,299) | 3.44 | 5.75 | 3.40 | 15 |
| P5 `list_tasks` Done (50) | 1.14 | 1.21 | 1.17 | 15 |
| P5 `count_tasks` Mine / Team (context) | 1.65 / 3.39 | 1.69 / 6.47 | 1.66 / 3.33 | 10 |
| P6 `queue_summary` Mine / Team | 14.27 / 24.41 | 20.42 / 28.89 | 14.80 / 23.40 | 80 |
| P9 `open_call_zones` cold backend / warm (309 calling zones) | 21.61 / 1.253 | 39.73 / 1.299 | 28.12 / 1.504 | 50 / 2 |

P10 (`perf_queue_concurrency.sh`): three sessions at once, 100 rounds each on the team queue (claim the next lead,
committed; log "no answer" from the queue, which releases the claim), each session alternating between two admins so no
one passes the 60-entries-a-minute flood guard; calling hours as at that moment.

| P10 | Run 1 | Run 2 | Run 3 | Budget |
|---|---|---|---|---|
| Claims (leads served) | 300 (300) | 300 (300) | 300 (300) | |
| Claim p50 / p95 / max | 8.6 / 19.3 / 128.7 | 9.4 / 23.6 / 57.7 | 13.2 / 30.5 / 145.5 | p95 60 |
| Outcome (`log_activity`) p95 | 16.6 | 17.3 | 23.5 | |
| Leads served twice / deadlocks | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 |

Every budget is met in every run. The maxima are single rounds (one in 300) while the three sessions queued behind each
other's claims and the machine was shared.

**Found by these measurements and fixed before the runs above:**
- `list_tasks` first joined every open task of the bucket to its lead, contact and assignee (a hash join reading all
  30,015 leads) before keeping 50: Upcoming took 19.7 ms (budget 15). The page of 50 is now taken first, then joined:
  3.4 to 5.8 ms.
- `queue_summary` first looked up "claimed by someone else" once per lead (a subplan per row, three references) and
  sorted the whole team for the zone groups: Team 86 ms (budget 80). Now the live claims are hash-joined once and each
  count is a filter: 23 to 29 ms.
- Mine + unassigned first had no ordered path for the unassigned half (`owner_id is null` on the owner index is a
  filter, not a constant, so its rows are not in queue order) and PostgreSQL 16 does not push the outer ORDER BY into
  UNION ALL halves. A partial index on unassigned leads with a rank (`companies_queue_unassigned_idx`) and an ORDER BY /
  LIMIT inside each half give the designed Merge Append (below).

## Generic-plan check (run 6 of P3, P3b and P3c, every inner statement logged by auto_explain)

After 5 settling runs, run 6 of each case ran with `auto_explain` logging every statement inside `claim_next_lead`, its
helpers and triggers (printed by `scripts/db-perf.sh`; the same in all three runs):

- **Mine + unassigned** (a2) runs on a generic plan (`$9`, `$10` in the conditions) and is the designed Merge Append of
  two ordered index scans, each stopping after a handful of rows:
  `Limit -> Merge Append (Sort Key: next_action_at, last_activity_at NULLS FIRST, id)`;
  `-> Limit -> Index Scan using companies_queue_owner_idx … Index Cond: ((org_id = $1) AND (owner_id = $9) AND
  (queue_rank = $10) AND (next_action_at <= now()))`;
  `-> Limit -> Index Scan using companies_queue_unassigned_idx … Index Cond: ((org_id = $5) AND (queue_rank = $10) AND
  (next_action_at <= now()))`. The calling-hours, skip and live-claim conditions are filters (`call_zone = ANY ($3)`,
  `id <> ALL ($4)`, an anti join on `queue_claims_pkey`), as the leakproof rule intends.
- **Team** (a2): `Index Scan using companies_queue_team_idx … Index Cond: ((org_id = $1) AND (queue_rank = $10) AND
  (next_action_at <= now()))`, generic plan, 7 rows read.
- **P3b** (b4, rank 3): `Index Scan using companies_queue_owner_idx … Index Cond: ((org_id = $1) AND (owner_id = …) AND
  (queue_rank = '3') AND (next_action_at IS NULL))`, in queue order, with `Rows Removed by Filter: 5500` (the leads
  outside hours at the head of the walk) in about 4 ms. The empty parts before it (ranks 0 to 2 for b4) each stop at once.
- **P3** (a1): the follow-ups part reads a1's due call tasks by `tasks_queue_idx` (a bitmap scan on the assignee),
  groups them by lead and joins each lead by primary key; it is the whole answer, since a1 has due follow-ups.
- The claim insert, the second look after it (one primary-key read), the claim guard's live-claim count (the caller's
  claims by `queue_claims_user_idx`) and the queue card (primary-key and `activities_company_keyset_idx` reads) are all
  short index reads. No plan reads companies or tasks sequentially. `open_call_zones` evaluates 309 keys in about 1.4 ms.
- Nothing needed `plan_cache_mode = force_custom_plan`.

## Context: the earlier parts and the Day 3b import, same runs

| Case | Run 1 | Run 2 | Run 3 | Budget / Day 4b `perf.md` |
|---|---|---|---|---|
| P1 `get_lead` (adds `worked_by`), busiest / typical lead | 2.57 / 2.29 | 2.75 / 2.47 | 3.23 / 2.44 | 12 / 8 (4b: 2.4–3.6) |
| P4 `log_activity` (redefined: claim release, NO KEY UPDATE), busiest / typical | 7.30 / 7.06 | 7.27 / 8.27 | 9.33 / 7.98 | 15 (4b: 7.6–11.7) |
| P4b `undo_activity`, busiest / typical | 5.57 / 5.47 | 5.88 / 5.74 | 7.54 / 5.59 | 15 (4b: 5.4–7.6) |
| Import, 28 calls of 1,000 (average) | 297.0 | 281.7 | 294.0 | 4b same machine: 257–361 |
| Undo, 14 calls of 2,000 (average) | 242.0 | 257.1 | 261.9 | 4b same machine: 232–260 |
| Undo preview | 101.1 | 110.0 | 110.8 | 4b: 106–174 |
| Check 30,000 / 50,000 rows | 1,208 / 1,886 | 1,359 / 2,049 | 1,082 / 1,958 | 4b: 1,212–1,485 / 2,280–2,685 |

Every run gave the Day 3b import results exactly (27,356 imported, 2,344 duplicates, 300 rejected, 281 late duplicates
skipped; the undo removed 27,256 and kept 100). The import inserts now compute the stored `call_zone` and `queue_rank`
and the new indexes; the import and undo chunks stay within Day 4b's same-machine spread (design P7: within +10% of Day
3b's numbers on the machine that measured them; on this machine the comparison is with Day 4b's runs of Day 4a's code).

## Sizes after seeding (part 1)

`activities` 99 MB, `companies` 58 MB (Day 4b: 47–48 MB; the three new columns and three partial queue indexes), `tasks`
5.5 MB (the three new task indexes), `audit_log` 31 MB. The has_contact_phone flag and the generated queue facts write
no audit diff (design 3.5).
