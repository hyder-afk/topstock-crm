# Security review: Day 6a stock engine (database only), 11 Oct 2026

Scope: branch `day6a-local`, `git diff origin/main..HEAD`. The code change is one migration,
`supabase/migrations/20261016090000_stock_engine.sql`. The rest is tests (`stock_attack.sql`, `stock_concurrency.sh`,
`perf_stock.sql`, one line of `import_attack.sql`), test scripts (`db-test.sh`, `db-perf.sh`, `db-mutations.py`), the db
workflow and documents. There is no app (`src/`) change: nothing in the app calls the new RPCs yet (6b does). Checked
against CLAUDE.md SECURITY, Master Plan section 8 (A to F) and the Day 6 design's threat table
(`docs/evidence/day6/design.md` section 9, rows S1 to S12, A1 to A3).

## How

1. **`/security-review`** (the skill), run in this session. Its git context pointed at the main checkout, so the
   review was done by hand on the 6a diff with the skill's method and filters: the repository's security model first
   (Day 1 to 4a helpers, the revoke/grant loop, invoker RPCs, guards before CHECKs), then every path a client has
   (PostgREST exposes `public` only; `private` has no REST endpoint), for each kind of caller: anon, aal1, aal2 with a
   stale or fresh code, rep, manager, admin, the same organisation or another, and the session-less maintenance role.
   The skill's sub-tasks could not be started from this subagent, so the false-positive filter was applied inline.
   **Result: no high-confidence (8/10 or more) vulnerability found.**
2. **Mutations** (`mutations.md`): every protection named below was removed in turn and the tests had to fail.
3. **The full test run** (`bash scripts/db-test.sh`, README check table) on the final code.

## What was checked

