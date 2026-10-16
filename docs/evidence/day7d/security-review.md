# Day 7d manual security pass over all of Release 1 (a supplement to `/security-review`)

**`/security-review`: done** by the main session on 942ab62 (`git diff origin/main...942ab62`, all of Day 6 and 7): 0 HIGH
or MEDIUM at confidence 8+, [`security-review-command.md`](security-review-command.md). This file is not that review and is not counted as it. It is the builder's manual pass, done with the same method (read the code paths an attacker can reach,
keep only exploitable findings, rate each, report HIGH and MEDIUM at confidence 8 or more) because the slash command
cannot run inside a sub-agent session. No parallel sub-agents were available in this session (no agent tool); the areas
were reviewed one after the other.

Code under review: `day7f-local` 287430b (main + Day 5 + Team + Day 6 + Day 7a + 7b + the seven 7f follow-ups) plus this
branch's commits, then the first merge of `day7c-local` (624f647): its one change on a security path is read below
(section "Day 7c on a security path").

## Result of the manual pass

**No HIGH or MEDIUM finding at confidence 8 or more.** Nothing needed a fix in product code. Four test gaps found while
reviewing were closed with new checks (below); three informational notes are recorded.

## What was read, per area

| Area | Read (files) | Checked | Proof that runs |
|---|---|---|---|
| Auth and two-factor | `src/app/(auth)/actions.ts`, `src/lib/auth.ts`, `src/proxy.ts`, `src/lib/supabase/*`, `src/lib/auth-events.ts`, `src/app/(app)/step-up-actions.ts` | Zod on every form, codes only, no account enumeration (reset answers the same), `getClaims()` verifies the JWT, aal2 from the auth server not the cookie, enrolment only without a verified factor, `safeNext` allowlist (no open redirect), sign-out-everywhere behind `requireSession()`, step-up window read from the verified `amr` | `journey.spec.ts`, `day7a.spec.ts`, `gate1.spec.ts` step 3 (aal1 token reads nothing anywhere), `gate1_attack.sql` G2 |
| RLS and RPCs | every migration's policies and grants through the catalog (local database after all 20 migrations) | RLS on all 36 tables; the restrictive `require_mfa` policy on all 36; policy roles only `authenticated` and `share_reader`; 45 SECURITY DEFINER functions, each with `search_path ''`, each on a reviewed list with who may call it; no function executable by PUBLIC; dynamic SQL only in `list_leads`/`count_leads` (`EXECUTE … USING`, sort keys from a whitelist, INVOKER) | `gate1_attack.sql` G1 to G7 (15 planted breaks, 15 caught), `rls_attack.sql` (catalog anon sweep), each day's attack file |
| Routes and actions | all 36 `route.ts`, all 18 `"use server"` files (91 exported actions), all 16 app pages under `(app)` | `apiSession()` on every route but the two public share routes (same-origin check and Zod there), `requireSession()`/`requireAdmin()` on every action but the 9 sign-in steps, Zod on every input, `assertSameOrigin` on the POST routes, codes-only answers, `Cache-Control: no-store` on personal data, no `.or()`/`.filter()` strings, no `dangerouslySetInnerHTML`, `eval`, `child_process`, `console` | `tests/unit/route-inventory.spec.ts` (new, 5 planted breaks caught), `gate1.spec.ts` step 5 (every API with oversized, malformed and script-laden input) |
| Import (leads, stock sheets) | `src/app/(app)/leads/import/actions.ts`, `inventory/import/actions.ts`, `src/lib/import/*`, `src/lib/stock-import/*` | admin + fresh code decided in the database, file name cleaned (no controls, slashes, bidi), row caps, staging tables never served, problems files formula-guarded | `import_attack.sql`, `stock_import_attack.sql`, `import-security.spec.ts`, `stock-import.spec.ts`, `csv-out.spec.ts` |
| Files | `src/app/api/files/[id]/route.ts`, `src/lib/files/*`, `file-actions.ts` | server-built paths, magic bytes on upload and on every open, the signed link checked against our own Supabase origin before any fetch (no SSRF), 60 s links, Sec-Fetch-Site check, no referrer | `files_attack.sql`, `files.spec.ts` (storage parts in CI), `file-sniff.spec.ts` |
| Share link | `src/app/api/share/*`, `src/lib/share/*`, `20261020090000_client_share.sql`, `20261022130000_share_take_paris_day.sql` | token made in the database (256 bits), only `sha256(token)` stored, carried in the URL fragment, functions owned by `share_reader` (no bypass, own policies on eight reviewed tables), per-IP limiter keyed on `x-forwarded-for` (Vercel overwrites it, spike S5 below), per-link and per-org limits in the database, no cost ever in the answer | `share_attack.sql`, `share.spec.ts`, `gate1_attack.sql` G3 and G4 |
| Inventory | `post_stock_movement` and the stock migrations, `src/app/(app)/inventory/**/actions.ts`, inventory routes | `stock_levels` select-only for everyone, row lock, no negative stock, no over-reservation, step-up on adjustments and imports, append-only movements with audit | `stock_attack.sql`, `stock_concurrency.sh` (`twenty_reservers_one_product`), `gate1.spec.ts` step 8 |
| Configuration and supply chain | `next.config.ts`, `supabase/config.toml`, `.mcp.json`, `.github/workflows/*`, `package.json` | security headers and nonce CSP, `productionBrowserSourceMaps: false`, only the two `NEXT_PUBLIC_` values in `src`, MCP dev-only and read-only, actions pinned by digest, exact dependency pins | `headers.spec.ts`, `signed-out.spec.ts` (new: repository files not served), `scripts/check-build.mjs` (new), gitleaks and `npm audit` (README) |

