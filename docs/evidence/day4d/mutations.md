# Day 4d mutations

Each row removes one protection of the Day 4d migration (or, where it says so, one of the earlier sets' rows on the
import "untouched" rule, whose live definition is now in the Day 4d migration), runs the whole database suite
(`scripts/db-test.sh`: migrations, rls/import/activity/outcome/files attack tests, the four concurrency scripts,
advisors) and restores it. A row is caught when the run fails. Tool: `python3 scripts/db-mutations.py --set day4d`
(and `--set day3b 18 19 20 21`, `--set day4a 10`), run in a throwaway worktree under the scratchpad with its own
`db-test.sh` on port 54372 (the real script's port untouched), after a passing baseline.

**Final run on e5f6d65** (the migration and database tests are unchanged since 902f000; later commits change only app
code, end-to-end tests and docs), 12 Oct 2026: **Day 4d 30 of 31 caught, 1 documented two-layer row (29), 0 not as
listed; Day 3b rows 18 to 21 caught; Day 4a row 10 caught.** Every anchor of all four sets (Day 3b 37, Day 4a 104,
Day 4b 94, Day 4d 31 rows) was found exactly once on the final head. An earlier full run on a5783bd (before the P11 and
`stale` changes) gave the same result.

Design 8.3's 4d list maps to rows 1 to 10; its row 11 ("skip the sniff on open") is app code, below.

| # | Protection removed | Result | First failure |
|---|---|---|---|
| 1 | Storage insert policy: no organisation folder check | caught | FAIL: "select pg_temp.put('5468deb0-9e90-49b6-952b-41944a522b3d/35000000-0000-0000-0000-0000000000a1/77777777-0000-0000-0000-0000000000cc.pd |
| 2 | Storage insert policy: the file row need not be pending | caught | FAIL: "select pg_temp.put('b3f4861a-8abc-4721-b448-502a17ef07f2/35000000-0000-0000-0000-0000000000a1/212760e8-398c-481d-97dd-cd624f7bdc3b.pd |
| 3 | Storage: an update policy (overwrite, move) | caught | FAIL: storage_policies_exact: {lead_files_delete:d,lead_files_insert:a,lead_files_select:r,lead_files_update:w} |
| 4 | Update guard: ready -> deleting without a fresh code | caught | FAIL: "update public.files set status = 'deleting' where id = 'a9663445-5e42-43fc-8b6d-827fcdff2cc4'" succeeded, expected 42501 |
| 5 | Update guard: finish without the size and type match | caught | FAIL: "select public.finish_file_upload('ff0e8b67-bacb-4ff0-a69e-a1de3eebaf6a')" succeeded, expected 22023 |
| 6 | Insert guard: the space counts declared sizes, not stored bytes | caught | FAIL: "select public.begin_file_upload('35000000-0000-0000-0000-0000000000a2', 'four.pdf', 'application/pdf', 4194304)" succeeded, expected  |
| 7 | Insert guard: no advisory lock (two uploads take the last space) | caught | FAIL: quota_race: both 10 MB uploads were accepted with 15 MB left |
| 8 | Files foreign key to the lead: cascade (bytes orphaned when a lead goes) | caught | FAIL: files_company_id_fkey must be on delete restrict |
| 9 | storage_path written by the client (grant, and the guard keeps it) | caught | FAIL: files insert grant |
| 10 | Bucket public | caught | FAIL: bucket_private (lead-files missing, public, or with other limits) |
| 11 | Insert guard: no limit on uploads waiting | caught | FAIL: "select public.begin_file_upload('35000000-0000-0000-0000-0000000000a2', 'p6.pdf', 'application/pdf', 10)" succeeded, expected 22023 |
| 12 | Insert guard: no hourly upload limit | caught | FAIL: "select public.begin_file_upload('35000000-0000-0000-0000-0000000000a2', 'r31.pdf', 'application/pdf', 10)" succeeded, expected 22023 |
| 13 | Insert guard: hourly limit counts the rows still there (deleting resets it) | caught | FAIL: "select public.begin_file_upload('35000000-0000-0000-0000-0000000000a2', 'r31.pdf', 'application/pdf', 10)" succeeded, expected 22023 |
| 14 | Insert guard: waiting uploads' declared sizes not reserved | caught | FAIL: "select public.begin_file_upload('35000000-0000-0000-0000-0000000000a2', 'two.pdf', 'application/pdf', 2097152)" succeeded, expected 2 |
| 15 | Insert guard: the client's status kept | caught | new row for relation "files" violates check constraint "files_ready_has_time" |
| 16 | Insert guard: the client's uploader kept | caught | FAIL: day4_server_columns_not_writable (guard kept {"id":"a7598e71-162d-4305-83e9-bfb116d92c4e","org_id":"494e1703-5b98-4575-afbc-e7e16b3fd5 |
| 17 | Insert guard: no constant pre-check on the name (the CHECK puts it in the log) | caught | FAIL: "insert into public.files (company_id, name, mime, size) values ('35000000-0000-0000-0000-0000000000a1', 'MARK7\u202Efdp.exe', 'application |
| 18 | Update guard: other columns may change with the status | caught | FAIL: "update public.files set name = 'x.pdf' where id = 'a281fbc4-9885-47d7-ae5c-837ddf8414a8'" succeeded, expected 42501 |
| 19 | Update guard: a file may move back | caught | FAIL: "update public.files set status = 'pending' where id = '7cd0560f-ddae-4636-9192-2ac11e1f1c13'" succeeded, expected 22023 |
| 20 | Delete guard: the row goes while its bytes are still stored | caught | FAIL: "select public.finish_file_delete('5d5e4543-fe65-483e-9705-071c73285f1e')" succeeded, expected 22023 |
| 21 | Who sees a file: the lead's owner sees uploads still pending | caught | FAIL: the lead owner sees a pending upload of someone else |
| 22 | Storage delete policy: the file row need not be deleting | caught | FAIL: bytes removed while the file is not being deleted |
| 23 | Storage select policy: no file row needed (any object of the org) | caught | FAIL: the lead owner sees a pending upload of someone else |
| 24 | Storage insert policy: no two-factor check | caught | FAIL: a storage policy without the two-factor check |
| 25 | Storage insert policy: bytes accepted after 15 minutes | caught | FAIL: "select pg_temp.put('c4b8ff8d-8861-443b-a860-f96c4b397426/35000000-0000-0000-0000-0000000000a1/c04232c7-8908-4e6c-9829-125bb45afee5.pd |
| 26 | begin_file_upload: stale uploads not handed back | caught | FAIL: stale uploads handed back: {"id": "1e04e8d9-f87e-4839-ac02-7cffc321f7af", "path": "3e680e82-fa69-40bc-9758-d1cfed4be3a1/35000000-0000- |
| 27 | audit_file_access: any organisation | caught | FAIL: audit_file_access wrote for another org or an aal1 session |
| 28 | Import undo: a lead with a file counts as untouched | caught | FAIL: undo preview with a file {"kept": 0, "tagged": 2, "removable": 2} |
| 29 | begin_file_delete: no fresh-code pre-check (no step_up hint from the function) | **NOT CAUGHT** (documented: two layers) | advisors: no ERROR-level findings |
| 30 | begin_file_delete pre-check and the update guard's step-up both removed (both layers) | caught | FAIL: "select public.begin_file_delete('a337dbe9-35ff-4187-a4e1-9aea338f82a0')" succeeded, expected 42501 |
| 31 | file_usage: for everyone | caught | FAIL: file_usage is for managers and admins |

day4d: 31 rows run: 30 caught, 1 documented two-layer rows not caught, 0 not as listed

### Day 3b and Day 4a rows that now edit the Day 4d migration

| # | Protection removed | Result | First failure |
|---|---|---|---|
| 18 | Undo: leads with an activity count as untouched | caught | FAIL: undo preview {"kept": 4, "tagged": 6, "removable": 2} |
| 19 | Undo: leads with a contact count as untouched | caught | FAIL: undo preview {"kept": 4, "tagged": 6, "removable": 2} |
| 20 | Undo: leads with a deal count as untouched | caught | FAIL: undo preview {"kept": 4, "tagged": 6, "removable": 2} |
| 21 | Undo: edited leads count as untouched | caught | FAIL: undo preview {"kept": 4, "tagged": 6, "removable": 2} |

day3b: 4 rows run: 4 caught, 0 documented two-layer rows not caught, 0 not as listed

| # | Protection removed | Result | First failure |
|---|---|---|---|
| 10 | Import undo: leads with a task count as untouched | caught | FAIL: undo preview with a task {"kept": 0, "tagged": 2, "removable": 2} |

day4a: 1 rows run: 1 caught, 0 documented two-layer rows not caught, 0 not as listed

## Row 29 (documented two-layer row)

`begin_file_delete`'s own fresh-code pre-check is a first layer that gives a clean `step_up` hint; without it the update
guard (`file_guard_update`, ready to deleting) raises the same `42501 step_up`, so no test can see the first layer
alone. Row 30 removes both layers and is caught. This is the S2 fallback: the step-up lives in the database.

## Design row 11: skip the sniff on open (app code)

`db-mutations.py` only edits migrations. The open check is `checkStoredFile` (server-only) around `readAndSniff`
(`src/lib/files/stored-bytes.ts`). Mutation run by hand on 5362beb's code: `readAndSniff` returning `ok: true` without
calling `sniffFile` → `tests/unit/file-stored.spec.ts` **4 of 5 failed** (the HTML-as-PDF and macro cases with Range
honoured and ignored); restored, 5 passed. Removing the `checkStoredFile` call from `GET /api/files/[id]` itself is
caught only by the CI e2e `direct_api_html_as_pdf_refused_at_open` (needs storage-api): recorded as CI-proved.
