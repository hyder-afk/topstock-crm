import { expect, test } from "@playwright/test";
import {
  authHeaders,
  batches,
  bothLists,
  ConfigError,
  MAX_OBJECTS,
  planSweep,
  readConfig,
  runSweep,
  SQL_LIMIT,
} from "../../scripts/ops/sweep-core.mjs";

// Day 7c: the orphan sweeper's rules (scripts/ops/sweep-core.mjs, run by scripts/ops/sweep-lead-files.mjs; plan section 3 on day7-local). A fake fetch
// stands in for PostgREST and the Storage API: no network, no key. Fake ids only.

const ORG_A = "00000000-0000-4000-8000-0000000000aa";
const ORG_B = "00000000-0000-4000-8000-0000000000bb";
const LEAD = "30000000-0000-4000-8000-000000000001";
const path = (org: string, n: number, ext = "pdf") => `${org}/${LEAD}/a0000000-0000-4000-8000-${String(n).padStart(12, "0")}.${ext}`;
const row = (org: string, n: number, size = 1000) => ({ name: path(org, n), org_id: org, size, created_at: "2026-10-10T00:00:00Z" });
const caps = { maxObjects: 50, maxBytes: 200 * 1024 * 1024 };
const config = (over: Record<string, unknown> = {}) => ({
  url: "https://abcdefghijklmnopqrst.supabase.co",
  key: "sb_secret_fake_test_value_only_0000",
  apply: false,
  maxObjects: 50,
  maxBytes: 200 * 1024 * 1024,
  minAgeHours: 24,
  ...over,
});

type Call = { method: string; path: string; body: unknown; headers: Record<string, string> };
type Rows = ReturnType<typeof row>[];

/** A fake server: stats, two listings (the second may differ), deletes answered with the names asked (minus `gone`). */
function fakeServer(opts: { stats?: object; first?: Rows; second?: Rows; gone?: string[]; failDeleteAt?: number; failRpc?: string }) {
  const calls: Call[] = [];
  let listings = 0;
  let deletes = 0;
  const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });
  const fetchFn = async (url: string, init: RequestInit) => {
    const u = new URL(url);
    const body = init.body ? JSON.parse(String(init.body)) : null;
    calls.push({ method: String(init.method), path: u.pathname, body, headers: init.headers as Record<string, string> });
    const fn = u.pathname.replace("/rest/v1/rpc/", "");
    if (opts.failRpc && fn === opts.failRpc) return json({ code: "42501", message: "permission denied" }, 403);
    if (u.pathname === "/rest/v1/rpc/lead_file_sweep_stats") {
      return json([opts.stats ?? { bucket_objects: 10, bucket_bytes: 10_000, file_rows: 7, odd_names: 0 }]);
    }
    if (u.pathname === "/rest/v1/rpc/lead_file_orphans") {
      // Same bounds as the migration: 1 to 1000 rows a call, anything else is refused (22023).
      const limit = (body as { p_limit: number }).p_limit;
      if (!Number.isInteger(limit) || limit < 1 || limit > 1000) return json({ code: "22023", message: "bounds" }, 400);
      listings += 1;
      return json(listings === 1 ? (opts.first ?? []) : (opts.second ?? opts.first ?? []));
    }
    if (u.pathname === "/rest/v1/rpc/record_file_sweep") return new Response(null, { status: 204 });
    if (u.pathname === "/storage/v1/object/lead-files" && init.method === "DELETE") {
      deletes += 1;
      if (opts.failDeleteAt === deletes) return json({ statusCode: "500", error: "boom" }, 500);
      const asked = (body as { prefixes: string[] }).prefixes;
      return json(asked.filter((n) => !(opts.gone ?? []).includes(n)).map((name) => ({ name })));
    }
    return json({ message: "unexpected" }, 404);
  };
  const recorded = () => calls.filter((c) => c.path.endsWith("/record_file_sweep")).map((c) => c.body);
  const deleteCalls = () => calls.filter((c) => c.method === "DELETE");
  return { fetchFn: fetchFn as unknown as typeof fetch, calls, recorded, deleteCalls };
}

const quiet = { log: () => {}, summary: () => {} };

