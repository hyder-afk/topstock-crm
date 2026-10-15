# Day 5 final design: pipeline, deals and the Home dashboard

> **How this was produced (11 Oct 2026).** A design workflow wrote three separate designs: one security-first, one data and performance-first, one owner-UX-first. Three judges scored them. Two picked the **security design** and one picked the UX design. This document starts from the security design. It adds every idea the judges listed from the other two, answers every risk they raised (section 2.3), and says which option won wherever the designs disagreed (section 2.2).
>
> I checked the repo facts at `b80c674`. That is branch `claude/busy-darwin-xech8m`, where Day 4a is built with its evidence. `origin/main` is at `4fe5641`, with Day 3b merged. I also checked against `docs/evidence/day4/design.md`.
>
> **Builder changes on top of the judges'** (each one comes from checking the code):
> 1. **No custom setting is read anywhere.** Undo needs no marker, and move request ids live in a private table. This removes the trap where a pooled connection reads `''`, instead of guarding against it.
> 2. **Day 6 status triggers must use `WHEN`, not `UPDATE OF status`.** A column-specific trigger does not fire when only a BEFORE trigger changed the column (PostgreSQL CREATE TRIGGER notes).
> 3. **A deal always gets an owner.** `enforce_org_and_owner` leaves `owner_id` null when an admin names nobody (`20261010090000` lines 105–112). The deal guard fills in the caller.
> 4. **A CI step checks migration order**, because `deploy-dev-db` runs `supabase db push --yes` without `--include-all`.
>
> I did not consult Context7 for this design: this was a read-only session. Each PR runs the lookups listed in 8.7 before writing code (CLAUDE.md).

## 1 Summary (plain words)

**What the team gets**

1. **A pipeline board** at `/pipeline`.
   - Haider's four columns: **Lead → Qualified → Negotiations → Closed/won**. The Won column shows the last 30 days.
   - **Closed/lost** is a drop band that appears while you drag. A line under the board reads "Lost in the last 30 days: 2 · Price 1 · Timing 1".
   - Only **deals** are on the board, never the 30,000 leads.
   - Each card shows:
     - the lead's name;
     - what is being sold;
     - the value in euros, or "Add value";
     - **days in stage**;
     - a **Stalled** warning when nobody has moved or contacted the deal for too long;
     - "Supplier Stock" when the goods ship straight from the supplier.
2. **Moving a deal**: four ways, all reaching the same database rule.
   - **Drag** it. It settles into place with a spring. On a phone, press and hold to drag.
   - **Keyboard**: `Shift+→`/`Shift+←` moves one stage. Digits `1` to `5` send it straight to a stage. `Space` starts a keyboard drag.
   - The card's **right-click menu** ("Move to…").
   - The **stage stepper** in the deal sheet, which is the main way on phones.
   - Every move shows at once and has **Undo** for 2 minutes. Dragging a deal back within those 2 minutes counts as Undo, so days in stage come back too.
