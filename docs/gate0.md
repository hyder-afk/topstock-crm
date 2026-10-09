# Gate 0 checklist (9 Oct 2026)

Gate 0 is defined in three places that do not fully agree:
- Master Plan section 12: MFA on all accounts, private repo, gitleaks installed, dev/prod projects separated.
- START_HERE section E: sign-off table complete, `.gitignore` in place, repo private on GitHub.
- Tooling Protocol section 9: sign-off table complete (5 tools), `DESIGN.md` written, `npm run verify` working, `CLAUDE.md` updated.

| # | Item | Status | How it was checked |
|---|---|---|---|
| 1 | Repo private on GitHub | **Pass** | GitHub API: `hyder-afk/topstock-crm` visibility `private` |
| 2 | `.gitignore` in place | **Pass** | Ignores `node_modules/`, `.next/`, `.env` and `.env.*` (except `.env.example`), `.vercel`, Playwright output, `.DS_Store` |
| 3 | Sign-off table complete (5 tools) | **Pass, one waiver** | `docs/preflight.md`: tools 1 to 4 verified (tool 4 on 9 Oct 2026); tool 5 waived until the Day 1 scaffold by Haider (6 Oct 2026) |
| 4 | gitleaks | **Pass in session; CI on Day 1** | gitleaks v8.30.1 built from source in the session scratchpad (not in the repo): `gitleaks git --redact` (28 commits) and `gitleaks dir --redact`, both "no leaks found". The GitHub Actions job that runs it on every PR is Day 1 work (no CI exists yet) |
| 5 | Dev and prod separated | **Pass (Haider-reported, plus what Claude can see)** | Haider (9 Oct 2026): `topstock-dev` in account A, `topstock-prod` in account B with no access tokens, both Paris. From the session: the MCP token reaches only the dev project URL, has no account tools, and is read-only. Claude cannot see account B, by design |
| 6 | MFA on all accounts | **Haider-reported** | Haider (9 Oct 2026): Supabase A and B, GitHub, Vercel, both mailboxes. Claude cannot check these dashboards. Henri and Kais set theirs up when invited |
| 7 | `DESIGN.md` written, `npm run verify` working, `CLAUDE.md` updated | **Not done: these are Day 1 tasks** | START_HERE section F puts all three inside Day 1 (`DESIGN.md` first, then scaffold, then `npm run verify`). **Haider decides** (recommended: move them to the Day 1 exit check instead of Gate 0) |

## Open issues found on the way (not Gate 0 blockers)

- **Context7 quota.** Context7 answered "Monthly quota exceeded" (free use without a key). It is mandatory before writing library code, so Day 1 needs a free Context7 API key, added by Haider as a second network secret (host `mcp.context7.com`). Steps when he says yes.
- **Open sign-ups on dev** (`disable_signup: false`). Already required off before any app screen ships to production (Cloud Workflow section 6); set from code on Day 1.
- **Supabase MCP not loaded as tools in this session** because `main` lacks the `.mcp.json` entry. Fixed by merging this branch; the next session loads it.
