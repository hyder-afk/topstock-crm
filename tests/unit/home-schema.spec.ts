import { expect, test } from "@playwright/test";
import {
  attentionPart,
  effectiveScope,
  lowStockCard,
  lowStockPart,
  recentPart,
  stageShares,
  summaryPart,
  toPart,
  todayPart,
  winRatePercent,
} from "@/lib/home";

// Home's parts (Day 5 design 8.4 home-schema): every part parses what the database answers, unknown keys are dropped,
// a wrong shape is that card's error ({ok:false}), and the Day 6 low-stock contract (section 10) holds.
const summary = {
  scope: "team",
  zone: "Europe/Paris",
  today: "2026-10-14",
  as_of: "2026-10-14T09:00:00+00:00",
  open: {
    count: 7, value: "4125.50", no_value: 1, stalled: 2, closing: 1, close_passed: 1,
    by_stage: [{ key: "lead", count: 4, value: "1225.00" }, { key: "qualified", count: 2, value: "400.00" }, { key: "negotiations", count: 1, value: "2500.50" }],
  },
  won_month: { count: 2, value: "500.00" },
  win_rate: { won: 3, lost: 2, rate: 0.6 },
  lost_30: { count: 3, reasons: [{ code: "price", count: 1 }] },
  calls_today: { count: 3, reached: 2 },
  tasks: { overdue: 2, today: 2, meetings: 1 },
  new_leads: { count: 3, imported: 2 },
};
const ok = (data: unknown) => ({ status: "fulfilled" as const, value: { data, error: null } });

test("the summary parses, and a broken one is the KPI row's error", () => {
  expect(toPart(summaryPart, ok(summary))).toEqual({ ok: true, data: summary });
  expect(toPart(summaryPart, ok({ ...summary, open: { ...summary.open, value: "NaN" } }))).toEqual({ ok: false });
  expect(toPart(summaryPart, ok({ ...summary, scope: "everyone" }))).toEqual({ ok: false });
  expect(toPart(summaryPart, { status: "fulfilled", value: { data: null, error: { code: "42501" } } })).toEqual({ ok: false });
  expect(toPart(summaryPart, { status: "rejected", reason: new Error("x") })).toEqual({ ok: false });
});

test("unknown keys are dropped from every part", () => {
  const parsed = toPart(summaryPart, ok({ ...summary, secret: "x" }));
  expect(parsed.ok && "secret" in parsed.data).toBe(false);
  const row = { item_id: "a:1", kind: "activity", type: "call", outcome: "interested", to_stage: null, value: null,
    company_id: "6f1c1c1e-7a3b-4c1d-9e2f-0a1b2c3d4e5f", company_name: "Maison Verdane", user_first_name: "Kais",
    at: "2026-10-14T08:50:00+00:00", body: "should never reach the browser" };
  const recent = recentPart.parse([row]);
  expect("body" in recent[0]).toBe(false);
  expect(todayPart.safeParse({ total: 0, overdue: 0, items: [] }).success).toBe(true);
  expect(attentionPart.safeParse({ total: 0, items: [] }).success).toBe(true);
  expect(attentionPart.safeParse({ total: 1, items: [{ id: "x" }] }).success).toBe(false);
});

