# Day 8 go-live: Haider's checklist

Written 12 Oct 2026 by the builder. Master Plan section 9 Day 8, section 8 row 44, section 12 (Gate 1, "Backups
and keep-alive"); Cloud Workflow sections 4 to 7; docs/day0-setup.md ("Later visits").

**How to use this:** do one part at a time, in order. After each part, tell Claude only "Part X done" (or what did
not match, in words). Claude never touches production: `topstock-prod` lives in Supabase **account B**, which has no
access token, ever; its secrets live only in the private repository **topstock-ops**, which Claude is never attached
to. So every production step below is yours, in your own browser or Terminal.

**Never paste into Claude:** passwords, keys, tokens, the backup private key, connection strings, anything copied
from account B, lead or stock rows, the CSV or stock files, or screenshots that show data.

**Have ready:** your password manager, your phone with the authenticator app, a private browser window for account
B (the ops@ login), and about 3 hours in total (parts J and K can be another day).

---

## Decisions for you (answer Claude in one line each; recommendation in bold)

1. **Production web address.** The Site URL in part D. **Keep `https://topstock-crm.vercel.app` for now**; a custom
   domain (for example crm.topstockwholesale.com) can come later and changes part D's two URLs.
2. **Email sender for production.** Supabase's built-in sender (what dev uses today) only delivers to members of
   account B's Supabase team, at most 2 emails an hour, and refuses the app's own bilingual email templates. So
   with it, **invitations and password-reset emails cannot reach Henri and Kais**. Options:
   (a) **set up a custom SMTP sender on topstockwholesale.com before part K** (an email-sending service; may cost
   money; Claude writes the steps when you choose a provider); or
   (b) go live with the built-in sender and create Henri's and Kais's accounts by hand with a temporary password
   you give them in person (part K, route 2). Password reset by email stays unavailable until (a).
3. **Henri and Kais as admins.** The database makes only the first account an admin; later accounts start as reps.
   You change their role yourself in the app: **More > Team** (admins only; it asks for a code from your
   authenticator app when the last one is older than 10 minutes). Claude confirms in part A that this screen is merged
   and live. Never change roles with SQL in the production dashboard.
4. **Vercel Pro** (money) and **Deployment Protection: keep Standard Protection** (part B).
5. **Leaked password protection** (Supabase rejects passwords known from breaches) exists only on Supabase's paid
   plan. **Stay on Free for now** (the setting stays off; passwords are 12+ characters with mixed types plus
   two-factor) unless you want to pay for Supabase Pro, which also removes the need for keep-alive.
6. **Backup storage.** Backups are kept 90 days. GitHub's free plan includes limited artifact storage for private
   repositories (500 MB on GitHub Free). After the first backup (part G), tell Claude its size in MB; if 90 copies
   do not fit, **keep 30 days plus your monthly download**, or pay GitHub for storage.
7. **Later restore tests.** The first restore test (part H) runs before any real data exists. After the real import,
   restoring a backup into dev would put real leads where Claude's dev access can read them. **Decide with Claude
   before the first quarterly test (January 2027)**; the builder's recommendation is a separate restore-test project
   in account B.
8. **Keep-alive once a day** (not every 3 days): Supabase says a few database requests each day keeps a Free
   project awake. It is free.

---

## Part A. Prerequisites gate (Claude confirms; you only read)

Why: production gets real data, so the Day 7 security gate must be passed first.

1. In Claude Code, write: **"Go-live part A: please confirm."**
2. Claude replies with a REPORT that states, with evidence:
   - Day 7 security gate 1 passed: Master Plan section 8 A to F, the two-user attack test, `/security-review`,
     Supabase Security Advisor on dev with no ERROR;
   - the `advisor` subagent's verdict on Day 7 and on this go-live kit: **APPROVED** (quoted);
   - CI green on `main`, and the **go-live commit SHA** (40 characters) you will deploy in part E;
   - the lead import page and the stock sheet import page are live, and where they are in the app;
   - how Henri and Kais will be invited (decision 2), and that **More > Team** is live in that commit, so you can make
     them admins in part K (decision 3).

**What you should see:** one REPORT with "APPROVED" in the advisor line and one commit SHA.
**Done when:** Claude says "Part A: passed" and you have written the SHA down (it is not secret).

---

## Part B. Vercel Pro and Deployment Protection

Why: Vercel's free Hobby plan is for non-commercial use only; a business app needs Pro.

1. Go to vercel.com and sign in.
2. Open your account or team settings (the menu at the top left), then **Billing**, and choose the upgrade to
   **Pro**. Vercel shows the price before you confirm. If Vercel asks to move the project to a new Pro team,
   accept and keep the project's GitHub connection.
3. Open the project **topstock-crm** > **Settings** > **Deployment Protection**.
4. Under Vercel Authentication, keep **Standard Protection** (decided 9 Oct 2026, revisited now): previews stay
   behind your Vercel login; the production address stays public so Henri and Kais can reach the login page. Do
   not choose a setting that protects all deployments: it would lock Henri and Kais out unless they had paid Vercel
   seats.
5. Do not add team members to Vercel (each one costs a seat; they only need the app).

**What you should see:** Billing shows Pro; Deployment Protection shows Standard Protection.
**Done when:** both are true. Tell Claude "Part B done".

---

## Part C. Private repository topstock-ops with its secrets and the migration workflow

Why: production secrets must live where Claude can never reach them. Workflows in topstock-crm run on
Claude-written branches, so nothing about production goes there.

### C1. Create the repository
1. github.com > the **+** at the top right > **New repository**.
2. Owner `hyder-afk`, name `topstock-ops`, **Private**, tick **Add a README file**. **Create repository**.

### C2. Keep Claude and Vercel off it
1. github.com > your avatar > **Settings** > **Applications** > **Installed GitHub Apps**.
2. Next to **Claude**, click **Configure**. Under Repository access it must say **Only select repositories** with
   `topstock-crm` only. If it says "All repositories", switch to **Only select repositories**, choose `topstock-crm`,
   **Save**.
3. Do the same check for **Vercel**: only `topstock-crm`.

**What you should see:** neither app lists `topstock-ops`.

### C3. Check the repository's default token is read-only
1. topstock-ops > **Settings** > **Actions** > **General**.
2. Under **Workflow permissions**, choose **Read repository contents and packages permissions**. **Save**.

### C4. Create the read-only token for topstock-crm
1. github.com > avatar > **Settings** > **Developer settings** > **Personal access tokens** >
   **Fine-grained tokens** > **Generate new token**.
2. Name `topstock-ops reads topstock-crm`. Expiration: **1 year** (put a reminder in your calendar 2 weeks before).
   Resource owner `hyder-afk`.
3. Repository access: **Only select repositories** > `topstock-crm`.
4. Permissions > Repository permissions > **Contents: Read-only**. (Metadata: Read-only is added by itself.)
   Nothing else.
5. **Generate token**. Copy it once (next step); do not save it anywhere else.

### C5. Add the secrets
topstock-ops > **Settings** > **Secrets and variables** > **Actions** > **New repository secret**, once per line.
Values come from account B (private window, ops@ login, project `topstock-prod`) and your password manager:

| Secret name | Value | Where to find it |
|---|---|---|
| `TOPSTOCK_CRM_READ_TOKEN` | the token from C4 | just copied |
| `PROD_PROJECT_REF` | the 20-letter project reference | account B, topstock-prod: in the address bar after `/project/` |
| `PROD_DB_PASSWORD` | the database password | password manager: "Supabase topstock-prod DB password" (Day 0) |
| `PROD_DB_POOLER_HOST` | the session pooler host only | topstock-prod > **Connect** (top of the project page) > **Session pooler**: the part after `@` and before `:5432`, like `aws-0-eu-west-3.pooler.supabase.com` |
| `PROD_PUBLISHABLE_KEY` | the publishable key (or legacy **anon public** key) | topstock-prod > Project Settings > **API Keys**. Never the secret / service_role key |

The sixth secret, `AGE_PUBLIC_KEY`, is added in part G.

### C6. Paste the migration workflow
1. In topstock-crm on github.com, open `docs/ops-templates/migrate-prod.yml` and click the **Copy raw file** button.
2. In topstock-ops: **Add file** > **Create new file**. Name: `.github/workflows/migrate-prod.yml` (typing the
   slashes creates the folders). Paste. **Commit changes** > commit directly to `main`.

(The backup and keep-alive workflows are pasted in parts G and I, so they do not run, and fail, before the
database and the backup key exist.)

**What you should see:** topstock-ops > **Actions** lists **migrate-prod**; Settings > Secrets lists 5 secrets
(values are never shown again).
**Done when:** both are true. Tell Claude "Part C done".

---

## Part D. Production auth settings, by hand in account B

Why: account B has no access token, so the settings that `supabase/config.toml` pushes to dev must be typed into
the production dashboard. Do this **before** part E: the database makes the first account an admin, so sign-ups
must be closed before the schema exists.

Private window, account B, project **topstock-prod**. Menu names are those of October 2026; if a name differs,
look for the setting itself.

### D1. Authentication > Sign In / Providers
| Setting | Value | config.toml |
|---|---|---|
| Allow new users to sign up | **OFF** (invite-only) | `[auth] enable_signup = false` |
| Allow anonymous sign-ins | **OFF** | `enable_anonymous_sign_ins = false` |
| Allow manual linking | **OFF** | `enable_manual_linking = false` |
| Confirm email | **ON** | `[auth.email] enable_confirmations = true` |
| Email provider (in the provider list) | **Enabled** (needed for email + password sign-in) | `[auth.email] enable_signup = true` |
| Inside Email: Secure email change | **ON** | `double_confirm_changes = true` |
| Inside Email: Secure password change | **ON** | `secure_password_change = true` |
| Inside Email: Minimum password length | **12** | `minimum_password_length = 12` |
| Inside Email: Password requirements | **Lowercase, uppercase, digits and symbols** | `password_requirements = "lower_upper_letters_digits_symbols"` |
| Inside Email: Email OTP length | **6** | `otp_length = 6` |
| Inside Email: Email OTP expiration | **3600** seconds | `otp_expiry = 3600` |
| Inside Email: leaked password protection | off (paid plan only; decision 5) | not in config.toml |
| Phone provider | **Disabled** | `[auth.sms] enable_signup = false` |
| Every other provider (Apple, Google...) | **Disabled** | `[auth.external.*] enabled = false` |

If you see a setting for the minimum time between emails to the same address, set **60 seconds**
(`max_frequency = "60s"`).

### D2. Authentication > Multi-Factor (MFA)
| Setting | Value | config.toml |
|---|---|---|
| TOTP (App Authenticator) | **Enabled** (enrol and verify) | `[auth.mfa.totp] enroll_enabled = true`, `verify_enabled = true` |
| Phone MFA | **Disabled** | `[auth.mfa.phone]` false |
| Maximum enrolled factors per user | **10** | `max_enrolled_factors = 10` |

### D3. Authentication > URL Configuration
| Setting | Value | config.toml |
|---|---|---|
| Site URL | **`https://topstock-crm.vercel.app`** (or your custom domain, decision 1) | `site_url` |
| Redirect URLs | **only `https://topstock-crm.vercel.app/**`** (same domain as the Site URL) | `additional_redirect_urls` |

Do **not** add `localhost` or the `topstock-crm-*` preview addresses that dev has: previews talk to dev, never to
production.

### D4. Authentication > Rate Limits (check, change only if different)
| Setting | Value | config.toml |
|---|---|---|
| Sign-ups and sign-ins | **30** per 5 minutes per IP | `sign_in_sign_ups = 30` |
| Token refreshes | **150** per 5 minutes per IP | `token_refresh = 150` |
| Token verifications | **30** per 5 minutes per IP | `token_verifications = 30` |
| Emails sent | **10** per hour (only applies with a custom SMTP sender) | `email_sent = 10` |

### D5. Authentication > Emails
Leave the sender **as today** (Supabase's built-in sender) and the templates as they are, unless you chose decision
2 (a); then Claude gives separate steps for the SMTP sender, the app's invite and reset templates
(`supabase/templates/`) and the three security notices (password changed, two-factor added, two-factor removed).

### D6. Sessions and tokens (defaults, check only)
Access token (JWT) expiry **3600** seconds; refresh token rotation **ON** with reuse interval **10** seconds
(`jwt_expiry`, `enable_refresh_token_rotation`, `refresh_token_reuse_interval`). These are Supabase's defaults: only
change them if they show other values.

### D7. Project Settings > Data API (exposed schemas)
| Setting | Value | config.toml |
|---|---|---|
| Exposed schemas | **`public` only**: remove `graphql_public` if it is listed | `[api] schemas = ["public"]` |
| Extra search path | `public, extensions` (default) | `extra_search_path` |
| Max rows | **1000** (default) | `max_rows = 1000` |

Save each screen.

**What you should see:** each value above, saved without an error.
**Done when:** every row matches. Part E then proves the two most important ones (sign-ups closed, only `public`
exposed) and stops if either is wrong. Tell Claude "Part D done" (plus any setting you could not find, by name).

---

## Part E. Apply the database to production, then check the Security Advisor

Why: this creates the CRM's tables, security rules and functions in production, from the reviewed code on main.

1. topstock-ops > **Actions** > **migrate-prod** (left list) > **Run workflow** (right side).
2. Branch: `main`. **commit_sha**: paste the SHA from part A. **confirm**: type `MIGRATE`. Click **Run workflow**.
3. Click the run that appears and wait (about 3 to 5 minutes).

**What you should see:** a green tick. The run summary lists the commit, the migration files and five lines:
sign-ups closed: yes; REST API exposes only public: yes; migrations recorded; row level security on for all
tables, each with a policy; advisors: no ERROR.
If it is red, open the red step: its message says what to fix (usually a part D setting). Nothing is applied when
a check before "Apply migrations" fails. Run it again after fixing.

4. Account B, topstock-prod > **Advisors** (left menu) > **Security Advisor**. Refresh or re-run it if it offers.

**What you should see:** **no Errors**. Two warnings are known and accepted: `set_user_role` is a SECURITY DEFINER
function (accepted Day 1: it checks admin plus a fresh two-factor code), and leaked password protection is off
(decision 5). Anything else: tell Claude its title only.

**Done when:** the run is green and the Security Advisor shows no Error. Tell Claude "Part E done".

---

## Part F. Point the production app at production, sign in, enrol two-factor

Why: until now the production address used the dev database (decided 9 Oct 2026). Do this right after part E.

### F1. Vercel production variables
1. vercel.com > project **topstock-crm** > **Settings** > **Environment Variables**.
2. Find `NEXT_PUBLIC_SUPABASE_URL` (today it holds the dev address for all environments). Edit it and untick
   **Production** (keep Preview and Development). Save.
3. **Add** a new variable: name `NEXT_PUBLIC_SUPABASE_URL`, value `https://<prod project reference>.supabase.co`,
   environment **Production only**. Save.
4. Do the same for `NEXT_PUBLIC_SUPABASE_ANON_KEY`: untick Production on the dev one, then add a Production-only one
   with the **prod publishable (or anon public) key**.
5. Never add a secret / service_role key, the database password or any other production value to Vercel.

**What you should see:** each name twice: one for Preview + Development (dev values), one for Production.

### F2. Redeploy
1. **Deployments** tab > the latest deployment marked **Production** > the **...** menu > **Redeploy**. If asked,
   do not reuse the build cache. Confirm.
2. Wait until it says **Ready**.

### F3. Create the first account (it becomes the admin)
Sign-ups are closed and the built-in sender cannot email you, so create the account in the dashboard:
1. Account B, topstock-prod > **Authentication** > **Users** > **Add user** > **Create new user**.
2. Email: your own (contact@topstockwholesale.com). Password: generate a new one in your password manager, 16+
   characters with upper and lower case, digits and symbols, **different from your dev password**. Tick
   **Auto Confirm User**. Create.

**What you should see:** exactly one user in the list.

### F4. Sign in and enrol two-factor
1. Open `https://topstock-crm.vercel.app` (normal window) and sign in with that email and password.
2. The app asks you to set up two-factor: scan the QR code with your authenticator app, enter the 6-digit code.
3. You land on Home ("Hello" / "Bonjour"). If it asks for your name, add it.
4. Open the lead import page (where Claude said in part A): it opens for you because you are the admin.

Because your production password differs from dev, a successful sign-in also proves the app now talks to
production.

**Done when:** you are signed in on production with two-factor, and the import page opens. Tell Claude "Part F done".

---

## Part G. Backups

Why: nightly encrypted copies of the production database, which only your offline key can open.

### G1. Make the backup key pair on your Mac (Terminal)
```bash
brew install age
mkdir -m 700 ~/topstock-key && cd ~/topstock-key
age-keygen -o topstock-backup-key.txt
cat topstock-backup-key.txt
```
**You should see:** `Public key: age1...` and then three lines: two starting with `#` and one starting with
`AGE-SECRET-KEY-1`.

1. In your password manager, create a secure note **"TopStock backup private key (age)"** and paste **all three
   lines** of the file. This private key never goes to GitHub, Vercel, Supabase, email or Claude.
2. Keep a second offline copy (for example printed, in a safe). Without this key the backups cannot be opened.
3. Copy the **public key** only (the `age1...` value after "Public key:").
4. Delete the file: `cd ~ && rm -rf ~/topstock-key`

### G2. Add the public key and the workflow
1. topstock-ops > **Settings** > **Secrets and variables** > **Actions** > **New repository secret**: name
   `AGE_PUBLIC_KEY`, value the `age1...` public key.
2. Paste `docs/ops-templates/backup-prod.yml` from topstock-crm into topstock-ops as
   `.github/workflows/backup-prod.yml` (as in C6).

### G3. Run it once by hand
1. topstock-ops > **Actions** > **backup-prod** > **Run workflow** > **Run workflow**.

**What you should see:** a green tick; under **Artifacts** a `topstock-prod-<date>` item; the summary shows the file
size, the number of tables counted and the migrations.
**Done when:** green with one artifact. Tell Claude "Part G done, backup size N MB" (the size is needed for
decision 6). From now on it runs every night; GitHub emails you if a run fails.

---

## Part H. Restore test into topstock-dev

Why: a backup only counts once it has been restored (Master Plan section 8 row 44, Gate 1).

Follow **docs/ops-templates/restore-into-dev.md** on your Mac, start to end. In short: download the artifact,
decrypt it with your private key, save dev's fake data, load the backup's CRM tables into dev, compare row counts,
put dev's fake data back. It **overwrites dev's data for about 15 minutes** (dev holds only fake data, and it is put
back at the end). Accounts and two-factor secrets are never loaded into dev. Do this before part J, while production
holds no real leads.

**Done when:** Terminal printed `ROW COUNTS MATCH` and then `DEV IS BACK`. Tell Claude "Part H done, counts matched".

---

## Part I. Keep-alive

Why: Supabase pauses a free project after about a week with too little activity; a paused CRM is offline.

1. Paste `docs/ops-templates/keep-alive.yml` from topstock-crm into topstock-ops as
   `.github/workflows/keep-alive.yml` (as in C6).
2. **Actions** > **keep-alive** > **Run workflow** > **Run workflow**.

**What you should see:** a green tick; the log says "Database reached (anonymous read refused by Postgres, as it
should be)".
**Done when:** the manual run is green. It then runs every day by itself. Tell Claude "Part I done".

**Gate 1 is now complete** (security gate, backup and restore tested, keep-alive running, Vercel Pro). Only now does
real data go in.

---

## Part J. Real data: the 30,000 leads and the stock sheets

Why: the files go from your computer straight into the app. They never go to Claude, GitHub or any cloud session.

Before: prepare the leads file as in Master Plan section 7 ("Before import"): UTF-8 CSV, one header row.

### J1. Leads
1. Production app > the lead import page (Leads > Import, as confirmed in part A).
2. Choose the CSV from your computer. Match the columns when asked.
3. Run the **dry run** first. Read the result: how many would be imported, skipped as duplicates and rejected.
4. If there are rejects, download the rejects file and look at the reasons. Fix the source file and start again if
   needed (nothing has been written yet).
5. When the dry run looks right, confirm the import. Enter a fresh two-factor code when the app asks.
6. Check the Leads list: the total matches what the dry run said.

If something looks wrong after importing, undo the whole batch with the import page's rollback, then tell Claude
what you saw in words (for example "312 rows rejected for phone format"), never rows or screenshots of data.

### J2. Stock sheets
Same pattern on the stock sheet import page (Inventory, as confirmed in part A): choose the file, match columns,
dry run, check, import with a fresh code, check the stock list. Rollback is by batch, as for leads.

### J3. Fresh backup
**Actions** > **backup-prod** > **Run workflow**, so a backup with the real data exists right away.

**Done when:** both imports are in and the backup run is green. Tell Claude "Part J done" plus anything that did not
match. Delete local copies of the files you no longer need.

---

## Part K. Invite Henri and Kais

Why: everyone gets their own account with two-factor; nobody shares a login.

**Route 1 (custom SMTP sender set up, decision 2 a):**
1. Account B > **Authentication** > **Users** > **Add user** > **Send invitation**, once for Henri and once for Kais.
2. Each opens the email, presses Continue, chooses a password (12+ characters, mixed), and sets up two-factor with
   their own phone.

**Route 2 (built-in sender, decision 2 b):**
1. Account B > **Authentication** > **Users** > **Add user** > **Create new user**: their email, a temporary password
   generated by your password manager, **Auto Confirm User** ticked. Once for each.
2. Give each person their temporary password in person or by phone call (not email, not WhatsApp).
3. Each signs in at the production address, sets up two-factor with their own phone, then opens
   `https://topstock-crm.vercel.app/set-password` and chooses their own password.

**Then (both routes):** make each of them admin in the app (decision 3, confirmed in part A). Never with SQL.
Do it after the person has signed in, set up two-factor and chosen their own password (their account is in the
list from the moment you create it, as a rep). Signed in as yourself:
1. Open **More** (the last button in the dock) > **Team**.
2. Find the person. With a name: their name. Without one yet: **No name yet** with a **User ID** that matches the
   start of the UID shown for them in account B > **Authentication** > **Users**.
3. On their row, press **Role** (the button that says **Rep**) > **Admin**.
4. Check the confirmation names the right person and says "becomes an admin", then press **Confirm**.
5. If it asks "Confirm it’s you", type the 6-digit code from your authenticator app.
6. The row now says **Admin**. Do the same for the second person.

If it says "You are the last admin", you tried to change your own role: leave yours as Admin.

**What you should see:** account B lists 3 users; each of them reaches Home after entering a two-factor code.
**Done when:** Henri and Kais are signed in with two-factor and have the role you chose. Tell Claude "Part K done".

---

## Part L. What to tell Claude afterwards

- After each part: **"Part X done"**, or which step did not match and what the screen said, in words.
- Fine to send: part and step numbers, error titles, Security Advisor warning titles, "counts matched", the backup
  size in MB, "green" or "red" for a workflow run.
- Never send: passwords, keys (including the publishable key), tokens, the backup private key, connection strings,
  the production project reference or anything else from account B, lead or stock rows, the files, screenshots that
  show data.
- After part L, Claude logs "go-live done" in docs/log.md and lists what stays open (decisions 2, 6 and 7).

---

## Reference

### Secrets in topstock-ops
| Secret | Used by | Part |
|---|---|---|
| `TOPSTOCK_CRM_READ_TOKEN` | migrate-prod (checkout of topstock-crm, read-only) | C |
| `PROD_PROJECT_REF` | migrate-prod, backup-prod, keep-alive | C |
| `PROD_DB_PASSWORD` | migrate-prod, backup-prod | C |
| `PROD_DB_POOLER_HOST` | migrate-prod, backup-prod (the session pooler host cannot be worked out from the region, so it is copied) | C |
| `PROD_PUBLISHABLE_KEY` | migrate-prod (sign-ups and exposed-schema checks), keep-alive | C |
| `AGE_PUBLIC_KEY` | backup-prod | G |

### Templates (in topstock-crm, pasted into topstock-ops)
- `docs/ops-templates/migrate-prod.yml`: by hand; types MIGRATE; checks out a commit on main read-only; proves
  sign-ups closed and only `public` exposed; dry run; `supabase db push --db-url` through the session pooler;
  checks migrations recorded, row level security and policies on every table, advisors.
- `docs/ops-templates/backup-prod.yml`: nightly and by hand; `pg_dump` custom format of public, private, auth and
  supabase_migrations, streamed into age; private artifact for 90 days with a row-count file.
- `docs/ops-templates/keep-alive.yml`: daily; Auth health plus one REST request that reaches the database.
- `docs/ops-templates/restore-into-dev.md`: the restore test, on your Mac.

### Pages checked (Context7, 12 Oct 2026)
- Supabase CLI reference (`/supabase/cli`): `supabase db push` flags (`--db-url`, which must be percent-encoded;
  `--dry-run`), the global `--yes` flag, `supabase migration list`, and the CLI source `internal/utils/flags/db_url.go`
  (with `--db-url` the password is read only from the URL, never from an environment variable).
- Supabase guides (`/websites/supabase_guides`): Connecting to Postgres / serverless drivers (shared session pooler
  on port 5432 is IPv4 on every plan, user `postgres.<project-ref>`, host to be copied from the Connect dialog; direct
  connection is IPv6 on Free); Supavisor FAQ; Dedicated IPv4 address; Backup and restore using the CLI
  (`SET session_replication_role = replica` for data loads); CI backups; Free project pausing (inactivity over 7
  days, a few requests a day prevents it); Custom SMTP (built-in sender delivers only to the organisation's team,
  2 messages an hour); Password security (minimum length, required characters, leaked password protection on paid
  plans only); PGRST106 troubleshooting and Using custom schemas (`Accept-Profile` header); CLI config
  `auth.mfa.totp.enroll_enabled`.
- PostgreSQL 17 manual (`/websites/postgresql_17`): pg_dump (`-Fc`), pg_restore (`-n` repeatable, `--data-only`,
  `-1`), psql (`--single-transaction` with `-c` and `-f`), Backup and restore (custom dumps need pg_restore).
- age (`/filosottile/age`): README and man pages (`age-keygen -o`, `age -r`, `age --decrypt -i`).
- actions/upload-artifact (`/actions/upload-artifact`): `retention-days` (maximum 90 unless raised in repository
  settings), `if-no-files-found: error`, `compression-level: 0` for incompressible files.

Not from Context7 (builder's knowledge, to be confirmed on first use): GitHub and Vercel menu names; the PostgreSQL
apt repository script (`apt.postgresql.org.sh -y`) used by backup-prod; that Supabase Auth answers `signup_disabled`
before checking the password (if it did not, migrate-prod would stop with "not proven closed", never migrate
wrongly); that the Supabase `postgres` role may set `session_replication_role` (Supabase's own guide uses it).
