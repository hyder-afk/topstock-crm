import { expect, test } from "@playwright/test";
import type { ParsedRecord } from "@/lib/import";
import {
  STOCK_FIX_CODES,
  STOCK_PROBLEM_CODES,
  StockRulesError,
  createStockNormaliser,
  resaleMismatch,
  tallyStock,
  type StockMapping,
} from "@/lib/stock-import";

// Row rules (design 7.4): every problem and warning code.
const MAPPING: StockMapping = [
  "name", "price_max", "price_min", "quantity", "pieces_per_carton", "total_cost", "resale_min_total", "resale_max_total", "status",
];
const run = createStockNormaliser({ mapping: MAPPING, style: "fr", defaultLocation: "warehouse" });
let n = 2;
// name, max, min, qty, ppc, pp, rmin, rmax, status
const row = (...cells: string[]): ParsedRecord => ({ row_no: n++, cells });
const ok = ["Gobelet", "3,00", "2,00", "120", "12", "120,00", "240,00", "360,00", "In Warehouse"];
const withCell = (i: number, v: string) => ok.map((c, j) => (j === i ? v : c));

test("a clean row is staged with canonical text and no warnings", () => {
  const r = run(row(...ok));
  expect(r.rejected).toBe(false);
  expect(r.payload).toEqual({
    row_no: r.row_no, name: "Gobelet", location_kind: "warehouse", quantity: "120", pieces_per_carton: "12",
    price_min: "2", price_max: "3", total_cost: "120", fixes: [],
  });
});

test("every problem code rejects the row and sends no values", () => {
  const cases: Array<[string[], string]> = [
    [withCell(0, ""), "name_missing"],
    [withCell(0, "x".repeat(201)), "name_too_long"],
    [withCell(3, ""), "quantity_missing"],
    [withCell(3, "beaucoup"), "quantity_invalid"],
    [withCell(3, "-5"), "quantity_negative"],
    [withCell(3, "12,5"), "quantity_not_whole"],
    [withCell(3, "50 000 001"), "quantity_too_big"],
    [withCell(4, "0"), "carton_invalid"],
    [withCell(4, "1 000 001"), "carton_invalid"],
    [withCell(4, "2,5"), "carton_invalid"],
    [withCell(1, "-1"), "price_invalid"],
    [withCell(1, "1 000 000,01"), "price_invalid"],
    [withCell(1, "3,00001"), "price_invalid"],
    [withCell(2, "4,00"), "price_order"],
    [withCell(5, "-1"), "cost_invalid"],
    [withCell(5, "10 000 000 000,01"), "cost_invalid"],
    [withCell(3, "#VALEUR!"), "excel_error"],
    [withCell(1, "#N/A"), "excel_error"],
    [withCell(3, "1,2E+02"), "number_mangled"],
    [[...ok, "extra"], "columns_extra"],
    [withCell(0, "y".repeat(2001)), "cell_too_long"],
  ];
  const seen = new Set<string>();
  for (const [cells, code] of cases) {
    const r = run(row(...cells));
    expect(r.rejected, code).toBe(true);
    expect(r.problems, code).toContain(code);
    expect(Object.keys(r.payload).sort(), code).toEqual(["problems", "row_no"]);
    seen.add(code);
  }
  expect([...seen].sort()).toEqual([...STOCK_PROBLEM_CODES].sort());
});

test("every warning code keeps the row", () => {
  const cases: Array<[string[], string]> = [
    [withCell(7, "400,00"), "resale_max_mismatch"],
    [withCell(6, "200,00"), "resale_min_mismatch"],
    [withCell(6, "beaucoup"), "resale_unreadable"],
    [withCell(5, "480,00"), "cost_above_price"],
    [withCell(5, ""), "cost_missing"],
    [["Gobelet", "3,00", "2,00", "0", "12", "50,00", "0,00", "0,00", "In Warehouse"], "cost_kept_sold_out"],
    [["Gobelet", "", "", "120", "12", "120,00", "", "", "In Warehouse"], "price_missing"],
    [["Gobelet", "3,00", "2,00", "130", "12", "120,00", "260,00", "390,00", "In Warehouse"], "loose_pieces"],
  ];
  const seen = new Set<string>();
  for (const [cells, code] of cases) {
    const r = run(row(...cells));
    expect(r.rejected, code).toBe(false);
    expect(r.fixes, code).toContain(code);
    seen.add(code);
  }
  expect([...seen].sort()).toEqual([...STOCK_FIX_CODES].sort());
});

