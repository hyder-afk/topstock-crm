# Consistency audit fixes (17 Oct 2026)

Branch `audit-consistency` from main c543676. Source: the read-only consistency audit of c543676 (24 findings: 0 H,
11 M, 13 L) and the security audit's one LOW, plus the dock finding from the Analytics builder's axe run. Builder
decisions under Haider's standing instruction (press feedback, page entrance, one red button, queue note label, docs).

Files owned by the parallel bugs PR were not edited: `src/components/pipeline/*`, `src/components/leads/use-leads.ts`,
`lead-form.tsx`, `contact-form.tsx`, `src/components/ui/toast.tsx`, `src/components/tasks/*`,
`src/components/inventory/units.ts`, `use-hold-actions.ts`. Findings in them are marked **left for the bugs PR**.

## Outcome per finding

| # | Finding | Outcome | Commit |
|---|---|---|---|
| 1.1 | `pipeline/board.tsx:601` blanks the page while a new scope loads or after a failed first fetch | Fixed in the bugs branch (83ce223): skeleton while loading, board error with Retry | - |
| 2.1 | Share link "Français"/"English" options hardcoded | Fixed: `ShareLinks.languageFr`/`languageEn` (endonyms, same in both files, named in the same-in-both list); the two exceptions leave the hardcoded-strings allowlist. The command menu's own endonyms stay a named exception (not in the audit) | d21b9cd |
| 2.2 | `placeholder="FR"` in the sale sheet | Fixed: `Sales.sheet.shipToPlaceholder` ("FR" in both); exception removed from the allowlist | d21b9cd |
| 2.3 | fr `ShareText.perPiece` "{price}/pc" | Fixed: "{price} la pièce", as `Share.perPiece` and the message itself say; unit test updated to the new French line | d21b9cd |
| 2.4 | English tagline on French pages has no language tag | Fixed: `lang="en"` on the tagline | d21b9cd |
| 3.1 | `active:scale-*` with a transform-only transition snaps | Fixed: `scale` added next to `transform` (same duration and easing) in Button and 30 other files (48 lists). The six owned-file spots (`ui/toast.tsx`, `tasks/task-row.tsx`, `tasks/quick-add.tsx`, `tasks/tasks-workspace.tsx`, `tasks/lead-picker.tsx`) done in the combined audit PR. `transition-transform` needs nothing: in Tailwind 4 it already covers `transform, translate, scale, rotate` | 0b039c8 |
| 3.2 | Page entrance replays on every navigation | Fixed: `(app)/template.tsx` plays the rise on the first visit to each path per tab (module state like the greeting; server render and first hydration carry it; reduced motion off as before; CSS only, never blocks input). The product page's nested second rise is removed. Kept: `leads-workspace.tsx:366`, the phone list-to-lead rise, which is a navigation cue ("one level in"), not a page entrance; changing it is a design call | 4b488d5 |
| 3.3 | Two red buttons on empty Leads for admins | Fixed: "Import from a spreadsheet" is the quiet variant; red fills in `main` 2 -> 1 (measured). Not done: removing Button's `brand` default (14 call sites; a refactor, not a fix) | 0d04c2d |
| 3.4 | Segment shadows on non-floating elements, raw `rgb(14 14 16 / ...)` | **Left:** the real question is a design rule (DESIGN.md: shadow only on floating layers). Either the segment shadow goes (a visual change) or DESIGN.md allows it (Haider). A token-only swap would not resolve that and would touch `tasks/*` and `pipeline/board-toolbar.tsx` (bugs PR) | - |
| 3.5 | Segmented control duplicated about 10 times, drifted | **Left:** extracting `ui/segmented.tsx` is a refactor across owned files; `bg-card` -> `bg-pill` on the share pages and `rounded-sm` -> 10 px on the board toolbar are visual changes; adding "segment 10" to DESIGN.md's radius scale is Haider's | - |
| 3.6 | `rounded-[24px]` where `rounded-xl` (24 px) exists | Fixed in `activity/call-panel.tsx` and `ui/dialog.tsx` (no visual change). `pipeline/deal-sheet.tsx:93,94` done in the combined audit PR after merging the bugs branch | 815c4b2 |
| 3.7 | Raw colours outside tokens | Fixed: logo mark `className="fill-brand"` (same red, screenshots show it); import Kbd `border-brand-foreground/30`. **Left:** `inventory/stock-table.tsx:219` amber level bar -> neutral fill is a visual and meaning change, a design call | 815c4b2 |
| 4.1 | Queue phone note textarea has no accessible name | Fixed: `aria-label={t("noteSheet")}` ("Note about the call" / French from messages) | f0298e3 |
| 4.2 | Inventory "Sell" button's aria-label hides its visible word | Fixed: aria-label removed; the visible span is the name at each width (WCAG 2.5.3). No test used the old name on phones | f0298e3 |
| 4.3 | Filter chip remove button 28 px | Fixed without a visual change: `relative` plus a `::before` hit area 8 px past each edge (44 px to tap) | f0298e3 |
| 4.4 | Root error page's hand-rolled Retry button | Fixed: `<Button className="w-fit">` (gains `min-h-11`, as the app error page) | f0298e3 |
| 5.1 | README empty | Fixed: what it is, stack, cloud-only workflow (START_HERE.md, Cloud Workflow), security note; no URLs to private resources, no secrets, no data | 6f156c2 |
| 5.2 | go-live: `jwt_expiry` PR still future tense | Fixed: "Done: PR #24 (merged as c543676)" in both places | 6f156c2 |
| 5.3 | go-live: security digest "comes as its own PR" | Fixed: merged in PR #23 (2b1e7f5); part A's migration list now ends at `20261023090000_security_digest` (22 files); I3.3 status updated | 6f156c2 |
| 5.4 | go-live header date and SHA stale | Fixed: "brought up to date again on 17 Oct 2026 with main c543676" | 6f156c2 |
| 5.5 | START_HERE: "advisor Claude in a separate chat" | Fixed: the `advisor` subagent reviews every step; Haider decides merges | 6f156c2 |
| 5.6 | START_HERE: "start the dev server" | Fixed: give Haider the PR's Vercel preview link and the screenshot paths; section B added to the cloud override list; Haider's box now starts a claude.ai/code session instead of a local folder | 6f156c2 |
| 5.7 | START_HERE item 10 "system stack" | Fixed: copied from `docs/apple-design-audit.md` (Outfit + DM Mono). Item 7 now matches the code (3.2) | 6f156c2 |
| 5.8 | START_HERE embedded-files note and byte counts | Fixed: the note now says every embedded file is a bootstrap snapshot and lists what is superseded (Vercel Pro, black/white/greys and system fonts, the advisor chat, building on the Mac); "the brand is being redesigned" replaced. Section J is marked bootstrap only (6be0957). Its byte counts were **kept on purpose**: re-running the split on 17 Oct 2026 still produces exactly those sizes, so they remain correct for what they verify | 6f156c2 |

