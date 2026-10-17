import { DEFAULT_IDLE, DEFAULT_RANGE, MIN_HEAT_CALLS, analyticsRanges, daysBetween, MAX_RANGE_DAYS, speedBuckets } from "@/lib/analytics/params";
import type { AnalyticsParams, AnalyticsRange, Bucket } from "@/lib/analytics/params";
import type { ActivityPart, CallTimesPart, PipelinePart, SalesPart, SpeedPart } from "@/lib/analytics/parts";
import type { AnalyticsTeamMember } from "@/lib/analytics/fetch";
import { lostReasons, openStageKeys, type OpenStageKey } from "@/lib/deals";
import { addMoney, formatMoney } from "@/lib/money";

// Analytics P2 (design docs/evidence/analytics/design.md 2, 4.3, 4.6): what the page draws, as pure functions of the API's
// answer, so they are unit-tested and shared by the charts, their captions and their "Show as table" views (the table
// always holds the same numbers as the chart). Formatting uses Intl only: bucket dates arrive as YYYY-MM-DD Paris dates
// and are formatted as UTC calendar dates, so no browser zone can move them by a day. No calendar arithmetic for the
// query happens here: presets travel by name and the server resolves them from the Paris date.

// ---------------------------------------------------------------------------------------------------------------------
// Filters in the URL and the query key
// ---------------------------------------------------------------------------------------------------------------------

export type AnalyticsFilters = { range: AnalyticsRange; from?: string; to?: string; rep?: string; idle?: number };

/** The page's filters from the lenient parse (the default preset when none or a bad one was given). */
export function toFilters(p: AnalyticsParams): AnalyticsFilters {
  const range = p.range ?? DEFAULT_RANGE;
  const out: AnalyticsFilters = { range };
  if (range === "custom" && p.from && p.to) Object.assign(out, { from: p.from, to: p.to });
  if (p.rep) out.rep = p.rep;
  if (p.idle !== undefined && p.idle !== DEFAULT_IDLE) out.idle = p.idle;
  return out;
}

/**
 * The canonical query string for a filter set ("" for the default view): the default preset and the default idle days
 * are left out, so the dock's prefetch of the default view and a page opened without parameters share one cache entry.
 * Keys in a fixed order, so equal filters always give equal keys.
 */
export function filtersToSearch(f: AnalyticsFilters): string {
  const p = new URLSearchParams();
  if (f.range !== DEFAULT_RANGE) p.set("range", f.range);
  if (f.range === "custom" && f.from && f.to) {
    p.set("from", f.from);
    p.set("to", f.to);
  }
  if (f.rep) p.set("rep", f.rep);
  if (f.idle !== undefined && f.idle !== DEFAULT_IDLE) p.set("idle", String(f.idle));
  return p.toString();
}

export { analyticsKey } from "@/lib/analytics/key";

/** The presets in the order the filter row shows them ("custom" opens the date picker). */
export const presetOrder: readonly AnalyticsRange[] = analyticsRanges;

/** A custom range the person picked is usable: 1 to 366 days, ending today at the latest (the server checks again). */
export function customRangeOk(from: string, to: string, today: string): boolean {
  const days = daysBetween(from, to) + 1;
  return days >= 1 && days <= MAX_RANGE_DAYS && daysBetween(to, today) >= 0;
}

// ---------------------------------------------------------------------------------------------------------------------
// Numbers, money, durations, dates
// ---------------------------------------------------------------------------------------------------------------------

/** a / b, or null when there is nothing to divide by. */
export function ratio(a: number, b: number): number | null {
  return b > 0 ? a / b : null;
}

export function formatPercent(x: number, locale: string): string {
  return new Intl.NumberFormat(locale, { style: "percent", maximumFractionDigits: 0 }).format(x);
}

export function formatCount(n: number, locale: string): string {
  return new Intl.NumberFormat(locale).format(n);
}

/** Compact counts for axis ticks ("1,2 k"). */
export function formatCompact(n: number, locale: string): string {
  return new Intl.NumberFormat(locale, { notation: "compact", maximumFractionDigits: 1 }).format(n);
}

