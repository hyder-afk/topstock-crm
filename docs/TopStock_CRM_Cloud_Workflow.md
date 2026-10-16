# TopStock CRM: Cloud-only workflow (Addendum B, 6 October 2026)

**Decision (Haider, 6 Oct 2026):** the project is built without his Mac. All building happens in **Claude Code cloud sessions** (claude.ai/code) on the GitHub repository `hyder-afk/topstock-crm`, deployed with **Vercel**, data in **Supabase**.

This addendum **overrides** every instruction in `START_HERE.md`, the Master Plan and the Lean Tooling Protocol that assumes Haider's Mac: local installs, Terminal, GitHub Desktop, `claude mcp add` at local scope, local import scripts, and "monthly dump to your Mac". Everything else in those documents still applies. Where this file and an older one conflict, this file wins.

---

## 1. How one change flows

1. Haider starts a session at **claude.ai/code** on `hyder-afk/topstock-crm`, in the cloud environment **TopStock** (section 2).
2. Claude Code works on a branch, runs lint, typecheck and tests in the VM, runs the app (`next dev`) inside the VM against the Supabase **dev** project, takes Playwright screenshots, commits, pushes and opens a **pull request**.
3. GitHub Actions runs CI on the PR. Vercel builds a **preview deployment** and posts its URL on the PR.
4. Before reporting, Claude Code runs the **`advisor` subagent** (`.claude/agents/advisor.md`): a read-only reviewer with a fresh context that checks the step against the plan, the security checklist and the evidence bundle. Claude Code fixes what it raises until it returns APPROVED.
5. Claude Code shows Haider the `REPORT` with the advisor's verdict and the preview link. Haider looks at the preview on his phone or any browser (signed in to Vercel).
6. When the advisor approved and CI is green, Haider clicks **Merge**. `main` deploys to Vercel production (Pro plan before go-live). *(Superseded 16 Oct 2026 by Haider: no Vercel Pro for now; see docs/log.md and go-live decision 4.)*

Haider works **only in Claude Code**; there is no separate advisor chat (decided 6 Oct 2026).

Sessions are disposable; the **repository is the memory**: `CLAUDE.md`, `docs/`, `docs/log.md`. Commit often: an idle session's VM is reclaimed and running work is lost (the conversation is kept).

## 2. Cloud environment "TopStock" (Haider configures once at claude.ai/code)

Create a new environment named **TopStock** (or edit Default):

**Network access: Custom**, tick **Also include default list of common package managers**, and add:

```
*.supabase.co
mcp.context7.com
cdn.playwright.dev
playwright.download.prss.microsoft.com
playwright.azureedge.net
```

(`*.supabase.co` lets the dev server and tests reach the dev project. `mcp.supabase.com` is reached through the API credential below, which bypasses the allowlist for that host only.)

**Environment variables** (not secret; anyone using the environment can read them). Fill in after Day 0 (section 9):

```
NEXT_PUBLIC_SUPABASE_URL=https://<dev-project-ref>.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=<dev anon / publishable key>
SUPABASE_DEV_PROJECT_REF=<dev-project-ref>
```

Never in environment variables: a `service_role` / secret key, a database password, or anything from the production project.

