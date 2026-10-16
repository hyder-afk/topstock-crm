# Restore test: a production backup into topstock-dev

For Haider, on his own computer (macOS, Terminal). **Never in a Claude session**: the backup and the private key
never go near Claude, GitHub issues or a cloud VM. About 30 minutes.

**What this proves:** a nightly backup can be opened with your offline key and loads completely (every table has
the same number of rows as production had). Master Plan section 8 row 44 and the Gate 1 row need one real restore
before real data goes in; after that, once a quarter.

**What it does to dev:** it **overwrites the data in topstock-dev** (fake data only) for about 15 minutes, then puts
dev's own fake data back. Only the CRM tables are restored (schemas `public` and `private`). Accounts (`auth`:
emails, password hashes, two-factor secrets) are **not** restored into dev: they stay only in the encrypted backup.

**Important, about real data:** the Supabase dev MCP lets Claude read topstock-dev. The first restore test (go-live
part H) happens **before** the real leads are imported, so production then holds only the empty CRM, the seeded
stages and your own profile. **Do not restore a backup that contains real leads into topstock-dev** until Claude
and you have agreed where later quarterly restore tests go (see "Decisions" in docs/go-live.md).

---

## Before you start

- Go-live parts E, F and G are done: the backup-prod run you will use is green and was made **after** the
  migrate-prod run (so dev and prod have the same migrations).
- Tell Claude: "Restore test on dev starting, please do not merge or use dev for about an hour." (No other detail.)
- Have ready: your password manager (the **topstock-dev** database password and the **TopStock backup private key**),
  and the dev project open in Supabase account A.

## 1. Install the tools (once)

In Terminal:

```bash
brew install age postgresql@17
export PATH="$(brew --prefix postgresql@17)/bin:$PATH"
pg_restore --version
age --version
```

**You should see:** `pg_restore (PostgreSQL) 17.x` and an age version. (`export PATH=...` only lasts for this
Terminal window; run it again if you open a new one.)

## 2. Download the backup into a private folder

1. github.com/hyder-afk/topstock-ops > **Actions** > **backup-prod** > open the green run you want.
2. At the bottom of the run page, under **Artifacts**, click the name (`topstock-prod-<date>`). A zip downloads.
3. In Terminal:

```bash
mkdir -m 700 ~/topstock-restore && cd ~/topstock-restore
unzip ~/Downloads/topstock-prod-*.zip -d .
ls
```

**You should see:** one `topstock-prod-<date>.dump.age` file and `row-counts.txt`.
(If several zips are in Downloads, replace `topstock-prod-*` with the exact name.)

## 3. Decrypt with your private key

1. In your password manager, copy the whole "TopStock backup private key" note (all its lines).
2. In Terminal (the key goes from the clipboard into a file only you can read, is used once, then deleted):

```bash
umask 077
pbpaste > backup-key.txt
age --decrypt --identity backup-key.txt --output prod.dump topstock-prod-*.dump.age
rm backup-key.txt
pbcopy < /dev/null
pg_restore --list prod.dump | head -5
```

**You should see:** a few lines starting with `; Archive created at ...` and `; dbname: postgres`.
If age says "no identity matched", the key is not the one whose public key is in topstock-ops: stop and tell Claude
"restore: key did not match".

## 4. Point Terminal at the DEV database

1. In Supabase **account A**, open **topstock-dev**, click **Connect** (top of the project page), choose
   **Session pooler** and read the host: the part after `@` and before `:5432`
   (it looks like `aws-0-eu-west-3.pooler.supabase.com`; the number can differ).
2. In Terminal (replace the host; the password is typed into a hidden prompt, nothing shows, then press Enter):

```bash
export PGHOST='PASTE-THE-DEV-POOLER-HOST'
export PGPORT=5432
export PGUSER='postgres.swhkafqlmfhvgpsgdqjp'
export PGDATABASE=postgres
export PGSSLMODE=require
read -s PGPASSWORD && export PGPASSWORD
psql -X -A -t -c "select 'connected to dev'"
```

`swhkafqlmfhvgpsgdqjp` is the **dev** project reference: the user name decides which project you reach, and only the
dev password works with it, so these commands cannot touch production.

**You should see:** `connected to dev`.

## 5. Save dev's own fake data first

