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
- **Manual security pass over all of Release 1 (a supplement): no HIGH or MEDIUM finding.** Four test gaps closed with
  new checks. **`/security-review`: pending, run by the main session on the final head**; not counted as done.
- **No secret in the whole git history** (gitleaks, 678 commits); **0 vulnerabilities** in what ships (`npm audit`).
- **Section 8: 50 of 59 items done**, 1 pending in the main session (`/security-review`, item 50), 1 accepted residual
  (rate limits, R1), 3 wait for Day 8, 1 runs in CI when billing is back (`npm audit signatures`), 3 not applicable.
- **Dev project**: fake data only, the lead checks return 0, 14 MB used; advisors 0 ERROR. Dev still has only main's
  migrations (up to Team), so these are read again after the Day 6 and Day 7 PRs deploy.
- **Database budgets on a GitHub runner**: workflow prepared (`db-budgets`), runs when CI billing is back.

## Deliverables

| # | Deliverable | Where | Result |
|---|---|---|---|
| 1 | Two-user attack test, steps 1 to 8, one Playwright plus SQL run, step-to-test map | `two-user-map.md`; `tests/auth/gate1.spec.ts`; `supabase/tests/gate1_attack.sql`; `scripts/gate1-run.sh` | all 8 steps pass (step 7 login/reset: hosted only); 8 planted breaks against the new browser/API tests: 7 caught, 1 refused by a second database layer (as it should be); `gate1_attack.sql` 15 of 15 |
| 2 | `/security-review` over all of Release 1 | `security-review.md` | **pending: the main session runs `/security-review` on the final head.** The builder's manual pass, a supplement: 0 HIGH, 0 MEDIUM at confidence 8+; 4 test gaps closed; 3 informational notes |
| 3 | Full-history gitleaks; `npm audit --omit=dev`; `npm audit signatures` | `gitleaks.md` | no leaks (678 commits); 0 vulnerabilities; signatures blocked by this session's network policy, added to CI |
| 4 | Master Plan section 8 A to F checklist | `section8-checklist.md` | 50 done, 1 pending (`/security-review`), 1 residual, 3 Day 8, 1 CI, 3 N/A |
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
| bbe5eec | route inventory: stricter Zod rule; rules as functions; planted breaks on in-memory fixtures | advisor round 1 item 1 |
| 13fe35e | `gate1_attack.sql` G2 compares `has_aal2`'s whole normalised body | advisor round 1 item 6 |
| f27987e, e58485b, acc33dc | merges of `day7c-local` (624f647, 549191c, final f6f1f3f) | section "Merge with Day 7c" |

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
   `check-build.mjs`, Semgrep), then one manual run of `db-budgets` (question 11; `workflow_dispatch` needs the workflow on the default branch, so after the PR merges) and the Release 1 speed baseline from
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
6. **`/security-review`** on the final head (main session; condition (d)). **Advisor**: round 1 CHANGES NEEDED on
   f4e5cff, fixed (section "Advisor round 1"); the next round is the main session's (it runs the subagent before the
   REPORT).

## Context7 (documentation checked)

Consulted during the build and, for the first four rows, again on 16 Oct during advisor round 1 (they were used before
without being named):

