import { expect, test } from "@playwright/test";
import { assignStockTarget, autoMapStock } from "@/lib/stock-import";

// Column matching for stock sheets (design 7.2).
const HAIDER = [
  "CATÉGORIE",
  "PRIX PAR PCS MAX (SELLING PRICE IN EURO MAX)",
  "PRIX PAR PCS (SELLING PRICE IN EURO MIN)",
  "QUANTITÉ",
  "QTY PAR CARTON",
  "PP",
  "REVENTE MIN",
  "REVENTE MAX",
  "STATUS",
];
const EXPECTED = [
  "name",
  "price_max",
  "price_min",
  "quantity",
  "pieces_per_carton",
  "total_cost",
  "resale_min_total",
  "resale_max_total",
  "status",
];

test("stock_headers_haider_exact: zero clicks, with or without accents and parentheses", () => {
  expect(autoMapStock(HAIDER).targets).toEqual(EXPECTED);
  const plain = HAIDER.map((h) => h.normalize("NFD").replace(/\p{M}/gu, ""));
  expect(autoMapStock(plain).targets).toEqual(EXPECTED);
  const noParens = HAIDER.map((h) => h.replace(/\s*\([^)]*\)/g, ""));
  expect(autoMapStock(noParens).targets).toEqual(EXPECTED);
  expect(autoMapStock(HAIDER.map((h) => h.toLowerCase())).targets).toEqual(EXPECTED);
  expect(autoMapStock(HAIDER).matched.every(Boolean)).toBe(true);
});

test("stock_headers_parenthesis_only: min and max read inside the parentheses", () => {
  const headers = ["Produit", "Prix (max)", "Prix (min)", "Quantité", "Colisage", "PP", "Revente (min)", "Revente (max)", "Statut"];
  expect(autoMapStock(headers).targets).toEqual([
    "name", "price_max", "price_min", "quantity", "pieces_per_carton", "total_cost", "resale_min_total", "resale_max_total", "status",
  ]);
  // A max outside the parentheses wins over a min inside them; a plain price is the min price.
  expect(autoMapStock(["Prix max (min 2 cartons)"]).targets).toEqual(["price_max"]);
  expect(autoMapStock(["Prix par pcs (EUR)"]).targets).toEqual(["price_min"]);
});

test("English headers and shuffled order", () => {
  const en = ["Status", "Quantity", "Product name", "Selling price min", "Units per carton", "Selling price max", "Total cost", "Resale max", "Resale min"];
  expect(autoMapStock(en).targets).toEqual([
    "status", "quantity", "name", "price_min", "pieces_per_carton", "price_max", "total_cost", "resale_max_total", "resale_min_total",
  ]);
});

test("qty par carton is never the quantity; prix par pcs max is never the min", () => {
  expect(autoMapStock(["QTY PAR CARTON", "Article"]).targets).toEqual(["pieces_per_carton", "name"]);
  expect(autoMapStock(["Nombre par carton"]).targets).toEqual(["pieces_per_carton"]);
  expect(autoMapStock(["PRIX PAR PCS MAX", "PRIX PAR PCS"]).targets).toEqual(["price_max", "price_min"]);
  expect(autoMapStock(["PRIX PAR PCS", "PRIX PAR PCS MAX"]).targets).toEqual(["price_min", "price_max"]);
});

test("pp is exact only; purchase price is the cost, never a selling price", () => {
  expect(autoMapStock(["PP total", "Prix d'achat"]).targets).toEqual(["ignore", "total_cost"]);
  expect(autoMapStock(["Purchase price"]).targets).toEqual(["total_cost"]);
  expect(autoMapStock(["Coût prix"]).targets).toEqual(["ignore"]);
});

test("Row and Problem columns of a problems file are ignored; one column per field", () => {
  const m = autoMapStock(["Row", "Problem", ...HAIDER]);
  expect(m.targets).toEqual(["ignore", "ignore", ...EXPECTED]);
  expect(m.matched.slice(0, 2)).toEqual([true, true]);
  expect(autoMapStock(["Quantité", "Qté"]).targets).toEqual(["quantity", "ignore"]);
});

test("assigning a field already used swaps the two columns", () => {
  const m = autoMapStock(HAIDER).targets;
  const next = assignStockTarget(m, 1, "price_min");
  expect(next[1]).toBe("price_min");
  expect(next[2]).toBe("price_max");
  expect(assignStockTarget(m, 0, "ignore")[0]).toBe("ignore");
});
