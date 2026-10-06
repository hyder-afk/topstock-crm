# TopStock Wholesale CRM: Master Plan (v3)

This document replaces the earlier roadmap, design and sprint documents. It is written so it can be pasted or attached into a fresh Claude conversation.

## Changes in v3 (6 October 2026)

Haider answered the section 16 questions. Everything below is updated to match; the answers are recorded in section 16.

| Decision | Effect on the plan |
|---|---|
| **Pipeline stages: Lead → Qualified → Negotiations → Closed/won** (plus Closed/lost with a reason) | Sections 5, 6, 9 Day 5. A deal is opened at "Lead" when a rep marks a lead as interested; the rest of the 30k contacts never appear on the board |
| **Users: Haider, Henri, Kais, all admins** | MFA mandatory for all three. Roles stay in the schema for later hires. Section 8 items 4 and 45 |
| **Hosting: Vercel Pro ($20/month)** | Build on Hobby, upgrade before the first live deploy. Section 3 |
| **Zoom: paid plan, cloud recording and transcripts on** | R3 unchanged. Verify the two Zoom settings before Day 14 |
| **No Google Workspace** | Calendar sync and mailbox integration removed. Email opens the mail app and is logged with one tap. Meetings are dated tasks (Zoom meetings from R3). The former R2 (Calendar) is now **R2: Inventory depth** |
| **TopStock is a wholesale importer in France** (buys its own containers, sells wholesale across Europe, and sources direct for clients as "supply chain as a service"); existing stock sheets to import | IMS is a first-class half of the product: basics in R1 (Day 6), containers, orders and fulfilment in R2. Section 5, 6, 7, 8F, 10 |
| **Markets: UK, US, France, rest of EU** | Work queue hours per lead timezone (section 5). Supabase and Vercel regions in the EU (section 9 Day 0) |
| **Fully responsive, skeleton loaders, very fast, very secure** | Section 4 "Loading, speed and responsiveness"; section 8F; section 13. Every UI change gets an `/apple-design` audit (Tooling Protocol) |
| **Brand still in progress** | Unchanged: tokens first, polish later |
| **R1 is now 8 days** (inventory basics added as Day 6) | Section 9. R2 Days 9 to 13, R3 Days 14 to 21 |


---

## 0. INSTRUCTIONS FOR CLAUDE (read this first)

You are my build advisor and project manager for the **TopStock Wholesale Sales CRM**. I will build it myself using **Claude Code on a MacBook**, with **Supabase, GitHub and Vercel**. Assume I am a sales leader, not a professional engineer, so explain in plain language and give exact copy-paste commands and prompts.

**How to work with me**
1. Read this whole document. Then reply with (a) a 10-line summary of what we are building, and (b) any open questions you still need answered (section 16 lists what was answered on 6 October 2026 and what is still open). Wait for my answers.
2. Then guide me **one step at a time** through Release 1 (section 14). For each step give: the goal, exact commands or the exact Claude Code prompt to paste, what I should see when it works, and a "done when" check.
3. **Wait for me to reply "done" (or paste an error) before giving the next step.** Never dump multiple steps.
4. Enforce the **security gates** (section 12). Do not let me move to the next release until the gate checklist is complete.
5. Keep cost at **$0** unless a cost is flagged in section 3. If a step would cost money, warn me first and offer a free alternative.
6. Prefer the simplest thing that works. If I ask for something that conflicts with this plan (scope, cost, security), say so plainly and propose an option.
7. Keep a running "Progress" list at the top of your replies: done / current step / next.

---

## 1. Product Summary

**Company:** TopStock Wholesale, a wholesale importer based in France. It buys its own containers, lands them in its warehouse and sells wholesale to buyers across Europe; it also sources direct for clients, shipping from the supplier to the client ("supply chain as a service"). **Users:** Haider, Henri and Kais, all admins (the schema keeps admin, manager and rep roles for later hires).

**Purpose:** work a large lead list (about **30,000 leads** from a CSV) efficiently, run deals through a four-stage pipeline, manage stock, inbound containers and orders in an **integrated IMS**, run **Zoom** calls and turn them into **coaching and sales analytics**. No Google Workspace: email opens the user's mail app and is logged in the CRM; there is no mailbox or calendar sync.

**Platform priority**
1. **Desktop / MacBook first** (Safari and Chrome, 1280 to 1728px wide, keyboard and trackpad driven)
2. **Mobile second** (fully usable, installable PWA, but simplified layouts)

**Languages:** English and French.
**Design language:** Apple-like. Black, white and shades of grey. Generous spacing. Spring animations.

**Release plan**
| Release | Contents | Target |
|---|---|---|
| **R1: Core CRM + IMS basics** | Auth, dock navigation, 30k lead import, leads table, work queue, lead detail, tasks, pipeline (4 stages), dashboard ("Hello Haider"), products, locations, stock levels, movements, reservations, stock sheet import, security baseline, backups | Days 1 to 8 |
| **R2: Inventory depth** | Inbound containers, orders and fulfilment (from stock or direct from source), reservations with expiry, low-stock alerts, stock analytics, warehouse mode on phone | Days 9 to 13 |
| **R3: Zoom + Analytics + Coaching** | Zoom integration, transcripts, call metrics, sales analytics, coaching scorecards | Days 14 to 21 |

Honest note: the full scope does not fit in 4 to 7 days. **R1 fits in 8 focused days** and is a usable CRM with basic stock on its own. R2 and R3 follow.

---

## 2. Tech Stack (all free tiers)

| Layer | Choice |
|---|---|
| Build tool | **Claude Code** (Claude Max plan) |
| Code hosting / CI | **GitHub** (private repo, Actions) |
| Frontend + API | **Next.js (App Router) + TypeScript** on **Vercel** |
| Database, Auth, Storage | **Supabase** (Postgres, Auth with TOTP MFA, Storage, RLS) |
| UI | Tailwind, shadcn/ui (Radix), Lucide icons |
| Animation | **Motion** (Framer Motion), spring physics |
| Tables | TanStack Table + TanStack Virtual (virtualised rows) |
| Data fetching | TanStack Query, Server Actions / Route Handlers |
| Forms & validation | React Hook Form + **Zod** (server-side too) |
| Drag & drop | dnd-kit (Kanban), Motion (dock) |
| i18n | next-intl (EN / FR) |
| Charts | Recharts (monochrome styling) |
| Inventory (IMS) | Postgres tables, one transactional RPC for every stock movement, papaparse for CSV import; .xlsx through SheetJS community edition (check the licence) or ask for CSV exports |
| Zoom | Zoom Server-to-Server OAuth app + webhooks |
| PWA | Serwist |
| Security tooling | gitleaks, npm audit, Dependabot, Semgrep OSS, Claude Code `/security-review` |
| Errors / monitoring | Vercel + Supabase logs, GitHub Actions health check (Sentry free tier optional, check its terms) |