test.describe("planSweep", () => {
  test("groups by org id and sums bytes", () => {
    const p = planSweep([row(ORG_A, 1, 100), row(ORG_A, 2, 200), row(ORG_B, 3, 50)], caps);
    expect(p.ok).toBe(true);
    expect(p.found).toBe(3);
    expect(p.bytes).toBe(350);
    expect(p.byOrg).toEqual({ [ORG_A]: { count: 2, bytes: 300 }, [ORG_B]: { count: 1, bytes: 50 } });
  });
  test("caps: more objects than the cap, or more bytes, stop the plan", () => {
    const many = Array.from({ length: 51 }, (_, i) => row(ORG_A, i + 1));
    expect(planSweep(many, caps)).toMatchObject({ ok: false, reason: "too_many", found: 51 });
    expect(planSweep(many.slice(0, 50), caps).ok).toBe(true);
    expect(planSweep([row(ORG_A, 1, 3 * 1024 * 1024)], { maxObjects: 50, maxBytes: 2 * 1024 * 1024 })).toMatchObject({ ok: false, reason: "too_big" });
  });
  test("refuses any row outside the path shape, with a mismatched org id, a bad size or a repeat", () => {
    const bad = [
      { ...row(ORG_A, 1), name: `${ORG_A}/notes.txt` },
      { ...row(ORG_A, 1), name: path(ORG_A, 1).toUpperCase() },
      { ...row(ORG_A, 1), name: `${ORG_A}/${LEAD}/x/a0000000-0000-4000-8000-000000000001.pdf` },
      { ...row(ORG_A, 1), name: path(ORG_A, 1, "exe") },
      { ...row(ORG_A, 1), name: `../${path(ORG_A, 1)}` },
      { ...row(ORG_A, 1), org_id: ORG_B },
      { ...row(ORG_A, 1), size: -1 },
      { ...row(ORG_A, 1), size: 1.5 },
      { ...row(ORG_A, 1), size: "100" },
    ];
    for (const r of bad) expect(planSweep([r], caps), JSON.stringify(r)).toMatchObject({ ok: false, reason: "bad_row" });
    expect(planSweep([row(ORG_A, 1), row(ORG_A, 1)], caps)).toMatchObject({ ok: false, reason: "bad_row" });
    expect(planSweep({ not: "a list" } as unknown as Rows, caps)).toMatchObject({ ok: false, reason: "bad_answer" });
  });
  test("both lists: only names found the first and the second time", () => {
    const a = planSweep([row(ORG_A, 1), row(ORG_A, 2), row(ORG_A, 3)], caps).names;
    const b = planSweep([row(ORG_A, 2), row(ORG_A, 3), row(ORG_A, 4)], caps).names;
    expect(bothLists(a, b)).toEqual([path(ORG_A, 2), path(ORG_A, 3)]);
  });
  test("batches of 100", () => {
    expect(batches(Array.from({ length: 250 }, (_, i) => i)).map((b) => b.length)).toEqual([100, 100, 50]);
    expect(batches([])).toEqual([]);
  });
});

