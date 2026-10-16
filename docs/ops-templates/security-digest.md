# Runbook: the daily security digest (topstock-ops)

For Haider. Written 16 Oct 2026 (Master Plan section 8 item 43, "No security monitoring"; planned for Day 7c). The
workflow is `docs/ops-templates/security-digest.yml`, the database part
`supabase/migrations/20261023090000_security_digest.sql`, the tests `supabase/tests/digest_attack.sql`.
You set it up in go-live part I3.3, from 31 Oct, after part I2.

## What it is, in plain words

Once a day, at 09:13 UTC, a small job in **topstock-ops** (your private repository that Claude never reaches) does
two things:

1. It asks GitHub whether last night's **backup-prod**, today's **keep-alive** and **sweep-lead-files** worked.
2. It asks the production database for **counts** of security events in the last 25 hours: sign-ins, two-factor codes
   that were never finished, password-reset emails, new accounts, accounts without an authenticator app, role changes,
   removed accounts, deletes, files opened, imports, the client sharing switch.

It compares each count with a limit. **Only counts** come back: never a name, an email, an IP address, a lead or a file
name. To find out *who* did something, you ask the team first; if nobody knows, Claude gives you a read-only query
for account B's SQL editor that shows who and when, for your eyes only (never paste its answer back).

## How you hear about it (the "email")

- **Green run:** everything is within its limits. GitHub sends nothing. The run page has a summary if you want to read
  it.
- **Red run:** at least one line is over its limit, or one of the other workflows did not work, or the database could
  not be read. GitHub then **emails you** "Run failed: security-digest", like it does for a failed backup. The email
  links to the run; the run's summary lists each line that is over, in plain words.

**Red means "look", not "attack".** Many reds are you: an import you ran, an invitation you sent, a role you changed.
Then there is nothing to do. The limits are set low on purpose, because the team is three people.

For the email to reach you, two things must be true (go-live I3.3 step 1 checks them):
- github.com > your avatar > **Settings** > **Notifications** > **Actions** (it may sit under **System**):
  notifications on, with **Email** ticked (and, if you like, "Only notify for failed workflows").
- You are the one who pasted the workflow. GitHub emails about a scheduled run the person who last changed its
  schedule line. If someone else ever edits that line, the emails go to them instead.

**If the digest itself stops running** (for example someone disables it), nothing turns red. Once a week, glance at
topstock-ops > **Actions** > **security-digest**: the newest run should be from today or yesterday.

## What it checks, and the limits

The limits sit at the top of the workflow file (`LIMITS`). "Limit 0" means any single one turns the run red.

| Line in the summary | Where it comes from | Limit | Why |
|---|---|---|---|
| Codes asked for, never entered right | Supabase Auth's two-factor challenges, older than 15 minutes, never verified | 3 | Someone got the password right but not the 6-digit code: a wrong code, or the screen closed at the code step |
| Password accepted, code never finished | Supabase Auth sessions still at the "password only" level after 15 minutes | 3 | Same signal from the other side |
| Most sign-ins by one person | CRM audit log (one row per finished sign-in, since Day 7a) | 20 | Far more than anyone needs in a day; a script with a stolen password and code would show here |
| Password-reset emails sent | Supabase Auth accounts | 0 | On a team of three, a reset nobody asked for means someone is trying |
| New accounts | Supabase Auth accounts | 0 | Sign-ups are closed; only you create accounts (part K) |
| Accounts without a working authenticator app | Supabase Auth accounts and their two-factor apps | 0 | Everyone must have two-factor; a new person shows here until they set it up |
| Authenticator apps added | Supabase Auth two-factor apps | 0 | A new app on an existing account can mean someone took the account over |
| Role changes | CRM audit log (Team screen, `set_user_role`) | 0 | Admin rights are the keys to everything |
| Accounts removed | CRM audit log (a removed account takes its profile with it) | 0 | Nobody should disappear unnoticed |
| Leads deleted | CRM audit log (an import undo is counted apart) | 10 | Bulk deletion |
| Files deleted | CRM audit log | 20 | Bulk deletion |
| Records deleted (all kinds) | CRM audit log (a lead takes its contacts, notes and tasks with it) | 300 | Bulk deletion of anything |
| Most files opened by one person | CRM audit log (every file opened or downloaded) | 100 | Someone copying the files out |
| Imports committed | CRM audit log (lead or stock import) | 0 | Imports change thousands of rows at once |
| Imports undone | CRM audit log | 0 | Same |
| Client sharing switched on or off | CRM audit log (Inventory settings) | 0 | On, it lets clients see stock through links |
| Audit entries of a kind this digest does not know | CRM audit log | 0 | A new kind of action exists (for example an export, later): Claude adds it to the digest |
| backup-prod, keep-alive, sweep-lead-files | GitHub: each one's newest finished run | must be green and less than 26 hours old, workflow enabled | A silent backup failure is the worst kind |

