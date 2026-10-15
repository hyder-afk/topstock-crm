import { expect, test } from "@playwright/test";
import { STOCK_HINTS, stockError } from "@/lib/inventory/errors";
import { parseStockFilters, stockFiltersToParams, parseTab, movementParams } from "@/lib/inventory/filters";
import { moneyTotal, pieces, priceRange, pricePerPiece } from "@/lib/inventory/format";
import { correctionInput, newProductInput, productInput, receiveInput, decimals } from "@/lib/inventory/schemas";
import { productRef, stockStatus, weekStart } from "@/lib/inventory/status";
import { availabilityFill, packs, pallets, parsePrice, parseWhole, toPieces } from "@/lib/inventory/units";

// Day 6b pure rules (design 11.4: units, money, inventory status, the error contract, the filters in the URL and the
// action schemas). Instants are plain dates, so different ICU time zone data cannot change them.

test.describe("units", () => {
  test("pieces and cartons", () => {
    expect(toPieces(3, "carton", 48)).toBe(144);
    expect(toPieces(3, "piece", 48)).toBe(3);
    expect(toPieces(1.5, "carton", 48)).toBeNull();
    expect(toPieces(-1, "piece", 48)).toBeNull();
    expect(toPieces(2_000_000, "carton", 48)).toBeNull();
    expect(packs(1210, 24)).toEqual({ cartons: 50, loose: 10 });
    expect(packs(96, 48)).toEqual({ cartons: 2, loose: 0 });
    expect(packs(0, 48)).toEqual({ cartons: 0, loose: 0 });
    expect(pallets(4800, 24, 100)).toBe(2);
    expect(pallets(5040, 24, 100)).toBe(2.1);
    expect(pallets(100, 24, null)).toBeNull();
  });
  test("typed numbers", () => {
    expect(parseWhole("1 200")).toBe(1200);
    expect(parseWhole("1 200")).toBe(1200);
    expect(parseWhole("1.200")).toBe(1200);
    expect(parseWhole("12,5x")).toBeNull();
    expect(parsePrice("2,50")).toBe(2.5);
    expect(parsePrice("€2.50")).toBe(2.5);
    expect(parsePrice("2,5 €")).toBe(2.5);
    expect(parsePrice("0.12345")).toBeNull();
    expect(parsePrice("-3")).toBeNull();
    expect(parsePrice("2000000")).toBeNull();
  });
  test("availability bar against 3 x the reorder point", () => {
    expect(availabilityFill(150, 50)).toBe(1);
    expect(availabilityFill(75, 50)).toBe(0.5);
    expect(availabilityFill(0, 50)).toBe(0);
    expect(availabilityFill(10, null)).toBeNull();
  });
});

test.describe("money and quantities", () => {
  test("EUR per piece with 2 to 4 decimals, totals with 2", () => {
    expect(pricePerPiece("en", 2.5)).toBe("€2.50");
    expect(pricePerPiece("en", 0.125)).toBe("€0.125");
    expect(pricePerPiece("fr-FR", 2.5)).toBe("2,50 €");
    expect(moneyTotal("fr-FR", 1036.8)).toBe("1 036,80 €");
    expect(moneyTotal("en", 1036.8)).toBe("€1,036.80");
    expect(pieces("fr-FR", 4200)).toBe("4 200");
    expect(priceRange("en", 1.5, 2.5)).toBe("€1.50 – €2.50");
    expect(priceRange("en", 2.5, 2.5)).toBe("€2.50");
    expect(priceRange("en", null, 2.5)).toBe("€2.50");
    expect(priceRange("en", null, null)).toBeNull();
  });
});

test.describe("inventory status", () => {
  const base = { archived: false, wh_available: 100, tr_on_hand: 0, reorder_point: null as number | null };
  test("In stock, Low, Arriving, Sold out, Archived (same rule as private.stock_rows)", () => {
    expect(stockStatus(base)).toBe("in_stock");
    expect(stockStatus({ ...base, reorder_point: 100 })).toBe("low");
    expect(stockStatus({ ...base, reorder_point: 99 })).toBe("in_stock");
    expect(stockStatus({ ...base, wh_available: 0, tr_on_hand: 10 })).toBe("arriving");
    expect(stockStatus({ ...base, wh_available: 0 })).toBe("sold_out");
    expect(stockStatus({ ...base, archived: true })).toBe("archived");
  });
  test("references and the week of an arrival date", () => {
    expect(productRef(42)).toBe("P-0042");
    expect(productRef(123456)).toBe("P-123456");
    expect(weekStart("2026-10-15")).toBe("2026-10-12"); // a Thursday: its Monday
    expect(weekStart("2026-10-12")).toBe("2026-10-12");
    expect(weekStart("2026-10-18")).toBe("2026-10-12"); // Sunday belongs to the week before
    expect(weekStart("2027-01-01")).toBe("2026-12-28");
  });
});