/** EUR in compact notation ("1,2 M €"), for y ticks and tiles from one million. */
export function formatMoneyCompact(value: number, locale: string): string {
  return new Intl.NumberFormat(locale, { style: "currency", currency: "EUR", notation: "compact", maximumFractionDigits: 1 }).format(value);
}

/** Money on a tile: whole euros under one million, compact from there (design 4.1). */
export function formatTileMoney(value: number, locale: string): string {
  return Math.abs(value) >= 1_000_000 ? formatMoneyCompact(value, locale) : formatMoney(String(Math.round(value)), locale);
}

/** A median duration in minutes, as the ICU message it reads in: minutes, hours and minutes, or days. */
export type Duration = { kind: "minutes"; m: number } | { kind: "hours"; h: number } | { kind: "hoursMinutes"; h: number; m: number } | { kind: "days"; d: number };
export function duration(minutes: number): Duration {
  const total = Math.max(0, Math.round(minutes));
  if (total < 60) return { kind: "minutes", m: total };
  if (total < 48 * 60) return total % 60 === 0 ? { kind: "hours", h: total / 60 } : { kind: "hoursMinutes", h: Math.floor(total / 60), m: total % 60 };
  return { kind: "days", d: Math.round((total / 1440) * 10) / 10 };
}

/** Days as a short figure: one decimal under 10 ("2,5"), whole days from there. */
export function formatDays(days: number, locale: string): string {
  return new Intl.NumberFormat(locale, { maximumFractionDigits: days < 10 ? 1 : 0 }).format(days);
}

const utcDate = (iso: string) => new Date(`${iso}T00:00:00Z`);

/** "14 Oct" / "14 oct." for a bucket's start (a Paris date, formatted as a UTC calendar date). */
export function bucketDate(iso: string, locale: string): string {
  return new Intl.DateTimeFormat(locale, { day: "numeric", month: "short", timeZone: "UTC" }).format(utcDate(iso));
}

/** "Tue 14 Oct" / "mar. 14 oct." for a day bucket in a tooltip. */
export function bucketDay(iso: string, locale: string): string {
  return new Intl.DateTimeFormat(locale, { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" }).format(utcDate(iso));
}

/** "1 Sep – 30 Sep 2026" for the range line (Intl's own range format, so each language joins it its own way). */
export function formatRange(from: string, to: string, locale: string): string {
  const f = new Intl.DateTimeFormat(locale, { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
  return from === to ? f.format(utcDate(from)) : f.formatRange(utcDate(from), utcDate(to));
}

/** "14:32" in Paris time (the page says "Paris time"), 24-hour in both languages. */
export function formatClock(at: number, locale: string): string {
  return new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: "Europe/Paris" }).format(new Date(at));
}

/** ISO weekday (1 = Monday … 7 = Sunday) by name, short or long, from Intl (5 Jan 2026 is a Monday). */
export function weekdayName(dow: number, locale: string, width: "short" | "long" = "short"): string {
  return new Intl.DateTimeFormat(locale, { weekday: width, timeZone: "UTC" }).format(new Date(Date.UTC(2026, 0, 4 + dow)));
}

/** "10:00" for an hour of the Paris day, 24-hour in both languages. */
export function hourLabel(hour: number, locale: string): string {
  return new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: "UTC" }).format(new Date(Date.UTC(2026, 0, 5, hour)));
}

/** "07" for the heatmap's narrow hour labels. */
export function hourShort(hour: number, locale: string): string {
  return new Intl.NumberFormat(locale, { minimumIntegerDigits: 2, useGrouping: false }).format(hour);
}

/** Cuts a label for a narrow axis ("Denim jacket wash…"); the full text stays in the tooltip and the table. */
export function truncate(text: string, max: number): string {
  const chars = [...text];
  return chars.length <= max ? text : `${chars.slice(0, Math.max(1, max - 1)).join("").trimEnd()}…`;
}

// ---------------------------------------------------------------------------------------------------------------------
// Calls over time and the small multiples
// ---------------------------------------------------------------------------------------------------------------------

export type CallsRow = {
  key: string;
  start: string;
  partial: boolean;
  calls: number;
  reached: number;
  notReached: number;
  emails: number;
  whatsapp: number;
  meetings: number;
};

