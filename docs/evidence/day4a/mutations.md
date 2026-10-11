# Day 4a: protections removed one at a time, 11 Oct 2026

`python3 scripts/db-mutations.py --set day4a` changes the migrations in place for one mutation, runs the whole database
suite (`scripts/db-test.sh`: migrations, the RLS attack test, the import attack test, the two-session import test, the
activity attack test, the two-session activity test, advisors) and restores the migrations; "caught" means the suite
failed. Run on commit a0f86ff (the final migration and tests after review round 1; later commits change only
documents), in three separate copies of the code at the same time (`git worktree`: rows 1 to 34, 35 to 68 and 69 to
101), so nothing else read a mutated file. The first round's run (64 rows, on ffa9dc4) is in git history. A run of this
list on 5244c58 found row 101 not caught: the give-away test named its row, so `tasks_select`, checked on the new row,
hid both layers; a0f86ff adds two bare updates (no WHERE) to that test.

Result: **98 of 98 caught, and the 3 documented two-layer rows not caught, as listed** (101 rows). Count lines
printed by the script, one per copy (each exited 0):

- rows 1 to 34: `day4a: 34 rows run: 34 caught, 0 documented two-layer rows not caught, 0 not as listed`
- rows 35 to 68: `day4a: 34 rows run: 34 caught, 0 documented two-layer rows not caught, 0 not as listed`
- rows 69 to 101: `day4a: 33 rows run: 30 caught, 3 documented two-layer rows not caught, 0 not as listed`

**What the list covers.** Rows 1 to 13 are the design's list (section 8.3, 4a), in its order. Rows 14 to 64 are the
first round's: column grants, guard rules and pre-checks, CHECKs behind pre-checks, policy clauses, foreign key actions,
the D8 audit rules and the D9 untouch trigger, each removed alone. Rows 65 to 101 come from review round 1
(`docs/log.md`, 11 Oct): protections the reviewers showed had no row or no test (C1 controls, the lead lock, the
maintenance previous date, the untouch rule's "only the entry that set the date", the link-emptying exception's own
conditions, the flood windows, a deleted entry's length in the audit, `tasks_delete`'s role clause, Day 3a's
activity-time rule), protections that were tested but had no row (the task CHECKs, the task foreign key actions, the
task update grant), and each layer of the two update policies. The list holds the protections the builder and the
reviewers named; it does not prove that no other protection exists.

**Three layers stand behind another layer,** so no test can see one of them removed alone. They are listed as **NOT
CAUGHT (documented: two layers)**, like Day 3b's row 4 below, and the row removing both layers is caught:

- Row 96, the author rule in `activities_update`'s WITH CHECK. USING already requires the caller to be the author, and
  the author cannot change (no update grant on `user_id`, and the guard refuses it), so the new row always passes.
  Both layers: row 97, caught.
- Row 98, the role clause in `tasks_update`'s USING. An update that names a row also gets `tasks_select`, which has the
  same clause; a bare update (no WHERE) meets the same clause in WITH CHECK and fails with nothing written. Both layers
  (USING and `tasks_select`): row 99, caught.
- Row 100, the role clause in `tasks_update`'s WITH CHECK. The assignee is the only column it reads that a rep could
  change, and `enforce_org_and_owner` refuses that for reps ("only managers and admins can change the owner"); an
  update that names a column also checks the new row against `tasks_select`. Both layers (WITH CHECK and the owner
  rule): row 101, caught by a rep's bare update (no WHERE, so `tasks_select` does not apply) that tries to give tasks
  away.

**Kinds of test** (see `supabase/tests/activity_attack.sql` and `activity_concurrency.sh`):

- through the API role, where grants, row level security and triggers all apply;
- as the superuser with a user's claims, where only the triggers apply: this proves each guard on its own, as if a
  grant were widened by mistake (rows 4, 22, 36, 38, 43), and, one trigger level down as a referential update runs,
  the link-emptying exception's own conditions (rows 75 to 78);
- inside a transaction that switches the activity guard off: this proves the insert policy on its own (row 1: the
  manager exception, which the guard and the missing column grant would otherwise hide);
