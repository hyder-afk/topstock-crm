# Day 4a speed at Release 1 size: activity hardening, 11 Oct 2026

Design: `docs/evidence/day4/design.md` section 8.6 (part 1: P2, P7, P8). Re-runnable by anyone with
`bash scripts/db-perf.sh`:

1. a throwaway PostgreSQL 16.15 with the auth stand-in the security tests use and every migration, including
   `20261011120000_activity_hardening.sql`;
2. `supabase/tests/perf_leads.sql`: the Day 3a set (30,015 leads, 10,015 contacts) and the Day 3a list timings (**P8**);
3. `supabase/tests/perf_day4.sql` (new): 300,008 activities (10,008 on the busiest lead, 1,667 on each of 24 more, the
   rest spread over every lead; 60% calls, 15% emails, 5% WhatsApp, 5% meetings, 15% notes), inserted with triggers off,
   then the leads' last-activity dates set in one update; 15,000 tasks (5,000 per person, 30% done); `vacuum analyze`.
   Then the timeline timings (**P2**) and two context timings for 4b;
4. `supabase/tests/perf_import.sql`: the Day 3b import and undo (**P7**), now with the 300,000 activities and 15,000
   tasks in place and the new "untouched" rule (a lead with a task stays).

Everything runs as a signed-in user with two-factor, row level security on. Machine: this cloud session, 4 vCPU.
Three full runs, one after the other, with nothing else running.

**Review round 1 re-run (the lead lock, commit a0f86ff).** The fix round adds a row lock on the lead to every entry
insert and delete (`docs/log.md`, D9 under concurrency), so part 1 (P2 and the context timings) was run again: steps 1
to 3 only, three runs of the final code, each right after a run of the code before the fix (17d0354, a separate copy),
on the same machine with nothing else running; and, before those, three runs of the final code one after the other.
P7 and P8 were not re-run: an import inserts no entries, the undo deletes only leads without entries, and the leads
list reads no entries, so the lock never runs in them. The results sit below the first round's tables.

## P2: a timeline page (budget 5 / 8 / 10 ms)

`list_lead_activities` itself arrives in 4b. This PR adds the index it needs (`activities_company_keyset_idx` on
`(company_id, created_at desc, id desc)`), so `perf_day4.sql` runs the same static query from a plpgsql function
(`pg_temp.timeline_page`: 30 entries, newest first, keyset `(created_at, id) <`, optional types; one static query with
a cursor and one without, so no `OR` hides the cursor from the index). Its plans are cached like the RPC's will be.
Average of 5 warm runs after 10, milliseconds:

| Case | Run 1 | Run 2 | Run 3 | Budget |
|---|---|---|---|---|
| First page, lead with 10,008 entries | 0.18 | 0.17 | 0.17 | 5 |
| Page at row 5,000 (keyset) | 0.08 | 0.18 | 0.09 | 8 |
| Calls only, first page | 0.09 | 0.19 | 0.09 | 10 |
| First page, a typical lead (8 entries) | 0.06 | 0.14 | 0.08 | |

Review round 1, milliseconds, the final code and the code before the fix in turn:

| Case | Final code, run 1 / 2 / 3 | Before the fix, run 1 / 2 / 3 | Budget |
|---|---|---|---|
| First page, lead with 10,008 entries | 0.23 / 0.21 / 0.24 | 0.20 / 0.23 / 0.34 | 5 |
| Page at row 5,000 (keyset) | 0.13 / 0.19 / 0.16 | 0.13 / 0.13 / 0.23 | 8 |
| Calls only, first page | 0.14 / 0.15 / 0.18 | 0.19 / 0.13 / 0.26 | 10 |
| First page, a typical lead (8 entries) | 0.11 / 0.12 / 0.13 | 0.12 / 0.11 / 0.18 | |

The three runs of the final code one after the other gave 0.13 to 0.37 ms over the four cases. A timeline page takes
no lock; every plan in the six final-code runs reads `activities_company_keyset_idx` (30 of 30 per run), with no sort
and no sequential scan, and the generic plans look as below.

**Generic-plan check.** Each case ran 10 times with `auto_explain` (nested statements, analyze). Runs 1 to 5 were
custom plans (constants in the conditions); from run 6 the plans show `$1`..`$4`, that is PostgreSQL switched to the
generic plan. All 30 plans read `activities_company_keyset_idx` and stop after 30 rows; there is no sort and no
sequential scan of activities. So `list_lead_activities` needs no `force_custom_plan` if it keeps this shape. Run 1,
page at row 5,000:

