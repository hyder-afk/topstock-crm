# Day 7a (part 1): Gate 1 security fixes, with Day 6 merged in, 15 Oct 2026

Local branch `day7a-local`, cut from e038d65 (PR #17's head: main + Day 5 + Team); Day 6 (`day6a-local` 9bbbf1c) is
merged in at 08b0ae7 (section "Merge with Day 6"). Plan: `docs/evidence/day7/plan.md` (on `day7-local`) step 7a,
section 1 items 7, 25, 28, 47, 49 and question 9. Haider, 15 Oct 2026 ("A, all yes"): record each sign-in without an IP
address; fix the same-organisation owner check now. Built while Day 6 merged in another worktree; since the merge the
rate limit also covers Day 6's list APIs, and Day 6's tables and functions are in the catalog-driven anon sweep.
Local only so far: not pushed, no PR yet; pushing and opening the PR come after the advisor's APPROVED.

## What changed and why

| # | Gap (plan) | Change | Files |
|---|---|---|---|
| 1 | Anon test covered Day 1's 12 tables and 6 functions only (item 7) | `rls_attack.sql` section 1 now reads the catalog: every table, view, materialized view, foreign table, sequence and function in `public` and `private` is checked for any anon privilege (table, column, sequence, function), schema `private` has no anon USAGE and neither schema anon CREATE; then anon really tries SELECT, INSERT, UPDATE and DELETE on every relation (each must fail with 42501 before touching a row). Allowlists: relations none; functions exactly `public.share_view(text,text)` and `public.share_request(text,jsonb)` by full signature (`regprocedure` text, schema-qualified), which Day 6 grants to anon by design (`20261020090000_client_share.sql`, the `grant execute … to anon` line, :1050 on `day6a-local`) | `supabase/tests/rls_attack.sql` |
| 2 | No "Sign out of all devices" (item 25) | Server action `signOutEverywhere` (`signOut({ scope: "global" })`) behind `requireSession()` (aal2, checked on the server); a quiet button on More next to Sign out opens a confirmation sheet (Radix dialog, no browser popup; bottom sheet on phones); failure keeps the sheet open with a short message; EN/FR | `src/app/(auth)/actions.ts`, `src/components/shell/sign-out-everywhere.tsx`, `src/app/(app)/more/page.tsx`, `loading.tsx`, `messages/*.json` |
| 3 | Auth cookie Secure flag unverified (item 47) | One `authCookieOptions(https)` for every Supabase client (proxy, server, browser): `Secure` whenever the request is HTTPS (URL or `x-forwarded-proto`, which Vercel sets), `SameSite=Lax`, `Path=/`, not HttpOnly (the browser client of the Files tab reads them; accepted residual 3). `__Host-` is not possible (the library names the cookies `sb-<ref>-auth-token`) | `src/lib/supabase/cookie-options.ts`, `client.ts`, `server.ts`, `src/proxy.ts` |
| 4 | No limit on search and list APIs (item 28) | Per-person sliding window keyed by the verified user id: 300 requests a minute shared by 19 search and list APIs: `/api/leads` (search and the lead pickers), `/api/pipeline/board`, `/stage`, `/summary`, `/api/tasks`; the lead page's list tabs `/api/leads/[id]/activities`, `/deals`, `/files`, `/tasks`; the lead import's `/api/imports/[id]/issues`; and Day 6's `/api/inventory/stock`, `/movements`, `/sales`, `/requests`, `/reservations`, `/share-links`, `/api/leads/[id]/stock`, `/api/stock-imports/[id]/changes` and `/issues`. 429 `{ "error": "rate_limited" }`, `Retry-After`, no-store. A speed bump, not scrape protection (decisions and residual R1 below). GET routes left out on purpose: "Merge with Day 6" | `src/lib/rate-limit.ts`, the 19 `route.ts` |
| 5 | Sign-ins not audited (question 9) | `audit_log` gains actions `sign_in` and `mfa_verify`; `public.record_auth_event(p_event)` is SECURITY INVOKER: the caller inserts one row about themselves under RLS (policy pins actor, org, action, table `auth`, no record id, no details; column grant on 4 columns; the table's restrictive aal2 policy applies). Written after the authenticator code is accepted at sign-in (`verifyTotp`, `verifyTotpEnrollment`: exactly one `sign_in` per sign-in) and at "Confirm it's you" (`verifyStepUp`: `mfa_verify`). No IP, no email, no details. Flood guard: 30 an hour per person (a DEFINER trigger, not callable, so it can count rows only admins can read; a row about someone else is left to RLS before any count, so a refusal never tells a caller another person's sign-in count). Best effort: a failed write never blocks a sign-in | `supabase/migrations/20261021100000_day7a_security.sql`, `src/lib/auth-events.ts`, `src/app/(auth)/actions.ts`, `src/app/(app)/step-up-actions.ts` |
| 6 | Same-org owner check (item 49, question 5) | Finding: `private.enforce_org_and_owner` already refuses an owner outside the caller's organisation since `20261010090000_leads_are_companies.sql` (the Day 5 review read the core version); only the lead owner through `update_lead` was tested (`rls_attack.sql`), and it skips sessions with no signed-in user by design. Added as a database rule for every path: `profiles (id, org_id)` unique, and composite foreign keys `companies (owner_id, org_id)`, `deals (owner_id, org_id)`, `tasks (assignee_id, org_id)` to it (`on delete set null (owner column)`). Now tested on every path a manager can choose an owner | same migration, `supabase/tests/day7a_attack.sql` |

Also: `scripts/db-test.sh` takes `DB_TEST_PORT` (default 54329) so two checkouts can run it at once; CI (`db.yml`) runs
the new attack file; `scripts/db-mutations.py` has a `day7a` set.

**Decisions taken here (recorded in `docs/log.md`).**
- No step-up for Sign out everywhere: it only removes access and is what someone does after losing a device; Master
  Plan section 8 lists step-up for adjustments, imports, exports, deletes and role changes. The server still requires a
  full aal2 session.
- **Rate limit: deviation accepted by Haider on 15 Oct 2026 ("1 yes"); recorded as residual R1.** Master Plan section 8
  item 28 and the plan's `private.rate_hits` table are not built; the limit is in the app, in memory, per server
  instance (on Vercel each function instance keeps its own window and a cold start resets it). It is a speed bump
  against a runaway client and casual scripting of these routes, **not scrape protection**: authenticated has direct
  SELECT on `public.companies` through PostgREST (`20261009180000_core_schema.sql:452`) and the auth cookies are
  readable by scripts (residual 3), so a stolen session can read `{supabase}/rest/v1/companies` directly, up to
  `max_rows` 1000 rows per request, without touching these routes. A `private.rate_hits` guard in the routes would be
  bypassed the same way, so it would add a database round trip per list request (route budget 200 ms) for no real
  gain. The real layers are two-factor sign-in, the Vercel Firewall rule (Day 8, after Pro) and, later, an RPC-only
  read path (no direct table SELECT for authenticated).
- Migration timestamp 20261021100000 sorts after Day 6's last (20261020100000_deal_stock_blocks). Day 6 does not change
  `audit_log_action_check` (checked on `day6a-local`), so redefining it here loses nothing at the merge.

## Merge with Day 6 (08b0ae7)

`day6a-local` 9bbbf1c merged into `day7a-local` (a0423ca) at 08b0ae7, locally; the advisor's CHANGES NEEDED on that
merge are fixed in the commits after it (below).

**Conflicts and how each was resolved.**

| File | Conflict | Resolution |
|---|---|---|
| `.github/workflows/db.yml`, `scripts/db-test.sh` | both sides added suites at the end of the list | Day 6's suites first (stock, inventory, stock import, sales, share, each with its concurrency script), then Day 7a's `day7a_attack.sql` (its migration applies last), then the advisors. `db-test.sh` keeps 7a's `DB_TEST_PORT`, so Day 6's suites and concurrency scripts also run against `$PORT`; the header comments name both days |
| `scripts/db-mutations.py` | both sides added a migration constant, a mutation list and a `SETS` entry | Day 6's sets, `REDEFINERS` and anchor checks kept; `MIG_7A` and `MUTATIONS_7A` added, `"day7a"` in `SETS` and in the usage line. Day 7a redefines no earlier function, so `REDEFINERS` needs no 7a entry |
| `tests/unit/messages.spec.ts` | both sides appended namespaces | Day 6's seven (`Inventory` … `ShareText`), then Day 7a's `More` |
| `docs/log.md` | both sides appended rows | both kept, Day 6's first; one row Day 7a had twice word for word (a0423ca, Haider's "3. no" on S3 keys) kept once |
| `supabase/tests/deals_attack.sql` | none (merged cleanly) | Day 7a never changed it, so it is Day 6's file byte for byte (`git diff 9bbbf1c HEAD` on it is empty), with Day 6's check that `private.deal_closing_blocked(uuid)` is SECURITY DEFINER |
| `supabase/migrations/20261021100000_day7a_security.sql` header | stale fact | it sorts after `20261020100000_deal_stock_blocks` (Day 6's last), not `client_share`; header and this README say so. After the merge its plan link also says "(on day7-local)", a comment only, in a migration not yet on main |

**Post-merge checks (at 08b0ae7).** Unit 599 passed; `DB_TEST_PORT=54593 scripts/db-test.sh` exit 0 with 26 suites
(including `rls_attack`'s anon sweep over Day 6's objects with the `share_view`/`share_request` allowlist, and
`day7a_attack` on the merged schema); `db-mutations.py --anchors` 660 rows in 15 sets, all apply, Day 7a's 16
included; advisors 0 ERROR. Re-run after the fixes below: "Checks after the merge".

**Unindexed foreign keys 5 → 8.** The three new ones are Day 7a's composite owner keys `companies (owner_id, org_id)`,
`deals (owner_id, org_id)` and `tasks (assignee_id, org_id)` → `profiles (id, org_id)`; splinter flags them because no
index starts with exactly those two columns. No new index: the keys are only checked from this side when a profile is
deleted or its `(id, org_id)` changes (three people, and `org_id` never changes), and that lookup is served by the
existing `companies_owner_idx` / `companies_org_owner_idx`, `deals_owner_idx` / `deals_org_owner_idx`,
`tasks_assignee_idx` / `tasks_org_assignee_idx` (`20261009180000_core_schema.sql:96-97, 195-196, 230-231`). Inserts
and updates of leads, deals and tasks check the key against `profiles`' unique `(id, org_id)` index.

**`src/proxy.ts` imports `./lib/supabase/cookie-options` (relative).** Day 6's `tests/unit/proxy-share.spec.ts` loads
the proxy with a dynamic `import("@/proxy")`, and Playwright's loader does not map `@/` inside that module (3 unit
failures, "Cannot find module @/lib/supabase/cookie-options"). Runtime is unchanged: Next resolves both specifiers
(`@/*` → `./src/*` in `tsconfig.json`) to the same file, `src/lib/supabase/cookie-options.ts`, so it is one module
either way; the auth-cookies scan still finds the proxy passing the shared options.

**Fixes after the merge (advisor's CHANGES NEEDED on 08b0ae7).**
- **Rate limit on Day 6's lists.** `listRateLimited(session.claims.sub)` right after `apiSession()`, the same 429 as
  `/api/tasks`, on `/api/inventory/stock`, `/movements`, `/sales`, `/requests`, `/reservations`, `/share-links`,
  `/api/leads/[id]/stock`, `/api/stock-imports/[id]/changes` and `/issues`. The scan of every GET route under
  `src/app/api` also found the lead page's other list tabs (`/api/leads/[id]/activities`, `/deals`, `/files`, `/tasks`)
  and the lead import's `/api/imports/[id]/issues` (the same shape as the stock import's), so they are limited too:
  19 routes in all, every one in `tests/unit/rate-limit.spec.ts`.
- **GET routes left out on purpose** (named in the test; a GET route in neither list fails it). None returns a page of
  rows or a search:
  - one record by id: `/api/activities/[id]`, `/api/deals/[id]`, `/api/leads/[id]`, `/api/inventory/products/[id]`,
    `/api/inventory/requests/[id]`, `/api/inventory/sales/[id]` (opening a panel or a hover prefetch must not spend
    the list budget; ids come from the limited lists);
  - fixed sets of counts: `/api/home`, `/api/inventory/alerts` (the Requests badge), `/api/inventory/summary`,
    `/api/queue/summary`;
  - `/api/files/[id]`: one file download behind a same-origin check and a short signed link;
  - `/api/inventory/share-preview`: the fixed client whitelist for "Send stock list as text";
  - the public share page's `/api/share/view` and `/api/share/request` are POST only, signed-out, and have their own
    per-IP limit (`src/lib/share/rate-limit.ts`) and database limits (Day 6e); the queue's POST actions are writes.
- **Plan link.** The migration's first comment line now says the plan is on `day7-local`.

## Tests

- **SQL** `supabase/tests/day7a_attack.sql` (own fixture people: manager, rep, admin in TopStock, admin in another org):
  A0 keys exist and are validated; A1 signed-in manager gets 42501 on direct lead owner update, `bulk_update_leads`,
  `open_deal(p_owner)`, `update_deal(owner_id)`, direct deal owner update, `create_task(p_assignee)`, `update_task`,
  direct task assignee update, and same-org controls succeed; A2 both directions between orgs; A3 no signed-in user:
  23503 on insert and update of all three tables, same-org insert passes; A4 deleting a person empties only the owner.
  B0 writer is INVOKER, anon/PUBLIC cannot call it, the guard is not callable, authenticated has only the four insert
  columns and no update/delete; B1 one row each, only who/what/when, rep cannot read it, own-org admin reads it, other
  org admin does not; B2 forgeries refused: another person's row, another org, another action, another table, details
  (an IP in `diff_json`), a back-dated `created_at`, aal1, update and delete (admin too); B3 anon; B4 the 31st row in
  an hour is refused (`rate_limited`), another person is not held; B5 with the victim at 30 rows, a forged row about
  them gets 42501 from RLS, not the flood guard's 22023, and the victim's own 31st row is still held.
- **SQL** `rls_attack.sql` section 1 (catalog sweep, above; function allowlist for Day 6's two share functions).
- **Unit** `tests/unit/auth-cookies.spec.ts` (the options; the real `@supabase/ssr` server client writing a refreshed
  session with a stub fetch, HTTPS and plain HTTP; a scan that every `createServerClient`/`createBrowserClient` in
  `src` passes the options), `tests/unit/rate-limit.spec.ts` (window, per person, refusals do not extend it, LRU cap,
  the 429 answer, a scan that all 19 routes check the limit right after the session, and an inventory of every GET
  route under `src/app/api`: each is either limited or on the named not-a-list list, so a new GET route fails the test
  until it is placed in one), `tests/unit/messages.spec.ts` now covers `More` (same keys, French typography).
- **E2E** `tests/auth/day7a.spec.ts` (Chromium): a sign-in writes exactly one `sign_in` row and the password step none;
  cookie flags with and without `x-forwarded-proto: https`; 300 list requests pass, the 301st and the other list APIs
  answer 429 with the generic code, another person still gets 200; Sign out of all devices (Cancel keeps the sessions;
  confirm deletes every `auth.sessions` row of the person, clears this browser's cookies, the second browser's refresh
  token is refused (400 `refresh_token_not_found`) in every environment; then, from its access token's JWT header: where
  getClaims asks the auth server (HS256, the local stack) it lands on `/login` and its API answers 401; with asymmetric
  signing keys (the Supabase CLI stack in CI, hosted Supabase) it keeps access until the token expires, within 3600 s,
  as R2 says, and the test asserts exactly that; no console error); French button and sheet. (PR #19 CI fix, 16 Oct
  2026: the earlier version expected `/login` everywhere and failed on CI's asymmetric keys. The decision rule, the
  same as @supabase/auth-js getClaims, and the cookie reader, plain, `base64-` or chunked, are unit-tested in
  `tests/unit/auth-cookie.spec.ts`.)

## Checks after the merge (15 Oct 2026, on the merged branch with the fixes below)

| Check | Result |
|---|---|
| `npm run lint` | 0 errors, 3 warnings (TanStack `useVirtualizer` incompatible-library: the two tables before, plus Day 6's stock table; same 3 on 08b0ae7) |
| `npm run typecheck` | clean |
| `npm run test:unit` | 600 passed (599 at the merge, plus the GET route inventory test) |
| Planted breaks in the route scan | 2 of 2 caught: the limit removed from `/api/inventory/sales`; a new GET route in neither list |
| `DB_TEST_PORT=54595 bash scripts/db-test.sh` (scratch PostgreSQL 16, own port) | exit 0: 26 suites green (incl. `rls_attack` with the catalog sweep over Day 6's objects and the share-function allowlist, Day 6's stock, inventory, stock import, sales and share suites, `day7a_attack`); advisors 0 ERROR; WARN `share_view` and `share_request` anon SECURITY DEFINER (Day 6, by design) and `set_user_role` (accepted Day 1); INFO unindexed_foreign_keys 8 (see "Merge with Day 6"), unused_index 13 (empty database; the count varies between runs, Day 6 README) |
| Mutation anchors `python3 scripts/db-mutations.py --anchors` | 660 rows in 15 sets, all apply, none dead: 3b 37, 4a 104, 4b 94, 4c 92, 4d 44, 5a 76, 5b 20, 5c 21, team 4, 6a 68, 6c 9, 6d 22, 6e 31, day6 22, **day7a 16** |
| Chromium and WebKit e2e on the merged code | not run here: the post-merge e2e run is the PR's CI (`auth-journey`, real Supabase stack) |
| gitleaks, `npm audit`, Semgrep | the PR's CI (gitleaks is not installed in this container; no dependency changed since the merge) |

## Checks before the merge (15 Oct 2026, Day 7a alone at a0423ca; kept as run)

| Check | Result |
|---|---|
| `npm run lint` | 0 errors (2 existing warnings: TanStack `useVirtualizer` incompatible-library) |
| `npm run typecheck` | clean |
| `npm run test:unit` | 504 passed (new: auth-cookies 5, rate-limit 5; messages now cover `More`) |
| `DB_TEST_PORT=54497 bash scripts/db-test.sh` (scratch PostgreSQL 16, own port) | all suites green, `day7a_attack: all checks passed` (incl. B5); `rls_attack` with the catalog sweep and the function allowlist green |
| Anon sweep against Day 6 (scratch PostgreSQL 16 on 54498: `day6a-local` a083511's 16 migrations + this branch's migration, same shim) | `rls_attack.sql` **without** the allowlist (e038d65..66a25d4 version): `FAIL: anon can execute public.share_view(p_token text, p_known_version text)`; **with** it: `rls_attack: all checks passed`, and `day7a_attack: all checks passed` on the merged schema; exactness: an extra `public.share_view(text)` overload granted to anon fails the sweep (`FAIL: anon can execute public.share_view(p text)`) |
| Supabase advisors (splinter, in db-test) | 0 ERROR; WARN `set_user_role` SECURITY DEFINER (accepted Day 1); INFO unindexed_foreign_keys 8 (was 5: the three composite keys; the existing single-column owner indexes serve profile deletes; accepted), unused_index 5 (empty database). `record_auth_event` is INVOKER, so no new DEFINER warning. Dev project advisors run after `deploy-dev-db` applies the migration (not deployed from here) |
| Mutation anchors `python3 scripts/db-mutations.py --anchors` | all sets apply: 3b 37, 4a 104, 4b 94, 4c 92, 4d 44, 5a 76, 5b 20, 5c 21, team 4, **day7a 16** |
| Mutation rows `DB_TEST_PORT=54497 python3 scripts/db-mutations.py --set day7a` | **16 of 16 caught** (`mutations.md`): 4 anon grants Day 1's list never named (incl. Day 5's `deal_stage_history`, a private table, schema `private`, a new RPC), 4 same-org rows (keys only, trigger only, both, task key), 8 sign-in-row rows (actor, org, action, table, `diff_json` grant, flood guard, flood guard counting a forged row (new, row 15), DEFINER) |
| Planted breaks in TypeScript (unit tests) | 7 of 7 caught: proxy or server client without the shared options, Secure on plain HTTP, SameSite=None, Tasks API without the limit, a limiter that never refuses, a 429 that leaks counts |
| Chromium e2e, throwaway isolated stack (Postgres 54540, GoTrue 9995, gateway 54541, `next start` 3400; never the shared stack) | `day7a.spec.ts` 6 passed; regression on what the change touches: `shell`, `team`, `leads`, `tasks`, `pipeline` 62 passed + 3 of `day4-security` before an artefact clash, then `day4-security` and `day5-security` 15 passed on a clean re-run (the first run's 2 failures were Playwright trace files deleted by a unit run sharing `test-results/`, ENOENT in `context.close()`, not app failures) |
| Round 2 (after the advisor's CHANGES NEEDED) | lint 0 errors (same 2 warnings); typecheck clean; unit 504 passed; `day7a.spec.ts` 6 passed (now also checks the sheet's "within an hour" sentence, EN and FR) on a fresh throwaway isolated stack (Postgres 54540, GoTrue 9995, gateway 54541, `next start` 3400; Chromium 141.0.7390.37), stack and build deleted after |
| Sheet screens retaken (round 2) | the 24 `sheet-*` shots (6 widths, light and dark, EN and FR) with the new sentence, no console error, no sideways scroll; `more-*` unchanged (the More page itself did not change) |
| Screens (`screens/`, Chromium 141) | More's sign-out row and the sheet at 390, 768, 1024, 1280, 1440, 1728, light and dark, EN and FR (48 shots): no console error, no sideways scroll; on phones the sheet rises from the bottom with the two buttons stacked, thumb-reachable; the button row stacks below 640 px; the loading skeleton has both buttons |
| `npm audit --omit=dev` | 0 vulnerabilities |
| gitleaks (`gitleaks git --log-opts=e038d65..HEAD`) | round 2 (head 583a71d): 7 commits scanned, no leaks found; round 1: 3 commits scanned, no leaks (a directory scan only flags the ignored `.next` build output, which holds the throwaway local stack's anon key; not committed, deleted after the run) |

Design notes (DESIGN.md; full notes in `apple-design-audit.md` and `web-design-guidelines.md`): reuses the existing quiet button,
dialog and phone-sheet patterns (no new tokens, no red: the confirm is the neutral button since red is reserved for
the brand fills), opacity + scale entrance from the shared dialog, focus trapped and returned by Radix, Escape and
Cancel close, the confirm is disabled and `aria-busy` while the action runs, the error is a live region with words.
No native picker or popup in anything new.

## Open items

- **Day 6 objects** (merged at 08b0ae7): the catalog-driven anon sweep now runs over Day 6's tables and functions in
  every `db-test.sh` and `db.yml` run (green after the merge, Checks). Day 6 grants EXECUTE on
  `public.share_view(text, text)` and `public.share_request(text, jsonb)` to anon by design (the public share page;
  `supabase/migrations/20261020090000_client_share.sql:1050` on this branch; the functions are owned by `share_reader`
  and run as it, but anon is the role that calls them). They are on the sweep's function allowlist by full signature;
  any other anon grant still fails (proven before the merge: fails without the allowlist, passes with it).
- **Rate-limit modules stay separate**: `src/lib/rate-limit.ts` (per person, this branch) and Day 6e's per-IP
  `src/lib/share/rate-limit.ts` are not touched or merged here; unifying them (or dropping one) is its own later PR.
- **Auth cookies stay readable by scripts** (residual 3, the Files tab's browser client needs them); CSP is the control.
  Secure is set from the request's protocol; on Vercel that is always HTTPS. Verify on the preview in 7d (DevTools >
  Application > Cookies shows Secure, Lax).
- CI (`db.yml` on the real Supabase image, and the e2e suites) has not run the merged branch (not pushed): the PR's CI
  is the post-merge e2e run. The catalog sweep could meet a Supabase-only object in `public`; none is expected (fresh
  `supabase start`, all objects from our migrations).
- **Rest of step 7a, still to do** (later parts of 7a): `docs/evidence/day7/gate1.md`; `gate1_attack.sql` catalog
  checks (a restrictive two-factor policy on every table; SECURITY DEFINER functions only from a reviewed list);
  anon-key requests to every PostgREST table on real PostgREST in CI; `npm audit signatures`; `.mcp.json` re-check;
  route inventory test, bundle scan, `GET /.env`, codes-only check on Day 5/6 APIs, `config push` diff check,
  `deal_links_attack` block 2, deal Delete cut-off; the dev advisors after deploy.
- **Belongs to 7b**: the More page's time-zone control is a native `<select>`; replacing it is step 7b, not 7a.

## Residual risks (accepted unless Haider says otherwise)

| # | Residual | Why it stays | Later option |
|---|---|---|---|
| R1 | Direct PostgREST reads are limited only by RLS and `max_rows` (1000 per request). The in-app limit (300 a minute per person, per instance, reset by a cold start) covers the 19 search and list routes only (Day 7a's five, the lead page's list tabs, the lead import's issues and Day 6's nine; the GET routes left out are listed in "Merge with Day 6"); a stolen session reads `rest/v1/companies` directly | Deviation from Master Plan section 8 item 28 / `private.rate_hits`: **accepted by Haider, 15 Oct 2026**. Every person in Release 1 may read every lead (Haider's "3 yes"), so a full session already sees them all | Two-factor sign-in (in place); Vercel Firewall rule (Day 8); later an RPC-only read path (revoke direct SELECT) |
| R2 | After "Sign out of all devices", another device's current access token stays valid until it expires: `jwt_expiry` 3600 s, `getClaims` verifies an asymmetric token locally and PostgREST does not check that the session still exists, so up to 1 hour of reads and writes. Refresh tokens die at once, so nothing lasts past that hour. The sheet says so ("Other devices lose access within an hour at most.") `day7a.spec.ts` asserts this behaviour where the token is asymmetric (CI) and the immediate sign-out where it is HS256 (local stack), and the dead refresh token in both | Supabase's design; a shorter expiry means more refreshes | Day 8: a shorter production `jwt_expiry` (for example 900 s), **Haider's call** |
| R3 | A signed-in person can write up to 30 fake `sign_in` rows an hour about themselves (only about themselves, no details, own organisation) | They are the person the row is about; the flood guard caps the noise; admins see actor and time | None planned |
| 3 (existing) | Auth cookies are readable by scripts (the Files tab's browser client) | CSP is the control | Revisit if the Files tab moves server-side |

## Context7 (libraries checked before writing code)

- `@supabase/ssr` 0.12.7: `cookieOptions` on `createServerClient` / `createBrowserClient` (Secure, SameSite, Path; cookie names fixed as `sb-<ref>-auth-token`).
- `@supabase/supabase-js` 2.117.3: `auth.signOut({ scope: "global" })` (revokes every refresh token of the person) and `auth.getClaims()` (local verification with asymmetric keys, a call to the auth server otherwise).
- PostgreSQL 16: `FOREIGN KEY … ON DELETE SET NULL (column)` (only the owner column is emptied on a composite key) and column-level `GRANT INSERT (…)` together with RLS policies.

## Reviews

- `/security-review`: NO FINDINGS at 80 % confidence or more; its informational note (the flood count could answer for a forged row about another person) is applied and tested (B5, mutation 15): `security-review.md`.
- apple-design audit of the More button and sheet: `apple-design-audit.md`. web-design-guidelines audit: `web-design-guidelines.md`.
