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
| Logging | No `console.*` in import or server code; the lint rule covers the import actions, the API routes and the server libraries (there is no `console` call anywhere in `src`) |
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

## Covers the final head (everything after b6416b8)

The review above ran on b6416b8. Every later commit was reviewed again by a security reviewer (and a design reviewer),
with a skeptic per finding:

| Commit | What changed | Security result |
|---|---|---|
| 0b480cd | Layout: the wizard fills the width | Screen only |
| ae4c911 | `no-console` on the server files that handle import data | Lint guard; no `console` call anywhere in `src` |
| 3a8a69f | deploy-dev-db proves the dev REST API exposes only `public` | Runs on a push to main or by hand, never on PR input; `bash -eo pipefail` stops the job on a failed call; the Management API answer goes straight into `jq`, which keeps only `db_schema`; no body is printed; no `set -x` |
| b39ff78 | Import security e2e | Tests only; the helpers refuse non-local URLs |
| 410d244 | Name rule: any phone keeps a row out of the company + city match | Still SECURITY INVOKER, static SQL, `search_path = ''`; no new grants; RLS untouched; the same test in Check and in Import; mutation 36 catches its removal |
| 88fb1e2 | Live counts on Match, late choices used, leftovers discarded, safer review and resume | No new server entry point: the only new call is the existing `discardImport` action (Zod `strictObject`, explicit arguments, session, codes-only errors); the database still checks admin + fresh code and refuses to discard a started, imported or undone import; the remembered matching is still a SHA-256 key holding column targets only |
| eb6e66e | Time zone and country names prepared while the file is read | Caches keyed by language and zone id; they hold names only, never file data |
| b2e292e | Date order example under the menu, 248 px menus | React text through next-intl; nothing rendered as HTML |
| 5f30c4a | US and Canada phone key limit written up (design open question 7), test rows | Tests and docs; a duplicate-matching limit that Check shows before anything is written, not a security boundary |
| 741164f | Final review fixes (headers, live counts, date example, measure, French "1er") | Screen and accessibility; plus: a check opened again from Past imports is no longer discarded at the next Check |
| 3714b74 | The step heading takes focus after the new step is drawn | Screen only: CI on 5f30c4a failed once on Chromium and WebKit because the heading was focused on the next frame, which a busy main thread can run before the new step is drawn; reproduced at 4x and 8x CPU (focus on the page in 5 of 12 tries), 18 of 18 after the fix |

Findings: one confirmed nit (the leftover discard above), fixed in 741164f. One refuted: the `no-console` rule does not
list every server file (there is no `console` call anywhere in `src`; the row above now says what it covers).

Checks on the final head: lint (0 errors), typecheck, unit tests (166), the database suite (`rls_attack`,
`import_attack` with the new phone rows, `import_concurrency`, advisors with no ERROR), import e2e 14 of 14 on Chromium
(WebKit runs in CI), the import screenshots (112, no console error, no sideways scroll), Semgrep with the CI rule sets
(CI `semgrep` job green on e177c42; correction of 11 Oct: the local run could not reach semgrep.dev, which this session's
network policy blocks, and a pipe hid that failure, so no local Semgrep result exists), gitleaks on the branch history (no leak), `npm audit --omit=dev` (0). Development tooling only: a new
advisory for `braces` (GHSA-vfj7-8cjw-p6xm, every version, pulled in by the Next.js ESLint config) affects the lint
step, never the app; no fixed version exists yet, and CI reports development advisories without failing.