export function callsRows(a: ActivityPart): CallsRow[] {
  return a.buckets.map((b) => ({
    key: b.start,
    start: b.start,
    partial: b.partial,
    calls: b.calls,
    reached: b.reached,
    notReached: Math.max(0, b.calls - b.reached),
    emails: b.emails,
    whatsapp: b.whatsapp,
    meetings: b.meetings,
  }));
}

/** The row with the largest value (the first of equals), or null when every value is 0. */
export function busiest<T>(rows: readonly T[], value: (r: T) => number): T | null {
  let best: T | null = null;
  for (const r of rows) if (value(r) > 0 && (best === null || value(r) > value(best))) best = r;
  return best;
}

/** Nothing logged in the range: no call, email, WhatsApp message or meeting. */
export function activityEmpty(a: ActivityPart): boolean {
  const t = a.totals;
  return t.calls + t.emails + t.whatsapp + t.meetings === 0;
}

// ---------------------------------------------------------------------------------------------------------------------
// Speed-to-lead, funnel, days in stage, lost reasons
// ---------------------------------------------------------------------------------------------------------------------

export type ShareRow<K extends string = string> = { key: K; count: number; share: number | null };

export function speedRows(s: SpeedPart): ShareRow<(typeof speedBuckets)[number]>[] {
  return speedBuckets.map((key) => {
    const count = s.buckets.find((b) => b.key === key)?.count ?? 0;
    return { key, count, share: ratio(count, s.leads) };
  });
}

export type FunnelKey = OpenStageKey | "won";
/** Cohort reach, in stage order (design 1.2: a bar per stage, % of the cohort at its tip). */
export function funnelRows(p: PipelinePart): ShareRow<FunnelKey>[] {
  const f = p.funnel;
  return ([...openStageKeys, "won"] as const).map((key) => ({ key, count: f[key], share: ratio(f[key], f.cohort) }));
}

export function stageDays(p: PipelinePart): { key: OpenStageKey; n: number; median: number | null }[] {
  return openStageKeys.map((key) => {
    const row = p.stage_days.find((s) => s.key === key);
    return { key, n: row?.n ?? 0, median: row?.median_days ?? null };
  });
}

type LostCode = (typeof lostReasons)[number];
/** Lost reasons, most first (equal counts keep the reason list's order); shares of all deals lost (mistakes apart). */
export function lostRows(p: PipelinePart): ShareRow<LostCode>[] {
  const total = p.lost_reasons.reduce((s, r) => s + r.count, 0);
  return p.lost_reasons
    .filter((r) => r.count > 0)
    .map((r) => ({ key: r.code, count: r.count, share: ratio(r.count, total) }))
    .sort((a, b) => b.count - a.count || lostReasons.indexOf(a.key) - lostReasons.indexOf(b.key));
}

/** Nothing opened or closed in the range. */
export function pipelineEmpty(p: PipelinePart): boolean {
  return p.opened.count + p.won.count + p.lost.count + p.lost.mistake === 0;
}

// ---------------------------------------------------------------------------------------------------------------------
// Sales
// ---------------------------------------------------------------------------------------------------------------------

export type RevenueRow = { key: string; start: string; partial: boolean; revenue: number; sales: number };
export function revenueRows(s: SalesPart): RevenueRow[] {
  return s.buckets.map((b) => ({ key: b.start, start: b.start, partial: b.partial, revenue: Number(b.revenue), sales: b.sales }));
}

export type ProductRow = { key: string; name: string; revenue: number; pieces: number };
/** Top products by revenue; the name is untrusted text (shown only as React text, in ticks, tooltips and the table). */
export function productRows(s: SalesPart): ProductRow[] {
  return s.top_products.map((p, i) => ({ key: `p${i}`, name: p.name, revenue: Number(p.revenue), pieces: p.pieces }));
}

// ---------------------------------------------------------------------------------------------------------------------
// Best time to call (heatmap)
// ---------------------------------------------------------------------------------------------------------------------

