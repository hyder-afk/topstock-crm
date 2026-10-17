import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { CALL_OUTCOMES, REACHED_OUTCOMES } from "@/lib/activities";
import { analyticsRole, runAnalytics, type Rpc } from "@/lib/analytics/fetch";
import {
  ANALYTICS_WIN_RATE_MIN,
  ANALYTICS_ZONE,
  CYCLE_MIN_WON,
  DAY_BUCKET_MAX_DAYS,
  DEFAULT_IDLE,
  MAX_RANGE_DAYS,
  MAX_WEEK_BUCKETS,
  MIN_HEAT_CALLS,
  addDays,
  bucketCount,
  idleOptions,
  parisToday,
  parseAnalyticsQuery,
  parsePageParams,
  resolveRange,
  speedBuckets,
} from "@/lib/analytics/params";
import {
  DEFAULT_BATCHES,
  MAX_BATCHES,
  activityPart,
  batchesPart,
  callTimesPart,
  coveragePart,
  pipelinePart,
  salesPart,
  speedPart,
} from "@/lib/analytics/parts";
import { openStageKeys } from "@/lib/deals";
import { WIN_RATE_MIN_CLOSED } from "@/lib/home";
import { inactivityOptions } from "@/lib/leads";

// Analytics v1 P1 (design docs/evidence/analytics/design.md 3.5, 3.6 and 5.1): the range rules in Paris time, the strict
// and lenient parameter parses, the strict result parses, the parallel reads with their 403/400 mapping, and the literals
// shared with SQL (the migration and Home's K4 list) so the two sides cannot drift.

const mig = (name: string) => readFileSync(join(__dirname, "../../supabase/migrations", name), "utf8");
const analyticsSql = mig("20261024090000_analytics.sql");
const homeSql = mig("20261015150000_home_dashboard.sql");
const quoted = (text: string) => [...text.matchAll(/'([a-z_0-9]+)'/g)].map((m) => m[1]);

// ---------------------------------------------------------------------------------------------------------------------
// resolveRange and the Paris day
// ---------------------------------------------------------------------------------------------------------------------
test("presets end on Paris today: 7d, 30d, 90d, this month, last month", () => {
  const t = "2026-10-17";
  expect(resolveRange({ range: "7d" }, t)).toEqual({ from: "2026-10-11", to: t, bucket: "day", days: 7 });
  expect(resolveRange({ range: "30d" }, t)).toEqual({ from: "2026-09-18", to: t, bucket: "day", days: 30 });
  expect(resolveRange({}, t)).toEqual(resolveRange({ range: "30d" }, t)); // the default
  expect(resolveRange({ range: "90d" }, t)).toEqual({ from: "2026-07-20", to: t, bucket: "week", days: 90 });
  expect(resolveRange({ range: "mtd" }, t)).toEqual({ from: "2026-10-01", to: t, bucket: "day", days: 17 });
  expect(resolveRange({ range: "last_month" }, t)).toEqual({ from: "2026-09-01", to: "2026-09-30", bucket: "day", days: 30 });
});

