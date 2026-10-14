import { z } from "zod";
import { MONEY_PATTERN } from "@/lib/money";

// The Home dashboard's data (Day 5 design 4.3, 5.8, 7.10 to 7.12; D26 to D30). Each card reads one part of GET
// /api/home; the parts are fetched in parallel and each one fails alone ({ok:false} shows that card's error state).
// Every part is parsed with Zod on the server (unknown keys dropped), so a database or Day 6 change that breaks a shape
// shows one card's error, never a broken page. Literals shared with SQL are checked by tests/unit/day5-parity.spec.ts.

export const homeScopes = ["team", "mine"] as const;
export type HomeScope = (typeof homeScopes)[number];
/** Remembered per device (D28): a cookie, so the server renders the remembered scope at once (no flash of Team). */
export const HOME_SCOPE_COOKIE = "topstock.home.scope";
/** The win rate shows from this many closed deals in WIN_RATE_DAYS (D27; home_summary's "rate"). */
export const WIN_RATE_MIN_CLOSED = 5;
export const WIN_RATE_DAYS = 90;
/** Needs attention: closing soon means within this many days (home_attention). */
export const CLOSING_SOON_DAYS = 7;
export const ATTENTION_SHOWN = 5;
export const RECENT_SHOWN = 8;
export const TODAY_SHOWN = 6;
/** Fresh for 30 s; refetched on focus and every 60 s while the tab is visible (D31). */
export const HOME_STALE_MS = 30_000;
export const HOME_REFRESH_MS = 60_000;
/** The count-up plays only when hydration lands this soon after navigation start (D29). */
export const COUNT_UP_HYDRATION_MS = 800;

const money = z.string().regex(MONEY_PATTERN);
const total = z.string().regex(/^\d{1,16}(\.\d{1,2})?$/); // sums may pass one deal's cap
const count = z.number().int().nonnegative();
const stage = z.enum(["lead", "qualified", "negotiations", "won", "lost"]);

export const summaryPart = z.object({
  scope: z.enum(homeScopes),
  zone: z.string().max(64),
  today: z.iso.date(),
  as_of: z.string(),
  open: z.object({
    count,
    value: total,
    no_value: count,
    stalled: count,
    closing: count,
    close_passed: count,
    by_stage: z.array(z.object({ key: z.enum(["lead", "qualified", "negotiations"]), count, value: total })).max(3),
  }),
  won_month: z.object({ count, value: total }),
  win_rate: z.object({ won: count, lost: count, rate: z.number().min(0).max(1).nullable() }),
  lost_30: z.object({ count, reasons: z.array(z.object({ code: z.string().max(20), count })).max(8) }),
  calls_today: z.object({ count, reached: count }),
  tasks: z.object({ overdue: count, today: count, meetings: count }),
  new_leads: z.object({ count, imported: count }),
});
export type HomeSummary = z.infer<typeof summaryPart>;

export const attentionReasons = ["overdue", "stalled", "closing"] as const;
export const attentionItem = z.object({
  id: z.uuid(),
  stage,
  title: z.string().nullable(),
  company_id: z.uuid(),
  company_name: z.string(),
  value: money.nullable(),
  expected_close: z.iso.date().nullable(),
  stage_entered_at: z.string(),
  is_stalled: z.boolean(),
  quiet_days: z.number().int().nullable(),
  owner_first_name: z.string().nullable(),
  reason: z.enum(attentionReasons),
});
export const attentionPart = z.object({ total: count, items: z.array(attentionItem).max(20) });
export type AttentionItem = z.infer<typeof attentionItem>;
export type HomeAttention = z.infer<typeof attentionPart>;

export const recentRow = z.object({
  item_id: z.string().max(80),
  kind: z.enum(["activity", "open", "move", "won", "lost", "reopen"]),
  type: z.enum(["call", "email", "whatsapp", "meeting", "note"]).nullable(),
  outcome: z.string().max(60).nullable(),
  to_stage: stage.nullable(),
  value: money.nullable(),
  company_id: z.uuid().nullable(),
  company_name: z.string().nullable(),
  user_first_name: z.string().nullable(),
  at: z.string(),
});
export const recentPart = z.array(recentRow).max(20);
export type RecentRow = z.infer<typeof recentRow>;