export type HeatMetric = "rate" | "volume";
/** "none": no calls; "few": under 5 calls (rate only: a hatched "not enough calls" cell); 1 to 5: the ramp step. */
export type HeatLevel = "none" | "few" | 1 | 2 | 3 | 4 | 5;
export type HeatCell = { dow: number; hour: number; calls: number; reached: number; rate: number | null; level: HeatLevel };

/** Fixed connect-rate bins (Q12): 0–10, 10–20, 20–30, 30–45, 45 % and more. */
export const RATE_BINS = [0.1, 0.2, 0.3, 0.45] as const;
export const DEFAULT_HOURS = { first: 7, last: 20 } as const;

/** Volume bins: the quintile edges of the range's call counts per cell (cells with calls only). */
export function volumeEdges(calls: number[]): number[] {
  const sorted = calls.filter((c) => c > 0).sort((a, b) => a - b);
  if (sorted.length === 0) return [];
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
  return [at(0.2), at(0.4), at(0.6), at(0.8)];
}

function binOf(value: number, edges: readonly number[], inclusive: boolean): 1 | 2 | 3 | 4 | 5 {
  let level = 1;
  for (const e of edges) if (inclusive ? value > e : value >= e) level++;
  return Math.min(5, level) as 1 | 2 | 3 | 4 | 5;
}

export function heatLevel(calls: number, reached: number, metric: HeatMetric, edges: readonly number[]): HeatLevel {
  if (calls === 0) return "none";
  if (metric === "volume") return edges.length === 0 ? 1 : binOf(calls, edges, true);
  if (calls < MIN_HEAT_CALLS) return "few";
  return binOf(reached / calls, RATE_BINS, false);
}

/** The hours the map shows: 07:00 to 20:00 Paris, widened to every hour that has calls (design 1.6). */
export function heatHours(t: CallTimesPart): { hours: number[]; outside: number } {
  let first: number = DEFAULT_HOURS.first;
  let last: number = DEFAULT_HOURS.last;
  let outside = 0;
  for (const c of t.cells) {
    if (c.hour < DEFAULT_HOURS.first || c.hour > DEFAULT_HOURS.last) outside += c.calls;
    first = Math.min(first, c.hour);
    last = Math.max(last, c.hour);
  }
  return { hours: Array.from({ length: last - first + 1 }, (_, i) => first + i), outside };
}

export const WEEKDAYS = [1, 2, 3, 4, 5, 6, 7] as const;

/** Every cell of the shown grid (empty ones included), keyed "dow-hour". */
export function heatGrid(t: CallTimesPart, metric: HeatMetric): { hours: number[]; outside: number; cells: Map<string, HeatCell> } {
  const { hours, outside } = heatHours(t);
  const edges = metric === "volume" ? volumeEdges(t.cells.map((c) => c.calls)) : [];
  const given = new Map(t.cells.map((c) => [`${c.dow}-${c.hour}`, c]));
  const cells = new Map<string, HeatCell>();
  for (const dow of WEEKDAYS) {
    for (const hour of hours) {
      const c = given.get(`${dow}-${hour}`);
      const calls = c?.calls ?? 0;
      const reached = c?.reached ?? 0;
      cells.set(`${dow}-${hour}`, { dow, hour, calls, reached, rate: ratio(reached, calls), level: heatLevel(calls, reached, metric, edges) });
    }
  }
  return { hours, outside, cells };
}

/**
 * The grid's rows in either orientation: desktop has a row per weekday and a column per hour; the phone's is transposed
 * (a row per hour, a column per weekday), so 7 columns fit a 326 px card (design 4.2).
 */
export function heatRows(grid: { hours: number[]; cells: Map<string, HeatCell> }, orientation: "weekdays" | "hours"): { head: number; cells: HeatCell[] }[] {
  const at = (dow: number, hour: number) => grid.cells.get(`${dow}-${hour}`)!;
  return orientation === "weekdays"
    ? WEEKDAYS.map((dow) => ({ head: dow, cells: grid.hours.map((h) => at(dow, h)) }))
    : grid.hours.map((hour) => ({ head: hour, cells: WEEKDAYS.map((d) => at(d, hour)) }));
}