test("the Paris date on the server: day edges and both clock changes", () => {
  // 31 Oct 2026 23:30 UTC is already 1 Nov in Paris (winter time, UTC+1); 22:30 UTC is still 31 Oct.
  expect(parisToday(new Date("2026-10-31T23:30:00Z"))).toBe("2026-11-01");
  expect(parisToday(new Date("2026-10-31T22:59:59Z"))).toBe("2026-10-31");
  // 25 Oct 2026 (25 hours): 00:30 UTC is 02:30 summer time, 23:00 UTC is midnight winter time.
  expect(parisToday(new Date("2026-10-25T00:30:00Z"))).toBe("2026-10-25");
  expect(parisToday(new Date("2026-10-25T22:59:00Z"))).toBe("2026-10-25");
  expect(parisToday(new Date("2026-10-25T23:00:00Z"))).toBe("2026-10-26");
  // 29 Mar 2026 (23 hours): 23:30 UTC the day before is 00:30 winter time; 22:00 UTC is midnight summer time.
  expect(parisToday(new Date("2026-03-28T23:30:00Z"))).toBe("2026-03-29");
  expect(parisToday(new Date("2026-03-29T21:59:00Z"))).toBe("2026-03-29");
  expect(parisToday(new Date("2026-03-29T22:00:00Z"))).toBe("2026-03-30");
  // The presets from those days stay whole calendar days (no clock change shifts a bound).
  expect(resolveRange({ range: "mtd" }, parisToday(new Date("2026-10-31T23:30:00Z")))).toEqual({
    from: "2026-11-01",
    to: "2026-11-01",
    bucket: "day",
    days: 1,
  });
  expect(resolveRange({ range: "last_month" }, "2026-11-01")).toEqual({ from: "2026-10-01", to: "2026-10-31", bucket: "day", days: 31 });
  expect(resolveRange({ range: "7d" }, "2026-10-25")).toEqual({ from: "2026-10-19", to: "2026-10-25", bucket: "day", days: 7 });
  expect(resolveRange({ range: "7d" }, "2026-03-29")).toEqual({ from: "2026-03-23", to: "2026-03-29", bucket: "day", days: 7 });
  expect(resolveRange({ range: "30d" }, "2026-03-29")?.from).toBe("2026-02-28");
});

test("month ends and 29 February 2028", () => {
  expect(resolveRange({ range: "last_month" }, "2028-03-31")).toEqual({ from: "2028-02-01", to: "2028-02-29", bucket: "day", days: 29 });
  expect(resolveRange({ range: "mtd" }, "2028-02-29")).toEqual({ from: "2028-02-01", to: "2028-02-29", bucket: "day", days: 29 });
  expect(resolveRange({ range: "last_month" }, "2026-03-29")).toEqual({ from: "2026-02-01", to: "2026-02-28", bucket: "day", days: 28 });
  expect(resolveRange({ range: "last_month" }, "2027-01-15")).toEqual({ from: "2026-12-01", to: "2026-12-31", bucket: "day", days: 31 });
  // 30 days back from 1 March: 1 February in a leap year (29 days in February), 31 January otherwise.
  expect(resolveRange({ range: "30d" }, "2028-03-01")?.from).toBe("2028-02-01");
  expect(resolveRange({ range: "30d" }, "2027-03-01")?.from).toBe("2027-01-31");
  expect(addDays("2028-02-28", 1)).toBe("2028-02-29");
  expect(addDays("2027-02-28", 1)).toBe("2027-03-01");
});

test("bucket rule: 31 days are days, 32 are weeks", () => {
  const t = "2026-10-17";
  expect(resolveRange({ range: "custom", from: "2026-08-01", to: "2026-08-31" }, t)?.bucket).toBe("day");
  expect(resolveRange({ range: "custom", from: "2026-08-01", to: "2026-09-01" }, t)?.bucket).toBe("week");
  expect(bucketCount({ from: "2026-08-01", to: "2026-08-31", bucket: "day" })).toBe(31);
  // The database test's 90-day case: Wednesday 3 Jun to Monday 31 Aug 2026 is 14 weeks, both ends partial.
  expect(bucketCount({ from: "2026-06-03", to: "2026-08-31", bucket: "week" })).toBe(14);
});

test("the week cap: 5 Jan 2025 to 5 Jan 2026 (366 days) is 54 weeks; the parts accept 54 and refuse 55", () => {
  const r = resolveRange({ range: "custom", from: "2025-01-05", to: "2026-01-05" }, "2026-10-17");
  expect(r).toEqual({ from: "2025-01-05", to: "2026-01-05", bucket: "week", days: 366 });
  expect(bucketCount(r!)).toBe(MAX_WEEK_BUCKETS);
  const weeks = (n: number) => Array.from({ length: n }, (_, i) => ({ start: addDays("2024-12-30", 7 * i), partial: i === 0 || i === n - 1 }));
  const activity = (n: number) => ({ ...activitySample, bucket: "week", buckets: weeks(n).map((w) => ({ ...w, ...zeroCounts })) });
  expect(activityPart.safeParse(activity(54)).success).toBe(true);
  expect(activityPart.safeParse(activity(55)).success).toBe(false);
  const sales = (n: number) => ({ ...salesSample, bucket: "week", buckets: weeks(n).map((w) => ({ ...w, revenue: "0.00", sales: 0 })) });
  expect(salesPart.safeParse(sales(54)).success).toBe(true);
  expect(salesPart.safeParse(sales(55)).success).toBe(false);
  // Day buckets stop at 31.
  const days = (n: number) => ({ ...activitySample, buckets: Array.from({ length: n }, (_, i) => ({ start: addDays("2026-08-01", i), partial: false, ...zeroCounts })) });
  expect(activityPart.safeParse(days(31)).success).toBe(true);
  expect(activityPart.safeParse(days(32)).success).toBe(false);
});

