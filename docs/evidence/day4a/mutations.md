# Day 4a: every protection removed one at a time, 11 Oct 2026

`python3 scripts/db-mutations.py --set day4a` changes the migrations in place for one mutation, runs the whole database
suite (`scripts/db-test.sh`: migrations, the RLS attack test, the import attack test, the two-session import test, the
new activity attack test, advisors) and restores the migrations; "caught" means the suite failed. Run on commit ffa9dc4
(the final migration and tests of this PR: later commits change only documents), in a separate copy of the code
(`git worktree`), so nothing else read a mutated file. A first run on d59d4c2, before the "person leaves" case moved
from `auth.users` to `public.profiles`, gave the same 64 of 64.

Result: **64 of 64 caught.** Rows 1 to 13 are the design's list (section 8.3, 4a), in its order; rows 14 to 64 remove
every other protection the migration adds, one at a time: each column grant, each guard rule and pre-check, each
CHECK behind a pre-check, each policy clause, each foreign key action, the D8 audit rules and the D9 untouch trigger.
Three kinds of test make this possible (see `supabase/tests/activity_attack.sql`):

- through the API role, where grants, row level security and triggers all apply;
- as the superuser with a user's claims, where only the triggers apply: this proves each guard on its own, as if a
  grant were widened by mistake (rows 4, 22, 36, 38, 43);
- inside a transaction that switches the activity guard off: this proves the insert policy on its own (row 1: the
  manager exception, which the guard and the missing column grant would otherwise hide).

Two rows check the builder's changes to the design (docs/log.md): row 18 (the previous date is carried forward, so
deleting an older entry and then the newest returns to a true date) and row 37 (`created_by` in the task guard's
link-emptying exception, without which deleting a person who created a task fails).

