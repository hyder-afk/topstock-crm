import { z } from "zod";
import { REACHED_OUTCOMES } from "@/lib/activities";
import { WIN_RATE_MIN_CLOSED, dateInZone } from "@/lib/home";
import { inactivityOptions } from "@/lib/leads";

// Analytics v1 inputs (design docs/evidence/analytics/design.md sections 1.0, 2 and 3.5): the range presets, custom
// dates, the person filter and the untouched days, and resolveRange, which turns them into the Paris dates the database
// functions take. Pure (no I/O, no secrets), so the page, the route and the unit tests share one definition; only the
// server ever calls it with "today", so the browser never does calendar arithmetic for a query. The literals shared
// with SQL are checked against the migration by tests/unit/analytics.spec.ts.

/** Every bucket, range bound and hour is a Paris one (design 1.0, Q2). */
export const ANALYTICS_ZONE = "Europe/Paris";
export const analyticsRanges = ["7d", "30d", "90d", "mtd", "last_month", "custom"] as const;
export type AnalyticsRange = (typeof analyticsRanges)[number];
export const DEFAULT_RANGE: AnalyticsRange = "30d";
/** A range holds at most this many days, both ends included (SQL: p_to - p_from <= 365). */
export const MAX_RANGE_DAYS = 366;
/** Ranges of this many days or fewer use day buckets; longer ones ISO weeks (SQL: p_to - p_from < 31). */
export const DAY_BUCKET_MAX_DAYS = 31;
/** A 366-day range can touch 54 ISO weeks, partial at both ends (design 3.5). */
export const MAX_WEEK_BUCKETS = 54;
/** Untouched days for "Right now": the Leads list's own options, so a tile's count matches its link. */
export const idleOptions = inactivityOptions;
export const DEFAULT_IDLE = 30;
/** A heatmap cell shows a rate from this many calls (analytics_call_times' min_calls). */
export const MIN_HEAT_CALLS = 5;
/** Win rate from 5 closed deals (Home's D27); the median cycle from 3 won deals. */
export const ANALYTICS_WIN_RATE_MIN = WIN_RATE_MIN_CLOSED;
export const CYCLE_MIN_WON = 3;
export { REACHED_OUTCOMES };
/** Speed-to-lead buckets, in the order the database answers them. */
export const speedBuckets = ["lt1h", "lt24h", "lt3d", "gte3d", "none"] as const;
export type Bucket = "day" | "week";

const isoDate = z.iso.date();
const idle = z.coerce
  .number()
  .int()
  .refine((n) => (idleOptions as readonly number[]).includes(n));

const fields = {
  range: z.enum(analyticsRanges).optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
  rep: z.uuid().optional(),
  idle: idle.optional(),
};

/** What GET /api/analytics accepts: strict, an unknown key or a bad value is refused (400). */
export const analyticsParams = z.strictObject(fields).superRefine((p, ctx) => {
  const custom = p.range === "custom";
  if (custom && (p.from === undefined || p.to === undefined)) {
    ctx.addIssue({ code: "custom", message: "custom needs from and to", input: p });
  }
  if (!custom && (p.from !== undefined || p.to !== undefined)) {
    ctx.addIssue({ code: "custom", message: "from and to only with custom", input: p });
  }
  if (custom && p.from !== undefined && p.to !== undefined) {
    const span = daysBetween(p.from, p.to);
    if (span < 0 || span + 1 > MAX_RANGE_DAYS) ctx.addIssue({ code: "custom", message: "bounds", input: p });
  }
});
export type AnalyticsParams = z.infer<typeof analyticsParams>;

/**
 * The route's parse of its query string: each key at most once (a repeated key is refused, not silently last-wins),
 * then the strict schema.
 */
export function parseAnalyticsQuery(search: URLSearchParams): { success: true; data: AnalyticsParams } | { success: false } {
  const keys = [...search.keys()];
  if (new Set(keys).size !== keys.length) return { success: false };
  const parsed = analyticsParams.safeParse(Object.fromEntries(search));
  return parsed.success ? { success: true, data: parsed.data } : { success: false };
}

/**
 * The page's parse (lenient, like the Leads filters): a bad value is dropped, never an error; a custom range missing a
 * date or out of bounds falls back to the default preset. Values may arrive as arrays (repeated keys): the first counts.
 */
export function parsePageParams(search: Record<string, string | string[] | undefined>): AnalyticsParams {
  const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
  const pick = <T>(schema: z.ZodType<T>, v: unknown): T | undefined => {
    const r = schema.safeParse(v);
    return r.success ? r.data : undefined;
  };
  const out: AnalyticsParams = {
    range: pick(z.enum(analyticsRanges), first(search.range)),
    rep: pick(z.uuid(), first(search.rep)),
    idle: pick(idle, first(search.idle)),
  };
  if (out.range === "custom") {
    const from = pick(isoDate, first(search.from));
    const to = pick(isoDate, first(search.to));
    if (from && to && analyticsParams.safeParse({ range: "custom", from, to }).success) return { ...out, from, to };
    return { ...out, range: undefined };
  }
  return out;
}

/** Whole days from one ISO date to another (negative when `to` is earlier). */
export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

/** An ISO date moved by whole days (calendar arithmetic in UTC, so no clock change can shift it). */
export function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

/** The Paris calendar date of an instant (the server's "today" for every preset; Home's dateInZone). */
export function parisToday(at: Date = new Date()): string {
  // Europe/Paris is in every ICU build; the UTC date is only a type-level fallback.
  return dateInZone(at, ANALYTICS_ZONE) ?? at.toISOString().slice(0, 10);
}

export type ResolvedRange = { from: string; to: string; bucket: Bucket; days: number };

/**
 * The query's Paris dates (both included) and bucket size, from the parsed parameters and the Paris date today on the
 * server. Presets: 7d, 30d and 90d end today; mtd is the 1st of this month to today; last_month the whole previous
 * month. A custom range must hold 1 to 366 days and end today at the latest; null otherwise (the route answers 400).
 */
export function resolveRange(p: Pick<AnalyticsParams, "range" | "from" | "to">, today: string): ResolvedRange | null {
  const range = p.range ?? DEFAULT_RANGE;
  let from: string;
  let to = today;
  switch (range) {
    case "7d":
      from = addDays(today, -6);
      break;
    case "30d":
      from = addDays(today, -29);
      break;
    case "90d":
      from = addDays(today, -89);
      break;
    case "mtd":
      from = `${today.slice(0, 8)}01`;
      break;
    case "last_month": {
      to = addDays(`${today.slice(0, 8)}01`, -1);
      from = `${to.slice(0, 8)}01`;
      break;
    }
    case "custom":
      if (!p.from || !p.to) return null;
      from = p.from;
      to = p.to;
      break;
  }
  const days = daysBetween(from, to) + 1;
  if (days < 1 || days > MAX_RANGE_DAYS || daysBetween(to, today) < 0) return null;
  return { from, to, bucket: days <= DAY_BUCKET_MAX_DAYS ? "day" : "week", days };
}

/** The Monday of an ISO date's week. */
export function mondayOf(date: string): string {
  const dow = new Date(`${date}T00:00:00Z`).getUTCDay(); // 0 = Sunday
  return addDays(date, -((dow + 6) % 7));
}

/** How many buckets the database answers for a range (empty ones included). */
export function bucketCount(r: Pick<ResolvedRange, "from" | "to" | "bucket">): number {
  if (r.bucket === "day") return daysBetween(r.from, r.to) + 1;
  return daysBetween(mondayOf(r.from), mondayOf(r.to)) / 7 + 1;
}