test("custom ranges: reversed, 367 days, a future end, and from without custom are refused", () => {
  const t = "2026-10-17";
  expect(resolveRange({ range: "custom", from: "2026-09-30", to: "2026-09-01" }, t)).toBeNull();
  expect(resolveRange({ range: "custom", from: "2025-01-05", to: "2026-01-06" }, t)).toBeNull();
  expect(resolveRange({ range: "custom", from: "2026-10-01", to: "2026-10-18" }, t)).toBeNull();
  expect(resolveRange({ range: "custom", from: "2026-10-17", to: "2026-10-17" }, t)).toEqual({ from: t, to: t, bucket: "day", days: 1 });
  expect(resolveRange({ range: "custom", from: "2026-10-01" }, t)).toBeNull();
  const q = (s: string) => parseAnalyticsQuery(new URLSearchParams(s)).success;
  expect(q("range=custom&from=2026-09-30&to=2026-09-01")).toBe(false);
  expect(q("range=custom&from=2025-01-05&to=2026-01-06")).toBe(false);
  expect(q("range=custom&from=2025-01-05&to=2026-01-05")).toBe(true);
  expect(q("from=2026-09-01&to=2026-09-30")).toBe(false);
  expect(q("range=30d&from=2026-09-01")).toBe(false);
  expect(q("range=custom&from=2026-09-01")).toBe(false);
  expect(q("range=custom&from=2026-02-30&to=2026-03-01")).toBe(false);
  expect(q("range=custom&from=2026-9-1&to=2026-09-30")).toBe(false);
});

// ---------------------------------------------------------------------------------------------------------------------
// Parameters: strict for the API, lenient for the page
// ---------------------------------------------------------------------------------------------------------------------
test("the API refuses unknown, repeated or bad parameters", () => {
  const q = (s: string) => parseAnalyticsQuery(new URLSearchParams(s));
  expect(q("")).toEqual({ success: true, data: {} });
  expect(q("range=7d&idle=90&rep=3f1c2b6e-8d4a-4c5e-9f00-1a2b3c4d5e6f")).toEqual({
    success: true,
    data: { range: "7d", idle: 90, rep: "3f1c2b6e-8d4a-4c5e-9f00-1a2b3c4d5e6f" },
  });
  for (const bad of [
    "foo=1",
    "range=1y",
    "range=7d&range=30d",
    "idle=14",
    "idle=",
    "idle=30.5",
    "rep=not-a-uuid",
    "rep=3f1c2b6e-8d4a-4c5e-9f00-1a2b3c4d5e6f&rep=3f1c2b6e-8d4a-4c5e-9f00-1a2b3c4d5e6f",
    "rep=' or 1=1 --",
    "range=30d&scope=team",
  ]) {
    expect(q(bad).success, bad).toBe(false);
  }
});

test("the page drops bad values instead of failing", () => {
  expect(parsePageParams({ range: "bogus", rep: "x", idle: "14", foo: "1" })).toEqual({ range: undefined, rep: undefined, idle: undefined });
  expect(parsePageParams({ range: ["7d", "30d"], idle: "7" })).toEqual({ range: "7d", rep: undefined, idle: 7 });
  expect(parsePageParams({ range: "custom", from: "2026-09-01", to: "2026-09-30" })).toEqual({
    range: "custom",
    rep: undefined,
    idle: undefined,
    from: "2026-09-01",
    to: "2026-09-30",
  });
  // A custom range missing a date, reversed or too long falls back to the default preset.
  expect(parsePageParams({ range: "custom", from: "2026-09-01" }).range).toBeUndefined();
  expect(parsePageParams({ range: "custom", from: "2026-09-30", to: "2026-09-01" }).range).toBeUndefined();
  expect(parsePageParams({ range: "custom", from: "2025-01-01", to: "2026-09-01" }).range).toBeUndefined();
  // Dates without custom are ignored.
  expect(parsePageParams({ range: "7d", from: "2026-09-01", to: "2026-09-30" })).toEqual({ range: "7d", rep: undefined, idle: undefined });
});

