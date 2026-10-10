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

## Database: three full runs of the script

| Step | Calls | Run 1 | Run 2 | Run 3 | Target |
|---|---|---|---|---|---|
| Add rows (1,000 per call) | 30 | avg 56.0, max 78.2 ms | avg 50.3, max 60.8 ms | avg 52.7, max 57.8 ms | ~100–300 ms per call |
| Check 30,000 rows (problems, duplicates) | 1 | 974 ms | 890 ms | 974 ms | under 2 s |
| One page of rows to look at (1,000) | 1 | 22.9 ms | 18.9 ms | 23.4 ms | |
| Import (1,000 per call, late duplicates re-checked each call) | 28 | avg 194, max 252 ms | avg 198, max 256 ms | avg 245, max 402 ms | ~300 ms per call |
| Undo preview | 1 | 44.4 ms | 43.3 ms | 59.1 ms | |
| Undo (2,000 per call) | 14 | avg 162, max 213 ms | avg 156, max 187 ms | avg 169, max 257 ms | |
| Add rows for a 50,000-row file | 50 | avg 58.9, max 79.7 ms | avg 59.4, max 94.2 ms | avg 67.2, max 96.2 ms | |
| Check 50,000 rows | 1 | 1,735 ms | 1,678 ms | 1,856 ms | under 3 s |
| Discard the 50,000-row file | 1 | 29.5 ms | 31.3 ms | 48.9 ms | |

Every run gave the same results: 27,637 ready after the check; 27,356 imported, 281 late duplicates skipped, 2,344
duplicates and 300 rejected in all (the counters add up to the 30,000 rows); the undo removed 27,256 and kept exactly the
100 worked-on leads. Database time for the whole 30,000-row flow (add, check, import, undo): 10.4 s, 10.1 s and 11.8 s
(target under 20 s). Run 3 overlapped a browser test run on the same machine, which explains its slower import calls.

## Leads list after the change (Day 3a cases re-timed, same runs)

The import adds three stored key columns and their indexes to the leads table. The list and count timings stay where Day
3a left them (`docs/evidence/day3a/perf.md`); average of 5 warm runs, range over the three runs:

| Case | Time |
|---|---|
| First page, last activity / A to Z / newest first | 0.7–0.9 ms |
| Page 200 (row 10,000), keyset | 7.0–10.4 ms |
| Total count, no filter | 1.6–2.1 ms |
| Status + country filter, list / count | 9.6–10.7 / 1.9–2.0 ms |
| Search "verdane", list / count | 0.9–1.0 / 8.7–11.2 ms |
| Search for a contact's name ("benali4") | 14.6–14.9 ms |
| Search with no match, list / count | 12.7–16.0 / 7.5–9.4 ms |
| Search matching every lead ("example.com"), list / count | 0.8–1.6 / 9.6–10.8 ms |
| 15 matches that all sort last ("zermatt", "quaxley") | 13.6–31.7 ms |
| City filter "lyon" | 15.3–25.7 ms |

## Browser

Work in progress (final numbers come with the last fixes). 30,000-row made-up file (3.9 MB), CPU 4x slower, local stack:

| Build | Read the file | Check | Import | Total | Longest freeze | Largest request |
|---|---|---|---|---|---|---|
| a60b355 (rows cleaned in one go) | 2.0 s | 12.9 s | 61.8 s | 76.8 s | 1,365 ms | 271 KB |
| 1b85966 (rows cleaned in slices) | 1.5 s | 13.0 s | 37.6 s | 52.1 s | 670 ms | 271 KB |

Targets: total under 90 s, longest freeze under 200 ms, every request under 1 MB. Most of the import time is spent
outside the database (its own work for 30,000 rows is about 6 s, see above); locally every call also goes through the
test gateway, which starts psql for each one.
