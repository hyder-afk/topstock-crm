# Day 6 final design: Inventory, sales, stock sheets and the client stock link

> **How this was produced (11 Oct 2026).** A design workflow wrote three independent designs: security-first, data/performance-first and owner-UX-first. Three judges scored them. Two picked the **security-first design** and one picked the **data design**. This document starts from the security design. It adds the ideas the judges listed, it answers every risk they raised (section 2.3), and it says which option won wherever the designs disagreed (section 2.2).
>
> The largest change from the security design is the **stock engine**. All three judges said the custom database roles that would own the stock core (`stock_ledger`, `share_reader`) were the riskiest part to build on hosted Supabase. So this design uses the data design's engine instead. Every RPC is SECURITY INVOKER and only inserts rows into a private, append-only ledger. A trigger owned by `postgres` is the only code that writes stock levels. That removes the `stock_ledger` role entirely. Only one custom role is left, `share_reader`, which owns the two functions behind the public client page. It has its own spike and a fallback.
>
> The repo was re-checked at `17d0354` (the Day 4a branch; `main` is at `4fe5641`, where Day 3b is merged). That check found four gaps that none of the three designs covered:
> - **Ledger ids and `created_at` do not show the order in which movements were applied.** Both are set when the row is formed, before the trigger waits for the lock. So "moved in the CRM since the last sheet" and "this import was the last to change this stock" cannot be read from them. This design uses fields that are set under the lock instead (3.1, 4.6).
> - **The proxy walls `/robots.txt`.** The matcher sends it to `/login`, so `src/app/robots.ts` alone would never be served (8.9).
> - **`ALTER FUNCTION … OWNER TO share_reader` needs `CREATE` on the schema** for the new owner, as well as membership (spike S1).
> - **A payload hash gives the "unchanged" answer for polls.** That is exact even when commits land out of order. A data cache keyed on a stock version is not (D28).
>
> Builder's choice on top of the judges: **five PRs instead of four**. The engine is reviewed alone, with no screens, because the judges said the PRs were too large (D1).

---

## 1 Summary (plain words)

**What the team gets**

1. **An Inventory page** at `/inventory` with these tabs:
   - **Stock**: each product once, with In Warehouse, In Transit, held, available, cartons, price range, cost (managers and admins only) and a status shown as a dot and a word.
   - **Arriving**: In Transit stock with its expected date and an **Arrived** button.
   - **Reserved**: what is held, for which lead and deal, and until when.
   - **Movements**: an append-only log of who changed what, when and why.
   - **Sales** and **Requests** (from 6d).

   Clicking a product opens its panel on the right. On a phone it opens a full page.
2. **Products come from Haider's stock sheet.**
   - CATÉGORIE is the product name.
   - PRIX PAR PCS and PRIX PAR PCS MAX are the minimum and maximum selling price per piece in EUR.
   - QUANTITÉ is pieces (0 means sold out). QTY PAR CARTON is pieces per carton.
   - PP is the total purchase cost of the lot. The CRM keeps cost per piece = PP ÷ QUANTITÉ in a separate table that only managers and admins can read.
   - REVENTE MIN and MAX are never stored. The CRM works them out, and the import checks the sheet's totals against quantity × price.
   - STATUS says where the pieces are: In Warehouse (France) or In Transit.
   - Cartons per pallet, reorder point, category and the expected arrival date are set in the app.
3. **Stock sheet import** at `/inventory/import`. It uses the same steps as the lead import: choose file, match columns, check, import, undo.
   - Haider's French headers match with zero clicks.
   - French numbers like "1 234,56" are understood.
   - The file never leaves the browser.
   - It needs an admin with a fresh authenticator code.
   - A second sheet updates the products it lists. Quantities change only for products nobody sold, received or corrected in the CRM since the last sheet, unless Haider ticks "use the sheet".
4. **Sales.** "Record sale" works from a lead, a request, a hold or a product row.
   - **Warehouse inventory** sales take stock down at once, through the engine.
   - **Supplier Stock** sales (sold from Pakistan and shipped straight to the client's country) never touch warehouse stock.
   - A sale records the lines, the pieces, the price per piece, and a deal when there is one.
   - **Undo** works for 2 minutes without a code. After that, a manager or admin cancels with a fresh code.
5. **Holds (reservations)** keep stock for a lead, and for one of its deals when there is one.
   - They end on a date (14 days by default).
   - They are released when the deal is lost or deleted.
   - A sale uses them up automatically.
   - Stock that is still in transit can be held too. When it arrives, the holds move with it.
6. **The lead's Stock tab** has four sections:
   - **Wants**: requests, with live availability next to each line;
   - **Reserved**: holds;
   - **Bought**: sales;
   - **Client link**: the lead's share link.
7. **Automations:**
   - low stock opens one "Restock" task and feeds the Home card;
   - a client request opens one task for the lead's owner;
   - Arrived moves stock and holds into the warehouse, and gives each hold's creator a "record the sale" task;
   - sold-out products disappear from client links by themselves;
   - a lost deal releases its holds;
   - holds end on their date;
   - a late arrival is flagged on Home;
   - a nightly integrity check runs where the database scheduler is available.

**What clients get**

- A **private link per client**, sent on WhatsApp or by email: `…/s/fr#tss_…`.
- A phone-first page in French or English, in TopStock's brand, titled "Stock available now". It shows:
  - each product's name;
  - the **maximum price per piece**;
  - available pieces and cartons;
  - an "Arriving" section with the week the stock is expected.
- A **request form**: "I want this, this many" or "find me something else". The team then arranges it with the supplier.
- The page never shows costs, minimum prices, holds, other clients, or any lead data. It does not even show the client's own company name.

**How stock stays right**

- Every stock change is one row in an append-only ledger. Rows are never edited or deleted.
- One engine applies each row. It locks that product's stock row, re-checks the rules, and updates the totals in the same transaction:
  - stock never goes below zero;
  - nobody holds more than is there;
  - nobody sells stock held for another client.
- Nobody can write stock totals directly, not even an admin through the API. The engine's write step is the only code that does.
- **Two people selling the last cartons at the same moment:** one sale goes through. The other gets "Only 0 left", and nothing is saved for it.

**How the client page stays safe**

- The link's secret sits after the `#`, so it never reaches a server log, a link preview or a Referer header.
- Only a SHA-256 hash of the secret is stored. Links end on a date, can be revoked at once, and show when they were last opened.
- The internet can reach **two database functions** and **two web routes**, nothing else.
  - The functions run as a role that cannot read cost or minimum-price columns, lead data, or another organisation.
  - Every link and every organisation is rate-limited inside the database.
- A master switch, **off by default**, turns all sharing off at once. It stays off in production until Haider switches it on after Gate 1.

**Proof**

- Database attack tests, each shown to fail when its protection is removed (mutations).
- Two- to twenty-session concurrency tests.
- A 1,000-random-operation integrity test.
- Unit tests, and end-to-end tests in Chromium and WebKit, including the client page opened signed out.
- Timings at 5,000 products and 200,000 movements.

**Five PRs**, each with its own migration, attack test file, evidence folder and advisor loop:

| PR | Contents | Why separate |
|---|---|---|
| **6a Stock engine** (database only) | products, costs, locations, levels, the ledger and its engine, holds, `post_stock_movement`, deal triggers, expiry, integrity check, product RPCs | The invariants and the concurrency proofs, reviewed with no screens (the Day 4a lesson) |
| **6b Inventory page** | read RPCs; Stock, Arriving, Reserved and Movements tabs; product panel; new product, edit, archive, correction, manual receipt, Arrived; settings | The first UI over the engine |
| **6c Stock sheet import** | staging, changes ledger, the stock branch of the Day 3b batch guard, the import lock helper, 10 RPCs, `/inventory/import`, fake sheets | It changes the approved Day 3b guard and needs its own lead-import regression run |
| **6d Sales, holds, lead Stock tab, automations** | orders, lines, cost snapshots, record/undo/cancel sale, hold sheet, team-logged requests, Sales and Requests tabs, lead Stock tab, system tasks, `stock_alerts()` for Home | Money and lead data; touches Day 4 tables (`tasks`, `task_guard`, the lead page) |
| **6e Client stock link** | `share_reader`, share links, rate counters, the two anon functions, `/s/[locale]`, `/api/share/*`, proxy branch and share CSP, links UI, "What clients see", "Send stock list as text" | The first page reachable without signing in. Sharing ships **switched off** |

**Changes from the winning design** (each comes from a judge's finding):

1. There is no `stock_ledger` role. The RPCs are invoker, the ledger is in `private`, and a `postgres`-owned trigger applies each row. The security design's core would have failed on its first call: `FOR SHARE` as a role holding only SELECT needs UPDATE privilege and an UPDATE policy, and the role also lacked EXECUTE on the private helpers and USAGE on schema `auth`.
2. The share link lookup is bound to the presented token's hash (`topstock.share_token_hash`). The organisation is set only after that. As written, the security design's lookup always answered "inactive".
3. The 2,000-item cap on the client page applies **after** the "in stock" filter.
4. The token is generated **in the database** (`gen_random_bytes` in the insert guard). It has a `tss_` prefix and a gitleaks rule. The guard ignores any hash the client sends.
5. The public page receives only the `Share` messages. Today the root layout sends every namespace.
6. Automation tasks are created as **system** rows (claims cleared for that one insert). They use `kind 'todo'` plus link columns, not a new `kind`. Before this, a rep's sale that crossed a reorder point would have rolled back on `enforce_org_and_owner('assignee_id')`.
7. The stock import keeps the Day 3b chunked commit. Each chunk locks its products, then applies **targets** under the lock.
8. Quantities are entered in **pieces** by default, with a cartons toggle (Haider, 7 Oct: "stock is sold by the piece").

---

## 2 Decisions

### 2.1 Facts checked in the repo (at `17d0354`)

| Fact | Where | Consequence for Day 6 |
|---|---|---|
| Private helpers are revoked from everyone and granted to `authenticated` only. New private functions get no PUBLIC execute | `20261009180000_core_schema.sql` lines 545–548 | A custom definer role would need explicit EXECUTE on `current_org_id`, `has_aal2`, `has_recent_aal2` and `is_manager_or_admin`. The engine avoids custom roles (D2). `share_reader`'s code path calls none of them (8.5) |
| `has_aal2` and `has_recent_aal2` read `auth.jwt()`. `current_org_id`, `is_admin` and `is_manager_or_admin` are definer functions reading `profiles` | core schema lines 42–80 | Guards run as invoker in the caller's session, so these work as they do on Days 3 and 4 |
| `enforce_org_and_owner` skips sessions with no `auth.uid()`. For a rep, an insert whose owner column is someone else raises "reps can only create records they own". The `tasks` owner column is `assignee_id` | core schema lines 294–333 (refusal at 326), 365–366 | A rep's sale that opens a task for Haider would fail. System tasks clear the claims for that one insert (D22, spike S3) |
| `tasks.kind in ('todo','call','meeting')`. `task_guard` skips sessions with no user. On insert it sets `created_by` and applies a 60-a-minute flood guard. On update it lets FK columns become null only at depth > 1, from a fixed list | `20261011120000_activity_hardening.sql` lines 182, 210–311 | No new `kind`. 6d adds `source_product_id` and `source_request_id` to the depth > 1 list, otherwise a lead delete with a request task fails |
| `deals.company_id` is nullable (`on delete set null`). `status in ('open','won','lost')`, and lost needs `lost_reason`. `fulfilment in ('from_stock','direct_from_source')`. `deals_rw`: the owner, managers and admins | core schema lines 177–199; `20261010090000` lines 253–258 | Day 6 links holds and sales to deals using these columns only. A deal with a null lead never matches (D-contract, 12.1) |
| `import_batches.kind` allows `'stock'`, but the insert grant leaves `kind` out. `import_batches_one_writer_idx` is per org | core schema line 103; `20261010150000_lead_import.sql` lines 189–190, 196 | 6c grants `insert (kind)`. The index becomes per `(org_id, kind)` (D11) |
| The batch guard reads `private.lead_import_staging` and skips sessions with no user. `staging_insert` checks `kind = 'leads'`. `validate_lead_import`, `commit_lead_import` and `rollback_lead_import` **never check kind** | lead_import.sql lines 255–261, 352–444, 564, 724, 846 (kind only at 260, 326, 485, 959) | The stock branch of the guard refuses every lead-only transition for a stock batch. Test `lead_rpcs_refuse_stock_batch` |
| `audit_row` is SECURITY DEFINER. Hidden keys are `search_text`, `email_key`, `phone_key`, `name_key`. It has an activities branch. `audit_log.record_id` is `text` | 4a lines 345–391; core schema lines 267–276 | Ledger rows (bigint ids) can be audited. Day 6 adds a minimal ledger branch, `token_hash` (hidden) and the link counters (no diff) |
| `lead_import_untouched` (4a version) knows activities, contacts, deals and tasks. `import_fk_coverage` compares `conrelid::regclass::text` | 4a lines 394–405; `import_attack.sql` lines 139–143 | Each Day 6 table pointing at a lead joins both. Private tables print as `private.orders` |
| `rls_attack.sql` §1 lists the tables and functions anon must not reach | lines 86–108 | 6e turns it into a catalog allowlist: anon may execute exactly the two share functions |
| `[api] schemas = ["public"]`, `max_rows = 1000`, `major_version = 17`. Local runner: PostgreSQL 16, superuser `postgres`, an auth shim whose `auth.uid()` reads `request.jwt.claims` only. pgcrypto is installed locally; pg_cron is not | `supabase/config.toml` lines 14, 20, 42; `scripts/db-test.sh`; `supabase/tests/shim.sql` | `private` has no REST endpoint. Any RPC returning more than 1,000 rows is cut silently, so share and list RPCs return `jsonb` or pages of ≤ 200. Nothing depends on pg_cron (D8) |
| Proxy: public paths are `/login`, `/forgot-password` and `/auth/confirm`. It refreshes the session cookie on every request. `/api/*` answers 401. The CSP `connect-src` includes the Supabase origin. `matches()` is exact-or-prefix. The matcher catches `/robots.txt` | `src/proxy.ts` | 6e adds a share branch before the Supabase block. `/robots.txt` becomes public, otherwise robots would be redirected to `/login` |
| Global headers: HSTS, nosniff, `X-Frame-Options: DENY`, `Referrer-Policy: strict-origin-when-cross-origin` | `next.config.ts` | Share headers go in a later entry of `headers()` (in Next, the last entry for a path wins). The e2e test proves it |
| The root layout wraps everything in `NextIntlClientProvider` with no `messages` prop (next-intl 4.14.9 then passes all messages). The locale comes from a cookie | `src/app/layout.tsx`, `src/i18n/request.ts` | The share surface loads only the `Share` messages, chosen by a proxy-set header (D30, spike S4) |
| `public/` is empty. There is no `.gitleaks.toml`; the CI runs default rules | `public/`, `.github/workflows/gitleaks.yml` | 6e adds `src/app/robots.ts` and `.gitleaks.toml` (extending the defaults with `topstock-share-token`) |
| Inventory is a placeholder. `G then I` already goes there | `src/app/(app)/inventory/page.tsx`, `src/lib/shortcuts.ts` | 6b replaces the page and its `loading.tsx` |
| The lead page lives in `src/components/lead/*` and its Stock tab shows "nothing yet" | Day 4 design §10 (4b), §11 Q8 | 6d: `src/components/lead/stock-tab.tsx` |
| `normaliseHeader` removes text in parentheses | `src/lib/import/headers.ts` lines 13–18 | `PRIX PAR PCS (… MIN)` becomes `prix par pcs`. The stock matcher also reads the words inside the parentheses (7.2) |
| Step-up helpers: `useStepUp(...).ensureFresh`, `stepUpSecondsLeft`, `STEP_UP_SECONDS = 600`, `requireSession`, `apiSession`, `requireAdmin`; `importError()` | `src/components/auth/step-up-dialog.tsx`, `src/lib/auth.ts`, `src/lib/import-server.ts` | Reused. `stockError()` copies the `importError` pattern |
| Day 4 spike S5(b): `SELECT … FOR UPDATE` under RLS returns no row, and no error, when the UPDATE policy fails | `docs/log.md`, 11 Oct | `record_sale` uses it to check "may change this lead" and to lock the lead row for the first-sale status change |
| `companies.lead_status` includes `customer`, `do_not_contact` and `disqualified` | `20261010090000` lines 11–12 | First sale → Customer (open question 15) |
| Haider, 7 Oct: "Stock is sold by the piece". The prototype counts sneakers in pairs | `docs/log.md` | Pieces stored and entered by default (D12). A display word per product, pcs or pairs (open question 16) |
| Haider, 11 Oct: the sheet columns, In Warehouse / In Transit, the two order types, the client view with the max price, client requests | `docs/log.md` | Binding inputs for this whole design |
| Cloud Workflow §6: previews sit behind Vercel login; the production URL is public and serves the **dev** database until Gate 1; Hobby is non-commercial | `docs/TopStock_CRM_Cloud_Workflow.md` | Sharing ships switched off (D34) |
| Pinned: Next 16.4.0, React 19.3.0, next-intl 4.14.9, supabase-js 2.117.3, @supabase/ssr 0.12.7, Zod 4.6.5, papaparse 5.7.0, TanStack Table 9.2.4, Virtual 3.14.13, Query 5.103.2, Motion 14.0.0, Supabase CLI 2.120.0 | `package.json` | No new dependency (section 12) |

### 2.2 Where the designs disagreed, and what we chose

| # | Topic | Chosen | Rejected | Why |
|---|---|---|---|---|
| D1 | PR split | **5 PRs**: engine (database only), page, import, sales and lead tab, share | 4 PRs (all three designs) | Judges: the PRs were too large and touched approved objects. The engine gets a focused review with no screens |
| D2 | Single writer of stock | **Data's engine.** `post_stock_movement`, `record_sale` and the import RPCs are SECURITY INVOKER with static SQL. They only insert into `private.stock_movements`. An invoker guard trigger checks the caller. A `postgres`-owned definer trigger, `private.stock_movement_b_apply()`, is the only code that writes `stock_levels` and holds | Core owned by `stock_ledger` (security); a `postgres`-owned definer core called by RPCs (UX) | The security core cannot run as written: it needs an UPDATE grant and policy for `FOR SHARE`, EXECUTE on revoked helpers, USAGE on `auth` (possibly impossible on hosted Supabase), and a role that `pg_dump` does not restore. The data engine meets "SECURITY INVOKER RPCs" literally, and `stock_levels` has **zero** write grants (F1). A trigger function cannot be called directly |
| D3 | Where the ledger lives | `private` schema (no REST endpoint) | `public` with no write grants (security) | Day 3b and Day 4 precedent: "only through the RPC" holds by construction |
| D4 | Locks | In the apply step: product row `FOR SHARE`, then the level rows `FOR UPDATE` in `location_id` order. Multi-line operations go in `product_id` order. A transfer's first line locks both levels. `lock_timeout = 3s` maps to `busy` | Level lock only (data, UX) | The product lock closes the archive-versus-receive race (security's graft). One global order: product id, then product row, then levels by location id. So there are no deadlocks |
| D5 | "Moved since the last sheet" and "this import was last" | Lock-ordered fields on `stock_levels`: `version` (+1 per applied row), `crm_moved`, `last_onhand_batch_id` | Ledger ids (data), `created_at` (security), a `seq` identity (UX) | Identities and `now()` are set before the trigger waits for the lock. A sale that waited behind an import can carry a smaller id than the import's rows (4.6) |
| D6 | Sale and holds | `ship` uses holds automatically, under the lock: the deal's holds first, then the lead's holds with no deal, oldest first, partial use allowed. Check `on_hand − q ≥ reserved − used`. One line per product per order | An explicit reservation per line (data); "Sell held" converting one whole hold (UX) | Judges' graft. It needs no line splitting, and it never sells stock held for another client |
| D7 | Undo and cancel | 2-minute Undo by the creator with no code. It returns the stock and puts back the holds the sale used (as new holds with `restored_from`), if their end date is still ahead. After that, a manager or admin cancels with a fresh code and a reason; holds are not recreated | No Undo, cancel always with a code (data); re-reserving the same hold row (UX, which collides with its once-per-reference index) | CLAUDE.md asks for optimistic updates with Undo. Restoring a hold always fits, because the return puts back at least as many pieces (5.6) |
| D8 | Hold expiry | `hold_until date` (Europe/Paris, inclusive). Expired holds are released (1) by the RPCs just before they write to that product, (2) by a sweep when Inventory, Home or the Stock tab loads (at most once a minute per org), and (3) by a nightly pg_cron job when available. Expiry rows have `user_id` null | pg_cron only (data); lazy expiry only (UX) | pg_cron is missing from the local PG16 runner. Lazy-only expiry leaves expired holds lowering client availability. Expiry rows are written by the system, never "by" an unrelated user |
| D9 | Holds on In Transit stock | Allowed. Arrived moves holds oldest first and splits the last. Each moved hold's creator gets a task "Arrived: record the sale" | Warehouse-only holds (data) | Pre-selling a container is normal wholesale (UX). The move logic is security's |
| D10 | Stock import commit | Day 3b chunked commit (`committing` / `rolling_back`, `p_max_rows`, resumable). Each chunk calls `private.lock_stock_import` (product, then levels, per product), then applies **targets** under the lock. For products the sheet lists, a status it leaves out means 0 there. Transit → warehouse is posted as a transfer pair. Compare-and-set (`expected_on_hand`) is defence only | One atomic call of up to 5,000 rows with compare-and-set (data) | The 8 s statement timeout and audit triggers per row make the atomic commit risky. Chunks hold locks for less than 2 s each. Judges' graft |
| D11 | One-writer index | Per `(org_id, kind)` | Per org (security) | A paused lead import no longer blocks stock work (judge 3). Test `stock_and_lead_import_can_run_together`; `import_second_writer_busy` still passes |
| D12 | Units | Pieces stored. **Pieces are the default unit when entering a sale, hold or request**, with a cartons toggle showing "= 3 ctn" live and remembered per person. Client requests carry `quantity` and `unit` (`piece` or `carton`) | Cartons as the default (UX); carton-only requests (UX) | Haider, 7 Oct: stock is sold by the piece |
| D13 | Product identity | `name_key`: case and accents folded with a fixed map, punctuation turned into spaces, spaces collapsed, digits kept. Unique per org, **archived included**: a re-import restores an archived product | Accents kept (security); every space removed (UX) | Re-imports must match "T-SHIRT COTON" to "T-shirt coton". Keeping inner spaces avoids over-merging. The Check lists new products by name |
| D14 | Short reference | `products.number` identity, shown as **P-0042** (team, phone requests); shown small and muted on client cards | No reference (security, UX) | Judge 3's graft. An identity column needs no sequence grant |
| D15 | Cost | `private.product_costs` (managers and admins). Cost per piece = Σ PP ÷ Σ QUANTITÉ over the product's rows with QUANTITÉ > 0. Sale-time snapshot in `private.order_line_costs` | A cost column with column grants | No query that reads `products`, the client functions included, can touch cost |
| D16 | Sales table | `private.orders` with `fulfilment in ('from_stock','direct_from_source')`, labelled **Warehouse inventory** and **Supplier Stock**; optional `ship_to_country` (defaults to the lead's country) | `type ('warehouse','supplier')` (security) | One vocabulary with deals and Release 2 |
| D17 | Who sees sales and requests | Sales: the creator, the lead's owner, managers and admins (like deals). Requests: the lead's owner, managers and admins. Holds and stock: the whole org | Everything org-wide (data, UX) | No change to the tested visibility model without Haider. All three users are admins, so everyone sees everything today |
| D18 | Below the minimum price | Managers and admins, after a confirmation. The line is flagged `below_min`. Reps are refused | Always allowed (data, UX) | Open question 7 |
| D19 | Audit of movements | **A minimal audit row per ledger row** `{kind, product_id, location_id, d_on_hand, d_reserved, reason, refs, note_len}` | No copy (UX); create/destroy kinds only (data) | Master Plan F2 and the R2 rule "writes the movement and the audit row together". About 30 MB a year in the worst case (3.7) |
| D20 | Step-up (fresh code, 600 s) | Correction (add, remove, set count), manual receipt, archive and restore, import and undo, cancelling a sale after its Undo window, creating or extending a share link, switching sharing on | Code for every stock action; no code for links (UX) | CLAUDE.md lists adjustments, imports, exports and deletes. A link is a standing export, created once per client. Sales, holds, Arrived, revoking a link and switching sharing off stay fast |
| D21 | Who may sell and hold | Whoever may change the lead (owner, manager, admin), as for deals. Corrections, receipts and Arrived: managers and admins. Imports and cost: admins | | Matches tested rules |
| D22 | Automation tasks | `private.insert_system_task(...)`: a `postgres`-owned definer helper. It clears `request.jwt.claims` and `request.jwt.claim.sub` for one insert, so `enforce_org_and_owner` and `task_guard` see no user, then puts them back. `kind 'todo'`, `created_by` null, `source_product_id` / `source_request_id` links, partial unique indexes for one open task per subject | Tasks inserted in the user's session (security, UX: a rep's sale fails); `tasks.kind 'stock'` (security); cron-only creation (data: up to 10 minutes late, and pg_cron is a dependency) | No change to the approved Day 1 and Day 4 guards. Spike S3, with data's outbox plus cron as the fallback |
| D23 | Back-in-stock tasks | Deferred | Security's trigger | Judge 3: scope. The Requests inbox and the lead tab already show "now available" on each line |
| D24 | Request tasks | **One open task per lead.** Later requests attach to it, and the inbox shows the count | One task per request (data, UX) | No flood: up to 200 a day could otherwise land (judge 1) |
| D25 | Client data path | Two anon, VOLATILE, SECURITY DEFINER functions owned by `share_reader`: `share_view` and `share_request`. The link lookup is bound to the token's hash, then the org is set. One whitelist function, `private.share_items`, feeds the anon view and the team preview. Positional arrays are mapped to named keys in the route, and the route re-checks them with a strict Zod schema | Browser calls Supabase; `service_role`; a login role through the pooler (data's option E); a gateway secret; functions owned by `postgres` (UX; kept as the S1 fallback) | The smallest grant set that works. A bug in a function body cannot read what its owner has no privilege on |
| D26 | Token | 32 random bytes from `extensions.gen_random_bytes` **in the insert guard**: `tss_` + 43 base64url characters. Stored as `sha256` only. Placed in the URL fragment: `/s/fr#tss_…`. Last 4 characters kept as a hint | Generated in Node with a client-sent hash (security) | Entropy holds even for a direct API call. The prefix lets gitleaks catch an accidental commit |
| D27 | Link lifecycle | Lead editor plus a fresh code to create. Expiry is required: 90 days by default, at most 365. Extending needs a code. Revoking is one click with no code. At most 3 active links per lead and 200 per org. "Replace link" revokes the old one and creates a new one in one step | No expiry by default (UX); mandatory ≤ 366 days (data) | Judges flagged links that never expire |
| D28 | Caching | **No data cache.** `share_view` builds the items and returns `version = left(md5(items), 16)`. When the page's `known_version` matches, it answers `{unchanged:true}` (about 200 bytes) | `unstable_cache` keyed by org and a `max(updated_at)` version (data); a 30-second per-instance cache (UX) | `now()`-based versions miss out-of-order commits (a 4 s import overlapping a sale). `unstable_cache` is superseded in Next 16.4. A per-instance cache delays revocation. A payload hash is exact by construction |
| D29 | Rate limits | Database limits per link and per org are authoritative. Refusals are read-only. Unknown tokens cause no write. Per-IP memory limiter. Honeypot, a 2-second time trap, Origin check, size caps | A global "miss" bucket (UX: one hot row written for every bad token) | No write amplification on the anon path |
| D30 | Share surface isolation | The proxy strips `x-topstock-surface` and `x-topstock-locale` from every incoming request, then sets them on share paths. `src/i18n/request.ts` loads only `Share` (plus two generic strings) for that surface. Static share headers sit in the last `headers()` entry of `next.config.ts` | Nothing (security); a separate `(share)` root layout as the first choice (data) | The smallest change to approved files. The `(share)` root layout is the fallback if spike S4 fails |
| D31 | In Transit on the client page | A separate "Arriving" section with the **week** ("week of 13 Oct"). A past or unset date shows "date to be confirmed". Per-link switch | The exact day (security); month only (UX) | Never the exact day (judge 3) |
| D32 | What the client sees | Name, P-ref (muted), max price per piece, available pieces and full cartons, carton size, unit word, "Only N cartons left" when ≤ 3 cartons, the Arriving section, "Your contact: Henri" (a first-name snapshot taken when the link is made) | The client's company name ("Prepared for…") | A forwarded link reveals nothing about who TopStock works with |
| D33 | Where a client request lands | Request rows, one open task per lead, the Requests tab with its badge, the lead's Stock tab, the Home card. No activity row. No email | An activity (activities need a signed-in author, Day 4a); email (no channel) | Open question 13 |
| D34 | Rollout | `sharing_enabled` defaults to **false**. Haider switches it on after Gate 1 and the Vercel Pro upgrade. Per-link `show_in_transit` and `allow_requests` | Default on (data); no switch (UX) | Production is public, serves dev data, and Hobby is non-commercial |
| D35 | Locations | One warehouse and one transit per org (`unique (org_id, kind)`). Supplier Stock is not a location | Editable locations | Release 1 simplicity. Multi-warehouse is Release 2 |
| D36 | Red on the lead page | Record sale and Share are **neutral** primaries on the lead's Stock tab; Call stays the red one. On `/inventory`, Record sale is red. On the client page, only Send request is red | Red Record sale on the lead tab (security) | DESIGN.md: one accent, one primary per screen |
| D37 | Extras | Kept: "Send stock list as text", `/inventory/client-view`, Set counted quantity, first sale → Customer (open question 15), Arrived tasks. Deferred: value at cost KPI, CSV export, back-in-stock tasks | | The deferred items are Release 2 analytics, or need the export step-up and audit pattern (section 15) |

