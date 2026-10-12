# Day 4d: files on a lead, 12 Oct 2026

Design: `docs/evidence/day4/design.md` (sections 1, 2 with D1 to D17 and the spikes in 2.4, 3.4, 4.3, 5.7, 6 rows 17 to
28 for files, 7.6, 8, 10 "4d Files" items 3 to 7, 11 with Haider's answer to question 6). Local branch `day4d-local`,
cut from `main` at a7aa89e (Day 4a and 4b merged). Day 4c is built elsewhere and not merged: nothing here depends on its
files; the places that redefine a merged definition are listed under "Rebase points". Not pushed; no PR yet.

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
  (`object_mismatch`); ready to deleting needs a code from the last 10 minutes (`step_up`); nothing moves back.
  `file_guard_delete` (INVOKER): only a `deleting` row whose bytes are gone.
- Policies (D11, as today): the uploader sees their files in every state; once ready, the lead's owner, managers and
  admins too; anyone in the organisation may add to any lead; update and delete for the uploader, lead owner, managers
  and admins (the guards hold the moves).
- Bucket `lead-files` (private, 10 MiB, the five types) and three Storage policies (read, add, remove; no update), each
  checking the organisation's folder and the matching file row (read under the caller's own RLS). Created only when the
  storage schema exists (spike S1); `files_attack.sql` fails loudly otherwise.
- `audit_log.action` gains `file_access` (`private.audit_file_access`, private, ready files of the caller's
  organisation only); the import "untouched" rule keeps leads with a file; `config.toml`: S3 protocol off.
- RPCs (SECURITY INVOKER, static SQL, revoked from anon): `begin_file_upload` (cleans up the caller's uploads left
  pending over 15 minutes and hands back their ids and paths), `get_pending_upload`, `finish_file_upload`,
  `abort_file_upload`, `list_lead_files` (keyset), `open_file` (writes the audit row), `begin_file_delete`,
  `finish_file_delete`, `file_usage` (managers and admins).
- Local runners: `supabase/tests/storage_shim.sql` (the storage tables with RLS on, Supabase's grants, the unique
  `(bucket_id, name)` index, `storage.foldername`), included by `shim.sql` and applied by `scripts/local-auth/start.sh`.

**Tests** — `supabase/tests/files_attack.sql` (threats 1, 2, 7, 8, 20 to 25, 30, 31) and `files_concurrency.sh`
(`quota_race`, `pending_race`), in `scripts/db-test.sh` and `db.yml` (storage-api on); `rls_attack.sql` and
`import_attack.sql` fixtures moved to the new shape; 31 Day 4d mutation rows; P11 in `supabase/tests/perf_files.sql`.

**App**

- Libraries: `src/lib/files/sniff.ts` (PDF, PNG, JPEG signatures; Word and Excel from the zip's central directory, at
  most 10,000 entries, `vbaProject.bin` refused, nothing decompressed, never throws), `name.ts` (`cleanFileName`: NFC,
  unsafe characters removed, the type's extension forced, 180 characters), `upload.ts` (checks before any byte is sent;
  XHR upload with real progress, the person's own token, no upsert), `stored-bytes.ts` (reads the stored bytes back for
  the sniff, with or without Range: spike S3), `stored.ts` (server-only: signed links pinned to our Supabase origin),
  `types.ts`, `files-server.ts`.
- Actions `src/app/(app)/leads/[id]/file-actions.ts`: `beginUpload`, `finishUpload` (the bytes sniffed; a mismatch is
  removed and answers `type_mismatch`), `abortUpload`, `deleteFile` (step-up; when the bytes cannot be removed the row
  stays `deleting`).
- Routes: `GET /api/files/[id]?disposition=` (Sec-Fetch-Site, `open_file`, **the check on every open**, a 60-second
  link, 303 with `no-store` and `no-referrer`, else 303 to `/files/unavailable`), `GET /api/leads/[id]/files`;
  page `/files/unavailable` with its `loading.tsx`.
