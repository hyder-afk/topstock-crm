# Two-user attack test, steps 1 to 8: one run, step-to-test map (Day 7d)

The steps are Master Plan section 8, "Two-user attack test (before every release)". One command runs them all on a
throwaway local stack (Supabase Auth built from source, PostgreSQL 16, the PostgREST stand-in, a production build of
the app; fake people `@example.test`, fake data):

```
set -a; . /tmp/day7d-builder/auth/env; set +a
PLAYWRIGHT_BASE_URL=http://localhost:4100 DB_TEST_PORT=54669 PW_CHROMIUM_PATH=... bash scripts/gate1-run.sh
```

`scripts/gate1-run.sh` = (1) `scripts/db-test.sh`: every SQL attack file, the concurrency scripts, `gate1_attack.sql`
and the advisors; (2) Playwright, Chromium: `tests/auth/gate1.spec.ts` plus every existing spec named below; (3) the
signed-out spec and the unit route inventory. New tests were written only where no existing test covered a step; they
are all in `tests/auth/gate1.spec.ts` (one run, its own Rep A, Rep B and Admin) and `supabase/tests/gate1_attack.sql`.
Results: section "The run" below. CI (real PostgREST, real Supabase Postgres, storage-api) runs the same files when
billing is back; the checks that only real PostgREST can answer (table POST and DELETE, the private schema header) are
marked "CI" and are skipped by the local stand-in, never faked.

## Map

