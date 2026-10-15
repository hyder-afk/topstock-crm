# Day 4d: files on a lead, 12 Oct 2026

Design: `docs/evidence/day4/design.md` (sections 1, 2 with D1 to D17 and the spikes in 2.4, 3.4, 4.3, 5.7, 6 rows 17 to
28 for files, 7.6, 8, 10 "4d Files" items 3 to 7, 11 with Haider's answer to question 6). Local branch `day4d-local`,
cut from `main` at a7aa89e (Day 4a and 4b merged). Day 4c (PR #15 branch `claude/busy-darwin-xech8m`, 959e2b8) was
merged into this branch on 12 Oct 2026 (merge commit d0d98b0, no rebase): see "Rebase onto Day 4c (merge)". After PR #15
merged (5f1a966), main was merged in and the branch opened as PR #16 on `claude/busy-darwin-xech8m`: see "PR #16".

## What changed

**Database** (`supabase/migrations/20261014090000_lead_files.sql`)

- `files` belong to the lead (`company_id`, `on delete restrict`; `contact_id` dropped; the migration refuses to run
  if any file row exists). New columns `name` (1 to 180 characters, no control, invisible or bidi character, no `/`,
  `\` or `"`), `status` (`pending`, `ready`, `deleting`), `ready_at`; size 1 byte to 10 MiB; the path shape
  `org/lead/file.ext` checked. Column grants: insert `(company_id, name, mime, size)`, update `(status)`.
- Guards: `file_guard_insert` (DEFINER, trigger-only, revoked) sets the id, path (from ids and the type, never the
  name), status, uploader and times, pre-checks type, size and name with constant errors, then, under an advisory lock
  per organisation, refuses a sixth waiting upload (`too_many_pending`), a 31st upload in an hour (`rate_limited`,
  counted from the audit log so deleting does not reset it) and anything past the team's 800 MiB, counted from the real
  stored bytes plus the declared sizes of uploads still waiting for their bytes (`quota`). `file_guard_update` (INVOKER):
  only the status changes; pending to ready needs the stored object's real size and type to equal the declared
  (`object_mismatch`) and records that object's `version` in `files.object_version` (no client grant; verifier round 2);
  ready to deleting needs a code from the last 10 minutes (`step_up`); nothing moves back.
  `file_guard_delete` (INVOKER): only a `deleting` row whose bytes are gone.
- Policies (D11, as today): the uploader sees their files in every state; once ready, the lead's owner, managers and
  admins too; anyone in the organisation may add to any lead; update and delete for the uploader, lead owner, managers
  and admins (the guards hold the moves).
- Bucket `lead-files` (private, 10 MiB, the five types) and three Storage policies (read, add, remove; no update), each
  checking the organisation's folder and the matching file row (read under the caller's own RLS). Created only when the
  storage schema exists (spike S1); `files_attack.sql` fails loudly otherwise.
- `audit_log.action` gains `file_access` (`private.audit_file_access`, private, ready files of the caller's
  organisation only); the import "untouched" rule keeps leads with a file of any state and any uploader
  (`private.lead_has_files`, DEFINER, own organisation only; verifier round 2); `config.toml`: S3 protocol off.
- RPCs (SECURITY INVOKER, static SQL, revoked from anon): `take_stale_uploads` (the caller's uploads left pending over
  15 minutes become `deleting`; their ids and paths come back for clean-up; its own call before `begin_file_upload`
  since verifier round 2), `begin_file_upload`, `get_pending_upload`, `finish_file_upload`,
  `abort_file_upload`, `list_lead_files` (keyset), `open_file` (only while the stored object is the one checked at
  finish: same version, size and type; writes the audit row), `begin_file_delete`,
  `finish_file_delete`, `file_usage` (managers and admins).
- Local runners: `supabase/tests/storage_shim.sql` (the storage tables with RLS on, Supabase's grants, the unique
  `(bucket_id, name)` index, `storage.foldername`), included by `shim.sql` and applied by `scripts/local-auth/start.sh`.

**Tests** — `supabase/tests/files_attack.sql` (threats 1, 2, 7, 8, 20 to 25, 30, 31) and `files_concurrency.sh`
(`quota_race`, `pending_race`), in `scripts/db-test.sh` and `db.yml` (storage-api on); `rls_attack.sql` and
`import_attack.sql` fixtures moved to the new shape; 44 Day 4d mutation rows (31 before verifier round 2); P11 in `supabase/tests/perf_files.sql`.

**App**

- Libraries: `src/lib/files/sniff.ts` (PDF, PNG, JPEG signatures; Word and Excel from the zip's central directory, at
  most 10,000 entries, `vbaProject.bin` refused, nothing decompressed, never throws), `name.ts` (`cleanFileName`: NFC,
  unsafe characters removed, the type's extension forced, 180 characters), `upload.ts` (checks before any byte is sent;
  XHR upload with real progress, the person's own token, no upsert), `stored-bytes.ts` (reads the stored bytes back for
  the sniff, with or without Range: spike S3), `stored.ts` (server-only: signed links pinned to our Supabase origin),
  `types.ts`, `files-server.ts`.
- Actions `src/app/(app)/leads/[id]/file-actions.ts`: `beginUpload`, `finishUpload` (the bytes sniffed; only bytes
  read in full and refused are removed and answer `type_mismatch`; a read that fails (no link, Storage error, the 3 s
  budget, a body cut short) answers `unavailable` and leaves the row pending: `afterUploadCheck` in `stored-bytes.ts`;
  the Files tab then cancels that row at once and offers Try again, the 15-minute clean-up being the last resort),
  `abortUpload`, `deleteFile` (step-up; when the bytes cannot be removed the row
  stays `deleting`).
- Routes: `GET /api/files/[id]?disposition=` (Sec-Fetch-Site, `open_file`, **the check on every open**, a 60-second
  link, 303 with `no-store` and `no-referrer`, else 303 to `/files/unavailable`), `GET /api/leads/[id]/files`;
  page `/files/unavailable` with its `loading.tsx`.
- **The Files tab is shown now** (between Stock and Details; D16's hidden state ends): drop zone with a real button
  ("Add file" on phones; `accept` lists the types, so iPhone Safari gives JPEG), uploads with a real progress bar and
  Cancel, then "Checking the file…", per-file reasons (too big, empty, type, unreadable, "isn't really a PDF" per kind,
  space full, too many uploads, connection lost, more than 5 at once; each also announced, and Try again on the same
  line when the file itself was not refused), the list (type tile, name keeping its extension, size in DM
  Mono, who, when; Open for PDF and images, Download, Delete with confirmation and a fresh code), "Couldn't finish
  deleting · Retry", the team's space for managers and admins, loading, empty and error states. The first page comes
  with the lead page; hovering the tab prefetches.
- Messages EN and FR (`Files`, `LeadPage.tabs.files`, `Errors.hint.file_*`), French typography checked.
- Screenshots: 66 in `screens/` (verifier round 2 added an upload's line uploading, checking and failed: 24).

## Spikes S1 to S4 (design 2.4): decided by fallback, proved in CI on the PR

No Docker here, so no storage-api: each spike's safe fallback is built, and CI records the real behaviour.

| Spike | Question | Built here (safe either way) | Recorded in CI |
|---|---|---|---|
| S1 | Storage schema without storage-api; migration order | storage-api enabled in `db.yml` and `auth-journey`; every `storage.*` reference in plpgsql; bucket and policies created behind `to_regclass`; `files_attack.sql` fails if they are missing | `db.yml` step "Spike S1" writes the bucket columns, storage's migration count, our bucket row and policies to the job summary |
| S2 | Does storage-api pass `amr` to Storage policies? | Step-up for delete enforced in `file_guard_update` and `begin_file_delete` (database); Storage policies use only `has_aal2` and the `deleting` row | `tests/auth/files-spikes.spec.ts` S2 (probe buckets readable with `has_aal2` / `has_recent_aal2`); e2e `delete_needs_fresh_code` |
| S3 | Do signed links honour Range? | `stored-bytes.ts` reads 206 ranges or a 200 whole body the same way (unit-tested both ways) | files-spikes S3 (status and bytes of a ranged request) |
| S4 | Metadata key names; written before the insert check? | Key names only in `private.object_size_key()`/`object_mime_key()`; the ready check runs at finish | files-spikes S4 (keys, the helpers' reading, a probe bucket whose insert policy needs `metadata ? 'size'`) |
| S5 (verifier finding 8) | Is the insert policy checked again when bytes reach a signed upload link, or only when the link is made? | Nothing to build: stray bytes this way are accepted residual risk 7 (they count against the team's space, read from real stored bytes) | files-spikes S5 (a link made for a pending upload, the upload cancelled, then bytes sent to the link: status and whether an object was stored). Recorded only; TUS uploads not probed |

Results land in the CI artifact `storage-spikes` (`test-results/spikes/day4d.json`) and the S1 job summary. The spike
tests fail only where the built code would break (S2: `has_aal2` must work in Storage policies, or no upload could;
S4: the helpers must read the real keys).

## Verifier round 1 (12 Oct 2026): NOT READY, every finding fixed

| # | Finding | What changed | How it was checked |
|---|---|---|---|
| 1 | Medium: every failed read of the stored bytes was treated as a fake file (upload deleted, "isn't a real Word file") | `readAndSniff` returns `reason: "unreadable"` (no link, Storage error, timeout, body or tail cut short) or `"mismatch"` (bytes read in full, refused by `sniffFile`); `afterUploadCheck` turns it into finish / discard / keep pending; `finishUpload` deletes only on `mismatch` and otherwise answers `unavailable`, leaving the row pending (Cancel or the 15-minute clean-up). The open route is unchanged (any failure is `/files/unavailable`) | Unit tests written first and seen failing (3 of 11), then passing: a stream that times out mid-read, a fetch that times out, 503, 400, a whole body cut short, a short tail, and `afterUploadCheck` on a timed-out read (`keep_pending`). Hand mutations M12, M13 (`mutations.md`) |
| 2 | Medium: `rep_cannot_open_others_file` could not fail (no bytes, so every open ends on `/files/unavailable`) | Locally the test now reads the `file_access` audit row that `open_file` writes only when the caller may open the file: 0 after the rep's request, 1 after the admin's (the control). CI twin with real bytes: the admin uploads through the API, gets a 303 to the Storage origin; the rep gets `/files/unavailable` | Local e2e passes; with a permissive `select` policy added on `files` the local test **fails** (`Expected "0", Received "1"`), policy dropped after. CI twin: CI only |
| 3 | Medium: `deleted_file_url_404` named but not written; no test deleted the bytes of a real upload | The CI test now takes a fresh link, checks the object exists, deletes the file through the tab with a fresh code (step-up dialog), then checks the row and the `storage.objects` row are gone, `/api/files/<id>` answers `/files/unavailable`, and the earlier link answers 4xx | CI only (needs storage-api); lint, typecheck |
| 4 | Low: `/security-review` not run | Run in this session (`security-review.md`): the command again collected the primary checkout's diff, so its prompt was applied to this worktree's diff on e38d97a | No high-confidence finding. Still to run on the PR head (no PR in this workflow) |
| 5 | Low: S1 wording missed the "old storage tables" case | "Open risks" now lists the three cases; case (c) makes `supabase start` fail outright | Read against the migration's `to_regclass` guard and insert |
| 6 | Low: progress `aria-valuetext` was a hand-built "`n` %" | `format.number(progress, { style: "percent", maximumFractionDigits: 0 })` | Typecheck; CI e2e asserts `aria-valuetext` matches `^\d{1,3}%$` or "Checking the file…" in English |
| 7 | Low: hints `file_name` / `file_lead` showed the type message | `failureToUpload` (moved to `src/lib/files/upload.ts`): `file_type` -> type, `file_size` -> too big, any other `invalid` -> unavailable | Unit test first failing, then passing; hand mutation M14 |
| 8 | Info: signed upload links may skip the 15-minute check | Spike S5 in `files-spikes.spec.ts` records it in CI (accepted residual risk 7) | CI only |

Check results on **e38d97a** (the last code commit), 12 Oct 2026. Shared local auth stack taken while idle (it served
the Day 6a checkout, nothing of 6a's running), restarted for this worktree, released after the run.

| Check | Result |
|---|---|
| `db-test.sh` (a copy on port 54395) | all 9 suites pass; advisors 0 ERROR (WARN `set_user_role` accepted; INFO unchanged); exit 0. No migration change in this round, so no `db-mutations.py` row is affected |
| Hand mutations (app code) | M11 (design row 11 re-run: skip the sniff) 6 of 8 `file-stored` tests fail; M12 (unreadable reported as mismatch) 4 fail; M13 (discard on every failure) 1 fails; M14 (old hint mapping) 1 `file-upload` test fails; all restored |
| `npm run lint` | exit 0: 0 errors, the 2 existing React Compiler warnings (files this branch does not touch) |
| `npm run typecheck` | exit 0 |
| `npm run test:unit` | 347 passed |
| E2E local, Chromium | `files.spec.ts`, `files-spikes.spec.ts`, `files-screens.spec.ts`: **9 passed, 8 skipped** (storage-api cases and spikes: CI only) |
| gitleaks (`origin/main..HEAD`) | no leaks found, exit 0 |
| `npm audit --omit=dev` | found 0 vulnerabilities |
| WebKit e2e, Semgrep, storage-api e2e and spikes S1 to S5 | CI only |

## Verifier round 2 (12 Oct 2026): findings 1 to 6 (database and security) fixed

Findings from `day4d-findings.json` (n = 1 to 6; the skeptic confirmed each). Code commits: a919f7c (finding 2),
ac9a895 (database and SQL tests: 1, 3, 4, 5, 6), f8c0cdc (CI e2e for 1, local seed objects), 90c35b0 (mutation rows).

| # | Finding | What changed | How it was checked |
|---|---|---|---|
| 1 | Should fix: a signed upload link made with `x-upsert: true` while the file is pending can overwrite it after it is ready (storage-api writes it as its own superuser; nothing noticed) | **Bound to the exact object**: `files.object_version` (server-set by `file_guard_update` at pending to ready from `storage.objects.version`; no client grant; the insert guard clears it; the update guard refuses a change). `open_file` joins `storage.objects` and answers "not found" (the route's `/files/unavailable`, no audit row) unless the version, the size and the type are still those checked at finish, or when the object is gone. storage-api writes a new random version for every upload (`uploader.ts` `prepareUpload`: `randomUUID()`), so an upsert overwrite always changes it. **Exposure**: refusing upsert at sign time is not possible by policy (the sign-time probe is `INSERT ... ON CONFLICT DO UPDATE` on a path with no object yet, which an INSERT policy passes; the skeptic showed this on a throwaway cluster), and a trigger or grant change on `storage.objects` is a change to the storage schema, which Supabase says to treat as read-only (docs "The Storage Schema"); so the overwrite still lands, but the file can no longer be opened, by anyone. The app itself never asks for upsert (`x-upsert: false`) | `files_attack` 2 `object_version_bound_at_finish`; 3 (a client cannot set it: grant, insert guard, update guard alone); **8b** `open_file_object_changed_refused`: same size and type with a new version, other size, other type, each refused for the uploader and an admin, no `file_access` row; put back, it opens for both; object deleted, refused. CI e2e `signed_upsert_overwrite_after_ready_refused` (real storage-api: link signed with `x-upsert: true` while pending, genuine PDF sent through it and finished, opens; other bytes of the same size sent to the link; then `/files/unavailable`, or, if storage-api refused the overwrite, the version is unchanged and it still opens). Mutation rows 32 to 36 |
| 2 | Nit (security): the macro check walked only as many zip entries as the end record claimed | `zipEntryNames` refuses a directory whose walk does not end exactly at its end (`at === end`), a split-disk count field, and a disk entry count that differs from the total | Unit `sniff_zip_count_understated` (4 entries, count says 3, `word/vbaProject.bin` last): **fails on the old `sniff.ts` (1 failed, 7 passed), passes now**; hand mutation M15 |
| 3 | Should fix: import undo failed (23503, the chunk rolled back) when another user had a pending upload on an imported lead (the admin's RLS hides it) | `private.lead_import_untouched` calls `private.lead_has_files(c.id)` (DEFINER, `search_path = ''`, own organisation only, revoked from public and anon). The lead is kept, as for any lead with a file. `rollback_lead_import` already locks the candidates first, so an upload begun during the undo waits or is seen by the second statement | `files_attack` 12 `import_undo_keeps_lead_with_others_pending_file`: rep g1 begins an upload on lead Three; the admin cannot see it; preview `{tagged 3, removable 1, kept 2}`; the undo succeeds (no exception) and keeps One and Three; another organisation's admin gets `false` from the helper. Mutation rows 37, 38 |
| 4 | Should fix: the stale-upload sweep ran in `begin_file_upload`'s transaction, so a quota refusal (caused by the stale bytes) undid it | New RPC `take_stale_uploads()` (INVOKER, two-factor, the caller's own rows over 15 minutes, at most 20). `beginUpload` calls it, removes the bytes and rows (`clearDeleting`), then calls `begin_file_upload`, which no longer sweeps. A row left `deleting` is listed to its uploader and admins with Retry | `files_attack` 5 (begin no longer sweeps; another person gets nothing; the caller gets the row once) and 11 `stale_sweep_survives_refusal`: an abandoned 9 MiB upload fills the space, 4 MiB refused; `take_stale_uploads` hands it back; a second refusal leaves it `deleting`; bytes removed and row finished, 4 MiB fits. Mutation row 26 |
| 5 | Nit: the anon and aal1 read probes ran before any object existed, and with a rep who could see nothing anyway | The probes moved to section **6b**, after two ready files with objects exist: anon reads 0 objects; the admin at aal2 sees both files and objects (control), at aal1 0 objects, 0 file rows, and `open_file` 42501 | Mutation rows 39 (files `require_mfa` reads opened: caught), 40 (the select policy's two-factor check made always true: documented two-layer row, the files row it needs stays hidden at aal1), 41 (both: caught by the objects probe) |
| 6 | Nit: three limit clauses had no test or mutation | `files_attack` 11: `old_pending_not_counted` (5 direct pending rows of h1 aged 16 minutes do not block a new upload), `stored_upload_counted_once` (9 MiB declared and stored, 2 MiB still fits), `old_reservation_expires` (another person's 10 MiB upload begun 16 minutes ago with no bytes reserves nothing) | Mutation rows 42, 43, 44, each removing one clause: caught |

Check results on **90c35b0** (the last code commit), 12 Oct 2026:

| Check | Result |
|---|---|
| `db-test.sh` (a copy on port 54371) | all 9 suites pass; advisors 0 ERROR; WARN `set_user_role` (accepted since Day 1); INFO `unindexed_foreign_keys` 2, `unused_index` 3 (was 2: `files_pending_idx` is no longer chosen on the small test tables now that the sweep is its own query; P11's 5,000-file plans use their own indexes); exit 0. The committed head before this round, run the same way: same suites, `unused_index` 2 |
| Mutations (`mutations.md`) | Day 4d **42 of 44 caught, 2 documented two-layer rows (29, 40), 0 not as listed**; Day 3b rows 18 to 21 and Day 4a row 10 caught; every anchor of the four sets found once; run in a throwaway worktree under the scratchpad on port 54372, removed after |
| Hand mutation M15 (app code) | the old `sniff.ts` restored: `file-sniff.spec.ts` 1 failed, 7 passed; restored |
| Perf P11 (`perf.md`) | 3 runs: `take_stale_uploads` 0.42 / 0.54 / 0.45 ms, `begin_file_upload` 6.95 / 7.60 / 7.76 ms, `finish_file_upload` 3.25 / 3.73 / 4.07 ms (budget 10 ms each) |
| `npm run test:unit` | 349 passed |
| `npm run lint` / `npm run typecheck` | exit 0 (pre-commit hook on every commit; the 2 existing React Compiler warnings) |
| E2E local, Chromium | `files.spec.ts` 7 passed, 5 skipped (CI only, including the new upsert test); `files-spikes.spec.ts` 4 skipped (CI only); `files-screens.spec.ts` 2 passed; `import.spec.ts` 11 passed (undo through the UI). Shared stack idle (no auth Playwright run; it served the Day 6a checkout), restarted for this worktree |
| gitleaks, `npm audit --omit=dev` | gitleaks (`origin/main..HEAD`): no leaks found, exit 0; `npm audit --omit=dev`: found 0 vulnerabilities |
| WebKit, Semgrep, storage-api e2e (including `signed_upsert_overwrite_after_ready_refused`) and the spikes | CI only |

## Verifier round 2 (12 Oct 2026): findings 7 to 18 (app and design) fixed

Findings from `day4d-findings.json` (n = 7 to 18; the skeptic confirmed each). Code commits: fe173cb (finding 12),
2a39c31 (Files tab, messages, comments: 7 to 11, 13 to 18), b7b84b9 (e2e and the screenshot spec). Every new e2e test
was also run against the previous `files-tab.tsx` (rebuilt): each fails there (named below), and passes now.

| # | Finding | What changed | How it was checked |
|---|---|---|---|
| 7 | Should fix: a failed check after upload (`unavailable`, or the finish call lost) left an invisible pending row the user could not cancel; five tries locked uploads for 15 minutes | `uploadOne` cancels the pending row at once (`abortUpload`) on any failed finish except a refused file (which the server already removed), and on a failed or refused send; the line offers **Try again** on the same file (`canRetry`: connection, unavailable, more than 5 at once) and keeps the id if the cancel itself failed, so Dismiss and Try again cancel it first. `finishUpload`'s and `afterUploadCheck`'s comments say so; the README line above too | e2e `upload line focus`: while checking, 1 pending row; after the failed check (no storage-api here) 0 pending rows, the line reads "Couldn't add this file. Try again." and announces it; Try again uploads the same line again. Unit `canRetry` |
| 8, 13 | Should fix: focus fell to `<body>` when Cancel went (checking) or became Dismiss (error) | `patch` notes when a phase change happens with the focus inside the line; an effect after the commit moves it to the line's new `[data-upload-action]` button (Cancel, Try again, or Dismiss) or to the line itself (`tabIndex=-1`) while checking; `drop` sends it to Choose files | e2e `upload line focus`: Cancel focused -> the line focused while checking -> Try again focused after the failed check -> Cancel focused after Try again -> Choose files after Cancel; a lost connection while sending -> Try again focused. **Old component: fails** ("the line" not focused) |
| 9 | Should fix: a file the browser could not read was called fake | `checkLocalFile` separates the read (`catch` -> `unreadable`) from `sniffFile`'s answer (`mismatch`); "Couldn't read this file. Choose it again." / "Impossible de lire ce fichier. Choisissez-le à nouveau." | Unit `checkLocalFile: a read that fails is unreadable` (a `slice()` whose `arrayBuffer()` rejects with `NotReadableError`, PDF and Word): **fails with the old catch (1 failed, 5 passed)**, passes now |
| 10 | Nit: "Show older files" unmounted after the last page (focus to `<body>`); a failed page showed nothing | One stable button that reads Try again under an inline `role="alert"` error (`isFetchNextPageError`), `aria-disabled` while loading with two skeleton rows; after the last page the focus moves to the first file that arrived (else the heading) | e2e `show older files` (52 files, the older page answered 502 then let through): the alert and the same button focused; then "Lot 51.pdf" focused. **Old component: fails** (no alert) |
| 11 | Nit: the stuck delete's Retry was `disabled` while busy (focus to `<body>`) and named only "Retry" | `aria-disabled` with an early return; `aria-label` "Retry deleting `name`" / "Réessayer de supprimer `name`" (visible text unchanged); 44 by 44 on phones, scale 0.97 on press | e2e `delete_needs_fresh_code`: Retry found by its new name, pressed from the keyboard, fails again here (no storage-api), the toast shows, and Retry still has the focus. **Old component: fails** (no such name) |
| 12 | Nit: the "this year?" check used the process's time zone (hydration mismatch around New Year) | `fileDateLabel` (`src/lib/files/dates.ts`) compares both years through next-intl's formatter (Europe/Paris) | Unit `file-dates.spec.ts`: now 2026-12-31T23:30Z, file 22:00Z: "31 déc. 2026" with the Paris formatter, "31 déc." with a UTC one; passes under `TZ=UTC`, `Europe/Paris` and `America/New_York` |
| 14 | Should fix: refusal reasons not announced; files past 5 refused silently | Announcement "`name` wasn't added. `reason`" (the line's own words); one ICU-plural summary "2 files weren't added: up to 5 at a time." (FR "2 fichiers n'ont pas été ajoutés : 5 à la fois au maximum."); the status region keeps the last 10 messages as separate nodes, so several outcomes in one render are each read | e2e `announcements` (a fake PDF, 4 SVGs, 2 past the limit): 6 messages, the summary first, each reason present; the extra files offer Try again, the refused ones do not. **Old component: fails** (fewer than 6 messages: only the last of a burst is in the region); unit messages parity and French typography |
| 15 | Should fix: the progress track was invisible in light mode; no uploading or checking screenshot | The upload line is the card colour with a border token; the track is the muted surface (DESIGN.md "tracks"), 8 px as the import bar | 24 new shots: `files-uploading-*` (throttled to about 40%), `files-checking-*`, `files-failed-*` at 390 and 1440, light and dark, EN and FR; the track's length shows in both themes. Apple and WIG audits re-checked against them |
| 16 | Should fix: the name link was 24 px tall on phones; EN Retry about 36 px wide, no press feedback | Phones: the name link's `::after` covers its line (icon, name, meta), the menu button sits above it, the line tints on press; Retry `min-h-11 min-w-11`, `active:scale-[0.97]` | e2e `phone_390_files`: the line is at least 44 px and a tap on the icon tile and on the meta line lands on the link; Retry at least 44 by 44. **Old component: fails** (the icon tile is not the link) |
| 17 | Nit: a file dropped outside the zone replaced the page | While the tab is shown (an effect, so React's Activity removes it on hidden tabs), window `dragover`/`drop` with files are cancelled outside the zone (`dropEffect = "none"`) | e2e `hidden tab`: dispatched `dragover`/`drop` on the page title and the Files heading are cancelled while Files is shown, not while Timeline is. **Old component: fails** |
| 18 | Nit: outcomes while the tab was hidden were silent | A final outcome (failed, added, the past-5 summary) also goes to the app's toast when the tab is hidden (`shown` ref, false while Activity hides the tab); the line stays for when it is shown again | e2e `hidden tab`: an upload's connection fails after switching to Timeline: the toast "`name` wasn't added. Connection lost. Try again." is visible; back on Files, the line says it |

### Checks on b7b84b9 (code as committed; screenshots and docs in the next commit)

| Check | Result |
|---|---|
| `npm run test:unit` | 353 passed (new: `file-dates` 2, `file-upload` unreadable and `canRetry`) |
| `npm run lint` / `npm run typecheck` | exit 0 (pre-commit hook on each commit; the 2 existing React Compiler warnings) |
| `db-test.sh` (a copy on port 54371) | all 9 suites pass; advisors 0 ERROR (WARN `set_user_role` accepted; INFO `unindexed_foreign_keys` 2, `unused_index` 3, as after round 2's database fixes); exit 0. No migration change in this round, so no mutation row is affected |
| E2E local, Chromium | `files.spec.ts` **11 passed, 5 skipped** (CI only); `files-screens.spec.ts` 3 passed (66 shots, no console error, no sideways scroll); `lead-page.spec.ts` + `files-spikes.spec.ts` 26 passed, 4 skipped. The shared stack was idle (6a's gateway, no Playwright run), restarted for this worktree and left running |
| New e2e against the previous `files-tab.tsx` (rebuilt) | `phone_390_files`, `announcements`, `upload line focus`, `hidden tab`, `show older files`, `delete_needs_fresh_code` (Retry's name): each fails |
| gitleaks (`origin/main..HEAD`), `npm audit --omit=dev` | no leaks found, exit 0; found 0 vulnerabilities |
| WebKit, Semgrep, storage-api e2e | CI only. In CI the new upload tests run the same way (the Storage request is answered or held by the test, so no object is stored and the check after upload fails as here) |

## Verifier round 3 (12 Oct 2026): NOT READY on 742bb40, both findings fixed

Code commits: 27c0c1b (finding 2), d88a50d (finding 1, Files tab), 307f764 (finding 1, e2e). Each behaviour fix has a
test that failed first and passes now.

| # | Finding | What changed | How it was checked |
|---|---|---|---|
| 1 | Should fix: closing the Delete dialog dropped the focus to `<body>` (Escape, Cancel, a cancelled code, a failed delete): Radix returned it to the menu item that opened the dialog, which no longer exists | The file whose Delete was chosen is remembered (`returnTo`). `DialogContent`'s `onCloseAutoFocus` prevents Radix's default and focuses that row's own button (Actions, or Retry once stuck deleting; both carry `data-file-actions`) or the heading when the row is no longer listed, only when nothing has the focus (so "Confirm it's you", opened in the same render, keeps it). `ensureFresh` gets the same target as its fallback, so a cancelled code returns there too. After a failed delete and its refetch, the focus goes to what the row has now (Actions, Retry, or the heading). A successful delete still moves it to the heading | New e2e `delete dialog focus` (keyboard only, a session of its own): Escape, then Cancel, each `toBeFocused` on the row's Actions; a delete whose server action is aborted shows the toast, keeps the file and the focus on Actions; with a code older than 10 minutes, Escape in "Confirm it's you" returns to Actions. `delete_needs_fresh_code`: after the code, the failed delete (no storage-api here, the row stuck deleting) focuses the row's Retry. **Previous `files-tab.tsx` (rebuilt): both fail** (Actions not focused after Escape, line 358; Retry not focused, line 313); pass now |
| 2 | Nit: any refused `beginUpload` input answered `invalid("file_type")`, so a name over 400 characters was told "Only PDF, PNG, JPG, Word or Excel files" | `beginUploadHint` (`src/lib/files/types.ts`) names the failing field as the database's own hints: `name` -> `file_name` (shown as unavailable), `size` -> `file_size`, `mime` -> `file_type`, `leadId` -> `file_lead`, anything else no hint. The Files tab sends the cleaned name (`cleanFileName`, at most 180 characters, the extension kept; the server cleans it again), so a real file with a very long name is not refused at all | Unit `beginUploadHint` (a 446-character name, an empty name, a too-big size, an SVG type, a bad lead id, an unknown field; the cleaned long name passes `beginUploadInput`): **fails before the change** (no such function), passes now |

### Checks on 307f764

| Check | Result |
|---|---|
| `npm run test:unit` | 354 passed (new: `beginUploadHint`) |
| `npm run lint` / `npm run typecheck` | exit 0 (pre-commit hook on each commit, and run again; the 2 existing React Compiler warnings) |
| `db-test.sh` (a copy on port 54371) | all 9 suites pass; advisors 0 ERROR (WARN `set_user_role` accepted; INFO `unindexed_foreign_keys` 2, `unused_index` 3); exit 0. No migration change in this round, so no mutation row is affected and mutations were not re-run (last run: verifier round 2, matches `mutations.md`) |
| E2E local, Chromium | `files.spec.ts` + `files-spikes.spec.ts` **12 passed, 9 skipped** (Storage and spike cases, CI only); `lead-page.spec.ts` 26 passed (with the fix, before the new test's session change). The shared stack was idle, restarted for this worktree (the build ran inside a script named as a Playwright session, and every run first checked the gateway still served this worktree) and left running idle |
| New e2e against the previous `files-tab.tsx` (rebuilt) | `delete dialog focus` and `delete_needs_fresh_code` (Retry focused): each fails |
| gitleaks (`origin/main..HEAD`), `npm audit --omit=dev` | no leaks found, exit 0; found 0 vulnerabilities |
| Screenshots, Apple and WIG audits | No visual change (focus only, and the name sent to the server): no shots re-taken; WIG row 13 and Apple row 19 added |
| WebKit, Semgrep, storage-api e2e | CI only (`files.spec.ts` is in the WebKit `testMatch`) |

## Check results (first round)

Code checks on **6a08a49** (the last code commit; the commits after it are docs), 12 Oct 2026. Local auth stack
restarted for this worktree (the shared stack was idle; it served the Day 6a worktree before).

| Check | Result |
|---|---|
| `scripts/db-test.sh` (a copy on port 54371) | all 9 suites pass: rls_attack, import_attack, import_concurrency, activity_attack, activity_concurrency, outcome_attack, outcome_concurrency, **files_attack**, **files_concurrency**; advisors: no ERROR-level findings (WARN `set_user_role`, accepted since Day 1; INFO `unindexed_foreign_keys` 2 and `unused_index` 2, as before 4d); exit 0 |
| Mutations (`mutations.md`) | Day 4d **30 of 31 caught, 1 documented two-layer row, 0 not as listed** (on e5f6d65; migration unchanged since); Day 3b rows 18 to 21 and Day 4a row 10 (retargeted to the Day 4d migration) caught; every anchor of the four sets found once on the final head; design row 11 (sniff on open) by hand: 4 unit failures |
| Perf P11 (`perf.md`, 3 runs) | `begin_file_upload` 7.31 / 7.90 / 7.53 ms, `finish_file_upload` 3.23 / 3.45 / 3.29 ms (budget 10 ms each), 5,000 stored files |
| `npm run lint` | exit 0: 0 errors, the 2 existing React Compiler warnings |
| `npm run typecheck` | exit 0 |
| `npm run test:unit` | 344 passed (new: `file-sniff`, `file-name`, `file-upload`, `file-stored`, Day 4d parity, messages with `Files`) |
| E2E local, Chromium, `files.spec.ts` | **7 passed, 3 skipped** (the storage-api cases: CI only) |
| E2E local, Chromium, regression | `lead-page`, `day4-security`, `leads`, `import`, `shell`: **72 passed**; `screens.spec.ts --grep "lead page"`: 2 passed (the lead page shots and the route skeleton at 1024/1280 with the sixth tab) |
| Screenshots (`files-screens.spec.ts`) | 42 shots in `screens/`: the list at 390, 768, 1024, 1280, 1440, 1728 × light/dark × EN/FR (24), plus empty, refused uploads, delete confirmation (390, 1440, EN light / FR dark), menu (1440), unavailable page; no console error, no sideways scroll |
| `/security-review` (`security-review.md`) | done by hand on this worktree's diff (the command reads the session's other checkout): no high-confidence findings; run again in verifier round 1 (see above) |
| Apple design audit / Web Interface Guidelines | `apple-design-audit.md`, `web-design-guidelines.md`: findings fixed (focus ring on the heading, one control for the file input, one accessible name per file, no-break spaces, refusal next steps, the tab strip scroll, byte sizes); unresolved: none |
| gitleaks (`origin/main..HEAD`) | no leaks found, exit 0 (re-run after the docs commit: see the final line of `docs/log.md`) |
| `npm audit --omit=dev` | found 0 vulnerabilities |
| WebKit e2e, Semgrep, storage-api e2e and spikes | CI only (not installed / blocked / no Docker here) |

## Docs used (Context7 and installed typings)

- Supabase (`/supabase/supabase`): `createSignedUrl` with `download`, `download` with a custom name, the REST upload
  endpoint (`POST /storage/v1/object/{bucket}/{path}` with `Authorization`, `apikey`, `Content-Type`), storage RLS with
  `storage.foldername`, and the troubleshooting page "403 new row violates row-level security policy on upload" (an
  upload runs INSERT ... RETURNING, so a SELECT policy must cover the new object: ours does, for the uploader's own
  pending row).
- Installed `@supabase/storage-js` (via supabase-js 2.117.3) typings: `createSignedUrl(path, expiresIn, { download })`,
  `remove(paths)` (needs delete and select), `encodeStoragePath`.
- Next.js 16.2 (`/vercel/next.js/v16.2.9`): route handlers with `params` promises, `NextResponse.redirect` (status and
  headers), `notFound` in route handlers.
- MDN (known): `XMLHttpRequest.upload.onprogress`, `Sec-Fetch-Site`.
- React (`/reactjs/react.dev`): a hidden `<Activity>` hides its children with `display: none` and cleans up their
  Effects (re-run when shown), used for the drop guard and the "tab shown" flag (verifier round 2 findings 17, 18).
- TanStack Query (`/tanstack/query`): `useInfiniteQuery` `isFetchNextPageError`, `fetchNextPage()` resolving with the
  observer result (`hasNextPage`), for "Show older files" (finding 10).
- next-intl (`/amannn/next-intl`): `createFormatter({ locale, timeZone })` from `use-intl/core` for the date unit test,
  and `format.dateTime` using the configured time zone (finding 12).
- next-intl (`/amannn/next-intl`): `useFormatter().number(value, options)` takes `Intl.NumberFormatOptions`, used with
  `style: "percent"` for the progress bar's `aria-valuetext` ("40%" in English, "40 %" with a narrow no-break space in
  French).
- Radix Primitives (`/websites/radix-ui_primitives`): `Dialog.Content`'s `onCloseAutoFocus` (called when the focus
  would return to the trigger on close; `event.preventDefault()` to place it yourself), for the Delete dialog (verifier
  round 3 finding 1).
- Zod 4 (installed typings): `safeParse(...).error.issues[n].path`, read by `beginUploadHint` (round 3 finding 2).
- Installed `@supabase/storage-js` typings and source: `createSignedUploadUrl` (`POST /object/upload/sign/{bucket}/{path}`,
  answers `{ url }` with a token) and `uploadToSignedUrl` (`PUT` to that URL), for spike S5.

## Deviations from the design

1. Library paths `src/lib/files/{sniff,name,upload}.ts` (design 5.7's folder) plus `stored-bytes.ts` (the testable part
   of the open check), `stored.ts`, `types.ts`, `files-server.ts`.
2. `begin_file_upload` returns `stale: [{id, path}]` instead of `stale_paths` (the clean-up needs the ids; no filter
   on paths through PostgREST). `open_file` also returns `size` (the open check needs it).
3. The hourly limit counts the audit log's file inserts, not the rows still present (deleting a row would reset it).
4. `private.file_quota_bytes()` is a function (tests lower it); `private.object_size_key()`/`object_mime_key()` hold the
   metadata key names (S4; folded into constants, P11).
5. `get_lead` is not extended with `file_count` (design 4.1 "4d adds file_count"): the tab's list carries the files,
   and not redefining `get_lead` avoids a third rebase point with 4c, which also redefines it.
6. A `deleting` file is listed to its uploader and to managers and admins ("Couldn't finish deleting · Retry"), as
   design 5.7 says; 4.3 said "the caller's own deleting rows".
7. `begin_file_delete` on a row already `deleting` returns its path without a new code (a retry; the code was given
   when it moved).
8. The open route answers 403 (not the unavailable page) when `Sec-Fetch-Site` is missing or cross-site: nothing is
   read for such a request.
9. More than 5 files in one drop: the first 5 upload, each extra one is listed with "Up to 5 files at a time".
10. The skeleton (`loading.tsx`) is unchanged: its tab strip block (440 px from tablet width) already matches the
    strip with six tabs; it draws the summary layout, the default tab (a `?tab=files` deep link shows the
    summary-shaped body for the brief load, as `?tab=details` does today).
11. `TabList` (Day 4b's shared tabs) now scrolls its own strip so the selected tab is whole (a deep link to Files at
    390 left it cut; Day 4b had kept the same note for "Détails").
12. E2E fixtures (`seedLeads`, the import specs) delete file rows before deleting leads: since 4d a lead with files
    cannot be deleted (23503), and the specs share one stack.
13. The open route's `Referrer-Policy: no-referrer` is also set in `next.config.ts` for `/api/files/*`: the site-wide
    header from the config overrode the route's own (found by the e2e).
14. Design 5.7's `upload-zone.tsx` is folded into `src/components/files/files-tab.tsx` (the drop zone shares the
    tab's upload state; a separate file would only pass that state through).
15. A long name is cut at the end of its stem, the extension kept (`cleanFileName`), not in the middle.
16. Verifier round 1: `finishUpload` answers `unavailable` (not `type_mismatch`) when the stored bytes cannot be read,
    and leaves the pending row; `failureToUpload` lives in `src/lib/files/upload.ts` (unit-tested).
17. Verifier round 2: the stale-upload clean-up is its own RPC, `take_stale_uploads()`, which `beginUpload` calls (and
    clears) before `begin_file_upload`; `begin_file_upload` returns `{id, path}` only (deviation 2's `stale` moved).
18. Verifier round 2: `files.object_version` (not in the design) binds a ready row to the stored object it was checked
    against; `open_file` joins `storage.objects` and refuses a changed version, size or type, or a missing object.
19. Verifier round 2: `private.lead_has_files(uuid)` is a third DEFINER function (yes/no for a lead of the caller's
    organisation), so import undo sees other people's pending uploads.
20. Verifier round 2 (finding 7): a failed check after upload cancels the pending row from the browser at once (design
    5.7 left it for Cancel or the clean-up); the line offers Try again on the same file, which design 7.6 did not list.
21. Verifier round 2 (findings 14, 15): the status region keeps the last 10 messages as separate nodes (design 7.9:
    "one polite live region"; still one region); upload lines are card-coloured with a border so the muted track
    shows (design 7.6 did not specify the line's surface).
22. Verifier round 2 (finding 16): on phones the whole file line opens the file (the name link stretched over it);
    on desktop only the name is the link, as designed.
23. Verifier round 3 (finding 2): the browser sends the cleaned name (`cleanFileName`), not the raw one; design 5.7 has
    only the server clean it. The server still cleans it again and the database still checks it.

## Rebase onto Day 4c (merge, 12 Oct 2026)

`origin/claude/busy-darwin-xech8m` (959e2b8: `origin/main` + Day 4c + docs, PR #15) merged into `day4d-local` as merge
commit d0d98b0 (no rebase), so the Day 4d PR can open as soon as PR #15 is merged.

### What was re-copied

| Definition | 4d redefines it? | Latest before 4d on the merged tree | Result |
|---|---|---|---|
| `private.lead_import_untouched` | yes (`create or replace`, marked REBASE) | still Day 4a's (`20261011120000_activity_hardening.sql`): 4c's `20261013090000_tasks_queue.sql` does not redefine it; its queue claims are left out of the rule on purpose ("a claim is not work; it goes with the lead", `on delete cascade`) | 4d's copy checked equal to Day 4a's text plus the one `lead_has_files` line (script comparison); REBASE markers replaced by a note saying so |
| `private.audit_row` | no | Day 4c's (hides `call_zone`, `queue_rank`; `has_contact_phone` out of diffs) | stays live; the files hourly limit still counts `files` insert rows it writes |
| `public.get_lead` | no (deviation: Files has its own list call) | Day 4c's (`worked_by`) | stays live |
| `public.log_activity` | no | Day 4c's | stays live |
| `audit_log_action_check` | yes (adds `file_access`) | Day 3a's; 4c does not touch it | unchanged |

Every other object the 4d migration creates is new (files functions, triggers, policies on `public.files` and
`storage.objects`); 4c touches none of them. No mutation anchor moved: all 371 rows (3b 37, 4a 104, 4b 94, 4c 92,
4d 44) find their text exactly once on the merged tree; Day 3b rows 18 to 21 and Day 4a row 10 keep editing the Day 4d
migration, 4c's `REDEFINED_IN_4C` rows keep editing the Day 4c one.

### Conflicts resolved (both sides kept)

| File | Resolution |
|---|---|
| `scripts/db-test.sh`, `.github/workflows/db.yml` | 4c's queue attack and three-session tests, then 4d's files attack and concurrency tests; db.yml's storage-api settings and the Spike S1 step unchanged (not in conflict); header comments merged |
| `scripts/db-perf.sh` | `perf_queue_concurrency.sh` (4c), then `perf_files.sql` (4d); comment merged |
| `scripts/db-mutations.py` | `MIG_4C` and `MIG_4D`; `MUTATIONS_4D` kept beside `MUTATIONS_4C`, `REDEFINED_IN_4C` and its row moves; `SETS` has `day4c` and `day4d`; usage and docstring name both |
| `messages/en.json`, `messages/fr.json` | all keys: 4c's `bad_bucket`, `timezone` and 4d's `file_*` hints, the `Files` namespace before 4c's `Queue`; 1,035 keys each, parity; no key of either side lost or changed (script check) |
| `src/lib/db-errors.ts`, `tests/unit/messages.spec.ts` | union of the hints and of the namespaces |
| `playwright.auth.config.ts` | WebKit `testMatch` union: `shell, leads, import, lead-page, queue, queue-multi, tasks, files` |
| `supabase/tests/import_attack.sql` | tables referencing leads: `activities, contacts, deals, files, private.queue_claims, tasks` |
| `docs/log.md` | all rows, ordered by the time each was written (git blame on each branch) |
| Auto-merged, checked | `src/lib/leads.ts` (4c `worked_by`, 4d `LEAD_TABS` with Files), `tests/auth/helpers.ts` (4c `countryInHours`, `signedInPage`); the lead page files and route had no 4c change |

### Checks after the merge (on d0d98b0)

| Check | Result |
|---|---|
| `db-test.sh` (a copy on port 54371) | all 11 suites pass (rls, import x2, activity x2, outcome x2, queue x2, files x2); advisors 0 ERROR (WARN `set_user_role` accepted; INFO `unindexed_foreign_keys` 4 = exactly 4c's accepted four, `activities_org_id_fkey`, `activity_undo_org_id_fkey`, `queue_claims_org_id_fkey`, `tasks_org_id_fkey`: 4d adds none; `unused_index` 4); exit 0 |
| Mutations touching the re-checked definitions (throwaway worktree, port 54372, removed) | Day 3b 18 to 23 (undo rule and its second look), 28, 29 (audit, now in 4c's copy); Day 4a 10; Day 4c 65, 66 (audit hides `call_zone`/`queue_rank`, contact flag); Day 4d 27, 28, 37, 38 (`audit_file_access`, undo with files, `lead_has_files`): **15 of 15 caught**, 0 not as listed; each set exit 0 |
| `npm run lint` / `npm run typecheck` / `npm run test:unit` | exit 0 (the 2 existing React Compiler warnings) / exit 0 / 378 passed, exit 0 |
| E2E local, Chromium (shared stack idle, restarted for this worktree) | `files.spec.ts` 12 passed, 5 skipped (Storage cases, CI only), `lead-page.spec.ts` 26 passed, `queue.spec.ts` 20 passed, `tasks.spec.ts` 12 passed: **70 passed, 5 skipped, 0 failed**, exit 0. Build with the uncommitted `turbopack.root` line (removed before the commit); the stack left running idle for this worktree |
| gitleaks (`origin/main..HEAD`) | no leaks found (80 commits), exit 0 |

## Merge of main after PR #15 (14 Oct 2026)

PR #15 merged into main as 5f1a966. Between 959e2b8 (merged above) and 61aee60, PR #15 gained CI fixes only:
- the queue follow-up scrolls into view at every width;
- Cancel gives the focus to the card heading;
- the claim release is not sent when a tel:/mailto: link is followed;
- the Chromium CI limit went to 45 minutes;
- two tests were hardened (the timeline menu and the reduced-motion bead).

main merged into `day4d-local` with one conflict, `docs/log.md`: both sides added rows, and all are kept in date order. No migration and no file that Day 4d changes was touched, so the database checks above still hold. Lint, typecheck and 378 unit tests pass after the merge. The full e2e suite runs in CI on the PR.

## PR #16 (14 Oct 2026)

| Head | What happened | Fix and proof |
|---|---|---|
| c7fd6a2 (opened) | `/security-review` on the head: **no findings** (security-review.md) | — |
| c7fd6a2 | **semgrep** blocked: `generic.unicode.security.bidi.contains-bidirectional-characters` in `src/lib/files/name.ts`. The refused bidi and invisible characters were written raw inside the name regex | 8b93817: written as `\u` escapes, also in the migration's two name checks. Same code points (checked over every code point); `files_attack` still refuses a U+202E name; parity test passes |
| c7fd6a2, 8b93817 | **rls** failed in "Files attack test": `duplicate key value violates unique constraint "users_email_partial_key"`, `repg@test.invalid` (files_attack.sql:172). `outcome_attack` (repg) and `queue_attack` (reph) already create those emails, and real Supabase allows one account per email. The local stand-in had no such index, so `db-test.sh` passed. Section 0 (bucket, policies, grants on the real storage schema) had passed before that line, so spike S1's fallback is not needed | The files fixtures use `filesg@` and `filesh@`. `shim.sql` gets Supabase's unique email index, so local runs catch this. Reproduced first: with the index, the old fixture fails on the same line; with the new fixture, all 11 suites pass and the advisors report 0 ERROR |
| (same push) | The advisor could not read job logs or artifacts | Every db.yml test step runs through `scripts/ci-report.sh`, which posts the failing output as an error annotation. Spike S1's rows and spikes S2 to S5 (ci.yml) are also posted as notice annotations, which can be read through the API |

| 3c68b77 | **rls** went further and stopped at files_attack.sql:343: `Direct deletion from storage tables is not allowed. Use the Storage API instead` (`storage.protect_delete`), as the advisor suspected. storage-api refuses direct SQL deletes from its tables unless the session sets `storage.allow_delete_query` (the Storage API sets it for its own deletes). Only tests delete directly: the app and the migration never delete from `storage.objects` in SQL | `files_attack.sql` sets `storage.allow_delete_query` for its own session; row level security still decides every delete made as a user. The spike clean-ups set it too. `storage_shim.sql` copies the trigger (on objects and buckets), so local runs refuse such deletes as CI does. Reproduced first: with the trigger and without the setting, the same error; with the setting, all 11 suites pass and the advisors report 0 ERROR |
| c7fd6a2 | **auth-journey webkit**: `upload_pdf_progress_then_open` threw `Invalid URL` reading the opened tab's address. A test WebKit saves a PDF as a download, so the tab has no address (Chromium shows it). Real Safari shows PDFs | The test checks the tab's navigation request instead: it must go to Storage's signed link (`/storage/v1/object/sign/lead-files/…`) on our Supabase origin. The other checks are unchanged |

| c7fd6a2 | **auth-journey chromium**: (1) the S2 spike's clean-up hit the same storage delete guard (fixed in 86b305c); (2) `phone_390_files`: after a deep link the Files tab ended 1.5 px past the tab strip (376 > 374.5). Reproduced locally on Chrome Headless Shell 156. The strip snaps each tab to its start (`snap-mandatory`), so the old scroll position (tab end + 8 px) was snapped again by the browser to a tab start that cut the tab | `revealTab` in `src/components/ui/tabs.tsx` scrolls the strip to the first tab start from which the tab shows whole, in fractional pixels. The arrow keys use it too, so they never scroll the page. files.spec and lead-page.spec on Chrome 156: 38 passed, plus 5 that need storage-api (CI only) |

| 86b305c | **rls green**: every suite passed on the real storage schema (`files_attack` and `files_concurrency` included), advisors 0 ERROR (WARN `set_user_role` accepted; INFO `unindexed_foreign_keys` 4, `unused_index` 3), SQL lint passed (only the known `list_leads` "maybe unmodified" warnings). **quality, semgrep, scan green.** auth-journey chromium: 147 passed; only `phone_390_files` failed (the tab strip, fixed in 5e73b7e); the 9 storage-api tests after it did not run (files.spec.ts is serial; CI: "1 failed, 9 did not run, 147 passed"; the job's notices are the files-spikes tests). Chromium's first run of them is on the final head. auth-journey webkit: the storage test got past the open check and failed in `ageStepUp` with `refresh_token_already_used` | 5a2e06d: the storage test signs in a session of its own (the shared admin state's refresh token was used by an earlier test) |
| 15fb7a6, 5a2e06d | Every job ended in 1 to 2 seconds without a runner (runner id 0), in all three workflows. That points to GitHub Actions minutes or the spending limit on the account, not the code | Haider checks GitHub billing (see the log). CI for 5e73b7e and 5a2e06d runs once Actions can start jobs again |
| b460abd | **Superseded by a123e31:** the reading in this row is wrong; storage-js encoded the name twice (a product bug in every browser). **rls, quality, semgrep, scan green.** auth-journey webkit: 116 passed, 1 skipped, 1 failed: `name_accents_download` got `Bon_de_commande_n%C2%B07_%E2%80%94_%C3%A9t%C3%A9.docx` as the saved name. The app passes the file's real name unchanged to `createSignedUrl({ download })`. CI runs storage-api v1.79.36 (`supabase services`, CLI 2.120.0), whose `handleDownload` sends `filename=` as an ASCII fallback (here `"Bon de commande n_7 _ _t_.docx"`) and `filename*=UTF-8''` with the RFC 8187 encoding of the name. The saved name matches neither part decoded: it matches the `filename*` value left undecoded (`%20` as `_`), and equally the link's `download=` parameter (`+` as `_`). WebKit's shared parser (WebCore `filenameFromHTTPContentDisposition`, marked "doesn't comply with RFC 6266") reads only `filename=`, so the cause in Playwright's Linux WebKit is **not established**. Safari on Mac and iPhone is expected to read `filename*`; this is **confirmed only by Haider's check below** | The test now checks Storage's `Content-Disposition` header in both engines: it starts `attachment;` and its `filename*=UTF-8''` value is exactly the RFC 8187 encoding of the name. It records the header and the saved name as annotations. In every engine the saved name must end in `.docx`, and in Chromium it must equal the name exactly. **Haider's check before merge**, on the preview, in Safari on the Mac and in Safari on the iPhone: upload a Word file named exactly `Bon de commande n°7 — été.docx`, tap Download, and read the name in the download list (Mac) or the Files app (iPhone). It must read exactly `Bon de commande n°7 — été.docx`. Failure looks like `Bon de commande n_7 _ _t_.docx` (the fallback was used) or codes such as `%C2%B0` (not decoded). PR #16 is not merged until both pass; if either fails, the answer is a product fix (the fallback, a client-side download, is a design change for Haider), not another test change |
| f875fed | **rls, quality, semgrep, scan, Vercel green.** auth-journey webkit: 116 passed, 1 skipped, 1 failed: `name_accents_download` failed the new header check, so Storage's `Content-Disposition` in CI does **not** carry `filename*=UTF-8''` with the RFC 8187 encoding v1.79.36's source predicts (it does start with `attachment;`). The test printed no header (annotations are not in the log). Chromium was cancelled by the next push | The test now prints the header, the link's `download` parameter (never its token) and the saved name in the log, runs the download first, and uses soft checks, so one run shows every check in both engines. The header is the product contract Safari depends on, so if it is not RFC 8187 the answer is a product fix, not a test change |
| a123e31 | **Root cause found (a product bug, every browser).** storage-js 2.117.3 `createSignedUrl(path, s, { download })` writes the name with `URLSearchParams` and then runs `encodeURI` over the whole link, so each `%` it made is encoded again. Storage decodes the query once and gets the text `Bon de commande n%C2%B07 %E2%80%94 %C3%A9t%C3%A9.docx`, then sends that as the name: `filename*` decodes to that text in Chrome and Safari, and the ASCII `filename=` part is that same text, which WebKit saved with spaces as `_` (exactly the name seen on b460abd and f875fed). This replaces the "not established" reading above | `src/lib/files/link.ts` `withDownloadName`: the signed link is made without a name and the `download` parameter is added once with `URL.searchParams` (the signed token does not cover it); `signedLink` uses it after the origin check. Unit `tests/unit/file-link.spec.ts`: six awkward names (accents, em dash, `%`, `+`, `&`, `#`, apostrophes, brackets) decode back exactly (WHATWG parsing; storage-api's own decoding is proven by the e2e header check); the storage-js way is shown not to round-trip (it gives the `%C2%B0` text). Unit suite 382 passed. The e2e keeps the strict header check, `.docx` everywhere and the exact name in Chromium; Haider's Safari check stays |
| 492178e | **All checks green**: rls, quality, semgrep, scan, Vercel, auth-journey webkit (06:22) and auth-journey chromium (06:42; its first complete run of the 9 storage-api tests on this PR, files.spec.ts serial). In both engines `name_accents_download` passed its strict checks: Storage's `Content-Disposition` starts `attachment;` and carries `filename*=UTF-8''Bon%20de%20commande%20n%C2%B07%20%E2%80%94%20%C3%A9t%C3%A9.docx` exactly (boundary-checked); Chromium saved exactly `Bon de commande n°7 — été.docx`; WebKit's saved name ends in `.docx`. The printed `content-disposition=… download-param=… saved=…` lines are not in the log: CI uses Playwright's `github` reporter, which shows test output only for failures (retries 0, `forbidOnly` on, so a green job means every test passed). Spikes in this run as before (S5: bytes still stored after Cancel, residual risk 7) | Haider's Safari check on the preview (Mac and iPhone) still gates the merge |

### Spikes S1 to S5 as CI measured them (86b305c)

| Spike | Result in CI | Reading |
|---|---|---|
| S1 (db.yml) | `storage.buckets` has `allowed_mime_types` and `file_size_limit`; 74 storage migrations had run; bucket `lead-files` public=f, limit=10485760, types=5; `storage.objects` policies `lead_files_delete`, `lead_files_insert`, `lead_files_select` | The project migrations ran after storage-api's own. The bucket and policies come from our migration, so no fallback is needed |
| S2 | `has_aal2` and `has_recent_aal2` inside storage policies: status 200, the probe row was seen | storage-api passes the user's aal claims to the policies, so the bucket policies' aal2 checks work |
| S3 | Range on a signed link: 206, `bytes 0-4/15`, tail read 206 | Range is honoured; the server-side sniff can read just the head and the zip directory |
| S4 | Object metadata keys `cacheControl, contentLength, eTag, httpStatusCode, lastModified, mimetype, size`; helpers read `15 application/pdf`; the insert policy does not see the size (`insert_policy_sees_size` false) | Size and type are checked at finish (the built design), not in the insert policy |
| S5 | A signed upload link made before Cancel still stored bytes (put 200, object stored) | The policy is not checked again at upload time. Accepted residual risk 7: after Cancel the files row is gone, so the stale-upload sweep (`take_stale_uploads`, pending rows only) never sees this object. No user can see or remove it, but it counts toward the 800 MiB team space (`private.org_storage_bytes`) until the Gate 1 sweeper (service key, removes `lead-files` objects with no files row) exists |

CI results on the final head, and spikes S1 to S5 as CI measured them, are recorded below once known.

## Rebase points (resolved by the merge above)

- `private.lead_import_untouched` (redefined here with `files`): "-- REBASE: re-copy after 4c merges". 4c adds
  `private.queue_claims` with a lead foreign key and may redefine the rule.
- `supabase/tests/import_attack.sql` `import_fk_coverage` list (now includes `files`; 4c adds `queue_claims`).
- `scripts/db-mutations.py`: Day 3b rows 18 to 21 and Day 4a row 10 now edit the Day 4d migration (the live
  definition); if 4c redefines the rule later, they move again.
- `scripts/db-test.sh`, `.github/workflows/db.yml`, `scripts/db-perf.sh`, `messages/*.json`, `src/lib/leads.ts`
  (`LEAD_TABS`), `src/components/lead/lead-page.tsx`, `src/app/(app)/leads/[id]/page.tsx`, `docs/log.md`: additive
  edits that will conflict textually with 4c and should keep both sides.

## Not done here

- Storage-dependent e2e (real upload, open with the check, dead links, `deleted_file_url_404` with a real delete, the
  rep refused a real stored file, accented download) and the spike recordings S2 to S5: CI only (`E2E_STORAGE=1`), logged waiver (design 8.5).
- WebKit (`files.spec.ts` is in its `testMatch`) and Semgrep: CI only.
- Read-only MCP pre-check of dev (0 file rows) and `config push` of the S3 change: not available in this workflow
  (no MCP, no remote database); the migration refuses to run on a database with file rows, and Haider checks Storage >
  S3 Connection after deploy.
- `/security-review` on the PR head, advisor loop, PR, merge: after this workflow.

## Open risks

- **Signed upsert overwrite (verifier round 2 finding 1)**: an overwrite through a signed upload link still lands in
  Storage (no policy sees it); the file then answers "unavailable" to everyone, with no audit row and no sign in the
  list. A narrow race remains: an overwrite between `open_file`'s check and the browser fetching the 60-second link is
  served. Only the uploader can make such a link, only within 15 minutes of starting, and it lasts 2 hours.
- **Storage-dependent paths are unproven until CI runs them**: the real upload (XHR to storage-api with the user's token),
  the check on open against real signed links, link expiry, real deletes, and the spike recordings. Built so each spike's
  fallback holds either way; the spike tests fail only where the code would break.
- **Direct inserts into the real `storage.objects`** (as `authenticated`, in `files_attack.sql` in CI): storage-api
  does the same insert as that role, so the grants exist; newer storage versions add triggers (prefixes) on that table,
  which `files_attack.sql` will exercise for the first time in CI.
- **Storage migrations before ours in CI (S1)**: what happens depends on what the database image holds when our
  migration runs. (a) No storage tables at all: the bucket and policies are skipped with a `NOTICE` and
  `files_attack.sql` fails visibly. (b) Storage fully migrated (Supabase itself, and CI if the CLI waits for
  storage-api): everything is created. (c) Unverified, and the likeliest early-start case: the Postgres image's own
  init already creates `storage.buckets` and `storage.objects` in an older shape, without `file_size_limit` and
  `allowed_mime_types` (storage-api's migrations add them). Then `to_regclass` passes, the bucket insert at
  `20261014090000_lead_files.sql:288` raises "column does not exist", and `supabase start` fails outright in both CI
  jobs (loud, not silent). The fallback for (a) and (c) is the same: the bucket in `config.toml` and the policies in a
  later migration. The `db.yml` step "Spike S1" records the bucket columns the migrations met.
- **The hourly upload count reads the audit log** by organisation and time; after a 30,000-lead import in the same hour
  it scans that hour's audit rows (1.1 ms after the 30k seed). A partial index on file inserts is the fix if needed.
- **`config push` of `[storage.s3_protocol] enabled = false`** to dev is not verified here (no remote access); Haider
  checks Storage > S3 Connection after the deploy.
- **Next.js local build**: this worktree's `node_modules` is a symlink to a sibling worktree, which Turbopack refuses; the
  local builds used an uncommitted `turbopack.root` line in `next.config.ts` (removed before every commit). CI builds
  from a real `npm ci`.
- **Rebase onto 4c**: done by merge (d0d98b0); if PR #15 changes before it merges, merge its branch again.