- **The Files tab is shown now** (between Stock and Details; D16's hidden state ends): drop zone with a real button
  ("Add file" on phones; `accept` lists the types, so iPhone Safari gives JPEG), uploads with a real progress bar and
  Cancel, then "Checking the file…", per-file reasons (too big, empty, type, "isn't really a PDF" per kind, space full,
  too many uploads, connection lost, more than 5 at once), the list (type tile, name keeping its extension, size in DM
  Mono, who, when; Open for PDF and images, Download, Delete with confirmation and a fresh code), "Couldn't finish
  deleting · Retry", the team's space for managers and admins, loading, empty and error states. The first page comes
  with the lead page; hovering the tab prefetches.
- Messages EN and FR (`Files`, `LeadPage.tabs.files`, `Errors.hint.file_*`), French typography checked.

## Spikes S1 to S4 (design 2.4): decided by fallback, proved in CI on the PR

No Docker here, so no storage-api: each spike's safe fallback is built, and CI records the real behaviour.

| Spike | Question | Built here (safe either way) | Recorded in CI |
|---|---|---|---|
| S1 | Storage schema without storage-api; migration order | storage-api enabled in `db.yml` and `auth-journey`; every `storage.*` reference in plpgsql; bucket and policies created behind `to_regclass`; `files_attack.sql` fails if they are missing | `db.yml` step "Spike S1" writes the bucket columns, storage's migration count, our bucket row and policies to the job summary |
| S2 | Does storage-api pass `amr` to Storage policies? | Step-up for delete enforced in `file_guard_update` and `begin_file_delete` (database); Storage policies use only `has_aal2` and the `deleting` row | `tests/auth/files-spikes.spec.ts` S2 (probe buckets readable with `has_aal2` / `has_recent_aal2`); e2e `delete_needs_fresh_code` |
| S3 | Do signed links honour Range? | `stored-bytes.ts` reads 206 ranges or a 200 whole body the same way (unit-tested both ways) | files-spikes S3 (status and bytes of a ranged request) |
| S4 | Metadata key names; written before the insert check? | Key names only in `private.object_size_key()`/`object_mime_key()`; the ready check runs at finish | files-spikes S4 (keys, the helpers' reading, a probe bucket whose insert policy needs `metadata ? 'size'`) |

Results land in the CI artifact `storage-spikes` (`test-results/spikes/day4d.json`) and the S1 job summary. The spike
tests fail only where the built code would break (S2: `has_aal2` must work in Storage policies, or no upload could;
S4: the helpers must read the real keys).

## Check results

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
| `/security-review` (`security-review.md`) | done by hand on this worktree's diff (the command reads the session's other checkout): no high-confidence findings; to run again on the PR head |
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

## Rebase points (4c not merged)

- `private.lead_import_untouched` (redefined here with `files`): "-- REBASE: re-copy after 4c merges". 4c adds
  `private.queue_claims` with a lead foreign key and may redefine the rule.
- `supabase/tests/import_attack.sql` `import_fk_coverage` list (now includes `files`; 4c adds `queue_claims`).
- `scripts/db-mutations.py`: Day 3b rows 18 to 21 and Day 4a row 10 now edit the Day 4d migration (the live
  definition); if 4c redefines the rule later, they move again.
- `scripts/db-test.sh`, `.github/workflows/db.yml`, `scripts/db-perf.sh`, `messages/*.json`, `src/lib/leads.ts`
  (`LEAD_TABS`), `src/components/lead/lead-page.tsx`, `src/app/(app)/leads/[id]/page.tsx`, `docs/log.md`: additive
  edits that will conflict textually with 4c and should keep both sides.

## Not done here

- Storage-dependent e2e (real upload, open with the check, dead links, real delete, accented download) and the spike
  recordings: CI only (`E2E_STORAGE=1`), logged waiver (design 8.5).
- WebKit (`files.spec.ts` is in its `testMatch`) and Semgrep: CI only.
- Read-only MCP pre-check of dev (0 file rows) and `config push` of the S3 change: not available in this workflow
  (no MCP, no remote database); the migration refuses to run on a database with file rows, and Haider checks Storage >
  S3 Connection after deploy.
- Advisor loop, PR, merge: after this workflow.

## Open risks

- **Storage-dependent paths are unproven until CI runs them**: the real upload (XHR to storage-api with the user's token),
  the check on open against real signed links, link expiry, real deletes, and the spike recordings. Built so each spike's
  fallback holds either way; the spike tests fail only where the code would break.
- **Direct inserts into the real `storage.objects`** (as `authenticated`, in `files_attack.sql` in CI): storage-api
  does the same insert as that role, so the grants exist; newer storage versions add triggers (prefixes) on that table,
  which `files_attack.sql` will exercise for the first time in CI.
- **Storage migrations before ours in CI (S1)**: if the CLI applied our migration before storage-api's own, the bucket and
  policies would be missing (`NOTICE` in the migration) and `files_attack.sql` fails visibly; the fallback then is the
  bucket in `config.toml` and the policies in a later migration.
- **The hourly upload count reads the audit log** by organisation and time; after a 30,000-lead import in the same hour
  it scans that hour's audit rows (1.1 ms after the 30k seed). A partial index on file inserts is the fix if needed.
- **`config push` of `[storage.s3_protocol] enabled = false`** to dev is not verified here (no remote access); Haider
  checks Storage > S3 Connection after the deploy.
- **Next.js local build**: this worktree's `node_modules` is a symlink to a sibling worktree, which Turbopack refuses; the
  local builds used an uncommitted `turbopack.root` line in `next.config.ts` (removed before every commit). CI builds
  from a real `npm ci`.
- **Rebase onto 4c** (see "Rebase points").