// ---------------------------------------------------------------------------------------------------------------------
// Results: strict parses
// ---------------------------------------------------------------------------------------------------------------------
const U1 = "3f1c2b6e-8d4a-4c5e-9f00-1a2b3c4d5e6f";
const U2 = "8a0b6d3c-2e4f-4a1b-8c9d-0e1f2a3b4c5d";
const zeroCounts = { calls: 0, reached: 0, emails: 0, whatsapp: 0, meetings: 0 };
const activitySample = {
  scope: "team",
  owner_id: null,
  bucket: "day",
  buckets: [{ start: "2026-09-02", partial: false, calls: 3, reached: 1, emails: 0, whatsapp: 0, meetings: 0 }],
  totals: { calls: 8, reached: 5, emails: 2, whatsapp: 1, meetings: 2, meetings_held: 1 },
  by_person: [
    { user_id: U1, calls: 4, reached: 2, emails: 1, whatsapp: 1, meetings: 1 },
    { user_id: null, calls: 1, reached: 1, emails: 0, whatsapp: 0, meetings: 0 },
  ],
};
const pipelineSample = {
  opened: { count: 12, value: "4960.00", no_value: 1 },
  won: { count: 3, value: "3500.00" },
  lost: { count: 2, mistake: 1 },
  win_rate: { won: 3, lost: 2, rate: 0.6 },
  cycle: { n: 3, median_days: 14.0, mean_days: 11.0 },
  funnel: { cohort: 12, lead: 12, qualified: 5, negotiations: 5, won: 4, still_open: 7, lost: 1, mistake: 1 },
  stage_days: [
    { key: "lead", n: 8, median_days: 2.0 },
    { key: "qualified", n: 1, median_days: 5.0 },
    { key: "negotiations", n: 0, median_days: null },
  ],
  lost_reasons: [
    { code: "price", count: 1 },
    { code: "timing", count: 1 },
  ],
  by_person: [{ user_id: U1, opened: 8, won: 2, won_value: "1500.00", lost: 1, rate: null }],
};
const speedSample = {
  leads: 5,
  touched: 4,
  median_minutes: 1740,
  within_1h: 1,
  within_24h: 2,
  buckets: speedBuckets.map((key) => ({ key, count: 1 })),
};
const callTimesSample = { min_calls: 5, cells: [{ dow: 3, hour: 10, calls: 2, reached: 1 }] };
const salesSample = {
  bucket: "day",
  buckets: [{ start: "2026-06-02", partial: false, revenue: "220.00", sales: 1 }],
  totals: { revenue: "510.00", sales: 3, from_stock: "420.00", direct: "90.00" },
  top_products: [{ name: "denim jacket", revenue: "290.00", pieces: 13 }],
};
const coverageSample = {
  idle_days: 30,
  untouched: 3,
  never_contacted: 1,
  no_next_step: 2,
  overdue_tasks: 2,
  as_of: "2026-10-17T00:40:35.123456+00:00",
};
const batchesSample = [
  {
    id: U2,
    filename: "<img src=x onerror=alert(1)> liste été.csv",
    created_at: "2026-05-01T08:00:00+00:00",
    leads: 4,
    contacted: 2,
    reached: 1,
    with_deal: 2,
    won: 1,
  },
];

