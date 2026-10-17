# Apple design audit: whole app (findings only, no product code changed)

Branch `apple-audit` from `origin/main` 3908c83 (17 Oct 2026). Audit against `/anthropic-skills:apple-design` (WWDC 2018
*Designing Fluid Interfaces*, translated to the web), the repo checklist `docs/apple-design-audit.md`, and `DESIGN.md`
(the source of truth). Analytics was read from PR #28's branch (`analytics-ui`, 390656d), read-only.

**Method.** I read the code of every page and shared component. I took no screenshots and started no local stack, because
each finding below can be seen in the code at the line given. Each finding shows: area, file:line, the Apple principle,
what is wrong, the smallest fix, effort (S under 1 h, M half a day, L more), and who decides:
- **builder** = a motion, feedback, keyboard or a11y fix inside the existing tokens.
- **HAIDER DECIDES** = changes brand colours, fonts, font size or weight, tracking, the layout of a feature, or adds a
  control, action or flow.

The findings are ranked by user impact (how often people hit it × how much it hurts).

**Kept out on purpose.**
- The visual-polish items in the separate design preview: hairline card borders, 40 ms card stagger, sliding Team/Mine
  pill, tinted status pills, 64 px rows, shimmer skeletons, blurred modal backdrop. Also its tab-panel fade.
- The four design calls already queued for Haider: segment shadows, a shared segmented control, the amber stock bar, the
  phone list-to-lead rise.
- The two logged follow-ups: arrow keys in the pipeline scope radiogroup, and Undo for deleting a saved view.

## Summary