## Security audit LOW and hardening notes

| Item | Outcome | Commit |
|---|---|---|
| `max_enrolled_factors = 10` lets a stolen aal2 session add an unseen second authenticator | Fixed: `supabase/config.toml` `max_enrolled_factors = 1`; `docs/go-live.md` D2 row = 1 with the reason. Checked first: `startTotpEnrollment` (`src/app/(auth)/actions.ts`) deletes every unverified TOTP factor before it enrols, and GoTrue counts all factors (`validateFactors`, `factorCount >= MaxEnrolledFactors`), so setup still works. The local auth stack (`scripts/local-auth/start.sh`) now sets `GOTRUE_MFA_MAX_ENROLLED_FACTORS=1` so local tests run with the same limit; CI's `supabase start` reads config.toml; no other env sets it. Merging pushes the new value to dev (deploy-dev-db watches config.toml) | 7296bda |
| Realtime on but unused | Recommendation for Haider's production session: go-live **D10** (switch Realtime off, or allow private channels only). Dev's config.toml is unchanged | 6f156c2 |
| `/forgot-password` has no app-side limit | Added as a fourth OR condition to the planned Firewall rule (go-live **B3** step 4), with the reason | 6f156c2 |

## Dock bead (coordinator, from the Analytics builder's axe run)

