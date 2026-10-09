# Day 0: one-sitting setup for Haider (Supabase, Vercel, GitHub, Claude)

Written 9 Oct 2026 so Haider visits each dashboard once. Everything not listed here is done from code by Claude
(Supabase auth settings via `supabase config push` from the GitHub Action, Vercel region via `vercel.json`, all schema via migrations).
Never paste a password, key or token into a Claude chat. Only the dev **project reference** is sent to Claude.

Have ready: your password manager, your phone with an authenticator app, and a second email address for the production account
(for example ops@topstockwholesale.com; it must exist and receive mail). About 45 minutes.

## Part 1. Supabase account A: development (supabase.com, your usual email)
1. Sign in or sign up.
2. Turn on two-factor: avatar (top right) > Account preferences > Multi-factor authentication > add your authenticator app.
3. Create organisation **TopStock Dev**, plan **Free**.
4. New project: name `topstock-dev`; Database password > **Generate**, save as "Supabase topstock-dev DB password"; Region **West EU (Paris)**. Create and wait about 2 minutes.
5. Copy the 20-letter **project reference** from the address bar (after `/project/`). This is the only thing you send Claude.
6. Project Settings > API Keys: save in a password-manager note "TopStock dev public values":
   the **Project URL** (`https://<ref>.supabase.co`) and the **publishable** key (or the legacy **anon public** key).
   Do not copy the secret / service_role key.
7. Avatar > Account preferences > Access Tokens > Generate new token, twice, each copied once into the password manager:
   `claude-mcp-dev` and `github-actions-dev`.

## Part 2. Supabase account B: production (private browser window, the second email)
1. Sign up with the second email. Turn on two-factor (as in Part 1 step 2).
2. Create organisation **TopStock**, plan **Free**.
3. New project `topstock-prod`; Generate password, save as "Supabase topstock-prod DB password"; Region **West EU (Paris)**.
4. Do not create access tokens in this account, ever. Send Claude nothing from it. Sign out.

## Part 3. GitHub (github.com)
1. Two-factor: Settings > Password and authentication > Enable two-factor authentication (if not already on).
2. Repo secrets: github.com/hyder-afk/topstock-crm > Settings > Secrets and variables > Actions > New repository secret:
   - `SUPABASE_ACCESS_TOKEN` = the `github-actions-dev` token
   - `SUPABASE_DEV_DB_PASSWORD` = the topstock-dev database password

## Part 4. Vercel (vercel.com)
1. Sign up with **Continue with GitHub**, plan **Hobby**. When GitHub asks which repositories Vercel may see, choose **Only select repositories** > `topstock-crm`.
2. Two-factor: Account Settings > Authentication > enable.
3. Add New > Project > Import `topstock-crm`. Before clicking Deploy, open **Environment Variables** and add, for all environments:
   - `NEXT_PUBLIC_SUPABASE_URL` = the dev Project URL
   - `NEXT_PUBLIC_SUPABASE_ANON_KEY` = the dev publishable / anon key
   Deploy. The repo has no app yet, so a failed or empty first deployment is expected.
4. Project > Settings > Deployment Protection > Vercel Authentication: on, scope **All Deployments**.
   If the free plan only offers **Standard Protection**, choose that and tell Claude.
5. Do not install the Supabase integration from the Vercel Marketplace (it copies secret keys into Vercel and would mix the two accounts).

## Part 5. Claude environment (claude.ai/code)
In a session, the environment menu in the title bar > **TopStock** > Edit:
1. Environment variables (three lines):
   ```
   NEXT_PUBLIC_SUPABASE_URL=<dev Project URL>
   NEXT_PUBLIC_SUPABASE_ANON_KEY=<dev publishable / anon key>
   SUPABASE_DEV_PROJECT_REF=<dev project reference>
   ```
2. **Network secrets** (called API credentials in older app versions): name `Supabase dev MCP`, type Bearer if asked,
   allowed host `mcp.supabase.com`, value = the `claude-mcp-dev` token. Save.

## Part 6. Email two-factor
Turn on two-factor for contact@ and the second (ops@) mailbox. Henri and Kais do theirs when they are invited.

## Then tell Claude
"Day 0 done", the dev project reference, and anything that did not match these steps.

## Later visits (unavoidable, at go-live / Gate 1 only)
Vercel Pro upgrade; Vercel Production variables switched to the production URL and key; Deployment Protection to Standard;
inviting Henri and Kais.