```text
-- run 1 (custom plan), 0.72 ms
Limit  (cost=0.94..77.37 rows=30 width=71) (actual time=0.219..0.325 rows=30 loops=1)
  ->  Index Scan using activities_company_keyset_idx on activities a  (cost=0.42..6389.89 rows=2508 width=71) (actual time=0.218..0.322 rows=30 loops=1)
        Index Cond: ((company_id = '00010780-...'::uuid) AND (ROW(created_at, id) < ROW('2025-10-19 20:03:55.413262+00'::timestamp with time zone, 'f8e784c9-...'::uuid)))
        Filter: ($0 AND (org_id = $1))
-- run 6 (generic plan), 0.25 ms
Limit  (cost=0.94..7.64 rows=1 width=71) (actual time=0.130..0.145 rows=30 loops=1)
  ->  Index Scan using activities_company_keyset_idx on activities a  (cost=0.42..13.82 rows=2 width=71) (actual time=0.129..0.143 rows=30 loops=1)
        Index Cond: ((company_id = $1) AND (ROW(created_at, id) < ROW($3, $4)))
        Filter: ($0 AND (org_id = $1) AND (($2 IS NULL) OR (type = ANY ($2))))
```

The `Filter` holds only the row level security checks (`$0` is two-factor, `org_id = $1` the caller's organisation, both
computed once per statement) and the optional types: every condition is leakproof, so the row comparison is an index
condition under RLS. The calls-only page removes about 21 rows by filter to find 30 calls (60% of entries are calls).

## Context for 4b: logging and deleting one entry (no budget in 4a)

One entry logged as a signed-in user (the activity guard sets the author and the previous date and runs the flood
guard; the touch trigger moves the lead's date) and then deleted with a fresh code (the D9 untouch trigger puts the
date back), each undone; average of 5:

| Lead | Insert, run 1 / 2 / 3 | Delete, run 1 / 2 / 3 |
|---|---|---|
| The lead with 10,008 entries | 2.42 / 3.79 / 2.74 ms | 1.45 / 2.25 / 1.64 ms |
| A typical lead | 1.24 / 1.34 / 1.21 ms | 0.95 / 1.11 / 0.99 ms |

4b's P4 (`log_activity` with task creation, ≤ 15 ms) and P4b (`undo_activity`, ≤ 15 ms) build on these.

Review round 1 (the insert now locks the lead first; the delete locks it before its update), same probe, average of 5:

| Lead | Insert: final code, run 1 / 2 / 3 | Insert: before the fix | Delete: final code | Delete: before the fix |
|---|---|---|---|---|
| The lead with 10,008 entries | 3.18 / 3.86 / 3.76 ms | 4.38 / 3.05 / 4.95 ms | 2.00 / 2.15 / 2.26 ms | 2.58 / 1.80 / 3.00 ms |
| A typical lead | 1.77 / 1.86 / 2.00 ms | 3.01 / 1.59 / 2.67 ms | 1.29 / 1.54 / 1.40 ms | 2.24 / 1.17 / 2.02 ms |

The lock makes no difference that shows above the spread between runs: the code before the fix itself ranged 3.05 to
4.95 ms on the busy lead in this session, against 2.42 to 3.79 ms in the first round's session (the machine was slower
in this one). The three final-code runs one after the other: insert 3.24 / 5.65 / 3.32 ms and 1.68 / 3.04 / 1.84 ms, delete
2.04 / 3.41 / 1.97 ms and 1.28 / 2.34 / 1.28 ms. All far below 4b's 15 ms budgets. A session waits on the lock only
when another one writes an entry on the same lead at that moment, and only until that transaction ends.

## P7: Day 3b import and undo, re-timed (budget: average within +10% of `day3b/perf.md`)

| Step | Calls | Run 1 | Run 2 | Run 3 | Day 3b (3 runs) |
|---|---|---|---|---|---|
| Import (1,000 per call) | 28 | avg 182.5, max 252.5 ms | avg 176.0, max 213.0 ms | avg 174.4, max 249.2 ms | avg 169–207 ms |
| Undo (2,000 per call) | 14 | avg 145.5, max 185.1 ms | avg 157.8, max 179.1 ms | avg 138.7, max 167.5 ms | avg 140–206 ms |
| Undo preview | 1 | 89.7 ms | 80.0 ms | 80.4 ms | 39.3–44.9 ms |
| Add rows (1,000 per call) | 30 | avg 43.7 ms | avg 44.1 ms | avg 44.4 ms | avg 40.3–51.3 ms |
| Check 30,000 rows | 1 | 916 ms | 870 ms | 866 ms | 839–970 ms |
| Check 50,000 rows | 1 | 1,382 ms | 1,695 ms | 1,585 ms | 1,447–1,643 ms |

