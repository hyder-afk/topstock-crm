# Day 6 pre-PR review: the independent items, 15 Oct 2026

The advisor's Day 6 pre-PR review (on `day6a-local` at 400ff4e) split its findings into items that depend on the Team
merge (handled after it) and four that do not. This file records those four. Branch `day6a-local`, local only, fake
data only; nothing pushed.

| Commit | What |
|---|---|
| 7b84c8a | Item 1: no raw invisible characters in source (45 lines, 15 files) |
| b98270d | Item 4: the Day 6d `task_guard` rebase note names Day 5a; item 3's pg_cron half (`docs/evidence/day6d/README.md`) |
| a7a9a71 | Item 2: Master Plan section 9, Day 6, as a plan change for Haider to approve at merge |
| this commit | Item 3's `share_reader` half (`docs/evidence/day6e/README.md`), this README, `bidi/`, log rows |

## 1. Raw bidi and zero-width characters (Trojan Source)

Day 5a's `tests/unit/sql-bidi.spec.ts` (arrives with the merge) fails on any raw U+202A to U+202E, U+2066 to U+2069,
U+200E, U+200F or U+061C in a source file. The Day 6 migrations, schemas, tests and the fake-stock script held such
characters inside their "refuse these characters" classes and test strings.

**Scan** (`bidi/scan.py`: every git-tracked and untracked file, `.csv` exempt, for U+061C, U+180E, U+200B to U+200F,
U+202A to U+202E, U+2060 to U+2064, U+2066 to U+2069, U+FEFF, U+FFF9 to U+FFFB, U+E0000 to U+E007F):

| | Lines | Files |
|---|---|---|
| Before, at 400ff4e (`bidi/scan-before-400ff4e.txt`) | 45 | 15 |
| After, on this branch | **0** | **0** |

The advisor counted 42 lines in 14 files with Day 5a's narrower set; the 3 extra lines are a lone U+FEFF (byte order
mark) in `scripts/make-fake-stock.mjs:32` and `tests/auth/stock-import.spec.ts:47,155`. Day 5a's spec itself, copied
in temporarily and removed: "no raw bidirectional control characters" passed; its first test failed only because it
names files that arrive with the merge (`20261015090000_deals_pipeline.sql`, its own name).

**How each was rewritten**

- SQL (29 lines in `20261017090000_inventory_reads.sql`, `20261018090000_stock_import.sql`,
  `20261019090000_sales_requests.sql`, `20261020090000_client_share.sql`): the regex escape inside a plain `'…'`
  string, `'[\u0001-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]'`, exactly the convention of
  Day 4a's `20261011120000_activity_hardening.sql` and Day 4d's `20261014090000_lead_files.sql` (the regex engine
  reads `\uXXXX`; `standard_conforming_strings` keeps the backslash).
- TS regex literals (`src/lib/inventory/schemas.ts`, `src/lib/sales/schemas.ts`, `src/lib/share/schema.ts`) and
  `scripts/make-fake-stock.mjs`: `\uXXXX` escapes.
- Test strings (`tests/unit/{inventory,sales,share,stock-normalise,stock-schema}.spec.ts`,
  `tests/auth/stock-import.spec.ts`): built with `String.fromCodePoint(0x202e)` / `String.fromCodePoint(0xfeff)`; the
  BOM strip regex is `/^\uFEFF/`.
- `supabase/tests/sales_attack.sql:290` (a JSON literal inside `$q$…$q$`): the JSON escape `"Secret \u202e item"`;
  `jsonb` (and `json ->>`) decode it to U+202E (checked: equal to `'Secret ' || chr(8238) || ' item'`).

**Equivalence proof**

