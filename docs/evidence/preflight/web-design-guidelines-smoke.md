# web-design-guidelines: smoke run (pre-flight, 6 Oct 2026)

Not the real verification. That runs on the Day 1 scaffold (`/web-design-guidelines src/`).
Rules: `https://raw.githubusercontent.com/vercel-labs/web-interface-guidelines/434b7f91364665f2f733b310ec54809bf8f37937/command.md`
(SHA-256 `d246b026f4f29b5823a9cc857f9edf3d2507002e055e32040cadeaf3b38e0234`, the version pinned in `.claude/skills/web-design-guidelines/SKILL.md`).
Applied by hand to the pre-flight test page, because skills added mid-session load only in a new session.
The test page is throwaway evidence and is not fixed.

## docs/evidence/preflight/test-page.html

docs/evidence/preflight/test-page.html:3 - missing `<meta name="theme-color">` matching page background
docs/evidence/preflight/test-page.html:10 - heading lacks `text-wrap: balance`
docs/evidence/preflight/test-page.html:13 - no `<main>` landmark (semantic HTML first)
docs/evidence/preflight/test-page.html:13 - heading "Playwright pre-flight" not Title Case (guideline is Chicago style; DESIGN.md decides for EN/FR)
docs/evidence/preflight/test-page.html:13 - tool name "Playwright" lacks `translate="no"`
