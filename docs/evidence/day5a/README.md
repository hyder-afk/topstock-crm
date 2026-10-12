# Day 5a: the deals database (pipeline rules, stage history, deal RPCs), 12 Oct 2026

Design: `docs/evidence/day5/design.md` (sections 1, 2 with spikes S6 to S9, 3.1, 4.1, 5.1 to 5.7, 6, 8.1 to 8.3, 8.6
part 1, 10 the Day 6 contract, 11 the 5a build order, 12 open questions; Haider accepted every recommendation on 11 Oct,
`docs/log.md`). Local branch `day5a-local`, cut from `main` at a7aa89e (Day 4a and 4b merged). **Day 4c is not merged
yet**: see "Rebase points". No screens, no server actions, no routes (5b and 5c); no UI change, so no browser e2e here.

## What changed

**Migration `supabase/migrations/20261015090000_deals_pipeline.sql`** (renamed at merge if main moved, D35), four parts:

1. **Stages** (G4, D9): `pipeline_stages.key` (`lead`, `qualified`, `negotiations`, `won`, `lost`, backfilled from the
   seeded positions; a DO block refuses an org without the five seeded rows) and `stall_days` (7 / 14 / 21); CHECKs for
   the keys, key-flag agreement, stall days on open stages only, one key per org; the three admin write policies dropped
   and every client write revoked (admins included). Helpers `private.stage_id(key)` and `private.stage_key(id)`.
2. **Deal columns, constraints, FKs, indexes** (G1, G2, G5 to G8): `title`, `lost_note`, `closed_at`, `version`,
   `created_by`, `source_activity_id`, `request_id`; `company_id not null` with FK `on delete restrict`; `value` and
   `fulfilment` nullable with no default; the four old CHECKs replaced by eleven named ones (value bounds incl. NaN,
   EUR only, lost reason list, lost needs a reason, other needs a note, won needs value > 0 and shipping, close time
   matches status, version >= 0, safe title and note); `tasks.deal_id` set null and **`private.task_guard` recreated**
   with `deal_id` in its link-emptying exception; the design's index set (board, closed, company, creator, source,
   request id unique, activities by deal).
3. **Rules and records**: `private.deal_undo_candidate` (one definition for the guard and the history trigger),
   `private.deal_closing_blocked` (returns null: the Day 6 seam), **`private.deal_guard`** (INVOKER, BEFORE INSERT OR
   UPDATE: server-set columns on insert, the transition rules, undo restore, closed-deal freeze, constant pre-checks,
   flood guards, version on every change), **`public.deal_stage_history`** (append-only, select-only, written by the
   revoked DEFINER trigger `private.deal_history` on insert and on a stage change), **`private.deal_moves`** (lead
   before/after and request ids for replay and compare-and-restore; own rows only), deal policies (select, insert,
   update, delete with the fresh-code and creator-window branches), column grants, **`private.audit_row` recreated**
   with the deals rules (version not diffed, lost note masked).
4. **RPCs** (design 4.1; all SECURITY INVOKER, static SQL, revoked from anon): `open_deal`, `move_deal`, `update_deal`,
   `delete_deal`, `get_deal`, `list_stage_deals`, `pipeline_summary`, `pipeline_board`, `list_lead_deals`, with their
   private helpers (`deal_cards`, `deal_card`, `stage_deal_ids`, `deal_value_ok`, `deal_scope_owner`, `opened_deal`,
   `moved_deal`, `deal_conflict`, `pipeline_summary_for`).

**Tests and tooling**

- `supabase/tests/deals_attack.sql` (new, 12 blocks): catalog checks (grants, policies, RPC rules, triggers, CHECKs as the
  superuser), aal1, opening, forging, the 20-pair `transition_matrix` (RPC and direct PATCH), undo, conflicts and replays,
  deleting, the `coupling_table` (9 events x 7 lead statuses x editor/non-editor) and lead undo, the board (hand counts,
  scopes, keyset stability, cursors, limits), the shared stall cases in four session time zones, get_deal, move records,
  audit, flood guards, referential link emptying; both invariants after every block.