- two sessions at once on one lead (rows 69 and 70). Row 71 (the lead lock running as the caller) is caught first by
  the catalog check that the lock is DEFINER; a separate run on 078b9fd with that check removed showed the two-session
  test catches it too: "deleting the newest entry left the lead on 2026-01-15 10:00:00+00 while an entry from
  2026-10-11 11:34:44 is still there" (the entry was logged by a rep who cannot change the lead).

Rows that check the builder's changes to the design (`docs/log.md`): 18 (the previous date is carried forward) and 37
(`created_by` in the task guard's link-emptying exception) from the first round; 65 to 68 (C1 controls), 69 to 71 (the
lead lock), 72 and 74 (the previous date for sessions with no signed-in user) from review round 1.

| # | Protection removed | Result | First failure |
|---|---|---|---|
| 1 | Activities insert policy: manager exception back (G1) | caught | FAIL: "insert into public.activities (company_id, type) values ('32000000-0000-0000-0000-0000000000b1', 'note')" succeeded, expected 42501 |
| 2 | Activity guard: author line dropped | caught | new row violates row-level security policy for table "activities" |
| 3 | Activities: update grant on outcome too | caught | FAIL: activity update columns are {body,outcome} |
| 4 | Activity guard: link-emptying exception without the depth condition (a direct update to null passes) | caught | FAIL: "update public.activities set contact_id = null where id = '37a5cc53-895d-48d2-b2d6-d59d655a0ca0'" succeeded, expected 42501 |
| 5 | Activity guard: no link-emptying exception (a contact delete must then fail) | caught | only the text of an entry can change |
| 6 | Activities delete: no fresh code (Day 3a policy) | caught | FAIL: an entry deleted with no code |
| 7 | Last activity on delete: newest remaining entry only (previous date ignored) | caught | FAIL: deleting the last entry left the date at <NULL> |
| 8 | Activities: contact FK back to cascade | caught | FAIL: foreign key delete actions on activities and tasks |
| 9 | Audit: a deleted entry keeps its text | caught | FAIL: a deleted entry should be audited without its text, with its length: {"id": "54d287a7-4e96-43f2-87f5-5a2e06acc1b3", "body": "AUDIT-MAR |
| 10 | Import undo: leads with a task count as untouched | caught | FAIL: undo preview with a task {"kept": 0, "tagged": 2, "removable": 2} |
| 11 | Task guard: keeps the client's done_at | caught | FAIL: done takes the server's time and the caller: {"done_at":"2000-01-01T00:00:00+00:00","completed_by":"00000000-0000-0000-0000-0000000000 |
| 12 | Task guard: the source entry need not be the caller's | caught | FAIL: "insert into public.tasks (company_id, title, source_activity_id) values ('32000000-0000-0000-0000-0000000000b1', 'Not mine', 'f42634d |
| 13 | Activity guard: no flood guard | caught | FAIL: "insert into public.activities (company_id, type) values ('32000000-0000-0000-0000-0000000000e1', 'note')" succeeded, expected 22023 |
| 14 | Task guard: no flood guard | caught | FAIL: "insert into public.tasks (title) values ('One too many')" succeeded, expected 22023 |
| 15 | Activities: insert grant on user_id too | caught | FAIL: activity insert columns are {body,company_id,contact_id,outcome,request_id,type,user_id} |
| 16 | Activity guard: the client's edited_at kept on insert | caught | FAIL: the guard kept a server column sent by the client: {"user_id":"00000000-0000-0000-0000-00000000000a","created_at":"2026-10-11T12:12:19 |
| 17 | Activity guard: previous date not set | caught | FAIL: the guard kept a server column sent by the client: {"user_id":"00000000-0000-0000-0000-00000000000a","created_at":"2026-10-11T12:12:30 |
| 18 | Activity guard: previous date not carried forward (the design's literal rule) | caught | FAIL: previous dates 2026-01-15 10:00:00+00, 2026-10-11 12:12:42.302479+00 (expected the sheet's) |
| 19 | Last activity on delete: runs as the caller | caught | FAIL: only the untouch trigger and the lead lock run as their owner |
| 20 | Last activity on delete: previous date only (remaining entries ignored) | caught | FAIL: deleting the newest entry should go back to the newest remaining one |
| 21 | Activities: deal FK back to cascade | caught | FAIL: foreign key delete actions on activities and tasks |
| 22 | Activity guard: any column editable | caught | FAIL: "update public.activities set type = 'email' where id = '25cdd7a8-0df8-44c7-b794-56803468abe0'" gave 23514 (hint ""), expected 42501 ( |
| 23 | Activity guard: an edit is not marked | caught | FAIL: an edit by the author (text with CRLF, edited_at set, author kept): {"body":"line one\nline two","edited_at":null,"user_id":"00000000- |
| 24 | Activities update policy: managers and admins edit any entry (Day 3a rule) | caught | FAIL: 00000000-0000-0000-0000-00000000000a rewrote rep b1's entry |
| 25 | Activities insert policy: a contact of another lead | caught | FAIL: linked to a record the caller cannot use: insert into public.activities (company_id, contact_id, type) values ('30000000-0000-0000-000 |
| 26 | Activity guard: no outcome pre-check (the CHECK answers with the row) | caught | FAIL: "insert into public.activities (company_id, type, outcome) values ('32000000-0000-0000-0000-0000000000d1', 'call', NULL)" gave 23514 ( |
| 27 | Activity guard: no text length pre-check | caught | FAIL: "update public.activities set body = 'PLANTED-SECRET xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx |
| 28 | Activity guard: no safe-character pre-check | caught | FAIL: "update public.activities set body = 'PLANTED-SECRET \u202Eevil' where id = '1ff42518-1638-43ad-b1b1-9e93d085929c'" gave 23514 (hint ""), e |
| 29 | Activity guard: CRLF not folded on insert | caught | the text contains characters that are not allowed |
| 30 | Activities: a call without an outcome passes the CHECK | caught | FAIL: "insert into public.activities (org_id, company_id, type, outcome, body) select org_id, id, 'call', NULL, NULL from public.companies w |
| 31 | Activities: no safe-character CHECK | caught | FAIL: "insert into public.activities (org_id, company_id, type, outcome, body) select org_id, id, 'note', NULL, 'a\u202Eb' from public.companies  |
| 32 | Audit: an edit keeps the text | caught | FAIL: an edit should be audited as the text's lengths and edited_at: {"body": {"new": "AUDIT-MARKER second, longer words", "old": "AUDIT-MAR |
| 33 | Audit: new entries copied | caught | FAIL: an activity insert was copied into the audit log |
| 34 | Tasks: contact FK back to cascade | caught | FAIL: foreign key delete actions on activities and tasks |
| 35 | Task guard: no link-emptying exception (a contact delete must then fail) | caught | this part of a task cannot change |
| 36 | Task guard: link-emptying exception without the depth condition | caught | FAIL: "update public.tasks set created_by = null where id = 'b731c649-a9e0-4701-b607-c3ca7a4082e8'" succeeded, expected 42501 |
| 37 | Task guard: link-emptying exception without created_by (the design's list: a person delete fails) | caught | this part of a task cannot change |
| 38 | Task guard: fixed fields editable | caught | FAIL: "insert into pg_temp.depth2 values ('update public.tasks set created_by = ''00000000-0000-0000-0000-0000000000b1'' where title = ''For |
| 39 | Task guard: creator left to the client | caught | FAIL: "insert into public.tasks (title) values ('One too many')" succeeded, expected 22023 |
| 40 | Task guard: done, completed by and dismissed kept from the client on insert | caught | new row for relation "tasks" violates check constraint "tasks_not_done_and_cancelled" |
| 41 | Task guard: no assignee left empty for an admin | caught | FAIL: a task with no assignee should be its creator's |
| 42 | Task guard: a done task takes a new client time | caught | FAIL: a done task took a client time |
| 43 | Task guard: completed_by changes without done | caught | FAIL: completed_by changed without done_at |
| 44 | Task guard: dismissed takes the client's time | caught | FAIL: dismissing takes the server's time |
| 45 | Task guard: a dismissed task takes a new client time | caught | FAIL: a dismissed task took a client time |
| 46 | Task guard: no done-and-dismissed pre-check | caught | FAIL: "update public.tasks set cancelled_at = now() where id = '8ba0ed77-f2a5-4e68-a108-d0652b17ba3b'" gave 23514 (hint ""), expected 22023  |
| 47 | Task guard: no title pre-check | caught | FAIL: a personal task (trimmed title, no lead, kind todo) |
| 48 | Task guard: no kind pre-check | caught | FAIL: "insert into public.tasks (title, kind) values ('PLANTED-SECRET', 'chore')" gave 23514 (hint ""), expected 22023 (hint "task_kind") |
| 49 | Task guard: no date-or-time pre-check | caught | FAIL: "insert into public.tasks (title, due_date, due_at) values ('PLANTED-SECRET', current_date, now())" gave 23514 (hint ""), expected 220 |
| 50 | Task guard: no meeting-time pre-check | caught | FAIL: "insert into public.tasks (title, kind) values ('PLANTED-SECRET', 'meeting')" gave 23514 (hint ""), expected 22023 (hint "task_due") |
| 51 | Task guard: dates not bounded | caught | FAIL: "insert into public.tasks (title, due_date) values ('PLANTED-SECRET', current_date + 2000)" succeeded, expected 22023 |
| 52 | Task guard: dates checked even when unchanged (overdue tasks stuck) | caught | the date is out of range |
| 53 | Task guard: the source entry may be on another lead | caught | FAIL: "insert into public.tasks (company_id, title, source_activity_id) values ('32000000-0000-0000-0000-0000000000d1', 'Elsewhere', '225a3a |
| 54 | Task guard: the source entry may be of any age | caught | FAIL: "insert into public.tasks (company_id, title, source_activity_id) values ('32000000-0000-0000-0000-0000000000b1', 'Old', '52000000-000 |
| 55 | Tasks select: the creator loses sight of a task given away | caught | FAIL: the creator lost sight of a task given to a colleague |
| 56 | Tasks select: everyone in the org sees every task | caught | FAIL: rep A can read rep B or other-org rows in tasks |
| 57 | Tasks delete: no fresh code | caught | FAIL: a task deleted without a code |
| 58 | Tasks insert: a lead of another organisation | caught | FAIL: "insert into public.tasks (company_id, title) values ('30000000-0000-0000-0000-0000000000c1', 'x')" succeeded, expected 42501 |
| 59 | Tasks insert: a contact of another lead | caught | new row for relation "tasks" violates check constraint "tasks_contact_needs_lead" |
| 60 | Tasks update: no check on the lead and contact | caught | FAIL: "update public.tasks set contact_id = '12000000-0000-0000-0000-0000000000d1' where id = 'b48d1e73-e92a-4667-8810-f9cc8de000b6'" succee |
| 61 | Tasks: a contact without a lead passes the CHECK | caught | FAIL: "insert into public.tasks (org_id, title, contact_id) select id, 'x', '12000000-0000-0000-0000-0000000000b1' from public.orgs where na |
| 62 | Tasks: insert grant on created_by too | caught | FAIL: task insert columns are {assignee_id,company_id,contact_id,created_by,due_at,due_date,kind,request_id,source_activity_id,title} |
| 63 | Tasks: request id unique across everyone (index on request_id alone) | caught | duplicate key value violates unique constraint "tasks_creator_request_idx" |
| 64 | Activities: request id not unique | caught | FAIL: the request indexes must be unique per author |
| 65 | Activity guard: C1 controls pass the safe-character pre-check | caught | FAIL: "insert into public.activities (company_id, type, body) values ('32000000-0000-0000-0000-0000000000d1', 'note', 'PLANTED-SECRET a\u0080b')" |
| 66 | Activities: C1 controls pass the safe-character CHECK | caught | FAIL: "insert into public.activities (org_id, company_id, type, outcome, body) select org_id, id, 'note', NULL, 'a |
| 67 | Task guard: C1 controls pass the title pre-check | caught | FAIL: "insert into public.tasks (title) values ('PLANTED-SECRET |
| 68 | Tasks: C1 controls pass the title CHECK | caught | FAIL: "insert into public.tasks (org_id, title) select id, 'a |
| 69 | Last activity on delete: no lead lock (two deletes at once leave a deleted entry's date) | caught | FAIL: parallel deletes (newest first) left the lead on 2026-10-11 12:09:38.059024+00, expected the sheet's date |
| 70 | Lead lock on insert: locks nothing (an entry still being logged is missed when the newest is deleted) | caught | FAIL: deleting the newest entry left the lead on 2026-01-15 10:00:00+00 while an entry from 2026-10-11 12:09:59.746451+00 is still there |
| 71 | Lead lock on insert: runs as the caller (locks nothing on a lead the caller cannot change) | caught | FAIL: only the untouch trigger and the lead lock run as their owner |
| 72 | Activity guard: no previous date for sessions with no signed-in user (the chain breaks after them) | caught | FAIL: a maintenance entry should keep the sheet's date as its previous date and move the lead to its own |
| 73 | Last activity on delete: any deleted entry moves the date (not only the one that set it) | caught | FAIL: deleting an entry that did not set the lead's date moved it to 2025-06-01 09:00:00+00 |
| 74 | Activity guard: a maintenance session's own previous date replaced | caught | FAIL: a maintenance session's own previous date was not kept |
| 75 | Activity guard: link-emptying exception lets a link move to another record (depth 2) | caught | FAIL: "insert into pg_temp.depth2 values ('update public.activities set contact_id = ''12000000-0000-0000-0000-0000000000b1'' where body = ' |
| 76 | Activity guard: link-emptying exception lets any column change (depth 2) | caught | FAIL: "insert into pg_temp.depth2 values ('update public.activities set type = ''email'', outcome = ''sent'' where id = ''52000000-0000-0000 |
| 77 | Task guard: link-emptying exception lets a link move to another record (depth 2) | caught | FAIL: "insert into pg_temp.depth2 values ('update public.tasks set created_by = ''00000000-0000-0000-0000-0000000000b1'' where title = ''For |
| 78 | Task guard: link-emptying exception lets any column change (depth 2) | caught | FAIL: "insert into pg_temp.depth2 values ('update public.tasks set kind = ''call'' where title = ''For Fay''')" succeeded, expected 42501 |
| 79 | Activity guard: flood window of one second (60 a second) | caught | FAIL: "insert into public.activities (company_id, type) values ('32000000-0000-0000-0000-0000000000e1', 'note')" succeeded, expected 22023 |
| 80 | Activity guard: flood window of two minutes | caught | too many entries in a minute |
| 81 | Task guard: flood window of one second (60 a second) | caught | FAIL: "insert into public.tasks (title) values ('One too many')" succeeded, expected 22023 |
| 82 | Task guard: flood window of two minutes | caught | too many tasks in a minute |
| 83 | Audit: a deleted entry without its length (D8) | caught | FAIL: a deleted entry should be audited without its text, with its length: {"id": "323438b7-6a7f-47ad-b79d-8696fdb818a0", "type": "note", "o |
| 84 | Tasks delete: no role clause (a fresh code deletes any task of the org) | caught | FAIL: a bare delete by rep d1 removed 12 tasks (d1's own: 4, all: 13) |
| 85 | Activity time (Day 3a trigger): a session with no signed-in user may change it after the fact | caught | FAIL: a session with no signed-in user changed an entry's time |
| 86 | Tasks: date-or-time CHECK dropped | caught | FAIL: "insert into public.tasks (org_id, title, due_date, due_at) select id, 'x', current_date, now() from public.orgs where name = 'TopStoc |
| 87 | Tasks: meeting-time CHECK dropped | caught | FAIL: "insert into public.tasks (org_id, title, kind) select id, 'x', 'meeting' from public.orgs where name = 'TopStock Wholesale'" succeede |
| 88 | Tasks: done-and-dismissed CHECK dropped | caught | FAIL: "insert into public.tasks (org_id, title, done_at, cancelled_at) select id, 'x', now(), now() from public.orgs where name = 'TopStock  |
| 89 | Tasks: safe-title CHECK dropped | caught | FAIL: "insert into public.tasks (org_id, title) select id, 'a\u202Eb' from public.orgs where name = 'TopStock Wholesale'" succeeded, expected 235 |
| 90 | Tasks: kind CHECK dropped | caught | FAIL: "insert into public.tasks (org_id, title, kind) select id, 'x', 'chore' from public.orgs where name = 'TopStock Wholesale'" succeeded, |
| 91 | Tasks: lead FK without cascade (a lead with a task cannot be deleted) | caught | FAIL: foreign key delete actions on activities and tasks |
| 92 | Tasks: creator FK without set null (a person who created a task cannot leave) | caught | FAIL: foreign key delete actions on activities and tasks |
| 93 | Tasks: source entry FK without set null (an entry with a follow-up cannot be deleted) | caught | FAIL: foreign key delete actions on activities and tasks |
| 94 | Tasks: update grant on kind too | caught | FAIL: task update columns are {assignee_id,cancelled_at,contact_id,done_at,due_at,due_date,kind,title} |
| 95 | Activities update policy: USING without the author rule | caught | new row violates row-level security policy for table "activities" |
| 96 | Activities update policy: WITH CHECK without the author rule (behind USING, the grant and the guard) | **NOT CAUGHT** (documented: two layers) | advisors: no ERROR-level findings |
| 97 | Activities update policy: no author rule in USING nor in WITH CHECK (both layers) | caught | FAIL: rep A changed rep B activity |
| 98 | Tasks update policy: USING without the role clause (behind tasks_select and WITH CHECK) | **NOT CAUGHT** (documented: two layers) | advisors: no ERROR-level findings |
| 99 | Tasks update policy: no role clause in USING nor in who sees tasks (both layers) | caught | FAIL: rep A can read rep B or other-org rows in tasks |
| 100 | Tasks update policy: WITH CHECK without the role clause (behind the owner rule and tasks_select) | **NOT CAUGHT** (documented: two layers) | advisors: no ERROR-level findings |
| 101 | Tasks update policy: no role clause in WITH CHECK, and reps may change an owner (both layers) | caught | FAIL: "update public.tasks set assignee_id = '00000000-0000-0000-0000-0000000000b1'" succeeded, expected 42501 |

## Day 3b protections after Day 4a

Day 4a redefines two Day 3b functions (the import "untouched" rule and the audit trigger), so the Day 3b mutations of
those functions (rows 18 to 21, 28 and 29) now edit the Day 4a migration; the others still edit the Day 3b migration.
`python3 scripts/db-mutations.py --set day3b` on 5244c58 (the migrations are the same on a0f86ff, which adds
two checks to the activity test), in a separate copy of the code:
**36 of 37 caught, and row 4 not caught as documented**, exactly as on 10 Oct (`docs/evidence/day3b/mutations.md`);
count line `day3b: 37 rows run: 36 caught, 1 documented two-layer rows not caught, 0 not as listed`. Row 4 is the same protection with two layers documented there (now marked SURVIVES in the
script): only an admin may tag a lead with an import, and only admins can see imports at all, so removing the admin
check alone changes nothing anyone can observe; removing both layers (row 5) is caught.

| # | Protection removed | Result | First failure |
|---|---|---|---|
| 1 | Working rows: insert without a fresh code | caught | FAIL: "insert into private.lead_import_staging (batch_id, row_no, org_id, name) select '9f794597-ac68-4be3-b948-ad67b781b029', 2, org_id, 'x |
| 2 | Working rows: read without a fresh code | caught | FAIL: a stale code reads working rows |
| 3 | Working rows: row number past the file's end | caught | FAIL: "insert into private.lead_import_staging (batch_id, row_no, org_id, name) select '0a494796-540d-48b2-9094-991302e047f6', 4, org_id, 'x |
| 4 | Tagging leads: no admin check | **NOT CAUGHT** (documented: two layers) | advisors: no ERROR-level findings |
| 5 | Tagging leads: no admin check in the rule nor in who sees imports (both layers) | caught | FAIL: rep can read import batches |
| 6 | Tagging leads: no fresh-code check | caught | FAIL: "insert into public.companies (name, import_batch_id) values ('late', '316307bd-0ef7-4e54-9193-57d7d554965f')" succeeded, expected 425 |
| 7 | Tagging leads: import need not be in progress | caught | FAIL: "insert into public.companies (name, import_batch_id) values ('tagged', '433b8ac4-4ddd-4621-90dd-7402a055739e')" succeeded, expected 4 |
| 8 | Tagging leads: any last-activity date | caught | FAIL: "insert into public.companies (name, import_batch_id, last_activity_at) |
| 9 | Tagging leads: date bound 1 Jan 1990 UTC (refuses 1 Jan 1990 in Paris) | caught | FAIL: "insert into public.companies (name, import_batch_id, last_activity_at) |
| 10 | Check: dates compared in UTC instead of local time | caught | FAIL: row 7 expected rejected <NULL> <NULL> date_out_of_range, got (ready,,,) |
| 11 | Tagging leads: into someone else's import | caught | FAIL: "insert into public.companies (name, import_batch_id) values ('Sneak', '0dd44f8e-aa03-4fb5-9506-397711dbac65')" succeeded, expected 42 |
| 12 | Import history: no organisation check | caught | FAIL: other org reads our imports |
| 13 | Import status: changeable without a fresh code | caught | new row violates row-level security policy for table "import_batches" |
| 14 | Import counters: client may write one | caught | FAIL: "update public.import_batches set imported = 99" succeeded, expected 42501 |
| 15 | File name: zero-width and bidi characters allowed (controls only) | caught | FAIL: "select public.create_lead_import('leads\u202Evsc.csv', null, 1, 2)" succeeded, expected 23514 |
| 16 | Batch guard trigger dropped | caught | only the person who started this import can add rows |
| 17 | One import at a time: index not unique | caught | FAIL: "select public.commit_lead_import('85f0edb9-fef4-4f9a-8b9a-eca759673c00')" succeeded, expected 22023 |
| 18 | Undo: leads with an activity count as untouched | caught | FAIL: undo preview {"kept": 4, "tagged": 6, "removable": 2} |
| 19 | Undo: leads with a contact count as untouched | caught | FAIL: undo preview {"kept": 4, "tagged": 6, "removable": 2} |
| 20 | Undo: leads with a deal count as untouched | caught | FAIL: undo preview {"kept": 4, "tagged": 6, "removable": 2} |
| 21 | Undo: edited leads count as untouched | caught | FAIL: undo preview {"kept": 4, "tagged": 6, "removable": 2} |
| 22 | Undo: no second look before deleting (race with a new contact) | caught | FAIL: undo removed a lead that got a contact meanwhile ({"kept": 0, "status": "rolled_back", "removed_now": 1}) |
| 23 | Undo: a short chunk counts as the end (race with a deleted lead) | caught | some leads are still waiting to be removed |
| 24 | Import: no re-check for leads added meanwhile | caught | FAIL: late duplicate not skipped {"status": "committing", "remaining": 1, "imported_now": 3, "imported_total": 6, "late_duplicates": 0} |
| 25 | Import: someone else may run it | caught | FAIL: "select public.commit_lead_import('eada7cae-bb6c-40a7-83f8-9c3040cc71e3')" gave 22023 (hint "not_ready"), expected 42501 (hint "<NULL> |
| 26 | Add rows: no constant-error pre-check | caught | FAIL: "select public.stage_lead_import_rows('84a2adc7-f19a-43f3-bfc5-9ac9b4c4cfcc', '[{"row_no": 4, "problems": ["name_missing"]}]')" gave 4 |
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