test("each block's answer parses as the database writes it", () => {
  expect(activityPart.safeParse(activitySample).success).toBe(true);
  expect(activityPart.safeParse({ ...activitySample, scope: "person", owner_id: U1, by_person: undefined }).success).toBe(true);
  expect(pipelinePart.safeParse(pipelineSample).success).toBe(true);
  expect(speedPart.safeParse(speedSample).success).toBe(true);
  expect(speedPart.safeParse({ ...speedSample, touched: 0, median_minutes: null }).success).toBe(true);
  expect(callTimesPart.safeParse(callTimesSample).success).toBe(true);
  expect(salesPart.safeParse(salesSample).success).toBe(true);
  expect(coveragePart.safeParse(coverageSample).success).toBe(true);
  expect(batchesPart.safeParse(batchesSample).success).toBe(true);
  // The file name comes back as the very same text (never interpreted).
  expect(batchesPart.parse(batchesSample)[0].filename).toBe("<img src=x onerror=alert(1)> liste été.csv");
});

test("an unknown key anywhere (a cost, say) fails the block", () => {
  expect(activityPart.safeParse({ ...activitySample, totals: { ...activitySample.totals, cost_per_piece: 1 } }).success).toBe(false);
  expect(activityPart.safeParse({ ...activitySample, extra: 1 }).success).toBe(false);
  expect(salesPart.safeParse({ ...salesSample, top_products: [{ ...salesSample.top_products[0], cost_per_piece: "1.00" }] }).success).toBe(false);
  expect(salesPart.safeParse({ ...salesSample, totals: { ...salesSample.totals, margin: "1.00" } }).success).toBe(false);
  expect(pipelinePart.safeParse({ ...pipelineSample, lost_note: "x" }).success).toBe(false);
  expect(pipelinePart.safeParse({ ...pipelineSample, won: { ...pipelineSample.won, notes: [] } }).success).toBe(false);
  expect(batchesPart.safeParse([{ ...batchesSample[0], uploaded_by: U1 }]).success).toBe(false);
  expect(coveragePart.safeParse({ ...coverageSample, body: "x" }).success).toBe(false);
  expect(callTimesPart.safeParse({ ...callTimesSample, cells: [{ ...callTimesSample.cells[0], body: "x" }] }).success).toBe(false);
  expect(speedPart.safeParse({ ...speedSample, leads_list: [] }).success).toBe(false);
});

test("negative counts, bad sums, over-long lists and unknown codes fail", () => {
  expect(activityPart.safeParse({ ...activitySample, totals: { ...activitySample.totals, calls: -1 } }).success).toBe(false);
  expect(activityPart.safeParse({ ...activitySample, totals: { ...activitySample.totals, calls: 1.5 } }).success).toBe(false);
  for (const value of ["12.345", "1e5", "-1.00", "", "12,00", "NaN", "12345678901234567.00"]) {
    expect(pipelinePart.safeParse({ ...pipelineSample, opened: { ...pipelineSample.opened, value } }).success, value).toBe(false);
  }
  expect(pipelinePart.safeParse({ ...pipelineSample, opened: { ...pipelineSample.opened, value: "1234567890123456.99" } }).success).toBe(true);
  expect(pipelinePart.safeParse({ ...pipelineSample, win_rate: { won: 1, lost: 0, rate: 1.2 } }).success).toBe(false);
  expect(pipelinePart.safeParse({ ...pipelineSample, lost_reasons: [{ code: "bogus", count: 1 }] }).success).toBe(false);
  expect(pipelinePart.safeParse({ ...pipelineSample, stage_days: [{ key: "won", n: 1, median_days: 1 }] }).success).toBe(false);
  expect(pipelinePart.safeParse({ ...pipelineSample, cycle: { n: 3, median_days: -1, mean_days: 1 } }).success).toBe(false);
  expect(
    pipelinePart.safeParse({ ...pipelineSample, lost_reasons: Array.from({ length: 9 }, () => ({ code: "price", count: 1 })) }).success,
  ).toBe(false);
  const cells = (n: number) => Array.from({ length: n }, (_, i) => ({ dow: (i % 7) + 1, hour: i % 24, calls: 1, reached: 0 }));
  expect(callTimesPart.safeParse({ min_calls: 5, cells: cells(168) }).success).toBe(true);
  expect(callTimesPart.safeParse({ min_calls: 5, cells: cells(169) }).success).toBe(false);
  expect(callTimesPart.safeParse({ min_calls: 5, cells: [{ dow: 8, hour: 1, calls: 1, reached: 0 }] }).success).toBe(false);
  expect(callTimesPart.safeParse({ min_calls: 5, cells: [{ dow: 1, hour: 24, calls: 1, reached: 0 }] }).success).toBe(false);
  expect(callTimesPart.safeParse({ min_calls: 3, cells: [] }).success).toBe(false);
  const products = (n: number) => Array.from({ length: n }, (_, i) => ({ name: `P${i}`, revenue: "1.00", pieces: 1 }));
  expect(salesPart.safeParse({ ...salesSample, top_products: products(10) }).success).toBe(true);
  expect(salesPart.safeParse({ ...salesSample, top_products: products(11) }).success).toBe(false);
  expect(batchesPart.safeParse(Array.from({ length: MAX_BATCHES }, () => batchesSample[0])).success).toBe(true);
  expect(batchesPart.safeParse(Array.from({ length: MAX_BATCHES + 1 }, () => batchesSample[0])).success).toBe(false);
  expect(coveragePart.safeParse({ ...coverageSample, idle_days: 14 }).success).toBe(false);
  expect(speedPart.safeParse({ ...speedSample, buckets: speedSample.buckets.slice(1) }).success).toBe(false);
});

