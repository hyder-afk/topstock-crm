# Master Plan section 8 (A to F) at Gate 1, code part (Day 7d)

Status words: **done** (a test, check or record proves it on this branch); **residual** (accepted by Haider, with the
log line); **Day 8** (the ops part of Gate 1: Haider's dashboards, production settings, backup and restore, question 1);
**N/A** (Release 3 feature). "Log line N" is the line number in `docs/log.md`. Dev checks ran read-only through the
Supabase MCP on the dev project (`dev-checks.md`); dev still has main's migrations only (up to Team), so the dev rows
are re-read after the Day 6 and Day 7 PRs deploy.

## A. Secrets and configuration

| # | Item | Evidence | Status |
|---|---|---|---|
| 1 | DB credentials never in client code | 0 `service_role`/`sb_secret_`/`postgres://` in `src`; `scripts/check-build.mjs` on the production build: no server key, no connection string, only the anon JWT (`check-build.md`); CI step added after `next build` | done |
| 2 | No public `.env` | `git ls-files` lists only `.env.example`; `tests/e2e/signed-out.spec.ts` "no repository or environment file is served" (signed out: sign-in redirect) and `gate1.spec.ts` `item2_repository_files_not_served` (signed in: 404, no contents) | done; production URL checked again Day 8 |
| 3 | No hardcoded secrets | gitleaks 8.28.0 full history, all refs, 708 commits after the 7c merge (678 on the base): no leaks (`gitleaks.md`); gitleaks on every PR (`gitleaks.yml`) | done |
| 10 | No debug tools in production | `tests/unit/route-inventory.spec.ts`: every page and route is on the reviewed screen list (59 entries, Master Plan section 5); GraphQL not exposed (`[api] schemas = ["public"]`, log line 64) | done |
| 11 | Logs do not leak | 0 console calls (ESLint `no-console: error`); spike S5: Vercel's runtime logs hold only what the app writes, the app writes nothing (`spike-s5.md`) | done |
| 12 | Generic errors | `gate1.spec.ts` `step5_bad_input_every_api`: every route answers codes only, never database text (a planted leak was caught, `two-user-map.md`); `error.tsx`, `global-error.tsx` | done |
| 13 | No secrets in git history | full-history gitleaks above | done |
| 14 | Only URL and anon key public | `src` reads exactly `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY`; bundle scan finds only anon-role JWTs | done |
| 29 | Environments separate | dev and prod in separate Supabase accounts (Gate 0); dev holds fake data only: 1 lead with no e-mail, 0 contacts, 0 deals, 0 files, 1 auth user on the company domain (`dev-checks.md`); previews behind Vercel login (Standard Protection, log lines 33 to 35) | done (code); Day 8: Haider opens a preview signed out |
| 30 | No default accounts | no seeded users (first account becomes admin); dev has exactly 1 auth user (Haider's own); fixtures only on throwaway stacks | done (dev); Day 8 production accounts |
| 35 | Logs restricted | Vercel, both Supabase accounts and GitHub member lists | Day 8 (Haider) |
| 36 | No source maps | `productionBrowserSourceMaps: false`; `check-build.mjs`: no `*.map`, no `sourceMappingURL` in `.next/static` | done |
| 45 | Admin pages need role and MFA | `gate1.spec.ts` `item45_admin_pages_by_direct_url` (rep gets the not-found page, signed out goes to sign-in, admin gets the screen, on the four admin screens); route inventory: those pages call `requireAdmin()`; the database refuses non-admins too (`team.spec.ts`, `import-security.spec.ts`, `stock-import.spec.ts`) | done |

## B. Authentication, sessions and access control

| # | Item | Evidence | Status |
|---|---|---|---|
| 4 | Invite-only, strong passwords, TOTP for all | `journey.spec.ts` (sign-up refused, two-factor wall); `gate1_attack.sql` G2 (the restrictive two-factor policy on all 36 tables); `gate1.spec.ts` step 3 (an aal1 token reads nothing in any table) | done; Day 8 production auth settings (go-live D1/D2) |
| 5 | Server and RLS check every read and write | route inventory (session helper on every route, action and page); `gate1.spec.ts` step 2 | done |
| 6 | Reps see only their records | `gate1.spec.ts` step 2 (deal, task invisible; lead, contact, entry read-only by design) with every SQL suite (`two-user-map.md`) | done |
| 7 | RLS everywhere, anon revoked | `gate1_attack.sql` G1, G3 to G5; `rls_attack.sql` catalog anon sweep; `gate1.spec.ts` step 3 (anon key on every table and every function over HTTP); dev Security Advisor: 0 ERROR (`dev-checks.md`) | done; dev advisor re-read after the Day 6 and 7 deploys |
| 8 | Cloud settings | private `lead-files` bucket (`files_attack.sql`); dev Storage S3 connection has no keys (Haider, log line 367) | done (dev); Day 8 Vercel settings and production Storage |
| 9 | Guard in proxy and each page; framework updated | proxy wall plus per-page checks (route inventory); `npm audit --omit=dev` 0 vulnerabilities on Next 16.4.0 and supabase-js 2.117.3 | done |
| 15 | No client-only rules | `gate1.spec.ts` step 2 and 4 call the API directly with a rep's token | done |
| 24 | Safe password reset | `journey.spec.ts` (unknown address, same answer); `signed-out.spec.ts` (expired or used link shows the plain message) | done; custom SMTP after go-live (log line 68) |
| 25 | Sessions | `day7a.spec.ts` Sign out of all devices (two browsers); 1 h tokens, refresh rotation | done; residual R2 (other devices up to 1 h), `jwt_expiry` decided Day 8 (log line 366) |
| 26 | No custom JWTs | no JWT signing in `src`; the local stack makes a random secret per run | done |
| 27 | No permissive CORS | no CORS headers anywhere; `assertSameOrigin` on POST routes; `day4-security.spec.ts` `cross_origin_release_403`; `gate1.spec.ts` step 5 | done |
| 33 | IDOR | `gate1.spec.ts` step 2 (lead, contact, deal, task, entry ids of Rep B); `files.spec.ts` `rep_cannot_open_others_file`; product, hold and share-link ids in `stock_attack.sql`, `sales_attack.sql`, `share_attack.sql` | done |
| 41 | service_role least privilege | not used by the app (0 in `src`); the orphan sweeper is an ops script with its own key (Day 7c) | done |
| 47 | Cookie flags | `day7a.spec.ts` (Secure on HTTPS, SameSite Lax); not HttpOnly = Day 1 residual 3 | done; residual 3 (log line 58) |
| 49 | Tenant isolation | `day7a_attack.sql` A2 (both directions between organisations); `gate1.spec.ts` step 4 (`org_id` tamper on a lead and a profile) | done |
| 54 | OAuth | none in Release 1 | N/A |

## C. Input handling and injection

| # | Item | Evidence | Status |
|---|---|---|---|
| 16 | Zod on every route and action | route inventory | done |
| 17 | No SQL injection | `gate1_attack.sql` G6: dynamic SQL only in `list_leads`/`count_leads` (INVOKER, `EXECUTE … USING`) | done |
| 18 | No filter-string injection | 0 `.or(`/`.filter(` with strings in `src`; `gate1.spec.ts` step 5 sends `),id.eq.` input to every API | done |
| 19 | XSS | `gate1.spec.ts` `step5_script_in_text_fields_renders_as_text` (lead, contact, task, product names; a planted `dangerouslySetInnerHTML` is caught); deal titles, notes and file names in their specs; nonce CSP | done |
| 20 | CSRF | Next's Origin check on actions (`cross_site_action_refused`, `cross_site_move_action_refused`); same-origin POST routes | done |
| 21 | File uploads | allowlist, size, magic bytes on upload and open (`files_attack.sql`, `file-sniff.spec.ts`, `files.spec.ts`; real bytes in CI) | done |
| 22 | Path traversal | server-built paths, `files_path_shape` CHECK | done |
| 23 | SSRF | the only server fetches: the auth health URL from the environment and Storage links checked against our origin | done |
| 34 | API output | codes only (`gate1.spec.ts` step 5), strict schemas, share wire format | done |
| 51 | Mass assignment | `gate1.spec.ts` step 4 (role, owner, org through REST and RPC) and step 5 (extra fields to every POST); column grants | done |
| 52 | Command injection | 0 `child_process`/`exec` in `src` | done |
| 53 | Deserialisation | JSON through Zod, papaparse with row caps, 0 `eval`/`new Function` | done |

## D. Abuse, webhooks, headers and data protection

| # | Item | Evidence | Status |
|---|---|---|---|
| 28 | Rate limits | Supabase Auth limits (`config.toml [auth.rate_limit]`); in-app 300 a minute per person on 19 list routes (`day7a.spec.ts` 429); database guards per day | residual R1 (log line 366); Day 8 Vercel Firewall rule (spike S5: Hobby includes one rate-limit rule) |
| 31 | Signed webhooks | no webhooks in Release 1 | N/A |
| 32 | Server-side totals | sale totals and costs computed in the database (Day 6d, `sales_attack.sql`) | done |
| 46 | Security headers | `headers.spec.ts`, `signed-out.spec.ts` (CSP with nonce, `frame-ancestors 'none'`, HSTS, nosniff) | done; Day 8 header check on the production URL |
| 48 | Encryption | TLS; Supabase encryption at rest; no integration secrets in Release 1 | done (record) |

## E. Supply chain, code quality, AI and operations

| # | Item | Evidence | Status |
|---|---|---|---|
| 37 | Vulnerable dependencies | `npm audit --omit=dev`: 0 vulnerabilities; dev tooling: 5 high in eslint-config-next's `braces` chain, build-time only, report-only in CI (`gitleaks.md`) | done; Dependabot alerts on = Haider |
| 38 | Malicious packages | lockfile, `npm ci`, exact pins; `npm audit signatures` could not run here (the session's proxy refuses `tuf-repo-cdn.sigstore.dev`); added to `ci.yml` | prepared, runs in CI later |
| 39 | Prompt injection | no AI in Release 1 | N/A |
| 40 | No production access for AI | `.mcp.json` unchanged since 105fe44: dev project only, `read_only=true`; the MCP answered as `supabase_read_only_user` on `swhkafqlmfhvgpsgdqjp` | done |
| 42 | Audit log | append-only triggers (imports, roles, deletes, file access, stock); sign-in rows (`day7a.spec.ts`, `day7a_attack.sql` B1) | done |
| 43 | Security monitoring | daily digest template (`docs/ops-templates/`, Day 7c) | Day 8 (Haider pastes it into `topstock-ops`) |
| 44 | Backups and restore | templates and runbook (`share_reader` first, Day 7c) | Day 8 (backup, restore test, keep-alive) |
| 50 | Reviewed code | per-day `/security-review` records; the builder's manual pass over the whole release (`security-review.md`, a supplement); advisor before every merge | done: `/security-review` by the main session on 942ab62, 0 HIGH or MEDIUM ([`security-review-command.md`](security-review-command.md)) |

## F. Inventory controls

| # | Item | Evidence | Status |
|---|---|---|---|
| F1 | Stock only through `post_stock_movement` | `gate1.spec.ts` step 8 (direct PATCH/POST/DELETE refused for a rep and an admin; a planted grant was caught); `stock_attack.sql` section 0 | done |
| F2 | Append-only movements with audit | `stock_attack.sql` (`movement_audit_minimal`, immutability), `inventory.spec.ts` `count_sets_quantity_then_movements_log` | done |
| F3 | Step-up for risky stock actions | `stock_attack.sql` section 5 (aal1 and stale code refused), `stock-import.spec.ts` step-up flow | done |
| F4 | Stock sheet validation | `stock_import_attack.sql` (run in today's `db-test.sh`) | done |
| F5 | Last cartons race | `stock_concurrency.sh` `twenty_reservers_one_product` (run in today's `db-test.sh`); `gate1.spec.ts` step 8 (over-reservation refused) | done |

## Gate 1 items beyond the table (Master Plan section 12)

| Item | Evidence | Status |
|---|---|---|
| Two-user attack test | `two-user-map.md` | done |
| Supabase Security Advisor clean | dev: 0 ERROR; WARN `set_user_role` (accepted Day 1) and leaked password protection (accepted, question 4, log line 356); local splinter on all 20 migrations: 0 ERROR | done; re-read on dev after the Day 6 and 7 deploys |
| CSP and headers | item 46 | done |
| Backup and restore tested, keep-alive running | templates ready | Day 8 |
| Hosting decision | Vercel Pro before go-live (6 Oct) | Day 8 |

**Count:** 54 numbered items plus F1 to F5 = 59 rows. **51 done** (2, 4, 8, 29, 30 and 46 also get a production
check on Day 8; 25 and 47 carry an accepted residual; 50 with `/security-review` on 942ab62), **0 pending**, **1 residual** as its status (28: R1, log line 366, with the Firewall rule on Day 8), **3 Day 8 only**
(35, 43, 44), **1 prepared for CI** (38: `npm audit signatures`), **3 N/A** (31, 39, 54).