### 2.3 Judges' risks and where each is handled

| Risk raised | Handled in |
|---|---|
| Custom definer roles may not be buildable on hosted Supabase (`FOR SHARE` needs UPDATE, `auth` USAGE, helper EXECUTE, `pg_dump` skips roles) | No `stock_ledger` role (D2). `share_reader` owns only the two anon functions; its path calls no `auth.*` and no private auth helper (8.5). Spike S1 tests ownership, the temporary `CREATE` grant ALTER OWNER needs, policies `TO share_reader`, and the restore note. Fallback: `postgres`-owned definers with explicit org filters plus catalog and body-lint tests |
| `share_view` looked up the link under an org-keyed policy before setting the org: every link "inactive" | Lookup bound to `topstock.share_token_hash`, then `topstock.share_org` and `topstock.share_link` are set (8.5). Test `share_view_valid_link_ok` runs before the "inactive" tests |
| The root layout ships every message namespace and reads the cookie locale | D30. Unit test `share_messages_subset_exact`; e2e `share_html_has_no_internal_strings`. Spike S4 |
| Automation tasks in a rep's session are refused and roll back the sale | D22. Tests as rep `b1`: `rep_sale_crossing_reorder_point_succeeds`, `system_task_restores_claims`. A mutation removes the claims clearing |
| Direct PostgREST callers bypass the Next limiter, honeypot, time trap and Origin check | Database limits per link and per org; unknown tokens write nothing; functions are VOLATILE (POST only). The `anon_security_definer_function_executable` WARN is accepted and logged with this reason (8.7, 9) |
| Sharing on Hobby with dev data | D34; open question 11 |
| Stale client data from version caches and per-instance token caches | D28; revocation takes effect on the next request. Test `share_link_revoke_then_inactive` |
| Size; redefining approved Day 3b and Day 4 objects (`import_batch_guard`, `audit_row`, `lead_import_untouched`, `task_guard`, the FK-coverage array) | 5 PRs (D1). Rule: each migration starts from the newest `create or replace` across `supabase/migrations/` (grep in the build step). `import_attack.sql` and `activity_attack.sql` must pass unchanged. Parity test `audit_lists_union`. 6d waits for 4a and 4b to merge |
| Lead RPCs never check `kind` | The stock branch of the guard refuses lead-only transitions, and stock transitions require a transaction-local marker set only by the stock RPCs (7.5). Tests `lead_rpcs_refuse_stock_batch`, `stock_rpcs_refuse_lead_batch` |
| One-writer index semantics | D11, with both tests |
| Import transaction size against the 8 s statement timeout | Chunks of 250 products by default, halved on `timeout`; budget ≤ 1.5 s per call at 5,000 rows on the CI runner (11.6, I13) |
| PostgREST `max_rows = 1000` cuts set-returning RPCs | Share functions and `share_preview` return `jsonb`. List RPCs return pages of ≤ 200. Test `share_view_2000_items_not_truncated` |
| Next 16.4 (`unstable_cache` superseded; header precedence) | No data cache (D28). e2e `share_public_headers` checks `Referrer-Policy: no-referrer` on `/s/fr` and `/api/share/view` |
| pg_cron missing locally | Nothing depends on it (D8). Tests call `private.nightly_stock_jobs()` directly. Spike S6 |
| Units and audit fit | D12, D19, both logged as decisions |
| Ledger uniqueness and hold moves | No once-per-reference index on reserve or release; unique only for `ship` and `return` per order line. The Arrived step order keeps `reserved = Σ active holds` at the end of every statement. `ledger_sums_match_levels` runs after every concurrency script |
| Parallel days redefining shared functions | The latest-definition rule above, plus `audit_lists_union`, plus the FK-coverage test |
| Stale holds lower client availability | D8 (three sweeps) |
| Step-up friction against the WhatsApp flow | A code only when a link is created (once per client). The link stays in memory for "Copy again" during that page view; after a reload, "Replace link" is offered |
| The Day 5 contract | Day 5 must set `deals.status = 'lost'` on Closed/lost. A null `deals.company_id` never matches a lead (12.1) |
| UX bugs: the once-per-reference index blocks re-reserving after Undo; the premise that an invoker writer cannot meet F1 | No such index (D7). The invoker writer meets F1 (D2) |
| Data weaknesses: set-returning `share_catalog` capped at 1,000 rows; `unstable_cache`; atomic commit; pg_cron; no Undo; partial F2; fulfil line splits; sharing on by default | jsonb; no cache; chunked commit; optional cron; 2-minute Undo; full F2; automatic hold use; off by default |
| Security bugs: `FOR SHARE` as `stock_ledger`; lookup order; missing grants; `limit 500` before the filter; client-computed hash; messages bundle; `tasks.kind 'stock'`; the `moved_in_crm` scan; `components/leads/` path | No custom role for stock; hash-bound lookup; `share_reader` grant list in 8.5; limit after the filter; token made in the guard; D30; `kind 'todo'`; O(1) lock-ordered flags (D5); `src/components/lead/` |
| The token sent as a GET query parameter would land in Supabase API logs | Both anon functions are VOLATILE, so PostgREST accepts them only by POST. Tests `share_functions_volatile` and e2e `share_rpc_get_405` |

### 2.4 Facts to prove before building on them (spikes)

| # | When | Question | Decision rule |
|---|---|---|---|
| S2 | 6a, first commit | On local PG16 and the CI image (PG17): (a) an identity column is filled before BEFORE ROW triggers run; (b) a BEFORE trigger may change `new.kind`, and `RETURN NULL` skips the row (`INSERT … RETURNING` gives no row); (c) a `postgres`-owned definer trigger can take `FOR SHARE` on `products` and `FOR UPDATE` on `stock_levels` while the session is `authenticated`; (d) a definer helper's insert into the ledger fires the guard with `current_user = 'postgres'` and the caller's claims still set; (e) a DEFERRABLE FK from `stock_hold_uses` to a ledger row inserted later in the same statement passes at commit; (f) after waiting on `FOR UPDATE`, READ COMMITTED re-reads the latest row | (a) If it fails, `stock_hold_uses` is written by an AFTER trigger. (b) If `RETURN NULL` misbehaves, `count` with no change returns early in the RPC. (c) and (d) are the engine's premise; if either fails, the core moves into a `postgres`-owned definer function called by the invoker RPCs (the UX shape) and the decision is logged. (f) is proved by `last_cartons_two_sellers` |
| S3 | 6a (script), used in 6d | `set_config('request.jwt.claims', '', true)` plus `request.jwt.claim.sub` makes `auth.uid()` null on the shim, the CI image and dev. Restoring both brings the caller back. An error inside the block rolls the settings back | If any part fails: data's outbox. `private.stock_task_outbox` is written in-session by the definer triggers and drained by `private.drain_stock_task_outbox()` from pg_cron every 10 minutes (where available) and on Inventory or Home load as a definer with no task insert in the user's session. Home counts stay live either way |
| S1 | 6a (throwaway script, not merged), repeated in 6e's first commit | On the CI image and on dev: `create role share_reader nologin noinherit`; `grant share_reader to postgres with set true`; `grant create on schema public to share_reader`, `alter function … owner to share_reader`, then revoke `create`; column grants and `TO share_reader` policies apply inside the definer; nothing on its path needs `auth`; PostgREST anon calls work; what splinter reports; whether the Gate 1 restore needs the role created first | Works: proceed and add the role to the Gate 1 restore runbook (`create role` before `pg_restore`). Fails on hosted: functions owned by `postgres`, explicit `org_id = v_link.org_id` filters, the same `share_items`, tests `share_items_signature_exact`, `share_view_keys_exact` and `share_body_lint` (no `product_costs`, `price_min` or `companies` in the function bodies). The lost layer is logged |
| S4 | 6e | Next 16.4 and next-intl 4.14.9: a request-config locale and a message subset chosen from a proxy-set header; `NextIntlClientProvider` passing only that subset; `<html lang>`; the last `headers()` entry winning for `Referrer-Policy`; no `Set-Cookie` when the proxy returns early; a route handler reading at most N bytes of a body | If the header route fails: a separate `src/app/(share)` root layout (route-group roots), with `global-error` and not-found checked |
| S5 | 6e | Vercel: is `x-forwarded-for` overwritten by the platform? Is a Firewall rate-limit rule free on Hobby or Pro? Are POST bodies absent from runtime logs? | Free rule: add it at Gate 1. Paid: ask Haider; the database limits stand alone. An unreliable header: limiter key `unknown` (one shared bucket) |
| S6 | 6a | Is pg_cron available on the CI image and on dev (read-only MCP `list_extensions`)? | Available: the nightly job is scheduled behind a guarded `do` block. Otherwise it is skipped, and Haider gets numbered steps only if he wants it |

---

## 3 Data model and migration outline

### 3.0 Conventions

- Every function sets `search_path = ''`. Public RPCs are SECURITY INVOKER with static SQL: no `format()`, and no `EXECUTE` with user text. List RPCs with sort variants use the Day 3a pattern: constant SQL run by `EXECUTE … USING`.
- Definer code is limited to:
  - trigger functions (clients cannot call them);
  - four `postgres`-owned private helpers with no REST endpoint (`expire_due_holds`, `sweep_expired_holds`, `lock_stock_import`, `insert_system_task`);
  - the two anon functions owned by `share_reader`.
- Every CHECK that user input could fire has a constant-message pre-check first, so "Failing row contains …" never reaches the log.
- "Safe text" means `!~ '[\u0001-\u001F\u007F\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]'`.
- Every table has `org_id`, RLS enabled, the restrictive `require_mfa` policy for `authenticated`, and `set_updated_at` where it has `updated_at`. Clients get column grants only.
- Quantities are **pieces**, as integers within 0–50,000,000 per level. Prices are `numeric(12,4)` EUR per piece. Totals are computed at read time as `Σ round(quantity × unit_price, 2)`.
- Migration timestamps are set at build time so they sort after every merged migration, Day 4b–4d and Day 5 included. Names:
  - 6a `<ts>_stock_engine.sql`
  - 6b `<ts>_inventory_reads.sql`
  - 6c `<ts>_stock_import.sql`
  - 6d `<ts>_sales.sql`
  - 6e `<ts>_client_share.sql`

### 3.1 6a: stock engine (database only)

```sql
-- Name fold for the "same product" rule: a fixed translate() map (A-Z, Latin-1, Latin Extended-A to lower ASCII;
-- œ→oe æ→ae ß→ss), punctuation to spaces, spaces collapsed and trimmed, digits kept. Same result under ICU and libc.
create function private.product_name_key(name text) returns text
language plpgsql immutable parallel safe set search_path = '' as $$ ... $$;
grant execute on function private.product_name_key(text) to authenticated;    -- generated columns need it

create table public.locations (                       -- R1: exactly one warehouse and one transit per org
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id),
  kind text not null check (kind in ('warehouse', 'transit')),
  name text not null check (char_length(name) between 1 and 80),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique (org_id, kind));
-- private.seed_org_inventory(org): 'Warehouse France' + 'In transit' + inventory_settings; run for every org now
-- and by an AFTER INSERT trigger on orgs (the test org c1 gets them too).

create table public.products (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id),
  number integer generated always as identity unique,         -- shown as P-0042
  name text not null,                                          -- CATÉGORIE; 1-200, trimmed, safe (pre-check + CHECK)
  name_key text generated always as (private.product_name_key(name)) stored,
  category text,                                               -- optional grouping (team-set), 1-80, safe
  unit text not null default 'piece' check (unit in ('piece', 'pair')),   -- display word only (open question 16)
  pieces_per_carton integer not null check (pieces_per_carton between 1 and 1000000),   -- QTY PAR CARTON
  cartons_per_pallet integer check (cartons_per_pallet between 1 and 10000),
  reorder_point integer check (reorder_point between 0 and 50000000),     -- warehouse available pieces; null = no alert
  price_min numeric(12,4) check (price_min between 0 and 1000000),        -- PRIX PAR PCS: internal floor
  price_max numeric(12,4) check (price_max between 0 and 1000000),        -- PRIX PAR PCS MAX: the client price
  transit_eta date,                                            -- expected arrival of the In Transit pieces
  share_visible boolean not null default true,                 -- "Hide from clients"
  archived_at timestamptz,                                     -- archive, never delete (the ledger references it)
  import_batch_id uuid references public.import_batches (id) on delete set null,   -- set by an import (6c), insert only
  search_text text generated always as (lower(name || E'\n' || coalesce(category, ''))) stored,
  created_by uuid, created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  check (price_min is null or price_max is null or price_min <= price_max),
  check (char_length(name) between 1 and 200 and name = btrim(name) and <safe>));
create unique index products_name_key_idx on public.products (org_id, name_key);     -- archived included
create index products_keyset_idx on public.products (org_id, lower(name), id);
create index products_import_batch_idx on public.products (import_batch_id) where import_batch_id is not null;

create table private.product_costs (                  -- managers and admins only (D15)
  product_id uuid primary key references public.products (id),
  org_id uuid not null references public.orgs (id),
  cost_per_piece numeric(14,6) not null check (cost_per_piece between 0 and 1000000),
  source text not null check (source in ('import', 'manual')),
  import_batch_id uuid references public.import_batches (id) on delete set null,
  updated_by uuid, updated_at timestamptz not null default now());

create table public.stock_levels (                    -- written only by private.stock_movement_b_apply()
  product_id uuid not null references public.products (id),
  location_id uuid not null references public.locations (id),
  org_id uuid not null references public.orgs (id),
  on_hand integer not null default 0 check (on_hand between 0 and 50000000),
  reserved integer not null default 0 check (reserved >= 0),
  available integer generated always as (on_hand - reserved) stored,
  version bigint not null default 0,                  -- +1 per applied row, under the lock: the true order here (D5)
  crm_moved boolean not null default false,           -- on hand changed by the CRM since a sheet last set it
  last_onhand_batch_id uuid,                          -- the stock import that last changed on hand here; null = CRM
  updated_at timestamptz not null default now(),
  primary key (product_id, location_id),
  check (reserved <= on_hand));
create index stock_levels_location_idx on public.stock_levels (location_id);

create table private.stock_reservations (             -- holds; written only by the apply step
  id uuid primary key,
  org_id uuid not null references public.orgs (id),
  product_id uuid not null references public.products (id),
  location_id uuid not null references public.locations (id),
  company_id uuid not null references public.companies (id),           -- restrict: a lead with holds is kept
  deal_id uuid references public.deals (id) on delete set null,          -- optional; works before Day 5
  quantity integer not null check (quantity between 1 and 50000000),     -- as created
  remaining integer not null check (remaining between 0 and quantity),
  status text not null default 'active' check (status in ('active', 'released', 'fulfilled', 'expired')),
  hold_until date not null,                                               -- inclusive, Europe/Paris
  note text check (char_length(note) <= 300 and <safe>),
  split_from uuid references private.stock_reservations (id),            -- the part moved by Arrived
  restored_from uuid references private.stock_reservations (id),         -- put back by a sale's Undo
  created_by uuid not null, created_at timestamptz not null default now(),
  closed_at timestamptz, closed_by uuid,
  close_reason text check (close_reason in ('manual', 'deal_lost', 'deal_deleted', 'expired', 'sold')),
  check ((status = 'active') = (remaining > 0)));
create index reservations_fifo_idx on private.stock_reservations (product_id, location_id, created_at, id)
  where status = 'active';
create index reservations_company_idx on private.stock_reservations (company_id, created_at desc);
create index reservations_deal_idx on private.stock_reservations (deal_id) where deal_id is not null;
create index reservations_due_idx on private.stock_reservations (org_id, hold_until) where status = 'active';

create table private.stock_movements (                -- the ledger: append-only, one row per level touched
  id bigint generated always as identity primary key,
  org_id uuid not null references public.orgs (id),
  group_id uuid not null,                             -- one operation: a transfer pair, a sale, an import chunk
  product_id uuid not null references public.products (id),
  location_id uuid not null references public.locations (id),
  kind text not null check (kind in ('receive','adjust_in','adjust_out','transfer_out','transfer_in','reserve',
                                     'release','expire','ship','return','import_in','import_out','undo_in','undo_out')),
                                                      -- 'count' is accepted as input; the apply step turns it into adjust_in/out
  qty integer check (qty between 1 and 50000000),     -- set by the apply step for count and release-all
  target_on_hand integer check (target_on_hand between 0 and 50000000),   -- count only
  expected_on_hand integer,                           -- compare-and-set (imports, undo); defence only
  d_on_hand integer not null default 0, d_reserved integer not null default 0,         -- engine-set
  on_hand_after integer not null default 0, reserved_after integer not null default 0, -- engine-set
  level_version bigint not null default 0,                                              -- engine-set
  reason text check (reason in ('received','found','count','damaged','lost','sample','correction','other',
                                'manual','deal_lost','deal_deleted','expired','sold','sale_undone','sale_cancelled',
                                'arrived','import','import_undo')),
  note text check (char_length(note) <= 500 and <safe>),
  company_id uuid, deal_id uuid,                      -- history: no FK (the row is immutable)
  reservation_id uuid references private.stock_reservations (id),
  order_line_id uuid,                                 -- FK added in 6d
  import_batch_id uuid references public.import_batches (id),
  hold_until date,                                    -- reserve input
  pair_id bigint references private.stock_movements (id),   -- transfer_in: its transfer_out
  user_id uuid,                                       -- null = system (expiry, nightly job); no FK, like audit_log
  created_at timestamptz not null default now(),
  check (d_on_hand <> 0 or d_reserved <> 0),
  check (user_id is not null or kind = 'expire'));
create index movements_org_idx on private.stock_movements (org_id, id desc);            -- log keyset
create index movements_product_idx on private.stock_movements (product_id, id desc);    -- product history, FK
create index movements_org_kind_idx on private.stock_movements (org_id, kind, id desc);
create index movements_location_idx on private.stock_movements (location_id);
create index movements_batch_idx on private.stock_movements (import_batch_id) where import_batch_id is not null;
create index movements_reservation_idx on private.stock_movements (reservation_id) where reservation_id is not null;

create table private.stock_hold_uses (                -- which holds a ship row used, for Undo and the audit trail
  movement_id bigint not null references private.stock_movements (id) deferrable initially deferred,
  reservation_id uuid not null references private.stock_reservations (id),
  pieces integer not null check (pieces between 1 and 50000000),
  primary key (movement_id, reservation_id));

create table private.movement_requests (              -- idempotency for every stock RPC (pruned after 7 days)
  user_id uuid not null, request_id uuid not null, kind text not null,
  result jsonb, created_at timestamptz not null default now(),
  primary key (user_id, request_id));

create table private.inventory_settings (             -- one row per org (seeded)
  org_id uuid primary key references public.orgs (id),
  alert_assignee_id uuid references public.profiles (id) on delete set null,   -- Restock tasks; seeded: oldest admin
  hold_days smallint not null default 14 check (hold_days between 1 and 90),
  last_sweep_at timestamptz,
  updated_at timestamptz not null default now());
-- 6e adds: sharing_enabled boolean not null default false, sharing_changed_at timestamptz, sharing_changed_by uuid
```

**Triggers** (all `search_path = ''`)

| Trigger | Kind | Rules |
|---|---|---|
| `product_guard`, BEFORE INSERT OR UPDATE on products | invoker | Constant pre-checks with hints `product_name`, `category`, `price`, `price_order`, `carton`, `pallet`, `reorder`, `eta` (today − 1 year to today + 2 years). `name_taken` is checked before the unique index. Insert: `created_by := auth.uid()`. Update: `import_batch_id` and `created_by` never change. Archiving needs every level at `on_hand = 0` and `reserved = 0` (hint `has_stock`); un-archiving is admin only. Sessions with no user (fixtures) are skipped |
| `product_cost_guard` on product_costs | invoker | Bounds pre-check; `updated_by`, `updated_at` |
| `stock_movement_a_guard`, BEFORE INSERT on the ledger | invoker | Section 4.3 |
| `stock_movement_b_apply`, BEFORE INSERT on the ledger | **definer, owner postgres**, execute revoked | Section 4.4. The names order them: a runs before b |
| `stock_movement_immutable`, BEFORE UPDATE OR DELETE (row) and BEFORE TRUNCATE (statement) on the ledger | invoker | Always 42501, hint `append_only`, for every role including the owner. The perf seed uses `session_replication_role = replica`, as on Day 4 |
| `audit_row` on the ledger, AFTER INSERT | definer (existing) | Minimal row (3.7) |
| `release_deal_holds`, AFTER UPDATE OF status ON deals (`new.status = 'lost' and old.status is distinct from 'lost'`) and BEFORE DELETE ON deals | definer, owner postgres | Inserts `release` rows (reason `deal_lost` / `deal_deleted`) for the deal's active holds, in `(product_id, location_id, created_at, id)` order |

**Definer helpers** (owner `postgres`, in `private`, so no REST endpoint):
- `private.expire_due_holds(p_product uuid default null) returns integer`: org = `current_org_id()`. Inserts `expire` rows for active holds with `hold_until < (now() at time zone 'Europe/Paris')::date`, in lock order, at most 500. Granted to `authenticated` so invoker RPCs can call it.
- `private.sweep_expired_holds() returns integer`: the same for the whole org, at most once a minute (a compare-and-set on `inventory_settings.last_sweep_at`). Granted to `authenticated`.

