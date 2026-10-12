# Day 4d security review: files on a lead

Scope: `origin/main..day4d-local` (the Day 4d migration, storage stand-in, attack and concurrency tests, the file
libraries, actions and routes, the Files tab, the CI changes). Design section 6, rows 1, 2, 7, 8, 20 to 28, 30, 31;
the residual risks in design section 6 (items 1, 2, 5 and 7 concern files).

## `/security-review`, verifier round 1 (head e38d97a, 12 Oct 2026)

The command was invoked in this session (Skill `security-review`, asked for this worktree's branch). Its automatic
context again came from the session's primary checkout (`/home/user/topstock-crm`, branch `claude/busy-darwin-xech8m`,
6 documentation files), not from this worktree. Its prompt (categories, hard exclusions, precedents, the ">80%
confident" bar, confidence 8 or more to report) was therefore applied to `git diff origin/main...HEAD` of
`/home/user/topstock-crm-4d` on e38d97a: 52 non-doc files, the migration, actions, routes, libraries, Files tab, CI and
config. This session has no sub-task tool, so the false-positive filter step ran inline on each candidate.

Candidates considered and dropped (all below confidence 8):

- `finishUpload` now keeps an unchecked pending row when its bytes cannot be read (verifier finding 1). Not exploitable:
  a pending object is readable only by its uploader (`lead_files_select` follows `files_select`), it never becomes
  ready without `finish_file_upload`, and every open sniffs the bytes again. The uploader could already store any bytes
  by calling Storage directly (accepted residual risk 5).
- Signed upload links (`createSignedUploadUrl`) may outlive the 15-minute pending check (verifier finding 8): needs an
  aal2 insider, gives only stray bytes in the caller's own organisation's folder, counted against the team space.
  Accepted residual risk 7; spike S5 records it in CI.
- `private.audit_file_access` is DEFINER and granted to `authenticated`: private schema, no API endpoint; writes only
  for a ready file of the caller's organisation (accepted residual risk 3 and 5 of the design).
- Inline PDF and images open on the Supabase Storage origin, never the app's; types are limited by the bucket and
  sniffed on every open.
- The download name in the signed link comes from `files.name`, which cannot hold control characters, quotes, slashes
  or bidi characters (CHECK and pre-check); storage-api encodes it.
- The spikes and e2e specs interpolate values into SQL: test-only files with values the tests made (hard exclusion 11).

**Result: no vulnerability at confidence 8 or more.** Final report of the command, verbatim:

> No high-confidence security vulnerabilities were found in the changes on `day4d-local` against `origin/main`
> (head e38d97a).

The command still has to run on the PR head once the PR exists, where its automatic diff is this branch.

## `/security-review` (first round)

The `/security-review` command in this session reads the session's primary checkout (`/home/user/topstock-crm`, another
branch), not this worktree, so its automatic diff was not this work. The same review (its categories, exclusions and
the ">80% confident of a real exploit" bar) was therefore done by hand on this worktree's diff against `origin/main`,
file by file, tracing every value that comes from a browser. **Result: no high-confidence findings.** It must be run
again on the PR head once the PR exists (CI and the advisor loop), where the command sees the right diff.

What was traced, and why each holds:

