import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { createServerClient } from "@supabase/ssr";
import { authCookieOptions, isHttps } from "@/lib/supabase/cookie-options";

// Gate 1 item 47 (Day 7a): the Supabase auth cookies are Secure on HTTPS, SameSite=Lax, Path=/, and not HttpOnly (the
// browser client reads them; accepted residual 3). Proven three ways: the options themselves, the real @supabase/ssr
// client writing a refreshed session with them (no network: a stub fetch answers the refresh), and a scan that every
// Supabase client in src passes these options.

const b64url = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
const jwt = (exp: number) => `${b64url({ alg: "HS256", typ: "JWT" })}.${b64url({ sub: "00000000-0000-0000-0000-000000000001", exp, aal: "aal2", role: "authenticated" })}.c2ln`;

test("the options: Secure only on HTTPS, always Lax, Path=/ and readable by the browser client", () => {
  expect(authCookieOptions(true)).toEqual({ path: "/", sameSite: "lax", secure: true, httpOnly: false });
  expect(authCookieOptions(false)).toEqual({ path: "/", sameSite: "lax", secure: false, httpOnly: false });
});

test("HTTPS is read from the URL or the platform's forwarded protocol", () => {
  expect(isHttps("https:", null)).toBe(true);
  expect(isHttps("http:", "https")).toBe(true);
  expect(isHttps(null, "HTTPS, http")).toBe(true);
  expect(isHttps("http:", null)).toBe(false);
  expect(isHttps("http:", "http")).toBe(false);
  expect(isHttps(undefined, undefined)).toBe(false);
});

for (const https of [true, false]) {
  test(`@supabase/ssr writes a refreshed session with these flags (${https ? "HTTPS" : "plain HTTP"})`, async () => {
    const now = Math.floor(Date.now() / 1000);
    const user = { id: "00000000-0000-0000-0000-000000000001", aud: "authenticated", role: "authenticated", app_metadata: {}, user_metadata: {}, created_at: "2026-10-01T00:00:00Z" };
    const expired = { access_token: jwt(now - 60), refresh_token: "old-refresh", token_type: "bearer", expires_in: 3600, expires_at: now - 60, user };
    const fresh = { access_token: jwt(now + 3600), refresh_token: "new-refresh", token_type: "bearer", expires_in: 3600, expires_at: now + 3600, user };
    const written: { name: string; value: string; options: Record<string, unknown> }[] = [];
    const supabase = createServerClient("http://127.0.0.1:1", "anon-key", {
      cookieOptions: authCookieOptions(https),
      cookies: {
        getAll: () => [{ name: "sb-127-auth-token", value: JSON.stringify(expired) }],
        setAll: (cookies) => {
          written.push(...cookies);
        },
      },
      global: {
        fetch: async (input) => {
          if (!String(input).includes("grant_type=refresh_token")) throw new Error(`unexpected request ${String(input)}`);
          return new Response(JSON.stringify(fresh), { status: 200, headers: { "Content-Type": "application/json" } });
        },
      },
    });
    const { data } = await supabase.auth.getSession();
    expect(data.session?.refresh_token).toBe("new-refresh");
    await expect.poll(() => written.length).toBeGreaterThan(0);
    for (const c of written) {
      expect(c.name.startsWith("sb-127-auth-token")).toBe(true);
      expect(c.options).toMatchObject({ path: "/", sameSite: "lax", secure: https, httpOnly: false });
    }
  });
}

// Every Supabase client constructed in src passes the shared options (a new client without them fails here).
function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = path.join(dir, name);
    return statSync(p).isDirectory() ? files(p) : /\.(ts|tsx)$/.test(name) ? [p] : [];
  });
}

test("every createServerClient and createBrowserClient call in src passes authCookieOptions", () => {
  const src = path.join(__dirname, "..", "..", "src");
  const calls: string[] = [];
  for (const file of files(src)) {
    const text = readFileSync(file, "utf8");
    for (const m of text.matchAll(/create(?:Server|Browser)Client\(/g)) {
      const call = text.slice(m.index, m.index + 400);
      calls.push(path.relative(src, file));
      expect(call, `${path.relative(src, file)} builds a Supabase client without the shared cookie options`).toMatch(/cookieOptions: authCookieOptions\(/);
    }
  }
  expect(calls.sort()).toEqual(["lib/supabase/client.ts", "lib/supabase/server.ts", "proxy.ts"]);
});
