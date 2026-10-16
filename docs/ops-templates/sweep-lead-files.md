# Runbook: the orphan file sweeper (topstock-ops)

For Haider. Written 15 Oct 2026 (Day 7c). The workflow is `docs/ops-templates/sweep-lead-files.yml`, the script
`scripts/ops/sweep-lead-files.mjs`, the database part `supabase/migrations/20261022090000_orphan_sweeper.sql`.
Decided by Haider on 15 Oct 2026: "orphan sweeper runs from topstock-ops with its own key; dry-run week first".

## What it is, in plain words

When someone cancels a file upload at exactly the wrong moment, the file's bytes can still land in storage with no
file entry in the CRM (spike S5). Nobody can see or delete those bytes in the app, and they eat into the team's
800 MB of file space. Once a day the sweeper looks for files in storage that have **no** entry in the CRM and are more
than **24 hours** old, and (once you switch it on) removes them.

It runs in **topstock-ops**, your private repository that Claude never reaches, with its **own** Supabase secret key
that does nothing else. That key never goes to Vercel, to topstock-crm or to Claude.

**What it never touches:** files that have an entry in the CRM (waiting, ready or being deleted), files younger than
24 hours, anything outside the `lead-files` storage bucket, and any file whose name does not have the exact shape the
CRM gives files (those are only counted).

**Safety rules built in:**
- **Dry run first.** Scheduled runs only list until you set `SWEEP_APPLY` to `yes`. A manual run deletes only when you
  type `SWEEP`.
- **Caps.** If one run finds more than 50 files or 200 MB, it stops without deleting anything and the run turns red.
- **Sanity check.** If storage holds files but the CRM reports no file entries at all, it stops (red).
- **Double check.** It lists twice and deletes only files found both times, 100 at a time.
- **No names in logs.** The run shows counts and sizes per organisation id only.
- **Pinned code.** It runs the script from one commit you choose (`SWEEPER_SHA`); new code on main never runs with
  the production key until you change that variable.

---

## Day 8 set-up (do these in order, after go-live part I)

### Step 1. Create the sweeper's own secret key (account B)
1. Private browser window, log in to Supabase **account B** (the ops@ login), open project **topstock-prod**.
2. Left menu **Project Settings** > **API Keys** > tab **Publishable and secret API keys**.
3. Under **Secret keys**, click **Add new secret key** (the button may say **+ New secret key**).
4. Name: `sweeper`. Create it.
5. Click the eye or **Copy** next to the new `sweeper` key (it starts with `sb_secret_`). Keep the window open for
   step 2. Do not save the key anywhere else, and never paste it into Claude.

### Step 2. Store it in topstock-ops
1. github.com/hyder-afk/topstock-ops > **Settings** > **Secrets and variables** > **Actions** > tab **Secrets** >
   **New repository secret**.
2. Name `PROD_SWEEPER_KEY`, value: the key from step 1. **Add secret**.
3. Close the account B window.

### Step 3. Add the two variables
Same page, tab **Variables** > **New repository variable**, once per line:

| Name | Value |
|---|---|
| `SWEEPER_SHA` | the full 40-character commit SHA Claude gives you (a commit on topstock-crm main that has the sweeper) |
| `SWEEP_APPLY` | `no` |

### Step 4. Paste the workflow
1. In topstock-crm on github.com, open `docs/ops-templates/sweep-lead-files.yml` > **Copy raw file**.
2. In topstock-ops: **Add file** > **Create new file**, name `.github/workflows/sweep-lead-files.yml`, paste,
   **Commit changes** > directly to `main`.

### Step 5. First run by hand (dry run)
1. topstock-ops > **Actions** > **sweep-lead-files** > **Run workflow**. Leave **confirm** empty. **Run workflow**.
2. Open the run when it finishes (about 1 minute).

**What you should see:** a green tick. The summary says `sweep-lead-files (dry run)`, the number of files in storage,
the number of file entries, and "Older than 24 hours with no files row: N objects". On a new production project N is
`0`. The last line says "Dry run: nothing removed".

**Done when:** green. Tell Claude "Sweeper step 5 done, found N" (the number only).

### Step 6. The dry-run week
It now runs by itself every day at 03:37 UTC, still as a dry run. Once a day or at the end of the week, open the
latest run and read the "found" number. Normal: 0, or a handful after someone cancelled uploads. Not normal: a red
run, or a number that keeps growing. Tell Claude the numbers only (for example "dry week: 0, 0, 1, 0, 0, 0, 0").

