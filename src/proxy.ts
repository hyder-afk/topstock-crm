import { NextResponse, type NextRequest } from "next/server";
import { createServerClient } from "@supabase/ssr";
// Relative, not "@/...": tests/unit/proxy-share.spec.ts loads this file with a dynamic import (env set first), and
// Playwright's loader does not map the "@/" alias inside a dynamically imported module.
import { authCookieOptions, isHttps } from "./lib/supabase/cookie-options";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "";

// The client stock page and its two routes (design 8.6): no Supabase origin at all, nothing but this site.
function shareContentSecurityPolicy(nonce: string, https: boolean) {
  const isDev = process.env.NODE_ENV === "development";
  return [
    "default-src 'none'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${isDev ? " 'unsafe-eval'" : ""}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self'",
    `connect-src 'self'${isDev ? " ws:" : ""}`,
    // The root layout links the web app manifest on every page (Day 7c); without this the browser refuses it here.
    "manifest-src 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "object-src 'none'",
    ...(isDev || !https ? [] : ["upgrade-insecure-requests"]),
  ].join("; ");
}

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

// Open to everyone: the sign-in screens, the email-link landing page, robots.txt and the web app manifest (browsers fetch
// it without cookies; it holds the app's name, colours and icon paths only).
export const publicPaths = ["/login", "/forgot-password", "/auth/confirm", "/robots.txt", "/manifest.webmanifest"];
// The client stock link (6e): served before any session code, with no cookie read or written.
export const sharePaths = ["/s", "/api/share"];
// Need a session, but not yet two-factor (aal1): the two-factor screens and choosing a password.
const aal1Paths = ["/mfa", "/mfa/setup", "/set-password"];

export function matches(path: string, list: string[]) {
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
  const https = isHttps(request.nextUrl.protocol, request.headers.get("x-forwarded-proto"));
  const csp = contentSecurityPolicy(nonce, https);

  const requestHeaders = new Headers(request.headers);
  // Only this proxy may say a request is the client surface: incoming copies are dropped on every path.
  requestHeaders.delete("x-topstock-surface");
  requestHeaders.delete("x-topstock-locale");
  requestHeaders.set("x-nonce", nonce);
  const path = request.nextUrl.pathname;

  if (matches(path, sharePaths)) {
    const shareCsp = shareContentSecurityPolicy(nonce, https);
    requestHeaders.set("x-topstock-surface", "share");
    const locale = /^\/s\/(en|fr)(\/|$)/.exec(path)?.[1];
    if (locale) requestHeaders.set("x-topstock-locale", locale);
    requestHeaders.set("Content-Security-Policy", shareCsp);
    const shared = NextResponse.next({ request: { headers: requestHeaders } });
    shared.headers.set("Content-Security-Policy", shareCsp);
    return shared;
  }

  requestHeaders.set("Content-Security-Policy", csp);

  let response = NextResponse.next({ request: { headers: requestHeaders } });
  let aal: string | null = null;

  // Refresh the Supabase session cookie on every request (authorisation still happens on the server per route).
  if (supabaseUrl && supabaseKey) {
    const supabase = createServerClient(supabaseUrl, supabaseKey, {
      cookieOptions: authCookieOptions(https),
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
    // JSON APIs answer 401 (the app's data fetches then show their error state) instead of an HTML redirect.
    const blocked = path.startsWith("/api/")
      ? NextResponse.json({ error: "unauthorized" }, { status: 401 })
      : NextResponse.redirect(new URL(target, request.url));
    // Keep any refreshed session cookies and their no-store headers on the redirect.
    response.cookies.getAll().forEach((c) => blocked.cookies.set(c));
    ["cache-control", "expires", "pragma"].forEach((key) => {
      const value = response.headers.get(key);
      if (value) blocked.headers.set(key, value);
    });
    blocked.headers.set("Content-Security-Policy", csp);
    return blocked;
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
