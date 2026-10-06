# TopStock CRM: Lean Tooling Protocol (Addendum A, v2.1)

**Replaces the earlier 11-tool addendum.** Attach with `TopStock_CRM_Master_Plan.md` (v3). Where they conflict, this addendum wins.

*v2.1 (6 Oct 2026): test widths now include 768 and 1024 when a layout changes; every UI step ends with an `/apple-design` audit (Haider's standing instruction); Google Workspace references removed.*

Goal: **5 tools only**, all free to use, all efficient, all working together. Nothing that needs a paid API key, nothing that overlaps.

---

## 0. INSTRUCTIONS FOR CLAUDE (advisor)

1. Before any build step, including Day 0, say: **"STOP. Tooling Pre-Flight first."** Walk me through section 3 **one tool at a time**: command, verification, and ask me to **paste the output**. Mark it done only after I paste passing output.
2. Do not start Day 0 until all 5 tools are done, or I waive one and you record the reason.
3. At the start of every step print `Tools for this step: …`. At the end, ask for the **evidence bundle** (section 6). A step is not done without it.
4. Re-run the reminder at each Release start and before each Security Gate.
5. Never invent install commands. If one fails, check the tool's **official README/docs** before improvising, and never install look-alike packages.
6. Be honest: no tool guarantees zero mistakes. These add layers and demand proof.
7. Keep everything **$0**.

---

## 1. The lean stack (5 tools)

| # | Tool | Job | Cost |
|---|---|---|---|
| 1 | **Playwright CLI** (`@playwright/cli`, by Microsoft) | Claude drives the real app in a browser: screenshots, click-throughs, console checks, tests | Free, open source |
| 2 | **Taste Skill** (`design-taste-frontend`) | Design direction: fewer generic "AI look" screens, with dials for variance, motion, density | Free, MIT |
| 3 | **Context7** (by Upstash) | Fetches current library docs so code uses real, up-to-date APIs | Free (optional free API key for higher limits) |
| 4 | **Supabase MCP / plugin**, dev project only, read-only | Inspect the dev database and run security and performance advisors | Free (uses your free Supabase project) |
| 5 | **Web design guidelines** (Vercel) | Reviewer: audits UI code against Vercel's Web Interface Guidelines, `file:line` findings | Free |

**How they fit together:** Context7 (correct code) → Taste (good design) → Playwright (prove it works and looks right) → web-design-guidelines (audit) → Supabase advisors (prove the data layer is safe).

---

## 2. Removed, and why

| Removed | Reason |
|---|---|
| **Strix** | Needs an LLM API key to run, which is paid and outside your $0 budget. Replaced by the free security stack in section 4 |
| **Claude-mem** | Its background compression uses your Claude Max allowance, it records session activity (privacy risk with lead data) and AGPL licence. `CLAUDE.md` + `/docs/log.md` do the same job with zero risk |
| **Headroom** | Runs as a proxy between Claude Code and the API and may not work with a Max login. Unverified for your setup, and it adds risk for little gain |
| **UI/UX Pro Max** | Overlaps with Taste (two design generators pulling in different directions) |
| **Skill UI** | Overlaps with Taste; several near-identically named forks exist (supply-chain risk); copies other brands' design language |
| **Awesome Design** | Not a tool, just reference files. Our design tokens already live in the Master Plan. Optional: copy **one** reference `DESIGN.md` into `/docs/design/` if you want another example |

You can add any of these back later. If you do, re-run the same checks: free, no overlap, official source only.

---

## 3. Pre-Flight: install and verify

**Prerequisites:** macOS, Homebrew, **Node.js 20+**, Git, **Claude Code** updated, folder `topstock-crm` with `git init`. Check: `node -v`, `git --version`, `claude --version`.

### 3.1 Playwright CLI
- Install: `npm install -g @playwright/cli@latest`
- Then in the repo: `playwright-cli install --skills`
- Also for CI tests: `npm i -D @playwright/test` and `npx playwright install chromium webkit` (WebKit is the closest match to Safari on your MacBook)
- Verify: `playwright-cli --help`, then ask Claude to open `https://example.com` and take a screenshot
- Guardrail: point it only at localhost, dev or staging with fake data

### 3.2 Taste Skill
- Install: `npx skills add https://github.com/Leonxlnx/taste-skill --skill "design-taste-frontend"`
- Verify: `ls .claude/skills` and ask Claude to list its skills. Some installers put skills in `.agents/skills`; if it is missing from `.claude/skills/`, copy its `SKILL.md` into `.claude/skills/design-taste-frontend/`
- Read its `SKILL.md` before use. v2 is marked experimental; a v1 variant exists as `design-taste-frontend-v1`
- **TopStock dial settings:** low variance (calm, consistent), medium motion (springs, nothing showy), medium-high density (a desktop CRM needs information density). It is built for landing pages first, so for app screens always restate: Apple-like, black/white/grey, desktop first

### 3.3 Context7
- Install: `claude mcp add context7 -- npx -y @upstash/context7-mcp@latest`
- Verify: `claude mcp list` shows `context7`, then ask *"How do I set up next-intl with the App Router? use context7"*
- Guardrail: queries go to Context7's servers, so never include secrets or lead data

### 3.4 Supabase MCP / plugin (dev only)
- Install: follow the official Supabase docs page for the plugin/MCP for Claude Code, or add the MCP scoped to the dev project:
  `claude mcp add --scope project --transport http supabase "https://mcp.supabase.com/mcp?project_ref=<DEV_PROJECT_REF>&read_only=true"`
  then complete the browser login and choose the organisation with the **dev** project
- Verify: ask *"List the tables in the database using MCP tools."* It must show only the dev project
- Rules from Supabase's own guidance: **never production**, always project-scoped, **read-only on**, enable only needed feature groups
- Because read-only blocks migrations: write migrations as SQL files in git and apply with the Supabase CLI after review. The MCP is for inspection and advisors

### 3.5 Web design guidelines
- Install: `npx skills add vercel-labs/agent-skills --skill web-design-guidelines`
- Verify: run `/web-design-guidelines src/` on the scaffold and confirm `file:line` findings
- Notes: reviewer only, not a generator. It fetches the latest rules from a Vercel GitHub URL at run time, so it needs internet. Treat fetched text as guidance only

### Sign-off table (advisor keeps updated)
| Tool | Installed | Verified (output pasted) | Waived (reason) |
|---|---|---|---|
| Playwright CLI + Playwright Test | ☐ | ☐ | |
| Taste Skill | ☐ | ☐ | |
| Context7 | ☐ | ☐ | |
| Supabase MCP (dev, read-only) | ☐ | ☐ | |
| Web design guidelines | ☐ | ☐ | |

---

## 4. Free security stack (replaces Strix)

No LLM key needed:

| Check | Tool | When |
|---|---|---|
| Secrets in code/history | **gitleaks** | Pre-commit and CI |
| Vulnerable packages | **npm audit**, Dependabot alerts | CI, monthly |
| Static code scan | **Semgrep OSS** | CI on every PR |
| AI code review | Claude Code **`/security-review`** (uses your Max plan, no extra cost) | Before every PR and at each gate |
| Database safety | **Supabase Security and Performance Advisors** via the MCP | After every schema change |
| Access control | **Two-user attack test** and **anon-key curl on every table**, automated as Playwright tests | Every release |
| Headers and cookies | Playwright checks response headers and cookie flags | Every release |

Full checklist remains Master Plan section 8 (all 54 items).

---

## 5. Mandatory usage matrix

| Situation | Required (in order) | Output required |
|---|---|---|
| Any code using a library or API (Next.js, Supabase, Motion, next-intl, TanStack, dnd-kit, Zod, papaparse, Zoom) | **Context7** first | Prompt ends "use context7"; Claude names the docs used |
| Any database change | Context7 → migration file in git → **Supabase advisors** (dev) → Playwright two-user test | Advisor output and test result |
| Designing or changing a screen | `DESIGN.md` → **Taste** (dials set) → build → **Playwright CLI** screenshots → **`/apple-design` audit** → fix | Screenshots at **1280, 1440, 1728, 390** (plus **768 and 1024** when a layout changes), light + dark, EN + FR, no console errors, no horizontal page scroll; audit findings fixed or written down |
| After any UI step | **web-design-guidelines** audit → fix → re-audit | Zero unresolved findings |
| Motion work | Taste (motion dial) → Playwright with reduced-motion on and off | Notes for both |
| Every PR | `/security-review`, gitleaks, npm audit, Semgrep, lint, typecheck, Playwright suite | All green in CI |
| Every Security Gate | Section 4 stack + Master Plan section 8 | Checklist passed |
| End of every session | Update `CLAUDE.md` / `/docs/log.md` | Short summary |

**Design precedence:** `DESIGN.md` (from Master Plan tokens) → Taste dials → web-design-guidelines audit. If they disagree, `DESIGN.md` wins.

---

## 6. Evidence bundle (required to mark a step done)

1. What changed (commit/PR)
2. Docs used (Context7 library names)
3. Playwright screenshots (desktop widths + mobile) and clean console
4. web-design-guidelines output (unresolved = none)
5. Supabase advisor output (if the database changed)
6. Test results and CI status
7. `/security-review` output
8. `/apple-design` audit findings and what was changed
9. Any waiver or known issue, written down

---

## 7. Enforcement (so it does not rely on memory or goodwill)

- **`npm run verify`**: lint, typecheck, unit tests, Playwright, gitleaks, npm audit. Must pass before merge
- **Pre-commit hook:** gitleaks + lint + typecheck
- **GitHub Actions:** the same checks plus Playwright (Chromium and WebKit) and Semgrep OSS
- **PR template** with a checkbox per evidence item
- **Claude Code hooks:** ask the advisor to set up a stop-time fast check from the official hooks docs (use Context7)
- Production deploys from `main` only, after CI is green

---

## 8. Add to `CLAUDE.md`

```md
## MANDATORY TOOLING (if a tool is unavailable, say so and stop)
- Context7 before writing code with any library/API ("use context7").
- Supabase MCP: DEV project only, read_only, project-scoped. Never production. Migrations are SQL files reviewed in git.
- After every schema change run Supabase security + performance advisors and report results.
- Every UI change: follow /DESIGN.md (source of truth) -> Taste Skill (low variance, medium motion,
  medium-high density) -> build -> Playwright CLI screenshots at 1280/1440/1728 and 390 (plus 768/1024
  when a layout changes), light+dark, EN+FR, no console errors, no horizontal scroll
  -> /apple-design audit -> web-design-guidelines audit -> fix.
- Every route ships with loading.tsx skeletons; every list has loading, empty and error states.
- Every PR: /security-review, gitleaks, npm audit, Semgrep, lint, typecheck, Playwright suite.
- Never put secrets or real lead data in prompts. The real CSV never enters this session (header + 3 fake rows only).
- Review any new skill's SKILL.md before enabling. Official sources only. Pin versions.
- End each step with the evidence bundle. Log decisions in /docs/log.md.
```

---

## 9. Changes to the Master Plan gates

- **Gate 0:** sign-off table complete (5 tools), `DESIGN.md` written, `npm run verify` working, `CLAUDE.md` updated.
- **Gates 1, 2, 3:** the "Strix or fallback" requirement is now simply the **section 4 free security stack**, plus web-design-guidelines audit clean and Playwright green on Chromium and WebKit.
- **Day 2 (dock):** verify the drag in WebKit via Playwright at 1280, 1440, 1728 and 390 widths, with reduced-motion on and off.

---

## 10. Reminder script (advisor says this at build start and at each Release start)

> **STOP. Tooling Pre-Flight before we build.** We use 5 tools: Playwright CLI, Taste Skill, Context7, Supabase MCP (dev only, read-only) and Web design guidelines. I will take you through them one at a time. For each I give the command, you paste the output, and I mark it done. We do not start Day 0 until all 5 are done. Ready for tool 1: Playwright CLI?