### Step 7. Switch deleting on (after the week, when Claude and you agree)
1. topstock-ops > **Settings** > **Secrets and variables** > **Actions** > **Variables** > `SWEEP_APPLY` > edit to
   `yes` > **Update variable**.
2. Optional but recommended: run it once by hand to see the first real removal: **Actions** > **sweep-lead-files** >
   **Run workflow**, confirm `SWEEP`, **Run workflow**.

**What you should see:** green; the summary says `(apply)` and "Removed: N of N". From now on the daily run removes
what it finds.

---

## Reading a run

| What you see | What it means | What to do |
|---|---|---|
| Green, "Dry run: nothing removed" | Listed only | Nothing (dry-run week) |
| Green, "Removed: N of N" | Removed N stray files | Nothing |
| Green with a yellow warning "names outside the shape" | Storage holds files the CRM never names (someone used the dashboard?) | Tell Claude the count; they are never removed |
| Red, "more objects than the cap" or "more bytes than the cap" | Something looks wrong, so it stopped; nothing was deleted | Do not raise the cap. Tell Claude the numbers in the message |
| Red, "zero files rows (sanity check)" | Storage has files but the CRM reports none; it stopped; nothing was deleted | Tell Claude right away; do not run it again with SWEEP |
| Red, "HTTP 401" or "HTTP 403" | The key is wrong, revoked or the publishable one | Redo steps 1 and 2 with a new `sweeper` key |
| Red, "SWEEPER_SHA ... is not on main" | The variable is not a merged commit | Paste the SHA Claude gives you again |
| Red, "a delete request failed" | Storage refused part of the removal | Run again tomorrow; tell Claude if it repeats |

### Raising a cap for one run (only when Claude asks)
**Run workflow** > confirm `SWEEP` > set **max_objects** or **max_mib** to the number Claude gives you. The next
scheduled run uses the normal caps again. The highest **max_objects** is 999 and the highest **max_mib** is 1024: a
bigger number stops the run at once with "bad settings" and nothing is deleted. More than 999 orphans means something
is wrong; tell Claude instead of raising the cap further.

### Moving to newer sweeper code
Claude gives you a new commit SHA after a reviewed change is merged. Edit the variable `SWEEPER_SHA` to it. Nothing
else changes.

### Turning it off
topstock-ops > **Actions** > **sweep-lead-files** > the **...** menu at the top right > **Disable workflow**. To stop
deleting but keep the daily count, set `SWEEP_APPLY` back to `no` instead.

### Before any restore into production
Disable the workflow first (above) and enable it again only after the restore is finished and checked. While file
entries are being loaded back, files in storage can briefly have no entry, and the sanity check only catches the case
where the CRM has none at all.

### If the key leaks
1. Account B > topstock-prod > **Project Settings** > **API Keys** > **Secret keys**: create a new key named
   `sweeper-2`, copy it.
2. topstock-ops > Secrets > `PROD_SWEEPER_KEY` > **Update** with the new value.
3. Run the workflow once by hand (dry run) to see it green.
4. Back in account B, delete the old `sweeper` key (this cannot be undone; do it only after step 3 is green).
Nothing else uses this key, so no other part of the CRM is affected.

## What to tell Claude (and what never)
- Fine: "green" or "red", the red step's message, the found and removed numbers, "names outside the shape: N".
- Never: the key, the project reference, organisation ids from the summary, file names, screenshots of the dashboard.

## For Claude (reference)
- Database: `public.lead_file_orphans(p_min_age interval default '24 hours', p_limit integer default 200)`,
  `public.lead_file_sweep_stats()`, `public.record_file_sweep(p_found, p_removed, p_bytes, p_dry)`; SECURITY INVOKER,
  `search_path = ''`, executable by `service_role` only. Audit rows: `action = 'file_sweep'`,
  `table_name = 'storage.objects'`, no org, actor or record id, `diff_json` = `{found, removed, bytes, dry_run}`.
- Script settings: `SUPABASE_URL`, `SWEEPER_KEY`, `SWEEP_MODE` (dry or apply), `SWEEP_MAX_OBJECTS` (50, at most 999: the listing asks for one more than the cap and the database gives at most 1000 a call),
  `SWEEP_MAX_MIB` (200), `SWEEP_MIN_AGE_HOURS` (24, never less). Exit 0 done, 1 stopped or failed, 2 bad settings.
- Tests: `supabase/tests/sweeper_attack.sql` (CI job db), `tests/unit/sweep-plan.spec.ts` (unit),
  `tests/auth/sweeper.spec.ts` (CI auth-journey with real storage-api), mutation set `day7c` in
  `scripts/db-mutations.py`.