---

## 3. Zero-Cost Reality Check (important)

Verified against current published terms (September 2026). Confirm again before going live.

| Item | Reality | What to do |
|---|---|---|
| **Vercel Hobby (free)** | **Non-commercial use only.** Vercel's terms say commercial use requires Pro ($20/user/month). TopStock is a company, so production on Hobby breaks their terms and risks suspension. | **Decided 6 Oct 2026: Vercel Pro ($20/month, one seat).** Build and preview on Hobby, upgrade the project to Pro before the first live deploy (Day 8). |
| **Supabase Free** | 500 MB database, 1 GB file storage, 5 GB egress, 2 projects. **Pauses after 7 days of inactivity.** **No daily backups** (paid feature). | 30,000 leads fit comfortably. Add a keep-alive ping and our own backups (section 12). Use the 2 projects as **dev** and **prod**. Upgrade to Pro ($25/month) when convenient. |
| **Zoom transcripts** | Cloud recording and audio transcripts require a **paid Zoom plan** (Pro, Business, Education or Enterprise). Cannot be tested on free Zoom. | Haider confirmed a paid plan with cloud recording and transcripts (6 Oct 2026). Before Day 14, check in Zoom web settings that "Cloud recording" and "Audio transcript" are on for the account. |
| **Claude API** | Claude Max does **not** include API credits, so the app cannot call Claude live for free. | AI coaching runs **from Claude Code on your Mac** as a manual batch command (section 11). The app itself uses free rule-based metrics. |
| **Google Workspace** | **Not used by TopStock (6 Oct 2026).** Calendar sync and mailbox integration are out of scope. | Email: the CRM opens the user's mail app (`mailto:`) and logs the email with one tap. Meetings: dated tasks, plus Zoom meetings from R3. If the company uses Microsoft 365, its Graph API is the free equivalent for a later release. |
| **GitHub Free** | Private repos allowed. Some features (secret scanning push protection, branch protection) may be limited on private free repos. | Use gitleaks + PR discipline + CI checks. |
| **Custom domain** | A domain costs money. `*.vercel.app` is free. | Optional. |
| **Claude Max usage** | Heavy building uses your usage allowance. | Work in focused sessions, commit often, keep `CLAUDE.md` tight. |

---

## 4. Desktop-First Design System

### Principles
Clarity, deference, depth. Content first. One primary action per screen. Everything reachable by keyboard.

### Viewports (design at 1440, test all)
| Device | Effective width |
|---|---|
| MacBook Air 13" | 1440 x 900 |
| MacBook Pro 14" | 1512 x 982 |
| MacBook Pro 16" | 1728 x 1117 |
| Small laptop | 1280 x 720 |
| External monitor | 1920 to 2560 |
| Minimum supported desktop | 1024 |
| Mobile | 375 to 430 |

Content max width 1440px on ultra-wide with generous side margins. Multi-pane layouts on desktop, stacked on mobile.

### Colour tokens
| Role | Light | Dark |
|---|---|---|
| Background | #FFFFFF | #000000 |
| Surface | #F5F5F7 | #1C1C1E |
| Surface elevated | #FFFFFF + 1px border | #2C2C2E |
| Border | #D2D2D7 | #3A3A3C |
| Text | #1D1D1F | #F5F5F7 |
| Text muted | #6E6E73 | #98989D |
| Primary button | #1D1D1F | #FFFFFF |

Status colours only as tiny dots or badges: success #30D158, warning #FF9F0A, danger #FF453A, info/focus #0A84FF. Follow system light/dark with manual toggle.

### Type
`-apple-system, "SF Pro Display", "SF Pro Text", Inter, system-ui`. Scale: 34/40 large title, 28 title, 22 card header, 17 headline, 15 body (desktop), 13 footnote, 12 caption. Tabular numbers for money and counts. French runs about 20% longer: never fix label widths.

### Spacing and shape
8pt grid. Card radius 20, controls 12, sheets 28. Page padding 32 desktop, 16 mobile. Borders and tone for depth, shadow only on floating layers. Glass (`backdrop-filter: blur(20px)` with `-webkit-` prefix for Safari) on dock and popovers.

### Desktop interaction standards
- **Command palette** `Cmd+K`: jump to any lead, create anything, switch language/theme
- **Keyboard shortcuts** (shown with `?`): `Cmd+1..7` switch sections, `N` new lead, `T` new task, `J/K` move in lists, `Enter` open, `Esc` close, `/` focus search, `G then L` go to leads
- **Tables:** virtualised, resizable and reorderable columns, column chooser, density toggle (comfortable/compact), sticky header, shift-click multi-select, bulk actions bar, saved views
- **Right-click context menus** on rows and cards
- **Hover states and tooltips** everywhere (desktop only), focus rings for keyboard
- **Trackpad:** two-finger horizontal swipe scrolls Kanban columns and wide tables, smooth momentum scroll
- **Drag and drop:** Kanban cards between stages (spring settle, Undo toast)
- **Split view:** list on the left, detail on the right (Apple Mail style) for leads
- **Safari checks:** `-webkit-backdrop-filter`, `100dvh`, date inputs, scroll snapping

### Motion (spring physics)
```ts
export const springs = {
  snappy: { type: "spring", stiffness: 400, damping: 30 },
  smooth: { type: "spring", stiffness: 300, damping: 30 },
  sheet:  { type: "spring", stiffness: 260, damping: 32 },
  gentle: { type: "spring", stiffness: 180, damping: 24 },
  bead:   { type: "spring", stiffness: 380, damping: 30, mass: 0.9 },
};
```
Animate only `transform` and `opacity`. Press scale 0.97. Page enter fade + 8px rise. List stagger 30ms. Skeletons not spinners. Everything interruptible. Respect `prefers-reduced-motion`. Target 60fps.

### Loading, speed and responsiveness (added v3)
Haider's requirement: fully responsive, skeleton loaders, very fast.
- **Skeletons, never spinners.** Every route has a `loading.tsx` skeleton that matches the final layout (same card sizes, same row heights) so content replaces it without a jump. Every list and card has loading, empty and error states. Show a skeleton at once when there is no cached data; when cached data exists, show it at once and refresh in the background.
- **Budgets:** first load under 2 s on Wi-Fi, route change under 200 ms perceived, every tap acknowledged within 100 ms (press state), scrolling and dragging at 60 fps, no layout shift, Lighthouse 90+ on Home, Leads and Inventory.
- **How:** Server Components for first paint, TanStack Query cache with prefetch on hover and on dock focus, keyset pagination, virtualised tables, optimistic updates with Undo, space reserved for badges and avatars, system font stack (no web font download), Supabase and Vercel regions both in the EU.
- **Responsive matrix:** 375 to 430 phone (stacked, 5-item dock, horizontal snap for Kanban columns and tab strips), 744 to 1023 tablet (two columns), 1024 and up desktop (split views, 7-item dock), content max 1440 on wide monitors. Test every UI change at **390, 768, 1024, 1280, 1440 and 1728**, light and dark, EN and FR; no horizontal page scroll at any width.
- **Prototype reference (v3.2):** skeletons on first visit to each section, sliding tab indicator, Kanban columns that snap on phone, call panel that can be dragged away.

