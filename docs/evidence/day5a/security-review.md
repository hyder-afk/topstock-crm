# Day 5a security review: the deals database

Scope: `supabase/migrations/20261015090000_deals_pipeline.sql` and its tests (`supabase/tests/deals_attack.sql`,
`deal_concurrency.sh`, the fixture edits in `rls_attack.sql` and `import_attack.sql`), `scripts/check-migration-order.sh`,
`tests/unit/sql-guc.spec.ts`. No screens, no server actions, no routes (those are 5b and 5c). Design:
`docs/evidence/day5/design.md` section 6 (threats) and 8.1 (which file covers which threat).

How to read the table: "Test" names the case in `deals_attack.sql` (block number in brackets) or `deal_concurrency.sh`
(case number); "Mutation" names the rows of the day5a set in `mutations.md` that remove the control and are caught by
that test. Every row was re-checked on the final head by reading the control in the migration and running the test
(`bash scripts/db-test.sh`, all suites green; see README "Check results").

## Threat rows for 5a (design section 6), re-checked

| # | Threat | Control in 5a | Test | Mutation |
|---|---|---|---|---|
| 1 | Stolen aal1 session | restrictive `require_mfa` on `deals`, `deal_stage_history`, `pipeline_stages`, `private.deal_moves`; every new RPC raises 42501 without aal2 (`get_deal` gives null under RLS) | `day5_aal1_blocked` [1]; the policy list check [0] (restrictive on every Day 5a table) | (policies are checked by name and kind in [0]) |
| 2 | Another org's deals, stages, history or figures | `org_id` in every policy; `enforce_org_and_owner`; `private.stage_id`/`stage_key` read the caller's org only; the guard's invisible-stage path (42501 `stage`) | `other_org_deal_invisible`, `other_org_history_invisible` [3]; `other_org_stage_refused_42501` [3] and `rls_attack.sql` line 299 | 32 (P0002 instead of 42501), 40 (select without org) |
| 3 | IDOR on a colleague's deal | deals RLS (owner, managers, admins, D2); P0002 for missing and invisible alike; `get_deal` null | `rep_cannot_move_others_deal_p0002`, `rep_get_other_deal_null` (and `update_deal`, `delete_deal`, history, `list_lead_deals`) [3] | 41 (history readable) |
| 4 | Opening a deal on a lead the caller cannot change, or with another lead's contact | `deals_insert` policy (lead editor; contact of the same lead); `open_deal` lead lock (`lead_not_editable`) | `open_deal_on_colleagues_lead_42501`, `open_deal_contact_other_lead` (RPC P0002, direct 42501) [2] | 50 (no lead lock: the hint goes) |
| 5 | Forging server columns (G1) | column grants (insert 9 columns, update 9); the guard sets status, clock, close time, version, creator, currency, owner default and the Lead stage on insert, and resets them from the stored row on update | `deal_insert_columns_exact`, `deal_update_columns_exact` [0]; `deal_status_not_writable`, `deal_stage_entered_at_not_writable`, `deal_closed_at_not_writable`, `deal_version_not_writable`, `deal_company_immutable` (11 columns) [3]; `deal_created_by_forced`, `deal_insert_stage_not_writable`, `deal_opens_at_lead`, `owner_defaults_to_creator` [2] | 1, 2, 36, 37, 39 |
| 6 | Invalid transitions, incl. closed to closed (G2, D7) | the guard's move rules; `reopen_first`; constant pre-checks before the CHECKs; the same rules on a direct PATCH | `transition_matrix` (20 from/to pairs through `move_deal` and directly, with each missing input) [4]; `insert_at_won_refused` [2]; CHECKs without the guard [0] | 3, 4, 5, 6, 21, 33 |
| 7 | Rewriting won sales | reopening a won deal needs `has_recent_aal2(600)` (guard and RPC), except one's own undo within 120 s; a closed deal keeps value, shipping, dates and reason (22023 `closed`); `closed_at` is server time | `reopen_won_stale_code_denied`, `reopen_won_fresh_code_ok`, `closed_at_is_server_time` (matrix) [4]; `undo_own_win_within_120s_no_code` [5]; `closed_value_frozen` [4] | 7, 38 |
| 8 | Value tampering (NaN, Infinity, negative, huge, extra decimals) | `deals_value_bounds` (S6); guard pre-checks; RPC `private.deal_value_ok` (not NaN, 0 to 100,000,000, at most 2 decimals) | `value_nan_refused`, `value_infinity_refused`, `value_negative_refused`, `value_over_cap_constant_error` (RPC and direct) [2], [6]; `audit_deal_value_change_logged` [11]; CHECK backstop as superuser [0] | 20 (documented two-layer), 21, 51 |
| 9 | Forging or erasing history | select-only grant; one revoked DEFINER trigger builds rows from OLD/NEW; actor forced to `auth.uid()`; undo appends | `history_insert_denied`, `history_update_denied`, `history_delete_denied`, `deal_history_not_callable` [3]; `history_row_per_stage_change`, `history_no_row_without_stage_change`, `history_written_on_direct_patch`, `history_actor_forced` [5]; both invariants after every block | 12, 13 |
| 10 | Stage tampering | every stage write revoked (admins included); key and flag CHECKs; one key per org | `stage_write_denied_even_admin` [0], [3]; `one_won_one_lost_per_org`, `stage_key_flags_consistent` [0] | 19 |
| 11 | Two people move one deal | row lock (`FOR NO KEY UPDATE`) plus `version`; a conflict is a result | `two_movers_one_conflict`, `win_vs_lose_one_closes`, `move_vs_update_value_one_conflict`, `undo_vs_colleague_move_conflict`, `history_chain_consistent` (3 x 100) [concurrency 1 to 4, 9]; single-session conflict results [6] | 11 |
| 13 | Double submit or replay | `deals_creator_request_idx`; `deal_moves (user_id, request_id)`; replay checks before and after the lock | `open_deal_idempotent`, `request_id_other_author_no_collision`, duplicate direct insert 23505 [2]; `move_replay_returns_stored` [6]; `open_deal_replay_parallel_once`, `move_replay_parallel_once` [concurrency 5, 6] | 29, 42 |
| 14 | Undo abuse | one candidate function (own, latest, 120 s, `version_after`); values only from server rows; `p_undo_of` refuses a stale undo before writing | `undo_restores_clock_close_value_fulfilment`, `undo_of_expired_refused_no_write` [5]; `reverse_by_other_user_is_ordinary_move`, `reverse_after_121s_is_ordinary_move`, `reverse_after_colleague_edit_is_ordinary`, `undo_of_undo_is_ordinary`, `undo_of_reopen_from_lost_keeps_reason` [5] | 8, 9, 10, 34 |
| 15 | Deleting without a code, or erasing sales | `deals_delete`: manager/admin with a fresh code, or the creator's untouched deal under 120 s once the call's undo record is consumed; `delete_deal` pre-checks (`step_up`) | `deal_delete_stale_code_denied`, `deal_delete_rep_fresh_code_denied`, `deal_delete_admin_fresh_code_ok` (a manager), `deal_delete_creator_within_120s_untouched_ok`, `deal_delete_after_move_needs_code`, `deal_direct_delete_refused_while_activity_undo_record` [7] | 14, 15, 43 |
| 16 | Orphan deals; lost tasks; import undo removing a lead with a deal | `company_id not null`, FK restrict; `tasks.deal_id` set null with `task_guard`'s exception; Day 3b's untouched rule | `lead_with_deal_delete_23503`, `deal_delete_keeps_activities_and_tasks` [7]; the FK checks [0]; `import_attack.sql` (import undo keeps the lead with a deal) | 16, 17, 18 |
| 18 | Board figures leaking rows | INVOKER only, no views or DEFINER; scope resolved first (`deal_scope_owner`) | `pipeline_board_equals_hand_count` (admin), `rep_board_team_falls_back_to_mine`, `rep_stage_list_team_42501`, `rep_summary_team_42501`, manager scope [9]; RPC rules (INVOKER, no EXECUTE/format) [0] | 31 |
| 19 | Lead side effects on a lead the caller cannot change; DNC or Disqualified overwritten | lead `FOR UPDATE` gives no row to non-editors (S7); closed coupling table; compare-and-restore on undo | `coupling_table` (9 events x 7 statuses x editor/non-editor, incl. `win_never_overrides_dnc`, `coupling_never_touches_disqualified`, `non_editor_move_no_lead_change`) [8]; `undo_restores_lead_only_if_unchanged` [8b] | 23, 24 (documented two-layer), 25, 26, 47 |
| 20 | Owner reassigned by a rep or outside the org; ownerless deals | `enforce_org_and_owner`; guard default | `rep_cannot_reassign_deal` [2], [3]; `owner_must_be_org_member`, `owner_defaults_to_creator` [2] | 37 |
| 21 | XSS, bidi or control characters; values in logs | safe-character CHECKs (C0, DEL, C1, bidi) and constant pre-checks; planted markers never in the message or detail | `deal_title_bidi_refused`, `deal_bad_value_constant_error` and the lost note marker [2], [4], [6] | (the CHECK backstop is checked as superuser [0]) |
| 22 | Flooding history, audit and deals | 30 opens an hour; 120 stage changes a minute; page limits 1 to 100 | `open_deal_rate_limited`, `move_rate_limited` [11]; `limit_bounds_22023` [9] | 27, 28 |
| 25 | Direct REST writes to history, stages or forbidden columns; private tables exposed | grants; `private` has no endpoint | the grant checks [0], [3]. The REST probes (`history_table_write_refused`, `deal_patch_status_column_denied`, `private_deal_moves_not_exposed`) are e2e in 5b (`day5-security.spec.ts`) | 12 |
| 26 | Noisy or leaky audit | deals audited; `version` not diffed; `lost_note` masked (lengths only; `lost_note_len` on insert and delete); history not audited | `audit_deal_insert_update_delete_rows`, `audit_version_not_diffed`, `audit_lost_note_masked` [11], [7] | 48, 49 |
| 27 | Deals on a Do not contact lead | guard `dnc` on insert | `open_deal_on_dnc_refused` (RPC and direct) [2] | 35 |
| 28 | SQL or filter injection | static SQL (checked in `pg_proc`: no EXECUTE, no format()); whitelisted stage, scope, order, fields, reasons | `bad_scope_22023`, `bad_order_22023`, `bad_cursor_22023`, unknown stage [9]; `update_deal_bad_field_22023` [6]; titles `'); drop table deals;--` and `),id.eq.` stored verbatim [2] | 44, 45, 30 |
| 29 | A custom setting read with a bare cast | none is read | `tests/unit/sql-guc.spec.ts` (every migration) | (unit test; a planted bare read fails its own self-check case) |
| 30 | Day 6 seam misuse | `deal_closing_blocked` returns a code only (null in 5a); called before reopening a won deal, undoing a win, changing fulfilment and deleting | `closing_blocked_stub_null` [0] | 52 (documented: the stub returns null, so removing a call changes nothing until Day 6) |

