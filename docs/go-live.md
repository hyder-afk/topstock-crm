# Day 8 go-live: Haider's checklist

Written 12 Oct 2026 by the builder. Brought up to date on 16 Oct 2026 with main (commit c8ac42a: all of Day 6 and
Day 7, Gate 1 code part passed) and with Haider's decisions of 16 Oct 2026; part I3.3 (the daily security digest)
written the same day. Brought up to date again on 17 Oct 2026 with main c543676 (PR #23, the security digest, merged
as 2b1e7f5; PR #20, DB tests on the Paris day; PR #24, decision 9's 15-minute tokens, merged as c543676), plus the
consistency and security audit follow-ups (D2 one authenticator per person, D10 Realtime, B3 `/forgot-password`), and
with the audit-fixes PR (bugs and consistency audits: migrations `20261024080000_pipeline_board_order` and
`20261024080100_lead_stock_hold_note`). Master Plan section 9 Day 8, section 8
rows 2, 4, 8, 29, 30, 35, 43, 44 and 46, section 12 (Gate 1, "Backups and keep-alive"); Cloud Workflow sections 4 to
7; docs/day0-setup.md ("Later visits"); docs/evidence/day7d/section8-checklist.md (the items marked "Day 8").

**Haider's decisions, 16 Oct 2026**, in his words: "1. i dont want to get vercel pro extra cost no / 2. yes / 3. yes /
4. not right now when everything is ready / 5. when everything is ready".

| # | Decision | Parts |
|---|---|---|
| 1 | **No Vercel Pro.** Production stays on Vercel's free Hobby plan for now; hosting decided the same day: "Stay on vercel for now" (decision 4 below) | B |
| 2 | **Yes:** set up production Supabase (`topstock-prod`, account B), your own steps | C, D, E, F (up to your own account and two-factor) |
| 3 | **Yes:** backups, restore test, keep-alive, and the orphan sweeper's dry runs | G, H, I, I2 |
| 4 | **Later:** the real data import, "when everything is ready" | J (deferred) |
| 5 | **Later:** inviting Henri and Kais, "when everything is ready" | K (deferred) |

**So, in two sessions:** **now** decision 1 (decision 9 is decided: 900 seconds, already set by you on 16 Oct), parts A, B, C, D (and optionally G1 with G2 step 1), I3.1 and
I3.2; **from 31 Oct** parts E, F, the rest of G, then H, I, I2 and I3.3 (next section explains why). **Not now:**
parts J and K. Before either of them: the daily security digest is running (part I3.3) and, for part K, the email
sender question is answered (decision 2). Hosting is decided (decision 4: Vercel Hobby for now).

### GitHub Actions minutes (until 31 Oct)

You reported on 16 Oct 2026 that this month's GitHub Actions minutes are used up (2000 of 2000); they come back on
**31 Oct**. topstock-ops is private, so none of its workflows (migrate-prod, backup-prod, keep-alive,
sweep-lead-files) can run before then. topstock-crm is public, so its own CI uses no minutes and Claude can keep
working.

**Now (no topstock-ops workflow runs):**
- decision 1 (decision 9 is decided), then parts A and B;
- C1 to C6. Pasting migrate-prod in C6 is fine, because it only runs when you start it by hand: **do not start it**;
- all of part D;
- optionally G1 and G2 step 1 (the key pair and the `AGE_PUBLIC_KEY` secret);
- I3.1 and I3.2.

Done meanwhile: PR #24 (merged as c543676) set `jwt_expiry = 900` (decision 9: 900 seconds); the hosting options
are compared in `docs/evidence/day8/hosting-options.md` (decision 4, decided: stay on Vercel for now). The security
digest template (I3.3) is merged (PR #23, 2b1e7f5): its migration `20261023090000_security_digest` is on main, so it is
part of the SHA Claude confirms on 31 Oct.

**From 31 Oct**, after you check github.com > your avatar > **Settings** > **Billing** (the page may be called
"Billing and plans" or "Billing and licensing") that the Actions minutes are back:
- first ask Claude **"Go-live part A again: confirm the SHA"**, and use that new SHA in E and I2 (main will have
  moved on since today);
- part E, then part F straight after. **Never F before E**: F1 would point the live address at an empty database;
- G2 step 2 and G3, then H, then I, then I2 (its dry-run week starts then), then I3.3 (the security digest).

**Do not paste** backup-prod, keep-alive, sweep-lead-files or security-digest into topstock-ops before 31 Oct: their
schedules would fail and email you every night.

**Paying for extra minutes now** is your choice. Recommended: **wait**. Waiting is free, and no real data is at risk
(production holds nothing yet).

**After the reset**, topstock-ops needs about 180 to 230 minutes a month. GitHub rounds each job up to a whole
minute: backup about 3 a night, keep-alive 1 a day, sweeper 1 a day, security digest 1 a day (about 30 a month), plus
a few minutes for each migrate-prod run.
That stays well inside the 2000 **only while topstock-crm stays public**. If topstock-crm ever goes private again,
its CI eats the same pool and the backups stop, so tell Claude before changing that.

**How to use this:** do one part at a time, in order. After each part, tell Claude only "Part X done" (or what did
not match, in words). Claude never touches production: `topstock-prod` lives in Supabase **account B**, which has no
access token, ever; its secrets live only in the private repository **topstock-ops**, which Claude is never attached
to. So every production step below is yours, in your own browser or Terminal.

**Never paste into Claude:** passwords, keys, tokens, the backup private key, connection strings, anything copied
from account B, lead or stock rows, the CSV or stock files, or screenshots that show data.

**Have ready:** your password manager, your phone with the authenticator app, a private browser window for account
B (the ops@ login), your Mac's Terminal (parts F5, G and H), and two sessions: about 1.5 hours now (A, B, C, D,
I3.1, I3.2) and about 2 hours from 31 Oct (E, F, G, H, I, I2, I3.3).

---

## Decisions for you (answer Claude in one line each; recommendation in bold)

1. **Production web address.** The Site URL in part D. **Keep `https://topstock-crm.vercel.app` for now**; a custom
   domain (for example crm.topstockwholesale.com) can come later and changes part D's two URLs. Hosting stays on
   Vercel for now (decision 4); if the app ever moves, the address changes with it and Claude gives the new part D3
   and F values.
2. **Email sender for production** (needed for part K, which is deferred). Supabase's built-in sender (what dev uses
   today) only delivers to members of account B's Supabase team, at most 2 emails an hour, and refuses the app's own
   bilingual email templates. So with it, **invitations and password-reset emails cannot reach Henri and Kais**.
   Options:
   (a) **set up a custom SMTP sender on topstockwholesale.com before part K** (an email-sending service; may cost
   money; Claude writes the steps when you choose a provider); or
   (b) go live with the built-in sender and create Henri's and Kais's accounts by hand with a temporary password
   you give them in person (part K, route 2; your choice of 12 Oct 2026). Password reset by email stays unavailable
   until (a).
