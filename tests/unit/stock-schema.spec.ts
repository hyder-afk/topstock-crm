import { expect, test } from "@playwright/test";
import { chunkRows } from "@/lib/import";
import { STOCK_LIMITS, stagedStockRowSchema, stockChunkSchema, type StockRow } from "@/lib/stock-import";

// The stage payload (design 7.4): strict keys, decimals as text, chunk limits.
const good = {
  row_no: 2, name: "Gobelet", location_kind: "warehouse", quantity: "120", pieces_per_carton: "12",
  price_min: "2", price_max: "3.25", total_cost: "120.5", fixes: [],
};

test("strict keys and decimals as canonical text", () => {
  expect(stagedStockRowSchema.safeParse(good).success).toBe(true);
  expect(stagedStockRowSchema.safeParse({ ...good, extra: 1 }).success).toBe(false);
  expect(stagedStockRowSchema.safeParse({ ...good, quantity: 120 }).success).toBe(false);
  expect(stagedStockRowSchema.safeParse({ ...good, quantity: "-1" }).success).toBe(false);
  expect(stagedStockRowSchema.safeParse({ ...good, price_max: "3,25" }).success).toBe(false);
  expect(stagedStockRowSchema.safeParse({ ...good, price_max: "3.25001" }).success).toBe(false);
  expect(stagedStockRowSchema.safeParse({ ...good, total_cost: "1e3" }).success).toBe(false);
  expect(stagedStockRowSchema.safeParse({ ...good, location_kind: "elsewhere" }).success).toBe(false);
  expect(stagedStockRowSchema.safeParse({ ...good, name: " Gobelet" }).success).toBe(false);
  expect(stagedStockRowSchema.safeParse({ ...good, name: `Gob${String.fromCodePoint(0x202e)}elet` }).success).toBe(false);
  expect(stagedStockRowSchema.safeParse({ ...good, row_no: 5002 }).success).toBe(false);
  expect(stagedStockRowSchema.safeParse({ ...good, fixes: ["made_up"] }).success).toBe(false);
});

test("a chunk holds 1 to 1,000 rows with distinct row numbers", () => {
  const rows = (n: number) => Array.from({ length: n }, (_, i) => ({ ...good, row_no: i + 2 }));
  expect(stockChunkSchema.safeParse(rows(1000)).success).toBe(true);
  expect(stockChunkSchema.safeParse(rows(1001)).success).toBe(false);
  expect(stockChunkSchema.safeParse([]).success).toBe(false);
  expect(stockChunkSchema.safeParse([good, good]).success).toBe(false);
  expect(stockChunkSchema.safeParse([{ row_no: 3, problems: ["name_missing"] }, good]).success).toBe(true);
  expect(stockChunkSchema.safeParse([{ row_no: 3, problems: [] }]).success).toBe(false);
});

test("chunks stay under 750 KB with multibyte names", () => {
  const name = "Théière émaillée 漢字 ".repeat(9).trim().slice(0, 190);
  const rows: StockRow[] = Array.from({ length: 5000 }, (_, i) => ({ ...good, row_no: i + 2, name }) as StockRow);
  const chunks = chunkRows(rows, { maxRows: STOCK_LIMITS.chunkRows, maxBytes: STOCK_LIMITS.chunkBytes });
  for (const c of chunks) {
    expect(new TextEncoder().encode(JSON.stringify(c)).length).toBeLessThanOrEqual(STOCK_LIMITS.chunkBytes);
    expect(stockChunkSchema.safeParse(c).success).toBe(true);
  }
  expect(chunks.flat().length).toBe(5000);
});
