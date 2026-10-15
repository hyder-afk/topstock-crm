import { expect, test } from "@playwright/test";
import { createTranslator } from "use-intl/core";
import enMessages from "../../messages/en.json";
import frMessages from "../../messages/fr.json";
import { stockError } from "@/lib/inventory/errors";
import { parseTab } from "@/lib/inventory/filters";
import { addDays, extendedUntil } from "@/lib/sales/dates";
import { dealOptionLabel, dealsForHold, dealsForSale } from "@/lib/sales/deal-option";
import { rankByName } from "@/lib/sales/rank";
import type { LeadDealOption } from "@/lib/sales/types";
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
    expect(recordSaleSchema.safeParse({ ...sale, note: `ok${String.fromCodePoint(0x202e)}evil` }).success).toBe(false);
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

// The deal picker on Day 5's deal schema (merge of Day 5, 15 Oct 2026): the label reads like Day 5's deal chips, a
// deal with no value yet never shows "€0.00", the stage is translated, and undecided deals (fulfilment null) are offered.
test.describe("deal picker", () => {
  const deal = (over: Partial<LeadDealOption>): LeadDealOption => ({
    id: "d1", title: null, value: null, currency: "EUR", expected_close: null, stage: "negotiations", fulfilment: null, held: 0, ...over,
  });
  const words = (locale: "en" | "fr") => {
    const messages = (locale === "en" ? enMessages : frMessages) as Record<string, unknown>;
    const t = createTranslator({ locale, messages }) as unknown as (key: string) => string;
    return {
      untitled: t("Deals.untitled"),
      stage: (key: NonNullable<LeadDealOption["stage"]>) => t(`Stages.${key}`),
      money: (value: number, currency: string) => new Intl.NumberFormat(locale, { style: "currency", currency }).format(value),
    };
  };
  test("a deal with no value shows no amount (never €0.00)", () => {
    const label = dealOptionLabel(deal({}), words("en"));
    expect(label).toBe("Deal · Negotiations");
    expect(label).not.toMatch(/0[.,]00/);
    expect(dealOptionLabel(deal({ value: 0 }), words("en"))).toBe("Deal · Negotiations · €0.00");
  });
  test("title, translated stage and value", () => {
    expect(dealOptionLabel(deal({ title: "Denim, 2 pallets", value: 4200, stage: "qualified" }), words("en"))).toBe("Denim, 2 pallets · Qualified · €4,200.00");
  });
  test("French: the stage in French, French number format, no English stage name", () => {
    const label = dealOptionLabel(deal({ title: null, value: 4200, stage: "negotiations" }), words("fr"));
    expect(label).toBe(`Affaire · Négociation · ${new Intl.NumberFormat("fr", { style: "currency", currency: "EUR" }).format(4200)}`);
    expect(label).toMatch(/^Affaire · Négociation · 4\s?200,00\s?€$/u);
    expect(label).not.toContain("Negotiations");
    expect(dealOptionLabel(deal({ stage: "lead" }), words("fr"))).toBe("Affaire · Prospect");
  });
  test("undecided deals are offered; a deal set to the other kind is not", () => {
    const deals = [deal({ id: "open" }), deal({ id: "stock", fulfilment: "from_stock" }), deal({ id: "supplier", fulfilment: "direct_from_source" })];
    expect(dealsForHold(deals).map((d) => d.id)).toEqual(["open", "stock"]);
    expect(dealsForSale(deals, "from_stock", null).map((d) => d.id)).toEqual(["open", "stock"]);
    expect(dealsForSale(deals, "direct_from_source", null).map((d) => d.id)).toEqual(["open", "supplier"]);
    expect(dealsForSale(deals, "direct_from_source", "stock").map((d) => d.id)).toEqual(["open", "stock", "supplier"]);
  });
});
