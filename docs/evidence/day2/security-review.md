# /security-review: Day 2 (app shell, command menu, profile name), branch vs origin/main, 9 Oct 2026

**No findings** at confidence 8/10 or higher.

Checked:
- **Sign-in wall on new routes.** Every page in `src/app/(app)` calls `requireSession()` (the layout does too, but layouts are not
  re-run on client navigation and prefetches skip the proxy). Signed-out e2e: `/`, `/leads`, `/mfa`… all redirect to `/login`.
- **`updateProfile` server action** (callable directly): Zod (`first_name`, `last_name`, trimmed, max 80), `requireSession()` (aal2),
  update scoped to `id = claims.sub`, and the database only lets `authenticated` update those columns of their own row (RLS +
  column grants from step 2a). No mass assignment; errors return a short code; names render through React (escaped).
- **Command menu actions** call existing server actions (`signOut`, `setLocale` with its Zod enum) and fixed in-app routes only.
- **Keyboard layer** navigates to fixed hrefs from `src/lib/nav.ts`; single-key shortcuts are ignored while typing in fields.
- **CSP:** `upgrade-insecure-requests` is now sent only on HTTPS requests (always the case on Vercel); scripts stay nonce-only.
  Why: two local screenshot runs failed at the same shot with `ERR_SSL_PROTOCOL_ERROR`. The directive on the plain-HTTP
  test server is the **suspected** cause, **not reproduced** in isolation; Day 1's screenshot runs passed with the same
  directive, and the two full runs after the change passed. Both sides are tested: a plain-HTTP response omits it, and a
  request marked `x-forwarded-proto: https` (as Vercel sends) gets it (signed-out e2e).
- **Dependencies:** `cmdk` 1.1.1 and `@radix-ui/react-dialog` 1.1.23 pinned exactly (1.2.0 was 4 days old, skipped);
  `npm audit --omit=dev`: 0 vulnerabilities. No `dangerouslySetInnerHTML`; Lucide icons only.
- **Profile read failure** (advisor round 1): if the name cannot be read, More shows "Couldn't load your name" and locks
  the form (so a save cannot blank a name it never saw); Home hides the add-name link. Pages that throw render
  `src/app/(app)/error.tsx` inside the shell (plain message, retry; no error details shown).
- **Command menu:** cmdk's Vim keys are off (they swallowed Ctrl+K inside the menu); search starts empty on every opening;
  labels are searchable in both languages (`keywords`); key presses during accent/IME composition are ignored.
- **CI:** every job in ci.yml, db.yml and gitleaks.yml has a time limit; the sign-in journey runs one job per engine.
- **Tests:** shortcuts never fire inside inputs (e2e); profile save works only for the signed-in person (e2e on the full stack in CI).
