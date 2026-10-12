import { expect, test } from "@playwright/test";
import { assertSameOrigin, readJsonBody } from "@/lib/http";

// The release route's request checks (Day 4 design 4.2, threat 28): same origin only, JSON only, 32 KB at most.
const h = (o: Record<string, string>) => new Headers(o);

test("same origin: Origin must name the host the request went to", () => {
  expect(assertSameOrigin(h({ host: "localhost:3100", origin: "http://localhost:3100" }))).toBe(true);
  expect(assertSameOrigin(h({ host: "crm.example.com", "x-forwarded-host": "crm.example.com", origin: "https://crm.example.com" }))).toBe(true);
  expect(assertSameOrigin(h({ host: "localhost:3100", origin: "https://evil.example" }))).toBe(false);
  // Another port is another origin; a look-alike host too.
  expect(assertSameOrigin(h({ host: "localhost:3100", origin: "http://localhost:3101" }))).toBe(false);
  expect(assertSameOrigin(h({ host: "crm.example.com", origin: "https://crm.example.com.evil.example" }))).toBe(false);
  // The forwarded host wins over Host (as Next.js compares for server actions).
  expect(assertSameOrigin(h({ host: "internal:3000", "x-forwarded-host": "crm.example.com", origin: "https://crm.example.com" }))).toBe(true);
  expect(assertSameOrigin(h({ host: "crm.example.com", "x-forwarded-host": "other.example", origin: "https://crm.example.com" }))).toBe(false);
  // A sandboxed page sends "null"; a malformed Origin is refused.
  expect(assertSameOrigin(h({ host: "localhost:3100", origin: "null" }))).toBe(false);
  expect(assertSameOrigin(h({ host: "localhost:3100", origin: "not a url" }))).toBe(false);
});

test("no Origin: Sec-Fetch-Site must say same-origin; neither header is refused", () => {
  expect(assertSameOrigin(h({ host: "localhost:3100", "sec-fetch-site": "same-origin" }))).toBe(true);
  expect(assertSameOrigin(h({ host: "localhost:3100", "sec-fetch-site": "cross-site" }))).toBe(false);
  expect(assertSameOrigin(h({ host: "localhost:3100", "sec-fetch-site": "same-site" }))).toBe(false);
  expect(assertSameOrigin(h({ host: "localhost:3100" }))).toBe(false);
  // A foreign Origin is refused even with a same-origin Sec-Fetch-Site.
  expect(assertSameOrigin(h({ host: "localhost:3100", origin: "https://evil.example", "sec-fetch-site": "same-origin" }))).toBe(false);
});

const req = (body: string, headers: Record<string, string>) => new Request("http://localhost:3100/api/queue/release", { method: "POST", body, headers });

test("JSON body: type, size, parse", async () => {
  expect(await readJsonBody(req('{"ids":[]}', { "content-type": "application/json" }), 100)).toEqual({ ok: true, value: { ids: [] } });
  expect(await readJsonBody(req('{"ids":[]}', { "content-type": "application/json; charset=utf-8" }), 100)).toEqual({ ok: true, value: { ids: [] } });
  expect(await readJsonBody(req("", { "content-type": "application/json" }), 100)).toEqual({ ok: true, value: {} });
  // A form post (no preflight from another site) and plain text are refused.
  expect(await readJsonBody(req("ids=1", { "content-type": "application/x-www-form-urlencoded" }), 100)).toEqual({ ok: false, status: 415 });
  expect(await readJsonBody(req("{}", { "content-type": "text/plain" }), 100)).toEqual({ ok: false, status: 415 });
  expect(await readJsonBody(req("{", { "content-type": "application/json" }), 100)).toEqual({ ok: false, status: 400 });
  // Over the limit: by the declared length, or by the bytes read (multi-byte characters count as bytes).
  expect(await readJsonBody(req("{}", { "content-type": "application/json", "content-length": "5000" }), 100)).toEqual({ ok: false, status: 413 });
  expect(await readJsonBody(req(JSON.stringify({ a: "é".repeat(60) }), { "content-type": "application/json" }), 100)).toEqual({ ok: false, status: 413 });
});
