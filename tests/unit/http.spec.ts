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

// Day 6e's streaming cap, kept when the two copies of this module became one (the anonymous client stock routes call it):
// a body with no Content-Length, or a false one, is read only up to the cap; the rest is never pulled.
const endless = (chunk: Uint8Array) => {
  let pulls = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulls += 1;
      controller.enqueue(chunk);
    },
  });
  return { stream, pulls: () => pulls };
};
const streamed = (body: ReadableStream<Uint8Array>, headers: Record<string, string>) =>
  new Request("http://localhost:3100/api/share/request", { method: "POST", body, headers, duplex: "half" } as RequestInit);

test("JSON body: an endless body without Content-Length stops at the cap", async () => {
  const body = endless(new TextEncoder().encode(" ".repeat(64)));
  expect(await readJsonBody(streamed(body.stream, { "content-type": "application/json" }), 1000)).toEqual({ ok: false, status: 413 });
  // 1,000 bytes in 64-byte chunks: the 16th chunk passes the cap; a few more may be queued ahead, never the whole body.
  expect(body.pulls()).toBeLessThan(40);
});

test("JSON body: a Content-Length that understates the body does not lift the cap", async () => {
  const body = endless(new TextEncoder().encode("x".repeat(64)));
  expect(await readJsonBody(streamed(body.stream, { "content-type": "application/json", "content-length": "10" }), 100)).toEqual({ ok: false, status: 413 });
});

test("JSON body: bytes that are not UTF-8 are refused, not replaced", async () => {
  const bytes = new Uint8Array([0x7b, 0x22, 0x61, 0x22, 0x3a, 0x22, 0xff, 0xfe, 0x22, 0x7d]); // {"a":"\xff\xfe"}
  expect(await readJsonBody(new Request("http://localhost:3100/api/share/view", { method: "POST", body: bytes, headers: { "content-type": "application/json" } }), 100)).toEqual({ ok: false, status: 400 });
});

test("JSON body: exactly at the cap is read", async () => {
  const text = JSON.stringify({ a: "x".repeat(92) }); // 100 bytes
  expect(new TextEncoder().encode(text).length).toBe(100);
  expect(await readJsonBody(req(text, { "content-type": "application/json" }), 100)).toEqual({ ok: true, value: { a: "x".repeat(92) } });
});
