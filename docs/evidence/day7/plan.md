# Day 7 plan: Security gate 1 and polish

Written 15 Oct 2026 by the builder, docs only, on local branch `day7-local` from `origin/main` 2c86eba.
Scope: Master Plan section 9 Day 7 ("Run the full checklist in section 8 (A to F), two-user attack test,
`/security-review`, Supabase Security Advisor. French pass. Mobile pass (PWA manifest, bottom dock 5 items).
Skeleton, empty and error states on every list. Animation polish with an `/apple-design` audit. Accessibility pass.")
Read for this plan: Cloud Workflow, START_HERE (sections A, B, G, H, I), DESIGN.md, Master Plan sections 0, 8, 9, 12,
13, Lean Tooling Protocol, `docs/log.md` on every branch, the evidence READMEs, `docs/go-live.md`.

**Where things are.** Paths are given with the branch that holds them:
- **[main]** `origin/main` 2c86eba (Days 1 to 4d).
- **[5]** `day5a-local` 5f240f3 (worktree `/home/user/topstock-crm-5a`): Day 5 pipeline and Home.
- **[T]** `team-local` 877b9b5 (`/home/user/topstock-crm-team`): More > Team and the role-change lock.
- **[6]** `day6a-local` 62e87c8 (`/home/user/topstock-crm-6a`): Day 6 inventory; already holds main, 4d, Day 5 up to
  b9c05db and Team 877b9b5. It does **not** yet hold Day 5's last two commits (ae157cf, 5f240f3: deal delete
  admin-only again).

**Precondition (before Day 7 starts).** Gate 1 is run on `main` with all of Release 1 in it. So the Day 5 PR, then
the Team PR, then the Day 6 PR merge first (each with advisor APPROVED and green CI), and `deploy-dev-db` has applied
their migrations to dev. Two known items go into those PRs, not into Day 7: Team's manager wording ("deletes leads
and deals with a code") must follow Day 5's admin-only deal delete, and Team's `/security-review` is repeated on its
final head (`docs/evidence/team/README.md`, open risks).

**Scope A, compressed (Haider 15 Oct 2026: "Day 7 scope A", all 14 recommendations in section 5 yes).** The nine steps
first planned (7a to 7i) become **four PRs** (section 4): **7a** security fixes and the audit harness, **7b** the switch
to the app's own pickers (no native pickers or popups, Haider 15 Oct) plus loading, empty and error states on every
list, **7c** French and phone pass plus the orphan sweeper, **7d** the Gate 1 run. Deep speed tuning, the full
accessibility pass, PWA extras and animation polish are **deferred** (section 4, "Deferred"); the speed misses left are
written down as the Release 1 baseline (question 14). The replacement picker components are built ahead of 7b on
`day7-local` (`docs/evidence/day7/pickers.md`). Step names in sections 1 to 3 and section 5 keep the first split; read
them as: old 7a and 7b → **7a**; old 7d → **7b**; old 7c (sweeper, runbooks), 7e and 7f → **7c**; old 7i → **7d**;
old 7g and 7h → deferred, except the items named in the new table (re-timing on a GitHub runner moves to 7d).

---

## 1. Gate 1 checklist (Master Plan section 8, A to F)

Who: **B** builder (code, tests, read-only dev checks), **H** Haider (a dashboard or a click), **B+H** both.
"Proven" means a test or record that exists today. "Day 7" is what is still to do, with the step from section 4.

### A. Secrets and configuration

