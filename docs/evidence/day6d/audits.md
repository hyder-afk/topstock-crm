# Day 6d design audits (12 Oct 2026)

Screens: `screens/` (80 PNGs): the lead's Stock tab and Inventory › Sales at 390/768/1024/1280/1440/1728, the record-sale,
hold and request sheets and Inventory › Requests at 390 and 1440, light and dark, EN and FR (`tests/auth/sales.spec.ts`
"screens": no console errors, no horizontal scroll at any width). Rules: DESIGN.md first, then the Apple design skill
and the Web Interface Guidelines (pinned 434b7f9), read against `src/components/sales/*.tsx`,
`src/components/lead/stock-tab.tsx` and the Inventory tabs.

## Apple design (fluid interfaces)

| Finding | Fix |
|---|---|
| Sale rows at 390 squeezed the lead's name to "M…" and wrapped "No." away from its number (Sales tab and the lead's Bought list) | Phones put the sale on its own line, the type badge and the total under it; the number never wraps (1ba0c7d) |
| "Enregistrer une vente" wrapped to two lines in the phone header (the one red button) | "Vendre" / "Sell" on phones, the full name for screen readers (1ba0c7d) |
| Opening the request sheet with "Add item" opened the product list over the next fields (the list opened on focus) | The list opens on typing, a click or the Down arrow (637b0a5) |
| After picking a product the focus fell to the page | The focus moves to the quantity (637b0a5); e2e checks it |
| Enter typed before the latest search came back picked a row of the older search | Enter waits for the latest letters' results; names that start with the search come first (637b0a5) |
| Sheets and motion | The shared `Dialog` (phone sheet from the bottom edge, opacity + scale on desktop, none under reduced motion); no spinners: the submit button says "Recording…" and skeleton rows hold every list |
| Colour | Red only on Inventory's Record sale (black text); status as dot plus words (New, In progress, Done, Declined; Warehouse inventory and Supplier Stock badges; amber "Below your minimum price") |

## Web Interface Guidelines (pinned 434b7f9)

| Rule | Finding | Fix |
|---|---|---|
| Navigation & state: URL reflects state | The Sales type chips and the Requests status chips lived in component state | `?tab=sales&type=…` and `?tab=requests&status=…` (1ba0c7d); e2e reloads and finds the same list |
| Forms: submit stays focusable | A disabled Record sale button lost the keyboard focus and said nothing | `aria-disabled` with the reason in a live line under it (637b0a5) |
| Forms | Every field has a label and a `name`; `autocomplete="off"` on non-personal fields; prices `inputMode="decimal"`; the below-minimum confirmation is a labelled checkbox | none |
| Typography | French spaces before `:` `;` `?` `!`, typographic apostrophes; "N° 12" / "No. 12" with a non-breaking space (1ba0c7d); DM Mono with tabular figures for money and pieces | none |
| Content | Lead and product names truncate in rows (`min-w-0`), notes wrap at 65 characters | none |
| Lists | Loading (skeleton rows), empty ("No sales yet", "No requests from this client yet. Share your stock to get some.") and error (retry) states for Sales, Requests and each Stock tab section; pages of 50 with "Show more" | none |
| Keyboard | ⌘/Ctrl + Enter records a sale; Cmd+K "Record sale…" opens the sheet; Esc closes the list then the sheet; focus returns to the opener (Radix) | none |
| Accepted | `autoFocus` on the sheets' first search field also on phones: the next action is to type, and CLAUDE.md asks for keyboard-first sheets | none |

No finding left open.
