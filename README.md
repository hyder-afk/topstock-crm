# TopStock CRM

Sales CRM and inventory system (IMS) for TopStock Wholesale, a wholesale importer in France. Three people use it to
work a list of leads (pipeline, calls, tasks, files) and to keep stock, holds, sales and client stock links in one
place. Desktop first, fully usable on phones, in English and French.

## Stack

Next.js (App Router) with TypeScript, Tailwind CSS, shadcn/ui on the TopStock tokens, Motion, TanStack
Query/Table/Virtual, React Hook Form + Zod, next-intl, and Supabase (Postgres with row level security, Auth with
TOTP two-factor, Storage). Hosted on Vercel. Tests: Playwright (unit, end-to-end, auth journeys) plus SQL tests for
the database.

## How it is built

The project is built **only in Claude Code cloud sessions** with GitHub, Vercel and Supabase; nothing is built on a
local machine. Every change goes branch, pull request, CI green, Vercel preview, review, then the owner merges.

- `START_HERE.md`: how a session starts and how work is reported.
- `docs/TopStock_CRM_Cloud_Workflow.md`: the cloud-only workflow (it overrides anything that assumes a local Mac).
- `CLAUDE.md`: the project rules. `DESIGN.md`: the design source of truth.
- `docs/TopStock_CRM_Master_Plan.md`: the plan and the security checklist (section 8).
- `docs/go-live.md`: the production checklist. `docs/log.md`: every decision, dated.

`npm run verify` runs lint, typecheck, the native-controls check, unit tests, the build and the end-to-end tests.

## Security

Row level security on every table, deny by default, two-factor for every user and a fresh code for sensitive actions.
Development uses a separate dev project with **fake data only**; production lives in a separate account that the build
sessions never reach. No secrets, keys or real customer data belong in this repository: only the public Supabase URL
and anon key are ever exposed to the browser. Report a security problem to the repository owner privately, not in an
issue.
