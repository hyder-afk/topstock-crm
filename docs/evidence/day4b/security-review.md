# Security review: Day 4b lead page, 11 Oct 2026

Scope: everything on `day4b-local` after PR #13's head (17d0354): the migration
`supabase/migrations/20261012090000_lead_page.sql` and the zone map, the server actions
`src/app/(app)/leads/[id]/actions.ts`, the routes `GET /api/leads/[id]/activities`, `GET /api/leads/[id]/tasks` and
`GET /api/activities/[id]`, the lead page and call panel components, the libraries `src/lib/{activities,tasks,timezones,
phone,db-errors,drafts}.ts`, and the tests. Checked against CLAUDE.md SECURITY, Master Plan section 8 (A to F) and the
threat table of the Day 4 design (section 6). The final commit and the check results are in `README.md`.

How: the builder re-read the code against each threat row 4b delivers and named the test that proves it; every test
named below ran on this branch's final code (`bash scripts/db-test.sh`, `npm run test:unit`, the local Chromium auth
e2e suites; results in `README.md`). WebKit e2e and Semgrep run in CI only. The `/security-review` slash command ran
on the final head after the review round; its result is the section "`/security-review` on f2c900b" below.

## Code checks

| Area | Result |
|---|---|
| Server actions | Every action parses with a Zod `strictObject` first, then `requireSession()` (aal2 only), then one RPC with its arguments named one by one (no spread of client input, no mass assignment); answers are `{ ok, data }` or codes and hints from `src/lib/db-errors.ts`, never database text |
| Routes | `apiSession()` first (401 signed out, tested); ids through `z.uuid()`; query parameters through a strict Zod schema (unknown parameters 400); a cursor needs both parts; `Cache-Control: private, no-store`; errors are `{ error: code }` only |
| Database functions | All new RPCs SECURITY INVOKER, static SQL, values as arguments, revoked from `public` and `anon`; RLS decides visibility; `lead_guard`/`contact_guard` own the server columns; `private.activity_undo` has no API exposure |
| Filter strings | No `.or()` / `.filter()` with user text anywhere in the 4b code; the timeline filter is a whitelisted kind list passed as an RPC argument |
| HTML | No `dangerouslySetInnerHTML`, `innerHTML` or `eval` in `src`; notes, task titles and names are React text with `dir="auto"`, never auto-linked |
| CSP | No `unsafe-eval`: Zod 4's `Function("")` probe was reported as a `script-src` violation, so the browser runs Zod with `z.config({ jitless: true })` (found by `day4-security`'s CSP check) |
| Logging | No `console.*` in `src`; ESLint `no-console` now also covers `src/app/(app)/leads/**`, `src/app/api/activities/**`, `src/components/{lead,activity}/**` and the 4b libraries |
| External links | `tel:` and `wa.me` carry digits only (`dialString`); `mailto:` parts are percent-encoded with no line break in the subject; `target="_blank"` links have `rel="noopener noreferrer"` |
| Browser storage | Drafts hold note text per lead until saved; the sign-in page clears all drafts; no lead data in URLs beyond the lead's UUID, `?tab=` and `?filter=` |
| Secrets | No keys; fake local passwords in tests only; gitleaks clean on `origin/main..HEAD`; `npm audit --omit=dev` 0 vulnerabilities |

## Threat rows 4b delivers (design section 6), re-checked