test("REVENTE tolerance edges: 0.50 EUR or 0.5 %, whichever is larger", () => {
  // Small totals: the 0.50 EUR floor.
  expect(resaleMismatch(10049, 10000)).toBe(false);
  expect(resaleMismatch(10050, 10000)).toBe(false);
  expect(resaleMismatch(10051, 10000)).toBe(true);
  expect(resaleMismatch(9949, 10000)).toBe(true);
  // Large totals: 0.5 %.
  expect(resaleMismatch(1_005_000, 1_000_000)).toBe(false);
  expect(resaleMismatch(1_005_001, 1_000_000)).toBe(true);
  // Through the row rule: 12 x 2.00 = 24.00 (the 0.50 EUR floor): 24.50 is fine, 24.51 is not; 120 x 2.00 = 240.00
  // (0.5 % = 1.20 EUR): 241.20 is fine, 241.21 is not.
  const small = (rmin: string) => run(row("Gobelet", "3,00", "2,00", "12", "12", "12,00", rmin, "36,00", "In Warehouse")).fixes;
  expect(small("24,50")).not.toContain("resale_min_mismatch");
  expect(small("24,51")).toContain("resale_min_mismatch");
  expect(run(row(...withCell(6, "241,20"))).fixes).not.toContain("resale_min_mismatch");
  expect(run(row(...withCell(6, "241,21"))).fixes).toContain("resale_min_mismatch");
});

test("PP divided by QUANTITE is compared with the max price", () => {
  // 360.00 / 120 = 3.00: equal to the max, not above.
  expect(run(row(...withCell(5, "360,00"))).fixes).not.toContain("cost_above_price");
  expect(run(row(...withCell(5, "360,12"))).fixes).toContain("cost_above_price");
});

test("swapped PRIX MIN and MAX columns raise the banner", () => {
  const swappedRows = [1, 2, 3].map(() => run(row("Bol", "3,00", "2,00", "120", "12", "120,00", "360,00", "240,00", "In Warehouse")));
  expect(swappedRows.every((r) => r.swapHint)).toBe(true);
  expect(tallyStock(swappedRows).swapped).toBe(true);
  const mixed = [...swappedRows, ...[1, 2, 3, 4].map(() => run(row(...ok)))];
  expect(tallyStock(mixed).swapped).toBe(false);
});

test("STATUS: blank uses the default, unknown needs a choice, choices are used", () => {
  expect(run(row(...withCell(8, ""))).payload).toMatchObject({ location_kind: "warehouse" });
  expect(run(row(...withCell(8, "En mer"))).payload).toMatchObject({ location_kind: "transit" });
  expect(() => run(row(...withCell(8, "Quai 4")))).toThrow(StockRulesError);
  const chosen = createStockNormaliser({
    mapping: MAPPING, style: "fr", defaultLocation: "transit", statusChoices: new Map([["quai 4", "warehouse"]]),
  });
  expect(chosen(row(...withCell(8, "Quai 4"))).payload).toMatchObject({ location_kind: "warehouse" });
  expect(chosen(row(...withCell(8, ""))).payload).toMatchObject({ location_kind: "transit" });
});

test("names are cleaned text: formulas and markup kept as text, bidi controls stripped", () => {
  expect(run(row(...withCell(0, '=HYPERLINK("http://example.invalid")'))).payload).toMatchObject({
    name: '=HYPERLINK("http://example.invalid")',
  });
  expect(run(row(...withCell(0, `Étiquette ${String.fromCodePoint(0x202e)}cadeau`))).payload).toMatchObject({ name: "Étiquette cadeau" });
  expect(() => createStockNormaliser({ mapping: ["quantity"], style: "fr", defaultLocation: "warehouse" })).toThrow(StockRulesError);
});
