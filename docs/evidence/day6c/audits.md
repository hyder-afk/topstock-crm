# Day 6c design audits (12 Oct 2026)

Screens: `screens/` (72 PNGs: Choose, Match and Check at 390/768/1024/1280/1440/1728, light and dark, EN and FR). Rules:
DESIGN.md first, then the Apple design skill and the Web Interface Guidelines (pinned 434b7f9), read against
`src/components/stock-import/*.tsx` and `src/app/(app)/inventory/import/**`.

## Apple design (fluid interfaces)

| Finding | Fix |
|---|---|
| The action bar (sticky above the dock) took a third of a phone screen on Match and Check | Static below 640 px, sticky from `sm` (a1b011d) |
| Past imports filled with discarded checks after a few tries | Discarded checks are left out (a1b011d) |
| Tiles sat on the card colour and read as one block | Tiles and the pieces lines on the page background inside the card (labelled groups) |
| Progress (sending, checking, importing, undoing) | Bars only (scaleX spring, none under reduced motion), no spinners; the import and undo keep the tab-open warning |
| Colour | Red only on the Import button (black text) and dots; status as dot plus words (Matched, Can't import, Imported) |

## Web Interface Guidelines (pinned 434b7f9)

| Rule | Finding | Fix |
|---|---|---|
| Content: no repeated or wrong messages | Every refused row also said "Product name not accepted" (the database's rule on a row sent without values) | The database's own `db_*` reason is shown only when the browser found no problem (a1b011d) |
| Forms | Every select has a label (column name, "Number style", "Where “…” goes"); unknown STATUS values are marked with a red dot and "needs a choice" for screen readers; Continue is disabled with the reason in a status line | none |
| Keyboard | ⌘/Ctrl + Enter runs the step's main action; focus moves to each step's heading; dialogs return focus (Past imports heading after an undo, checked by e2e) | none |
| Numbers | DM Mono with tabular figures; `Intl` for counts, EUR and dates | none |
| Typography | French spaces before `:` `;` `?` `!`, typographic apostrophes and « » quotes (messages spec) | none |
| Tables | The change table scrolls inside its frame at 390 (no page sideways scroll, checked at every width) | none |
| Lists | Loading (skeleton rows), empty ("Every row is ready", "No stock sheet imported yet") and error (retry) states for the rows to look at, the change table and Past imports | none |

No finding left open.
