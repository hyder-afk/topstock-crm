# Day 6e: the client stock link, 12 Oct 2026

Design: `docs/evidence/day6/design.md` (sections 3.5, 5.5, 6.8, 8, 9, 10.4 to 10.6, 11 and 13 "6e Client stock link"),
with Haider's 11 Oct answers: the client page shows live warehouse inventory with the **max price per piece, excluding
VAT**, never PP (cost) or the minimum price; clients can ask for other stock; links are token-scoped, read-only,
rate-limited and revocable; sharing stays off until he switches it on (open question 11). Built on `day6a-local` after
6d. Fake data only.

Verifier round commits: df56ab0, 5297d5c, 3a16ba1, 8e735dd, 888258d, 05f15dd, 6065688, 4fd8c8a, 9c67930, 26bfa53 and
the evidence commit (section "Verifier round" below).

Commits: b326afb (database, `share_attack.sql`, `share_concurrency.sh`), c24418c (libraries, routes, proxy, headers,
i18n subset, robots, ESLint, gitleaks, team actions, unit tests, mutation set), 5bd81c5 (pages and components, messages),
ca18b65 (perf: product numbers and positional arrays on the wire, targeted visibility check; e2e), bb81d5d (app mutation
script), 67a6dcf (hand-written wire check), fd6f404 (phone target, lang checks), 1e3a232 (audit fixes), 556e783 and 85e8269 (tests: the direct-insert attack, the
gitleaks false positive, the e2e's per-IP addresses and WebKit), and the evidence commit. (74c741b, a
6d evidence addition, sits between them.)

## What changed

