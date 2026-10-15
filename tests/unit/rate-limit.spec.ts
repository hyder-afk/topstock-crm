import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { createUserLimiter, LIST_LIMIT, listRateLimited } from "@/lib/rate-limit";

// Gate 1 item 28 (Day 7a): the per-person limit on the search and list APIs.

test("a person gets max requests per window, then a wait in whole seconds; the window slides", () => {
  const l = createUserLimiter({ windowMs: 60_000, max: 3 });
  const t0 = 1_000_000;
  expect([l.take("a", t0), l.take("a", t0 + 10), l.take("a", t0 + 20)]).toEqual([0, 0, 0]);
  expect(l.take("a", t0 + 30)).toBe(60); // the first hit leaves the window at t0 + 60 s
  expect(l.take("a", t0 + 59_999)).toBe(1);
  expect(l.take("a", t0 + 60_001)).toBe(0); // the first hit has left the window
});

test("people are counted apart, and refused requests do not extend the wait", () => {
  const l = createUserLimiter({ windowMs: 1_000, max: 1 });
  expect(l.take("a", 0)).toBe(0);
  expect(l.take("b", 0)).toBe(0);
  for (let i = 1; i < 10; i++) expect(l.take("a", i * 50)).toBeGreaterThan(0);
  expect(l.take("a", 1_001)).toBe(0);
});

test("the key map is capped: the least recently used person goes first", () => {
  const l = createUserLimiter({ windowMs: 60_000, max: 1, cap: 2 });
  l.take("a", 0);
  l.take("b", 1);
  l.take("a", 2); // refused, but a is now the most recent
  l.take("c", 3); // b leaves
  expect(l.size()).toBe(2);
  expect(l.take("b", 4)).toBe(0); // b starts again
  expect(l.take("a", 5)).toBe(0); // a was pushed out by b
});

test("the API answer: 429, a generic code, no-store and Retry-After", async () => {
  const l = createUserLimiter({ windowMs: 60_000, max: 1 });
  expect(listRateLimited("u", l)).toBeNull();
  const res = listRateLimited("u", l);
  expect(res?.status).toBe(429);
  expect(await res?.json()).toEqual({ error: "rate_limited" });
  expect(res?.headers.get("cache-control")).toBe("private, no-store");
  expect(Number(res?.headers.get("retry-after"))).toBeGreaterThan(0);
  expect(LIST_LIMIT).toEqual({ windowMs: 60_000, max: 300 });
});

// Every GET route under src/app/api is either a search or list API (limited) or named here with the reason it is not.
// A new GET route in neither list fails the inventory test below, so a new list route cannot ship without the limit.
const LIMITED = [
  "leads",
  "pipeline/board",
  "pipeline/stage",
  "pipeline/summary",
  "tasks",
  // Day 6 (merged 08b0ae7)
  "inventory/stock",
  "inventory/movements",
  "inventory/sales",
  "inventory/requests",
  "inventory/reservations",
  "inventory/share-links",
  "leads/[id]/stock",
  "stock-imports/[id]/changes",
  "stock-imports/[id]/issues",
  // the lead page's other list tabs and the lead import's issue list (same shape as the stock import's)
  "leads/[id]/activities",
  "leads/[id]/deals",
  "leads/[id]/files",
  "leads/[id]/tasks",
  "imports/[id]/issues",
];
// Left out on purpose (docs/evidence/day7a/README.md, "Merge with Day 6"): one record by id, a fixed set of counts, a
// file download, or the fixed client whitelist; never a page of rows or a search.
const NOT_LISTS = [
  "activities/[id]",
  "deals/[id]",
  "files/[id]",
  "home",
  "inventory/alerts",
  "inventory/products/[id]",
  "inventory/requests/[id]",
  "inventory/sales/[id]",
  "inventory/share-preview",
  "inventory/summary",
  "leads/[id]",
  "queue/summary",
];
const api = path.join(__dirname, "..", "..", "src", "app", "api");

test("every search and list API checks the limit right after the session", () => {
  for (const route of LIMITED) {
    const text = readFileSync(path.join(api, route, "route.ts"), "utf8");
    expect(text, route).toMatch(/const session = await apiSession\(\);\n[^\n]*unauthorized[^\n]*\n\s*const limited = listRateLimited\(session\.claims\.sub\);\n\s*if \(limited\) return limited;/);
  }
});

test("every GET route under src/app/api is either limited or named as not a list", () => {
  const routes = (readdirSync(api, { recursive: true }) as string[])
    .filter((f) => path.basename(f) === "route.ts")
    .filter((f) => /export async function GET\b/.test(readFileSync(path.join(api, f), "utf8")))
    .map((f) => path.dirname(f).split(path.sep).join("/"))
    .sort();
  expect(routes).toEqual([...LIMITED, ...NOT_LISTS].sort());
  for (const route of NOT_LISTS) expect(LIMITED, route).not.toContain(route);
});
