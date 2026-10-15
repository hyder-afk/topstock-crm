# Day 4d mutations

Each row removes one protection of the Day 4d migration (or, where it says so, one of the earlier sets' rows on the
import "untouched" rule, whose live definition is now in the Day 4d migration), runs the whole database suite
(`scripts/db-test.sh`: migrations, rls/import/activity/outcome/files attack tests, the four concurrency scripts,
advisors) and restores it. A row is caught when the run fails. Tool: `python3 scripts/db-mutations.py --set day4d`
(and `--set day3b 18 19 20 21`, `--set day4a 10`), run in a throwaway worktree under the scratchpad with its own
`db-test.sh` on port 54372 (the real script's port untouched), after a passing baseline.

**Final run on 90c35b0** (verifier round 2; the migration, `files_attack.sql` and `db-mutations.py` as committed),
12 Oct 2026: **Day 4d 42 of 44 caught, 2 documented two-layer rows (29, 40), 0 not as listed; Day 3b rows 18 to 21
caught; Day 4a row 10 caught.** Every anchor of all four sets (Day 3b 37, Day 4a 104, Day 4b 94, Day 4d 44 rows) was
found exactly once on this head. Rows 32 to 44 are new in round 2; rows 5, 26 and 28 follow the migration (the finish
check now selects the object's version; the sweep is `take_stale_uploads`; the untouched rule calls
`private.lead_has_files`). Row 37 also edits `files_attack.sql`'s static list of definers in the same run, so the
behaviour test (section 12) is what catches it. The previous full run (on e5f6d65, 31 rows) gave 30 caught and 1
documented row.

Design 8.3's 4d list maps to rows 1 to 10; its row 11 ("skip the sniff on open") is app code, below.

| # | Protection removed | Result | First failure |
|---|---|---|---|
| 1 | Storage insert policy: no organisation folder check | caught | FAIL: "select pg_temp.put('94d8e668-38d4-47ba-9202-24ea29fe98eb/35000000-0000-0000-0000-0000000000a1/77777777-0000-0000-0000-0000000000cc.pd |
| 2 | Storage insert policy: the file row need not be pending | caught | FAIL: "select pg_temp.put('06cc4605-2c90-4f1a-9f36-fade9f99d9ea/35000000-0000-0000-0000-0000000000a1/642dbee9-25cc-4194-a142-c4850a11fd9e.pd |
| 3 | Storage: an update policy (overwrite, move) | caught | FAIL: storage_policies_exact: {lead_files_delete:d,lead_files_insert:a,lead_files_select:r,lead_files_update:w} |
| 4 | Update guard: ready -> deleting without a fresh code | caught | FAIL: "update public.files set status = 'deleting' where id = 'e5e46728-8124-478d-b73e-ed3b1bcd4b1d'" succeeded, expected 42501 |
| 5 | Update guard: finish without the size and type match | caught | FAIL: "select public.finish_file_upload('6da11140-7a4f-4d0a-a6bf-06f2faf0d8cc')" succeeded, expected 22023 |
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
| 16 | Insert guard: the client's uploader kept | caught | FAIL: day4_server_columns_not_writable (guard kept {"id":"f5211d5c-3448-4be2-8abb-40bd83ec1932","org_id":"cfbea98f-50a3-49fb-b6e7-fd9df1006c |
| 17 | Insert guard: no constant pre-check on the name (the CHECK puts it in the log) | caught | FAIL: "insert into public.files (company_id, name, mime, size) values ('35000000-0000-0000-0000-0000000000a1', 'MARK7\u202Efdp.exe', 'application |
| 18 | Update guard: other columns may change with the status | caught | FAIL: "update public.files set name = 'x.pdf' where id = '4311eb5b-def2-4711-ba2b-5953cc1325e5'" succeeded, expected 42501 |
| 19 | Update guard: a file may move back | caught | FAIL: "update public.files set status = 'pending' where id = '6e8550c3-9556-455b-bbd2-980e6afdb68d'" succeeded, expected 22023 |
| 20 | Delete guard: the row goes while its bytes are still stored | caught | FAIL: "select public.finish_file_delete('a5e13b96-49af-447d-8be9-8f60e2036d5a')" succeeded, expected 22023 |
| 21 | Who sees a file: the lead's owner sees uploads still pending | caught | FAIL: the lead owner sees a pending upload of someone else |
| 22 | Storage delete policy: the file row need not be deleting | caught | FAIL: bytes removed while the file is not being deleted |
| 23 | Storage select policy: no file row needed (any object of the org) | caught | FAIL: the lead owner sees a pending upload of someone else |
| 24 | Storage insert policy: no two-factor check | caught | FAIL: a storage policy without the two-factor check |
| 25 | Storage insert policy: bytes accepted after 15 minutes | caught | FAIL: "select pg_temp.put('4ea3dcf3-ea39-4c80-adff-9d30f5805209/35000000-0000-0000-0000-0000000000a1/ab015e0a-3f52-48e1-8014-fa81202c4da2.pd |
| 26 | take_stale_uploads: stale uploads not handed back | caught | FAIL: stale uploads handed back: [] |
| 27 | audit_file_access: any organisation | caught | FAIL: audit_file_access wrote for another org or an aal1 session |
| 28 | Import undo: a lead with a file counts as untouched | caught | FAIL: undo preview with files {"kept": 0, "tagged": 3, "removable": 3} |
| 29 | begin_file_delete: no fresh-code pre-check (no step_up hint from the function) | **NOT CAUGHT** (documented: two layers) | advisors: no ERROR-level findings |
| 30 | begin_file_delete pre-check and the update guard's step-up both removed (both layers) | caught | FAIL: "select public.begin_file_delete('c67f9081-3147-4161-be55-840e8f7ce335')" succeeded, expected 42501 |
| 31 | file_usage: for everyone | caught | FAIL: file_usage is for managers and admins |
| 32 | open_file: the object's version not compared (an overwrite through a signed upsert link opens) | caught | FAIL: open_file_object_changed_refused (same size and type, other bytes (new version)): FAIL: "select public.open_file('0065555e-35e1-4b1b-a |
| 33 | open_file: the object's size and type not compared | caught | FAIL: open_file_object_changed_refused (other size, same version): FAIL: "select public.open_file('f9dc9d92-ca2f-443c-b07b-da75d1ea91a7')" s |
| 34 | Update guard: the object's version not recorded at finish | caught | FAIL: object_version_bound_at_finish |
| 35 | Update guard: a client may change the recorded object version | caught | FAIL: "update public.files set object_version = 'forged' where id = 'd231c80f-2a1a-4728-aa65-70b787538479'" succeeded, expected 42501 |
| 36 | Insert guard: the client's object version kept | caught | FAIL: day4_server_columns_not_writable (guard kept {"id":"a3b9fa39-5f57-4dfd-b196-9968cfc24225","org_id":"fdab390c-6b1a-4a90-9101-bf34c0b964 |
| 37 | lead_has_files: security invoker (another person's pending upload hidden; the undo fails with 23503) | caught | FAIL: undo preview with files {"kept": 1, "tagged": 3, "removable": 2} |
| 38 | lead_has_files: any organisation | caught | FAIL: lead_has_files answers for another organisation |
| 39 | Files: require_mfa no longer applies to reads (an aal1 session reads file rows) | caught | FAIL: day4_aal1_blocked: aal1 reads files |
| 40 | Storage select policy: two-factor check made always true (the files row it needs is still hidden at aal1) | **NOT CAUGHT** (documented: two layers) | advisors: no ERROR-level findings |
| 41 | Storage select policy two-factor check and files require_mfa reads both removed (both layers) | caught | FAIL: day4_aal1_blocked: aal1 reads stored objects |
| 42 | Insert guard: the space reserves uploads begun over 15 minutes ago (another person's abandoned upload, forever) | caught | the team's file space is full |
| 43 | Insert guard: a waiting upload whose bytes are stored is also reserved (counted twice) | caught | the team's file space is full |
| 44 | Insert guard: the 5-waiting limit counts uploads begun over 15 minutes ago | caught | too many uploads waiting |

day4d: 44 rows run: 42 caught, 2 documented two-layer rows not caught, 0 not as listed

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

## Row 40 (documented two-layer row, round 2)

The bucket's select policy needs a `files` row the caller can see for the object; at aal1 the restrictive `require_mfa`
on `files` hides every row, so with the policy's own two-factor check made always true an aal1 session still reads no
object (section 6b). Row 39 removes the other layer alone (caught: the admin at aal1 reads file rows) and row 41
removes both (caught: the admin at aal1 reads stored objects).

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

## Verifier round 1 (12 Oct 2026): app-code rows by hand, on e38d97a

No migration changed in this round, so no `scripts/db-mutations.py` row is affected. The changed app code was mutated
by hand (each edit made, the unit file run, the file restored with `git checkout`):

| Row | Mutation | Tests run | Result |
|---|---|---|---|
| M11 (design row 11, re-run) | `readAndSniff` answers ok without `sniffFile` deciding (`true \|\| sniffFile(...)`) | `tests/unit/file-stored.spec.ts` | **caught**: 6 failed, 2 passed |
| M12 | every unreadable read reported as `reason: "mismatch"` (the old behaviour: a slow read deletes the upload) | `tests/unit/file-stored.spec.ts` | **caught**: 4 failed, 4 passed |
| M13 | `afterUploadCheck` discards on every failure | `tests/unit/file-stored.spec.ts` | **caught**: 1 failed, 7 passed |
| M14 | `failureToUpload` back to "any `invalid` that is not `file_size` is a type error" | `tests/unit/file-upload.spec.ts` | **caught**: 1 failed, 3 passed |

The local e2e `rep_cannot_open_others_file` was also run against a permissive `select` policy on `files`
(`using (true)`, added and dropped by hand on the local stack): **caught** (`Expected "0", Received "1"` on the
`file_access` audit count). Before this round the same test passed whatever the policies said.

## Verifier round 2 (12 Oct 2026): app code by hand, on 90c35b0

| Row | Mutation | Tests run | Result |
|---|---|---|---|
| M15 | `src/lib/files/sniff.ts` as before this round (the zip walk stops after the stated count; no end or count-field check) | `tests/unit/file-sniff.spec.ts` | **caught**: 1 failed (`sniff_zip_count_understated`), 7 passed; restored, 8 passed |

`beginUpload`'s order (clean-up before the new row) is server-action code with no unit seam; the database half is
proved by `files_attack` 11 `stale_sweep_survives_refusal` and row 26, and the action is read in review.
