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
| Script | `scripts/ops/sweep-lead-files.mjs` (entry point) and `scripts/ops/sweep-core.mjs` (rules, loadable by the unit tests). Node 22 built-in fetch, no npm packages. Dry run unless `SWEEP_MODE=apply`; sanity stop; caps 50 objects / 200 MiB (one run can raise them); shape and org-id re-check on every row; two listings, deletes only names in both, 100 a request, through the Storage API (`DELETE /storage/v1/object/lead-files`); one audit row; counts and bytes per org id in the log and the run summary, never names; exit 0 / 1 (stopped or failed: GitHub emails Haider) / 2 (bad settings). The key travels in `apikey` only (a legacy JWT also as bearer, per Supabase's docs) | `scripts/ops/` |
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
  sanity counts move by exactly what the block stored. B6: a files row of another kind (pending, uploaded by nobody)
  still protects its object.
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

Pre-existing flake seen while checking (not from this branch): `stock_attack.sql` fails between 22:00 and 24:00 UTC in
summer time (23:00 to 24:00 in winter) because it builds hold dates from `current_date` (UTC) while the stock guard
uses the Paris date. It hit this session at 22:25 UTC (00:25 Paris); `PGTZ=Europe/Paris` makes it pass, which confirms the cause. CI runs in UTC, so a CI run in that window fails the same way. A follow-up task was suggested (fix the test's dates; no migration change).

## Residuals

- **S1. The sweeper key is full service_role.** Supabase secret keys cannot be limited to three functions. Kept small
  by: topstock-ops only, revocable alone, pinned code, no npm install, read-only checkout token.
- **S2. Not yet run on real storage-api.** The apply path's real removal is proven only by `tests/auth/sweeper.spec.ts`,
  which runs in CI (auth-journey) once this branch is pushed; locally there is no storage-api. The local smoke ran
  everything up to the delete request against real SQL.
- **S3. Production restore.** While a restore loads file rows, objects can briefly have no row; the runbook says to
  disable the workflow first.
- **P1. Landscape notch for fixed layers.** The body pads the side insets; fixed full-width layers on phones (sheets,
  the call panel's floating card at `right-6` from 640 px) do not add the side inset in landscape. To check in part 2's
  phone pass on a real iPhone (component changes are out of this part).
- **P2. Top inset and full-height pages.** With a non-zero top inset (iOS standalone with a translucent status bar,
  which we do not use), pages that are `min-h-dvh` would scroll by the inset. With `statusBarStyle: "default"` the top
  inset is 0 in standalone; to confirm on a real iPhone in part 2.
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