### Navigation: the dock (Meniscus-style)
A floating rounded dock, **bottom-centre on all screen sizes**, with a **bead** sitting in a **notch** cut into the bar. Tap a tab or **drag the bead** along the bar.

| Behaviour | Spec |
|---|---|
| Shape | One SVG path with the socket built in; notch shape derived from bead x and velocity |
| Drag | `drag="x"` on the bead, `touch-action: none`, constrained to the bar, elastic 0.05 |
| Stretch | Normalised velocity (-1..1). Trailing shoulder widens about 40%, leading tightens about 20% |
| Release | Snap to nearest tab using velocity projection, `bead` spring with tiny overshoot |
| Live preview | Tab under bead highlights during drag; route changes on release |
| Feedback | `navigator.vibrate(8)` on snap where supported |
| Bead colour | Monochrome (white on dark, black on light) |
| Keyboard | Arrows move, Enter activates, `role="tablist"`, `Cmd+1..7` |
| Reduced motion | No stretch, simple fade |
| Desktop items (7) | Home, Leads, Pipeline, Inventory, Tasks, Analytics, More |
| Mobile items (5) | Home, Leads, Pipeline, Inventory, More |
| Desktop extras | Labels on hover, tooltips with shortcut, optional slim top bar with search and profile |

Starter path function (Claude Code should refine visually):
```ts
export function dockPath(W:number,H:number,r:number,cx:number,depth:number,hw:number,lean:number){
  const k=18;
  const sL=hw*(1+(lean>0?0.4*lean:0.2*lean));
  const sR=hw*(1+(lean<0?0.4*-lean:-0.2*lean));
  return [`M ${r},0`,`H ${cx-sL-k}`,
    `C ${cx-sL},0 ${cx-sL*0.7},${depth} ${cx},${depth}`,
    `C ${cx+sR*0.7},${depth} ${cx+sR},0 ${cx+sR+k},0`,
    `H ${W-r}`,`Q ${W},0 ${W},${r}`,`V ${H-r}`,`Q ${W},${H} ${W-r},${H}`,
    `H ${r}`,`Q 0,${H} 0,${H-r}`,`V ${r}`,`Q 0,0 ${r},0`,`Z`].join(" ");
}
```
Timebox the dock to 3 hours: ship tap + drag + snap first, velocity stretch second.

### Dashboard greeting
Top of Home: small date line, then large title **"Hello Haider"** ("Bonjour Haider" in French). The name comes from the logged-in profile's first name. "Hello" in muted grey, name in primary text. Words fade up with 60ms stagger and a slight blur-to-sharp effect. One calm line beneath: "You have N tasks today and M meetings."

---

## 5. Information Architecture and Screens

**Home (dashboard):** greeting, today's meetings, tasks due, "Work queue" shortcut, pipeline snapshot, KPI cards (count-up numbers), recent activity.

**Leads:** split view. Left: virtualised table with search, filters (status, country, source, owner, import batch, last contacted, timezone), saved views. Right: lead detail preview. Bulk actions.

**Work Queue (key feature for a 30k list):** "Up next" card with one lead at a time, ordered by priority and by **whether it is a sensible hour in the lead's timezone**. One-key outcomes: No answer, Voicemail, Wrong number, Not interested, Interested (creates task), Book meeting. Auto-advances to the next lead. Shows script and last notes.

**Lead detail (like the reference screenshot):** header (avatar, name, role, company, phone, email, temperature, owner, local time), quick actions (call, WhatsApp, email through the mail app with one-tap logging, Zoom meeting from R3, note), tabs (Summary, Timeline, Deals, Stock, Files, Details), deal card, next task, activity composer.

**Pipeline:** Kanban of **deals** (not all 30k leads). Stages (Haider, 6 Oct 2026): **Lead → Qualified → Negotiations → Closed/won**, plus **Closed/lost** with a reason. A deal is opened at "Lead" when a rep marks a lead as interested from the work queue or the lead page; the other contacts stay in the leads table with a `lead_status` and never appear on the board. Stage totals, days in stage, stalled-deal warning, drag with spring settle, Won/Lost flow with reason.

**Tasks:** Overdue, Today, Upcoming, Done. Quick add with date chips.

**Inventory (IMS):** basics in R1, depth in R2 (section 10). Screens: Stock (products × locations with on hand, reserved, available, status), Inbound containers (supplier, container number, ETA, status, lines), Movements (append-only log with who, when, why), Orders and fulfilment (from stock or direct from source), Settings for units and locations. Every lead has a Stock tab showing what they want and what is available.

**Analytics + Coaching (R3):** section 11.

**Settings:** profile, language, theme, pipeline stages, team and roles, units and locations, integrations (Zoom), security (MFA), data export, import history.

---

## 6. Data Model

Core (R1)
- **profiles** (id = auth user, first_name, last_name, role [admin/manager/rep], language, timezone)
- **companies** (id, name, website, country, industry)
- **contacts** (id, company_id, first_name, last_name, title, email, phone_e164, whatsapp, country, city, timezone, source, lead_status [new/contacted/interested/not_interested/do_not_contact/customer, confirm with Haider], temperature, owner_id, do_not_contact, last_contacted_at, next_action_at, import_batch_id, created_at)
- **pipeline_stages** (id, name, position, is_won, is_lost): seeded with Lead (1), Qualified (2), Negotiations (3), Closed/won (4, is_won), Closed/lost (5, is_lost)
- **deals** (id, contact_id, company_id, stage_id, value, currency [EUR default], expected_close, owner_id, status, lost_reason, fulfilment [from_stock/direct_from_source], stage_entered_at)
- **activities** (id, contact_id, deal_id, type [call/email/whatsapp/meeting/note], outcome, body, user_id, created_at)
- **tasks** (id, contact_id, deal_id, title, due_at, done_at, assignee_id)
- **files** (id, contact_id, storage_path, mime, size)
- **import_batches** (id, filename, uploaded_by, row_count, imported, duplicates, rejected, status, created_at)
- **saved_views** (id, user_id, section, filters_json)
- **audit_log** (id, actor_id, action, table_name, record_id, diff_json, ip, created_at): append-only