| # | Threat | How 4b blocks it | Proving tests (all passed on the final code) |
|---|---|---|---|
| 1 | Stolen aal1 session | restrictive `require_mfa` on the new private table; every new writing RPC checks aal2 (42501); `requireSession` / `apiSession` in the app | `outcome_attack.sql` section 1 `day4_aal1_blocked` (every new RPC 42501 for aal1, reads empty, nothing changed; anon runs none) |
| 2 | Another org reads or changes the lead page's data | RLS `org_id = current_org_id()` under every RPC; a null `get_lead` gives the same not-found screen | `outcome_attack.sql` section 17 `other_org` (get_lead, get_activity, timeline, tasks, undo records empty; every write P0002/42501/22023); e2e `lead-page.spec.ts` "a missing lead, someone else's org id and a malformed id get the same not-found page" |
| 3 | Logging as someone else | `log_activity` has no author parameter; the 4a guard forces `user_id` | e2e `day4-security.spec.ts` `rep_direct_rpc` (a forged `p_user_id` adds nothing); 4a `activity_author_forced_for_admin` re-run in `activity_attack.sql` |
| 4 | Rewriting history | `edit_activity` changes `body` only, author only | e2e `rep_direct_rpc` (a rep's token cannot edit or delete the admin's entry: 403 `not_editable`, body unchanged); `outcome_attack.sql` section 10 |
| 5 | FK actions smuggling changes | undo and delete branches keep the 4a depth rule | `outcome_attack.sql` `undo_with_touched_task` (an edited follow-up is kept and unlinked) |
| 6 | Back- or forward-dating the last activity | undo restores the trigger-set previous date | `undo_restores_previous_date` (`outcome_attack.sql` section 6 and `activity_attack.sql`) |
| 7 | Forging server columns | `lead_guard` / `contact_guard` set `phone_wrong_at` times; column grants on the new columns | `outcome_attack.sql` section 0 (grants, guards exist, BEFORE, not executable) and `phone_wrong_time_forced` |
| 8 | Skipping step-up for deletes; stretching the undo window | `has_recent_aal2(600)` in the delete branches; no-code branch only for own entries under 120 s with no undo record | `outcome_direct_delete_refused_while_undo_record`, `undo_at_119s_ok_at_121s_denied` (`outcome_attack.sql` section 6); e2e `delete_note_asks_for_code` (code aged 15 minutes: "Confirm it's you" before the delete) |
| 9 | Undo overwrites a colleague's change | compare-and-restore per field | `undo_skips_changed_status`, `undo_skips_changed_owner` |
| 10 | Double submit or replay | `request_id` unique per author; stored result returned | `log_activity_idempotent`, `undo_twice_second_refused`, `request_id_other_author_no_collision` (section 7) |
| 11 | Outcome on a lead the caller may not change | `FOR UPDATE` only for editors; the entry is logged, nothing else | `outcome_not_editable_logs_only`; e2e `read_only_lead_logs_but_no_status` |
| 12 | Wrong-number mark on a colleague's lead | mark only in the editor branch or an editor's direct update (RLS) | `rep_wrong_number_on_others_lead_no_mark`, `rep_direct_phone_wrong_patch_zero_rows` |
| 16 | Do not contact ignored (lead page part) | outcome 7 from any status; the page hides Call, WhatsApp and Email | `dnc_from_customer` (and from Disqualified); e2e `call_panel_each_outcome` (`dnc_lead_hides_call` step). Queue part (`dnc_never_served`): 4c |
| 18 | Cool off lead back at once (entry part) | +90 days on entry without a future date | `cool_off_entry_defaults_90_days` (section 12); e2e `status_menu_cool_off_until_when`. Queue part (`cool_off_without_date_not_served`): 4c |
| 19 | Time-zone value injection | closed list per country; country change clears; constant pre-check error | `timezone_outside_country_refused`, `country_change_clears_zone`, `timezone_bad_constant_error` (planted text absent from message and detail). Profile zone (`profile_timezone_garbage_refused`): 4c |
| 26 | XSS through notes and titles | React text only; no `dangerouslySetInnerHTML`; no auto-linking; `dir="auto"` | e2e `xss_note_is_text` (`<img onerror>`, `<script>`: shown as text, no dialog) |
| 27 | SQL or filter injection | static SQL; whitelisted kinds; Zod | `bad_types_22023` (section 8); section 16 input rules |
| 28 | CSRF | Next.js server actions' Origin check | e2e `cross_site_action_refused` (replayed action with another Origin: refused, no row added, the toast has no SQL words) |
| 29 | Personal data in logs or error text | constant pre-checks before every CHECK; codes only to the client; `no-console` | `outcome_attack.sql` section 16 (constant errors); `bad_body_constant_error` (`activity_attack.sql`); e2e `error_copy_has_no_sql` (the lead page APIs answer `{ error }` only, `no-store`); ESLint `no-console` on the new files |
| 30 | Audit gaps | outcome status changes audited; next call and wrong-number marks not diffed; zone audited | `audit_outcome_status_change_logged`, `audit_queue_columns_not_diffed` (section 14) |
| 32 | Flooding | 4a's 60 per minute guards reach `log_activity` and `create_task` | `outcome_attack.sql` section 15 (`rate_limited` on the 61st entry and task) |
| 33 | External links leak the lead URL, tabnabbing | `noopener noreferrer`; digits only in `tel:` and `wa.me`; mail parts encoded | unit `dial_*`, `whatsapp_*`, `mailto_crlf_blocked` (`tests/unit/phone.spec.ts`); e2e `external_links_rel` |
| 15 (part) | Private tables exposed | `private.activity_undo` in the private schema (no endpoint) | e2e `private_tables_not_exposed` (REST: not served; `Accept-Profile: private` refused). Claims: 4c |