export const todayTask = z.object({
  id: z.uuid(),
  title: z.string(),
  kind: z.enum(["todo", "call", "meeting"]),
  due_date: z.iso.date().nullable(),
  due_at: z.string().nullable(),
  company_id: z.uuid().nullable(),
  company_name: z.string().nullable(),
  overdue: z.boolean(),
  overdue_days: z.number().int().nonnegative().nullable(),
});
export const todayPart = z.object({ total: count, overdue: count, items: z.array(todayTask).max(20) });
export type TodayTask = z.infer<typeof todayTask>;
export type HomeToday = z.infer<typeof todayPart>;

/**
 * The Day 6 contract for the Low stock card (design section 10): exactly {low, out, deals_waiting, items[≤ 5]}. Unknown
 * keys (a purchase cost, say) are dropped by the parse and never reach the browser; a bad shape shows the card's error.
 * null from home_low_stock means inventory is not set up yet (the calm placeholder).
 */
export const lowStockItem = z.object({
  product_id: z.uuid(),
  name: z.string().max(200),
  available: z.number().int(),
  reorder_point: z.number().int().nonnegative(),
  in_transit: z.number().int().nonnegative(),
  next_eta: z.iso.date().nullable(),
  state: z.enum(["low", "out"]),
});
export const lowStockCard = z.object({
  low: count,
  out: count,
  deals_waiting: count.nullable(),
  items: z.array(lowStockItem).max(5),
});
export const lowStockPart = lowStockCard.nullable();
export type LowStockCard = z.infer<typeof lowStockCard>;

/** Day 4c's queue_summary counts the Work queue card shows (loaded after paint, `['queue','summary']`). */
export const queueSummary = z.object({ callable_now: count, later_today: count });
export type QueueSummary = z.infer<typeof queueSummary>;

export type Part<T> = { ok: true; data: T } | { ok: false };
export type HomeData = {
  scope: HomeScope;
  summary: Part<HomeSummary>;
  attention: Part<HomeAttention>;
  recent: Part<RecentRow[]>;
  today: Part<HomeToday>;
  lowStock: Part<LowStockCard | null>;
  /** When the server answered (ms since the epoch), for "Updated 3 min ago". */
  at: number;
};

/** A part from what the database answered: parsed, or {ok:false} when the call failed or the shape is wrong. */
export function toPart<T>(schema: z.ZodType<T>, settled: PromiseSettledResult<{ data: unknown; error: unknown }>): Part<T> {
  if (settled.status !== "fulfilled" || settled.value.error) return { ok: false };
  const parsed = schema.safeParse(settled.value.data);
  return parsed.success ? { ok: true, data: parsed.data } : { ok: false };
}

/** GET /api/home?scope= (unknown parameters refused). */
export const homeParams = z.strictObject({ scope: z.enum(homeScopes).optional() });

/** The scope a person gets: reps always Mine (no switch); managers and admins their remembered choice, Team first. */
export function effectiveScope(role: string, remembered: string | undefined): HomeScope {
  if (role !== "admin" && role !== "manager") return "mine";
  return remembered === "mine" ? "mine" : "team";
}

/** The win rate as a whole percentage, or null under WIN_RATE_MIN_CLOSED closed deals. */
export function winRatePercent(rate: HomeSummary["win_rate"]): number | null {
  if (rate.won + rate.lost < WIN_RATE_MIN_CLOSED || rate.rate === null) return null;
  return Math.round(rate.rate * 100);
}

/** The stage bar's segments: each open stage's share of the open value (by count when nothing has a value yet). */
export function stageShares(byStage: HomeSummary["open"]["by_stage"]): { key: string; share: number }[] {
  const values = byStage.map((s) => Number(s.value));
  const sum = values.reduce((a, b) => a + b, 0);
  const counts = byStage.map((s) => s.count);
  const n = counts.reduce((a, b) => a + b, 0);
  return byStage.map((s, i) => ({ key: s.key, share: sum > 0 ? values[i] / sum : n > 0 ? counts[i] / n : 0 }));
}
