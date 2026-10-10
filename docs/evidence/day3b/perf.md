# Lead import speed at Release 1 size: Day 3b, 10 Oct 2026

Two measurements, both re-runnable by anyone:

1. **Database** (`bash scripts/db-perf.sh`): a throwaway PostgreSQL 16.15 with the same auth stand-in the security tests use
   and every migration. It loads the Day 3a set (30,015 made-up leads, 10,015 contacts), then `supabase/tests/perf_import.sql`
   runs the whole import as an admin with a fresh two-factor code, row level security on, through the same functions the
   app calls:
   - a 30,000-row file: 5% already in the CRM, 2% repeated in the file, 1% with problems, 1% with a name only;
   - 281 leads added by the team while the import runs (late duplicates; every one must be skipped);
   - 100 imported leads worked on before the undo (every one must stay).
2. **Browser** (`PERF=1 npx playwright test -c playwright.auth.config.ts tests/auth/import-perf.spec.ts --project chromium`):
   a 30,000-row made-up file imported through the real screen on the local stack, with the CPU slowed down 4 times.

Machine: this cloud session, 4 vCPU Xeon 2.1 GHz. Targets from the design (section 3.15 and 6E): every call under 2 s (the
statement timeout is about 8 s), the check under 3 s at 50,000 rows, the whole 30,000-row flow under 20 s of database time.

## Database: three full runs of the script (final migration, after the review fixes)

| Step | Calls | Run 1 | Run 2 | Run 3 | Target |
|---|---|---|---|---|---|
| Add rows (1,000 per call) | 30 | avg 40.3, max 47.9 ms | avg 51.3, max 60.5 ms | avg 44.2, max 62.7 ms | ~100–300 ms per call |
| Check 30,000 rows (problems, duplicates) | 1 | 839 ms | 940 ms | 970 ms | under 2 s |
| One page of rows to look at (1,000) | 1 | 17.7 ms | 23.2 ms | 23.7 ms | |
| Past imports (20 rows) half way through the import, with its running count | 1 | 3.5 ms | 3.3 ms | 3.8 ms | |
| Import (1,000 per call, late duplicates re-checked each call) | 28 | avg 169, max 260 ms | avg 188, max 260 ms | avg 207, max 359 ms | ~300 ms per call |
| Undo preview | 1 | 44.9 ms | 39.3 ms | 40.3 ms | |
| Past imports half way through the undo | 1 | 8.9 ms | 6.0 ms | 7.1 ms | |
| Undo (2,000 per call) | 14 | avg 206, max 326 ms | avg 140, max 159 ms | avg 168, max 228 ms | |
| Add rows for a 50,000-row file | 50 | avg 56.3, max 105.6 ms | avg 47.3, max 71.5 ms | avg 55.9, max 81.2 ms | |
| Check 50,000 rows | 1 | 1,447 ms | 1,527 ms | 1,643 ms | under 3 s |
| Discard the 50,000-row file | 1 | 31.3 ms | 31.2 ms | 25.2 ms | |

Every run gave the same results: 27,637 ready after the check; 27,356 imported, 281 late duplicates skipped, 2,344
duplicates and 300 rejected in all (the counters add up to the 30,000 rows); half way through, Past imports showed the
14,847 leads already added (the same as the import call's running total); the undo removed 27,256 and kept exactly the
100 worked-on leads. Database time for the whole 30,000-row flow (add, check, import, undo): 9.7 s, 9.7 s and 10.5 s
(target under 20 s). Earlier runs on the first version of the migration gave 10.1-11.8 s.

## Leads list after the change (Day 3a cases re-timed, same runs)

The import adds three stored key columns and their indexes to the leads table. The list and count timings stay where Day
3a left them (`docs/evidence/day3a/perf.md`); average of 5 warm runs, range over the three runs:

| Case | Time |
|---|---|
| First page, last activity / A to Z / newest first | 0.6–0.9 ms |
| Page 200 (row 10,000), keyset | 5.6–7.8 ms |
| Total count, no filter | 1.2–2.2 ms |
| Status + country filter, list / count | 8.0–13.5 / 1.6–1.9 ms |
| Search "verdane", list / count | 0.7–0.8 / 6.7–9.1 ms |
| Search for a contact's name ("benali4") | 11.6–17.6 ms |
| Search with no match, list / count | 15.3–18.1 / 7.0–8.6 ms |
| Search matching every lead ("example.com"), list / count | 0.7–1.1 / 9.8–11.5 ms |
| 15 matches that all sort last ("zermatt", "quaxley") | 11.5–26.4 ms |
| City filter "lyon" | 12.5–25.9 ms |

## Browser

A 30,000-row made-up file (3.9 MB) imported through the real screen on the local stack, with the CPU slowed down 4 times
(Chrome DevTools throttling). "Longest freeze" is the longest task that kept the page from answering (budget 200 ms).

| Build | Read the file | Check | Import | Total | Longest freeze | Largest request |
|---|---|---|---|---|---|---|
| a60b355 (rows cleaned in one go) | 2.0 s | 12.9 s | 61.8 s | 76.8 s | 1,365 ms | 271 KB |
| 1b85966 (rows cleaned in slices) | 1.5 s | 13.0 s | 37.6 s | 52.1 s | 670 ms | 271 KB |
| Final, run 1 (first after a restart) | 1.7 s | 12.6 s | 70.1 s | 84.3 s | 111 ms | 271 KB |
| Final, run 2 | 1.6 s | 11.5 s | 11.9 s | 25.1 s | 91 ms | 271 KB |
| Final, run 3 | 1.8 s | 11.4 s | 12.0 s | 25.2 s | 162 ms | 271 KB |

Targets: total under 90 s, longest freeze under 200 ms, every request under 1 MB. All met in every final run.
What took the freezes from 1,365 ms down: rows cleaned in slices of 500; each column's distinct values and the date
order worked out once, one task each, while the file is read (each different spelling cleaned once); the date guess
reads trimmed text first; the country and time zone names prepared while the file is read; chunks measured one at a
time as they are sent. The import step's time is mostly outside the database (its own work is about 5 s, above): on
this machine every call also goes through the local test gateway, which starts psql each time, and the first run after
a restart was slower there. Production uses Supabase's PostgREST instead.