Not 4b: threats 13 to 15 (claims), 17 (calling hours in the queue), 20 to 25 (files), 31 (files FK) are 4c and 4d.

## Residual risks (accepted)

1. **A stolen aal2 session without a fresh code** can undo its own entries from the last 2 minutes, only through
   `undo_activity`, which puts the lead back; it can also delete entries it inserted directly in that window, which
   changed no lead (design residual 3).
2. **A lead called from its page is not claimed** (claims are 4c). The outcome's next call date keeps it out of the
   queue; at worst two calls happen minutes apart (design residual 4).
3. **Time zone data can differ** between PostgreSQL, Node (server render) and browsers (western Canada from November
   2026 is a live case). Parity tests use fixed instants; a zone missing on either side fails CI; times that depend on
   the viewer render after mount (design residual 6).
4. **Drafts** keep unsent note text in this browser's storage until saved, cleared on the sign-in page, or pushed out
   by the 50 most recent; a shared device left signed in keeps them.
5. **The follow-up task title carries the lead's name from the client** (`leadName`, Zod: 1 to 200 characters, no
   control or bidi characters; the database CHECKs the title again). A forged name changes only the wording of the
   caller's own task title, which the caller may type freely anyway; it grants nothing.
6. **The other-org e2e check uses an unknown UUID**: the local stack and CI have one organisation, so a second
   organisation is proved in SQL (`other_org`, section 17), not through the browser.
7. **A missing lead answers HTTP 200** with the not-found screen (the page streams behind its skeleton); the screen is
   the same for missing, other-org and malformed ids, so nothing is learned from it.
8. **Flood guards count per transaction snapshot**: concurrent requests in the same instant can pass 60 by a few
   (accepted in 4a).
9. **Semgrep and WebKit** did not run here (semgrep.dev blocked, WebKit not installed); both run in CI before merge.

## Verifier round (11 Oct, evening; on 08ba920)

