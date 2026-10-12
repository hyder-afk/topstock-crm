# Day 6e mutations

`python3 scripts/db-mutations.py --set day6e` in a throwaway worktree (`git worktree add --detach` at ca18b65, removed
afterwards; the database files are unchanged from ca18b65 to the 6e head) whose `scripts/db-test.sh` copy listens on
port 54382 (the real script's port is unchanged). Each row edits the live definition (edits reach later redefinitions
through `REDEFINERS`, which now includes the 6e migration), runs the whole `db-test.sh` (every attack and concurrency
suite, advisors) and restores the migration. Design rows 37 to 47 plus the build's own protections.

## Database: day6e (29 rows, 12 Oct 2026)

| # | Protection removed | Result | First failure |
|---|---|---|---|
| 1 | share_reader may read the minimum price [design 37] | caught | FAIL: share_reader_column_privileges (select): {private.inventory_settings.org_id,private.inventory_settings.sharing_enabled,private.share_l |
| 2 | share_items sends the minimum price in place of the max (and share_reader may read it) [design 38] | caught | FAIL: share_reader_column_privileges (select): {private.inventory_settings.org_id,private.inventory_settings.sharing_enabled,private.share_l |
| 3 | share_view compares the plain token instead of its hash [design 39] | caught | FAIL: share_view_valid_link_ok: {"status": "inactive"} |
| 4 | share_view works for a revoked link [design 40] | caught | FAIL: share_view_inactive_cases_same_answer (tss_YXJLgHnI): {"items": [[207, "SH Visible", "Bags", "999.99", 24, 480, 0, null], [213, "SH Pa |
| 5 | share_view works for an expired link [design 40] | caught | FAIL: share_view_inactive_cases_same_answer (tss_NqKdOMfE): {"items": [[207, "SH Visible", "Bags", "999.99", 24, 480, 0, null], [213, "SH Pa |
| 6 | share_view ignores the kill switch [design 40] | caught | FAIL: kill_switch_disables_all |
| 7 | share_request ignores the kill switch [design 40] | caught | FAIL: kill_switch_disables_all |
| 8 | share_view without its rate limit [design 41] | caught | FAIL: share_view_rate_limited: the 31st view gave {"items": [[207, "SH Visible", "Bags", "999.99", 24, 480, 0, null], [213, "SH Past eta", " |
| 9 | share_request without its rate limits [design 41] | caught | FAIL: share_request_rate_limits (6th an hour): {"status": "received", "signature": "Ada"} |
| 10 | share_take writes a count when it refuses [design 42] | caught | FAIL: share_view_over_limit_writes_nothing / share_unknown_token_writes_nothing: 62 counter steps |
| 11 | share_items lists sold-out products [design 43] | caught | FAIL: share_view_hides_sold_out_hidden_archived_fully_held: {207,213,212,104,105,108,109,111,112,113,114,115,116,117,118,119,120,121,122,123 |
| 12 | share_items cuts at 2,000 before the in-stock filter [design 44] | caught | FAIL: share_view_2000_items_not_truncated: 1950 items |
| 13 | authenticated may call the two anon functions [design 45] | caught | FAIL: share_view_not_granted_to_authenticated |
| 14 | share_view made STABLE (a GET could call it) [design 46] | caught | UPDATE is not allowed in a non-volatile function |
| 15 | The link guard keeps a token_hash the client sent [design 47] | caught | FAIL: share_link_client_token_hash_ignored (the guard kept a planted hash) |
| 16 | authenticated may insert token_hash (the guard still replaces it) | caught | FAIL: "insert into private.share_links (company_id, language, token_hash) |
| 17 | A link without a fresh code | caught | FAIL: "select public.create_share_link('5e000000-0000-0000-0000-0000000000b1', 'en')" gave 22023 (hint "too_many_links", too many active lin |
| 18 | A revoked link may be brought back | caught | FAIL: "update private.share_links set revoked_at = null where id = '2777767f-6618-42ab-9397-6ad2882b43a9'" succeeded, expected 22023 |
| 19 | A rep may make a link for any lead (insert policy without the editor check) | caught | FAIL: "insert into private.share_links (company_id, language) |
| 20 | No cap on active links a lead | caught | FAIL: "select public.create_share_link('5e000000-0000-0000-0000-0000000000d0', 'en')" succeeded, expected 22023 |
| 21 | A manager may switch sharing on (guard) | caught | FAIL: "update private.inventory_settings set sharing_enabled = true" succeeded, expected 42501 |
| 22 | share_reader's links policy without the token hash (any link readable) | caught | FAIL: share_rls_org_setting_scoping (no setting must read nothing) |
| 23 | share_reader reads every organisation's products (policy without the org) | caught | FAIL: share_rls_org_setting_scoping (no setting must read nothing) |
| 24 | A client request is not checked against the visible products | caught | FAIL: share_request_rejects_foreign_or_hidden_product: {"status": "received", "signature": "Henri"} |
| 25 | A client request retried with the same key is written twice | caught | FAIL: share_request_idempotent (2 rows) |
| 26 | No limit on new requests a link | caught | FAIL: share_request_too_many_open |
| 27 | The audit keeps the token hash | caught | FAIL: token_hash_not_in_audit |
| 28 | A client request opens no task | caught | FAIL: share_request_creates_request_and_one_task (task) |
| 29 | The import undo misses client links (a lead with a link counts as untouched) | caught | FAIL: lead_import_untouched_counts_links |

**Row 19, first run: NOT CAUGHT.** `create_link_needs_editor_and_fresh_code` went only through `create_share_link`,
whose own editor check refused first, so nothing exercised the insert policy alone. `share_attack.sql` now also tries
the same rep's direct insert into `private.share_links` (fresh code, granted columns only) and expects 42501; the row
above is the re-run with that test (caught). Final: **29 rows, 29 caught.**

## Database: earlier rows the 6e redefinitions reach (re-run on the 6e database)

`lead_import_untouched` (Day 3b, 4a, 6a, 6d rows), `inventory_settings_guard` (6a row 46):

| Set | # | Protection removed | Result | First failure |
|---|---|---|---|---|
| day3b | 18 | Undo: leads with an activity count as untouched | caught | FAIL: undo preview {"kept": 4, "tagged": 6, "removable": 2} |
| day3b | 19 | Undo: leads with a contact count as untouched | caught | FAIL: undo preview {"kept": 4, "tagged": 6, "removable": 2} |
| day3b | 20 | Undo: leads with a deal count as untouched | caught | FAIL: undo preview {"kept": 4, "tagged": 6, "removable": 2} |
| day3b | 21 | Undo: edited leads count as untouched | caught | FAIL: undo preview {"kept": 4, "tagged": 6, "removable": 2} |
| day4a | 10 | Import undo: leads with a task count as untouched | caught | FAIL: undo preview with a task {"kept": 0, "tagged": 2, "removable": 2} |
| day6a | 46 | The alert assignee may be outside the organisation | caught | FAIL: "update private.inventory_settings set alert_assignee_id = '00000000-0000-0000-0000-0000000000c1'" succeeded, expected 22023 |
| day6a | 47 | Import undo does not count holds (it would try to delete a lead with stock history) | caught | FAIL: undo preview with a hold {"kept": 0, "tagged": 2, "removable": 2} |
| day6d | 7 | The import undo misses sales (a lead with a sale counts as untouched) [design 30] | caught | FAIL: lead_import_untouched_counts_stock |

All 8 as listed (caught).

## App: rows 48 to 52 (`python3 scripts/app-mutations.py`, in place, file restored after each row)

| # | Protection removed | Result | Check that fails |
|---|---|---|---|
| 48 | The proxy's share branch reads the session (it runs after the Supabase block) | caught | unit `proxy-share.spec.ts` |
| 49 | The share CSP keeps the Supabase origin | caught | unit `proxy-share.spec.ts` |
| 50 | The view answer is passed on without the output schema | caught | unit `share.spec.ts` (`share_output_schema_strips_cost`) |
| 51 | The honeypot and the time trap call the database | caught | e2e `share_public_route_guards` (`--e2e 51`: mutated build on the shared local stack, then a clean build) |
| 52 | The proxy keeps incoming surface headers | caught | unit `proxy-share.spec.ts` |

## Verifier round (12 Oct 2026, database at 888258d, app at 6065688)

The verifier's finding 6 changed `share_link_caps` (an organisation transaction lock before the count; the trigger
also runs on `update of expires_at`) and added two checks (`share_concurrency.sh` case 4
`share_link_cap_parallel_creates`, `share_attack.sql` `extend_counts_against_the_cap`), both seen failing on the old
migration first. Two rows were added for the new protections and the rows touching the caps and the link guard were
re-run with `python3 scripts/db-mutations.py --set day6e 17 18 20 30 31` in a throwaway worktree at 888258d (its
`db-test.sh` copy on port 54392; removed afterwards). Rows 1 to 4 also ran again in a first full-set pass (stopped
there to save time; all 4 caught as before).

| # | Protection removed | Result | First failure |
|---|---|---|---|
| 17 | A link without a fresh code | caught | FAIL: "select public.create_share_link('5e000000-0000-0000-0000-0000000000b1', 'en')" gave 22023 (hint "too_many_links", too many active lin |
| 18 | A revoked link may be brought back | caught | FAIL: "update private.share_links set revoked_at = null where id = '0ea27976-…'" succeeded, expected 22023 |
| 20 | No cap on active links a lead | caught | FAIL: "select public.create_share_link('5e000000-0000-0000-0000-0000000000d0', 'en')" succeeded, expected 22023 |
| 30 | The link caps count without the organisation's lock (two creates at once pass the cap) | caught | FAIL: share_link_cap_parallel_creates: the second create answered: tss_C0co… |
| 31 | The link caps run on a new link only (Extend brings an expired link back past the cap) | caught | FAIL: "select public.extend_share_link('8d02f337-…', 30)" succeeded, expected 22023 |

day6e now: 31 rows, 31 caught (rows 1 to 29 as listed above, 30 and 31 here).

App rows (`python3 scripts/app-mutations.py`, in place in the 6a worktree, file restored after each row): 48, 49, 50
and 52 caught again (51 needs the e2e stack, unchanged code); new rows for the client page's own checks:

| # | Protection removed | Result |
|---|---|---|
| 53 | The client page counts lengths in UTF-16 units (an emoji at the limit blanks the list) [verifier 1] | caught |
| 54 | The client page sends the elapsed time uncapped (a page open a day is refused) [verifier 2] | caught |
| 55 | The token must end the fragment (a glued full stop makes the link inactive) [verifier 3] | caught |
