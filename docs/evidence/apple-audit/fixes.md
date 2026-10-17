# Apple design audit: builder fixes (19 of 24)

Branch `apple-audit` (from `origin/main` 3908c83; findings commit a86550e). One commit per finding, in the order they were
done. The five HAIDER DECIDES findings (#4 lead search in Cmd+K, #7 swipe-down sheets or no grabber, #17 TOTP auto-submit,
#18 heading tracking, #24 right-click menus on lead and stock rows) are **not** touched.

Every finding was checked in the code first; all 19 were real. "Red on base" means the new or extended test was run
against a build of a86550e on the throwaway local stack and failed for the reason the finding gives, before the fix.

| # | Finding | Outcome | Commit | Test |
|---|---|---|---|---|
| 1 | Call panel: a pull moves only the header | Fixed: `drag="y"` on the panel, `dragListener={false}`, `useDragControls` from the header's pointerdown (buttons and fields still work), same elastic and snap. Past the threshold on a call already marked "not logged", the panel exits by animating `y` out of view from where it is with the release velocity (`springs.sheet`). In any other phase the panel asks first ("Call not logged.") and springs back: dismissing there never closed the panel, so a throw would have been false. Reduced motion: drag kept, fade exit | 878d092 | `lead-page.spec` call_panel_pull_moves_the_whole_panel… (red on base: the panel moved 0 px) |
| 2 | ~25 controls with no press state on touch | Fixed, 27 class edits, no new tokens. Rows get an `active:` tint equal to their hover tint (the leads-row recipe). Buttons, link-buttons, chips, steppers, segments, bulk-bar actions and icon buttons get `active:scale-[0.97]` with `scale` in their transition. The two drop zones are large surfaces, so they take the tint (`active:bg-muted`) instead of a scale | 83ad4db | Class-only (covered by the existing specs of those screens) |
| 3 | Home and lead-page tick: row vanishes before the check fills | Fixed: the Tasks page pattern. The check fills, 160 ms later the row fades out inside `AnimatePresence initial={false}` and the rows below close the gap (`layout="position"`, `springs.smooth`; fade only with reduced motion). Focus still goes to the next open check (new `lib/focus` `openCheck` skips a row still fading out), else the heading | 3f154eb | `home.spec` today_toggle_done_undo and `lead-page.spec` task_check_keeps_focus record click, aria-checked and removal times: check filled < 100 ms, row present ≥ 160 ms (both red on base) |
| 5 | Queue Undo: the card comes back from the wrong side | Fixed: `AnimatePresence custom` direction, worked out when the card on screen changes (a card that left and comes back = −1); `CardShell` variants enter from `32 × dir` and leave to `−32 × dir`. Spring and reduced-motion fade unchanged | 9437a83 | `queue.spec` skip_and_undo: `data-from` and per-frame offsets (returning card only negative x, replaced card positive x) |
| 6 | Dialogs and sheets cannot reverse mid-animation | Fixed with the smallest CSS change: dialog, phone sheet, side sheet and deal sheet move from keyframes to transitions on `transform` and `opacity` (same curves and durations), with `@starting-style` for the first frame. Radix Presence waits only for animations, so while closed an invisible `dialog-hold` animation (it animates a custom property) lasts exactly as long as the exit. Reduced motion stays instant (the global block). Popovers and menus unchanged. Tested in Chromium by closing 40 ms into the entrance and reopening 40 ms into the exit. **WebKit risk:** `@starting-style` needs Safari 17.5+; on an older engine the dialog would simply appear without its entrance (it still opens, closes and unmounts). CI's WebKit run of `shell.spec` will exercise it | 6dda31b | `shell.spec` dialogs reverse mid-animation… (red on base: opacity 0.45 at the close jumped to 1) |
| 8 | Inventory side panel replays its entrance per product | Fixed: `animate-panel` on the `<aside>`; the per-product key stays on the content | 699ddf2 | `inventory.spec` inventory_keyboard_only counts `panel-in` starts while stepping with arrows and J/K (3 on base, 1 now) |
| 9 | Toasts rise in then vanish | Fixed: on timeout, Undo or ✕ a copy stays for a 140 ms exit (8 px down and fade, transform and opacity), outside the live region, `aria-hidden` and `inert`; a new toast replaces it at once; reduced motion instant | 413cc95 | `leads.spec` toast_after_a_mouse_click… records the leaving copy (≥ 100 ms on screen, then gone; red on base: no copy) |
| 10 | Leads: no J/K, "/" opens the menu | Fixed: J/K in the leads table (same guard as the stock table); "/" focuses the leads search in the capture phase as on Inventory. When a phone hides the toolbar behind an open lead, "/" still opens the command menu | 76166c6 | `leads.spec` preview… arrow keys: K, J and "/" (red on base) |
| 11 | Text links give no response on a phone | Fixed with the finding's second option: `active:opacity-60` on the 47 underline-style and muted text links and text buttons that styled only hover. A global `:where(a[href], button):active` rule would also have dimmed red buttons, rows and dock links that already press. Analytics' `card.tsx` is on PR #28's branch, not here | 83bb664 | Class-only |
| 12 | Import drop zones flicker during a drag | Fixed: the Files tab's `relatedTarget` guard on both zones | 3668cab | New tests in `import.spec` and `stock-import.spec` (dispatched drag events; red on base) |
| 13 | Share page basket bar pops in | Fixed: `animate-bar-in` = the phone sheets' `sheet-in` (320 ms, existing curve) once on mount; reduced motion instant | 5d2525a | `share.spec` request test counts the bar's entrance |
| 14 | Right-click does not open existing menus | Fixed. Task rows: the shared `ContextMenu` with the ⋯ menu's own items (one `TaskMenuItems` list for both), as the deal card does; off while the row is an edit form; the lead link keeps the browser's link menu; Escape returns focus where it was. Timeline entries: right-click, Shift+F10 or the Menu key open the entry's existing ⋯ menu. **Builder decision:** that menu is mounted lazily on purpose (a menu per entry cost tab switches and scrolling, per the code), so no ContextMenu is mounted per entry; the edit box, links and selected text keep the browser's menu | 94a09a7 | `tasks.spec` right_click_opens_the_row_menu (right-click, Shift+F10, Escape focus, Dismiss; red on base); `lead-page.spec` note_edit… right-click opens "Edit text", Escape focuses ⋯ |
| 15 | Count-up restarts from the old target | Fixed: the ref holds the value on screen (updated every frame, final on complete) | fae613f | `home.spec` count_up_interrupted_starts_from_the_value_on_screen (held page clock; red on base: jumped to €50,000) |
| 16 | Dropped deal ignores the throw speed | Fixed: pointer samples in `onDragMove`, `lib/motion` `releaseVelocity` (last ~50 ms, 0 when the hand stopped, clamped to 4000 px/s) passed as `velocity` on the x and y springs in `settle()`. Keyboard moves and the Won/Lost asks settle with none | 1f67fb0 | `tests/unit/release-velocity.spec.ts` (3 tests) |
| 19 | Bead tap gives no press response | Fixed: `whileTap` 0.94 on `springs.bead`; `whileDrag` 1.08 still wins | 03c067a | `shell.spec` pressing the bead… (press, release, drag lift; red on base) |
| 20 | First Home: KPI tiles rise twice | Fixed: the tiles' own `animate-page` removed (and the now unused `shouldRise`) | ad8a9b8 | Screens (see below) |
| 21 | Translucent bars without reduced-transparency fallback | Fixed: `@custom-variant reduced-transparency` and solid background + no blur on the four bars | f1fc334 | Checked in Chromium with CDP media emulation on the share bar (blur none, solid colour); Playwright cannot emulate this media feature in a committed cross-browser test |
| 22 | `font-medium` on Outfit | Fixed: removed from the four titles; no visual change | 5c63b5e | Same page, same instant: Home with and without `font-medium` on those titles is pixel-identical |
| 23 | Two red Add buttons for a rep | Fixed: the empty state's Add is quiet in every role | 6d61296 | `day7b.spec` rep empty state: one `bg-brand` control in main |

## Existing assertions changed

None weakened or removed. Assertions were only added to existing tests (`leads.spec`, `home.spec`, `lead-page.spec`,
`queue.spec`, `inventory.spec`, `share.spec`, `day7b.spec`). The new `recordTick`/`tickTimes` helpers live in
`tests/auth/helpers.ts`.

## Checks

Throwaway local stack (Postgres 54810, Supabase Auth 9977, gateway 54811, app on 5100; production build of the final
code), Chromium 1194. Run at the end, after every product commit.

- `npm run lint`: 0 errors (the 3 existing TanStack Virtual warnings). `npm run typecheck`: clean. `npm run check:native`:
  clean. `npm run test:unit`: **785 passed** (3 new in `release-velocity.spec.ts`).
- Chromium e2e, one spec file at a time on one database (nothing else running against it):

| Spec | Result |
|---|---|
| shell | 25 / 25 (see note 1) |
| home | 17 / 17 |
| leads | 12 / 12 |
| lead-page | 27 / 27 |
| queue | 20 / 21: `call_keeps_claims` is the known local Chromium 1194 red (Chromium's beforeunload on a tel: link); the other 20 run with `--grep-invert call_keeps_claims` because the file is serial |
| pipeline | 26 / 26 |
| tasks | 14 / 14 |
| inventory | 11 / 11 |
| sales | 12 / 12 |
| share | 12 / 12 |
| import | 12 / 12 |
| stock-import | 8 / 8 |
| phone | 5 / 5 |
| day7b | 21 / 21 |
| gate1 | 10 / 10 |

**232 passed, 1 known environment red.** Journey (Mailpit) was not in the list and was not run. WebKit is not available
locally; CI runs it.

Notes.
1. `shell.spec` "in French, the command menu finds French words" fails when `shell.spec` is the first file run on a
   **fresh** database, and passes otherwise (3 of 3 fresh-first runs red; 25 of 25 on a used database, and 8 of 8 alone).
   Cause, from the failing trace: the spec's user is the first profile of the org, so it is an admin, so the menu also
   lists "Importer des prospects"; cmdk scores "import leads csv spreadsheet importer prospects" at 0.891 and
   "go leads Prospects" at 0.8909 for "prosp" (a case penalty on the capital P), so Enter opens the import. Pre-existing
   and order-dependent (CI runs `shell` after other files, when the user is a rep); none of these commits touches the
   menu, its items or roles. Worth a separate fix (give the test user a role, or a better item value).
2. Three of the new tests needed a second look on the full run and were fixed in dab377c (the leaving toast is added
   inside its wrapper; the snappy spring overshoots by about a pixel; the call panel grows with "Call not logged.", so
   its bottom edge is measured). d2dd0c5 made the #15 test independent of hydration timing. No product code changed.
3. #21 (reduced transparency) checked in Chromium through CDP media emulation on the share bar: default
   `blur(8px)` on 95 % card; reduced transparency `none` on solid `rgb(255,255,255)`.

Advisor round 1 follow-up runs (Chromium 1194, fresh `next build` of the round-1 code, throwaway stack):
- `leads.spec` 12 / 12 (the "/" check, after the `checkVisibility()` guard; also checked with
  `Element.prototype.checkVisibility` deleted: "/" still focuses the search, no page error).
- `shell.spec` 28 / 28; the new reduced-motion bead test 45 / 45 (`--repeat-each=15` at 1280, 1440, 1728). It can fail:
  with the spring put back it fails and prints the in-between scales (`1 0.9927 0.9723 0.9540 0.9450 0.9409 …`).
- `day7b.spec` 21 / 21 (11 screenshot-only tests skipped by design), `share` 12 / 12, `sales` 12 / 12, `inventory` 11 / 11.

Security tooling:
- gitleaks 8.28.0: `gitleaks git --log-opts="origin/main..HEAD"`: 24 commits scanned, **no leaks found**;
  `gitleaks dir docs/evidence/apple-audit src`: **no leaks found**.
- npm audit and Semgrep: left to CI. This step changes no dependency (`package.json` and `package-lock.json` untouched),
  so npm audit cannot differ from main; Semgrep runs on the PR.

## Context7 and docs lookups

Done after the build, against the code as written (the advisor flagged that none were recorded). Every API is used the
way its docs describe. One small code change came out of them: the `checkVisibility()` guard below.

| API (where) | Source | What the docs say, and how the code matches |
|---|---|---|
| Motion `useDragControls`, `dragListener={false}` (call-panel.tsx) | Context7 `/websites/motion_dev` (react-use-drag-controls) | `dragListener={false}` stops a drag starting on the element itself; `controls.start(event)` from another element's `onPointerDown` starts it. The panel header calls `dragControls.start(e)`, so only the header pulls the panel and its buttons stay plain taps |
| Motion transition `velocity`, physics springs (call-panel.tsx, settle.ts) | Context7 `/websites/motion_dev` (transitions, spring-value) | Physics springs (stiffness, damping, mass) carry the gesture's velocity; duration-based springs do not. Our `springs.*` are physics springs, and the throw / settle pass the release velocity as `velocity` |
| Motion `custom` with variant functions and `AnimatePresence custom` (queue-workspace.tsx, the card's travel direction) | Context7 `/websites/motion_dev` (motion component, advanced props) | `custom` feeds dynamic variant functions; on `AnimatePresence` it reaches exiting children whose props can no longer update. Both the presence and the child get `custom={dir}` |
| Radix ContextMenu `Trigger disabled` (task-row.tsx) | Context7 `/websites/radix-ui_primitives` (context-menu) | `disabled` is a `ContextMenu.Trigger` prop (added in 2.1.0), default false; when true the menu does not open. Used as `<ContextMenuTrigger asChild disabled={editing \|\| !hasMenu}>` |
| Radix Presence and exit animations (dialogs, sheets) | Context7 `/websites/radix-ui_primitives` (guides/animation) | Primitives suspend unmount while a CSS animation plays out. The closed state's invisible `dialog-hold` animation is what keeps the content mounted while the CSS transition runs |
| Tailwind 4 `@custom-variant` (globals.css) | Context7 `/websites/tailwindcss` (adding custom styles) | Shorthand form `@custom-variant name (selector-or-at-rule);` is valid without `@slot` when no nesting is needed. `@custom-variant reduced-transparency (@media (prefers-reduced-transparency: reduce));` matches it |
| CSS `@starting-style` (globals.css) | Context7 `/mdn/content` (@starting-style) | Only for transitions. A standalone block must come after the rule it starts from (same specificity). Every standalone block in globals.css comes after its `[data-state="open"]` rule; the phone and desktop variants nest it inside their `@media` |
| `Element.checkVisibility()` (leads-toolbar.tsx) | Context7 `/mdn/content` (checkvisibility) | Returns false when the element has no box. It is missing in Safari before 17.4, so the call is now guarded with a fallback to `offsetParent !== null` (the advisor's optional note) |
| `prefers-reduced-transparency` (globals.css, #21) | Context7 `/mdn/content` | Media feature for the OS "reduce transparency" setting; where it is unsupported the default blur stays, which is the current behaviour |

## web-design-guidelines audit (after the fixes)

Rules pinned at vercel-labs/web-interface-guidelines `434b7f9`, applied to the lines this branch changes in `src/`
(56 files). 5 findings, all low; 0 on reduced motion, `transition: all`, focus, touch targets or context-menu ARIA.

| Finding | Outcome |
|---|---|
| `inventory/tab-lists.tsx:138` adds `transition-colors` only to fade the new press tint | Fixed: transition removed, the tint is instant (as on lead rows) |
| `share/share-request.tsx:89, 218, 239` `transition-[background-color,scale]` also fades the hover tint that was instant before | Fixed: `transition-[scale]` |
| `sales/hold-and-request-sheets.tsx:365`, `sales/record-sale-sheet.tsx:304` `transition-[color,scale]` fades text colour | Fixed: `transition-[scale]` |
| New press tints and the check fill ride colour transitions that were already there (closed-deals, deal-summary-card, deals-tab, recent-activity, choose-step, stock-choose; today-card and lead-cards check) | Kept: the same 150 ms recipe the Tasks page already uses; a colour change, not layout, and covered by the reduced-motion block |
| `active:opacity-60` on the 47 text links and text buttons lowers contrast while held ("active more prominent than rest") | Kept on purpose: the iOS press dim for text controls (Apple audit #11). The dim lasts only while the finger is down. Logged as a deviation in `docs/log.md` |

Checked and passing: every new CSS animation is under the global reduced-motion block (`globals.css` 396-405), every new
Motion path has a reduced branch, new motion moves only transform and opacity (`dialog-hold` animates an invisible
custom property), focus rings come from the global `:focus-visible` rule and no press removes them, no control got
smaller, the task row's context menu has `role=menu`, an `aria-label`, Shift+F10 / Menu key and focus return, and the
toast's leaving copy is `aria-hidden`, `inert` and outside the live region.

Pre-existing, outside this step (not changed here): `ui/dialog.tsx:40` `focus:outline-none` and no `overscroll-behavior`
on plain dialog content; inline phone and email links without a 44 px tap area on phones (details-tab, lead-preview);
lead page "Back" link without `min-h-11`; some controls with a press but no hover state. Listed as follow-ups.

## Apple re-check after the fixes

Each finding re-read against the final code:

- **19 builder findings: all resolved** (#1-3, #5, #6, #8-16, #19-23), each with its file:line evidence in the review
  notes; e.g. #1 `call-panel.tsx` (header-only drag, throw from the live `y` with release velocity), #6 `globals.css`
  (transitions with `@starting-style`, reverse from where they are), #15 `count-up.tsx` (restarts from the number on
  screen), #16 `board.tsx` + `settle.ts` (release velocity carried into the settle).
- **5 HAIDER DECIDES (#4, #7, #17, #18, #24): untouched** (command palette, deal-sheet grabber, TOTP field, heading
  tracking, list-row context menus).
- New problems the re-check found:
  1. Under reduced motion the dock bead had no press response while every CSS press still showed an instant press.
     **Fixed:** the bead's press shows instantly under reduced motion (no spring, no drag lift); new `shell.spec` test
     "reduced motion: a press on the bead still shows, at once, and a drag does not lift it".
  2. A toast dismissed during its 220 ms rise sinks from its resting place, not from where it was. **Kept:** toasts stay
     at least 6 s, so this needs a dismiss inside the first fifth of a second; the copy is a new element, so following
     the live position would need measuring the old one. Noted as a follow-up.
- **Unresolved: none.**

## Screenshots

In `docs/evidence/apple-audit/screens/`, EN, light and dark, 1440 and 390, `-before-` from a86550e and `-after-` from
the final code (24 files), plus 12 for the one visible change (#23, advisor round 1): `leads-empty-rep-after-en-{light,dark}-{1280,1728}.png`
and `leads-empty-rep-after-fr-{light,dark}-{1280,1440,1728,390}.png` (a new rep alone in an empty organisation; 900 px
high on desktop, 390x844 on phone). 768 and 1024 are not shot: no layout changed. Every shot: no console error, no
horizontal scroll (0 px); the #23 shots also have exactly one red button in `main` (the header's Add).

| Shots | What to see |
|---|---|
| `leads-empty-rep-{before,after}-en-{light,dark}-{1440,390}.png`, `leads-empty-rep-after-{en,fr}-…` | #23: before, two red "Add lead" buttons; after, the empty state's Add is quiet and the header's Add is the one red button |
| `share-basket-{before,after}-en-{light,dark}-{1440,390}.png` | #13: the bar at rest looks the same (its rise is motion, counted in `share.spec`); the only pixel changes are the run's product name and the "Updated" time |
| `home-{before,after}-en-{light,dark}-{1440,390}.png` | #20 and #22: at rest the page is the same. Pixel diff: the Today titles region is identical in both builds (#22); the meeting time differs (seeded relative to the clock); the KPI tiles differ by 13 pixels of at most 2/255 (edge anti-aliasing: the tiles are no longer a separate animated layer). #22 also checked in one page at one instant: adding `font-medium` back to the 4 title spans changes no pixel |

## Security review

`/security-review` on apple-audit (a86550e..635d9a5): **no findings at confidence 8 or higher**. No server paths
changed; the new right-click menus reuse the same role-gated items as the existing menus; no
`dangerouslySetInnerHTML`; the new shortcuts are non-destructive; the share page changes are CSS only.
