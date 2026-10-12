# Day 6e design audits (12 Oct 2026)

Screens: `screens/` (68 PNGs from `tests/auth/share.spec.ts` "screens": no console errors and no horizontal scroll at
any width): the client page at 360, 390, 768, 1024, 1280, 1440 and 1728; its item and review sheets at 390 and 1440;
the lead's client link card, Settings › Client links and What clients see at 390 and 1440; light and dark, EN and FR.
Rules: DESIGN.md first, then the Apple design skill and the Web Interface Guidelines (pinned 434b7f9), read against
`src/components/share/*.tsx`, `src/components/share-links/*.tsx` and `src/app/(share)/**`.

## Apple design (fluid interfaces)

| Finding | Fix |
|---|---|
| The item sheet's line "999,99 € la pièce · 480 pcs · 20 cartons de 24" broke inside "20 / cartons de 24" at 390 | The price and the availability are two unbreakable pieces that wrap between them (`share-request.tsx`) |
| The review sheet left a 40 px hole under "Looking for something else?" (the empty slot of the 900-character counter) | The counter sits on the label's line; nothing moves when it appears (`share-request.tsx`) |
| The request bar's content ran 24 px wider than the page column from 640 px up ("Your request · 1 item" and Review did not line up with the rows) | The bar uses the column's padding and width (`share-page.tsx`) |
| Settings › Client links: "What clients see" read as a heading (bold, no cue) | Underlined with a chevron, as a link (`sharing-settings.tsx`) |
| What clients see (team) said "10:49 AM" while the client page says "10:49" | 24-hour time on both (`client-view.tsx`), as everywhere in the app |
| After "Add to request" the focus fell to the page | Focus returns to the row that opened the sheet (`returnFocusTo`, 5bd81c5); e2e checks it |
| The pcs/ctn toggle was 36 px tall on phones | 44 px (fd6f404) |
| Motion and loading | The shared `Dialog` (phone sheet from the bottom edge, opacity and scale on desktop, none under reduced motion); skeleton rows (`motion-safe:animate-pulse`) for the first load; no spinners; "Sending…" on the button |
| Colour | Red only on "Send request" (black text in light mode; the logo mark); the selected chip is black (white in dark); "Arriving week of …" a neutral badge; the "sharing on" dot green with words |

## Web Interface Guidelines (pinned 434b7f9)

| Rule | Finding | Fix |
|---|---|---|
| Navigation & state | The language toggle keeps the fragment (the token) and the page; the search and chips are not in the URL because the URL carries the token in its fragment only and the page must not grow a query string a client could forward with it | Accepted |
| Forms | Every field has a label and a `name`; the name field `autocomplete="name"`; quantity `inputMode="numeric"`; the honeypot hidden from people and screen readers (`aria-hidden`, `tabIndex=-1`); the send button stays focusable (`aria-disabled`) with the reason in a live line | none |
| Typography | French spaces (U+202F) before `:` `;` `?` `!` and inside « » (checked by `messages.spec.ts`); typographic apostrophes; prices with `Intl.NumberFormat` (EUR) in DM Mono with tabular figures | none |
| Content | Long product names wrap (`break-words`) and `translate="no"`; the footer says prices exclude VAT, a request is not an order, and that TopStock sees opens and requests | none |
| States | Loading, empty ("Nothing in stock right now. Tell us what you need."), inactive, slow down, error with retry, offline (keeps the last list) and no-JavaScript states | none |
| Keyboard | Tab through search, chips and rows (native buttons); Enter opens the item sheet, Esc closes it and the focus returns to the row; e2e `share_public_keyboard_only_and_language_toggle`. No single-key shortcuts on a client page (a client types in the search field) | none |
| Images & performance | No images but the inline SVG logo; the page's own JavaScript 23.7 KB gzip (`bundle-scan.txt`); the list is a plain list up to 2,000 rows (open risk 4) | none |
| Accepted | Team screens at 390 and 1440 only: the link card, the Settings section and What clients see sit inside the lead page, settings and inventory layouts already shot at every width (4b, 6b, 6d); the client page itself is shot at all seven widths | none |

No finding left open.
