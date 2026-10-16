# One run of scripts/gate1-run.sh: trimmed output

Code: `day7d-local` ef2b74c. Throwaway stack: PostgreSQL 54650, Supabase Auth 9988, gateway 54651, `next start` 4100,
Chromium 141; `db-test.sh` on 54669. Kept: the section headers, the database suites' pass lines and advisor lines, and
Playwright's list lines (one per test) and totals. Removed: everything else (stack traces of the one environment
failure are summarised at the end). No environment values appear in the run's output; it was checked for keys and
connection strings before trimming.

```
== 1. SQL attack suites (scripts/db-test.sh)
rls_attack: all checks passed
import_attack: all checks passed
import_concurrency: all checks passed
activity_attack: all checks passed
activity_concurrency: all checks passed
outcome_attack: all checks passed
outcome_concurrency: all checks passed
queue_attack: all checks passed
queue_concurrency: all checks passed
files_attack: all checks passed
files_concurrency: all checks passed
deals_attack: all checks passed
deal_concurrency: all checks passed
deal_links_attack: all checks passed
home_attack.sql: all Day 5c checks passed
team_concurrency: all checks passed
NOTICE: integrity_after_random_ops: 735 applied, 265 refused (constant errors), by kind {"count": 45, "receive": 83, "release": 85, "reserve": 143, "transfer": 59, "adjust_in": 72, "deal_lost": 65, "deal_open": 84, "adjust_out": 63, "reserve_deal": 36}
stock_attack: all checks passed
stock_concurrency: all checks passed
inventory_attack: all checks passed
stock_import_attack: all checks passed
stock_import_concurrency: all checks passed
sales_attack: all checks passed
sales_concurrency: all checks passed
share_attack: all checks passed
share_concurrency: all checks passed (40 of 40 parallel views answered, the rest slowed down)
day7a_attack: all checks passed
 gate1_attack: all checks passed
WARN  anon_security_definer_function_executable: Function `public.share_request(p_token text, p_payload jsonb)` executable by anon (SECURITY DEFINER)
WARN  anon_security_definer_function_executable: Function `public.share_view(p_token text, p_known_version text)` executable by anon (SECURITY DEFINER)
WARN  authenticated_security_definer_function_executable: Function `public.set_user_role(target_user uuid, new_role public.app_role)` executable by authenticated (SECURITY DEFINER)
INFO  unindexed_foreign_keys: 8
INFO  unused_index: 13
advisors: no ERROR-level findings
== 2. Two-user browser and API run (Chromium)
Running 112 tests using 1 worker
  ✓    1 [chromium] › tests/auth/day4-security.spec.ts:94:5 › private_tables_not_exposed: undo records are not served by the REST API (349ms)
  ✓    2 [chromium] › tests/auth/day4-security.spec.ts:114:5 › rep_direct_rpc: a rep's own token cannot edit or delete a colleague's entry, nor log as someone else (538ms)
  ✓    3 [chromium] › tests/auth/day4-security.spec.ts:137:5 › external_links_rel, no console errors and no CSP violations on the lead page (3.4s)
  ✓    4 [chromium] › tests/auth/day4-security.spec.ts:174:5 › cross_site_action_refused: a server action sent with another Origin changes nothing (2.8s)
  ✓    5 [chromium] › tests/auth/day4-security.spec.ts:226:5 › error_copy_has_no_sql: the lead page APIs answer codes only (421ms)
  ✓    6 [chromium] › tests/auth/day4-security.spec.ts:243:5 › rep_direct_rpc_scope_403: a rep's own token cannot work the team's queue or claim a colleague's lead (462ms)
  ✓    7 [chromium] › tests/auth/day4-security.spec.ts:258:5 › private_tables_not_exposed: queue claims are not served by the REST API (322ms)
  ✓    8 [chromium] › tests/auth/day4-security.spec.ts:273:5 › cross_origin_release_403: the release route takes same-origin JSON only, and releases only the caller's claims (1.8s)
  ✓    9 [chromium] › tests/auth/day4-security.spec.ts:334:5 › no console errors and no CSP violations on the Tasks page, the queue and More (4c) (4.2s)
  ✓   10 [chromium] › tests/auth/day5-security.spec.ts:105:5 › rep_direct_rpc_team_scope_403: a rep's own token cannot list the team's deals or another person's (258ms)
  ✓   11 [chromium] › tests/auth/day5-security.spec.ts:121:5 › rep_get_other_deal_404: another person's deal reads as missing, the same as one that does not exist (727ms)
  ✓   12 [chromium] › tests/auth/day5-security.spec.ts:143:5 › history_table_write_refused, stage_write_refused_via_rest, deal_patch_status_column_denied, private_deal_moves_not_exposed (950ms)
  ✓   13 [chromium] › tests/auth/day5-security.spec.ts:191:5 › cross_site_move_action_refused: a move sent with another Origin changes nothing (1.9s)
  ✓   14 [chromium] › tests/auth/day5-security.spec.ts:240:5 › error_copy_has_no_sql: the deal and pipeline APIs answer codes only (444ms)
  ✓   15 [chromium] › tests/auth/day5-security.spec.ts:258:5 › no_console_errors_no_csp_violations on the pipeline, the deal sheet and the lead's Deals tab (3.3s)
  ✓   16 [chromium] › tests/auth/day7a.spec.ts:19:5 › a sign-in writes exactly one audit row; the password step alone writes none (23.8s)
  ✓   17 [chromium] › tests/auth/day7a.spec.ts:50:7 › auth cookie flags (HTTPS via the platform header) (1.2s)
  ✓   18 [chromium] › tests/auth/day7a.spec.ts:50:7 › auth cookie flags (plain HTTP) (1.2s)
  ✓   19 [chromium] › tests/auth/day7a.spec.ts:74:5 › the search and list APIs answer 429 after 300 requests a minute, for that person only (42.9s)
  ✓   20 [chromium] › tests/auth/day7a.spec.ts:100:5 › Sign out of all devices ends the session in the other browser too (48.3s)
  ✓   21 [chromium] › tests/auth/day7a.spec.ts:140:5 › French: the More button and the sheet speak French (2.0s)
  ✓   22 [chromium] › tests/auth/files.spec.ts:138:5 › files_tab_empty_state: the tab is shown, empty, with the limits and a real button (1.6s)
  ✓   23 [chromium] › tests/auth/files.spec.ts:158:5 › too_big_rejected_before_upload, renamed_exe_rejected, docm_renamed_docx_rejected: nothing is sent (3.2s)
  ✓   24 [chromium] › tests/auth/files.spec.ts:187:5 › files_list: rows, sizes, who and when; names as text (xss); the team space for admins only (3.4s)
  ✓   25 [chromium] › tests/auth/files.spec.ts:235:5 › rep_cannot_open_others_file, cross_site_file_request_refused, the unavailable page (3.1s)
  ✓   26 [chromium] › tests/auth/files.spec.ts:271:5 › quota_message: a full team space refuses before any byte is sent (1.8s)
  ✓   27 [chromium] › tests/auth/files.spec.ts:287:5 › delete_needs_fresh_code (the database asks for the code), stuck delete shows Retry (18.4s)
  ✓   28 [chromium] › tests/auth/files.spec.ts:329:5 › delete dialog focus: Escape, Cancel, a failed delete and a cancelled code give it back to the row's Actions, never the page (round 3 finding 1) (36.5s)
  ✓   29 [chromium] › tests/auth/files.spec.ts:389:5 › phone_390_files: no sideways scroll; Add file, the row menus, the row's open target and Retry are 44 px (1.6s)
  ✓   30 [chromium] › tests/auth/files.spec.ts:441:5 › announcements: each refusal says why, and files past 5 are announced once (finding 14) (1.5s)
  ✓   31 [chromium] › tests/auth/files.spec.ts:470:5 › upload line focus: Cancel -> the line while checking -> Try again -> Cancel -> Choose files; a failed check cancels the pending row (findings 7, 8, 13) (4.7s)
  ✓   32 [chromium] › tests/auth/files.spec.ts:542:5 › hidden tab: an outcome shows as a toast and the line waits; a file dropped outside the zone never leaves the page (findings 17, 18) (2.1s)
  ✓   33 [chromium] › tests/auth/files.spec.ts:580:5 › show older files: a failed page says so and keeps the focus; the last page moves the focus to its first file (finding 10) (3.7s)
  ✓   34 [chromium] › tests/auth/files.spec.ts:610:5 › show older files: a last page that comes back empty (the older files were deleted meanwhile) puts the focus on the heading (2.0s)
  -   35 [chromium] › tests/auth/files.spec.ts:674:7 › with storage-api (CI) › upload_pdf_progress_then_open, signed_url_dead_after_60s, deleted_file_url_404
  -   36 [chromium] › tests/auth/files.spec.ts:738:7 › with storage-api (CI) › rep_cannot_open_others_file with real bytes: the admin reaches Storage, the rep gets unavailable
  -   37 [chromium] › tests/auth/files.spec.ts:763:7 › with storage-api (CI) › signed_upsert_overwrite_after_ready_refused: a signed upload link made with upsert while pending cannot swap a ready file
  -   38 [chromium] › tests/auth/files.spec.ts:814:7 › with storage-api (CI) › direct_api_html_as_pdf_refused_at_open: bytes stored by a direct API call are checked when opened
  -   39 [chromium] › tests/auth/files.spec.ts:831:7 › with storage-api (CI) › name_accents_download: Word files download under their own name
  ✓   40 [chromium] › tests/auth/gate1.spec.ts:173:5 › step1_three_people_fake_data: Rep A, Rep B and Admin exist with their roles; every address is a test address (344ms)
  ✓   41 [chromium] › tests/auth/gate1.spec.ts:187:5 › step2_direct_api: Rep A's own token cannot read Rep B's deal or task, nor change or delete any of Rep B's records (2.8s)
  ✓   42 [chromium] › tests/auth/gate1.spec.ts:250:5 › step2_app_routes_and_urls: Rep A gets not found for Rep B's deal and sees no trace of Rep B's task through the app (2.9s)
  ✓   43 [chromium] › tests/auth/gate1.spec.ts:276:5 › step3_anon_key_every_table: the public key alone reads and writes nothing in any table, view or function (9.3s)
  ✓   44 [chromium] › tests/auth/gate1.spec.ts:336:5 › step4_role_and_owner_tamper: Rep A cannot make themselves admin, take Rep B's lead, or hand their own lead to another org (3.0s)
  ✓   45 [chromium] › tests/auth/gate1.spec.ts:390:5 › step5_bad_input_every_api: oversized, malformed and script-laden input gets a code, never database text or reflected markup (15.7s)
  ✓   46 [chromium] › tests/auth/gate1.spec.ts:436:5 › step5_script_in_text_fields_renders_as_text: lead, contact, task and product names with markup never run (5.1s)
  ✓   47 [chromium] › tests/auth/gate1.spec.ts:467:5 › item2_repository_files_not_served: signed in, /.env and the other repository files answer 404 without their contents (1.1s)
  ✓   48 [chromium] › tests/auth/gate1.spec.ts:477:5 › item45_admin_pages_by_direct_url: a rep gets the not-found page and a signed-out visitor the sign-in page on every admin screen (8.6s)
  ✓   49 [chromium] › tests/auth/gate1.spec.ts:499:5 › step8_stock_levels_direct_and_over_reservation_refused: direct writes fail for everyone; reserving past what is there is refused (888ms)
  ✓   50 [chromium] › tests/auth/import-security.spec.ts:124:5 › staged lead rows are not served by the REST API, even to the admin who staged them (677ms)
  ✓   51 [chromium] › tests/auth/import-security.spec.ts:168:5 › a rep's own token cannot start an import or read the import history (403, 42501) (284ms)
  ✓   52 [chromium] › tests/auth/import-security.spec.ts:183:5 › the import functions refuse the public key alone (no one signed in) (589ms)
  ✓   53 [chromium] › tests/auth/inventory.spec.ts:125:5 › stock_table_filters_and_panel (4.4s)
  ✓   54 [chromium] › tests/auth/inventory.spec.ts:158:5 › new_product_with_opening_stock_step_up (26.5s)
  ✓   55 [chromium] › tests/auth/inventory.spec.ts:188:5 › count_sets_quantity_then_movements_log (6.2s)
  ✓   56 [chromium] › tests/auth/inventory.spec.ts:216:5 › arrived_partial_moves_hold (4.3s)
  ✓   57 [chromium] › tests/auth/inventory.spec.ts:242:5 › movements_log_keyset (3.4s)
  ✓   58 [chromium] › tests/auth/inventory.spec.ts:258:5 › rep_sees_no_cost_column_and_no_manager_actions; get_routes_read_only (3.8s)
  ✓   59 [chromium] › tests/auth/inventory.spec.ts:290:5 › inventory_390_no_horizontal_scroll_and_product_page (2.4s)
  ✓   60 [chromium] › tests/auth/inventory.spec.ts:311:5 › inventory_keyboard_only (2.5s)
  ✓   61 [chromium] › tests/auth/inventory.spec.ts:341:5 › inventory_empty_and_error_states (3.6s)
  ✓   62 [chromium] › tests/auth/inventory.spec.ts:360:5 › admin_settings (2.2s)
  ✓   63 [chromium] › tests/auth/inventory.spec.ts:384:5 › screens (1.9m)
  ✘   64 [chromium] › tests/auth/journey.spec.ts:17:5 › invite, password, two-factor setup, signed in (177ms)
  -   65 [chromium] › tests/auth/journey.spec.ts:64:5 › sign out, password alone is not enough, code signs in
  -   66 [chromium] › tests/auth/journey.spec.ts:92:5 › password reset asks for the code before the new password
  -   67 [chromium] › tests/auth/journey.spec.ts:113:5 › an unknown address gets the same answer as a real one
  -   68 [chromium] › tests/auth/journey.spec.ts:120:5 › nobody can sign up: accounts come from invitations only
  ✓   69 [chromium] › tests/auth/leads.spec.ts:46:7 › desktop › 120 leads, newest activity first; scrolling loads the rest page by page (3.1s)
  ✓   70 [chromium] › tests/auth/leads.spec.ts:68:7 › desktop › search and filters narrow the list, live in the URL, and survive a reload (7.4s)
  ✓   71 [chromium] › tests/auth/leads.spec.ts:110:7 › desktop › preview shows the lead; contacts can be added and edited; arrow keys move between leads (5.4s)
  ✓   72 [chromium] › tests/auth/leads.spec.ts:146:7 › desktop › adding a lead validates, then opens it; status change shows at once and undoes (7.6s)
  ✓   73 [chromium] › tests/auth/leads.spec.ts:179:7 › desktop › bulk: select two leads and set their status; saved views save, apply and delete (8.0s)
  ✓   74 [chromium] › tests/auth/leads.spec.ts:212:5 › saved views with bad filters are tidied or left out; email links cannot add mail fields; cursors are checked (3.1s)
  ✓   75 [chromium] › tests/auth/leads.spec.ts:250:5 › a rep reads every lead but changes only their own (6.8s)
  ✓   76 [chromium] › tests/auth/leads.spec.ts:279:5 › phone: list, then the lead full screen with a way back (2.7s)
  ✓   77 [chromium] › tests/auth/leads.spec.ts:294:5 › the leads API refuses signed-out and bad requests (45ms)
  ✓   78 [chromium] › tests/auth/share.spec.ts:133:5 › enable_sharing_needs_admin_fresh_code (30.4s)
  ✓   79 [chromium] › tests/auth/share.spec.ts:153:5 › share_link_create_needs_code_and_shows_once (32.4s)
  ✓   80 [chromium] › tests/auth/share.spec.ts:196:5 › palette_share_stock_with_opens_the_lead_link_card (5.2s)
  ✓   81 [chromium] › tests/auth/share.spec.ts:220:5 › share_public_lists_warehouse_stock_with_max_price_and_never_cost (1.2s)
  ✓   82 [chromium] › tests/auth/share.spec.ts:258:5 › share_public_request_creates_task_for_owner (5.0s)
  ✓   83 [chromium] › tests/auth/share.spec.ts:287:5 › share_public_route_guards (924ms)
  ✓   84 [chromium] › tests/auth/share.spec.ts:314:5 › share_public_headers_and_robots (799ms)
  ✓   85 [chromium] › tests/auth/share.spec.ts:339:5 › share_public_signed_in_teammate_still_anon (1.1s)
  ✓   86 [chromium] › tests/auth/share.spec.ts:350:5 › share_public_keyboard_only_and_language_toggle (1.9s)
  ✓   87 [chromium] › tests/auth/share.spec.ts:371:5 › share_public_unknown_revoked_same_page_and_rep_cannot_create (9.3s)
  ✓   88 [chromium] › tests/auth/share.spec.ts:404:5 › share_public_rate_limit_message (3.9s)
  ✓   89 [chromium] › tests/auth/share.spec.ts:422:5 › screens (1.4m)
  ✓   90 [chromium] › tests/auth/stock-import.spec.ts:122:5 › import_stock_40_zero_click_match, stock_problems_file_formula_guarded, stock_step_up_dialog_flow (33.5s)
  ✓   91 [chromium] › tests/auth/stock-import.spec.ts:178:5 › reimport_keeps_crm_moved_quantities, reimport_use_sheet_option, reimport_transit_arrived_as_transfer (7.0s)
  ✓   92 [chromium] › tests/auth/stock-import.spec.ts:219:5 › stock_undo_preview_and_run, stock_undo_keeps_sold (3.4s)
  ✓   93 [chromium] › tests/auth/stock-import.spec.ts:249:5 › cp1252_variant, parens_only_headers, stock_import_en_file (7.5s)
  ✓   94 [chromium] › tests/auth/stock-import.spec.ts:280:5 › stock_import_rep_404, stock_staging_not_exposed (2.7s)
  ✓   95 [chromium] › tests/auth/stock-import.spec.ts:301:5 › screens (2.2m)
  ✓   96 [chromium] › tests/auth/tasks.spec.ts:61:5 › quick_add_chips_buckets: Today, Tomorrow and a picked date land in their tabs, with their counts (6.5s)
  ✓   97 [chromium] › tests/auth/tasks.spec.ts:113:5 › toggle_done_undo: the row leaves at once, Undo brings it back; Done lists it (4.6s)
  ✓   98 [chromium] › tests/auth/tasks.spec.ts:141:5 › dismiss_and_undo: Dismiss from the menu, Undo puts it back (4.3s)
  ✓   99 [chromium] › tests/auth/tasks.spec.ts:165:5 › karachi_today_boundary: Today and Tomorrow follow the profile's zone, not the browser's (5.1s)
  ✓  100 [chromium] › tests/auth/tasks.spec.ts:210:5 › team_scope_admin_only: a rep has no Team switch and the API refuses it; an admin sees the rep's task with initials (3.3s)
  ✓  101 [chromium] › tests/auth/tasks.spec.ts:235:5 › delete_needs_code: Delete asks first, then a fresh code; the task is gone (6.6s)
  ✓  102 [chromium] › tests/auth/tasks.spec.ts:258:5 › keyboard_only: T, Enter, J/K, X, E, D, Backspace and Enter to the lead, the focus always somewhere (8.1s)
  ✓  103 [chromium] › tests/auth/tasks.spec.ts:322:5 › phone_lead_link_target: on a phone, a task's lead link is a 44 px tap target without making the row taller (1.8s)
  ✓  104 [chromium] › tests/auth/tasks.spec.ts:347:5 › lead_picker_focus: picking a lead from the keyboard puts the focus on the chip's remove button, never the page (2.4s)
  ✓  105 [chromium] › tests/auth/tasks.spec.ts:369:5 › failed_toggle_reverts: a toggle that cannot be sent puts the row back with an empty check (4.7s)
  ✓  106 [chromium] › tests/auth/tasks.spec.ts:411:5 › enter_on_task_without_lead: Enter on a task's check never ticks it (X or Space do) (3.5s)
  ✓  107 [chromium] › tests/auth/tasks.spec.ts:464:5 › switch_without_motion: rows already in a cached tab or scope do not fade in or rise when it is shown again (9.0s)
  ✓  108 [chromium] › tests/auth/team.spec.ts:63:5 › admin_promotes_rep_with_fresh_code: More > Team > the person > Role > Admin > Confirm; focus and announcement (3.6s)
  ✓  109 [chromium] › tests/auth/team.spec.ts:119:5 › rep_cannot_see_or_reach_team: no row on More, 404 on the page, the action refused (3.0s)
  ✓  110 [chromium] › tests/auth/team.spec.ts:152:5 › stale_code_asks_for_a_code: Cancel keeps the role, a fresh code saves it (53.5s)
  ✓  111 [chromium] › tests/auth/team.spec.ts:193:5 › last_admin_refused: the only admin cannot step down; the row goes back and says why (2.7s)
  ✓  112 [chromium] › tests/auth/team.spec.ts:215:5 › demoting_yourself: with another admin, you become a manager and land on More without Team, focus on its title (3.9s)
  1 failed
  5 skipped
  4 did not run
  102 passed (25.9m)
== 3. Signed-out checks and the route inventory
Running 22 tests using 2 workers
  ✓   2 [chromium-1440] › tests/e2e/signed-out.spec.ts:8:9 › sign-in renders (en, dark) with no console errors and no sideways scroll (1.4s)
  ✓   1 [chromium-1440] › tests/e2e/signed-out.spec.ts:8:9 › sign-in renders (en, light) with no console errors and no sideways scroll (1.5s)
  ✓   3 [chromium-1440] › tests/e2e/signed-out.spec.ts:8:9 › sign-in renders (fr, light) with no console errors and no sideways scroll (1.3s)
  ✓   4 [chromium-1440] › tests/e2e/signed-out.spec.ts:8:9 › sign-in renders (fr, dark) with no console errors and no sideways scroll (1.3s)
  ✓   6 [chromium-1440] › tests/e2e/signed-out.spec.ts:44:5 › no repository or environment file is served (/.env and the like) (191ms)
  ✓   7 [chromium-1440] › tests/e2e/signed-out.spec.ts:54:5 › security headers are present, also on the sign-in redirect (139ms)
  ✓   8 [chromium-1440] › tests/e2e/signed-out.spec.ts:70:5 › behind HTTPS (Vercel sets x-forwarded-proto), the CSP upgrades insecure requests (71ms)
  ✓   9 [chromium-1440] › tests/e2e/signed-out.spec.ts:75:5 › language switch sets the cookie and re-renders in French (1.4s)
  ✓   5 [chromium-1440] › tests/e2e/signed-out.spec.ts:34:5 › every app page sends a signed-out visitor to sign-in (2.8s)
  ✓  10 [chromium-1440] › tests/e2e/signed-out.spec.ts:81:5 › forgot-password page links back to sign-in (1.8s)
  ✓  11 [chromium-1440] › tests/e2e/signed-out.spec.ts:89:5 › an email link without a token shows a plain message, not an error page (1.7s)
  ✓  12 [chromium-390] › tests/e2e/signed-out.spec.ts:8:9 › sign-in renders (en, light) with no console errors and no sideways scroll (1.0s)
  ✓  14 [chromium-390] › tests/e2e/signed-out.spec.ts:8:9 › sign-in renders (fr, light) with no console errors and no sideways scroll (1.0s)
  ✓  13 [chromium-390] › tests/e2e/signed-out.spec.ts:8:9 › sign-in renders (en, dark) with no console errors and no sideways scroll (1.5s)
  ✓  15 [chromium-390] › tests/e2e/signed-out.spec.ts:8:9 › sign-in renders (fr, dark) with no console errors and no sideways scroll (1.1s)
  ✓  17 [chromium-390] › tests/e2e/signed-out.spec.ts:44:5 › no repository or environment file is served (/.env and the like) (144ms)
  ✓  18 [chromium-390] › tests/e2e/signed-out.spec.ts:54:5 › security headers are present, also on the sign-in redirect (162ms)
  ✓  19 [chromium-390] › tests/e2e/signed-out.spec.ts:70:5 › behind HTTPS (Vercel sets x-forwarded-proto), the CSP upgrades insecure requests (121ms)
  ✓  16 [chromium-390] › tests/e2e/signed-out.spec.ts:34:5 › every app page sends a signed-out visitor to sign-in (2.7s)
  ✓  20 [chromium-390] › tests/e2e/signed-out.spec.ts:75:5 › language switch sets the cookie and re-renders in French (1.2s)
  ✓  21 [chromium-390] › tests/e2e/signed-out.spec.ts:81:5 › forgot-password page links back to sign-in (1.4s)
  ✓  22 [chromium-390] › tests/e2e/signed-out.spec.ts:89:5 › an email link without a token shows a plain message, not an error page (1.6s)
  22 passed (16.4s)
Running 13 tests using 2 workers
  13 passed (2.3s)
gate1-run: exit 1
```

Separate run of `journey.spec.ts`'s two mail-free tests (the full journey needs a mail inbox, CI):

```
  ✓  1 [chromium] › tests/auth/journey.spec.ts:113:5 › an unknown address gets the same answer as a real one (857ms)
  ✓  2 [chromium] › tests/auth/journey.spec.ts:120:5 › nobody can sign up: accounts come from invitations only (26ms)
  2 passed (2.1s)
```

The one failure: `journey.spec.ts` "invite, password, two-factor setup, signed in" stopped with "MAILPIT_URL is not set"
(the helper reads the invitation e-mail from a mail inbox the local stand-in does not have); the file is serial, so
its other 4 tests did not run.