test("a person's activity never carries colleague rows; the team's always does", () => {
  expect(activityPart.safeParse({ ...activitySample, scope: "person", owner_id: U1 }).success).toBe(false);
  expect(activityPart.safeParse({ ...activitySample, by_person: undefined }).success).toBe(false);
  expect(activityPart.safeParse({ ...activitySample, owner_id: U1 }).success).toBe(false);
});

// ---------------------------------------------------------------------------------------------------------------------
// runAnalytics: parallel reads, who gets what, 403 and 400
// ---------------------------------------------------------------------------------------------------------------------
const answers: Record<string, unknown> = {
  analytics_activity: activitySample,
  analytics_pipeline: pipelineSample,
  analytics_speed: speedSample,
  analytics_call_times: callTimesSample,
  analytics_sales: salesSample,
  analytics_coverage: coverageSample,
  analytics_batches: batchesSample,
  list_team: [{ id: U1, first_name: "Rita", last_name: "R", role: "rep" }],
};
function fakeRpc(overrides: Record<string, { data: unknown; error: { code?: string; hint?: string; message?: string } | null } | "reject"> = {}) {
  const calls: { fn: string; args?: Record<string, unknown> }[] = [];
  const rpc: Rpc = (fn, args) => {
    calls.push({ fn, args });
    const o = overrides[fn];
    if (o === "reject") return Promise.reject(new Error("network down"));
    return Promise.resolve(o ?? { data: answers[fn], error: null });
  };
  return { rpc, calls };
}
const query = { range: { from: "2026-09-18", to: "2026-10-17", bucket: "day" as const, days: 30 }, rep: null, idle: DEFAULT_IDLE };

test("an admin gets every block, list quality and the team; arguments are typed values only", async () => {
  const { rpc, calls } = fakeRpc();
  const data = await runAnalytics(rpc, query, "admin");
  if (typeof data === "string") throw new Error(data);
  for (const part of [data.activity, data.pipeline, data.speed, data.callTimes, data.sales, data.coverage, data.batches, data.team]) {
    expect(part?.ok).toBe(true);
  }
  expect(calls.map((c) => c.fn).sort()).toEqual([
    "analytics_activity",
    "analytics_batches",
    "analytics_call_times",
    "analytics_coverage",
    "analytics_pipeline",
    "analytics_sales",
    "analytics_speed",
    "list_team",
  ]);
  expect(calls.find((c) => c.fn === "analytics_activity")?.args).toEqual({ p_from: "2026-09-18", p_to: "2026-10-17", p_user: null });
  expect(calls.find((c) => c.fn === "analytics_coverage")?.args).toEqual({ p_user: null, p_idle_days: 30 });
  expect(calls.find((c) => c.fn === "analytics_batches")?.args).toEqual({ p_user: null, p_limit: DEFAULT_BATCHES });
  expect([data.from, data.to, data.bucket, data.rep, data.idle]).toEqual(["2026-09-18", "2026-10-17", "day", null, 30]);
});