**RLS and grants (6a)**

| Table | `authenticated` grants | Policies (plus `require_mfa`) |
|---|---|---|
| products | `select`; `insert (name, category, unit, pieces_per_carton, cartons_per_pallet, reorder_point, price_min, price_max, transit_eta, share_visible)`; `update` (same plus `archived_at`) | select: org. insert and update: managers and admins. No delete grant |
| product_costs | `select`, `insert (product_id, cost_per_piece, source)`, `update (cost_per_piece, source)` | managers and admins of the org |
| locations | `select`; `update (name)` | select: org; update: admins |
| stock_levels | `select` **only** (`revoke insert, update, delete … from authenticated, anon`) | select: org |
| stock_movements | `select`; `insert (group_id, product_id, location_id, kind, qty, target_on_hand, expected_on_hand, reason, note, company_id, deal_id, reservation_id, order_line_id, import_batch_id, hold_until, pair_id)` | select: org; insert: `org_id = current_org_id()` (after the guard sets it). No update or delete grant |
| stock_reservations, stock_hold_uses | `select` only | org |
| movement_requests | `select`, `insert (request_id, kind)`, `update (result)` | own rows (`user_id = auth.uid()`, guard-set) |
| inventory_settings | `select`; `update (alert_assignee_id, hold_days)` | select: org; update: admins; the guard checks the assignee is in the org |

**6a public RPCs** (section 5): `post_stock_movement`, `create_product`, `update_product`, `set_product_cost`, `archive_product`, `restore_product`, `release_expired_reservations`, `check_stock_integrity`.

### 3.2 6b: inventory reads

No new tables. Read RPCs (5.2): `list_stock`, `count_stock`, `stock_summary`, `get_product`, `list_movements`, `list_reservations`, `get_inventory_settings`, `update_inventory_settings` (admins), `rename_location` (admins). All are invoker and return pages of ≤ 200 or `jsonb`.

### 3.3 6c: stock sheet import

```sql
grant insert (kind) on public.import_batches to authenticated;     -- the guard checks the value
drop index public.import_batches_one_writer_idx;
create unique index import_batches_one_writer_idx on public.import_batches (org_id, kind)
  where status in ('committing', 'rolling_back');                  -- D11

create table private.stock_import_staging (
  batch_id uuid not null references public.import_batches (id) on delete cascade,
  row_no integer not null check (row_no between 2 and 5001),
  org_id uuid not null references public.orgs (id),
  name text check (char_length(name) <= 500),
  name_key text generated always as (private.product_name_key(name)) stored,
  location_kind text check (location_kind in ('warehouse', 'transit')),
  quantity integer, pieces_per_carton integer,
  price_min numeric(12,4), price_max numeric(12,4), total_cost numeric(18,4),   -- PP as given; REVENTE never sent
  problems text[] not null default '{}' check (cardinality(problems) <= 16 and problems <@ array[<7.4 codes>]),
  fixes text[] not null default '{}' check (cardinality(fixes) <= 16 and fixes <@ array[<7.4 codes>]),
  db_problem text generated always as
    (private.stock_db_problem(name, quantity, pieces_per_carton, price_min, price_max, total_cost)) stored,
  outcome text not null default 'pending'
    check (outcome in ('pending','new','update','unchanged','rejected','repeated','applied','kept','skipped')),
  reason text check (reason in ('db_name','db_quantity','db_carton','db_price','db_cost','carton_conflict',
                                'below_reserved','moved_in_crm','added_meanwhile')),
  match_product_id uuid, match_row_no integer,
  wh_at_check integer, tr_at_check integer, reserved_at_check integer, moved_at_check boolean,
  primary key (batch_id, row_no)) with (fillfactor = 60);
-- RLS and grants copy private.lead_import_staging: admin plus a fresh code on every policy; insert only for the
-- caller's own 'staged' batch of kind 'stock' with row_no ≤ last_row_no. Not audited (temporary; holds costs).

create table private.stock_import_changes (           -- what an import did to each product, for an exact undo
  batch_id uuid not null references public.import_batches (id),
  product_id uuid not null references public.products (id),
  org_id uuid not null,
  created boolean not null, restored boolean not null default false,   -- made, or brought back from archive
  old_price_min numeric(12,4), old_price_max numeric(12,4), old_ppc integer, old_cost numeric(14,6),
  new_price_min numeric(12,4), new_price_max numeric(12,4), new_ppc integer, new_cost numeric(14,6),
  qty_changed boolean not null default false,
  undone_at timestamptz,
  kept_reason text check (kept_reason in ('moved', 'held', 'edited', 'later_import')),
  primary key (batch_id, product_id));
-- RLS: admins of the org may select; written only by commit and rollback (admin plus a fresh code).
```

- **Products import column:** `grant insert (import_batch_id) on public.products` plus a restrictive policy, `products_import_column`. A non-null value is allowed only for an admin with a fresh code inserting for their own `committing` stock batch (the `companies_import_columns` pattern).
- **The batch guard** is recreated from its newest definition. When `coalesce(new.kind, old.kind) = 'stock'`, it returns `private.stock_batch_step(old, new, tg_op)`. The lead path stays byte-identical (7.5).
- **Lock helper** (definer, owner `postgres`, granted to `authenticated`): `private.lock_stock_import(p_batch uuid, p_products uuid[])`. It checks the batch is `kind = 'stock'`, the caller has a fresh code, and either (status `committing` and the caller is the uploader) or (status `rolling_back` and the caller is an admin). Every product must be in that batch's staging or changes. Then, product by product in `id` order, it locks the product row `FOR UPDATE`, creates any missing level rows at zero, and locks the levels `FOR UPDATE` in `location_id` order.
- **RPCs** (7.5): `create_stock_import`, `stage_stock_import_rows`, `validate_stock_import`, `list_stock_import_issues`, `list_stock_import_changes`, `commit_stock_import`, `preview_stock_import_rollback`, `rollback_stock_import`, `discard_stock_import`, `list_stock_imports`.

### 3.4 6d: sales, holds UI, requests, automations

```sql
create table private.orders (                         -- "sales"
  id uuid primary key default gen_random_uuid(),
  number bigint generated always as identity unique,  -- shown as "Sale 1042"
  org_id uuid not null references public.orgs (id),
  company_id uuid not null references public.companies (id),           -- restrict: sales are kept records
  deal_id uuid references public.deals (id) on delete set null,
  stock_request_id uuid,                                                -- FK below
  fulfilment text not null check (fulfilment in ('from_stock', 'direct_from_source')),
  status text not null default 'confirmed' check (status in ('confirmed', 'cancelled')),
  ship_to_country char(2) check (ship_to_country ~ '^[A-Z]{2}$'),       -- Supplier Stock (default: the lead's country)
  note text check (char_length(note) <= 1000 and <safe>),
  prev_lead_status text,                                                -- set when this sale made the lead a Customer
  created_by uuid not null, created_at timestamptz not null default now(),
  cancelled_at timestamptz, cancelled_by uuid,
  cancel_reason text check (char_length(cancel_reason) between 3 and 300 and <safe>),
  updated_at timestamptz not null default now());
create index orders_company_idx on private.orders (company_id, created_at desc, id desc);
create index orders_org_idx on private.orders (org_id, created_at desc, id desc);
create index orders_deal_idx on private.orders (deal_id) where deal_id is not null;

create table private.order_lines (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references private.orders (id),
  org_id uuid not null references public.orgs (id),
  position smallint not null check (position between 1 and 50),
  product_id uuid references public.products (id),                     -- required for from_stock
  product_name text not null check (char_length(product_name) between 1 and 200 and <safe>),   -- snapshot or description
  quantity integer not null check (quantity between 1 and 50000000),   -- pieces
  unit_price numeric(12,4) not null check (unit_price between 0 and 1000000),      -- EUR per piece, excl. VAT
  line_total numeric(14,2) generated always as (round(quantity * unit_price, 2)) stored,
  below_min boolean not null default false,                            -- guard-set from price_min at sale time
  unique (order_id, position));
create unique index order_lines_product_idx on private.order_lines (order_id, product_id) where product_id is not null;
create index order_lines_product_fk_idx on private.order_lines (product_id) where product_id is not null;

create table private.order_line_costs (               -- cost snapshot; managers and admins only
  order_line_id uuid primary key references private.order_lines (id),
  org_id uuid not null, cost_per_piece numeric(14,6) not null);

alter table private.stock_movements add constraint stock_movements_order_line_fkey
  foreign key (order_line_id) references private.order_lines (id);
create unique index movements_ship_once_idx on private.stock_movements (order_line_id) where kind = 'ship';
create unique index movements_return_once_idx on private.stock_movements (order_line_id) where kind = 'return';

create table private.stock_requests (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id),
  company_id uuid not null references public.companies (id) on delete cascade,   -- the client's lead
  share_link_id uuid,                                   -- FK added in 6e (on delete set null)
  source text not null check (source in ('team', 'share_link')),
  status text not null default 'new' check (status in ('new', 'in_progress', 'done', 'declined')),
  note text check (char_length(note) <= 1000 and <safe>),
  requester_name text check (char_length(requester_name) <= 80 and <safe>),       -- share link only, optional
  language text check (language in ('en', 'fr')),
  idempotency_key uuid,
  created_by uuid,                                       -- null for client requests
  handled_by uuid, handled_at timestamptz,
  team_note text check (char_length(team_note) <= 300 and <safe>),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  check ((source = 'team') = (created_by is not null)));
create index stock_requests_inbox_idx on private.stock_requests (org_id, status, created_at desc, id desc);
create index stock_requests_company_idx on private.stock_requests (company_id, created_at desc);

create table private.stock_request_lines (
  request_id uuid not null references private.stock_requests (id) on delete cascade,
  position smallint not null check (position between 1 and 20),
  org_id uuid not null,
  product_id uuid references public.products (id),
  description text check (char_length(description) between 1 and 200 and <safe>),   -- "other stock"
  quantity integer not null check (quantity between 1 and 10000000),
  unit text not null check (unit in ('piece', 'carton')),
  pieces integer not null check (pieces between 1 and 50000000),                    -- server-computed
  price_shown numeric(12,4),                            -- the max price the client saw; never a promise
  availability text not null check (availability in ('in_warehouse', 'in_transit', 'not_listed')),
  primary key (request_id, position),
  check (product_id is not null or description is not null));
create index request_lines_product_idx on private.stock_request_lines (product_id) where product_id is not null;

alter table private.orders add constraint orders_stock_request_fkey
  foreign key (stock_request_id) references private.stock_requests (id) on delete set null;

alter table public.tasks                              -- automation links (system-set only; no grant)
  add column source_product_id uuid references public.products (id) on delete set null,
  add column source_request_id uuid references private.stock_requests (id) on delete set null;
create unique index tasks_open_restock_idx on public.tasks (source_product_id)
  where source_product_id is not null and company_id is null and done_at is null and cancelled_at is null;
create unique index tasks_open_request_idx on public.tasks (company_id)
  where source_request_id is not null and done_at is null and cancelled_at is null;
```

**Guards (6d)**

| Trigger | Kind | Rules |
|---|---|---|
| `order_guard`, BEFORE INSERT OR UPDATE on orders | invoker | **Insert:** `created_by := auth.uid()`, `status := 'confirmed'`, `org_id`; the deal is visible, on the same lead, and not `lost` (hints `deal_mismatch`, `deal_lost`); a null `deals.company_id` never matches; flood guard of 60 orders a minute per person. **Update:** only `confirmed → cancelled`, never back. It is allowed when (`created_by = auth.uid()` and `created_at > now() − 120 s`) or (manager or admin and `has_recent_aal2(600)` and a reason of 3–300 characters). It sets `cancelled_at` and `cancelled_by`. Nothing else changes |
| `order_line_guard`, BEFORE INSERT on order_lines | invoker | Only for an order created **in this transaction** by the caller (`o.created_by = auth.uid() and o.created_at = now()`). Snapshots `product_name` from the product. `from_stock` lines need an active product. `below_min := unit_price < price_min`; when true and the caller is not a manager or admin, 42501. Lines are never updated (no grant) |
| `order_line_cost_snapshot`, AFTER INSERT on order_lines | definer, postgres | Copies `product_costs.cost_per_piece` into `order_line_costs` |
| `stock_request_guard`, BEFORE INSERT OR UPDATE on stock_requests | invoker | It checks `current_user = 'share_reader'` **before** anything calls `auth.uid()`. Share branch: fields come from `share_request`. Team branch: `source := 'team'`, `created_by := auth.uid()`, `status := 'new'`, text pre-checks, flood guard 60 a minute. Update: `status` and `team_note` only; `handled_by` and `handled_at` set on the first move out of `new` |
| `stock_request_task`, AFTER INSERT on stock_requests | definer, postgres | `source = 'share_link'` only: `insert_system_task` (5.8) |
| `stock_low_automation`, AFTER INSERT on the ledger | definer, postgres | Warehouse rows, kinds other than `import_*`, `undo_*` and `expire`: when `(on_hand_after − reserved_after) − (d_on_hand − d_reserved) > reorder_point ≥ on_hand_after − reserved_after`, a Restock system task |
| `hold_arrived_task`, AFTER UPDATE OF location_id on stock_reservations, and AFTER INSERT where `split_from is not null` | definer, postgres | When a hold arrives at the warehouse: a system task for its creator |
| `task_guard` | invoker | Recreated from its newest definition, with `source_product_id` and `source_request_id` added to the depth > 1 FK exception list |

**System task helper** (definer, owner `postgres`, revoked from everyone; called only by the triggers above):

```sql
create function private.insert_system_task(p_org uuid, p_assignee uuid, p_title_key text, p_title_arg text,
  p_company uuid, p_product uuid, p_request uuid) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_claims text := current_setting('request.jwt.claims', true);
  v_sub text := current_setting('request.jwt.claim.sub', true);
  v_lang text; v_tz text; v_id uuid;
begin
  select coalesce(p.language, 'en'), coalesce(nullif(p.timezone, ''), 'Europe/Paris') into v_lang, v_tz
    from public.profiles p where p.id = p_assignee and p.org_id = p_org;
  if not found then return null; end if;
  begin
    -- A system row: the person whose action triggered this did not create the task. With no claims, the task
    -- guards treat it as system work (enforce_org_and_owner and task_guard skip). An error here rolls back these
    -- settings with the block.
    perform set_config('request.jwt.claims', '', true);
    perform set_config('request.jwt.claim.sub', '', true);
    insert into public.tasks (org_id, assignee_id, created_by, kind, title, due_date, company_id,
                              source_product_id, source_request_id)
    values (p_org, p_assignee, null, 'todo', private.stock_task_title(p_title_key, v_lang, p_title_arg),
            (now() at time zone v_tz)::date, p_company, p_product, p_request)
    on conflict do nothing                                 -- one open task per subject (partial unique indexes)
    returning id into v_id;
    perform set_config('request.jwt.claims', coalesce(v_claims, ''), true);
    perform set_config('request.jwt.claim.sub', coalesce(v_sub, ''), true);
  end;
  return v_id;
end $$;
```

`private.stock_task_title(key, lang, arg)` gives constant titles with French typography:

| Key | English | French |
|---|---|---|
| `restock` | "Restock: {product}" | "Réapprovisionner : {product}" |
| `request` | "Stock request (client link)" | "Demande de stock (lien client)" |
| `arrived` | "Arrived: record the sale of {product}" | "Arrivé : enregistrer la vente de {product}" |
| `integrity` | "Stock check found a difference" | "Le contrôle du stock a trouvé un écart" |

No text the client typed ever reaches a title. Names are cut to 200 characters.

**RLS and grants (6d)**

| Table | `authenticated` grants | Policies (plus `require_mfa`) |
|---|---|---|
| orders | `select`; `insert (company_id, deal_id, stock_request_id, fulfilment, ship_to_country, note)`; `update (status, cancel_reason)` | select: the creator, the lead's owner, managers and admins. insert: lead editor of `company_id`. update: the creator, managers and admins (the guard limits columns) |
| order_lines | `select`; `insert (order_id, position, product_id, product_name, quantity, unit_price)` | through the order |
| order_line_costs | `select` | managers and admins |
| stock_requests | `select`; `insert (company_id, note, idempotency_key)`; `update (status, team_note)` | select and update: the lead's owner, managers and admins. insert: lead editor |
| stock_request_lines | `select`; `insert (request_id, position, product_id, description, quantity, unit)` | through the request |

`pieces`, `price_shown` and `availability` on team-logged lines are set by the guard. **6d RPCs** (5.4): `record_sale`, `undo_sale`, `cancel_sale`, `list_sales`, `get_sale`, `extend_reservation`, `get_lead_stock`, `list_lead_deals_for_stock`, `log_stock_request`, `set_stock_request_status`, `list_stock_requests`, `get_stock_request`, `stock_alerts`.

### 3.5 6e: client stock link

```sql
create extension if not exists pgcrypto with schema extensions;      -- gen_random_bytes; a no-op on Supabase

create table private.share_links (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id),
  company_id uuid not null references public.companies (id) on delete cascade,   -- the client
  token_hash bytea not null unique check (octet_length(token_hash) = 32),        -- sha256(token); never granted
  token_hint text not null check (token_hint ~ '^[A-Za-z0-9_-]{4}$'),            -- last 4 characters
  label text check (char_length(label) between 1 and 80 and <safe>),             -- internal only
  language text not null check (language in ('en', 'fr')),
  show_in_transit boolean not null default true,
  allow_requests boolean not null default true,
  signature text check (char_length(signature) <= 60),     -- the creator's first name, taken when the link is made
  expires_at timestamptz not null,                         -- now() + 1 hour to now() + 366 days (guard)
  revoked_at timestamptz, revoked_by uuid,
  created_by uuid not null, created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  open_count integer not null default 0, last_opened_at timestamptz,
  request_count integer not null default 0, last_request_at timestamptz);
create index share_links_company_idx on private.share_links (company_id, created_at desc);
create index share_links_org_idx on private.share_links (org_id, created_at desc);

alter table private.stock_requests add constraint stock_requests_share_link_fkey
  foreign key (share_link_id) references private.share_links (id) on delete set null;
create unique index stock_requests_idem_idx on private.stock_requests (share_link_id, idempotency_key)
  where share_link_id is not null;
create index stock_requests_link_idx on private.stock_requests (share_link_id, status, created_at desc)
  where share_link_id is not null;

create table private.share_rate (                     -- rate counters; no endpoint; not audited
  scope_id uuid not null,                             -- a link id or an org id
  kind text not null check (kind in ('view', 'request')),
  span text not null check (span in ('m', 'h', 'd')),
  bucket timestamptz not null, n integer not null,
  primary key (scope_id, kind, span, bucket));

alter table private.inventory_settings
  add column sharing_enabled boolean not null default false,
  add column sharing_changed_at timestamptz, add column sharing_changed_by uuid;
```

**`share_link_guard`**, BEFORE INSERT OR UPDATE (invoker). It checks `current_user` before anything calls `auth.uid()`:

- **`share_reader` (the anon functions):** only `open_count`, `last_opened_at`, `request_count` and `last_request_at` may change.
- **Team insert:**
  - `has_recent_aal2(600)`, else 42501 `step_up`;
  - the token is made here, so its entropy holds even for a direct insert:
    ```sql
    v_token := 'tss_' || translate(rtrim(encode(extensions.gen_random_bytes(32), 'base64'), '='), '+/', '-_');
    new.token_hash := sha256(convert_to(v_token, 'UTF8'));
    new.token_hint := right(v_token, 4);
    perform set_config('topstock.new_share_token', v_token, true);   -- read once by create_share_link
    ```
  - `created_by := auth.uid()`; `signature` from `profiles.first_name`; counters at 0; `revoked_*` null;
  - `expires_at` defaults to now() + 90 days, bounded as above;
  - at most 3 active links per lead and 200 per org (hint `too_many_links`).
- **Team update:**
  - `label`, `language`, `show_in_transit` and `allow_requests` may change;
  - `revoked_at` may only go from null to `now()` (sets `revoked_by`, never undone);
  - changing `expires_at` needs `has_recent_aal2(600)` and the bounds.

**RLS for `authenticated`:**
- select: the lead's owner, managers and admins. Grant every column except `token_hash`.
- insert: lead editor (`insert (company_id, label, language, show_in_transit, allow_requests, expires_at)`). Any `token_hash` sent is overwritten.
- update: the creator, the lead's owner, managers and admins (`update (label, language, show_in_transit, allow_requests, expires_at, revoked_at)`).

**`set_sharing_enabled(p_on boolean)`:** switching on needs an admin with a fresh code; switching off needs a manager or admin.

The role, its grants, its policies and the two functions are in section 8.5.

### 3.6 Changes to earlier days' objects

Each change starts from the newest `create or replace` in `supabase/migrations/`.

| Object | Change | PR | Re-test |
|---|---|---|---|
| `private.audit_row` | Hidden: `token_hash`. No diff: `open_count`, `last_opened_at`, `request_count`, `last_request_at`, `version`, `last_sweep_at`. Branches: minimal ledger rows; `stock_requests` insert `{source, share_link_id, line_count, note_len}` and updates without `note` or `requester_name`; `stock_levels` and `stock_reservations` not audited (the ledger is their record) | 6a, 6d, 6e | `audit_lists_union` (every hidden and no-diff key from Days 3–6 present) |
| `private.lead_import_untouched` | `not exists` for `private.stock_reservations` and `private.orders` (6a, 6d), `private.stock_requests` (6d), `private.share_links` (6e) | 6a, 6d, 6e | `import_fk_coverage` array grows; `import_rollback_keeps_worked_on` gains a lead with a hold, a sale, a request and a link |
| `private.import_batch_guard` | stock branch (7.5) | 6c | `import_attack.sql` unchanged and green; Day 3b guard mutations re-run |
| `import_batches_one_writer_idx`, insert grant | per `(org_id, kind)`; `insert (kind)` | 6c | `import_second_writer_busy`, `stock_and_lead_import_can_run_together`, `import_batch_insert_server_fields` |
| `public.tasks`, `private.task_guard` | link columns, partial unique indexes, depth > 1 list | 6d | `activity_attack.sql` unchanged; `lead_delete_with_request_task` |
| `rls_attack.sql` §1 | becomes a catalog allowlist for anon | 6e | `anon_executable_functions_exact` |
| `src/proxy.ts`, `next.config.ts`, `src/i18n/request.ts` | share branch, `/robots.txt` public, surface headers, share CSP; a last `headers()` entry for share paths; share message subset | 6e | `signed-out.spec.ts` extended; `proxy_share_paths_exact` |

### 3.7 Audit and the free-tier budget (500 MB database, 5 GB egress)

| Data | Year 1 estimate (worst case in brackets) |
|---|---|
| products (5,000), costs, levels (10,000) | ≈ 4 MB |
| ledger: ~50,000 rows a year (200,000) × ~250 B with 6 indexes | ≈ 15 MB (60 MB) |
| minimal audit row per ledger row (~150 B) | ≈ 8 MB (30 MB) |
| orders 10,000, lines 30,000, cost snapshots | ≈ 12 MB |
| holds, hold uses, requests and lines, links, counters, idempotency | ≈ 5 MB |
| **Inventory total** | **≈ 45 MB (110 MB)** |
| With Day 4's estimate (~255 MB) | ≈ 300 MB (365 MB), 60–73 % of 500 MB |

- The Gate 1 size query in `scripts/db-perf.sh` adds `stock_movements`, `audit_log` and `orders`. Supabase Pro is advisable before production anyway (backups).
- **Share egress:** a full answer is about 70 B per item as positional arrays: 300 items ≈ 21 KB, 2,000 items ≈ 140 KB. Polls answer "unchanged" in about 200 B. Realistic use (50 clients × 2 opens a day × 30 KB) ≈ 90 MB a month, under 2 % of 5 GB. A worst case of 1,000 opens a day at 140 KB ≈ 4.2 GB a month: the per-link limits cap that, and the Gate 1 checklist reads egress weekly.

---

## 4 The stock engine (`post_stock_movement`): exact logic

### 4.1 Invariants

| # | Invariant | Enforced by |
|---|---|---|
| I1 | `on_hand ≥ 0`, `reserved ≥ 0`, `reserved ≤ on_hand` per level | Checks under the lock (constant 22023), plus CHECK backstops |
| I2 | Each level equals the sum of its ledger deltas | Single writer; `check_stock_integrity`; the random-operations test; the nightly job |
| I3 | `reserved` equals the sum of `remaining` of active holds at that level | Holds and levels change in the same apply step |
| I4 | Ledger rows never change | No grants; `stock_movement_immutable` |
| I5 | Nobody holds more than is available | `reserve` needs `on_hand − reserved ≥ q` under the lock |
| I6 | Nobody sells stock held for another client | `ship` needs `on_hand − q ≥ reserved − used` |
| I7 | Every warehouse sale line has exactly one `ship` row; every cancelled one exactly one `return` | Same transaction; unique indexes; integrity check `ship_lines` |
| I8 | Per level, the row with the highest `level_version` has `on_hand_after = on_hand` | The version is set under the lock; integrity check `versions` |

### 4.2 The public RPC