3. **Henri and Kais as admins** (part K, deferred). The database makes only the first account an admin; later
   accounts start as reps. You change their role yourself in the app: **More > Team** (admins only; it asks for a
   code from your authenticator app when the last one is older than 10 minutes). Claude confirms in part A that this
   screen is merged and live. Never change roles with SQL in the production dashboard.
4. **Hosting: decided 16 Oct 2026, production stays on Vercel Hobby for now** (your words: "Stay on vercel for now";
   earlier the same day: "i dont want to get vercel pro extra cost no"). Said plainly: Vercel's fair-use guidelines
   limit the Hobby plan to non-commercial, personal use (https://vercel.com/docs/limits/fair-use-guidelines,
   "Commercial usage"). They count as commercial any deployment used for the financial gain of anyone involved in
   it, and a company's own sales CRM falls under that rule. **You accept that risk:** Vercel may ask for an upgrade or
   pause the project (Master Plan section 3 already says Hobby "risks suspension"); a pause takes the app offline but
   loses no data, because the data lives in Supabase, not in Vercel. The option comparison is in
   `docs/evidence/day8/hosting-options.md`. If Vercel ever asks for an upgrade or pauses the project, Claude plans the move
   (recommended: Cloudflare Workers Paid, about $5 a month) as its own step. Meanwhile: **Deployment Protection stays
   on Standard Protection** and one free Firewall rule is added (part B).
5. **Leaked password protection** (Supabase rejects passwords known from breaches) exists only on Supabase's paid
   plan. **Stay on Free for now** (decided 15 Oct 2026; the setting stays off; passwords are 12+ characters with mixed
   types plus two-factor) unless you want to pay for Supabase Pro, which also removes the need for keep-alive.
6. **Backup storage.** Backups are kept 90 days. GitHub's free plan includes limited artifact storage for private
   repositories (500 MB on GitHub Free). After the first backup (part G), tell Claude its size in MB; if 90 copies
   do not fit, **keep 30 days plus your monthly download**, or pay GitHub for storage.
7. **Later restore tests.** The first restore test (part H) runs before any real data exists. After the real import,
   restoring a backup into dev would put real leads where Claude's dev access can read them. **Decide with Claude
   before the first quarterly test (January 2027)**; the builder's recommendation is a separate restore-test project
   in account B.
8. **Keep-alive once a day** (not every 3 days): Supabase says a few database requests each day keeps a Free
   project awake. It is free.
9. **How long a sign-in token lasts in production (`jwt_expiry`)**: **decided by you on 16 Oct 2026: "15 minutes",
   900 seconds.** You already set Access token (JWT) expiry to 900 in the production dashboard that day, so part D6
   is only a check. Done: PR #24 (merged as c543676) set `jwt_expiry = 900` in `supabase/config.toml` (dev gets it on the next
   deploy-dev-db run; CI's local stack and the tests use it too) and the "Sign out of all devices" sheet now says
   "within 15 minutes". Why: after "Sign out of all devices", another device stays signed in until its token runs
   out (Day 7a residual R2); 900 shrinks that window from 1 hour to 15 minutes. Supabase's guide says the 1-hour
   default suits most apps and values under 5 minutes should not be used; with three people the extra token
   refreshes are far below the limit (150 per 5 minutes). It was left open on 15 Oct 2026 for go-live (log:
   "jwt_expiry 60 to 15 min is decided at go-live"); until then it was 3600 seconds (1 hour). It can be changed later
   on the same screen, together with `supabase/config.toml`.

---

## Part A. Prerequisites gate (Claude confirms; you only read)

Why: production must get only reviewed code that passed the security gate.

