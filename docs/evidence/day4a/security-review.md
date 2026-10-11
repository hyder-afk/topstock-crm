# Security review: Day 4a activity hardening, 11 Oct 2026

Scope: PR #13 on its final code head **4137fef** (`git diff origin/main..4137fef`). The code change is the migration
`supabase/migrations/20261011120000_activity_hardening.sql`. The rest is tests, test scripts, the db workflow, and
documents. There is no app (`src/`) change. Checked against CLAUDE.md SECURITY, Master Plan section 8 (A to F), and
the Day 4 design's threat table (`docs/evidence/day4/design.md` section 6).

## How

1. **`/security-review`** on 4137fef. Following the skill, one sub-task looked for high-confidence vulnerabilities.
   Its prompt listed every PostgREST path (direct writes with the granted columns, upserts, RPCs) and each kind of
   caller: same org or another, aal1 or aal2, rep, manager or admin. A false-positive filter was to run per finding,
   but none was needed. **Result: no high-confidence vulnerability found.**
2. **Review workflow** (before the fix rounds). Three reviewers (security and RLS, database correctness and
   concurrency, test quality) were each checked by a skeptic: 12 findings confirmed, none a security hole. One was
   an integrity gap (a contact moved to another lead, below). The others were weak or missing tests, a concurrency
   bug in the last-activity rule, and C1 control characters. All were fixed in review round 1 and verified by an
   independent verifier ("ALL FIXED"). Round 2 handled the verifier's notes (lock order, flood window, one more
   probe).
3. **Advisor round 1** read the whole migration against the Day 3a and 3b definitions it replaces. It found the
   database work sound; its requests were evidence only (this file among them).

## What the `/security-review` sub-task checked

| Area | Result |
|---|---|
| Column grants | activities: insert `company_id, contact_id, type, outcome, body, request_id`; update `body` only. Tasks: the design's whitelist. `id`, `user_id`, `created_by`, `created_at`, `prev_last_activity_at`, `edited_at`, `completed_by`, `deal_id` and `org_id` cannot be written. Upserts cannot get round it: merging needs `id` (no insert grant) or UPDATE on columns other than `body`, and `on_conflict=user_id,request_id` cannot match the partial unique indexes |
| Trigger order | activities: `activity_date_lock` → `activity_guard` → `enforce_org_and_owner` → `set_activity_time`. Tasks: `enforce_org_and_owner('assignee_id')` → `set_updated_at` → `task_guard`. On insert the author is the caller, for managers too. On a task update a rep still cannot change the assignee |
| `pg_trigger_depth() > 1` exception | Only foreign-key actions (ON DELETE SET NULL from contacts, deals, profiles, activities) reach depth 2 on these tables. No trigger in the schema runs DML on activities or tasks, and RPCs do not raise the depth. The exception lets only the listed foreign-key columns go to null, with every other column equal. A client cannot use it |
| SECURITY DEFINER triggers (`lock_activity_lead`, `untouch_company_activity`) | `search_path = ''`, qualified names, static SQL, no user text; execute revoked; trigger-only. `untouch` writes only `last_activity_at`, from values the server set. `lock_activity_lead` reads and changes nothing |
| Sessions with no `auth.uid()` | Only service_role, superuser or migrations reach this. Supabase's authenticated JWTs always carry `sub`, and `set_config` is not reachable through PostgREST (only `public` is exposed). Same model as Day 3a and 3b |
| Policies | `activities_insert` and `activities_update` are stricter than before: no manager exception, and the author edits only their own entries. Tasks select, insert, update and delete follow D11 with an org check everywhere; delete needs `has_recent_aal2(600)`. Parent checks run under the caller's RLS. The restrictive `require_mfa` policy is still on both tables |
| Errors and logs | A constant-message pre-check runs before every CHECK a client can reach. RLS WITH CHECK runs before constraints, so foreign-key and contact-needs-lead failures surface as RLS errors, never "Failing row contains …". Unique-index errors show only the caller's own values |
| Audit (D8) | Activity text is no longer copied into `audit_log` (insert: no row; edit: lengths; delete: the row without its text, plus its length). The audit log stays admin-only |
| `lead_import_untouched` | Still INVOKER; its callers are admins, who see every task |
| CI and scripts | `db.yml` runs on `pull_request` (not `pull_request_target`) with `contents: read`, `persist-credentials: false` and actions pinned to commit SHAs; the `postgres:postgres` login is for the throwaway local container. The test scripts are local tooling with no outside input |

