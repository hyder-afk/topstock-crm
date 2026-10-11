# Day 4a: activity hardening (database only), 11 Oct 2026

Design: `docs/evidence/day4/design.md` (sections 1, 2, 3.1, 6, 8.1 to 8.3, 8.6, 10 "4a Activity hardening"). Branch
`claude/busy-darwin-xech8m`. No screen changes.

## What changed

**Migration `supabase/migrations/20261011120000_activity_hardening.sql`** (dev had 0 activities, tasks, files, companies
and contacts before it: read-only check, `docs/log.md`)

- **Activities.** New columns `request_id`, `edited_at`, `prev_last_activity_at`. The outcome must fit the kind of entry
  (`activities_outcome_fits_type`); text has tab and line feed as its only control characters and no bidi overrides
  (`activities_body_safe`). Indexes: `activities_company_keyset_idx (company_id, created_at desc, id desc)`,
  `activities_user_created_idx (user_id, created_at desc)`, unique `activities_author_request_idx (user_id, request_id)`;
  the three old ones go. Contact and deal FKs are now `on delete set null`. Clients get `insert (company_id, contact_id,
  type, outcome, body, request_id)` and `update (body)` only.
- **`private.activity_guard()`** (INVOKER, BEFORE INSERT OR UPDATE, skips sessions with no signed-in user):
  - insert: the author is the caller (G1); `edited_at` empty; `prev_last_activity_at` set (D9); CRLF becomes LF;
    constant-message pre-checks (hints `outcome`, `body_too_long`, `body_chars`); at most 60 entries a minute
    (`rate_limited`);
  - update: a referential SET NULL (depth > 1, only `contact_id`, `deal_id`, `user_id` emptied) passes; otherwise only
    the text may change (42501 `not_editable`), `edited_at` is set when it does, and the text rules run again.
- **Policies.** `activities_insert` without the manager exception (author = caller, contact on the same lead);
  `activities_update` for the author only. Select (org-wide) and delete (fresh code; author, manager or admin) unchanged.
- **D9, `private.untouch_company_activity()`** (DEFINER, AFTER DELETE, revoked): when the deleted entry set the lead's
  date, the date goes back to the newest remaining entry or the date from before the entries, whichever is later.
- **Tasks.** New columns `company_id` (cascade with the lead), `kind`, `due_date`, `created_by`, `completed_by`,
  `cancelled_at`, `source_activity_id` (set null), `request_id`; contact FK `on delete set null`; CHECKs
  `tasks_one_due`, `tasks_meeting_timed`, `tasks_not_done_and_cancelled`, `tasks_contact_needs_lead`,
  `tasks_title_safe`; indexes on the lead, the creator (with time), the source entry and `(created_by, request_id)`.
  Clients get `insert (company_id, contact_id, title, kind, due_date, due_at, assignee_id, source_activity_id,
  request_id)` and `update (title, due_date, due_at, assignee_id, contact_id, done_at, cancelled_at)` only.