1. In Claude Code, write: **"Go-live part A: please confirm."**
2. Claude replies with a REPORT that states, with evidence:
   - **Gate 1 (code part) PASSED** on 16 Oct 2026: conditions (a) to (d) of your decision shown met
     (`docs/evidence/day7d/README.md`, PR #19 merged as d12a4a9, evidence merged as c8ac42a): the two-user attack
     test, Master Plan section 8 A to F (52 of 59 items done, the rest marked Day 8, residual or not applicable),
     `/security-review` with no HIGH or MEDIUM finding, Supabase Security Advisor on dev with no ERROR;
   - the `advisor` subagent's verdict on this go-live kit: **APPROVED** (quoted);
   - CI green on `main`, and the **go-live commit SHA** (40 characters) you will deploy in part E: main **c8ac42a or
     later**, and Claude confirms it is **the newest commit on main** at that moment (F2 redeploys production from
     main, so the database in E must match it), with every migration on main at that
     confirmed SHA (Claude reads the list in `supabase/migrations/` at that SHA and names the last file and the count;
     with the audit-fixes PR merged that is `20261024080100_lead_stock_hold_note`, 24 files, and part I3.3 needs
     `20261023090000_security_digest` from PR #23 among them; `20261024090000_analytics` comes with the Analytics PR
     and is then the last file), and `deploy-dev-db` green on it (dev has the same migrations). The same SHA serves as
     `SWEEPER_SHA` in part I2;
   - that topstock-crm's Actions logs, which anyone can read since the repository went public (16 Oct 2026), touch
     only dev and print no secret;
   - where the lead import page and the stock sheet import page are (for part J, later), and that **More > Team** is
     live in that commit (for part K, later).

**What you should see:** one REPORT with "APPROVED" in the advisor line and one commit SHA.
**Done when:** Claude says "Part A: passed" and you have written the SHA down (it is not secret). The SHA is
**re-confirmed at the start of the 31 Oct session** ("Go-live part A again: confirm the SHA"); E and I2 use that
newer one.

---

## Part B. Vercel: stay on Hobby, check Deployment Protection, add one Firewall rule

Why: you decided on 16 Oct 2026 not to pay for Vercel Pro. Production stays on the free Hobby plan for now. Vercel's
fair-use guidelines limit Hobby to non-commercial use (https://vercel.com/docs/limits/fair-use-guidelines), and that
rule covers this business app. You decided on 16 Oct 2026 to stay on Vercel for now and accept that risk (decision 4):
Vercel can enforce the rule (for example by asking for an upgrade or pausing the project); a pause would take the app
offline, and no data would be lost, because the data lives in Supabase. The options are compared in
`docs/evidence/day8/hosting-options.md`; if Vercel ever acts, Claude plans the move (recommended: Cloudflare Workers
Paid, about $5 a month) as its own step. Nothing in this part costs money; do not upgrade anything.

### B1. Deployment Protection
1. Go to vercel.com and sign in. If Vercel offers Pro or a trial anywhere, decline it.
2. Open the project **topstock-crm** > **Settings** > **Deployment Protection**.
3. Under Vercel Authentication, keep **Standard Protection** (decided 9 Oct 2026, checked again now): previews stay
   behind your Vercel login; the production address stays public so that you (and later Henri and Kais) reach the
   login page. Do not choose a setting that protects all deployments: it would lock the team out of the app.
4. Do not add members to Vercel. Nobody but you needs Vercel; the team only uses the app.

**What you should see:** Deployment Protection shows Standard Protection.

### B2. A preview is closed to the public (section 8 item 29)
1. Project **topstock-crm** > **Deployments** tab > any deployment marked **Preview** > the **Visit** button. Copy
   the address from the browser's address bar and close that tab.
2. Open a **private window** (one where you are not signed in to Vercel) and paste the address.

**What you should see:** Vercel's own log-in page, not the TopStock sign-in page. Close the private window.

### B3. One Firewall rate-limit rule (free on Hobby)
Why: an extra layer in front of the app's own limits (residual R1, accepted 15 Oct 2026, stays recorded as residual)
and in front of the sign-in pages (Day 1 residual 2). Vercel's documentation says Firewall custom rules are free on
all plans, and Hobby includes **one rate-limit rule per project with 1,000,000 allowed requests**, counted by IP
address, in windows of 10 seconds to 10 minutes. Hobby has no payment method, so nothing can be charged: if any
screen asks for a card or an upgrade, stop and tell Claude.

1. Project **topstock-crm** > **Firewall** (left side) > **Configure** (top right) > **+ New Rule**.
2. Name: `TopStock rate limit`.
3. **If**: **Request Path** > **Starts with** > `/api`.
4. Add a second condition joined with **OR** (not AND): **Request Path** > **Starts with** > `/login`. Then a third,
   also with **OR**: **Request Path** > **Starts with** > `/mfa`, and a fourth, also with **OR**: **Request Path** >
   **Starts with** > `/forgot-password` (recommended by the 17 Oct 2026 security audit: the reset page has no limit of
   its own, and the project's email cap of 10 an hour is shared by everyone, so a script could use it up and delay real
   resets and invites). If the editor only lets you join conditions with AND,
   delete the extra conditions, keep the `/api` one alone and tell Claude "rule: no OR".
5. **Then**: **Rate Limit**. If a "Rate Limiting Pricing" window opens, read it and choose **Continue** (see the card
   rule above).
6. Strategy **Fixed Window**. **Time Window**: `60` seconds. **Request Limit**: `600`. Key: **IP Address** only.
7. Action when the limit is reached: **Log** for the first week (it blocks nothing and shows whether the numbers
   suit the way you work; three people may share one office address).
8. **Save Rule**. Then **Review Changes** (top right) > **Publish**.

**What you should see:** the rule listed as active, with the action Log.
**One week later:** Firewall overview > pick `TopStock rate limit` in the traffic drop-down and tell Claude how many
requests it logged as over the limit (the number only, never addresses). If it is 0 or close, edit the rule, change
the action from Log to **Default (429)**, **Save Rule** > **Review Changes** > **Publish**.

If production ever moves away from Vercel (decision 4: only if Vercel asks for an upgrade or pauses it), this rule stays behind with Vercel, and Claude gives the
equivalent step for the new host.

**Done when:** Standard Protection shown, the preview shows Vercel's log-in page, and the rule is published.
Tell Claude "Part B done" (plus "rule: no OR" if that happened).

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
topstock-crm is public since 16 Oct 2026, so the workflows could read it without a token today. Keep this token
anyway: it is read-only, it reaches nothing else, and the workflows keep working if the repository goes private
again.
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

The sixth secret, `AGE_PUBLIC_KEY`, is added in part G; the seventh, `PROD_SWEEPER_KEY`, in part I2.

### C6. Paste the migration workflow
1. In topstock-crm on github.com, open `docs/ops-templates/migrate-prod.yml` and click the **Copy raw file** button.
2. In topstock-ops: **Add file** > **Create new file**. Name: `.github/workflows/migrate-prod.yml` (typing the
   slashes creates the folders). Paste. **Commit changes** > commit directly to `main`.

(The backup, keep-alive and sweeper workflows are pasted in parts G, I and I2, so they do not run, and fail, before
the database and their keys exist.)

**What you should see:** topstock-ops > **Actions** lists **migrate-prod**; Settings > Secrets lists 5 secrets
(values are never shown again).
**Done when:** both are true. Tell Claude "Part C done".

---

## Part D. Production auth and storage settings, by hand in account B

Why: account B has no access token, so the settings that `supabase/config.toml` pushes to dev must be typed into
the production dashboard. Do this **before** part E: the database makes the first account an admin, so sign-ups
must be closed before the schema exists. Every value below is the one in `supabase/config.toml` on main (checked
16 Oct 2026), except the email templates (D5), which dev leaves out too.

Private window, account B, project **topstock-prod**. Menu names are those of October 2026; if a name differs,
look for the setting itself.

**If topstock-prod shows Paused**, click **Restore project** (free, nothing is lost) and wait until it is active
before D, and again before E if it has paused again. Why: a free project pauses after about a week without activity
(it has had none since Day 0); while it is paused the settings below cannot be saved and migrate-prod fails.

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
| Every other provider (Apple, Google, Web3 / Solana...) | **Disabled** | `[auth.external.*] enabled = false`, `[auth.web3.solana] enabled = false` |
| Third-party auth (Firebase, Auth0, Cognito, Clerk), if the menu shows it | **none added** | `[auth.third_party.*] enabled = false` |
| OAuth Server, if the menu shows it | **off** | `[auth.oauth_server] enabled = false` |

If you see a setting for the minimum time between emails to the same address, set **60 seconds**
(`max_frequency = "60s"`).

### D2. Authentication > Multi-Factor (MFA)
| Setting | Value | config.toml |
|---|---|---|
| TOTP (App Authenticator) | **Enabled** (enrol and verify) | `[auth.mfa.totp] enroll_enabled = true`, `verify_enabled = true` |
| Phone MFA | **Disabled** | `[auth.mfa.phone] enroll_enabled = false`, `verify_enabled = false` |
| Maximum enrolled factors per user | **1** | `max_enrolled_factors = 1` |

Why **1** (security audit, 17 Oct 2026): everyone has exactly one authenticator, and the app has no screen that lists
factors, so a stolen signed-in session could otherwise add a second authenticator nobody would see. Setup still works:
the app deletes any half-finished setup before it starts a new one. A lost phone is still handled by an admin removing
the factor in the dashboard.

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
| SMS sent, if shown | **30** per hour (phone is off, so unused) | `sms_sent = 30` |
| Anonymous sign-ins, if shown | **30** per hour per IP (anonymous sign-ins are off, so unused) | `anonymous_users = 30` |
| Web3 sign-ins, if shown | **30** per 5 minutes per IP (Web3 is off, so unused) | `web3 = 30` |

### D5. Authentication > Emails
Leave the sender **as today** (Supabase's built-in sender) and the templates and security notices as Supabase made
them. This matches dev: dev's deploy leaves out config.toml's email templates and notices
(`scripts/strip-email-templates.py`), because Supabase refuses them with the built-in sender on the Free plan. If
you choose decision 2 (a), Claude gives separate steps for the SMTP sender, the app's invite and reset templates
(`supabase/templates/`) and the three security notices (password changed, two-factor added, two-factor removed).

### D6. Authentication > Sessions (tokens)
Supabase's guide puts the access token expiry on the Auth **Sessions** page, and refresh token reuse under that
page's advanced settings. If a name differs, look for "JWT expiry" or "access token expiry".
**Access token (JWT) expiry: you already set it to 900 on 16 Oct 2026 (decision 9).** On 31 Oct you only check that
it still says **900**; change nothing. If it shows another number, set 900 again and tell Claude.

| Setting | Value | config.toml |
|---|---|---|
| Access token (JWT) expiry | **900** seconds (decision 9; set by you on 16 Oct 2026, only checked on 31 Oct) | `jwt_expiry = 900` |
| Detect and revoke compromised refresh tokens (refresh token rotation) | **ON** | `enable_refresh_token_rotation = true` |
| Refresh token reuse interval | **10** seconds | `refresh_token_reuse_interval = 10` |

Leave session time limits (time-box, inactivity timeout, single session) as they are: config.toml does not set
them.

### D7. Project Settings > Data API (exposed schemas)
| Setting | Value | config.toml |
|---|---|---|
| Exposed schemas | **`public` only**: remove `graphql_public` if it is listed | `[api] schemas = ["public"]` |
| Extra search path | `public, extensions` (default) | `extra_search_path` |
| Max rows | **1000** (default) | `max_rows = 1000` |

### D8. Storage > Configuration (S3 and upload size; section 8 item 8, log 15 Oct 2026)
On dev you found no S3 access keys (15 Oct 2026); production gets the same check now.
| Setting | Value | config.toml |
|---|---|---|
| S3 (the S3 connection or S3 protocol section): access keys | **none**. Never create one: S3 access keys skip all row level security on every bucket | not a setting |
| S3 protocol connection switch, if shown | **off** (the app and the sweeper use the Storage API, never S3) | `[storage.s3_protocol] enabled = false` |
| Upload file size limit (global) | **50 MB** (Free plan default) | `[storage] file_size_limit = "50MiB"` |

The `lead-files` bucket itself is made by the migrations in part E; you check it there.

### D9. Project Settings > Infrastructure (check only)
Read the Postgres version. **What you should see:** 17 (something). If it starts with another number, tell Claude
"prod Postgres is N" before part G: the backup workflow installs version 17 tools.

### D10. Realtime (recommended; security audit, 17 Oct 2026)
The app uses no Realtime channel and publishes no table, but Realtime is on by default. With it open, anyone holding
the public anon key could use public Broadcast and Presence channels as free messaging against the project's quota
(Master Plan item 10: switch off unused APIs). **Recommended:** in **Realtime** > **Settings**, switch Realtime off if
the screen offers it; otherwise turn off public access so that only private channels are allowed (the switch may be
called "Allow public access" or "Private channels only"). Nothing in the app changes. If you find neither switch, tell
Claude "no Realtime switch" and leave it. (Dev keeps `[realtime] enabled = true` in `supabase/config.toml` for now;
changing dev is a separate small PR if you want them to match.)

Save each screen.

**What you should see:** each value above, saved without an error.
**Done when:** every row matches. Part E then proves the two most important ones (sign-ups closed, only `public`
exposed) and stops if either is wrong. Tell Claude "Part D done" (plus any setting you could not find, by name, and
the Postgres number if it is not 17).

---

## Part E. Apply the database to production, then check the Security Advisor

Why: this creates the CRM's tables, security rules and functions in production, from the reviewed code on main.

**From 31 Oct only** (GitHub Actions minutes, see the top). Before you start: check that the minutes are back, and
that topstock-prod is not Paused (part D). Do part F straight after this part.

**First, switch on pg_cron in production** (your decision of 15 Oct 2026, plan question 3). The stock migration
schedules the nightly stock job (holds that end, the integrity check) only where pg_cron is already on, so this comes
before the migration run:
1. Account B (private window), topstock-prod > **Database** (left menu) > **Extensions**.
2. Search `pg_cron`, switch it **on**, keep the schema it suggests, **Enable extension**.

**What you should see:** pg_cron listed as enabled. (Dev has had it since 15 Oct: 1.6.4.)

Then:

1. topstock-ops > **Actions** > **migrate-prod** (left list) > **Run workflow** (right side).
2. Branch: `main`. **commit_sha**: paste the SHA Claude confirmed at the start of this session. **confirm**: type
   `MIGRATE`. Click **Run workflow**.
3. Click the run that appears and wait (about 3 to 5 minutes).

**What you should see:** a green tick. The run summary lists the commit, the migration files (21 at c8ac42a, from
`20261009180000_core_schema` to `20261022130000_share_take_paris_day`; a later commit lists more, for example 22 up to
`20261023090000_security_digest`) and five lines:
sign-ups closed: yes; REST API exposes only public: yes; migrations recorded; row level security on for all
tables, each with a policy; advisors: no ERROR.
If it is red, open the red step: its message says what to fix (usually a part D setting). Nothing is applied when
a check before "Apply migrations" fails. Run it again after fixing.

4. Account B, topstock-prod > **Advisors** (left menu) > **Security Advisor**. Refresh or re-run it if it offers.

**What you should see:** **no Errors**. These warnings are known and accepted (dev shows the same ones):
`set_user_role` is a SECURITY DEFINER function (accepted Day 1: it checks admin plus a fresh two-factor code);
`share_view` and `share_request` can be called by anonymous visitors (by design: the client stock link's only two
public functions, Day 6e; sharing stays off until you switch it on, later); leaked password protection is off
(decision 5). Anything else: tell Claude its title only.

5. Account B, topstock-prod > **Storage** > **Buckets** (or Files).

**What you should see:** one bucket, `lead-files`, **not** marked Public.

6. Account B, topstock-prod > **Integrations** > **Cron** > **Jobs** (it may be under **Database** > **Cron Jobs**).

**What you should see:** a job named `topstock-nightly-stock`, every day at 01:10 UTC. If it is missing, pg_cron was
not on before the run: tell Claude "no nightly job" (Claude gives the one-line fix; do not type SQL from elsewhere).

**Done when:** the run is green, the Security Advisor shows no Error, the bucket is private and the nightly job is
listed. Tell Claude "Part E done".

---

## Part F. Point the production app at production, sign in, enrol two-factor, check from outside

Why: until now the production address used the dev database (decided 9 Oct 2026). Do this right after part E.
**Never F before E**: F1 would point the live address at an empty database. This part ends with your own account
only; Henri and Kais wait for part K (later).

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

**What you should see:** exactly one user in the list (section 8 item 30: no default or test accounts in production).

### F4. Sign in and enrol two-factor
1. Open `https://topstock-crm.vercel.app` (normal window) and sign in with that email and password.
2. The app asks you to set up two-factor: scan the QR code with your authenticator app, enter the 6-digit code.
3. You land on Home ("Hello" / "Bonjour"). If it asks for your name, add it.
4. Open the lead import page (where Claude said in part A): it opens for you because you are the admin. **Do not
   import anything**: real data waits for part J.

Because your production password differs from dev, a successful sign-in also proves the app now talks to
production.

### F5. Check production from the outside (section 8 items 2 and 46, spike S5)
On your Mac, open **Terminal** and paste these three commands one at a time. They only read public answers of the
app; nothing in them is secret, and they work signed out.

**1. No repository or environment file is served (item 2):**
```bash
for p in /.env /.git/config /supabase/config.toml; do curl -s -o /dev/null -w "$p %{http_code} %{redirect_url}\n" "https://topstock-crm.vercel.app$p"; done
```
**You should see:** three lines, each ending in `307 https://topstock-crm.vercel.app/login` (sent to sign-in) or
`404` (not found). Anything else (for example `200`): tell Claude the line.

**2. Security headers on the sign-in page (item 46):**
```bash
curl -s -D - -o /dev/null https://topstock-crm.vercel.app/login | grep -i -E '^(content-security-policy|strict-transport-security|x-frame-options|x-content-type-options|x-powered-by):'
```
**You should see:** a `content-security-policy` line that contains `frame-ancestors 'none'` and
`upgrade-insecure-requests`; a `strict-transport-security` line (`max-age=63072000`); `x-frame-options: DENY`;
`x-content-type-options: nosniff`; and **no** `x-powered-by` line. Tell Claude which one is missing, if any.

**3. Vercel does not pass on a forged host header (spike S5, `x-forwarded-host`):**
```bash
curl -s -o /dev/null -w '%{http_code}\n' -X POST https://topstock-crm.vercel.app/api/share/view -H 'Origin: https://evil.example' -H 'X-Forwarded-Host: evil.example' -H 'Content-Type: application/json' --data '{}'
```
**You should see:** `403` (the app refused a request from another site, so Vercel replaced the forged header). If it
says `404`, Vercel passed the forged header on: tell Claude "share check 404". (Spike S5 planned this on a preview;
previews sit behind your Vercel login, so the public production address is the one a stranger could reach.)

**Done when:** you are signed in on production with two-factor, the import page opens, and the three checks show
what is written above. Tell Claude "Part F done" (plus any check that differed, in words).

---

## Part G. Backups

Why: nightly encrypted copies of the production database, which only your offline key can open.

G1 and G2 step 1 can be done now. **G2 step 2 and G3 wait for 31 Oct** (GitHub Actions minutes, see the top): a
backup-prod workflow pasted earlier would fail every night and email you.

### G1. Make the backup key pair on your Mac (Terminal)
This is your own operations step on your own Mac (not building the app). The private key is never shown on screen:
it goes from the file to your password manager through the clipboard.

1. Open **Terminal**. Check that Homebrew is there:
   ```bash
   brew --version
   ```
   **You should see:** `Homebrew` followed by a version number. If it says `command not found: brew`, open
   https://brew.sh, copy the one install line shown on that page into Terminal, follow what it prints, then run
   `brew --version` again.
2. Install age and make the key pair in a private folder:
   ```bash
   brew install age
   mkdir -m 700 ~/topstock-key && cd ~/topstock-key
   age-keygen -o topstock-backup-key.txt
   grep -c '^AGE-SECRET-KEY-1' topstock-backup-key.txt
   ```
   **You should see:** `Public key: age1...` (a long line) and then `1` (the file holds one private key). If
   `mkdir` says "File exists", an earlier attempt left the folder: run `rm -rf ~/topstock-key` and repeat step 2.
3. Copy the whole key file to the clipboard:
   ```bash
   pbcopy < topstock-backup-key.txt
   ```
   In your password manager, create a secure note **"TopStock backup private key (age)"** and paste. It has three
   lines: `# created: ...`, `# public key: age1...` and `AGE-SECRET-KEY-1...`. Save the note. This private key never
   goes to GitHub, Vercel, Supabase, email or Claude.
4. Keep a second offline copy (for example printed from the password manager, kept in a safe). Without this key the
   backups cannot be opened.
5. Put the **public key** (only) on the clipboard; this also replaces the private key there:
   ```bash
   age-keygen -y topstock-backup-key.txt | tr -d '\n' | pbcopy
   ```
   Go straight on to G2 step 1 and paste it there. (The public key is not secret; you may also keep it in the same
   password-manager note.) If you use a clipboard-history app, clear its history after this step, because it may
   have kept the private key from step 3.
6. After G2 step 1, delete the key file and its folder:
   ```bash
   cd ~ && rm -rf ~/topstock-key
   ```

### G2. Add the public key and the workflow
1. topstock-ops > **Settings** > **Secrets and variables** > **Actions** > **New repository secret**: name
   `AGE_PUBLIC_KEY`, value the `age1...` public key (paste from G1 step 5). **Add secret**. Then do G1 step 6.
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

Why: a backup only counts once it has been restored (Master Plan section 8 row 44, Gate 1). It also proves that the
private key in your password manager is the right one. From 31 Oct, after G3 (it needs that backup).

Follow **docs/ops-templates/restore-into-dev.md** on your Mac, start to end. In short: download the artifact,
decrypt it with your private key, save dev's fake data, load the backup's CRM tables into dev, compare row counts,
put dev's fake data back. It **overwrites dev's data for about 15 minutes** (dev holds only fake data, and it is put
back at the end). Accounts and two-factor secrets are never loaded into dev. This is the right moment: part J is
deferred, so production holds no real leads.

If age says "no identity matched", the note in your password manager is not the key from G1: tell Claude
"restore: key did not match"; the fix is a new key pair (G1 and G2 again) and a new backup (G3).

**Done when:** Terminal printed `ROW COUNTS MATCH` and then `DEV IS BACK`. Tell Claude "Part H done, counts matched".

For a real emergency in production later, the page is **docs/ops-templates/restore-production.md** (read it once
now, so you know it exists; it is not a test).

---

## Part I. Keep-alive

Why: Supabase pauses a free project after about a week with too little activity; a paused CRM is offline. From
31 Oct, after H (GitHub Actions minutes, see the top).

1. Paste `docs/ops-templates/keep-alive.yml` from topstock-crm into topstock-ops as
   `.github/workflows/keep-alive.yml` (as in C6).
2. **Actions** > **keep-alive** > **Run workflow** > **Run workflow**.

**What you should see:** a green tick; the log says "Database reached (anonymous read refused by Postgres, as it
should be)".
**Done when:** the manual run is green. It then runs every day by itself. Tell Claude "Part I done".

---

## Part I2. Orphan file sweeper (dry runs for a week, then on)

Why: bytes left behind by a cancelled upload (no file entry in the CRM) are removed once a day, so they never fill the
team's 800 MB. It runs in topstock-ops with its own Supabase secret key (your decision of 15 Oct 2026: "orphan sweeper
runs from topstock-ops with its own key; dry-run week first"). The database side is the migration
`20261022090000_orphan_sweeper` (in part E's run). From 31 Oct, after part I (GitHub Actions minutes, see the top):
its dry-run week starts then.

Follow **docs/ops-templates/sweep-lead-files.md**, "Day 8 set-up", steps 1 to 5 then: create the secret key named
`sweeper` in account B, store it as `PROD_SWEEPER_KEY` in topstock-ops, add the variables `SWEEPER_SHA` (the SHA Claude
confirmed at the start of this session) and `SWEEP_APPLY` = `no`, paste `docs/ops-templates/sweep-lead-files.yml`, run
it once by hand. Step 6 is the dry-run week (it runs by itself); step 7 switches deleting on afterwards, when Claude and
you agree.

**Done when:** the manual dry run is green. Tell Claude "Part I2 done, found N" (the number only; on a new project it
is 0).

---

## Part I3. Who can see what, and alerts (section 8 items 35 and 43)

Why: logs and dashboards show names and activity, so only you should reach them; and you should hear about problems.

### I3.1 Who can see logs and dashboards (item 35)
Check each list and remove anyone who should not be there (there should be nobody but you):
1. **Vercel:** the Hobby plan has only you. If your account settings show a Members page, it lists only you.
2. **Supabase account A (dev):** organisation > **Team** (or Members): only your own login.
3. **Supabase account B (prod):** private window, ops@ login > organisation > **Team**: only your own logins (the
   ops@ one). (Being on this team is also what lets the built-in sender email someone, decision 2.)
4. **GitHub, topstock-crm:** **Settings** > **Collaborators and teams**: nobody else. The repository is public, so
   anyone can read its code and its Actions logs; those touch only dev (part A confirms they print no secret).
5. **GitHub, topstock-ops:** **Settings** > **Collaborators and teams**: nobody else. Production's run logs live only
   here.

### I3.2 Dependabot alerts on topstock-crm (Day 7d open item)
1. topstock-crm > **Settings** > **Code security** (it may be called **Advanced Security**).
2. Next to **Dependabot alerts**, click **Enable** (free for public repositories). Leave the other Dependabot
   switches as they are; Claude handles updates through normal PRs.

**What you should see:** Dependabot alerts shown as enabled.

**Done when (I3.1 and I3.2, now):** the five lists hold only you and Dependabot alerts are on. Tell Claude "Part I3.1
and I3.2 done" (plus anyone you removed, by role only, for example "one old Vercel member"). I3.3 follows on 31 Oct.

### I3.3 Daily security digest (item 43): from 31 Oct, after I2
Why: once a day, a small job in topstock-ops counts security events in production (sign-ins whose code was never
finished, password-reset emails, new accounts, accounts without two-factor, role changes, removed accounts, deletes,
file opens, imports, the client sharing switch) and checks that backup-prod, keep-alive and sweep-lead-files worked.
When something is over its limit, the run turns **red and GitHub emails you**; otherwise it stays green and quiet. It
only reads, gets counts only (no names, emails or IP addresses), and needs **no new secret**. What it checks, the
limits and what to do when it is red: **docs/ops-templates/security-digest.md**.

**From 31 Oct only**, after part I2 (GitHub Actions minutes, see the top), and only if part E ran at a commit that has
the migration `20261023090000_security_digest` (Claude says so in "Go-live part A again"). If E ran without it, tell
Claude: the fix is one more migrate-prod run at a newer SHA.

1. **Email setting:** github.com > your avatar > **Settings** > **Notifications** > **Actions** (it may sit under
   **System**): notifications on, **Email** ticked. "Only notify for failed workflows" may be ticked too. Check that the
   email address at the top of the page is one you read.
2. **Paste the workflow:** `docs/ops-templates/security-digest.yml` from topstock-crm into topstock-ops as
   `.github/workflows/security-digest.yml` (as in C6). You must be the one who commits it: GitHub emails about a
   scheduled run the person who last changed its schedule line.
3. **Run it once by hand:** **Actions** > **security-digest** > **Run workflow** > **Run workflow**.

**What you should see:** a green tick (under a minute). The summary says "security-digest: green, nothing over its
limit", lists the counts, and shows backup-prod, keep-alive and sweep-lead-files as "success" and less than 26 hours
old. If it is red, the summary says why; the runbook's "When it is red" table says what each line means (for example
"Could not read the security counts": the migration is not in production yet, tell Claude).
**Done when:** the manual run is green. It then runs every day at 09:13 UTC by itself. Tell Claude "Part I3.3 done".

**Where Gate 1 stands.** Done: the code part (16 Oct). Now: production settings (D) and access checked (I3.1,
I3.2). **Waiting for 31 Oct** (GitHub Actions minutes): the database in production and its checks (E, F5), backups
(G), the restore test (H), keep-alive (I), the sweeper's dry runs (I2) and the security digest (I3.3; its template
is merged, PR #23). Hosting is decided (decision 4, 16 Oct 2026: Vercel Hobby for now, the
fair-use risk accepted), so it no longer holds Gate 1 open. Real data (part J) waits for all of these, and for your
"when everything is ready".

---

## Part J. Real data: the 30,000 leads and the stock sheets (DEFERRED)

**Deferred** (your decision of 16 Oct 2026: "not right now when everything is ready"). **Do not start this part.**
Before it: the security digest running green (part I3.3), Gate 1 fully passed, and Claude's
"part J ready" with a fresh go-ahead from you. The steps below stay as written for that day.

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

## Part K. Invite Henri and Kais (DEFERRED)

**Deferred** (your decision of 16 Oct 2026: "when everything is ready"). **Do not start this part.** Before it: part J
done and Gate 1 fully passed, your choice of email sender (decision 2) and Claude's
"part K ready". The steps below
stay as written for that day.

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
  size in MB, "green" or "red" for a workflow run, the Firewall rule's logged count, the Postgres major version.
- Never send: passwords, keys (including the publishable key), tokens, the backup private key, connection strings,
  the production project reference or anything else from account B, lead or stock rows, the files, screenshots that
  show data, IP addresses from the Firewall page.
- After the first session, Claude logs which parts are done; after the 31 Oct session (parts E to I3.3), Claude logs
  "go-live parts A to I3 done" in docs/log.md and lists what stays open: the security digest (I3.3) if it is not green yet, parts J and K (deferred), the
  email sender (decision 2), backup storage (decision 6), later restore tests (decision 7), the sweeper's switch-on after its dry-run week (I2 step 7), the Firewall rule's switch from Log
  to 429 (B3), and switching the client stock link on in production (off until you decide, after Gate 1).

---

## Reference

### Secrets in topstock-ops
| Secret | Used by | Part |
|---|---|---|
| `TOPSTOCK_CRM_READ_TOKEN` | migrate-prod, sweep-lead-files (checkout of topstock-crm, read-only) | C |
| `PROD_PROJECT_REF` | migrate-prod, backup-prod, keep-alive, sweep-lead-files, security-digest | C |
| `PROD_DB_PASSWORD` | migrate-prod, backup-prod, security-digest (read-only transaction, reader role) | C |
| `PROD_DB_POOLER_HOST` | migrate-prod, backup-prod, security-digest (the session pooler host cannot be worked out from the region, so it is copied) | C |
| `PROD_PUBLISHABLE_KEY` | migrate-prod (sign-ups and exposed-schema checks), keep-alive | C |
| `AGE_PUBLIC_KEY` | backup-prod | G |
| `PROD_SWEEPER_KEY` | sweep-lead-files only: the dedicated Supabase secret key named `sweeper` (account B), revocable on its own | I2 |

Variables (Settings > Secrets and variables > Actions > Variables): `SWEEPER_SHA` (the topstock-crm commit whose
sweeper script runs) and `SWEEP_APPLY` (`no` for the dry-run week, then `yes`), both part I2.

Nothing for production is stored in Vercel except the two public values of part F1 (the production address and the
publishable key). Hosting stays on Vercel Hobby (decision 4, decided 16 Oct 2026).

### Templates (in topstock-crm, pasted into topstock-ops)
- `docs/ops-templates/migrate-prod.yml`: by hand; types MIGRATE; checks out a commit on main read-only; proves
  sign-ups closed and only `public` exposed; dry run; `supabase db push --db-url` through the session pooler, which
  applies every file in `supabase/migrations/` at that commit (21 at c8ac42a, Day 1 to Day 7); checks migrations
  recorded, row level security and policies on every table, advisors.
- `docs/ops-templates/backup-prod.yml`: nightly and by hand; `pg_dump` custom format of public, private, auth and
  supabase_migrations, streamed into age; private artifact for 90 days with a row-count file. Lead files in Storage
  are not in it (no database backup holds them; see restore-production.md).
- `docs/ops-templates/keep-alive.yml`: daily; Auth health plus one REST request that reaches the database.
- `docs/ops-templates/restore-into-dev.md`: the restore test, on your Mac.
- `docs/ops-templates/restore-production.md`: a real restore of production (which backup per plan, checks after,
  the Storage caveat, role `share_reader` first). For an emergency, never in a Claude session.
- `docs/ops-templates/sweep-lead-files.yml`: daily; lists files in storage with no file entry older than 24 hours,
  removes them only once `SWEEP_APPLY` is `yes` (or a manual run typed SWEEP); caps, sanity check, pinned commit.
  It calls the three service-role functions of migration `20261022090000_orphan_sweeper` (`lead_file_orphans`,
  `lead_file_sweep_stats`, `record_file_sweep`). Runbook: `docs/ops-templates/sweep-lead-files.md`.
- `docs/ops-templates/security-digest.yml`: daily and by hand; checks that backup-prod, keep-alive and
  sweep-lead-files succeeded in the last 26 hours (GitHub API, its own token with `actions: read`), then reads
  `private.security_digest` (migration `20261023090000_security_digest`) in a read-only transaction as the role
  `security_digest_reader`: counts only. Red, so GitHub emails, when a count is over its limit. No new secret, no
  third-party action, about 1 minute a day. Runbook: `docs/ops-templates/security-digest.md`.

### Section 8 items with a Day 8 step (`docs/evidence/day7d/section8-checklist.md`)
| Item | What | Where in this kit |
|---|---|---|
| 2 | No public `.env` on the production address | F5 check 1 |
| 4 | Invite-only, strong passwords, two-factor in production | D1, D2 (proved by E's run) |
| 8 | Cloud settings: Vercel and production Storage | B1, D8, E step 5 |
| 25 | Sessions: `jwt_expiry` (residual R2) | decision 9, D6 |
| 28 | Rate limits: Firewall rule (residual R1 stays recorded) | B3 |
| 29 | Environments separate: a preview opened signed out | B2 |
| 30 | No default accounts in production | F3 |
| 35 | Logs restricted | I3.1 |
| 43 | Security monitoring | I3.3 (template written 16 Oct 2026; pasted from 31 Oct) |
| 44 | Backups and restore | G, H, I (and restore-production.md) |
| 46 | Security headers on the production address | F5 check 2 |
| Gate 1 | Hosting decision | decision 4 (decided 16 Oct 2026: Vercel Hobby for now; `docs/evidence/day8/hosting-options.md`) |

### Pages checked (Context7, 16 Oct 2026)
- For part I3.3 (security digest): Supabase guides (`/websites/supabase_guides`) Auth Audit Logs (what is logged; the
  database copy in `auth.audit_log_entries` only when "write to the database" is on) and Auth Hooks (password and MFA
  verification attempt hooks on Teams and Enterprise only); Supabase Auth source (`/supabase/auth`: `token.go` and
  `mfa.go` return on a wrong password or code before writing an audit entry); GitHub REST (`/websites/github_en_rest`:
  list workflow runs for a workflow, `status=completed`, Actions read) and GitHub Docs (`/github/docs`: notifications
  for scheduled workflows go to the person who last changed the cron line).
- Vercel documentation (`/websites/vercel`): fair-use guidelines, "Commercial usage" (Hobby teams are restricted to
  non-commercial personal use; commercial means a deployment used for the financial gain of anyone involved in any
  part of its production); Vercel WAF usage and pricing (Firewall features on all plans are free, including custom
  rules; rate limiting is priced per plan); WAF rate limiting "Limits" (Hobby: 1 rate-limit rule per project,
  1,000,000 allowed requests included, keys IP or JA4, fixed window 10 seconds to 10 minutes, up to 3 custom rules in
  all) and "Get started" (Firewall > Configure > New Rule > Rate Limit, actions Default 429, Log, Deny, Challenge;
  Review Changes > Publish); the CLI page for `vercel firewall rules add` and the WAF config API (rules can hold OR
  groups of conditions).
- Supabase guides (`/websites/supabase_guides`): Sessions (access token expiry on the Auth Sessions page; 1 hour
  suits most apps; under 5 minutes not advised; refresh token reuse interval 10 seconds, not to be changed); CLI
  config `auth.jwt_expiry` (default 3600, at most one week) and `auth.refresh_token_reuse_interval`; Storage S3
  authentication and "Download objects" (S3 access keys bypass row level security on all buckets; Storage >
  Configuration > S3 is where the protocol is enabled and keys are made).

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
- age (`/filosottile/age`): README and man pages (`age-keygen -o`, `age-keygen -y`, `age -r`, `age --decrypt -i`).
- actions/upload-artifact (`/actions/upload-artifact`): `retention-days` (maximum 90 unless raised in repository
  settings), `if-no-files-found: error`, `compression-level: 0` for incompressible files.

Not from Context7 (builder's knowledge, to be confirmed on first use): GitHub, Vercel and Supabase menu names
(including where the Firewall editor offers OR, the Cron jobs page and the Storage configuration page); the
PostgreSQL apt repository script (`apt.postgresql.org.sh -y`) used by backup-prod; that Supabase Auth answers
`signup_disabled` before checking the password (if it did not, migrate-prod would stop with "not proven closed", never
migrate wrongly); that the Supabase `postgres` role may set `session_replication_role` (Supabase's own guide uses it);
the Homebrew check in G1; that Vercel sets `x-forwarded-host` from the real host (Vercel's request-headers page says it
carries the same value as `host`; F5 check 3 confirms it on the real deployment).