**Migration `supabase/migrations/20261020090000_client_share.sql`** (sorts after 6d's `20261019090000`)

- Role `share_reader` (nologin, noinherit) owning `public.share_view` and `public.share_request` (definer, VOLATILE,
  static SQL, `search_path = ''`), the only functions anon may execute. Column grants on exactly what the page shows;
  policies `TO share_reader` bound to the presented token's hash (`share_links`) and the link's organisation (products,
  levels, places, settings, requests, rate counters).
- `private.share_links` (token hash and last 4 characters, language, two switches, the creator's first name, expiry,
  permanent revoke, open and request counters), `private.share_rate` (minute/hour/day buckets, 2 days),
  `inventory_settings.sharing_enabled` (off by default). RLS, restrictive `require_mfa`, column grants.
- `share_link_guard` (invoker; the token made here: `gen_random_bytes(32)`; share_reader may move only the counters;
  a teammate's insert needs a fresh code; revoke is permanent; expiry changes need a fresh code and 1 hour to 366 days),
  `share_link_caps` (definer trigger: 3 active links a lead, 200 an org; counted under an organisation transaction lock, also when the expiry moves), `audit_share_link_row` (hash hidden, counters
  no diff), `stock_request_task` (definer trigger: one task for the lead's owner, else the link's creator, else the
  oldest admin; a lead with an open request task keeps one).
- `private.share_items(org, with_transit)`: the one whitelist, 8-place arrays `[number, name, category, max price,
  pieces per carton, warehouse available, transit available, eta week]`, in-stock filter before the 2,000 cap, the
  eta's week only; `private.share_take` (counters that refuse without writing).
- `share_view(token, known_version)` (one "inactive" answer for every link that does not work; 30 views a minute and
  600 an hour a link; "unchanged" polls), `share_request(token, payload)` (shape checked as text; products named by
  number among the visible ones; idempotency key; 10 new a link; 5 an hour and 20 a day a link, 200 a day an org).
- Team RPCs (invoker): `create_share_link` (token returned once), `revoke_share_link`, `extend_share_link`,
  `list_share_links`, `set_sharing_enabled`, `share_preview`; `get_inventory_settings` gains the switch.
- REBASE redefinitions: `stock_request_guard` and `stock_request_line_guard` (6d) with the share_reader branch first,
  `inventory_settings_guard` and the settings update policy (6a), `get_inventory_settings` (6b),
  `lead_import_untouched` (6d: a lead with a link is touched).

**App**

- `src/proxy.ts`: `/s` and `/api/share` are served before any session code with the share CSP (`default-src 'none'`,
  `connect-src 'self'`, no Supabase origin) and the surface headers; incoming copies of those headers are dropped on
  every path; `/robots.txt` public. `next.config.ts`: `no-referrer`, `X-Robots-Tag`, `CORP same-origin`, `no-store` on
  the share paths (last entry wins). `src/i18n/request.ts`: the share surface gets its locale from the path and only the
  Share messages. `src/app/robots.ts` (`Disallow: /`).
- `POST /api/share/view` and `POST /api/share/request`: JSON only, byte caps (2 KB, 16 KB), same Origin, Zod strict,
  per-IP limiter (60 a minute; 10 per 10 minutes), honeypot and time trap (fake "received", no database call), the
  answer re-parsed strictly and sent as positional arrays; anon client without cookies (`src/lib/share/server.ts`).
- `/s/fr` and `/s/en` (`src/app/(share)`): logo, title, "Updated 14:05" in the client's time, EN | FR keeping the
  fragment, search, category chips, "In our warehouse in France" and "Arriving" (week of …), rows with the max price per
  piece and "per piece", "Only 3 cartons left", item sheet (pcs or cartons, "= 2 cartons", more than available
  allowed), request bar and review sheet (free text with a counter from 900, optional name, honeypot), thanks with the
  contact's first name; loading, empty, inactive, slow down, error, offline and no-JavaScript states; no spinners.
- The lead's Stock tab: the client link card (options, Share on WhatsApp / Copy link behind "Confirm it's you", the
  address shown once with WhatsApp, e-mail and copy, active links with opens, requests and expiry, Revoke, Replace,
  Extend, "Send stock list as text"). Settings › Client links (the switch and every active link). What clients see
  (`/inventory/client-view`, Cmd+K).
- Messages `Share` and `ShareLinks` in EN and FR (French typography checked by `messages.spec.ts`).

## Verifier round (12 Oct 2026, head 001bad5: NOT READY, 7 findings)

Every finding fixed or recorded; behaviour fixes have a test that failed before the fix.

| # | Finding | What changed | How it was checked |
|---|---|---|---|
| 1 | Medium: the client page counted name / category / signature lengths in UTF-16 units; a 200-character name ending in an emoji passed the server and blanked every client's list | `wire.ts` counts characters (`[...v].length`, a string over 2 × max units refused without counting); dates must exist on the calendar (2026-02-30 was accepted by the page, refused by `z.iso.date()`) (df56ab0) | unit `wire_counts_characters_like_the_server` (failed first; parity with `mapShareItem` on emoji, limit and impossible-date rows, a whole snapshot with a 60-character signature); app mutation row 53 |
| 2 | Medium: a request sent from a page open more than 24 hours was refused | `requestElapsed(now, loadedAt)` caps `t` at the server's bound and floors it at 0; the page uses it (5297d5c) | unit `share_request_after_a_day_open` (failed first); app mutation row 54 |
| 3 | Low: a full stop glued to the link made it inactive | `tokenFromHash` takes the 43 characters when the next one cannot be part of a token (`.`, `)`, quotes, `%2E`, a space…); another token character is still refused (3a16ba1). The message puts the link on its own line, so nothing follows it (8e735dd) | unit `share_token_trailing_punctuation` (failed first) and `share_link_message_from_messages`; app mutation row 55; e2e `share_link_create_needs_code_and_shows_once` checks the exact e-mail body |
| 4 | Low: the link message and stock list text were EN/FR strings in TypeScript | New `ShareText` namespace in `messages/en.json` and `fr.json` (message, signature, e-mail subject, list head, line, per piece, price on request, more), read through `createTranslator` in the link's language; the request config adds both languages' ShareText as `ShareTextByLanguage` for the team app (the client page's subset is unchanged); `ShareLinks.emailSubject` moved there (8e735dd) | unit tests above, `messages.spec.ts` (same keys, French typography) now covers `ShareText`; `share_messages_subset_exact` unchanged; e2e: the French subject and body from an English interface |
| 5 | Low: Cmd+K "Hold stock…" / "Share stock with…" and Inventory keys S and R were missing | Product panel: Record sale (`S`) and Hold (`R`) for every role, each opening its sheet with the product and the lead search; the hold sheet picks its lead and reads that lead's deals when opened without one; Cmd+K "Hold stock…" (`/inventory?hold=1`) and "Share stock with…" (`?share=1`: a lead search that opens the lead's Stock tab on the client link card); both keys in the `?` sheet; EN and FR (05f15dd). A dialog without a Radix Trigger now gives the focus back to its opener, else the page heading, never `<body>` (4fd8c8a, found by the new e2e); `/favicon.ico` redirects to the app icon (Chromium asked for it after the same-page Cmd+K navigation and logged a 404; 9c67930); the panel's Record sale is quiet so the header's red one and Arrived stay the strong actions (26bfa53) | e2e `product_keys_s_and_r_then_palette_hold_stock` (sales) and `palette_share_stock_with_opens_the_lead_link_card` (share); screenshots `hold-from-product` and `share-with` |
| 6 | Low: two links made at the same moment could pass the cap | `share_link_caps` takes an organisation transaction lock (`pg_advisory_xact_lock`) before counting, and also runs on `update of expires_at` (Extend could bring an expired link back as a 4th) (888258d) | `share_concurrency.sh` case 4 `share_link_cap_parallel_creates` (a held uncommitted create, then a second: refused, 3 active) and `share_attack.sql` `extend_counts_against_the_cap`, both failed on the old migration; mutation rows 30 and 31 caught |
| 7 | Info: the same-origin check trusts `x-forwarded-host` | Kept (as Next.js does for server actions and as Day 4c's helper does); added to spike S5 with the exact preview check (`spikes.md`) and to open risk 2 | review only |

### Checks after the verifier round (code head 26bfa53)

| Check | Result |
|---|---|
| `db-test.sh` copy on port 54391 (database files at 888258d, unchanged since) | exit 0: every suite passed, including `share_attack` (with `extend_counts_against_the_cap`) and `share_concurrency` (4 cases, with `share_link_cap_parallel_creates`); advisors: no ERROR (WARN `share_view` / `share_request` for anon by design, `set_user_role`; INFO 2 unindexed foreign keys, 10 unused indexes). On the old migration the two new checks failed (`attack-before`, `conc-before`) |
| Mutations | day6e rows 17, 18, 20, 30, 31 caught (throwaway worktree, port 54392, removed); rows 1 to 4 caught again in a stopped full pass; app rows 48, 49, 50, 52 caught again, new rows 53 to 55 caught (`mutations.md`) |
| `npm run lint` | 0 errors (the 3 existing warnings) |
| `npm run typecheck` | passed |
| `npm run test:unit` | 402 passed (398 + the 4 new cases) |
| Playwright Chromium `share` + `inventory` + `sales` + `stock-import` (shared local stack serving 6a, this worktree's own `next start`, build of 26bfa53) | 40 passed in 14.0 min (38 before, plus `product_keys_s_and_r_then_palette_hold_stock` and `palette_share_stock_with_opens_the_lead_link_card`); no console errors, no horizontal scroll in the screens runs |
| Screenshots (`screens/`, 92) | added: `share-with-*` (Cmd+K Share stock with…), `hold-from-product-*` (R from the panel, lead search first), `product-panel-*` (Record sale S and Hold R) at 390 and 1440, light and dark, EN and FR |
| gitleaks (`origin/main..HEAD`) | no leaks found |
| `npm audit --omit=dev` | found 0 vulnerabilities |
| `/security-review` (`security-review.md`, verifier-round section) | no new vulnerability |
| Not run here | WebKit, Semgrep (CI only), Lighthouse, Supabase MCP and hosted advisors (no remote database) |

The e2e needed several attempts on the shared stack: twice a `next start` from another checkout was already listening on
port 3100 and Playwright reused it (`reuseExistingServer`), so the first page showed another build and the server then
went away; once another workflow had restarted the stack (incident in `docs/log.md`). The final run started this
worktree's own server first and checked its working directory.

## Check results

| Check | Result |
|---|---|
| `bash scripts/db-test.sh` (copy on port 54381, on the evidence head) | exit 0: every suite passed (`rls_attack`, `import_attack`, `import_concurrency`, `activity_attack`, `activity_concurrency`, `outcome_attack`, `outcome_concurrency`, `stock_attack`, `stock_concurrency`, `inventory_attack`, `stock_import_attack`, `stock_import_concurrency`, `sales_attack`, `sales_concurrency`, `share_attack`, `share_concurrency`); `advisors: no ERROR-level findings` (WARN `anon_security_definer_function_executable` for `share_view` and `share_request`, by design: they are the public surface, owned by `share_reader`; WARN `set_user_role` as before; INFO 2 unindexed foreign keys, 10 unused indexes) |
| `supabase/tests/share_attack.sql` | catalog and grants (anon executes exactly the two functions, reads no table; `share_reader` column privileges exact), token hash only, inactive cases one answer, rate limits per link and per org writing nothing when refusing, sold-out / hidden / archived / fully held items left out, 2,000 items not truncated by the filter, requests (shape, foreign or hidden product, idempotency, too many open, the task), team RPCs and the guard (fresh code, editor check through the RPC and straight into the table, caps, revoke permanent, extend bounds), kill switch, audit without the hash, import undo counting links |
| `supabase/tests/share_concurrency.sh` | 3 cases: 5 parallel requests on one link (5 requests, 1 open task), 8 more past the hourly cap (never more than 8, the rest "slow_down", 1 task), 40 parallel views (the 30-a-minute cap plus the overshoot the design accepts, 39 and 40 answered in the last two runs, open_count 1, no deadlock): passed |
| Mutations (`mutations.md`) | day6e: 29 rows, 29 caught (row 19 caught after the direct-insert test was added); earlier rows the 6e redefinitions reach: 8 of 8 as listed; app rows 48 to 52: 5 of 5 caught |
| Perf I9 to I11 (`perf.md`, 3 runs) | I9 valid link 2,000 items average 29.9–32.7 ms, **p95 over 40 ms in 2 of 3 runs** (open risk 3); unknown token 0.07 ms; I11 8.0–9.0 ms (20); I10 125 KB raw / 11.6 KB gzip (150 / 35) |
| Client page JavaScript (`bundle-scan.txt`) | own chunks 23.7 KB gzip (budget baseline + 40 KB); no Supabase origin, key, `price_min`, cost or token string in any script or the HTML |
| Headers (`headers.txt`) | share CSP, `no-referrer`, `X-Robots-Tag`, CORP, `no-store`, no cookie on `/s` and `/api/share` |
| `npm run test:unit` | 398 passed |
| Playwright `tests/auth/share.spec.ts` + `inventory.spec.ts` (Chromium, shared local stack, build of the evidence head) | 22 passed (share 11: enable sharing behind an admin code, link made with a code and shown once, the public list with the max price and never cost, a request opening a task for the owner, route guards, headers and robots, a signed-in teammate still anonymous, keyboard only and the language toggle, unknown and revoked links on the same page and a rep refused, the rate-limit message, screens; inventory 11, run with it because the share fixtures now avoid its "Sac" search) |
| Screenshots (`screens/`, 68) | the client page at 360/390/768/1024/1280/1440/1728, its item and review sheets at 390 and 1440, the lead's link card, Settings › Client links and What clients see at 390 and 1440; light and dark, EN and FR; no console errors, no horizontal scroll (taken after the audit fixes) |
| Audits (`audits.md`) | findings fixed in 5bd81c5, fd6f404 and 1e3a232; none open |
| `npm run lint` | 0 errors (3 existing warnings) |
| `npm run typecheck` | passed |
| `npm audit --omit=dev` | found 0 vulnerabilities |
| gitleaks (`origin/main..HEAD`) | no leaks found (the old unit-test commit's UUID false positive listed in `.gitleaksignore`) |
| `/security-review` (`security-review.md`) | no high-confidence vulnerability |
| Not run here | WebKit (CI only; `testMatch` now includes `share`), Semgrep (CI only), Lighthouse (not installed); Supabase MCP, dev advisors and spikes S1 (hosted) / S5 (Vercel) (no remote database or deploy by instruction) |

## Deviations from the design

1. **Products are named by their number (P-0042), not their UUID**, on the wire and in requests, and the list travels
   as positional arrays to the browser (perf I10: 2,000 items 125 KB raw / 12 KB gzip instead of 212 / 59 KB). The
   design's item had the UUID first and no unit (pieces only, Haider 11 Oct): 8 places instead of 10.
2. **`share_request` checks the named products with `share_items`' rule directly**, not against the built list (perf
   I11); a product beyond the 2,000-item cap is still requestable.
3. **`share_request` answers `too_many_open`** (its own sentence) rather than `slow_down` for the 10-new-requests cap,
   as the page's states table words it.
4. **The client page checks the answer by hand** (`wire.ts`, unit-tested against the server's schema) instead of Zod,
   to keep its JavaScript within budget.
5. **The rls_attack allowlist lives in `share_attack.sql`** (`anon_executable_functions_exact`,
   `anon_cannot_select_any_table`); `rls_attack.sql` section 1 is unchanged.
6. **No activity is logged when a link is sent** ("Sent the stock link, valid until …"): the card opens WhatsApp or
   the mail app without the Day 4 log step; the language choice is not remembered in localStorage.
7. **Settings' sharing switch sits on the admin-only settings page**; a manager can switch sharing off through the RPC
   (the database allows it) but has no screen for it yet.
8. **Lighthouse not run** (not installed; no new dependency in this session).
9. **E2E names grouped** in `share.spec.ts` (team and public in one serial file); the design's `lead-stock.spec.ts`
   link cases are there.
10. **No Share button in the Inventory header** (design 10.1): sharing starts from Cmd+K "Share stock with…" or the
    lead's Stock tab (the header has no room at 390 px without a menu). Added in the verifier round.

## Rebase points (built before Day 4c, 4d and 5a are merged)

- `private.stock_request_guard`, `private.stock_request_line_guard` (from 6d, unmerged).
- `private.inventory_settings_guard` and policy `inventory_settings_update` (from 6a, unmerged).
- `public.get_inventory_settings` (from 6b, unmerged).
- `private.lead_import_untouched` (from 6d; Day 4c/4d may add their own tables to it): the FK-coverage array in
  `import_attack.sql` now includes `private.share_links`.
- `src/lib/http.ts` (`assertSameOrigin`, `readJsonCapped`) is added here because Day 4c is not merged; if 4c ships
  its own, keep one.

## Hosted dev pre-check (15 Oct 2026)

Advisor item 11 (Day 6 pre-PR review): `client_share.sql` lines 37 to 46 create `share_reader`, grant it to
`postgres` `with set true` and hand it the two anon functions; that was proven only on the local PostgreSQL 16 shim,
where `postgres` is a superuser. Read-only queries through the Supabase MCP, scoped to the DEV project
(`swhkafqlmfhvgpsgdqjp`, `read_only=true`; the session ran as `supabase_read_only_user`). Nothing was written.

| Query | Hosted dev answer |
|---|---|
| `select version();` | PostgreSQL 17.11 (`server_version_num` 170011): 16 or later, so `grant … with set true` parses and works |
| `select rolname, rolcreaterole, rolsuper from pg_roles where rolname in ('postgres','share_reader');` | `postgres`: `rolcreaterole` true, `rolsuper` **false** (also `rolinherit` true, `rolbypassrls` true). `share_reader`: no row (the migration creates it) |
| `current_setting('createrole_self_grant')` | empty: creating `share_reader` gives `postgres` ADMIN on it but neither SET nor INHERIT, hence the migration's explicit `grant share_reader to postgres with set true` |
| `pg_namespace` for `public` | owner `pg_database_owner`; `PUBLIC` has USAGE only (no CREATE); `postgres` owns the database, so it reaches `public` through `pg_database_owner` and can grant on it |
| `pg_database` | `postgres` database owned by `postgres` |

**Reading.** No blocker: `postgres` has CREATEROLE and the server is 17. Because `postgres` is **not** a superuser on
hosted, the ownership hand-over takes the non-superuser path the local runs skip: `ALTER FUNCTION … OWNER TO` needs
SET on the new owner (the `with set true` grant) **and** CREATE for the new owner on the function's schema. The
migration already lends `grant create on schema public to share_reader` around the two `alter function` lines and
revokes it after (lines 1042 to 1046; spike S1). Simulated locally the same day on a scratch PostgreSQL 16.15
cluster (port 54493) with a non-superuser CREATEROLE role that owns the database, `createrole_self_grant` empty, and
`public` with PUBLIC USAGE only: the role block and the self-grant succeed (memberships: ADMIN without SET from the
creation, SET + INHERIT from the explicit grant); `alter function … owner to share_reader` **fails with "permission
denied for schema public"** without the lent CREATE, and succeeds with the migration's grant/revoke pair, leaving
`share_reader` the owner and without CREATE afterwards. The real proof stays the dev deploy (`supabase db push` on
merge to `main`); risk 2 below is narrowed to that run and to S5.

## Docs used (Context7)

`/vercel/next.js` (next.config `headers()`: the last matching entry wins; route handlers; proxy; metadata robots and
referrer; `robots.ts`), `/amannn/next-intl` (request config reading `headers()`, passing a message subset to the
provider), `/colinhacks/zod/v4.6.5` (strictObject, refine), `/supabase/supabase-js` 2.117 (`createClient` auth
options without session persistence, `rpc`), PostgreSQL 16/17 manual (role membership `WITH SET`, function ownership
and `CREATE` on the schema, policies `TO role`, `sha256`, `trim_scale`, pgcrypto `gen_random_bytes`). Verifier round:
`/amannn/next-intl` (`createTranslator` from the core library with a locale and messages; `useMessages`),
`/websites/postgresql_16` (advisory lock functions: `pg_advisory_xact_lock` held to the end of the transaction).

## Open risks

1. **Switch on sharing in production?** (HAIDER DECIDES) Recommended after Gate 1 and the Vercel Pro upgrade (open
   question 11). Until then every link answers "This link isn't active".
2. Spike S1 on the hosted database and S5 on Vercel are unverified here (`spikes.md`): the CI `db` job and the dev
   deploy check S1 (its hosted preconditions were read on 15 Oct: "Hosted dev pre-check" above); the preview check S5, now including whether Vercel overwrites `x-forwarded-host` (verifier
   finding 7).
3. I9's p95 brushes 40 ms on this runner (average 30–33 ms) for 2,000 items.
4. The client list renders up to 2,000 rows without virtualisation (design 10.5); fine at realistic sizes (hundreds),
   unmeasured at 2,000 on a slow phone.