Every run gave the Day 3b results exactly: 27,356 imported, 281 late duplicates skipped, 2,344 duplicates and 300
rejected; the undo removed 27,256 leads and kept the 100 worked-on ones.

- **Import and undo chunks: within budget.** The averages (174–183 ms and 139–158 ms) sit inside Day 3b's own ranges.
  The undo's "untouched" rule now also probes `tasks_company_idx`, and its activities probe reads the new keyset index
  over 300,000 rows instead of an empty table; neither shows in the chunk times.
- **Undo preview: about twice Day 3b's (80–90 ms against 39–45 ms).** The preview counts all 27,356 imported leads
  against the rule in one statement, so the two changes above add up there. It is one call per undo, far below the
  2 s per call target, and P7's budget is on the chunks; recorded so it is not a surprise at Gate 1.
- The 50,000-row check varies by ±10% between runs here as it did in Day 3b (it does not read activities or tasks).

## P8: Day 3a leads list cases (budget: no case more than 20% slower than `day3a/perf.md`)

Average of 5 warm runs, milliseconds, range over the three runs; the Day 3a and Day 3b ranges are from their perf.md:

| Case | Day 3a | Day 3b | Day 4a | Within budget |
|---|---|---|---|---|
| First page, last activity / A to Z / newest first | 1.1–2.3 | 0.6–0.9 | 0.6–0.8 | yes |
| Page 200 (row 10,000), keyset | 11.6–20.0 | 5.6–7.8 | 5.6–6.7 | yes |
| Total count, no filter | 2.6–5.2 | 1.2–2.2 | 1.2–1.5 | yes |
| Status + country filter, list / count | 16.9–28.6 / 2.7–4.5 | 8.0–13.5 / 1.6–1.9 | 7.1–8.5 / 1.5–1.8 | yes |
| No activity for 30 days | 2.1–4.3 | | 1.2–1.5 | yes |
| Search "verdane", list / count | 1.3–1.9 / 15.1–15.7 | 0.7–0.8 / 6.7–9.1 | 0.6–0.8 / 6.5–7.9 | yes |
| Search "verdane" + status customer | 6.7–8.9 | | 2.8–3.9 | yes |
| Search for a contact's name ("benali4") | 23.3–27.7 | 11.6–17.6 | 10.6–13.4 | yes |
| Search with no match, list / count | 22.8–25.4 / 14.3–18.4 | 15.3–18.1 / 7.0–8.6 | 12.2–14.5 / 7.8–9.9 | yes |
| Search matching every lead ("example.com"), list / count | 1.2–2.0 / 17.3–22.5 | 0.7–1.1 / 9.8–11.5 | 0.6–0.9 / 7.9–9.9 | yes |
| Search "+33 6", list A to Z / count | 1.2–2.0 / 14.5–22.8 | | 0.6–0.9 / 6.5–8.1 | yes |
| Search "ly", list / count | 5.0–8.6 / 15.4–25.8 | | 2.4–3.1 / 8.7–10.5 | yes |
| Search "éé" (no match) | 25.2–32.6 | | 11.4–12.6 | yes |
| 15 matches that all sort last ("zermatt", "quaxley") | 23.4–55.2 | 11.5–26.4 | 10.4–19.6 | yes |
| City filter "lyon" | 26.0–26.2 | 12.5–25.9 | 12.4–16.8 | yes |

Unchanged, as expected: 4a touches no lead column, index or list function. Day 3a's numbers were taken in an earlier
session (its perf.md lists a different CPU), which is why Day 3b and 4a are both faster than Day 3a; against Day 3b the
largest step up is the no-match count, 9.9 ms against 8.6 ms in one run (+15%, within the 20% rule).

## Sizes after seeding (for the free-tier budget, design 3.5)

`activities` 99 MB with its 6 indexes at 300,008 rows (design estimate ~135 MB a year), `tasks` 4.3 MB at 15,000 rows,
`companies` 47 MB, `audit_log` 29 MB (from the fixtures and the import; seeded activities write no audit rows, and since
D8 no app-logged activity insert does either).
