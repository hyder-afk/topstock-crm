import { expect, test } from "@playwright/test";
import { NextRequest } from "next/server";

// The proxy's client-link branch (design 8.6; threats P13, P14, P16): /s and /api/share are served before any session
// code with the share CSP (no Supabase origin), the surface headers are set only there, and incoming copies of them
// are dropped on every path. The Supabase URL is set, so a branch that reached the session code would show it.
test.beforeAll(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://abcdefgh.supabase.co";
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "x".repeat(40);
});
const load = async () => (await import("@/proxy")) as typeof import("@/proxy");
const forwarded = (res: Response, name: string) => res.headers.get(`x-middleware-request-${name}`);

test("proxy_share_paths_exact: /s, /s/fr, /s/en and /api/share/*, never /settings or /search", async () => {
  const { matches, sharePaths } = await load();
  for (const p of ["/s", "/s/fr", "/s/en", "/s/xx", "/api/share/view", "/api/share/request"]) expect(matches(p, sharePaths)).toBe(true);
  for (const p of ["/settings", "/search", "/sales", "/api/shares", "/api/inventory/share-links", "/leads/s"]) expect(matches(p, sharePaths)).toBe(false);
});

test("the share branch: share CSP without the Supabase origin, surface and locale headers, no cookie", async () => {
  const { proxy } = await load();
  const res = await proxy(new NextRequest("http://localhost:3100/s/fr", { headers: { cookie: "sb-abcdefgh-auth-token=x" } }));
  const csp = res.headers.get("content-security-policy") ?? "";
  expect(csp).toContain("default-src 'none'");
  expect(csp).toContain("connect-src 'self'");
  expect(csp).toContain("frame-ancestors 'none'");
  expect(csp).not.toContain("supabase.co");
  expect(forwarded(res, "x-topstock-surface")).toBe("share");
  expect(forwarded(res, "x-topstock-locale")).toBe("fr");
  expect(res.headers.get("set-cookie")).toBeNull();
  expect(res.headers.get("location")).toBeNull();
  const api = await proxy(new NextRequest("http://localhost:3100/api/share/view", { method: "POST" }));
  expect(forwarded(api, "x-topstock-surface")).toBe("share");
  expect(forwarded(api, "x-topstock-locale")).toBeNull();
});

test("spoofed surface headers are dropped outside the share paths", async () => {
  const { proxy } = await load();
  const res = await proxy(new NextRequest("http://localhost:3100/login", { headers: { "x-topstock-surface": "share", "x-topstock-locale": "fr" } }));
  expect(forwarded(res, "x-topstock-surface")).toBeNull();
  expect(forwarded(res, "x-topstock-locale")).toBeNull();
  expect(res.headers.get("content-security-policy") ?? "").toContain("supabase.co");
  const spoofLocale = await proxy(new NextRequest("http://localhost:3100/s/en", { headers: { "x-topstock-locale": "fr" } }));
  expect(forwarded(spoofLocale, "x-topstock-locale")).toBe("en");
});
