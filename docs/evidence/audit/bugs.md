# Bugs audit fixes (17 Oct 2026)

The read-only correctness audit of origin/main `c543676` found 6 medium and 5 low bugs (M1 to M6, L1 to L5). The
consistency audit added one more: the pipeline board returned `null` while a new scope or owner loaded. This page
records, for each one, whether it was real, the fix commit and the test that proves it.

How each finding was checked:
1. Read the code path the audit named.
2. Wrote a test that should fail on the old code.
3. Ran that test on a build of origin/main `c543676` (port 4901, on the same throwaway stack and database) and saw it
   fail. Then ran it on this branch's build (port 4900) and saw it pass.

The unit tests that fail on the old code were run on a scratch copy of `c543676`'s sources. Every finding below turned
out to be real. M5 is narrower than the audit described (see its row).

## Findings

| Finding | Real? | What was wrong (checked) | Fix commit | Test (fails on `c543676`, passes here) |
|---|---|---|---|---|
| **M1** "Longest in stage" sort does nothing | Yes | `sortLoaded` leaves "oldest" to the server, but `pipeline_board` always read newest first, and neither `boardKey`, `/api/pipeline/board` nor Show more carried the order | `2537c4e` | e2e `pipeline.spec` `sort_longest_in_stage_reads_oldest_first, and Show more continues that order` (on `c543676`: the column still started with the newest deal). DB: `deals_attack.sql` `board_order_oldest`, plus `bad_order` for `pipeline_board` |
| **Board null** (consistency audit, board.tsx:601) | Yes | `if (!board \|\| !display) return null`: the title, toolbar and columns vanished while Mine or an owner loaded, and a failed read left a blank page | `83ce223` | e2e `pipeline.spec` `scope_not_read_before_shows_skeleton_then_error_with_retry` (on `c543676`: no skeleton) |
| **M2** forms stuck on "Saving…" | Yes | `lead-form` and `contact-form` awaited `onSubmit` with no catch, so a thrown action never reached `setPending(false)` | `ae5eb2c` | e2e `leads.spec` `contact_save_that_cannot_be_sent_says_so_and_frees_the_button` (on `c543676`: no message, button stuck) |
| **M3** status or owner change that throws stays on screen; Undo always says "Change undone." | Yes | `changeStatus` and `changeOwner` awaited the action without a catch, so `restore` never ran; Undo ignored the results | `ae5eb2c` | e2e `leads.spec` `status_change_and_undo_that_cannot_be_sent_say_so` (on `c543676`: no toast, "Customer" kept) |
| **M4** a stuck pause stops later toasts leaving | Yes | Undo or Dismiss unmounts the box under the pointer or focus, so no mouseleave or blur arrives and `paused` stayed true | `ae5eb2c` | e2e `leads.spec` `toast_after_a_mouse_click_on_another_still_leaves_on_its_own` (on `c543676`: the next toast still showed after 10 s) |
| **M5** a failed rollback restores a whole-board snapshot | Yes, narrower than described | Next.js sends server actions one at a time, so B's answer can never land before A fails. What really happens: A's failure restores the board as it was before A, which puts B back in its old column, with its old totals, until B's own answer arrives one full round trip later (seconds on a slow network). Tasks behave the same way (`restoreLists`) | `dbbc09a` | e2e `pipeline.spec` `failed_move_rolls_back_its_own_card_only` and `tasks.spec` `failed_tick_puts_back_its_own_row_only`. Each slows B's action and reads the screen while it is on its way. On `c543676`, B was back in Lead or on its old tab. Unit: `rollbackCard` (pipeline-cache.spec) and `restoreTask` (tasks-cache.spec) |
| **M6** stale version in the module map causes false conflicts | Yes | `update()` sent `versions.get(id) ?? card.version`, so the map won over a newer version the sheet had just read | `bb46ed2` | e2e `pipeline.spec` `field_edit_after_own_move_and_a_colleagues_edit_needs_no_conflict_round_trip`. On `c543676` the sheet showed "Ada changed this a moment ago. · Keep yours" and nothing was saved. Here: "Saved" after one request. `undo()` is unchanged on purpose: `deal_undo_candidate` refuses an undo once `version_after` differs, whatever version is sent |
| **L1** release then Undo on a lead's Stock tab leaves the tab stale; the new hold loses its note | Yes | Undo refreshed only the inventory keys (not `["lead-stock", id]` or the alerts), and `stock-tab` passed `note: null`. `get_lead_stock` did not return the note at all | `8e39893` | e2e `sales.spec` `release_from_stock_tab_then_undo_shows_the_hold_again_with_its_note` (on `c543676`: the hold did not come back on the tab). DB: `sales_attack.sql` checks that holds carry `note` |
| **L2** "Close date passed" uses the UTC date | Yes | `new Date(now).toISOString().slice(0, 10)` | `2041711` | e2e `pipeline.spec` `close_date_passed_follows_the_paris_day_after_midnight` (clock fixed at 00:30 Paris; on `c543676` it showed "Closes Oct 12"). Unit: `closeDatePassed` (days-in-stage.spec) |
| **L3** missing cross-feature invalidations | Yes, all four | Queue save and undo did not refresh `["pipeline"]` or `["lead-deals", id]`. Ticking a task on the Tasks page did not refresh `["home"]`. Ticking one on Home's Today card did not refresh `["tasks"]` or `["lead-tasks", id]`. Stock changes did not refresh `["home"]` | `d2ed5ad` | e2e `lead-deals.spec` `queue_outcome_deal_reaches_the_board` and `home.spec` `today_tick_reaches_the_tasks_page` (both failed on `c543676`). Unit: `refreshTasks` and `refreshInventory` refresh Home (both failed on `c543676`). The queue's Undo path uses the same `refreshDeals` helper; it is not tested on its own, because leaving the queue page drops its Undo |
| **L4** "1,250" read as €1.25; "1.5" read as 15 | Yes | `parsePrice` replaced the first comma with a dot whatever the language; `parseWhole` dropped every dot and comma | `c5259cb` | Unit `inventory.spec` `ambiguous separators are refused, never misread (L4)` (failed on `c543676`) |
| **L5** a check that fails after the page was left leaves a staged batch | Yes | In `runCheck`'s catch, `if (!mounted.current) return;` ran before `discardStockImport` | `9559f16` | e2e `stock-import.spec` `check_failing_after_the_page_was_left_throws_its_import_away` (on `c543676` the batch stayed "staged") |

