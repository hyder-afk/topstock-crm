import type { CookieOptionsWithName } from "@supabase/ssr";

// Flags of the Supabase auth cookies (Gate 1 item 47), the same for every client that writes them (the proxy, server
// actions and pages, and the browser client of the Files tab):
// - Secure whenever the page is served over HTTPS (always on Vercel, preview and production); the plain-HTTP local and
//   CI servers keep it off, or WebKit would drop the cookie on http://localhost.
// - SameSite=Lax and Path=/ (the @supabase/ssr defaults, stated here so a library change cannot loosen them).
// - Not HttpOnly: @supabase/ssr keeps the session in cookies that its browser client reads (the Files tab's signed
//   uploads), so HttpOnly would break it. Accepted residual 3 (docs/evidence/day1-step2/security-review.md); the strict
//   nonce CSP is the XSS control. A __Host- prefix is not possible either: the library names the cookies (sb-<ref>-...).
export function authCookieOptions(https: boolean): CookieOptionsWithName {
  return { path: "/", sameSite: "lax", secure: https, httpOnly: false };
}

/** True when the request reached the app over HTTPS (Vercel sets x-forwarded-proto; it overwrites a client's value). */
export function isHttps(protocol: string | null | undefined, forwardedProto: string | null | undefined): boolean {
  return protocol === "https:" || forwardedProto?.split(",")[0]?.trim().toLowerCase() === "https";
}