| Path | Input from the browser | Why it is safe |
|---|---|---|
| `beginUpload` -> `begin_file_upload` | lead id, name, type, size | Zod strictObject (uuid, enum of five types, 1 to 10 MiB); the name cleaned (`cleanFileName`); the database re-checks all four with constant errors; the stored path is built in `file_guard_insert` from the organisation, lead and new row ids and the type's extension, never from the name (no traversal, no overwrite); RLS `files_insert` needs a lead of the caller's organisation |
| Browser upload to Storage | the bytes, the `content-type` header | The person's own token; the bucket's insert policy allows only the caller's own pending path under 15 minutes in their organisation's folder (two independent checks); no update policy (no upsert, overwrite or move); `x-upsert: false`; bucket limit 10 MiB and the five types |
| `finishUpload` | file id | uuid; `get_pending_upload` is uploader-only; the stored bytes are read back through a signed link whose origin must equal the configured Supabase origin (no SSRF), with `redirect: "error"` and a 3 s limit, and sniffed; the database then requires the stored object's real size and type to equal the declared ones (`object_mismatch`) |
| `GET /api/files/[id]` | id, `disposition` | `Sec-Fetch-Site` must be `same-origin` or `none` (403 otherwise: no cross-site opens); two-factor session; Zod strictObject on the query; `open_file` under RLS, ready files only; the bytes are sniffed again on every open, so HTML stored as "PDF" by a direct API call is refused; inline only for PDF, PNG and JPEG, Word and Excel always download; the 60 s link travels only in the 303 `Location`, with `Cache-Control: private, no-store` and `Referrer-Policy: no-referrer`; any failure is one answer (`/files/unavailable`) |
| `deleteFile` | file id | uuid; `begin_file_delete` needs a code from the last 10 minutes for a ready file (checked in the function and, independently, in `file_guard_update`: spike S2's fallback); Storage removal runs with the person's token under the `deleting`-only delete policy; the row goes only once its bytes are gone (`file_guard_delete`) |
| `GET /api/leads/[id]/files` | id, cursor | Zod (uuid, ISO instant, both cursor parts or none); `list_lead_files` is SECURITY INVOKER with static SQL and bounded limits |
| Files tab | file names from the database | React text only (no `dangerouslySetInnerHTML`, no auto-linking), `translate="no"`, `title` attribute; links are the app's own `/api/files/<id>` route; PDF/images open with `rel="noopener noreferrer"` |

Database privileges: the RPCs are SECURITY INVOKER with `search_path = ''` and static SQL; the only definers are the
insert guard (trigger-only, revoked: it needs the team's usage and returns nothing about it, and skips its checks for a
session the policies refuse anyway) and `private.audit_file_access` (private schema, no API endpoint; writes only for a
ready file of the caller's organisation in a two-factor session). Column grants: insert `(company_id, name, mime, size)`,
update `(status)`. Sessions with no signed-in user keep given values (fixtures, maintenance), as every Day 3 and 4 guard
does; an API request always carries a signed JWT with a subject.

## Threat rows re-checked, with their tests

| # | Threat | Tests |
|---|---|---|
| 1 | Stolen aal1 session | `files_attack` 1 (every RPC 42501, 0 rows, no object read or written); restrictive `require_mfa` kept on `files`; every storage policy has `has_aal2` (structural check) |
| 2 | Another organisation | `files_attack` 7 (`other_org_file_row_invisible`, `other_org_object_select_zero`, `other_org_object_insert_denied`), the folder fence on its own (a forged row of the other org naming this org's folder still cannot store bytes) |
| 7 | Forged server columns | `files_attack` 3 (column grants; the insert guard alone overrides id, path, status, uploader, times; the update guard alone refuses every column but the status) |
| 8 | Delete without a fresh code | `files_attack` 9 (`file_delete_stale_code_denied` through the function, a direct update and the guard alone); e2e `delete_needs_fresh_code` |
| 20 | Public or listable bucket | `bucket_private`, `lead_files_only_bucket`, `storage_policies_exact`, `object_update_denied`; S3 protocol off (`config.toml`, parity unit test) |
| 21 | Arbitrary path or overwrite | `object_insert_other_path_denied` (6 variants), `object_insert_after_15min_denied`, `object_overwrite_denied` (23505) |
| 22 | Signed link leakage | e2e `file_link_has_no_token_in_dom`, `cross_site_file_request_refused`, headers on the 303 (local); `signed_url_dead_after_60s`, `deleted_file_url_404` (CI) |
| 23 | Type spoofing | unit `sniff_*` (exe, HTML, SVG, docm/xlsm, truncated zip, `%PDF` polyglot, lying directories), `file-stored.spec.ts` (the open check with and without Range); SQL `finish_size_mismatch_refused`; e2e `renamed_exe_rejected`, `docm_renamed_docx_rejected` (local), `direct_api_html_as_pdf_refused_at_open` (CI) |
| 24 | Path or name injection | `file_name_invisible_refused` (17 code points, 181 characters, empty, `../`), unit `cleanFileName`; the path never uses the name |
| 25 | Quota and rate abuse | `files_concurrency.sh` `quota_race`, `pending_race`; `declared_1_byte_counted_at_real_size`, `sixth_pending_refused`, `thirty_first_upload_refused` (counted from the audit log, so deleting does not reset it); e2e `quota_message` |
| 26 | XSS through names | e2e `files_list` (`<img onerror>` name shown as text, no dialog) |
| 27 | SQL or filter injection | static SQL; no user text in any filter string (the stale clean-up uses ids the database returns) |
| 28 | CSRF | server actions' Origin check; the open route's `Sec-Fetch-Site` |
| 30 | Audit | `audit_file_access_row`; no other org or aal1 session can write one |
| 31 | Lost or orphaned bytes | `lead_with_files_delete_refused_23503`, `import_undo_keeps_lead_with_file`, `import_fk_coverage` (updated) |

## Residual risks (accepted, as in the design)

1. A signed link works for whoever holds it, for 60 seconds. It is never in the page, the query cache or the logs.
2. No antivirus on the free plan. PDFs open in the browser's sandboxed viewer, Word and Excel download; macros are
   refused at upload and on every open.
3. A user can add `file_access` rows about their own opens of files they can see (noise, not forgery).
4. An abandoned upload's object stays until its owner's next upload (`begin_file_upload` hands back its id and path for
   clean-up) or the Gate 1 sweeper; it is counted in the team space.
5. Storage writes `metadata.mimetype` from the uploader's `content-type` header, so the database's finish check proves
   the size and the declared type, not the content: the content is proved by the server's sniff at finish and on every
   open (a direct API caller who skips `finishUpload` can only make a file that will not open).
6. The delete guard checks "bytes gone" as the caller; a person who could not see the object would see "gone". Every
   person allowed to delete a row also sees its object (the bucket's select policy follows the file rows), so this
   needs a policy change to matter; a stray object would then wait for the Gate 1 sweeper.
