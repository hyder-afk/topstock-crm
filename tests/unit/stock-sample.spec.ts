import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { decodeBytes, parseCsvText } from "@/lib/import";
import { autoMapStock, detectNumberStyle, distinctStatuses, normaliseStockRecords, tallyStock } from "@/lib/stock-import";

// Every row of the fake sheets gives the label in tests/fixtures/stock/expected.json (design 7.10), read the way the
// browser reads it: decode, parse, match with zero clicks, detect the number style, map the statuses, apply the rules.
const dir = join(__dirname, "../fixtures/stock");
const expected = JSON.parse(readFileSync(join(dir, "expected.json"), "utf8"));

async function load(file: string) {
  const decoded = decodeBytes(new Uint8Array(readFileSync(join(dir, file))));
  const parsed = await parseCsvText(decoded.text, { sepHint: decoded.sepHint, schedule: (resume) => resume() });
  const mapping = autoMapStock(parsed.headers);
  const numberCells = parsed.records.flatMap((r) =>
    mapping.targets.flatMap((t, i) => (["quantity", "price_min", "price_max", "total_cost"].includes(t) ? [r.cells[i] ?? ""] : [])),
  );
  const style = detectNumberStyle(numberCells, parsed.delimiter);
  const statusCol = mapping.targets.indexOf("status");
  const statuses = distinctStatuses(parsed.records.map((r) => r.cells[statusCol] ?? ""));
  return { decoded, parsed, mapping, style, statuses };
}

for (const file of ["stock-40-fake.csv", "stock-40-fake-cp1252.csv"]) {
  test(`${file}: zero-click match, French numbers, every row labelled as expected`, async () => {
    const { decoded, parsed, mapping, style, statuses } = await load(file);
    expect(decoded.encoding).toBe(file.includes("cp1252") ? "windows-1252" : "utf-8");
    expect(parsed.delimiter).toBe(expected.delimiter);
    expect(parsed.rowCount).toBe(expected.row_count);
    expect(parsed.lastRowNo).toBe(expected.last_row_no);
    expect(mapping.targets).not.toContain("ignore");
    expect(style).toEqual({ style: "fr", ambiguous: false });
    expect(statuses.values.every((v) => v.suggested !== null)).toBe(true);
    const rows = normaliseStockRecords(parsed.records, { mapping: mapping.targets, style: style.style, defaultLocation: "warehouse" });
    const got: Record<string, unknown> = {};
    for (const r of rows) got[r.row_no] = r.rejected ? { problems: r.problems } : { fixes: r.fixes };
    const want: Record<string, unknown> = {};
    for (const [rowNo, label] of Object.entries(expected.rows) as Array<[string, { problems?: string[]; fixes?: string[] }]>) {
      want[rowNo] = label.problems ? { problems: label.problems } : { fixes: label.fixes };
    }
    expect(got).toEqual(want);
    const tally = tallyStock(rows);
    expect(tally.rejected).toBe(expected.browser.rejected);
    expect(tally.fixes).toEqual(expected.browser.warnings);
    expect(tally.swapped).toBe(false);
    const names = rows.flatMap((r) => (r.rejected ? [] : [r.display.name]));
    expect(names).toContain(expected.names.formula);
    expect(names).toContain(expected.names.html);
    expect(names).toContain(expected.names.bidi_stripped);
  });
}

test("stock-en-headers.csv: English headers and numbers", async () => {
  const { parsed, mapping, style, statuses } = await load("stock-en-headers.csv");
  expect(mapping.targets).not.toContain("ignore");
  expect(style.style).toBe("en");
  expect(statuses.values.every((v) => v.suggested !== null)).toBe(true);
  const rows = normaliseStockRecords(parsed.records, { mapping: mapping.targets, style: style.style, defaultLocation: "warehouse" });
  expect(rows.every((r) => !r.rejected && r.fixes.length === 0)).toBe(true);
});

test("stock-parens-only.csv: min and max only inside parentheses", async () => {
  const { parsed, mapping, style } = await load("stock-parens-only.csv");
  expect(mapping.targets).toEqual([
    "name", "price_max", "price_min", "quantity", "pieces_per_carton", "total_cost", "resale_min_total", "resale_max_total", "status",
  ]);
  const rows = normaliseStockRecords(parsed.records, { mapping: mapping.targets, style: style.style, defaultLocation: "warehouse" });
  expect(rows.every((r) => !r.rejected && r.fixes.length === 0)).toBe(true);
});

test("stock-reimport-fake.csv: every row importable", async () => {
  const { parsed, mapping, style } = await load("stock-reimport-fake.csv");
  const rows = normaliseStockRecords(parsed.records, { mapping: mapping.targets, style: style.style, defaultLocation: "warehouse" });
  expect(rows.length).toBe(Object.keys(expected.reimport.rows).length);
  expect(rows.every((r) => !r.rejected)).toBe(true);
});