Not in 5a (by the design's split): 12 (deadlocks across deals, activities and leads: 5b's `log_activity` with a deal; 5a
proves the lock that makes it safe: concurrency case 8 and mutation 22), 17 (activities linked to deals: 5b), 23
(CSRF: server actions, 5b), 24 (Home's "today": 5c), 31 (drag UI: 5b).

## New code reviewed by hand (beyond the table)

- **DEFINER code:** only `private.deal_history()` (trigger-only, revoked from everyone, `search_path = ''`, builds the row
  from OLD/NEW and `auth.uid()`; reads stage keys and the undo candidate without RLS, which is what the guard already
  decided under RLS: spike S9 showed both get the same candidate).
- **No dynamic SQL:** every new function body was checked in `pg_proc` for `EXECUTE` and `format(` (block 0).
- **Error messages:** every raise in the guard and the RPCs is a constant English sentence plus a hint; no value is
  concatenated except the Day 6 seam's code in the hint (`blocked_<code>`), a server-chosen word.
- **Lock order:** lead, then deal, in `open_deal`, `move_deal` (only when the change touches the lead) and `delete_deal`;
  `update_deal` and a direct PATCH take the deal alone. `move_deal`'s deal lock reads the deal without a join (the
  concurrency test found that a join dropped a row changed by a concurrent move under READ COMMITTED).