3. **Won and Lost.**
   - **Won** asks for the final value (above €0) and **how it ships**: **Warehouse inventory** (sold from the warehouse in France) or **Supplier Stock** (shipped from Pakistan straight to the client's country). Day 6 turns each answer into its order type.
   - **Lost** asks why: Price, Timing, No stock, Went with a competitor, No response, Shipping, Opened by mistake, or Other (with a note).
   - A closed deal changes stage only by **Reopen**. Reopening a lost deal is one click. Reopening a won deal more than 2 minutes after winning it asks for a fresh authenticator code.
4. **Deals open where selling happens:**
   - the **Interested** and **Book meeting** outcomes in the work queue and the call panel. One key press logs the call and opens the deal, and one Undo removes both;
   - the lead page's **Deals** tab;
   - **New deal** on the board.
5. **The lead follows its deal** (open question 1). Negotiations makes the lead *Negotiation*. Won makes it a *Customer*. Lost rests it in *Cool off* for 90 days. Do not contact and Disqualified are never touched, and Undo puts the lead back.
6. **Two people moving the same deal**: exactly one move lands. The other screen springs the card to where it really is and says "Henri moved this deal a moment ago".
7. **Home**:
   - the date line, then "Hello Haider" ("Bonjour Haider"), then "You have 6 tasks today and 2 meetings.";
   - **four KPI cards whose numbers count up**: Open pipeline, Won this month, Calls today, Tasks due;
   - **Today** (tasks and meetings, ticked off in place);
   - **Work queue** (callable now, with the red **Start calling**);
   - **Needs attention** (stalled deals, and deals whose close date has passed);
   - **Pipeline** (stage bar, win rate, lost reasons);
   - **Recent activity** (calls and deal moves, never note text);
   - **Low stock**. Until Day 6 ships inventory, this card says so calmly.

**Protections** (each one holds when someone calls the database directly with their own login)

- **The database decides the deal's lifecycle.** Status, the stage clock, the close time and the version number are set by the database alone. A deal cannot be created already won, won without a value and a shipping choice, or lost without a reason.
- **Locked fields.** A deal's lead never changes. A closed deal keeps its value and reason until it is reopened.
- **History.** The stage history is written only by the database. Nobody can add, edit or delete it.
- **Stages.** Pipeline stages cannot be edited, not even by admins, until a Settings screen exists.
- **Home figures** run under the same row rules as the lists: no privileged function, no view.
- **Deleting a deal** needs an admin and a fresh code. The one exception is undoing a deal you opened in the last 2 minutes that nobody has touched.

**Proof**
- SQL attack tests, each shown to fail when its protection is removed (mutations).
- A concurrency script with two and three sessions, deadlock cases included.
- Unit tests, and end-to-end tests in Chromium and WebKit.
- Database timings at 30,015 leads, 300,000 activities and 10,000 deals.
- Browser timings for dragging (60 fps), route changes (under 200 ms) and first load (under 2 s).

**Three PRs.** Each has its own migration, attack test file, evidence folder and advisor loop:

| PR | Contents | Why separate | Branch from main after |
|---|---|---|---|
| **5a Deals database** | Stage keys and stall limits; deal columns, guard and history; `private.deal_moves`; policies and column grants; deal RPCs; tasks FK fix; audit rules; fixture updates; attack, concurrency and perf tests; migration-order check. No screens | Every other part trusts these rules, and Day 6 builds on them. A database-only review is fast | 4c merged (5a recreates `audit_row` and `task_guard` on their merged bodies) |
| **5b Pipeline and deals UI** | A small migration (activities get `deal_id` back; `log_activity`, `undo_activity`, `get_lead` and `claim_next_lead` recreated); the dnd-kit board, deal sheet, Win/Lose/Reopen, Undo, the lead Deals tab, Interested opens a deal; context menus | All the drag, keyboard and motion risk sits in one place | 5a merged |
| **5c Home dashboard** | `home_summary`, `home_attention`, `home_recent_activity`, the `home_low_stock` stub; the Home screen, count-up, low-stock slot | Read-only, but it is where figures could leak rows outside the row rules, so it gets its own review | 5a merged (5b recommended first) |

**Changes from the winning design** (each comes from a judge's finding):
1. **Locks**: lead first, then deal, everywhere. `undo_activity` deletes its deal after taking the contact and lead locks.
2. **Closed deals**: won and lost are reachable only from an open deal. Won → Lost now goes through Reopen, which needs a code.
3. **Undo**: no custom-setting marker. Your own reverse move of your latest change, within 120 s and with nothing changed since, is the undo. History stays append-only.
4. **Value and shipping**: value is nullable and fulfilment has no default. Both are required to win.
5. **Lead coupling** stays in INVOKER RPCs. Its undo data sits in a private table, not in history.
6. **Interested**: the deal opens inside `log_activity`, in one transaction. `created_deal_id` goes into `activity_undo`.
7. **Day 6 seam**: `private.deal_closing_blocked(deal)`, so Day 6 never redefines the guard.
8. **Board**: newest-in-stage first, and the moved card is scrolled into view before the settle. The Won column covers 30 days, not the calendar month.
9. **Home KPI row**: Open pipeline, Won this month, Calls today, Tasks due. Win rate moves into the Pipeline card, shown from 5 closed deals. Home also gets a queue card with counts.
10. **Count-up** plays on the first visit per tab, hard loads included, when hydration lands within 800 ms.
11. **Low stock**: the card and its skeleton ship in 5c with a calm placeholder (Haider accepted the same rule for Day 4's tabs). Its data is a separate part.
12. **Other grafts**:
    - money as decimal strings;
    - the leakproof rule (no keyset or index condition on `value`);
    - cache-first rendering for the 200 ms route budget;
    - `MouseSensor` plus `TouchSensor`;
    - Radix ContextMenu;
    - digits 1–5 read with `event.code`;
    - a rate limit on stage changes;
    - invariant checks after every scenario.

## 2 Decisions

### 2.1 Facts checked in the repo

**Gaps that exist today** (Day 5 closes all of them):

| # | Gap | Where |
|---|---|---|
| G1 | **Table-wide write grant on deals.** A client writes `status`, `stage_entered_at`, `created_at`, `currency` and `lost_reason`. It can insert a deal straight at Closed/won, or set status `won` on the Lead stage | `20261009180000_core_schema.sql:452` |
| G2 | **No transition rules.** The only check is `status <> 'lost' or lost_reason is not null`. `lost_reason` is free text up to 500 characters | core schema, `deals` |
| G3 | **Deleting a deal needs no fresh code** (`deals_rw` is `FOR ALL`) | `20261010090000:254` |
| G4 | **Admins write stages with no code.** Policies `pipeline_stages_admin_write/update/delete` plus a table grant. Nothing keeps one won and one lost stage per org. Names are stored in English only | core `:454`, `:529–535` |
| G5 | `deals.company_id` is nullable and `on delete set null`: a deal can lose its lead | core, `deals` |
| G6 | `value numeric(14,2) check (value >= 0)` accepts `'NaN'`: PostgreSQL sorts NaN above every number | core, `deals` |
| G7 | `value not null default 0` shows "€0" on a deal opened from a call. `fulfilment not null default 'from_stock'` claims warehouse stock for every deal before Day 6 | core, `deals` |
| G8 | `tasks.deal_id` is `on delete cascade`. 4a's `task_guard` FK exception lists `assignee_id, contact_id, created_by, source_activity_id` but not `deal_id`. Switching to SET NULL without adding it would raise `not_editable` | core `:222`; `20261011120000:250–256` |
| G9 | 4a took `deal_id` out of the activities insert grant (`20261011120000:54`). `activity_guard` already lets `deal_id` become null at depth > 1 (`:113–118`) | 4a |
| G10 | Deals are visible to the owner, managers and admins; leads to the whole org | `deals_rw`; Day 3a |
| G11 | An admin who inserts with no owner leaves `owner_id` null (`enforce_org_and_owner` forces the owner only for reps) | `20261010090000:105–112` |
| G12 | Home and Pipeline are placeholders (`src/app/(app)/page.tsx`, `pipeline/page.tsx`). `package.json` has no dnd-kit, Recharts or context-menu package | |
| G13 | Fixtures that change with Day 5: `rls_attack.sql` lines 30, 249, 287–292, 299 and 313; `import_attack.sql:523`; `activity_attack.sql:117` (5b) | tests |

**Other facts the design relies on:**

- **Spike S5 (4a, logged).** ON DELETE SET NULL fires BEFORE UPDATE triggers at `pg_trigger_depth() = 2`, with the claims still set. Under RLS, `SELECT … FOR UPDATE` returns 0 rows (and no error) when the update policy fails.
- **Leakproof operators** (`/usr/share/postgresql/16/postgres.bki`, read for this design):
  - `numeric_lt`, `numeric_ge` and `numeric_eq` are **not** leakproof;
  - `uuid_eq/lt/gt`, `timestamptz_lt/le/ge/gt`, `texteq`, `textne`, `date_le`, `int2eq` and `int4lt` are.
  - So `deals.value` is **never** an index condition or a keyset.
- **Column-specific triggers.** An `AFTER UPDATE OF col` trigger fires only when `col` is in the UPDATE target list. A change made by a BEFORE trigger does not count. The guard sets `status`, so any trigger on status must be `AFTER UPDATE … WHEN (old.status is distinct from new.status)`. Spike S9 records this.
- **Next 16.4 prefetch** (`node_modules/next/dist/docs/01-app/02-guides/prefetching.md:31–35, 61–62`). A dynamic route with `loading.js` is prefetched only "layout to first loading boundary", and `staleTimes.dynamic` is 0. A route change under 200 ms therefore needs data already in the TanStack cache.
- **Server actions** are dispatched one at a time per client (Day 4 fact).
- **QueryProvider defaults:** `staleTime 30 s`, `refetchOnWindowFocus false` (`src/components/providers/query-provider.tsx`).
- **Keyboard layer** (`src/components/shell/keyboard-layer.tsx`):
  - the "G then a letter" chord is handled on `window` keydown, with `pendingG` as a private ref;
  - element handlers run first, so card keys need a new `isChordPending()` export;
  - an open `[role=dialog]` owns the keyboard;
  - `goKeys` uses `h l p i t a m` (`src/lib/shortcuts.ts`).
- **Greeting** plays its CSS word rise on the first render in a tab, through a module flag (`src/components/shell/greeting.tsx`).
- **Toast**: one at a time, 6 s (`src/components/ui/toast.tsx:28`). 4b adds a 10 s option (Day 4 5.3).
- **CSP**: `style-src 'self' 'unsafe-inline'` (`src/proxy.ts:15`) allows the inline transforms dnd-kit writes. Scripts stay nonce-only.
- **Packages** (npm registry, read only):
  - `@dnd-kit/core` 6.3.1, published 5 Dec 2024. Peer `react >=16.8`; it depends on `@dnd-kit/accessibility ^3.1.1`, `@dnd-kit/utilities ^3.2.2` and `tslib`. `latest` is 6.3.1.
  - `@dnd-kit/react` is still 0.x.
  - `@radix-ui/react-context-menu` 2.3.7, published 24 Jul 2026, depends on `@radix-ui/react-menu` **2.1.24**. That is the version the installed dropdown 2.1.24 already brings, so no menu code is duplicated. 2.3.8, from 5 Oct 2026, is under the two-week rule.
- **CI.**
  - `db.yml` starts Supabase **without PostgREST**. `auth-journey` (`ci.yml:71`) starts it with PostgREST and Kong.
  - `deploy-dev-db.yml:72` runs `supabase db push --yes` without `--include-all`.
- **Lead index.** `companies_created_keyset_idx (org_id, created_at desc, id desc)` exists (`20261010090000:42`).
- **Import Undo** keeps any lead that has a deal (`lead_import_untouched`, 4a `:394`).
- **`import_fk_coverage`** expects exactly `{activities, contacts, deals, tasks}` to reference leads (`import_attack.sql:138–143`). Day 5 adds no FK to `companies`.
- **Haider's answers on 11 Oct (log).**
  - He accepted Day 4 open question 8: "Deals and Stock tabs shown with 'nothing yet'". That is the precedent for the low-stock placeholder.
  - Day 6 order types are **Supplier Stock** and **Warehouse inventory**. Stock statuses are **In Warehouse** and **In Transit**.
  - **PP** is the internal purchase cost and is never shown to clients.

### 2.2 Where the designs disagreed, and what we chose

| # | Topic | Chosen | Rejected | Why |
|---|---|---|---|---|
| D1 | PR split | 3 PRs: database, UI, Home | 2 PRs | All three designs agreed; the Day 4 judges asked for this shape |
| D2 | Who sees deals | Unchanged: owner, managers, admins | Org-wide like leads | No change to a tested rule without Haider. All three are admins, so nothing changes today. Open question 5 |
| D3 | Status, times, version | **Derived by the guard** from the stage; never granted (security) | Client field; RPC-only rules | The same rules apply on every path, including a direct PATCH |
| D4 | Stage history | `public.deal_stage_history`: **append-only**, select-only for clients, written by one revoked DEFINER trigger. Stages stored as keys. An undo is a new row with `undoes` (security) | Deleting reversed rows (data); setting `undone_at` (UX) | Clients cannot forge or erase it. Analytics drop the undo pairs. Keys mean no stage FKs to index |
| D5 | Concurrency | `version` integer, bumped by the guard on every change. RPCs lock with `FOR NO KEY UPDATE` and compare `p_expected_version`. A mismatch is **a result**, `{result:'conflict', deal, changed_by_first_name}`, not an error (data) | 22023 `stale` (security); 40001 (UX); from-stage compare (UX) | 40001 invites automatic retries meant for real serialization failures. A from-stage compare lets a stale Win overwrite a colleague's value edit |
| D6 | **Undo of a move** | **Your own reverse move of the deal's latest change, within 120 s, with the deal unchanged since (`version_after`), is the undo.** The guard restores `stage_entered_at`, `closed_at`, `value` and `fulfilment` from that history row. The RPC restores the lead from `private.deal_moves`. The toast's Undo passes `p_undo_of` and gets `undo_expired` instead of a silent ordinary move | A custom-setting marker with a separate RPC (security); client-sent values | No custom setting, so no pooled-connection trap. Drag back, `U` and the toast share one path. Values come only from server-written rows |
| D7 | Closed → closed | **Won and Lost only from an open deal** (22023 `reopen_first`). A closed deal moves only by Reopen | Allowing Won → Lost | Otherwise Won → Lost skips the reopen step-up and quietly rewrites the month's sales (judges' first risk) |
| D8 | Reopening a won deal | Fresh code (`has_recent_aal2(600)`), except your own undo within 120 s. `private.deal_closing_blocked()` must return null | Always free; never allowed | Correcting a mistake stays easy; changing the figures needs a code. Day 6 can lock it once an order exists. Open question 7 |
| D9 | Stages | `key` and `stall_days`; one won and one lost per org; **every client write revoked, admins included** | Admin rename and stall edit with no code (data) | The smallest surface. Labels come from `messages/*` by key. Settings is deferred |
| D10 | Value and money | `value` nullable ("not estimated"), CHECK `>= 0`, `<> 'NaN'`, `<= 100,000,000`. **Required and > 0 to win.** Sent as a decimal string end to end (regex `^\d{1,9}(\.\d{1,2})?$`, `parseMoney` for FR "12 400,50" with NBSP and narrow NBSP) | `not null default 0`; `z.number().multipleOf(0.01)` | No "€0" deals, no float drift, no NaN |
| D11 | Fulfilment | **Nullable with no default; chosen at Win (required)** | `default 'from_stock'` | Day 6's order type is chosen on purpose, never assumed |
| D12 | Currency | **EUR only** (`check (currency = 'EUR')`, not granted) | EUR/GBP/USD per-currency totals (data) | Master Plan "EUR assumed", CLAUDE.md "EUR default". Multi-currency touches every figure. Open question 11 |
| D13 | Lost reasons | Closed list `price, timing, no_stock, competitor, no_response, shipping, mistake, other`. A note is required for `other`. `mistake` is left out of the win rate. The note is masked in audit | Free text | Groupable. No second copy of free text (Day 4 D8). Open question 3 |
| D14 | Closed deals | Only `title`, `contact_id` and `owner_id` (managers) may change. Reopen to change the value, fulfilment or reason | Freely editable | Won figures cannot drift quietly |
| D15 | Lead follows deal | In the **INVOKER RPCs** (`open_deal`, `move_deal`, `delete_deal`), where RLS gives 0 rows to non-editors. Recorded in `private.deal_moves` for compare-and-restore. **Never touches `do_not_contact` or `disqualified`** (table in 5.4) | A DEFINER AFTER trigger with a copied editor check (UX); no coupling | No hand-copied `companies_update` check that bypasses RLS. Haider has not confirmed the rule: open question 1 |
| D16 | Stalled | **One rule**: open, and `greatest(stage_entered_at, lead.last_activity_at) < now() - stall_days` (Lead 7, Qualified 14, Negotiations 21). Computed in SQL only; shared literal cases | Days in stage only (data); "either" (UX) | A deal people are calling is not flagged. `stage_entered_at <= cutoff` stays an index range as a prefilter. Open question 2 |
| D17 | Interested opens a deal | **Inside `log_activity`** (one transaction). `created_deal_id` goes into `activity_undo`, and one Undo removes both (UX) | `log_activity` then `open_deal` (security) | Atomic, and one round trip on the queue's 400 ms path. Deal inputs are validated before any write, and a non-editor or DNC lead skips the deal but keeps the call |
| D18 | Open deals per lead | **Several allowed**, with a warning ("This lead already has an open deal: Qualified · €6,800") | One-open unique index (UX) | Haider has two order types that can run at once. A unique index would leak hidden deals to future reps and break reopening (23505). The index stays a one-line option. Open question 4 |
| D19 | Board contents | Open deals, plus **Won from the last 30 days** (rolling). Lost is a drop band and a 30-day summary line with "See lost deals" | Won this month (security); a fifth column | The Won column never empties on the 1st. Home's "Won this month" stays a calendar month |
| D20 | Order in a column | Server keyset on `(stage_entered_at, id)`: **"Recently moved" (default, newest first)** or "Longest in stage", same index. "Value" and "Close date" re-sort **loaded cards only**, with a note when more exist. A moved card is scrolled into view before the settle | Oldest-first default (security, UX); value keyset | The settle always lands on a mounted, visible card. `numeric` is not leakproof (2.1) |
| D21 | Board loading | One `pipeline_board` call for first paint: summaries plus 50 cards per column. A rep asking for `team` silently gets `mine` there only. Keyset pages after that. Virtualised past 60 loaded cards | Per-column first calls | One round trip, about 14 KB gzip, and a rep's first paint never errors. `list_stage_deals` and `pipeline_summary` keep 42501 |
| D22 | Drag library | `@dnd-kit/core` 6.3.1, no `sortable`. `MouseSensor` (distance 6) + `TouchSensor` (delay 250, tolerance 8) + `KeyboardSensor` | `@dnd-kit/react` 0.x; `PointerSensor` + `TouchSensor` | Stable, accessible. dnd-kit advises Mouse + Touch when touch needs its own activation |
| D23 | Context menu | `@radix-ui/react-context-menu` 2.3.7 (shares `react-menu` 2.1.24) | The dropdown opened at the ⋯ button (security) | CLAUDE.md asks for right-click menus at the pointer. No duplicated menu code |
| D24 | Card keys | Digits `1`–`5` via `event.code`; `Shift+←/→`; `Space` drag; `Enter`, `E`, `O`, `U`, `N`, `Delete`. **No** `h l p i t a m` letters, and a check for a pending G chord | `W`/`X`/`M` letters | AZERTY-safe (Day 4 7.7). `M` would clash with "G then M" |
| D25 | Charts | No Recharts. The stage bar is a hand-built `scaleX` bar in ink tones | Recharts now | Bundle size on Home. Trends need period history (Release 3) |
| D26 | Home data | Separate parts: `home_summary`, `home_attention`, `home_recent_activity`, today's tasks, `home_low_stock`. Fetched in parallel with `allSettled`; each card fails alone. `queue_summary` loads after paint | One `get_home` (UX) | One SQL error, including a Day 6 stock fault, must not take down every KPI |
| D27 | KPI row | **Open pipeline, Won this month, Calls today, Tasks due**. Win rate sits in the Pipeline card, shown once 5 deals have closed in 90 days (UX) | Win rate as a KPI card (security) | A KPI showing a dash for weeks reads as broken |
| D28 | Home scope | **Team by default for managers and admins**, Mine for reps (no switch). Remembered per device. Tasks due is always mine | Mine by default (security) | Two of three designs; Haider leads the team. Open question 9 |
| D29 | Count-up | The server renders the final number. On the **first visit per tab, hard loads included**, if hydration landed within 800 ms and motion is allowed, it counts from 0 under the CSS fade. The width is reserved by an invisible copy (UX + security) | Client navigation only (security) | Plays on Haider's usual morning hard load, without flashing final → 0 → final |
| D30 | Low stock before Day 6 | 5c ships the card, skeleton and placeholder, plus `public.home_low_stock(int)` returning null (created only if absent). Day 6 replaces the function with the fixed JSON contract (section 10) | No card until Day 6 (security) | The layout does not move when inventory lands. Precedent: Day 4 open question 8, accepted |
| D31 | Freshness | Refetch on focus; the board every 30 s and Home every 60 s while visible; invalidation after every mutation | Supabase Realtime | No new channel to secure; three users |
| D32 | Route speed | **Cache-first**. The server passes a promise. The client renders TanStack cache data at once (prefetched on dock hover and focus), otherwise it calls `use()` on the promise (spike S14) | `router.prefetch` alone; `staleTimes.dynamic` | Next 16.4 prefetches dynamic routes only up to `loading.tsx` (2.1) |
| D33 | Recent activity | Activities **and** deal stage changes, merged ("Henri won Maison Verdane · €12,400"). Never a note body or a lost note | Text previews | Least exposure on a screen that is often shared |
| D34 | New deal owner | The person who opens it. Admins may pick anyone in the team | The lead's owner | Matches Day 4's "Interested makes the caller the owner". Open question 14 |
| D35 | Migration order | Every new migration file must sort after the newest on `main` when its PR merges; it is renamed at merge time if needed. CI step `scripts/check-migration-order.sh` in `db.yml` | Fixed timestamps | `db push` without `--include-all` refuses an out-of-order file. 4d and Day 6 merge in parallel |

### 2.3 Judges' risks and where each is handled

| Risk raised | Handled in |
|---|---|
| Won → Lost (closed to closed) skips the reopen step-up | D7. Guard rule "into won or lost only from open". `transition_matrix` rows `won→lost`, `lost→won` (22023 `reopen_first`). Mutation 5a-6 |
| Lock order contradicted ("deal, contact, lead" vs `log_activity(p_deal)`) | One order everywhere: **contact → lead → deal** (5.7). `undo_activity` deletes the deal after the lead lock. Tests `undo_activity_vs_log_activity_with_deal_no_deadlock`, `move_vs_log_activity_with_deal_no_deadlock`, `delete_deal_vs_log_activity_with_deal_no_deadlock` (`deadlock_timeout = 200ms`). Mutation 5b-3 |
| Custom settings on pooled connections read `''` | **No custom setting is read** (builder change 1). Unit test `sql-guc.spec.ts` fails if any migration contains `current_setting(` not wrapped as `nullif(current_setting(…, true), '')` |
| Fixture breakage (`rls_attack` 30, 249, 287–292, 299, 313; `import_attack:523`; `activity_attack:117`) | Exact edits in 8.1. The guard raises **42501 hint `stage`** for an invisible stage, so line 299 still passes |
| Every stage write revoked, so stall days change only by migration | Accepted (D9). Settings with an admin-plus-code policy is deferred (section 13) |
| Deal visibility vs org-wide leads; an existence oracle | D2 and open question 5. No unique index (D18), so nothing leaks. Residual risk 3 |
| 120 s no-code windows; "untouched" can be fooled | The guard bumps `version` on **every** changed column, including through the referential path. Residual risk 1 |
| DEFINER code writing `companies` or deleting history | Neither exists: lead coupling lives in INVOKER RPCs (D15), and history is append-only (D4) |
| Day 6 coordination (order, reservations on Lost, reopen after a sale) | Contract in section 10. `deal_closing_blocked` seam. `WHEN` instead of `UPDATE OF status` (builder change 2). D35 |
| dnd-kit 6.x unmaintained since Dec 2024; virtualised drag and WebKit long press unproven | Spikes S10, S11, S13 first in 5b. Fallback: no virtualisation, at most 100 cards loaded per column with "Show more" |
| Partial indexes do not cover FK lookups; history stage FKs unindexed | `deals_owner_idx`, `deals_stage_idx` and `deals_contact_idx` stay. History stores stage **keys** (no FK). Index list in 3.1 |
| Settle target off-screen with oldest-first | D20 (newest first, plus scroll into view before the spring) |
| Stalled definitions differ | D16, one SQL definition; shared cases in unit tests and in `deals_attack.sql`; open question 2 |
| Interested as two RPCs is not atomic | D17 |
| Home fault isolation and the Day 6 seam | D26, D30, contract section 10 |
| Scope creep (multi-currency, Recharts, settings) | D12, D25; deferred |
| Recreating 4b/4c functions still being built | 5b branches after 4c merges and copies the merged bodies. Day 4's `outcome_attack.sql` and `queue_attack.sql` re-run **unchanged** after 5b |
| Undo by reverse move split across the guard and the AFTER trigger | One shared STABLE function `private.deal_undo_candidate` decides for both. Spike S9 proves both see the same answer. The full move table includes undo rows |
| Lead coupling unconfirmed | Built per recommendation behind compare-and-restore Undo. Never DNC or Disqualified. Open question 1 |
| Card keys collide with "G then letter" or break on AZERTY | D24; `isChordPending`; unit `board-keys.spec.ts` |
| Count-up flashes, or never plays on a hard load | D29; e2e `count_up_first_visit_hard_load`, `kpis_no_layout_shift` |
| Day-one Home looks broken | Calm empty states (7.10). Win rate hidden under 5 closed deals |
| One open deal per lead vs two order types | D18 |
| Route change under 200 ms | D32; perf "route with dock hover ≤ 200 ms" |
| No rate limit on moves | Guard: 120 stage changes a minute per person (one range read on the history actor index) |
| `value` default 0 and fulfilment default `from_stock` | D10, D11 |
| `activity_attack.sql:733` (tasks `deal_id`) | Unchanged: `tasks.deal_id` stays out of the grants (section 13) |
| 40001 for "stale" | D5 (a result, never 40001) |
| Context7 not consulted | Named lookups per PR (8.7), run before any code |

### 2.4 Facts to prove before building on them (spikes; results logged in `docs/log.md`)

| # | PR | Question | Decision rule |
|---|---|---|---|
| S6 | 5a, first commit | PG16: does `numeric(14,2)` accept `'NaN'` and pass `value >= 0`? Does it refuse `'Infinity'`? Can PostgREST pass `"NaN"` to a numeric parameter? | Add `value <> 'NaN'` to the CHECK and the guard pre-check either way. If Infinity is accepted, the `<= 100000000` bound already refuses it; record that |
| S7 | 5a | With column grants, does `SELECT … FOR NO KEY UPDATE` under RLS return the row to an editor and 0 rows (no error) to a viewer, as S5b showed for `FOR UPDATE`? | If not, RPCs run an explicit editor check before the lock |
| S8 | 5a | Does `FOR NO KEY UPDATE` on a deal coexist with the `FOR KEY SHARE` an activity insert takes through `activities.deal_id`, while a `DELETE` conflicts with it? | Required by 5.7. If the behaviour differs, the lock order table is revised before 5b |
| S9 | 5a | In one UPDATE, do the INVOKER guard and the DEFINER AFTER trigger get the same `deal_undo_candidate` result? Does `AFTER UPDATE OF stage_id` fire for a client stage change? Does an `AFTER UPDATE OF status` probe **not** fire when only the guard changed `status`? | If the candidates could differ, the guard writes the candidate id into a server-kept column `deals.undo_of bigint` (never granted), which the AFTER trigger reads and clears. The status probe result goes into the Day 6 contract |
| S10 | 5b, first commit | `@dnd-kit/core` 6.3.1 under React 19.3 StrictMode and Next 16.4. SSR ids with `DndContext id="pipeline-board"`, the `DragOverlay` portal, no CSP violation, the live region. With a TanStack-virtualised column, does a drag survive the source card scrolling away (`rangeExtractor` keeps the active index)? | If the drag breaks, columns are not virtualised (at most 100 loaded per column, "Show more"). If core fails outright, stop and report (CLAUDE.md) |
| S11 | 5b | WebKit at 390: `TouchSensor` (250 ms, tolerance 8) against `scroll-snap-type: x mandatory` columns | If a long press scrolls instead of lifting, the phone drag starts only from a ⋮⋮ grip (`touch-action: none`). The stage stepper stays the main phone path |
| S12 | 5b | TanStack Query 5.103.2: do mutations with `scope: {id: 'deal-'+id}` run in series, with `mutationFn` reading the latest cached `version` at run time? | If not, a small per-deal promise chain in `use-pipeline.ts` |
| S13 | 5b | Motion `layout="position"` on cards inside TanStack Virtual rows (translateY), and the settle on a virtualised card after `scrollToIndex` | If the transforms fight, virtualised columns drop neighbour layout animation and keep the settle on the moved card only |
| S14 | 5b/5c | Next 16.4: a server component passes a promise; the client calls `use()` only when the TanStack cache is empty. Does it stream without blocking the shell or the greeting? | If it blocks, the page awaits nothing and the client fetches on mount behind a skeleton; LCP is re-measured |

## 3 Data model and migration outline

House rules (Day 4 section 3):
- `set search_path = ''` everywhere;
- RPCs are SECURITY INVOKER with static SQL (no `format()`, no `EXECUTE` with user text; filters are IF branches);
- DEFINER code is trigger-only and revoked from everyone;
- clients get column grants only;
- every CHECK that input can reach has a constant-message pre-check first.

**Read-only MCP pre-check on dev before 5a** (logged):
- `select count(*) from deals` (expect 0);
- `select count(*) from tasks where deal_id is not null`;
- `select count(*) from activities where deal_id is not null`;
- `select org_id, position, name, is_won, is_lost from pipeline_stages order by 1, 2` (expect the 5 seeded rows per org);
- the constraint names on `deals`: expect `deals_check`, `deals_lost_reason_check`, `deals_value_check`, `deals_currency_check`, plus `deals_status_check` and `deals_fulfilment_check`, which stay.

### 3.1 5a: `supabase/migrations/20261015090000_deals_pipeline.sql` (renamed at merge to sort after main, D35)

**Stages (G4, D9)**
```sql
alter table public.pipeline_stages
  add column key text,
  add column stall_days smallint check (stall_days between 1 and 365);
update public.pipeline_stages set
  key = case position when 1 then 'lead' when 2 then 'qualified' when 3 then 'negotiations' when 4 then 'won' when 5 then 'lost' end,
  stall_days = case position when 1 then 7 when 2 then 14 when 3 then 21 end;
-- a DO block raises if any key is still null (an org without the seeded rows)
alter table public.pipeline_stages
  alter column key set not null,
  add constraint pipeline_stages_key_check check (key in ('lead','qualified','negotiations','won','lost')),
  add constraint pipeline_stages_key_flags check (is_won = (key = 'won') and is_lost = (key = 'lost')),
  add constraint pipeline_stages_stall_open_only check (stall_days is null or key in ('lead','qualified','negotiations')),
  add constraint pipeline_stages_org_key unique (org_id, key);          -- so exactly one won and one lost per org
drop policy pipeline_stages_admin_write on public.pipeline_stages;
drop policy pipeline_stages_admin_update on public.pipeline_stages;
drop policy pipeline_stages_admin_delete on public.pipeline_stages;
revoke insert, update, delete on public.pipeline_stages from authenticated;   -- select (org) and require_mfa stay
```

**Deals: columns, constraints, FKs (G1, G2, G5, G6, G7)**
```sql
alter table public.deals
  add column title text,                         -- what is being sold ("Denim jackets, 2 pallets")
  add column lost_note text,
  add column closed_at timestamptz,              -- guard-set
  add column version integer not null default 0, -- guard-set; optimistic concurrency
  add column created_by uuid references public.profiles (id) on delete set null,
  add column source_activity_id uuid references public.activities (id) on delete set null,   -- the Interested call
  add column request_id uuid;                    -- idempotency of open, unique per creator
alter table public.deals
  alter column company_id set not null,          -- dev: 0 rows (pre-check)
  alter column value drop not null, alter column value drop default,             -- null = not estimated
  alter column fulfilment drop not null, alter column fulfilment drop default,   -- chosen at Win
  drop constraint deals_company_id_fkey,
  add constraint deals_company_id_fkey foreign key (company_id) references public.companies (id) on delete restrict,
  drop constraint deals_check, drop constraint deals_lost_reason_check,
  drop constraint deals_value_check, drop constraint deals_currency_check,
  add constraint deals_value_bounds check (value is null or (value >= 0 and value <> 'NaN' and value <= 100000000)),
  add constraint deals_currency_eur check (currency = 'EUR'),
  add constraint deals_lost_reason_code check (lost_reason is null or lost_reason in
       ('price','timing','no_stock','competitor','no_response','shipping','mistake','other')),
  add constraint deals_lost_has_reason check (status <> 'lost' or lost_reason is not null),
  add constraint deals_other_has_note check (status <> 'lost' or lost_reason <> 'other' or lost_note is not null),
  add constraint deals_won_shape check (status <> 'won' or (value is not null and value > 0 and fulfilment is not null)),
  add constraint deals_closed_at_matches check ((status = 'open') = (closed_at is null)),
  add constraint deals_version_nonneg check (version >= 0),
  add constraint deals_title_safe check (title is null or (char_length(title) between 1 and 120
       and title !~ '[\u0001-\u001F\u007F\u202A-\u202E\u2066-\u2069]')),
  add constraint deals_note_safe check (lost_note is null or (char_length(lost_note) between 1 and 500
       and lost_note !~ '[\u0001-\u0008\u000B-\u001F\u007F\u202A-\u202E\u2066-\u2069]'));
alter table public.tasks                          -- G8: a deleted deal keeps its tasks
  drop constraint tasks_deal_id_fkey,
  add constraint tasks_deal_id_fkey foreign key (deal_id) references public.deals (id) on delete set null;
```
- `deals_won_shape` says `value is not null and value > 0`. A CHECK lets null through, which is the lesson from 4a deviation 2.
- `private.task_guard` is recreated with `create or replace` from its **merged** body. One change: `deal_id` joins the FK-exception list.
- A lead with deals cannot be deleted (23503, hint `lead_has_deals`). There is no lead delete screen (Day 4 deferral).

**Indexes, and the query each serves**
```sql
drop index public.deals_org_owner_idx, public.deals_company_idx;
create index deals_owner_board_idx on public.deals (owner_id, stage_id, stage_entered_at desc, id desc) where status = 'open';
create index deals_org_board_idx   on public.deals (org_id,   stage_id, stage_entered_at desc, id desc) where status = 'open';
create index deals_owner_closed_idx on public.deals (owner_id, status, closed_at desc, id desc) where status <> 'open';
create index deals_org_closed_idx   on public.deals (org_id,   status, closed_at desc, id desc) where status <> 'open';
create index deals_company_idx on public.deals (company_id, created_at desc, id desc);          -- FK, Deals tab, coupling check
create index deals_created_by_idx on public.deals (created_by, created_at);                     -- FK, open rate guard
create index deals_source_activity_idx on public.deals (source_activity_id) where source_activity_id is not null;
create unique index deals_creator_request_idx on public.deals (created_by, request_id) where request_id is not null;
-- kept for their FKs (non-partial): deals_owner_idx (owner_id), deals_stage_idx, deals_contact_idx
drop index public.activities_deal_idx;
create index activities_deal_idx on public.activities (deal_id, created_at desc, id desc) where deal_id is not null;
-- Leakproof rule (migration comment): numeric comparisons are not leakproof under RLS, so deals.value is never
-- an index condition or a keyset. Queries repeat the partial predicate literally (status = 'open' / status <> 'open').
```

| Query | Index condition (all leakproof) | Rows touched at the perf seed |
|---|---|---|
| Team column page | `org_id = $o and stage_id = $s and (stage_entered_at, id) < ($t, $id) and stage_entered_at <= $cutoff` | 51 |
| Mine / one owner | `deals_owner_board_idx` on `owner_id` | 51 |
| Won column (30 days) | `deals_org_closed_idx`, `status = 'won' and closed_at >= now() - 30 d` | ~560 scanned, 51 returned |
| Summary (team) | `deals_org_board_idx` on the ~2,000 open rows plus heap for value | 2,000 |
| Won this month / win rate | closed index ranges | 400 / ~1,500 |
| Deals tab | `company_id = $id` | ≤ 50 |

**Helpers** (STABLE, INVOKER, `grant execute … to authenticated`; private schema, so no endpoint)
- `private.stage_id(p_key text) returns uuid`: the caller's org stage by key (RLS: own org).
- `private.stage_key(p_id uuid) returns text`: null when the stage is invisible.
- `private.deal_undo_candidate(p_deal uuid, p_from text, p_to text, p_old_version integer) returns bigint`. It returns the deal's **latest** history row `h` when all of these hold:
  - `h.kind in ('move','won','lost','reopen')`;
  - `h.actor_id = auth.uid()`;
  - `h.created_at > now() - interval '120 seconds'`;
  - `h.to_stage = p_from` and `h.from_stage = p_to`;
  - `h.version_after = p_old_version`.

  Otherwise it returns null. `now()` is the transaction time, and history for a deal is written only under its row lock, so the guard and the AFTER trigger get the same answer (S9).
- `private.deal_closing_blocked(p_deal uuid) returns text`: **returns null in 5a.** Day 6 replaces it with `create or replace`, returning `'order'`, `'sales'` or `'reservation'`.
- `private.deal_card(p_id uuid) returns jsonb`: one card (the 5.6 fields) under RLS. Used by every write RPC's answer.

**`private.deal_guard()`** (SECURITY INVOKER; trigger **`guard_deal`** BEFORE INSERT OR UPDATE ON deals)
- The name sorts after `enforce_org_and_owner` (org set, owner rule run) and before `set_updated_at`.
- Sessions with no `auth.uid()` (fixtures, perf seed, maintenance) are skipped, as in Day 3a and 4a.
- Every raise is a constant message plus a hint.

*INSERT*
1. **Server-set:**
   - `created_by := caller`, `version := 0`, `status := 'open'`;
   - `closed_at`, `lost_reason` and `lost_note` become null;
   - `currency := 'EUR'`, `created_at := now()`, `stage_entered_at := now()`;
   - `owner_id := coalesce(owner_id, caller)` (G11);
   - `stage_id := private.stage_id('lead')`. A deal always opens at Lead.
2. **The lead:**
   - `company_id` null gives 22023 `lead_required`;
   - a lead in `do_not_contact` gives 22023 `dnc`;
   - whether the caller may change the lead is the policy's job.
3. **Pre-checks (22023):**
   - title trimmed, empty becomes null, then 1–120 safe characters (`deal_title`);
   - value null, or not NaN and between 0 and 100,000,000 (`value`);
   - `expected_close` between today − 1 year and today + 3 years (`bounds`);
   - fulfilment null or in the list (`fulfilment`).
4. **`source_activity_id`**, when set, must be the caller's own `call` on the same lead with outcome `interested` or `meeting_booked`, created under 10 s ago (42501 `source`). That is Day 4's task rule. It only ever comes from inside `log_activity`'s transaction (D17).
5. **Rate:** 30 or more deals created by the caller in the last hour gives 22023 `rate_limited` (one range read on `deals_created_by_idx`, `limit 30`).

*UPDATE*
1. `changed` = the columns that differ, except `updated_at`.
2. **FK exception (S5):** at `pg_trigger_depth() > 1`, when `changed <@ {contact_id, owner_id, created_by, source_activity_id}` and each changed value is null: `version := old.version + 1`, return.
3. **Never change** (42501 `not_editable`): `company_id`, `created_by`, `created_at`, `source_activity_id`, `request_id`, `currency`. `org_id` is held by `enforce_org_and_owner`.
4. **Reset the server columns** from `old`: `status`, `closed_at` and `stage_entered_at`, recomputed below.
5. **Stage changed:**
   - a. `v_from := key(old)`, `v_to := private.stage_key(new.stage_id)`. **Null (another org or unknown) gives 42501 `stage`**, which keeps `rls_attack.sql:299` passing.
   - b. `v_h := private.deal_undo_candidate(new.id, v_from, v_to, old.version)`.
   - c. **Undo (`v_h` found):**
     - `stage_entered_at`, `closed_at`, `value` and `fulfilment` come back from row `h` (`prev_stage_entered_at`, `prev_closed_at`, `value_before`, `fulfilment_before`);
     - `status` follows `v_to`; the lost fields stay as they are;
     - undoing a win checks `deal_closing_blocked` (42501 `blocked_<code>`);
     - client-sent value, fulfilment and lost fields are ignored in this branch.
   - d. **Ordinary move:**
     - into `won` or `lost` when `old.status <> 'open'`: 22023 **`reopen_first`** (D7);
     - **to `won`:** `value is not null and value > 0` (`value_required`) and `fulfilment is not null` (`fulfilment_required`). Then `status := 'won'`, `closed_at := now()`;
     - **to `lost`:** `lost_reason` in the list (`lost_reason_required`); `other` needs `lost_note` (`lost_note_required`); note pre-check (`lost_note`). Then `status := 'lost'`, `closed_at := now()`;
     - **to an open stage from `won`:** needs `private.has_recent_aal2(600)` (42501 `step_up`) and `deal_closing_blocked` null (42501 `blocked_<code>`). Then `status := 'open'`, `closed_at := null`;
     - **to an open stage from `lost`:** `status := 'open'`, `closed_at := null`. `lost_reason` and `lost_note` are **kept**, so undoing this reopen still has them, and the next Lose overwrites them;
     - always `stage_entered_at := now()`.
   - e. **Rate:** 120 or more history rows by the caller in 60 s gives 22023 `rate_limited` (history actor index, `limit 120`).
6. **Stage unchanged:**
   - on a closed deal, anything other than `title`, `contact_id` or `owner_id` gives 22023 `closed`;
   - on an open deal, `lost_reason` or `lost_note` changing gives 22023 `state`;
   - title, value, expected close and fulfilment pre-checks run when changed. A fulfilment change also checks `deal_closing_blocked`.
7. `version := old.version + 1` whenever `changed` is not empty, on every path.

**History (D4)**
```sql
create table public.deal_stage_history (
  id bigint generated always as identity primary key,
  org_id uuid not null references public.orgs (id),
  deal_id uuid not null references public.deals (id) on delete cascade,
  actor_id uuid,                                            -- no FK, like audit_log.actor_id
  kind text not null check (kind in ('open','move','won','lost','reopen','undo')),
  from_stage text check (from_stage in ('lead','qualified','negotiations','won','lost')),
  to_stage text not null check (to_stage in ('lead','qualified','negotiations','won','lost')),
  prev_stage_entered_at timestamptz, prev_closed_at timestamptz,   -- what an undo restores
  value_before numeric(14,2), value_after numeric(14,2),            -- value_after on won rows feeds analytics
  fulfilment_before text,
  lost_reason text,                                         -- the code on a 'lost' row; never the note
  version_after integer not null,
  undoes bigint references public.deal_stage_history (id) on delete cascade,
  created_at timestamptz not null default now(),
  check ((kind = 'undo') = (undoes is not null)),
  check ((kind = 'open') = (from_stage is null)));
create index deal_stage_history_deal_idx on public.deal_stage_history (deal_id, id desc);
create index deal_stage_history_actor_idx on public.deal_stage_history (actor_id, created_at desc);  -- rate guard, Mine feed
create index deal_stage_history_org_idx on public.deal_stage_history (org_id, created_at desc);      -- Team feed, org FK
create index deal_stage_history_undoes_idx on public.deal_stage_history (undoes) where undoes is not null;
alter table public.deal_stage_history enable row level security;
create policy require_mfa on public.deal_stage_history as restrictive to authenticated
  using ((select private.has_aal2())) with check ((select private.has_aal2()));
create policy deal_history_select on public.deal_stage_history for select to authenticated using (
  org_id = (select private.current_org_id())
  and exists (select 1 from public.deals d where d.id = deal_stage_history.deal_id));   -- deals RLS decides
revoke all on public.deal_stage_history from public, anon, authenticated;
grant select on public.deal_stage_history to authenticated;                            -- no insert, update or delete
```
- **`private.deal_history()`** is SECURITY DEFINER, `search_path = ''`, revoked from everyone. Two triggers call it:
  - `history_deal` AFTER INSERT writes the `open` row;
  - `history_deal_stage` AFTER UPDATE OF `stage_id` `WHEN (old.stage_id is distinct from new.stage_id)` writes one row from `OLD` and `NEW`.
- The `kind` comes from the keys: to won gives `won`; to lost gives `lost`; closed to open gives `reopen`; open to open gives `move`. When `deal_undo_candidate` matches, it gives `undo` with `undoes`.
- `actor_id := auth.uid()`. `version_after := new.version`.
- History is not audited: it is its own record. A deal delete cascades it, and the audit log keeps the deleted deal's row.

**Move records: `private.deal_moves`** (no API endpoint; replaces the custom-setting marker and the request-id setting)
```sql
create table private.deal_moves (
  history_id bigint primary key references public.deal_stage_history (id) on delete cascade,
  org_id uuid not null references public.orgs (id),
  user_id uuid not null,
  deal_id uuid not null references public.deals (id) on delete cascade,
  company_id uuid not null,                 -- no FK: a lead with deals cannot be deleted; keeps import_fk_coverage exact
  request_id uuid,
  prev_lead_status text, new_lead_status text,               -- null: this change did not touch the lead
  prev_next_action_at timestamptz, new_next_action_at timestamptz,
  created_at timestamptz not null default now());
create index deal_moves_user_idx on private.deal_moves (user_id, created_at);
create index deal_moves_deal_idx on private.deal_moves (deal_id);
create unique index deal_moves_request_idx on private.deal_moves (user_id, request_id) where request_id is not null;
-- RLS on; restrictive require_mfa; policy own rows (user_id = auth.uid() and org); grant select, insert, delete.
-- Not audited (no lead text). Every write RPC deletes the caller's rows older than 10 minutes.
```
- Each RPC open or move writes one row.
- The row serves **replay detection** (the same `p_request_id` returns the stored outcome) and the **lead compare-and-restore** on undo.
- A direct PATCH writes no row. It changes no lead and has no replay key.

**Policies (replace `deals_rw`)**
```sql
drop policy deals_rw on public.deals;
create policy deals_select on public.deals for select to authenticated using (
  org_id = (select private.current_org_id()) and ((select private.is_manager_or_admin()) or owner_id = (select auth.uid())));
create policy deals_insert on public.deals for insert to authenticated with check (
  org_id = (select private.current_org_id()) and ((select private.is_manager_or_admin()) or owner_id = (select auth.uid()))
  and exists (select 1 from public.companies p where p.id = deals.company_id                 -- a lead the caller may change
              and ((select private.is_manager_or_admin()) or p.owner_id = (select auth.uid())))
  and (contact_id is null or exists (select 1 from public.contacts k
       where k.id = deals.contact_id and k.company_id = deals.company_id))
  and exists (select 1 from public.pipeline_stages s where s.id = deals.stage_id));
create policy deals_update on public.deals for update to authenticated
  using (org_id = (select private.current_org_id()) and ((select private.is_manager_or_admin()) or owner_id = (select auth.uid())))
  with check (org_id = (select private.current_org_id()) and ((select private.is_manager_or_admin()) or owner_id = (select auth.uid()))
    and (contact_id is null or exists (select 1 from public.contacts k
         where k.id = deals.contact_id and k.company_id = deals.company_id))
    and exists (select 1 from public.pipeline_stages s where s.id = deals.stage_id));
create policy deals_delete on public.deals for delete to authenticated using (
  org_id = (select private.current_org_id()) and (
       ((select private.has_recent_aal2(600)) and (select private.is_manager_or_admin()))
    -- no code: my own untouched deal, opened under 120 s ago; one opened from a call only once that call's undo
    -- record is consumed (undo_activity), so the lead comes back first (Day 4 tasks_delete pattern)
    or (created_by = (select auth.uid()) and version = 0 and created_at > now() - interval '120 seconds'
        and (source_activity_id is null
             or not exists (select 1 from private.activity_undo u where u.activity_id = deals.source_activity_id)))));
```
- 5a needs `private.activity_undo` (4b), which is one reason 5a branches after 4c.
- PostgreSQL checks WITH CHECK after BEFORE triggers, so the guard's 42501 `stage` comes first for an invisible stage.

**Column grants (G1)**
```sql
revoke insert, update on public.deals from authenticated;
grant insert (company_id, contact_id, title, value, expected_close, fulfilment, owner_id, source_activity_id, request_id),
      update (title, value, expected_close, fulfilment, contact_id, owner_id, stage_id, lost_reason, lost_note)
  on public.deals to authenticated;
-- select and delete stay granted; RLS decides.
```

**Audit.** `private.audit_row` is recreated from its merged 4c body, with a deals rule:
- `version` joins the no-diff list;
- a `lost_note` diff becomes `{changed, old_len, new_len}`;
- a deleted deal carries `lost_note_len` instead of the text;
- `stage_id`, `status`, `value`, `fulfilment`, `owner_id`, `closed_at` and `stage_entered_at` stay audited with old and new values.

**Migration-order check** (`scripts/check-migration-order.sh`, a step in `db.yml`). It fetches `origin/main` and fails if any migration file added by the PR sorts at or before the newest file on main.

### 3.2 5b: `supabase/migrations/20261015120000_deal_links.sql` (renamed at merge if needed)

```sql
grant insert (deal_id) on public.activities to authenticated;
drop policy activities_insert on public.activities;
create policy activities_insert on public.activities for insert to authenticated with check (
  org_id = (select private.current_org_id()) and user_id = (select auth.uid())
  and exists (select 1 from public.companies c where c.id = activities.company_id)
  and (contact_id is null or exists (select 1 from public.contacts k
       where k.id = activities.contact_id and k.company_id = activities.company_id))
  and (deal_id is null or exists (select 1 from public.deals d                         -- visible AND same lead
       where d.id = activities.deal_id and d.company_id = activities.company_id)));
alter table private.activity_undo add column created_deal_id uuid;
```
- `activity_guard` already makes `deal_id` immutable after insert.
- **`log_activity`** is dropped and recreated from its merged 4b body. Four defaulted parameters are added at the end: `p_deal uuid default null, p_open_deal boolean default false, p_deal_title text default null, p_deal_value numeric default null`. Steps are in 5.1. The revoke/grant loop is the same.
- **`undo_activity`** is recreated (same signature). After the contact and lead locks and the lead restore, it deletes `created_deal_id` when `version = 0` and `created_by = me`, through the policy's creator branch (the undo record is already consumed). It returns `deal_removed` or `deal_kept`. Then come the task, reopen and activity steps as in Day 4.
- **`get_lead`** (same signature) adds:
  - `deals: {open_count, latest_open: {id, title, stage, value, stage_entered_at, is_stalled}}` under deals RLS;
  - `can_open_deal` (= `can_edit and lead_status <> 'do_not_contact'`).
- **`claim_next_lead`** cards add `open_deal: {count, latest: {id, stage, value}}`. The JSON stays backwards-compatible.

### 3.3 5c: `supabase/migrations/20261015150000_home_dashboard.sql` (renamed at merge if needed)

- Three STABLE INVOKER plpgsql functions with static IF branches per scope: `home_summary`, `home_attention`, `home_recent_activity` (5.8).
- **`public.home_low_stock(p_limit integer default 5) returns jsonb`** returns `null`. It is created inside a `DO` block only when `to_regprocedure('public.home_low_stock(integer)') is null`, so it works whichever of 5c and Day 6 merges first. Day 6 replaces it (section 10).
- No tables, no views, no materialised views.

### 3.4 Size budget (500 MB free tier)

| Item | Year-1 estimate |
|---|---|
| ~5,000 deals and indexes | ~4 MB |
| ~20,000 history rows and indexes | ~5 MB |
| Deal audit rows (version and lost note not copied) | ~8 MB |
| `private.deal_moves` (10-minute life) | < 1 MB |
| **Day 5 total on top of Day 4's ~255 MB** | **~18 MB → ~273 MB (55%)** |

## 4 RPCs, server actions and routes

Every RPC is revoked from `public, anon` and granted to `authenticated` through the Day 3a loop. Each hot one runs 10 times in perf, with plans 6 and later logged. `set plan_cache_mode = force_custom_plan` is added where a generic plan loses its index.

**Error contract** (extends Day 4's; messages never contain values)

| Code | Hints |
|---|---|
| 42501 | `step_up`, `not_editable`, `stage`, `source`, `lead_not_editable`, `scope`, `blocked_order`, `blocked_sales`, `blocked_reservation` |
| 22023 | `value`, `value_required`, `fulfilment`, `fulfilment_required`, `lost_reason_required`, `lost_note_required`, `lost_note`, `deal_title`, `bounds`, `closed`, `state`, `reopen_first`, `dnc`, `lead_required`, `fields`, `rate_limited`, `undo_expired`, `bad_cursor`, `bad_order`, `limit` |
| P0002 | not found or not visible (the same answer for both) |
| 23503 | `lead_has_deals` (lead delete); `deal_has_order` (Day 6 FK) |

**Results, not errors:**
- `{result: 'conflict', deal, changed_by_first_name}`;
- `{result: 'unchanged', deal}`;
- `replayed: true`.

`src/lib/db-errors.ts` maps all of these to:
- `conflict`;
- `needsValue`, `needsFulfilment`, `needsReason`;
- `reopenFirst`, `closed`;
- `step_up` (the `useStepUp().ensureFresh()` dialog, then retry);
- `blocked`, `forbidden`, `invalid`, `rate_limited`, `expired`, `not_found`, `unavailable`.

### 4.1 5a RPCs

| RPC | Who | What |
|---|---|---|
| `open_deal(p_company uuid, p_title text default null, p_value numeric default null, p_expected_close date default null, p_fulfilment text default null, p_contact uuid default null, p_owner uuid default null, p_request_id uuid default null) returns jsonb` | lead editors | 5.1. Replay on `(created_by, request_id)`. Returns `{deal: card, open_deal_count, replayed, lead_status_before, lead_status_after, undo_until}` |
| `move_deal(p_id uuid, p_stage text, p_expected_version integer, p_value numeric default null, p_fulfilment text default null, p_lost_reason text default null, p_lost_note text default null, p_undo_of bigint default null, p_request_id uuid default null) returns jsonb` | deal editors | Every stage change: move, win, lose, reopen, undo (5.2). `p_value`/`p_fulfilment` only with `won`; reason and note only with `lost` (22023 `state` otherwise). Returns `{result, deal, history_id, undone, undo_until, lead_status_before, lead_status_after, replayed}` |
| `update_deal(p_id uuid, p_expected_version integer, p_fields text[], p_title text, p_value numeric, p_expected_close date, p_fulfilment text, p_contact uuid, p_owner uuid) returns jsonb` | deal editors; owner changes managers/admins only (`enforce_org_and_owner`) | **Patch**: only the fields named in `p_fields` change (`p_fields <@ '{title,value,expected_close,fulfilment,contact_id,owner_id}'`, non-empty, else 22023 `fields`). One static UPDATE with `case when 'title' = any(p_fields) then p_title else title end`. Version compare gives a conflict result |
| `delete_deal(p_id uuid) returns void` | policy | Lead lock first. Inside the creator window: no code, and the lead is restored from the `open` move record (compare-and-restore). Otherwise `has_recent_aal2(600)` (42501 `step_up`), then manager/admin (42501). `deal_closing_blocked` (Day 6). 0 rows gives P0002; 23503 gives `deal_has_order` |
| `get_deal(p_id uuid) returns jsonb` | deals RLS; null when invisible | Card; lead `{id, name, city, country, lead_status, can_edit}`; contact; owner; `can_edit`; `can_delete`; `undo {history_id, until}` (my latest change while it is still undoable); `history[]` ≤ 50 with actor first names and undo pairs flagged; `activities[]` ≤ 5 linked to the deal (type, outcome, author, time; **no body**); `stall_days` |
| `pipeline_board(p_scope text default 'team', p_owner uuid default null, p_per_stage integer default 50) returns jsonb` | everyone; a rep's `team` or `p_owner` silently becomes `mine` | `{scope, stages: [{key, stall_days, count, value, no_value, stalled, cards[≤ p_per_stage], next}], won: {count, value, cards, next}, lost: {count, reasons: [{code, count}]}, open_total: {count, value}}`. One summary pass plus 4 index walks. `p_per_stage` 1–100 |
| `list_stage_deals(p_stage text, p_scope text default 'team', p_owner uuid default null, p_stalled_only boolean default false, p_order text default 'recent', p_after_at timestamptz default null, p_after_id uuid default null, p_limit integer default 50)` returns the card columns | `team` and `p_owner` for managers/admins (42501 `scope`) | 5.6. `won` and `lost` page by `(closed_at, id)` with no age limit ("See all won", "See lost deals"). Both cursor parts or neither (22023 `bad_cursor`). Limit 1–100 |
| `pipeline_summary(p_scope text default 'team', p_owner uuid default null) returns jsonb` | same scope rule (42501) | The summary part of the board, for the 30 s refresh |
| `list_lead_deals(p_company uuid, p_limit integer default 20)` | deals RLS | Open deals first, then closed by `closed_at desc`; `deals_company_idx` |

### 4.2 5b RPC changes

The 5b changes to `log_activity`, `undo_activity`, `get_lead` and `claim_next_lead` are described in 3.2 and 5.1.

### 4.3 5c RPCs

| RPC | Notes |
|---|---|
| `home_summary(p_scope text default 'team') returns jsonb` | 5.8 (K1–K8). A rep asking for `team` gets 42501 `scope` |
| `home_attention(p_scope text default 'team', p_limit integer default 5) returns jsonb` | Open deals that are stalled or close within 7 days. Order: close date passed, then most days over the limit, then soonest close. Returns `{items, total}` |
| `home_recent_activity(p_scope text default 'team', p_limit integer default 8) returns jsonb` | Activities and deal changes merged, **no `body` and no `lost_note` column** |
| `home_low_stock(p_limit integer default 5) returns jsonb` | Stub returning null until Day 6 |

### 4.4 Server actions

**`src/app/(app)/pipeline/actions.ts`**: `openDeal`, `moveDeal`, `winDeal`, `loseDeal`, `reopenDeal`, `undoDealMove`, `updateDeal`, `deleteDeal`. Each one:
1. parses with `z.strictObject` (schemas in `src/lib/deals.ts`);
2. calls `requireSession()`;
3. calls exactly one RPC;
4. returns `{ok:true, data}` or `{ok:false, error}`.

`winDeal`, `loseDeal`, `reopenDeal` and `undoDealMove` all call `move_deal`. `undoDealMove` sends `p_undo_of`. ESLint `no-console` covers every new server file.

```ts
// src/lib/deals.ts (literals shared with SQL through tests/unit/day5-parity.spec.ts)
export const stageKeys = ["lead", "qualified", "negotiations", "won", "lost"] as const;
export const openStageKeys = ["lead", "qualified", "negotiations"] as const;
export const lostReasons = ["price", "timing", "no_stock", "competitor", "no_response", "shipping", "mistake", "other"] as const;
export const fulfilments = ["from_stock", "direct_from_source"] as const; // Warehouse inventory / Supplier Stock
export const DEAL_VALUE_MAX = "100000000";
export const DEAL_UNDO_SECONDS = 120;
export const STALL_DAYS = { lead: 7, qualified: 14, negotiations: 21 } as const;
const money = z.string().regex(/^\d{1,9}(\.\d{1,2})?$/);
const version = z.int().min(0);
export const moveInput = z.strictObject({ id: z.uuid(), stage: z.enum(openStageKeys), version, requestId: z.uuid() });
export const winInput = z.strictObject({ id: z.uuid(), version, value: money, fulfilment: z.enum(fulfilments), requestId: z.uuid() });
export const loseInput = z.strictObject({ id: z.uuid(), version, reason: z.enum(lostReasons),
  note: z.string().trim().min(1).max(500).optional(), requestId: z.uuid() }).refine((v) => v.reason !== "other" || v.note);
export const undoInput = z.strictObject({ id: z.uuid(), historyId: z.int().positive(), toStage: z.enum(stageKeys), version });
```
- `parseMoney(input, locale)` turns "12 400,50" (FR, with NBSP or narrow NBSP) and "12,400.50" (EN) into `"12400.50"`. Anything else is refused.
- **Queue and lead actions** (4b/4c) extend their strictObject schemas with `deal?: uuid` and `openDeal?: {title?, value?: money}`.

### 4.5 Routes (GET only)

Every route uses `apiSession`, a Zod-parsed query and `Cache-Control: private, no-store`, has no side effects, and answers 400 for a bad cursor or scope.

| Route | Calls |
|---|---|
| `GET /api/pipeline/board?scope=&owner=` | `pipeline_board` |
| `GET /api/pipeline/stage?stage=&scope=&owner=&stalled=&order=&after_at=&after_id=` | `list_stage_deals` (403 for a rep's `team`) |
| `GET /api/pipeline/summary?scope=&owner=` | `pipeline_summary` |
| `GET /api/deals/[id]` | `get_deal` (404 for null) |
| `GET /api/leads/[id]/deals` | `list_lead_deals` |
| `GET /api/home?scope=` | `home_summary`, `home_attention`, `home_recent_activity`, `list_tasks('overdue'/'today','mine', 6)`, `home_low_stock` in parallel with `allSettled`; each part may be `null` |
| `GET /api/queue/summary` | `queue_summary` (added in 5c only if 4c has none) |

## 5 Flows

### 5.1 Opening a deal

**`open_deal`** (one transaction):
1. Validate. Zod has already checked; the guard checks again.
2. **Replay:** an existing `(created_by, request_id)` returns the stored deal with `replayed: true`. A concurrent 23505 is caught and answered the same way.
3. **Lead lock:** `select … from companies where id = p_company` (P0002 if invisible), then `for update`. No row means 42501 `lead_not_editable`. The lead lock serialises concurrent opens on one lead.
4. `insert into deals`. The guard sets the stage, clock, creator, owner and version; the history trigger writes the `open` row.
5. **Lead coupling:** `cold` or `cool_off` becomes `warm` (5.4).
6. Insert the `private.deal_moves` row for the `open` history row, with the lead before and after, and delete the caller's rows older than 10 minutes.
7. Return the card, `open_deal_count`, the lead before and after, and `undo_until`.

**From Interested or Book meeting** (`log_activity` with `p_open_deal`, 5b):
1. Before any write:
   - `p_open_deal` only with outcomes `interested` or `meeting_booked` (22023 `state`);
   - `p_deal` and `p_open_deal` cannot both be set;
   - deal title and value pre-checks (constant 22023).
2. Day 4 steps 2–7 run unchanged: replay, contact then lead lock, activity insert, lead update, tasks.
3. **Editable branch only:**
   - lead in `do_not_contact`: skip, `deal: {opened: false, reason: 'dnc'}`;
   - caller over the open rate: skip, `reason: 'rate_limited'`;
   - otherwise insert the deal with `source_activity_id = activity_id`, set `activity_undo.created_deal_id`, and return `deal: {id, opened: true, open_deal_count}`.
4. A non-editor gets `deal: {opened: false, reason: 'not_editable'}`. The call is always logged.
5. The lead change (cold → warm) is the outcome's, already recorded in `activity_undo`. Opening the deal adds none.

**From the board:** **New deal** (`N`) opens a lead combobox (`list_leads` with `p_search`, limit 8), then the open-deal sheet.

### 5.2 Moving, winning, losing, reopening (`move_deal`, one transaction)

1. **Validate** `p_stage` and the parameter mix.
2. **Replay:** a `private.deal_moves` row with `(user_id = me, request_id = p_request_id)` returns the stored outcome (`replayed: true`) and writes nothing.
3. Read the deal with no lock (P0002 if invisible). Already in `p_stage` returns `{result: 'unchanged'}`.
4. **Lock order: lead, then deal.**
   - If the move will touch the lead (target `negotiations`, `won` or `lost`; a reopen from `lost`; or an undo whose move record changed the lead), lock the lead first with `select … for update`. A row comes back only for editors, which sets `v_lead_editable`.
   - Then `select … from deals where id = p_id for no key update`.
5. `version <> p_expected_version`:
   - check replay again (a concurrent duplicate may have just committed);
   - otherwise return `{result:'conflict', deal: private.deal_card(p_id), changed_by_first_name}` (from the latest history row).
6. `v_h := deal_undo_candidate(...)`, read after the lock, so it is authoritative.
   - If `p_undo_of` is set and `v_h` is not that id, raise 22023 `undo_expired` before writing.
   - A won deal moving to an open stage with no candidate and no `has_recent_aal2(600)` raises 42501 `step_up` before writing; the guard checks again.
7. Update:
   ```sql
   update deals set stage_id = private.stage_id(p_stage),
     value = coalesce(p_value, value),
     fulfilment = coalesce(p_fulfilment, fulfilment),
     lost_reason = coalesce(p_lost_reason, lost_reason),
     lost_note = coalesce(nullif(btrim(p_lost_note), ''), lost_note)
   where id = p_id
   ```
   The guard derives status, times and version, or restores them on undo. The AFTER trigger writes history.
8. `v_history := (select id from deal_stage_history where deal_id = p_id order by id desc limit 1)`. Safe, because the row lock is held.
9. **Lead:**
   - **undo:** compare-and-restore from the candidate's `deal_moves` row, then delete that row;
   - **otherwise**, when `v_lead_editable`: apply 5.4 and insert `deal_moves (history_id = v_history, …)`. A move that did not touch the lead still inserts a row with null lead fields when `p_request_id` is set, so replay works.
10. Return the result.

### 5.3 Undo

- **The toast and `U`/⌘Z** send `undoDealMove`, which calls `move_deal(p_stage = h.from_stage, p_expected_version = version from the move result, p_undo_of = h.id)`. Outside the window, or after a colleague's change, the answer is `undo_expired` or `conflict`, and nothing is written.
- **Dragging back by hand** within 120 s, with nothing changed since, is the same undo, because the guard decides. After that it is an ordinary move: the clock restarts, and reopening a won deal asks for the code.
- **Only the single latest change is undoable.** Moving again after an undo is an ordinary move.
- **Undo of an open** is `delete_deal` within the creator window. **Undo of an Interested outcome** is `undo_activity`, which removes the untouched deal.
- **Where Undo is offered:** the toast (10 s, using 4b's option); the card menu and the deal sheet for 120 s (`get_deal.undo`).

### 5.4 The lead follows its deal (recommended; open question 1; INVOKER RPCs only, editors only)

| Event | Lead status now | Becomes | `next_action_at` |
|---|---|---|---|
| Deal opened (`open_deal`) | cold, cool_off | warm | unchanged |
| To Negotiations | cold, warm, cool_off | negotiation | unchanged |
| To Closed/won | cold, warm, negotiation, cool_off | customer (the queue never serves it) | unchanged |
| To Closed/lost, and no other **visible** open deal on the lead | warm, negotiation | cool_off | `now() + 90 days` (Day 4's Not interested rule) |
| Reopened from Lost | cool_off | warm (negotiation when reopened into Negotiations) | unchanged |
| Reopened from Won; Lead ↔ Qualified moves | — | unchanged | unchanged |
| **Undo** of any of the above | still equal to what the change wrote | back to the value before | back too, if it still equals what was written |
| Any event | do_not_contact, disqualified | **never touched** | |

- `lead_guard` (4b) and `audit_row` fire normally, so lead status changes are audited.
- A direct PATCH of `stage_id` changes no lead (residual risk 2).

### 5.5 Days in stage and stalled (D16)

- **Days in stage** = `floor(extract(epoch from now() - stage_entered_at) / 86400)`: elapsed days, with no time zone. Shown as "Today", "1 day" or "12 days in stage" (ICU plural); "Won 3 Oct" in the Won column.
  - The browser uses next-intl's per-request `now` (a Day 3a lesson). The board keeps one `now`, refreshed with each 30 s refetch.
- **Stalled**, in SQL only:
  ```sql
  d.status = 'open' and greatest(d.stage_entered_at, coalesce(c.last_activity_at, '-infinity')) < now() - make_interval(days => s.stall_days)
  ```
  `pipeline_board`, `list_stage_deals`, `get_deal`, `list_lead_deals`, `home_summary` and `home_attention` all return `is_stalled` and `quiet_days` (days since the greater of the two dates).
- **Stalled only** is an index range `stage_entered_at <= now() - stall_days` (a necessary condition), plus a filter on the joined lead.
- After an optimistic move the card shows 0 days and not stalled, which is always true: its stage clock just restarted. An undo shows what the server returns.
- **Shared cases:** about 24 cases between `days-in-stage:start/end` and `stall-cases:start/end` markers, in `tests/unit/days-in-stage.spec.ts` and `deals_attack.sql`. They cover:
  - 7 × 24 h minus 1 ms, and exactly 7 × 24 h;
  - the 25 Oct 2026 EU and 1 Nov 2026 US clock changes;
  - a deal opened today on a lead untouched for a month (not stalled);
  - a call yesterday on a deal 30 days in stage (not stalled);
  - an undo restoring a 10-day clock.

### 5.6 Board data

- **Index paths.** `p_owner`, or "mine", uses `deals_owner_board_idx` with `owner_id = coalesce(p_owner, auth.uid())`. Team uses `deals_org_board_idx`.
- **One static statement per path** (6 in all: owner or org × {open recent, open oldest, closed}). The cursor defaults to the far end, so the index condition is always present:
  ```sql
  … where d.status = 'open' and d.org_id = v_org and d.stage_id = v_stage
        and (d.stage_entered_at, d.id) < (coalesce(p_after_at, 'infinity'), coalesce(p_after_id, 'ffffffff-ffff-ffff-ffff-ffffffffffff'))
        and d.stage_entered_at <= v_cutoff                     -- 'infinity' unless stalled-only
        and (not p_stalled_only or coalesce(c.last_activity_at, '-infinity') < v_cutoff)
  order by d.stage_entered_at desc, d.id desc limit p_limit + 1
  ```
- **Card columns:** `id, stage, title, company_id, company_name, city, country, lead_status, contact_name, value (text), currency, status, stage_entered_at, closed_at, expected_close, fulfilment, owner_id, owner_first_name, owner_last_name, version, last_activity_at, is_stalled, quiet_days, lost_reason, can_edit`.
- `can_edit` is the owner or a manager/admin. A future rep sees only their own deals anyway.

### 5.7 Concurrency and lock order

- **Global order: contact → lead → deal.** A lead lock is taken only by editors; for non-editors it returns no row and locks nothing.

| Path | Locks, in order |
|---|---|
| `log_activity` (+`p_deal`, +`p_open_deal`) | contact (wrong number) → lead `FOR UPDATE` → activity insert (`FOR KEY SHARE` on the deal through the FK) → deal insert |
| `undo_activity` | contact → lead → **deal delete** → task, then activity |
| `move_deal` | lead `FOR UPDATE` (only when touching it) → deal `FOR NO KEY UPDATE` |
| `open_deal` | lead `FOR UPDATE` → deal insert |
| `delete_deal` | lead `FOR UPDATE` → deal delete (`FOR UPDATE`) |
| `update_deal`, direct PATCH | deal `FOR NO KEY UPDATE` only |

- `FOR NO KEY UPDATE` does not conflict with an activity insert's `FOR KEY SHARE`. A move that does not touch the lead therefore never waits behind `log_activity(p_deal)`. Every path that touches both locks the lead first, so no cycle is possible (S8).
- **Two people, one deal.** Both read version 4. A's move commits version 5. B's waits for the row lock, sees 5 ≠ 4 and gets `conflict`. B's card springs to the server stage, with "Haider moved this deal a moment ago". History has one row.
- **One person, quick keys:** TanStack `scope: {id: 'deal-'+id}` runs the moves in series. Each `mutationFn` reads the latest cached version (S12). A failure rolls back that move and the ones queued behind it.
- **Replays:** opens by `(created_by, request_id)`; moves by `deal_moves (user_id, request_id)`.

### 5.8 Home figures: exact meaning (`home_summary`)

**Variables:**
```sql
v_me := auth.uid();  v_org := private.current_org_id();
v_team := p_scope = 'team';   -- 42501 'scope' unless private.is_manager_or_admin()
v_tz := coalesce((select timezone from public.profiles where id = v_me), 'Europe/Paris');   -- 4c validates it
v_today := (now() at time zone v_tz)::date;
v_day_start := v_today::timestamp at time zone v_tz;
v_day_end := (v_today + 1)::timestamp at time zone v_tz;                      -- a 23 h or 25 h day stays one day
v_month_start := date_trunc('month', v_today)::timestamp at time zone v_tz;
```
- `[scope]` means `d.owner_id = v_me` in the Mine branch and `d.org_id = v_org` in the Team branch. They are separate static statements, each with a fixed index condition.
- Each part is timed with `clock_timestamp()` markers in `perf_day5.sql`.

| # | Figure (EN / FR) | Exact meaning (SQL) | Index; rows at the seed | Budget |
|---|---|---|---|---|
| K1 | **Open pipeline** / Pipeline en cours | `count(*), coalesce(sum(d.value),0), count(*) filter (where d.value is null), count(*) filter (where <stalled>)` from `deals d join pipeline_stages s on s.id = d.stage_id join companies c on c.id = d.company_id where d.status = 'open' [scope]` | `deals_*_board_idx`; 2,000 open (team) | ≤ 4 ms |
| K1b | By stage (Pipeline card) | K1 grouped by `s.key, s.position` | same scan | (in K1) |
| K2 | **Won this month** / Gagné ce mois-ci | `count(*), coalesce(sum(value),0) from deals where status <> 'open' and status = 'won' and closed_at >= v_month_start [scope]`. Current status counts: a reopened deal leaves the figure | `deals_*_closed_idx`; ~400 | ≤ 2 ms |
| K3 | Win rate (90 days), Pipeline card | `won ÷ (won + lost)`: `count(*) filter (where status = 'won')`, `count(*) filter (where status = 'lost' and lost_reason <> 'mistake')` `from deals where status <> 'open' and status in ('won','lost') and closed_at >= now() - interval '90 days' [scope]`. Shown only when the denominator is 5 or more | closed index; ~1,500 | ≤ 2 ms |
| K4 | **Calls today** / Appels aujourd'hui | Mine: `count(*), count(*) filter (where outcome in ('connected','interested','meeting_booked','not_interested','do_not_contact'))` `from activities where user_id = v_me and created_at >= v_day_start and type = 'call'`. Team: the same per person, `from profiles p cross join lateral (… a.user_id = p.id …)` (profiles RLS: own org) | `activities_user_created_idx`; ~150 per person | ≤ 2 ms |
| K5 | **Tasks due** / Tâches à faire | `public.count_tasks('mine')` (4c, profile zone): number = `today + overdue`, sub-line "2 overdue". **Always mine** | 4c `tasks_assignee_open_idx` | ≤ 5 ms (4c P5) |
| K6 | Meetings today (calm line) | `count(*) from tasks where assignee_id = v_me and kind = 'meeting' and done_at is null and cancelled_at is null and due_at >= v_day_start and due_at < v_day_end` | `tasks_assignee_open_idx` | ≤ 1 ms |
| K7 | New leads (7 days), Work queue card | `count(*), count(*) filter (where import_batch_id is not null) from companies where org_id = v_org and created_at >= now() - interval '7 days'`. Leads are org-wide, so scope does not apply | `companies_created_keyset_idx` plus heap; import week 30k | ≤ 1 ms normally, ≤ 15 ms import week |
| K8 | Attention counts | Over K1's rows: stalled; closing soon (`expected_close between v_today and v_today + 7`); close passed (`expected_close < v_today`) | same scan | (in K1) |

**`home_attention`** reads the same open-deal scan, takes up to 5 rows (order in 4.3), and returns card fields plus `reason in ('overdue','stalled','closing')`.

**`home_recent_activity`:**
- **Activities:** Mine is `user_id = v_me order by created_at desc limit 8`. Team is `profiles p cross join lateral (… where a.user_id = p.id order by a.created_at desc limit 8)`, then the top 8. That is one ordered index scan per person, never a sort over 300k rows.
- **Deal changes:** Mine uses the actor index; Team uses the org index. `kind <> 'undo' and not exists (select 1 … where u.undoes = h.id)`, limit 8.
- The two are merged and cut to 8. Columns: `kind, type, outcome, to_stage, value (won rows only), company_id, company_name, user_first_name, at`. There is **no body and no note**.

**Total `home_summary`** ≤ 30 ms team, ≤ 25 ms mine, ≤ 45 ms in an import week.

## 6 Security: threats and how each is blocked

SQL tests are in `supabase/tests/{deals,deal_links,home}_attack.sql` and `deal_concurrency.sh`; e2e tests in `tests/auth/*`.

| # | Threat | Control | Tests |
|---|---|---|---|
| 1 | Stolen aal1 session | restrictive `require_mfa` on deals, history, stages and `deal_moves`; RPCs give nothing | `day5_aal1_blocked` (every new RPC: 0 rows, null or 42501), `home_aal1_blocked` |
| 2 | Another org's deals, stages, history or figures | `org_id` in every policy; `enforce_org_and_owner`; org-scoped stage helpers; INVOKER figures | `other_org_deal_invisible`, `other_org_stage_refused_42501`, `other_org_history_invisible`, `kpi_ignores_other_org`; e2e `api_refuses_other_org_deal` |
| 3 | IDOR: reading or moving a colleague's deal | deals RLS; P0002 for missing and invisible alike; `get_deal` null gives 404 | `rep_cannot_move_others_deal_p0002`, `rep_get_other_deal_null`; e2e `rep_get_other_deal_404` |
| 4 | Opening a deal on a lead the caller cannot change, or with another lead's contact | insert policy; `open_deal` lead lock | `open_deal_on_colleagues_lead_42501`, `open_deal_contact_other_lead_42501` |
| 5 | **Forging server columns** (G1) | column grants; the guard sets status, clock, close time, version, creator, currency and the insert stage | `deal_insert_columns_exact`, `deal_update_columns_exact`, `deal_status_not_writable`, `deal_stage_entered_at_not_writable`, `deal_closed_at_not_writable`, `deal_version_not_writable`, `deal_created_by_forced`, `deal_insert_stage_not_writable`, `deal_opens_at_lead` |
| 6 | **Invalid transitions** (G2), including **closed → closed** | guard matrix; `reopen_first` | `transition_matrix` (5 × 5 from/to × value / fulfilment / reason / note / fresh code / undo), `insert_at_won_refused`, `won_needs_value_gt_0`, `won_needs_fulfilment`, `lost_needs_reason`, `lost_other_needs_note`, `won_to_lost_refused`, `lost_to_won_refused`, `deal_company_immutable` |
| 7 | **Rewriting won sales** (reopen, value edit, back-dated win) | reopen-won needs a fresh code; closed deals frozen; `closed_at` is server time | `reopen_won_stale_code_denied`, `reopen_won_fresh_code_ok`, `undo_own_win_within_120s_no_code`, `closed_value_frozen`, `closed_at_is_server_time` |
| 8 | **Value tampering** (NaN, Infinity, negative, huge, extra decimals) | CHECK plus guard pre-check; decimal strings; audit diff of value | `value_nan_refused`, `value_infinity_refused`, `value_negative_refused`, `value_over_cap_constant_error`, `audit_deal_value_change_logged`; unit `parse_money_*` |
| 9 | **Forging or erasing history** | select-only grant; revoked DEFINER trigger built from NEW/OLD; actor forced; undo appends | `history_insert_denied`, `history_update_denied`, `history_delete_denied`, `history_row_per_stage_change`, `history_actor_forced`, `history_no_row_without_stage_change`, `history_written_on_direct_patch`, `deal_history_not_callable` |
| 10 | Stage tampering (rename, reorder, flip won/lost) | all stage writes revoked; key and flag CHECKs; unique key per org | `stage_write_denied_even_admin`, `one_won_one_lost_per_org`, `stage_key_flags_consistent`; e2e `stage_write_refused_via_rest` |
| 11 | **Two people move one deal** | row lock plus version; per-deal client queue | `two_movers_one_conflict`, `win_vs_lose_one_closes`, `move_vs_update_value_one_conflict`, `history_chain_consistent`; e2e `two_users_move_same_deal_one_conflict` |
| 12 | Deadlocks across deals, activities and leads | contact → lead → deal everywhere; `FOR NO KEY UPDATE` | `move_vs_log_activity_with_deal_no_deadlock`, `undo_activity_vs_log_activity_with_deal_no_deadlock`, `delete_deal_vs_log_activity_with_deal_no_deadlock` (`deadlock_timeout = 200ms`) |
| 13 | Double submit or replay | `(created_by, request_id)` on deals; `deal_moves (user_id, request_id)` | `open_deal_idempotent`, `open_deal_replay_parallel_once`, `move_replay_returns_stored`, `move_replay_parallel_once`, `request_id_other_author_no_collision` |
| 14 | **Undo abuse** (a colleague's move, after the window, after a change, undo of an undo) | one candidate function: own, latest, 120 s, `version_after`; values only from server rows; `p_undo_of` refuses a stale undo | `undo_restores_clock_close_value_fulfilment`, `reverse_by_other_user_is_ordinary_move`, `reverse_after_121s_is_ordinary_move`, `reverse_after_colleague_edit_is_ordinary`, `undo_of_undo_is_ordinary`, `undo_of_expired_refused_no_write`, `undo_of_reopen_from_lost_keeps_reason` |
| 15 | **Deleting without a code**, or erasing sales | admin plus fresh code; the creator's untouched 120 s branch only once the call's undo record is consumed | `deal_delete_stale_code_denied`, `deal_delete_rep_fresh_code_denied`, `deal_delete_admin_fresh_code_ok`, `deal_delete_creator_within_120s_untouched_ok`, `deal_delete_after_move_needs_code`, `deal_direct_delete_refused_while_activity_undo_record`; e2e `delete_deal_asks_for_code` |
| 16 | Orphan deals; lost tasks; import undo removing a lead with a deal | `company_id not null` with FK restrict; `tasks.deal_id` set null plus `task_guard`; untouched rule | `lead_with_deal_delete_23503`, `deal_delete_keeps_activities_and_tasks`, existing `import_undo_keeps_lead_with_deal` |
| 17 | An activity linked to another lead's or an invisible deal | insert policy (same lead and visible); 4a immutability | `activity_deal_other_lead_refused`, `activity_deal_invisible_refused`, `activity_deal_id_immutable` |
| 18 | **Figures leaking rows** | INVOKER only; no views, MVs or DEFINER; scope checked first; no text in the feed | `rep_kpis_equal_own_rows`, `admin_team_kpis_equal_org_rows`, `rep_team_scope_42501`, `rep_board_team_falls_back_to_mine`, `recent_activity_has_no_body` (column list checked in `pg_proc`); splinter: 0 `security_definer_view`, 0 `materialized_view_in_api` |
| 19 | Lead side effects on a lead the caller cannot change; DNC or Disqualified overwritten | lead `FOR UPDATE` returns no row for non-editors; closed table; compare-and-restore | `non_editor_move_no_lead_change`, `coupling_table` (events × 7 statuses × editor/non-editor), `win_never_overrides_dnc`, `coupling_never_touches_disqualified`, `undo_restores_lead_only_if_unchanged` |
| 20 | Owner reassigned by a rep, or set outside the org; ownerless deals | `enforce_org_and_owner`; guard default | `rep_cannot_reassign_deal`, `owner_must_be_org_member`, `owner_defaults_to_creator` |
| 21 | XSS, bidi or control characters; values in logs | safe-character CHECKs plus constant pre-checks; React text only; plain-text announcements | `deal_title_bidi_refused`, `deal_bad_value_constant_error` (planted text absent from SQLERRM and DETAIL); e2e `xss_deal_title_is_text` |
| 22 | **Flooding** history, audit and deals (for example a stolen aal2 session) | 30 opens an hour; 120 stage changes a minute; page limits | `open_deal_rate_limited`, `move_rate_limited`, `limit_bounds_22023` |
| 23 | CSRF | server actions' Origin check; GET routes read-only | e2e `cross_site_move_action_refused` |
| 24 | Browser clock or zone used for "today" or "this month" | server `now()` plus the profile zone | `kpi_month_boundary_karachi_vs_paris`, `calls_today_profile_zone` |
| 25 | Direct REST writes to history, stages or forbidden columns; private tables exposed | grants; the `private` schema has no endpoint | e2e `history_table_write_refused` (POST/PATCH/DELETE on `/rest/v1/deal_stage_history`), `deal_patch_status_column_denied`, `private_deal_moves_not_exposed` (404, and `Accept-Profile: private` gives 406) |
| 26 | Noisy or leaky audit | deals audited; `version` not diffed; `lost_note` masked | `audit_deal_insert_update_delete_rows`, `audit_version_not_diffed`, `audit_lost_note_masked` |
| 27 | Opening deals on a Do not contact lead | guard `dnc`; `log_activity` skips | `open_deal_on_dnc_refused`, `log_activity_open_deal_dnc_skipped` |
| 28 | SQL or filter injection | static SQL; whitelisted scopes, orders, stages, reasons and fields; Zod | `bad_scope_22023`, `bad_order_22023`, `update_deal_bad_field_22023`; e2e titles `'); drop table deals;--` and `),id.eq.` stored verbatim |
| 29 | A custom setting read with a bare cast | none exists; lint | unit `sql-guc.spec.ts` |
| 30 | Day 6 seam misuse | `deal_closing_blocked` returns a code only; Day 6 replaces it; contract | `closing_blocked_stub_null`; Day 6's own tests |
| 31 | The drag UI as an attack vector (CSP, injected styles) | dnd-kit writes style attributes only (allowed); S10 checks | e2e `no_console_errors_no_csp_violations` on `/pipeline` |

**Residual risks accepted** (written into each `security-review.md`):
1. A stolen aal2 session without a fresh code can:
   - move, win and lose its own deals;
   - undo its own change within 2 minutes;
   - delete a deal it opened in that window and never touched.

   Everything is audited and has history. It cannot reopen a won deal after 2 minutes, or delete other deals.
2. A direct PATCH of `stage_id` follows every deal rule but skips the lead coupling. That is cosmetic: the lead's status stays editable by its editors.
3. Deal visibility stays owner, manager or admin. A future rep sees "No deal yet" on a colleague's lead that has a deal, and the Lost coupling check sees only visible deals (open question 5).
4. Anyone in the org can reset a deal's stalled clock by logging an activity on its lead. That is audited, and it is not a permission.
5. Haider, Henri and Kais are all admins, so today each of them can do everything in the matrix. The rules matter for future hires and stolen sessions.
6. A colleague's move can take up to 30 s to appear. Any action against it gets `conflict` and the latest state.

## 7 UX (DESIGN.md is the source of truth)

General rules:
- Outfit for text; **DM Mono** for values, counts, days and KPI numbers (tabular, so a count-up never wobbles).
- **Signal Red** only on the one primary action per screen, with black text: **New deal** on Pipeline, **Start calling** on Home.
- Status is a dot plus a word.
- 8 pt grid; radius 20 (cards, columns), 12 (controls), 24 (sheets).
- Shadow only on the dragged card, sheets and menus. Skeletons, never spinners.
- Taste Skill dials 3/5/7 before building.

### 7.1 Pipeline layout (`src/app/(app)/pipeline/page.tsx`, `loading.tsx`)

**The server page:**
- calls `requireSession()`;
- starts `pipeline_board(defaultScope)` as a promise (cache-first, D32) and `list_team`;
- passes both to `PipelineView`.

**`loading.tsx`** matches block for block: header, then 4 columns × 3 card skeletons of 120 px (at 390, the tab strip plus one column). It is measured against the real page at 390 and 1440 (Day 2 method).

| Width | Layout |
|---|---|
| 1728 / 1440 | Content max 1440. **Header:** "Pipeline" (h1); totals badge "18 open · €182,400" (DM Mono); segmented Team · Mine (managers/admins); owner chips (Team); "Stalled only" chip with a count; sort menu (Recently moved · Longest in stage · Value* · Close date*, where * means the loaded cards); **New deal** (red). **Board:** `repeat(4, minmax(220px, 1fr))`, gap 16. Each column scrolls vertically on its own and has a sticky header ("Qualified · 9 · €48,200 · 2 stalled"). Height `calc(100dvh - header - 152px)` keeps the dock clear. **Under the board:** "Lost in the last 30 days: 2 · Price 1 · Timing 1 · See lost deals" |
| 1280 | Same |
| 1024 | Same, gap 12. 4 × 220 + 3 × 12 = 916 px ≤ 960 px of content, so no sideways scroll. Names wrap to 2 lines; the owner avatar moves under the value |
| 768 | Toolbar on two rows. The board is its own horizontal scroller with 2 columns visible (`calc((100% - 12px) / 2)`) and `scroll-snap-type: x mandatory`; the page never scrolls sideways. Two-finger swipe and momentum are native |
| 390 | Title and totals; owner chips scroll in their own row; **sticky stage tabs** ("Lead 5 · Qualified 3 · Négo. 2 · Won 4"), synced both ways with the column in view (IntersectionObserver); a tap scrolls to the column (instantly under reduced motion). Columns are `calc(100vw - 48px)` with a 16 px peek of the next. The page scrolls vertically, with no inner column scroll and pages of 30 behind "Show more". **New deal** full width. A tap opens the deal sheet; a long press drags |

**States**

| State | What shows |
|---|---|
| Loading | `loading.tsx` |
| No deals in the org | Columns read "No deals here". A calm card above the board: "No deals yet. Deals open when a lead says they're interested, from the work queue or the lead page." with **Open the work queue** and **New deal** |
| Mine empty, team has deals | "You have no deals. Show the team's" |
| Empty column | "No deals in Qualified". It is still a drop target. In Lead: "Mark a call Interested, or press N." |
| Filtered empty | "No deals match. Clear filters" |
| More than loaded | Column footer "Show 50 more" (keyset) and "Showing 50 of 240" |
| Value / Close date sort with more rows | "Sorted among the 50 shown" |
| Column page error | "Couldn't load more · Retry" at the end of the column; loaded cards stay |
| Board error | `(app)/error.tsx` keeps the shell and dock, with Retry. A failed refetch keeps the cards and shows "Couldn't refresh · Retry" in the toolbar |
| Offline | Dragging off; the chip "You're offline · moves are paused" |
| Conflict | The card springs to the server stage; toast "Henri moved this to Negotiations a moment ago." |
| Step-up | Reopen-won and Delete open "Confirm it's you" (`StepUp.bodyReopenWon`, `StepUp.bodyDeleteDeal`) |
| Read-only card (future role mix) | No drag, chip or edit; "Only {owner} or an admin can change this deal" |
| Lead is Do not contact | Red-dot badge "Asked not to be contacted". Moves stay allowed, to close the deal |
| Reduced motion | Instant placement with a fade of at most 120 ms |

### 7.2 Card anatomy (`deal-card.tsx`, 120 px at 1440; `li > article`)

- **Line 1:** lead name (Outfit 700 15/20, 2 lines at most); owner initials (24 px, Team view, full name in `title` and in screen-reader text).
- **Line 2:** title, or the contact's name (muted 13).
- **Line 3:**
  - value (DM Mono 500, `Intl.NumberFormat(locale, {style: 'currency', currency: 'EUR', maximumFractionDigits: 0})`, so FR shows "12 400 €"), or "Add value" (`E`);
  - a **Supplier Stock** chip when `direct_from_source`;
  - on the right, the next-step chip ("→ Qualified", "→ Negotiations", or **Mark won** in Negotiations) and a ⋯ button.
- **Line 4, one of:**
  - "12 days in stage";
  - "12 days in stage · ● Stalled" (amber dot plus word; `title` and screen-reader text "No move or contact for 16 days. Usually under 14 days in Qualified.");
  - "Close date passed · 30 Sep" (red text token plus the words);
  - "Closes Fri";
  - "Won 3 Oct" in the Won column.
- **Semantics:**
  - a stretched **main button** holds the visible text and is the dnd-kit activator (`setActivatorNodeRef`);
  - the chip and ⋯ are sibling buttons layered above it, so no interactive control is nested inside another;
  - press feedback is scale 0.97 within 100 ms, cancelled when a drag starts; hover is a tint, never a lift.
- **Menu** (⋯, right-click through `src/components/ui/context-menu.tsx`, Shift+F10 or the ContextMenu key):
  - Move to ▸ (with 1–3);
  - Mark won… (4), Mark lost… (5);
  - Reopen… (closed deals);
  - Edit value (E);
  - Open lead (O);
  - Copy link;
  - Undo last move (U, 120 s);
  - Delete… (code).

### 7.3 Drag with dnd-kit (`src/components/pipeline/drag-layer.tsx`)

**Context.**
```tsx
<DndContext id="pipeline-board" sensors={sensors} collisionDetection={pointerFirst}
  measuring={{ droppable: { strategy: MeasuringStrategy.WhileDragging } }}
  autoScroll={{ threshold: { x: 0.15, y: 0.2 }, acceleration: 12 }}
  accessibility={{ announcements, screenReaderInstructions }} …>
```
- `pointerFirst` uses `pointerWithin` and falls back to `rectIntersection` (keyboard, touch).
- Columns use `useDroppable({id: stageKey})`, plus the `lost` band. Cards use `useDraggable({id, data: {stage, version}})`. There is no sortable and no in-column order.

**Sensors:**
- `useSensor(MouseSensor, {activationConstraint: {distance: 6}})`, so a click still opens the sheet;
- `useSensor(TouchSensor, {activationConstraint: {delay: 250, tolerance: 8}})`, so a swipe still scrolls. `navigator.vibrate(8)` fires on pickup where supported;
- `useSensor(KeyboardSensor, {coordinateGetter: columnJump, keyboardCodes: {start: ['Space'], cancel: ['Escape'], end: ['Space', 'Enter']}})`. `Enter` on a focused card opens the sheet when no drag is active.

**`columnJump`** (`coordinate-getter.ts`, unit-tested):
- ←/→ return the centre of the previous or next droppable, in the order Lead, Qualified, Negotiations, Won, Lost;
- at 390, ↑/↓ do the same; elsewhere they are a no-op;
- each jump calls `scrollIntoView({inline: 'center', block: 'nearest'})`.

**Lost band:**
- rendered only while dragging, fixed above the dock at `bottom: calc(104px + env(safe-area-inset-bottom))`, `min(560px, 100% - 32px)` wide, centred;
- reads "Drop here to mark as lost" and enters with `snappy`;
- over a column, the column takes the muted surface token and its header reads "Drop to move here";
- over Won, the header reads "Drop to mark won". No colour accent.

**Overlay:** `DragOverlay dropAnimation={null}`, lifted to scale 1.03 with the floating-layer shadow. The source card stays at 40% opacity as the "from" marker. While dragging, the board sets `data-dragging`, which turns off `scroll-snap-type`.

**Drop rules:**
- same column: no-op;
- open stage: optimistic `moveDeal`;
- Won: the card waits in Won at 60% opacity ("Confirm the win") and the **Win dialog** opens;
- Lost band: the **Lose dialog** opens;
- Cancel or Esc in a dialog is a drag cancel, and the card springs back.

**Virtualisation:** a column with more than 60 loaded cards uses TanStack Virtual (`estimateSize: 128`, `measureElement`, `overscan 6`). Its `rangeExtractor` always includes the active index (S10). The droppable is the column, so unmounted cards never matter. Cards are `React.memo` keyed by `id + version`.

### 7.4 Spring settle and motion (springs from `src/lib/motion.ts`; transform and opacity only; interruptible)

**Settle** (`settle.ts`):
1. `onDragEnd` stores `{id, from: active.rect.current.translated, token}`.
2. The optimistic update places the card at its sorted position. Under "Recently moved" that is the top.
3. In a layout effect keyed by `token`, if the card is unmounted or outside the column's view, first `virtualizer.scrollToIndex(i, {align: 'center'})` or `scrollIntoView({block: 'nearest'})`, instantly. Then measure.
4. Run `animate(el, {x: [dx, 0], y: [dy, 0], scale: [1.03, 1]}, springs.smooth)`.
5. Grabbing the card mid-settle starts the overlay from its current `getBoundingClientRect()`.

| Moment | Motion | Reduced motion |
|---|---|---|
| Pick up | overlay scale 1.03, `snappy`; source to 40% | no scale; instant ghost |
| Drag | overlay follows the pointer 1:1 | same (direct manipulation stays) |
| Drop on an open column | the settle above; neighbours in both columns use Motion `layout="position"` (`smooth`) | card appears in place, fade ≤ 120 ms |
| Win or Lose confirmed | Won card turns solid; a lost card fades and scales to 0.96 (`gentle`) and the lost line ticks | instant |
| Cancel, conflict, error, Undo | the same FLIP back from where the card is now | instant |
| Keyboard move (Shift+→, digits) | the settle from the card's old rect | instant |
| Column totals | 120 ms opacity cross-fade (no count-up on the board) | instant |
| Deal sheet | `sheet` spring from the right (bottom on phones), scaling from the card's rect; drag down to dismiss (`project()`) | fade 120 ms |
| Stage tab pill (390) | `layoutId`, `smooth` | instant |

### 7.5 Optimistic updates and Undo (`use-pipeline.ts`)

- **Query** `['pipeline', 'board', scope, owner]`:
  - seeded from the server promise;
  - `refetchOnWindowFocus: true`;
  - `refetchInterval: 30_000` while visible.
- **Mutation** `moveDeal`, with `scope: {id: 'deal-' + id}`:
  - **`onMutate`:** cancel queries, snapshot, then `applyMove(board, id, toStage, now)`. That pure function in `src/lib/pipeline-cache.ts` moves the card, sets 0 days and not stalled, and fixes both column counts and totals.
  - **`onSuccess`:**
    - write the server card (`version`, `stage_entered_at`, `history_id`);
    - invalidate `['home']`, `['pipeline','summary']`, `['lead', company_id]` and `['lead-deals', company_id]`;
    - toast "Moved to Qualified · Undo (U)" for 10 s.
  - **`onError` or `conflict`:** roll back, or reconcile to the server card, then map the error (4.1).
- **Undo** calls `undoDealMove`. On `undone: true` the card shows the restored days in stage. `undo_expired` gives "Too late to undo. Move it back by hand."; `conflict` gives "Couldn't undo: Kais changed this deal since."
- **A failed save** (network) rolls back with "Couldn't move the deal · Retry". Retry re-sends the same `request_id`, so the move is never applied twice.

### 7.6 Deal sheet, Win, Lose, Reopen, Open deal

**Deal sheet** (`deal-sheet.tsx`):
- `?deal=<id>`, written with `replaceState`, so it deep-links from Home, the board and the lead page.
- A 440 px right sheet from 1024 px wide; a full-height bottom sheet below that.
- **Contents:**
  - lead name (link, prefetched on hover);
  - title (inline edit);
  - value (inline edit, `parseMoney`);
  - **stage stepper** (Lead → Qualified → Negotiations → Won; arrow keys inside it; "Mark lost" link). This is the main way to move on phones;
  - status line (days in stage, stalled reason, or the closed date);
  - expected close (chips "End of this month", "End of next month", "Pick a date");
  - contact (the lead's contacts);
  - **How it ships** (Not decided · Warehouse inventory · Supplier Stock);
  - owner (admins);
  - **Path**: "Lead 3 days → Qualified 5 days → Negotiations, 12 days so far", with undo pairs folded;
  - the last 5 entries linked to the deal (no body) and "Log a note on this deal" (Day 4 composer with `dealId`);
  - ⋯ menu: Copy link, **Delete deal** (`useStepUp().ensureFresh()` first; the creator inside 2 minutes needs none).
- A reserved "Stock" section stays hidden until Day 6.
- **Inline edits** call `update_deal` with only the changed field in `p_fields`, plus `version`. On `conflict`:
  - if the edited field did not change remotely, re-send silently with the new version;
  - otherwise "Henri changed the value to €19,000 a moment ago." with **Keep yours** / **Use theirs**.
- **States:** skeleton; "This deal isn't available" (missing or invisible); error with Retry; closed deals read-only ("Reopen to change the value").

**Win dialog** (`win-dialog.tsx`; a bottom sheet on phones):
- "Mark {lead} as won?";
- **Value**: required, prefilled, focused when empty;
- **How it ships**: required, two large options:
  - **Warehouse inventory**, "Sold from our warehouse in France" (FR "Stock entrepôt · Vendu depuis notre entrepôt en France");
  - **Supplier Stock**, "Shipped from Pakistan straight to the client's country" (FR "Stock fournisseur · Expédié du Pakistan directement dans le pays du client");
- **Mark as won** (neutral primary, ⌘↩) and Cancel (Esc);
- toast "Won · €18,400 · Maison Verdane is now a customer · Undo".

**Lose dialog** (`lose-dialog.tsx`):
- the reasons as a radio group (8);
- the note (required for Other; counter from 450 of 500);
- **Mark as lost** (⌘↩);
- toast "Lost · Price · Undo".

**Reopen:** "Reopen in {stage}", defaulting to the stage the deal was closed from (from history).
- A won deal asks first: "Reopen this won deal? It leaves this month's won total."
- After 2 minutes it also needs the code.
- From Day 6 the button is hidden when `deal_closing_blocked` says so.

**Open-deal sheet** (`open-deal-sheet.tsx`; from the lead page, **New deal**, `N`, or Cmd+K "New deal"):
- lead (prefilled, or the combobox);
- title (placeholder "e.g. Denim jackets, 2 pallets");
- value, expected close, contact, how it ships (optional), owner (admins);
- **Open deal** (⌘↩);
- with an open deal already: "This lead already has an open deal: {title} in {stage} · Open it · Open another".

### 7.7 Keyboard

Keys stay quiet while typing (`isTyping`), during IME composition, with a `[role=dialog]` open, and while `useShell().isChordPending()` is true. That is a new export from `keyboard-layer.tsx`.

| Where | Keys |
|---|---|
| Page | `N` new deal; `U` / ⌘Z undo the last move (120 s); `/` palette; `?` shortcuts; "G then P" opens the page (exists) |
| Board navigation | One tab stop into the board (roving tabindex). ↑/↓ and `Home`/`End` within a column; ←/→ to the nearest card (by vertical position) in the next column |
| Focused card | `Enter` opens the sheet. **`Shift+→`/`Shift+←`** move one stage (`Shift+→` from Negotiations opens Win). **`1`–`5`** (`event.code` `Digit1–5`/`Numpad1–5`) go to Lead, Qualified, Negotiations, Won (dialog), Lost (dialog). `Space` starts the keyboard drag (←/→ choose, Space or Enter drop, Esc cancel). `E` edits the value; `O` opens the lead; `Delete`/`Backspace` deletes (code) |

- After a move, focus follows the card into its new column, in an effect after commit (Day 3b lesson).
- The "?" dialog gains a Pipeline section. Cmd+K gains "New deal" and "Show stalled deals". Every menu item shows its key.

### 7.8 Accessibility and announcements

- **Structure:**
  - the board is a `region` named "Pipeline board";
  - each column is a `section` labelled by its `h2`, with "9 deals, €48,200, 2 stalled" in `aria-describedby`;
  - the card's main button carries dnd-kit's attributes, with a translated `aria-roledescription` ("draggable deal" / "affaire déplaçable").
- **Announcements** (`announcements.ts`, from `messages/*`, plain text):

| Event | EN | FR |
|---|---|---|
| Instructions | "To move a deal, press Space, choose a stage with the left and right arrows, then press Space. Escape cancels. Or press 1 to 5 to send it straight to a stage." | "Pour déplacer une affaire, appuyez sur Espace, choisissez une étape avec les flèches gauche et droite, puis appuyez sur Espace. Échap annule. Ou appuyez sur 1 à 5 pour l'envoyer directement à une étape." |
| Start | "Picked up {lead}, {value}, in {stage}." | "{lead}, {value}, prise dans {stage}." |
| Over | "Over {stage}." | "Au-dessus de {stage}." |
| End | "Moved {lead} to {stage}. Press U to undo." | "{lead} déplacée vers {stage}. Appuyez sur U pour annuler." |
| End at Won or Lost | "{lead} dropped on {stage}. Confirm in the dialog." | "{lead} déposée sur {stage}. Confirmez dans la fenêtre." |
| Cancel | "Move cancelled. {lead} is back in {stage}." | "Déplacement annulé. {lead} est revenue dans {stage}." |

- Dialogs use Radix focus trapping, and focus returns to the card. The reasons are a `radiogroup`; limits sit in `aria-describedby`.
- Status is never colour alone. Targets are 44 px on phones; focus rings are visible; contrast is AA in both themes; French labels wrap.

### 7.9 Lead page Deals tab, queue and call panel (5b)

**Deals tab** (`src/components/lead/deals-tab.tsx`; replaces 4b's empty state; `list_lead_deals`, prefetched on tab hover or focus):

| State | 1440 | 390 |
|---|---|---|
| Open deals | Rows of 72 px, open first: mini stepper (4 dots), title or "Deal", stage word, value (DM Mono), days in stage or Stalled, expected close, owner. "Open a deal" (editors) top right. A row opens the deal sheet over the page (`?tab=deals&deal=`) | Stacked rows; "Open a deal" full width |
| Closed deals | "Won · €11,900 · 3 Oct · Supplier Stock", "Lost · Price · 12 Sep"; Reopen in the row menu | same |
| Empty, editor | "No deals yet. Open one when this lead is interested." plus the button | same |
| Empty, cannot open | "Only {owner} or an admin can open a deal on this lead." / Do not contact: "Asked not to be contacted: no new deals." | same |
| Loading / error | 3 skeleton rows / "Couldn't load deals · Retry" | same |

- **Summary tab:** 4b's deal card becomes the latest open deal (stepper, value, days, stalled), with "+1 more open deal" and "Open on the board". Data comes from `get_lead.deals`, so there is no extra call.
- **Header:** a chip "Deal: Qualified · €22,000" opens the Deals tab.
- **Composer:** with an open deal, entries carry it by default as a removable chip, "About: the deal". With several open deals, the chip's menu chooses one or none.
- **Interested (5) and Book meeting (6)**, in the queue and the call panel:
  - the inline chips gain **"Open a deal"** (`D` toggles via `event.key`; `aria-keyshortcuts="D"`) and optional title and value fields;
  - the switch is **on when `open_deal_count = 0`**, otherwise off, reading "Already has an open deal: Qualified · €6,800";
  - **hidden for non-editors**, whose result says "Logged. Only {owner} or an admin can open a deal.";
  - `↩` confirms in the same single dispatch; the buffered next card still shows within 100 ms;
  - toast "Logged: Interested · deal opened in Lead · Undo (U)". Undo removes both, or says "The deal was kept: it changed since";
  - if the deal was skipped, the rail chip says why, with **Open it now** (`open_deal` without a source).
- **The queue card** (4c) shows "Deal open: Negotiations · €18,400".

### 7.10 Home (`src/app/(app)/page.tsx`, `loading.tsx`, `src/components/home/*`)

**The server page:**
- calls `requireSession()` and awaits the profile's first name, because the greeting is the likely LCP element;
- passes promises for `/api/home`'s parts (cache-first, D32).

**The client** keeps `['home', scope]`:
- `staleTime` 30 s;
- refetch on focus and every 60 s while visible;
- invalidated by deal, task and outcome mutations.

The work queue count loads after paint as `['queue','summary']`.

DOM order, which is also the reading order: greeting → KPIs → Today → Work queue → Needs attention → Pipeline → Recent → Low stock → tagline.

| Width | Layout |
|---|---|
| 1728 / 1440 / 1280 | Content max 1440, 12-column grid, gap 16. **Row A:** date line; "Hello Haider" (existing `Greeting`); the calm line "You have 6 tasks today and 2 meetings." (ICU plurals; "Nothing due today." when 0); Team · Mine at top right on the greeting baseline (managers/admins). **Row B:** 4 KPI cards × 3 columns, 132 px (label 13 muted, number DM Mono 500 36/40, sub-line 13). **Row C:** Today (7) · Work queue (5). **Row D:** Needs attention (7) · Pipeline (5). **Row E:** Recent activity (7) · Low stock (5). Tagline |
| 1024 | Same grid; KPI numbers 28 px; labels may wrap to 2 lines (French), with the height reserved |
| 768 | KPIs 2 × 2; every other card full width, in DOM order |
| 390 | Greeting 36/40; calm line; KPIs 2 × 2 tiles (number 24, label 13, sub-line hidden under 360 px); cards stacked; **Start calling** full width, 56 px, red; rows 56 px with 44 px targets; `pb-36` keeps the dock clear (exists); no horizontal scroll |

**Cards**

| Card | Content |
|---|---|
| KPI: Open pipeline | "€182,400" · "23 deals · 4 stalled · 3 without a value". Links to `/pipeline` |
| KPI: Won this month | "€48,200" · "5 deals". Links to `/pipeline` |
| KPI: Calls today | "23" · "9 reached". Links to `/leads/queue` |
| KPI: Tasks due | "6" · "2 overdue". Links to `/tasks` |
| Today | Overdue first ("Overdue · 2 days", red token plus word), then meetings with their times (DM Mono, dual zone label from 4b), then call tasks. Check circles (4c `setTaskDone`, optimistic, Undo). 6 rows, "+3 more · Open Tasks" |
| Work queue | "412 to call now · 1,030 later today" (DM Mono) or 4c's empty messages; "12 new leads this week (+30,000 imported)"; **Start calling** (red) with the Kbd hint "G Q" |
| Needs attention | ≤ 5 rows: lead, stage word, reason ("● Stalled · no move or contact for 16 days" in amber, or "Close date passed 3 Oct" in the red token), value. A row opens the deal sheet over Home. "See all 7 on the board" links to `/pipeline?stalled=1` |
| Pipeline | A 14 px bar of the 3 open stages sized by value, ink tones at 30/60/100% (no status fills). Legend: stage, count, value. "Win rate 38% · 5 won, 8 lost in 90 days" (from 5 closed deals; otherwise "Not enough closed deals yet"). "Lost (30 days): 2 · Price 1 · Timing 1" |
| Recent activity | 8 rows: "Kais · Call · Interested · Maison Verdane · 10 min ago" / "Henri won Maison Verdane · €12,400". `<time>` relative, with the absolute time in `title`. Rows link to the lead. No note text |
| Low stock | 7.12 |

**States** (each card on its own)

| Card | Loading | Empty | Error |
|---|---|---|---|
| Whole page | `(app)/loading.tsx` rebuilt block for block per width, measured at 390 and 1440 | — | The greeting stays; `(app)/error.tsx` only if the profile read fails |
| KPIs | Number-width blocks | "€0" · "No open deals yet. Mark a lead Interested to open one."; calls "0" · "No calls yet today"; tasks "0" · "Nothing due" | "Couldn't load · Retry" on the KPI row |
| Today | 4 row blocks | "Nothing due today." plus **Add a task** | same pattern |
| Work queue | count-line block (the button shows at once) | 4c messages | "Couldn't load the queue count" (the button still works) |
| Needs attention | 3 row blocks | "All deals are moving." | same pattern |
| Pipeline | bar and legend blocks | "No deals yet. Deals open when a lead says they're interested." | same pattern |
| Recent | 4 row blocks | "No calls or notes yet today." | same pattern |
| Low stock | 3 row blocks | 7.12 | same pattern |
| Name missing | — | the existing "Add your first name" link | — |
| Failed refetch | — | — | old numbers kept, "Updated 3 min ago · Retry" under the greeting |

- **Scope:** reps get no switch. In Team scope the headings say "Team". The choice is remembered in `localStorage['topstock.home.scope']`, read in try/catch.
- **Reduced motion:** no count-up and no bar grow.

### 7.11 Count-up (`count-up.tsx`; D29)

1. The server renders the final formatted value inside an element with the CSS `rise` entrance (opacity and 8 px). Everything is readable without JavaScript.
2. On hydration, the count runs only when all of these hold:
   - this tab has not counted yet (a module flag, as in `Greeting`);
   - `performance.now()` minus navigation start is under 800 ms;
   - `useReducedMotion()` is false.

   Then, in a layout effect before paint, it sets a Motion value to 0 and runs `animate(mv, target, {duration: 0.7, ease: [0.16, 1, 0.3, 1]})`. Each frame writes `Intl` text into a ref, so React does not re-render. The CSS fade hides the first frames.
3. **Refresh:** a changed value springs from old to new in 0.3 s; an unchanged value does not move.
4. **No layout shift:** the number sits in a grid stack with an invisible copy of the final string. The animated span is `aria-hidden`, and an `sr-only` span holds the final value.
5. Bar segments grow with `scaleX` (`smooth`, 30 ms apart) only in the same first-visit case.

### 7.12 Low stock before and after Day 6 (D30)

- **Before Day 6** (`home_low_stock` returns null): a package icon, "Low stock", and "Stock alerts will show here once inventory is set up." (FR "Les alertes de stock s'afficheront ici dès que l'inventaire sera configuré."). No link: Inventory is still a placeholder. The same grid cell and height, so nothing moves later.
- **After Day 6**, parsed by Zod `lowStockCard` in `src/lib/home.ts` (unknown keys dropped; a bad shape shows that card's error state):
  - "3 low · 1 out · 2 deals waiting";
  - up to 5 rows: name; "120 available · reorder at 200" (DM Mono); "+300 In Transit · ETA 24 Oct" (muted); a dot-plus-word badge ("Low" amber, "Out of stock" red);
  - "Open inventory" links to `/inventory?filter=low` (Day 6 defines the parameter);
  - empty: "All products are above their reorder level.";
  - the card fails alone.

### 7.13 i18n (`messages/en.json`, `fr.json`; `messages.spec.ts` keeps key parity)

| Namespace | Keys |
|---|---|
| `Stages` | `lead`, `qualified`, `negotiations`, `won`, `lost`, `wonWindow` |
| `Pipeline` | `title`, `totals`, `scope.{team,mine}`, `owners.everyone`, `stalledOnly`, `sort.{recent,oldest,value,close}`, `sortedAmongShown`, `newDeal`, `columnSummary`, `dropHere`, `dropWon`, `lostBand`, `lostLine`, `seeLost`, `seeWon`, `empty.{org,mine,column,lead,filtered}`, `showMore`, `showingOf`, `offline`, `refreshFailed`, `loadMoreFailed`, `conflict`, `undo`, `undoExpired`, `undoConflict`, `announce.{instructions,start,over,end,endClosed,cancel,roledescription}`, `keys.*` |
| `Deals` | `addValue`, `daysInStage`, `today`, `wonOn`, `stalled`, `stalledHint`, `closes`, `closePassed`, `supplierStock`, `dnc`, `readOnly`, `menu.*`, `sheet.*`, `fields.{title,value,expectedClose,fulfilment,contact,owner}`, `path`, `history.*`, `keepYours`, `useTheirs`, `theyChanged`, `win.*`, `lose.*`, `reopen.*`, `reopenWonConfirm`, `delete`, `deleteConfirm`, `open.*`, `openAnother`, `notAvailable`, `errors.*`, `toast.{moved,won,lost,opened,kept}` |
| `LostReasons` | `price` (Prix), `timing` (Pas le bon moment), `no_stock` (Stock indisponible), `competitor` (Concurrent choisi), `no_response` (Plus de réponse), `shipping` (Livraison : coût ou délai), `mistake` (Ouverte par erreur), `other` (Autre, à préciser) |
| `Fulfilment` | `undecided`, `from_stock.{title,body}` ("Warehouse inventory" / "Stock entrepôt"), `direct_from_source.{title,body}` ("Supplier Stock" / "Stock fournisseur") |
| `Home` (extended) | `calmLine`, `nothingToday`, `scope.*`, `kpi.{open,won,calls,tasks}.*`, `today.*`, `queue.*`, `attention.*`, `pipeline.{winRate,winRateEmpty,lost}`, `recent.*`, `lowStock.{notReady,allGood,summary,inTransit,low,out,open}`, `loadFailed`, `updatedAgo`, `retry` |
| Existing | `LeadPage.deals.*`, `Outcomes.{openDeal,dealOpen,dealSkipped,noDealRights}`, `Queue.dealLine`, `Shortcuts.pipeline.*`, `Palette.{newDeal,showStalled}`, `StepUp.{bodyReopenWon,bodyDeleteDeal}` |

- **FR:** stages **Prospect · Qualifiée · Négociation · Gagnée · Perdue** (feminine, agreeing with "affaire"; open question 12); "Affaire", "Pipeline", "Jours dans l'étape", "Bloquée", "Gagné ce mois-ci", "Appels aujourd'hui", "Bonjour Haider".
- Money through Intl ("182 400 €"). French typography follows the Day 3b pattern.

## 8 Tests and evidence

### 8.1 Database attack tests (`scripts/db-test.sh` and `db.yml`; fixtures `a`, `a1`, `b1`, `c1`; each file redefines `pg_temp.as_user`)

| PR | File | Covers |
|---|---|---|
| 5a | `supabase/tests/deals_attack.sql` | Threats 1–11, 13–16, 18–22 and 24–30. **`transition_matrix`**: every from → to pair × value / fulfilment / reason / note / fresh code / undo gives the expected status, `closed_at`, clock, history `kind` and error hint. The coupling table. Undo cases (6, 14). Shared days-in-stage and stall cases. `pipeline_board_equals_hand_count` (rep and admin). `rep_board_team_falls_back_to_mine`, `rep_stage_list_team_42501`, `rep_summary_team_42501`. `list_stage_keyset_stable` (30 deals with one `stage_entered_at`, pages of 7, both orders: no repeats or gaps). `bad_cursor_22023`. `closing_blocked_stub_null`. `deal_moves_own_rows_only`. **Invariants after every scenario:** `stage_status_consistent` (0 rows where status disagrees with the stage's key) and `history_chain_consistent` (each `from` equals the previous `to`, ending at the current stage) |
| 5b | `supabase/tests/deal_links_attack.sql` | Threats 12 and 17; `log_activity_with_deal_same_lead_only`, `log_activity_interested_opens_deal`, `log_activity_meeting_booked_opens_deal`, `log_activity_open_deal_non_editor_skipped`, `log_activity_open_deal_dnc_skipped`, `log_activity_open_deal_bad_title_writes_nothing`, `undo_activity_removes_untouched_deal`, `undo_activity_keeps_moved_deal`, `deal_direct_delete_refused_while_activity_undo_record`, `get_lead_deals_respects_rls`, `claim_card_open_deal_count`. Day 4's `outcome_attack.sql` and `queue_attack.sql` re-run **unchanged** |
| 5c | `supabase/tests/home_attack.sql` | **`home_kpi_fixture`**: fixed deals, activities and tasks give exact K1–K8 numbers at fixed instants, in Europe/Paris and Asia/Karachi, including the 25 Oct 2026 week. `kpi_month_boundary_karachi_vs_paris` (31 Oct 2026 21:30 UTC: November in Karachi, October in Paris). `calls_today_profile_zone`, `win_rate_hidden_under_5`, `win_rate_excludes_mistake`, `rep_kpis_equal_own_rows`, `admin_team_kpis_equal_org_rows`, `rep_team_scope_42501`, `kpi_ignores_other_org`, `recent_activity_has_no_body` (`pg_proc` output columns), `recent_hides_undo_pairs`, `attention_order`, `home_low_stock_stub_null`, `home_aal1_blocked` |

**Fixture updates** (5a, unless marked; each explained in the PR):
- `rls_attack.sql:30`: the other org's stage insert adds `key = 'lead'`.
- `rls_attack.sql:249`: section 3b updates deals through `title = 'x'` instead of `updated_at` (no grant).
- `rls_attack.sql:287–291` drop `stage_id`, so **the policy** refuses them:
  - 287 becomes `(company_id a1, contact c1)`;
  - 289 becomes `(company_id b1)`;
  - 290 becomes `(company_id b1, contact b1)`;
  - 291 becomes `(company_id a1, contact b1)`.
- `rls_attack.sql:292` stays. It now fails on the column grant, because a stage is never client-chosen on insert; this is commented.
- `rls_attack.sql:299` stays. The guard's invisible-stage path raises 42501 `stage`.
- `rls_attack.sql:313` becomes `insert into public.deals (company_id) values (a1)`.
- `rls_attack.sql:284` (activity with deal b1): still refused, in 5b by the policy instead of the grant.
- `rls_attack.sql:51`, `activity_attack.sql:98` (superuser fixtures): unchanged; the guard is skipped.
- The admin lead delete (`rls_attack.sql:622`) deletes lead `mine`, which has no deal, so it is unchanged.
- `import_attack.sql:523`: the admin's deal insert drops `stage_id`.
- `activity_attack.sql:117` (5b): the expected insert columns gain `deal_id`, and the comment at line 101 is updated.
- `activity_attack.sql:733` (tasks `deal_id` refused): unchanged.
- `activity_attack.sql:541` (admin deletes a deal with a 30 s code): passes the new policy unchanged.

### 8.2 Concurrency (`supabase/tests/deal_concurrency.sh`; two or three psql sessions; `deadlock_timeout = 200ms`; wired into `db-test.sh` and `db.yml`)

- **5a:**
  - `two_movers_one_conflict`: A holds its transaction with `pg_sleep(1)`; B gets `conflict`; version 5; one history row.
  - `win_vs_lose_one_closes`.
  - `move_vs_update_value_one_conflict`.
  - `undo_vs_colleague_move_conflict`.
  - `open_deal_replay_parallel_once`.
  - `move_replay_parallel_once`.
  - `two_people_open_deal_same_lead`: serialised by the lead lock; 2 deals; 2 `open` rows; the second answer has `open_deal_count = 2`.
  - `history_chain_consistent`: 3 sessions × 100 random moves over 20 deals. History rows equal successful moves plus 20 openings; versions strictly increase; both invariants hold.
- **5b:**
  - `move_vs_log_activity_with_deal_no_deadlock`;
  - `undo_activity_vs_log_activity_with_deal_no_deadlock`;
  - `delete_deal_vs_log_activity_with_deal_no_deadlock`;
  - `undo_activity_vs_move_same_lead_no_deadlock`.

### 8.3 Mutations (each must fail at least one check; `docs/evidence/day5x/mutations.md`)

**5a:**
1. Grant `update (status)`.
2. Grant `update (stage_entered_at)`.
3. Drop `value_required`.
4. Drop the `fulfilment_required` check.
5. Drop the lost-reason pre-check (the hint test fails although the CHECK still raises).
6. Remove the "into won or lost only from open" rule.
7. Remove step-up from reopen-won.
8. Candidate ignores `actor_id`.
9. Candidate ignores the 120 s bound.
10. Candidate ignores `version_after`.
11. Remove the version compare in `move_deal`.
12. Grant insert on `deal_stage_history`.
13. Take the history actor from `new.owner_id`.
14. Delete policy without `has_recent_aal2`.
15. Delete branch without `version = 0`.
16. `company_id` FK back to set null.
17. `tasks.deal_id` back to cascade.
18. Remove `deal_id` from `task_guard`'s exception.
19. Restore the admin stage update policy and grant.
20. Remove the NaN check.
21. Lock with `FOR UPDATE` (deadlock test).
22. Coupling overrides DNC.
23. Coupling without the editor lock.
24. Undo restores the lead unconditionally.
25. Remove the open rate guard.
26. Remove the move rate guard.
27. Drop the request-id unique index.
28. Keyset `<` becomes `<=`.
29. `pipeline_board` without the rep → mine mapping.
30. The guard raises P0002 instead of 42501 for an invisible stage.
31. The guard does not bump `version` on a `lost_note` change.

**5b:**
1. Activities insert policy without the same-lead deal check.
2. `undo_activity` without `version = 0`.
3. `undo_activity` deletes the deal before the lead lock (deadlock test).
4. Deal delete branch without the activity-undo condition.
5. `log_activity` opens deals for non-editors.

**5c:**
1. Remove the scope check.
2. Month start in UTC.
3. `v_day_end` as `v_day_start + 24 h` (the DST case must fail).
4. Win rate includes `mistake`.
5. The feed selects `body`.
6. `home_summary` made SECURITY DEFINER.
7. Tasks due ignores `mine`.

### 8.4 Unit tests (`npm run test:unit`)

- `day5-parity.spec.ts`: stage keys, lost reasons, fulfilments, `DEAL_VALUE_MAX`, `DEAL_UNDO_SECONDS`, stall days, the 30-day Won window, the 90-day / 5-deal win-rate rule and the rate limits, all against the migration literals.
- `deals.spec.ts`:
  - strictObject on every action input;
  - money regex (`"0"`, `"12400.5"` and `"100000000"` accepted; `"1e3"`, `"-1"`, `"12.345"`, `"NaN"` and `"Infinity"` refused);
  - `parseMoney` EN "12,400.50" and FR "12 400,50" with U+00A0 and U+202F; ambiguous FR "1,234.5" refused.
- `days-in-stage.spec.ts`, `stall.spec.ts`: the shared cases.
- `pipeline-cache.spec.ts`:
  - `applyMove` places the card per sort, fixes both columns' counts and totals, and keeps cursors;
  - `rollback` restores byte for byte;
  - a conflict reconciles to the server card;
  - two queued moves.
- `coordinate-getter.spec.ts`: → from Negotiations goes to Won, then Lost; ← from Lead stays; ↑/↓ are a no-op on desktop and step at 390.
- `board-keys.spec.ts`:
  - `{code:'Digit4', key:"'"}` opens Won (AZERTY); `Numpad5` opens Lost; `Shift+ArrowRight` moves;
  - typing, composing, an open dialog and a pending G chord are ignored.
- `kpi-dates.spec.ts`: day and month starts in Europe/Paris and Asia/Karachi across 25 Oct and 1 Nov 2026.
- `count-up.spec.ts`: formatter frames never exceed the reserved width (EN/FR, €0 to €99,999,999); reduced motion gives the final value.
- `home-schema.spec.ts`: `homeData` parts and the `lowStockCard` contract (null, empty, full, and an extra key such as `pp` stripped).
- `announcements.spec.ts`: EN and FR strings filled.
- `sql-guc.spec.ts`: no bare `current_setting(` cast in any migration.
- `messages.spec.ts` (exists).

### 8.5 End-to-end (CI `auth-journey`, real local Supabase with PostgREST; WebKit `testMatch` gains `pipeline|lead-deals|home`)

- **5b `tests/auth/pipeline.spec.ts`:**
  - **moving:** `drag_lead_to_qualified_settles_then_undo_keeps_days` (database state through the API; `page.clock`); `keyboard_space_arrows_space_moves`; `enter_opens_sheet_not_drag`; `shift_arrow_moves_stage`; `digit_4_opens_win_azerty` (`code: 'Digit4', key: "'"`); `context_menu_right_click_move_to`;
  - **won, lost, reopen:** `drop_on_won_requires_value_and_ships`; `drop_on_won_cancel_springs_back`; `lost_band_reason_other_needs_note`; `won_to_lost_needs_reopen`; `reopen_lost_one_click`; `reopen_won_asks_code` (`ageStepUp`);
  - **delete and concurrency:** `delete_deal_asks_for_code`; `quick_second_drag_same_card_no_conflict`;
  - **display:** `stalled_badge_with_clock`; `won_column_last_30_days`; `show_more_keyset` (120 deals in Lead); `sort_value_note_when_more`; `column_virtualised_drag_from_bottom_200_cards`; `announcements_live_region_en_fr`;
  - **safety and phones:** `reduced_motion_no_settle`; `offline_disables_drag`; `xss_deal_title_is_text`; `phone_390_stepper_moves_and_tabs_sync` (`scrollWidth === clientWidth`); `phone_long_press_drag` (WebKit).
- **5b `tests/auth/lead-deals.spec.ts`:** `open_deal_from_tab_then_undo`, `interested_opens_deal_in_queue`, `book_meeting_opens_deal`, `interested_existing_deal_switch_off`, `undo_interested_removes_deal`, `non_editor_no_open_switch`, `header_chip_and_summary_card`.
- **5b `tests/auth/pipeline-multi.spec.ts`:** two contexts drag the same deal within 200 ms. One wins; the other screen shows the winner's column and the conflict toast; history has 1 row.
- **5c `tests/auth/home.spec.ts`:**
  - `greeting_and_calm_line_en_fr`;
  - `kpis_match_api`;
  - `count_up_first_visit_hard_load`;
  - `count_up_not_on_second_visit`;
  - `reduced_motion_static_numbers`;
  - `kpis_no_layout_shift` (CLS observer ≤ 0.02);
  - `today_toggle_done_undo`;
  - `attention_opens_deal_sheet`;
  - `queue_card_loads_after_paint`;
  - `scope_switch_admin_only`, `rep_has_no_scope_switch`;
  - `karachi_today_boundary`;
  - `win_rate_hidden_under_5`;
  - `new_org_empty_states`;
  - `card_error_isolated` (`page.route` aborts one part);
  - `low_stock_placeholder_when_null`;
  - `low_stock_filled_from_contract` (route mocked with the contract JSON);
  - `recent_activity_has_no_note_text`;
  - `refetch_after_move`;
  - `phone_390_no_horizontal_scroll`.
- **Every PR, `tests/auth/day5-security.spec.ts`:** `rep_direct_rpc_team_scope_403`, `rep_get_other_deal_404`, `history_table_write_refused`, `stage_write_refused_via_rest`, `deal_patch_status_column_denied`, `private_deal_moves_not_exposed`, `cross_site_move_action_refused`, `error_copy_has_no_sql`, `no_console_errors_no_csp_violations`.
- **Screens, `tests/auth/day5-screens.spec.ts`:** URL asserted before each shot; output to `test-results/day5-screens`. Covers:
  - board: data, empty, loading, error, mid-drag with the Lost band, Win, Lose, deal sheet, conflict toast, phone tabs;
  - lead Deals tab: none, open, closed, read-only;
  - Home: full, new org, before Day 6, a card error, loading.

  Each at 1280, 1440, 1728 and 390, plus 768 and 1024 (new layouts); light and dark; EN and FR.

### 8.6 Performance (numbers to hit)

**Database** (`scripts/db-perf.sh` plus `supabase/tests/perf_day5.sql`, on the Day 4 seed)

- **Seed:**
  - 30,015 leads, 300,000 activities (450 calls today across 3 people), 15,000 tasks;
  - **10,000 deals**: 2,000 open (Lead 900, Qualified 600, Negotiations 500; 20% stalled), 5,000 won over 2 years (400 this month), 3,000 lost;
  - **40,000 history rows**.
  - **Import-week variant:** all 30,000 leads created in the last 7 days.
  - Inserted as `postgres` (guards skipped), then `vacuum analyze`.
- **Method:** each case executed 10 times, with plans 6 and later logged by `auto_explain` (generic-plan check). The figure is the average of 5 warm runs. Three full runs.

| # | Case | Budget (database time) |
|---|---|---|
| P1 | `pipeline_board` team / mine | ≤ 25 / ≤ 15 ms |
| P2 | `list_stage_deals` at row 500 of Lead / stalled only / mine / won / lost | ≤ 5 ms each |
| P3 | `pipeline_summary` team | ≤ 10 ms |
| P4 | `move_deal` (lead lock, guard, history, coupling, move record) / win / lose (with the other-open-deal check) / undo by move / `open_deal` | ≤ 10 ms each |
| P4b | `update_deal`, `delete_deal` | ≤ 6 / ≤ 10 ms |
| P5 | `log_activity` with `p_open_deal`; `undo_activity` with the deal removed | ≤ 15 / ≤ 18 ms, and within +10% of `day4b/perf.md` P4/P4b |
| P6 | `get_deal` (50 history rows) / `list_lead_deals` / `get_lead` with the deals brief | ≤ 5 / ≤ 3 / Day 4 P1 + 2 ms |
| P7 | `home_summary` team / mine / import week, each K-part timed with `clock_timestamp()` | ≤ 30 / ≤ 25 / ≤ 45 ms |
| P8 | `home_attention` / `home_recent_activity` team (plan: per-person ordered index scans, no Sort over activities) | ≤ 10 / ≤ 5 ms |
| P9 | Regressions: Day 3a list cases / Day 4 cases / Day 3b import and undo chunks | ≤ +20% / ≤ +10% / ≤ +10% |
| P10 | 3 sessions × 100 moves on 20 hot deals | p95 ≤ 20 ms; 0 deadlocks; both invariants hold |

**Browser** (`tests/auth/day5-perf.spec.ts`, `PERF=1`, Chromium, 4× CPU through CDP)

| Measure | Budget |
|---|---|
| Drop, `Shift+→` or menu move to card painted in its new column (optimistic) | ≤ 100 ms p95 over 30 moves |
| Drag frame time, 4 columns × 150 loaded cards (virtualised) | p95 ≤ 16.7 ms; longest task ≤ 50 ms |
| Settle finished after pointer up | ≤ 450 ms |
| Press feedback | ≤ 100 ms |
| Route Home → Pipeline and Pipeline → Home after dock hover | ≤ 200 ms to content; without hover, skeleton ≤ 100 ms (stream time recorded) |
| Cold deep link `/pipeline` and `/` | LCP ≤ 2 s; CLS ≤ 0.05 (Home ≤ 0.02) |
| Count-up | longest frame ≤ 8 ms; 0 `layout-shift` entries |
| Route chunks from `next build` | Pipeline ≤ 60 KB extra gzip (dnd-kit core about 12 KB, context menu included); Home ≤ 20 KB; lead page growth ≤ 10 KB |

### 8.7 Evidence bundle (per PR: `docs/evidence/day5a|day5b|day5c/`)

- This design as `docs/evidence/day5/design.md`, referenced by each folder, with "as built" corrections.
- `perf.md` (3 runs, plans, the generic-plan check, browser numbers) and `mutations.md`.
- Spike results S6–S14 with their decisions.
- `security-review.md`: `/security-review` on the final head, this threat table re-checked, residual risks.
- UI PRs (5b, 5c): `apple-design-audit.md` (drag tracking, momentum, interruptible settle and reduced motion checked by hand and in tests), `web-design-guidelines.md` (unresolved: none), `screens/` (a representative set; the full matrix as a CI artifact).
- **Supabase advisors:**
  - local splinter in CI: 0 ERROR, the accepted `set_user_role` WARN, and no definer-function WARN (`deal_history` is trigger-only and revoked). `unindexed_foreign_keys` INFO on `deals_org_id_fkey` is accepted if flagged, like Day 4a's `activities_org_id_fkey`;
  - dev dashboard advisors through read-only MCP after each `deploy-dev-db`.
- **Context7 lookups, named per PR, run before code:**
  - `@dnd-kit/core` 6: `DndContext` `id`, `MouseSensor`/`TouchSensor` activation constraints, `KeyboardSensor` `coordinateGetter` and `keyboardCodes`, `accessibility.announcements`, `autoScroll`, `MeasuringStrategy`, `DragOverlay`;
  - Radix ContextMenu;
  - TanStack Query v5: optimistic mutations, `scope`, `initialData`/`initialDataUpdatedAt`, `prefetchQuery`;
  - TanStack Virtual: `rangeExtractor`, `scrollToIndex`, `measureElement`;
  - Motion: `animate` on elements and motion values, `layout`, `layoutId`, `useReducedMotion`;
  - Next 16: passing promises to client components, `use()`, Suspense streaming, `loading.tsx`, server actions;
  - next-intl: `useFormatter` currency and relative time, ICU plurals;
  - MDN: `Intl.NumberFormat` currency (fr-FR), `KeyboardEvent.code`;
  - PostgreSQL: numeric NaN, `CREATE TRIGGER … UPDATE OF`.
- **Dependency review:** `npm view` metadata and publish dates; licence; no install scripts; `npm audit` (0 runtime); `npm audit signatures`; package names checked for typosquats.
- **CI links:** quality, semgrep, gitleaks, rls (with `deal_concurrency.sh` and the migration-order check), auth-journey (Chromium and WebKit), Vercel preview.
- **`docs/log.md` lines:** D1–D35, the read-only MCP pre-checks, spikes, dependency pins, the Day 6 contract, and any waivers.
- The advisor's final verdict pasted into the REPORT (START_HERE section H).

## 9 Dependencies

- **Added in 5b, exact pins, each well over two weeks old:**
  - `@dnd-kit/core` **6.3.1** (5 Dec 2024). The lockfile brings `@dnd-kit/utilities` 3.2.2, `@dnd-kit/accessibility` 3.1.1 and `tslib`, each checked.
  - `@radix-ui/react-context-menu` **2.3.7** (24 Jul 2026). It shares `@radix-ui/react-menu` 2.1.24 with the installed dropdown.
  - Risk noted: dnd-kit 6.x has had no release since Dec 2024, and its maintainer's new work is `@dnd-kit/react` (0.x). Spikes S10/S11 come first; revisit when the new line reaches 1.0.
- **Deliberately not added:**
  - `@dnd-kit/sortable` (no in-column order);
  - `@dnd-kit/react` (pre-1.0);
  - **Recharts** (D25; Release 3);
  - a money, decimal, count-up or date library (strings, `numeric`, Intl, Motion);
  - Supabase Realtime (D31).
- **Reused:** `motion` 14.0.0, `@tanstack/react-query` 5.103.2, `@tanstack/react-virtual` 3.14.13, `@radix-ui/react-dialog` 1.1.23, `@radix-ui/react-dropdown-menu` 2.1.24.
- **CI:**
  - `db.yml` gains `deals_attack.sql`, `deal_links_attack.sql`, `home_attack.sql`, `deal_concurrency.sh` and the migration-order check; `db-test.sh` the same;
  - `db-perf.sh` gains `perf_day5.sql`;
  - the WebKit `testMatch` becomes `/(shell|leads|import|lead-page|queue|tasks|pipeline|lead-deals|home)\.spec\.ts/`.

## 10 Contract with Day 6 (inventory basics, designed in parallel; to be agreed before either day's database PR merges)

| Topic | Day 5 provides | Day 6 adds |
|---|---|---|
| Order types | `deals.fulfilment`: `from_stock` = **Warehouse inventory**, `direct_from_source` = **Supplier Stock**. Null until won, required at Win | Order type taken from `fulfilment` when an order is made from a won deal |
| Reservations | Fulfilment may be null on open deals | Reserving stock for an open deal requires fulfilment null or `from_stock` and sets it to `from_stock`. `deal_closing_blocked` returns `'reservation'`, so fulfilment cannot change while reservations exist |
| Blocking seam | `private.deal_closing_blocked(p_deal) returns text` (null), called before reopening a won deal, undoing a win, changing fulfilment, and in `delete_deal` | `create or replace`, returning `'order'`, `'sales'` or `'reservation'`. Day 6 **never redefines `deal_guard`** |
| Deal deletion | `delete_deal` maps 23503 to `deal_has_order` ("This deal has an order. Cancel the order first.") | `orders.deal_id … on delete restrict` |
| Reopening a won deal | Reopen with a fresh code | Refused once sale movements exist (`'sales'` gives 42501 `blocked_sales`) |
| Lost releases reservations | `status` becomes `lost` through the guard | An AFTER trigger `… after update on public.deals for each row when (old.status is distinct from new.status and new.status = 'lost')`. **Not `UPDATE OF status`**, which does not fire for a guard-set column (S9). It releases through `post_stock_movement` (type `release`, reference `deal`). Undoing a Lost does not re-reserve; the undo toast says "Reservations were released. Reserve again from the Stock tab." |
| Home Low stock | Card slot, placeholder, skeleton, `/api/home` part, Zod contract, `public.home_low_stock(p_limit integer default 5)` stub (created only if absent) | `create or replace` (INVOKER, under stock RLS, ≤ 10 ms) returning exactly `{low, out, deals_waiting: int \| null, items: [{product_id, name, available, reorder_point, in_transit, next_eta, state: 'low'\|'out'}] ≤ 5}`. **Available** = In Warehouse on hand − reserved. **In Transit** is shown, never counted as available. **Supplier Stock** never counts as warehouse stock. **PP (purchase cost) never appears** in the payload |
| Deal sheet and lead page | A hidden "Stock" section on the deal sheet; 4b's Stock tab placeholder | Day 6 fills both |
| Triggers on deals | BEFORE: `enforce_org_and_owner`, `guard_deal`, `set_updated_at`. AFTER: `audit_row`, `history_deal*` | AFTER triggers only. No BEFORE trigger on deals |
| Migration order | 5a, 5b and 5c renamed at merge to sort after main (D35) | Day 6 files sort after 5a. The CI check enforces it |

## 11 Build order (three PRs; each one branch, small commits, merged under Haider's standing permission only after advisor APPROVED and every check green)

**5a Deals database** (branch from `main` after 4c merges)
1. Read-only MCP pre-check on dev (section 3 preamble); log it.
2. Spikes S6, S7, S8 and S9 on a throwaway PG16; log the results.
3. Migration part 1: stages; `private.stage_id`/`stage_key`.
4. Part 2: deal columns, constraints, FKs, indexes; tasks FK; `task_guard` recreated from its merged body plus `deal_id`.
5. Part 3: `deal_undo_candidate`, `deal_closing_blocked`, `deal_guard`, the history table and DEFINER trigger, `private.deal_moves`, policies, grants, `audit_row` recreated from its merged body plus the deals rules.
6. Part 4: RPCs (4.1) and their grants.
7. Fixture updates (8.1); `deals_attack.sql`; `deal_concurrency.sh` part 1; `scripts/check-migration-order.sh`; wire them into `db-test.sh` and `db.yml`; `sql-guc.spec.ts`; mutations.
8. `perf_day5.sql` part 1 (P1–P4b, P6, P9, P10); 3 runs.
9. Splinter; `/security-review`, gitleaks, npm audit, Semgrep, lint, typecheck, the full Playwright suite (no UI change, so existing suites pass unchanged).
10. Evidence in `day5a/`; log lines; advisor loop; REPORT; rename the migration if main moved; merge; `deploy-dev-db`; dev advisors.

**5b Pipeline and deals UI** (after 5a)
1. Spikes S10–S13 on a throwaway branch page (not merged). Context7 lookups. Install the pinned dependencies (review logged).
2. Migration `…_deal_links.sql` (3.2), with bodies copied from the merged 4b/4c functions; `deal_links_attack.sql`; concurrency part 2; Day 4 attack files re-run unchanged; mutations; P5.
3. `src/lib/{deals,deals-server,pipeline-cache,money}.ts` and `db-errors.ts` additions; unit specs.
4. Actions (`pipeline/actions.ts`; queue and lead actions extended) and routes (4.5).
5. UI:
   - `src/components/ui/context-menu.tsx`;
   - `src/components/pipeline/{board,column,deal-card,drag-layer,coordinate-getter,lost-band,board-toolbar,win-dialog,lose-dialog,deal-sheet,open-deal-sheet,stage-stepper,settle,announcements,use-pipeline,use-board-keys}.tsx|ts`;
   - `pipeline/page.tsx` and `loading.tsx` (replace the placeholder);
   - dock prefetch (`src/lib/prefetch.ts`; `onPointerEnter`/`onFocus` in `dock.tsx`);
   - `useShell().isChordPending`;
   - lead `deals-tab`, `deal-summary-card`, `deal-chip`; the composer deal chip; the Interested/Book meeting switch in the queue and call panel; the queue card's deal line;
   - Cmd+K entries; shortcuts list.
6. Messages EN and FR.
7. E2E (pipeline, lead-deals, multi, security), perf, screenshots, Taste Skill pass, `/apple-design` and web-design-guidelines audits, fixes.
8. Reviews, evidence, advisor, REPORT, rename the migration if needed, merge, deploy, dev advisors. Lift the Day 2 Pipeline placeholder waiver.

**5c Home dashboard** (after 5a; 5b recommended first)
1. Spike S14.
2. Migration `…_home_dashboard.sql` (`home_summary`, `home_attention`, `home_recent_activity`, conditional `home_low_stock`); `home_attack.sql`; mutations; P7, P8.
3. `src/lib/{home,home-server}.ts` (types, Zod, the `lowStockCard` contract); `/api/home`; `/api/queue/summary` if 4c has none.
4. UI: `src/components/home/{kpi-card,count-up,today-card,queue-card,attention-card,pipeline-snapshot,recent-activity,low-stock-card,home-scope,use-home}.tsx|ts`; `(app)/page.tsx` and `(app)/loading.tsx` rebuilt block for block.
5. Messages; e2e; perf; screenshots; audits; reviews; evidence; advisor; REPORT; rename if needed; merge; deploy; dev advisors.
6. Hand Day 6 the contract note (section 10).

## 12 Open questions for Haider (recommendation first)

Haider is away. The build follows each recommendation, and each one is a small change if he says otherwise.

1. **When a deal moves, its lead follows (recommended).**
   - Negotiations makes the lead "Negotiation", so the work queue calls it first.
   - Won makes it a "Customer", so it is never cold-called again.
   - Lost rests it in "Cool off" for 90 days, like "Not interested", when it has no other open deal.
   - Opening a deal makes a Cold lead Warm.
   - "Do not contact" and "Disqualified" are never changed, and Undo puts the lead back.

   Or keep lead statuses manual?
2. **"Stalled" means no stage move and no contact (recommended):** for 7 days in Lead, 14 in Qualified and 21 in Negotiations. A logged call or email resets the warning; "days in stage" keeps counting. Different numbers?
3. **Reasons for a lost deal:** Price, Timing, No stock, Went with a competitor, No response, Shipping (cost or time), Opened by mistake (left out of the win rate), Other (with a note). Anything to add, for example "Quality or grade"?
4. **A lead may have several open deals at once (recommended)**, for example warehouse stock and supplier stock, with a warning when you open a second. Or one at a time?
5. **Who sees deals: keep today's rule (recommended).** Each person sees their own; admins and managers see all. All three of you are admins, so you see everything. It only matters for future reps. The alternative shows every deal to the whole team, like leads.
6. **Winning a deal asks for the final value (above €0) and how it ships (recommended):** Warehouse inventory or Supplier Stock. Before that, both are optional.
7. **Reopening a won deal more than 2 minutes after winning it asks for your authenticator code (recommended).** Deleting a deal is for admins, with the code. Whoever opened a deal can remove it within 2 minutes if nothing changed.
8. **The Won column shows the last 30 days, so it never empties on the 1st (recommended).** "See all won" lists the rest. Home's "Won this month" stays the calendar month.
9. **Home opens on the Team view for admins (recommended),** with a switch to "Mine" that each computer remembers. Tasks due are always your own.
10. **Pressing Interested or Book meeting offers "Open a deal" (recommended),** switched on when the lead has no open deal. Or off by default?
11. **Euros only for now (recommended).** Pounds and dollars can come later, always shown separately and never converted.
12. **French stage names: Prospect · Qualifiée · Négociation · Gagnée · Perdue.** OK, or do you say "Lead" in French too?
13. **A deal's value is the expected order total excluding VAT (recommended).** The expected close date is optional. Deals closing this week, or past their date, show on Home when it is set.
14. **A new deal belongs to whoever opens it (recommended).** Admins can pick someone else. Or should it go to the lead's owner?

## 13 Deferred (with reasons)

**Later days and releases**
- **Low-stock data, reservations, sales, orders from won deals, fulfilment locks, the lead Stock tab:** Day 6, through the contract in section 10.
- **Weighted forecast and win likelihood per stage** (the prototype's 10/35/65/100%): Release 3. A guess shown as a number misleads before there is real history.
- **Time per stage, conversion funnel, cycle length, lost-reason analytics beyond the line:** Release 3, built on `deal_stage_history`.
- **Recharts, sparklines, trend arrows:** Release 3 Analytics (D25). There are no value snapshots yet.
- **Dock badges (tasks due, stalled deals), swipe gestures on cards:** Day 7 polish. Badges need a live count on every route; swipes risk accidental moves.
- **Deal CSV export:** exports need step-up and their own design.

**Settings and configuration**
- **Editing stages and stall limits:** a Settings screen with an admin-plus-code policy. Every stage write is revoked until then (D9).
- **Several currencies and exchange rates:** open question 11. There is no free rate source.

**Product features not needed for Release 1**
- **Manual card order, swimlanes by owner, bulk moves, saved pipeline views:** sorted columns and owner filters cover three people (`saved_views.section = 'pipeline'` exists).
- **Tasks linked to deals:** `tasks.deal_id` stays out of the grants. The lead's tasks and the deal chip in the composer cover it.
- **Deal events in the lead timeline:** they would double the timeline. The deal sheet shows the path.
- **Cmd+K deal search:** the board filters and the lead page cover it.
- **Expected-close reminders and notifications:** there is no push or email channel until the PWA and custom SMTP work.
- **Moving a deal to another lead:** `company_id` is immutable. Close the deal and open a new one.
- **Multi-step undo:** only the latest change is undoable (5.3).

**Rejected designs**
- **A custom-setting undo marker and request-id setting:** replaced by guard-decided reverse moves and `private.deal_moves` (D6). The pooled-connection trap cannot occur.
- **Deleting or flagging reversed history rows:** history stays append-only (D4).
- **A DEFINER trigger syncing the lead:** it would bypass companies RLS with a copied check (D15).
- **A single `get_home`:** one failure would blank every card (D26).
- **Value-ordered keysets:** `numeric` is not leakproof under RLS (2.1).
- **Count-up on client navigation only:** it would never play on the morning hard load (D29).
- **Supabase Realtime:** another channel to secure; refetching on focus and on a timer covers three users (D31).