- **Insert lock (DEFINER) narrowed.** `private.lock_activity_lead` is redefined in the 4b migration: for a signed-in
  session it returns without locking when the session has no two-factor or the entry's lead is not in the caller's
  organisation, and it locks a named contact only in the caller's organisation (sessions with no signed-in user lock
  as before). Before, any authenticated session could make the DEFINER trigger hold another team's lead or contact
  until its own insert was refused by row level security. Proved by `outcome_concurrency.sh` case 5 (a refused insert
  answers at once while another session holds that row FOR UPDATE: aal1, another organisation's lead, another
  organisation's contact) and mutation rows 88 to 90. Still trigger-only and revoked from every client role.
- **Lock order.** `log_activity` takes a contact it names before the lead in every call, the order of the merged Day 4a
  insert lock and of a contact edit; case 4 reproduced the deadlock before the fix (row 87).
- **Cross-site action replay** (threat 33's test) now first replays with the page's own Origin (200, one more row),
  then with another site's (500, no row), each with its own request id, so the refusal is the Origin check and not a
  broken replay.
- **Full prefetch on hover.** Open lead now prefetches the server-rendered lead page in full: the page runs
  `requireSession()` and the same RPCs under the viewer's session on the prefetch, and the router keeps that payload in
  the tab's memory for up to 5 minutes (Next.js `staleTimes.static`). Nothing new is exposed (the viewer could open the
  page anyway); residual: a lead opened from that cache within 5 minutes first shows what the prefetch saw, then the
  query cache refreshes it.
- No new route, action, RPC or grant in this round; the client text rule now refuses C1 controls like the database.

## `/security-review` on f2c900b (11 Oct, night, after the review round)

The `/security-review` slash command, run as the skill prescribes: one sub-task searched the whole PR diff
(`git diff origin/main...f2c900b`) for high-confidence vulnerabilities, with every PostgREST path (granted columns,
upserts, each RPC) and each caller kind (same or other org, aal1 or aal2, rep, manager, admin) in its prompt. A
false-positive filter sub-task was to run per finding; none was needed. **Result: no findings** (no HIGH or MEDIUM issue
at confidence 0.7 or above).

| Area | Result |
|---|---|
| RPCs in the migration | All SECURITY INVOKER, `search_path = ''`, static SQL (only the grant loop uses `format`); aal2 required; revoked from public and anon, granted to authenticated; RLS decides every row |
| `log_activity` | Editability from `SELECT … FOR UPDATE` under `companies_update`; contact must be on the lead; owner takeover only on unassigned leads and only for managers; tasks through `tasks_update` and `task_guard`; another org fails on the org-scoped select |
| `undo_activity` | Own entry under 120 s; the undo record is consumed first; each restore only when the current value is the one the entry wrote, written through RLS; records in `private`, not exposed |
| New delete policy branches | No-code branches reach only the caller's own fresh rows; everything else still needs a fresh code |
| `private.activity_undo` | RLS, restrictive `require_mfa`, own rows, WITH CHECK on the entry's author, no update grant |
| DEFINER `lock_activity_lead` / `audit_row` | Lock nothing for aal1 or another org; read and write nothing else / write only `audit_log` from row values |
| Guards and new column grants | Update-only grants behind editor-only policies; no insert grant, so upserts cannot set them; server-set mark times; zone from a closed list with a constant message |
| SQL injection | User text reaches SQL only as parameters; no `.or()` or filter strings |
| Server actions and routes | Zod strictObject, then `requireSession()` / `apiSession()`; named RPC arguments; codes only; routes GET only, `no-store` |
| XSS and URL sinks | No `dangerouslySetInnerHTML`, `innerHTML` or `eval`; `tel:`, `mailto:`, `wa.me` built from digits or percent-encoded parts; the Back URL is limited to `/leads` paths |
| CI and config | `pull_request` with `contents: read`, `persist-credentials: false`, a throwaway local database; `no-console` widened |

## Review round (11 Oct, night)

A four-lens review (security, database, app, design; a skeptic per finding) found 23 findings: the security lens found
none; 22 were confirmed and fixed (README "Review round"), 1 refuted. Security-relevant changes:

- **`lead_guard` rule 5** (migration lines 403-408): on an update, a past Cool off date is replaced by +90 days only when
  the date is empty or the statement left a past date unchanged; a past date the statement itself writes is kept. That
  is what `undo_activity` writes when it puts back a due Cool off lead. Inserts are unchanged. Proved by
  `outcome_attack.sql` block 6b (fails with either half of the fix removed) and mutation rows 8, 45, 46, 91 to 94.
- **`bulk_update_leads`** refuses a return date that is not in the future (22023, hint `bounds`), since the guard no
  longer replaces such a date (section 12 cases).
- **`undo_activity`** reports `restored.next_action_at` only when the stored date is the one put back (block 6c).
- **Nothing new is reachable:** no new route, server action, RPC, table, policy or grant came with the round; the app
  changes are in client components, messages and tests.
- **Test-only WebKit console filter** (`tests/auth/helpers.ts`, `isCancelledPrefetch`, used only in
  `lead-page.spec.ts`): it ignores exactly "Fetch API cannot load http://localhost:3100/…?_rsc=… due to access control
  checks" (anchored regex, same-origin RSC requests only), WebKit's wording for a fetch the page cancelled. Every other
  console error still fails a test. No app code changed for it.

Residual (low): a direct editor update can still put a lead in Cool off with a past date it writes itself (the lead then
shows as due at once). Only on leads the caller may edit, who could set that date anyway; the app always sends tomorrow
or later.
