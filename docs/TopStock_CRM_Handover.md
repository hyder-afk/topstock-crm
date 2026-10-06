# TopStock CRM and Prototype: Agent Handover

**Date:** 6 October 2026
**Owner:** Haider (sales leader, not a professional engineer; works from a MacBook and checks things on his phone)
**Project:** private sales CRM + inventory system (IMS) for **TopStock Wholesale**

---

## 1. Where things stand

| Area | Status |
|---|---|
| Product plan (scope, data model, security, releases) | **v3** (6 Oct 2026): Haider's decisions applied, see its "Changes in v3" table and section 16. `docs/TopStock_CRM_Master_Plan.md` |
| Build tooling rules | v2.1: `docs/TopStock_CRM_Tooling_Protocol_Lean.md` (adds 768/1024 widths and the `/apple-design` audit to every UI step) |
| Interactive design prototype | **v3.2** (6 Oct 2026): browser-tested in Chromium (desktop widths + phone), 9 bugs fixed in v3.1, then Haider's decisions applied and `/apple-design` audit 3 done in v3.2. **Safari / iPhone still untested** |
| Real build (Next.js + Supabase) | **Not started.** Next action is the tooling pre-flight, tool 1 (Playwright CLI); Haider was given the commands on 6 Oct 2026 |
| Brand | **In flux**: Haider is redesigning the brand (see section 6). The prototype still uses the old logo and a neutral palette |

---

## 2. Decisions Haider has made (treat as requirements)

- **Platform:** desktop and MacBook first; mobile phones second but fully usable.
- **Languages:** English and French. Used in France.
- **Access:** private and internal only. No public product, no public marketing site.
- **Look:** Apple-like, minimal, generous spacing, smooth spring motion. Black, white and greys, with functional status colours.
- **Navigation:** floating dock with a draggable bead and a notch (the "Meniscus" reference), including the drag animation.
- **Dashboard greeting:** "Hello Haider" ("Bonjour Haider" in French), using the logged-in user's first name.
- **Modules:** leads (30,000 imported from CSV), lead profile with click-to-call and email through the mail app (logged with one tap), pipeline, tasks, an **integrated IMS** (stock, inbound containers, orders, direct-from-source fulfilment, stock sheet import), Zoom-based coaching and sales analytics. **No Google Workspace** (decided 6 Oct 2026): no mailbox sync and no calendar sync.
- **Pipeline stages (6 Oct 2026):** Lead → Qualified → Negotiations → Closed/won, plus Closed/lost with a reason. The board shows deals, never all 30k contacts.
- **Users (6 Oct 2026):** Haider, Henri, Kais, all admins, all with MFA.
- **Business (6 Oct 2026):** wholesale importer in France; buys its own containers, sells wholesale across Europe, and sources direct for clients ("supply chain as a service"). Markets: UK, US, France, rest of EU. Existing stock sheets will be imported.
- **Hosting (6 Oct 2026):** Vercel Pro ($20/month) for the live app. **Zoom:** paid plan with cloud recording and transcripts (verify the settings before R3).
- **Quality bar (6 Oct 2026):** fully responsive, skeleton loaders on every route, very fast, very secure. Haider wants `/apple-design` used to audit and change every UI step.
- **Stack and cost:** Claude Code + Supabase + GitHub + Vercel. **No spend beyond Claude Max.**
- **Security:** extensive. Haider supplied a 54-item checklist; every item is mapped in Master Plan section 8.
- **Tooling:** 5 tools only: Playwright CLI, Taste Skill, Context7, Supabase MCP (dev only, read-only), Web design guidelines. Every UI change also gets an `/apple-design` audit.
- **Logo:** the supplied logo must never be altered (no recolouring or redrawing). See section 6 for the redesign caveat.

---

## 3. Documents in this pack

| File | Use |
|---|---|
| `docs/TopStock_CRM_Master_Plan.md` | **Source of truth.** Scope, desktop-first design system, data model, 30k import, security checklist, three releases, advisor instructions |
| `docs/TopStock_CRM_Tooling_Protocol_Lean.md` | The 5 mandatory tools, install and verify steps, usage matrix, evidence bundle. **Supersedes** the earlier 11-tool version |
| `prototype/topstock-crm-prototype.html` | The prototype (v3.2), single self-contained file |
| `assets/` | Black and white transparent logo PNGs (466 px, derived from mockups; not production files) |