```sql
public.post_stock_movement(
  p_product uuid,
  p_kind text,                      -- receive | adjust_in | adjust_out | count | transfer | reserve | release
  p_qty integer default null,       -- pieces; release: null = everything still held; count: unused
  p_location text default null,     -- 'warehouse' | 'transit' (resolved by kind; clients never send location ids)
  p_reason text default null,
  p_note text default null,
  p_company uuid default null,      -- reserve: the lead
  p_deal uuid default null,         -- reserve: an open, from_stock deal of that lead
  p_reservation uuid default null,  -- release
  p_hold_until date default null,   -- reserve: default today + hold_days; today to today + 90
  p_target integer default null,    -- count: the counted quantity (0 to 50,000,000)
  p_request_id uuid default null
) returns jsonb   -- {group_id, movement_ids, reservation_id, unchanged, levels:[{location, on_hand, reserved, available}]}
language plpgsql volatile security invoker set search_path = '' set lock_timeout = '3s'
```

Steps:
1. The caller is signed in with `aal2` and has an org, else 42501.
2. Constant pre-checks: the kind is in the list; the quantity is within its bounds; the reason fits the kind (`other` needs a note); the note is safe and ≤ 500 characters. Failures give 22023 with a hint.
3. Idempotency: `insert into private.movement_requests … on conflict do nothing returning`. On a replay it returns the stored `result`.
4. It resolves the location ids from `locations` by kind (P0002 if not visible).
5. For kinds that take room (`adjust_out`, `count`, `transfer`, `reserve`) it calls `private.expire_due_holds(p_product)`.
6. It inserts the ledger row(s):
   - `transfer` inserts `transfer_out` at transit, then `transfer_in` at the warehouse with `pair_id`;
   - `count` sends `target_on_hand`; a row the apply step skips means "unchanged".
7. It reads the levels back, stores the result in `movement_requests`, and returns it.

**Named server actions** map to it: `adjustStock` (adjust or count, step-up), `receiveStock` (receive, step-up), `markArrived` (transfer), `reserveStock`, `releaseReservation`.

### 4.3 Guard: `private.stock_movement_a_guard()` (invoker, BEFORE INSERT, runs first)

- **Trusted caller** means `current_user = 'postgres'`. Only the definer helpers and triggers (expiry, deal lost or deleted, the nightly job) run as `postgres`. They skip the caller checks but keep every validation and every engine rule. `authenticated` and `share_reader` are never trusted. `share_reader` has no grant at all.
- **Server-set columns:**
  - `user_id := auth.uid()` (null for `expire`);
  - `org_id :=` the product's org, read **under the caller's RLS** (invisible → P0002);
  - `created_at := now()`;
  - `d_*`, `*_after` and `level_version` zeroed.
- The location belongs to the org, and its kind fits the row's kind.
- An archived product refuses every kind except `release` and `expire` (22023 `product_archived`). This is checked again under the lock.
- **Per kind:**

| Kind | Place | Who | Fresh code | Document |
|---|---|---|---|---|
| `receive` | any | manager or admin | yes | reason `received`, `found`, `correction` or `other` |
| `adjust_in`, `adjust_out` | any | manager or admin | yes | reason `count`, `damaged`, `lost`, `found`, `sample`, `correction` or `other` |
| `count` | any | manager or admin | yes | `target_on_hand` set; reason `count` |
| `transfer_out` / `transfer_in` | transit → warehouse | manager or admin. Import-tagged: the uploader admin of a `committing` stock batch | import-tagged only | `transfer_in.pair_id` is a `transfer_out` of the same `group_id` in this transaction, with the same product and quantity |
| `reserve` | warehouse or transit | lead editor: `exists (select 1 from public.companies c where c.id = new.company_id and ((select private.is_manager_or_admin()) or c.owner_id = auth.uid()))` | no | Deal, if given: `exists (select 1 from public.deals d where d.id = new.deal_id and d.company_id = new.company_id and d.status = 'open' and d.fulfilment = 'from_stock')` under deals RLS, else hints `deal_mismatch`, `deal_closed`, `deal_direct`. `hold_until` within today to today + 90 |
| `release` | the hold's level | the hold's creator or a lead editor; trusted for `deal_lost` / `deal_deleted` | no | the hold is visible and active |
| `expire` | any | trusted only | — | — |
| `ship` | warehouse | through `record_sale` only | no | `order_line_id` is a line of a `from_stock`, `confirmed` order created in this transaction by the caller (`o.created_by = auth.uid() and o.created_at = now()`), same product and quantity. `company_id` and `deal_id` are copied from the order, never trusted from the row |
| `return` | warehouse | through `undo_sale` or `cancel_sale` | the order guard decides | the line's order is `cancelled` with `cancelled_by = auth.uid()` and `cancelled_at = now()` |
| `import_in`, `import_out` | any | the uploader admin | yes | batch `kind = 'stock'`, status `committing`; `expected_on_hand` not null |
| `undo_in`, `undo_out` | any | any admin | yes | batch status `rolling_back`; `expected_on_hand` not null |

- **Rate guard** for team kinds: more than 120 rows by this user in 60 seconds gives 22023 `rate_limited`. It is one range read with `limit 121` on a `(user_id, created_at)` partial index.

### 4.4 Apply: `private.stock_movement_b_apply()` (SECURITY DEFINER, owner postgres, execute revoked from everyone)

```sql
declare
  p record; lvl public.stock_levels%rowtype; v_locs uuid[]; d_on integer := 0; d_res integer := 0;
  v_used integer := 0; h record; v_take integer; v_out private.stock_movements%rowtype;
  is_import constant boolean := new.import_batch_id is not null;
begin
  -- 1. The product, shared lock: serialises against archive_product's FOR UPDATE (product first, then levels).
  select active_flag, reorder_point into p
    from (select archived_at is null as active_flag, reorder_point from public.products
           where id = new.product_id for share) x;
  if not p.active_flag and new.kind not in ('release', 'expire') then
    raise exception 'product archived' using errcode = '22023', hint = 'product_archived';
  end if;
  -- 2. The level(s), created at zero the first time, locked in location order. A transfer locks both on its first row.
  v_locs := case when new.kind in ('transfer_out', 'transfer_in') then private.transfer_pair(new.org_id)
                 else array[new.location_id] end;
  insert into public.stock_levels (org_id, product_id, location_id)
  select new.org_id, new.product_id, l from unnest(v_locs) l on conflict do nothing;
  perform 1 from public.stock_levels where product_id = new.product_id and location_id = any (v_locs)
   order by location_id for update;
  select * into strict lvl from public.stock_levels
   where product_id = new.product_id and location_id = new.location_id;
  -- 3. Compare-and-set (defence for imports and undo).
  if new.expected_on_hand is not null and lvl.on_hand <> new.expected_on_hand then
    raise exception 'stock changed since the check' using errcode = '22023', hint = 'stale';
  end if;
  -- 4. Deltas per kind (table 4.5). Hold rows are locked only after their level.
  ...
  -- 5. The rules.
  if lvl.on_hand + d_on < 0 then
    raise exception 'not enough stock' using errcode = '22023', hint = 'insufficient_stock';
  end if;
  if lvl.reserved + d_res < 0 then
    raise exception 'more than is held' using errcode = '22023', hint = 'not_reserved';
  end if;
  if lvl.reserved + d_res > lvl.on_hand + d_on then
    raise exception 'stock is held' using errcode = '22023',
      hint = case new.kind when 'reserve' then 'over_reservation' when 'ship' then 'reserved_by_others'
                           else 'below_reserved' end;
  end if;
  -- 6. Write the level, then the row's snapshot.
  update public.stock_levels
     set on_hand = on_hand + d_on, reserved = reserved + d_res, version = version + 1,
         crm_moved = case when d_on = 0 then crm_moved else not is_import end,
         last_onhand_batch_id = case when d_on = 0 then last_onhand_batch_id
                                     when is_import then new.import_batch_id else null end,
         updated_at = now()
   where product_id = new.product_id and location_id = new.location_id
  returning on_hand, reserved, version into new.on_hand_after, new.reserved_after, new.level_version;
  new.d_on_hand := d_on; new.d_reserved := d_res;
  return new;
end;
```

### 4.5 Rule per kind (`oh`, `rv` = the locked level; `q` = quantity)

| Kind | Δ on hand | Δ reserved | Extra work under the lock |
|---|---|---|---|
| `receive`, `adjust_in`, `return`, `import_in`, `undo_in` | +q | 0 | — |
| `adjust_out`, `import_out`, `undo_out` | −q | 0 | — |
| `count` | `target − oh` | 0 | Becomes `adjust_in` / `adjust_out` with `qty = |d|`. `d = 0` gives `RETURN NULL` (no row; the RPC says "unchanged"). Refused below `rv` (`below_reserved`) |
| `transfer_out` (transit) | −q | −m, `m = min(q, rv)` | Moves `m` held pieces oldest first: a hold covered whole changes `location_id` to the warehouse; the last one is reduced, and a new hold is inserted at the warehouse with `split_from`, keeping its creator, lead, deal and end date |
| `transfer_in` (warehouse) | +q | +m, read from its `pair_id` row | — |
| `reserve` | 0 | +q | Inserts the hold (`created_by = user_id`); sets `new.reservation_id` |
| `release`, `expire` | 0 | −q (`q` null → `remaining`) | The hold must be active, at this level, with `q ≤ remaining`, else `reservation_state`. Then `remaining −= q`; at 0, status `released` or `expired`, plus `closed_*` |
| `ship` | −q | −c | Uses holds at this level: first those with `deal_id = new.deal_id` (when the sale has a deal), then the lead's holds with no deal, oldest first, up to `q`, giving `c`. Each one: `remaining −= x` (status `fulfilled` at 0, `close_reason 'sold'`) and a `stock_hold_uses` row. The general rule then checks `oh − q ≥ rv − c` |

### 4.6 Locks, order and the fields that record it

- **One global order:** product id, then the product row (`FOR SHARE`, or `FOR UPDATE` in the import helper), then levels by `location_id` (`FOR UPDATE`), then hold rows.
  - `record_sale` inserts its rows in `product_id` order;
  - a transfer locks both levels on its first row;
  - the import helper goes product by product;
  - deal triggers and expiry go in `(product_id, location_id, created_at, id)` order.
  - So a waiting cycle cannot form.
- `lock_timeout = '3s'` on every stock RPC gives 55P03, shown as `busy` ("Someone else is changing this stock. Try again.").
- **Why the level carries `version`, `crm_moved` and `last_onhand_batch_id`:**
  - A ledger row's `id` and `created_at` are set when the row is formed, **before** the apply step waits for the lock.
  - Example: a sale gets id 100, then waits while an import chunk (which already holds the lock) inserts rows 101–105 and commits. The sale then applies last, with the smallest id.
  - The three fields are written under the lock, so they record the real order. "Moved in the CRM since the last sheet" is `crm_moved`. "This import was the last to change on hand here" is `last_onhand_batch_id = batch`. The per-level order of rows is `level_version`. Both checks are O(1).
- **Lock hold time:** sales and holds hold locks for one short transaction (target < 20 ms). An import chunk holds its products' locks for ≤ 1.5 s. A sale of another product is never blocked.

### 4.7 Two people selling the last cartons (exact timeline)

The warehouse has 96 pieces (2 cartons of 48), with 0 held. Henri and Kais each record a sale of 96.

| t | Henri (T1) | Kais (T2) |
|---|---|---|
| 0 | `record_sale` inserts the order and line, then the `ship` row. The apply step locks the product (share) and the level (96 / 0); 96 − 96 ≥ 0 − 0; the level becomes 0 / 0 | `record_sale` inserts the order and line, then the `ship` row. The apply step takes the product share lock, then **waits** on the level |
| 1 | COMMIT | The lock is released. READ COMMITTED re-reads the level: 0 / 0 |
| 2 | | 0 − 96 < 0 raises 22023 `insufficient_stock`. **The whole transaction rolls back**: no order, no line, no row |
| 3 | "Sale 1042 recorded · Undo" | "Only 0 pieces available now. Someone just sold some. Nothing was saved." The sheet stays open, and the line re-reads availability |

Two holds racing, and a sale racing a hold, behave the same way (I5, I6). These are proved in 11.2.

### 4.8 Error contract (`src/lib/inventory-server.ts`, `stockError()`, the `importError` pattern)

| SQLSTATE | Hint | Screen code |
|---|---|---|
| 42501 | `step_up` | `step_up`: the Confirm-it's-you dialog opens, then the call is retried with the same `request_id` |
| 42501 | other | `forbidden` |
| 22023 | `insufficient_stock`, `over_reservation`, `reserved_by_others`, `below_reserved`, `not_reserved` | `stock_short`: the screen re-reads the levels and says "Only {n} available now". Messages never carry values |
| 22023 | `stale` | `stale` |
| 22023 | `reservation_state`, `deal_mismatch`, `deal_closed`, `deal_direct`, `deal_lost`, `product_archived`, `has_stock`, `name_taken`, `product_name`, `below_min`, `duplicate_line`, `lines`, `rate_limited`, `too_many_links` | same name |
| 22023 | none | `invalid` |
| P0002 | | `not_found` |
| 55P03 | | `busy` |
| 57014 | | `timeout` |
| 23503 | | `has_history` (lead delete: "This lead has stock history") |
| else | | `unavailable` |

### 4.9 Integrity check

`public.check_stock_integrity()` (admins, invoker) returns `table (check_name text, product_id uuid, location_id uuid, expected bigint, actual bigint)` for:
- `ledger_vs_levels` (I2);
- `holds_vs_reserved` (I3);
- `ship_lines` (I7);
- `versions` (I8);
- `bounds` (I1 sanity).

`private.nightly_stock_jobs()` (pg_cron at 03:10 Paris where available, run as `postgres` with no claims):
- expires due holds for every org;
- runs the same checks, and on any row opens **one** admin system task a day;
- prunes `movement_requests` older than 7 days and `share_rate` older than 2 days;
- discards stock batches idle for 24 hours.

Every attack file and concurrency script ends with the same checks (`ledger_sums_match_levels`).

---

## 5 RPCs, server actions and routes

Every public RPC uses the Day 3a revoke/grant loop (granted to `authenticated` only), except the two anon functions.

**Server actions:** `z.strictObject` → `requireSession()` → **one RPC** → `{ok, data} | {ok: false, error}`. They live in:
- `src/app/(app)/inventory/actions.ts` (6a, 6b);
- `inventory/import/actions.ts` (6c);
- `inventory/sales-actions.ts` (6d);
- `inventory/share-actions.ts` (6e);
- `inventory/settings/actions.ts` (6b, 6e).

**GET routes:** `apiSession`, Zod, `Cache-Control: private, no-store`, 400 on a bad cursor.

### 5.1 6a

| RPC | Notes |
|---|---|
| `post_stock_movement(…)` | 4.2 |
| `create_product(p_name, p_pieces_per_carton, p_price_min, p_price_max, p_category, p_unit, p_cartons_per_pallet, p_reorder_point, p_transit_eta, p_share_visible, p_cost_per_piece, p_opening_qty, p_opening_location, p_request_id) returns uuid` | An opening quantity is a `receive` (fresh code; reason `received`) |
| `update_product(p_id, …same, p_transit_eta)`, `set_product_cost(p_id, p_cost)` | managers and admins |
| `archive_product(p_id)` (fresh code; only when empty), `restore_product(p_id)` (admin) | |
| `release_expired_reservations() returns integer` | Calls `private.sweep_expired_holds()`. Called when Inventory, Home or the Stock tab loads |
| `check_stock_integrity()` | admins |

### 5.2 6b

| RPC | Route / action | Notes |
|---|---|---|
| `list_stock(p_search text, p_filter text, p_category text, p_sort text, p_after_value text, p_after_id uuid, p_limit int ≤ 200)` | `GET /api/inventory/stock` | `p_filter`: `all`, `in_warehouse`, `in_transit`, `low`, `sold_out`, `held`, `hidden`, `archived`. `p_sort`: name, available, updated. Returns `id, number, name, category, unit, pieces_per_carton, cartons_per_pallet, wh_on_hand, wh_reserved, wh_available, tr_on_hand, tr_available, transit_eta, price_min, price_max, reorder_point, status_key, share_visible, cost_per_piece` (null unless manager or admin, through a left join under RLS), `sort_value` |
| `count_stock(…)`, `stock_summary() returns jsonb` | page load | Pieces in the warehouse, in transit and held; low and sold-out counts |
| `get_product(p_id) returns jsonb` | `GET /api/inventory/products/[id]` | levels, active holds, last 20 movements, last 10 sales (6d), requests mentioning it (6d) |
| `list_movements(p_product, p_kinds text[], p_user, p_from, p_to, p_before_id bigint, p_limit ≤ 100)` | `GET /api/inventory/movements` | keyset on `id desc`; joins first names; transfer pairs grouped by `group_id` in the UI |
| `list_reservations(p_company, p_product, p_status, p_before_created, p_before_id, p_limit ≤ 100)` | `GET /api/inventory/reservations` | The deal is shown only if the caller can see it |
| `get_inventory_settings()`, `update_inventory_settings(p_alert_assignee, p_hold_days)`, `rename_location(p_kind, p_name)` | `/inventory/settings` | admins |

### 5.3 6c

The 10 import RPCs (7.5). Routes: `GET /api/stock-imports/[id]/issues` and `/changes`.

### 5.4 6d

| RPC | Action / route | Notes |
|---|---|---|
| `record_sale(p_company uuid, p_fulfilment text, p_lines jsonb, p_deal uuid default null, p_note text default null, p_ship_to_country text default null, p_stock_request uuid default null, p_allow_below_min boolean default false, p_request_id uuid default null) returns jsonb` | `recordSale` | 6.1 |
| `undo_sale(p_order)`, `cancel_sale(p_order, p_reason)` | `undoSale`, `cancelSale` (step-up) | 6.6 |
| `extend_reservation(p_id, p_hold_until)` | `extendReservation` | the hold's creator or a lead editor; ≤ today + 90 |
| `list_sales(p_company, p_fulfilment, p_user, p_from, p_to, p_before_created, p_before_id, p_limit ≤ 100)`, `get_sale(p_id)` | `GET /api/inventory/sales` | totals computed |
| `get_lead_stock(p_company) returns jsonb` | `GET /api/leads/[id]/stock` | requests (≤ 20 + count, with live availability per line), active holds, sales (≤ 20 + count, `bought_total`), links (6e, without hash) |
| `list_lead_deals_for_stock(p_company) returns jsonb` | deal picker | Open, `from_stock` deals of the lead visible to the caller. Empty until Day 5 opens deals |
| `log_stock_request(p_company, p_lines jsonb, p_note, p_request_id)`, `set_stock_request_status(p_id, p_status, p_team_note)`, `list_stock_requests(p_status text[], p_before_created, p_before_id, p_limit)`, `get_stock_request(p_id)` | `GET /api/inventory/requests` | Requests inbox |
| `stock_alerts() returns jsonb` | Home card (Day 5) | `{low, sold_out, deals_waiting, requests_new, arriving_late, holds_ending_soon, sample: [≤ 5 {id, name, available, reorder_point, arriving}]}` |

### 5.5 6e

| RPC | Action / route | Notes |
|---|---|---|
| `create_share_link(p_company, p_language, p_label default null, p_expires_days int default 90, p_show_in_transit default true, p_allow_requests default true, p_replace default false) returns jsonb` | `createShareLink` (step-up) | `{id, token, expires_at}`. It inserts, reads `current_setting('topstock.new_share_token')` once, then sets it to `''`. `p_replace` revokes the lead's other active links in the same transaction |
| `revoke_share_link(p_id)`, `extend_share_link(p_id, p_days)` (step-up), `list_share_links(p_company default null, p_active_only default true, p_before_created, p_before_id, p_limit)` | | No `token_hash` in any result |
| `set_sharing_enabled(p_on boolean)` | `/inventory/settings` | on: admin plus a fresh code; off: manager or admin |
| `share_preview() returns jsonb` | `/inventory/client-view`, "Send stock list as text" | invoker; `private.share_items(current_org_id(), true)` |
| anon `share_view(p_token text, p_known_version text default null) returns jsonb`, `share_request(p_token text, p_payload jsonb) returns jsonb` | `POST /api/share/view`, `POST /api/share/request` | 8.5 |

---

## 6 Flows (exact behaviour)

### 6.1 Record a warehouse sale (`record_sale`, one transaction)

1. `aal2`. Idempotency through `movement_requests`: a retry after a lost connection returns the first result and never sells twice.
2. **Shape**, checked as text with one constant 22023 `lines`:
   - 1–50 objects with exactly the keys `product_id`, `description`, `quantity`, `unit_price`;
   - quantity `^[0-9]{1,8}$`, from 1 to 50,000,000 pieces;
   - price `^[0-9]{1,7}(\.[0-9]{1,4})?$`;
   - `from_stock` lines need a product; one product at most once (`duplicate_line`);
   - descriptions are safe and 1–200 characters.
3. **Lead:** `select … from public.companies where id = p_company for update`. No row means the caller cannot change this lead (Day 4 S5(b)), so 42501. The lock also serialises the first-sale status change.
4. **Deal**, if given: visible, same lead, not lost. `p_fulfilment` defaults to the deal's fulfilment. A mismatch is allowed and shown.
5. **Below the minimum:** any warehouse line under its product's `price_min`. Without `p_allow_below_min`, 22023 `below_min` (the sheet asks "Below your minimum price: sell anyway?"). A rep gets 42501.
6. Insert the order, then its lines (the guards snapshot the name, flag `below_min`, and copy the cost).
7. For `from_stock`: `expire_due_holds` for the products, then one `ship` row per line in `product_id` order. Each uses holds automatically (4.5). Any shortage rolls back the whole sale.
8. If `p_stock_request` is given, that request becomes `done`. Its task is marked done if the caller may change it.
9. **First sale** (open question 15): the lead's status becomes `customer` unless it is already `customer`, `do_not_contact` or `disqualified`, or it already has a confirmed sale. The old status goes into `orders.prev_lead_status`.
10. Returns `{order_id, number, total, lines: [{product_id, pieces, used_held, available_after}], became_customer}`. The client never sends a total.

On screen:
- **Success:** toast "Sale 1042 recorded · 3 lines · €1,036.80 · Undo", plus "Lead is now a Customer" when step 9 applied. TanStack keys `['stock']`, `['lead-stock', id]` and `['sales']` are updated from `available_after`.
- **`stock_short`:** the sheet stays open and the line says "Only 120 pieces available now".

### 6.2 Supplier Stock sale

- The same RPC with `direct_from_source`. Lines may have no product (a description is then required). There are no ledger rows.
- Badge "Supplier Stock · ships from the supplier". The ship-to country defaults to the lead's country.

### 6.3 Holds

- **Hold:** `post_stock_movement('reserve', …)` from the lead's Stock tab, the product panel, or Day 5's deal card (`ReserveSheet {companyId, dealId?}`). Stock that is still in transit can be held.
- **Release:** whole or partial. **Extend:** a new end date within 90 days, with no ledger row.
- **Use:** automatic when a sale of that product to that lead (or deal) is recorded. "Sell held" opens the sale sheet prefilled from the hold.
- **End:** as in D8. Until a sweep runs, lists show "Ended Fri · Release" and count such holds separately.
- **Deal lost or deleted:** the holds are released (reason `deal_lost` / `deal_deleted`).
- **Deal won:** holds stay until a sale uses them.

### 6.4 Arrived (`post_stock_movement('transfer')`)

1. Manager or admin. The quantity defaults to all transit pieces and must be ≤ transit on hand.
2. `transfer_out` at transit moves the holds oldest first (whole, then the last one split). `transfer_in` at the warehouse adds the stock and the held count.
3. At the end of the statement, each level has `reserved = Σ active holds`.
4. `hold_arrived_task` (6d) gives each moved hold's creator a task "Arrived: record the sale of {product}" on the hold's lead, due today.
5. When transit on hand reaches 0, `products.transit_eta` is cleared (by the RPC, as invoker).
6. Returns `{moved, holds_moved, holds_split}`.

### 6.5 Correction and stocktake (fresh code)

- Dialog: product, place (Warehouse / In transit), **Set counted quantity / Add / Remove**, quantity in pieces or cartons, reason chips (Count correction, Damaged, Lost, Found, Sample, Other) and a note (required for Other).
- "Set" sends `count`. The change is worked out under the lock, so two people counting never add up twice.
- A correction can never go below what is held: "Release holds first (120 pieces held)".

### 6.6 Undo and cancel

**`undo_sale(p_order)`** (the creator, under 120 s old, still confirmed, no code):
1. Set `status = 'cancelled'`, `cancel_reason = 'undo'`.
2. Post `return` for each warehouse line, in `product_id` order.
3. For each `stock_hold_uses` row whose hold's `hold_until ≥ today`: a `reserve` row recreating that hold (`restored_from`, same lead, deal and end date). This always fits: the return just put back at least as many pieces.
4. If `prev_lead_status` is set, the lead is still `customer`, and it has no other confirmed sale: put the status back.

**`cancel_sale(p_order, p_reason)`** (after the window, or by someone else): a manager or admin with a fresh code and a reason of 3–300 characters. Returns are posted, holds are not recreated, and the status is unchanged. Sales are never edited: cancel and record again.

### 6.7 Low stock

- When a CRM movement takes **warehouse available** from above a product's reorder point to at or below it: one Restock system task for `alert_assignee_id` (nobody if null).
- There is no second task while one is open. Imports never open one; the Check shows "N products will be low".
- The Home card (`stock_alerts().low`) and the Low chip are read live.

### 6.8 A client request lands (6e)

`share_request` writes, in one transaction: the request, its lines, the link counters, and (through `stock_request_task`) a system task.
- Assignee: the lead's owner, else the link's creator, else the oldest admin.
- Constant title, due today in the assignee's time zone, `company_id` and `source_request_id` set.
- If the lead already has an open request task, the request attaches to it (D24).

