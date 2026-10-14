# Day 5b security review

**Scope:** the Day 5b changes on `day5a-local` from b49fd9e (dependencies) to the head named in the README: migration
`supabase/migrations/20261015120000_deal_links.sql`, its tests (`deal_links_attack.sql`, `deal_concurrency.sh` part 2),
the pipeline server actions and GET routes, `src/lib/{deals,deals-server,pipeline-cache,money,prefetch}.ts`, the
`logActivity` changes, and the pipeline and lead page UI.

**Method:** `/security-review` (the Skill's instructions: input validation, authn/authz, crypto and secrets, injection
and code execution, data exposure; high-confidence findings only, with the false-positive filter). The Skill's own
context pointed at the main checkout's branch, so the review was done by hand on this worktree's diff
(`git diff b49fd9e~1..HEAD -- src supabase scripts`), tracing every input from the browser to the database, then the
design's threat table (section 6) re-checked against the tests that now exist.

## Result

**No findings** (nothing at or above confidence 8; nothing below it worth recording as a lead either).

What was traced:

- **Server actions** (`src/app/(app)/pipeline/actions.ts`, `leads/[id]/actions.ts`): every action parses with a Zod
  `strictObject` first (unknown keys refused), then `requireSession()` (two-factor sessions only), then exactly one RPC
  with its arguments named one by one (no spread of client input, no column list from the client). `updateDeal` sends
  `p_fields` from a Zod enum list; the database's `update_deal` whitelists them again. `logActivity`'s new `dealId` is
  a UUID and `openDeal` only passes with a call whose outcome is Interested or Book meeting and no `dealId` (Zod
  `superRefine`, then the database's `state` check).
- **GET routes** (`/api/pipeline/{board,stage,summary}`, `/api/deals/[id]`, `/api/leads/[id]/deals`): `apiSession()`
  first (401 otherwise), Zod `strictObject` on the query, UUIDs checked, every value reaches the database as a function
  argument; answers `{ error: code }` only, `Cache-Control: private, no-store`. No `.or()` or filter strings anywhere in
  the Day 5b code (grep), no `dangerouslySetInnerHTML`, no `innerHTML`, no `eval`, no logging of input.
- **Database** (`deal_links.sql`): `deal_id` returns to the activities insert grant behind a policy that requires a deal
  the caller sees on the same lead; `log_activity`, `undo_activity` and `get_lead` stay SECURITY INVOKER with static SQL
  and `search_path = ''`; the deal `log_activity` opens goes through the deals insert policy and `deal_guard` (editor,
  Do not contact, open limit, safe title, value bounds) and is linked to the call (the guard's source rule); the undo
  removes it only while untouched (`version = 0`) after the lead lock. Mutation 17 (log_activity as DEFINER) is caught.
- **UI**: React text only (titles with markup or bidi characters render as text: `xss_deal_title_is_text`); the money
  input goes through `parseMoney` and then the database bounds; links built from UUIDs only.

## Threat table (design section 6) re-checked for 5b

| # | Threat | Day 5b test now in place |
|---|---|---|
| 3 | IDOR on a colleague's deal | e2e `rep_get_other_deal_404` (RPC null for invisible and missing alike, move refused, route 404 codes only) |
| 10 | Stage tampering | e2e `stage_write_refused_via_rest` (admin PATCH 403, stages unchanged) |
| 11 | Two people move one deal | e2e `pipeline-multi.spec.ts` (two drops within 200 ms: one move row, version 1, conflict toast on the other screen) |
| 12 | Deadlocks with activities | `deal_concurrency.sh` part 2 (four no-deadlock cases; mutations 2 and 3) |
| 17 | An activity linked to another lead's or an invisible deal | `deal_links_attack.sql`; mutations 1 and 11 |
| 18 | Figures leaking rows | e2e `rep_direct_rpc_team_scope_403` (list_stage_deals and pipeline_summary team: 403 `scope`; the board falls back to the rep's own deals) |
| 19 | Lead side effects for non-editors | e2e `non_editor_no_open_switch`; mutation 5 |
| 21 | XSS, bidi, control characters | e2e `xss_deal_title_is_text`; mutation 9 (title pre-check) |
| 23 | CSRF | e2e `cross_site_move_action_refused` (the captured move replayed with another Origin: 500, nothing moved; the same request with the page's Origin runs) |
| 25 | Direct REST writes; private tables | e2e `history_table_write_refused` (POST and PATCH), `deal_patch_status_column_denied` (status, version, stage clock, creator: 403), `private_deal_moves_not_exposed` (404, and 406 by schema name on real PostgREST) |
| 27 | Opening deals on a Do not contact lead | mutation 6; `deal_links_attack.sql` `log_activity_open_deal_dnc_skipped` |
| 28 | Filter injection | no filter strings in the code; scopes and stages are Zod enums and database whitelists; `error_copy_has_no_sql` |
| 31 | The drag UI and CSP | spike S10 (no CSP violation, no console error); e2e `no_console_errors_no_csp_violations` on the board, the deal sheet, a keyboard drag and the lead's Deals tab |

The other rows (1, 2, 4 to 9, 13 to 16, 20, 22, 24, 26, 29, 30) are Day 5a's and unchanged (`docs/evidence/day5a/security-review.md`).
Local runs use `scripts/local-auth/gateway.mjs` in place of PostgREST; the checks that hold only on real PostgREST
(406 by schema name, 401/403 on a table POST) are marked in the spec and asserted in CI.

## Residual risks (accepted, design section 6)

1. A stolen aal2 session without a fresh code can move, win and lose its own deals, undo its own change within 2
   minutes, and delete a deal it opened in that window and never touched. Audited, with history. New in 5b: it can also
   log Interested with a deal and take both back with one Undo inside the 2-minute window (the same powers, one call).
2. A direct PATCH of `stage_id` follows every deal rule but skips the lead coupling (cosmetic).
3. Deal visibility stays owner, manager or admin; a future rep sees "No deals yet" on a colleague's lead with a deal.
4. Logging an activity resets a deal's stalled clock (audited, not a permission).
5. All three users are admins today; the rules matter for future hires and stolen sessions.
6. A colleague's move can take up to 30 s to appear; any action against it gets `conflict` and the latest state.
