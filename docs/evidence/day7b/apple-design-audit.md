# Apple design audit: Day 7b pickers and the screens that use them, 15 Oct 2026

Checklist: `docs/apple-design-audit.md` (12 items) and the apple-design skill (anthropic-skills:apple-design: motion starts
from the current value, interruptible, springs where something is dragged, calm, restraint). Scope: the app's own
pickers in `src/components/ui` (Select, Combobox, DatePicker and its Calendar, TimePicker, DateTimePicker, Tooltip,
SearchInput, Disclosure, the shared `picker-styles.ts`) and the screens whose fields moved onto them (Leads toolbar and
Add lead, the lead page's Details and Stock tabs, Tasks quick add and task edit, Inventory toolbar, More's time zone; the
dock's Tooltip). Read from the code and from the screenshots in `screens/` (pickers closed and open at 390, 768, 1024,
1280, 1440, 1728; whole changed screens at the same widths; light and dark; EN and FR).

| # | Item | Finding | Fix |
|---|---|---|---|
| 1 | Instant response | Every trigger answers the press at once: field triggers scale to 0.99 (wide fields; 0.97 would jump visibly), icon buttons (calendar, clock, clear search, month arrows, Clear) and day cells to 0.97, list rows tint on highlight. **Finding: the field triggers (Select, Combobox, DatePicker, DateRangePicker) had no hover answer at all**, so with a mouse a field-like button looked inert until pressed | `picker-styles.ts:5` the border darkens to `muted-foreground` on hover (`enabled:not-aria-invalid:hover:`), instant (colour, not animated); a red invalid border stays red and a disabled field does not react |
| 2 | Tracks the finger | Nothing in the pickers is dragged; lists scroll natively | none |
| 3 | Momentum | Native scrolling in every list (`overscroll-contain` keeps the page still under a list) | none |
| 4 | Interruptible | Panels use the shared `floating-content` settle (160 ms in, 100 ms out, transform + opacity). A press during the out animation reopens from where it is (Radix presence); a key pressed while a list opens is handled at once (proven by the keyboard-only runs) | none |
| 5 | Rubber-band | Native edge bounce on touch; lists contain their overscroll | none |
| 6 | Animate from the current value | Popovers, the Select list and tooltips scale in from their trigger (`transform-origin` from Radix's `--radix-*-content-transform-origin`); the Disclosure chevron turns from where it is | none |
| 7 | Calm | No constant motion; the only pulse is the Combobox's loading rows (`motion-safe`); no spinners | none |
| 8 | Reduced motion | The global `prefers-reduced-motion` block collapses the settle, the chevron turn (`motion-reduce:transition-none` too) and the press scale's transition; keyboard and pointer use unchanged | none |
| 9 | Materials and depth | Floating panels are solid cards with a border and the floating shadow (a list over a form must stay readable; DESIGN.md keeps glass for the dock). The tooltip is the inverse chip (black on white, white on black) with a small shadow | none |
| 10 | Typography | Outfit for words, DM Mono for typed dates, times and calendar digits (they line up). French: month and weekday names in French, Monday first, 24-hour times, "jj/mm/aaaa"; the screenshots show no clipped French label at 390 (trigger text truncates with an ellipsis inside its field, the chosen option stays readable in the open list) | none |
| 11 | Status never colour-only | Today in the calendar is bold plus a dot; the chosen option has a tick and "chosen" for screen readers; an invalid field has a red border plus the field's error text and `aria-invalid` | none |
| 12 | Spatial consistency | Every panel opens next to its own field with 8 px between them and 16 px from the screen edges at 390, and focus returns to the field that opened it (the typed DatePicker's calendar gives focus back to its text box) | none |

Further look-throughs (restraint and focus, from the skill):

- **Combobox search box focus.** The search box inside the Combobox panel drops its outline (`focus-visible:outline-none`)
  and showed nothing in its place, so the only focus sign was the caret. Fix: `combobox.tsx:152`, the line under the
  search row takes the focus colour (`focus-within:border-ring`).
- **Disclosure summary hover.** The summary row (for example "Link options") had a pointer cursor and nothing else on
  hover. Fix: `disclosure.tsx:23`, the chevron darkens to the text colour on hover.
- **Red stays rare.** No picker uses Signal Red; the chosen day is the neutral black fill (white in dark), the
  invalid border uses the status red token only with its error text. Kept.
- **Information that lived in `title=`** (removed by the no-native-popups rule): the deal card's stall reason, a deal's
  owner initials, the stock row's on hand / held split, Recent activity's full time. Each is still in the page for
  screen readers (`sr-only`) and visible on the next screen a person opens (deal sheet: days in stage with the stall
  reason and the Owner field; product panel: On hand with "N held"; the lead's timeline: entries under their day's heading with the time). No change.

Result: three fixes (field-trigger hover, Combobox search focus line, Disclosure hover); everything else passes.
