# Day 7c mutation rows (orphan sweeper), 15 Oct 2026

`PGTZ=Europe/Paris DB_TEST_PORT=54597 python3 scripts/db-mutations.py --set day7c`, run in a scratch copy of
`scripts/` and `supabase/` (the script edits migrations in place). Each row changes the migration, runs the whole
`scripts/db-test.sh` and restores it; "caught" means the run failed. `PGTZ=Europe/Paris` only works around the
pre-existing evening flake in `stock_attack.sql` (README, "Checks"); it does not touch the sweeper's tests.

Row 12 first ran without the column-grant change and was caught by the local service_role's missing `org_id` insert
privilege ("permission denied for table audit_log"), a layer Supabase's default grants to service_role do not give;
the row now widens the grant too and was re-run alone (`--set day7c 12`), caught by the test's own "no organisation"
check. Row 8 is caught first by `files_attack.sql`'s check that no unexpected file function is SECURITY DEFINER (the
sweeper test's catalog check would catch it too).

| # | Protection removed | Result | First failure |
|---|---|---|---|
| 1 | Sweeper: no "not exists files row" (objects with a pending, ready or deleting row become candidates) | caught | FAIL: candidates (default grace) is {00000000-0000-0000-0000-0000d7c000cc/30000000-0000-0000-0000-0000d7c00001/a0000000-0000-4000-8000-00000 |
| 2 | Sweeper: no age check (young objects, an upload in flight, become candidates) | caught | FAIL: candidates (default grace) is {00000000-0000-0000-0000-0000d7c000cc/30000000-0000-0000-0000-0000d7c00001/a0000000-0000-4000-8000-00000 |
| 3 | Sweeper: the grace period may be under 24 hours (a caller asks for 1 hour) | caught | FAIL: "select * from public.lead_file_orphans(interval '23 hours 59 minutes', 10)" succeeded, expected 22023 |
| 4 | Sweeper: no bucket filter (another bucket's objects become candidates) | caught | FAIL: candidates (default grace) is {00000000-0000-0000-0000-0000d7c000cc/30000000-0000-0000-0000-0000d7c00001/a0000000-0000-4000-8000-00000 |
| 5 | Sweeper: no path shape check (any name in the bucket becomes a candidate) | caught | FAIL: candidates (default grace) is {00000000-0000-0000-0000-0000D7C000CC/30000000-0000-0000-0000-0000d7c00001/a0000000-0000-4000-8000-00000 |
| 6 | Sweeper: the three functions granted to authenticated (any signed-in person lists or records sweeps) | caught | FAIL: lead_file_orphans(interval,integer) is callable by public, anon or authenticated |
| 7 | Sweeper: the candidates function granted to anon | caught | FAIL: anon can execute public.lead_file_orphans(p_min_age interval, p_limit integer) |
| 8 | Sweeper: the candidates function runs as its owner (SECURITY DEFINER) | caught | FAIL: unexpected SECURITY DEFINER file functions |
| 9 | Sweeper: the sanity counts do not count names outside the shape | caught | FAIL: names outside the shape counted is 0, expected 4 |
| 10 | Sweeper audit row: removed may exceed found | caught | FAIL: "select public.record_file_sweep(1, 2, 0, false)" succeeded, expected 22023 |
| 11 | Sweeper audit row: a dry run may report removals | caught | FAIL: "select public.record_file_sweep(1, 1, 0, true)" succeeded, expected 22023 |
| 12 | Sweeper audit row: carries an organisation (a later reader could tie a sweep to a team's leads) | caught | FAIL: sweep row has no organisation is 00000000-0000-0000-0000-0000d7c000cc, expected <NULL> |

day7c: 12 rows run: 12 caught, 0 documented two-layer rows not caught, 0 not as listed

`python3 scripts/db-mutations.py --anchors`: 672 rows in 16 sets, every edit applies (day7c 12 of 12).

Re-run on 16 Oct 2026 after advisor round 1 (the merge of `day7a-local`, the new B6 with two organisations):
12 of 12 caught again, same first failures (rows 1 to 9 in one run, rows 10 to 12 in a second; `--anchors` 672 of 672).