Inventory, R1 basics
- **products** (id, sku, name, category, unit, units_per_carton, cartons_per_pallet, cost_price, sell_price, currency, reorder_point, supplier_id, active)
- **locations** (id, name, type [warehouse/transit/supplier], address)
- **stock_levels** (product_id, location_id, on_hand, reserved; available = on_hand − reserved; **written only by the `post_stock_movement` function**)
- **stock_movements** (id, product_id, location_id, type [receive/ship/adjust/reserve/release/transfer], qty_units, reference_type [deal/order/inbound/import/manual], reference_id, reason, user_id, created_at): append-only
- **stock_import_staging** and reuse of **import_batches** for stock sheets

Inventory, R2
- **suppliers** (id, name, country, contact, lead_time_days)
- **inbound_shipments** (id, supplier_id, container_no, size, etd, eta, status [ordered/in_transit/customs/received], location_id, received_at), **inbound_lines** (shipment_id, product_id, qty_cartons, unit_cost)
- **orders** (id, deal_id, contact_id, fulfilment [from_stock/direct_from_source], status, currency, total), **order_lines** (order_id, product_id, qty_units, unit_price), **shipments** (order_id, carrier, tracking, from_location_id or supplier_id, status)

Zoom / analytics (R3): **meetings** (zoom_meeting_id, host_id, contact_id, deal_id, start, duration, recording_share_url), **transcripts** (meeting_id, segments_json, full_text), **call_metrics** (meeting_id, rep_talk_pct, longest_monologue_s, questions_asked, filler_count, interruptions, wpm, next_step_set, objections_json), **rubrics**, **coaching_reviews** (meeting_id, reviewer_id, source [manager/ai/rules], scores_json, comments_json with timestamps, status), **targets** (user_id, period, metric, value)

Design rules: UUID primary keys, `created_at`/`updated_at`, `org_id` on every table for future isolation, foreign keys, RLS on all tables.

---

## 7. Importing 30,000 Leads

### Before import (do in Excel/Sheets or with Claude Code)
1. Save as **UTF-8 CSV** with one header row.
2. Map columns to the fields in section 6. Decide the **source** label and **batch name**.
3. Clean: trim spaces, lowercase emails, remove obvious junk rows, standardise country names.
4. Phones to **E.164** (`+92...`, `+33...`, `+1...`). Claude Code can do this with a script (`libphonenumber`).
5. Make a **500-row sample with fake or anonymised data** for testing. **Never put the real list into the dev project.**

### Import pipeline (built in R1, Day 3)
1. Upload/parse in a **local script on your Mac** (or an admin-only page), using `\copy` or the Supabase client with the service key **kept on your Mac only**.
2. Load into a **staging table** (`lead_import_staging`), tagged with an `import_batch_id`.
3. **Validate:** required fields, email format, phone parse, country code, length limits. Rejected rows go to a downloadable "rejects" CSV with reasons.
4. **Dedupe:** by lowercase email, then by phone, then by company domain + name. Duplicates are merged or skipped per rule; counts shown.
5. **Dry run** mode: show "would import X, skip Y, reject Z" before writing.
6. **Upsert** into `companies` and `contacts` in chunks of 1,000.
7. **Assign owners:** round-robin, by country/territory, or unassigned (choose in the batch settings).
8. **Set timezone** from country (and city where present) so the work queue respects local hours.
9. Record results in `import_batches`. **Rollback** = delete by `import_batch_id`.
10. Log the import in `audit_log`.

### Stock sheets (IMS, R1 Day 6)
Same pattern, smaller scale: staging table, validation (known SKU or "create product" flag, integer quantities, known location, units per carton present), dedupe by SKU, dry run with "would create X products, set Y stock levels, reject Z rows", write through `post_stock_movement` (type `receive`, reference `import`), rollback by batch. Haider will send the **header row plus 3 fake rows** of each stock sheet; build a column-mapping step so a different header does not need code changes.

### Performance for 30k rows
- Never load all leads in the browser. **Server-side pagination (keyset)**, filters and sort in SQL.
- Virtualised rows (TanStack Virtual). Debounced search.
- Indexes: btree on `(owner_id, lead_status)`, `(next_action_at)`, `(import_batch_id)`, `(country)`, unique partial on lower(email); **pg_trgm GIN** on name/company/email for fuzzy search; optional `tsvector` full-text.
- Expected size: roughly 30 to 60 MB with indexes, far below the 500 MB free limit. Keep files and transcripts out of the DB where possible.

### Compliance (not legal advice)
You sell into the EU/UK and US. Cold B2B outreach has rules (GDPR/PECR, CAN-SPAM, calling and recording consent). Keep `do_not_contact` and `source` fields, honour opt-outs immediately, record where each lead came from, and tell people when calls are recorded. Consider a short legal check for EU outreach.

---

## 8. Security Checklist (all 54 items mapped to this project)

Source: the 54-item "vibe-coded app" vulnerability list you shared. Every item has a control and a way to verify. Claude Code must treat this as a **hard requirement**, and I will run each gate before launch.

### A. Secrets and configuration (items 1 to 3, 10 to 14, 29, 30, 35, 36, 45)
| # | Risk | Control | Verify |
|---|---|---|---|
| 1 | Exposed DB credentials | DB URL and service key only in server env vars, never in client code | Search built JS for `service_role` and `postgres://` |
| 2 | Public .env files | `.env*` in `.gitignore`, nothing secret in `/public` | `git ls-files | grep env`; request `/.env` on prod returns 404 |
| 3 | Hardcoded secrets | All secrets from env vars, `.env.example` with fake values | gitleaks in pre-commit and CI |
| 10 | Exposed prod debug tools | No debug routes, no test pages in prod, disable unused Supabase APIs (e.g. GraphQL) | Crawl routes list before launch |
| 11 | Logs leak secrets | Central logger with redaction, never log tokens, keys, full request bodies | Grep code for `console.log` |
| 12 | Verbose prod errors | Generic error messages to users, details only in server logs | Trigger errors on prod, check output |
| 13 | Secrets in git | gitleaks scan of full history before first push; rotate anything leaked | `gitleaks detect` clean |
| 14 | Secrets in JS | Only `NEXT_PUBLIC_SUPABASE_URL` and anon key are public; audit all `NEXT_PUBLIC_*` | Inspect the production JS bundle |
| 29 | Exposed environments | Separate Supabase **dev** and **prod** projects; preview deployments behind Vercel deployment protection; no real data in dev/preview | Open a preview URL logged out |
| 30 | Default credentials | No seeded admin accounts in prod, remove test users, rotate all initial passwords | Review auth users list |
| 35 | Exposed logs | Vercel/Supabase log access restricted to admins; no PII in logs | Check team members |
| 36 | Exposed source maps | Production browser source maps **off** | DevTools Sources on prod shows no original code |
| 45 | Exposed internal dashboards | Admin pages need role check **plus MFA**; MFA on GitHub, Vercel, Supabase and Zoom accounts | Try admin URLs as a rep and logged out |

