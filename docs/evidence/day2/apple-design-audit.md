# Apple design audit: Day 2 (app shell, dock, command menu), 9 Oct 2026

Checklist: docs/apple-design-audit.md (12 items) plus the apple-design skill's through-line ("motion starts from the current
on-screen value, inherits the user's velocity, projects momentum forward, and can be grabbed and reversed at any instant").
Screens: Home, five section placeholders, More (name, settings, status), the dock on desktop and phone, command menu, shortcuts list.

| # | Item | Finding | Fix |
|---|---|---|---|
| 1 | Instant response | Dock icons press to 0.86 (prototype value, icon only), buttons 0.97, palette rows highlight on hover/arrow at once | none |
| 2 | Tracks the finger | Bead follows the pointer 1:1 (Motion drag, x motion value, no React state per frame), `touch-action: none` on the bead | dock text made unselectable during drags (`select-none`) |
| 3 | Momentum | Release projects the flick (deceleration 0.99) and snaps to the nearest section with the `bead` spring, carrying the release velocity | none |
| 4 | Interruptible | Grabbing the bead mid-spring stops the spring and continues from where it is; a new tap retargets the spring from the current value | an instant placement used `set()`, leaving a velocity that made the next spring swing across the bar: now `jump()` |
| 5 | Rubber-band | `dragElastic` 0.05 at both ends | none |
| 6 | Animate from current value | Bead springs from its current position to the new section on every navigation; it never jumps back to a start slot | none |
| 7 | Calm | No constant motion; greeting words rise once per tab; page enter is 220 ms fade + 8 px; dialogs settle from 98% in 200 ms | none |
| 8 | Reduced motion | Bead moves instantly (jump, no spring, no projection); CSS entrances collapse via the global block; tested in e2e | none |
| 9 | Materials and depth | Glass only on the dock (solid under reduced transparency or without backdrop-filter); dialogs are solid cards with a shadow over a dim overlay | none |
| 10 | Typography | Outfit 700 titles, DM Mono key caps; French labels fit at 390 (dock labels truncate safely; longest is "Prospects") | none |
| 11 | Status never colour-only | The only status (database reachable) has its sentence | none |
| 12 | Spatial consistency | Dock bottom-centre on every width; the bead comes from and returns to the bar; sections hidden on phones light up More | tapping the bead on More (phone, while on Tasks) now opens More |

Known gaps: **there is no notch at all.** Master Plan 4 describes a bead sitting in a notch cut into the bar (one SVG path
whose notch follows the bead's x and velocity). The dock instead follows the prototype Haider approved: the bead floats above a
glass bar inside a ring of page colour ("halo"), and nothing is cut into the bar, so there is nothing to stretch either. Whether
that look is accepted for Release 1, with the notch and its stretch moved to the Day 9 polish, is put to Haider. Also: page entrances are
CSS keyframes (not springs) so they replay rather than reverse if you navigate mid-entrance (220 ms, judged acceptable); the command
menu opens centred rather than from the search button (it is opened from the keyboard most of the time).