```bash
COUNTS_SQL="select n.nspname || '.' || c.relname, (xpath('/row/cnt/text()', query_to_xml(format('select count(*) as cnt from %I.%I', n.nspname, c.relname), false, true, '')))[1]::text::bigint from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname in ('public', 'private') and c.relkind in ('r', 'p') order by 1"
psql -X -A -t -F '|' -v ON_ERROR_STOP=1 -c "$COUNTS_SQL" > dev-counts-before.txt
pg_dump --format=custom --data-only --schema=public --schema=private --file=dev-before.dump
ls -l dev-before.dump dev-counts-before.txt
```

**You should see:** both files listed, `dev-before.dump` larger than 0 bytes.

## 6. Empty the CRM tables on dev

This deletes dev's (fake) CRM rows. Step 5 saved them; step 9 puts them back.

```bash
EMPTY_SQL="do \$\$ declare t text; begin select string_agg(format('%I.%I', schemaname, tablename), ', ') into t from pg_tables where schemaname in ('public', 'private'); if t is not null then execute 'truncate table ' || t || ' restart identity cascade'; end if; end \$\$;"
psql -X -v ON_ERROR_STOP=1 -c "$EMPTY_SQL"
```

**You should see:** `DO`.

## 7. Load the production backup's CRM data

This loads **data only** into tables our migrations made, so the roles `share_reader` (Day 6, owner of the two client
stock functions) and `security_digest_reader` (the security digest's reader) already exist on dev. A restore that
recreates the schema instead (a new project, or `pg_restore` without `--data-only`) must create those roles first, or
it stops with `role "share_reader" does not exist`: see `restore-production.md`, Part C.

```bash
pg_restore --data-only --schema=public --schema=private --file=prod-data.sql prod.dump
psql -X -q -o /dev/null -v ON_ERROR_STOP=1 --single-transaction \
  -c 'SET session_replication_role = replica' -f prod-data.sql
```

`session_replication_role = replica` switches off triggers while loading (Supabase's own restore guide does the
same), so the audit triggers do not fire and the profiles load without their accounts. Everything loads in one
transaction: if anything fails, nothing is loaded.

**You should see:** no `ERROR` lines. If you see one, copy only its first line (it names a table or a setting,
not data), go straight to step 9 to put dev back, and tell Claude that line.

## 8. Check the row counts (done when they match)

```bash
psql -X -A -t -F '|' -v ON_ERROR_STOP=1 -c "$COUNTS_SQL" > dev-after-restore.txt
diff row-counts.txt dev-after-restore.txt && echo "ROW COUNTS MATCH"
```

**Done when:** Terminal prints `ROW COUNTS MATCH`.
If `diff` prints lines instead, the table names on those lines (not the numbers) are what to tell Claude.
(Rare: if the backup run's summary said counts changed while it ran, use a quiet night's backup instead.)

## 9. Put dev back as it was

```bash
psql -X -v ON_ERROR_STOP=1 -c "$EMPTY_SQL"
pg_restore --data-only --schema=public --schema=private --file=dev-before.sql dev-before.dump
psql -X -q -o /dev/null -v ON_ERROR_STOP=1 --single-transaction \
  -c 'SET session_replication_role = replica' -f dev-before.sql
psql -X -A -t -F '|' -v ON_ERROR_STOP=1 -c "$COUNTS_SQL" > dev-counts-after.txt
diff dev-counts-before.txt dev-counts-after.txt && echo "DEV IS BACK"
```

**You should see:** `DEV IS BACK`. Sign in to the dev preview once to check it looks as before.

## 10. Clean up

```bash
cd ~ && rm -rf ~/topstock-restore
rm -f ~/Downloads/topstock-prod-*.zip
```

Then close the Terminal window (this forgets the dev password you typed).

## 11. Tell Claude

"Restore test done, row counts matched, dev is back" (or which step did not match, in words). Never send the
key, the password, the files or any screenshot of data.

---

Commands checked against: PostgreSQL 17 manual (pg_dump, pg_restore: `--data-only`, `-n/--schema` repeatable,
`--file` writes a script; psql `--single-transaction` with `-c` and `-f`), Supabase "Backup and restore using the
CLI" guide (`SET session_replication_role = replica` for data loads), Supabase "Connecting to Postgres"
(session pooler: IPv4, port 5432, user `postgres.<project-ref>`, host copied from the Connect dialog), age README
(`age --decrypt --identity`).