### B. Authentication, sessions and access control (items 4 to 9, 15, 24 to 27, 33, 41, 47, 49, 54)
| # | Risk | Control | Verify |
|---|---|---|---|
| 4 | Weak auth | **Invite-only** (public signup off), email domain allowlist, strong password rules, **TOTP MFA required for every user** (all three current users are admins) | Attempt signup with a random email; log in without MFA, expect the enrolment wall |
| 5 | Missing authorisation check | Check role and ownership **on the server and in RLS** for every read/write | Two-user test (below) |
| 6 | Cross-user access | RLS: reps see only their records, managers/admins see all | Two-user test |
| 7 | Open DB permissions | **RLS enabled on every table (deny by default)**; revoke default grants from `anon`; views use `security_invoker` | Supabase Security Advisor clean; curl every table with anon key |
| 8 | Cloud service misconfig | Private storage buckets with signed URLs; Supabase Advisors run; Vercel settings reviewed | Advisor report |
| 9 | Unprotected admin route | Guard in middleware **and again in each page/route handler** (never rely on middleware alone); keep Next.js updated | Direct-URL test as non-admin |
| 15 | Client-only security | Every rule enforced server-side and in RLS; UI hiding is cosmetic | Call API directly with a rep token |
| 24 | Broken password reset | Use Supabase Auth flows only; allowlist redirect URLs; generic "if the account exists" messages; rate limits | Try reset for unknown email, expired link |
| 25 | Weak session management | Short access token lifetime, refresh rotation, sign-out-everywhere, idle timeout (where the plan supports it), `@supabase/ssr` cookies | Log out on device A, confirm device B behaviour |
| 26 | JWT secrets | No custom JWTs; keep Supabase JWT signing secrets server-side; rotate if ever exposed | Grep repo for JWT secret |
| 27 | Permissive CORS | No `*`; API routes same-origin only | Cross-origin fetch test |
| 33 | IDOR / BOLA | Every request with an ID checks ownership via RLS; UUIDs; tests | Change IDs in URLs as another user |
| 41 | Excessive DB permissions | Least privilege: `service_role` used only in isolated server-only modules (Zoom webhook, cron) and on your Mac for imports | Grep `service_role` usage |
| 47 | Insecure cookie settings | `Secure`, `HttpOnly`, `SameSite=Lax`, `__Host-` prefix where possible | DevTools > Cookies |
| 49 | Poor tenant isolation | `org_id` on every table, RLS filters by org and owner | Two-org test with fake data |
| 54 | Misconfigured OAuth | Zoom Server-to-Server OAuth only (no user-facing OAuth flow in R1 to R3): minimal scopes, account credentials in server env vars, access tokens cached server-side and never sent to the browser, rotate when staff change | Review the Zoom app's scopes and where its secret lives |

### C. Input handling and injection (items 16 to 23, 34, 51 to 53)
| # | Risk | Control | Verify |
|---|---|---|---|
| 16 | Input validation | **Zod schema on every** route handler and server action; length and type limits | Fuzz forms with long/odd input |
| 17 | SQL injection | Supabase client and parameterised queries only; raw SQL only in migrations; RPC functions take typed params | Review any `sql` strings |
| 18 | NoSQL injection | N/A (Postgres) but **JSONB filters and PostgREST `.or()` strings are injectable if you interpolate user text**: never build filter strings from raw input, use RPC for search | Test search box with `),id.eq.` style input |
| 19 | XSS | React escaping, **no `dangerouslySetInnerHTML`**, notes/transcripts rendered as text, strict **CSP** | Paste `<script>` and `<img onerror>` in every text field |
| 20 | CSRF | SameSite cookies, Server Actions origin checks, state-changing routes POST only with Origin check | Cross-site form POST test |
| 21 | Insecure file uploads | Allowlist types (pdf, png, jpg, docx, xlsx), size limit, magic-byte check, random filenames, **no SVG/HTML**, private bucket | Upload renamed `.exe`/`.html` |
| 22 | Path traversal | Storage paths generated server-side (UUID), never from user input | Upload `../../x` filename |
| 23 | SSRF | No server-side fetching of user-supplied URLs; if needed, allowlist hosts and block private IP ranges (Zoom downloads only from zoom.us domains) | Review all `fetch` calls |
| 34 | APIs + user input | Same as 16, plus output encoding and response field whitelists | Contract tests |
| 51 | Mass assignment | Explicit field whitelists; never spread request body into a DB write; users cannot write `role`, `owner_id`, `org_id` | Send extra JSON fields |
| 52 | Command injection | No `child_process`/shell with user input | Grep for `exec`, `spawn` |
| 53 | Insecure deserialisation | JSON only, parsed through Zod; never `eval`/`Function`; CSV parsed with a safe library and row limits | Review parsers |

### D. Abuse, webhooks, headers and data protection (items 28, 31, 32, 46, 48)
| # | Risk | Control | Verify |
|---|---|---|---|
| 28 | Rate limits | Supabase Auth built-in limits; Postgres counter table for API/search/import/webhook limits; Vercel firewall rules (Hobby allows a few custom rules) | Hammer endpoints, expect 429 |
| 31 | Unsigned webhooks | **Zoom:** answer `endpoint.url_validation`, verify `x-zm-signature` (HMAC-SHA256 of `v0:{timestamp}:{body}` with the secret token), reject timestamps older than 5 minutes, dedupe by event id | Send forged webhook, expect 401 |
| 32 | Frontend payment checks | N/A in R1 (no payments). If quotes/orders are added later, all prices and totals are computed server-side | n/a |
| 46 | Missing security headers | CSP (nonce-based), HSTS, `frame-ancestors 'none'`, `X-Content-Type-Options`, `Referrer-Policy`, `Permissions-Policy` | securityheaders.com or DevTools |
| 48 | Unencrypted data | TLS everywhere, Supabase encryption at rest, **extra encryption (Supabase Vault or AES-GCM) for integration secrets and cached tokens (Zoom)** | Check DB column contents |

