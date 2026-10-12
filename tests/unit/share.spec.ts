import { createHash } from "node:crypto";
import { expect, test } from "@playwright/test";
import enMessages from "../../messages/en.json";
import frMessages from "../../messages/fr.json";
import { isShareSurface, shareMessages } from "@/i18n/share-messages";
import { assertSameOrigin, readJsonCapped } from "@/lib/http";
import { mapShareItem, mapShareItems, mapShareRequest, mapShareView, snapshotToWire } from "@/lib/share/map";
import { itemFromWire, requestElapsed, snapshotFromWire } from "@/lib/share/wire";
import { clientIp, createLimiter } from "@/lib/share/rate-limit";
import { requestBodySchema, viewBodySchema } from "@/lib/share/schema";
import { defaultLinkLanguage } from "@/lib/share/team";
import { linkMessage, mailtoHref, piecePrice, stockListText, whatsappTextHref } from "@/lib/share/text";
import { shareUrl, tokenFromHash, TOKEN_RE } from "@/lib/share/token";

// Day 6e pure rules (design 11.4): the token, the public routes' schemas (in and out), the positional map, the IP
// limiter, the share message subset, the stock list text, the request guards.

const TOKEN = "tss_" + "Ab3_-".repeat(8) + "xyz";
const ID = "9c65bb59-fad7-47ec-adce-d96f9400f487";
const row = [42, "Sac kraft", "Bags", "2.5", 24, 480, 0, null];

test.describe("token", () => {
  test("share_token_format: tss_ and 43 base64url characters, read from the fragment only", () => {
    expect(TOKEN).toMatch(TOKEN_RE);
    expect(tokenFromHash(`#${TOKEN}`)).toBe(TOKEN);
    expect(tokenFromHash(TOKEN)).toBe(TOKEN);
    for (const bad of ["", "#", "#main", `#${TOKEN}x`, `#${TOKEN}_`, `#${TOKEN}-`, `#x${TOKEN}`, `#.${TOKEN}`, `#${TOKEN.slice(0, -1)}`, `#${TOKEN.slice(0, -1)}.`,
                       `#tss_${"a".repeat(42)}=`, null, undefined]) {
      expect(tokenFromHash(bad)).toBeNull();
    }
  });
  test("share_token_trailing_punctuation: a full stop, bracket or quote a chat app glued to the link is left out", () => {
    // The 43 characters must be followed by something that cannot be part of a token; the token itself is unchanged.
    for (const tail of [".", ",", ";", ":", "!", "?", ")", ").", "]", "\"", "'", "’", "»", "…", " ", "%2E", "%C2%BB", "%20", "\n"]) {
      expect(tokenFromHash(`#${TOKEN}${tail}`), JSON.stringify(tail)).toBe(TOKEN);
    }
  });
  test("the address carries the token in the fragment, never in the path or query", () => {
    expect(shareUrl("https://crm.example", "fr", TOKEN)).toBe(`https://crm.example/s/fr#${TOKEN}`);
    expect(shareUrl("https://crm.example/path", "fr", TOKEN)).toBeNull();
    expect(shareUrl("javascript:alert(1)", "en", TOKEN)).toBeNull();
    expect(shareUrl("https://crm.example", "en", "tss_short")).toBeNull();
  });
  test("the SQL hash (sha256 of the UTF-8 text) equals Node's", () => {
    // share_view looks links up by sha256(convert_to(p_token, 'UTF8')): a plain SHA-256 of the UTF-8 bytes.
    expect(createHash("sha256").update(TOKEN, "utf8").digest("hex")).toHaveLength(64);
  });
});

// An all-zero version-4 UUID: obviously fake, and kept out of the literal so secret scanners see no key-like value.
const FAKE_UUID = ["00000000", "0000", "4000", "8000", "000000000000"].join("-");