| Check | Result |
|---|---|
| SQL: the 3 distinct classes on the 29 changed lines, old against new, in PostgreSQL 16.15 (scratch cluster, port 54493), every code point 1..0x10FFFF except the surrogates (1,112,063), alone and inside `'ab' … 'cd'` (`bidi/eq-sql.py`, `bidi/eq-sql-output.txt`) | 0 differences; 78, 79 and 73 code points match, the same above U+009F as listed |
| SQL: the rest of each changed line is identical apart from the class | asserted by `eq-sql.py` |
| JS: the 7 changed regex literals over every code point 0..0x10FFFF (and inside a longer string) (`bidi/eq-js.mjs`, `bidi/eq-js-output.txt`) | 0 differences |
| JS: the 8 changed strings by value | all equal |
| `node scripts/make-fake-stock.mjs --check` | exit 0: committed stock fixtures byte-identical |
| `sales_attack` still plants U+202E: a manual mutation dropping `\u202A-\u202E` from `record_sale`'s description pre-check (line 1378), scratch copy | caught by exactly that case (`sales_attack.sql:313: FAIL … "Secret \u202e item"`) |

## 2. Master Plan section 9, Day 6

`docs/TopStock_CRM_Master_Plan.md` section 9 still said "Inventory basics" (log, 11 Oct: Haider's in-depth scope;
the Day 4a advisor round 1 row carried "update Master Plan section 9 for Haider's in-depth inventory scope" to Day 6). The Day 6 entry now describes 6a to 6e as built, under a quoted
note: **plan change (15 Oct 2026), for Haider to approve when Day 6 merges**. Section 10 (Release 2) is unchanged; the
entry ends with what Release 2 keeps.

## 3. Hosted dev pre-check

Read-only, through the Supabase MCP scoped to the DEV project. `share_reader` preconditions:
`docs/evidence/day6e/README.md` "Hosted dev pre-check (15 Oct 2026)"; pg_cron: `docs/evidence/day6d/README.md`, same
heading. In short: PostgreSQL 17.11; `postgres` has CREATEROLE and is not a superuser; `share_reader` does not exist
yet; pg_cron is available (1.6.4) but not installed. **No blocker** for the `share_reader` block (the migration
already lends CREATE on `public` around the ownership hand-over, which a non-superuser needs; simulated locally).
**One decision for Haider:** enable pg_cron on dev before Day 6 merges, or the dev deploy schedules no nightly job.

## 4. Day 6d docs fix

`docs/evidence/day6d/README.md` (rebase points) and two comments in `20261019090000_sales_requests.sql` said "Day 4c
may redefine" `private.task_guard`. Day 4c left it as it was; Day 5a's `20261015090000_deals_pipeline.sql` redefines
it (`deal_id` joins the referential exception). Corrected (comments only).

## Checks (head after these commits)

| Check | Result |
|---|---|
| Bidi scan (`bidi/scan.py`) | 0 lines, 0 files |
| `npm run lint` | 0 errors (3 warnings, as before: TanStack Virtual and the React Compiler) |
| `npm run typecheck` | exit 0 |
| `npm run test:unit` | 402 passed |
| `db-test.sh`, scratch copy on port 54493 (all migrations as they stand after the comment fix) | exit 0: all 16 suites passed (`rls_attack` to `share_concurrency`); advisors 0 ERROR (WARN `anon_security_definer_function_executable` for `share_view` / `share_request` by design, `set_user_role` as before; INFO unindexed FKs 2, unused indexes 10) |
| Mutation anchors (`scripts/db-mutations.py`, all 7 sets, 365 rows): how often each edit's text, mirrored ones included, occurs before and after | identical; every row applies exactly once. Only day4a row 67 ("Task guard: C1 controls pass the title pre-check") touches a changed line (its mirror in `sales_requests.sql:775`; the anchor is the unchanged prefix, so it edits the same logic): re-run on a scratch copy, **caught**. No app-mutation row touches a changed line |
| gitleaks (`git --log-opts=400ff4e..HEAD`, and `dir docs/evidence/day6`) | no leaks found |
| Not run | Playwright e2e (the shared local stack is in use by another agent; no UI change); Semgrep (CI only); hosted advisors (Day 6 is not deployed on dev) |

# Merge of main + 4d + Day 5 + Team, 15 Oct 2026

