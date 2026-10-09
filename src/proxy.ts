import { NextResponse, type NextRequest } from "next/server";
import { createServerClient } from "@supabase/ssr";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "";

function contentSecurityPolicy(nonce: string, https: boolean) {
  const isDev = process.env.NODE_ENV === "development";
  const supabaseOrigin = supabaseUrl ? new URL(supabaseUrl).origin : "";
  const supabaseWs = supabaseOrigin.replace(/^https:/, "wss:");
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${isDev ? " 'unsafe-eval'" : ""}`,
    // Style attributes (spring animations write transform/opacity inline) need 'unsafe-inline'; scripts stay nonce-only.
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' blob: data:",
    "font-src 'self'",
    `connect-src 'self' ${supabaseOrigin} ${supabaseWs}${isDev ? " ws:" : ""}`.trim(),
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    // Only meaningful on HTTPS pages (always the case on Vercel); on the plain-HTTP local and CI servers it would
    // make the browser retry same-origin requests over HTTPS and fail.
    ...(isDev || !https ? [] : ["upgrade-insecure-requests"]),
  ].join("; ");
}

// Open to everyone: the sign-in screens and the email-link landing page.
const publicPaths = ["/login", "/forgot-password", "/auth/confirm"];
// Need a session, but not yet two-factor (aal1): the two-factor screens and choosing a password.
const aal1Paths = ["/mfa", "/mfa/setup", "/set-password"];

function matches(path: string, list: string[]) {
  return list.some((p) => path === p || path.startsWith(`${p}/`));
}

// Where the sign-in wall sends this request, or null to let it through. aal is null when there is no valid session.
function wallTarget(path: string, aal: string | null) {
  if (matches(path, publicPaths)) return null;
  if (aal === null) return "/login";
  if (aal !== "aal2" && !matches(path, aal1Paths)) return "/mfa";
  return null;
}

export async function proxy(request: NextRequest) {
  const nonce = Buffer.from(crypto.randomUUID()).toString("base64");
  const https = request.nextUrl.protocol === "https:" || request.headers.get("x-forwarded-proto") === "https";
  const csp = contentSecurityPolicy(nonce, https);

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("Content-Security-Policy", csp);

  let response = NextResponse.next({ request: { headers: requestHeaders } });
  const path = request.nextUrl.pathname;
  let aal: string | null = null;

  // Refresh the Supabase session cookie on every request (authorisation still happens on the server per route).
  if (supabaseUrl && supabaseKey) {
    const supabase = createServerClient(supabaseUrl, supabaseKey, {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet, headers) {
          cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
          response = NextResponse.next({ request: { headers: requestHeaders } });
          cookiesToSet.forEach(({ name, value, options }) => response.cookies.set(name, value, options));
          // A response that sets auth cookies must never be cached (Cache-Control: private, no-store, ...).
          Object.entries(headers).forEach(([key, value]) => response.headers.set(key, value));
        },
      },
    });
    const { data } = await supabase.auth.getClaims();
    aal = data?.claims ? String(data.claims.aal ?? "aal1") : null;
  }

  // First line of the sign-in wall (fails closed). Every page and action checks again on the server (src/lib/auth.ts).
  const target = wallTarget(path, aal);
  if (target) {
    const redirect = NextResponse.redirect(new URL(target, request.url));
    // Keep any refreshed session cookies and their no-store headers on the redirect.
    response.cookies.getAll().forEach((c) => redirect.cookies.set(c));
    ["cache-control", "expires", "pragma"].forEach((key) => {
      const value = response.headers.get(key);
      if (value) redirect.headers.set(key, value);
    });
    redirect.headers.set("Content-Security-Policy", csp);
    return redirect;
  }

  response.headers.set("Content-Security-Policy", csp);
  return response;
}

export const config = {
  matcher: [
    // Everything except static files and images.
    {
      source: "/((?!_next/static|_next/image|icon.svg|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ttf|woff2?)$).*)",
      // Prefetches do not render HTML, so they need neither a nonce nor a session refresh.
      missing: [
        { type: "header", key: "next-router-prefetch" },
        { type: "header", key: "purpose", value: "prefetch" },
      ],
    },
  ],
};
