# Lead import: every protection removed one at a time, 10 Oct 2026

`python3 scripts/db-mutations.py` changes the lead-import migration in place for one mutation, runs the whole database
suite (`scripts/db-test.sh`: migrations, the RLS attack test, the import attack test, the two-session test, advisors)
and restores the migration; "caught" means the suite failed. Run on commit 577d9bb (the final migration, after the
name-key change), in a separate copy of the code so nothing else read a mutated file.

Result: **24 of 25 caught**. The one not caught is a protection with two layers, and removing both layers (row 5) is
caught.

| # | Protection removed | Result | First failure |
|---|---|---|---|
| 1 | Working rows: insert without a fresh code | caught | FAIL: "insert into private.lead_import_staging (batch_id, row_no, org_id, name) select '4cddf828-9101-4487-a0a7-a772d18450b9', 2, org_id, 'x |
| 2 | Working rows: read without a fresh code | caught | FAIL: a stale code reads working rows |
| 3 | Working rows: row number past the file's end | caught | FAIL: "insert into private.lead_import_staging (batch_id, row_no, org_id, name) select '03aaa865-0ccd-439d-8d35-e9fdbe7941cc', 4, org_id, 'x |
| 4 | Tagging leads: no admin check | **NOT CAUGHT** | advisors: no ERROR-level findings |
| 5 | Tagging leads: no admin check in the rule nor in who sees imports (both layers) | caught | FAIL: rep can read import batches |
| 6 | Tagging leads: no fresh-code check | caught | FAIL: "insert into public.companies (name, import_batch_id) values ('late', 'd3cf5e08-5358-4dbf-ac33-94068aedf2d0')" succeeded, expected 425 |
| 7 | Tagging leads: import need not be in progress | caught | FAIL: "insert into public.companies (name, import_batch_id) values ('tagged', '43b9d505-96fa-4fda-8c6f-4a21175bd664')" succeeded, expected 4 |
| 8 | Import history: no organisation check | caught | FAIL: other org reads our imports |
| 9 | Import status: changeable without a fresh code | caught | new row violates row-level security policy for table "import_batches" |
| 10 | Import counters: client may write one | caught | FAIL: "update public.import_batches set imported = 99" succeeded, expected 42501 |
| 11 | Batch guard trigger dropped | caught | only the person who started this import can add rows |
| 12 | One import at a time: index not unique | caught | FAIL: "select public.commit_lead_import('e28bef72-44ea-4677-9ff8-e692a8507593')" succeeded, expected 22023 |
| 13 | Undo: leads with an activity count as untouched | caught | FAIL: undo preview {"kept": 4, "tagged": 6, "removable": 2} |
| 14 | Undo: leads with a contact count as untouched | caught | FAIL: undo preview {"kept": 4, "tagged": 6, "removable": 2} |
| 15 | Undo: leads with a deal count as untouched | caught | FAIL: undo preview {"kept": 4, "tagged": 6, "removable": 2} |
| 16 | Undo: edited leads count as untouched | caught | FAIL: undo preview {"kept": 4, "tagged": 6, "removable": 2} |
| 17 | Undo: no second look before deleting (race with a new contact) | caught | FAIL: undo removed a lead that got a contact meanwhile ({"kept": 0, "status": "rolled_back", "removed_now": 1}) |
| 18 | Import: no re-check for leads added meanwhile | caught | FAIL: late duplicate not skipped {"status": "committing", "remaining": 1, "imported_now": 3, "late_duplicates": 0} |
| 19 | Import: someone else may run it | caught | FAIL: "select public.commit_lead_import('7de482d4-56f0-4f07-a6c6-20db422d553a')" gave 22023 (hint "not_ready"), expected 42501 (hint "<NULL> |
| 20 | Add rows: no constant-error pre-check | caught | FAIL: "select public.stage_lead_import_rows('dc8e6de8-000e-4cd7-bba1-98a773dcf2dd', '[{"row_no": 4, "problems": ["name_missing"]}]')" gave 4 |
| 21 | Functions: no fresh-code check (hint step_up) | caught | FAIL: "select public.create_lead_import('x.csv', null, 1, 2)" gave 42501 (hint ""), expected 42501 (hint "step_up") |
| 22 | Audit: full copy of imported leads | caught | FAIL: imported leads should each have one small audit row |
| 23 | Audit: search and key columns kept | caught | FAIL: search_text copied into the audit log |
| 24 | Working rows kept after the import | caught | FAIL: working rows kept after the import |
| 25 | Counters not recounted at the end of an import | caught | import counts do not add up |

## Why row 4 is not caught, and why that is fine

Only an admin may tag a new lead with an import (the restrictive policy `companies_import_columns` checks
`private.is_admin()`). The same policy also requires the import to exist and be in progress, read through
`public.import_batches`, whose own policy lets only admins see any import. So a rep or a manager who tried to tag a lead
cannot see the import in that check, and the insert is refused either way: removing the admin check alone changes
nothing anyone can observe. Row 5 removes both layers and the attack test fails ("rep can read import batches"): the pair is
proven necessary, and each layer alone is backed up by the other. The earlier run of this script, before the final
changes, gave the same result.
