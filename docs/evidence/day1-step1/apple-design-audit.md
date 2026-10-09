# Apple design audit: Day 1 step 1 (foundation placeholder screen), 9 Oct 2026

Checklist: docs/apple-design-audit.md. Screen: `/` (placeholder: logo, language and appearance controls, status card).
Most motion items apply from Day 2 (dock, bead, sheets); recorded here as not applicable yet.

| # | Item | Finding | Fix |
|---|---|---|---|
| 1 | Instant response | Segmented buttons and the error button press to 0.97 within 150 ms | none |
| 2 | Tracks the finger | Nothing draggable yet | n/a until the dock (Day 2) |
| 3 | Momentum | n/a | Day 2 |
| 4 | Interruptible | n/a | Day 2 |
| 5 | Rubber-band | n/a | Day 2 |
| 6 | Animate from current value | Theme switch uses `disableTransitionOnChange` so colours do not cross-fade from a stale state | none |
| 7 | Calm | No constant motion; skeleton pulse only while loading, `motion-safe` only | none |
| 8 | Reduced motion | Global reduced-motion block; skeleton pulse is `motion-safe:` | none |
| 9 | Materials and depth | Cards use tone (white on chalk, charcoal on black), no shadows; only the selected segment has a hairline shadow | none |
| 10 | Typography | Outfit 400/700 and DM Mono 500, self-hosted; headings -3% tracking and balanced; French heading wraps cleanly at 390 | none |
| 11 | Status never colour-only | Database status dot has a text label ("reachable" / "not reachable") | made the status live (it was a fixed sentence) |
| 12 | Spatial consistency | Single screen; header controls wrap under the logo at 390 without sideways scroll | none |

Found during the step and fixed: the appearance control showed no selected option after load (server/client hydration);
the selected segment in dark mode was darker than its track (new `--pill` token).