test.describe("stock error contract (design 4.8)", () => {
  test("codes, never text", () => {
    expect(stockError({ code: "42501", hint: "step_up" })).toEqual({ ok: false, error: "step_up" });
    expect(stockError({ code: "42501", hint: "forbidden" })).toEqual({ ok: false, error: "forbidden" });
    for (const h of ["insufficient_stock", "over_reservation", "reserved_by_others", "below_reserved", "not_reserved"]) {
      expect(stockError({ code: "22023", hint: h })).toEqual({ ok: false, error: "stock_short" });
    }
    expect(stockError({ code: "22023", hint: "stale" })).toEqual({ ok: false, error: "stale" });
    expect(stockError({ code: "22023", hint: "rate_limited" })).toEqual({ ok: false, error: "rate_limited" });
    for (const h of STOCK_HINTS) expect(stockError({ code: "22023", hint: h })).toEqual({ ok: false, error: "invalid", hint: h });
    expect(stockError({ code: "22023", hint: "something_new" })).toEqual({ ok: false, error: "invalid" });
    expect(stockError({ code: "P0002" })).toEqual({ ok: false, error: "not_found" });
    expect(stockError({ code: "55P03" })).toEqual({ ok: false, error: "busy" });
    expect(stockError({ code: "57014" })).toEqual({ ok: false, error: "timeout" });
    expect(stockError({ code: "23503" })).toEqual({ ok: false, error: "has_history" });
    expect(stockError({ code: "XX000", hint: "Failing row contains (secret)" })).toEqual({ ok: false, error: "unavailable" });
    expect(stockError(null)).toEqual({ ok: false, error: "unavailable" });
  });
});

test.describe("filters in the URL", () => {
  test("bad values are dropped, good ones round-trip", () => {
    expect(parseStockFilters(new URLSearchParams("filter=steal&sort=cost&q=%20bag%20"))).toEqual({ q: "bag", filter: undefined, category: undefined, sort: undefined });
    const f = parseStockFilters({ filter: "low", sort: "available", category: "Bags", q: "jute" });
    expect(stockFiltersToParams(f).toString()).toBe("q=jute&filter=low&category=Bags&sort=available");
    expect(stockFiltersToParams({ filter: "all", sort: "name" }).toString()).toBe("");
    expect(parseTab("movements")).toBe("movements");
    expect(parseTab("orders")).toBe("stock");
  });
  test("movement filters", () => {
    expect(movementParams.safeParse({ kinds: "ship,return" }).success).toBe(true);
    expect(movementParams.safeParse({ kinds: "ship,steal" }).success).toBe(false);
    expect(movementParams.safeParse({ before: "-1" }).success).toBe(false);
    expect(movementParams.safeParse({ from: "2026-13-01" }).success).toBe(false);
    expect(movementParams.strict().safeParse({ extra: "1" }).success).toBe(false);
  });
});

test.describe("action schemas (strict, whitelisted)", () => {
  const product = {
    name: "T-shirt coton",
    category: null,
    piecesPerCarton: 48,
    cartonsPerPallet: null,
    reorderPoint: 100,
    priceMin: 2.1,
    priceMax: 2.5,
    transitEta: null,
    shareVisible: true,
  };
  const req = "8b1c6f3e-6a8f-4c58-9e0f-3d8c1f2b4a51";
  test("product: extra keys, bad prices, order, control characters", () => {
    expect(productInput.safeParse(product).success).toBe(true);
    expect(productInput.safeParse({ ...product, cost: 1 }).success).toBe(false);
    expect(productInput.safeParse({ ...product, priceMax: 2.12345 }).success).toBe(false);
    expect(productInput.safeParse({ ...product, priceMin: 3 }).success).toBe(false);
    expect(productInput.safeParse({ ...product, name: `Bad${String.fromCodePoint(0x202e)}name` }).success).toBe(false);
    expect(productInput.safeParse({ ...product, piecesPerCarton: 0 }).success).toBe(false);
    expect(newProductInput.safeParse({ product, costPerPiece: 0.85, openingQty: 96, openingPlace: "warehouse", requestId: req }).success).toBe(true);
    expect(newProductInput.safeParse({ product, costPerPiece: 0.85, openingQty: 96, openingPlace: "attic", requestId: req }).success).toBe(false);
    expect(decimals(0.1 + 0.2, 4)).toBe(false);
    expect(decimals(2.5, 4)).toBe(true);
  });
  test("corrections: set is a count, add and remove need a piece, Other needs a note", () => {
    const c = { productId: req, mode: "set", place: "warehouse", pieces: 0, reason: "count", note: null, requestId: req };
    expect(correctionInput.safeParse(c).success).toBe(true);
    expect(correctionInput.safeParse({ ...c, reason: "damaged" }).success).toBe(false);
    expect(correctionInput.safeParse({ ...c, mode: "add" }).success).toBe(false);
    expect(correctionInput.safeParse({ ...c, mode: "remove", pieces: 3, reason: "other" }).success).toBe(false);
    expect(correctionInput.safeParse({ ...c, mode: "remove", pieces: 3, reason: "other", note: "Broken box" }).success).toBe(true);
    expect(correctionInput.safeParse({ ...c, mode: "remove", pieces: 3, reason: "damaged", qty: 3 }).success).toBe(false);
    expect(receiveInput.safeParse({ productId: req, place: "transit", pieces: 10, reason: "received", note: null, requestId: req }).success).toBe(true);
    expect(receiveInput.safeParse({ productId: req, place: "transit", pieces: 10, reason: "count", note: null, requestId: req }).success).toBe(false);
  });
});
