# Day 7a (part 1): Gate 1 security fixes that do not depend on Day 6, 15 Oct 2026

Local branch `day7a-local`, cut from e038d65 (PR #17's head: main + Day 5 + Team). Plan: `docs/evidence/day7/plan.md`
(on `day7-local`) step 7a, section 1 items 7, 25, 28, 47, 49 and question 9. Haider, 15 Oct 2026 ("A, all yes"):
record each sign-in without an IP address; fix the same-organisation owner check now. Day 6 is merging in another
worktree, so this part touches no Day 6 code; its tables are covered by the catalog-driven checks once merged.
Not pushed, no PR (builder task).

## What changed and why

| # | Gap (plan) | Change | Files |
|---|---|---|---|
| 1 | Anon test covered Day 1's 12 tables and 6 functions only (item 7) | `rls_attack.sql` section 1 now reads the catalog: every table, view, materialized view, foreign table, sequence and function in `public` and `private` is checked for any anon privilege (table, column, sequence, function), schema `private` has no anon USAGE and neither schema anon CREATE; then anon really tries SELECT, INSERT, UPDATE and DELETE on every relation (each must fail with 42501 before touching a row). Allowlists: relations none; functions exactly `public.share_view(text,text)` and `public.share_request(text,jsonb)` by full signature (`regprocedure` text, schema-qualified), which Day 6 grants to anon by design (`20261020090000_client_share.sql`, the `grant execute … to anon` line, :1050 on `day6a-local`) | `supabase/tests/rls_attack.sql` |
| 2 | No "Sign out of all devices" (item 25) | Server action `signOutEverywhere` (`signOut({ scope: "global" })`) behind `requireSession()` (aal2, checked on the server); a quiet button on More next to Sign out opens a confirmation sheet (Radix dialog, no browser popup; bottom sheet on phones); failure keeps the sheet open with a short message; EN/FR | `src/app/(auth)/actions.ts`, `src/components/shell/sign-out-everywhere.tsx`, `src/app/(app)/more/page.tsx`, `loading.tsx`, `messages/*.json` |
| 3 | Auth cookie Secure flag unverified (item 47) | One `authCookieOptions(https)` for every Supabase client (proxy, server, browser): `Secure` whenever the request is HTTPS (URL or `x-forwarded-proto`, which Vercel sets), `SameSite=Lax`, `Path=/`, not HttpOnly (the browser client of the Files tab reads them; accepted residual 3). `__Host-` is not possible (the library names the cookies `sb-<ref>-auth-token`) | `src/lib/supabase/cookie-options.ts`, `client.ts`, `server.ts`, `src/proxy.ts` |
| 4 | No limit on search and list APIs (item 28) | Per-person sliding window keyed by the verified user id: 300 requests a minute across `/api/leads` (search and the lead pickers), `/api/pipeline/board`, `/stage`, `/summary` and `/api/tasks`; 429 `{ "error": "rate_limited" }`, `Retry-After`, no-store. A speed bump, not scrape protection (decisions and residual R1 below) | `src/lib/rate-limit.ts`, the five `route.ts` |
| 5 | Sign-ins not audited (question 9) | `audit_log` gains actions `sign_in` and `mfa_verify`; `public.record_auth_event(p_event)` is SECURITY INVOKER: the caller inserts one row about themselves under RLS (policy pins actor, org, action, table `auth`, no record id, no details; column grant on 4 columns; the table's restrictive aal2 policy applies). Written after the authenticator code is accepted at sign-in (`verifyTotp`, `verifyTotpEnrollment`: exactly one `sign_in` per sign-in) and at "Confirm it's you" (`verifyStepUp`: `mfa_verify`). No IP, no email, no details. Flood guard: 30 an hour per person (a DEFINER trigger, not callable, so it can count rows only admins can read; a row about someone else is left to RLS before any count, so a refusal never tells a caller another person's sign-in count). Best effort: a failed write never blocks a sign-in | `supabase/migrations/20261021100000_day7a_security.sql`, `src/lib/auth-events.ts`, `src/app/(auth)/actions.ts`, `src/app/(app)/step-up-actions.ts` |
| 6 | Same-org owner check (item 49, question 5) | Finding: `private.enforce_org_and_owner` already refuses an owner outside the caller's organisation since `20261010090000_leads_are_companies.sql` (the Day 5 review read the core version); only the lead owner through `update_lead` was tested (`rls_attack.sql`), and it skips sessions with no signed-in user by design. Added as a database rule for every path: `profiles (id, org_id)` unique, and composite foreign keys `companies (owner_id, org_id)`, `deals (owner_id, org_id)`, `tasks (assignee_id, org_id)` to it (`on delete set null (owner column)`). Now tested on every path a manager can choose an owner | same migration, `supabase/tests/day7a_attack.sql` |

Also: `scripts/db-test.sh` takes `DB_TEST_PORT` (default 54329) so two checkouts can run it at once; CI (`db.yml`) runs
the new attack file; `scripts/db-mutations.py` has a `day7a` set.

**Decisions taken here (recorded in `docs/log.md`).**
- No step-up for Sign out everywhere: it only removes access and is what someone does after losing a device; Master
  Plan section 8 lists step-up for adjustments, imports, exports, deletes and role changes. The server still requires a
  full aal2 session.
- **Rate limit: deviation awaiting Haider (HAIDER DECIDES; recommended: accept as residual R1).** Master Plan section 8
  item 28 and the plan's `private.rate_hits` table are not built; the limit is in the app, in memory, per server
  instance (on Vercel each function instance keeps its own window and a cold start resets it). It is a speed bump
  against a runaway client and casual scripting of the five routes, **not scrape protection**: authenticated has direct
  SELECT on `public.companies` through PostgREST (`20261009180000_core_schema.sql:452`) and the auth cookies are
  readable by scripts (residual 3), so a stolen session can read `{supabase}/rest/v1/companies` directly, up to
  `max_rows` 1000 rows per request, without touching these routes. A `private.rate_hits` guard in the routes would be
  bypassed the same way, so it would add a database round trip per list request (route budget 200 ms) for no real
  gain. The real layers are two-factor sign-in, the Vercel Firewall rule (Day 8, after Pro) and, later, an RPC-only
  read path (no direct table SELECT for authenticated).
- Migration timestamp 20261021100000 sorts after Day 6's last (20261020090000_client_share). Day 6 does not change
  `audit_log_action_check` (checked on `day6a-local`), so redefining it here loses nothing at the merge.

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
  the 429 answer, a scan that all five routes check the limit right after the session), `tests/unit/messages.spec.ts`
  now covers `More` (same keys, French typography).
- **E2E** `tests/auth/day7a.spec.ts` (Chromium): a sign-in writes exactly one `sign_in` row and the password step none;
  cookie flags with and without `x-forwarded-proto: https`; 300 list requests pass, the 301st and the other list APIs
  answer 429 with the generic code, another person still gets 200; Sign out of all devices (Cancel keeps the sessions;
  confirm deletes every `auth.sessions` row of the person, clears this browser's cookies, the second browser lands on
  `/login` and its API answers 401; no console error); French button and sheet.

## Checks (15 Oct 2026, on this branch's final code; re-run after the advisor's round 1, see the last rows)

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
| gitleaks (`gitleaks git --log-opts=e038d65..HEAD`) | round 1: 3 commits scanned, no leaks (a directory scan only flags the ignored `.next` build output, which holds the throwaway local stack's anon key; not committed, deleted after the run) |

Design notes (DESIGN.md; full notes in `apple-design-audit.md` and `web-design-guidelines.md`): reuses the existing quiet button,
dialog and phone-sheet patterns (no new tokens, no red: the confirm is the neutral button since red is reserved for
the brand fills), opacity + scale entrance from the shared dialog, focus trapped and returned by Radix, Escape and
Cancel close, the confirm is disabled and `aria-busy` while the action runs, the error is a live region with words.
No native picker or popup in anything new.

## Open items

- **Day 6 objects**: Day 6's tables and functions are covered by the catalog-driven anon test once Day 6 is merged.
  Day 6 grants EXECUTE on `public.share_view(text, text)` and `public.share_request(text, jsonb)` to anon by design
  (the public share page; `20261020090000_client_share.sql:1050` on `day6a-local`; the functions are owned by
  `share_reader` and run as it, but anon is the role that calls them). They are on the sweep's function allowlist by
  full signature; any other anon grant still fails. Proven on a scratch PostgreSQL 16 with Day 6's migrations plus
  this branch's: fails without the allowlist, passes with it (Checks).
- **Rate-limit modules stay separate**: `src/lib/rate-limit.ts` (per person, this branch) and Day 6e's per-IP
  `src/lib/share/rate-limit.ts` are not touched or merged here; unifying them (or dropping one) is its own later PR.
- **Auth cookies stay readable by scripts** (residual 3, the Files tab's browser client needs them); CSP is the control.
  Secure is set from the request's protocol; on Vercel that is always HTTPS. Verify on the preview in 7d (DevTools >
  Application > Cookies shows Secure, Lax).
- CI (`db.yml`, real Supabase image) has not run this branch (not pushed): the catalog sweep could meet a Supabase-only
  object in `public`; none is expected (fresh `supabase start`, all objects from our migrations).
- **Rest of step 7a, still to do** (later parts of 7a): `docs/evidence/day7/gate1.md`; `gate1_attack.sql` catalog
  checks (a restrictive two-factor policy on every table; SECURITY DEFINER functions only from a reviewed list);
  anon-key requests to every PostgREST table on real PostgREST in CI; `npm audit signatures`; `.mcp.json` re-check;
  route inventory test, bundle scan, `GET /.env`, codes-only check on Day 5/6 APIs, `config push` diff check,
  `deal_links_attack` block 2, deal Delete cut-off; the dev advisors after deploy.
- **Belongs to 7b**: the More page's time-zone control is a native `<select>`; replacing it is step 7b, not 7a.

## Residual risks (accepted unless Haider says otherwise)

| # | Residual | Why it stays | Later option |
|---|---|---|---|
| R1 | Direct PostgREST reads are limited only by RLS and `max_rows` (1000 per request). The in-app limit (300 a minute per person, per instance, reset by a cold start) covers five routes only; a stolen session reads `rest/v1/companies` directly | Deviation from Master Plan section 8 item 28 / `private.rate_hits`: **HAIDER DECIDES** (recommended: accept as residual). Every person in Release 1 may read every lead (Haider's "3 yes"), so a full session already sees them all | Two-factor sign-in (in place); Vercel Firewall rule (Day 8); later an RPC-only read path (revoke direct SELECT) |
| R2 | After "Sign out of all devices", another device's current access token stays valid until it expires: `jwt_expiry` 3600 s, `getClaims` verifies an asymmetric token locally and PostgREST does not check that the session still exists, so up to 1 hour of reads and writes. Refresh tokens die at once, so nothing lasts past that hour. The sheet says so ("Other devices lose access within an hour at most.") | Supabase's design; a shorter expiry means more refreshes | Day 8: a shorter production `jwt_expiry` (for example 900 s), **Haider's call** |
| R3 | A signed-in person can write up to 30 fake `sign_in` rows an hour about themselves (only about themselves, no details, own organisation) | They are the person the row is about; the flood guard caps the noise; admins see actor and time | None planned |
| 3 (existing) | Auth cookies are readable by scripts (the Files tab's browser client) | CSP is the control | Revisit if the Files tab moves server-side |

## Context7 (libraries checked before writing code)

- `@supabase/ssr` 0.12.7: `cookieOptions` on `createServerClient` / `createBrowserClient` (Secure, SameSite, Path; cookie names fixed as `sb-<ref>-auth-token`).
- `@supabase/supabase-js` 2.117.3: `auth.signOut({ scope: "global" })` (revokes every refresh token of the person) and `auth.getClaims()` (local verification with asymmetric keys, a call to the auth server otherwise).
- PostgreSQL 16: `FOREIGN KEY … ON DELETE SET NULL (column)` (only the owner column is emptied on a composite key) and column-level `GRANT INSERT (…)` together with RLS policies.

## Reviews

- `/security-review`: NO FINDINGS at 80 % confidence or more; its informational note (the flood count could answer for a forged row about another person) is applied and tested (B5, mutation 15): `security-review.md`.
- apple-design audit of the More button and sheet: `apple-design-audit.md`. web-design-guidelines audit: `web-design-guidelines.md`.
