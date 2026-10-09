# /security-review: Day 1 step 2 (2a database + 2b sign-in), working tree vs origin/main, 9 Oct 2026

**No findings** at confidence 8/10 or higher. Residual risks are listed at the end for Haider's awareness.

Checked (2b):
- **Sign-in wall, two layers.** `src/proxy.ts` redirects no session → `/login` and aal1 → `/mfa` (fails closed when the Supabase
  values are missing); every page and every server action calls `getGate()`/`requireSession()` again on the server. aal comes from
  `getClaims()` (JWT signature verified), the authenticator list from `listFactors()` (auth server, not the cookie).
- **Server actions** (callable by anyone who knows the action id): each validates input with Zod and re-checks the session state.
  Setup refuses unless the user has no verified authenticator (no second factor at aal1); finishing setup checks the factor is the
  caller's own unverified TOTP factor; changing the password needs aal2 when an authenticator exists, so a reset link alone never
  bypasses two-factor. Next's Origin check covers CSRF.
- **No open redirect.** The only "continue to" value is allow-listed (`/set-password`), everything else goes to `/`.
- **No account enumeration.** Wrong email, wrong password, unconfirmed email all return the same message; reset always answers
  "if that address has an account".
- **Email links** use a one-time token hash and are only spent by a POST from the Continue button (mail scanners that open links
  cannot use them); only `invite` and `recovery` types are accepted; redirect allow-list unchanged.
- **No raw errors or PII in logs**: actions return short codes; no `console.*`; no `dangerouslySetInnerHTML` (the QR code is an `<img>`
  data URL, allowed by `img-src data:`).
- **Proxy redirects** keep refreshed session cookies and the no-store headers; CSP header set on redirects too.
- **CI auth job** uses only the local stack's built-in demo keys (masked), never project values; artifacts contain throwaway users only.

Checked (2a), see also docs/log.md: RLS on all 12 tables with a restrictive aal2 policy; anon revoked; org and owner set by trigger;
`set_user_role` admin + aal2 + same org + last-admin guard; append-only audit log; two-user attack test green on real Supabase in CI.

Residual risks (accepted for now, revisit at Gate 1):
1. Enrol-on-first-sign-in: someone who steals a password before its owner sets up two-factor could enrol their own app. Mitigated by
   inviting people only when they are ready to finish setup at once, and by the "two-factor added" notice email.
2. Supabase's per-IP rate limits see Vercel's server addresses, so all three users share one bucket. Brute force is still capped;
   the worst case is a few minutes' lockout for everyone during an attack.
3. Session cookies are readable by page scripts (Supabase default, needed by its browser client); the strict nonce CSP is the XSS control.
4. Lost authenticator: no recovery codes yet; an admin removes the factor in the Supabase dashboard and the person sets up again.
5. Default Supabase email only delivers to the Supabase team's addresses: fine for Haider's own invite; custom SMTP needed before
   inviting Henri and Kais (Gate 1).
