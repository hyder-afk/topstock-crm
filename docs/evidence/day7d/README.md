# Day 7d: Gate 1 run, code part (16 Oct 2026)

Built by the builder on local branch `day7d-local` (worktree `/home/user/topstock-crm-7d`) from `day7f-local` 287430b
(main + Day 5 + Team + Day 6 + Day 7a + 7b + the seven 7f follow-ups), with `day7c-local` merged at the end (section
"Merge with Day 7c"). Not pushed, no PR. Plan: `docs/evidence/day7/plan.md` step 7d (section 4 table), section 1 (the
Gate 1 checklist), section 2 security items 7, 14, 15, 16 and 20, questions 1, 4 and 11. Haider's question 1 split
Gate 1: this is the **code part**; the ops part (backup, restore test, keep-alive, Vercel Pro, production settings)
passes on Day 8.

## Summary for Haider

- **The two-user attack test passes, all 8 steps, in one run** (`scripts/gate1-run.sh`: every SQL attack suite, the new
  `tests/auth/gate1.spec.ts` and the existing specs it maps to). Step 7's login and reset limits are Supabase's own and
  can only be seen on the hosted service (Day 1 residual 2, Firewall rule on Day 8).
- **Security review of all of Release 1: no HIGH or MEDIUM finding.** Four test gaps closed with new checks.
- **No secret in the whole git history** (gitleaks, 678 commits); **0 vulnerabilities** in what ships (`npm audit`).
- **Section 8: 51 of 59 items done in code**, 1 accepted residual (rate limits, R1), 3 wait for Day 8, 1 runs in CI
  when billing is back (`npm audit signatures`), 3 not applicable. Nothing is open in code.
- **Dev project**: fake data only, the lead checks return 0, 14 MB used; advisors 0 ERROR. Dev still has only main's
  migrations (up to Team), so these are read again after the Day 6 and Day 7 PRs deploy.
- **Database budgets on a GitHub runner**: workflow prepared (`db-budgets`), runs when CI billing is back.

## Deliverables

| # | Deliverable | Where | Result |
|---|---|---|---|
| 1 | Two-user attack test, steps 1 to 8, one Playwright plus SQL run, step-to-test map | `two-user-map.md`; `tests/auth/gate1.spec.ts`; `supabase/tests/gate1_attack.sql`; `scripts/gate1-run.sh` | all 8 steps pass (step 7 login/reset: hosted only); 8 planted breaks against the new browser/API tests: 7 caught, 1 refused by a second database layer (as it should be); `gate1_attack.sql` 15 of 15 |
| 2 | `/security-review` method over all of Release 1, by hand | `security-review.md` | 0 HIGH, 0 MEDIUM at confidence 8+; 4 test gaps closed; 3 informational notes |
| 3 | Full-history gitleaks; `npm audit --omit=dev`; `npm audit signatures` | `gitleaks.md` | no leaks (678 commits); 0 vulnerabilities; signatures blocked by this session's network policy, added to CI |
| 4 | Master Plan section 8 A to F checklist | `section8-checklist.md` | 51 done, 1 residual, 3 Day 8, 1 CI, 3 N/A |
| 5 | Day 5a mutation rows 64 to 73 re-run | `mutations.md` | 10 of 10 caught; row 58 back to its documented NOT CAUGHT (the fixture fix) |
| 6 | Dev data checks (item 15), size query (item 16), dev advisors | `dev-checks.sql`, `dev-checks.md` | 0 wrong (one check read by hand: the read-only role cannot run private functions); 14 MB; Security 0 ERROR, 2 accepted WARN; Performance 0 ERROR/WARN |
| 7 | Spike S5 from Vercel's docs; Day 1 residuals; leaked-password WARN | `spike-s5.md`; sections below | answered; restated; recorded as accepted |
| 8 | Database budgets on a GitHub runner | `.github/workflows/db-budgets.yml` | prepared, runs when CI billing is back (manual start only) |
| 9 | This README, log rows | here, `docs/log.md` | |

## What changed in code (commits on `day7d-local`)

| Commit | What | Why |
|---|---|---|
| 35c58bd | `deal_links_attack.sql`: fixtures in the block bodies, not in DECLARE | DECLARE initialisers run before the block's TS001 savepoint, so their deals outlived the undo (plan item 20) |
| d86cf0d | `supabase/tests/gate1_attack.sql` (G1 to G7), wired into `db-test.sh` and `db.yml`; `gate1-breaks.sh/.md` | catalog rules for every table and function at once (items 4, 7, 17); 15 planted breaks, 15 caught |
| 97470a3 | `deal_links_attack.sql` setup deletes r1's deals from the earlier files | `deal_concurrency.sh`'s 28 committed deals still made row 58 fail for the wrong reason |
| cfeea84 | `tests/unit/route-inventory.spec.ts` | session check and Zod on every route, action and page; the reviewed screen list (items 5, 9, 10, 16); 5 planted breaks caught |
| d218a03, 736e3ae | `scripts/check-build.mjs`; `ci.yml` runs it after `next build`, and `npm audit signatures` | items 1, 14, 36, 38; 6 planted cases behave |
| 61db722 | `.github/workflows/db-budgets.yml` | question 11: re-time the database budgets once on a GitHub runner |
| ef2b74c | `tests/auth/gate1.spec.ts` (10 tests), `tests/e2e/signed-out.spec.ts` (repository files not served), `scripts/gate1-run.sh` | the two-user test as one run; item 2; item 45 |
| f43f90d | `scripts/db-mutations.py`: Day 7f's `share_take` migration is a redefiner | day6e row 10 was dead on the base; now mirrored and caught |