Also shown, with no limit (for reading): sign-ins finished, people who signed in, "Confirm it's you" codes, passwords
accepted, accounts and admins in total, files opened, leads removed by an import undo, stock adjustments, client links
created, audit log entries, orphan sweeper runs.

## What it cannot see

- **Wrong passwords.** Supabase Auth does not write a wrong password (or a wrong code) into the database at all; it
  only appears in account B's logs (topstock-prod > **Logs** > **Auth**, look for "Invalid login credentials"). The
  digest still sees the dangerous case: a right password with no right code (the first two lines). Supabase's own limit
  (30 sign-in tries per 5 minutes per address, part D4) slows guessing down, and two-factor stops it. If you want to
  look: when a run is red on the first two lines, open that page the same day (Free plan logs are kept only a short
  time). Supabase's database copy of its auth log is off on our projects (dev has never written a row); turning it on
  would store IP addresses and emails, which your Day 7a decision ("who and when, no IP") left out.
- **Exports.** Release 1 has none (the stock CSV export moved to Release 2). When an export is added, its audit entries
  turn the run red ("a kind this digest does not know") until Claude adds the line.
- **Vercel's logs and Firewall.** They stay where they are (Vercel > the project > **Logs** and **Firewall**). The B3
  Firewall rule's count is read by hand, as part B3 says.
- **Who.** By design. The summary never names anyone.

---

## Set-up (go-live part I3.3, from 31 Oct)

Before: part E ran at a commit that has the migration `20261023090000_security_digest` (Claude confirms this in
"Go-live part A again"), and parts G, I and I2 are done (the digest checks their workflows). No new secret: it uses
`PROD_PROJECT_REF`, `PROD_DB_PASSWORD` and `PROD_DB_POOLER_HOST`, which exist since part C.

### Step 1. Check that GitHub will email you
1. github.com > your avatar > **Settings** > **Notifications**.
2. Find **Actions** (under **System**). Make sure notifications are on and **Email** is ticked. Ticking "Only notify
   for failed workflows" is fine (recommended: fewer emails).
3. Check the email address at the top of that page is one you read.

### Step 2. Paste the workflow
1. In topstock-crm on github.com, open `docs/ops-templates/security-digest.yml` > **Copy raw file**.
2. In topstock-ops: **Add file** > **Create new file**, name `.github/workflows/security-digest.yml`, paste,
   **Commit changes** > directly to `main`.

### Step 3. First run by hand
1. topstock-ops > **Actions** > **security-digest** > **Run workflow** > **Run workflow**.
2. Open the run when it finishes (under a minute).

**What you should see:** a green tick. The summary says "security-digest: green, nothing over its limit", then the
counts (on a new production project mostly 0, with your own sign-ins), then the three other workflows, each "success"
and less than 26 hours old.

If it is red on its first run, read the lines: "has not finished a run in the last 26 hours" just after setting up a
workflow means that workflow has not run yet (run it once by hand, then this one again). "Could not read the security
counts" means the migration is not in production yet: tell Claude.

**Done when:** a manual run is green. Tell Claude "Part I3.3 done, green".

---

## When it is red

