# Design audits of the audit-fixes branch (17 Oct 2026)

Both audits cover the UI that this branch changes compared with origin/main `c543676`:
- the press motion (scale transitions);
- the first-visit entrance in `(app)/template.tsx`;
- the button variant on empty Leads;
- the pipeline's columns skeleton and board error under the real toolbar;
- the hit area of the Leads filter chips;
- the tab order of the dock bead;
- the tokens (logo mark, Kbd border, sheet radius).

Sources:
- the Apple design skill (`anthropic-skills:apple-design`) with the repo checklist `docs/apple-design-audit.md` (all 12 items);
- the Web Interface Guidelines skill (`web-design-guidelines`), with the rules fetched from the pinned commit
  `vercel-labs/web-interface-guidelines@434b7f9`, `command.md`.

Screens were checked by eye in `docs/evidence/audit/screens/`:
- `leads-empty-admin-{en,fr}-{light,dark}-{1280,1440,1728,390}.png`;
- `pipeline-skeleton-{mine,longest}-en-{light,dark}-{1440,390}.png`;
- `pipeline-board-error-en-{light,dark}-{1440,390}.png`;
- `pipeline-skeleton-mine-fr-{light,dark}-390.png` and `pipeline-board-error-fr-{light,dark}-390.png` (French, added after the merge of main's Next 16.4.1).

In every shot: no horizontal scroll and no console error. The only console lines in the error shots are the two
injected 502s.

A fact both audits rely on: in Tailwind 4.3.3, `active:scale-[0.97]` sets the CSS `scale` property, not `transform`.
A transition only animates the press when its property list includes `scale` (or uses `transition-transform`, which
compiles to `transform, translate, scale, rotate`). Both were checked in the built CSS.

## Apple design checklist (docs/apple-design-audit.md)

| # | Item | Finding (file:line) | Outcome |
|---|---|---|---|
| 1 | Instant response | Every press-scale control in `src/` was listed with a script. All of them animate `scale` (button.tsx:6, toast.tsx:67 and :76, settings-bar.tsx:41, tabs.tsx:136, task-row.tsx:136 and :198, dock.tsx:174, board-toolbar.tsx:57 and :92), except two: `leads-toolbar.tsx:347` (remove a filter chip) and `leads-toolbar.tsx:444` (delete a saved view). Those two pressed instantly with no transition, so they snapped | **Fixed** (f0c92ce): `transition-[color,scale] duration-150` on both |
| 2 | Tracks the finger 1:1 | Dock bead `drag="x"` (dock.tsx:191 onward) is unchanged by this branch. This branch only adds `tabIndex={-1}` (dock.tsx:189) | Pass |
| 3 | Keeps momentum | Unchanged (the bead snaps with a spring in `onDragEnd`) | Pass |
| 4 | Interruptible | The press scale is a CSS transition, so it reverses from its current value. The page entrance (globals.css:199) uses opacity and transform only and never blocks input | Pass |
| 5 | Rubber-bands at the edges | Bead `dragElastic={0.05}` (dock.tsx:193), unchanged | Pass |
| 6 | Animate from the current value | The board keeps its toolbar mounted while a new scope or order loads (board.tsx:629 onward; the swap at :803 to :807). The chips and the Sort button stay where they were, and only the columns area changes | Pass (34f976a) |
| 7 | Calm | `(app)/template.tsx:10-18`: the entrance plays only on the first visit to each pathname in the tab. A return visit renders at rest. Skeletons are used, never spinners (pipeline-skeleton.tsx:63). Before the fix, the totals placeholder kept pulsing even after the read failed (constant motion on an error screen) | **Fixed** (6c94873): it pulses only while the read is on its way (board-toolbar.tsx:70 and :117, board.tsx:657) |
| 8 | Reduced motion | globals.css:344 collapses every animation and transition to 0.01 ms. The page entrance ends at rest (`both` fill). The skeleton pulse is `motion-safe:` only. The bead's `whileDrag` scale is off under reduce (dock.tsx:210), and drag still works | Pass |
| 9 | Materials and depth | The inline board error is a card (`rounded-lg bg-card p-5`, board.tsx:144), toned like the empty-org card. No shadow and no translucency | Pass |
| 10 | Typography | Totals stay in DM Mono with tabular numbers (board-toolbar.tsx:66). The French screens (`leads-empty-admin-fr-*`) show no clipped labels at 390 ("Importer depuis un tableur" fits) | Pass |
| 11 | Status never colour-only | "Stalled only" keeps its amber dot and its label. The board error is text plus Retry | Pass |
| 12 | Spatial consistency | The dock stays bottom-centre in every shot. The error and the skeleton sit exactly where the columns sit | Pass |

Empty-Leads button variant (a check from item 1 of the consistency audit): the header's "Add a lead" is the only red
fill in `main`. "Import from a spreadsheet" (leads-workspace.tsx:226) and "Add a lead" in the empty state are quiet, in
light and dark, EN and FR (screens above). **Pass.**

## Web Interface Guidelines (pinned rules)

### src/components/pipeline/board.tsx
- board.tsx:140-152: the error is `role="alert"` with a next step (Retry). It shows the h1 only when it is the whole
  page (the server read failed). Inline, the toolbar keeps the single h1, so the headings stay in order. Pass.
- board.tsx:803-807: the skeleton and the error take the columns' place only. The toolbar stays mounted, so focus
  never drops to `<body>`. Pass (e2e `sort_and_scope_keep_keyboard_focus_while_a_new_board_loads`).
- board.tsx:657: the totals placeholder pulsed forever after a failure. Fixed (6c94873).

### src/components/pipeline/board-toolbar.tsx
- :57 and :92: chips and radios have explicit transition properties (no `transition: all`), a hover state, and a
  global `:focus-visible` outline (globals.css:162). Pass.
- :70 and :117: the placeholders are `aria-hidden`, and the real values are announced once they load. Pass.
- :83-100 (scope radiogroup, not changed by this branch): each radio is its own Tab stop, with no arrow-key roving.
  Left as it is: out of scope for this branch, and noted for a later keyboard pass.

### src/components/pipeline/pipeline-skeleton.tsx
- :63-71: `aria-busy="true"` with an sr-only label. The label "Loading the pipeline" did not end with "…" (the
  guideline, and most of the app's loading strings, use one). Fixed (f0c92ce): EN "Loading the pipeline…", FR
  "Chargement du pipeline…".
- Its blocks have the same sizes and gaps as the board's columns, so swapping in the board causes no layout jump
  (screens). Pass.

### src/app/(app)/template.tsx
- :14: the server render and the first hydration both carry the class (the module Set is empty on both), so there is
  no hydration mismatch. Pass.
- The animation uses transform and opacity only, honours reduced motion, and cannot be interrupted badly because it
  never blocks input. Pass.

### src/components/ui/button.tsx, toast.tsx, settings-bar.tsx, ui/tabs.tsx, tasks/task-row.tsx, shell/dock.tsx
- Every transition lists its properties explicitly, including `scale` where the control presses. Pass.
- The toast keeps `role="status" aria-live="polite"` (toast.tsx:87). Pass.

### src/components/leads/leads-toolbar.tsx
- :347: the chip's remove button is 28 px to look at and 44 px to tap (`before:-inset-2`). Pass.
- :337: wrapped rows were 8 px apart, but each target reaches 6 px above and below its chip, so two rows' targets
  could overlap by 4 px. Fixed (f0c92ce): `gap-y-3` (12 px).
- :347 and :444: the presses had no transition. Fixed (f0c92ce).
- :438-446 (saved view delete, not changed by this branch): deletes with no confirmation and no Undo. Out of scope
  here; noted for a later pass.

### src/components/shell/dock.tsx
- :186-189: the bead is `aria-hidden` and now `tabIndex={-1}`, so nothing aria-hidden can take focus. The `shell`
  e2e test checks this. Pass.

### Tokens
- logo.tsx:13: `fill-brand` is the same Signal Red (`--brand: #f2203e`, globals.css:106). It is not redefined in dark
  mode, so the mark stays red in the dark shots. Pass.
- dialog.tsx:18: `rounded-t-xl` is 24 px, the same as the old `rounded-t-[24px]`. Pass.
- The light-mode status tokens are unchanged (globals.css:110-112). Pass.

## Not done
- WebKit was not run here (CI runs it).
- The two out-of-scope notes above (scope radiogroup arrow keys; saved view delete without Undo) were left for Haider
  to schedule.
