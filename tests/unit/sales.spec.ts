import { expect, test } from "@playwright/test";
import { stockError } from "@/lib/inventory/errors";
import { parseTab } from "@/lib/inventory/filters";
import { addDays, extendedUntil } from "@/lib/sales/dates";
import { rankByName } from "@/lib/sales/rank";
import { cancelSaleSchema, extendHoldSchema, logRequestSchema, recordSaleSchema, requestStatusSchema, saleListParams } from "@/lib/sales/schemas";

// Day 6d pure rules: the action schemas (shapes only, unknown keys refused), the hold dates, the error contract's new
// branch and the two new Inventory tabs in the URL.

const id = "5a000000-0000-4000-8000-0000000000b1";
const sale = {
  companyId: id,
  fulfilment: "from_stock",
  lines: [{ product_id: id, description: null, quantity: 480, unit_price: "2.5" }],
  dealId: null,
  note: null,
  shipToCountry: null,
  stockRequestId: null,
  allowBelowMin: false,
  requestId: id,
};

test.describe("sale schemas", () => {
  test("a plain sale passes", () => {
    expect(recordSaleSchema.safeParse(sale).success).toBe(true);
  });
  test("unknown keys are refused (no mass assignment)", () => {
    expect(recordSaleSchema.safeParse({ ...sale, created_by: id }).success).toBe(false);
    expect(recordSaleSchema.safeParse({ ...sale, lines: [{ ...sale.lines[0], below_min: false }] }).success).toBe(false);
  });
  test("prices are decimal text with at most 4 decimals; pieces are whole", () => {
    expect(recordSaleSchema.safeParse({ ...sale, lines: [{ ...sale.lines[0], unit_price: "2.12345" }] }).success).toBe(false);
    expect(recordSaleSchema.safeParse({ ...sale, lines: [{ ...sale.lines[0], unit_price: "-1" }] }).success).toBe(false);
    expect(recordSaleSchema.safeParse({ ...sale, lines: [{ ...sale.lines[0], quantity: 1.5 }] }).success).toBe(false);
    expect(recordSaleSchema.safeParse({ ...sale, lines: [{ ...sale.lines[0], quantity: 0 }] }).success).toBe(false);
  });
  test("type, country and line count", () => {
    expect(recordSaleSchema.safeParse({ ...sale, fulfilment: "warehouse" }).success).toBe(false);
    expect(recordSaleSchema.safeParse({ ...sale, shipToCountry: "fr" }).success).toBe(false);
    expect(recordSaleSchema.safeParse({ ...sale, shipToCountry: "FR" }).success).toBe(true);
    expect(recordSaleSchema.safeParse({ ...sale, lines: [] }).success).toBe(false);
  });
  test("bidi controls and control characters are refused in free text", () => {
    expect(recordSaleSchema.safeParse({ ...sale, note: "ok‮evil" }).success).toBe(false);
    expect(recordSaleSchema.safeParse({ ...sale, note: "line one\nline two" }).success).toBe(true);
    expect(cancelSaleSchema.safeParse({ orderId: id, reason: "no\u0007" }).success).toBe(false);
    expect(cancelSaleSchema.safeParse({ orderId: id, reason: "ok" }).success).toBe(false);
  });
  test("requests, statuses, holds and list parameters", () => {
    expect(logRequestSchema.safeParse({ companyId: id, lines: [{ product_id: null, description: "Jute bags", quantity: 200, unit: "piece" }], note: null, requestId: id }).success).toBe(true);
    expect(logRequestSchema.safeParse({ companyId: id, lines: [{ product_id: null, description: null, quantity: 2, unit: "pallet" }], note: null, requestId: id }).success).toBe(false);
    expect(requestStatusSchema.safeParse({ requestId: id, status: "archived", teamNote: null }).success).toBe(false);
    expect(extendHoldSchema.safeParse({ reservationId: id, holdUntil: "2026-10-31" }).success).toBe(true);
    expect(extendHoldSchema.safeParse({ reservationId: id, holdUntil: "31/10/2026" }).success).toBe(false);
    expect(saleListParams.safeParse({ company: id, user: id }).success).toBe(false);
  });
});

test.describe("hold dates", () => {
  test("Extend adds 14 days from the end, or from today when the hold has ended", () => {
    expect(extendedUntil("2026-10-20", "2026-10-12")).toBe("2026-11-03");
    expect(extendedUntil("2026-10-01", "2026-10-12")).toBe("2026-10-26");
  });
  test("never more than 90 days ahead", () => {
    expect(extendedUntil("2027-01-05", "2026-10-12")).toBe(addDays("2026-10-12", 90));
  });
  test("calendar days across the end of October (clock change) and a leap day", () => {
    expect(addDays("2026-10-24", 2)).toBe("2026-10-26");
    expect(addDays("2028-02-28", 1)).toBe("2028-02-29");
  });
});

test.describe("errors and tabs", () => {
  test("below the minimum keeps its hint; other refusals do not leak theirs", () => {
    expect(stockError({ code: "42501", hint: "below_min" })).toEqual({ ok: false, error: "forbidden", hint: "below_min" });
    expect(stockError({ code: "42501", hint: "anything" })).toEqual({ ok: false, error: "forbidden" });
    expect(stockError({ code: "22023", hint: "undo_window" })).toEqual({ ok: false, error: "invalid", hint: "undo_window" });
  });
  test("Sales and Requests are tabs in the URL", () => {
    expect(parseTab("sales")).toBe("sales");
    expect(parseTab("requests")).toBe("requests");
    expect(parseTab("orders")).toBe("stock");
  });
});

test.describe("picker ranking", () => {
  test("names starting with the search come first, then names containing it, else the server's order", () => {
    const rows = [{ name: "Gobelet bambou 1" }, { name: "Tablier coton 1" }, { name: "Coton bio tablier" }];
    expect(rankByName(rows, "tablier coton").map((r) => r.name)).toEqual(["Tablier coton 1", "Gobelet bambou 1", "Coton bio tablier"]);
    expect(rankByName(rows, "TABLIER").map((r) => r.name)).toEqual(["Tablier coton 1", "Coton bio tablier", "Gobelet bambou 1"]);
    expect(rankByName(rows, " ")).toBe(rows);
  });
});
