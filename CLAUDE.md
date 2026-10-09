# TopStock Wholesale CRM + IMS

Sales CRM and inventory for a wholesale importer in France. DESKTOP/MACBOOK FIRST, fully usable on phones.
English + French. Users: Haider, Henri, Kais (all admins; roles admin/manager/rep stay in the schema).
No Google Workspace: no mailbox sync, no calendar sync. Email = open the mail app + one-tap log.

## BUILD MODE: CLOUD ONLY (since 6 Oct 2026)
Built in Claude Code cloud sessions + GitHub + Vercel + Supabase, never on Haider's Mac.
Read docs/TopStock_CRM_Cloud_Workflow.md before any step; it overrides any instruction that assumes his Mac.
Every change: branch -> PR -> CI green -> Vercel preview -> advisor approves -> Haider merges.
Supabase: dev only, fake data; production lives in a separate Supabase account Claude never reaches.

## Stack
Next.js App Router + TypeScript, Tailwind, shadcn/ui, Motion, TanStack Query/Table/Virtual,
React Hook Form + Zod, next-intl, Supabase (Postgres, Auth, RLS, Storage), dnd-kit, Recharts, papaparse.

## Design (TopStock brand, Apple-like behaviour; DESIGN.md is the source of truth)
TopStock Black / Chalk White / greys with Signal Red #F2203E as the single accent (fills only: dock bead, Call, primary button,
logo mark; black text on red). Outfit + DM Mono, self-hosted via next/font (decided by Haider 7 Oct 2026).
Status colours only as tiny dots or labelled badges (text tokens: green #15702F, amber #7C5300, red #B61C29 in light mode). 8pt grid, radius 20/12. Spring animations (transform + opacity
only), respect prefers-reduced-motion. Keyboard-first: Cmd+K palette, shortcuts, context menus.
Split views on desktop. Nav is a floating dock with a draggable bead.
Dashboard greeting: "Hello {first_name}" (FR "Bonjour").
Pipeline stages: Lead > Qualified > Negotiations > Closed/won, plus Closed/lost with a reason.

## Speed and loading
Every route has loading.tsx skeletons matching the final layout; every list has loading/empty/error states;
no spinners. TanStack Query cache + prefetch on hover; optimistic updates with Undo. Budgets: first load < 2 s,
route change < 200 ms, taps acknowledged < 100 ms, 60 fps. Test at 390, 768, 1024, 1280, 1440, 1728.

## Data rules
Never load all leads in the browser: server-side keyset pagination + virtualised rows.
30k leads and stock sheets imported via staging table, dedupe, dry run, rollback by import_batch_id.
Stock levels change only through the post_stock_movement RPC (transaction, row lock, no negative stock,
no over-reservation). Never update stock_levels directly.

## SECURITY (non-negotiable)
- RLS on EVERY table, deny by default. Server-side authz on every route/action; never trust the client.
- TOTP MFA for every user. Step-up MFA (aal2) for stock adjustments, imports, exports, deletes, role changes.
- Zod-validate all input. Whitelist fields on writes (no mass assignment). No dangerouslySetInnerHTML.
- Never interpolate user text into PostgREST .or()/filter strings; use RPC.
- service_role key only in server-only modules and local import scripts. Never in client code or prompts.
- Only NEXT_PUBLIC_SUPABASE_URL and anon key are public. Production source maps off.
- Verify Zoom webhook signatures. Encrypt integration secrets at rest.
- No raw errors to users; no secrets/PII in logs. Security headers + CSP.
- Use the DEV Supabase project with fake data only. Never touch prod data from Claude Code.
- Work on branches, run lint/typecheck/tests + gitleaks + npm audit, run /security-review before merge.
- Full checklist: /docs/TopStock_CRM_Master_Plan.md section 8 (A to F).

## Conventions
No hardcoded strings (messages/en.json, messages/fr.json). Intl for dates/numbers/currency (EUR default).
Loading/empty/error state for every list. Small commits, one feature at a time.
Every UI change: /apple-design audit + Playwright screenshots (see /docs/TopStock_CRM_Tooling_Protocol_Lean.md).

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

## Working with Haider (he works ONLY in Claude Code; there is no separate advisor chat)
- You are builder and project manager. Master Plan section 0 ("instructions for Claude") now applies to you.
- One step at a time, plain language. Before a step: two sentences on what and why. After it: stop and wait.
- Before showing Haider any REPORT or asking him to merge: run the `advisor` subagent (.claude/agents/advisor.md,
  fresh context, read-only) on the step. Fix everything it raises and run it again until it says APPROVED.
  Paste its final verdict into the REPORT. Never call a step done without APPROVED.
- REPORT format: START_HERE.md section H, then a line "What I need from you:" with exact clicks for Haider.
- Haider decides: merges to main, money, anything touching production, deletions, keys, passing a gate,
  scope changes. Ask him in one plain question with your recommendation.
- Things Haider must do himself (web dashboards, secrets, MFA): give numbered click-by-click steps, one at a time.
- Never ask for secrets or real data. Log decisions in docs/log.md. Keep a Progress line (done / now / next) at the
  top of every reply.
