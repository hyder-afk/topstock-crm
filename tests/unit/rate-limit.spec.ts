import { readFileSync } from "node:fs";
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

test("every search and list API checks the limit right after the session", () => {
  const api = path.join(__dirname, "..", "..", "src", "app", "api");
  for (const route of ["leads", "pipeline/board", "pipeline/stage", "pipeline/summary", "tasks"]) {
    const text = readFileSync(path.join(api, route, "route.ts"), "utf8");
    expect(text, route).toMatch(/const session = await apiSession\(\);\n[^\n]*unauthorized[^\n]*\n\s*const limited = listRateLimited\(session\.claims\.sub\);\n\s*if \(limited\) return limited;/);
  }
});
