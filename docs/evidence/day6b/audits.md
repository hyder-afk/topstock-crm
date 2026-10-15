# Day 6b design audits (12 Oct 2026)

Screens: `screens/` (72 PNGs; stock table and product at 390/768/1024/1280/1440/1728, Arriving, Movements and the
correction dialog at 1440 and 390; light and dark, EN and FR). Rules: DESIGN.md first, then the Apple design skill and
the Web Interface Guidelines (pinned 434b7f9), read against `src/components/inventory/*.tsx` and
`src/app/(app)/inventory/**`.

## Apple design (fluid interfaces)

| Finding | Fix |
|---|---|
| The product panel at 1440 squeezed the table until columns were cut | The table picks its layout from its own width (ResizeObserver): wide with cost from 1000 px, medium from 600 px, cards below (eb936f9) |
| The side sheet (1024 to 1279) appeared without motion | Slides in with a spring-like curve on transform and opacity; reduced motion gets a fade only (`globals.css`, eb936f9) |
| The split panel popped in | `animate-panel` (translate + opacity, interruptible CSS animation; none under reduced motion) |
| Toolbar wrapped to two lines at 768 | Narrower category and sort menus at `sm`, one line at 768 (eb936f9); at ≥ 1280 the French "Toutes les catégories" was cut, so the category menu is wider from `xl` (this commit) |
| Taps under 44 px on phones (links in the panel, the clear-search button) | `min-h-11` links and 44 px buttons below `sm` (eb936f9) |
| Status colour | Only as a dot plus a word (In stock, Low, Sold out, Arriving); red stays for the primary action, the dock bead and Call |

Kept: numbers in DM Mono with tabular figures; one primary action per surface (New product, Arrived in the panel);
skeletons that match the final layout in every `loading.tsx`; no spinners.

## Web Interface Guidelines (pinned 434b7f9)

| Rule | Finding | Fix |
|---|---|---|
| Forms: `name` and `autocomplete` | Product form inputs had no `name` | `name` on every field, `autoComplete="off"` on non-personal fields (eb936f9) |
| Content: translation | Product names and references were translated by browsers | `translate="no"` on names and `P-0042` references |
| Focus | Focus must never drop to `<body>` (sheet, dialogs, tabs) | Dialogs and the sheet return focus to their opener (Radix); `inventory_keyboard_only` checks the focus never lands on `<body>` |
| Keyboard | `/` was taken by the global palette | Capture-phase listener on the toolbar (quiet while typing or with a dialog open) |
| Typography | French spaces before `:` `;` `?` `!` and the typographic apostrophe | `tests/unit/messages.spec.ts` covers `Inventory` and `InventorySettings` |
| Numbers and dates | `Intl` everywhere (pieces, EUR, "Week of Oct 19" / "Semaine du 19 oct.") | none |
| Animation | Only transform and opacity; `prefers-reduced-motion` honoured | none |
| Lists | Loading, empty and error states on every list (checked by `inventory_empty_and_error_states`) | none |

No finding left open.
