# Apple design audit: Day 1 step 2b (sign-in screens), 9 Oct 2026

Checklist: docs/apple-design-audit.md. Screens: sign in, forgot password, email-link landing, choose password,
two-factor setup (QR), enter code, signed-in home. One narrow card under the brand header; one red button per screen.

| # | Item | Finding | Fix |
|---|---|---|---|
| 1 | Instant response | Every button presses to 0.97 within 150 ms; the label changes at once to "Signing in…", "Checking…" (no spinner) | none |
| 2 | Tracks the finger | Nothing draggable | n/a |
| 3 | Momentum | n/a | n/a |
| 4 | Interruptible | n/a (no animations beyond press feedback) | n/a |
| 5 | Rubber-band | Page rubber-band off on fine pointers only (existing rule) | none |
| 6 | Animate from current value | No layout jumps: the message line keeps its height whether empty or showing an error | reserved the line (`min-h-6`) |
| 7 | Calm | No entrance animation on sign-in screens; skeleton pulse only while loading, `motion-safe` | none |
| 8 | Reduced motion | Global reduced-motion block covers the press transition and skeleton pulse | none |
| 9 | Materials and depth | Card by tone only (white on chalk, charcoal on black), no shadows; inputs sit on page tone inside the card | inputs used the card colour and faded into it; now page tone |
| 10 | Typography | Outfit 700 headings, DM Mono for the 6-digit code (spaced) and the setup key (grouped by 4); French titles wrap cleanly at 390 ("Continuer / vers TopStock") | curly apostrophes, French non-breaking space before `?` `:` |
| 11 | Status never colour-only | Errors are sentences with the fix ("Use the one showing now"), not just a red border | none |
| 12 | Spatial consistency | Same header, card width and button position on every step; desktop focus lands in the first field, phones wait for a tap | autofocus limited to fine pointers |

Red use: only the primary button on each screen (black text on red, 4.64:1) and the logo mark. Links are grey text with underline on hover.
Screenshots (76, this folder): signed-out screens against the dev project (sign-in at 390/768/1024/1280/1440/1728; error, forgot,
forgot-done, email-link landing at 390 and 1440; EN/FR, light/dark); signed-in screens (two-factor setup with QR, enter code,
choose password, home; 390 and 1440, EN/FR, light/dark) taken against a real Supabase Auth server built locally
(`scripts/local-auth/start.sh`); CI produces the same set from the full Supabase stack as artifact `auth-screens`.
Also fixed after looking at them: French "Vous êtes connecté / invité" assumed a gender, now neutral; home text curly apostrophes.
