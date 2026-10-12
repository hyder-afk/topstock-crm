# Day 6e security review (12 Oct 2026)

Scope: every 6e commit (b326afb to the evidence commit): `supabase/migrations/20261020090000_client_share.sql`,
`share_attack.sql`, `share_concurrency.sh`, `perf_share.sql`, the changes to `import_attack.sql` and `stock_attack.sql`,
`scripts/db-mutations.py` (day6e), `scripts/app-mutations.py`, `src/lib/share/**`, `src/lib/http.ts`,
`src/lib/share-links-server.ts`, `src/app/api/share/**`, `src/app/api/inventory/share-*`, `src/app/(share)/**`,
`src/app/(app)/inventory/{share,client-view,settings}/**`, `src/components/share/**`, `src/components/share-links/**`,
`src/proxy.ts`, `next.config.ts`, `src/i18n/**`, `src/app/robots.ts`, `eslint.config.mjs`, `.gitleaks.toml`, messages.
Method: the `/security-review` checklist (CLAUDE.md SECURITY, Master Plan 8 A to F) read against the diff, plus the
design's public-surface checklist (section 9, P1 to P16; `threat-model.md` maps each to its passing checks).

## Result

No high-confidence vulnerability.

## What was checked

| Area | Finding |
|---|---|
| Public surface | Anon can execute exactly `share_view` and `share_request` (catalog test); both are definer, VOLATILE, `search_path = ''`, static SQL, owned by `share_reader` (nologin, noinherit, no bypass, nobody's member) whose column grants cover only what the page shows, bound by policies to the presented token's hash and its organisation |
| Secrets | 256-bit tokens made by the guard (`gen_random_bytes(32)`); only `sha256` stored, never granted to `authenticated`, hidden in the audit; the token travels in the fragment and in POST bodies only; `create_share_link` reads the transaction-local token once and blanks it; the action builds the address from its own validated host; nothing logs it (ESLint `no-console` scope; e2e: no request URL holds it, no audit row holds it) |
| Enumeration | One answer for every non-working link; the format check before any read; no per-token counters; "slow down" only for working links |
| Input | Route: `Content-Type` JSON, byte caps (2 KB, 16 KB) read as a stream, same Origin, Zod `strictObject` with clean-text rules (no controls, zero-width, direction characters or lone surrogates), honeypot and time trap before any database call; function: the same shape checks as text with one "invalid"; products resolve only among the visible ones, by number; no user text in any filter string |
| Output | The route re-parses the answer strictly and sends only whitelisted fields; the page checks them again (`wire.ts`); React text only; no `dangerouslySetInnerHTML`; product names with markup render as text (e2e) |
| Headers | Share CSP `default-src 'none'` with `connect-src 'self'` (no Supabase origin), `frame-ancestors 'none'`, `base-uri 'none'`; `Referrer-Policy: no-referrer`, `X-Robots-Tag`, `Cross-Origin-Resource-Policy: same-origin`, `Cache-Control: no-store`; no cookie read or written on `/s` and `/api/share` (`headers.txt`) |
| Session isolation | The proxy's share branch returns before the Supabase block; the server's anon client is created per call without cookies or session persistence; the functions are not granted to `authenticated` |
| Abuse and cost | Database limits per link and per organisation (views and requests), ≤ 10 new requests a link, one open task a lead, idempotency; unknown tokens write nothing; a 2,000-item cap after the filter; "unchanged" polls; per-IP limiter per instance; kill switch off by default |
| Team side | Making a link: an editor of the lead with a fresh code (guard and RPC); revoke without a code, permanent; extend with a fresh code and bounds; 3 active links a lead and 200 an organisation (a definer trigger that only counts); sharing on: an admin with a fresh code; off: a manager or an admin; every list and action goes through invoker RPCs under RLS (`require_mfa` on both new tables) |
| Definer code | Trigger functions only (`share_link_caps`, `audit_share_link_row`, `stock_request_task`), owner postgres, revoked from everyone; plus the two anon functions above |
| Keys and data | No secret in the diff; gitleaks gains the `topstock-share-token` rule (`tss_` plus 43 characters) with an allowlist for repeated-letter test tokens; every fixture is invented |

## Residual risks

1. A direct PostgREST caller skips the Next layers (Origin, honeypot, time trap, per-IP limiter); the database limits
   hold on both paths (design 8.7, accepted).
2. A forwarded link shows the stock to whoever has it until it is revoked or expires (by design; the page says so, the
   team sees opens and requests).
3. Spike S5 (Vercel's `x-forwarded-for`, Firewall rules, log contents) is unverified until a preview deployment; the
   limiter falls back to one shared key when the header is absent; if the platform passed a client's own header
   through, a caller could rotate it past the per-IP limiter, never past the database limits.