### E. Supply chain, code quality, AI and operations (items 37 to 40, 42 to 44, 50)
| # | Risk | Control | Verify |
|---|---|---|---|
| 37 | Vulnerable dependencies | `npm audit` in CI, Dependabot alerts, monthly update day | CI green |
| 38 | Malicious packages | Commit lockfile, `npm ci`, minimal dependencies, review every new package name (typosquats), `npm audit signatures` | Dependency list review |
| 39 | Prompt injection | Transcripts and notes are **untrusted text** (prospects speak in them). AI coaching only reads text and writes text into review tables. **No tools, no actions, no secrets** in that run. Output is labelled "AI draft" until a manager approves | Add "ignore previous instructions" to a test transcript |
| 40 | Unpermissioned AI access | Never give Claude Code production credentials. Use the **dev** project. If using the Supabase MCP, scope it to dev and read-only. Keep prod service key out of the repo and out of prompts | Review MCP config |
| 42 | Missing audit logs | Append-only `audit_log` via DB triggers: imports, exports, role changes, deletes, logins, integration connects | Perform actions, check log |
| 43 | No security monitoring | Daily SQL digest: failed logins, role changes, exports, bulk deletes; Vercel/Supabase logs; GitHub Actions health check that emails on failure | Trigger a failed login, see it |
| 44 | No backups/restore | Scheduled **GitHub Action** runs `pg_dump`, encrypts it, stores as private artifact; plus monthly dump to your Mac; **quarterly restore test into the dev project**. A cron **keep-alive** prevents the free-tier 7-day pause | Do a real restore once in R1 |
| 50 | Unreviewed code | Work on branches and pull requests; CI must pass (lint, typecheck, tests, gitleaks, audit); run Claude Code `/security-review` and a second-session review before merging; Vercel deploys prod from `main` only | PR history |

### F. Inventory controls (added v3)
| # | Risk | Control | Verify |
|---|---|---|---|
| F1 | Stock changed outside the rules | Stock levels change only through one transactional Postgres function (`post_stock_movement`); table grants allow no direct update of `stock_levels` | Direct update as a user is refused; the function rejects negative stock and over-reservation |
| F2 | Silent stock edits | Every movement is an append-only row with user, reason and reference; `audit_log` trigger on movements, adjustments and imports | Adjust stock, read the log |
| F3 | Risky admin actions from a stolen session | Step-up MFA (Supabase `aal2` within the last 10 minutes) for stock adjustments, imports, exports, bulk deletes and role changes | Try with an `aal1` session, expect refusal |
| F4 | Bad stock sheet | Import validation (known SKU or create flag, integer quantities ≥ 0, known location, row limit), dry run before write, rollback by batch | Import a sheet with a negative and a text quantity |
| F5 | Two users reserving the same last cartons | Row lock inside the function (`SELECT ... FOR UPDATE`) | Two parallel reservations: exactly one succeeds |

### Account hardening (do on Day 0)
Turn on **MFA/passkeys** for GitHub, Vercel, Supabase, Zoom admin and each person's email account (Haider, Henri, Kais). A stolen account beats every code-level control. Use a password manager. Never paste secrets into chat.

### Two-user attack test (before every release)
1. Create **Rep A**, **Rep B** and **Admin** in dev with fake data.
2. As Rep A, copy a lead/deal/task/file ID belonging to Rep B and try to read, edit, delete it via the UI, via direct URL and via direct API calls.
3. Call every table with only the **anon key** using curl; expect empty or denied.
4. Try to change your own `role` or `owner_id`.
5. Send oversized, malformed and script-laden input to every form.
6. Upload a disguised file.
7. Hit login/reset/search 100 times quickly; expect throttling.
8. Try to update `stock_levels` directly and to reserve more than is available; both must be refused.

### If a secret leaks
Rotate immediately (Supabase keys, Zoom secret, Vercel env), redeploy, check `audit_log` and provider logs, purge from git history, and note it in an incident log.

---

## 9. Release 1: Core CRM + IMS basics (Days 1 to 8)

**Day 0 (prep, 1 to 2 hours)**
- Create GitHub (private repo `topstock-crm`), Supabase **two projects** (`topstock-dev`, `topstock-prod`) in an **EU region (Paris `eu-west-3` or Frankfurt `eu-central-1`)**, Vercel account with the function region set to match (`cdg1` or `fra1`). Users are in France and a region cannot be changed later without a migration.
- Turn on MFA everywhere. Install Node, Git, Claude Code on the Mac.
- Put this plan, your reference screenshots and `CLAUDE.md` in `/docs`.
- Pipeline stages and users are confirmed (6 Oct 2026, section 16). Ask Haider for the CSV header plus 3 fake rows and the stock sheet header plus 3 fake rows.
- Prepare the CSV cleaning and the 500-row fake sample.

**Day 1: Foundation and security baseline**
Scaffold Next.js, Tailwind, shadcn, next-intl (EN/FR), Motion. Design tokens and dark/light. Database schema, **RLS on every table**, invite-only auth, MFA, profiles/roles, `audit_log` triggers. Security headers and CSP. CI: lint, typecheck, gitleaks, npm audit. Pre-commit hook.

**Day 2: App shell and dock**
Desktop-first layout, **dock navigation with drag bead**, page transitions, command palette (`Cmd+K`), shortcut system, greeting header. Test in Safari and Chrome at 1280, 1440, 1728.

**Day 3: Leads and import**
Virtualised leads table (server pagination, filters, saved views, bulk actions, column chooser), split-view preview, search indexes. **Import pipeline** tested with the 500-row fake sample (dry run, rejects, dedupe, rollback).

**Day 4: Lead detail, timeline, tasks, work queue**
Lead detail page matching the reference, activity composer, notes, files (secure upload), tasks, **Work Queue** with one-key outcomes and timezone awareness.

**Day 5: Pipeline and dashboard**
Kanban with dnd-kit and spring settle using the four stages, deals opened from the work queue, Closed/won and Closed/lost flow with reason, days in stage and stalled warning. Home dashboard with "Hello Haider", KPI cards, today lists, low-stock card.

**Day 6: Inventory basics**
Products (units per carton, cartons per pallet, reorder point), locations, stock levels, `post_stock_movement` function with its checks, reservation from a deal, Inventory page (stock table, inbound list read-only, movements, reserved for deals), lead Stock tab. **Stock sheet import** with the same staging, dry run and rollback pattern, tested with a fake sheet.

**Day 7: Security gate 1 and polish**
Run the full checklist in section 8 (A to F), two-user attack test, `/security-review`, Supabase Security Advisor. French pass. Mobile pass (PWA manifest, bottom dock 5 items). Skeleton, empty and error states on every list. Animation polish with an `/apple-design` audit. Accessibility pass.

**Day 8: Go live**
Upgrade the Vercel project to Pro. Deploy prod, enable backup and keep-alive Actions, do one restore test. **Import the real 30,000 leads into prod** (dry run first, then full) and the real stock sheets. Invite Henri and Kais; all three enrol MFA. Buffer for fixes.

**If you truly only have 4 days:** do Days 1 to 4 fully, compress Day 5 to "pipeline + basic dashboard", run a shortened security gate, and go live with import. Defer French polish, PWA offline, saved views and bulk actions, and move inventory basics to the start of R2.

---

## 10. Release 2: Inventory depth (Days 9 to 13)