No product code changed: the review found nothing to fix in `src/` or the migrations.

## Checks on this branch (before the Day 7c merge)

| Check | Result |
|---|---|
| `npm run lint` | 0 errors (3 old warnings: TanStack `useVirtualizer`), run by the pre-commit hook on every commit |
| `npm run typecheck` | clean (pre-commit hook) |
| `npm run check:native` | 0 findings |
| `npm run test:unit` | 697 passed |
| `DB_TEST_PORT=54669 bash scripts/db-test.sh` | exit 0: every suite including `gate1_attack: all checks passed`; advisors 0 ERROR |
| `scripts/gate1-run.sh` (the one run) | SQL exit 0 (`gate1_attack` included); Playwright 102 passed, 5 storage-api skips (CI), `journey.spec.ts` needs a mail inbox: its 2 mail-free tests passed, the rest CI; signed-out 22 passed; unit 13 passed (`two-user-map.md`, "The run") |
| `tests/auth/gate1.spec.ts` alone | 10 passed (2.4 min) |
| `python3 scripts/db-mutations.py --anchors` | 660 rows in 15 sets apply, none dead |
| Chromium | 141 (`/opt/pw-browsers/chromium-1194`), throwaway stack: PostgreSQL 54650, GoTrue 9988, gateway 54651, `next start` 4100 |
| WebKit, storage-api, real PostgREST, Semgrep | CI only (GitHub Actions blocked by billing): prepared, runs in CI later |

## Day 1 residual risks, restated at Gate 1 (`docs/evidence/day1-step2/security-review.md` lines 26 to 35, log line 58)

| # | Residual | Today | Stays because | Later |
|---|---|---|---|---|
| 1 | Enrol-on-first-sign-in: a stolen password before the owner sets up two-factor lets the thief enrol | unchanged; the "two-factor added" notice e-mail is **not sent today** (templates stripped until custom SMTP, log line 68) | invite only when the person finishes setup at once (three people) | custom SMTP brings the notice back (after go-live) |
| 2 | Supabase's per-IP auth limits see Vercel's addresses: one shared bucket | unchanged; spike S5: Vercel overwrites `x-forwarded-for`, but the auth calls go from the server | brute force still capped (30 sign-ins per 5 minutes in all), worst case a few minutes' lockout for everyone | Vercel Firewall rate-limit rule on the sign-in pages (Day 8, Hobby includes one) |
| 3 | Session cookies readable by page scripts | unchanged (`day7a.spec.ts` checks Secure and SameSite) | the browser client of the Files tab needs them; the nonce CSP is the XSS control (`gate1.spec.ts` step 5) | revisit if the Files tab moves server-side |
| 4 | No recovery codes for a lost authenticator | unchanged | an admin removes the factor in the dashboard, the person sets up again | none planned for Release 1 |
| 5 | Supabase's default e-mail reaches only the Supabase team | unchanged: reset is off on dev until custom SMTP (log line 68) | Haider's "next week" item | custom SMTP, then restore the templates and remove `scripts/strip-email-templates.py` |

Day 7a residuals R1 (in-app rate limit, accepted log line 366), R2 (other devices up to 1 hour after Sign out of all
devices; `jwt_expiry` decided on Day 8) and R3 (up to 30 own sign-in rows an hour) stand as recorded.

## Leaked-password protection WARN: accepted

The dev Security Advisor's `auth_leaked_password_protection` WARN is **recorded as accepted**: the switch exists only on
Supabase's paid plan, and Haider decided on 15 Oct 2026 to stay on Free for go-live (plan question 4, log line 356).
Passwords stay at 12+ characters with lower, upper, digit and symbol (`config.toml`, the sign-up form's Zod), and every
account needs its authenticator. Revisit if the plan is upgraded (Pro gives the switch).

## Open items (for the main session, CI or Day 8)

1. **CI when billing is back**: the PR's full CI (WebKit, storage-api e2e, real PostgREST checks in `gate1.spec.ts`
   steps 2, 3 and 8, `db.yml` with `gate1_attack.sql` on the real Supabase image, `npm audit signatures`,
   `check-build.mjs`, Semgrep), then one manual run of `db-budgets` (question 11) and the Release 1 speed baseline from
   its log (question 14).
2. **Dev after the Day 6 and Day 7 PRs deploy**: re-run `dev-checks.sql` (read-only MCP) and both dev advisors; expect
   the WARNs `share_view`/`share_request` (Day 6e, accepted) to join.
3. **`call_zone_matches_map` as the owner**: the read-only MCP role cannot call the private zone functions; Haider runs
   that one query in the dev SQL editor after the import (1 minute), or it runs on the next restore test.
4. **`supabase config push --yes` diff check** (plan step 7a, log line 71) is not built: it changes the dev deploy
   workflow, so it goes with the next deploy change, with Haider; until then `deploy-dev-db` keeps reading back the
   settings it pushed.
5. **Day 8 (ops part, Haider)**: preview opened signed out of Vercel; member lists (item 35); production auth settings,
   Storage S3 keys, Vercel settings; backup, restore test, keep-alive (items 43, 44); Vercel Pro and the Firewall rule
   (spike S5); the `x-forwarded-host` check on the preview; `jwt_expiry` (R2); Dependabot alerts on.
6. **Advisor**: this step has not been through the `advisor` subagent yet (the main session runs it before the
   REPORT).

## Merge with Day 7c

(filled in below after the merge)

HAIDER DECIDES: pass Gate 1 (code part)?