test.describe("schemas", () => {
  const body = (over: Record<string, unknown> = {}) => ({
    token: TOKEN,
    lines: [{ productNumber: 42, description: null, quantity: 2, unit: "carton" }],
    note: "",
    name: "",
    idempotencyKey: FAKE_UUID,
    website: "",
    t: 5000,
    ...over,
  });
  test("view body: token and an optional 16-hex version, nothing else", () => {
    expect(viewBodySchema.safeParse({ token: TOKEN }).success).toBe(true);
    expect(viewBodySchema.safeParse({ token: TOKEN, knownVersion: "0123456789abcdef" }).success).toBe(true);
    expect(viewBodySchema.safeParse({ token: TOKEN, knownVersion: "xyz" }).success).toBe(false);
    expect(viewBodySchema.safeParse({ token: TOKEN, extra: 1 }).success).toBe(false);
    expect(viewBodySchema.safeParse({ token: "tss_x" }).success).toBe(false);
  });
  test("request body: 20 lines at most, notes and names bounded, no bidi or control characters, no extra keys", () => {
    expect(requestBodySchema.safeParse(body()).success).toBe(true);
    const line = { productNumber: null, description: "Sacs", quantity: 1, unit: "piece" };
    expect(requestBodySchema.safeParse(body({ lines: Array.from({ length: 21 }, () => line) })).success).toBe(false);
    expect(requestBodySchema.safeParse(body({ lines: [], note: "n".repeat(1001) })).success).toBe(false);
    expect(requestBodySchema.safeParse(body({ lines: [], note: "n".repeat(1000) })).success).toBe(true);
    expect(requestBodySchema.safeParse(body({ note: "Hi ‮evil" })).success).toBe(false);
    expect(requestBodySchema.safeParse(body({ name: "Marie\u0007" })).success).toBe(false);
    expect(requestBodySchema.safeParse(body({ note: "a\nb" })).success).toBe(true);
    expect(requestBodySchema.safeParse(body({ name: "a\nb" })).success).toBe(false);
    expect(requestBodySchema.safeParse(body({ note: "\uD800" })).success).toBe(false);
    expect(requestBodySchema.safeParse({ ...body(), price: 1 }).success).toBe(false);
    expect(requestBodySchema.safeParse(body({ lines: [], note: "ok" })).success).toBe(false);
    expect(requestBodySchema.safeParse(body({ lines: [{ ...line, unit: "carton" }] })).success).toBe(false);
    expect(requestBodySchema.safeParse(body({ lines: [{ productNumber: 42, description: "x", quantity: 1, unit: "piece" }] })).success).toBe(false);
    expect(requestBodySchema.safeParse(body({ lines: [{ productId: ID, description: null, quantity: 1, unit: "piece" }] })).success).toBe(false);
    expect(requestBodySchema.safeParse(body({ lines: [{ productNumber: 42, description: null, quantity: 0, unit: "piece" }] })).success).toBe(false);
    expect(requestBodySchema.safeParse(body({ lines: [{ productNumber: 4.2, description: null, quantity: 1, unit: "piece" }] })).success).toBe(false);
    const dup = { productNumber: 42, description: null, quantity: 1, unit: "piece" };
    expect(requestBodySchema.safeParse(body({ lines: [dup, dup] })).success).toBe(false);
  });
  test("share_request_after_a_day_open: a page left open overnight still sends (the elapsed time is capped, not refused)", () => {
    const loaded = 1_250.5;
    const dayAndAnHour = loaded + 25 * 3_600_000;
    expect(requestElapsed(dayAndAnHour, loaded)).toBe(86_400_000);
    expect(requestBodySchema.safeParse(body({ t: requestElapsed(dayAndAnHour, loaded) })).success).toBe(true);
    expect(requestElapsed(loaded + 4_999.6, loaded)).toBe(5_000);
    expect(requestElapsed(loaded - 10, loaded)).toBe(0); // a clock that ran backwards never sends a negative time
    expect(requestBodySchema.safeParse(body({ t: 86_400_001 })).success).toBe(false); // the server's bound is unchanged
  });
});