| # | Requirement | Proven today | Day 7 | Who |
|---|---|---|---|---|
| 1 | DB URL and service key only on the server | No service key anywhere in `src` (only the local test stack's demo keys in `scripts/local-auth/*`); CI uses the local stack's demo keys (`docs/evidence/day1-step2/security-review.md`) [main] | Scan the production build (`.next/static`) for `service_role`, `sb_secret_`, `postgres://` and JWT-shaped strings; CI step (7a) | B |
| 2 | No public `.env` | `.gitignore` ignores `.env*` except `.env.example` [main] | Record `git ls-files \| grep env`; signed-out e2e: `GET /.env` answers 404 (7a). Production URL checked again on Day 8 | B |
| 3 | No hardcoded secrets | gitleaks on every PR and push, digest-pinned (`.github/workflows/gitleaks.yml`), `.gitleaksignore` with reasons; builder runs gitleaks before each push [main] | Full-history `gitleaks git` on the gate head, output in evidence (7i) | B |
| 10 | No debug tools in prod | GraphQL not exposed (`[api] schemas = ["public"]`, log 9 Oct); `deploy-dev-db` reads back the exposed schemas [main]; spike pages never committed (log 14 Oct [5]) | Route inventory: every page and route under `src/app`, each tied to a screen in Master Plan section 5; nothing else (7a) | B |
| 11 | Logs do not leak | ESLint `no-console: error`; 0 console calls in `src`; constant SQL error messages [main] | Note the decision "no app logging at all" in the gate file; check Vercel runtime logs carry no POST bodies (spike S5 [6] `docs/evidence/day6e/spikes.md`) | B+H |
| 12 | Generic errors | `error.tsx`, `global-error.tsx`; codes-only API answers (`tests/auth/day4-security.spec.ts` `error_copy_has_no_sql`) [main] | Extend the codes-only check to every Day 5 and Day 6 API family (7a) | B |
| 13 | No secrets in git history | Full-history gitleaks 9 Oct (log row 39) [main] | Re-run on the gate head (7i) | B |
| 14 | Only URL and anon key public | `src` reads only `NEXT_PUBLIC_SUPABASE_URL` / `..._ANON_KEY`; share bundle scan [6] `docs/evidence/day6e/` | List every `NEXT_PUBLIC_*` plus the bundle scan of item 1 (7a) | B |
| 29 | Environments separate | Dev and prod in separate Supabase accounts (Gate 0, log 9 Oct); previews behind Vercel login (Standard Protection, decided 9 Oct) | H opens a preview link while signed out of Vercel and sees Vercel's login; B confirms dev holds fake data only (read-only MCP counts) (7i) | B+H |
| 30 | No default accounts | No seeded users; first account becomes admin (core schema) [main] | List dev auth users read-only (count, test domains); H decides whether leftover fake test users on dev are removed; prod accounts on Day 8 parts F and K | B+H |
| 35 | Logs restricted | none recorded | H checks the member lists of Vercel, both Supabase accounts and GitHub (three people at most) | H |
| 36 | No source maps in prod | `productionBrowserSourceMaps: false` (`next.config.ts`) [main] | CI step after `next build`: no `*.map` under `.next/static` (7a) | B |
| 45 | Admin pages need role and MFA | Team: non-admins get a 404 and the database refuses (`tests/auth/team.spec.ts` [T]); imports admin-only with a fresh code (`tests/auth/import-security.spec.ts` [main], stock import [6]) | One direct-URL run as a rep and signed out over `/leads/import`, `/inventory/import`, `/inventory/settings`, `/more/team` (7i) | B |

### B. Authentication, sessions and access control

| # | Requirement | Proven today | Day 7 | Who |
|---|---|---|---|---|
| 4 | Invite-only, strong passwords, TOTP for all | Public sign-up answers `signup_disabled` (`tests/auth/journey.spec.ts`), `deploy-dev-db` proves it on dev; 12+ mixed passwords; restrictive aal2 policy on every table plus the proxy wall (`src/proxy.ts`, `src/lib/auth.ts`); no domain rule (Haider 9 Oct) [main] | Catalog test: every table in `public` and `private` has RLS on and the restrictive two-factor policy, or is on a reviewed list (7a). Prod settings: go-live part D1/D2 on Day 8 | B+H |
| 5 | Server and RLS check every read/write | `requireSession`/`apiSession` in every page and action; per-day attack tests | Route inventory test: every `route.ts` and `actions.ts` calls the session helper and parses with Zod; fails on a new file that does not (7a) | B |
| 6 | Reps see only their records | `supabase/tests/rls_attack.sql`, `activity_attack`, `outcome_attack`, `queue_attack`, `files_attack` [main]; `deals_attack` [5]; `stock_attack`, `sales_attack`, `share_attack` [6] | One consolidated two-user run over every object type (7i) | B |
| 7 | RLS everywhere, anon revoked | `rls_attack.sql` section 1, but its anon loop is a **hard-coded list of Day 1's 12 tables and 6 functions** (lines 88 to 110); splinter in CI (`scripts/db-advisors.sh`); dev advisors after every deploy (log) [main] | Catalog-driven anon sweep over every table, view and function in `public` and `private` (allowlist: `share_view`, `share_request`); anon-key requests to every PostgREST table in CI against real PostgREST (7a); Security Advisor on dev after Day 6 deploys (7i) | B |
| 8 | Cloud settings | Private `lead-files` bucket, 3 exact policies, 60 s links (`files_attack.sql` `bucket_private`, `storage_policies_exact`) [main] | H reviews Vercel (protection, env scopes, nothing secret in Preview) and Supabase Storage > S3 connection off (log row 200) | H |
| 9 | Guard in proxy and each page | Proxy wall plus per-page checks; Next 16.4.0 | Check Next.js and Supabase security advisories for the pinned versions (7i) | B |
| 15 | No client-only rules | `rep_direct_rpc` (`day4-security.spec.ts` [main]), `day5-security.spec.ts` [5], share and sales specs [6] | Covered by the 7i run | B |
| 24 | Safe password reset | Supabase flows, same answer for unknown addresses (journey test), redirect allowlist, one reset a minute [main]. On dev reset is off until custom SMTP (log row 68) | Add an expired-link test if missing (7b); custom SMTP stays Haider's "next week" item | B+H |
| 25 | Sessions | `@supabase/ssr` cookies, refresh rotation, 1 h tokens [main]. **No sign-out-everywhere**: `signOut` uses `scope: "local"` (`src/app/(auth)/actions.ts:54`). Idle timeout and timebox are paid-plan settings | "Sign out of all devices" on More, e2e with two browser contexts (7b) | B |
| 26 | No custom JWTs | None in `src`; the local stack makes a random secret per run [main] | Grep recorded (7a) | B |
| 27 | No permissive CORS | No CORS headers; `assertSameOrigin` (`src/lib/http.ts`, `tests/unit/http.spec.ts`), `cross_origin_release_403` [main] | Cross-origin fetch against each API family (7i) | B |
| 33 | IDOR | UUID ids; `api_refuses_other_org_ids` and per-day id tests | ID-swap run over lead, deal, task, file, product, hold, share link (7i) | B |
| 41 | service_role least privilege | Not used anywhere in the app | The orphan sweeper is the first use, only in an ops script run from `topstock-ops` (section 3, step 7c) | B+H |
| 47 | Cookie flags | SameSite Lax; not HttpOnly (accepted residual 3, `day1-step2/security-review.md`); **Secure flag not verified** | Check the auth cookies on an HTTPS response; set `secure: true` in production cookie options if missing, with a test (7b). `__Host-` is not possible with Supabase's cookie names (record) | B |
| 49 | Tenant isolation | `org_id` everywhere; other-org tests per day. **Gap:** `private.enforce_org_and_owner` does not check that a manager-chosen owner is in the same org (log 15 Oct [5], "Multi-org hardening"); Day 5 adds `p_owner` to `open_deal`/`update_deal` | Migration with tests and mutation rows (7b), unless Haider accepts the residual (question 5) | B |
| 54 | OAuth | N/A in Release 1 (Zoom is Release 3) | Record N/A | B |

### C. Input handling and injection

| # | Requirement | Proven today | Day 7 | Who |
|---|---|---|---|---|
| 16 | Zod on every route and action | Strict Zod schemas per day (each README) | Route inventory test of item 5 (7a) | B |
| 17 | No SQL injection | Static SQL; `EXECUTE ... USING` with whitelisted sort parts (Day 3a); `plpgsql_check` per day | List every dynamic `execute`/`format(` in the migrations with a one-line review (7a) | B |
| 18 | No filter-string injection | Search through RPC; `),id.eq.` stored verbatim (Day 4 threat 27) | Record 0 uses of `.or(`/`.filter(` in `src`; search fuzz in the 7i run | B |
| 19 | XSS | 0 `dangerouslySetInnerHTML`; nonce CSP (`src/proxy.ts`); `xss_note_is_text` [main] | Payloads in every text field incl. deal, product, sale, request and share fields (7i) | B |
| 20 | CSRF | Server actions' Origin check (`cross_site_action_refused`); JSON routes same-origin; share routes carry no cookie | Covered by 7i | B |
| 21 | File uploads | Allowlist, 10 MiB, magic bytes on upload and on every open, private bucket (`files_attack.sql`, `tests/unit/file-sniff.spec.ts`) [main] | Disguised-file upload in 7i; stray bytes after Cancel removed by the sweeper (7c) | B |
| 22 | Path traversal | Server-built paths, `files_path_shape` CHECK [main] | none | B |
| 23 | SSRF | The only server fetch is the fixed Supabase auth health URL (`src/app/(app)/more/page.tsx`) | Record the review (7a) | B |
| 34 | API output | Codes-only answers, strict schemas, share `wire.ts` [6] | With item 12 (7a) | B |
| 51 | Mass assignment | Column grants plus strictObject; server-column attack checks per day | Role and owner tamper in 7i (two-user step 4) | B |
| 52 | Command injection | 0 `child_process`/`exec` in `src` | none | B |
| 53 | Deserialisation | JSON through Zod; papaparse pinned with row limits; 0 `eval`/`new Function` (Zod jitless) | none | B |

### D. Abuse, webhooks, headers and data protection

| # | Requirement | Proven today | Day 7 | Who |
|---|---|---|---|---|
| 28 | Rate limits | Supabase Auth limits (`supabase/config.toml` `[auth.rate_limit]`); database guards: entries and tasks 60 a minute, uploads 30 an hour [main], deals 30 an hour and 120 moves a minute [5], share per link, per org and per IP [6]. **Missing:** a counter for search and list APIs (`/api/leads` and friends), and a Vercel Firewall rule | `private.rate_hits` counter with a guard on search/list routes, 429 e2e (7b); Firewall rule after the Pro upgrade (H, Day 8; spike S5) | B+H |
| 31 | Signed webhooks | N/A until Release 3 | Record N/A | B |
| 32 | Server-side totals | No payments; sale totals computed in the database (Day 6d) [6] | Record | B |
| 46 | Security headers | Headers on every route and on redirects (`tests/e2e/signed-out.spec.ts`, `tests/unit/headers.spec.ts`); nonce CSP with `frame-ancestors 'none'`; HSTS without preload until a custom domain [main] | Header check on a preview response (H opens securityheaders.com with the production URL on Day 8, or B reads it in CI) | B+H |
| 48 | Encryption | TLS, Supabase encryption at rest; no integration secrets in Release 1 | Record | B |

### E. Supply chain, code quality, AI and operations

| # | Requirement | Proven today | Day 7 | Who |
|---|---|---|---|---|
| 37 | Vulnerable dependencies | `npm audit --omit=dev --audit-level=high` fails CI (`ci.yml` line 38) [main]. **Dependabot alerts not on** (`.github` holds workflows only) | H: GitHub > Settings > Advanced Security > Dependabot alerts on (free). B records `npm audit` at the gate | B+H |
| 38 | Malicious packages | Lockfile, `npm ci`, exact pins, no release under two weeks (log) | `npm audit signatures` and the dependency list in evidence (7a) | B |
| 39 | Prompt injection | N/A until Release 3 | Record N/A | B |
| 40 | No prod access for AI | `.mcp.json` dev-only, read-only (verified 9 Oct, `docs/preflight.md`); prod in account B [main] | Re-check `.mcp.json` unchanged (7a) | B |
| 42 | Audit log | Append-only `audit_log` triggers: imports, role changes, deletes, `file_access` [main]. **Logins not logged** and no `ip` column (deferred to Gate 1, log row 64); no exports exist yet | "Signed in" audit row from the sign-in action, no IP (7b; question 9); an e2e "do it, read the log" per audited action (7i) | B |
| 43 | Security monitoring | none | `security-digest.yml` ops template: daily read of failed sign-ins, role changes, deletes, imports; a red run makes GitHub email Haider (7c). H pastes it into `topstock-ops` on Day 8 | B+H |
| 44 | Backups and restore | Templates `docs/ops-templates/backup-prod.yml`, `restore-into-dev.md`, `keep-alive.yml` [main] (go-live parts G to I) | Add "create role `share_reader` before `pg_restore`" to the restore runbook (spike S1, `docs/evidence/day6e/spikes.md` [6]) (7c). H runs parts G to I on Day 8 | B+H |
| 50 | Reviewed code | Branches, PRs, CI, advisor and `/security-review` on every PR (log) | `/security-review` over the whole of Release 1 on the gate head (7i) | B |

### F. Inventory controls (all built on [6]; proven again on `main` after the Day 6 merge)

| # | Requirement | Proven today | Day 7 | Who |
|---|---|---|---|---|
| F1 | Stock only through `post_stock_movement` | `stock_levels` select-only grant (`20261016090000_stock_engine.sql` line 1063); `stock_attack.sql`, `stock_concurrency.sh` [6] | Two-user step 8 in 7i | B |
| F2 | Append-only movements with audit | `audit_inventory_row` triggers [6] | "Adjust, read the log" e2e in 7i | B |
| F3 | Step-up for risky stock actions | `has_recent_aal2` in stock engine, stock import, sales, share migrations [6]; lead import and roles [main] [T] | aal1 and stale-code refusal for each action in 7i | B |
| F4 | Stock sheet validation | `stock_import_attack.sql`, `tests/fixtures/stock` [6] | Re-run on `main` | B |
| F5 | Last cartons race | `stock_concurrency.sh` `twenty_reservers_one_product` [6] | Re-run on `main` | B |

### Gate 1 items beyond the table (Master Plan section 12)

| Item | Status | Day 7 | Who |
|---|---|---|---|
| Two-user attack test, steps 1 to 8 | Each step exists per day; no single run | 7i runs all 8 on `main` and maps each to its test (step 7 "hammer login/reset/search": Supabase limits for auth, the 7b counter for search) | B |
| Supabase Security Advisor clean | Dev: 0 ERROR; WARN `set_user_role` (accepted Day 1), leaked password protection (paid plan only); Day 6 adds `anon_security_definer_function_executable` on `share_view`/`share_request` (accepted, [6] log) | Dev advisors (security and performance) after the Day 6 deploy and after 7b/7c (7i) | B |
| Account hardening (MFA on every account) | Gate 0 passed 9 Oct | none | H |
| Backup and restore tested, keep-alive running | Templates ready | Day 8 parts G to I, before any real data (question 1) | H |
| Hosting decision | Vercel Pro before go-live (6 Oct) | Day 8 part B | H |

---

## 2. Collected Day 7 follow-ups

Sources searched: `docs/log.md` and every evidence README and audit on [main], [5], [T] and [6] for "Day 7", "Gate 1",
"polish", "follow-up" and "carried". Items marked *(found while planning)* had no row anywhere.

### Security gate
1. **Orphan sweeper** for `lead-files` objects with no files row (residual risk 7: stray bytes sent with a signed upload
   link after Cancel count toward the 800 MiB). Log row 245 [main]; `docs/evidence/day4/design.md` lines 849, 898,
   1394; `day4d/README.md` line 385 (spike S5); `day4d/security-review.md` lines 131 to 142. Section 3; step 7c.
2. **`private.enforce_org_and_owner` multi-org owner check.** [5] log 15 Oct "Multi-org hardening" and "Day 7 follow-ups".
   Step 7b (question 5).
3. **Rate-limit table and daily security digest including `file_access`.** `day4/design.md` line 1393;
   `day4a/README.md` line 165; `day4a/security-review.md` line 79. Steps 7b, 7c.
4. **Logins in the audit log; `audit_log.ip`.** Log row 64 [main]. Step 7b (question 9).
5. **Day 1 residual risks "revisit at Gate 1"**: enrol-on-first-sign-in, one shared per-IP auth bucket behind Vercel,
   cookies readable by scripts, no recovery codes, custom SMTP. `day1-step2/security-review.md` lines 26 to 35. Re-read
   and restate in the gate file (7i); none needs code in Day 7.
6. **Custom SMTP**, then restore the custom invite/recovery templates and the three security notices and remove
   `scripts/strip-email-templates.py`. Log rows 68 and 191 ("next week"). After go-live.
7. **Vercel header behaviour** (spike S5): is `x-forwarded-for` overwritten, does `x-forwarded-host` pass through, are
   POST bodies kept out of runtime logs, is a Firewall rule free. `docs/evidence/day6e/spikes.md` "S5" and
   `day6/design.md` line 240 [6]. 7i: answer from Vercel's docs (Context7), then a look at the preview by Haider.
8. **Restore needs `create role share_reader` first.** [6] log 11 Oct (spike S1); `day6e/spikes.md` line 22. Step 7c.
9. **Team wording after the admin-only deal delete** (Day 5 ae157cf/5f240f3 are not in [T] or [6]). [T] log 15 Oct
   "Team advisor item 3"; [5] log "Deal delete is admin-only again". Fixed in the Team PR before Day 7.
10. **`supabase config push --yes` also approves paid add-ons.** Log row 71 [main]. Step 7a (replace with a diff check).
11. *(found while planning)* **Anon test covers Day 1 tables only** (`rls_attack.sql` lines 88 to 110). Step 7a.
12. *(found while planning)* **No sign-out-everywhere; cookie Secure flag unverified.** `src/app/(auth)/actions.ts:54`.
    Step 7b.
13. *(found while planning)* **Dependabot alerts off.** Haider, one setting.
14. **Leaked password protection WARN** on the dev advisor. Log rows 110, 133, 237; go-live decision 5: the switch
    exists only on Supabase's paid plan. Question 4.
15. **Gate 1 data checks on dev**: `has_contact_phone_consistent` and `call_zone_matches_map` must return 0.
    `day4c/mutations.md` lines 332 to 333; `day4/design.md` line 413. Step 7i.
16. **Gate 1 size query and egress**: `audit_log`, `activities`, `tasks`, `companies`, plus `stock_movements` and
    orders; egress read weekly. `day4/design.md` line 544; `day6/design.md` lines 757 to 758 [6]. Step 7i.
17. **Storage S3 connection off** on dev (Haider checks). Log row 200 [main].
18. **pg_cron** on dev and prod (the nightly stock job runs only if it is installed). [6] log 15 Oct (HAIDER DECIDES);
    `day6a/README.md` open risk 4. Question 3.
19. **Sharing switched on in production** after Gate 1 and Vercel Pro. `day6e/README.md` open risk 1. Day 8 question.
20. **`supabase/tests/deal_links_attack.sql` [5], block 2**, found via Day 5a mutation row 58: it creates its deals with
    `pg_temp.su_deal(…)` in the block's `DECLARE`, so they survive the block's TS001 rollback. Move the calls into the
    block body, or clean `public.deals` for r1 in setup next to the `private.deal_opens` reset; then re-run Day 5a
    mutation rows 64 to 73 in the Day 7 full pass (scope A 7d). Also hide the deal Delete item client-side once
    `created_at` + 120 s has passed (the server already refuses it). Scope A step 7a.

### No native pickers or popups (Haider 15 Oct 2026)
1. **Rule:** "do not keep any native pickers or popups on the app". Audit: `ui/select.tsx` was a styled native
   `<select>` (about 37 call sites on the combined code), 13 raw `<select>`s, 15 native date, time and datetime-local
   inputs, about 27 `title=` tooltips, native validation bubbles (auth forms, status menu, quick add, hold sheet have no
   `noValidate`), the WebKit clear cross on `type="search"`, one `<summary>` marker.
2. **Components built first** on `day7-local` (Select, Combobox, DatePicker and DateRangePicker, TimePicker,
   DateTimePicker, Tooltip, SearchInput, CSS safety net): `docs/evidence/day7/pickers.md` with the call-site guide.
3. **Call sites switched in scope A step 7b** on the combined code, with the e2e tests that use `selectOption` or `fill` on a date
   field moved to clicks and typing (`tests/auth/screens`, `import`, `import-perf`, `lead-page`, `leads`, `tasks`).

### Speed
1. **Day 4b**: tab switch 105 to 155 ms (100), route change 209 to 334 ms (200), 1,000-entry timeline frames 25 to 31 ms
   (16.7). Accepted "revisit in Day 7", log row 179 [main].
2. **Day 4c queue**: longest task 58 to 112 ms (50); loading card on fast key bursts. Log row 222; `day4c/README.md`
   lines 326 to 337 [main].
3. **Day 5 decision A** ("accept as baseline, polish in Day 7"): move painted p95 ~585 ms (100), drag frames ~23 ms
   (16.7), long tasks 68 to 96 ms (50), settle ~690 ms (450), Home to Pipeline after hover ~2 s (200), skeletons
   84 to 174 ms (100), Pipeline to Home ~430 ms (200), Home's first-seconds frame. [5] log 15 Oct;
   `day5b/perf.md` lines 89 to 101; `day5c/perf.md` lines 73 to 115.
4. **Day 5a database misses, not yet decided**: rep's board 17.8 to 19.4 ms (15), a move touching the lead 9.9 to 11.7 ms
   (10), P10 p95 35 to 58 ms (20); round-2 triggers never re-timed. `day5a/README.md` open risks 1 and 8 [5].
5. **JS headroom**: pipeline route 56.3 of 60 KB, Home 10.3 of 20 KB. [5] log "Day 7 follow-ups". Every 7d to 7h change
   re-measures with `day4-chunks`/`day5-perf`.
6. **Skeleton without hover** possibly slower; within the spread. [5] log; `day5c/perf.md` line 112.
7. **Day 6 database timings to re-time** (all "re-time on dev first"): Arrived 4.1 to 5.8 ms (5; Haider 11 Oct "accept,
   re-check in CI", log row 164), I18 not provable (6a), I1/I2 sorts (6b), 5,000-row stock import 30.8 to 32.6 s (30;
   6c), I6 46 to 60 ms (40; 6d), I8 ~15 ms (6d), I9 p95 over 40 ms (6e), client list of 2,000 rows not virtualised (6e
   risk 4). [6] READMEs. Also Day 3b P7 and undo before Gate 1: `day6a/perf.md` line 147, `day4a/perf.md` line 122.
   Question 11 (where to re-time).
8. **Count-up layout shift** seen once on Chromium 141. [5] log.

### Design polish (animation)
1. **Dock notch and drag stretch** (Haider 9 Oct: halo bead for Release 1, "looked at again in the Day 7 animation
   polish"). Log row 94 [main]; `day2/apple-design-audit.md` line 25. Question 6.
2. **Dock badges; swipe gestures on cards and file rows.** `day5/design.md` line 1557 [6]; `day4/design.md` line 1389;
   `day4d/apple-design-audit.md` line 50. Question 7.
3. **Page entrances are CSS keyframes, not springs; the command menu opens centred.** `day2/apple-design-audit.md`.
4. **Day 4d kept items**: drop zone highlights by colour only; progress spring overshoots a hair.
   `day4d/apple-design-audit.md` lines 44 to 49.
5. **A Call pressed while the open call is still "Calling" replaces it without asking.** Log row 182;
   `day4b/README.md` line 194.
6. **Recent activity skeleton draws 4 rows, the card holds up to 8; Low stock skeleton** to match Day 6's real card.
   [5] log "Day 7 follow-ups".
7. **More's skeleton always draws the Administration block.** `team/README.md` open risks [T].
8. **"Account c9b5074f" (button name) vs "User ID c9b5074f" (row).** `team/README.md` [T].
9. **Shared sheet without `overscroll-behavior: contain`.** `team/web-design-guidelines.md` line 25 [T].

### Accessibility
1. **`<main>` focus fallback** sets `tabindex=-1` and no outline on the skip link's target. `day4b/web-design-guidelines.md`
   line 104; log row 182.
2. **Phone call sheet does not trap focus** and can cover a control reached with Tab. `day4b/web-design-guidelines.md`
   line 105; log row 183.
3. **One `exhaustive-deps` suppression** in `queue-workspace.tsx`. Log row 224.
4. **No automated accessibility scan; Lighthouse never run** (6e deviations). Step 7h.
5. **Tests on the real clock**: the reduced-motion bead test in `shell.spec.ts` (flaky twice, log rows 92 and 234) and
   the queue's calling-hours e2e (skipped when no country is closed, `day4c/README.md` line 346). Use Playwright's
   clock, as `home.spec.ts` count-up now does (1e5623f [5]). Step 7g.

### French
1. **Lead tab "Détails" cut at 390 with no edge fade.** `day4b/README.md` line 194; log row 183.
2. **Tasks at 390 in French**: date chips scroll with no fade, the Done tab is cut to "Termin". Log row 224;
   `day4c/apple-design-audit.md` line 49.
3. **Quick add chips row scrolls with no fade on phones.** `day4c/apple-design-audit.md` line 49.
4. **Search is accent-sensitive** ("e" does not find "é"). Log rows 106 to 108. Not Day 7: changes the search column
   and its index; after go-live if Henri or Kais miss it.

### Mobile and PWA
1. *(found while planning)* **No PWA manifest** (`src/app` has no `manifest.ts`, no apple-touch icon, no theme colour).
   Step 7e.
2. **Phone Lose sheet at 390 scrolls with Cancel at the fold.** [5] log "Day 7 follow-ups".
3. **Bottom dock 5 items**: built Day 2 (`src/lib/nav.ts`: Home, Leads, Pipeline, Inventory, More; Tasks and Analytics
   under More). Check it with Day 6's Inventory, and safe areas when opened from the home screen. Step 7e.
4. **Offline outcomes and web push** (`day4/design.md` line 1390; `day6/design.md` line 2119 [6]). Question 8.

### Ops
1. **Backups, restore test, keep-alive**: Day 8 go-live parts G to I (Haider).
2. **CI cost**: Actions budget 10 USD (log row 243); one push uses about 70 runner minutes (log row 244). Question 12.
3. **Master Plan section 9 Day 6 rewrite** awaits Haider's approval at the Day 6 merge ([6] log 15 Oct).
4. **CSV export of stock** listed for Day 7 in `day6/design.md` section 15 [6]. Question 10.
5. **Later restore tests** into a separate project in account B (go-live decision 7), before January 2027.
6. **Henri and Kais set their names before the real import** (Haider 11 Oct, log row 134).

---

## 3. Orphan sweeper (design, short)

**Job.** Remove objects in the `lead-files` bucket that have **no `files` row at all** and are older than a grace
period. Today only one path makes them (spike S5: a signed upload link made before Cancel still stores bytes); no user
can see or delete them, and they count toward the 800 MiB team space (`private.org_storage_bytes` sums the bucket).

**Why it needs the service key.** The bucket's policies only let a user touch an object that has a matching files
row. SQL cannot remove the bytes: storage-api's `storage.protect_delete` refuses direct deletes (seen in CI, log row
239), and deleting the row would leave the file in object storage. Only the Storage API removes both, and for objects
with no row only the service key may call it.

**Where it runs (chosen): a scheduled GitHub Action in `topstock-ops`**, the private ops repository Claude is never
attached to, next to `backup-prod`, `keep-alive` and `migrate-prod` (Cloud Workflow section 5; go-live parts C to I).
- Code: `scripts/ops/sweep-lead-files.mjs` in `topstock-crm` (reviewed, unit-tested, Node 22 built-in `fetch`, no npm
  packages). Template `docs/ops-templates/sweep-lead-files.yml` for Haider to paste, like the others.
- The workflow checks out `topstock-crm` read-only at a commit SHA kept in a `topstock-ops` repository variable
  (`SWEEPER_SHA`). A new commit on `main` never runs with the production key until Haider changes that variable.
- Secrets: `PROD_PROJECT_REF` (exists) and a new **dedicated Supabase secret key** named `sweeper`, created by Haider in
  account B (so it can be revoked on its own) and stored only as `PROD_SWEEPER_KEY` in `topstock-ops`. It never goes
  to Vercel, the cloud environment or `topstock-crm`. This matches Master Plan item 41 ("service_role only in isolated
  server-only modules (... cron)"); CLAUDE.md's wording ("server-only modules and local import scripts") needs Haider's
  OK for this one use (question 2).
- Rejected: a Vercel cron route (adds an internet-facing endpoint and puts the key in Vercel, where any merged app code
  can read it, and Production still runs on dev values until Gate 1); pg_cron with pg_net (the key would have to live
  in the database's Vault, and pg_cron is not installed).

**Database part (migration in 7c).** `public.lead_file_orphans(p_min_age interval default '24 hours', p_limit integer
default 200)`: `SECURITY INVOKER`, `search_path = ''`, revoked from `public, anon, authenticated`, granted to
`service_role` only. Returns `name, org_id, size, created_at` for objects in `lead-files` whose name matches the files
path shape (`org/lead/file.ext`), created before `now() - p_min_age`, with no files row of any status for that path.
Objects whose name does not match the shape are counted, never returned for deletion. A second function
`public.record_file_sweep(p_found integer, p_removed integer, p_bytes bigint, p_dry boolean)`, service-role only, writes
one `audit_log` row (action `file_sweep`, counts only).

**Grace period: 24 hours.** A signed upload link lives 2 hours, a pending row 15 minutes, and `take_stale_uploads`
needs the uploader's next visit; 24 hours covers all of them with margin. Pending, ready and deleting rows all have a
files row, so their objects are never candidates.

**Safety.**
- **Dry run by default.** Scheduled runs only list until Haider sets the variable `SWEEP_APPLY=yes` after reading a
  week of dry runs. A manual run deletes only with the input `confirm: SWEEP`.
- **Caps.** Stops without deleting if one run finds more than 50 objects or 200 MiB (a bug that hid every files row
  would otherwise empty the bucket). Haider can raise the cap for one manual run.
- **Sanity check.** Stops if the bucket holds objects but the database reports zero files rows.
- **Double check.** Lists, then lists again just before deleting, and deletes only names found both times, in
  batches of 100.
- **Org scoping.** Every name starts with its org id; the run reports per org id. It never builds a path itself.
- **Logging without PII.** Paths are only UUIDs and a type ending (file names are never in paths); the log prints
  counts and bytes per org, never names. The run's summary holds the same counts; a red run makes GitHub email Haider.

**Tests.**
- Unit (`tests/unit/sweep-plan.spec.ts`): caps, sanity check, the both-lists rule, grouping, dry run never calls delete
  (fake `fetch`).
- SQL (`files_attack.sql`, new section): anon and authenticated get 42501 on both functions; a young object, an object
  with a pending, ready or deleting row, and an object in another bucket are not returned; an old orphan is; the audit
  row has counts only. Mutation rows: no "not exists files row", no age check, granted to authenticated: each caught.
- CI e2e (`E2E_STORAGE=1`, real storage-api with the local stack's demo service key): make a real stray object the S5
  way, age it in SQL, run the script dry (lists 1, deletes 0), then with apply (removes it); `file_usage()` drops by its
  size; a ready file still opens.

---

## 4. Day 7 steps, scope A (four PRs, in this order)

Every step: two sentences to Haider before it; Context7 before code with any library; branch, PR, CI green, Vercel
preview; `/security-review`, gitleaks, `npm audit`, Semgrep (CI), lint, typecheck, Playwright suite; `advisor`
APPROVED (pasted); REPORT in START_HERE section H with "What I need from you:"; rows in `docs/log.md`; then stop.
**DB steps** add: migration in git, attack tests with mutation rows, splinter locally and dev Security and Performance
Advisors after `deploy-dev-db`, reported. **UI steps** add: DESIGN.md, Taste Skill (3 / 5 / 7), Playwright screenshots
at 1280, 1440, 1728 and 390 (plus 768 and 1024 where a layout changes), light and dark, EN and FR, no console errors,
no sideways scroll, `/apple-design` audit, web-design-guidelines audit, fixes.

Scope A (Haider 15 Oct 2026) folds the nine steps first planned into four PRs. CI budget stays at 10 USD (question 12);
the fewer PRs are the bundling.

| Step | What | Evidence beyond the standard | Effort |
|---|---|---|---|
| **7a** Security fixes and audit harness (DB + tests) | `docs/evidence/day7/gate1.md` from section 1; `supabase/tests/gate1_attack.sql`: RLS and the two-factor policy on every table, anon has nothing (allowlist share functions), every `SECURITY DEFINER` function on a reviewed list, every `public` function revoked from `public`/`anon`. **The gaps:** the anon test covers only Day 1 tables (now every table, plus anon-key requests to every PostgREST table on real PostgREST in CI); no "Sign out of all devices" (added on More, `signOut({ scope: "global" })`); auth cookie `Secure` unchecked (set and tested in production mode); no rate limit on the search and list APIs (`private.rate_hits` counter, 429); sign-ins not audited ("signed in" row, no IP, question 9); the same-org owner check in `enforce_org_and_owner` (question 5). Also: route inventory unit test (session helper and Zod in every route and action), production bundle scan and no `*.map`, `GET /.env` 404, codes-only check on Day 5/6 APIs, `config push` diff check instead of `--yes`, the `deal_links_attack.sql` block 2 fix and the client-side deal Delete cut-off (section 2 security item 20) | Each new check shown failing on a planted break (mutation-style); DB evidence; e2e for each fix; More screenshots | 1.5 days |
| **7b** No native pickers + list states (UI) | Every call site moved to the components in `src/components/ui/` (guide: `docs/evidence/day7/pickers.md`): `ui/select.tsx` users (already custom), raw `<select>`s, native date/time/datetime-local inputs, `title=` tooltips, `type="search"`, `<summary>` markers, `noValidate` on every form with errors in `FormMessage`; a source check in CI that fails on any of them returning. Then the table of every list (Leads, lead timeline, tasks, files, deals, Pipeline columns, Home cards, Tasks, queue, Inventory tables, movements, sales, requests, share links, Past imports, Team) with its loading, empty and error state and the test for each; fill gaps; skeletons that match (Recent activity 4 to 8 rows, Low stock, More without Administration for non-admins) | Screenshot per picker open and closed (EN/FR, light/dark, 390 and 1440); keyboard-only run through each picker; screenshot per list state | 1.5 days |
| **7c** French and phone pass + orphan sweeper | Every route at 390, 768 and 1280 in French with the cut-text check in CI; French typography; "Détails", the Tasks Done tab and other cuts fixed; Henri or Kais reads the French screens (question 13). Phone: the 5-item dock on every section, Lose sheet at 390, call sheet focus trap and scroll padding, edge fades on tab strips and chip rows; PWA **only** home-screen icon (maskable), `display: standalone`, theme colours and safe areas (question 8). Sweeper: section 3 in full (migration, `topstock-ops` template with its own key, dry runs for a week, question 2); restore runbook gains `share_reader`; `docs/go-live.md` gains the sweeper key and the pg_cron step for production | Cut-text report 0; 390 and 768 screenshots per route; manifest e2e; sweeper DB evidence; actionlint and shellcheck on the template | 1.5 days |
| **7d** Gate 1 run (code part) | On the `main` head after 7a to 7c: two-user attack test steps 1 to 8 as one Playwright plus SQL run with a step-to-test map; `/security-review` over all of Release 1; full-history gitleaks; `npm audit` and `audit signatures`; dev Security and Performance Advisors; dev data checks (security item 15) and the size query; re-run Day 5a mutation rows 64 to 73; database budgets re-timed once on a GitHub runner (question 11); spike S5 answered from Vercel's docs; Day 1 residuals restated; leaked-password WARN recorded as accepted (question 4) | Advisor APPROVED, then **HAIDER DECIDES: pass Gate 1 (code part)?** The ops part passes on Day 8 (question 1) | 0.5 day plus Haider's checks |

**Deferred (out of scope A):** deep speed tuning (section 2 "Speed": the misses are re-measured once in 7d and written
as the Release 1 baseline, question 14; JS budgets still checked on every PR); the full accessibility pass (axe over
every route, Lighthouse, screen-reader journeys; the pickers and list states still get keyboard and ARIA checks in 7b);
PWA extras (offline, push, install prompts); animation polish (dock notch, springs for page entrances, drop zone,
progress overshoot; the halo dock stays, question 6); swipe gestures and dock badges (question 7); stock CSV export
(Release 2, question 10).

Order reasons: security first because it gates go-live; the picker switch and list states touch the same screens, so
the French and phone pass runs after them and screenshots are taken once; the Gate 1 run last, on the final code.

Haider's own items during Day 7 (numbered click steps given when each comes up): Dependabot alerts on; Vercel and
Supabase member lists and Vercel settings review; Storage S3 connection off on dev; a preview link opened signed out of
Vercel; the sweeper key in account B (Day 8). pg_cron on dev: done (1.6.4, confirmed 15 Oct).

---

## 5. Questions for Haider (HAIDER DECIDES)

**Answered 15 Oct 2026: all 14 recommendations yes** (scope A; `docs/log.md`). pg_cron on dev is already on (1.6.4).

1. **Split Gate 1 in two?** The code part (section 8 A to F, two-user test, `/security-review`, advisors) passes at the
   end of Day 7; the ops part (backup, restore test, keep-alive, Vercel Pro) passes on Day 8 before any real data, as
   `docs/go-live.md` already assumes. **Recommended: yes.**
2. **The orphan sweeper runs once a day from `topstock-ops` with its own Supabase secret key that you create in account
   B** (dry runs for a week, then you switch on deleting). **Recommended: yes.**
3. **Switch on pg_cron on the dev project now** (free; Database > Extensions), and on production at go-live, so the
   nightly stock job runs. **Recommended: yes.**
4. **Leaked password protection** needs Supabase's paid plan (about 25 USD a month, which also gives daily backups, no
   pausing and session time limits). **Recommended: stay on Free for go-live**; the advisor warning is recorded as
   accepted.
5. **Fix the owner-in-same-organisation check now** (small database change) rather than accept it while there is only
   one organisation. **Recommended: fix now (step 7b).**
6. **Dock:** keep the floating halo bead you approved, or build the notch cut into the bar with its drag stretch?
   **Recommended: keep the halo bead for Release 1.**
7. **Swipe gestures and dock badges:** leave them out of Release 1 (accidental moves and deletes). **Recommended:
   leave out.**
8. **PWA scope:** home-screen icon, full-screen app look and safe areas only; no offline mode or push notifications in
   Release 1. **Recommended: yes.**
9. **Record each sign-in in the audit log** (who and when, no IP address). **Recommended: yes.**
10. **CSV export of stock** (the Day 6 design parked it for Day 7): move it to Release 2. **Recommended: Release 2.**
11. **Where to re-time the database speed budgets:** one manual run on a GitHub runner (uses Actions minutes) rather than
    loading fake test data into dev. **Recommended: the GitHub runner, once, in step 7g.**
12. **CI cost:** each push to a PR uses about 70 runner minutes; nine steps with review rounds is roughly 25 pushes.
    **Recommended: keep the 10 USD budget and let me bundle 7d to 7f into one PR if the budget runs low**; the
    alternative is raising the budget for October.
13. **French check by a native speaker:** Henri or Kais reads the French screens on the 7f preview (about 20 minutes).
    **Recommended: yes.**
14. **Speed misses that remain after 7g** are written down as the Release 1 baseline, as for Days 4 and 5, with the
    performance tests kept as a guard. **Recommended: yes**, provided the pipeline move and the Home to Pipeline route
    both improve clearly.
