# Day 6e: the client stock link, 12 Oct 2026

Design: `docs/evidence/day6/design.md` (sections 3.5, 5.5, 6.8, 8, 9, 10.4 to 10.6, 11 and 13 "6e Client stock link"),
with Haider's 11 Oct answers: the client page shows live warehouse inventory with the **max price per piece, excluding
VAT**, never PP (cost) or the minimum price; clients can ask for other stock; links are token-scoped, read-only,
rate-limited and revocable; sharing stays off until he switches it on (open question 11). Built on `day6a-local` after
6d. Fake data only.

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
  `share_link_caps` (definer trigger: 3 active links a lead, 200 an org), `audit_share_link_row` (hash hidden, counters
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

## Rebase points (built before Day 4c, 4d and 5a are merged)

- `private.stock_request_guard`, `private.stock_request_line_guard` (from 6d, unmerged).
- `private.inventory_settings_guard` and policy `inventory_settings_update` (from 6a, unmerged).
- `public.get_inventory_settings` (from 6b, unmerged).
- `private.lead_import_untouched` (from 6d; Day 4c/4d may add their own tables to it): the FK-coverage array in
  `import_attack.sql` now includes `private.share_links`.
- `src/lib/http.ts` (`assertSameOrigin`, `readJsonCapped`) is added here because Day 4c is not merged; if 4c ships
  its own, keep one.

## Docs used (Context7)

`/vercel/next.js` (next.config `headers()`: the last matching entry wins; route handlers; proxy; metadata robots and
referrer; `robots.ts`), `/amannn/next-intl` (request config reading `headers()`, passing a message subset to the
provider), `/colinhacks/zod/v4.6.5` (strictObject, refine), `/supabase/supabase-js` 2.117 (`createClient` auth
options without session persistence, `rpc`), PostgreSQL 16/17 manual (role membership `WITH SET`, function ownership
and `CREATE` on the schema, policies `TO role`, `sha256`, `trim_scale`, pgcrypto `gen_random_bytes`).

## Open risks

1. **Switch on sharing in production?** (HAIDER DECIDES) Recommended after Gate 1 and the Vercel Pro upgrade (open
   question 11). Until then every link answers "This link isn't active".
2. Spike S1 on the hosted database and S5 on Vercel are unverified here (`spikes.md`): the CI `db` job and the dev
   deploy check S1; the preview check S5.
3. I9's p95 brushes 40 ms on this runner (average 30–33 ms) for 2,000 items.
4. The client list renders up to 2,000 rows without virtualisation (design 10.5); fine at realistic sizes (hundreds),
   unmeasured at 2,000 on a slow phone.