- **Row level security inside RPCs:** S7 confirmed `FOR NO KEY UPDATE`/`FOR UPDATE` return 0 rows (no error) to people
  who may see but not change a row, so the lead lock doubles as the editor check.
- **Migration order (D35):** `scripts/check-migration-order.sh` fails a PR whose new migration sorts at or before main's
  newest (tested both ways locally); `db.yml` runs it on pull requests with full history.

## Residual risks (accepted in the design, unchanged)

1. A stolen aal2 session without a fresh code can move, win and lose its own deals, undo its own change within 2 minutes,
   and delete a deal it opened in that window and never touched. Everything is audited and has history. It cannot reopen
   a won deal after 2 minutes or delete other deals.
2. A direct PATCH of `stage_id` follows every deal rule but skips the lead coupling (cosmetic: the lead stays editable).
3. Deal visibility stays owner, manager or admin; the Lost coupling check sees only visible deals (open question 5).
4. Anyone in the org can reset a deal's stalled clock by logging an activity on its lead (audited; not a permission).
5. All three users are admins today; the rules matter for future hires and stolen sessions.
6. New in 5a: a direct PATCH of `value` with more than 2 decimals is rounded by the column (the RPCs refuse it); the app
   only calls the RPCs. The rounding never crosses the 0 or 100,000,000 bounds the CHECK enforces.

## `/security-review`

Not run in this build session (database-only workflow step; the lead builder runs `/security-review` on the PR head in
the advisor loop, build order item 9). The table above is the threat re-check the design asks for.
