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