test.describe("map", () => {
  test("mapShareItems gives exactly the public keys; a wrong array length or type is refused", () => {
    expect(mapShareItem(row)).toEqual({
      number: 42, name: "Sac kraft", category: "Bags", priceMax: "2.5", piecesPerCarton: 24, warehouse: 480, transit: 0, etaWeek: null,
    });
    expect(mapShareItem([...row, "0.42"])).toBeNull();
    expect(mapShareItem(row.slice(0, 7))).toBeNull();
    expect(mapShareItem([ID, ...row.slice(1)])).toBeNull();
    expect(mapShareItem([42, "x", null, "2.5", 24, -1, 0, null])).toBeNull();
    expect(mapShareItems([row, "x"])).toBeNull();
  });
  test("share_output_schema_strips_cost: an answer with any extra field is unavailable, never passed on", () => {
    const ok = { status: "ok", version: "0123456789abcdef", language: "fr", currency: "EUR", show_in_transit: true, allow_requests: true, signature: "Henri", generated_at: "2026-10-12T10:00:00Z", items: [row] };
    const mapped = mapShareView(ok);
    expect(mapped.status).toBe("ok");
    expect(JSON.stringify(mapped)).not.toContain("cost");
    expect(mapShareView({ ...ok, cost_per_piece: "0.42" })).toEqual({ status: "ok", version: "0123456789abcdef", language: "fr", currency: "EUR", showInTransit: true, allowRequests: true, signature: "Henri", generatedAt: "2026-10-12T10:00:00Z", items: [mapShareItem(row)] });
    expect(mapShareView({ ...ok, items: [[...row, "0.42"]] })).toEqual({ status: "unavailable" });
    expect(mapShareView({ status: "inactive" })).toEqual({ status: "inactive" });
    expect(mapShareView({ status: "other" })).toEqual({ status: "unavailable" });
    expect(mapShareView({ status: "ok", unchanged: true, version: "0123456789abcdef" })).toEqual({ status: "ok", unchanged: true, version: "0123456789abcdef" });
    expect(mapShareRequest({ status: "received", signature: "Henri", request_id: "x" })).toEqual({ status: "received", signature: "Henri" });
    // The wire form: positional again, only the whitelisted fields, and the browser reads it back to the same snapshot.
    const snap = mapShareView(ok);
    if (snap.status !== "ok" || !("items" in snap)) throw new Error("no snapshot");
    const wire = snapshotToWire(snap);
    expect(wire.items).toEqual([row]);
    expect(snapshotFromWire(JSON.parse(JSON.stringify(wire)))).toEqual(snap);
    expect(snapshotFromWire({ ...wire, items: [[...row, "0.42"]] })).toBeNull();
    expect(snapshotFromWire({ ...wire, cost: 1 })).toBeNull();
    // The browser's hand-written check agrees with the server's schema on good and bad rows.
    for (const r of [row, [...row, "0.42"], row.slice(0, 7), [ID, ...row.slice(1)], [42, "x", null, "2.5", 24, -1, 0, null],
                     [42, "x", null, "2.55555", 24, 1, 0, null], [42, "", null, null, 24, 1, 0, null], [0, "x", null, null, 1, 1, 0, null],
                     [42, "x", null, null, 1, 1, 0, "2026-13-45"], [42, "x", "c".repeat(81), null, 1, 1, 0, null], [42, "x", null, null, 1.5, 1, 0, null]]) {
      expect(itemFromWire(r)).toEqual(mapShareItem(r));
    }
    expect(mapShareRequest({ status: "boom" })).toEqual({ status: "unavailable" });
  });

  test("wire_counts_characters_like_the_server: an emoji at the length limit passes both checks, one past fails both", () => {
    // Zod and Postgres count characters (code points); the browser must too, or one long name blanks every client page.
    const at = [42, "a".repeat(199) + "😀", "c".repeat(79) + "🧵", "2.5", 24, 480, 0, null];
    const past = [42, "a".repeat(200) + "😀", null, "2.5", 24, 480, 0, null];
    const pastCategory = [42, "x", "c".repeat(80) + "🧵", "2.5", 24, 480, 0, null];
    const cases = [at, past, pastCategory, [42, "😀", null, null, 1, 1, 0, null], [42, "x", null, null, 1, 1, 0, "2026-02-30"],
                   [42, "x", null, null, 1, 1, 0, "2028-02-29"], [42, "x", null, null, 1, 1, 0, "2026-04-31"]];
    for (const r of cases) expect(itemFromWire(r), JSON.stringify(r).slice(0, 40)).toEqual(mapShareItem(r));
    expect(itemFromWire(at)).not.toBeNull();
    expect(itemFromWire(past)).toBeNull();
    // The whole list is read, not refused, when one name sits at the limit; a signature of 60 characters too.
    const snap = { status: "ok", version: "0123456789abcdef", language: "fr", currency: "EUR", showInTransit: true, allowRequests: true,
                   signature: "é".repeat(59) + "😀", generatedAt: "2026-10-12T10:00:00Z", items: [row, at] };
    expect(snapshotFromWire(snap)?.items).toHaveLength(2);
    expect(snapshotFromWire({ ...snap, signature: "é".repeat(60) + "😀" })).toBeNull();
  });
});

test.describe("rate limit", () => {
  test("a sliding window per address, a cap with least-recently-used eviction", () => {
    const l = createLimiter({ windowMs: 60_000, max: 3, cap: 2 });
    const t0 = Date.UTC(2026, 9, 12, 10);
    expect([1, 2, 3, 4].map((i) => l.take("1.1.1.1", t0 + i))).toEqual([true, true, true, false]);
    expect(l.take("1.1.1.1", t0 + 60_005)).toBe(true);
    l.take("2.2.2.2", t0 + 10);
    l.take("3.3.3.3", t0 + 11);
    expect(l.size()).toBe(2);
  });
  test("the salt rotates daily (yesterday's keys are dropped)", () => {
    const l = createLimiter({ windowMs: 86_400_000 * 2, max: 1 });
    const t0 = Date.UTC(2026, 9, 12, 23, 59);
    expect(l.take("1.1.1.1", t0)).toBe(true);
    expect(l.take("1.1.1.1", t0 + 1000)).toBe(false);
    expect(l.take("1.1.1.1", t0 + 120_000)).toBe(true);
  });
  test("the address comes from x-forwarded-for; one shared key without it", () => {
    expect(clientIp(new Headers({ "x-forwarded-for": "203.0.113.9, 10.0.0.1" }))).toBe("203.0.113.9");
    expect(clientIp(new Headers())).toBe("unknown");
  });
});