**Goal:** the IMS half of "CRM + IMS". TopStock buys its own containers, lands them in its French warehouse and sells wholesale across Europe; it also sources direct for clients ("supply chain as a service"), where goods ship from the supplier to the client and never touch the warehouse. R1 ships the basics (products, locations, stock levels, movements, reservations, stock sheet import); R2 adds the flows around them.

### Features
- **Inbound containers:** supplier, container number, size, ETD and ETA, status (ordered → in transit → customs → received), lines (product × cartons). "Receive" posts all stock movements in one transaction and closes the container. Landed cost per unit (optional).
- **Orders and fulfilment:** an order is created from a Closed/won deal with lines. Fulfilment is **from stock** (reserve → pick → ship, movements posted) or **direct from source** (supplier shipment tracked, no stock movement). Status timeline on the deal and on the order.
- **Reservations:** reserve stock for a deal in Negotiations; release on Closed/lost or when the reservation expires; "Reserved for deals" on the lead's Stock tab and on the Inventory page.
- **Low stock and alerts:** reorder point per product; Home card "Stock low: X products, Y deals waiting"; inbound ETA shown next to the shortfall.
- **Stock analytics:** stock value at cost, sell-through per product and per container, days of cover, dead stock (no movement for N days), reserved vs available.
- **Units:** each product carries unit, units per carton and cartons per pallet; quantities are entered in cartons or pallets, stored in units, shown in the user's preferred unit.
- **Warehouse mode on phone:** receive and adjust stock with large controls (barcode scanning later).

### Rules
- Stock levels change **only** through `post_stock_movement`, which runs in a transaction, locks the row, rejects negative stock and over-reservation, and writes the movement and the audit row together. The API never updates `stock_levels` directly.
- Every movement has a type, a quantity, a reference (deal, order, container, import or manual) and the user. Adjustments require a reason.
- Stock sheet import follows the staging, validation, dry run and rollback pattern of section 7.

### Security gate 2
Stock RLS (all three admins see everything today, policies still written per role), RPC-only writes proven (a direct update as a user is refused), no negative stock and no over-reservation under concurrent requests (two parallel reservations for the last cartons: exactly one succeeds), import validation and rollback, two-user test on stock, orders and containers, `/security-review`.

---

## 11. Release 3: Zoom, Sales Analytics and Coaching (Days 14 to 21)

### Zoom integration
- Create a **Server-to-Server OAuth** app in the Zoom Marketplace (for your own account, no public review)
- Scopes: cloud recording read, meeting read/write (for creating meetings); nothing broader
- Subscribe to `recording.completed` and `recording.transcript_completed` webhooks
- Webhook endpoint: answer `endpoint.url_validation`, **verify signature and timestamp**, dedupe by event ID
- On transcript ready: fetch the VTT transcript, parse speakers and timestamps, store text and segments. **Store a link to the recording, not the video** (saves the 1 GB storage)
- Match meeting to lead by attendee email or meeting ID; unmatched meetings go to an "Unassigned calls" list
- Requires a paid Zoom plan with cloud recording and audio transcripts enabled (section 3)

### Sales analytics dashboard (Analytics tab)
| Area | Metrics |
|---|---|
| Activity | Calls, emails, WhatsApp, meetings per rep per day/week; connect rate |
| Speed | Speed-to-lead (created to first touch), time in each stage |
| Pipeline | Created, won, lost value; win rate; average cycle; stage conversion funnel; weighted forecast; pipeline velocity |
| Import/list quality | **Per import batch and source:** contacted %, connected %, meeting %, win %; per country |
| Best time to call | Connect rate by hour, by lead timezone and country (heatmap) |
| Coverage | Leads untouched for N days, no next step, overdue tasks |
| Targets | Actual vs target per rep (calls, meetings, revenue) |
| Leaderboard | Rankings by chosen metric |

Implementation: SQL views/functions, nightly refresh via a scheduled Action for heavy aggregates, date range and rep filters, monochrome Recharts.

### Coaching dashboard
- **Call library** with filters (rep, outcome, date, score) and a "great calls" collection
- **Transcript viewer** with speaker labels, click a line to jump; manager comments **anchored to timestamps**
- **Free rule-based call metrics** (computed in code): talk-to-listen ratio, longest monologue, questions asked by rep, filler words, interruptions/overlaps, words per minute, next-step language detected ("send you", "follow up", "next week"), objection keywords (price, budget, competitor, shipping, MOQ) in English and French
- **Scorecard rubric** (1 to 5 each): Opening, Discovery, Pitch and value, Objection handling, Next step/close. Editable in Settings
- **Coaching queue:** calls auto-flagged (very high talk ratio, no next step, long monologue, low score)
- **Rep progress:** score and metric trends over time; 1:1 notes; goals per rep

### AI coaching without API cost
The app cannot call Claude for free, so AI reviews run **from Claude Code on your Mac**:
1. A local script exports new, unscored transcripts (dev-safe format) to a folder.
2. You run a Claude Code command that reads them, scores them against the rubric, and writes JSON results.
3. A local script uploads the results to `coaching_reviews` with `source = 'ai'` and status `draft`.
4. A manager reviews and approves. Nothing AI-generated is final without approval.
5. **Prompt injection rule:** the review prompt tells Claude that transcript text is untrusted data, gives it no tools beyond reading files, and never includes secrets. Use the prod service key only in the upload script, never in the AI session.
Usage counts against your Claude Max allowance, so batch weekly.