Open the run (the link in GitHub's email), read the red lines in the summary, and find each one here.

| Red line | What it means | What to do |
|---|---|---|
| Codes asked for, never entered right / Password accepted, code never finished | Someone typed a right password and then did not finish the 6-digit code | Ask Henri and Kais whether they had trouble signing in. If nobody did: that password is known to someone else. Have that person change it (Forgot password), and look at account B > Logs > Auth the same day. Tell Claude the counts |
| Most sign-ins by one person | One person finished an unusual number of sign-ins | Ask the team. If nobody knows: tell Claude the count (Claude gives you the read-only query above). If it was not that person: change their password, press **Sign out of all devices**, tell Claude |
| Password-reset emails sent | A reset email went out | If you or a teammate asked for it, nothing. If not: someone typed that address on the Forgot password page. The link only reaches the real inbox, so it is safe, but mention it to the person |
| New accounts | An account was created | If it was you (part K), nothing. If not: account B > **Authentication** > **Users**, delete it, and tell Claude right away (sign-ups should be closed, part D1) |
| Accounts without a working authenticator app | Someone has no two-factor | Right after part K this is expected until they finish set-up. Otherwise tell Claude |
| Authenticator apps added | A two-factor app was added to an account | Expected when someone sets up a new phone. If nobody did: treat the account as taken over (password change, Sign out of all devices, tell Claude) |
| Role changes / Accounts removed | Admin rights or accounts changed | If it was you, nothing. If not: More > Team shows the roles now; tell Claude right away |
| Leads deleted / Files deleted / Records deleted | More deletes than usual in a day | Ask the team. If nobody knows: tell Claude (the audit log keeps what was deleted; a restore is possible, see restore-production.md) |
| Most files opened by one person | Someone opened or downloaded many files | Ask the team. If nobody knows: as for a taken-over account (password, Sign out of all devices, tell Claude) |
| Imports committed / Imports undone | A lead or stock import ran or was undone | If it was you, nothing |
| Client sharing switched on or off | Someone changed the client stock link switch | If it was you, nothing. If not: Inventory settings, switch it back, tell Claude |
| Audit entries of a kind this digest does not know | The CRM records a new kind of action the digest does not count yet | Tell Claude: "digest: unknown audit kind". Claude updates the digest; nothing is wrong with the data |
| ... did not succeed / has not finished a run in the last 26 hours / is not enabled | backup-prod, keep-alive or sweep-lead-files is red, late or switched off | Open that workflow's latest run and follow its own runbook (a red backup matters most; run it again by hand) |
| Could not read the security counts | The job could not reach production or the digest function | Check that topstock-prod is not Paused (account B). If it is running: tell Claude the warning's first words (never the whole log) |
| A database secret is missing | One of the three secrets was deleted or renamed | Add it again as in go-live part C5 |
| The database's digest is version ..., or "sent no value for ..." | The workflow file and the database are from different versions | Ask Claude for the matching template and paste it again |

### Changing a limit
Only after talking to Claude. Edit the number in the `LIMITS` lines of `.github/workflows/security-digest.yml` in
topstock-ops and commit to `main`. Do not change the `cron:` line unless you mean to (whoever changes it receives the
emails from then on).

### Turning it off
topstock-ops > **Actions** > **security-digest** > the **...** menu > **Disable workflow**. Enable it the same way.

### Before any restore into production
Nothing to switch off: the digest only reads. A restore that recreates the schema needs the role
`security_digest_reader` first, like `share_reader` (restore-production.md, part C).

## What to tell Claude (and what never)
- Fine: "green" or "red", the red lines exactly as the summary words them (they hold counts only), a workflow's result.
- Never: the run log of the database step beyond its first words, the project reference, names of people involved,
  screenshots of account B or of the CRM's audit.

---

## For Claude (reference)

- **Database:** `private.security_digest(p_since timestamptz) returns table (metric text, value bigint)`, SECURITY
  DEFINER, STABLE, `search_path = ''`, static SQL, owned by postgres; window 1 hour to 8 days (22023 hint `bounds`).
  Execute granted only to the role `security_digest_reader` (NOLOGIN NOINHERIT, usage on schema `private`, nothing
  else; `grant ... to postgres with set true`). Revoked from public, anon, authenticated, service_role. Schema `private`
  is not exposed by the Data API.
- **Why postgres plus SET ROLE, not a login role:** postgres is the least privilege that already exists in
  topstock-ops for the database (the sweeper's secret key maps to service_role over REST, which cannot reach schema
  `private`). backup-prod reads the same password from the same repository, so whoever can edit a workflow there has it
  anyway: the digest adds no exposure. The READ ONLY transaction and `SET LOCAL ROLE security_digest_reader` keep the
  workflow's own SQL from writing or reading rows (a guard against mistakes). They are not a boundary against a person
  who controls the workflow: Postgres checks SET ROLE against the session user (postgres), so that session could
  `RESET ROLE` (proved in `digest_attack.sql` B; the READ ONLY layer still refuses writes after it).
  **Stricter option (open question for Haider):** give the role a login of its own (`alter role security_digest_reader
  login password ...`, typed by Haider in account B), store it as a new secret, and set `PGUSER` to
  `security_digest_reader.<project-ref>`; the session then cannot become anything else. It costs one more secret to
  rotate and a password typed into account B's SQL editor, and it would protect against a stolen copy of that one
  secret only, since the repository holds the postgres password anyway. Recommended: not now.
- **Metrics (digest.version 1, 31 rows, in this order):** `digest.version`, `digest.window_minutes`;
  `signin.completed`, `signin.people`, `signin.most_by_one_person`, `signin.step_up_codes`, `signin.passwords_accepted`,
  `signin.password_ok_no_code`, `signin.codes_not_finished`, `signin.reset_emails`; `accounts.users`, `accounts.new`,
  `accounts.without_two_factor`, `accounts.authenticators_added`, `accounts.admins`, `accounts.role_changes`,
  `accounts.people_removed`; `data.leads_deleted`, `data.files_deleted`, `data.rows_deleted`, `data.file_opens`,
  `data.file_opens_most_by_one_person`, `data.imports_done`, `data.imports_undone`, `data.import_undo_leads_removed`,
  `data.stock_adjustments`, `data.sharing_switch_changes`, `data.share_links_created`; `audit.rows`,
  `audit.unknown_actions`, `ops.file_sweeps`. Adding or renaming one means `digest.version` 2 and a new template.
- **Sources:** `public.audit_log` (actions insert, update, delete, role_change, file_access, sign_in, mfa_verify,
  file_sweep; anything else is `audit.unknown_actions`); `auth.sessions` (`aal`), `auth.mfa_challenges`
  (`verified_at`), `auth.mfa_factors` (`status`), `auth.users` (`created_at`, `recovery_sent_at`, `deleted_at`),
  `public.profiles` (`role`). Settle time 15 minutes for sessions and challenges.
- **Failed sign-ins, verified 16 Oct 2026:** Supabase Auth (`/supabase/auth`, Context7: `internal/api/token.go`
  ResourceOwnerPasswordGrant returns `invalid_credentials` before `NewAuditLogEntry`; `internal/api/mfa.go`
  verifyTOTPFactor returns `mfa_verification_failed` before it) writes no audit entry for a wrong password or code.
  Supabase's Auth audit log guide: entries go to `auth.audit_log_entries` only when "write to the database" is on; dev
  has 0 rows ever (read-only MCP, 16 Oct 2026), so it is off. The password and MFA verification attempt hooks, which
  could record failures, are paid-plan features (Supabase Auth Hooks guide: Teams and Enterprise only).
  `auth.mfa_challenges` keeps rows for days on dev (oldest 9 Oct on 16 Oct), so a 25-hour window sees them.
- **Thresholds and summary:** in the workflow (`LIMITS`, labels); the job fails (red) on any line over its limit,
  any workflow check, a missing secret, an unreadable database, a version mismatch or a missing metric.
- **Tests:** `supabase/tests/digest_attack.sql` (CI job `rls` in `.github/workflows/db.yml`, local
  `scripts/db-test.sh`); `supabase/tests/gate1_attack.sql` G4 lists the function. The local auth stand-ins for
  `auth.sessions`, `auth.mfa_factors`, `auth.mfa_challenges` and the two `auth.users` columns are in
  `supabase/tests/shim.sql`.
- **Not from Context7 (builder's knowledge, to be confirmed on first use):** GitHub's menu names for notification
  settings; that `psql` is on GitHub's ubuntu-latest image (the workflow installs `postgresql-client` if it is not);
  that `GITHUB_TOKEN` with `actions: read` alone reads the workflows and runs of a private repository (the REST pages say
  "Actions: read" for both endpoints); that Supavisor's session pooler keeps `SET LOCAL ROLE` within the transaction
  (session mode keeps one server connection for the client session).