| # | Protection removed | Result | First failure |
|---|---|---|---|
| 1 | Activities insert policy: manager exception back (G1) | caught | FAIL: "insert into public.activities (company_id, type) values ('32000000-0000-0000-0000-0000000000b1', 'note')" succeeded, expected 42501 |
| 2 | Activity guard: author line dropped | caught | new row violates row-level security policy for table "activities" |
| 3 | Activities: update grant on outcome too | caught | FAIL: activity update columns are {body,outcome} |
| 4 | Activity guard: link-emptying exception without the depth condition (a direct update to null passes) | caught | FAIL: "update public.activities set contact_id = null where id = 'efbe9929-163b-4542-b572-3b3c6a271cf3'" succeeded, expected 42501 |
| 5 | Activity guard: no link-emptying exception (a contact delete must then fail) | caught | only the text of an entry can change |
| 6 | Activities delete: no fresh code (Day 3a policy) | caught | FAIL: an entry deleted with no code |
| 7 | Last activity on delete: newest remaining entry only (previous date ignored) | caught | FAIL: deleting the last entry left the date at <NULL> |
| 8 | Activities: contact FK back to cascade | caught | FAIL: foreign key delete actions on activities and tasks |
| 9 | Audit: a deleted entry keeps its text | caught | FAIL: a deleted entry should be audited without its text, with its length: {"id": "2d550dc2-832e-410f-9f26-90aa02867baa", "body": "AUDIT-MAR |
| 10 | Import undo: leads with a task count as untouched | caught | FAIL: undo preview with a task {"kept": 0, "tagged": 2, "removable": 2} |
| 11 | Task guard: keeps the client's done_at | caught | FAIL: done takes the server's time and the caller: {"done_at":"2000-01-01T00:00:00+00:00","completed_by":"00000000-0000-0000-0000-0000000000 |
| 12 | Task guard: the source entry need not be the caller's | caught | FAIL: "insert into public.tasks (company_id, title, source_activity_id) values ('32000000-0000-0000-0000-0000000000b1', 'Not mine', '5125769 |
| 13 | Activity guard: no flood guard | caught | FAIL: "insert into public.activities (company_id, type) values ('32000000-0000-0000-0000-0000000000e1', 'note')" succeeded, expected 22023 |
| 14 | Task guard: no flood guard | caught | FAIL: "insert into public.tasks (title) values ('One too many')" succeeded, expected 22023 |
| 15 | Activities: insert grant on user_id too | caught | FAIL: activity insert columns are {body,company_id,contact_id,outcome,request_id,type,user_id} |
| 16 | Activity guard: the client's edited_at kept on insert | caught | FAIL: the guard kept a server column sent by the client: {"user_id":"00000000-0000-0000-0000-00000000000a","created_at":"2026-10-11T01:34:26 |
| 17 | Activity guard: previous date not set | caught | FAIL: the guard kept a server column sent by the client: {"user_id":"00000000-0000-0000-0000-00000000000a","created_at":"2026-10-11T01:34:36 |
| 18 | Activity guard: previous date not carried forward (the design's literal rule) | caught | FAIL: previous dates 2026-01-15 10:00:00+00, 2026-10-11 01:34:46.002316+00 (expected the sheet's) |
| 19 | Last activity on delete: runs as the caller | caught | FAIL: only the untouch trigger runs as its owner |
| 20 | Last activity on delete: previous date only (remaining entries ignored) | caught | FAIL: deleting the newest entry should go back to the newest remaining one |
| 21 | Activities: deal FK back to cascade | caught | FAIL: foreign key delete actions on activities and tasks |
| 22 | Activity guard: any column editable | caught | FAIL: "update public.activities set type = 'email' where id = '7165b0bd-eac4-497a-9185-24594b88c126'" gave 23514 (hint ""), expected 42501 ( |
| 23 | Activity guard: an edit is not marked | caught | FAIL: an edit by the author (text with CRLF, edited_at set, author kept): {"body":"line one\nline two","edited_at":null,"user_id":"00000000- |
| 24 | Activities update policy: managers and admins edit any entry (Day 3a rule) | caught | FAIL: 00000000-0000-0000-0000-00000000000a rewrote rep b1's entry |
| 25 | Activities insert policy: a contact of another lead | caught | FAIL: linked to a record the caller cannot use: insert into public.activities (company_id, contact_id, type) values ('30000000-0000-0000-000 |
| 26 | Activity guard: no outcome pre-check (the CHECK answers with the row) | caught | FAIL: "insert into public.activities (company_id, type, outcome) values ('32000000-0000-0000-0000-0000000000d1', 'call', NULL)" gave 23514 ( |
| 27 | Activity guard: no text length pre-check | caught | FAIL: "update public.activities set body = 'PLANTED-SECRET xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx |
| 28 | Activity guard: no safe-character pre-check | caught | FAIL: "update public.activities set body = 'PLANTED-SECRET \u202Eevil' where id = '20612c09-b2df-414a-849c-62c2c1955b1a'" gave 23514 (hint ""), e |
| 29 | Activity guard: CRLF not folded on insert | caught | the text contains characters that are not allowed |
| 30 | Activities: a call without an outcome passes the CHECK | caught | FAIL: "insert into public.activities (org_id, company_id, type, outcome, body) select org_id, id, 'call', NULL, NULL from public.companies w |
| 31 | Activities: no safe-character CHECK | caught | FAIL: "insert into public.activities (org_id, company_id, type, outcome, body) select org_id, id, 'note', NULL, 'a\u202Eb' from public.companies  |
| 32 | Audit: an edit keeps the text | caught | FAIL: an edit should be audited as the text's lengths and edited_at: {"body": {"new": "AUDIT-MARKER second, longer words", "old": "AUDIT-MAR |
| 33 | Audit: new entries copied | caught | FAIL: an activity insert was copied into the audit log |
| 34 | Tasks: contact FK back to cascade | caught | FAIL: foreign key delete actions on activities and tasks |
| 35 | Task guard: no link-emptying exception (a contact delete must then fail) | caught | this part of a task cannot change |
| 36 | Task guard: link-emptying exception without the depth condition | caught | FAIL: "update public.tasks set created_by = null where id = '8f8d3a10-ddb0-4a09-851d-51e9cfa3f807'" succeeded, expected 42501 |
| 37 | Task guard: link-emptying exception without created_by (the design's list: a person delete fails) | caught | this part of a task cannot change |
| 38 | Task guard: fixed fields editable | caught | FAIL: "update public.tasks set created_by = '00000000-0000-0000-0000-0000000000b1' where id = 'bbc754cc-85c7-45ec-8d20-d931df1f4d29'" succee |
| 39 | Task guard: creator left to the client | caught | FAIL: "insert into public.tasks (title) values ('One too many')" succeeded, expected 22023 |
| 40 | Task guard: done, completed by and dismissed kept from the client on insert | caught | new row for relation "tasks" violates check constraint "tasks_not_done_and_cancelled" |
| 41 | Task guard: no assignee left empty for an admin | caught | FAIL: a task with no assignee should be its creator's |
| 42 | Task guard: a done task takes a new client time | caught | FAIL: a done task took a client time |
| 43 | Task guard: completed_by changes without done | caught | FAIL: completed_by changed without done_at |
| 44 | Task guard: dismissed takes the client's time | caught | FAIL: dismissing takes the server's time |
| 45 | Task guard: a dismissed task takes a new client time | caught | FAIL: a dismissed task took a client time |
| 46 | Task guard: no done-and-dismissed pre-check | caught | FAIL: "update public.tasks set cancelled_at = now() where id = '9c0f36ee-dd4f-48bd-8d55-eb843db71b9a'" gave 23514 (hint ""), expected 22023  |
| 47 | Task guard: no title pre-check | caught | FAIL: a personal task (trimmed title, no lead, kind todo) |
| 48 | Task guard: no kind pre-check | caught | FAIL: "insert into public.tasks (title, kind) values ('PLANTED-SECRET', 'chore')" gave 23514 (hint ""), expected 22023 (hint "task_kind") |
| 49 | Task guard: no date-or-time pre-check | caught | FAIL: "insert into public.tasks (title, due_date, due_at) values ('PLANTED-SECRET', current_date, now())" gave 23514 (hint ""), expected 220 |
| 50 | Task guard: no meeting-time pre-check | caught | FAIL: "insert into public.tasks (title, kind) values ('PLANTED-SECRET', 'meeting')" gave 23514 (hint ""), expected 22023 (hint "task_due") |
| 51 | Task guard: dates not bounded | caught | FAIL: "insert into public.tasks (title, due_date) values ('PLANTED-SECRET', current_date + 2000)" succeeded, expected 22023 |
| 52 | Task guard: dates checked even when unchanged (overdue tasks stuck) | caught | the date is out of range |
| 53 | Task guard: the source entry may be on another lead | caught | FAIL: "insert into public.tasks (company_id, title, source_activity_id) values ('32000000-0000-0000-0000-0000000000d1', 'Elsewhere', '3a059a |
| 54 | Task guard: the source entry may be of any age | caught | FAIL: "insert into public.tasks (company_id, title, source_activity_id) values ('32000000-0000-0000-0000-0000000000b1', 'Old', '52000000-000 |
| 55 | Tasks select: the creator loses sight of a task given away | caught | FAIL: the creator lost sight of a task given to a colleague |
| 56 | Tasks select: everyone in the org sees every task | caught | FAIL: rep A can read rep B or other-org rows in tasks |
| 57 | Tasks delete: no fresh code | caught | FAIL: a task deleted without a code |
| 58 | Tasks insert: a lead of another organisation | caught | FAIL: "insert into public.tasks (company_id, title) values ('30000000-0000-0000-0000-0000000000c1', 'x')" succeeded, expected 42501 |
| 59 | Tasks insert: a contact of another lead | caught | new row for relation "tasks" violates check constraint "tasks_contact_needs_lead" |
| 60 | Tasks update: no check on the lead and contact | caught | FAIL: "update public.tasks set contact_id = '12000000-0000-0000-0000-0000000000d1' where id = 'd676dc19-268b-4516-a1cf-68caaa61cd35'" succee |
| 61 | Tasks: a contact without a lead passes the CHECK | caught | FAIL: "insert into public.tasks (org_id, title, contact_id) select id, 'x', '12000000-0000-0000-0000-0000000000b1' from public.orgs where na |
| 62 | Tasks: insert grant on created_by too | caught | FAIL: task insert columns are {assignee_id,company_id,contact_id,created_by,due_at,due_date,kind,request_id,source_activity_id,title} |
| 63 | Tasks: request id unique across everyone (index on request_id alone) | caught | duplicate key value violates unique constraint "tasks_creator_request_idx" |
| 64 | Activities: request id not unique | caught | FAIL: the request indexes must be unique per author |

## Day 3b protections after Day 4a

Day 4a redefines two Day 3b functions (the import "untouched" rule and the audit trigger), so the Day 3b mutations of
those functions (rows 18 to 21, 28 and 29) now edit the Day 4a migration; the others still edit the Day 3b migration.
`python3 scripts/db-mutations.py --set day3b`, same commit, same copy: **36 of 37 caught**, exactly as on 10 Oct
(`docs/evidence/day3b/mutations.md`). Row 4 is the same protection with two layers documented there: only an admin may
tag a lead with an import, and only admins can see imports at all, so removing the admin check alone changes nothing
anyone can observe; removing both layers (row 5) is caught.

| # | Protection removed | Result | First failure |
|---|---|---|---|
| 1 | Working rows: insert without a fresh code | caught | FAIL: "insert into private.lead_import_staging (batch_id, row_no, org_id, name) select '1145dd77-a890-4d84-9886-66938211f488', 2, org_id, 'x |
| 2 | Working rows: read without a fresh code | caught | FAIL: a stale code reads working rows |
| 3 | Working rows: row number past the file's end | caught | FAIL: "insert into private.lead_import_staging (batch_id, row_no, org_id, name) select 'ec1978b4-3c4a-4c89-b4ca-e7bebb062aa8', 4, org_id, 'x |
| 4 | Tagging leads: no admin check | **NOT CAUGHT** | advisors: no ERROR-level findings |
| 5 | Tagging leads: no admin check in the rule nor in who sees imports (both layers) | caught | FAIL: rep can read import batches |
| 6 | Tagging leads: no fresh-code check | caught | FAIL: "insert into public.companies (name, import_batch_id) values ('late', 'ee944add-5c05-4120-a89a-e19002f5cff7')" succeeded, expected 425 |
| 7 | Tagging leads: import need not be in progress | caught | FAIL: "insert into public.companies (name, import_batch_id) values ('tagged', '8f83b772-79f1-4bdd-a0ba-cdedbaba3f55')" succeeded, expected 4 |
| 8 | Tagging leads: any last-activity date | caught | FAIL: "insert into public.companies (name, import_batch_id, last_activity_at) |
| 9 | Tagging leads: date bound 1 Jan 1990 UTC (refuses 1 Jan 1990 in Paris) | caught | FAIL: "insert into public.companies (name, import_batch_id, last_activity_at) |
| 10 | Check: dates compared in UTC instead of local time | caught | FAIL: row 7 expected rejected <NULL> <NULL> date_out_of_range, got (ready,,,) |
| 11 | Tagging leads: into someone else's import | caught | FAIL: "insert into public.companies (name, import_batch_id) values ('Sneak', 'ed1a7430-0a37-430c-b3cd-3ad9c29c2f05')" succeeded, expected 42 |
| 12 | Import history: no organisation check | caught | FAIL: other org reads our imports |
| 13 | Import status: changeable without a fresh code | caught | new row violates row-level security policy for table "import_batches" |
| 14 | Import counters: client may write one | caught | FAIL: "update public.import_batches set imported = 99" succeeded, expected 42501 |
| 15 | File name: zero-width and bidi characters allowed (controls only) | caught | FAIL: "select public.create_lead_import('leads\u202Evsc.csv', null, 1, 2)" succeeded, expected 23514 |
| 16 | Batch guard trigger dropped | caught | only the person who started this import can add rows |
| 17 | One import at a time: index not unique | caught | FAIL: "select public.commit_lead_import('f83e7248-9269-4670-82b9-3d4173680368')" succeeded, expected 22023 |
| 18 | Undo: leads with an activity count as untouched | caught | FAIL: undo preview {"kept": 4, "tagged": 6, "removable": 2} |
| 19 | Undo: leads with a contact count as untouched | caught | FAIL: undo preview {"kept": 4, "tagged": 6, "removable": 2} |
| 20 | Undo: leads with a deal count as untouched | caught | FAIL: undo preview {"kept": 4, "tagged": 6, "removable": 2} |
| 21 | Undo: edited leads count as untouched | caught | FAIL: undo preview {"kept": 4, "tagged": 6, "removable": 2} |
| 22 | Undo: no second look before deleting (race with a new contact) | caught | FAIL: undo removed a lead that got a contact meanwhile ({"kept": 0, "status": "rolled_back", "removed_now": 1}) |
| 23 | Undo: a short chunk counts as the end (race with a deleted lead) | caught | some leads are still waiting to be removed |
| 24 | Import: no re-check for leads added meanwhile | caught | FAIL: late duplicate not skipped {"status": "committing", "remaining": 1, "imported_now": 3, "imported_total": 6, "late_duplicates": 0} |
| 25 | Import: someone else may run it | caught | FAIL: "select public.commit_lead_import('a03db4c6-ef05-4867-8113-1804a5db4f9d')" gave 22023 (hint "not_ready"), expected 42501 (hint "<NULL> |
| 26 | Add rows: no constant-error pre-check | caught | FAIL: "select public.stage_lead_import_rows('6fe6e9a4-2d18-453a-907f-1c907dd3ba27', '[{"row_no": 4, "problems": ["name_missing"]}]')" gave 4 |
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
