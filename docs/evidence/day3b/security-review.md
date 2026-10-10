# Security review: Day 3b lead import, 10 Oct 2026

Scope: everything from the Day 3a merge (fa86aef) to this PR's head: the migration
`supabase/migrations/20261010150000_lead_import.sql`, the server actions and route handler, the step-up flow, the browser
rules library, the import screens, the local test gateway and the tests. Checked against CLAUDE.md SECURITY and Master
Plan section 8 (A to F).

How: a review workflow ran five independent reviewers (security, app logic, database, design and accessibility, copy);
a skeptic then tried to refute every finding; confirmed findings were fixed by builders in isolated copies of the code
and each fix was re-checked by another skeptic. Earlier rounds did the same for the rules library and the gateway.

## What was checked (security reviewer)

| Area | Result |
|---|---|
| Server actions (`src/app/(app)/leads/import/actions.ts`, `step-up-actions.ts`) | Zod `strictObject` on every input, explicit RPC argument lists (no mass assignment), a session before every call, errors mapped to codes only |
| Route `GET /api/imports/[id]/issues` | Session at aal2, Zod, RPC only, codes-only errors, `Cache-Control: private, no-store` |
| Step-up | The dialog is convenience only: every write function re-checks `has_recent_aal2(600)` in the database, so a browser that skips the dialog gets `step_up`. Verified claims only (totp in `amr`), same rule as the database |
| Error text | `src/lib/import-server.ts` never forwards a database message, detail or hint to the screen |
| Migration | RLS and `require_mfa` on the staging table; policies check organisation + admin + fresh code; column grants on `import_batches`, staging and `companies`; restrictive `companies_import_columns`; guard trigger owns every status change; minimal audit rows; static SQL with every value as a parameter; functions revoked from `public` and `anon` |
| Throwaway database run | All migrations, `rls_attack.sql` and `import_attack.sql` pass; no function executable by `anon` or `PUBLIC`; only pre-existing SECURITY DEFINER functions plus `audit_row` |
| Bad input to the row function | Bad row numbers, problem codes, uuids and dates all raise the same constant `22023 invalid rows`, with no value in the error (nothing from a file reaches the database log) |
| Cross-organisation | `import_batches` policy pins the organisation; history, issues, preview and undo all run under RLS; an owner must be a visible profile |
| aal1 and stale sessions | `require_mfa` on `import_batches`, staging and `companies`; server actions redirect any session below aal2 |
| CSV formula injection | `csvCell` guards every cell of the problems file (= + - @ tab CR, full-width forms, leading spaces and NBSP) and drops NUL; the importer undoes exactly that guard (round-trip tested on the whole sample and 3,000 random rows) |
| XSS | No `dangerouslySetInnerHTML`, `innerHTML` or `eval` in `src`; links use database UUIDs only; the e2e test imports a lead named `<script>alert("x")</script>` and checks it shows as text with no dialog |
| Logging | No `console.*` in import or server code; the lint rule now covers every server file that receives lead rows |
| Secrets | Only fake local test passwords in tests; no keys; `npm audit --omit=dev`: 0 vulnerabilities |

## Confirmed findings and what was done

| Finding | Severity | Fix |
|---|---|---|
| The saved column matching used the header text as its browser-storage key, so a file with no header row stored its first lead | should fix | The key is now a SHA-256 of the header row, worked out when the file is read; older keys holding header text are removed; unit and e2e checks that no header text reaches localStorage |
| Nothing proved the staging table is unreachable through the REST API | should fix | `tests/auth/import-security.spec.ts` (runs in CI on the real Supabase stack) and a deploy step that checks through the Management API that the dev API exposes only `public` |
| A discard or undo done by a direct status update skipped the clean-up, leaving staged lead values in the database | nit | The guard trigger now deletes the working rows on every closing move (discarded, imported, rolling back, rolled back); attack test and mutations |
| An import file name could hold bidi overrides or zero-width characters (the name would look different in other admins' history) | nit | Refused in the server action (Zod, `isCleanString`) and by the database check, as code point ranges that do not depend on the locale; 13 bad names tested |
| The no-console lint rule missed server code that receives lead rows | nit | Extended to the import actions, the API routes and the server libraries |

Refuted by the skeptic: the claim that the e2e helper `ageStepUp` could be pointed at another server through a database
URL query (the helpers only ever run against the local stack; environment values are trusted).

## Other protections proven by tests

- `supabase/tests/import_attack.sql`: anon, aal1, a code older than 10 minutes, aal2 without a code, rep and manager,
  another admin, another organisation, direct API bypasses, limits, constant errors, one writer at a time, a demoted
  uploader, idle expiry, the 1 January 1990 boundary in several time zones, the tagging rule's date bound and uploader
  check, the running total, the clean-up on direct status changes.
- `supabase/tests/import_concurrency.sh`: two sessions: parallel imports add each row once; undo waits for a contact
  being added and keeps that lead; a lead deleted during an undo chunk no longer makes it fail.
- `docs/evidence/day3b/mutations.md`: each protection removed in turn; every removal is caught except one protection
  that has a second layer (removing both is caught).
- `tests/auth/import.spec.ts`: a rep gets a not-found page, sees no import buttons or menu entry, and the issues
  endpoint answers 403.