**API credential** (Max plan; the key is attached by Anthropic's proxy and never visible to Claude). Add after Day 0:
- Name: `Supabase dev MCP`; type **Bearer**; allowed website `mcp.supabase.com`; value: a Supabase personal access token created in the **dev** Supabase account (section 4).

**Setup script** (runs once, then cached for about 7 days):

```bash
#!/bin/bash
npm install -g @playwright/cli@0.1.22 || true
playwright-cli install-browser chromium --with-deps || playwright-cli install-browser chromium || true
playwright-cli install-browser webkit --with-deps || playwright-cli install-browser webkit || true
```

(Correction proposed by the builder in the pre-flight, 6 Oct 2026; **Haider applied it to the TopStock environment and confirmed it the same day**; it ran in 58 seconds. The original script was `npm install -g @playwright/cli@latest` followed by `npx -y playwright@latest install --with-deps chromium webkit || npx -y playwright@latest install chromium webkit`. Why it changed: `@playwright/cli` 0.1.22 bundles its own Playwright 1.64 pre-release, which needs Chromium build 1247 and WebKit 2368; `npx playwright@latest install` fetches the 1.63.0 builds (1243 and 2359), so `playwright-cli` would not find its browser. The CLI's own `install-browser` fetches the matching builds. `|| true` keeps a failed download from blocking every new session (a setup script that exits non-zero stops the session from starting); the first session then reports the missing tool. Bump the pinned version on dependency update day.)

Once the project pins its own `@playwright/test` version (Day 1), Claude Code adds a SessionStart hook in `.claude/settings.json` that runs `npm ci` and installs the matching browser build if it differs.

## 3. The five tools in the cloud (replaces Tooling Protocol section 3)

A fresh VM has nothing from earlier sessions except what is in the repository and the environment. So every tool lives in the repo:

| # | Tool | Cloud setup | Verify |
|---|---|---|---|
| 1 | Playwright CLI + Playwright Test | CLI and browsers from the setup script; `@playwright/test` as a devDependency; `playwright-cli install --skills` output committed to `.claude/skills/` | Screenshot of a localhost test page (`docs/evidence/preflight/test-page.html`) in Chromium and WebKit saved to `docs/evidence/preflight/` (changed from `https://example.com` by Haider, 6 Oct 2026: example.com is not on the TopStock network list, and Playwright points only at localhost) |
| 2 | Taste Skill | Read its `SKILL.md` first, then commit it to `.claude/skills/design-taste-frontend/`, pinned to a commit hash noted in `docs/log.md` | Listed as an available skill in a new session |
| 3 | Context7 | `.mcp.json` at the repo root: `{"mcpServers": {"context7": {"type": "http", "url": "https://mcp.context7.com/mcp"}}}` | New session answers "How do I set up next-intl with the App Router? use context7" and names the docs |
| 4 | Supabase MCP (dev, read-only) | `.mcp.json` entry `supabase`, type `http`, URL `https://mcp.supabase.com/mcp?project_ref=swhkafqlmfhvgpsgdqjp&read_only=true&features=database,debugging,development,docs` (configured 9 Oct 2026); token from the environment network secret `Supabase dev MCP` | In a TopStock session: (a) `list_tables` works and shows only the dev project; (b) the tool list has no `list_projects`, `list_organizations` or `create_project`; (c) a write (`apply_migration`, or `execute_sql` with `create table`) is refused as read-only. **Pass, 9 Oct 2026** (see `docs/preflight.md`) |
| 5 | Web design guidelines | Commit to `.claude/skills/web-design-guidelines/` (it fetches rules from GitHub at run time; that host is allowed) | `/web-design-guidelines` returns `file:line` findings on the scaffold |

Also check whether `/apple-design` is available (skills enabled on claude.ai load in cloud sessions). Fallback: `docs/apple-design-audit.md`, mandatory after every UI step either way.

**Free security stack** (gitleaks, Semgrep OSS, `npm audit`, lint, typecheck, Playwright on Chromium and WebKit) runs in **GitHub Actions** on every PR. Claude Code also runs `/security-review` before asking Haider to merge.

## 4. Supabase: two separate accounts (security control)

A Supabase personal access token can reach **every project in every organisation its user belongs to**. URL parameters (`project_ref`, `read_only`) limit the MCP server, but they live in a file Claude can edit. So production must be out of the token's reach:

- **`topstock-dev`** in Supabase account A (Haider's usual login). The MCP token comes from this account. Fake data only.
- **`topstock-prod`** in **Supabase account B**, a separate login (for example a dedicated `ops@` address), MFA on, never connected to Claude, no personal access token ever created.
- Both projects in an **EU region** (Paris `eu-west-3` or Frankfurt `eu-central-1`); a region cannot be changed later.

## 5. Migrations, tests and secrets

- Migrations are SQL files in `supabase/migrations/`, reviewed in PRs.
- Claude Code tests them **inside the VM** against a throwaway local database (Docker is available, so `supabase start` from the Supabase CLI works; plain PostgreSQL 16 is also installed). The two-user RLS attack tests run there, with no keys.
- On merge to `main`, a GitHub Action applies migrations to **dev** using repository secrets `SUPABASE_ACCESS_TOKEN` (account A) and `SUPABASE_DEV_DB_PASSWORD`, which **Haider pastes into GitHub settings himself**.
- **Production:** nothing touches prod before Gate 1. Proposal for Gate 1: a second private repository `topstock-ops` that Claude is never attached to and the Claude GitHub App is not installed on. It holds the prod secrets and the prod workflows (migrations by manual trigger, nightly encrypted backups, keep-alive). Reason: workflows in `topstock-crm` run on Claude-authored branches, so any secret stored there must be treated as reachable by Claude.
- Vercel environment variables: **Preview** = dev URL and anon key; **Production** = prod URL and anon key, entered by Haider at Gate 1; until Gate 1, Production uses the dev values (decided 9 Oct 2026). Server-only secrets, when needed, only as Vercel variables marked **Sensitive**, never in the repo or a cloud environment.

## 6. Vercel

- Import `hyder-afk/topstock-crm` in Vercel. Hobby while building, **Pro before go-live** (Hobby is non-commercial). Function region `cdg1` (Paris) or `fra1` (Frankfurt), matching Supabase. *(Superseded 16 Oct 2026 by Haider: no Vercel Pro for now; see docs/log.md and go-live decision 4.)*
- **Deployment Protection: Standard Protection + Vercel Authentication.** Original plan was All Deployments during the build, but Vercel Hobby offers only Standard. **Haider approved Standard on 9 Oct 2026:** previews stay behind Vercel login; the production URL is public and shows only the app's login page, in front of fake dev data. Revisit at the Pro upgrade. Before any app screen ships to production, open sign-ups on the dev project are disabled. *(Superseded 16 Oct 2026 by Haider: no Vercel Pro for now; see docs/log.md and go-live decision 4.)*
- Every PR gets a preview URL. That is how Haider sees screens on his phone and Mac.

## 7. Real data without a Mac (replaces the local import script)

- The 30,000-lead CSV and the stock sheets are imported through an **admin-only import page in the production app** (admin role plus step-up MFA): upload → staging table → validation and dry run → confirm → rollback by batch. It is built and tested in dev with fake files. The real files go from Haider's computer straight into the app; they never pass through Claude, GitHub or a cloud VM.
- Backups: the nightly encrypted `pg_dump` workflow moves to `topstock-ops` (section 5). "Monthly dump to your Mac" becomes "download the latest backup artifact once a month to a drive you control". Quarterly restore test into dev stays.
- AI coaching (Release 3) is re-planned at R3: transcripts are production data, so the batch must not run in a session that holds production access.

## 8. What the cloud cannot do

- No Safari and no access to Haider's devices: WebKit in Playwright approximates Safari; Haider checks previews on his iPhone and Mac.
- Installs made mid-session vanish with the VM; anything needed every session goes into the setup script or the repository.
- Sessions stop after inactivity; commit and push before long pauses.

## 9. Order of work from here

1. **PR #2 merged** (this file and the `advisor` subagent).
2. **Cloud environment TopStock** created with the network list and setup script (section 2). Variables and credential come later.
3. **Tooling pre-flight** in a new session (tools 1, 2, 3, 5; tool 4 pending), delivered as a PR with the sign-off table.
4. **Day 0 accounts** (Haider, on the web, one at a time): Supabase account A + `topstock-dev`; Supabase account B + `topstock-prod`; Vercel import with Standard Protection (Hobby offers only that; approved by Haider 9 Oct 2026); MFA on GitHub, Vercel, both Supabase accounts and email. Then environment variables, API credential, GitHub repository secrets, and tool 4.
5. **Gate 0**, then **Day 1** per Master Plan section 9.