test.describe("readConfig and headers", () => {
  const env = { SUPABASE_URL: "https://abcdefghijklmnopqrst.supabase.co", SWEEPER_KEY: "sb_secret_fake_test_value_only_0000" };
  test("dry run by default, with the plan's caps", () => {
    expect(readConfig(env)).toMatchObject({ apply: false, maxObjects: 50, maxBytes: 200 * 1024 * 1024, minAgeHours: 24 });
    expect(readConfig({ ...env, SWEEP_MODE: "apply" }).apply).toBe(true);
  });
  test("refuses a wrong address, a missing or publishable key, a bad mode and caps out of range", () => {
    const bad = [
      { ...env, SUPABASE_URL: "http://abcdefghijklmnopqrst.supabase.co" },
      { ...env, SUPABASE_URL: "https://evil.example.com" },
      { ...env, SUPABASE_URL: "http://127.0.0.1:54321" },
      { ...env, SWEEPER_KEY: "" },
      { ...env, SWEEPER_KEY: "sb_publishable_fake_test_value_only_00" },
      { ...env, SWEEP_MODE: "yes" },
      { ...env, SWEEP_MAX_OBJECTS: "0" },
      { ...env, SWEEP_MAX_OBJECTS: "5000" },
      { ...env, SWEEP_MAX_OBJECTS: "1000" },
      { ...env, SWEEP_MAX_MIB: "2048" },
      { ...env, SWEEP_MIN_AGE_HOURS: "1" },
      { ...env, SWEEP_MAX_OBJECTS: "1e3" },
    ];
    for (const e of bad) expect(() => readConfig(e), JSON.stringify(e)).toThrow(ConfigError);
    // The key's value is never in an error message.
    try {
      readConfig({ ...env, SWEEPER_KEY: "sb_secret has spaces in it 000" });
    } catch (e) {
      expect(String(e)).not.toContain("has spaces");
    }
  });
  test("the object cap stops at 999, one below the database's 1000 rows a call", () => {
    expect(MAX_OBJECTS).toBe(999);
    expect(SQL_LIMIT).toBe(1000);
    expect(readConfig({ ...env, SWEEP_MAX_OBJECTS: "999" }).maxObjects).toBe(999);
    expect(() => readConfig({ ...env, SWEEP_MAX_OBJECTS: "1000" })).toThrow("1 to 999");
  });
  test("a local address only with SWEEP_ALLOW_LOCAL=1 (the CI test)", () => {
    expect(readConfig({ ...env, SUPABASE_URL: "http://127.0.0.1:54321", SWEEP_ALLOW_LOCAL: "1" }).url).toBe("http://127.0.0.1:54321");
  });
  test("a secret key goes in apikey only; a legacy JWT also as the bearer token", () => {
    expect(authHeaders("sb_secret_x")).not.toHaveProperty("Authorization");
    expect(authHeaders("sb_secret_x").apikey).toBe("sb_secret_x");
    expect(authHeaders("eyJhbGciOi.fake.jwt").Authorization).toBe("Bearer eyJhbGciOi.fake.jwt");
  });
});