- **`private.task_guard()`** (INVOKER, runs after `enforce_org_and_owner`): insert forces the creator, empties done,
  completed by and dismissed, makes an empty assignee the caller, pre-checks kind (`task_kind`), the source entry (the
  caller's own, same lead, under 10 s: 42501 `source`), 60 tasks a minute, the title (`task_title`), date shape
  (`task_due`) and range (`bounds`); update passes referential SET NULLs, lets only the granted fields change (42501
  `not_editable`), makes done and dismissed switches with server times and `completed_by`, refuses both at once
  (22023 `state`), and checks title and dates only when they change (overdue tasks stay editable).
- **Task policies** `tasks_select`, `tasks_insert`, `tasks_update`, `tasks_delete` replace `tasks_rw`: the assignee,
  the creator, managers and admins (D11); writes point only at a lead of the org and a contact of that same lead;
  delete needs a fresh code.
- **D8 audit.** `private.audit_row` keeps no copy of activity text: no row for a new entry, `{changed, old_len,
  new_len}` for an edit, the old row without its text plus `body_len` for a delete.
- **Import undo (G7).** `private.lead_import_untouched` keeps leads with a task.
- **Files:** unchanged here (design 3.1 has no files part; G4 and the files G5 move to 4d, with `files.contact_id`).

**Tests and scripts**

- `supabase/tests/activity_attack.sql` (new; in `scripts/db-test.sh` and `.github/workflows/db.yml`): the design's 8.1
  cases for 4a, each protection with at least one check that fails when it is removed (proved by mutations).
- `supabase/tests/rls_attack.sql`, `import_attack.sql`: fixture tasks name their lead; the rep's call has an outcome and
  no deal; a client-sent activity time is now refused (42501; the trigger layer is proved in `activity_attack.sql`);
  section 3b updates a task's title; `import_fk_coverage` expects `{activities, contacts, deals, tasks}`; the admin's
  call in the undo test names no author. Every earlier protection is still tested.
- `scripts/db-mutations.py`: per-mutation target files, `--set day3b|day4a|all`, the Day 4a list.
- `supabase/tests/perf_day4.sql` (new, part 1) and its `scripts/db-perf.sh` hook.
- `docs/evidence/day4a/spike-s5/`: spike S5 script and output.

**App code:** nothing in `src/` writes activities, tasks or files today (no `.from("activities" | "tasks" | "files")`,
no RPC that touches them; the lead preview's Call and Email are plain `tel:` and `mailto:` links; e2e fixtures seed only
leads, contacts and saved views), so the new grants and guards need no app change.

## Check results

| Check | Result |
|---|---|
| Spike S5 (PG 16.15) | (a), (b), (c) all hold; decisions in `docs/log.md` |
| `bash scripts/db-test.sh` | `rls_attack: all checks passed`, `import_attack: all checks passed`, `import_concurrency: all checks passed`, `activity_attack: all checks passed`, `advisors: no ERROR-level findings` |
| Advisors (splinter, local) | WARN `authenticated_security_definer_function_executable` on `set_user_role` (accepted Day 1); INFO `unindexed_foreign_keys: 1` (`activities_org_id_fkey`, accepted below); INFO `unused_index: 2` |
| `plpgsql_check` 2.7.2 (local stand-in for CI's `supabase db lint`) | no finding on any new or changed function (only the existing dynamic-SQL notes on `list_leads`) |
| Mutations, Day 4a (`docs/evidence/day4a/mutations.md`) | **64 of 64 caught** |
| Mutations, Day 3b after 4a | 36 of 37 caught, the same documented two-layer row as on 10 Oct |
| Perf (`docs/evidence/day4a/perf.md`, 3 runs) | P2 0.08–0.19 ms (budgets 5 / 8 / 10 ms), generic plans keep the keyset index; P7 import chunks avg 174–183 ms, undo chunks avg 139–158 ms (Day 3b 169–207 / 140–206 ms); P8 every Day 3a case within 20% (all faster) |
| `npm run lint` | 0 errors (2 existing warnings: TanStack Virtual and the React compiler) |
| `npm run typecheck` | passed |
| `npm run test:unit` | 166 passed |
| Playwright e2e, Chromium, restarted local auth stack (migrations re-applied; every auth suite except `screens.spec.ts`) | **44 passed**, 1 skipped (`import-perf`, runs only with `PERF=1`); `journey.spec.ts` cannot run on this VM: its first test stops at `Error: MAILPIT_URL is not set` (the local stack has no mail inbox: it auto-confirms and sends no email), so its other 4 did not run. It does not touch activities or tasks and runs in CI's `auth-journey` job, which has the inbox |
| Semgrep | not run locally: `semgrep.dev` is denied by this session's egress policy (403; known since 9 Oct, `docs/log.md`), so it runs in CI's `semgrep` job |
| gitleaks (`origin/main..HEAD`, includes the two Day 4 design and log commits) | no leaks found (exit 0; 15 commits scanned before this line was written, 16 after) |
| `npm audit --omit=dev` | found 0 vulnerabilities |

## Accepted findings

- **INFO `unindexed_foreign_keys` on `activities_org_id_fkey`.** The design drops `activities_org_user_idx`. There is
  one organisation and it is never deleted, and every activity read goes through the lead or the author index; an
  `org_id` index would cost about 9 MB a year at 300,000 entries on the 500 MB plan.

## Deviations from the design (each logged in `docs/log.md`)

1. **D9 previous date carried forward.** `prev_last_activity_at` is the lead's current date unless an entry set that
   date, in which case it is that entry's own previous date. With the literal rule, deleting an older entry and then
   the newest left the lead on the deleted older entry's time, a date with nothing behind it (what D9 exists to
   prevent). Tested (`activity_attack` section 9) and mutation row 18.
2. **A call must have an outcome in the CHECK too** (`outcome is not null and outcome in (...)`): an IN list with a
   null outcome is null, and a CHECK lets null through. Mutation row 30.
3. **`created_by` is in the task guard's referential exception.** It is a `set null` FK to profiles; without it,
   deleting a person who created any task failed with 42501. Mutation row 37.
4. **Task fields that may change are a whitelist** (the granted ones plus the derived `completed_by`), a superset of the
   design's immutable list: `created_at`, `deal_id` and `org_id` are refused as well.
5. **Done and dismissed are strict switches:** done again with another time keeps the first time (the design rewrote
   any change of `done_at` to `now()`). The client still never chooses the time.
6. **Two more constant-message pre-checks** for CHECKs a client can reach: kind (hint `task_kind`) and date shape (hint
   `task_due`: a date or a time, not both; a meeting needs a time). 4b's `db-errors.ts` maps them like the other 22023
   hints.
7. **`tasks_created_by_idx` is `(created_by, created_at)`** instead of `(created_by)`: it still serves the FK, and the
   task flood guard reads a short range instead of all of a person's tasks.
8. **`edited_at` moves only when the text really changes** (after CRLF is folded, which now also happens on edits).
9. **P2 is timed on the same static query from a plpgsql function** (`pg_temp.timeline_page`), since
   `list_lead_activities` is a 4b RPC; and `perf_day4.sql` runs before `perf_import.sql`, so P7 includes the 300,000
   activities and 15,000 tasks.

## Not done here, and open risks

- **CI differences.** CI runs the Supabase Postgres 17 image; the spike and local runs are PostgreSQL 16.15. The
  behaviours the guards rely on (spike S5 (a)) are exercised by `activity_attack.sql` in CI, so a difference would turn
  the `rls` job red. The guard-only and policy-only probes rely on `postgres` owning the tables (it bypasses RLS and
  may disable a trigger), as `import_attack.sql` already does in CI; the "person leaves" case deletes the
  `public.profiles` row, not the `auth.users` row, so it needs no grant on the auth schema.
- **Not run locally:** Semgrep (blocked, above), `supabase db lint` (needs Docker; `plpgsql_check` used instead),
  WebKit e2e (not installed; CI runs it).
- **The flood guards are per transaction snapshot,** so two parallel sessions of the same person can together pass 60 in
  a minute. They limit flooding; they are not a hard quota (Gate 1 rate-limit table, design section 12).
- **Undo preview** for a 27,000-lead import now takes 80–90 ms (was 39–45 ms); chunks are unchanged (perf.md).
- **Entries inserted by maintenance sessions** (no signed-in user) keep `prev_last_activity_at` empty; deleting such an
  entry when it set the lead's date falls back to the newest remaining entry.
- **The dev database** still has the Day 3b schema: `deploy-dev-db` applies this migration after the merge, then the
  dev advisors are re-checked (build order 4a item 11).
