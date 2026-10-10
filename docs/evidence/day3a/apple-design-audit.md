# Apple design audit: Day 3a (leads list, preview, contacts, filters), 10 Oct 2026

Checklist: docs/apple-design-audit.md (12 items) plus the apple-design skill's through-line (motion starts from the current
on-screen value, can be interrupted, and every touch answers at once). Screens: leads list (desktop split view, tablet,
phone), lead preview with contacts, add-lead dialog, filters popover, saved views, columns and sort menus, bulk bar, undo toast.

| # | Item | Finding | Fix |
|---|---|---|---|
| 1 | Instant response | Buttons and menu triggers press to 0.97; menu items highlight on hover and arrow keys; status and owner changes show at once (optimistic) and the server confirms after. Filter ticks briefly flickered back because the filters were read from the URL, which Next.js updates a moment later (caught by a test) | filters now live in React state and the URL follows; table rows gained a press tint (`active:bg-muted/50`) for touch |
| 2 | Tracks the finger | Nothing is dragged on this screen; scrolling is native | none |
| 3 | Momentum | Native scroll momentum in the table and the preview; `overscroll-contain` keeps the page still | none |
| 4 | Interruptible | Popovers and menus use short CSS settle-in/out (160/100 ms), so closing mid-entrance replays the exit rather than reversing (same trade-off as the Day 2 dialogs) | none (accepted: too short to grab) |
| 5 | Rubber-band | The table and preview scroll in their own boxes with the platform's edge bounce | none |
| 6 | Animate from current value | Popovers and menus grow from their trigger (`transform-origin` from Radix). On phones the lead replaced the list with no transition | the phone preview now rises in (220 ms, transform and opacity); on desktop the preview updates in place, like a mail reader |
| 7 | Calm | No constant motion; loading is skeleton rows that match the table (pulse only under `motion-safe`); one toast at a time, gone after 6 s (kept while hovered or focused) | none |
| 8 | Reduced motion | The global reduced-motion block collapses the popover, toast and phone-preview entrances; skeleton pulses are `motion-safe` only | none |
| 9 | Materials and depth | Popovers, menus, dialog and toast float (solid card or black, shadow); the table and preview are flat cards on the page tone; no glass added | none |
| 10 | Typography | Outfit for text, DM Mono for column heads, the lead count, contact counts and phone numbers. French "Dernière activité" was cut in its column head at 140 px; French preview buttons wrap to a second row (never clipped) | last-activity column widened to 170 px |
| 11 | Status never colour-only | Every status is a badge with its word plus a small dot; dot colours use the status tokens (neutral, amber, green, red); the selected row no longer hides the badge background | selected-row tint lightened so badges stay visible |
| 12 | Spatial consistency | Dock stays bottom-centre; the preview always lives to the right on desktop and takes the list's place on phones with "Back to leads" where you came from; Back and Forward work through the URL. The add-lead dialog opens centred, not from its button | none (accepted for now, like the command menu) |

Keyboard: Up and Down move between leads and open each in the preview; every control is reachable by Tab; menus and
popovers trap and return focus (Radix); Escape closes them; the search box clears with Escape.
