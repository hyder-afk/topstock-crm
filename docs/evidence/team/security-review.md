# Team screen: security review, 12 Oct 2026 (re-checked 14 Oct 2026 on ed2ad60 and after the verifier round; `/security-review` run 15 Oct 2026)

Scope: this branch's diff against `origin/main` a7aa89e (branch `team-local`): `src/lib/team.ts`,
`src/app/(app)/more/team/{actions,page,loading}.tsx`, `src/components/team/{team-list,team-entry}.tsx`, the More page
and skeleton, the step-up dialog's `bodyRole`, messages, tests; since the verifier round also one migration,
`supabase/migrations/20261015200000_role_change_lock.sql` (re-dated on 15 Oct from `20261021090000_…`, content
unchanged), which redefines the existing `public.set_user_role` with a role-change lock, and one server action
(`src/app/(app)/more/team/actions.ts`). No new table, no new database function, no new route handler, no new
dependency.

How it was run: the `/security-review` skill was invoked from this session, but it reads the primary checkout
(`/home/user/topstock-crm`, another branch), so its diff was not this change. The same method (threat rows below,
>80% confidence bar, the skill's exclusions) was applied by hand to this branch's own diff
(`git diff origin/main..HEAD -- src`). Result: **no high- or medium-confidence vulnerability.**

Re-check 14 Oct (ed156da, ed2ad60): both change client code only (a monospace span around the user id; local roles
kept until the server's list shows them, and a `router.refresh()` after a save). No new input, no new call, no new
data shown; the server action and the database function are unchanged. Same result.

Verifier round (14 Oct, NOT READY, 7 findings): this round adds one migration,
`supabase/migrations/20261021090000_role_change_lock.sql` (now `20261015200000_role_change_lock.sql`), which replaces `public.set_user_role` (same signature,
same SECURITY DEFINER and `search_path = ''`, same grants re-stated, same constant messages and SQLSTATEs, same audit
row). After the admin and fresh-code check it locks every admin row of the caller's organisation in id order, checks
the caller is still an admin (an admin demoted while the call waited is refused), then locks the target and counts.
The server action now also returns the server's time on success (`at`, a number; no data). The page passes the time it
read the list (`readAt`). No new input, no new table, no new grant. Same result: no high- or medium-confidence
vulnerability.

| Threat | What stops it | Proof |
|---|---|---|
| A rep (or manager) makes themselves or anyone an admin | `public.set_user_role` (core schema, SECURITY DEFINER, accepted Day 1) checks `private.is_admin()` from the caller's own JWT first; the page's `requireAdmin()` only hides the screen | `rls_attack.sql` "rep promoted self"; e2e `rep_cannot_see_or_reach_team` replays the admin's own server-action request with the rep's session: answer `forbidden`, role and audit log unchanged |
| An admin without a fresh code changes a role | the database's `has_recent_aal2(600)`; the action's pre-check (`stepUpSecondsLeft(claims) > 0`, read from the verified JWT) can only refuse earlier, never allow | `rls_attack.sql` (code 660 s old, no code time); e2e `stale_code_asks_for_a_code` |
| Another organisation's person | `set_user_role` answers P0002 for a user outside the caller's org (screen: "no longer in your team") | `rls_attack.sql` "changed a role in another org" |
| The last admin removed (lock-out) | `set_user_role` counts the organisation's admins before the update, after locking every admin row of the organisation (id order) and checking the caller again, so two admins demoting each other at the same instant queue and the second is refused | `rls_attack.sql` "removed the last admin"; `team_concurrency.sh` (demote each other, demoted admin cannot demote or promote); mutation set `team` 4 of 4 caught; e2e `last_admin_refused` |
| Mass assignment / extra fields (`org_id`, `target_user`) | `roleChangeInput` is a Zod `strictObject({ userId: uuid, role: enum })`; the RPC gets two named args built from it | unit `refuses … any extra field`; e2e replay with `org_id` added answers `invalid` |
| SQL / filter injection | no user text reaches a filter string: the only filters are `.eq("id", claims.sub)` (verified JWT) and the RPC's typed args | code read |
| Error text leaks database detail | `roleChangeError` reads SQLSTATE and hint only; the 42501 cause is worked out from the caller's own role and the token's code time, never from the message | unit `refusals of set_user_role` |
| An oracle on other people (does user X exist?) | the function checks admin before looking up the target, so a non-admin gets `forbidden` for every id | code read (order in the core schema) |
| Cross-site request | Next.js server actions refuse a foreign Origin (proved for this app in `day4-security.spec.ts` `cross_site_action_refused`) | existing test |
| XSS through a name | names render as React text; no `dangerouslySetInnerHTML` | code read |
| Data shown | admins only (page 404s for others; RLS keeps `profiles` to the caller's org): name, role, account date, first 8 characters of the user id. No email (it is in `auth.users`, read neither with the service key nor through a new definer function) | code read |

Residual (not vulnerabilities):
- ~~Two admins demoting each other at the same instant~~: **fixed in the verifier round** by the migration above
  (before it, each call locked only its target's row and counted two admins, so both could commit and leave none;
  `team_concurrency.sh` case 1 failed that way on the old function: "both demotions committed (admins left: '')").
- the Supabase advisor's existing WARN on `set_user_role` (SECURITY DEFINER executable by
`authenticated`, accepted Day 1: it must update `profiles.role`, which `authenticated` has no grant for); the action
reads the caller's role once more after a 42501 to word the refusal (one extra query on a refusal only).

## /security-review on the branch diff (15 Oct 2026, 5f1a966...7d7c2f2, Team-only commits)

Result: **NO FINDINGS** at >= 80% confidence.

Checked:
- `set_user_role` (the role-change lock migration): SECURITY DEFINER, `search_path = ''`; grants re-stated (revoked
  from `public` and `anon`, granted to `authenticated`); `private.is_admin()` first; the `role` column is not
  client-updatable (the UPDATE grant on `profiles` covers only `first_name`, `last_name`, `language`, `timezone`);
  `caller_org` from `private.current_org_id()`, a target in another organisation gets P0002, the same as a missing
  user; `has_recent_aal2(600)` checked first with the admin check; the lock: every admin row of the organisation
  `FOR UPDATE` in id order before the target, the caller re-checked with `is_admin()` after the wait (READ COMMITTED
  re-checks the rows it waited on), the admins counted after the locks, the fixed lock order avoids deadlocks;
  stepping yourself down only while another admin remains.
- Server action `src/app/(app)/more/team/actions.ts`: `requireSession` (aal2), `z.strictObject({ userId: uuid, role:
  enum })`, named RPC args, only codes returned (through `roleChangeError`), no logging.
- Pages: `requireAdmin()` before any read, 404 for everyone else; the list reads `id, first_name, last_name, role,
  created_at` under RLS; no email, nothing new exposed.
- Client code: no unsafe sinks, fixed navigation paths.
- CI and scripts: local throwaway credentials only.

Residual noted by the reviewer (recorded under open risks in `README.md`): a promotion and a demotion running at the
same moment, all by admins with fresh codes, have a theoretical window that could lose the last admin. Ruled out as
theoretical; no privilege is gained.

Repeated after the 4d and Day 5 merge: see the two sections below (both no findings).

## /security-review of the Day 5 merge delta (15 Oct 2026, remerge-diff 4711172 + 4711172..877b9b5, Team files included)

Result: **NO FINDINGS**.

Checked:
- The role-change lock migration (`20261015200000_role_change_lock.sql`) is byte-identical and sorts last, after Day
  5's three migrations (`20261015090000_deals_pipeline`, `20261015120000_deal_links`, `20261015150000_home_dashboard`).
- Only the core schema and the lock define `set_user_role`; no later migration redefines `is_admin`,
  `is_manager_or_admin` or `has_recent_aal2`, or writes `profiles.role`.
- The `role` column is not client-writable (the UPDATE grant on `profiles` covers only `first_name`, `last_name`,
  `language`, `timezone`); `revoke` from `public`/`anon` and `grant` to `authenticated` on `set_user_role` intact.
- `db.yml` only adds `team_concurrency` through `ci-report.sh`; triggers `pull_request` and `push` to `main`,
  `contents: read`, no secrets, `base_ref` through `env`, checkout SHA-pinned with `persist-credentials: false`.
- The step-up dialog's body-key union only picks message text; the team list still uses `bodyRole`; the database
  enforces aal2.
- No Team code changed after the merge (`src/components/team`, `src/app/(app)/more`, the proxy untouched).
- `rls_attack.sql` identical to b9c05db (last-admin coverage kept); the conflict files are union resolutions; no
  secrets in the added lines.

## /security-review of the deal-delete delta (b9c05db..1e6b806)

Result: **NO FINDINGS**.

Checked:
- `deals_delete` and `delete_deal` agree: `is_admin` and `has_recent_aal2(600)`, or the creator's untouched 120 s
  branch. `delete_deal` is SECURITY INVOKER, so row level security is a second gate.
- `created_by`, `created_at` and `version` cannot be forged: the guard forces them, there are no column grants, an
  update refuses changes to them and `SET NULL` only nulls; `version` bumps on every real update, so the 120 s window
  closes once the deal is touched.
- `can_delete` is display-only (`deleteDeal` in `actions.ts` never reads it) and computed from data the caller can
  already see; `home_attention` strips it.
- No SECURITY DEFINER or grant changes.