test("a manager gets the team but not list quality; a rep gets neither", async () => {
  const m = fakeRpc();
  const manager = await runAnalytics(m.rpc, query, "manager");
  if (typeof manager === "string") throw new Error(manager);
  expect(manager.batches).toBeNull();
  expect(manager.team?.ok).toBe(true);
  expect(m.calls.map((c) => c.fn)).not.toContain("analytics_batches");
  const r = fakeRpc();
  const rep = await runAnalytics(r.rpc, { ...query, rep: U1 }, "rep");
  if (typeof rep === "string") throw new Error(rep);
  expect(rep.batches).toBeNull();
  expect(rep.team).toBeNull();
  expect(r.calls.map((c) => c.fn).sort()).toEqual([
    "analytics_activity",
    "analytics_call_times",
    "analytics_coverage",
    "analytics_pipeline",
    "analytics_sales",
    "analytics_speed",
  ]);
  expect(r.calls.every((c) => c.args?.p_user === U1)).toBe(true);
});

test("one failing or misshapen block fails alone; the database's message never comes through", async () => {
  const { rpc } = fakeRpc({
    analytics_speed: { data: null, error: { code: "XX000", message: "SECRET internal detail" } },
    analytics_sales: { data: { ...salesSample, cost: 1 }, error: null },
    analytics_pipeline: "reject",
  });
  const data = await runAnalytics(rpc, query, "admin");
  if (typeof data === "string") throw new Error(data);
  expect([data.speed.ok, data.sales.ok, data.pipeline.ok]).toEqual([false, false, false]);
  expect([data.activity.ok, data.callTimes.ok, data.coverage.ok, data.batches?.ok]).toEqual([true, true, true, true]);
  expect(JSON.stringify(data)).not.toContain("SECRET");
  expect(data.speed).toEqual({ ok: false });
});

test("a refused person filter is 'forbidden' (403); a person outside the organisation is 'invalid' (400)", async () => {
  const scope = { data: null, error: { code: "42501", hint: "scope", message: "only managers" } };
  expect(await runAnalytics(fakeRpc({ analytics_activity: scope }).rpc, { ...query, rep: U2 }, "rep")).toBe("forbidden");
  expect(await runAnalytics(fakeRpc({ analytics_coverage: scope }).rpc, { ...query, rep: U2 }, "rep")).toBe("forbidden");
  const rep = { data: null, error: { code: "P0002", hint: "rep", message: "no such team member" } };
  expect(await runAnalytics(fakeRpc({ analytics_sales: rep }).rpc, { ...query, rep: U2 }, "admin")).toBe("invalid");
  // A two-factor refusal (no scope hint) is a failed block, not a 403 for the filter.
  const aal = await runAnalytics(fakeRpc({ analytics_activity: { data: null, error: { code: "42501", hint: "forbidden" } } }).rpc, query, "admin");
  expect(typeof aal === "string" ? aal : aal.activity).toEqual({ ok: false });
});

test("C4: the six blocks start before the role read answers; list quality and the team wait for it", async () => {
  const { rpc, calls } = fakeRpc();
  let answer!: (role: "admin" | "manager" | "rep") => void;
  const role = new Promise<"admin" | "manager" | "rep">((resolve) => (answer = resolve));
  const pending = runAnalytics(rpc, query, role);
  await Promise.resolve();
  expect(calls.map((c) => c.fn).sort()).toEqual([
    "analytics_activity",
    "analytics_call_times",
    "analytics_coverage",
    "analytics_pipeline",
    "analytics_sales",
    "analytics_speed",
  ]);
  answer("admin");
  const data = await pending;
  if (typeof data === "string") throw new Error(data);
  expect(data.batches?.ok).toBe(true);
  expect(data.team?.ok).toBe(true);
  expect(calls.map((c) => c.fn)).toEqual(expect.arrayContaining(["analytics_batches", "list_team"]));
  // A role read that fails is a rep: the blocks still answer, nothing admin-only runs.
  const r = fakeRpc();
  const asRep = await runAnalytics(r.rpc, query, Promise.reject(new Error("profile read failed")));
  if (typeof asRep === "string") throw new Error(asRep);
  expect([asRep.activity.ok, asRep.batches, asRep.team]).toEqual([true, null, null]);
  expect(r.calls.map((c) => c.fn)).not.toContain("analytics_batches");
});