### Privacy for recordings
Tell participants calls are recorded (Zoom's notice) and follow local consent rules (stricter in parts of the EU). Restrict transcript access by RLS: reps see their own calls, managers see the team. Add a retention setting (for example delete transcripts after 12 months).

### Security gate 3
Webhook forgery test, transcript RLS test (rep cannot read another rep's calls), prompt-injection test transcript, token/secret review, `/security-review`.

---

## 12. Security Gates and Operations Summary

| Gate | When | Must pass |
|---|---|---|
| Gate 0 | Day 0 | MFA on all accounts, private repo, gitleaks installed, dev/prod projects separated |
| Gate 1 | End of R1 (before real data) | Sections 8 A to E complete, two-user test, Supabase Security Advisor clean, CSP and headers, backup + restore tested, keep-alive running, hosting decision made |
| Gate 2 | End of R2 | Stock RLS, RPC-only stock writes (no negative stock, no over-reservation under concurrency), import validation and rollback, two-user test on stock, orders and containers |
| Gate 3 | End of R3 | Webhook verification, transcript RLS, prompt-injection test |
| Monthly | Ongoing | Dependency update day, review audit log, check backups, rotate secrets that need it |

**Backups and keep-alive (GitHub Actions, free)**
- Nightly: `pg_dump` from the prod database, encrypt with a key you keep offline, store as a private artifact (retention up to 90 days)
- Every 2 to 3 days: call `/api/health` (runs a trivial DB query) so the free project does not pause
- Failed run = GitHub emails you
- Monthly: download a dump to your Mac. Quarterly: restore into `topstock-dev` to prove it works

---

## 13. Quality and Testing

- Unit tests for permissions, import validation, dedupe, phone parsing, metric calculations
- Playwright end-to-end: login + MFA, import dry run, create lead, log call, move stage, complete task, receive stock, reserve stock for a deal, stock sheet import dry run
- Loading: every route has a skeleton (`loading.tsx`), every list has loading, empty and error states, no spinners; no layout shift when content arrives
- Responsive: no horizontal page scroll at 390, 768, 1024, 1280, 1440 and 1728; Kanban and tab strips snap-scroll on phone
- Browsers: Safari and Chrome on Mac (primary), plus iPhone Safari and Android Chrome
- Performance: leads table scrolls at 60fps with 30k rows; first load under 2 seconds on Wi-Fi; Lighthouse 90+
- Accessibility: keyboard reachable everywhere, contrast AA, screen-reader labels, reduced motion
- Every list has loading, empty and error states; all text exists in EN and FR; dates/numbers via `Intl`

---

## 14. CLAUDE.md (put in repo root)

```md
# TopStock Wholesale CRM + IMS
Sales CRM and inventory for a wholesale importer in France. DESKTOP/MACBOOK FIRST, fully usable on phones.
English + French. Users: Haider, Henri, Kais (all admins; roles admin/manager/rep stay in the schema).
No Google Workspace: no mailbox sync, no calendar sync. Email = open the mail app + one-tap log.

## Stack
Next.js App Router + TypeScript, Tailwind, shadcn/ui, Motion, TanStack Query/Table/Virtual,
React Hook Form + Zod, next-intl, Supabase (Postgres, Auth, RLS, Storage), dnd-kit, Recharts, papaparse.

## Design (Apple-like)
Black/white/greys, status colours only as tiny dots or labelled badges (text tokens: green #15702F,
amber #7C5300, red #B61C29 in light mode). 8pt grid, radius 20/12. Spring animations (transform + opacity
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
```

---

## 15. Standing Prompts for Claude Code (examples the advisor can adapt)

**Kickoff**
> Read /docs/TopStock_CRM_Master_Plan.md and CLAUDE.md. Scaffold the project exactly as in Release 1 Day 1: Next.js + TypeScript, Tailwind, shadcn, next-intl (en, fr), Motion, Supabase client. Implement design tokens with light/dark. Do not build features yet. Commit.

**Database and security**
> Create Supabase migrations for the R1 data model in section 6 with RLS on every table (reps see own records, managers/admins see all), `org_id` everywhere, audit triggers, and revoke default anon privileges. Write tests that prove a rep cannot read or modify another rep's records. Explain how to run them locally against the dev project.

**Dock**
> Build the dock navigation per section 4 (single SVG path, draggable bead with velocity-based notch stretch, snap on release, keyboard support, reduced-motion fallback, 7 desktop items and 5 mobile items). Create a /design/dock page. Test in Safari and Chrome at 1280, 1440 and 375 widths.

**Import**
> Build the 30k lead import pipeline per section 7: staging table, validation with rejects CSV, dedupe, dry run, chunked upsert, owner assignment, timezone-from-country, rollback by batch id, audit logging. Test with the fake 500-row sample only.

**Inventory basics**
> Build the IMS basics per sections 6 and 10: products, locations, stock_levels, stock_movements, the `post_stock_movement` function (transaction, row lock, no negative stock, no over-reservation, audit row), RLS, the Inventory page with skeleton/empty/error states, the lead Stock tab, and the stock sheet import (staging, validation, dry run, rollback). Write tests that prove a direct update of stock_levels is refused and that two parallel reservations for the last cartons leave exactly one winner. use context7

**Security review**
> Act as a security reviewer. Check the codebase against all 54 items in section 8 of the plan, plus the inventory controls in section 8F. For each item say pass, fail or not applicable with evidence (file and line), then fix failures. Also run `/security-review`.

---

## 16. Open Questions: answered 6 October 2026

| # | Question | Haider's answer | Consequence |
|---|---|---|---|
| 1 | Pipeline stages and lead statuses | Lead, Qualified, Negotiations, Closed/won | Seeded as the four stages, plus Closed/lost with a reason. Lead statuses on contacts proposed as new / contacted / interested / not interested / do not contact / customer; confirm when the import is built |
| 2 | Users and roles | Haider, Henri, Kais, all admins | MFA mandatory for all three. Roles stay in the schema for later hires |
| 3 | CSV header and sample rows | Not yet; use placeholders | Import built with a column-mapping step so the real header maps without code changes. Header plus 3 fake rows needed before Day 3 |
| 4 | Hosting | Vercel Pro ($20/month) | Build on Hobby, upgrade before the first live deploy |
| 5 | Zoom plan | Paid, cloud recording and transcripts on | R3 unchanged; verify the two settings in Zoom before Day 14 |
| 6 | Google Workspace admin | TopStock does not use Google Workspace | Calendar sync and mailbox integration removed. Email opens the mail app and is logged. R2 is now inventory depth |
| 7 | Main markets | UK, US, France, rest of EU | Work queue hours per lead timezone: Europe/London, Europe/Paris and other EU zones, America/New_York to America/Los_Angeles. Henri and Kais on Europe/Paris, Haider on Asia/Karachi |
| 8 | What TopStock sells and how stock is counted | Wholesale importer in France: buys its own containers, sells wholesale across Europe, and sources direct for clients (supply chain as a service) | IMS modelled as containers → warehouse → wholesale orders, plus direct-from-source orders. Units per carton and cartons per pallet on every product. **Still open:** product categories and warehouse names |
| 9 | Brand | New brand in progress | Tokens first; visual polish waits for the brand board |
| 10 | Other data | Stock sheets | Stock sheet import on R1 Day 6; header row plus 3 fake rows needed |

**Still open, not blocking:** which email and calendar provider the company uses (Microsoft 365?); product categories and warehouse names; quote currency (EUR assumed); whether anyone needs to receive stock from a phone in the warehouse.

---

## 17. Definition of Done

**R1 done:** 30k leads imported and searchable instantly; reps can work the queue, log calls, manage tasks and deals through the four stages; products, locations and stock levels are in, movements and reservations work only through the RPC, stock sheets imported; dock navigation with drag works on Mac and phone; skeletons on every route; EN/FR; Gate 1 passed; backups and keep-alive running; restore tested.

**R2 done:** containers can be received into stock in one transaction; orders are fulfilled from stock or direct from source with a visible status; reservations expire and release; low-stock alerts show on Home; stock analytics live; Gate 2 passed.

**R3 done:** Zoom transcripts arrive automatically; call metrics computed; analytics dashboard live; coaching scorecards, queue and AI-draft review workflow working; Gate 3 passed.