| Step | What the step asks | Test file : test (new in bold) | Result |
|---|---|---|---|
| 1 | Create Rep A, Rep B and Admin in dev with fake data | **`gate1.spec.ts` : `step1_three_people_fake_data`** (three people with authenticators, roles rep/rep/admin, Rep B's lead, contact, deal, task, entry; Rep B sees their own deal) | pass |
| 2 | As Rep A, take Rep B's lead/deal/task/file id: read, edit, delete via the UI, a direct URL and direct API calls | **`gate1.spec.ts` : `step2_direct_api`** (deal and task unreadable; PATCH on lead, contact, deal, task, entry; DELETE on real PostgREST; 15 RPCs from `update_lead` to `undo_activity`; database unchanged after each; Rep B's own call works) | pass |
| | | **`gate1.spec.ts` : `step2_app_routes_and_urls`** (`/api/deals/<B>` = 404 as for a missing id; lead tabs and Tasks never list Rep B's deal or task; Rep B's lead page by direct URL holds neither) | pass |
| | | `day5-security.spec.ts` : `rep_get_other_deal_404`, `rep_direct_rpc_team_scope_403`; `day4-security.spec.ts` : `rep_direct_rpc`, `rep_direct_rpc_scope_403`; `leads.spec.ts` : "a rep reads every lead but changes only their own"; `tasks.spec.ts` : `team_scope_admin_only`; `files.spec.ts` : `rep_cannot_open_others_file, cross_site_file_request_refused` (real bytes in CI) | pass (run below) |
| | | SQL: `rls_attack.sql` sections 3, 3a to 3d, 4; `deals_attack.sql` section 3; `files_attack.sql` sections 6, 7; `stock_attack.sql` section 1; `sales_attack.sql` sections 2 to 4; `share_attack.sql` sections 2, 3 | pass |
| 3 | Call every table with only the anon key; expect empty or denied | **`gate1.spec.ts` : `step3_anon_key_every_table`** (every table and view in `public` read from the catalog: GET and PATCH refused, POST and DELETE on real PostgREST; every function in `public` called with all its arguments: 401/403, only the two share functions answer; the private schema not served (CI); an aal1 token reads nothing anywhere) | pass |
| | | `rls_attack.sql` section 1 (catalog sweep: no anon privilege on any table, view, sequence or function in `public` and `private`, live SELECT/INSERT/UPDATE/DELETE refused); **`gate1_attack.sql` G1 to G5**; `share_attack.sql` section 2 `anon_executable_functions_exact`; `import-security.spec.ts` : "the import functions refuse the public key alone"; `day4-security.spec.ts` : `private_tables_not_exposed` | pass |
| 4 | Try to change your own `role` or `owner_id` | **`gate1.spec.ts` : `step4_role_and_owner_tamper`** (own role and org through REST, `set_user_role` on self and on Rep B, Rep B's lead/deal/task owner through REST and RPC, own lead to Rep B or another org, open a deal or a task for Rep B) | pass |
| | | `day7a_attack.sql` A1 to A3 (owner in the same organisation, every path); `rls_attack.sql` section 3a (server columns); `team.spec.ts` : `rep_cannot_see_or_reach_team`; `deals_attack.sql` section 3 | pass |
| 5 | Oversized, malformed and script-laden input to every form | **`gate1.spec.ts` : `step5_bad_input_every_api`** (every route under `src/app/api`, read from disk: malformed ids, 10,000-character and markup queries, `),id.eq.` filters; to every POST route malformed JSON, a 2 MB body, a form post, markup with `owner_id`/`org_id`/`role`: never a 5xx, codes only, JSON only, nothing reflected) | pass |
| | | **`gate1.spec.ts` : `step5_script_in_text_fields_renders_as_text`** (markup in a lead's name and city, a contact's three name fields, a task title and a product name, shown as text on the lead page, the leads list, Tasks and the product page; nothing runs, no dialog) | pass |
| | | `lead-page.spec.ts` : `note_edit_marks_edited, xss_note_is_text`; `pipeline.spec.ts` : `xss_deal_title_is_text`; `files.spec.ts` : `files_list` (names as text); `day4-security.spec.ts` : `error_copy_has_no_sql`, `cross_site_action_refused`; `day5-security.spec.ts` : `error_copy_has_no_sql`, `cross_site_move_action_refused`; `leads.spec.ts` : "the leads API refuses signed-out and bad requests"; server actions: **`tests/unit/route-inventory.spec.ts`** (Zod on every action's input) | pass |
| 6 | Upload a disguised file | `files.spec.ts` : `too_big_rejected_before_upload, renamed_exe_rejected, docm_renamed_docx_rejected` (local); CI with storage-api: `direct_api_html_as_pdf_refused_at_open`, `signed_upsert_overwrite_after_ready_refused`; `files_attack.sql` sections 4, 5, 10; `tests/unit/file-sniff.spec.ts` | pass locally; storage parts CI |
| 7 | Hit login, reset and search 100 times quickly; expect throttling | Search and lists: `day7a.spec.ts` : "the search and list APIs answer 429 after 300 requests a minute, for that person only" (the limit is 300 a minute per person, residual R1); database floods: `deals_attack.sql` section 15, `share_attack.sql` section 6, `day7a_attack.sql` B4 (sign-in rows 30 an hour), entries and tasks 60 a minute (`activity_attack.sql`) | pass |
| | | Login, reset, two-factor: Supabase Auth's per-IP limits (`supabase/config.toml [auth.rate_limit]`: 30 sign-ins and 30 verifications per 5 minutes, one e-mail a minute). Not reproducible locally: GoTrue applies its limits only behind the platform's rate-limit header, which the hosted service sets (`internal/api/middleware.go`, read 16 Oct). `journey.spec.ts` : "an unknown address gets the same answer as a real one" | hosted only; Day 1 residual 2 (one shared bucket behind Vercel); Day 8 Firewall rule |
| 8 | Update `stock_levels` directly and reserve more than is available; both refused | **`gate1.spec.ts` : `step8_stock_levels_direct_and_over_reservation_refused`** (PATCH as a rep and an admin, POST and DELETE on real PostgREST; 6 asked of 5: `over_reservation`; 5 then a sixth refused; taking out 6 refused) | pass |
| | | `stock_attack.sql` section 0 (`stock_levels` read-only for every role), section 3 (`no_negative_stock`, `no_over_reservation`); `stock_concurrency.sh` : `twenty_reservers_one_product` (20 sessions, exactly 10 succeed) | pass |

Also in `gate1.spec.ts` for section 8: `item2_repository_files_not_served` (signed in, `/.env` and eight other repository
paths: 404, no contents) and `item45_admin_pages_by_direct_url` (rep gets the not-found page, signed out goes to sign-in, admin gets the screen).

## Do the new tests catch what they guard? (planted breaks)

Each break was applied to the throwaway stack or build, the test run, then reverted (and the revert checked).

| Planted break | Test | Result |
|---|---|---|
| `authenticated` may UPDATE `stock_levels` (grant plus an always-true policy) | step 8 | caught ("refused") |
| Every teammate may update every lead (`companies_update` without the owner check) | step 2 | caught ("companies PATCH changed nothing") |
| `profiles.role` updatable by `authenticated` | step 4 | caught (Rep A became admin) |
| anon may read `public.orgs` (grant and an open policy) | step 3 | caught (`orgs: [{"id": …}]`) |
| A public function anon may execute (planted, reads nothing private) | step 3 | caught (`planted_anon: 200`) |
| anon may execute `public.get_lead` (also with USAGE on schema `private`) | step 3 | not caught, correctly: the function still needs private functions anon cannot run, so the call is refused (401) by the next layer; the planted function above is the case with no second layer |
| `/api/deals/[id]` answers the database's error text | step 5 bad input | caught ("invalid input syntax for type uuid" matched the no-database-text rule) |
| The lead heading renders the name as HTML (`dangerouslySetInnerHTML`) | step 5 script | caught (the name is no longer shown as text; the nonce CSP is the layer that also stops the inline handler) |

Step 3's RPC sweep has met only the local stand-in, never real PostgREST: there an overloaded function name called
with null arguments may answer 300 (`PGRST203`, ambiguous) instead of 401, which the test would count as a failure
until the sweep names the overload (README condition (c)).

The first versions of step 3 passed every break vacuously: an empty RPC body only reaches "no such function" (404), and
the local stand-in answers 400 to `limit=`; both were fixed (all arguments passed as null, no `limit`, any 400 "LOCAL"
answer now fails the test) before the results above.

## The run

**Final run: `day7d-local` acc33dc, with Day 7c's final head f6f1f3f merged.** Fresh throwaway stack (new database
with all 21 migrations, new keys, a new production build): PostgreSQL 16 on 54650, Supabase Auth on 9988, gateway on
54651, `next start` on 4100, Chromium 141; `db-test.sh` on 54669. Trimmed output (every test line and every suite's
pass line): [`gate1-run-output.md`](gate1-run-output.md).

| Part | Result |
|---|---|
| 1. SQL: `db-test.sh` | exit 0: every attack file and concurrency script passed, including Day 7c's `sweeper_attack` and `gate1_attack` (with Day 7c's three INVOKER, service-role-only sweeper functions the reviewed DEFINER list holds); advisors 0 ERROR (WARN `share_view`, `share_request`, `set_user_role`, all accepted) |
| 2. Playwright, Chromium, one worker, 12 files | **99 passed**, 5 skipped (storage-api, CI), 1 failed + 2 not run: `files.spec.ts` "hidden tab … a file dropped outside the zone never leaves the page" read the drop guard before it was attached. Day 7c changed no files code; the test passed in the first run and alone on this build 3 of 3 times, and the whole `files.spec.ts` then passed (13 passed, 5 storage skips). Recorded as a timing flake under load |
| 2. `journey.spec.ts` mail-free tests | **2 passed** (the full journey needs a mail inbox: CI) |
| 3. Signed-out spec | **22 passed** |
| 3. Unit: route inventory and file sniffing | **18 passed** (the route inventory now has 10 tests) |

Earlier runs, kept as history:
- **Run 1** on ef2b74c (before Day 7c): SQL exit 0; Playwright 102 passed, 5 storage skips, `journey.spec.ts` stopped
  at its first test (no mail inbox) with its other 4 not run, its 2 mail-free tests then passed alone; signed-out 22;
  unit 13.
- **Run 2** on e58485b (Day 7c at 549191c) on the *reused* stack: SQL exit 0; Playwright 85 passed, 2 failed, 15 not
  run, both failures from the stack having run once already: `day7a.spec.ts` creates a fixed address
  (`d7a-audit@example.test`, "email_exists"), and `inventory.spec.ts` seeds its catalogue once per stack while
  `leads.spec.ts` had cleared every stock level. These specs expect a fresh stack (as CI's is); run 3 used one and both
  passed.

Every step in the map has its tests in this run, apart from what only CI or the hosted service can show: real-bytes
file checks (storage-api), real PostgREST's POST/DELETE and private-schema answers, the full sign-in journey, and
Supabase Auth's own login and reset limits.