The team sees it:
- in the owner's **Tasks › Today**;
- on **Inventory › Requests** (badge = count of `new`);
- on the Home card (`requests_new`);
- at the top of the lead's **Stock tab › Wants**, with live availability per line.

Actions: **Record sale** (prefilled: lead, lines, max prices), **Hold** (prefilled), **Asking the supplier** (`in_progress`), **Decline** (with a team note), **Reply on WhatsApp / Email** (Day 4 logging). Status changes are audited without the client's text.

### 6.9 Team-logged request

From a call or a WhatsApp chat: Stock tab → **Log a request**, with products from the stock search or "Something not in the list", and quantities. `source 'team'`, no task (the person logging it is already on it).

---

## 7 Stock sheet import (6c) in depth

### 7.1 Reused from Day 3b

- **Browser:** `src/lib/import/decode.ts` (UTF-8 and Windows-1252, so € survives), `parse.ts` (papaparse 5.7.0, `header: false`), `chunk.ts` (≤ 1,000 rows, ≤ 750 KB), `text.ts` (invisible characters), `csv-out.ts` (formula guard, BOM, CRLF). The file never leaves the browser; only cleaned fields are sent.
- **Components** made kind-aware without changing the lead flow: `stepper`, `progress`, `read-file`, `choose-step`, `discard-dialog`, `import-history`, and the step-up dialog.
- **Database:** `import_batches` with `kind = 'stock'`, the guard pattern, private staging, step-up on every write, the problems file built in the browser, and undo by `import_batch_id`.

### 7.2 Column matching (`src/lib/stock-import/headers.ts`)

Targets:
- `name` (required), `quantity` (required), `pieces_per_carton` (required for new products);
- `price_max`, `price_min`, `total_cost`;
- `resale_min_total`, `resale_max_total` (check only, never sent);
- `status`;
- "Don't import".

Headers go through `normaliseHeader`. Exact synonyms win, then the longest "contains" match. Short synonyms count only as exact matches. `Row`, `Ligne`, `Problem` and `Problème` are ignored, so a fixed problems file re-imports with no clicks.

| Target | Exact (after normalising) | Contains (whole words) |
|---|---|---|
| name | **categorie**, produit, nom du produit, designation, article, libelle, product, product name, item, lot | designation |
| price_max | **prix par pcs max**, prix max, prix par piece max, prix de vente max, selling price max, max price | prix … max |
| price_min | **prix par pcs**, prix par pcs min, prix min, prix par piece, prix de vente min, selling price min, min price | (exact only) |
| quantity | **quantite**, qte, qty, quantity, pieces, pcs, nombre de pieces | (exact only: "qty par carton" contains "qty") |
| pieces_per_carton | **qty par carton**, quantite par carton, pcs par carton, pieces par carton, colisage, pcb, units per carton | par carton, per carton |
| total_cost | **pp**, prix d achat, prix d achat total, cout total, cout du lot, purchase price, total cost | (exact only: "pp") |
| resale_min_total / resale_max_total | **revente min** / **revente max**, total revente min / max, resale min / max | revente min / revente max |
| status | **status**, statut, etat, emplacement, location | — |

**Min/max inside parentheses:** `normaliseHeader` drops parentheses, so the matcher also reads the folded words inside them. For a price or revente header:
- `max` outside the parentheses → max;
- otherwise `max` as a whole word inside → max;
- otherwise `min` inside or outside → min;
- plain "prix par pcs" → min.

Haider's row `CATÉGORIE · PRIX PAR PCS MAX (SELLING PRICE IN EURO MAX) · PRIX PAR PCS (SELLING PRICE IN EURO MIN) · QUANTITÉ · QTY PAR CARTON · PP · REVENTE MIN · REVENTE MAX · STATUS` maps with **zero clicks**, with or without accents and parentheses. The matching is remembered under a hash of the header row (localStorage, try/catch).

### 7.3 Values (`numbers.ts`, `values.ts`)

- **Number style per file**, shown on Match with a live example from the file ("Numbers look like **1 234,56** → 1234.56 · Change"):
  - French: spaces, NBSP, narrow NBSP, thin space and `'` as thousands separators, comma as decimal mark;
  - English: `1,234.56`;
  - a `;` separator or cells like `12,50` mean French; only ambiguous columns (`12,345`) ask.
- **Cleaning:**
  - `€` and `EUR` are stripped;
  - Excel errors (`#VALEUR!`, `#N/A`, `#DIV/0!`, `#REF!`, `#NOM?`) give `excel_error`;
  - scientific notation gives `number_mangled`;
  - prices allow at most 4 decimals;
  - quantities and cartons must be whole (`12,5` → `quantity_not_whole`; `1 200,00` → 1200).
- **Status values**, each distinct value shown with its count; an unknown value must be chosen ("Continue" is disabled with the reason); a blank cell uses the default chosen on Match (In Warehouse, with an amber note):

| Maps to | Values |
|---|---|
| In Warehouse | in warehouse, warehouse, en entrepot, entrepot, en stock, stock, disponible, available, arrive, france |
| In Transit | in transit, transit, en transit, en route, en cours, en mer, at sea, on the way, shipped, expedie |

### 7.4 Row rules (`normalise.ts`; constants in `rules.ts`, mirrored in SQL; `stock-parity.spec.ts` keeps them equal)

**Problems** (the row is not imported):

| Code | Rule |
|---|---|
| `name_missing`, `name_too_long` | empty, or over 200 characters |
| `quantity_missing`, `quantity_invalid`, `quantity_negative`, `quantity_not_whole`, `quantity_too_big` | the last is over 50,000,000 |
| `carton_invalid` | not from 1 to 1,000,000 |
| `carton_required` | a new product with no QTY PAR CARTON |
| `price_invalid`, `price_order` | negative, over 1,000,000, more than 4 decimals; min above max |
| `cost_invalid` | negative or over 10¹⁰ |
| `excel_error`, `number_mangled` | |
| `columns_extra`, `cell_too_long` | as on Day 3b |

**Warnings** (the row is imported):

| Code | Meaning |
|---|---|
| `resale_min_mismatch`, `resale_max_mismatch` | \|REVENTE − round(QUANTITÉ × PRIX, 2)\| > max(0.50 €, 0.5 %). The CRM's own total is shown |
| `resale_unreadable` | the REVENTE cell is not a number |
| `cost_above_price` | PP ÷ QUANTITÉ above PRIX MAX ("selling at a loss?") |
| `cost_missing` | no PP: no cost per piece |
| `cost_kept_sold_out` | QUANTITÉ 0 with PP: the existing cost is kept |
| `price_missing` | clients see "Price on request" |
| `loose_pieces` | QUANTITÉ is not a whole number of cartons |
| `prices_differ` | a product's warehouse and transit rows disagree; the warehouse row's prices are used |
| `carton_kept` | blank for an existing product: the old value is kept |

If more than half the rows mismatch REVENTE MAX but match MIN (or the reverse), a banner says: "PRIX MIN and MAX columns may be swapped. Check the matching."

**Staged row** (Zod `strictObject`; decimals as strings matching `^\d{1,10}(\.\d{1,4})?$`): `{row_no, name, location_kind, quantity, pieces_per_carton | null, price_min | null, price_max | null, total_cost | null, fixes[]}`, or `{row_no, problems[]}` for rows already known to be bad (no values sent).

### 7.5 Database: guard branch and RPCs (all invoker, static SQL)

**`private.stock_batch_step(o, n, op)`**, called by the recreated `import_batch_guard`. Every update transition also needs `current_setting('topstock.stock_batch_op', true) = n.id::text`, a transaction-local marker set only by the stock RPCs. That is defence in depth: the structural rules below are the primary layer.

| From → to | Who | Precondition | Sets |
|---|---|---|---|
| insert | admin with a fresh code | `row_count` 1–5,000; `last_row_no` > `row_count` and ≤ 5,001; ≤ 3 open stock batches | `uploaded_by` |
| staged / dry_run → dry_run | the uploader | staged count = `row_count`, none `pending` | `issue_counts` from `private.stock_import_tally`, `rejected`, `duplicates` |
| dry_run → committing | the uploader, fresh code | — | |
| committing → imported | the uploader | no `new` or `update` rows left | `imported`; purges staging after counting |
| imported → rolling_back | any admin, fresh code | — | |
| rolling_back → rolled_back | any admin | `private.stock_import_reversible(batch, 1)` is empty | `kept` |
| staged / dry_run → discarded (the Day 3b closing move) | any admin | — | purges staging |
| anything else | — | — | 22023 `bad_transition` |

The lead path is byte-identical, and lead RPCs given a stock batch fail (`lead_rpcs_refuse_stock_batch`).

**RPCs:**

| RPC | Notes |
|---|---|
| `create_stock_import(p_filename, p_file_sha256, p_row_count, p_last_row_no) returns uuid` | Discards the caller's stock batches idle for 24 hours; inserts `kind = 'stock'` |
| `stage_stock_import_rows(p_batch, p_rows jsonb) returns int` | 1–1,000 rows, ≤ 1 MiB. Pre-check as text through `jsonb_to_recordset(…) as r(row_no text, name text, location_kind text, quantity text, …, problems jsonb, fixes jsonb)`; numbers in canonical form and `pg_input_is_valid`. Constant 22023 `invalid rows`; `on conflict do nothing` |
| `validate_stock_import(p_batch, p_moved_policy text default 'keep_crm') returns jsonb` | 7.6 |
| `list_stock_import_issues(p_batch, p_after_row, p_limit ≤ 1000)`, `list_stock_import_changes(p_batch, p_after_row, p_limit ≤ 200)` | admin data (costs) |
| `commit_stock_import(p_batch, p_max_rows int default 250) returns jsonb` | 7.7 |
| `preview_stock_import_rollback(p_batch)`, `rollback_stock_import(p_batch, p_max_rows default 250)` | 7.8 |
| `discard_stock_import(p_batch)`, `list_stock_imports(p_limit, p_before_created, p_before_id, p_id)` | `kind = 'stock'` |

### 7.6 Check (dry run): `validate_stock_import`

One set-based statement with window aggregates (no join between unanalysed sets, the Day 3b lesson). Results are written back by primary key. In order:

1. **Rejected:** browser problems, `db_problem`, or a new product without pieces per carton.
2. **Repeated:** an earlier non-rejected row with the same `(name_key, location_kind)`; `match_row_no` points to the first (open question 2).
3. **Grouped per product** (`name_key`):
   - `sheet_wh` = the In Warehouse row's quantity, or **0 if absent**; `sheet_tr` the same for transit;
   - this applies only to products the sheet lists;
   - different pieces per carton between the two rows gives `carton_conflict` for the whole group.
4. **Matched** on `products (org_id, name_key)`, archived included (an archived match is flagged `restored`). The current levels are read as `wh_at_check`, `tr_at_check`, `reserved_at_check`, and `moved_at_check = crm_moved` at either level.
5. **Outcome per group:**
   - `new`;
   - `unchanged`: quantities, prices and carton all equal;
   - `update`;
   - `kept`: moved in the CRM, with policy `keep_crm`. Prices and carton still update;
   - `below_reserved`: a target under what is held there. Quantities are skipped, prices still update; "300 pieces are held for clients; the sheet says 200".
6. **Cost per piece** = Σ PP ÷ Σ QUANTITÉ over the group's non-rejected rows with QUANTITÉ > 0.

**Tallies** (also written to `issue_counts` by the guard):
- counts per outcome and per warning;
- pieces before → after per place;
- resale value min–max of available stock;
- `not_in_sheet`: products with stock that the sheet does not list. These are **left alone**.

### 7.7 Commit: `commit_stock_import(p_batch, p_max_rows default 250)`

Same contract as Day 3b: chunks, a paused state, safe retries. Each call is one transaction:

1. Admin uploader with a fresh code; marker set; batch `committing` (the first call moves `dry_run → committing`).
2. Pick the next `p_max_rows` product groups still pending. New products are inserted first, in `name_key` order, with `import_batch_id`. A name taken meanwhile gives `added_meanwhile`.
3. `private.lock_stock_import(p_batch, sorted product ids)`: products, then their levels, product by product.
4. For each product, in `product_id` order:
   1. Write `stock_import_changes` (old values).
   2. Update changed fields and the cost (`source 'import'`).
   3. Read the **locked** levels, then decide:
      - `crm_moved` at either level and policy `keep_crm` → **kept**;
      - a target under `reserved` → skipped (`below_reserved`);
      - otherwise apply targets:
        - transfer `t = least(greatest(tr_now − sheet_tr, 0), greatest(sheet_wh − wh_now, 0))` as a `transfer_out` / `transfer_in` pair tagged with the batch, reason `arrived` (holds move too, 6.4);
        - then `import_in` / `import_out` for the remainders, each with `expected_on_hand`.
   4. Mark the staging rows `applied`, `kept` or `skipped` in the same statement.
5. Return progress. When nothing is left, the status moves to `imported`.

On timeout the client halves `p_max_rows` and retries; replays are safe, because rows are marked in the same transaction.

**Worked examples:**

| CRM before (wh / tr) | Sheet rows for the product | Rows posted | After |
|---|---|---|---|
| 0 / 500 | In Warehouse 500 | transfer 500 ("Arrived (stock sheet)") | 500 / 0 |
| 3,600 / 0, sold in the CRM since the last sheet | In Warehouse 4,200 | none (kept); prices updated | 3,600 / 0 |
| 1,000 / 0, not moved | In Warehouse 800, In Transit 2,000 | import_out 200 (wh), import_in 2,000 (tr) | 800 / 2,000 |
| 300 / 0, not moved | In Warehouse 0 | import_out 300 | 0 / 0 (sold out, off client links) |
| not in the sheet | — | none | unchanged |

### 7.8 Undo

**Preview:** "Reverse quantities on 34 products, keep 3 (sold or held since). Archive 5 new products, keep 1. Restore prices on 7 products, keep 2 (edited since)."

**`rollback_stock_import`** (any admin with a fresh code, chunks of 250, `rolling_back`, the same lock helper):

| Item | Reversed when | Otherwise |
|---|---|---|
| A product's quantities | Every level the batch changed for it still has `last_onhand_batch_id = batch`, and reversing does not go below `reserved`. Then `undo_in` / `undo_out` with −(the batch's net change at that level) and `expected_on_hand` | kept (`moved`, `held`, `later_import`) |
| A product the import created, or brought back from archive | Quantities reversed as above; no holds, sale lines or request lines; fields equal `new_*`. Then `archived_at = now()` (never deleted: the ledger keeps its rows; a later import brings it back) | kept (`edited`) |
| Field changes (prices, carton, cost) | The current value still equals `new_*`: restore `old_*` | kept (`edited`) |

The ledger keeps both the import rows and the undo rows.

### 7.9 Screens

- `/inventory/import`: admins; everyone else gets 404. Same wizard as Day 3b: Choose · Match (columns, number style, statuses, default status) · Check · Import. Past imports sit on the right.
- **Check:**
  - tiles: **New products · Updated · Kept (changed in the CRM) · Can't import**, with Repeated and Unchanged in a line below;
  - before → after pieces for the warehouse and transit;
  - warnings with counts ("REVENTE MAX doesn't match quantity × max price on 4 rows");
  - "In the CRM but not in this sheet: 5 (left as they are)";
  - "For the 6 kept products, use the sheet's quantities" (re-runs the check with `use_sheet`);
  - a paged **change table**: product, warehouse before → after, transit before → after, price change, flags.
- **Before any CRM movement** nothing is "kept", so the sheet simply wins. That gives UX's "replace until the first sale" with no mode switch.
- "Download rows not imported" gives the Day 3b CSV: formula-guarded, same delimiter, `Row` and `Problem` first.
- Primary (red, black text): "Import 28 new products and update 6" (⌘↩). Done: "28 products added · 6 updated · 4 quantities set" with "See them in Inventory" and "Undo import".

### 7.10 Fake sheets (`scripts/make-fake-stock.mjs`, seeded; invented products and numbers only)

**`tests/fixtures/stock/stock-40-fake.csv`:** UTF-8 BOM, `;`, decimal comma, Haider's exact header. 40 lines:

| Group | Rows | Contents |
|---|---|---|
| Ready | 30 | 20 In Warehouse, 6 In Transit; 2 products listed in both places (so **28 products**); 2 sold out (QUANTITÉ 0); `1 200` with NNBSP; `12,50 €`; status spellings "In warehouse ", "EN TRANSIT", "Entrepôt"; 3 REVENTE mismatches; 1 PP blank; 1 cost above max; 1 loose pieces; names `=HYPERLINK("http://example.invalid")`, `<img src=x onerror=alert(1)>` and one with U+202E (stripped), all imported as text |
| Repeated | 2 | accent and case variants of a ready row, same status |
| Can't import | 7 | min > max, "beaucoup", −5, 12,5, carton 0, blank name, `#VALEUR!` |
| Blank | 1 | ignored |

**Also:**
- `stock-40-fake-cp1252.csv`;
- `stock-en-headers.csv` (English, `,`, dot decimals);
- `stock-parens-only.csv` (min/max only inside parentheses);
- `stock-reimport-fake.csv` (4 new quantities, 2 new prices, 1 transit product now In Warehouse, 2 new products, 1 unchanged, 1 product sold in the CRM in between);
- `not-a-csv.xlsx` (reused);
- `expected.json`.

The 5,000-row perf sheet is generated at test time. The real sheet never enters a session.

---

## 8 Client stock link (6e) in depth

### 8.1 What can go wrong

- Someone who is not the client sees the stock.
- A client sees cost, minimum prices, holds, other clients or lead data.
- A leaked link works forever.
- Links are guessed.
- The secret reaches logs, Referer headers, link previews or the Supabase API logs.
- The page becomes a spam channel into the CRM.
- Free tiers are burned (egress, function calls, database connections).
- A script on the page steals something.
- The anon key gains wider access.
- A signed-in teammate's session leaks into the page.

### 8.2 Architecture

```
Client phone ─GET /s/fr──────────────▶ proxy share branch (no session, no cookies, share CSP, no-referrer, noindex)
                                       └▶ shell with skeleton, Share messages only, no data, no token
             ─POST /api/share/view {token, knownVersion}──▶ route: JSON only, ≤ 2 KB, Origin, Zod, IP limiter
                                       └▶ server-only anon client (no cookies) ─▶ rpc share_view  [definer, share_reader]
             ─POST /api/share/request {token, lines, note, name, idempotencyKey, website, t}──▶ + honeypot, time trap
                                       └▶ rpc share_request  [definer, share_reader, throttled]
```

### 8.3 Token lifecycle

1. **Create** on the lead's Stock tab: lead editor plus a fresh code. `createShareLink` calls `create_share_link`. The guard makes the token; the action builds `${origin}/s/${language}#${token}` (its own validated origin) and returns it **once**. It is never cached in TanStack, never written to localStorage, never logged.
2. **Send:**
   - **Share on WhatsApp**: `wa.me/<dialString(phone)>?text=…`, or `wa.me/?text=…` when the lead has no usable number;
   - **Email**: `mailto:`;
   - **Copy**.

   The activity is logged without the URL ("Sent the stock link, valid until 9 Jan"). The dialog says: "Anyone with this link sees your stock list. Send it only to this client."
3. **Show again:** impossible, because only the hash exists. The card keeps the link in memory for this page view ("Copy again"). After a reload it offers **Replace link** (revoke and create in one step).
4. **Revoke:** one click, no code, effective on the next request. **Extend:** fresh code. **Lead deleted:** links cascade.
5. **Kill switch:** `sharing_enabled`, off by default.

### 8.4 What the client sees

