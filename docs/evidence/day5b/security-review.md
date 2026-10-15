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

## At the 4c rebase and verifier round 1 (15 Oct)

- `log_activity` and `get_lead` are now Day 4c's bodies plus the Day 5b parts: still SECURITY INVOKER, static SQL,
  `search_path = ''`, constant messages, the same revoke/grant loop. 4c's `p_from_queue` claim release deletes only the
  caller's own claim (the claims delete policy and 4c's mutation rows on it, re-run against the 5b copy).
- `private.queue_card` gains `open_deal`: INVOKER, static, read under deals RLS (a rep sees no count for a colleague's
  deals: `deal_links_attack` block 8; a DEFINER mutation of it is caught, day5b row 20).
- The queue's outcome call passes `p_open_deal` / `p_deal_title` / `p_deal_value` from the same `logActivityInput`
  strictObject as the lead page (explicit arguments in `queue-server.ts`; `p_deal` always null there). The database
  keeps deciding: editors only, not on Do not contact, the hourly open limit.
- Reopen from the board's menu and the Deals tab reads `GET /api/deals/[id]` (existing, Zod-checked) for the history;
  no new route. U on the lead page may now call `undoDealMove` (existing action; the database refuses a stale or
  someone else's undo).
- No new dependency, no `dangerouslySetInnerHTML`, no raw errors.

## Residual risks (accepted, design section 6)

1. A stolen aal2 session without a fresh code can move, win and lose its own deals, undo its own change within 2
   minutes, and delete a deal it opened in that window and never touched. Audited, with history. New in 5b: it can also
   log Interested with a deal and take both back with one Undo inside the 2-minute window (the same powers, one call).
2. A direct PATCH of `stage_id` follows every deal rule but skips the lead coupling (cosmetic).
3. Deal visibility stays owner, manager or admin; a future rep sees "No deals yet" on a colleague's lead with a deal.
4. Logging an activity resets a deal's stalled clock (audited, not a permission).
5. All three users are admins today; the rules matter for future hires and stolen sessions.
6. A colleague's move can take up to 30 s to appear; any action against it gets `conflict` and the latest state.

## /security-review before the PR (15 Oct 2026, ea75fbf)

Run by another reviewer on the whole Day 5 range `5f1a966..ea75fbf`. **Result: NO FINDINGS.**

What it checked:
- `20261015090000_deals_pipeline.sql`: the deals policies and grants, `deal_guard`, the SECURITY DEFINER trigger
  functions and the RPCs.
- `20261015120000_deal_links.sql`: `activities_insert`, `log_activity`, `undo_activity`.
- `20261015150000_home_dashboard.sql`: the `home_*` functions and the `stock_alerts()` stub.
- `src/app/(app)/pipeline/actions.ts` (its 8 actions), the 6 API routes, the pages.

By design (noted, not findings): one's own win can be undone within 2 minutes without a fresh code; reopening a lost
deal needs no code (a won one does).

Side note (hardening item for multi-org, logged in `docs/log.md`): the core `enforce_org_and_owner` does not check that
an owner chosen by a manager belongs to the same org. Not exploitable with one org (TopStock has one); to add before a
second org exists.

The advisor items fixed after it (ceca0b5, d29be68, a6f5dc2, 1118956, 7d5da6d) change tests, evidence, the Low stock
card's markup and messages, and its skeleton: no migration, policy, grant, RPC, route or action changed (the e2e only
take a grant away and give it back on the throwaway local stack).

## /security-review of the Day 4d merge (15 Oct 2026, dd24bb6 remerge-diff, d107fd2, docs commits)

Run on the merge delta only: the merge resolution (`git show --remerge-diff dd24bb6`), d107fd2 and the docs commits after
it. Day 4d itself (`5f1a966..efbbbb4`) was reviewed and approved in PR #16. **Result: NO FINDINGS.**

What it checked:
- Migrations: `git diff 931af08 dd24bb6 -- supabase/migrations` only adds 4d's `20261014090000_lead_files.sql`, identical
  to PR #16's. No Day 5 migration mentions 4d's objects, and 4d redefines nothing Day 5 changes.
- `src/lib/db-errors.ts` is the exact union of both allowlists: only the SQLSTATE and a listed hint reach users.
- `src/app/(app)/leads/[id]/page.tsx`: `requireSession` still first; `z.uuid()` on the id (404 otherwise); `?deal=` goes
  through `z.uuid().safeParse` and becomes `initialDeal` or null; the files are read inside the same `Promise.all`, after
  the checks.
- The auto-merged `lead-page.tsx`, `leads.ts` and `import_attack.sql` are clean unions (FilesTab still gets `stepUp`).
  4d's file routes and actions are unchanged.
- `rls_attack.sql` block 3b keeps all four refusal checks for deals, tasks and files. Files probes `status='deleting'`,
  deals and tasks probe `title='x'`: each is a column the client may write, so RLS is what refuses.
- `db.yml`: still `pull_request` plus `push` to main only, `contents: read`, `persist-credentials: false`,
  `github.base_ref` passed through `env`, no secrets. `ci.yml` and `gitleaks.yml` are identical to efbbbb4.
- d107fd2: the bytes were checked to be U+202E and U+2066 (written as escapes, same strings at run time).
- No secrets in the added lines.