**Superseded, not included:** the first roadmap, the first design guidelines (mobile-first), the first sprint plan, and the 11-tool tooling protocol. Where anything conflicts, the Master Plan wins, then the Lean Tooling Protocol.

**Live prototype (v3.2):** https://claude.ai/artifact/3ppCxqmfgKHs5uRidvcNv6
(The v3 link, https://claude.ai/artifact/MfZffRiZAohYcHuYRLQ9df, could not be opened from Haider's current account on 6 Oct 2026.)

---

## 4. The prototype

**What it is:** a throwaway design reference, written as vanilla HTML, CSS and JavaScript in one file with sample data. It is **not** the production stack. Do not port its code. Rebuild it in Next.js, Tailwind, shadcn and Motion. Reusable ideas only: the spring maths, the dock behaviour, the layout and motion specs.

**What it demonstrates**
- **Dock navigation:** spring-driven bead (starts from its on-screen position, keeps release velocity, projects to the nearest tab, resists at the edges, 10 px drag threshold, haptic on snap, reduced-motion fallback). Four tabs: Today, Leads, Pipeline, Inventory. Badges on Leads and Pipeline.
- **Home:** "Hello Haider" greeting, KPI cards with count-up and trend sparklines, coloured pipeline bar, today list, live activity feed.
- **Leads:** split view with a lead profile (four-stage tracker, win-likelihood bar, quick actions, Summary, Timeline, Email, Calls and Stock tabs with a sliding indicator), temperature badges. The Email tab composes an email that opens in the mail app and is logged.
- **Call panel:** simulated call with timer, outcome buttons and note. It grows out of the Call button, has Undo and Esc, and can be dragged away by its header (tracks the finger, rubber-bands upward, velocity decides the dismissal).
- **Pipeline:** Kanban with Haider's four stages, column counts and totals, days in stage, stalled-deal warning, "move to next stage" with a FLIP animation and Undo, Closed/lost summary line. Columns snap-scroll on phone.
- **Skeleton loaders:** the first visit to Leads, Pipeline or Inventory shows a layout-matching skeleton for about 450 ms, then the content rises in. The real build shows the same skeletons while data loads.
- **Inventory (IMS):** stock table with availability bars and status badges, inbound containers with ETA and status, movements, stock reserved for deals, with direct-from-source deals marked.
- **Other:** light and dark themes, partial EN/FR toggle, Undo toasts, reduced-motion, reduced-transparency and high-contrast support.

**Everything is fake:** names, prices, stock and events. Product categories are still guesses (clothing); Haider has not said what the containers hold. Quotes are shown in EUR.

**Audit history:** `/apple-design` audit 1 fixed the dock physics, interruptibility, call panel anchoring, undo, materials, type scaling and reduced-motion. Audit 2 calmed the constant motion, made entrance animations first-visit only, removed hover lift on non-clickable cards, strengthened amber contrast, and added symbols so status is not colour-only.

**Audit 3 (v3.2, 6 Oct 2026)**, against the fluid-interface principles (instant response, 1:1 tracking, momentum, interruptible, animate from the current value, reduced motion):

| Principle | Finding | Change |
|---|---|---|
| Instant response | Dock tabs gave no feedback on touch-down; only the bead moved after release | Press state on the tab icon (scale 0.86, 120 ms), focus ring for keyboard |
| Animate from the current value | Lead tabs rebuilt their markup on every switch, so the selected pill appeared with no motion | Sliding pill that moves and resizes from where it is (CSS transition, retargets if tapped again mid-move) |
| Animate from the current value | Kanban moves would have been a disappear/appear | FLIP: every card animates from its old position to its new one; Undo animates back |
| Direct manipulation, momentum | Call panel could only be closed by ✕ or Esc; no gesture | Header drag: tracks the finger 1:1, rubber-bands upward, release projects velocity (deceleration 0.99) and dismisses past 140 px, otherwise springs back. Reduced motion: tracking stays, return snaps |
| No dead time | Sections appeared instantly from sample data, hiding what loading will feel like | Layout-matching skeletons with a soft shimmer (none under reduced motion), content rises in after |
| Fits the hand | Phone: tab strip wrapped to two lines and the quick-action row wrapped | Tab strip snap-scrolls on one line, actions 56 px wide so five fit |
| Content under the finger | Kanban columns stacked vertically on phone (long scroll, no overview) | Horizontal snap-scroll, 82 % column width so the next column peeks |
| Calm | Hover lift on Kanban cards would add motion on every pass | Replaced with a tint change; press scale kept |

Checked and left as is: bead tap transitions use damping ratio 1 (no overshoot); the plan's `bead` spring (ratio about 0.81) will add a small overshoot in the build, which is intended.

**Browser test, 6 Oct 2026 (v3 → v3.1).** Playwright + Chromium at 1280, 1440, 1728 and 390 (phone emulation with real touch events), light and dark. WebKit was not available, so Safari is untested.

Confirmed working: mouse drag with live tab preview, edge resistance (a 250 px over-drag moves the bead about 60 px), sub-10 px wiggles ignored, interrupting a tap mid-flight reverses smoothly with no jumps, reduced-motion snaps instantly. Tap transitions settle in about 0.6 s with no overshoot (prototype uses damping ratio 1; the plan's `bead` spring is about 0.81, so a slight overshoot is expected in the build).

Fixed in v3.1 (each verified by rerunning the tests):
1. **Phone layout wider than the screen** on Leads (448 px) and Inventory (552 px). The dock was pushed off-screen, so you could not leave those pages. Cause: grid columns `1fr` keep a min-content minimum. Fix: `min-width: 0` on grid children (in the build: `minmax(0,1fr)` / `min-w-0`).
2. **Call panel collapsed into a small green dot** during a call, with End call off-screen. Cause: the call state reused the `.live` class of the Live-activity dot. Fix: own class name. Lesson for the build: scope class names (Tailwind/CSS modules avoid this).
3. **Bead could not be dragged by finger** in Chrome's phone mode: the browser retargeted the touch to the tab button under the bead. Fix: pointer handlers on the dock that hit-test the bead themselves, plus `pointercancel` handling. Recheck on a real iPhone and Android.
4. **Whole page blank if site storage is blocked**: an unused `localStorage` reference threw before anything rendered. Removed. Build rule: wrap storage access in try/catch.
5. **Sparklines drawn with gaps**: `pathLength` dash animation combined with `vector-effect: non-scaling-stroke` breaks in Chromium. Replaced with a clip reveal. Build rule: do not combine those two (Motion's `pathLength` uses the same dash trick).
6. **Lead quick-action icons oversized** (spilled out of their 48 px circles). Icons now 22 px.
7. **Console error on every load** (`navigator.vibrate` before any user tap). Haptic now fires only after user interaction. Note: iPhone Safari has no vibration API, so haptics will only work on Android.
8. **Status text failed AA in light mode** on its real backgrounds (badge tint over grey cards), worse than first measured: green 3.30:1, amber 3.91:1, red 3.70:1 at worst. New light-mode text tokens: green `#15702F`, amber `#7C5300`, red `#B61C29` (all ≥ 4.6:1 on every background they sit on). The Stock tab also used graphic colours for text; now uses the text tokens. Dark mode already passed.
9. **Inventory table cramped at 1280** (SKUs, locations and badges wrapping; "All" chip stretched). Now nowrap with the table scrolling inside its card.

**Known gaps (still open)**
1. Not tested in Safari (Mac or iPhone). Must be checked by hand, in particular finger-dragging the bead and the call panel header.
2. Dock lacks the Meniscus notch shape (the bead is a circle on a bar). The starter path function is in Master Plan section 4.
3. Dock has no keyboard support or tab semantics (no `role="tab"`, `aria-selected`, arrow keys, `Cmd+1..7`); `Cmd+K` palette is a placeholder. Required in the build.
4. Light-mode status **graphics** (dots, bars, sparklines) are below 3:1 on grey cards (green 1.86:1, amber 2.71:1). Acceptable while every status also has a text label or symbol; otherwise darken (e.g. green `#25A244`, amber `#BD8100`). Decide together with the brand green.
5. Kanban cards move with a button, not by drag (the build uses dnd-kit). Rows in lists are not keyboard-focusable (the build uses real buttons and links).
6. Calls and the live feed are simulated. The French toggle only translates a few labels. Times use the browser's 12/24 h setting; French users expect 24 h.

---

## 5. Reality checks the next agent must keep telling Haider

| Topic | Fact |
|---|---|
| **Hosting** | Vercel's free Hobby plan is **non-commercial only**. **Decided 6 Oct 2026: Vercel Pro ($20/month)**; build on Hobby, upgrade before the first live deploy. Also, "private" means authenticated, not hidden: any deployed URL is reachable, so the app needs login, MFA and no public signup. |
| **Supabase Free** | 500 MB, pauses after 7 days idle, no daily backups. Mitigation in Master Plan: keep-alive ping and scheduled encrypted dumps, plus a tested restore. |
| **Calling** | In-browser calling needs a paid phone provider. At $0: click-to-call from phone or Mac, one-tap outcome logging, Zoom meetings. |
| **Email** | TopStock has no Google Workspace, so there is no free mailbox sync. The CRM opens the mail app and logs the email with one tap. If the company uses Microsoft 365, Graph API is the free route for a later release; ask which provider they use. |
| **Zoom transcripts** | Need a paid Zoom plan with cloud recording and audio transcripts. Haider says yes (6 Oct 2026); verify both settings in Zoom before R3. |
| **AI coaching** | Claude Max has no API credits, so the app cannot call Claude live. Coaching reviews run as a manual batch from Claude Code on Haider's Mac; managers approve results. |
| **Timeline** | Full scope does not fit in 4 to 7 days. **Release 1** (core CRM, import, security, dock, IMS basics) takes 8 focused days. Inventory depth is Release 2, Zoom/analytics/coaching Release 3. |
| **Compliance** | Cold B2B outreach and call recording have rules in the EU and UK. Keep `do_not_contact`, lead source and consent fields. Not legal advice. |
| **"No room for vulnerability"** | No software reaches zero risk. What the plan delivers is layered controls (section 8 A to F), tests that prove each rule, and a gate before every release. Say this plainly when asked for guarantees. |

---

## 6. Brand status: read before polishing any UI

Haider is creating a **new brand direction** (Gen Z-friendly but premium and minimalist, a green colour family, a geometric letter-based logo with a tilted sub-mark, and a brand board PDF). He has rejected a bale-style logo concept. This is being handled by a separate workstream. Details may have changed, so **confirm the current state with him before starting**.

Impact on the CRM:
- The prototype uses the **old wordmark** (black and white transparent PNGs). If the logo changes, swap the asset only. Never edit the old logo.
- The CRM palette is neutral plus functional status colours (green good, amber warning, red danger). A brand green could collide with the functional green. Rule to propose: brand accent used for identity and primary actions only; status colours keep distinct hues and always carry a text or icon label.
- **Build the colour system as design tokens (CSS variables)** with one swappable brand accent, so the new brand drops in without redoing screens.
- Wait for the final brand tokens before doing visual polish. Structure, behaviour, data and security can proceed now.

---

## 7. Open questions

Questions 1 to 10 were answered on 6 October 2026; the answers and their consequences are in Master Plan section 16. Still open, not blocking:
1. Which email and calendar provider the company uses (Microsoft 365? something else?).
2. Product categories and warehouse names (the prototype's clothing items are placeholders).
3. The 30k CSV header row plus three fake rows, and the stock sheet header plus three fake rows (never the real data). Needed before R1 Day 3 and Day 6.
4. Quote currency (EUR assumed) and whether anyone will receive stock from a phone in the warehouse.

---

## 8. First steps for you

1. Read the Master Plan fully, then the Lean Tooling Protocol.
2. Open the prototype on a laptop and a phone, and compare it to the plan.
3. Check the still-open items in section 7 when they become relevant; do not block on them.
4. Run the **tooling pre-flight** (5 tools, one at a time, outputs pasted) before any build step.
5. Start Release 1, Day 0 and Day 1: accounts and MFA for all three users, dev and prod Supabase projects in an EU region, `CLAUDE.md` (Master Plan section 14), `DESIGN.md` built as tokens, scaffold, schema with row-level security, invite-only auth, CI with secret scanning.
6. After every UI step, deliver the evidence bundle: screenshots at 1280, 1440, 1728 and 390 (plus 768 and 1024 when a layout changes), a clean console, no horizontal scroll, `/apple-design` audit, web-design-guidelines audit.
7. Never put the real lead CSV, secrets or production credentials into an AI session.

---

## 9. How to work with Haider

- Give **one step at a time** with exact commands or prompts, and wait for him to report back.
- Explain in plain language. He knows sales and what he wants the product to feel like, not engineering terms.
- Be honest about cost, limits and timeline even when it is not what he hoped. He has accepted corrections so far, such as the hosting terms, the paid transcript requirement, the Strix cost and the 8-day Release 1.
- His short answers can be ambiguous ("okay", "yes"). State your reading at the top of the reply and carry on; he corrects if needed.
- He judges by seeing: show working screens and prototypes, and expect feedback via phone screenshots.