/** An hour row's best weekday by connect rate, among cells with enough calls (the phone readout's "best Tue 45 %"). */
export function bestOfRow(cells: HeatCell[]): HeatCell | null {
  let best: HeatCell | null = null;
  for (const c of cells) if (c.calls >= MIN_HEAT_CALLS && c.rate !== null && (best === null || c.rate > (best.rate ?? -1))) best = c;
  return best;
}

/** The map has something to show: at least one cell with enough calls for a rate. */
export function heatHasRates(t: CallTimesPart): boolean {
  return t.cells.some((c) => c.calls >= MIN_HEAT_CALLS);
}

// ---------------------------------------------------------------------------------------------------------------------
// Team table
// ---------------------------------------------------------------------------------------------------------------------

export type TeamRow = {
  key: string;
  /** null: entries whose author was deleted ("Former team members"). */
  userId: string | null;
  name: string;
  calls: number;
  reached: number;
  connect: number | null;
  emails: number;
  whatsapp: number;
  meetings: number;
  opened: number;
  won: number;
  wonValue: string;
  lost: number;
  winRate: number | null;
};

/**
 * One row per person (design 4.3 "Team"): names from list_team, figures from the activity and pipeline parts' by_person.
 * Members with nothing in the range still get a row (zeros). Sorted by name, no rank (Q8); "Former team members" (a
 * null id) last, and only when it holds something. A figure for someone no longer in list_team counts there too.
 */
export function teamRows(
  team: AnalyticsTeamMember[],
  activity: ActivityPart["by_person"],
  pipeline: PipelinePart["by_person"],
  labels: { former: string; noName: string },
  locale: string,
): TeamRow[] {
  const known = new Set(team.map((m) => m.id));
  const blank = (key: string, userId: string | null, name: string): TeamRow => ({
    key, userId, name, calls: 0, reached: 0, connect: null, emails: 0, whatsapp: 0, meetings: 0, opened: 0, won: 0, wonValue: "0", lost: 0, winRate: null,
  });
  const rows = new Map<string, TeamRow>();
  for (const m of team) rows.set(m.id, blank(m.id, m.id, `${m.first_name} ${m.last_name}`.trim() || labels.noName));
  const row = (id: string | null) => {
    const key = id !== null && known.has(id) ? id : "former";
    if (!rows.has(key)) rows.set(key, blank(key, null, labels.former));
    return rows.get(key)!;
  };
  for (const a of activity ?? []) {
    const r = row(a.user_id);
    r.calls += a.calls;
    r.reached += a.reached;
    r.emails += a.emails;
    r.whatsapp += a.whatsapp;
    r.meetings += a.meetings;
  }
  for (const p of pipeline ?? []) {
    const r = row(p.user_id);
    r.opened += p.opened;
    r.won += p.won;
    r.wonValue = addMoney(r.wonValue, p.won_value);
    r.lost += p.lost;
    r.winRate = r.userId === null ? null : p.rate;
  }
  for (const r of rows.values()) r.connect = ratio(r.reached, r.calls);
  const collator = new Intl.Collator(locale, { sensitivity: "base" });
  const people = [...rows.values()].filter((r) => r.key !== "former").sort((a, b) => collator.compare(a.name, b.name));
  const former = rows.get("former");
  const formerHasFigures = former && former.calls + former.emails + former.whatsapp + former.meetings + former.opened + former.won + former.lost > 0;
  return formerHasFigures ? [...people, former] : people;
}

/** The person picker's options: everyone in list_team, by name. */
export function teamOptions(team: AnalyticsTeamMember[], noName: string, locale: string): { value: string; label: string }[] {
  const collator = new Intl.Collator(locale, { sensitivity: "base" });
  return team
    .map((m) => ({ value: m.id, label: `${m.first_name} ${m.last_name}`.trim() || noName }))
    .sort((a, b) => collator.compare(a.label, b.label));
}

// ---------------------------------------------------------------------------------------------------------------------
// Bucket helpers shared by the column charts
// ---------------------------------------------------------------------------------------------------------------------

/** Which x ticks a column chart labels: every 7th day on a phone; Recharts' own spacing otherwise. */
export function tickInterval(bucket: Bucket, narrow: boolean): number | "preserveStartEnd" {
  return narrow && bucket === "day" ? 6 : "preserveStartEnd";
}
