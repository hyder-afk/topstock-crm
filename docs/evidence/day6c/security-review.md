# Day 6c security review (12 Oct 2026)

Scope: every 6c commit (6eb0b56 to a1b011d): `supabase/migrations/20261018090000_stock_import.sql`, its attack and
concurrency tests, `scripts/db-mutations.py`, `src/lib/stock-import/**`, `src/lib/stock-import-server.ts`,
`src/app/(app)/inventory/import/**`, `src/app/api/stock-imports/**`, `src/components/stock-import/**`, the fake-sheet
generator and fixtures, messages. Method: the `/security-review` checklist (CLAUDE.md SECURITY, Master Plan 8 A to F)
read against the diff, and the design's threat rows for the import (9: S7, S8, A2, A3).

## Result

No high-confidence vulnerability.

## What was checked

| Area | Finding |
|---|---|
| Row level security | Both new tables are in `private` (no REST endpoint), RLS on, restrictive `require_mfa`, every grant revoked then column grants only. Staged rows (they hold costs) need an admin of the organisation with a code from the last 10 minutes even to read; inserts only into the caller's own staged stock batch, within its row range. `stock_import_changes` is admin-only to read |
| Who may do what | Start, stage, check and commit: the uploader admin with a fresh code (guard, policies and RPCs); undo and discard: any admin with a fresh code; the lock helper (definer) checks the organisation, the fresh code and the uploader (mutation 25 now caught); lead RPCs given a stock batch are refused (marker and kind checks) |
| Definer code | `private.lock_stock_import` only: owner postgres, `search_path = ''`, static SQL, revoked from public and anon, checks the caller itself before locking; locks only products named in the batch |
| Input | The file never leaves the browser; staged rows are Zod `strictObject` with exact decimal patterns, then pre-checked as text in SQL with one constant error ("invalid rows"); problem and warning codes are closed lists (parity test); names are cleaned (control, zero-width and bidi characters removed) and stored as text; formula-like names are kept as text and the problems file is formula-guarded (`csvCell`, e2e checks `'-5`) |
| Errors and logs | Constant messages; `stockImportError()` maps codes; routes answer `{error: code}` with no database text; the audit and the staged rows never carry REVENTE or the file; product names do not reach error messages |
| Stock rules | Every quantity change goes through the engine (import rows with compare-and-set under the level lock; transfers move holds); a target under what is held is skipped; a product moved in the CRM is kept unless the admin chooses the sheet's numbers; integrity is clean after the concurrency cases and after a 5,000-row import and undo |
| Denial of service | 5,000 data rows and 15 MB per file; 1,000 rows and 750 KB per stage call; 3 open stock imports per organisation; 125 products per commit or undo call under `lock_timeout = 3s` |
| Output | No `dangerouslySetInnerHTML`; names render as text (`translate="no"`); the e2e imports `<img src=x onerror=alert(1)>` and `=HYPERLINK(...)` as plain names |
| Keys and data | No secret in the diff (gitleaks: no leaks); fixtures are invented (only Haider's header row is real) |

## Residual risks

1. An admin can import a sheet that sets every quantity (by design: the sheet is the source of truth until the CRM
   moves stock); the Check screen and Undo are the safety net.
2. The whole 5,000-row import runs a little over 30 s on this runner (README open risk 1).
