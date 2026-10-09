# web-design-guidelines on the sign-in screens (Day 1 step 2b, 9 Oct 2026)

Rules: pinned `command.md` at web-interface-guidelines `434b7f9`, SHA-256 `d246b026…0234` (matches the pin).
Files: `src/app/(auth)/**`, `src/components/auth/*`, `src/components/ui/*`, `src/app/page.tsx`. Findings before fixes, then the fix.
Kept by design: sentence case (DESIGN.md, Apple style) over Title Case; no spinners (CLAUDE.md), so a pending button shows "Signing in…" text instead.

## src/components/auth/forms.tsx
forms.tsx:LoginForm - `autoFocus` on email also on phones (keyboard jumps up) → focus only with a fine pointer (`useDesktopFocus`); the code field keeps autoFocus (only input, next thing to do)
forms.tsx:all forms - errors not focused after submit → `useFocusOnError` moves focus to the first `aria-invalid` field; login marks only the password (cleared after a failed try)
forms.tsx:ConfirmLinkForm - button said "Continue" → specific labels "Choose a password" / "Choose a new password"
forms.tsx:SetPasswordForm - comment promised password-manager support but no username field → hidden `autocomplete="username"` with the account email
forms.tsx:TotpSetup - "Copied" change not announced → polite live region
forms.tsx:TotpSetup - copy button 36 px on phones → 44 px below `sm`
messages/*.json:Auth - straight apostrophes → typographic ’; French `?` and `:` get a non-breaking space

## src/components/ui/input.tsx
input.tsx:9 - input background equal to the card in both themes (field edges only from a hairline) → page background inside the card

## src/app/page.tsx
page.tsx:greeting - a long first name could overflow at 390 → `break-words`

✓ pass: every input has a `<label htmlFor>`, `name`, `autocomplete` (`username`, `current-password`, `new-password`, `one-time-code`), correct `type`/`inputmode`, `spellCheck={false}` on email and codes; no paste blocking;
QR `<img>` has `alt`, `width`, `height`; secret key `translate="no"`; errors in a `role="alert"` region linked by `aria-describedby`;
`:focus-visible` ring (global); no `transition: all`; press feedback scale 0.97; skip link reaches `#main` on every sign-in screen;
loading skeletons on every route with a hidden "Loading…" label; no hydration-unsafe values.
