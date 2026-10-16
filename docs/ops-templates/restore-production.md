# Restoring production from a backup (runbook)

For Haider only, on his own computer, in Supabase **account B** and topstock-ops. **Never in a Claude session**:
Claude never reaches production, its backups or its keys. This page is for a real emergency (data deleted or broken
in production). The quarterly *test* of a backup is a different page: `restore-into-dev.md`.

Written 16 Oct 2026 (Day 7c). Facts checked against Supabase's "Database Backups" guide on that day: daily backups
on Pro (7 days), Team (14) and Enterprise (30) plans, none on Free; Point-in-Time Recovery (PITR) is a paid add-on on
Pro and above that needs at least the Small compute add-on and replaces the daily backups; a restore replaces the
whole project's database in place and the project is offline while it runs; **database backups never include the
files in Storage**.

---

## 0. Which backup can you use?

| Your Supabase plan for topstock-prod | What exists | Go to |
|---|---|---|
| Free (the plan today, go-live decision 5) | Only **our own** nightly backup: topstock-ops > backup-prod, encrypted with your age key, kept 90 days | Part C |
| Pro, no add-on | Supabase's **daily** backups for the last 7 days, plus our own nightly backup | Part A (or C) |
| Pro + PITR add-on | Any **second** in the retention window (7, 14 or 28 days), plus our own nightly backup | Part B (or C) |

Upgrading the plan does not give you backups from before the upgrade. If the problem happened today and you are on
Free, our own backup from last night (Part C) is the only copy.

Pick the **last backup before the problem**. Everything written after that moment (new leads, calls, sales, stock
movements, sign-ups) is lost by the restore, unless you re-enter it afterwards; write down what you know changed.

## 1. Before any restore (all parts)

1. **Tell Henri and Kais** to stop using the CRM until you say so (anything they save during the restore is lost).
2. **Turn off the orphan sweeper**: topstock-ops > **Actions** > **sweep-lead-files** > **...** > **Disable
   workflow** (see "Storage" below for why; `sweep-lead-files.md` "Before any restore into production").
3. **Keep the current state too**, if the database still answers: topstock-ops > **Actions** > **backup-prod** >
   **Run workflow**, and wait for it to go green. That backup is your way back if the restore makes things worse.
4. Write down, on paper or in your password manager (not in a chat): the time you are restoring to, and what you
   know was entered after it.

## Part A. Supabase daily backup (Pro plan)

1. Account B > **topstock-prod** > **Database** > **Backups** > **Scheduled backups**.
2. Find the newest backup **before** the problem, click **Restore**, read the confirmation and confirm.
3. The project is offline until the dashboard says the restore is complete (minutes for a database of this size).
4. Go to step 2 below ("After any restore").

## Part B. Point-in-Time Recovery (Pro + PITR add-on)

1. Account B > **topstock-prod** > **Database** > **Backups** > **Point in Time**.
2. **Start a restore**, pick the date and time just before the problem (the picker shows your time zone; it only
   accepts times between the earliest and latest recovery points), review and confirm.
3. The project is offline until the dashboard says the restore is complete.
4. Go to step 2 below.

## Part C. Our own nightly backup (any plan, the only option on Free)

Our backup (`backup-prod.yml`) holds the schemas `public`, `private`, `auth` (accounts and two-factor secrets) and
`supabase_migrations`; **not** `storage`. Two ways to use it:

- **C1. Restore into a new project, then switch the app to it (recommended).** Nothing in the broken project is
  touched, so you can compare both. Ask Claude for the step-by-step for "restore our backup into a new production
  project" when it happens: it needs the new project made in account B, the migrations run by migrate-prod against
  it, the data loaded, then Vercel's two production variables pointed at the new project. Claude writes the steps;
  you run them.
- **C2. Load it back into topstock-prod.** Same commands as `restore-into-dev.md` steps 1 to 8, with the
  **production** pooler host and user (`postgres.<prod-ref>`) and the production database password, plus the
  `auth` schema. This overwrites production's data; take step 1.3's fresh backup first.

**Role `share_reader` first (Day 6, spike S1).** A restore that recreates the schema (not `--data-only`) writes
`ALTER FUNCTION ... OWNER TO share_reader` for `share_view` and `share_request`. If that role does not exist in the
target database, `pg_restore` stops with `role "share_reader" does not exist`. Before such a restore, run once as
`postgres` on the target:

```sql
do $$ begin
  if not exists (select from pg_roles where rolname = 'share_reader') then
    create role share_reader nologin noinherit;
  end if;
end $$;
grant share_reader to postgres with set true;
```

(The same three lines as the client stock migration, `20261020090000_client_share.sql`. A data-only load into a
database made by our migrations already has the role.) `share_reader` has no password (nologin), so Supabase's
"custom role passwords are not in daily backups" note does not apply to it.

## 2. After any restore

1. **Sign in** to the CRM yourself (password, then the 6-digit code). Open Home, a lead and Inventory.
2. **Row counts**: compare with `row-counts.txt` of the backup you restored (Part C) or with what you expect (A, B).
3. Account B > topstock-prod > **Advisors** > **Security Advisor**: the same warnings as before (go-live part F),
   no new error.
4. **Files (Storage), see below**: open three files from leads, one recent and two older.
5. Run **sweep-lead-files once by hand as a dry run** (Run workflow, leave the confirm box empty) and read "found":
   that is how many stored files have no file entry after the restore. **Do not switch the sweeper back on** while
   that number holds files you want to keep; tell Claude only the number.
6. Tell Henri and Kais they can work again, and what (if anything) they need to re-enter.
7. Tell Claude: "Production restored to <date and time>, part A/B/C, checks 1 to 5 done", plus any step that failed
   (in words). Never send the backup, a key, a password, a connection string or a screenshot of data.

## Storage: the caveat (all parts)

Lead files (PDFs, images, spreadsheets) live in Supabase **Storage** (bucket `lead-files`), outside the database.
No database backup holds them: Supabase's daily backups and PITR hold only Storage's *list* of objects, and our own
backup holds neither the files nor that list (only the CRM's `files` entries). A restore therefore brings the
database back in time, **but the files stay as they are now**:

- **A file deleted after the restore point is gone for good.** The restored CRM still lists it; opening it shows
  "This file can’t be opened". Nothing can bring its bytes back.
- **A file uploaded after the restore point is still stored, but the CRM no longer lists it** (its entry was
  created after the restore point). To the orphan sweeper it looks exactly like stray bytes, and after 24 hours an
  enabled sweeper would **delete it**. That is why step 1.2 turns the sweeper off and step 2.5 counts these files
  before it goes back on. Ask Claude how to re-attach or download them before switching the sweeper on.
- The storage quota counts these files until they are re-attached or removed.

There is no separate backup of Storage today. If lead files become important enough, ask Claude for a "Storage
copy" workflow (a nightly copy of the bucket to a second place); it is not part of Release 1.
