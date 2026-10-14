# Team screen: security review, 12 Oct 2026 (re-checked 14 Oct 2026 on ed2ad60)

Scope: this branch's diff against `origin/main` a7aa89e (branch `team-local`): `src/lib/team.ts`,
`src/app/(app)/more/team/{actions,page,loading}.tsx`, `src/components/team/{team-list,team-entry}.tsx`, the More page
and skeleton, the step-up dialog's `bodyRole`, messages, tests. No migration, no new database function, no new route
handler, no new dependency.

How it was run: the `/security-review` skill was invoked from this session, but it reads the primary checkout
(`/home/user/topstock-crm`, another branch), so its diff was not this change. The same method (threat rows below,
>80% confidence bar, the skill's exclusions) was applied by hand to this branch's own diff
(`git diff origin/main..HEAD -- src`). Result: **no high- or medium-confidence vulnerability.**

Re-check 14 Oct (ed156da, ed2ad60): both change client code only (a monospace span around the user id; local roles
kept until the server's list shows them, and a `router.refresh()` after a save). No new input, no new call, no new
data shown; the server action and the database function are unchanged. Same result.

| Threat | What stops it | Proof |
|---|---|---|
| A rep (or manager) makes themselves or anyone an admin | `public.set_user_role` (core schema, SECURITY DEFINER, accepted Day 1) checks `private.is_admin()` from the caller's own JWT first; the page's `requireAdmin()` only hides the screen | `rls_attack.sql` "rep promoted self"; e2e `rep_cannot_see_or_reach_team` replays the admin's own server-action request with the rep's session: answer `forbidden`, role and audit log unchanged |
| An admin without a fresh code changes a role | the database's `has_recent_aal2(600)`; the action's pre-check (`stepUpSecondsLeft(claims) > 0`, read from the verified JWT) can only refuse earlier, never allow | `rls_attack.sql` (code 660 s old, no code time); e2e `stale_code_asks_for_a_code` |
| Another organisation's person | `set_user_role` answers P0002 for a user outside the caller's org (screen: "no longer in your team") | `rls_attack.sql` "changed a role in another org" |
| The last admin removed (lock-out) | `set_user_role` locks the target's row and counts the organisation's admins before the update (see Residual for two admins stepping each other down at the same instant) | `rls_attack.sql` "removed the last admin"; e2e `last_admin_refused` |
| Mass assignment / extra fields (`org_id`, `target_user`) | `roleChangeInput` is a Zod `strictObject({ userId: uuid, role: enum })`; the RPC gets two named args built from it | unit `refuses … any extra field`; e2e replay with `org_id` added answers `invalid` |
| SQL / filter injection | no user text reaches a filter string: the only filters are `.eq("id", claims.sub)` (verified JWT) and the RPC's typed args | code read |
| Error text leaks database detail | `roleChangeError` reads SQLSTATE and hint only; the 42501 cause is worked out from the caller's own role and the token's code time, never from the message | unit `refusals of set_user_role` |
| An oracle on other people (does user X exist?) | the function checks admin before looking up the target, so a non-admin gets `forbidden` for every id | code read (order in the core schema) |
| Cross-site request | Next.js server actions refuse a foreign Origin (proved for this app in `day4-security.spec.ts` `cross_site_action_refused`) | existing test |
| XSS through a name | names render as React text; no `dangerouslySetInnerHTML` | code read |
| Data shown | admins only (page 404s for others; RLS keeps `profiles` to the caller's org): name, role, account date, first 8 characters of the user id. No email (it is in `auth.users`, read neither with the service key nor through a new definer function) | code read |

Residual (not vulnerabilities):
- **Two admins demoting each other at the same instant** (existing function, not changed here): `set_user_role` locks
  only the target's row, then counts admins. With exactly two admins, A demoting B and B demoting A in the same
  moment each lock a different row and each count 2 admins, so both can commit and leave the organisation with no
  admin (recovery then needs SQL in the dashboard). Needs two admins acting within milliseconds of each other; with
  three people it is very unlikely. Fix (a migration, outside this screen's scope): lock every admin row of the
  organisation (`select … where org_id = caller_org and role = 'admin' for update`) before counting, plus a
  concurrency test. Recorded as an open risk in `README.md` and `docs/log.md`.
- the Supabase advisor's existing WARN on `set_user_role` (SECURITY DEFINER executable by
`authenticated`, accepted Day 1: it must update `profiles.role`, which `authenticated` has no grant for); the action
reads the caller's role once more after a 42501 to word the refusal (one extra query on a refusal only).