| By area (primary) | Findings |
|---|---|
| Shell (dock, palette, toasts, dialogs and sheets) | 5 |
| Cross-cutting (press states, links, materials, type) | 4 |
| Home | 4 |
| Leads (list, preview, empty state) | 3 |
| Call panel (Leads, lead page, queue) | 1 |
| Work queue | 1 |
| Pipeline | 1 |
| Inventory | 1 |
| Tasks and lead page (menus) | 1 |
| Leads and stock import | 1 |
| Client share page | 1 |
| Auth (sign-in, MFA, step-up) | 1 |
| Analytics (PR #28) | 0 of its own (shares #15 and #11) |
| More / Team, inventory settings, client view | 0 |

| By decision | Findings |
|---|---|
| builder can fix | 19 |
| HAIDER DECIDES | 5 |
| **Total** | **24** |

| # | Finding | Decides | Effort |
|---|---|---|---|
| 1 | Pulling the call panel down moves only its header; the panel stays put and then shrinks in place | builder | M |
| 2 | About 25 row, chip, stepper and icon buttons give no response at all to a tap on a phone | builder | S–M |
| 3 | Ticking a task on Home or on the lead page makes it vanish at once (the Tasks page animates it) | builder | M |
| 4 | Cmd+K cannot find a lead (the plan's "jump to any lead"); "/" and "Search…" promise it | HAIDER DECIDES | L |
| 5 | Work queue Undo brings the last card back from the wrong side | builder | S |
| 6 | Dialogs and sheets cannot reverse mid-animation: they jump to fully open, then close | builder | M |
| 7 | The deal sheet shows a grabber that cannot be dragged; no phone sheet can be swiped down | HAIDER DECIDES | M |
| 8 | The Inventory side panel replays its entrance on every product (J/K makes it twitch) | builder | S |
| 9 | Toasts rise in and then simply disappear | builder | S |
| 10 | Leads list keys: no J/K (Stock has them), and "/" opens the menu instead of the search | builder | S |
| 11 | Text links give no response to a tap on a phone | builder | S |
| 12 | The import drop zones flicker while a file is dragged over them | builder | S |
| 13 | The client share page's basket bar pops in with no entrance | builder | S |
| 14 | Right-click does not open the menus that task rows and timeline entries already have | builder | S–M |
| 15 | Count-up numbers restart from the old target when interrupted (Home, Analytics) | builder | S |
| 16 | A dropped deal card's settle ignores the speed of the throw | builder | M |
| 17 | The 6-digit TOTP code needs an extra tap (no auto-submit) | HAIDER DECIDES | S |
| 18 | The -3 % heading tracking also squeezes 12–14 px headings and a DM Mono heading | HAIDER DECIDES | S |
| 19 | A tap on the dock bead gives no press response | builder | S |
| 20 | First Home: the KPI tiles rise twice (inside the page's own rise) | builder | S |
| 21 | Four translucent bars have no solid fallback for reduced transparency | builder | S |
| 22 | `font-medium` on Outfit, which ships only 400 and 700: renders Regular, misleading code | builder | S |
| 23 | Empty Leads for a rep shows two red "Add lead" buttons | builder | S |
| 24 | Right-click menus on lead and stock rows (rows have no menu today) | HAIDER DECIDES | M |

---

## Findings

### 1. Call panel: a pull-down drags the header alone, and the dismissal ignores the throw
- **Area:** call panel (used from Leads, the lead page and the work queue), phones and desktop.
- **Where:** `src/components/activity/call-panel.tsx:396-401` (`drag="y"` sits on the header `motion.div`, not on the
  panel), `:371-373` (dismiss threshold), `:386` (exit `opacity 0, scale 0.9`).
- **Principle:** tracks the finger 1:1, spatial consistency, momentum.
- **What's wrong:** grabbing the handle moves only the header strip. It slides down over the panel's own content while the
  panel stays where it is. Past the threshold the panel then shrinks and fades in place instead of carrying on downward
  at the release speed. Below the threshold the header springs back alone. The panel on screen never follows the finger.
- **Minimal fix:** move the drag to the panel: `drag="y"`, `dragListener={false}`, `useDragControls()` started from the
  header's `onPointerDown` (so the buttons and fields inside still work), the same elastic `{ top: 0.08, bottom: 0.6 }` and
  `dragSnapToOrigin`. When released past the threshold, animate `y` to the panel's height with the release velocity
  (`springs.sheet` plus `velocity`), then dismiss. Reduced motion: keep the drag and use the existing fade.
- **Effort:** M. **Decides:** builder.

### 2. Button-like rows, chips, steppers and icon buttons with no press state on touch
- **Area:** cross-cutting (Sales, Pipeline, lead page, Inventory, client share page, imports).
- **Principle:** instant feedback (checklist 1: a press state within 100 ms).
- **What's wrong:** `globals.css:138` turns off the browser's tap highlight, and Tailwind 4's `hover:` only applies to
  pointers that can hover. These controls style only `hover:`, so a tap on a phone shows nothing until the result arrives.
  The leads and stock rows already do this right (`active:bg-muted/50`), as do the outcome pad and the chips.
  - Rows: `sales/sales-tabs.tsx:132`, `:425`; `pipeline/closed-deals.tsx:89`; `lead/deal-summary-card.tsx:34`;
    `lead/deals-tab.tsx:150`; `inventory/tab-lists.tsx:138`; `home/recent-activity.tsx:89`.
  - Links styled as buttons: `share-links/link-card.tsx:222`, `:235`, `:392` (WhatsApp / Email).
  - Icon buttons: `sales/hold-and-request-sheets.tsx:365`, `sales/record-sale-sheet.tsx:300`, `share/share-request.tsx:89`,
    `:218`, `:239`.
  - Client share page steppers and segments: `share/share-request.tsx:98`, `:112`, `:117`; `share/share-page.tsx:177`.
  - Chips and tabs: `sales/sales-tabs.tsx:107` (lead filter chip); `pipeline/board.tsx:696` (phone stage tabs).
  - Bulk bars: `inventory/tab-lists.tsx:109`, `:112`; `leads/leads-workspace.tsx:346`.
  - Others: `activity/open-deal-switch.tsx:39` (switch row); the drop-zone labels in `import/choose-step.tsx:72` and
    `stock-import/stock-choose.tsx:70`.
- **Minimal fix:** rows get `active:bg-muted/50` (the leads-row recipe). Buttons, chips, steppers and icon buttons get
  `active:scale-[0.97]` and add `scale` to their `transition-[…]` list (the recipe from the consistency audit). No new
  tokens.
- **Effort:** S–M (about 25 class edits). **Decides:** builder.

### 3. Home and lead-page task tick: the row vanishes before the check fills
- **Area:** Home "Today" card and the lead page's Tasks card.
- **Where:** `home/today-card.tsx:102-110` (the row leaves the cache immediately) with the check at `:41-52`;
  `lead/lead-cards.tsx:94` with the check at `:113-124`. Compare `tasks/task-row.tsx:94`, `:107-115` and
  `tasks/tasks-workspace.tsx:114-117`.
- **Principle:** feedback, spatial consistency (the same action looks the same everywhere).
- **What's wrong:** on the Tasks page a tick fills the circle, then the row fades and its neighbours spring up. On Home
  and on the lead page the row disappears in the same frame as the tap. The filled check is never seen, and every row
  below jumps up by one row. This is one of the most frequent actions in the app.
- **Minimal fix:** reuse the Tasks page pattern. Show the row checked for the same short delay the Tasks page uses, then
  remove it inside `AnimatePresence initial={false}` with `layout="position"` and `springs.smooth` (fade under reduced
  motion). Focus handling stays as it is.
- **Effort:** M. **Decides:** builder.

### 4. The command menu cannot find a lead
- **Area:** shell (Cmd+K, "/", the top-bar "Search…").
- **Where:** `shell/command-palette.tsx:23` ("Searching leads joins it when leads exist (Day 3)", never done) and
  `:74-202` (only sections and actions); `messages/en.json` `Header.searchHint` "Search…"; Shortcuts "/" = "Search".
  Master Plan §4: "Command palette Cmd+K: jump to any lead".
- **Principle:** keyboard-first (one keystroke to any object).
- **What's wrong:** the top bar says "Search…" and "/" is labelled "Search", but typing a company name in the menu
  finds nothing. With 30k leads this is the main path a keyboard user would expect.
- **Minimal fix:** a debounced lead group in the menu, fed by a server RPC search. Per CLAUDE.md, user text never goes
  into `.or()`. Results are keyset-limited, open the lead page or the preview on Enter, and are prefetched on highlight.
- **Effort:** L. **Decides:** HAIDER DECIDES (new feature and new query; the copy stays as it is).

### 5. Work queue Undo: the card comes back from the wrong side
- **Area:** work queue.
- **Where:** `queue/queue-workspace.tsx:669-692` and `:781-797` (`CardShell` always enters from `x: 32`, leaves to
  `x: -32`); `queue/use-queue.ts:449` (Undo puts the logged card back at the front).
- **Principle:** spatial consistency (things return the way they left).
- **What's wrong:** a logged card leaves to the left and the next one comes in from the right. Undo brings the old card
  back from the right as well, and pushes the current one off to the left, so it looks like a new card rather than the
  one you just left.
- **Minimal fix:** give `AnimatePresence` a `custom` direction (`+1` for next, `-1` for an undo) and pass it to the
  variants of `CardShell`. On an undo the card enters from `x: -32` and the current card leaves to `x: +32`. The spring and
  the reduced-motion fade stay as they are.
- **Effort:** S. **Decides:** builder.

### 6. Dialogs and sheets cannot reverse mid-animation
- **Area:** shell (every dialog, phone sheet, side sheet and the deal sheet).
- **Where:** `src/app/globals.css:231-242`, `:259-264`, `:294-299`, `:323-336`. These are CSS keyframes switched by
  Radix `data-state`. The closing keyframes have only a `to`, so they start from the resting style.
- **Principle:** interruptible, animate from the current value (checklist 4).
- **What's wrong:** if a sheet is closed while it is still rising (an Escape, a backdrop tap, a mis-tap), it first snaps
  to fully open and then slides down. Dialogs do the same over 200 ms. Nothing goes back from where it is on screen.
- **Minimal fix:** move these to CSS transitions, which reverse from the current value: `transition: transform, opacity`
  on `[data-state]`, with `@starting-style` for the entry and `transition-behavior: allow-discrete`. Or drive the content
  with Motion and `forceMount`. Keep the same curves and durations and the reduced-motion block.
- **Effort:** M. **Decides:** builder.

### 7. A grabber with nothing to grab; phone sheets cannot be swiped down
- **Area:** shell / Pipeline (deal sheet), and every `phoneSheet`.
- **Where:** `pipeline/deal-sheet.tsx:128` (a grabber bar on phones); `ui/dialog.tsx:276-277` (`phoneSheet`). Only the
  call panel has a pull-down (see #1).
- **Principle:** direct manipulation; a visible affordance must work.
- **What's wrong:** the deal sheet draws the iOS grabber, but dragging it does nothing. Other bottom sheets look like iOS
  sheets but can only be closed with ✕ or a tap outside.
- **Minimal fix (choose one):** (a) add swipe-down-to-dismiss to the deal sheet, then to all `phoneSheet`s, built the
  same way as the fixed call panel (#1), with rubber band, velocity projection and ✕ kept; or (b) remove the grabber so
  nothing false is promised.
- **Effort:** M (a), S (b). **Decides:** HAIDER DECIDES (a new gesture in every sheet, or a visual removal).
  Recommendation: (a) on the deal sheet first.

### 8. The Inventory side panel replays its entrance on every product
- **Area:** Inventory (1280 px and up).
- **Where:** `inventory/inventory-workspace.tsx:383` (`<div key={ui.product} className="animate-panel">`),
  `globals.css:300-308`.
- **Principle:** calm and restraint (no motion that carries no meaning); consistency with Leads, whose preview updates in
  place.
- **What's wrong:** stepping through the stock list with J/K or the arrows replays a 12 px slide on every row, so the
  panel twitches with each key. The Leads preview does the same job without moving.
- **Minimal fix:** put `animate-panel` on the `<aside>`, so it plays when the panel opens. Keep the key on the content so
  its state still resets per product.
- **Effort:** S. **Decides:** builder.

### 9. Toasts rise in and then disappear
- **Area:** shell (every toast, including the Undo toasts).
- **Where:** `ui/toast.tsx:53` (entrance `animate-page`), `:36`, `:62` and `:75` (the toast is removed in one frame).
- **Principle:** spatial consistency (leave the way you came), calm.
- **What's wrong:** the toast rises 8 px and fades in, but on timeout, Undo or ✕ it vanishes in a single frame, right
  above the dock where the eye is.
- **Minimal fix:** keep the leaving toast mounted for a 120–160 ms exit (fade plus 8 px down, transform and opacity), with
  `AnimatePresence` or a `data-state` CSS exit. Reduced motion: instant, as now.
- **Effort:** S. **Decides:** builder.

### 10. Leads list keyboard: J/K missing, and "/" means something else here
- **Area:** Leads list.
- **Where:** `leads/leads-table.tsx:200-201` (only ArrowUp/ArrowDown) vs `inventory/stock-table.tsx:116` (arrows and
  J/K); `inventory/stock-toolbar.tsx:53` ("/" focuses the stock search) vs `shell/keyboard-layer.tsx:66` ("/" opens the
  command menu everywhere else, which cannot search leads: #4).
- **Principle:** keyboard-first, consistency of shortcuts.
- **What's wrong:** J/K moves through the stock list and through leads on the lead page, but not through the leads list.
  On Leads, "/" (labelled "Search") does not reach the leads search box that sits on the page.
- **Minimal fix:** accept `j`/`k` in the leads table's `onKeyDown` (same guard as the stock table). On Leads, "/" focuses
  the toolbar's search the way Inventory does (copy the `stock-toolbar.tsx:53` handler).
- **Effort:** S. **Decides:** builder.

### 11. Text links give no response to a tap on a phone
- **Area:** cross-cutting (examples: `home/low-stock-card.tsx:40`, `home/pipeline-snapshot.tsx:56`,
  `home/today-card.tsx:137`, `home/attention-card.tsx:91`, `auth/forms.tsx:125`, `:174`, `lead/details-tab.tsx:88`, `:98`,
  `leads/lead-preview.tsx:140`, `:150`, `lead/deal-summary-card.tsx:53`, `:57`; Analytics `card.tsx:69` on PR #28).
- **Principle:** instant feedback.
- **What's wrong:** for the same reason as #2 (tap highlight off, hover only for pointers), "See all", "Forgot password?",
  phone, email and similar text links show nothing while pressed.
- **Minimal fix:** one base rule in `globals.css`, e.g. `:where(a[href], button):active { opacity: 0.6 }` with an opacity
  transition. Or `active:opacity-60` on the underline-style links. Existing scale presses override it.
- **Effort:** S. **Decides:** builder.

### 12. The import drop zones flicker while a file is dragged over them
- **Area:** leads import and stock import (step 1).
- **Where:** `import/choose-step.tsx:78`, `stock-import/stock-choose.tsx:76` (`onDragLeave={() => setDragging(false)}`).
  `files/files-tab.tsx:361` already does it right.
- **Principle:** feedback that holds steady while the action lasts.
- **What's wrong:** `dragleave` fires every time the pointer crosses into the icon or text inside the label, so the
  highlight flickers on and off while the file moves over the zone.
- **Minimal fix:** the Files tab's guard: `if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false)`.
- **Effort:** S. **Decides:** builder.

### 13. The client share page's basket bar pops in
- **Area:** client share page (`/s/…`, used by clients on their phones).
- **Where:** `share/share-page.tsx:258-259`.
- **Principle:** spatial consistency (things come from where they live).
- **What's wrong:** when the first item goes into the basket, the bar fixed to the bottom edge appears in one frame. It
  belongs to the bottom edge but does not come from it.
- **Minimal fix:** give it the phone sheets' rise (`sheet-in`: translateY from 100 %, 320 ms, existing curve) on mount.
  Reduced motion makes it instant (the global block already does this).
- **Effort:** S. **Decides:** builder.

### 14. Right-click does not open menus that already exist
- **Area:** Tasks page and the lead page timeline.
- **Where:** `tasks/task-row.tsx:187-207` and `activity/timeline.tsx:787-810` (⋯ menus with no context-menu wrapper).
  Only `pipeline/deal-card.tsx` uses `ui/context-menu.tsx`.
- **Principle:** keyboard and desktop first (CLAUDE.md: "context menus").
- **What's wrong:** on a Mac, right-clicking a task or a timeline entry brings up the browser's menu, although the same
  row has a menu one click away. Shift+F10 and the Menu key do nothing either.
- **Minimal fix:** wrap the row in `ContextMenu` with the same items as its ⋯ menu, as `deal-card.tsx` does. No new
  actions.
- **Effort:** S–M. **Decides:** builder.

### 15. Count-up numbers restart from the old target when interrupted
- **Area:** Home KPI tiles; Analytics KPI tiles (PR #28 reuses `CountUp`, and changing a filter re-counts).
- **Where:** `home/count-up.tsx:66` (`from` = `shown.current`, the last target, not the value on screen).
- **Principle:** interruptible, animate from the current on-screen value.
- **What's wrong:** if a figure changes while it is still counting (scope switch on Home; clicking range presets in a row
  on Analytics), the number first jumps to the previous target and then eases to the new one.
- **Minimal fix:** keep the live value in a ref updated in `onUpdate`, and start the next run from it.
- **Effort:** S. **Decides:** builder.

### 16. A dropped deal card's settle ignores the speed of the throw
- **Area:** Pipeline board.
- **Where:** `pipeline/settle.ts:32` (`springs.settle`, initial velocity 0); `pipeline/board.tsx:535-538` (only the drop
  rectangle is passed on).
- **Principle:** momentum (the release speed carries into the settle).
- **What's wrong:** a card thrown into a column comes to a stop and then eases home. The motion does not continue from the
  hand. This is subtle, because most moves are placed rather than thrown.
- **Minimal fix:** track pointer velocity over the last ~50 ms in `onDragMove`, then pass it as `velocity` on the `x` and
  `y` springs in `settle()`. The critically damped spring and the reduced-motion fade stay.
- **Effort:** M. **Decides:** builder.

### 17. The TOTP code needs an extra tap
- **Area:** auth (MFA sign-in, setup) and the step-up dialog (stock changes, imports, exports, deletes, role changes).
- **Where:** `auth/forms.tsx:68-84` (`CodeField`), `auth/step-up-dialog.tsx:195`.
- **Principle:** feedback and flow (iOS fills a one-time code and continues).
- **What's wrong:** after the code is typed or autofilled (`autocomplete="one-time-code"`), the user still has to press
  Verify. Step-up comes up several times a day.
- **Minimal fix:** submit the form once the field holds 6 digits, at most once per value. Keep the Verify button as the
  fallback.
- **Effort:** S. **Decides:** HAIDER DECIDES (changes the behaviour of a security step).

### 18. The -3 % heading tracking also squeezes small headings and a mono heading
- **Area:** cross-cutting typography.
- **Where:** `src/app/globals.css:156-161` (`h1, h2, h3 { letter-spacing: -0.03em }`). It applies to 24 headings of
  12–16 px (e.g. `activity/call-panel.tsx:407`, `lead/lead-cards.tsx:45`, `pipeline/column.tsx:163`,
  `lead/deals-tab.tsx:115`) and to a DM Mono heading (`activity/timeline.tsx:422`).
- **Principle:** typography (Apple tightens tracking only at display sizes; small text stays neutral, and monospaced
  text is never tracked).
- **What's wrong:** 12–14 px bold headings are packed tighter than the body text around them, and the mono date heading
  loses its even spacing.
- **Minimal fix:** limit the -3 % to headings of 20 px and up (e.g. `h1, h2, h3:where(.text-xl, .text-2xl, …)`, or a
  heading utility), and use `letter-spacing: normal` on `font-mono`. DESIGN.md's type line would say "-3 % at 20 px and
  up".
- **Effort:** S. **Decides:** HAIDER DECIDES (DESIGN.md type rule, visible change).

### 19. A tap on the dock bead gives no press response
- **Area:** shell (dock).
- **Where:** `shell/dock.tsx:187-219` (`whileDrag` scale only, line 210; no `whileTap`).
- **Principle:** instant feedback.
- **What's wrong:** the section links shrink on press (`group-active:scale-[0.86]`), but the bead, the brightest thing on
  screen, does not react to a tap that has not turned into a drag (a bead tap opens the section's main page).
- **Minimal fix:** `whileTap={reduce ? undefined : { scale: 0.94 }}` with `springs.bead`. The drag's 1.08 still wins
  once a drag starts.
- **Effort:** S. **Decides:** builder.

### 20. First Home: the KPI tiles rise twice
- **Area:** Home.
- **Where:** `home/kpi-card.tsx:40` (`shouldRise() && "animate-page"`) inside `(app)/template.tsx:18`, which plays the
  same rise on the first visit to `/`.
- **Principle:** restraint (one entrance per thing). The consistency audit removed the product page's nested rise for the
  same reason.
- **What's wrong:** on a tab's first Home the tiles travel 16 px on two stacked 220 ms curves while the rest of the page
  travels 8 px.
- **Minimal fix:** drop the tile's own `animate-page` (the page rise and the count-up remain), or skip the template rise
  on `/`.
- **Effort:** S. **Decides:** builder.

### 21. Translucent bars without the reduced-transparency fallback
- **Area:** materials (client share page, pipeline, stock import).
- **Where:** `share/share-page.tsx:259` (`bg-card/95 backdrop-blur`), `pipeline/board.tsx:693` (phone stage tabs),
  `stock-import/stock-check.tsx:257`, `stock-import/stock-match.tsx:248`.
- **Principle:** materials and depth (DESIGN.md: glass only with a solid fallback under `prefers-reduced-transparency`).
- **What's wrong:** `.dock-glass` has both fallbacks, but these four blurred bars have none.
- **Minimal fix:** add a `@custom-variant reduced-transparency (@media (prefers-reduced-transparency: reduce))` and
  `reduced-transparency:bg-card reduced-transparency:backdrop-blur-none` (or `bg-background`) on the four bars.
- **Effort:** S. **Decides:** builder.

### 22. `font-medium` on Outfit, which ships only 400 and 700
- **Area:** Home.
- **Where:** `home/today-card.tsx:60`, `:65`; `home/low-stock-card.tsx:71`; `home/attention-card.tsx:44`. (`font-medium` on
  `font-mono` is correct: DM Mono 500.)
- **Principle:** typography (DESIGN.md: Outfit 400 and 700 only).
- **What's wrong:** the browser falls back to Outfit Regular, so these titles already render at 400. The class suggests a
  weight that does not exist, and the next person to change fonts may "fix" it.
- **Minimal fix:** remove `font-medium` from those four spans. Nothing changes on screen. (Making them bold would be a
  visual change for Haider.)
- **Effort:** S. **Decides:** builder.

### 23. Empty Leads for a rep shows two red "Add lead" buttons
- **Area:** Leads (empty state, non-admin roles).
- **Where:** `leads/leads-workspace.tsx:231` (`variant={isAdmin ? "quiet" : "brand"}`) together with the header's
  `:277` (red by default).
- **Principle:** restraint (DESIGN.md: one red primary action per screen).
- **What's wrong:** the consistency audit fixed this for admins (Import went quiet). For a rep or manager, both "Add lead"
  buttons are Signal Red. All three users are admins today, so nobody sees it yet.
- **Minimal fix:** `variant="quiet"` for the empty state's Add in every role. The header Add stays the one red button.
- **Effort:** S. **Decides:** builder (applies the existing one-red rule, as the consistency audit did).

### 24. Right-click menus for lead and stock rows
- **Area:** Leads list and stock list.
- **Where:** `leads/leads-table.tsx:293-310`, `inventory/stock-table.tsx:239-253` (rows have no menu at all).
- **Principle:** desktop and keyboard first (Master Plan §4: "Right-click context menus on rows and cards").
- **What's wrong:** on desktop the only route to row actions (open as page, change status or owner, call, hold stock,
  record sale) is to open the row first.
- **Minimal fix:** a `ContextMenu` per row with a short set of existing actions (open, open as page, change owner or
  status for leads; open, sell, hold for stock), each one calling the same code paths that exist today.
- **Effort:** M. **Decides:** HAIDER DECIDES (which actions go in the menu).

---

## Checked and clean (no finding)
- **Dock:** the bead drags 1:1 with `touch-action: none`, rubber-bands at the ends (elastic 0.05), lands by velocity
  projection (0.99) on the `bead` spring started from the current value, gives a haptic tick, uses arrow, Home and End
  keys, works with real links, and moves instantly under reduced motion with drag kept.
- **Tabs:** the pill slides with `layoutId` and `springs.smooth` and is interruptible; roving tabindex; reduced motion
  moves it instantly. The phone stage tabs' pill likewise.
- **Pipeline:** the card press is a 0.97 scale; hover is a tint, never a lift; the drag ghost lifts to 1.03 on `snappy`;
  the drop settles from the release point; the neighbours move with `layout="position"`; full keyboard drag and
  announcements; the Lost band rises; reduced motion is honoured everywhere.
- **Work queue** card slide (`snappy`, `popLayout`, interruptible); outcome pad and chips press at 0.97.
- **Reduced motion:** the global CSS block, `useReducedMotion` in every Motion component, `motion-safe:` on every pulse,
  and smooth scrolling gated in all three places.
- **Materials:** shadows and glass only on floating layers (dock, call panel, popovers, menus, dialogs, toasts); the
  dock has both glass fallbacks.
- **Brand:** Signal Red only on the bead, Call, primary buttons and the logo mark, always with black text (except #23 for
  reps). Outfit and DM Mono self-hosted with `next/font/local`; money and counts in DM Mono with `tabular-nums`.
- **No spinners**; skeletons everywhere. The count-up has no layout shift (mono ghost copy).
- **Analytics (PR #28):** monochrome ramp, first-visit bar growth on `springs.smooth`, collapsed before paint, never
  under reduced motion; presets press at 0.97; keyboard grid on the heatmap. Only #11 and #15 apply.
- **More / Team, inventory settings, client view, product page, auth layout:** no Apple-principle issues beyond the
  cross-cutting #2, #11 and #17.