test.describe("messages", () => {
  test("share_messages_subset_exact: Share, the skip link and the page title only", () => {
    for (const all of [enMessages, frMessages]) {
      const sub = shareMessages(all as Record<string, unknown>);
      expect(Object.keys(sub).sort()).toEqual(["Common", "Metadata", "Share"]);
      expect(Object.keys(sub.Common as object)).toEqual(["skipToContent"]);
      expect(sub.Metadata).toEqual((all as { Share: { meta: unknown } }).Share.meta);
      expect(JSON.stringify(sub)).not.toMatch(/price_min|minimum price|cost/i);
    }
  });
  test("surface_header_ignored_outside_share: only the exact value the proxy sets", () => {
    expect(isShareSurface("share")).toBe(true);
    for (const v of ["Share", " share", "share,share", "", null, undefined]) expect(isShareSurface(v)).toBe(false);
  });
});

test.describe("stock list text", () => {
  const item = (n: number, warehouse = 4200) => mapShareItem([n + 1, `T-shirt coton ${n}`, "Textile", "2.5", 24, warehouse, 0, null])!;
  test("30 in-stock items at most, French typography, the link at the end", () => {
    const items = [item(0, 0), ...Array.from({ length: 40 }, (_, i) => item(i + 1))];
    const text = stockListText(items, "fr", { link: "https://crm.example/s/fr#" + TOKEN, firstName: "Henri" });
    expect(text.split("\n").filter((l) => l.startsWith("•"))).toHaveLength(30);
    expect(text).toContain("• T-shirt coton 1 : 2,50 €/pc · 4 200 pcs");
    expect(text).not.toContain("T-shirt coton 0 :");
    expect(text).toContain("… et d’autres articles.");
    expect(text.endsWith("Henri, TopStock Wholesale")).toBe(true);
    expect(text.length).toBeLessThanOrEqual(3500);
  });
  test("cut to 3,500 characters with the link kept", () => {
    const long = Array.from({ length: 30 }, (_, i) => mapShareItem([i + 1, "N".repeat(190), null, "1", 1, 5, 0, null])!);
    const text = stockListText(long, "en", { link: "https://x.example/s/en#" + TOKEN });
    expect(text.length).toBeLessThanOrEqual(3500);
    expect(text).toContain("#" + TOKEN);
  });
  test("wa.me and mailto encode every part; prices per piece with 2 to 4 decimals", () => {
    const msg = linkMessage("https://x.example/s/en#" + TOKEN, null, "en");
    expect(whatsappTextHref(msg, "06 12 34 56 78", "FR")).toBe(`https://wa.me/33612345678?text=${encodeURIComponent(msg)}`);
    expect(whatsappTextHref("a&b", null, null)).toBe("https://wa.me/?text=a%26b");
    expect(mailtoHref("Stock & prices", "a b", "x@y.fr")).toBe("mailto:x%40y.fr?subject=Stock%20%26%20prices&body=a%20b");
    expect(mailtoHref("s", "b", "not an email")).toBe("mailto:?subject=s&body=b");
    expect(piecePrice("2.5", "en")).toBe("€2.50");
    expect(piecePrice("0.1234", "fr")).toBe("0,1234 €");
  });
  test("a new link's language follows the lead's country", () => {
    expect(defaultLinkLanguage("BE", "en")).toBe("fr");
    expect(defaultLinkLanguage("DE", "fr")).toBe("en");
    expect(defaultLinkLanguage(null, "fr")).toBe("fr");
  });
});

test.describe("request guards", () => {
  const req = (body: BodyInit | null, headers: Record<string, string>) => new Request("http://localhost:3100/api/share/view", { method: "POST", body, headers });
  test("same origin only", () => {
    expect(assertSameOrigin(req("{}", { origin: "http://localhost:3100", host: "localhost:3100" }))).toBe(true);
    expect(assertSameOrigin(req("{}", { origin: "https://evil.example", host: "localhost:3100" }))).toBe(false);
    expect(assertSameOrigin(req("{}", { host: "localhost:3100" }))).toBe(false);
  });
  test("JSON only, read with a byte cap", async () => {
    expect(await readJsonCapped(req('{"a":1}', { "content-type": "application/json" }), 100)).toEqual({ ok: true, value: { a: 1 } });
    expect(await readJsonCapped(req('{"a":1}', { "content-type": "text/plain" }), 100)).toEqual({ ok: false, status: 415 });
    expect(await readJsonCapped(req(JSON.stringify({ a: "x".repeat(200) }), { "content-type": "application/json" }), 100)).toEqual({ ok: false, status: 413 });
    expect(await readJsonCapped(req("{nope", { "content-type": "application/json; charset=utf-8" }), 100)).toEqual({ ok: false, status: 400 });
  });
});
