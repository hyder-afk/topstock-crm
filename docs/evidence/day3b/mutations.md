# Lead import: every protection removed one at a time, 10 Oct 2026

`python3 scripts/db-mutations.py` changes the lead-import migration in place for one mutation, runs the whole database
suite (`scripts/db-test.sh`: migrations, the RLS attack test, the import attack test, the two-session test, advisors)
and restores the migration; "caught" means the suite failed. Run on commit 410d244 (the final migration, after the
review fixes), in a separate copy of the code so nothing else read a mutated file.

Result: **36 of 37 caught** (the first run, before the review fixes, gave 24 of 25). The one not caught is a protection with two layers, and removing both layers (row 5) is
caught.

| # | Protection removed | Result | First failure |
|---|---|---|---|
| 1 | Working rows: insert without a fresh code | caught | FAIL: "insert into private.lead_import_staging (batch_id, row_no, org_id, name) select '36a5a010-4db0-4358-9fda-c6252933cbd5', 2, org_id, 'x |
| 2 | Working rows: read without a fresh code | caught | FAIL: a stale code reads working rows |
| 3 | Working rows: row number past the file's end | caught | FAIL: "insert into private.lead_import_staging (batch_id, row_no, org_id, name) select '0e9c638b-f791-401e-92f4-f8e6d6cdb930', 4, org_id, 'x |
| 4 | Tagging leads: no admin check | **NOT CAUGHT** | advisors: no ERROR-level findings |
| 5 | Tagging leads: no admin check in the rule nor in who sees imports (both layers) | caught | FAIL: rep can read import batches |
| 6 | Tagging leads: no fresh-code check | caught | FAIL: "insert into public.companies (name, import_batch_id) values ('late', 'd5e944dd-bb35-49ff-84f1-0a8b442de2ea')" succeeded, expected 425 |
| 7 | Tagging leads: import need not be in progress | caught | FAIL: "insert into public.companies (name, import_batch_id) values ('tagged', '54e5303b-eae5-4d32-9052-ebc01356e20a')" succeeded, expected 4 |
| 8 | Tagging leads: any last-activity date | caught | FAIL: "insert into public.companies (name, import_batch_id, last_activity_at) |
| 9 | Tagging leads: date bound 1 Jan 1990 UTC (refuses 1 Jan 1990 in Paris) | caught | FAIL: "insert into public.companies (name, import_batch_id, last_activity_at) |
| 10 | Check: dates compared in UTC instead of local time | caught | FAIL: row 7 expected rejected <NULL> <NULL> date_out_of_range, got (ready,,,) |
| 11 | Tagging leads: into someone else's import | caught | FAIL: "insert into public.companies (name, import_batch_id) values ('Sneak', 'f4673d46-fd34-4c74-9cad-898802000327')" succeeded, expected 42 |
| 12 | Import history: no organisation check | caught | FAIL: other org reads our imports |
| 13 | Import status: changeable without a fresh code | caught | new row violates row-level security policy for table "import_batches" |
| 14 | Import counters: client may write one | caught | FAIL: "update public.import_batches set imported = 99" succeeded, expected 42501 |
| 15 | File name: zero-width and bidi characters allowed (controls only) | caught | FAIL: "select public.create_lead_import('leads\u202Evsc.csv', null, 1, 2)" succeeded, expected 23514 |
| 16 | Batch guard trigger dropped | caught | only the person who started this import can add rows |
| 17 | One import at a time: index not unique | caught | FAIL: "select public.commit_lead_import('7d50af5e-f2aa-4a2f-8390-cab6ff514625')" succeeded, expected 22023 |
| 18 | Undo: leads with an activity count as untouched | caught | FAIL: undo preview {"kept": 4, "tagged": 6, "removable": 2} |
| 19 | Undo: leads with a contact count as untouched | caught | FAIL: undo preview {"kept": 4, "tagged": 6, "removable": 2} |
| 20 | Undo: leads with a deal count as untouched | caught | FAIL: undo preview {"kept": 4, "tagged": 6, "removable": 2} |
| 21 | Undo: edited leads count as untouched | caught | FAIL: undo preview {"kept": 4, "tagged": 6, "removable": 2} |
| 22 | Undo: no second look before deleting (race with a new contact) | caught | FAIL: undo removed a lead that got a contact meanwhile ({"kept": 0, "status": "rolled_back", "removed_now": 1}) |
| 23 | Undo: a short chunk counts as the end (race with a deleted lead) | caught | some leads are still waiting to be removed |
| 24 | Import: no re-check for leads added meanwhile | caught | FAIL: late duplicate not skipped {"status": "committing", "remaining": 1, "imported_now": 3, "imported_total": 6, "late_duplicates": 0} |
| 25 | Import: someone else may run it | caught | FAIL: "select public.commit_lead_import('2ce18901-9934-4dec-96d6-5268b2a24c1e')" gave 22023 (hint "not_ready"), expected 42501 (hint "<NULL> |
| 26 | Add rows: no constant-error pre-check | caught | FAIL: "select public.stage_lead_import_rows('14ba0cab-a3c7-4fb1-8fb0-e22c9b406490', '[{"row_no": 4, "problems": ["name_missing"]}]')" gave 4 |
| 27 | Functions: no fresh-code check (hint step_up) | caught | FAIL: "select public.create_lead_import('x.csv', null, 1, 2)" gave 42501 (hint ""), expected 42501 (hint "step_up") |
| 28 | Audit: full copy of imported leads | caught | FAIL: imported leads should each have one small audit row |
| 29 | Audit: search and key columns kept | caught | FAIL: search_text copied into the audit log |
| 30 | Working rows kept after the import | caught | FAIL: working rows kept after the import |
| 31 | Working rows kept after a direct discard | caught | FAIL: a direct discard left working rows |
| 32 | Working rows kept when an undo starts directly | caught | FAIL: a direct undo of a paused import left working rows |
| 33 | Import: running total is this call's count, not the leads tagged so far | caught | FAIL: running total after a resume {"status": "imported", "remaining": 0, "imported_now": 1, "imported_total": 1, "late_duplicates": 0} |
| 34 | Import history: a paused import shows the counter (0), not the leads added | caught | FAIL: history should show the leads a paused import added |
| 35 | Undo of a paused import: working rows deleted before they are counted | caught | FAIL: the counts of a paused import were taken after its working rows were deleted: (0,0,"{""ready"": 0, ""by_name"": 0, ""by_email"": 0, "" |
| 36 | Name rule: a phone too short to be a key counts as no phone (chain shops merged) | caught | FAIL: row 3 expected ready <NULL> <NULL> <NULL>, got (duplicate_file,name,2,) |
| 37 | Counters not recounted at the end of an import | caught | import counts do not add up |

## Why row 4 is not caught, and why that is fine

Only an admin may tag a new lead with an import (the restrictive policy `companies_import_columns` checks
`private.is_admin()`). The same policy also requires the import to exist and be in progress, read through
`public.import_batches`, whose own policy lets only admins see any import. So a rep or a manager who tried to tag a lead
cannot see the import in that check, and the insert is refused either way: removing the admin check alone changes
nothing anyone can observe. Row 5 removes both layers and the attack test fails ("rep can read import batches"): the pair is
proven necessary, and each layer alone is backed up by the other. The earlier run of this script, before the final
changes, gave the same result.
