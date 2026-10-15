# Security review: Day 4c Tasks page and work queue, 12 Oct 2026

Scope: everything on `day4c-local` since `main` a7aa89e, with this file written for the third review round (the
verifier's round 2 and the 24 confirmed review findings): the migration
`supabase/migrations/20261013090000_tasks_queue.sql`, the queue and task server actions and routes, `src/lib/queue.ts`,
`src/lib/http.ts`, `src/lib/tasks.ts`, the queue and Tasks components, the toast and call panel changes, and the tests.
Checked against CLAUDE.md SECURITY, Master Plan section 8 (A to F) and the Day 4 design's threat table (section 6).
Check results and commits: `README.md`.

How: the builder re-read the round's diff (7b3fa92 to the head named in the README) against each rule below and named
the test that proves it. The `/security-review` command was started from this session, but it reviews the session's
own checkout (the main checkout's branch, documentation only), not this worktree; so the same review (input
validation, authorisation, injection, data exposure, secrets) was done by hand on this branch's diff. Result: **no
finding at medium or high confidence.**

## This round's changes, re-checked

| Change | Security reading | Proof |
|---|---|---|
| Claim guard refuses renewing a claim on a lead the caller may no longer claim (42501 `scope`); `renew_claims` and `claim_next_lead`'s keep path let such a claim go | Tightens threat 13 ("nobody can lock a teammate out of their own leads"): the insert rule now holds for the claim's whole life. Constant error text, no lead data | `queue_attack` 9b (direct renewal refused, keep path drops it, `renew_claims` answers null, the new owner claims at once); mutation rows 88 to 91 |
| A lead's claim row changes only under its advisory lock (`'queue_claim:' \|\| lead`); the walk only tries it and skips | The key is built from a UUID typed value, never from user text; static SQL, no `EXECUTE`/`format()` (the `queue_attack` section 0 rule still passes). Transaction-scoped locks only: nothing outlives a request; PostgREST exposes no `pg_catalog` lock function, so a client cannot hold one | `queue_concurrency` 11 (crossing orders, 20 rounds, no failure; a held lead lock is skipped at once); mutation row 92 |
| The walk also skips a lead deleted mid-claim (`foreign_key_violation`) | Before, the whole call failed with a generic error; no data shown either way | read in review |
| Queue sessions: answers for an earlier run let their new claims go (`release_claims`, own claims only, at most 3) | Client logic; the database keeps deciding (own claims only, the delete policy) | e2e `stop_while_in_flight` |
| U waits for the latest outcome's save; the queue owns U (`data-owns-undo`) | Undo still goes through `undo_activity` (owner, 2 minutes, database-checked); the change only picks which entry | e2e `undo_latest_outcome`, `undo_on_empty_screen and queue_owns_u` |
| Not-saved outcomes retried from `sessionStorage` on Start, Retry and `online` | Same request (replay-safe request id, Zod strict on the server, same-origin JSON route); the stored item is validated by `pendingShape` before use; never claims | e2e `not_saved_in_every_phase`, unit `queue.spec.ts` |
| Cache refresh after outcomes and undo (`refreshLead`, `refreshTasks`), after a time zone save (`["tasks"]`) | Reads only, through the existing routes and RLS | e2e `caches_after_outcome` |
| Toast `quiet` option and `data-toast` hook | Presentation only; message text is still React text (no HTML) | e2e queue specs |
| Queue skeleton renders its own translated words invisibly | Messages only, no user data; `aria-hidden` | screenshots |
| Tasks: `cancelQueries` before optimistic removal; Enter never ticks; picker focus; check state on a restored row | Client behaviour only; every write still goes through `setTaskDone`/`setTaskCancelled`/`deleteTask` (Zod, aal2, RLS, step-up for delete) | unit `tasks-cache.spec.ts`; e2e `failed_toggle_reverts`, `enter_on_task_without_lead`, `lead_picker_focus` |
| Messages: U+237D replaced; no-break spaces in key hints | Text only | unit `messages.spec.ts` |

## Standing checks (whole Day 4c)

| Area | Result |
|---|---|
| Server actions and routes | Zod `strictObject` first, then `requireSession()`/`apiSession()` (aal2), RPC arguments named one by one; the POST routes check the origin (`assertSameOrigin`), JSON content type and size; answers are codes and hints only, `Cache-Control: private, no-store` |
| Database functions | All Day 4c RPCs SECURITY INVOKER, `search_path ''`, static SQL, revoked from `public` and `anon` (checked by `queue_attack` section 0); `private.queue_claims` has no API endpoint, RLS with `require_mfa`, insert names only the lead, update only the end |
| Filter strings | No user text in `.or()`/`.filter()`; the lead picker's search travels as a function argument of the leads list RPC |
| HTML and logs | No `dangerouslySetInnerHTML`, `innerHTML` or `eval`; no `console.*` in `src` |
| Secrets | No keys; fake data and local passwords in tests only; gitleaks and `npm audit` results in `README.md` |

## `/security-review` on the PR head (PR #15, head 55a8de8, 12 Oct 2026)

Run by the lead builder on the main checkout at the PR head (`git diff origin/main...HEAD`), as the advisor asked;
it replaces the earlier note that the command could not see this worktree. Method as the command sets it: one
finder pass over the whole diff, then a false-positive filter per finding, keeping only confidence 8 or more.

**Result: no findings** (nothing at high or medium; the filter step had nothing to filter).

What the finder checked, in short:
- `private.queue_claims`: not exposed (`schemas = ["public"]`), RLS with `require_mfa`, insert only on leads the caller
  may change with `(company_id)` granted, update only `(expires_at)` on own claims, delete own or expired claims;
  `claim_guard` sets org, user and times on the server, refuses a renewal once the lead changed hands, caps 3 live
  claims under a per-person lock.
- Every new RPC: SECURITY INVOKER, `search_path ''`, static SQL, `auth.uid()` and aal2 checks, fixed value lists,
  scopes beyond `mine` need manager or admin (repeated inside `private.queue_candidates`), revoked from `public` and
  `anon`; `delete_task` needs `has_recent_aal2(600)`; `update_task` cannot reassign for a rep
  (`enforce_org_and_owner`) and a contact must belong to the task's lead; `set_my_timezone` checks
  `pg_timezone_names` and touches only the caller's profile.
- New return values (`queue_card`, `get_lead.worked_by`, `list_tasks`) read under RLS; nothing beyond the caller's
  existing read scope or from another organisation.
- DEFINER: only the trigger-only `sync_contact_phone` (new) and `audit_row` (redefined), execute revoked;
  `has_contact_phone` has no grant, `call_zone` and `queue_rank` are generated.
- `log_activity`: same signature as 4b; FOR NO KEY UPDATE still applies the UPDATE policy; it deletes only the
  caller's own claim.
- Dynamic SQL: only `call_zone_keys()` from the zone-map functions and the grant loop; no user input.
- Actions and routes: Zod `strictObject`, `requireSession()`/`apiSession()` (aal2), named RPC arguments, codes only;
  POST routes check the origin and require `application/json` (a cross-site page needs a preflight), so no CSRF;
  GET routes read-only, aal2, Zod, no-store.
- Client: no `dangerouslySetInnerHTML` or `eval`; `callHref` keeps digits and `+` only; `sessionStorage` holds only
  unsent outcomes and the caller's own counts. Scripts and `db.yml` add local test steps only.

## `/security-review` on the PR head again (PR #15, head c06aed2, 14 Oct 2026)

Run on the delta since the run above (`git diff 55a8de8..c06aed2`: the four CI-fix commits 875e8be, 5ff57c8, 13a5652,
c06aed2), with the whole PR as context, as the advisor asked. Same method: a finder pass, a false-positive filter per
finding, confidence 8 or more kept.

**Result: no findings.** The delta is client code, tests and docs only; the release route, `src/lib/http.ts`, the
proxy and the migrations are unchanged.

What was checked, in short:
- The release beacon: fixed same-origin URL, body only `{ ids }` (at most 3 card ids), Blob type `application/json`;
  the keepalive request is the fallback with the same body.
- The route still applies every check to the beacon: `assertSameOrigin` (Origin, or `Sec-Fetch-Site: same-origin`),
  `apiSession()` (aal2), `readJsonBody` (JSON only, 32 KB on the header and the bytes read), Zod `strictObject` with
  UUIDs (max 3), `release_claims` (own claims only), codes only and `no-store`.
- CSRF: a cross-site beacon or form post fails the origin check (403), and a form cannot send JSON (415). At worst a
  forged request could release the victim's own claims, with nothing read back.
- The tel:/mailto:/sms: click listener only reads the href's scheme and stores a timestamp; ignoring a beforeunload
  within 1 s of it affects only when claims end (pagehide still releases; otherwise they expire in 10 minutes), not access.
- Focus and scroll changes use a static `data-queue-panel` selector; no user data reaches a selector or the DOM.
- No `dangerouslySetInnerHTML`, `innerHTML` or `eval` in `src`; no user text in PostgREST filters; no new logging,
  secrets or env access.