The advisor's pre-PR review listed the items that depend on the Team merge (2 to 8). Day 6 (`day6a-local`) took main
(4c), Day 4d, Day 5 and Team in 92a5132 (team-local 877b9b5), then PR #17's final head in two steps: e038d65 (Day 5's
admin-only deal delete, Team wording, evidence; 0b2b229) and 429c187 (two WebKit fixes; 424ef1d). Local only, fake data
only, nothing pushed.

| Commit | What |
|---|---|
| 92a5132 | Merge of main (4c), 4d, Day 5 and Team: every day's lines kept (item 6), `src/lib/http.ts` as one module (item 4), import_attack's FK array as the union (item 3) |
| efa55e1 | Items 2 and 3: Day 6's copies of `task_guard` and `lead_import_untouched` rebased on Day 5a's and 4d's bodies; Day 6 tests on Day 5's deal schema; Day 5 tests on Day 6's objects |
| 865c002 | Item 5: the deal picker on Day 5's deal schema |
| 62e87c8 | `db-mutations.py`: mirrors follow the function; `--anchors` reports dead edits |
| 9c6965d | `stock_attack` deletes a deal as an admin; Haider's answer on holds after an undone loss (day6d README) |
| 0b2b229 | Merge of e038d65 (one conflict, `docs/log.md`: both sides' rows kept) |
| 424ef1d | Merge of 429c187 (`board.tsx` offline sensors, `dock.tsx` ResizeObserver; Day 6 changes neither file) |
| a8bbb2f | Item 7: the lead page's Stock and Files tabs load their code when first shown |
| 8abd686 | Mutation day6a row 45 re-aimed (6e replaces the policy it edited) |
| 5eb7f51 | e2e: specs sharing one stack in CI's order no longer trip over Day 6 data |
| a083511 | Command menu: one ranked list while searching (cmdk never reorders groups); lead-page.spec reads Day 6's Stock tab |
| this commit | `clearStockHistory()` shared with the import specs; sales.spec types the whole lead name; this section, the re-taken shots, log rows |

## Advisor items

| # | Item | Status | How |
|---|---|---|---|
| 2 | `private.task_guard` keeps Day 5's body plus Day 6's links | done (efa55e1) | `deal_id` back in the referential exception and the `new.deal_id` check, with 6d's `source_product_id` / `source_request_id`; deals_attack `deal_delete_keeps_activities_and_tasks` passes; mutation rows (Day 4a's three, Day 5a's `deal_id`) also remove the protection from 6d's live copy (`ALSO_IN_6D`) |
| 3 | `lead_import_untouched` copies, import_attack FK union, `stock_alerts`, other shared functions | done (efa55e1, 92a5132; checked again here) | The 6a, 6d and 6e copies keep 4d's `and not private.lead_has_files(c.id)` (files_attack section 12). import_attack's array is the union of the ten FKs. `stock_alerts`: Day 5c creates the stub only if absent (`to_regprocedure` check), 6d `create or replace`s it. Every function a Day 6 migration redefines was listed against earlier days: besides those three, only `private.import_batch_guard` (Day 3b's, untouched since; 6c adds the stock path and a per-kind open cap), the rest are Day 6's own |
| 4 | `src/lib/http.ts`: one module | done (92a5132) | main's `assertSameOrigin(headers)` (Sec-Fetch-Site, first `x-forwarded-host`, Origin "null" refused) and `readJsonBody` reading through 6e's streaming byte cap (and refusing non-UTF-8); share routes and `share.spec` use it; `http.spec` has the streaming cases |
| 5 | Deal picker on Day 5's schema | done (865c002), verified | `src/lib/sales/deal-option.ts`: title or "Deal", Day 5's stage words, the value only when set; undecided deals offered; `sales.spec` unit cases and `deal_picker_day5_shape` (sales_attack 11c) pass |
| 6 | Every day's lines kept | done (92a5132), verified | db.yml, db-test.sh, db-mutations.py, db-perf.sh, playwright.auth.config.ts (WebKit union), messages (key union), eslint/next config (both CSPs' headers), globals.css, step-up union, lead page (Deals, Stock, Files tabs), palette, shortcuts sheet, messages.spec, design.md, log.md. Migration order: Day 5 `20261015090000`/`120000`/`150000`, Team `20261015200000`, then Day 6 `20261016090000` to `20261020090000`: every redefinition comes after the body it rebases |
| 7 | Lead page chunk vs 60 KB | **fixed** (a8bbb2f) | Measured 124.3 KB gzip over the app shell after the merge (4d's Files tab, Day 5's deal sheets, Day 6's Stock tab and its sheets). The Stock and Files tabs are now `next/dynamic` (ssr off), mounted on first showing and kept; pointing at or focusing the tab fetches the code ahead; card skeleton while it arrives. **56.8 KB** (5 files) |
| 8 | Pipeline and Home re-measured | done | Pipeline **56.4 KB** of 60; Home **10.3 KB** of 20 (Chromium 141, `/opt/pw-browsers/chromium`) |

## The e038d65 merge (Day 5's admin-only deal delete)

No Day 6 migration recreates `private.deal_cards`, `list_lead_deals`, `get_deal` or `home_attention`, so `can_delete`
needs nothing on Day 6's side (`list_lead_deals_for_stock` returns its own columns). The only Day 6 test that deletes a
worked-on deal (`stock_attack` deal_delete_releases_holds) already does it as an admin (9c6965d); its comment now names
the admin-only rule. Mutation rows 74 to 76 (Day 5a) are in the merged script and caught here.

## What the re-runs found (fixed)

- **Mutation day6a row 45 was dead.** 6e drops and recreates `inventory_settings_update` (managers reach the row to
  switch sharing off) and moves the admin-only rule for the other settings into its guard, so the row edited a policy
  that no longer exists and was NOT CAUGHT. Re-aimed to also remove the guard's admin check: caught. A scan of every
  row that edits a `create policy` found no other policy dropped later (`--anchors` covers functions only).
- **e2e specs sharing a stack.** CI runs every auth spec in one stack, alphabetically. After `inventory.spec`, every
  later `seedLeads` failed (a lead with stock history is kept: `stock_reservations` and `orders` restrict), which would
  have failed `lead-page.spec`, `leads.spec` and `screens.spec` in CI; `seedLeads` now clears Day 6's stock history
  first, whole. Two Day 6 assertions read across organisations (Home's fixture adds one) and the shell's bead drag
  expected the Inventory heading without its count; each now reads its own organisation / the word, as the Leads check does.
  The reset is one helper, `clearStockHistory()`, also called by `import.spec` and `import-perf.spec` before they empty
  the leads and imports (with a stock import's undo records, which hold `import_batches`).
- **`sales.spec` empty_sections_and_palette_record_sale** typed the first word of its lead ("Atelier") in the sale
  sheet's lead picker; after `leads.spec` (120 made-up leads, many "Atelier …") the lead was past the picker's first
  answers. It types the whole name now.
- **`lead-page.spec` deals_stock_empty_states** still expected Day 4's Stock placeholder on both sides of the merge (Day 6
  never re-ran it); it now checks Day 6d's empty sections, after the tab's code loads.
- **The command menu ran the wrong item.** Typing "dark" and Enter opened Hold stock (or Inventory settings for an
  admin): cmdk 1.1.1 sorts items inside a group but never reorders groups (its lookup compares the group's id with the
  heading text), so Day 6's longer Actions values ("hold days", fuzzy score 0.14) came before Appearance's exact match
  (0.90). While a search is typed the menu is now one list without headings, sorted by score; the empty menu keeps its
  groups. `shell.spec`'s Appearance step and `screens.spec`'s menu shots pass.

## Checks (this commit)

| Check | Result |
|---|---|
| `npm run lint` | 0 errors (3 warnings, as before: TanStack Virtual and the React Compiler) |
| `npm run typecheck` | exit 0 |
| `npm run test:unit` | 587 passed (sql-bidi, http.spec, share.spec included) |
| `db-test.sh`, scratch copy on port 54493 | exit 0: all 25 suites passed (`rls_attack` to `share_concurrency`); advisors 0 ERROR (WARN `anon_security_definer_function_executable` for `share_view` / `share_request` by design, `set_user_role` as before; INFO unindexed FKs 5, unused indexes 13) |
| `db-mutations.py --anchors` | 622 rows in 13 sets: every edit applies once, none dead |
| Mutations re-run (own scratch copies, ports 54483 to 54507), the rows whose anchors or targets moved | Before the e038d65 merge (62e87c8): day3b 9, day4a 30, day4d 2 (rows 16, 28), day5a 5, day5c 5, day6a 1, day6c 1, day6d 8, day6e 2: all caught except the documented two-layer rows (day5a 28, day6d 15 and 16). After it (current migrations): day5a 14, 15, 19, 44, 47, 57, 65 and the new 74, 75, 76: 10 caught; day5c 11 to 13: caught; day3b 2, 4, 5, 6, 12, 13: 5 caught, row 4 documented two-layer; day6a 7 to 10, 15, 19, 23, 24, 31, 33 to 37, 58 to 60, 62, 66: caught except the documented two-layer rows 10, 31, 33; day6d 18: caught; **day6a 45: NOT CAUGHT, a dead row (above), re-aimed, then caught**. 104 row runs; every result as listed after the re-aim |
| Chromium e2e (Chromium 141, local stack restarted fresh from this worktree, build of a083511) | One run in CI's order: home 15, inventory 11, lead-page 26, leads 9, pipeline 15, sales 8 + 1 failed + 2 not run (the picker item above, fixed), share 12, shell 21, team 5. After the fixes: sales 11 passed, import 11 passed, screens (command menu and shortcuts) 1 passed. Earlier run on the e038d65 build: files 12 (5 storage-api tests are CI only), lead-deals 9, stock-import 6, home 15, pipeline 15, team 5 passed |
| Chunks (PERF=1) | lead page 56.8 / 60 KB; queue 17.9 / 40 KB; Tasks 0 / 35 KB; pipeline 56.4 / 60 KB; Home 10.3 / 20 KB |
| gitleaks (`git --log-opts=400ff4e..HEAD`) | no leaks found |
| Not run / not measurable here | WebKit (not installed here; CI runs it); Semgrep (CI only); hosted advisors (Day 6 is not deployed on dev); `db-perf.sh`; the perf specs' **timing** budgets: twice measured with the VM loaded (load average 9.4 on 4 cores from other sessions' builds and browsers), every timing budget missed (e.g. pipeline route 2.3 to 3.1 s, Home count frame 33 to 47 ms), so they say nothing about the code; only the chunk sizes, which do not depend on load, are recorded. To re-run in CI or on a quiet machine |

## Shots re-taken (only those the merge changed)

`docs/evidence/day6d/screens/`: `lead-stock-*` (24: the lead page with the Deals, Stock and Files tabs together),
`hold-sheet-*`, `sale-sheet-*`, `request-sheet-*` (8 each: the sheets over that page; the fixture lead has no open
deal, so the deal picker is covered by `sales.spec` (unit) and sales_attack 11c rather than a shot), from the final
build's `sales.spec` screens run.
`docs/evidence/day6/screens/`: `palette-*` and `shortcuts-*` (14 each, `screens.spec` "command menu and shortcuts
list": EN/FR, light/dark, 390 to 1728), the menu and `?` sheet with every day's commands and shortcuts.

## Day 5's seam filled in: stock records hold a deal (advisor item 2)

Day 5 left `private.deal_closing_blocked(p_deal)` returning null (`supabase/migrations/20261015090000_deals_pipeline.sql`
:295-301; called by the deal guard at :456, :489, :517, :554 and by `delete_deal` at :1426; design
`docs/evidence/day5/design.md` :87, :169 (D8), :362, :400-413, :1070; Haider accepted on 11 Oct that Day 6 replaces it so
stock records block reopening a won deal, undoing a win, changing the fulfilment and deleting the deal). The new
migration `20261020100000_deal_stock_blocks.sql` sorts after 6e's `20261020090000` and before Day 7a's `20261021100000`.

**The answers.** The callers raise 42501 with hint `'blocked_' || answer`, and `src/lib/db-errors.ts` maps
`blocked_order`, `blocked_sales` and `blocked_reservation` to `blocked` ("Stock records hold this deal. Sort them out
first."). The function returns:

| Answer | When | Why this key |
|---|---|---|
| `'sales'` | a confirmed (not cancelled) sale in `private.orders` names the deal | Day 6's `orders` table is the sale record (shown as "Sale"); `blocked_sales` is already mapped |
| `'reservation'` | no confirmed sale, and an active hold in `private.stock_reservations` names the deal | `blocked_reservation` is already mapped |
| null | nothing holds it; a cancelled sale, a released (or used, or expired) hold; another organisation's caller; an open deal whose shipping is not chosen yet | |

`'order'` (Day 5's third reserved key) is never returned: Day 6 has no separate order record beside the sale. A sale is
checked first because it is the stronger record (a hold can be released in one click; a sale needs a manager's cancel).

**Seeing every record.** `SECURITY DEFINER`, owned by postgres, `search_path ''`, read in the deal's own organisation
(the record helper `private.deal_stock_records` joins on `deal_id` and the deal's `org_id`): a rep's guard is stopped by
a manager's sale the rep cannot read (test `deal_blocked_by_sale_the_caller_cannot_see`). Day 5's grants stay (revoked
from public and anon, executable by authenticated: the guard and `delete_deal` run as the caller; `private` has no API
endpoint). A signed-in caller of another organisation gets null, so the function answers nothing by id across
organisations. Day 5's catalog check (deals_attack.sql, helpers INVOKER) now lists it separately as DEFINER owned by
postgres.

**The first shipping choice.** Day 6d lets an open deal with no shipping chosen take holds and either kind of sale; its
Win (or a choice while open) is the first decision, and Day 5's guard calls the seam on it without the new value. So the
seam answers null for an open, undecided deal, and the AFTER UPDATE trigger `fit_deal_fulfilment_to_stock` (WHEN the
shipping goes from null to a value) checks the chosen value: a confirmed sale of the other kind gives `blocked_sales`;
Supplier Stock while an active hold names the deal gives `blocked_reservation`. A choice that fits (the usual Win after a
hold or a warehouse sale) goes through. Without this, every deal that took a hold before its Win could never be won.

**Delete and the hold-release trigger (stock_attack `deal_delete_releases_holds`).** Decision: an active hold or a
confirmed sale blocks every signed-in delete. `delete_deal` (the user path) is blocked by the seam; an undecided deal,
and a direct `DELETE` through the API (`deals_delete` lets an admin with a fresh code, or the creator in the first
120 s, delete), are blocked by the new BEFORE DELETE trigger `block_deal_delete_on_stock`, which sorts before
`release_deal_holds_deleted` so it sees the holds still active. A session with no signed-in user (maintenance, the
service role, a test reset) is not blocked: Day 6a's release trigger stays and releases the holds (`deal_deleted`, no
person). The test now checks the block (through `delete_deal` and a direct delete: 42501 `blocked_reservation`, the
hold still active and linked), then releases the hold and deletes (the hold ends `manual`, loses the link, no
`deal_deleted` row); the maintenance delete test beside it is unchanged.

**Found while testing: a sale's deal could never be deleted.** `orders.deal_id` is `on delete set null`, but that update
reached Day 6d's sale guard and was refused (`not_editable` for a person, `sign in first` for maintenance), so a deal
named by any sale, even a cancelled one, could not be deleted by anyone (the pipeline spec's maintenance cleanup only
worked because `clearStockHistory()` runs first). `private.order_guard` is redefined here (6d's body verbatim plus one
first branch): the foreign key's action (trigger depth 2) may empty `deal_id` and change nothing else; the same change
made straight is still refused (test `deal_delete_by_maintenance_unlinks_sale`). A cancelled sale's deal can now be
deleted (the sale keeps its lines and ledger rows); a confirmed sale still blocks a signed-in delete.

**A sale must fit its deal.** `order_guard` checked only the lead and Closed/lost (sales_requests.sql :307-313) and the
UI filter in `src/lib/sales/deal-option.ts` is not a control. The new BEFORE INSERT trigger `order_guard_deal_fit`
(after `order_guard`, so the deal is already known visible, on this lead and not lost) refuses a sale whose kind differs
from the deal's chosen shipping: 22023, the existing hint `fulfilment`, already worded in the sale sheet as "Choose
Warehouse inventory or Supplier Stock (it must match the deal)." (no app change). An undecided deal takes either kind.
It locks the deal row (`FOR SHARE`): a concurrent shipping change and sale are ordered, and whichever waits sees the
other's committed row (sales_concurrency case 8, both orders).

**Tests.**
- sales_attack.sql 11d: catalog (the seam a postgres-owned definer, not anon; the helper and trigger functions definers
  nobody can call; the three triggers' kinds); `deal_blocked_by_sale_on_reopen`, `_on_undo_win`, `_on_fulfilment_change`
  (a patch, `update_deal`, emptying it), `_on_delete` (`delete_deal` and a direct DELETE by an admin with a fresh code);
  the seam answers null to another organisation; `deal_unblocked_after_sale_cancelled` (both sales undone: reopen,
  shipping change, `delete_deal` and a direct delete go through); `deal_blocked_by_sale_the_caller_cannot_see`;
  `deal_delete_by_maintenance_unlinks_sale`; `deal_blocked_by_hold_on_fulfilment_change` (to Supplier Stock and to
  none), `first_choice_supplier_blocked_by_hold` (a patch and a Win; Warehouse fits), a Win that keeps Warehouse with a
  hold, then its undo and a reopen blocked, `_on_delete` (both ways); `deal_unblocked_after_hold_released`;
  `first_choice_blocked_by_other_kind_sale` (a patch and a Win; the fitting Win passes); `sale_kind_must_fit_deal`
  (`record_sale` both ways, a direct insert; no kind, the same kind and no deal pass). Integrity checked after each.
- stock_attack.sql: `deal_delete_blocked_by_active_hold`, then `deal_delete_releases_holds` (released first).
- deals_attack.sql (Day 5's seam test unchanged and passing: its stub swap still works, a random id still gives null):
  the catalog check above, and the trigger list with the two new deal triggers.
- sales_concurrency.sh case 8 `sale_vs_deal_shipping_change`.
- e2e `pipeline.spec` `shipping_change_blocked_by_sale_says_why`: an open Warehouse deal named by a confirmed sale; the
  sheet's switch to Supplier Stock answers "Stock records hold this deal. Sort them out first." and nothing changes. The board's Reopen
  and Delete use the same mapping (`toActionFailure`, `Errors.blocked`), so one e2e covers the words.

**UI.** The design's line "From Day 6 the button is hidden when `deal_closing_blocked` says so" (:1070) is not done:
the card and sheet reads (`private.deal_cards`, Day 5's) carry no blocked flag, and adding one means recreating them in
a Day 6 migration. Reopen, Undo, the shipping switch and Delete stay offered and answer with the mapped words; the
database decides either way. Open for Haider as a small follow-up if he wants the buttons hidden.

**Mutations (set `day6`, `scripts/db-mutations.py`; own scratch copy, port 54493).** The new migration is added to
`REDEFINERS`, so Day 6d's rows aimed inside `order_guard` are made in its copy too (`--anchors`: 644 rows in 14 sets,
every edit applies once, none dead).

| # | Protection removed | Result | First failure |
|---|---|---|---|
| 1 | Seam: a confirmed sale does not hold the deal | caught | the seam answers null for a won deal with a sale |
| 2 | Seam: a cancelled sale still holds the deal | caught | a cancelled sale still blocks |
| 3 | Seam: an active hold does not hold the deal | caught | stock_attack: delete_deal succeeded, expected 42501 |
| 4 | Seam: a released hold still holds the deal | caught | a released hold's deal blocked ("this deal is held by stock records") |
| 5 | Seam: answers null always (Day 5's stub back) | caught | the seam answers null for a won deal with a sale |
| 6 | Seam: no exception for an undecided deal | caught | an undecided deal is blocked before its first shipping choice |
| 7 | Seam: the exception covers every open deal | caught | e2 shipping change succeeded, expected 42501 |
| 8 | Seam: runs as the caller (SECURITY INVOKER) | caught | deals_attack catalog |
| 9 | Seam: answers a caller of another organisation | caught | the seam answers another organisation |
| 10 | Seam: callable by anon | caught | deals_attack catalog |
| 11 | The record helper callable by signed-in people | caught | sales_attack catalog |
| 12 | First shipping choice not checked (trigger dropped) | caught | deals_attack trigger list |
| 13 | First shipping choice: a sale of the other kind ignored | caught | e5 switch to Warehouse succeeded |
| 14 | First shipping choice: Supplier Stock with an active hold allowed | caught | e4 switch to Supplier Stock succeeded |
| 15 | Delete: no BEFORE DELETE block (trigger dropped) | caught | deals_attack trigger list |
| 16 | Delete: the block lets signed-in sessions through | caught | stock_attack: a direct delete succeeded |
| 17 | Delete: maintenance deletes blocked too | caught | the maintenance delete refused |
| 18 | Sale kind guard dropped (trigger) | caught | record_sale of the other kind succeeded |
| 19 | Sale kind guard: kinds not compared | caught | record_sale of the other kind succeeded |
| 20 | Sale kind guard: the deal not locked (FOR SHARE) | caught | sales_concurrency case 8 (a): a warehouse sale named a Supplier Stock deal |
| 21 | Sale guard: a deal delete's set null refused again | caught | not_editable on the cancelled sale's deal delete |
| 22 | Sale guard: the deal-delete branch at any depth | caught | a straight update of deal_id succeeded |

day6: 22 rows run, 22 caught. Day 5a's rows that remove a call of the seam (53 undo of a win, 54 a win that changes the
shipping, 55 reopening a won deal, 56 a same-stage shipping change, 57 `delete_deal`): 5 caught (Day 5's stub test).
Day 6d's rows now mirrored into the `order_guard` copy (12, 14): 2 caught. 29 row runs, every result as listed.

**Checks (this section's commits).** Lint 0 errors (3 warnings as before); typecheck exit 0; unit 588 passed;
`db-test.sh` on a scratch copy (port 54493): exit 0, all 25 suites (sales_concurrency with case 8), advisors 0 ERROR
(WARN `share_view` / `share_request` anon definers by design, `set_user_role` as before; INFO unindexed FKs 5, unused
indexes 13: unchanged); Chromium e2e on the shared local stack (migration applied, build of a083511's code; stock
history and the inventory catalogue reset first, so the run matches CI's fresh stack): inventory 11, lead-deals 9,
lead-page 26, pipeline 16 (with the new test), sales 11: 73 passed. (A first run without that reset failed only
`inventory.spec` stock_table_filters_and_panel: earlier runs' `clearStockHistory()` had emptied the levels while its
seed marker stayed, so Polo was no longer Low; not this change.) gitleaks on `de0c7c3..HEAD`: no leaks found.

## Day 6 merge: /security-review

Result: **NO FINDINGS.** Checked on the merged Day 6 branch: the bidi rewrites refuse the same characters as before;
the `task_guard`, `lead_import_untouched` and `stock_alerts` copies are supersets of the bodies they replace; `http.ts`
keeps `Sec-Fetch-Site`, the first entry of `x-forwarded-host`, the refusal of `Origin: null` and the streaming byte cap;
the share routes keep the order same-origin, capped read, Zod, per-IP limiter; the `next/dynamic` tabs leak nothing;
`list_lead_deals_for_stock` is security invoker under the deals policies; `clearStockHistory()` is test-only; the command
palette has no sinks; CSP and security headers are intact; CI permissions are unchanged. The deal stock blocks migration
above adds four definer functions, each with `search_path ''`, revoked from every client role (the seam keeps Day 5's
authenticated-only grant), constant error messages and hints only, no dynamic SQL and no user text in any error.