test("low stock: Day 6's stock_alerts() shape, null (not set up), all zero, and strict on every key", () => {
  // The exact payload Day 6's stock_alerts() builds (6d migration): counts plus up to 5 low products.
  const item = { id: "6f1c1c1e-7a3b-4c1d-9e2f-0a1b2c3d4e5f", name: "Denim jacket", available: 120, reorder_point: 200, arriving: 300 };
  const day6 = { low: 3, sold_out: 1, arriving_late: 2, requests_new: 4, holds_ending_soon: 1, deals_waiting: 2, sample: [item] };
  expect(lowStockPart.parse(day6)).toEqual(day6);
  expect(lowStockPart.parse(null)).toBeNull();
  const zero = { low: 0, sold_out: 0, arriving_late: 0, requests_new: 0, holds_ending_soon: 0, deals_waiting: 0, sample: [] };
  expect(lowStockCard.parse(zero)).toEqual(zero);
  // Strict: an unknown key (a purchase cost, say) fails the whole part instead of being passed on.
  expect(lowStockCard.safeParse({ ...day6, pp_total: "999" }).success).toBe(false);
  expect(lowStockCard.safeParse({ ...day6, sample: [{ ...item, cost_per_piece: 4.1 }] }).success).toBe(false);
  // Every key is required (the 5c draft's {low, out, items} is refused).
  for (const key of Object.keys(day6)) {
    expect(lowStockCard.safeParse(Object.fromEntries(Object.entries(day6).filter(([k]) => k !== key))).success, key).toBe(false);
  }
  for (const key of Object.keys(item)) {
    const partial = Object.fromEntries(Object.entries(item).filter(([k]) => k !== key));
    expect(lowStockCard.safeParse({ ...day6, sample: [partial] }).success, key).toBe(false);
  }
  expect(lowStockCard.safeParse({ low: 0, out: 0, deals_waiting: null, items: [] }).success).toBe(false);
  // At most 5 products; counts and quantities are whole numbers of zero or more; the id is a uuid.
  expect(lowStockCard.safeParse({ ...day6, sample: Array(5).fill(item) }).success).toBe(true);
  expect(lowStockCard.safeParse({ ...day6, sample: Array(6).fill(item) }).success).toBe(false);
  for (const key of ["low", "sold_out", "arriving_late", "requests_new", "holds_ending_soon", "deals_waiting"] as const) {
    expect(lowStockCard.safeParse({ ...day6, [key]: -1 }).success, key).toBe(false);
    expect(lowStockCard.safeParse({ ...day6, [key]: 1.5 }).success, key).toBe(false);
    expect(lowStockCard.safeParse({ ...day6, [key]: null }).success, key).toBe(false);
  }
  for (const key of ["available", "reorder_point", "arriving"] as const) {
    expect(lowStockCard.safeParse({ ...day6, sample: [{ ...item, [key]: -1 }] }).success, key).toBe(false);
    expect(lowStockCard.safeParse({ ...day6, sample: [{ ...item, [key]: 0.5 }] }).success, key).toBe(false);
  }
  expect(lowStockCard.safeParse({ ...day6, sample: [{ ...item, id: "P-0042" }] }).success).toBe(false);
  expect(lowStockCard.safeParse({ ...day6, sample: [{ ...item, name: "" }] }).success).toBe(false);
});

test("scope: reps always Mine; managers and admins their remembered choice, Team first", () => {
  expect(effectiveScope("rep", "team")).toBe("mine");
  expect(effectiveScope("rep", undefined)).toBe("mine");
  expect(effectiveScope("admin", undefined)).toBe("team");
  expect(effectiveScope("admin", "mine")).toBe("mine");
  expect(effectiveScope("manager", "nonsense")).toBe("team");
});

test("win rate shows from 5 closed deals; the bar splits by value, else by count", () => {
  expect(winRatePercent({ won: 3, lost: 2, rate: 0.6 })).toBe(60);
  expect(winRatePercent({ won: 2, lost: 2, rate: null })).toBeNull();
  expect(winRatePercent({ won: 2, lost: 1, rate: 0.66 })).toBeNull();
  const shares = stageShares(summaryPart.parse(summary).open.by_stage);
  expect(shares.map((s) => s.key)).toEqual(["lead", "qualified", "negotiations"]);
  expect(shares.reduce((a, s) => a + s.share, 0)).toBeCloseTo(1);
  expect(stageShares([{ key: "lead", count: 2, value: "0.00" }, { key: "qualified", count: 0, value: "0.00" }, { key: "negotiations", count: 2, value: "0.00" }])
    .map((s) => s.share)).toEqual([0.5, 0, 0.5]);
  expect(stageShares([{ key: "lead", count: 0, value: "0" }]).map((s) => s.share)).toEqual([0]);
});