## Decisions (builder decision under Haider's standing instruction)

- **L4, the parsing rule.** When typed input can be read two ways, the app refuses it and the field shows its usual
  error ("Enter a price like 2.50"). It never guesses.
  - **Prices** (`parsePrice(text, locale)`):
    - One separator followed by 1, 2 or 4 digits is always the decimal point, in either language.
    - One separator followed by exactly 3 digits counts as a decimal only if it is the language's own decimal mark:
      "2.125" in English and "2,125" in French. With the language's grouping mark ("1,250" in English, "1.250" in
      French) the input is refused.
    - Thousands written with the language's own marks are read: "1,250.50" in English, "1.250,50" or "1 250,50" in
      French.
  - **Whole numbers** (`parseWhole`): a dot, comma or apostrophe is accepted only between groups of three digits.
  - **Stored prices** are written back into fields in the language's form (`priceInput`), so that a French edit of a
    2.125 price reads back unchanged.
  - No new strings: the existing field errors and the sale sheet's "needPrice" reason cover the refusal.
- **M1 needs a new migration** (`20261024080000_pipeline_board_order`). A sort applied only to the loaded cards would be
  wrong once more pages exist. `pipeline_board` is dropped and created again with `p_order`, so there are never two
  overloads; its grants are restored.
- **L1's note needs a new migration** (`20261024080100_lead_stock_hold_note`). It adds `note` to `get_lead_stock`'s
  holds. This exposes nothing new: every signed-in person in the organisation already reads the same note on the
  product panel.
- **Board null**: the board shows the skeleton while loading and its error with Retry when the read fails. It does not
  keep the previous board on screen (`keepPreviousData`), for two reasons. Moves or Show more on a previous scope's
  cards would write into the wrong board. And a move cancels board reads in flight, which could leave a placeholder
  board on screen for up to 30 s.

## Checks

All of these ran on this branch at `9559f16`.

- `npm run lint`: 0 errors (the same 3 warnings as before). `npm run typecheck`: passes. `npm run check:native`:
  passes.
- `npm run test:unit`: 756 passed.
- `npm run test:db` (a throwaway PostgreSQL 16 with every migration, every attack and concurrency suite, then the
  splinter advisors): exit 0. The run covers the new `board_order_oldest`, `bad_order` and holds-carry-`note` checks.
  - Advisors: 0 ERROR. The 3 WARNs already existed and are unrelated: `share_request` and `share_view` are executable by
    anon, and `set_user_role` by authenticated, all on purpose. INFO: 8 unindexed foreign keys and 11 to 13 unused indexes (the count varied between the two runs).
  - The two new functions are SECURITY INVOKER with `search_path ''` and static SQL (`deals_attack` checks this for
    `pipeline_board`).
  - The Supabase MCP advisors on the DEV project still need to run once these migrations reach DEV. This session does
    not apply migrations to DEV.
- e2e on Chromium 1194, on a throwaway local stack (Postgres 54790, GoTrue 9979, gateway 54791, app 4900; stopped and
  its data folder deleted afterwards):
  - 172 passed in one run: pipeline, pipeline-multi, leads, lead-page, lead-deals, tasks, home, inventory, sales,
    stock-import, share, queue and day5-security. This includes `call_keeps_claims`.
  - day5-screens "board errors": 1 passed. Its pipeline_board signature check was updated, and its screenshots went to a
    scratch folder.
- The tests run against the old code (build of `c543676` on port 4901, same stack):
  - e2e: all 13 new tests failed (M1, board null, M2, M3, M4, M5 pipeline, M5 tasks, M6, L1, L2, L3 queue, L3 Home, L5).
  - Unit: all 7 new tests failed (M5 twice, L2, L3 twice, L4).
- Not run: WebKit (not installed here; CI runs it) and journey invite (needs Mailpit).
- Changed after the e2e build, comments only: the doc comments of `rollbackCard` and use-pipeline's `restore`.