test("the role the server acts on: anything unknown is a rep", () => {
  expect(analyticsRole("admin")).toBe("admin");
  expect(analyticsRole("manager")).toBe("manager");
  for (const v of ["rep", "owner", "", null, undefined, 1, { role: "admin" }]) expect(analyticsRole(v)).toBe("rep");
});

// ---------------------------------------------------------------------------------------------------------------------
// Parity with SQL
// ---------------------------------------------------------------------------------------------------------------------
test("one 'reached' list for Home and Analytics, checked against both migrations", () => {
  expect(REACHED_OUTCOMES.every((o) => (CALL_OUTCOMES as readonly string[]).includes(o))).toBe(true);
  expect(CALL_OUTCOMES.filter((o) => !(REACHED_OUTCOMES as readonly string[]).includes(o))).toEqual(["no_answer", "voicemail", "wrong_number"]);
  const lists = (sql: string) => [...sql.matchAll(/outcome in \(([^)]*)\)/g)].map((m) => quoted(m[1]));
  const home = lists(homeSql);
  expect(home.length).toBe(2); // K4 team and mine
  for (const l of home) expect(l).toEqual([...REACHED_OUTCOMES]);
  const analytics = lists(analyticsSql);
  expect(analytics.length).toBe(4); // activity (buckets, by person), call times, list quality
  for (const l of analytics) expect(l).toEqual([...REACHED_OUTCOMES]);
});

test("range rules, zone, idle days, minimums and limits match the migration", () => {
  expect(analyticsSql).toContain(`p_to - p_from > ${MAX_RANGE_DAYS - 1}`);
  expect(analyticsSql).toContain(`p_to - p_from < ${DAY_BUCKET_MAX_DAYS} then 'day' else 'week'`);
  expect(analyticsSql).toContain(`p_to > (now() at time zone '${ANALYTICS_ZONE}')::date`);
  expect(quoted(analyticsSql.match(/p_idle_days not in \(([^)]*)\)/)![1].replace(/(\d+)/g, "'$1'")).map(Number)).toEqual([...idleOptions]);
  expect([...idleOptions]).toEqual([...inactivityOptions]);
  expect(analyticsSql).toContain(`p_idle_days integer default ${DEFAULT_IDLE}`);
  expect(analyticsSql).toContain(`'min_calls', ${MIN_HEAT_CALLS}`);
  expect(ANALYTICS_WIN_RATE_MIN).toBe(WIN_RATE_MIN_CLOSED);
  expect(analyticsSql.match(/x\.won \+ x\.lost >= (\d+)/g)?.map((m) => Number(m.split(">= ")[1]))).toEqual([WIN_RATE_MIN_CLOSED, WIN_RATE_MIN_CLOSED]);
  expect(analyticsSql).toContain(`case when count(*) >= ${CYCLE_MIN_WON} then round((percentile_cont(0.5)`);
  expect(analyticsSql).toContain(`p_limit not between 1 and ${MAX_BATCHES}`);
  expect(analyticsSql).toContain(`p_limit integer default ${DEFAULT_BATCHES}`);
  // Every bucket and hour in Paris time: no other zone appears.
  expect([...analyticsSql.matchAll(/at time zone '([^']+)'/g)].every((m) => m[1] === ANALYTICS_ZONE)).toBe(true);
});

test("the funnel's stage order, days-in-stage keys and speed buckets match the migration", () => {
  expect(analyticsSql).toContain("case h.to_stage when 'lead' then 1 when 'qualified' then 2 when 'negotiations' then 3 end");
  expect(quoted(analyticsSql.match(/case h\.to_stage (when [^\n]*?) end/)![1])).toEqual([...openStageKeys]);
  expect(analyticsSql).toContain("(values ('lead', 1), ('qualified', 2), ('negotiations', 3)) as k (key, pos)");
  expect([...analyticsSql.matchAll(/jsonb_build_object\('key', '([a-z0-9]+)', 'count'/g)].map((m) => m[1])).toEqual([...speedBuckets]);
});