| Shown | Never sent to the browser |
|---|---|
| name, P-ref (muted), category | cost per piece, PP, any value at cost |
| **max price per piece, excl. VAT** (null → "Price on request") | `price_min`, `below_min` |
| available pieces in the warehouse (on hand − held), full cartons, pieces per carton, unit word | held quantities, who holds them, deals, sales, other clients |
| In Transit available pieces and the **week** expected (if the link shows transit) | the exact ETA day, reorder points, movements |
| "Updated 14:05" (the answer's `generated_at`) | the client's own company name, phone, email, city; any lead data |
| "Your contact: Henri" (snapshot) | other team members, emails, phone numbers, internal labels |
| product UUIDs (needed for requests; they grant nothing) | link id, org id, location ids, import data |

Products appear only when `share_visible`, not archived, and with warehouse available > 0, or transit available > 0 when the link shows transit. **Sold out means hidden**, with no job needed.

### 8.5 The role and the two anon functions

**Role** (6e; spike S1):

```sql
do $$ begin
  if not exists (select from pg_roles where rolname = 'share_reader') then
    create role share_reader nologin noinherit;
  end if;
end $$;
grant share_reader to postgres with set true;            -- PG16+: lets the migration hand ownership over
grant usage on schema public, private to share_reader;
-- Column grants: the whole list. Nothing on product_costs, orders, deals, companies, contacts, profiles, tasks,
-- stock_reservations, stock_movements, audit_log, or any other column of these tables.
grant select (id, org_id, company_id, token_hash, language, show_in_transit, allow_requests, signature, expires_at,
              revoked_at) on private.share_links to share_reader;
grant update (open_count, last_opened_at, request_count, last_request_at) on private.share_links to share_reader;
grant select (org_id, sharing_enabled) on private.inventory_settings to share_reader;
grant select (id, org_id, number, name, category, unit, pieces_per_carton, price_max, transit_eta, share_visible,
              archived_at) on public.products to share_reader;
grant select (product_id, location_id, org_id, on_hand, reserved) on public.stock_levels to share_reader;
grant select (id, org_id, kind) on public.locations to share_reader;
grant select, insert, update, delete on private.share_rate to share_reader;
grant select (id, share_link_id, status, idempotency_key) on private.stock_requests to share_reader;
grant insert (org_id, company_id, share_link_id, source, note, requester_name, language, idempotency_key)
  on private.stock_requests to share_reader;
grant insert (request_id, position, org_id, product_id, description, quantity, unit, pieces, price_shown, availability)
  on private.stock_request_lines to share_reader;
grant execute on function private.share_token_hash(), private.share_link_id(), private.share_org(),
  private.share_items(uuid, boolean), private.share_take(uuid, text) to share_reader;
```

**Policies `TO share_reader`** (`require_mfa` targets `authenticated` only):

| Table | Policy |
|---|---|
| `share_links` (select, update) | `token_hash = (select private.share_token_hash())`: only the row of the presented secret, so the lookup works before the org is known |
| `share_rate` (all) | `scope_id in ((select private.share_link_id()), (select private.share_org()))` |
| `stock_requests` (select, insert) | `share_link_id = (select private.share_link_id())`; insert also checks `org_id = share_org()`, `source = 'share_link'`, and `company_id` = the link's lead |
| `stock_request_lines` (insert) | `org_id = share_org()` and the request belongs to the link |
| `inventory_settings`, `products`, `stock_levels`, `locations` (select) | `org_id = (select private.share_org())` |

- The three helpers read `current_setting('topstock.share_token_hash' | 'topstock.share_link' | 'topstock.share_org', true)`. They return null (no rows) when unset.
- The functions set them with `set_config(…, true)`, which is transaction-local; PostgREST runs each RPC in its own transaction. No API caller can set them: `set_config` is not in an exposed schema, and anon can execute only the two functions.
- **No `auth.*` call and no private auth helper** is on `share_reader`'s path. The two guards it fires branch on `current_user` before any `auth.uid()`. The task trigger and `audit_row` run as `postgres`.

**The whitelist, one definition for the anon view and the team preview:**

```sql
create function private.share_items(p_org uuid, p_with_transit boolean) returns jsonb
language sql stable set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_array(i.id, i.number, i.name, i.category, i.unit, i.price_max::text,
                                              i.ppc, i.wh, i.tr, i.eta_week)
                            order by i.category nulls last, i.sort_name, i.id), '[]'::jsonb)
    from (select p.id, p.number, p.name, p.category, p.unit, p.price_max, p.pieces_per_carton as ppc,
                 lower(p.name) as sort_name,
                 greatest(coalesce(w.on_hand - w.reserved, 0), 0) as wh,
                 case when p_with_transit then greatest(coalesce(t.on_hand - t.reserved, 0), 0) else 0 end as tr,
                 case when p_with_transit and coalesce(t.on_hand - t.reserved, 0) > 0
                       and p.transit_eta >= (now() at time zone 'Europe/Paris')::date
                      then date_trunc('week', p.transit_eta)::date end as eta_week      -- never the day
            from public.products p
            join public.locations lw on lw.org_id = p.org_id and lw.kind = 'warehouse'
            join public.locations lt on lt.org_id = p.org_id and lt.kind = 'transit'
            left join public.stock_levels w on w.product_id = p.id and w.location_id = lw.id
            left join public.stock_levels t on t.product_id = p.id and t.location_id = lt.id
           where p.org_id = p_org and p.archived_at is null and p.share_visible
             and (coalesce(w.on_hand - w.reserved, 0) > 0
                  or (p_with_transit and coalesce(t.on_hand - t.reserved, 0) > 0))
           order by p.category nulls last, lower(p.name), p.id
           limit 2000) i                                                         -- after the in-stock filter
$$;
revoke all on function private.share_items(uuid, boolean) from public, anon;
grant execute on function private.share_items(uuid, boolean) to authenticated, share_reader;
```

As invoker, it runs as `share_reader` inside `share_view`, and as `authenticated` (under RLS) inside `share_preview`. Both return exactly these columns.

**`public.share_view`:**

```sql
create function public.share_view(p_token text, p_known_version text default null) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare v_link record; v_on boolean; v_items jsonb; v_version text;
begin
  if p_token is null or p_token !~ '^tss_[A-Za-z0-9_-]{43}$' then
    return '{"status":"inactive"}';                                    -- no database read
  end if;
  perform set_config('topstock.share_token_hash', encode(sha256(convert_to(p_token, 'UTF8')), 'hex'), true);
  select l.id, l.org_id, l.language, l.show_in_transit, l.allow_requests, l.signature into v_link
    from private.share_links l
   where l.token_hash = sha256(convert_to(p_token, 'UTF8')) and l.revoked_at is null and l.expires_at > now();
  if not found then return '{"status":"inactive"}'; end if;           -- unknown, revoked and expired: one answer
  perform set_config('topstock.share_link', v_link.id::text, true);
  perform set_config('topstock.share_org', v_link.org_id::text, true);
  select s.sharing_enabled into v_on from private.inventory_settings s where s.org_id = v_link.org_id;
  if v_on is not true then return '{"status":"inactive"}'; end if;
  if not private.share_take(v_link.id, 'view') then return '{"status":"slow_down"}'; end if;
  update private.share_links set open_count = open_count + 1, last_opened_at = now()
   where id = v_link.id and (last_opened_at is null or last_opened_at < now() - interval '5 minutes');
  v_items := private.share_items(v_link.org_id, v_link.show_in_transit);
  v_version := left(md5(v_items::text), 16);
  if v_version = p_known_version then
    return jsonb_build_object('status', 'ok', 'unchanged', true, 'version', v_version);
  end if;
  return jsonb_build_object('status', 'ok', 'version', v_version, 'language', v_link.language, 'currency', 'EUR',
    'show_in_transit', v_link.show_in_transit, 'allow_requests', v_link.allow_requests,
    'signature', v_link.signature, 'generated_at', now(), 'items', v_items);
end $$;
```

**`public.share_request(p_token text, p_payload jsonb)`** (same header and owner):
1. The same format check, lookup and switch check → `inactive`. `allow_requests` false → `closed`.
2. **Shape**, checked as text, with one answer `{"status":"invalid"}` for any failure:
   - `octet_length(p_payload::text) ≤ 16384`;
   - keys exactly `lines, note, name, idempotency_key`;
   - 0–20 lines, each with keys exactly `product_id, description, quantity, unit`;
   - `product_id` a valid uuid or null; a safe description of 1–200 characters when it is null;
   - quantity `^[0-9]{1,8}$` from 1 to 10,000,000; unit `piece | carton`;
   - note ≤ 1,000 and name ≤ 80 code points, safe, with no lone surrogates;
   - at least one line, or a note of 3 or more characters.
3. **Idempotency:** an existing `(share_link_id, idempotency_key)` returns `received` again and writes nothing.
4. **Limits:** `share_take(link, 'request')` (5 an hour, 20 a day), `share_take(org, 'request')` (200 a day), and ≤ 10 `new` requests on the link (`too_many_open`). Over a limit → `slow_down`.
5. **Products:** each `product_id` must be in `share_items(org, show_in_transit)`, the visible set. Name, `price_max` and `pieces_per_carton` are snapshotted from it. `pieces = quantity × ppc` for cartons. `availability` is `in_warehouse` (wh > 0), `in_transit`, or `not_listed` for descriptions.
6. **Write:** the request (`company_id` from the link), its lines, then `request_count + 1` and `last_request_at` on the link. The task trigger runs (6.8).
7. **Returns** `{"status":"received","signature":…}`: no request number, no ids.

**`private.share_take(p_scope uuid, p_kind text) returns boolean`** (invoker, so it runs as `share_reader`):
- It reads the minute, hour and day buckets (views: 30 a minute and 600 an hour per link; requests: as above).
- **Over a limit, it refuses without writing.** Otherwise it upserts `n + 1` for each span and deletes this scope's buckets older than 2 days.
- An overshoot under concurrency is at most the number of parallel calls.

**Grants:**

```sql
alter function public.share_view(text, text) owner to share_reader;     -- inside: grant create on schema public to
alter function public.share_request(text, jsonb) owner to share_reader; -- share_reader before, revoke it after (S1)
revoke all on function public.share_view(text, text), public.share_request(text, jsonb) from public, authenticated;
grant execute on function public.share_view(text, text), public.share_request(text, jsonb) to anon;
```

**Why this is narrow even though anon can call it directly** with the public anon key:
- Every byte a direct caller can get equals what the page shows for that same secret.
- Without a valid 256-bit secret, nothing is returned and nothing is written.
- The per-link and per-org limits are in the database, so they hold on both paths.
- The bodies run as a role that **cannot read** cost, minimum prices, lead data, deals or another org's rows, even if a body had a bug.

### 8.6 Next side

**Proxy** (`src/proxy.ts`):
- First, `requestHeaders.delete("x-topstock-surface")` and `requestHeaders.delete("x-topstock-locale")` on every request.
- `sharePaths = ["/s", "/api/share"]` is checked before the Supabase block. On a match:
  - set `x-topstock-surface: share`, and `x-topstock-locale` from `/s/fr` or `/s/en`;
  - return `NextResponse.next()` with the nonce and `contentSecurityPolicy(nonce, https, { share: true })`;
  - **no Supabase client, no cookie read or write**.
- `"/robots.txt"` joins `publicPaths`.
- `matches()` keeps `/settings` and `/search` walled (`proxy_share_paths_exact`).
- **Share CSP:** `default-src 'none'; script-src 'self' 'nonce-…' 'strict-dynamic'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'; object-src 'none'`, plus `upgrade-insecure-requests` on HTTPS. Dev additions as today. **No Supabase origin.**

**`next.config.ts`:** a last `headers()` entry for `/s/:path*` and `/api/share/:path*` with `Referrer-Policy: no-referrer`, `X-Robots-Tag: noindex, nofollow, noarchive, nosnippet`, `Cross-Origin-Resource-Policy: same-origin` and `Cache-Control: no-store`. In Next, the last matching entry wins (S4).

**`src/i18n/request.ts`:** when the surface header is `share`:
- the locale comes from `x-topstock-locale`;
- messages are `{ Share, Common: { skipToContent }, Metadata: Share.meta }`;
- the cookie is ignored.

The root layout's provider then passes only that subset. Unit test `share_messages_subset_exact`.

**Pages:**
- `src/app/(share)/layout.tsx`: no app chrome, no `requireSession`.
- `src/app/(share)/s/[locale]/page.tsx` plus `loading.tsx`: validates `fr | en`, else `notFound()`. Metadata: `robots: { index: false, follow: false, nocache: true }`, `referrer: 'no-referrer'`, title "TopStock Wholesale · Stock", no OpenGraph image.
- The client component reads `location.hash`, POSTs, renders, and polls every 5 minutes while visible (and on focus, at most once a minute) with `knownVersion`.

**Routes:**
- **`POST /api/share/view`** (`src/app/api/share/view/route.ts`):
  1. `Content-Type: application/json`, body ≤ 2 KB (read with a byte cap), and `assertSameOrigin` (from `src/lib/http.ts` if Day 4c merged it; otherwise 6e adds it there with the Day 4 signature).
  2. Zod `strictObject({ token: z.string().regex(/^tss_[A-Za-z0-9_-]{43}$/), knownVersion: z.string().regex(/^[0-9a-f]{16}$/).optional() })`.
  3. IP limiter, 60 a minute.
  4. `createShareClient()` (`src/lib/share/server.ts`, server-only: anon key, `persistSession: false`, `autoRefreshToken: false`, `detectSessionInUrl: false`, no cookies) → `rpc('share_view')`.
  5. `mapShareItems()` turns positional arrays into fixed keys. `shareSnapshotSchema` (strict) re-parses the answer and drops anything else.
  6. ok → 200; inactive → 404; slow_down → 429; anything else → 503 `{status: "unavailable"}`. Always `no-store`.
- **`POST /api/share/request`:** the same gates, with a body ≤ 16 KB and an IP limit of 10 per 10 minutes.
  - Zod `strictObject({ token, lines: z.array(z.strictObject({ productId: z.uuid().nullable(), description: cleanText(1, 200).nullable(), quantity: z.int().min(1).max(10_000_000), unit: z.enum(['piece','carton']) })).max(20), note: cleanText(0, 1000), name: cleanText(0, 80), idempotencyKey: z.uuid(), website: z.string().max(200), t: z.int().min(0) })`.
  - A filled `website` (honeypot) or `t < 2000` ms since the page loaded answers `200 {status: "received"}` **without calling the database**.
  - invalid → 400; closed → 403.

**IP limiter** (`src/lib/share/rate-limit.ts`): a sliding window per instance, keyed by `sha256(ip + daily salt)` truncated to 16 bytes. The salt is random, in memory only, and rotates daily. A Map capped at 5,000 keys with LRU eviction. The IP comes from Vercel's `x-forwarded-for` (S5). Nothing is stored or logged.

**Lint:**
- `no-console` covers `src/app/(share)/**`, `src/app/api/share/**`, `src/lib/share/**`, `src/components/share/**` and every inventory server file.
- `no-restricted-imports` bans `@supabase/*`, `@/lib/supabase/*` and `*-server` in `src/app/(share)/**` and `src/components/share/**`.

**Gitleaks:** `.gitleaks.toml` with `[extend] useDefault = true` and rule `topstock-share-token` (`tss_[A-Za-z0-9_-]{43}`).

### 8.7 Rate limiting without paid services

| Layer | Limit | Bypassable? |
|---|---|---|
| Format checks (route and function) | malformed token or body → 404 / 400, no database read | — |
| Database, per link | views 30 a minute and 600 an hour; requests 5 an hour and 20 a day; ≤ 10 open requests | No: inside the function |
| Database, per org | 200 requests a day | No |
| Unknown tokens | one index probe, **no write** | — |
| Next per IP (memory, per instance) | view 60 a minute; request 10 per 10 minutes | Only by calling Supabase directly, which still hits the database limits |
| Honeypot, time trap, Origin, size caps | fake success without a database call | same |
| Vercel Firewall rule on `/api/share/*` | 60 a minute per IP, only if free on the plan (S5) | — |
| Kill switch and revoke | immediate | — |

**Accepted residuals** (written in the evidence):
- A direct PostgREST caller bypasses the Next layers; the database limits are the real guard.
- A flood of well-formed unknown tokens costs one index probe each, no worse than any anon endpoint today.
- Vercel's own request logs keep client IPs for their retention period; we add nothing to them.

### 8.8 Enumeration resistance

- One answer for every non-working case: malformed, unknown, revoked, expired, sharing off, lead deleted. Same JSON, same 404, same page ("This link isn't active. Ask your TopStock contact for a new one.").
- The format check comes before any database read. Well-formed tokens always take the same path.
- No per-token error counters. "Slow down" appears only for valid links, so it is no oracle for guessers.
- Product refs in requests resolve only among visible products, with one generic error.

### 8.9 Logging without personal data

| Where | What is kept |
|---|---|
| Database | per link: `open_count` (at most one per 5 minutes), `last_opened_at`, `request_count`, `last_request_at`; rate buckets for 2 days; the requests themselves (business records the client chose to send; they cascade with the lead) |
| Nowhere | IP address, user agent, fingerprint, country, the secret |
| Code | our share and inventory code logs nothing (ESLint); errors map to codes |
| Audit | request text masked (lengths only); `token_hash` hidden |
| Platform | Vercel logs the method, path (`/s/fr`, `/api/share/view`, never the token) and the client IP. Supabase API logs see `POST /rest/v1/rpc/share_view` from Vercel's IP; the token travels in a POST body because the function is VOLATILE |
| Robots | `src/app/robots.ts` (`Disallow: /`) is now reachable; plus meta robots and `X-Robots-Tag` |

### 8.10 How In Transit stock is shown

- A separate **"Arriving / Arrive bientôt"** section when the link shows transit (default on; open question 5).
- Each row: "1 000 pcs · 20 cartons of 50 · arriving week of 13 Oct" / "semaine du 13 oct.". A past or unset ETA shows "date to be confirmed" / "date à confirmer".
- Transit items can be requested (pre-order interest).
- The team sets `transit_eta` inline on the Arriving tab. Arrived moves the stock to "In our warehouse" at once.

### 8.11 Rollout

- 6e merges with `sharing_enabled = false`. Every link answers "inactive", and Settings shows "Sharing is off".
- Fixtures switch it on for e2e. On dev, Haider can switch it on for his preview check (previews sit behind Vercel login).
- REPORT line: **"Switch on sharing in production?"** Recommended after Gate 1 and the Vercel Pro upgrade.

---

## 9 Security: threats and how each is blocked

Test names refer to section 11. "attack" means a `supabase/tests/*.sql` file; "e2e" means Playwright.

| # | Threat | Control | Proof |
|---|---|---|---|
| P1 | Guessing or enumerating tokens | 256-bit tokens; hash lookup; one answer for every non-working case | attack `share_view_inactive_cases_same_answer` (byte-identical jsonb); e2e `share_public_unknown_revoked_expired_same_page` |
| P2 | Token leaks (logs, Referer, unfurlers, mail scanners, API logs) | Fragment; POST body; `no-referrer`; bots fetch only the shell; VOLATILE functions (POST only) | e2e `share_public_token_not_in_requests_urls`, `share_rpc_get_405`; attack `share_functions_volatile` |
| P3 | A forwarded link | No lead data on the page; expiry; revoke; Replace; "opened N times, last …" for the team | attack `share_view_payload_keys_exact`; e2e `share_link_revoke_then_inactive` |
| P4 | Token stolen from the database or a backup | Only `sha256` stored; a hash is not a token; `token_hash` not granted and hidden in audit | attack `token_hash_not_readable_by_authenticated`, `token_hash_not_in_audit`, `share_view_rejects_hash_as_token` |
| P5 | Weak tokens planted by an insider | Generated by the guard; client values ignored | attack `share_link_client_token_hash_ignored`, `share_token_format` |
| P6 | Anon gains wider access | Exactly two functions executable by anon; owner `share_reader` with column grants and hash/org-bound policies; static SQL; `search_path = ''` | attack `anon_executable_functions_exact` (catalog), `anon_cannot_select_any_table` (loop), `share_reader_column_privileges` (`has_column_privilege` over every column of every table) |
| P7 | Cost, PP or min price on the client page | `share_reader` has no privilege on them; `share_items` whitelist; positional arrays; strict output schema in the route | attack `share_items_signature_exact`, `share_reader_cannot_read_cost`; unit `share_output_schema_strips_cost`; e2e `share_public_never_shows_cost_or_min_price` (planted 999.99 and 1.11 absent from DOM and network) |
| P8 | Another org | Link org → `share_org`; org-bound policies | attack `share_rls_org_setting_scoping`, `share_cross_org_never_returned` |
| P9 | Lead data or other clients | No grant on companies, contacts, deals, orders, holds, profiles; signature snapshot | attack `share_reader_no_lead_columns` |
| P10 | Request spam or flood | Zod, size caps, honeypot, time trap, Origin, database caps, ≤ 10 open, one open task per lead | attack `share_request_rate_limits`, `share_request_payload_limits`, `share_request_idempotent`, `share_request_parallel_one_task`; e2e `share_public_honeypot_silently_dropped`, `share_public_fast_submit_fake_success`, `share_public_cross_origin_post_refused`, `request_body_413` |
| P11 | Denial of service or free-tier exhaustion | Read-only refusals; no write for unknown tokens; 2,000-item cap after the filter; "unchanged" polls; kill switch | attack `share_view_over_limit_writes_nothing`, `share_unknown_token_writes_nothing`; perf I10 |
| P12 | XSS through names or request text | React text only; safe-text CHECKs and pre-checks; share CSP with `default-src 'none'` | attack `product_name_unsafe_refused`, `share_request_bidi_refused`; e2e `share_public_xss_name_is_text`, `request_xss_rendered_as_text` |
| P13 | Clickjacking, indexing, caching | `frame-ancestors 'none'`; `X-Robots-Tag` and meta; robots reachable; `no-store` | e2e `share_public_headers`, `robots_txt_public_disallow_all` |
| P14 | Session confusion (a teammate opens a link) | The proxy returns before any session code; anon client without cookies; functions not granted to `authenticated` | e2e `share_public_signed_in_teammate_still_anon` (no `Set-Cookie`); attack `share_view_not_granted_to_authenticated` |
| P15 | Page bundle or HTML exposes Supabase or internal strings | ESLint restricted imports; share message subset | e2e `share_public_bundle_has_no_supabase`, `share_html_has_no_internal_strings`; unit `share_messages_subset_exact` |
| P16 | Surface-header spoofing | The proxy deletes incoming copies on every path | unit `surface_header_ignored_outside_share`; e2e `spoofed_surface_header_ignored` |
| S1 | Direct stock writes | Zero write grants on `stock_levels`; ledger, holds and sales in `private`; immutable ledger | attack `stock_levels_direct_write_denied`, `ledger_tables_direct_write_denied`, `stock_movements_immutable` (also as postgres); e2e `ledger_not_served_by_rest` (404; `Accept-Profile: private` → 406) |
| S2 | Over-selling or over-holding the last cartons | Locks plus checks under the lock; CHECK backstops | concurrency `last_cartons_two_sellers`, `twenty_sellers_one_product`, `two_holds_last_stock`, `sale_vs_hold` |
| S3 | Deadlocks | One global lock order | concurrency `crossed_lines_no_deadlock`, `transfer_vs_sell_no_deadlock`, `import_chunk_vs_sales_no_deadlock` |
| S4 | Wrong order of events (ids taken before the lock) | `version`, `crm_moved`, `last_onhand_batch_id` set under the lock | concurrency `import_commit_vs_waiting_sale_order`; attack `versions_match_snapshots` |
| S5 | Stolen session adjusts stock | `aal2` everywhere; fresh code per D20 | attack `aal1_every_stock_rpc_denied`, `adjust_stale_code_step_up`, `receive_stale_code_step_up`, `archive_stale_code`, `cancel_after_window_needs_fresh_code` |
| S6 | Rep overreach | Role and lead-editor checks in the guard and RLS; below-min refused | attack `rep_stock_permissions`, `record_sale_rep_below_min_refused`, `rep_cost_null` |
| S7 | Movement without a document | Per-kind document checks; unique ship and return per line | attack `ship_without_order_line_refused`, `ship_other_users_line_refused`, `ship_quantity_mismatch_refused`, `return_once`, `transfer_in_without_out_refused` |
| S8 | Archive racing a receipt | Product `FOR SHARE` versus archive's row lock; re-checked under the lock | concurrency `archive_vs_receive_race` |
| S9 | Replay or double click | `movement_requests` per author | attack `idempotent_request_id`, `record_sale_idempotent` |
| S10 | Mass assignment | Column grants; guards set server fields; `strictObject` | attack `movement_server_fields_not_writable`, `order_total_not_client_set`, `share_link_counters_not_writable`; unit `*_schema_rejects_extra_keys` |
| S11 | SQL or filter injection | Static SQL; values as parameters or jsonb; no PostgREST filter strings | e2e product named `'); drop table products; --` stored verbatim |
| S12 | Untrusted caller in the guard's trusted branch | Trusted means `current_user = 'postgres'` only | attack `trusted_branch_only_postgres` (authenticated `expire` → 42501) |
| T1 | Automation task refused in a rep's session | Claims cleared for the one insert | attack `rep_sale_crossing_reorder_point_succeeds`, `system_task_restores_claims`, `system_task_error_rolls_back_claims` |
| T2 | Task flood | One open task per subject; constant titles | attack `low_stock_task_once_per_product`, `request_task_once_per_lead`, `system_task_title_constant` |
| I1 | Bad or crafted sheet | Day 3b protections; 5,000-row cap; numeric bounds; constant errors | attack `stock_stage_bad_values_constant_error`; unit `stock-normalise.spec` |
| I2 | Stale quantities overwrite sales | Targets under the lock; `crm_moved` re-read under the lock; kept by default | concurrency `import_commit_vs_sale_target_respected`; attack `stock_import_moved_in_crm_kept` |
| I3 | Undo destroys later work | Per-product reversible rule; archive, never delete; fields restored only if unchanged | attack `stock_import_rollback_*` |
| I4 | Day 3b guard regression; lead RPCs on stock batches | Stock branch, marker, structural rules | attack `lead_import_tests_unchanged` (`import_attack.sql` passes unchanged), `lead_rpcs_refuse_stock_batch` |
| A1 | Silent edits | Append-only ledger with who, why, reference; minimal audit row per row (F2) | attack `movement_audit_minimal` |
| A2 | Personal data or secrets in logs or audit | Constant errors; no IP stored; request text masked; no console | attack `stock_request_note_masked_in_audit`, `stock_errors_constant`; e2e `error_copy_has_no_sql` |
| A3 | Lead delete orphans stock or sales | FK restrict from holds and orders; untouched rule; FK coverage | attack `lead_delete_blocked_by_stock_history`, `lead_import_untouched_counts_stock`, `import_fk_coverage` |

**Definer code and accepted advisor findings:**
- The apply trigger and private helpers are not in an exposed schema, so no WARN is expected.
- `public.share_view` and `public.share_request` will raise splinter's `anon_security_definer_function_executable` WARN. It is accepted with this section as the reason, as `set_user_role` was.
- `private.share_rate` has policies only for `share_reader`, which is the intended deny for everyone else.

---

## 10 UX (DESIGN.md is the source of truth; Taste Skill dials 3 / 5 / 7)

General rules:
- Outfit for text; **DM Mono, right-aligned, for every quantity, price, reference and date in tables**.
- One Signal Red primary per screen, with black text: Inventory **Record sale**; the import step primary; client page **Send request**. On the lead page, Call stays the red one.
- Status is always a dot plus a word: In stock (green), Low (amber), Sold out (red), Arriving (neutral), Held (neutral), Hidden from clients (eye-off icon plus words).
- 8 pt grid; radius 20 / 12 / 24 (sheets); skeletons only, never a spinner; springs from `src/lib/motion.ts`, transform and opacity only.
- Quantities change **without** animation: numbers are data.

### 10.1 Inventory page (`/inventory`; 6b, extended in 6d and 6e)

- `loading.tsx` matches the header, KPI row, tab strip and 12 table rows.
- **Header:** "Inventory" (FR "Stock"). On the right: Import (admins, neutral), New product (managers and admins; overflow menu below 1024), Share (6e, neutral, opens a lead picker), and **Record sale** (red, 6d).
- **KPI row** (4 tiles, as in the prototype): In warehouse (pcs) · In transit (pcs) · Held for clients (pcs) · Low (count). DM Mono, count-up spring on first visit only, instant with reduced motion.
- **Tabs:** hand-built WAI-ARIA tabs (`src/components/ui/tabs.tsx`, Day 4b) in `?tab=`, prefetched on hover: **Stock · Arriving · Reserved · Movements · Sales · Requests (badge)**.

| Tab | Contents |
|---|---|
| **Stock** | Filter chips: All · In Warehouse · In Transit · Low · Sold out · Held · Hidden from clients · Archived (admins); search (`/`, debounced 150 ms); category; **pcs / ctn** toggle (localStorage, try/catch). Virtualised table (TanStack Table and Virtual, server keyset pages of 100). Columns: Product (name, P-ref and category muted) · Price/pc (min–max) · Pcs/ctn · In warehouse (available, with "on hand / held" on hover, and the prototype's availability bar against 3 × the reorder point) · In transit (pieces and ETA week) · Cost/pc (managers and admins) · Status |
| **Arriving** | Products with transit stock: pieces and cartons, ETA (inline date picker, managers and admins; clients see the week), holds on arriving goods per row, **Arrived** (all or part); checkboxes plus "Mark selected arrived" |
| **Reserved** | Active holds: product, lead (link), deal chip (if visible), pieces, place, until, by whom; Release, Extend, Sell held. Ended-but-not-swept holds are flagged |
| **Movements** | Keyset log: when (relative, absolute on hover), who, what ("Sold", "Sale undone", "Correction +12", "Held", "Hold released", "Hold ended", "Arrived" with the transfer pair as one line, "Stock sheet"), product, place, ± pieces (signed, DM Mono), left after, reference (sale, lead, import file, reason). Filters: kind, product, person, dates. "Show older" |
| **Sales** (6d) | Number · date · lead · type badge (Warehouse inventory / Supplier Stock) · "3 products · 1 200 pcs" · total (Intl EUR) · by · deal chip · status (Cancelled struck through). Filters: type, person, dates, lead. Detail: lines, price per piece, below-minimum flags, Undo (2 min) or Cancel (step-up) |
| **Requests** (6d; link source from 6e) | New / In progress / Done. Row: lead · "3 items · 'also need jute bags…'" (text only, `dir="auto"`) · source (Link / Team) · time · task assignee. Detail: lines with **live availability now**, then the actions in 6.8 |

**Product panel** (split view at ≥ 1024, 420 px; full page `/inventory/p/[id]` on phones):
- name, category, status;
- a number grid: warehouse available / on hand / held; transit and ETA; pieces per carton; cartons per pallet ("≈ 2.1 pallets"); price range; cost (managers and admins); reorder point;
- actions: Record sale (`S`), Hold (`R`), Arrived (`A`, when transit > 0), Correct stock (step-up; reason required), Receive (step-up), Edit (`E`), Hide from clients, Archive (step-up; only when empty);
- sections: Held, Recent movements (10), Requests mentioning it, Sales.

**Responsive:**

| | 1440 / 1728 | 1280 | 1024 | 768 | 390 |
|---|---|---|---|---|---|
| Stock | table plus 420 px panel | table plus 380 px panel | table; panel as an overlay sheet | fewer columns ("Available · transit" folded) | cards: name, **available** large in DM Mono, price range, badges; tap → full page with sticky actions above the dock; tabs as a snap strip |
| Dialogs and sheets | right sheet | right sheet | right sheet | bottom sheet | full-height bottom sheet; total and button above the safe area |

**States** (every list):
- skeleton rows at final height;
- empty: "No stock yet. Import your stock sheet or add a product." (Import primary for admins); "Nothing in transit"; "No holds"; "No sales yet"; "No requests yet. Share your stock with a client to get some.";
- no-match: "No products match. Clear filters";
- error: card with Retry;
- offline: writes disabled with the reason.

**Optimistic updates with Undo:** hold and release (Undo releases or re-holds); sales get the 2-minute Undo toast.

### 10.2 Record-sale sheet (6d)

**Opens from:** Inventory, the lead's Stock tab, a request, a hold ("Sell held"), a product row (`S`), or Cmd+K "Record sale…". Preloaded on hover or focus, so it opens in < 100 ms.

**Fields:**
1. **Lead:** combobox over `list_leads` search; prefilled from a lead.
2. **Type:** segmented **Warehouse inventory** (default) | **Supplier Stock**. Follows the linked deal's fulfilment.
3. **Lines:**
   - product combobox: "4 200 pcs available · 87 ctn · €2.50 max", including "incl. 300 held for this lead". Sold-out products are dimmed and still selectable for Supplier Stock;
   - quantity in **pcs** (default) with a ctn toggle and live "= 3 ctn + 12 pcs";
   - **price per piece** prefilled with the max price, with "min 2.10 · max 2.50" under it. Below the minimum shows an amber line "Below your minimum price"; managers and admins confirm, reps see it disabled with the reason;
   - line total;
   - "+ Add product" (⌘+Enter on the last line adds one).
4. **Deal:** shown only when `list_lead_deals_for_stock` returns deals; preselected when the lead holds stock for one.
5. **Ship-to country** (Supplier Stock) and an optional note.

**Footer:** **Total** (DM Mono, Intl EUR) and **Record sale** (⌘↩). Disabled with a reason while invalid ("Choose a product", "Only 2 ctn available").

**Fastest path** from a lead: `S`, type a few letters, Enter, the quantity, ⌘↩. E2e `record_sale_five_keys` counts the key presses beyond the search letters.

**Feedback:** press state within 100 ms; "Recording…" while saving; a toast with Undo (120 s); failures keep the sheet and say why; network errors retry with the same `request_id`.

On the lead's Stock tab this button is the **neutral** primary (D36).

### 10.3 Hold sheet and Arrived dialog

- **Hold:**
  - lead, product, place (Warehouse / In transit, the latter when arriving stock is available), pieces or cartons;
  - **Until** chips: 7 days, 14 days (default), 30 days, Pick a date (≤ 90 days);
  - deal; note;
  - button "Hold 480 pcs".
- **Arrived:** "All 1 200 pcs arrived" (default) or "Only part arrived: [ ] pcs / ctn", with a list of the holds that move ("Maison Verdane 480 pcs moves to the warehouse").

### 10.4 Lead Stock tab (`/leads/[id]?tab=stock`; 6d fills the Day 4b placeholder, 6e adds the link card)

**Order of sections:**
1. **Client link** card (6e).
2. **Actions row:** Record sale (neutral primary) · Hold stock · Log a request.
3. **Wants:** open requests first. Each line has live availability: "Asked 480 pcs · 4 200 available now", "· arriving week of 13 Oct", or "· not in stock: ask the supplier", with Record sale / Hold / Decline.
4. **Reserved:** product, pieces, place, until, deal chip; Release / Sell / Extend; ended holds flagged.
5. **Bought:** sales newest first (date, items, total, type badge, by), plus "€12 480 over 7 sales"; "Show all" opens the Sales tab filtered to this lead.

**Also:**
- `?deal=<id>` preselects a deal (the Day 5 hook).
- States: a block-for-block skeleton; an empty line per section ("No requests from this client yet. Share your stock to get some.").
- A lead the user cannot change hides the actions: "Only {owner} or an admin can sell to this lead."

**Client link card (6e):**
- No link: **Share on WhatsApp** (neutral) and Copy link; language EN | FR (default FR for leads in FR, BE, LU, MC); expiry 30 / **90** / 365 days; label; "Show arriving stock"; "Allow requests". Creating asks for a code once.
- With links: "Made by Henri · 11 Oct · Opened today 09:22 · 3 opens · 1 request · valid until 9 Jan · [Revoke] [Replace]". The token hint is shown as "…a9Xz".
- **Send stock list as text:** a WhatsApp-friendly list from `share_preview()` (the same whitelist): up to 30 in-stock items ("• T-shirt coton 180 g: 2,50 €/pc · 4 200 pcs"), cut to 3,500 characters, ending with the link when one was just made. Copy, or open WhatsApp.
- **Message template** (EN and FR): "Hello, here is our live stock with prices per piece: {link}. Tap an item to ask for it. {firstName}, TopStock Wholesale".

### 10.5 Client page (`/s/fr`, `/s/en`; 6e; designed at 390 first, then 360, 768, 1280)

**At 390:**
- **Header** (not sticky): the TopStock lockup (184 px, Signal Red mark); "Stock available now" / "Stock disponible"; DM Mono "Updated 14:05" in the client's local time; EN | FR control (44 px). Switching navigates to `/s/en` keeping the `#`; the choice is remembered in localStorage (try/catch).
- Search ("Search products") and category chips when there are 2 or more categories. Filtering is client-side only.
- **Sections:** "In our warehouse in France · 24" / "Dans notre entrepôt en France · 24", then "Arriving · 6" / "Arrive bientôt · 6".
- **Item row** (64 px minimum):
  - name (Outfit, wraps to 2 lines), P-ref muted;
  - on the right, **€2.50** / "2,50 €" in DM Mono with "per piece" muted ("Price on request" when null);
  - second line: "1 200 pcs · 25 cartons of 48";
  - badge "Only 3 cartons left" (amber dot and words), or "Arriving week of 13 Oct" (neutral).
- **Tap a row:** a bottom sheet (spring; instant with reduced motion) with the name, price and availability; quantity with **pcs | ctn** (pcs default; the stepper steps by one carton in ctn mode), `inputMode="numeric"`, and live "= 2 cartons"; **Add to request**. Asking for more than is available is allowed: "We have 1 200 pcs. We'll check the supplier for the rest."
- **Sticky bottom bar** (safe-area aware) once something is added: "Your request · 3 items · Review".
- **Review sheet:** lines (edit, remove); "Looking for something else? Tell us" (1,000 characters, counter from 900); "Your name (optional)"; the honeypot `website` field (visually hidden, `aria-hidden`, `tabindex=-1`, `autocomplete=off`); **Send request** (Signal Red, black text: the only accent besides the logo mark).
- **After sending:** "Thank you. Henri will get back to you soon." / "Merci. Henri vous répond rapidement.", plus "Send another request".
- **Footer** (muted, 13 px): "Prices per piece in EUR, excl. VAT (open question 6). Stock changes during the day; a request is not an order. Please don't forward this page." and "TopStock sees when this link is opened and what you ask for."

**At ≥ 768:** a centred 720 px column. From 768, rows show name | price | availability in three columns; at 1280 the review sheet becomes a right-hand panel. No dock, no app chrome.

**States** (never a spinner):

| State | What shows |
|---|---|
| Loading | header, search and 8 skeleton rows at final heights |
| Empty | "Nothing in stock right now. Tell us what you need." The form stays, free text only |
| Inactive (every non-working case) | one message: "This link isn't active. Ask your TopStock contact for a new one." |
| Slow down (429) | "Too many refreshes. Wait a minute." |
| Requests closed | the Request button is hidden; "Contact your TopStock contact to order" |
| Too many open requests | "We already have your earlier requests. We'll reply soon." |
| Error | "We couldn't load the stock. [Try again]" |
| Offline | "You're offline." Retries on `online` |
| No JavaScript | `<noscript>` "Turn on JavaScript to see our live stock." |

**Brand and accessibility:**
- Chalk page, white cards, dark mode from `prefers-color-scheme`.
- Prices have screen-reader text ("2 euros 50 per piece"). Every badge has a word. Focus moves into each sheet and back to its opener; Esc closes.
- The basket count sits in `aria-live="polite"`. 44 px targets, AA contrast, `lang` follows the language.
- Entrances on first load only; reduced motion respected; no horizontal scroll at 360.
- `LazyMotion` with `domAnimation` keeps the JavaScript budget.

### 10.6 Settings and "What clients see"

- **`/inventory/settings`** (admins; `loading.tsx`):
  - warehouse name;
  - Restock task assignee (or nobody);
  - default hold days;
  - (6e) **Sharing** switch (switching on asks for a code; "Sharing is off" banner while off);
  - all active links across leads, sortable by last opened, with Revoke.
- **`/inventory/client-view`** (6e; everyone on the team): the same `ShareView` component fed by `share_preview()`, with the banner "This is what your clients see". It builds trust and doubles as a visual test of the whitelist.

### 10.7 Keyboard, motion and i18n

- **Keyboard:** `G then I` (exists). On Inventory: `/` search, `J/K` rows, `Enter` panel, `Esc` close, `S` sale, `R` hold, `A` arrived, `E` edit. Cmd+K gains "Record sale…", "Hold stock…", "Share stock with…", "Import stock sheet" (admins), "What clients see". Single-letter keys stay quiet while typing; all appear in the `?` dialog.
- **Motion:** sheets rise with the `sheet` spring from where they open; the tab pill uses `layoutId`; rows enter with a 30 ms stagger on first visit only.
- **i18n namespaces:** `Inventory`, `Products`, `Movements`, `Holds`, `Sales`, `StockImport`, `StockRequests`, `LeadStock`, `ShareLinks`, `InventorySettings`, `Units`, and `Share` (public, minimal).
- **French terms:** Stock · En entrepôt · En transit · Arrive bientôt · Réservé · Disponible · Épuisé · Mouvements · Ventes · Demandes · Stock entrepôt (Warehouse inventory) · Stock fournisseur (Supplier Stock) · Enregistrer une vente · Réserver · Arrivé · Corriger le stock · Prix par pièce · pcs / ctn · HT · Lien client.
- **Formatting:** `Intl.NumberFormat(locale, {style: 'currency', currency: 'EUR', minimumFractionDigits: 2, maximumFractionDigits: 4})` per piece, 2 decimals for totals. Pieces with narrow-NBSP thousands in French. French typography (non-breaking space before `:` `?`, "le 1er"). Label widths are never fixed. `messages.spec.ts` checks EN and FR key parity.

---

## 11 Tests and evidence

### 11.1 Database attack tests

These run in `scripts/db-test.sh` and the CI `db` job. Each file redefines `pg_temp.as_user(sub, aal, totp_age_s)` and `pg_temp.as_anon()`, reuses the fixtures `a` (admin), `a1` (manager), `b1` (rep) and `c1` (other-org admin), and ends with `ledger_sums_match_levels`.

**`supabase/tests/stock_attack.sql` (6a):**
- **Access:** `stock_levels_direct_write_denied` (insert, update, delete as admin aal2 and as rep → 42501); `ledger_tables_direct_write_denied`; `stock_movements_immutable` (also as postgres, TRUNCATE included); `stock_core_not_exposed`; `aal1_every_stock_rpc_denied`; `anon_no_execute_on_stock_rpcs`; `trusted_branch_only_postgres`.
- **Validation:** `post_movement_validation` (qty 0, −1, 50,000,001, unknown kind, missing reason, `other` without a note, wrong place for a kind, archived product); `movement_server_fields_not_writable`; `check_constraints_never_fire` (every bad value gets the constant pre-check message).
- **Rules:** `no_negative_stock`, `no_over_reservation`, `cannot_sell_reserved_stock`, `count_sets_exact_quantity`, `count_unchanged_writes_nothing`, `count_below_held_refused`, `adjust_below_reserved_refused`, `cas_stale_refused`.
- **Transfers:** `transfer_conserves_total`; `transfer_moves_holds_oldest_first_and_splits` (holds 400 + 400 at transit; receive 700 → first moved whole, second split 300 to the warehouse and 100 staying, `split_from` set, creator kept); `transfer_more_than_in_transit_refused`; `transfer_in_without_out_refused`.
- **Permissions:** `adjust_stale_code_step_up` (660 s → `step_up`; fresh passes); `receive_stale_code_step_up`; `rep_cannot_adjust_or_receive_or_transfer`; `archive_stale_code`; `archive_needs_zero_stock`; `archived_product_refuses_new_stock`.
- **Holds and deals:** `reserve_requires_editable_lead`, `reserve_deal_other_lead_refused`, `reserve_deal_null_company_refused`, `reserve_closed_or_direct_deal_refused`, `reserve_transit_allowed`, `release_rules` (creator, lead editor, unrelated rep refused), `deal_lost_releases_holds`, `deal_delete_releases_holds`, `expired_hold_released_before_write`, `sweep_throttled_once_a_minute`, `expire_rows_have_no_user`.
- **Other:** `idempotent_request_id`, `stock_rate_guard_121st_refused`, `rep_cost_null`, `product_insert_server_fields`, `product_name_unsafe_refused`, `name_taken_constant_error`, `other_org_product_not_found` (P0002 for c1 on every RPC), `movement_audit_minimal`, `versions_match_snapshots`, `product_name_key_cases` (shared table with `stock-key-parity.spec.ts`), `lead_import_untouched_counts_stock` (holds), `import_fk_coverage` (updated).
- **`integrity_after_random_ops`:** 1,000 random valid and invalid operations across 5 products, 3 leads and 2 deals, with exceptions caught. Then `check_stock_integrity()` returns 0 rows and a ledger replay equals the levels.

**`supabase/tests/stock_import_attack.sql` (6c)** mirrors `import_attack.sql`:
- the role matrix (aal1, stale code, rep, manager, other org, other admin's batch), status skips, counters not writable, staging not exposed, payload limits, constant errors, purge on every closing move, re-stage idempotent, double commit, `stock_row_count_5001_refused`, `stock_open_batches_cap_per_kind`;
- `stock_import_fixture_outcomes` (one assertion per fixture row);
- `same_name_two_places_one_product`, `repeated_row_rejected`, `carton_conflict_rejects_group`, `prices_differ_warns`, `sold_out_zero_ok`, `cost_weighted`, `absent_status_means_zero_for_listed_product`, `transit_to_warehouse_is_transfer`, `not_in_sheet_untouched`, `archived_product_restored`;
- `moved_in_crm_kept`, `moved_in_crm_applied_with_use_sheet`, `below_reserved_skipped`, `reimport_same_file_changes_nothing`, `added_meanwhile_skipped`;
- `rollback_reverses_untouched_products`, `rollback_keeps_moved_products`, `rollback_keeps_held_products`, `rollback_archives_untouched_new_products`, `rollback_restores_prices_unless_edited`, `rollback_twice_noop`;
- `lead_rpcs_refuse_stock_batch` (validate, commit and rollback of the lead flow on a stock batch with zero pending rows → `bad_transition`, staging untouched), `stock_rpcs_refuse_lead_batch`, `stock_and_lead_import_can_run_together`, `stock_import_second_writer_busy`, `stock_import_product_column_gated`, `stock_import_audit_minimal`, `lock_helper_refuses_non_uploader_and_stale_code`;
- `lead_import_tests_unchanged` (the runner runs `import_attack.sql` after this migration).

**`supabase/tests/sales_attack.sql` (6d):**
- `record_sale_moves_stock`, `record_sale_uses_deal_hold_then_lead_hold`, `record_sale_partial_hold_use`, `record_sale_never_sells_other_clients_holds`, `record_sale_insufficient_rolls_back_order`;
- `record_sale_rep_on_other_lead_refused`, `record_sale_below_min_needs_flag_and_manager`, `record_sale_rep_below_min_refused`, `record_sale_duplicate_product_line_refused`, `record_sale_51_lines_refused`, `record_sale_bad_values_constant_error`, `record_sale_idempotent`;
- `supplier_sale_no_movement`, `sale_deal_optional_without_day5`, `sale_deal_other_lead_refused`;
- `undo_sale_window_no_code`, `undo_sale_restores_consumed_hold`, `undo_sale_restores_lead_status`, `cancel_sale_after_window_needs_fresh_code`, `cancel_sale_does_not_recreate_holds`, `cancel_twice_noop`, `return_once`;
- `orders_direct_write_denied` (private: not served), `order_lines_never_updated`, `order_line_costs_hidden_from_rep`, `order_total_not_client_set`;
- `first_sale_sets_customer` (not from `do_not_contact` or `disqualified`);
- `rep_sale_crossing_reorder_point_succeeds` (rep b1; the task exists, `created_by` null, assignee = the alert assignee), `system_task_restores_claims`, `system_task_error_rolls_back_claims`, `low_stock_task_once_per_product`, `low_stock_not_from_import`, `arrived_creates_task_per_moved_hold`, `system_task_title_constant`;
- `lead_delete_with_request_task` (`task_guard` depth exception), `lead_delete_blocked_by_stock_history`, `lead_import_untouched_counts_stock` (orders, requests), `import_fk_coverage`;
- `team_request_validation`, `stock_request_note_masked_in_audit`, `stock_alerts_counts`, `audit_lists_union`.

**`supabase/tests/share_attack.sql` (6e):**
- `share_view_valid_link_ok` (first, so the lookup-order bug cannot hide), `share_functions_volatile`;
- `anon_executable_functions_exact` (`pg_proc` with `has_function_privilege('anon', …)` over the exposed schema = the two functions), `anon_cannot_select_any_table`;
- `share_reader_column_privileges`, `share_reader_cannot_read_cost`, `share_reader_no_lead_columns`, `share_rls_org_setting_scoping` (no setting → 0 rows; another org's setting does not show this org), `share_cross_org_never_returned`;
- `share_view_inactive_cases_same_answer` (malformed, unknown, revoked, expired, sharing off, lead deleted), `share_view_rejects_hash_as_token`, `share_view_payload_keys_exact`, `share_items_signature_exact` (`pg_get_function_result`), `share_preview_equals_view_items`;
- `share_view_hides_sold_out_hidden_archived_fully_held`, `share_view_transit_respects_link_setting`, `share_view_past_eta_hidden`, `share_view_eta_is_week_start`, `share_view_2000_items_not_truncated`, `share_view_unchanged_version`;
- `share_view_rate_limited`, `share_view_over_limit_writes_nothing`, `share_unknown_token_writes_nothing`, `share_view_writes_no_audit_rows`, `share_view_not_granted_to_authenticated`, `share_last_opened_throttled`;
- `share_request_creates_request_and_one_task`, `share_request_task_assignee_fallback`, `share_request_rejects_foreign_or_hidden_product`, `share_request_payload_limits` (21 lines, 1,001-character note, bidi and controls, extra keys, 16 KB, numbers out of range), `share_request_rate_limits` (6th an hour, 21st a day, 201st an org-day), `share_request_too_many_open`, `share_request_idempotent`, `share_request_closed_link`, `share_request_bidi_refused`;
- `token_hash_not_readable_by_authenticated`, `token_hash_not_in_audit`, `share_link_client_token_hash_ignored`, `share_token_format`, `share_link_counters_not_writable`;
- `create_link_needs_editor_and_fresh_code`, `revoke_is_permanent`, `expiry_bounds_and_extension_needs_code`, `max_links_per_lead`, `replace_revokes_old`, `kill_switch_disables_all`, `enable_sharing_needs_admin_fresh_code`;
- (S1 fallback only) `share_body_lint`.

**Changed:** `import_attack.sql` (FK coverage array; `import_rollback_keeps_worked_on` adds a lead with a hold, a sale, a request and a link) and `rls_attack.sql` (§1 becomes the allowlist).

### 11.2 Concurrency (`supabase/tests/stock_concurrency.sh`, the `import_concurrency.sh` pattern)

Two to twenty psql sessions. A holder runs `begin; …; select pg_sleep(2); commit;` and the second session starts 0.5 s later. Every scenario ends with the integrity checks.

| Test | PR | Setup | Must be |
|---|---|---|---|
| `two_holds_last_stock` | 6a | available 96; A and B each hold 96 | exactly one active hold; the other `over_reservation` |
| `reserve_vs_adjust_down` | 6a | on hand 96; A removes 96 while B holds 48 | exactly one succeeds |
| `transfer_vs_reserve` | 6a | transit 100 with 60 held; Arrived 100 while B holds 50 at transit | the hold fails after the transfer, or the transfer moves 110 held pieces correctly; I3 holds |
| `archive_vs_receive_race` | 6a | A receives 10 and sleeps; B archives | B is refused `has_stock`; or B archives first and A is refused `product_archived` |
| `lock_timeout_busy` | 6a | A holds the level 5 s | B gets 55P03 after 3 s |
| `transfer_vs_sell_no_deadlock` | 6a/6d | 50 rounds of Arrived racing sales on one product | no 40P01 in the server log |
| `last_cartons_two_sellers` | 6d | warehouse 96; A sells 96, B sells 96 | 1 order, 1 `ship`, on hand 0; B `insufficient_stock` and B's order row does not exist |
| `two_sellers_both_fit` | 6d | 96; A sells 48, B sells 48, then C sells 1 | A and B succeed; C fails |
| `twenty_sellers_one_product` | 6d | 240 pieces; `seq 20 \| xargs -P 20`, each selling 24 | exactly 10 orders; 10 refused; on hand 0 |
| `sale_vs_hold` | 6d | available 96; A holds 96 for lead 1 while B sells 96 to lead 2 | exactly one succeeds |
| `crossed_lines_no_deadlock` | 6d | sales (P1, P2) and (P2, P1), 50 times | all succeed; no 40P01 |
| `expiry_vs_sale` | 6d | an ended hold; the sweep and a sale race | exactly one path uses or ends it; I3 holds |
| `import_commit_vs_sale_target_respected` | 6c | Check sees P at 100; A sells 30 and holds the transaction; commit chunk runs | `keep_crm`: P kept, on hand 70; `use_sheet`: on hand 100 (+30 import row) |
| `import_commit_vs_waiting_sale_order` | 6c | the chunk holds P; a sale waits and gets a smaller ledger id | after both commit, `crm_moved = true` and `last_onhand_batch_id` null; undo keeps P |
| `import_chunk_vs_sales_no_deadlock` | 6c | a 250-product chunk while 3 sessions sell random products | no 40P01; integrity 0 rows |
| `share_request_parallel_one_task` | 6e | 5 parallel requests on one link | 5 requests (or the cap), 1 open task |

### 11.3 Mutations (each must fail at least one check; `docs/evidence/day6x/mutations.md`)

- **6a:**
  1. remove `for update` on levels;
  2. remove the `reserved > on_hand` check and its CHECK;
  3. `grant update on stock_levels to authenticated`;
  4. drop `stock_movement_immutable`;
  5. remove the step-up for adjust;
  6. remove the lead-editor check for reserve;
  7. drop the `deal.company_id` check;
  8. lock levels in a different order;
  9. transfer moves unheld stock first;
  10. skip `expire_due_holds` in the RPCs;
  11. make the guard trust any `current_user`;
  12. remove the product `for share` lock (`archive_vs_receive_race`);
  13. set `crm_moved` from the ledger id instead of under the lock;
  14. `count` delta computed in the RPC;
  15. rate guard limit 10,000;
  16. drop the audit branch for the ledger.
- **6c:**
  17. the commit applies a stored delta instead of the target;
  18. no `crm_moved` re-read at commit;
  19. absent status left untouched instead of 0;
  20. undo ignores `last_onhand_batch_id`;
  21. undo deletes new products;
  22. the guard purge skips stock staging;
  23. remove the stock marker check;
  24. one-writer index back to per org;
  25. the lock helper skips the uploader check;
  26. REVENTE mismatch rejects instead of warning.
- **6d:**
  27. `ship` ignores other clients' holds;
  28. below-min allowed for reps;
  29. deal-lost trigger dropped;
  30. `lead_import_untouched` misses orders;
  31. low-stock task fires on import;
  32. claims not cleared in `insert_system_task`;
  33. claims not restored;
  34. drop the unique ship index;
  35. Undo allowed after 120 s without a code;
  36. `task_guard` without the new FK columns.
- **6e:**
  37. `grant select (price_min) on products to share_reader`;
  38. `share_items` selects `price_min`;
  39. compare a plain token instead of the hash;
  40. remove the revoked, expiry or switch check (one run each);
  41. remove `share_take`;
  42. `share_take` writes before checking;
  43. remove the in-stock filter;
  44. `limit` before the filter;
  45. `grant execute … to authenticated`;
  46. function made STABLE;
  47. the guard trusts a client `token_hash`;
  48. the proxy share branch reads the session;
  49. the proxy keeps the Supabase origin in the share CSP;
  50. the route drops the output schema;
  51. the honeypot calls the database;
  52. the proxy forgets to delete incoming surface headers.

### 11.4 Unit tests (`npm run test:unit`)

| Spec | Covers |
|---|---|
| `stock-headers.spec.ts` | `stock_headers_haider_exact` (accents on and off, parentheses on and off), `stock_headers_parenthesis_only`, English headers, shuffled order, "qty par carton" never taken as quantity, "prix par pcs max" against "prix par pcs", `pp` exact only, `Row`/`Problem` ignored |
| `stock-numbers.spec.ts` | `12,50`, `12,50 €`, `€12.50`, `1 234,56` with NBSP, NNBSP and thin space, `1.234,56`, `1,234.56`, `1'234.56`, `-3`, `3,6E+03`, `#VALEUR!`, `#N/A`, blank, auto-detection per file |
| `stock-values.spec.ts` | every STATUS alias in EN and FR; blank default; unknown must be chosen |
| `stock-normalise.spec.ts` | every problem and warning code; REVENTE tolerance edges (0.49 €, 0.51 €, 0.5 %); swapped-columns banner; PP ÷ QUANTITÉ |
| `stock-schema.spec.ts` | strict keys; 1,001 rows; decimals as strings; chunk size ≤ 750 KB with multibyte names |
| `stock-sample.spec.ts` | every row of `stock-40-fake.csv` gives its `expected.json` label |
| `stock-parity.spec.ts`, `stock-key-parity.spec.ts` | code lists, tolerances, caps and statuses equal the SQL; the `product_name_key` table equals the TS `productKey` |
| `units.spec.ts` | `toPieces(3, 'carton', 48)`; `formatPacks(1210, 24)` → "50 ctn + 10 pcs" in EN and FR; pallet estimate; pairs |
| `money.spec.ts` | Intl EUR in `fr-FR` and `en`, 2–4 decimals per piece, totals at 2 |
| `share-schema.spec.ts` | request Zod (21 lines, 1,001-character note, bidi, extra keys); `share_output_schema_strips_cost` |
| `share-map.spec.ts` | `mapShareItems` gives exactly the public keys; wrong array length rejected |
| `share-token.spec.ts` | `tss_` regex; reading `location.hash` (with or without `#`, extra text refused); SQL `sha256(convert_to())` equals Node's hash |
| `share-rate-limit.spec.ts` | window, cap, LRU eviction, daily salt rotation |
| `share-messages.spec.ts` | `share_messages_subset_exact`; `surface_header_ignored_outside_share` |
| `whatsapp-text.spec.ts` | the stock list text: 30 items, 3,500-character cut, FR typography, `wa.me` encoding |
| `inventory-status.spec.ts` | In stock, Low, Sold out, Arriving |
| `messages.spec.ts` (existing) | new namespaces have identical EN and FR keys |

### 11.5 End-to-end (CI `auth-journey` on the real local Supabase, Chromium and WebKit; WebKit `testMatch` gains `inventory|stock-import|sales|lead-stock|share`)

- **`tests/auth/inventory.spec.ts` (6b):** `stock_table_filters_and_panel`, `new_product_with_opening_stock_step_up`, `adjust_with_step_up_dialog` (code aged with `ageStepUp`), `count_sets_quantity`, `arrived_partial`, `movements_log_keyset`, `rep_sees_no_cost_column`, `inventory_empty_and_error_states`, `inventory_390_no_horizontal_scroll`, `inventory_keyboard_only`, `inventory_get_routes_read_only`.
- **`tests/auth/stock-import.spec.ts` and `stock-import-security.spec.ts` (6c):**
  - `import_stock_40_zero_click_match` (French numbers detected, statuses mapped, tiles equal `expected.json`, REVENTE warnings listed);
  - `stock_problems_file_formula_guarded`, `reimport_keeps_crm_moved_quantities`, `reimport_use_sheet_option`, `reimport_transit_arrived_as_transfer`, `stock_undo_preview_and_run`, `stock_undo_keeps_sold`;
  - `cp1252_variant`, `parens_only_headers`, `stock_import_en_file`, `stock_import_rep_404`, `stock_staging_not_exposed` (REST 404/406), `stock_step_up_dialog_flow`.
- **`tests/auth/sales.spec.ts` (6d):** `record_sale_five_keys`, `sale_undo_restores_stock_hold_and_status`, `concurrent_sale_shows_only_n_left` (a second browser context sells first through the API), `supplier_stock_sale_no_stock_change`, `below_min_confirm`, `hold_then_sale_uses_hold`, `hold_end_shown`, `deal_lost_releases_hold` (status set through the local service key while Day 5 is absent), `cancel_old_sale_needs_code`, `restock_task_appears_in_tasks`, `team_logged_request_in_inbox`, `record_sale_from_request`.
- **`tests/auth/lead-stock.spec.ts` (6d, 6e):** Wants, Reserved and Bought sections with live availability; empty states; read-only lead; `share_link_create_needs_code_and_shows_once`, `share_link_whatsapp_and_mail_hrefs`, `share_link_revoke_then_inactive`, `share_link_replace`, `send_stock_list_as_text`, `rep_on_other_lead_cannot_create_link`.
- **`tests/auth/share-public.spec.ts` (6e, a fresh context with no storage state):**
  - `share_public_lists_warehouse_stock_with_max_price`, `share_public_never_shows_cost_or_min_price`, `share_public_hides_sold_out_and_hidden`, `share_public_arriving_section_with_week`, `share_public_language_toggle_keeps_fragment`;
  - `share_public_request_creates_task_for_owner` (checked from a signed-in context, French title for a French owner), `share_public_other_stock_request_free_text`, `share_public_honeypot_silently_dropped`, `share_public_fast_submit_fake_success`;
  - `share_public_unknown_revoked_expired_same_page`, `share_public_disabled_sharing_same_page`;
  - `share_public_headers` (share CSP with `connect-src 'self'` and `default-src 'none'`, `X-Robots-Tag`, `Referrer-Policy: no-referrer` on `/s/fr` and both routes, `no-store`, **no `Set-Cookie`**), `robots_txt_public_disallow_all`;
  - `share_public_bundle_has_no_supabase`, `share_html_has_no_internal_strings`, `share_public_token_not_in_requests_urls`, `share_public_no_supabase_requests`, `share_public_cross_origin_post_refused`, `share_public_non_json_refused`, `request_body_413`, `share_rpc_get_405`, `spoofed_surface_header_ignored`;
  - `share_public_rate_limit_message` (31st view in a minute), `share_public_signed_in_teammate_still_anon`, `share_public_xss_name_is_text`;
  - `share_public_360_no_horizontal_scroll`, `share_public_keyboard_only`, `share_public_reduced_motion`, `share_public_console_clean`, `proxy_share_paths_exact`.
- **`tests/auth/inventory-security.spec.ts` (6b, 6e):** private tables 404/406 on real PostgREST; `PATCH /rest/v1/stock_levels` → 403; `POST /rest/v1/rpc/stock_movement_b_apply` → 404; anon reaches only the two functions; a rep gets null cost.
- **Screenshots:** every new screen at 1280/1440/1728/390 (plus 768/1024 for Inventory, the lead tab, the import and `/s`; `/s` also at 360), light and dark, EN and FR, saved to `test-results/inventory-screens` and `share-screens`. No console errors, no CSP violations, no horizontal scroll.

### 11.6 Performance (numbers to hit)

**Database:** `scripts/db-perf.sh` with `supabase/tests/perf_stock.sql`, on a throwaway PG16. 3 full runs into `perf.md`; each hot RPC runs 10 times with plans 6 and later logged (the Day 4 generic-plan check).

Seed:
- 5,000 products (60 % with warehouse stock, 20 % transit only, 20 % sold out);
- 10,000 levels and 200,000 ledger rows;
- 5,000 holds (600 active);
- 10,000 orders and 30,000 lines;
- 2,000 requests and 300 links.

| # | Case | Budget |
|---|---|---|
| I1 | `list_stock` page 1, each sort / filter / search | p95 ≤ 20 ms |
| I2 | `stock_summary`, `stock_alerts` | ≤ 15 / ≤ 10 ms |
| I3 | `get_product` | ≤ 8 ms |
| I4 | `list_movements` page 1 / at id 100,000 / kind filter | ≤ 5 / ≤ 8 / ≤ 30 ms |
| I5 | `post_stock_movement` adjust / reserve / transfer | ≤ 5 ms |
| I6 | `record_sale` 1 / 10 / 20 lines | ≤ 10 / ≤ 25 / ≤ 40 ms |
| I7 | Arrived with 5 holds | ≤ 25 ms |
| I8 | `get_lead_stock` (50 sales, 20 holds, 20 requests) | ≤ 15 ms |
| I9 | `share_view` valid / unknown / malformed | ≤ 40 / ≤ 3 / ≤ 1 ms |
| I10 | `share_view` with 2,000 visible items | ≤ 40 ms database; payload ≤ 150 KB raw, ≤ 35 KB gzip |
| I11 | `share_request` (5 lines + task) | ≤ 20 ms |
| I12 | `validate_stock_import` at 5,000 rows | ≤ 1,000 ms |
| I13 | `commit_stock_import` chunk of 250 products / whole 5,000 rows | ≤ 1,500 ms per call / ≤ 30 s (cap rule: if a chunk misses, the default drops to 125) |
| I14 | `rollback_stock_import` chunk of 250 | ≤ 1,500 ms |
| I15 | `nightly_stock_jobs` (50 due holds, 5,000-product check) | ≤ 2,000 ms |
| I16 | 20-session concurrency script (wall clock) / 3 sessions × 300 mixed operations on 20 hot products | ≤ 3 s / p95 ≤ 25 ms, 0 deadlocks, integrity 0 rows |
| I17 | `check_stock_integrity` at 200,000 rows | ≤ 1,500 ms |
| I18 | Day 3a, 3b and 4 timings re-run (the untouched rule has more `not exists`) | ≤ +10 % |

**Browser** (`tests/auth/inventory-perf.spec.ts`, `PERF=1`, Chromium, 4× CPU):

| Measure | Budget |
|---|---|
| Inventory cold LCP | ≤ 2 s |
| Route change with hover prefetch | ≤ 200 ms |
| Tab switch | ≤ 100 ms |
| Stock table scroll at 5,000 rows | frame p95 ≤ 16.7 ms |
| Sale sheet open | ≤ 100 ms |
| 5,000-row stock sheet parse and clean | ≤ 1.5 s, longest task ≤ 200 ms |
| Inventory route extra JavaScript | ≤ 70 KB gzip |
| `/s` first-load JavaScript (from `next build`) | ≤ framework baseline + 40 KB gzip |
| `/s` Lighthouse mobile (Slow 4G, 4× CPU) | LCP ≤ 2.0 s, performance ≥ 90, accessibility ≥ 95, CLS ≤ 0.05 |
| `/api/share/view` server time | p95 ≤ 300 ms (preview; Haider's browser at Day 8) |
| 500 share items render | longest task ≤ 100 ms |

### 11.7 Evidence bundle (per PR: `docs/evidence/day6a|day6b|day6c|day6d|day6e/`)

| Item | 6a | 6b | 6c | 6d | 6e |
|---|---|---|---|---|---|
| This design as `docs/evidence/day6/design.md`, with as-built corrections in each README | ✓ | ✓ | ✓ | ✓ | ✓ |
| `db-test.sh` output: attack files, concurrency, advisors | ✓ | ✓ | ✓ | ✓ | ✓ |
| `mutations.md` (each mutation fails a check) | ✓ | | ✓ | ✓ | ✓ |
| `perf.md` (3 runs, plans, generic-plan check) | ✓ | ✓ | ✓ | ✓ | ✓ (plus Lighthouse) |
| `concurrency.md` (raw `stock_concurrency.sh` output) | ✓ | | ✓ | ✓ | ✓ |
| Spike results (S1, S2, S3, S6 in 6a; S1, S4, S5 in 6e) | ✓ | | | | ✓ |
| Supabase advisors (local splinter in CI; dev through the read-only MCP after `deploy-dev-db`) with accepted WARNs and reasons | ✓ | ✓ | ✓ | ✓ | ✓ (the share-function WARN) |
| Screenshots matrix, console clean, no horizontal scroll | | ✓ | ✓ | ✓ | ✓ |
| `/apple-design` and web-design-guidelines audits, fixes (unresolved: none) | | ✓ | ✓ | ✓ | ✓ |
| `security-review.md` covering the final head; gitleaks, npm audit, Semgrep (CI result), lint, typecheck, unit, Playwright | ✓ | ✓ | ✓ | ✓ | ✓ |
| `threat-model.md` (section 9 with links to passing tests), `headers.txt` (`curl -sI` of `/s/fr`, both routes, `/robots.txt`), `bundle-scan.txt`, catalog dump of anon-executable functions | | | | | ✓ |
| Read-only MCP pre-checks on dev before each migration (`select count(*) from import_batches where kind = 'stock'` expect 0; extensions; after 6e, `select rolname from pg_roles where rolname = 'share_reader'`) | ✓ | | ✓ | ✓ | ✓ |
| Context7 libraries named (Next 16 route handlers, proxy, `headers()`, metadata robots and referrer, `robots.ts`; next-intl v4 request config and provider; supabase-js 2.117 `rpc` and server-only client; TanStack Table, Virtual, Query; Zod 4; Motion `LazyMotion`; PostgreSQL row locks, `sha256`, pgcrypto; Supabase pg_cron; PostgREST GET/POST rules) | ✓ | ✓ | ✓ | ✓ | ✓ |
| `docs/log.md` decisions; the advisor's APPROVED verdict pasted into the REPORT (START_HERE section H) | ✓ | ✓ | ✓ | ✓ | ✓ |

---

## 12 Dependencies

**No new runtime or dev dependency.** Deliberately not added:
- a number or locale library (own `numbers.ts` plus Intl);
- SheetJS (CSV only, as Day 3b);
- a CAPTCHA (third-party script, key, CSP change);
- Upstash or Redis rate limiting (paid or external);
- an email service (needs a key and a domain);
- web push (Day 7 PWA);
- Supabase Realtime (refetch on focus and after mutations is enough).

**Extensions:** pgcrypto (already on Supabase; `create extension if not exists … with schema extensions`). pg_cron is optional (S6).

**CI:** new `db.yml` and `db-test.sh` steps (`stock_attack.sql`, `stock_concurrency.sh`, `stock_import_attack.sql`, `sales_attack.sql`, `share_attack.sql`). `db-perf.sh` runs `perf_stock.sql`. `scripts/db-mutations.py` gets the new lists. `.gitleaks.toml` is added in 6e.

### 12.1 Contract with Day 5 (no merge order needed)

1. Day 6 relies only on `deals.id`, `company_id`, `owner_id`, `status` and `fulfilment`, all present since Day 1. **Day 5 must set `deals.status = 'lost'` when a deal enters Closed/lost** (the core CHECK already requires `lost_reason`), because the release trigger keys on `status`. A deal with a null `company_id` never matches a lead.
2. Day 6 provides `stock_alerts()` for Day 5's Home card ("Stock low: X products, Y deals waiting" = `low`, `deals_waiting`):
   - if 6d merges first, 6d adds the card;
   - if Day 5 merges first, its card shows its own empty state until 6d wires the RPC in.
3. Day 6 provides `list_lead_deals_for_stock`. If Day 5 ships an equivalent, the builder uses Day 5's and drops this one.
4. `ReserveSheet` and `RecordSaleSheet` take `{companyId, dealId?}`, so Day 5's deal card can open them. A deal card links to `/leads/<id>?tab=stock&deal=<dealId>`.
5. If Day 5's final design adds its own orders or reservations table, Day 6's tables are the source of truth. The builder checks Day 5's design before 6d's migration.

### 12.2 Coordination with Day 4

- 6a needs 4a merged (the `lead_import_untouched` version).
- 6d needs 4b merged (lead page tabs, `src/components/lead/*`).
- 4c is recommended first, so the Tasks page shows system tasks. Its list must accept `created_by` null and show "Automatic".
- Shared functions are redefined from their newest version: `audit_row`, `lead_import_untouched`, `task_guard`, `import_batch_guard`. The FK-coverage array also follows the newest version (4c `queue_claims` and 4d `files`, whichever merged).

---

## 13 Build order (five PRs; each one branch, small commits, merged under Haider's standing permission only after advisor APPROVED and every check green)

**6a Stock engine** (branch `day6a-stock-engine`; after 4a is merged)
1. Read-only MCP pre-check; spikes S2, S3 and S6, plus a throwaway S1 script. Results logged.
2. Migration, part 1: `product_name_key`, locations and seeding, products and guard, costs, settings, RLS, grants.
3. Part 2: levels, ledger, holds, hold uses, idempotency table; guard, apply and immutable triggers; expiry helpers; deal triggers.
4. Part 3: RPCs and the revoke/grant loop; `check_stock_integrity`; `nightly_stock_jobs` (scheduled only if pg_cron exists); `audit_row` and `lead_import_untouched` from their newest definitions.
5. `stock_attack.sql`, the 6a cases of `stock_concurrency.sh`, wired into `db-test.sh` and `db.yml`; mutations 1–16.
6. `perf_stock.sql` part 1 (I5, I7, I16–I18); 3 runs.
7. Splinter, `/security-review`, gitleaks, npm audit, Semgrep (CI), lint, typecheck, full Playwright (no UI change).
8. Evidence, log lines, advisor loop, REPORT, merge, `deploy-dev-db`, dev advisors.

**6b Inventory page** (`day6b-inventory-page`)
1. Migration: read RPCs and settings RPCs.
2. `src/lib/inventory/{format,status,units,schemas}.ts`, `src/lib/inventory-server.ts`, unit specs (Context7 first).
3. Actions and GET routes.
4. UI: `/inventory` page and `loading.tsx`; `inventory/p/[id]`; `inventory/settings`; `src/components/inventory/*` (workspace, kpi-row, stock-table, stock-filters, product-panel, product-form, adjust-dialog, receive-dialog, arrived-dialog, arriving-list, reserved-list, movements-list, quantity-input); Cmd+K entries.
5. Messages in EN and FR; e2e; perf I1–I4; screenshots; audits; reviews; evidence; advisor; REPORT; merge.

**6c Stock sheet import** (`day6c-stock-import`; can swap with 6d)
1. Migration: the guard branch from the newest definition, the `kind` grant, the per-kind index, staging, changes table, lock helper, products import column, the 10 RPCs.
2. `stock_import_attack.sql`; `import_attack.sql` still green; concurrency cases; mutations 17–26; perf I12–I14.
3. `scripts/make-fake-stock.mjs` and fixtures; `src/lib/stock-import/*` with unit specs.
4. Shared wizard shell made kind-aware; `src/components/stock-import/*`; `/inventory/import` (`page.tsx`, `loading.tsx`, `actions.ts`); issues and changes routes.
5. E2e, screenshots, audits, reviews, evidence, advisor, REPORT, merge, deploy.

**6d Sales, holds, lead Stock tab, automations** (`day6d-sales`; after 4b is merged)
1. Migration: orders, lines, costs, requests, task columns and indexes, `task_guard` from its newest definition, `insert_system_task`, the automation triggers, RPCs, `lead_import_untouched`, audit branches.
2. `sales_attack.sql`; concurrency cases; mutations 27–36; perf I6, I8.
3. UI: Sales and Requests tabs, `record-sale-sheet`, `hold-sheet`, `sale-detail`, `requests-inbox`, `src/components/lead/stock-tab.tsx`; Home card wiring (or hand-off to Day 5).
4. Messages, e2e, screenshots, audits, reviews, evidence, advisor, REPORT, merge, deploy.

**6e Client stock link** (`day6e-client-share`)
1. Spikes S1, S4, S5.
2. Migration: pgcrypto, `share_reader`, share links and guard, share rate, settings columns, `share_items`, `share_take`, the two anon functions, team RPCs, `stock_requests` FK, `lead_import_untouched`, audit lists; `rls_attack.sql` allowlist; `.gitleaks.toml`.
3. `share_attack.sql`; mutations 37–52; perf I9–I11.
4. `src/lib/share/{server,schema,map,token,rate-limit}.ts`; routes; proxy branch and CSP; `next.config.ts` entry; `src/i18n/request.ts`; ESLint scopes; `src/app/robots.ts`.
5. `src/app/(share)/layout.tsx`, `src/app/(share)/s/[locale]/{page,loading}.tsx`, `src/components/share/*`; lead link card; settings sharing; `/inventory/client-view`; "Send stock list as text".
6. Messages; e2e (signed in and public); screenshots at 390 and 360 first; Lighthouse; `headers.txt`, `bundle-scan.txt`, `threat-model.md`.
7. `/security-review` with the public-surface checklist (section 9); evidence; advisor; REPORT. What I need from you: "open a preview link on your phone, signed out of the CRM but signed in to Vercel"; plus the HAIDER DECIDES line "Switch on sharing in production?" (recommended: after Gate 1 and the Pro upgrade). Merge; deploy; dev advisors.

---

## 14 Open questions for Haider (recommendation first)

The build follows each recommendation until Haider answers. Each one is a small change if he says otherwise.

1. **After go-live, the CRM is the master for quantities (recommended).** A new sheet updates prices and adds products. It changes a product's quantities only if nobody sold, received or corrected it in the CRM since the last sheet. One tick on the Check screen uses the sheet's numbers instead (after a full count). Until the first CRM movement, the sheet simply wins.
2. **The same product in the same place twice in one sheet: the second row is refused and listed (recommended),** so a copied row is never counted twice and two costs are never blended. Rename real separate lots ("… lot 2").
3. **Products missing from a new sheet are left as they are (recommended).** To mark something sold out, put 0. For a product the sheet does list, a place it leaves out counts as 0 there, so a lot that arrived leaves transit by itself.
4. **Clients see exact quantities** ("1 200 pcs · 25 cartons") and "Only 3 cartons left" (recommended). The alternative is ranges ("20+ cartons").
5. **Arriving stock on the client page: shown with the expected week**, otherwise "date to be confirmed"; switchable per link (recommended, on by default).
6. **Prices on the client page are per piece in EUR, excluding VAT (HT).** Please confirm HT or TTC, and send any footer wording (delivery terms).
7. **Selling below your minimum price: allowed for you, Henri and Kais after a confirmation, and marked on the sale (recommended).** Future reps cannot.
8. **Holds last 14 days by default, up to 90, can be extended, and end at once when a deal is lost (recommended).**
9. **Holding arriving stock is allowed (recommended).** When the container arrives, the hold moves with the goods, and whoever made it gets a task to record the sale.
10. **Low-stock tasks go to you (recommended)**, or to nobody (Home card only). A product only alerts once you set its reorder point (pieces available in the warehouse).
11. **Sharing stays switched off in production until Gate 1 and the Vercel Pro upgrade (recommended).** Before that, production shows fake data and Hobby forbids commercial use.
12. **Client links last 90 days by default (recommended)**, up to a year. Making or extending one asks for your authenticator code once. Revoking is one click.
13. **New client requests reach you in the app** (a task due today for the lead's owner, the Requests badge, the Home card), not by email (recommended for Release 1). Email needs a mail service and a domain; we can add one later if you approve a provider.
14. **The client page never shows the client's company name (recommended).** It does show "Your contact: Henri" (the first name of whoever made the link), so clients know who answers.
15. **A lead's first sale makes it a Customer automatically, with Undo (recommended).** Never from Do not contact or Disqualified.
16. **Units:** everything in pieces, typed in pieces by default with a cartons switch (as you decided on 7 Oct). Do some products sell by the pair? Recommended: a per-product word "pcs" or "pairs" (display only).
17. **PP on a lot:** we read PP as the cost of the QUANTITÉ on that row, so cost per piece = PP ÷ QUANTITÉ. Please confirm that is how your sheet works.
18. **Costs (PP) are visible to managers and admins only (recommended).** All three of you are admins, so you see them.
19. **Sales and requests do not appear on the lead's timeline or move "Last activity" in Release 1 (recommended).** They show on the Stock tab.
20. **Warehouse name:** "Warehouse France / Entrepôt France" until you give the real one (admins can rename it).
21. **Client link address:** `topstock-crm.vercel.app/s/fr#…` shows "crm" to clients. A custom address (for example `stock.topstockwholesale.com`) costs nothing if you own the domain, or about €10–15 a year if not. Recommended: decide at go-live.

---

## 15 Deferred (with reasons)

| Item | Reason |
|---|---|
| Containers (inbound shipments with lines, landed cost, receipt in one transaction) | Release 2. R1 has transit stock plus a per-product ETA |
| Order statuses after "confirmed" (pick, ship, deliver), carriers, tracking | Release 2. R1 sales are one step |
| Stock analytics (value at cost KPI, sell-through, days of cover, dead stock, margin) | Release 2. Cost snapshots per sale line are already stored |
| Back-in-stock tasks for leads who asked | Judge 3: scope. The inbox and the lead tab show live availability per line |
| CSV export of stock (in the sheet's format) | Needs the export step-up and an audit action; Day 7 |
| Gateway secret or a login role for the share functions | A new secret for Haider to manage. The database limits already cap direct callers. Revisit if logs show abuse |
| CAPTCHA (Turnstile) | Third-party script, key and CSP change. Only if spam passes the honeypot, time trap and database caps |
| Email, WhatsApp or push notifications | No free channel yet (open question 13) |
| Client accounts, client order history, client-side orders | A login surface for outsiders is a different risk class |
| Per-client prices or catalogues on a link; product photos | Would make the client view per link, and photos need storage and CSP changes after 4d |
| QR codes for links | Needs a library; links travel by WhatsApp and email |
| Merging two products after a rename; similar-name hints at import | Merging rewrites ledger references and needs its own design. The Check lists new products by name |
| Multi-warehouse, a supplier location, warehouse mode and barcodes on phones | Release 2. `unique (org_id, kind)` keeps R1 simple |
| XLSX stock sheets | CSV only, as Day 3b |
| Supabase Realtime on Inventory | Focus refetch and refetch after mutations are enough for three users |
| Saved stock filters | `saved_views.section` already allows `inventory`; after real use |
| Dock badge for requests; product search in Cmd+K | The Requests badge and the Inventory search cover it (Day 4 also deferred dock badges) |
| Timeline entries for sales, holds and requests | Open question 19; it would change Day 4's timeline meaning |
| Invoices, VAT, other currencies | EUR excl. VAT only in R1 |
| Country of the last view per link | Derived from the IP: pseudonymous data for little value |