| Library or service | Context7 ID | Used for |
|---|---|---|
| TypeScript compiler API (5.9.3 installed) | `/microsoft/typescript` ("Using the Compiler API"; `createSourceFile(fileName, text, target, setParentNodes, scriptKind)`) | `tests/unit/route-inventory.spec.ts`: parse each file, walk `sourceFile.statements`, read `export`/`default` modifiers, `getText(sourceFile)` |
| Playwright (1.64.0 installed) | `/websites/playwright_dev` (`APIRequestContext`, `apiRequest.newContext({ baseURL, maxRedirects })`, `fetch`, `APIResponse.status()/headers()`) | `gate1.spec.ts` step 5 (`context.request.fetch(path, { method, headers, data, maxRedirects: 0 })`) and item 45 (`playwright.request.newContext({ baseURL })` for the signed-out requests) |
| npm CLI | `/npm/cli` (`npm audit signatures`: verifies registry signatures and provenance attestations of installed packages; needs a recent npm) | the `ci.yml` step after `npm ci`; why it cannot run here (Sigstore's TUF host is refused by this session's proxy) |
| GitHub Actions and runner images | `/websites/github_en_actions` (`workflow_dispatch`: runs only from the default branch's copy of the workflow, write access needed); `/actions/runner-images` (Ubuntu 24.04 toolset: PostgreSQL 16, service disabled by default) | `.github/workflows/db-budgets.yml` (its header now says both) |
| Vercel | `/websites/vercel` (request headers, runtime logs, WAF pricing) | spike S5 (`spike-s5.md`) |

## Advisor round 1 (CHANGES NEEDED on f4e5cff), fixed

| # | Advisor item | Fix | Commit |
|---|---|---|---|
| 1 | The route inventory's Zod regex accepted `JSON.parse`, `parseInt`, `parseFloat`; its planted-break test did not run the real rules | Stricter regex; the rules became functions of a path and text, run by the tests over `src/app` and by six planted-break tests on in-memory fixtures (each with a correct twin); the old regex fails the `JSON.parse` case; evidence `route-inventory.md` | bbe5eec |
| 2 | The manual pass is not `/security-review` | `security-review.md` and this README call it a supplement; `/security-review` is pending (main session, final head) and is condition (d); checklist item 50 is "pending" | this round |
| 3 | The HAIDER DECIDES condition was too loose; the "7c did not touch security paths" line was wrong | Conditions (a) to (d) named below, with the PGRST203 note; the proxy's `/manifest.webmanifest` change recorded and reviewed; the recommendation's claim narrowed to what was shown | this round |
| 4 | The one run's output was not in the evidence | `gate1-run-output.md` (test lines and pass lines, no environment values), linked from `two-user-map.md` | this round |
| 5 | Context7 not named for four libraries | the section above | this round |
| 6 | `gate1_attack.sql` G2 accepted `aal2` in a comment | the whole normalised body is compared, with INVOKER, STABLE and search_path; 2 more planted breaks (17 of 17 caught) | 13fe35e |
| 7 | Re-merge Day 7c's final head, re-run `gate1-run.sh` and unit, commit the refreshed run output | f6f1f3f merged at acc33dc; unit 741, check:native 0, `gate1-run.sh` on a fresh stack (above); `gate1-run-output.md` refreshed | acc33dc, this commit |

## Merge with Day 7c

Merged three times as Day 7c moved: **624f647** at f27987e, **549191c** at e58485b, and **Day 7c's final,
advisor-approved head f6f1f3f at acc33dc** (one commit over 549191c: `phone.spec.ts`'s call panel height check allows
1 px of rounding). Every conflict was in `docs/log.md` (both sides' rows kept), and in the first merge also `db.yml` and
`db-test.sh` (both appended a suite after `day7a_attack.sql`: the sweeper test, then the Gate 1 catalog checks last,
then the advisors). Auto-merged: `scripts/db-mutations.py` (Day 7c's `day7c` set and this branch's `REDEFINERS` entry),
messages, pipeline components.

Day 7c on a security path: `src/proxy.ts` `publicPaths` gains `/manifest.webmanifest` (served signed out;
`src/app/manifest.ts` returns the app's name, colours and icon paths only, no data; reviewed in `security-review.md`).

Checks on the final merged tree (acc33dc):

| Check | Result |
|---|---|
| `npm run test:unit` | **741 passed** |
| `npm run check:native` | 0 findings |
| lint, typecheck | 0 errors (pre-commit hook) |
| `scripts/gate1-run.sh` on a fresh stack | SQL exit 0 (`sweeper_attack`, `gate1_attack`); Playwright 99 passed, 5 storage skips, 1 `files.spec.ts` failure that was a test race (the drop guard checked before the client-only Files tab attached it), fixed after the run and proven (old test fails 3 of 3 against a guard attached 2 s late, fixed test passes 3 of 3 there and 10 of 10 with `--repeat-each=10` on the real code); journey mail-free 2 passed; signed-out 22; unit 18 (`two-user-map.md`, "The run"; `gate1-run-output.md`) |
| `python3 scripts/db-mutations.py --anchors` | 672 rows in 16 sets apply, none dead |
| gitleaks | all refs, 708 commits: no leaks; this branch's 43 commits (`287430b..HEAD`): no leaks |
| `npm audit --omit=dev` | 0 vulnerabilities (no dependency changed in Day 7c) |

## Recommendation

Pass the code part, under the conditions below. Every step of the two-user attack test passes locally, the manual
security pass found nothing at HIGH or MEDIUM, history and dependencies are clean, and every check written for Gate 1
(`gate1_attack.sql`, the route inventory, the bundle scan, `gate1.spec.ts`) was shown to fail on a planted break of the
protection it guards; the per-day checks it relies on were shown so in their own days' mutation runs (the Day 5a rows
re-run here). What remains is not code, but it is part of the gate.

HAIDER DECIDES: pass Gate 1 (code part)? **Recommended: yes, once all four conditions hold:**

- **(a) Day 7c's final head is merged** into this branch (done: f6f1f3f at acc33dc), and `scripts/gate1-run.sh` on the
  merged tree, or the CI `auth-journey` and `db` jobs on it, are green. Locally: green apart from one `files.spec.ts`
  test race, since fixed in the test and proven (10 of 10); CI's run on the PR closes this condition.
- **(b) Dev re-read after the Day 6 and Day 7 deploys**: `dev-checks.sql` (read-only) and both dev advisors show
  0 ERROR and only the accepted WARNs (`set_user_role`, leaked password protection, and Day 6e's `share_view` and
  `share_request`).
- **(c) CI green on**: `npm audit signatures`, `check-build.mjs`, WebKit, the storage-api e2e and the real-PostgREST
  branches of `gate1.spec.ts` (table POST and DELETE, the private-schema header). Note: step 3's RPC sweep (every
  public function called as anon with all its arguments set to null) has only met the local stand-in, never real
  PostgREST; there an overloaded name may answer 300 (`PGRST203`, ambiguous call) instead of 401, which the test
  counts as a failure until the sweep names the overload.
- **(d) `/security-review`** run by the main session on the final head with no HIGH or MEDIUM finding left open.

The ops part (backup, restore test, keep-alive, Vercel Pro, production settings) passes on Day 8 before any real data.