- `supabase/tests/deal_concurrency.sh` (new, part 1): cases 1 to 7 of design 8.2, plus case 8 (a move and a value change
  are not blocked by an entry's foreign key lock on the deal; a delete is) and case 9 (`history_chain_consistent`,
  3 sessions x 100 random moves; with `p10` it is perf P10).
- Fixture updates (design 8.1): `rls_attack.sql` lines 30, 249, 287 to 292, 299 (comment), 313; `import_attack.sql:523`.
- `scripts/check-migration-order.sh` (new, D35) and a step in `db.yml` (pull requests, full history).
- `scripts/db-test.sh` and `.github/workflows/db.yml` run `deals_attack.sql` and `deal_concurrency.sh`.
- `tests/unit/sql-guc.spec.ts` (new, threat 29).
- `scripts/db-mutations.py`: the day5a set (53 rows), a `Region` target (one function inside a file), the earlier sets'
  rows aimed at `audit_row` and `task_guard` re-aimed at the live Day 5a copies, and `--anchors`.
- `supabase/tests/perf_day5.sql` (new, part 1) and `scripts/db-perf.sh` (runs it after `perf_day4.sql`, then P10).
- Spikes S6 to S9: `docs/evidence/day5a/spikes/` (scripts) and `docs/log.md` (results and decisions).

## Check results

Code head **b8e839f** (the last commit that changes code; later commits change `docs/` only), 12 Oct 2026, 03:20 UTC.

