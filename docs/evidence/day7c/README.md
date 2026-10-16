# Day 7c (part 1): the orphan sweeper and the PWA basics, 15 Oct 2026

Local branch `day7c-local`, cut from `day7a-local` 54739bb (main + Day 5 + Team + Day 6 + the Day 7a security
changes). Not pushed, no PR. Plan: `docs/evidence/day7/plan.md` (on `day7-local`) section 3 (the sweeper, in full),
section 4 row 7c, section 5 (Haider said yes to all 14 on 15 Oct 2026; here questions 2, 3 and 8).
Haider's words: "orphan sweeper runs from topstock-ops with its own key; dry-run week first" (question 2); PWA "home-
screen icon, full-screen app look and safe areas only; no offline mode or push notifications" (question 8).
**Not in this part** (a parallel Day 7b branch changes components and messages): the French pass, the phone pass and
any other UI work of row 7c. They are part 2.

## What was built

### 1. Orphan sweeper (plan section 3)

| Piece | What | Files |
|---|---|---|
| Database | Migration ordered after `20261021100000_day7a_security`. `public.lead_file_orphans(p_min_age interval default '24 hours', p_limit integer default 200)` returns `name, org_id, size, created_at` for objects in `lead-files` whose name is in the exact `org/lead/file.ext` shape (lowercase UUIDs, pdf/png/jpg/docx/xlsx), created before `now() - p_min_age`, with no `files` row of any status; oldest first; the grace period is 24 hours to 365 days (a caller cannot ask for less than 24) and 1 to 1000 rows a call. `public.lead_file_sweep_stats()` gives the sanity counts (objects and bytes in the bucket, files rows, names outside the shape: counted, never returned). `public.record_file_sweep(p_found, p_removed, p_bytes, p_dry)` writes one `audit_log` row per run, action `file_sweep`, table `storage.objects`, counts only, bounded | `supabase/migrations/20261022090000_orphan_sweeper.sql` |
| RLS and grants (deny by default) | All three SECURITY INVOKER, `search_path = ''`, static SQL; revoked from `public, anon, authenticated`; executable by `service_role` only. service_role gets exactly `select (storage_path)` on `files` and `insert (action, table_name, diff_json)` on `audit_log` (on Supabase it holds more by default; the local test role holds only these). No new table, so no new policy; `audit_log` keeps RLS (the sweep row has no organisation, so no person in the app reads it; the only authenticated insert policy is for one's own sign-in rows) | same |
| Script | `scripts/ops/sweep-lead-files.mjs` (entry point) and `scripts/ops/sweep-core.mjs` (rules, loadable by the unit tests). Node 22 built-in fetch, no npm packages. Dry run unless `SWEEP_MODE=apply`; sanity stop; caps 50 objects / 200 MiB (one run can raise them, to at most 999 objects and 1024 MiB); shape and org-id re-check on every row; two listings, deletes only names in both, 100 a request, through the Storage API (`DELETE /storage/v1/object/lead-files`); one audit row; counts and bytes per org id in the log and the run summary, never names; exit 0 / 1 (stopped or failed: GitHub emails Haider) / 2 (bad settings). The key travels in `apikey` only (a legacy JWT also as bearer, per Supabase's docs) | `scripts/ops/` |
| topstock-ops template | `.github/workflows/sweep-lead-files.yml` for Haider to paste into topstock-ops: daily 03:37 UTC plus manual; checks out topstock-crm read-only at the commit in the repository variable `SWEEPER_SHA` (must be on main); scheduled runs delete only when the variable `SWEEP_APPLY` is `yes`, a manual run only when its confirm box says `SWEEP`; secrets `PROD_PROJECT_REF`, `PROD_SWEEPER_KEY` (the new dedicated key), `TOPSTOCK_CRM_READ_TOKEN`; `permissions: {}`; inputs reach the shell through `env:` only | `docs/ops-templates/sweep-lead-files.yml` |
| Runbook | Plain-language runbook for Haider: Day 8 set-up steps 1 to 7 (key, secret, variables, paste, first dry run, dry-run week, switch on), reading a run, raising a cap once, moving to newer code, turning it off, before a production restore, key leak | `docs/ops-templates/sweep-lead-files.md` |
| Go-live | Part I2 (the sweeper, after keep-alive; does not block part J) and, at the top of part E, switching on pg_cron in production before the migration run (question 3; the stock migration schedules the nightly job only where pg_cron is on). Reference tables list the new secret, the two variables and the template | `docs/go-live.md` |
| Tests | SQL attack test (below), wired into `scripts/db-test.sh` and `.github/workflows/db.yml` after the Day 7a suite; mutation set `day7c` (12 rows) in `scripts/db-mutations.py`; unit tests with a fake fetch; a CI-only end-to-end test on the real storage-api | `supabase/tests/sweeper_attack.sql`, `tests/unit/sweep-plan.spec.ts`, `tests/auth/sweeper.spec.ts` |

`supabase/tests/sweeper_attack.sql`:
- **A. Deny by default:** catalog (INVOKER, `search_path`, no dynamic SQL, no EXECUTE for public, anon, authenticated;
  EXECUTE for service_role; exact signatures) and live calls (anon and an aal2 admin get 42501 on all three).
- **B. Candidates:** an old orphan is returned with its org id and size (0 when the metadata holds no number); never a
  young object, one at 23 hours, one with a pending, ready or deleting row, one in another bucket, or names outside the
  shape (a plain `.txt`, upper-case ids, an extra folder, a wrong type); oldest first; a 48-hour grace leaves a 30-hour
  orphan; the limit holds; bounds (under 24 hours, negative, over a year, null, limit 0, 1001, null: 22023 `bounds`);
  sanity counts move by exactly what the block stored. B6: files rows in two organisations (the test's own and a
  second one made in the block, with no member), pending and uploaded by nobody, protect their objects, while the
  second organisation's object with no row is a candidate: service_role reads files rows across organisations.
- **C. Audit row:** two calls write two rows with exactly `{found, removed, bytes, dry_run}`, no org, actor or record id;
  bounds (removed above found, removals in a dry run, negatives, nulls, over 100,000); an admin with a fresh code reads
  none; a signed-in person cannot insert a `file_sweep` row; the action check allows `file_sweep` and nothing new else.

`tests/auth/sweeper.spec.ts` (CI auth-journey, `E2E_STORAGE=1`, the local stack's demo service key): a ready file
uploaded normally; a stray made the spike S5 way (link made, upload cancelled and its row finished, then bytes PUT to
the link; if storage-api refuses that PUT, the stray is uploaded with the service key and an annotation says so); a
young stray is not listed; aged 2 days in SQL, a dry run lists 1, deletes 0; apply removes it through the Storage API;
`private.org_storage_bytes` drops by its size; the ready file still opens (`open_file` 200); the last two audit rows are
the dry and apply counts. The plan said `file_usage()` drops by the stray's size: `file_usage()` sums ready files rows
only, so an orphan never counted there; the test checks the bucket's real bytes instead (what the 800 MiB quota reads).

### 2. PWA basics only (question 8)

| Piece | What | Files |
|---|---|---|
| Manifest | `display: standalone`, `start_url` and `scope` `/`, `id` `/`, name from `Metadata.title` ("TopStock CRM", same in both languages), short name "TopStock" (brand), theme and background colour Chalk White; icons any 192/512 and maskable 192/512. No description (one document for two languages), no service worker, no share target, no install prompt | `src/app/manifest.ts` |
| Icons | Made from the logo mark already in the repo (`src/app/icon.svg`, the Brand Pack submark tile) by a script that reads the mark's path from that file: "any" icons keep the tile's rounded corners; maskable icons are full-bleed red with the mark at 56 % height, its farthest corner at 35 % of the size from the centre (safe circle: 40 %); `apple-icon.png` 180 px full-bleed (iOS rounds it). Uses sharp from Next's own install; nothing added to package.json | `scripts/make-app-icons.mjs`, `public/icons/*.png`, `src/app/apple-icon.png` |
| Theme colours | One module with DESIGN.md's page backgrounds (light `#f5f3ef`, dark `#0e0e10`) for the viewport's two `theme-color` tags and the manifest; a unit test ties them to `--background` in `globals.css` | `src/lib/theme-colors.ts`, `src/app/layout.tsx` |
| Full-screen look | `appleWebApp` (capable, title "TopStock", status bar "default") | `src/app/layout.tsx` |
| Safe areas | `viewport-fit=cover`, so `env(safe-area-inset-*)` reports real insets (it reports 0 without it: the dock, sheets, toasts and call panel already add the bottom inset); the body is padded by the top, right and left insets | `src/app/layout.tsx`, `src/app/globals.css` |
| Proxy and CSP | `/manifest.webmanifest` added to the public paths (browsers fetch it without cookies; it holds no data); it still gets the CSP and the security headers. The CSP is unchanged: `default-src 'self'` covers the manifest and the icons; the PNGs bypass the proxy as every image does | `src/proxy.ts` |

Tests: `tests/unit/pwa.spec.ts` (manifest fields, colours equal the CSS tokens, every icon's size and format, the
apple icon opaque, maskable corners red and every mark pixel inside the 40 % circle, "any" corners transparent, the
manifest public in the proxy while `/leads` still redirects, viewport-fit and the padding present, no service worker
code), `tests/e2e/pwa.spec.ts` (production build, signed out: manifest 200 `application/manifest+json` with nosniff
and the CSP, every icon 200 `image/png`, the sign-in page links the manifest and the apple icon, `viewport-fit=cover`,
both theme colours, no service worker registered, no console error, no sideways scroll; light and dark; 1440 and 390).

## Decisions (recommended option taken; logged in `docs/log.md`)

1. **Template location: `docs/ops-templates/`**, next to `migrate-prod.yml`, `backup-prod.yml` and `keep-alive.yml`
   (the brief said "e.g. ops/topstock-ops/"; the plan and go-live already use `docs/ops-templates/`, so one place).
   The script stays in topstock-crm (`scripts/ops/`) and topstock-ops runs it at a pinned commit, as the plan says.
2. **A third function, `lead_file_sweep_stats()`**, beyond the plan's two: the script's sanity check ("bucket holds
   objects but zero files rows") and the plan's "names outside the shape are counted" need counts the candidates list
   cannot give. Same rules (INVOKER, service_role only).
3. **The 24-hour grace period is a floor in SQL**, not only a default: a misconfigured run can never reach an upload
   in flight. `SWEEP_MIN_AGE_HOURS` can only lengthen it.
4. **Only `created_at` decides the age.** storage-api's update trigger rewrites `updated_at`, and an orphan cannot be
   rewritten through the app (a signed upload needs a pending row, which would protect it), so `updated_at` adds no
   safety.
5. **The size is read inline** (the JSON number under `size`, as `private.org_storage_bytes` reads it) so service_role
   needs no access to schema `private`.
6. **`p_bytes` in the audit row**: the bytes removed, or in a dry run the bytes found.
7. **Theme colour in the manifest is the light one**: a manifest has a single theme colour; the dark one reaches the
   browser through the existing media-query `theme-color` tag.
8. **The manifest has no description** and no `lang`: it is one document for EN and FR; the name is the same in both.
9. **Plan test wording**: the plan's "`file_usage()` drops by its size" is checked as "the bucket's real bytes drop by
   its size" (above).

## Checks (15 Oct 2026, on `day7c-local`)

| Check | Result |
|---|---|
| `npm run lint` | 0 errors (3 warnings, all pre-existing in `check-step.tsx`, `stock-table.tsx`, `leads-table.tsx`) |
| `npm run typecheck` | clean |
| `npm run test:unit` | 628 passed (20 new in `sweep-plan.spec.ts`, 7 in `pwa.spec.ts`) |
| `DB_TEST_PORT=54597 scripts/db-test.sh` | exit 0, 27 suites green (the 26 of Day 7a plus `sweeper_attack`), first with `PGTZ=Europe/Paris` at 23:15 UTC (the evening flake below), then again with no `PGTZ` at 00:00 UTC on 16 Oct: exit 0, 27 suites green, advisors 0 ERROR |
| Supabase advisors (splinter, in db-test) | 0 ERROR. Same as Day 7a: WARN `share_view` and `share_request` anon SECURITY DEFINER (Day 6, by design), `set_user_role` (accepted Day 1); INFO unindexed_foreign_keys 8, unused_index 12 (empty database; varies between runs). The three new functions are INVOKER: no new finding. The dev project's advisors run after `deploy-dev-db` applies the migration (not deployed from here) |
| `python3 scripts/db-mutations.py --anchors` | 672 rows in 16 sets, every edit applies (day7c 12 of 12) |
| `python3 scripts/db-mutations.py --set day7c` (real run) | 12 of 12 caught (table and notes: `mutations.md`) |
| Signed-out e2e on a production build (placeholder Supabase values, Next on :3900, Chromium 1194) | 26 passed (6 new in `pwa.spec.ts` across 1440 and 390, the 20 existing) |
| Safe-area padding with emulated insets (CDP `Emulation.setSafeAreaInsetsOverride`, 390 x 844, top 47 / bottom 34) | body `padding-top: 47px`, light and dark |
| Sweeper against real SQL through the local PostgREST stand-in (`scripts/local-auth/gateway.mjs` on :54601, Postgres :54600, demo service_role JWT) | dry run: found 1 (the 3-day orphan; not the 1-hour one, not the one with a ready row), exit 0, audit row `{found 1, removed 0, bytes 4321, dry_run true}`; the anon key: HTTP 401 (42501), exit 1; apply: the stand-in has no Storage API, so the delete answers 404, the run stops (exit 1) and records `removed 0`; nothing deleted; a cap of 0: exit 2 |
| actionlint 1.7.7 + ShellCheck 0.10.0 (release binaries, checksums verified) on the new template (and the existing templates and `db.yml`) | clean |
| gitleaks 8.28.0 over the branch's commits | no leaks |
| `npm audit --omit=dev --audit-level=high` | 0 vulnerabilities (no dependency change) |
| Semgrep | not run here: semgrep.dev is blocked by the session's proxy (403); CI runs it |

Pre-existing flake seen while checking (not from this branch; **fixed since** by Day 7a's merge of PR #18's Paris-day
change, `PGTZ=Europe/Paris` in `db.yml` and `scripts/db-test.sh`, merged into this branch on 16 Oct): `stock_attack.sql` fails between 22:00 and 24:00 UTC in
summer time (23:00 to 24:00 in winter) because it builds hold dates from `current_date` (UTC) while the stock guard
uses the Paris date. It hit this session at 22:25 UTC (00:25 Paris); `PGTZ=Europe/Paris` makes it pass, which confirms the cause. CI runs in UTC, so a CI run in that window fails the same way. A follow-up task was suggested (fix the test's dates; no migration change).

## Advisor round 1 fixes (16 Oct 2026)

The advisor's CHANGES NEEDED on `bdd8c50`, each fixed (recommended option taken where it offered a choice):

| # | Advisor point | Fix | Proof |
|---|---|---|---|
| 1 | Merge the latest `day7a-local` (Day 6 PR #18 fixes) | Merged `f33b5f1`: PGTZ=Europe/Paris in `db.yml` and `db-test.sh`, the two WebKit shards in `ci.yml`, the arrival-focus retry, the product search Enter fix, the eq-js nosemgrep line. One conflict (`docs/log.md`, rows on both sides kept). 7c's sweeper steps in `db.yml`, `db-test.sh` and `db-mutations.py` kept | `db-test.sh` exit 0 with all suites, `--anchors` all sets |
| 2 | Cap edge: `p_limit: maxObjects + 1` could be 1001, which the SQL refuses | **Both options at once:** `SWEEP_MAX_OBJECTS` is now 1 to 999 (`MAX_OBJECTS`); the request is `Math.min(max + 1, 1000)` (`SQL_LIMIT`), and a full page of 1000 rows counts as over the cap even for a caller that skips `readConfig`. Runbook "Raising a cap", the script header and the template's input text say 999 | `sweep-plan.spec.ts`: the fake server now refuses `p_limit` above 1000 like the migration; cap 999 asks for 1000 and stops on 1000 found, sweeps 999; 1000 is a config error; a raw cap of 1000 still asks for 1000 and stops |
| 3 | Audit row said `dry_run: true` for an apply run that found nothing | `p_dry: !config.apply` | Unit test: apply with 0 found records `{0, 0, 0, p_dry: false}`; a dry run with 0 found still records `true` |
| 4 | `sweeper_attack.sql` B6 comment said "another organisation" but used the same one | B6 makes a second organisation (no member) and puts a pending files row in each; only the second organisation's object with no row is a candidate | `sweeper_attack: all checks passed` |
| 5 | UI evidence for the PWA and safe-area change | 114 screenshots in `screens/` (below), both audits, three real issues found and fixed | `apple-design-audit.md`, `web-design-guidelines-audit.md`, `screens/measurements*.json` |
| 6 | Untracked `playwright.7c.local.config.ts` | Deleted at the end (never committed); the local runs used configs in the scratchpad | `git status` clean |

### Safe areas: what the screenshots found and what changed

| Found (emulated insets, CDP `Emulation.setSafeAreaInsetsOverride`) | Fix | Files |
|---|---|---|
| Opening any dialog dropped the body's safe-area padding (Radix's scroll lock rewrites body padding from its margins), so the page behind the sheet jumped up by 47 px | `body[data-scroll-locked]` keeps the three insets (`!important`, as the lock's own rule comes later) | `src/app/globals.css` |
| P2: `min-h-dvh` wrappers plus the 47 px top padding: every page 47 px taller than the screen | New utility `min-h-safe-screen` (100dvh less the top inset) on the four full-height wrappers | `src/app/globals.css`, `src/app/(app)/layout.tsx`, `src/app/(auth)/layout.tsx`, `src/app/(share)/layout.tsx`, `src/app/error.tsx` |
| Phone deal sheet rose to 12 px from the top: grabber and title under the status bar | Height `100dvh - max(12px, top inset)` | `src/components/pipeline/deal-sheet.tsx` |
| P1: landscape deal sheet text 21 px from the edge, under the notch | Sheet pads the side insets below 1024 px | `src/components/pipeline/deal-sheet.tsx` |
| P1 (same class, by reading): the call panel's floating card 24 px from the right, its phone height to 24 px from the top; the share page's fixed bar 16 / 24 px from the sides | `max(24px, right inset)`, `100dvh - max(24px, top inset)`, `max(16 / 24px, side inset)` | `src/components/activity/call-panel.tsx`, `src/components/share/share-page.tsx` |
| Doubled bottom padding | None found: the body pads top and sides only; the sheet pads the bottom inset once (34, no descendant adds another); the dock floats 16 + inset | (no change) |

`tests/unit/pwa.spec.ts` gains a test for the scroll-lock rule, the utility, the four wrappers and the deal sheet's
classes.

### Checks after round 1 (16 Oct 2026, on `day7c-local` after the merge and the fixes)

| Check | Result |
|---|---|
| `npm run lint` | 0 errors (the same 3 pre-existing warnings) |
| `npm run typecheck` | clean |
| `npm run test:unit` | 632 passed (4 new: the cap edge, apply with 0 found, the 999 config limit, the safe-area rules) |
| `DB_TEST_PORT=54597 scripts/db-test.sh` | exit 0, every suite green with `PGTZ=Europe/Paris` from the merge, `sweeper_attack` with the new B6; advisors 0 ERROR (WARN share_view, share_request, set_user_role as before; INFO unindexed_foreign_keys 8, unused_index 14) |
| `python3 scripts/db-mutations.py --anchors` | 672 rows in 16 sets, every edit applies (day7c 12 of 12) |
| `python3 scripts/db-mutations.py --set day7c` (real run) | 12 of 12 caught (rows 1 to 9 in one run, which the session's 30-minute background limit then stopped; rows 10 to 12 in a second run; the stopped run's mutated migration line was restored from git) |
| Affected Chromium e2e, signed in (own stack: Postgres :54600, GoTrue :9990, gateway :54601, Next :3900, Chromium 1194; spec copies with port 3100 swapped for 3900) | 86 passed: `pipeline` 18, `lead-deals` 9 (deal sheet), `lead-page` 26 (call panel), `share` 12 (share bar), `shell` 21 (layout wrapper) |
| Signed-out e2e on the same build (`tests/e2e`, 1440 and 390, incl. `pwa.spec.ts`) | 26 passed |
| Safe-area screenshots (below) | 112 shots, sideways scroll 0 and no console error on every one |
| gitleaks 8.28.0 over `54739bb..HEAD` and the new evidence files | no leaks |
| actionlint 1.7.7 on the workflows and templates | clean |
| `npm audit --omit=dev --audit-level=high` | 0 vulnerabilities |

### Screenshots (`screens/`, local run only, not in CI)

Signed in as an admin in an org made for the run (Home's fixture: six leads, seven deals), Next production build on
:3900 against this builder's own local stack (Postgres :54600, GoTrue :9990, gateway :54601), Chromium 1194, reduced
motion, the queue summary mocked as on Day 5c. Every shot: URL checked, no console error, no sideways scroll
(measured), measurements in `measurements.json` and `measurements-768-1024.json`.

- `{home,leads,pipeline,deal-sheet}-{en,fr}-{light,dark}-{390,1280,1440,1728}.png`: 64 shots.
- `{…}-{en-light,fr-dark}-{768,1024}.png`: 16 shots (the layout changed: the deal sheet is a bottom sheet below
  1024 px).
- `insets-portrait-{screen}-{locale}-{scheme}.png` (390 x 844, top 47, bottom 34) and `insets-landscape-…` (844 x 390,
  the 390 phone turned: left and right 47, plus the home indicator's bottom 21): 32 shots.
- `before-fix-insets-{portrait,landscape}-deal-sheet-en-light.png`: the two problems before the fix.

Measured with insets: sideways scroll 0; body padding 47 top (portrait) and 47 / 47 sides (landscape), kept with the
sheet open; full-height overflow 0 (was 47); dock 50 px from the bottom in portrait (16 + 34), 37 in landscape;
deal sheet top at 47 in portrait, bottom padding 34 (portrait) and 21 (landscape), content 68 / 60 px from the sides
in landscape.

## Residuals

- **S1. The sweeper key is full service_role.** Supabase secret keys cannot be limited to three functions. Kept small
  by: topstock-ops only, revocable alone, pinned code, no npm install, read-only checkout token.
- **S2. Not yet run on real storage-api.** The apply path's real removal is proven only by `tests/auth/sweeper.spec.ts`,
  which runs in CI (auth-journey) once this branch is pushed; locally there is no storage-api. The local smoke ran
  everything up to the delete request against real SQL.
- **S3. Production restore.** While a restore loads file rows, objects can briefly have no row; the runbook says to
  disable the workflow first.
- **P1. Landscape notch for fixed layers: fixed on 16 Oct** (advisor round 1, below). The screenshots with emulated
  insets showed it: the deal sheet's text sat under the notch in landscape and its top under the status bar in
  portrait. The deal sheet, the call panel and the share page's bar now keep clear of the insets. A real iPhone check
  stays in part 2's phone pass.
- **P2. Top inset and full-height pages: fixed on 16 Oct.** Measured: every page scrolled by 47 px with a top inset of
  47. The full-height wrappers now use `min-h-safe-screen` (100dvh less the top inset); measured overflow 0.
- **P3. One manifest theme colour.** Splash background is Chalk White in dark mode too (manifest limitation).
- **Semgrep** not run locally (above).

## Not done here (needs the caller or Haider)

- The `advisor` subagent round (CLAUDE.md: before any REPORT): this builder runs as a subagent without the Agent tool,
  so the advisor must be run by the caller on this branch.
- Push, PR, CI, Vercel preview: not in this part (local only, as asked).
- Part 2 of 7c: French pass, phone pass (dock, Lose sheet, call sheet focus trap, edge fades), restore runbook gains
  `share_reader`.

## Day 8 steps for Haider (click by click)

Do these after go-live part I (keep-alive). Full text with "what you should see": `docs/ops-templates/sweep-lead-files.md`.

1. **Create the key.** Private window, Supabase account B (ops@ login) > project topstock-prod > **Project Settings** >
   **API Keys** > tab **Publishable and secret API keys** > under **Secret keys** click **Add new secret key** (may read
   **+ New secret key**) > name `sweeper` > create > **Copy** the new key (starts `sb_secret_`). Never paste it into
   Claude.
2. **Store it.** github.com/hyder-afk/topstock-ops > **Settings** > **Secrets and variables** > **Actions** > **Secrets**
   > **New repository secret** > name `PROD_SWEEPER_KEY`, value the key > **Add secret**. Close the account B window.
3. **Variables.** Same page > **Variables** > **New repository variable**: `SWEEPER_SHA` = the full commit SHA Claude
   gives you (a commit on main that has the sweeper); then `SWEEP_APPLY` = `no`.
4. **Paste the workflow.** topstock-crm on github.com > `docs/ops-templates/sweep-lead-files.yml` > **Copy raw file**;
   topstock-ops > **Add file** > **Create new file** > name `.github/workflows/sweep-lead-files.yml` > paste > **Commit
   changes** to `main`.
5. **First run (dry).** topstock-ops > **Actions** > **sweep-lead-files** > **Run workflow** (confirm empty) > **Run
   workflow**. Green tick, summary "(dry run)", "found N". Tell Claude "Part I2 done, found N".
6. **Dry-run week.** It runs daily by itself; read the "found" number; tell Claude the numbers only.
7. **Switch on (after the week, when Claude and you agree).** Variables > `SWEEP_APPLY` > `yes`. Optionally one manual
   run with confirm `SWEEP`: green, "(apply)", "Removed: N of N".

Also on Day 8 (go-live part E, before migrate-prod): account B > topstock-prod > **Database** > **Extensions** > search
`pg_cron` > switch on > **Enable extension**.

## Context7 and docs checked

- Supabase (`/supabase/supabase`): Storage API bulk delete `DELETE /object/{bucketName}` with a JSON `prefixes` array
  (storage OpenAPI); new API keys: secret keys go in the `apikey` header, are not JWTs and are refused as bearer tokens
  ("Migrating to new API keys", Edge Functions auth headers, the gateway's opaque-key translation); creating one secret
  key per backend component in **Settings > API Keys** and rotating a leaked key (create, replace, then delete the old
  one, which cannot be undone).
- Next.js (`/vercel/next.js`): `manifest.ts` (`MetadataRoute.Manifest`, served as `/manifest.webmanifest`), the
  `apple-icon` file convention, `appleWebApp` metadata tags. `viewportFit` was checked against Next's own `Viewport`
  type (typecheck) and the rendered tag (`tests/e2e/pwa.spec.ts`), not in Context7.

---

# Day 7c (part 2): the French pass, the phone pass, the restore runbook, 16 Oct 2026

Same branch `day7c-local`, on part 1's advisor-approved head eb1b1bc. Not pushed, no PR. Plan row 7c (section 4):
French and phone pass; restore runbook gains `share_reader`.

## Step 0: Day 7b merged

`day7b-local` 0e895b5 (custom pickers, check:native, the Leave-site prompt kept) merged with `--no-ff` (0159d96).
Conflicts: `src/app/(app)/layout.tsx` keeps Day 7b's `data-role` and `group/app` with part 1's `min-h-safe-screen`;
`src/app/layout.tsx` imports both `themeColors` and `TooltipProvider`; `docs/log.md` merged with both sides kept (no
conflict markers). Day 7b's two new packages (`@radix-ui/react-select`, `@radix-ui/react-tooltip`, already in the
lockfile) were installed into this worktree's `node_modules` (`npm install --ignore-scripts`; no package change).
After the merge: lint 0 errors (3 old warnings), typecheck clean, `check:native` clean, unit 681 passed.

## Step 1: the French pass (107529e)

| Looked for | How | Found | Fix |
|---|---|---|---|
| Missing keys | Every key of `en.json` against `fr.json`, all 41 namespaces (2,434 strings); `messages.spec` only compared a list of namespaces | none | the parity test now covers the whole file and the top-level namespaces |
| English left in `fr.json` | Every French value equal to its English value | 79, all legitimate: brand names and the tagline (Brand Pack), words spelt the same (Pipeline, Contacts, Note, Stock, Total, Message, Date, Admin, Manager, Administration, Actions, Import, Correction), units Haider fixed for both languages ("pcs", 11 Oct), argument-only patterns, the call scripts (both files hold both languages) | a named allowlist; any other identical value fails |
| Typography | U+202F before `; ? ! » :` and after `«`, curly apostrophes, `…` | all good, except **12 numbers with ordinary spaces** ("1 000 000 €", "50 000 000", "15 Mo", "2 000 caractères"): a line could break inside a number | U+202F for thousands, U+00A0 before the unit, as Intl writes fr-FR; now a test rule |
| ICU arguments and tags | Same argument names and rich-text tags per key (French may count on `done` where English counts on `doneFormatted`) | none | test |
| Hardcoded strings | A TypeScript AST scan of every `.tsx` in `src/` for JSX text, string children and read attributes (`aria-label`, `placeholder`, `alt`, `title`, `label`) | none to fix; 10 legitimate: the root error boundary's bilingual text (no translations there), the logo's brand name, "FR" as a country-code example, the language names in their own language on the share-link card, a skeleton test hook | `tests/unit/hardcoded-strings.spec.ts` with these named exceptions (each must still match); the error boundary's French half now says `lang="fr"` |
| Locale-blind formatting | `toLocaleString()` without a locale, `toFixed` shown to people, hardcoded "€", `en-US`/`en-GB` formats | only internal uses (ISO dates in a zone, a CSS width, the 24-hour task time that reads the same in both) | none |
| Longer French labels at 390 | Screenshots plus the CI check below | Home's stalled reason lost its day count; the pipeline's lost line left a "·" hanging; the queue's scope control broke into two uneven rows | fixed in Step 2 |

Unit tests added: `messages.spec.ts` block "the whole French file (Day 7c)" (4 tests: keys, allowlist, arguments and
tags, typography in every namespace; each shown failing on a planted break), `hardcoded-strings.spec.ts` (2).

## Step 2: the phone pass (07b1599, 2e3e882, cb09e3c, d5a59eb)

`tests/auth/phone.spec.ts`, signed in as an admin of an org made for the run (Home's fixture, four products with
stock and a hold, a lead with a number), 390 x 844, touch, Chromium:

| Test | Runs | Checks |
|---|---|---|
| `phone_fit` | CI | Home, Leads, a lead, Pipeline, Tasks, Work queue, Inventory, Sales, More, Team, lead import, stock import, in EN and FR: no sideways scroll; every tap target hit-tested 22 px either side of its centre, across and down (what a tap really reaches, so a pseudo-element extension counts; inline links in a sentence and visually hidden controls are exempt; a disabled control is measured by its box; a large card passes if a 44 px cross fits in it); the page's end above the dock; no control or heading label cut by an ellipsis; no console error; at least 6 targets per route (not vacuous) |
| `phone_sheets` | CI | Add lead, New deal, deal sheet, Lose (over the deal sheet), note sheet, call panel after the call (its tallest state), Record sale, Hold stock, command menu, EN and FR: inside the viewport, 44 px targets, whole labels, closed again cleanly |
| `phone_safe_areas` | CI (Chromium) | Emulated insets 47 / 34 (`Emulation.setSafeAreaInsetsOverride`): header below the status bar, dock 16 px above the home indicator, no sideways scroll on every route, the deal sheet's top below the notch |
| `phone_shots` | `DAY7C_PHONE=1` only | The screenshots below; CI time unchanged (skipped) |

What it found, and the fixes (DESIGN.md: 44 px controls, never fix label widths, page padding 16 on phones):

| Found | Fix | File |
|---|---|---|
| Today card: task link 20 px tall | phone-only pseudo-element, tap area 44 px, row height and skeleton unchanged | `home/today-card.tsx` |
| Deal sheet: lead name in the title 25 px tall | same, 45 px | `pipeline/deal-sheet.tsx` |
| Inventory: product name link 36 px tall | `min-h-11`, centred | `inventory/stock-table.tsx` |
| Leads: Views and Columns 40 px wide (icon only on phones) | `min-w-11` | `leads/leads-toolbar.tsx` |
| Date, time and search fields: the button inside the field 40 px | 44 px on phones, flush right (fields keep their right padding) | `ui/date-picker.tsx`, `ui/time-picker.tsx`, `ui/search-input.tsx` |
| More: EN and FR segments 41-42 px wide | `min-w-11` on phones | `settings-bar.tsx` |
| Timeline: entry menu drawn 44 px but 4 px of it outside its `content-visibility` row, which clips paint and taps | its negative margin only from `sm` | `activity/timeline.tsx` |
| Home, Needs attention (FR): "Bloquée · aucun mouvement ni contact depuis 20 jours" cut before the count | `line-clamp-2 text-pretty`, dot on the first line | `home/attention-card.tsx` |
| Pipeline (FR): "·" left at a line's end before "Voir les affaires perdues" | on phones the link takes its own line, no separator | `pipeline/board.tsx` |
| Work queue (FR): "Les miens + sans responsable" broke the scope control into two rows | phones: one row of three, the middle label wraps inside its segment; skeleton matches | `queue/queue-workspace.tsx`, `leads/queue/loading.tsx` |
| Strips that scroll sideways gave no sign of more (plan row 7c "edge fades") | `edge-fade` utility: an edge fades only while more lies past it, driven by the strip's own scroll (scroll-driven animation, no fade where unsupported or not overflowing); tab strips, stock / sales / share chips, quick-add dates, pipeline owners and phone stage tabs | `globals.css`, `ui/tabs.tsx` and the strips |
| Stock chips: the first chip snapped flush to the screen edge (snap without scroll padding) | `scroll-px-4` on phones; the tab strip `scroll-px-1` | `inventory/stock-toolbar.tsx`, `ui/tabs.tsx` |
| A tab revealed by the keyboard or a deep link could land inside the fade (audit) | `revealTab` leaves the fade's width clear except at the strip's ends | `ui/tabs.tsx` |
| Nothing under the dock, no sideways scroll, sheets inside the screen, safe areas | none needed (the checks pass in both languages) | |

### Screenshots (`phone/`, local run, not in CI; first round: 66 PNG, now 147 after advisor round 1, see below)

Production build on :3900 against this builder's own stack (Postgres :54600, GoTrue :9990, gateway :54601),
Chromium 1194, reduced motion, 390 x 844, touch. Each shot after the URL check, the skeletons gone, no sideways scroll;
no console error in any context.

- `{home,leads,lead,pipeline,tasks,queue,inventory,sales,more,team,import,stock-import}-{en,fr}-{light,dark}.png`:
  48 full-page shots. In a full-page shot the floating dock shows where it sits in the first screen (it is fixed).
- `sheet-{add-lead,new-deal,deal-sheet,lose,note-sheet,call-panel,record-sale,hold-stock,palette}-{en-light,fr-dark}.png`:
  18 shots of the screen as a person sees it.

## Step 3: the restore runbook (3cf82d0)

`docs/ops-templates/restore-production.md`, for Haider on his own computer, never in a Claude session: which backup
exists on which Supabase plan (Free, today: only our own nightly `backup-prod`; Pro: 7 daily backups; the PITR add-on:
any second of the window), what to do first (team told, sweeper disabled, a fresh backup), part A (daily backup), part
B (PITR), part C (our own dump, into a new project or back into production), the checks after (sign-in, row counts,
Security Advisor, three files, a dry sweeper run), and **the Storage caveat**: no database backup holds the files, so
a file deleted after the restore point is gone for good, and a file uploaded after it loses its entry and looks like
an orphan to the sweeper (which is why the sweeper stays off until the dry run's count is understood). **Role
`share_reader` first** for any restore that recreates the schema (spike S1); `restore-into-dev.md` step 7 now says why
its data-only load needs no role. Facts checked against Supabase's "Database Backups" guide on 16 Oct 2026 (docs
search). Docs only; nothing touched production.

## Step 4: audits

- `apple-design-audit-part2.md`: pass after the fixes above (hit targets, French legibility, edge fades and reveal).
- `web-design-guidelines-audit-part2.md` (rules from the pinned commit 434b7f91364665f2f733b310ec54809bf8f37937,
  sha256 `d246b026…0e0234`): every finding fixed; the one it raised beyond the screenshots (a revealed tab inside the
  fade) fixed in d5a59eb.

## Decisions (recommended option taken; logged in `docs/log.md`)

1. **Equal-to-English French values are allowed by key**, not by value, so a changed English string never silently
   joins the allowlist; "Pipeline", "Admin", "Manager" stay as they are (used in French CRMs; Henri or Kais can still
   ask for other words, plan question 13).
2. **Tap targets are measured by hit-testing**, not by box size: the codebase grows small links with pseudo-elements
   (Day 4c), and a box check would miss a clipped target (the timeline menu) while flagging extended links.
3. **List-row data may truncate**; the CI label check covers controls and headings only (names and notes in rows are
   truncated by design and reviewed in the screenshots).
4. **The phone spec's products have names no other spec uses**: `inventory.spec` seeds its catalogue only when its
   marker product is missing from the stack, and the first run of this spec (with the catalogue's names) made it skip.
5. **The restore runbook is a new page** (`restore-production.md`) rather than a section of the dev restore test: one
   is an emergency in production, the other a quarterly test into dev.

## Checks (16 Oct 2026, on the code of `day7c-local` 727074e; the runs used the working tree that became it)

| Check | Result |
|---|---|
| `npm run lint` | 0 errors (the same 3 pre-existing warnings: `check-step.tsx`, `stock-table.tsx`, `leads-table.tsx`) |
| `npm run typecheck` | clean |
| `npm run check:native` | clean |
| `npm run test:unit` | 687 passed (6 new: 4 in `messages.spec.ts`, 2 in `hardcoded-strings.spec.ts`) |
| `tests/auth/phone.spec.ts` (own stack, Chromium 1194) | 4 passed (`phone_fit`, `phone_sheets`, `phone_safe_areas`, and `phone_shots` with `DAY7C_PHONE=1`); without the variable `phone_shots` is skipped |
| Affected signed-in e2e (same stack; spec copies with :3100 swapped for :3900, nothing in the repo changed) | home 15, leads 9, lead-page 26, pipeline 18, lead-deals 9, tasks 12, inventory 12, sales 11, share 12, shell 21, team 5, day7b 21, files 13 (5 storage-api tests skipped, CI only), queue 20: **204 passed**. Evidence-only tests skipped without their variables (day7b 11, inventory 1). `queue` `call_keeps_claims` fails on this machine, as before this branch (Day 5b, 5c and 7b READMEs: this Chromium fires one `beforeunload` for two quick `tel:` links); left to CI |
| Reruns explained | First batch: `day7b` disclosure lost its trace file because a second run started in the same output folder at the same time (rerun: pass); `inventory` stock table failed because the phone spec's first products used the catalogue's names (decision 4; renamed, rerun: pass); `files` "hidden tab" failed once on timing in a batch and passed alone |
| Signed-out e2e (`tests/e2e`, 1440 and 390) | 26 passed |
| gitleaks 8.28.0 (release binary, checksum verified) | `eb1b1bc..HEAD` (33 commits): no leaks; `docs/evidence/day7c`, `docs/ops-templates`, `messages`, `tests/unit`, `tests/auth/phone.spec.ts`: no leaks |
| `npm audit --omit=dev --audit-level=high` | 0 vulnerabilities |
| Semgrep | not run here (semgrep.dev blocked by the session's proxy, as in part 1); CI runs it |
| Context7 | Tailwind v4 `@utility` with CSS nesting and `@property` (tailwindcss.com docs); Playwright `BrowserContext.newCDPSession` / `CDPSession.send` (Chromium only) |

## Advisor round 1 (part 2): CHANGES NEEDED on 9446997, all ten fixed

| # | Advisor point | Fix | Proof |
|---|---|---|---|
| 1 | "Every route": add the missing signed-in routes and the pages outside the shell | phone_fit and the shots now also cover `/inventory/p/[id]`, `/inventory/settings`, `/inventory/client-view`, `/analytics`, `/files/unavailable`, and, each in its own context, `/login`, `/forgot-password` (signed out), `/mfa` (password done, code to come), `/mfa/setup` (a person without an authenticator), `/set-password`, and the client page `/s/fr`, `/s/en` (a fresh link each visit; sharing switched on in the run's org) | `phone.spec.ts` phone_fit: 17 signed-in routes and 6 outside pages, EN and FR |
| 2 | French at 768 and 1280 too; 768 shots per route; desktop shots of the part-2 changes | phone_fit runs the sideways-scroll and cut checks in French at 768 and 1280 on every route (tap targets stay at 390). Shots: every route at 768 in French; the strips (lead and inventory tab strips, quick-add chips, share chips) at 1280 / 1440 / 1728 in EN light and FR dark (both languages and both schemes); the lead's tab strip after a deep link at 390 (revealTab) | 23 + 24 + 2 shots below |
| 3 | Call panel: scroll padding, a Tab test, the focus-trap decision | The panel publishes its height (`--call-panel-h`, ResizeObserver); on phones `html:has([data-call-panel])` sets `scroll-padding-bottom` and main's bottom padding from it (the import action bar's pattern). Non-modal kept: **builder decision, Haider to confirm** (log) | `phone_call_panel_tab`: 10+ distinct controls reached with Tab, each above the panel; it **fails** with the padding removed (the quick actions and the deal button reported under the panel, checked) |
| 4 | Placeholders cut; the check missed them | Inventory search FR "Nom, catégorie ou P-0042…" and its own row below 1024 px (172 px at 768); Leads search shortened in EN and FR. cutLabels measures each placeholder in the field's font against its content box, flags overflowing `-webkit-line-clamp` labels, and counts terms (`dt`) as labels | It found, and we fixed, the product page's figure labels (cut at 390 in EN and FR); phone_fit green |
| 5 | hardcoded-strings.spec gaps | Literals in conditional branches and `\|\|` / `??` operands (attributes and children) are collected; the palette's endonyms are an exception; CardSkeleton's prop is `skeleton`, its two exceptions dropped; the header says .ts files and toast() are not scanned | 5 new self-test cases; the src scan passes |
| 6 | Runbook C2 must not reuse the dev restore test | C2 now says: ask Claude for the exact production steps at the time; do not adapt `restore-into-dev.md` (separate truncate, dev ref, no auth schema). C1 stays recommended | `restore-production.md` Part C |
| 7 | Storage caveat by part | A/B (daily, PITR) rewind `storage.objects` too: files uploaded after the restore point are stranded (invisible to the API and the sweeper), not swept. C (no storage schema): they look like orphans; after C1 the new bucket starts empty. Sweeper off in every part; step 2.5 explains "found" per part | `restore-production.md` "Storage" and step 2.5 |
| 8 | A focused chip in the fade | `edge-fade` sets `scroll-padding-inline: 24px`; revealTab picks among the strip's real snap stops; the strips' own scroll-px went | desktop and 390 shots; files, lead-page, inventory specs green |
| 9 | The dock's five | phone_fit asserts exactly 5 visible dock links on every signed-in route | phone_fit |
| 10 | Log the `--no-verify` | Row in `docs/log.md` (3cf82d0 changed docs only; the hook lints and typechecks code) | log |

Found by the wider checks and fixed: the client links' lead link on Inventory settings (20 px, its tap area clipped
by `truncate`; now 44 px on phones), the product figure labels, the inventory search width at 768.

### Screenshots after round 1 (`phone/`, 147 PNG, 8.5 MB)

- 390, signed in: `{home,leads,lead,pipeline,tasks,queue,inventory,sales,more,team,import,stock-import,product,
  inventory-settings,client-view,analytics,file-unavailable}-{en,fr}-{light,dark}.png` (68).
- 390, outside the shell: `{login,forgot-password,mfa,mfa-setup,set-password,share}-{en-light,fr-dark}.png` (12).
- 390, sheets: `sheet-{…}-{en-light,fr-dark}.png` (18); the lead's tab strip after `?tab=files`:
  `lead-tab-files-{en-light,fr-dark}.png` (2).
- 768, French light, every route: `768-{route}-fr-light.png` (23).
- Desktop, clipped to the strip: `desktop-{lead-tabs,inventory-tabs,quick-add-chips,share-chips}-{en-light,fr-dark}-
  {1280,1440,1728}.png` (24). Where a strip fits (most desktops), no fade shows, as designed.

### Checks after round 1 (16 Oct 2026, fresh stack: Postgres :54600, GoTrue :9990, gateway :54601, Next :3900)

| Check | Result |
|---|---|
| `npm run lint` | 0 errors (the same 3 pre-existing warnings) |
| `npm run typecheck` | clean |
| `npm run check:native` | clean |
| `npm run test:unit` | 687 passed |
| `tests/auth/phone.spec.ts` | 5 passed: phone_fit, phone_sheets, phone_call_panel_tab, phone_safe_areas, and phone_shots with `DAY7C_PHONE=1` (skipped without it) |
| Affected signed-in e2e | home, leads, lead-page, pipeline, lead-deals, tasks, inventory, sales, share, shell, team, day7b, files: 183 passed, 16 skipped (11 day7b evidence tests without their variable, 5 files storage-api tests, CI only), 0 failed; queue without `call_keeps_claims`: 20 passed. **203 passed** |
| Signed-out e2e | 26 passed |
| gitleaks 8.28.0 | `eb1b1bc..HEAD`: no leaks; the evidence, ops templates, messages, unit tests and phone spec: no leaks |
| `npm audit --omit=dev --audit-level=high` | 0 vulnerabilities |

## Advisor round 2 (part 2): one bug, fixed

| Point | Fix | Proof |
|---|---|---|
| `--call-panel-h` was read with `getBoundingClientRect()`, which includes the panel's entrance scale (0.6). A transform never fires a ResizeObserver, so for anyone without reduced motion the padding stayed about 40 % short for the whole call | The observer reads the layout height (`borderBoxSize[0].blockSize`, else `offsetHeight`) | `phone_call_panel_tab` now runs twice, with reduced motion and with `no-preference`, and checks Tab both during the call (small panel) and after it (outcome keys), each time after polling until `--call-panel-h` equals the panel's `offsetHeight`. On the old code the no-preference run **fails** ("103px of 170px"); with the fix both pass |

Checks after round 2: lint 0 errors (3 old warnings), typecheck clean, check:native clean, unit 687, `phone.spec.ts` 5
passed (phone_fit, phone_sheets, phone_call_panel_tab in both motion modes, phone_safe_areas; phone_shots skipped
without `DAY7C_PHONE=1`), `lead-page.spec.ts` 26 passed (the call panel's own tests). Screenshots unchanged (the fix
changes no layout at rest).

**CI time to watch:** `phone_fit` is one serial test with a 900 s timeout (17 signed-in routes and 6 outside pages at
390 in two languages, then French at 768 and 1280). Locally it takes about 1.5 minutes; its first CI run time (and
WebKit's, if the spec is ever added to the WebKit project) should be read from the auth-journey job before the PR is
merged, and the test split per locale if it comes close to the limit.

## Residuals (part 2)

- **R1. Real iPhone.** Safe areas are proven with emulated insets (now in CI); a check on Haider's phone in
  standalone mode waits for the Vercel preview.
- **R2. French read by a French speaker.** The pass checked keys, typography and fit; plan question 13 (Henri or Kais
  reads the French screens) stays open.
- **R3. Data in list rows truncates by design** (names, notes); not in the CI label check.
- **R4. `call_keeps_claims`** cannot be run on this machine (above).
- **R5. No backup of Storage.** The runbook states the caveat; a nightly copy of the bucket is not in Release 1.
- **R6. Call panel focus trap: decided "no trap"** (builder, under Haider's standing instruction, **Haider to
  confirm**; `docs/log.md`): the panel stays non-modal and keeps Tab-focused page controls clear of it instead (advisor
  round 1, below).

## Not done here (needs the caller or Haider)

- The `advisor` subagent round on part 2 (this builder has no Agent tool).
- Push, PR, CI, Vercel preview (local only, as asked).