## Design threat table re-checked for 4a

Rows from design section 6 that 4a delivers. The rest (outcomes, undo, queue, claims, files, Storage, signed URLs, UI)
belong to 4b, 4c and 4d. Tests are in `supabase/tests/activity_attack.sql` (sections named) and
`activity_concurrency.sh`. Each protection was also removed in turn and caught (`mutations.md`: 102 of 102, plus 2
documented two-layer rows whose combined removal is caught).

| # | Threat | 4a control | Proved by |
|---|---|---|---|
| 1 | Stolen aal1 session | restrictive `require_mfa` on activities and tasks (unchanged) | section 1 |
| 2 | Another org | `org_id = current_org_id()` in every new policy; `enforce_org_and_owner` | section 14 |
| 3 | Logging as someone else (G1) | guard forces `user_id`; no manager exception; no `user_id` grant | section 2 |
| 4 | Rewriting history (G2) | update grant on `body` only; guard refuses any other change; author-only update policy | section 3 |
| 5 | FK actions blocked by the guards, or used to smuggle changes | exception only at depth > 1, FK columns to null, all else equal | section 8, plus the depth-2 probe (four refused statements, two allowed) |
| 6 | Back- or forward-dating the last activity | `prev_last_activity_at` set by the trigger, no grant; the definer trigger uses only it; the lead is locked on insert and on delete | section 9; `activity_concurrency.sh` cases 1 and 2 |
| 7 | Forging task server columns (G3) | column grants; the guard sets `created_by`, `done_at`, `completed_by`, `cancelled_at` | section 10 |
| 8 | Skipping the fresh code to delete | `has_recent_aal2(600)` in `activities_delete` (unchanged) and `tasks_delete` | sections 10, 11 (and the bare-DELETE probe) |
| 10 | Double submit or replay | `request_id` unique per author | section 7 |
| 29 | Personal data in logs | constant pre-checks before every reachable CHECK | sections 4, 5 |
| 30 | Copies of notes in the audit log | D8 audit rules | section 12 |
| 31 | Lost history (G5, G7) | contact and deal FKs set null; import "untouched" includes tasks | sections 8, 13; `import_fk_coverage` |
| 32 | Flooding | 60 activities and 60 tasks per minute per person, one-minute window | section 6 (seeds at -59 s and -61 s) |

Lock order (no deadlock with 4b's `log_activity`): `activity_concurrency.sh` case 3 (mutation row 102 ends in
"deadlock detected").

## Residual risks (accepted or handed on)

- **Note text can be wiped without a fresh code** (D8 trade-off, noted by `/security-review`, below its bar). An
  author's own entries can be emptied with a plain aal2 session. They are marked "edited", but the old text is not
  kept anywhere: the audit log keeps lengths only (Haider accepted on 11 Oct, Day 4 open question 13). Deleting still
  needs a fresh code. To revisit if edits need a recoverable copy or step-up.
- **`lock_activity_lead` runs before RLS checks the new row** (advisor note; excluded by `/security-review` as
  denial of service only). An insert from an aal1 session or another org can briefly lock a company or contact row by
  id until its statement fails. Nothing is read or leaked. Carried to 4b: return early when the caller is not aal2 or
  the lead is not in the caller's org.
- **A contact moved to another lead** keeps its entries and tasks on the first lead, still naming it. This is an
  integrity gap, not an escalation: both leads are visible to the team and editable by whoever moved the contact.
  4c's planned contacts trigger (design 3.3) handles it. Until then 4b code must not assume an entry's contact is on
  the entry's lead.
- **The flood guards work per transaction snapshot.** Two parallel sessions of the same person can together pass 60
  a minute. A hard quota comes with the Gate 1 rate-limit table.
- **Maintenance sessions** (no signed-in user) are trusted with the previous date they give.
- **Two bulk deletes over several leads in opposite orders can deadlock.** PostgreSQL cancels one (40P01); the app
  writes one entry at a time.
- **CI runs PostgreSQL 17, local runs use 16.15.** Every protection runs in CI's `rls` job on the Supabase image.
- **Semgrep runs only in CI.** semgrep.dev is blocked in this session.