| Check | Result |
|---|---|
| `bash scripts/db-test.sh` (a copy on port 54361; the real script keeps 54329) | exit 0: rls_attack, import_attack, import_concurrency, activity_attack, activity_concurrency, outcome_attack, outcome_concurrency, **deals_attack**, **deal_concurrency** (cases 1 to 8; case 9: 194 moved, 27 conflicts, 19 `reopen_first`, 0 deadlocks) all pass |
| Supabase advisors (splinter, in `db-test.sh`) | no ERROR-level findings. WARN `set_user_role` (accepted since Day 1); INFO `unindexed_foreign_keys` 3 (`activities_org_id_fkey`, `private.activity_undo` and the new `private.deal_moves` org FK: the same accepted pattern, a 10-minute table), INFO `unused_index` 3 |
| `plpgsql_check` over every plpgsql function in `public` and `private` (what CI's `supabase db lint` runs) | no error, no warning (one type warning in `pipeline_board` fixed in cff33b5) |
| Mutations (`mutations.md`) | day5a **53 rows: 49 caught, 4 documented two-layer rows, 0 not as listed** (8bd6e4b, three rows on 3a21018); the 36 earlier rows re-aimed at the Day 5a copies of `audit_row` and `task_guard`: 36 caught (8bd6e4b); `--anchors` on b8e839f: every anchor of all four sets found once (37 / 104 / 94 / 53) |
| Perf part 1 (`perf.md`, 3 runs on b8e839f) | met: P1 team 18.8–20.4 ms (25), P2 all six 2.8–4.2 ms (5), P3 4.3–5.5 ms (10), P4 undo 7.7–8.0 and open 7.2–8.4 ms (10), P4b 2.1–4.4 ms (6 / 10), P6 list_lead_deals 2.3–2.6 ms (3), get_deal 4.5–5.8 ms (5, 2 of 3); **missed**: P1 mine 17.8–19.4 ms (15), P4 move/win/lose 9.9–11.7 ms (10), P10 p95 35.5–58.0 ms (20). P9: no regression traced to 5a code (medians within the run-to-run spread; import and undo within +10 to +16% against main with the same deals) |
| `scripts/check-migration-order.sh` | ok (newest on origin/main 20261012090000; added 20261015090000); a base with a later file fails it (tested) |
| `npm run lint` | exit 0: 0 errors, the 2 existing React Compiler warnings |
| `npm run typecheck` | exit 0 |
| `npm run test:unit` | 329 passed (321 before plus `sql-guc.spec.ts`'s 8) |
| gitleaks (`origin/main..HEAD`, on 25d2278) | 19 commits scanned (incl. the design commit 5c3e4c3), no leaks found, exit 0 |
| `npm audit --omit=dev` | found 0 vulnerabilities |
| Semgrep | not run locally (semgrep.dev is blocked here); CI's `semgrep` job |
| `/security-review` | not run in this step (the lead builder runs it on the PR head in the advisor loop); the threat table is re-checked in `security-review.md` |
| Playwright | not needed: no UI change in 5a (the existing suites are unchanged) |


## Commits (`origin/main..HEAD`, oldest first; this README's own commit follows)

- 5c3e4c3 Day 5 and Day 6 designs (three designs, judges, synthesis; Haider accepted all recommendations on 11 Oct)
- 937e3f2 Day 5a: log the read-only dev pre-check (deals 0, 5 seeded stages, deal constraint names)
- ea17e85 Day 5a: spikes S6 to S9 on a throwaway PG16 (NaN/Infinity, FOR NO KEY UPDATE under RLS, lock coexistence, trigger candidates) and their decisions
- 2635596 Day 5a migration: stage keys, deal columns and guard, stage history, move records, policies, grants, audit, deal RPCs
- 3fe87b8 Day 5a fixture updates (design 8.1): stage key on the other org's stage, deal probes without a client stage, title as the deal update probe
- f49769d Day 5a tests: deals_attack.sql, deal_concurrency.sh part 1, migration order check; wired into db-test.sh and db.yml
- ea573d7 Day 5a unit test sql-guc.spec.ts: no bare current_setting( in any migration (threat 29)
- 2b412d7 Day 5a tests: CHECK backstops without the guard, duplicate request id, lost note paths, moves not blocked by an entry's key lock
- 4782724 Day 5a mutation set (52 rows) in db-mutations.py; earlier rows aimed at audit_row and task_guard follow the live Day 5a copy; --anchors mode
- 615d6f6 Day 5a perf part 1: perf_day5.sql (P1 to P4b, P6) and deal_concurrency p10 in db-perf.sh; the board reads its cards in one call, column pages look up the lead only for stalled-only
- 7ec5295 Day 5a: get_deal.can_delete follows the delete policy's undo-record condition (and a test)
- cff33b5 Day 5a: plpgsql_check clean (pipeline_board array default typed)
- 96b3579 Day 5a test: the keyset paging loop is bounded (a repeating cursor fails instead of looping)
- 8bd6e4b Day 5a concurrency: an 'unchanged' answer is a valid outcome in the 3-session random run (a colleague moved the deal to that stage first)
- 3a21018 Day 5a: null-safe comparisons in deals_attack (mutation 37 slipped past owner <> admin); the insert clock mutation documented as two layers plus a both-layers row
- 9970269 Day 5a evidence: mutations.md (day5a 49 caught, 4 documented two-layer rows; 36 re-aimed earlier rows caught), README and security review drafts
- 0b9d470 Day 5a: the board summary reads a deal's lead only when its stage clock is already past the limit (19 ms to 4 ms on the perf seed)
- b8e839f Day 5a: the board summary's aggregate is computed once (materialized), not once per stage row
- 25d2278 Day 5a evidence: perf.md (3 runs on b8e839f, P9 against main with the same deals), README check results and open risks, log rows

## Spikes (design 2.4; full results in `docs/log.md`, scripts in `spikes/`)

| # | Result | Decision |
|---|---|---|
| S6 | `numeric(14,2)` stores `'NaN'`, which passes `value >= 0`; `'Infinity'`/`'-Infinity'` refused by the column (22003); an unconstrained numeric parameter (PostgREST's `json_to_record`) takes `"NaN"` and `"Infinity"`; `12.345` is rounded to 12.35 silently | CHECK keeps `value <> 'NaN'` and the bound; guard pre-checks; every RPC pre-checks `p_value` (not NaN, 0 to 100,000,000, at most 2 decimals) so Infinity never reaches the column and nothing is rounded |
| S7 | With column grants, `FOR NO KEY UPDATE` under RLS returns the row to editors and 0 rows (no error) to others, also when select is wider than update; no UPDATE column privilege at all gives 42501 | The lock's row count is the editor check (no extra pre-check) |
| S8 | An entry's FK check (KEY SHARE) and `FOR NO KEY UPDATE`/plain non-key UPDATE coexist; a DELETE waits behind both | Lock order table 5.7 unchanged; concurrency case 8 and mutation 22 keep it |
| S9 | The INVOKER guard and the DEFINER AFTER trigger get the same undo candidate in one UPDATE; `AFTER UPDATE OF stage … WHEN` fires on a client stage change; `AFTER UPDATE OF status` never fires when only the guard sets status; `AFTER UPDATE … WHEN (old.status is distinct from new.status)` does | No `deals.undo_of` column; the Day 6 contract keeps "WHEN, never UPDATE OF status" |

## Deviations from the design (each small; none changes a decision)

1. **Stalled in hours, not calendar days**: `make_interval(hours => 24 * stall_days)` instead of `make_interval(days =>
   …)`. A days interval follows the session's time zone across a clock change; hours do not. Same answer in UTC (what
   Supabase sessions use). The shared stall cases run in four session time zones; the fixed-instant clock-change cases of
   design 5.5 belong to the TypeScript side in 5b, where `now` can be set (SQL's `now()` cannot).
2. **C1 control characters** (`\u0080`–`\u009F`) are refused in titles and lost notes too (design text listed C0, DEL and
   bidi); the same rule as tasks and activities.
3. **RPC values with more than 2 decimals are refused** (22023 `value`), from S6; a direct PATCH is rounded by the column.
4. **Contact of another lead**: `open_deal` and `update_deal` answer P0002 "contact not found on this lead" before any
   write, like `log_activity` and `create_task`; a direct insert still gets 42501 from the policy (design threat 4 named
   42501 for both).
5. **Error hints added**: 22023 `stage` (unknown stage key), `bad_scope` (unknown scope), `limit` (page sizes); 42501
   `stage` also when the caller has no pipeline on insert.
6. **An ordinary Lose must send its reason** (`lost_reason_required`), and its note replaces the old one, instead of
   `coalesce` with a reason kept from an earlier loss (design 5.2 step 7 wrote `coalesce`); a hand drag back into Lost
   that is an undo needs none. A Win still keeps an estimated value and a chosen shipping when none is sent.
7. **Direct PATCH parameter mix**: on an ordinary move the guard lets value and shipping change only with a win and the
   lost fields only with a loss (22023 `state`), mirroring `move_deal`'s parameter check.
8. **`move_deal`'s row lock reads the deal alone** (no join to the stage table): found by `deal_concurrency.sh` case 1. Under
   READ COMMITTED a row changed by a concurrent move is re-checked on its new version against the stage row read before
   the wait, which dropped it ("deal not found").
9. **Card columns** add `contact_id` and `created_at` to design 5.6; `pipeline_board`/`pipeline_summary` also return
   `scope` and `owner_id`; `get_deal.undo` adds `to_stage`; `get_deal.can_delete` follows the policy's undo-record rule.
10. **`delete_deal`** runs the Day 6 block check before the lead lock, deletes, then puts the lead back (so a refused
    delete never changes the lead).
11. **`private.deal_moves` WITH CHECK** also requires the history row to be the caller's own and the lead to be the
    deal's (stricter).
12. **`pipeline_board`** reads all its cards in one call and takes each column's next cursor from its last card; column
    pages look up the lead only for "stalled only" (speed; same answers).
13. **Mutations**: 53 rows instead of 31. Design rows 20 and 23 are split into their layers (the two-layer rows are
    documented); rows 34 onward are additions (39/40 split the same way). Design row 21 ("deadlock test") is caught in 5a by concurrency case 8,
    since 5b's `log_activity` with a deal does not exist yet.
14. **Unit tests**: only `sql-guc.spec.ts` is 5a's; `day5-parity`, `deals`, `days-in-stage` and the rest of design 8.4
    test `src/lib/deals.ts` and friends, which 5b writes.

## Rebase points (Day 4c and 4d are not merged)

Day 4c will add `supabase/migrations/20261013090000_tasks_queue.sql` (queue columns on companies, `private.queue_claims`,
task indexes, a new `get_lead`, possibly `task_guard`, `audit_row` and the import FK coverage list). After 4c (and 4d)
merge, before 5a merges:

| # | Where | What to do |
|---|---|---|
| 1 | Migration block `private.task_guard` (marked `-- REBASE: re-copy from the latest merged body after 4c/4d merge`) | Re-copy the newest merged body and add `deal_id` to the link-emptying exception again (the array and its `new.deal_id is null …` line) |
| 2 | Migration block `private.audit_row` (marked `-- REBASE`) | Re-copy the newest merged body and add the deals rules again (`is_deal`, the `lost_note` masking on insert/delete, `version` and `lost_note` out of the update diff, the `lost_note` lengths) |
| 3 | The migration's file name | `scripts/check-migration-order.sh` must pass: rename to sort after main's newest (D35) |
| 4 | `scripts/db-mutations.py` rows aimed at `TASK_GUARD_5A` / `AUDIT_ROW_5A` (day3b 28, 29; day4a 9, 11, 12, 14, 32, 33, 35 to 54, 67, 77, 78, 81 to 83, 104; day4b 47; day5a 18, 49, 50) and any 4c/4d rows on those functions | Re-aim at the live copy, then `python3 scripts/db-mutations.py --anchors` must report every anchor found once |
| 5 | `import_attack.sql` FK coverage list (`import_fk_coverage`) | 5a adds no FK to `companies` (`deal_moves.company_id` has none on purpose); keep whatever list 4c/4d merged |
| 6 | `scripts/db-test.sh`, `.github/workflows/db.yml`, `scripts/db-perf.sh` | Keep 4c's/4d's new lines and 5a's; 5a's suites run after the Day 4 ones |
| 7 | `rls_attack.sql` and `import_attack.sql` fixture edits | Re-apply if 4c/4d touched the same lines |
| 8 | Re-run after the rebase | `scripts/db-test.sh` (all suites), the day5a mutation set, `perf_day5.sql` (P9 against the new main) |

## Open risks

1. **Speed misses under a loaded VM** (`perf.md`): the rep's board 17.8–19.4 ms (15), a move that touches the lead
   9.9–11.7 ms (10), P10 p95 35.5–58.0 ms (20, includes lock waits by design). Every run shared 4 cores with two other
   workflows; re-measure on CI hardware or a quiet VM before deciding. Haider decides whether to accept them as the
   baseline (as he did for Day 4b's speed on 11 Oct).
2. **Mutation runs on a shared VM**: concurrency tests depend on timing (0.4 s head starts). Two baselines passed before
   the run and every caught row's first failure was read and is the protection's own test; still, a run on a quiet
   machine would be cleaner.
3. **Rebase onto 4c/4d** (section above): two functions are copies of merged bodies; the PR must re-copy them.
4. **Stall clock-change cases**: the SQL side is zone-free by construction (hours), but the fixed-instant 25 Oct / 1 Nov
   cases of design 5.5 are only testable on the TypeScript side (5b).
5. **A direct PATCH of `value` with 3 decimals is rounded** by the column; the RPCs refuse it (residual risk 6 in
   `security-review.md`).
6. **The design's residual risks 1 to 5 stand** (`security-review.md`).
7. **Process note**: twice in this step a `pkill -f`/`pgrep -f` pattern matched the agent's own shell and ended it (the
   mutation runs were then stopped by PID and restarted cleanly from a reset worktree); nothing outside this step's
   processes was affected (other workflows' ports 54371/54372 and 54329 untouched).


## Docs used

- Context7 `/websites/postgresql_16`: CREATE TRIGGER notes (a column-specific `UPDATE OF` trigger ignores changes made by
  BEFORE triggers; `WHEN (OLD.x IS DISTINCT FROM NEW.x)`), numeric special values (NaN sorts above every number;
  Infinity only in unconstrained numeric), row-level lock conflicts (`FOR NO KEY UPDATE` vs `FOR KEY SHARE`; which
  UPDATEs take `FOR UPDATE`). Each was then checked on PG 16.15 by spikes S6, S8 and S9.
- Repository: the merged migrations (core schema, leads are companies, lead import, activity hardening, lead page) for
  guards, grants, lock order, `has_aal2`/`has_recent_aal2`, constant pre-checks and `audit_row`; `docs/evidence/day4b/README.md`;
  `docs/evidence/day6/design.md` section 12.1 (the Day 5 contract: status `lost` set on Closed/lost, which the guard
  does).
