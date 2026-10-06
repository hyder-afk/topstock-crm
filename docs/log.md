# Decision and session log

| Date | Who | What |
|---|---|---|
| 2026-10-06 | advisor | Master Plan v3, Tooling Protocol v2.1, prototype v3.2 handed over; START_HERE.md created |
| 2026-10-06 | builder | Bootstrap done in a cloud session (commit 6be0957, PR #1 merged); `START_HERE (1).md` renamed to `START_HERE.md` |
| 2026-10-06 | Haider | Build cloud-only: Claude Code cloud sessions + GitHub + Vercel + Supabase, no Mac. Addendum B `docs/TopStock_CRM_Cloud_Workflow.md` added; prod Supabase in a separate account |
| 2026-10-06 | Haider | No separate advisor chat: Haider works only in Claude Code. Review moved into the repo as the read-only `advisor` subagent (`.claude/agents/advisor.md`), run before every REPORT and merge |
| 2026-10-06 | builder | Tooling pre-flight (tools 1, 2, 3, 5) in the Default cloud environment; TopStock environment not created yet. Sign-off table and pins in `docs/preflight.md` |
| 2026-10-06 | builder | Taste Skill v2 pinned at Leonxlnx/taste-skill `ce26fc25c0e5e8cab638f883de62d9a86ee5e45b`; dials for TopStock 3 / 5 / 7 (variance / motion / density); plan overrides listed in `docs/preflight.md` |
| 2026-10-06 | builder | web-design-guidelines from vercel-labs/agent-skills `063bee94c3f4df8453406c830b0a7df0f2860278`; its rules URL pinned to web-interface-guidelines `434b7f91364665f2f733b310ec54809bf8f37937` instead of `main` |
| 2026-10-06 | builder (proposed, Haider to approve) | Cloud Workflow section 2 setup script: pin `@playwright/cli@0.1.22`, install browsers with `playwright-cli install-browser`, no line can stop a session from starting (`npx playwright@latest install` fetched builds the CLI cannot use) |
| 2026-10-06 | builder | Removed the `allowed-tools` grant from the vendored Playwright skill (it pre-approved `npx playwright`, which runs any code) and pinned its reinstall line to 0.1.22; found by `/security-review` and the advisor. Local skill edits listed in `docs/preflight.md` |
| 2026-10-06 | builder (proposed, Haider to approve) | Tool 1 check against a localhost test page instead of `https://example.com` (Cloud Workflow section 3, row 1): example.com is not on the TopStock network list, and the guardrail says localhost only |
| 2026-10-06 | builder (proposed, Haider to agree) | Tool 5 (web-design-guidelines) verification waived until the Day 1 scaffold: it needs UI code to review |
| 2026-10-06 | builder | Playwright skill: TopStock note tells sessions not to follow the CLI's "reinstall the skill" and update messages (they would restore the removed grant); `npm init playwright@latest` in `references/test-generation.md` replaced by the pinned project install |