| Finding | Outcome | Commit |
|---|---|---|
| The dock bead is `aria-hidden="true"` but focusable (`tabindex="0"`, added by Motion because it has `onTap`): axe `aria-hidden-focus` | Fixed the least invasive way: `tabIndex={-1}` on the bead (Motion keeps an explicit tabindex). The bead has no keyboard behaviour of its own: the dock's arrow keys work on the links, and pointer drag and tap are unchanged. `shell.spec.ts` "keyboard: arrows move between sections" now asserts that nothing `aria-hidden` inside the dock can take focus. axe-core is not a project dependency, so the rule is checked directly rather than adding a package | 65ec099 |

## Evidence

- Screenshots, empty Leads as an admin, before and after, 1440 and 390, light, EN and FR:
  `docs/evidence/audit/screens/leads-empty-admin-{en,fr}-{1440,390}-{before,after}.png`. No horizontal scroll, no
  console errors in either build. Every other UI change in this branch has no static visual change (labels, tab order,
  hit area, tokens with the same values, motion), so before and after images would be identical; the logo mark is
  still Signal Red in the after shots.
- Checks: see the results section below.
- Commits (oldest first): 0b039c8, 4b488d5, 7296bda, 6f156c2, 0d04c2d, f0298e3, d21b9cd, 815c4b2, 65ec099, 61d86cd, and the commit that adds this file.

## Results

Throwaway local stack (Postgres 54800, Supabase Auth 9978 with `GOTRUE_MFA_MAX_ENROLLED_FACTORS=1`, gateway 54801,
`next start` on 5000), Chromium 1194, fake users only; stopped and its data removed afterwards.

| Check | Result |
|---|---|
| `npm run lint` | 0 errors (3 existing warnings: TanStack Virtual and the React Compiler) |
| `npm run typecheck` | pass |
| `npm run check:native` | pass |
| `npm run test:unit` | 745 passed (includes messages.spec and hardcoded-strings.spec) |
| e2e round 1 (day7a, day7b, gate1, journey, leads, phone, queue, screens, shell; build before the dock fix) | 91 passed, 3 failed, 11 skipped, 20 did not run. Failures: `journey` invite (Mailpit, known environment red; its 4 serial followers did not run); `queue` `call_keeps_claims` (local Chromium 1194, known environment red); `phone_sheets` (real: it opened the sale sheet by the old aria-label; fixed in 61d86cd; its serial followers did not run) |
| e2e round 2 (day7b, home, inventory, phone, sales, share, shell with the new dock assertion, plus a throwaway MFA check; build with every fix) | 93 passed, 1 failed, 11 skipped, 4 did not run. The failure: `phone_sheets` "en deal-sheet targets checked: 1, expected >= 2" in 8.6 s, a timing miss on the pipeline deal sheet (not touched here; it passed in round 1) |
| `phone.spec.ts` alone, same build | 5 passed, 1 skipped (`phone_shots`, evidence only); `phone_sheets` passed |
| Throwaway MFA check (not committed) | Pass: a new person signs in, reloads `/mfa/setup` three times (each visit deletes the unverified factor and enrols again), finishes setup with the code and lands on Home; then an aal2 token calling `POST /auth/v1/factors` directly gets **422 `too_many_enrolled_mfa_factors`** |

Skipped tests are the evidence-only screenshot tests behind their environment flags and the queue tests that need a
country in calling hours. Not run here: WebKit (not installed locally; CI runs it), the full suite outside the specs
above, Semgrep, gitleaks, npm audit and `/security-review` (CI and the PR step).
