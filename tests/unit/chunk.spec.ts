import { expect, test } from "@playwright/test";
import { chunkRows } from "../../src/lib/import/chunk";
import { ImportRulesError, LIMITS } from "../../src/lib/import/rules";
import { importChunkSchema, type ImportRow } from "../../src/lib/import/schema";

const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;

function stagedRow(rowNo: number, name: string, city: string | null = null): ImportRow {
  return {
    row_no: rowNo,
    name,
    owner_id: null,
    lead_status: "cold",
    phone: null,
    email: null,
    city,
    country: null,
    last_activity: null,
    fixes: [],
  };
}

test.describe("chunks", () => {
  test("at most 1,000 rows each, in order, nothing lost", () => {
    const rows = Array.from({ length: 2500 }, (_, i) => ({ row_no: i + 2, problems: ["name_missing" as const] }));
    const chunks = chunkRows(rows);
    expect(chunks.map((c) => c.length)).toEqual([1000, 1000, 500]);
    expect(chunks.flat()).toEqual(rows);
  });

  test("at most 750 KB of UTF-8 JSON with multibyte text", () => {
    // 200 CJK characters (3 bytes each) and 120 emoji (4 bytes each): about 1.1 KB per row.
    const rows = Array.from({ length: 3000 }, (_, i) => stagedRow(i + 2, "東".repeat(200), "😀".repeat(120)));
    const chunks = chunkRows(rows);
    expect(chunks.length).toBeGreaterThan(3);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(LIMITS.chunkRows);
      expect(bytes(chunk)).toBeLessThanOrEqual(LIMITS.chunkBytes);
      expect(importChunkSchema.safeParse(chunk).success).toBe(true);
    }
    // Each chunk but the last is full: adding its next row would cross the byte limit.
    for (let i = 0; i < chunks.length - 1; i++) {
      expect(bytes([...chunks[i], chunks[i + 1][0]])).toBeGreaterThan(LIMITS.chunkBytes);
    }
    expect(chunks.flat().map((r) => r.row_no)).toEqual(rows.map((r) => r.row_no));
  });

  test("exact byte accounting at the limit", () => {
    const rows = Array.from({ length: 10 }, (_, i) => stagedRow(i + 10, "abc")); // same-width row numbers
    const two = bytes(rows.slice(0, 2));
    expect(chunkRows(rows, { maxBytes: two }).map((c) => c.length)).toEqual([2, 2, 2, 2, 2]);
    expect(chunkRows(rows, { maxBytes: two - 1 }).map((c) => c.length)).toEqual(Array(10).fill(1));
    expect(chunkRows(rows, { maxRows: 3 }).map((c) => c.length)).toEqual([3, 3, 3, 1]);
  });

  test("empty input gives no chunks; a row bigger than the limit is a programming error", () => {
    expect(chunkRows([])).toEqual([]);
    expect(() => chunkRows([stagedRow(2, "abc")], { maxBytes: 20 })).toThrow(ImportRulesError);
  });
});
