import { readFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { createTranslator } from "use-intl/core";
import type { ActivityPart, CallTimesPart, PipelinePart, SalesPart, SpeedPart } from "@/lib/analytics/parts";
import { activityPart, callTimesPart, pipelinePart, salesPart, speedPart } from "@/lib/analytics/parts";
import { batchesPart, type BatchesPart } from "@/lib/analytics/parts";
import { parseFilters, rpcFilterArgs } from "@/lib/leads";
import {
  RATE_BINS,
  UNTOUCHED_STATUSES,
  activityEmpty,
  batchHref,
  batchRows,
  coverageScope,
  formatParisDate,
  overdueHref,
  untouchedHref,
  bestOfRow,
  bucketDate,
  bucketDay,
  busiest,
  callsRows,
  customRangeOk,
  duration,
  filtersToSearch,
  formatClock,
  formatDays,
  formatMoneyCompact,
  formatPercent,
  formatRange,
  formatTileMoney,
  funnelRows,
  heatGrid,
  heatHasRates,
  heatHours,
  heatLevel,
  heatRows,
  hourLabel,
  hourShort,
  lostRows,
  pipelineEmpty,
  productRows,
  ratio,
  revenueRows,
  speedRows,
  stageDays,
  teamOptions,
  teamRows,
  tickInterval,
  toFilters,
  truncate,
  volumeEdges,
  weekdayName,
} from "@/lib/analytics/view";
import { analyticsKey } from "@/lib/analytics/key";

// Analytics P2 (design docs/evidence/analytics/design.md 2, 4.3, 4.6 and 5.1): the pure mappers and formatters the
// charts, their captions and their "Show as table" views share. Run under several TZ values in CI's matrix (bucket dates
// are formatted as UTC calendar dates, so no browser zone may move them).

const nnbsp = /[\u202f\u00a0\u2009]/g; // Intl's narrow, no-break and thin spaces, made plain for readable expectations
const plain = (s: string) => s.replace(nnbsp, " ");
const messages = (l: "en" | "fr") => JSON.parse(readFileSync(path.join(__dirname, "..", "..", "messages", `${l}.json`), "utf8"));

const activity: ActivityPart = activityPart.parse({
  scope: "team",
  owner_id: null,
  bucket: "day",
  buckets: [
    { start: "2026-10-12", partial: false, calls: 10, reached: 4, emails: 1, whatsapp: 0, meetings: 0 },
    { start: "2026-10-13", partial: false, calls: 38, reached: 12, emails: 0, whatsapp: 2, meetings: 1 },
    { start: "2026-10-14", partial: false, calls: 0, reached: 0, emails: 0, whatsapp: 0, meetings: 0 },
  ],
  totals: { calls: 48, reached: 16, emails: 1, whatsapp: 2, meetings: 1, meetings_held: 1 },
  by_person: [
    { user_id: "00000000-0000-4000-8000-000000000002", calls: 30, reached: 10, emails: 1, whatsapp: 0, meetings: 1 },
    { user_id: "00000000-0000-4000-8000-000000000001", calls: 15, reached: 5, emails: 0, whatsapp: 2, meetings: 0 },
    { user_id: null, calls: 3, reached: 1, emails: 0, whatsapp: 0, meetings: 0 },
  ],
});

const pipeline: PipelinePart = pipelinePart.parse({
  opened: { count: 40, value: "120000.00", no_value: 3 },
  won: { count: 6, value: "48300.00" },
  lost: { count: 4, mistake: 1 },
  win_rate: { won: 6, lost: 4, rate: 0.6 },
  cycle: { n: 6, median_days: 12, mean_days: 14.5 },
  funnel: { cohort: 40, lead: 40, qualified: 22, negotiations: 11, won: 5, still_open: 28, lost: 6, mistake: 1 },
  stage_days: [
    { key: "lead", n: 30, median_days: 2.5 },
    { key: "qualified", n: 18, median_days: 6 },
  ],
  lost_reasons: [
    { code: "timing", count: 1 },
    { code: "price", count: 2 },
    { code: "competitor", count: 1 },
    { code: "shipping", count: 0 },
  ],
  by_person: [
    { user_id: "00000000-0000-4000-8000-000000000001", opened: 10, won: 2, won_value: "12000.50", lost: 1, rate: null },
    { user_id: "00000000-0000-4000-8000-000000000099", opened: 1, won: 0, won_value: "0.00", lost: 0, rate: null },
  ],
});

const team = [
  { id: "00000000-0000-4000-8000-000000000001", first_name: "Henri", last_name: "Durand", role: "admin" as const },
  { id: "00000000-0000-4000-8000-000000000002", first_name: "Ada", last_name: "", role: "rep" as const },
  { id: "00000000-0000-4000-8000-000000000003", first_name: "", last_name: "", role: "manager" as const },
];

// ---------------------------------------------------------------------------------------------------------------------
test("filters: the canonical query string and the cache key", () => {
  expect(filtersToSearch({ range: "30d" })).toBe(""); // the default view: the dock's prefetch and a bare URL share it
  expect(analyticsKey("")).toEqual(["analytics", ""]);
  expect(filtersToSearch({ range: "7d", rep: "00000000-0000-4000-8000-000000000001" })).toBe("range=7d&rep=00000000-0000-4000-8000-000000000001");
  expect(filtersToSearch({ range: "custom", from: "2026-09-01", to: "2026-09-30" })).toBe("range=custom&from=2026-09-01&to=2026-09-30");
  expect(filtersToSearch({ range: "90d", idle: 30 })).toBe("range=90d"); // default idle days left out
  expect(filtersToSearch({ range: "90d", idle: 7 })).toBe("range=90d&idle=7");
  // A preset never carries dates; the lenient page parse feeds toFilters.
  expect(toFilters({ range: "mtd", from: "2026-01-01", to: "2026-01-02" })).toEqual({ range: "mtd" });
  expect(toFilters({})).toEqual({ range: "30d" });
  expect(toFilters({ range: "custom", from: "2026-09-01", to: "2026-09-30", idle: 30 })).toEqual({ range: "custom", from: "2026-09-01", to: "2026-09-30" });
});

test("a custom range the person picks: 1 to 366 days, never after Paris today", () => {
  const today = "2026-10-17";
  expect(customRangeOk("2026-10-17", "2026-10-17", today)).toBe(true);
  expect(customRangeOk("2025-10-17", "2026-10-17", today)).toBe(true); // 366 days
  expect(customRangeOk("2025-10-16", "2026-10-17", today)).toBe(false); // 367
  expect(customRangeOk("2026-10-10", "2026-10-18", today)).toBe(false); // tomorrow
  expect(customRangeOk("2026-10-10", "2026-10-01", today)).toBe(false); // reversed
});

test("numbers, money and durations in English and French (Intl)", () => {
  expect(formatPercent(0.314, "en")).toBe("31%");
  expect(plain(formatPercent(0.314, "fr"))).toBe("31 %");
  expect(plain(formatMoneyCompact(1_240_000, "fr"))).toBe("1,2 M €");
  expect(formatMoneyCompact(1_240_000, "en")).toBe("€1.2M");
  expect(plain(formatTileMoney(48_300, "fr"))).toBe("48 300 €");
  expect(formatTileMoney(48_300, "en")).toBe("€48,300");
  expect(plain(formatTileMoney(2_500_000, "fr"))).toBe("2,5 M €"); // compact from one million (design 4.1)
  expect(duration(0)).toEqual({ kind: "minutes", m: 0 });
  expect(duration(59.6)).toEqual({ kind: "hours", h: 1 });
  expect(duration(135)).toEqual({ kind: "hoursMinutes", h: 2, m: 15 });
  expect(duration(62 * 60)).toEqual({ kind: "days", d: 2.6 }); // Friday 19:00 to Monday 09:00
  expect(formatDays(2.54, "fr")).toBe("2,5");
  expect(formatDays(12.4, "en")).toBe("12");
  expect(ratio(1, 0)).toBeNull();
  expect(ratio(1, 4)).toBe(0.25);
  const te = createTranslator({ locale: "en", messages: messages("en"), namespace: "Analytics.duration" });
  const tf = createTranslator({ locale: "fr", messages: messages("fr"), namespace: "Analytics.duration" });
  expect(te("hoursMinutes", { h: 2, m: 15 })).toBe("2 h 15 min");
  expect(tf("hoursMinutes", { h: 2, m: 15 })).toBe("2 h 15 min");
  expect(tf("days", { d: "2,6" })).toBe("2,6 j");
});

test("dates: bucket starts are Paris calendar dates, formatted the same in every browser zone", () => {
  // 25 Oct 2026 (the 25-hour day) and 29 Mar 2026 (23 hours) stay on their own day.
  expect(bucketDate("2026-10-25", "en")).toBe("Oct 25");
  expect(bucketDate("2026-03-29", "fr")).toBe("29 mars");
  expect(bucketDay("2026-10-13", "en")).toBe("Tue, Oct 13");
  expect(bucketDay("2026-10-13", "fr")).toBe("mar. 13 oct.");
  expect(plain(formatRange("2026-09-01", "2026-09-30", "en"))).toBe("Sep 1 – 30, 2026");
  expect(plain(formatRange("2026-09-01", "2026-09-30", "fr"))).toBe("1–30 sept. 2026");
  expect(formatRange("2026-10-17", "2026-10-17", "en")).toBe("Oct 17, 2026");
  expect(weekdayName(1, "en")).toBe("Mon");
  expect(weekdayName(7, "fr", "long")).toBe("dimanche");
  expect(hourLabel(7, "en")).toBe("07:00");
  expect(hourLabel(19, "fr")).toBe("19:00");
  expect(hourShort(7, "fr")).toBe("07");
  // "Updated 14:32" is Paris time: 12:32 UTC in summer time.
  expect(formatClock(Date.parse("2026-10-17T12:32:00Z"), "en")).toBe("14:32");
  expect(formatClock(Date.parse("2026-12-01T12:32:00Z"), "fr")).toBe("13:32");
});

test("calls: rows, the busiest bucket, the caption sentence in both languages", () => {
  const rows = callsRows(activity);
  expect(rows.map((r) => [r.key, r.calls, r.reached, r.notReached])).toEqual([
    ["2026-10-12", 10, 4, 6],
    ["2026-10-13", 38, 12, 26],
    ["2026-10-14", 0, 0, 0],
  ]);
  const top = busiest(rows, (r) => r.calls)!;
  expect(top.key).toBe("2026-10-13");
  expect(busiest(rows, () => 0)).toBeNull();
  expect(activityEmpty(activity)).toBe(false);
  expect(activityEmpty({ ...activity, totals: { calls: 0, reached: 0, emails: 0, whatsapp: 0, meetings: 0, meetings_held: 0 } })).toBe(true);
  const te = createTranslator({ locale: "en", messages: messages("en"), namespace: "Analytics.calls" });
  const tf = createTranslator({ locale: "fr", messages: messages("fr"), namespace: "Analytics.calls" });
  expect(te("caption", { calls: 48, rate: formatPercent(16 / 48, "en"), day: bucketDay(top.start, "en"), count: top.calls })).toBe(
    "48 calls, 33% reached; busiest: Tue, Oct 13 (38).",
  );
  expect(plain(tf("caption", { calls: 1, rate: formatPercent(1, "fr"), day: bucketDay(top.start, "fr"), count: 1 }))).toBe(
    "1 appel, 100 % joints ; pic : mar. 13 oct. (1).",
  );
  expect(te("tooltip", { calls: 1, reached: 0, rate: "0%" })).toBe("1 call · 0 reached (0%)");
});

test("pipeline: funnel shares, days in stage, lost reasons sorted, empty", () => {
  expect(funnelRows(pipeline).map((r) => [r.key, r.count, r.share])).toEqual([
    ["lead", 40, 1],
    ["qualified", 22, 0.55],
    ["negotiations", 11, 0.275],
    ["won", 5, 0.125],
  ]);
  expect(stageDays(pipeline)).toEqual([
    { key: "lead", n: 30, median: 2.5 },
    { key: "qualified", n: 18, median: 6 },
    { key: "negotiations", n: 0, median: null }, // no row from the database: nothing measured yet
  ]);
  // Most first; equal counts keep the reasons' own order (timing before competitor); a zero row is left out.
  expect(lostRows(pipeline).map((r) => [r.key, r.count, r.share])).toEqual([
    ["price", 2, 0.5],
    ["timing", 1, 0.25],
    ["competitor", 1, 0.25],
  ]);
  expect(pipelineEmpty(pipeline)).toBe(false);
  const none = pipelinePart.parse({
    ...pipeline,
    opened: { count: 0, value: "0.00", no_value: 0 },
    won: { count: 0, value: "0.00" },
    lost: { count: 0, mistake: 0 },
  });
  expect(pipelineEmpty(none)).toBe(true);
});

test("speed-to-lead: five buckets in order, shares of every hand-added lead", () => {
  const s: SpeedPart = speedPart.parse({
    leads: 30,
    touched: 24,
    median_minutes: 135,
    within_1h: 9,
    within_24h: 18,
    buckets: [
      { key: "lt1h", count: 9 },
      { key: "lt24h", count: 9 },
      { key: "lt3d", count: 4 },
      { key: "gte3d", count: 2 },
      { key: "none", count: 6 },
    ],
  });
  expect(speedRows(s).map((r) => [r.key, r.count, r.share])).toEqual([
    ["lt1h", 9, 0.3],
    ["lt24h", 9, 0.3],
    ["lt3d", 4, 4 / 30],
    ["gte3d", 2, 2 / 30],
    ["none", 6, 0.2],
  ]);
});

test("sales: revenue rows as numbers, top products keep their names byte for byte", () => {
  const s: SalesPart = salesPart.parse({
    bucket: "week",
    buckets: [
      { start: "2026-09-28", partial: true, revenue: "1200.50", sales: 2 },
      { start: "2026-10-05", partial: false, revenue: "12420.00", sales: 3 },
    ],
    totals: { revenue: "13620.50", sales: 5, from_stock: "13000.00", direct: "620.50" },
    top_products: [
      { name: "<img src=x onerror=alert(1)>", revenue: "8940.00", pieces: 1200 },
      { name: "Denim jacket", revenue: "4680.50", pieces: 30 },
    ],
  });
  expect(revenueRows(s)).toEqual([
    { key: "2026-09-28", start: "2026-09-28", partial: true, revenue: 1200.5, sales: 2 },
    { key: "2026-10-05", start: "2026-10-05", partial: false, revenue: 12420, sales: 3 },
  ]);
  const p = productRows(s);
  expect(p[0].name).toBe("<img src=x onerror=alert(1)>"); // untrusted text, drawn only as React text
  expect(p.map((r) => r.key)).toEqual(["p0", "p1"]); // keys never come from the name
  expect(truncate("Denim jacket stone wash", 12)).toBe("Denim jacke…");
  expect(truncate("Short", 12)).toBe("Short");
  expect(truncate("été 😀 lin", 5)).toBe("été…"); // by characters, never splitting a pair
});

test("heatmap: fixed rate bins, hatched under 5 calls, volume quintiles", () => {
  expect(RATE_BINS).toEqual([0.1, 0.2, 0.3, 0.45]);
  expect(heatLevel(0, 0, "rate", [])).toBe("none");
  expect(heatLevel(4, 4, "rate", [])).toBe("few"); // 100 % of 4 calls is not shown as 100 %
  expect(heatLevel(10, 0, "rate", [])).toBe(1);
  expect(heatLevel(10, 1, "rate", [])).toBe(2); // 10 % starts the second bin
  expect(heatLevel(10, 2, "rate", [])).toBe(3);
  expect(heatLevel(10, 3, "rate", [])).toBe(4);
  expect(heatLevel(20, 9, "rate", [])).toBe(5); // 45 %
  expect(heatLevel(20, 8, "rate", [])).toBe(4); // 40 %
  const edges = volumeEdges([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 0]);
  expect(edges).toEqual([3, 5, 7, 9]);
  expect(heatLevel(2, 0, "volume", edges)).toBe(1); // a count is never misleading: no hatch for volume
  expect(heatLevel(10, 0, "volume", edges)).toBe(5);
  expect(volumeEdges([0, 0])).toEqual([]);
});

const times: CallTimesPart = callTimesPart.parse({
  min_calls: 5,
  cells: [
    { dow: 2, hour: 10, calls: 23, reached: 9 },
    { dow: 2, hour: 11, calls: 4, reached: 4 },
    { dow: 5, hour: 10, calls: 10, reached: 5 },
    { dow: 6, hour: 22, calls: 2, reached: 0 },
  ],
});

test("heatmap: hours 07–20 widened to every hour with calls; both orientations hold the same cells", () => {
  expect(heatHours(times)).toEqual({ hours: Array.from({ length: 16 }, (_, i) => 7 + i), outside: 2 });
  expect(heatHours(callTimesPart.parse({ min_calls: 5, cells: [] }))).toEqual({ hours: Array.from({ length: 14 }, (_, i) => 7 + i), outside: 0 });
  const grid = heatGrid(times, "rate");
  expect(grid.cells.size).toBe(7 * 16);
  expect(grid.cells.get("2-10")).toEqual({ dow: 2, hour: 10, calls: 23, reached: 9, rate: 9 / 23, level: 4 });
  expect(grid.cells.get("2-11")!.level).toBe("few");
  expect(grid.cells.get("1-7")).toEqual({ dow: 1, hour: 7, calls: 0, reached: 0, rate: null, level: "none" });
  const desktop = heatRows(grid, "weekdays");
  const phone = heatRows(grid, "hours");
  expect(desktop.map((r) => r.head)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  expect(desktop[0].cells).toHaveLength(16);
  expect(phone.map((r) => r.head)).toEqual(grid.hours);
  expect(phone[0].cells).toHaveLength(7);
  // The transposition: row "Tuesday", column "10:00" is row "10:00", column "Tuesday".
  expect(phone.find((r) => r.head === 10)!.cells[1]).toEqual(desktop[1].cells[3]);
  // The phone readout's best weekday in a row: by rate, among cells with 5 calls or more (the 4-call 100 % loses).
  expect(bestOfRow(phone.find((r) => r.head === 10)!.cells)!.dow).toBe(5);
  expect(bestOfRow(phone.find((r) => r.head === 11)!.cells)).toBeNull();
  expect(heatHasRates(times)).toBe(true);
  expect(heatHasRates(callTimesPart.parse({ min_calls: 5, cells: [{ dow: 1, hour: 9, calls: 4, reached: 1 }] }))).toBe(false);
});

test("team table: names merged with both parts, sorted by name, former members last, no rank", () => {
  const rows = teamRows(team, activity.by_person, pipeline.by_person, { former: "Former team members", noName: "No name yet" }, "en");
  expect(rows.map((r) => r.name)).toEqual(["Ada", "Henri Durand", "No name yet", "Former team members"]);
  const henri = rows[1];
  expect([henri.calls, henri.reached, henri.connect, henri.opened, henri.won, henri.wonValue, henri.winRate]).toEqual([15, 5, 1 / 3, 10, 2, "12000.50", null]);
  const nobody = rows[2];
  expect([nobody.calls, nobody.connect, nobody.opened]).toEqual([0, null, 0]); // a member with nothing still gets a row
  // The authorless entries and a figure for someone no longer in the team both count under Former team members.
  const former = rows[3];
  expect([former.userId, former.calls, former.opened]).toEqual([null, 3, 1]);
  // Without former figures there is no Former row.
  expect(teamRows(team, [], [], { former: "F", noName: "N" }, "en").map((r) => r.key)).toEqual([team[1].id, team[0].id, team[2].id]);
  expect(teamOptions(team, "No name yet", "fr").map((o) => o.label)).toEqual(["Ada", "Henri Durand", "No name yet"]);
});

test("x ticks: every 7th day on a phone, Recharts' spacing otherwise", () => {
  expect(tickInterval("day", true)).toBe(6);
  expect(tickInterval("week", true)).toBe("preserveStartEnd");
  expect(tickInterval("day", false)).toBe("preserveStartEnd");
});

test("French messages: the 429 line and the heatmap readout read right", () => {
  const tf = createTranslator({ locale: "fr", messages: messages("fr"), namespace: "Analytics" });
  const te = createTranslator({ locale: "en", messages: messages("en"), namespace: "Analytics" });
  expect(te("rateLimited", { seconds: 12 })).toBe("Too many updates, showing the last figures. Try again in 12 s.");
  expect(tf("rateLimited", { seconds: 12 })).toBe("Trop de mises à jour, derniers chiffres affichés. Réessayez dans 12 s.");
  expect(te("heat.readout", { hour: "10:00", calls: 61, reached: 22, rate: "36%" })).toBe("10:00 · 61 calls · 22 reached (36%)");
  expect(tf("heat.cell", { day: "mardi", hour: "10:00", calls: 1, reached: 1, rate: "100 %" })).toBe("mardi 10:00, 1 appel, 1 joint, 100 %");
  expect(te("kpi.connect.sub", { reached: 12, calls: 1 })).toBe("12 of 1 call");
  expect(tf("kpi.won.sub", { count: 0 })).toBe("Aucune affaire gagnée");
});

// ---------------------------------------------------------------------------------------------------------------------
// Right now (P3): whose figures, the tiles' links, list quality rows
// ---------------------------------------------------------------------------------------------------------------------
const SELF = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";

test("coverage scope: a rep is always their own; a manager or admin is the team, themselves or someone else", () => {
  expect(coverageScope("rep", undefined, SELF)).toEqual({ kind: "own", owner: SELF });
  expect(coverageScope("rep", OTHER, SELF)).toEqual({ kind: "own", owner: SELF }); // never another person's
  expect(coverageScope("admin", undefined, SELF)).toEqual({ kind: "team", owner: null });
  expect(coverageScope("manager", SELF, SELF)).toEqual({ kind: "own", owner: SELF });
  expect(coverageScope("admin", OTHER, SELF)).toEqual({ kind: "other", owner: OTHER });
});

test("the Untouched link is the Leads list with exactly the tile's filter (statuses, inactive days, owner)", () => {
  for (const idle of [7, 30, 90]) {
    const team = new URL(untouchedHref(idle, { kind: "team", owner: null }), "http://x");
    expect(team.pathname).toBe("/leads");
    // Read back by the Leads list's own parser: the same arguments count_leads gets (the attack test's parity, G4).
    expect(rpcFilterArgs(parseFilters(team.searchParams))).toMatchObject({
      p_statuses: [...UNTOUCHED_STATUSES],
      p_owners: null,
      p_inactive_days: idle,
      p_search: null,
      p_countries: null,
      p_city: null,
      p_import_batch: null,
      p_unowned: false,
    });
    const own = new URL(untouchedHref(idle, { kind: "other", owner: OTHER }), "http://x");
    expect(rpcFilterArgs(parseFilters(own.searchParams))).toMatchObject({ p_statuses: [...UNTOUCHED_STATUSES], p_owners: [OTHER], p_inactive_days: idle });
  }
});

test("the Overdue link: own tasks, the team's, or none for someone else (Tasks has no per-person view)", () => {
  expect(overdueHref({ kind: "own", owner: SELF })).toBe("/tasks?tab=overdue");
  expect(overdueHref({ kind: "team", owner: null })).toBe("/tasks?tab=overdue&scope=team");
  expect(overdueHref({ kind: "other", owner: OTHER })).toBeNull();
});

test("list quality: shares of the leads in each import now, file names byte for byte, a batch with none left", () => {
  const XSS = "<img src=x onerror=alert(1)> liste été.csv";
  const sample: BatchesPart = batchesPart.parse([
    { id: SELF, filename: XSS, created_at: "2026-08-18T22:30:00+00:00", leads: 5, contacted: 2, reached: 1, with_deal: 2, won: 1 },
    { id: OTHER, filename: "vide.csv", created_at: "2026-10-01T08:00:00+00:00", leads: 0, contacted: 0, reached: 0, with_deal: 0, won: 0 },
  ]);
  const rows = batchRows(sample);
  expect(rows[0]).toMatchObject({ filename: XSS, leads: 5, contacted: { count: 2, share: 0.4 }, reached: { count: 1, share: 0.2 }, deal: { count: 2, share: 0.4 }, won: { count: 1, share: 0.2 } });
  expect(rows[1]).toMatchObject({ leads: 0, contacted: { count: 0, share: null }, won: { count: 0, share: null } });
  // An import's leads in the Leads list; with the person filter, the ones they own.
  expect(rpcFilterArgs(parseFilters(new URL(batchHref(SELF, null), "http://x").searchParams))).toMatchObject({ p_import_batch: SELF, p_owners: null, p_statuses: null, p_inactive_days: null });
  expect(rpcFilterArgs(parseFilters(new URL(batchHref(SELF, OTHER), "http://x").searchParams))).toMatchObject({ p_import_batch: SELF, p_owners: [OTHER] });
  // The import's day on the Paris calendar: 22:30 UTC on 18 Aug is already 19 Aug in Paris.
  expect(formatParisDate("2026-08-18T22:30:00+00:00", "en")).toBe("Aug 19, 2026");
  expect(formatParisDate("2026-08-18T22:30:00+00:00", "fr")).toBe("19 août 2026");
});

test("Right now messages in both languages", () => {
  const tf = createTranslator({ locale: "fr", messages: messages("fr"), namespace: "Analytics" });
  const te = createTranslator({ locale: "en", messages: messages("en"), namespace: "Analytics" });
  expect(te("rightNow.untouched.label", { days: 30 })).toBe("Untouched 30+ days");
  expect(tf("rightNow.untouched.label", { days: 30 })).toBe("Sans contact depuis 30 j ou plus");
  expect(te("listQuality.share", { rate: "40%", count: "2" })).toBe("40% (2)");
  expect(tf("listQuality.share", { rate: "40 %", count: "2" })).toBe("40 % (2)");
  expect(tf("rightNow.caughtUp")).toBe("Tout est à jour");
});
