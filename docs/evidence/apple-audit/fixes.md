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

## Screenshots

In `docs/evidence/apple-audit/screens/`, EN, light and dark, 1440 and 390, `-before-` from a86550e and `-after-` from
the final code (24 files). Every shot: no console error, no horizontal scroll (0 px).

| Shots | What to see |
|---|---|
| `leads-empty-rep-{before,after}-en-{light,dark}-{1440,390}.png` | #23: before, two red "Add lead" buttons; after, the empty state's Add is quiet and the header's Add is the one red button |
| `share-basket-{before,after}-en-{light,dark}-{1440,390}.png` | #13: the bar at rest looks the same (its rise is motion, counted in `share.spec`); the only pixel changes are the run's product name and the "Updated" time |
| `home-{before,after}-en-{light,dark}-{1440,390}.png` | #20 and #22: at rest the page is the same. Pixel diff: the Today titles region is identical in both builds (#22); the meeting time differs (seeded relative to the clock); the KPI tiles differ by 13 pixels of at most 2/255 (edge anti-aliasing: the tiles are no longer a separate animated layer). #22 also checked in one page at one instant: adding `font-medium` back to the 6 Outfit titles changes no pixel |