## Gaps closed while reviewing (tests, not product fixes)

| # | Gap | New check |
|---|---|---|
| T1 | No catalog-wide rule that every table has the two-factor policy, that SECURITY DEFINER functions are reviewed, that nothing is executable by PUBLIC, and where dynamic SQL lives | `supabase/tests/gate1_attack.sql` (in `db-test.sh` and `db.yml`) |
| T2 | No proof that every route, action and page checks the session and parses with Zod, and no list of allowed screens (item 10) | `tests/unit/route-inventory.spec.ts` |
| T3 | Production bundle not scanned for server keys, connection strings or source maps (items 1, 14, 36) | `scripts/check-build.mjs`, a CI step after `next build` |
| T4 | `deal_links_attack.sql` left committed deals behind, so Day 5a mutation row 58 failed for the wrong reason (plan item 20) | fixtures in the block bodies, the setup clears r1's deals (two commits) |

## Informational notes (below MEDIUM, no change)

1. **Sequences in `public` on the real Supabase image** may carry Supabase's default grants to `authenticated`
   (`audit_log_id_seq`, `deal_stage_history_id_seq`); the local shim does not copy those defaults, so it cannot be
   checked here. Not reachable: PostgREST exposes no function that calls `nextval` or `setval`. `gate1_attack.sql` G7
   leaves sequences out for that reason; a later migration may revoke them.
2. **`profiles.role` has one layer against self-promotion**: the column grant (only first name, last name, language and
   time zone are updatable). A planted grant on `role` let Rep A become admin and `gate1.spec.ts` step 4 caught it; the
   role-change lock trigger guards `set_user_role`, not direct updates. One layer that a test watches is enough here.
3. **The proxy skips requests that carry a prefetch header** (Next.js's documented matcher). Such a request still meets
   the per-page and per-route session checks (T2 proves every one has them); only the first wall is skipped.

## Day 7c on a security path

`src/proxy.ts`: `publicPaths` gains `/manifest.webmanifest`, so the web app manifest is served without a session
(browsers fetch it without cookies). It is generated by `src/app/manifest.ts` from constants (name, short name, colours,
`display: standalone`, icon paths); it reads no session, cookie, database or environment value. Nothing else in the
wall changed: the match is exact (`path === p` or under `p/`, and nothing lives under that path). Metadata routes such as
`manifest.ts` are outside the route inventory's patterns (`route.ts`, `page.tsx`); this one was read by hand. No finding.

## Accepted residuals restated (no change)

Day 1 residuals 1 to 5 and Day 7a R1 to R3: see `README.md`, "Residual risks". The leaked-password WARN is accepted
(Haider, question 4, 15 Oct 2026).