test.describe("runSweep", () => {
  test("a dry run lists, records counts only and never calls delete", async () => {
    const s = fakeServer({ first: [row(ORG_A, 1, 100), row(ORG_B, 2, 200)] });
    const r = await runSweep({ config: config(), fetchFn: s.fetchFn, ...quiet });
    expect(r).toMatchObject({ exitCode: 0, found: 2, removed: 0, bytes: 300, deleteCalls: 0 });
    expect(s.deleteCalls()).toHaveLength(0);
    expect(s.recorded()).toEqual([{ p_found: 2, p_removed: 0, p_bytes: 300, p_dry: true }]);
    // One listing only; asks for one more than the cap so "more than 50" is seen; 24 hours.
    const lists = s.calls.filter((c) => c.path.endsWith("/lead_file_orphans"));
    expect(lists).toHaveLength(1);
    expect(lists[0].body).toEqual({ p_min_age: "24 hours", p_limit: 51 });
  });
  test("an apply run that finds nothing records an apply row (dry_run false), not a dry run", async () => {
    const s = fakeServer({ first: [] });
    const r = await runSweep({ config: config({ apply: true }), fetchFn: s.fetchFn, ...quiet });
    expect(r).toMatchObject({ exitCode: 0, mode: "apply", found: 0, removed: 0, bytes: 0, deleteCalls: 0 });
    expect(s.recorded()).toEqual([{ p_found: 0, p_removed: 0, p_bytes: 0, p_dry: false }]);
    expect(s.calls.filter((c) => c.path.endsWith("/lead_file_orphans"))).toHaveLength(1);
    // A dry run that finds nothing still records a dry run.
    const d = fakeServer({ first: [] });
    await runSweep({ config: config(), fetchFn: d.fetchFn, ...quiet });
    expect(d.recorded()).toEqual([{ p_found: 0, p_removed: 0, p_bytes: 0, p_dry: true }]);
  });
  test("cap edge: the highest cap (999) asks for 1000 rows, which the database accepts; 1000 rows found is over the cap", async () => {
    const thousand = Array.from({ length: 1000 }, (_, i) => row(ORG_A, i + 1, 1));
    const s = fakeServer({ first: thousand });
    const r = await runSweep({ config: config({ apply: true, maxObjects: MAX_OBJECTS, maxBytes: 1024 * 1024 * 1024 }), fetchFn: s.fetchFn, ...quiet });
    const lists = s.calls.filter((c) => c.path.endsWith("/lead_file_orphans"));
    expect(lists.map((c) => (c.body as { p_limit: number }).p_limit)).toEqual([1000]);
    expect(r).toMatchObject({ exitCode: 1, found: 1000 });
    expect(r.stopped).toContain("more objects than the cap (found 1000+");
    expect(s.deleteCalls()).toHaveLength(0);
    // 999 found under a 999 cap is fine and is swept.
    const ok = fakeServer({ first: thousand.slice(0, 999) });
    const r2 = await runSweep({ config: config({ apply: true, maxObjects: MAX_OBJECTS, maxBytes: 1024 * 1024 * 1024 }), fetchFn: ok.fetchFn, ...quiet });
    expect(r2).toMatchObject({ exitCode: 0, found: 999, removed: 999 });
    // A caller that skips readConfig and sets a cap of 1000 still never asks for more than 1000 rows, and a full page
    // of 1000 is treated as over the cap (there may be more than were listed).
    const raw = fakeServer({ first: thousand });
    const r3 = await runSweep({ config: config({ apply: true, maxObjects: 1000, maxBytes: 1024 * 1024 * 1024 }), fetchFn: raw.fetchFn, ...quiet });
    expect(raw.calls.filter((c) => c.path.endsWith("/lead_file_orphans")).map((c) => (c.body as { p_limit: number }).p_limit)).toEqual([1000]);
    expect(r3).toMatchObject({ exitCode: 1, found: 1000 });
    expect(raw.deleteCalls()).toHaveLength(0);
    expect(planSweep(thousand, { maxObjects: 1000, maxBytes: 1024 * 1024 * 1024 })).toMatchObject({ ok: false, reason: "too_many" });
  });
  test("the log and the summary hold counts per org id, never a name", async () => {
    const out: string[] = [];
    const s = fakeServer({ first: [row(ORG_A, 1, 100), row(ORG_B, 2, 200)] });
    await runSweep({ config: config({ apply: true }), fetchFn: s.fetchFn, log: (l: string) => out.push(l), summary: (m: string) => out.push(m) });
    const text = out.join("\n");
    expect(text).toContain(ORG_A);
    expect(text).not.toContain("a0000000-0000-4000-8000");
    expect(text).not.toContain(LEAD);
  });
  test("apply deletes only names found in both listings, 100 a request, and records what the Storage API removed", async () => {
    const first = Array.from({ length: 50 }, (_, i) => row(ORG_A, i + 1, 10));
    const second = [...first.slice(1), row(ORG_A, 99, 10)]; // #1 got a files row meanwhile; #99 is new
    const s = fakeServer({ first, second, gone: [path(ORG_A, 2)] });
    const r = await runSweep({ config: config({ apply: true }), fetchFn: s.fetchFn, ...quiet });
    const asked = s.deleteCalls().flatMap((c) => (c.body as { prefixes: string[] }).prefixes);
    expect(asked).toHaveLength(49);
    expect(asked).not.toContain(path(ORG_A, 1));
    expect(asked).not.toContain(path(ORG_A, 99));
    expect(r).toMatchObject({ exitCode: 0, found: 50, removed: 48, bytes: 480 });
    expect(s.recorded()).toEqual([{ p_found: 50, p_removed: 48, p_bytes: 480, p_dry: false }]);
  });
  test("apply splits 250 names into three requests", async () => {
    const first = Array.from({ length: 250 }, (_, i) => row(ORG_A, i + 1, 1));
    const s = fakeServer({ first });
    const r = await runSweep({ config: config({ apply: true, maxObjects: 300 }), fetchFn: s.fetchFn, ...quiet });
    expect(s.deleteCalls().map((c) => (c.body as { prefixes: string[] }).prefixes.length)).toEqual([100, 100, 50]);
    expect(r.removed).toBe(250);
  });
  test("caps stop the run before any delete, even in apply mode", async () => {
    const many = Array.from({ length: 51 }, (_, i) => row(ORG_A, i + 1));
    const s = fakeServer({ first: many });
    const r = await runSweep({ config: config({ apply: true }), fetchFn: s.fetchFn, ...quiet });
    expect(r.exitCode).toBe(1);
    expect(r.stopped).toContain("more objects than the cap");
    expect(s.deleteCalls()).toHaveLength(0);
    const big = fakeServer({ first: [row(ORG_A, 1, 300 * 1024 * 1024)] });
    expect((await runSweep({ config: config({ apply: true }), fetchFn: big.fetchFn, ...quiet })).exitCode).toBe(1);
    expect(big.deleteCalls()).toHaveLength(0);
  });
  test("a second listing over the cap also stops before deleting", async () => {
    const s = fakeServer({ first: [row(ORG_A, 1)], second: Array.from({ length: 51 }, (_, i) => row(ORG_A, i + 1)) });
    const r = await runSweep({ config: config({ apply: true }), fetchFn: s.fetchFn, ...quiet });
    expect(r.exitCode).toBe(1);
    expect(s.deleteCalls()).toHaveLength(0);
  });
  test("sanity: objects in the bucket but zero files rows stops before listing", async () => {
    const s = fakeServer({ stats: { bucket_objects: 5, bucket_bytes: 500, file_rows: 0, odd_names: 0 }, first: [row(ORG_A, 1)] });
    const r = await runSweep({ config: config({ apply: true }), fetchFn: s.fetchFn, ...quiet });
    expect(r.exitCode).toBe(1);
    expect(r.stopped).toContain("sanity");
    expect(s.calls.some((c) => c.path.endsWith("/lead_file_orphans"))).toBe(false);
    expect(s.deleteCalls()).toHaveLength(0);
    // An empty bucket with no rows is fine.
    const empty = fakeServer({ stats: { bucket_objects: 0, bucket_bytes: 0, file_rows: 0, odd_names: 0 } });
    expect((await runSweep({ config: config({ apply: true }), fetchFn: empty.fetchFn, ...quiet })).exitCode).toBe(0);
  });
  test("a bad row stops the run, even in apply mode", async () => {
    const s = fakeServer({ first: [row(ORG_A, 1), { ...row(ORG_A, 2), name: `${ORG_A}/../../etc.pdf` }] });
    const r = await runSweep({ config: config({ apply: true }), fetchFn: s.fetchFn, ...quiet });
    expect(r.exitCode).toBe(1);
    expect(s.deleteCalls()).toHaveLength(0);
  });
  test("a failed delete stops further deletes, records what was removed and fails the run", async () => {
    const first = Array.from({ length: 150 }, (_, i) => row(ORG_A, i + 1, 2));
    const s = fakeServer({ first, failDeleteAt: 2 });
    const r = await runSweep({ config: config({ apply: true, maxObjects: 200 }), fetchFn: s.fetchFn, ...quiet });
    expect(r).toMatchObject({ exitCode: 1, removed: 100, bytes: 200, deleteCalls: 2 });
    expect(s.recorded()).toEqual([{ p_found: 150, p_removed: 100, p_bytes: 200, p_dry: false }]);
  });
  test("a refused database call (wrong key) fails the run without deleting or printing the body", async () => {
    const out: string[] = [];
    const s = fakeServer({ first: [row(ORG_A, 1)], failRpc: "lead_file_orphans" });
    const r = await runSweep({ config: config({ apply: true }), fetchFn: s.fetchFn, log: (l: string) => out.push(l), summary: () => {} });
    expect(r.exitCode).toBe(1);
    expect(out.join("\n")).toContain("HTTP 403 (42501)");
    expect(out.join("\n")).not.toContain("permission denied");
    expect(s.deleteCalls()).toHaveLength(0);
  });
  test("every request carries the key in apikey (a secret key never as a bearer token)", async () => {
    const s = fakeServer({ first: [row(ORG_A, 1)] });
    await runSweep({ config: config({ apply: true }), fetchFn: s.fetchFn, ...quiet });
    for (const c of s.calls) {
      expect(c.headers.apikey).toBe("sb_secret_fake_test_value_only_0000");
      expect(c.headers.Authorization).toBeUndefined();
    }
  });
});