| Area | Result |
|---|---|
| Direct writes (S1) | `stock_levels`: select only for `authenticated`, nothing for `anon`; `stock_reservations`, `stock_hold_uses`: select only; ledger: insert of the 16 document columns only, no update or delete grant, and `stock_movement_immutable` refuses update, delete and truncate for every role, the owner included. The levels and holds are written only by `stock_movement_b_apply` (definer, execute revoked) |
| Trusted branch (S12) | `current_user = 'postgres'` only. The definer code that inserts ledger rows (`expire_holds_for`, `release_deal_holds`) is owned by postgres, revoked from clients, and inserts only fixed kinds (`expire`, `release` with `deal_lost` / `deal_deleted`) for holds of one deal or one organisation. `expire_due_holds` and `sweep_expired_holds` are granted to `authenticated` (the invoker RPCs call them) but live in `private` (no REST endpoint) and act only on the caller's organisation and on holds already past their end date |
| Guard bypass | The guard (`a`) and the apply step (`b`) are BEFORE INSERT triggers; PostgreSQL fires same-event triggers in name order, so `a` always runs first. Only a superuser can turn triggers off (`session_replication_role`), which PostgREST never gives |
| Server-set fields (S10) | `org_id` from the product read under the caller's RLS, `user_id`, `created_at`, all engine deltas and snapshots are overwritten by the guard and the apply step whatever the row says. `import_batch_id` and `order_line_id` are refused in 6a. Products: `created_by`, `org_id`, `archived_at` on insert, `import_batch_id` and `number` are not client-settable |
| Roles (S5, S6) | Corrections (receive, adjust, count) need manager or admin plus a code under 10 minutes; Arrived needs manager or admin (RPC and guard); a hold needs the lead's editor; a release needs the hold's creator or the lead's editor; products are created and changed by managers and admins; archive needs a fresh code and no stock; restore is admin with a fresh code; costs are managers and admins only; settings and place names are admin only; the stock check is admin only |
| Other organisation | Every policy has `org_id = current_org_id()`; the guard checks the place and the lead belong to the product's organisation; the deal is read under the deals policy and again under a lock in the apply step. Org C1's admin gets P0002 on every RPC (`other_org_product_not_found`); mutation rows 42, 62, 63 (33 documented: the guard's place check stands behind the places policy) |
| Restrictive two-factor | `require_mfa` on all 9 new tables; every RPC refuses aal1 itself as well (`aal1_every_stock_rpc_denied`) |
| Concurrency (S2, S3, S8) | Rules checked on the locked level; one lock order (deal, product, levels by location id, holds); a deferred check pairs every departure from transit with its arrival. `stock_concurrency.sh` covers the last pieces, two holds, archive versus receipt, lock timeout, both lock-order races and a deal lost during a hold |
| Injection (S11) | Static SQL only; no `format()` or `EXECUTE` with user values (the two `format()` loops run over constant names at migration time); `search_path = ''` on every function, all names schema-qualified |
| Errors and logs (A2) | A constant-message pre-check runs before every CHECK a client can reach (names, categories, notes, quantities, prices, dates, place names, request kinds); unique violations on the product name become `name_taken`. No value of the caller's text is put in a message |
| Audit (A1) | One minimal audit row per ledger row (kind, product, place, changes, reason, references, note length; never the note). Costs and settings audited with diffs; `audit_log` stays admin-only, and admins may read costs anyway |
| Idempotency (S9) | `movement_requests` per author (`user_id` set by its guard; own-rows policy). A person can only write or overwrite their own rows, which can only change what their own retries return |
| Definer functions | All `search_path = ''`, owner postgres, execute revoked from `public`, `anon`, `authenticated` (triggers, `seed_org_inventory`, `expire_holds_for`, `nightly_stock_jobs`), except the two expiry helpers above. `nightly_stock_jobs` refuses any session with a signed-in user. pg_cron is scheduled only if the extension already exists, with a constant command |
| CI and scripts | `db.yml` gains two steps on the existing `pull_request` job (no new permissions, no new action). The scripts are local tooling with no outside input; `db-mutations.py` edits only files in its own checkout |

## Design threat table re-checked for 6a

Rows from design section 9 that 6a delivers. Sales (ship, return, record_sale), imports, tasks and the client link
(P1 to P16, T1, T2, I1 to I4, parts of S6, S7, S10) belong to 6b to 6e. Tests are in `supabase/tests/stock_attack.sql`
(section numbers) and `stock_concurrency.sh` (case numbers); each control also has a mutation row.

| # | Threat | 6a control | Proved by | Mutation rows |
|---|---|---|---|---|
| S1 | Direct stock writes | zero write grants on levels; ledger and holds in `private`; immutable ledger | sections 0, 1 (`stock_levels_direct_write_denied`, `stock_movements_immutable` also as postgres) | 5, 6 |
| S2 | Over-holding the last pieces | rules under `FOR UPDATE` on the level; CHECK backstop | concurrency 1, 2, 3, 10; section 3 | 1, 2, 3, 52 (4 documented) |
| S3 | Deadlocks | one lock order; Arrived locks the product first; a deal hold locks the deal first | concurrency 7, 9, 11 | 12, 26, 27 |
| S4 | Wrong order of events | `version`, `crm_moved`, `last_onhand_batch_id` written under the lock; count worked out under the lock | section 3 (`versions_match_snapshots`), concurrency 8 | 17, 18 |
| S5 | Stolen session adjusts stock | aal2 everywhere; fresh code for corrections, opening stock, archive and restore | sections 1, 5 (`adjust_stale_code_step_up`, `receive_stale_code_step_up`, `archive_stale_code`) | 7, 29, 61 |
| S6 | Rep overreach | role and lead-editor checks in the guard; product, cost, settings and place policies | sections 5, 6 (`rep_cost_null`, `release_rules`) | 8, 35, 43 to 45, 56, 58, 59 |
| S7 | Movement without a document | per-kind document checks; transfer pairing (guard, unique index, deferred check) | section 4 (`transfer_in_without_out_refused`, lone departure refused) | 22 to 25, 34 |
| S8 | Archive racing a receipt | product `FOR SHARE` in the apply step against archive's row lock; re-checked under the lock | concurrency 5 | 16, 32 (31 documented) |
| S9 | Replay or double click | `movement_requests` per author and kind | section 7 (`idempotent_request_id`) | 40, 41 |
| S10 | Mass assignment | column grants; guards set server fields | sections 0, 2 (`movement_server_fields_not_writable`, `product_insert_server_fields`) | 57 |
| S11 | SQL or filter injection | static SQL | review (no dynamic SQL with user values) | |
| S12 | Untrusted caller in the trusted branch | `current_user = 'postgres'` only; a person cannot post `expire` | section 1 (`trusted_branch_only_postgres`) | 15, 60 |
| A1 | Silent edits | append-only ledger with who, why and references; minimal audit row | section 7 (`movement_audit_minimal`) | 20, 21, 55 |
| A2 | Personal data in logs or audit | constant pre-checks; the note never copied to the audit log | section 2 (`check_constraints_never_fire`), section 7 | 21, 37 to 39 |
| A3 | Lead delete orphans stock | holds FK `on delete restrict`; the import's untouched rule counts holds; FK coverage | section 7 (`lead_import_untouched_counts_stock`), `import_attack.sql` (`import_fk_coverage`) | 47, 48 |

## Residual risks (none blocks 6a)

1. **Expiry helpers granted to `authenticated`.** `private.expire_due_holds` and `private.sweep_expired_holds` must be
   executable by the invoker RPCs. They are not reachable through PostgREST (`private` is not exposed) and only end
   holds that are already past their end date, in the caller's organisation, as the design intends. If `private` were
   ever exposed, the worst a caller could do is run the expiry early (no data access).
2. **`movement_requests.result` is writable by its owner** (the RPC stores its answer through the caller's grant). A
   person can only change what their own retries return; the app must treat a replayed answer as a hint and re-read
   the levels (6b's server actions already re-read after every write in the design).
3. **Session-less callers skip the guards' caller checks** (product, cost, settings, place guards return early when
   `auth.uid()` is null), as every earlier day does. Only maintenance roles, migrations and pg_cron have no `sub`;
   Supabase JWTs for `authenticated` always carry one.
4. **Splinter WARN on `set_user_role`** is unchanged (accepted on Day 1). No new WARN: the new definer code lives in
   `private`.
5. **Hosted Supabase was not touched** (no MCP in this build, by instruction). The design's read-only pre-check on dev
   (`select count(*) from import_batches where kind = 'stock'`, extensions) and the dev advisors after `deploy-dev-db`
   are for the lead builder before merge. CI runs the same tests on the Supabase Postgres image.
6. **Semgrep** runs only in CI (semgrep.dev is blocked here).
