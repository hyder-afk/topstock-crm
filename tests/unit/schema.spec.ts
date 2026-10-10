import { expect, test } from "@playwright/test";
import { FIX_CODES, PROBLEM_CODES } from "../../src/lib/import/rules";
import {
  importChunkSchema,
  importRowSchema,
  isLocalDateTime,
  rejectedRowSchema,
  stagedRowSchema,
  type StagedRow,
} from "../../src/lib/import/schema";

const staged: StagedRow = {
  row_no: 2,
  name: "Maison Verdane",
  owner_id: "11111111-1111-4111-8111-111111111111",
  lead_status: "warm",
  phone: "+33 6 39 98 00 01",
  email: "contact@example.com",
  city: "Lyon",
  country: "FR",
  last_activity: "2025-03-15T14:32:00",
  fixes: [],
};
const rejected = { row_no: 3, problems: ["name_missing" as const] };
const valid = (value: unknown) => importRowSchema.safeParse(value).success;

test.describe("row schema", () => {
  test("both shapes pass; nullable fields may be null", () => {
    expect(valid(staged)).toBe(true);
    expect(valid(rejected)).toBe(true);
    expect(
      valid({ ...staged, owner_id: null, phone: null, email: null, city: null, country: null, last_activity: null }),
    ).toBe(true);
    expect(valid({ ...staged, fixes: [...FIX_CODES] })).toBe(true);
    expect(valid({ row_no: 50001, problems: [...PROBLEM_CODES] })).toBe(true);
  });

  test("strict keys: no extra key on either shape, no values on a rejected row", () => {
    expect(stagedRowSchema.safeParse({ ...staged, org_id: "x" }).success).toBe(false);
    expect(valid({ ...staged, outcome: "ready" })).toBe(false);
    expect(valid({ ...rejected, name: "Maison Verdane" })).toBe(false);
    expect(valid({ ...staged, problems: ["name_missing"] })).toBe(false);
    expect(rejectedRowSchema.safeParse({ ...rejected, fixes: [] }).success).toBe(false);
    const withoutFixes: Record<string, unknown> = { ...staged };
    delete withoutFixes.fixes;
    expect(valid(withoutFixes)).toBe(false);
    expect(valid(JSON.parse('{"row_no":2,"problems":["name_missing"],"__proto__":{"x":1}}'))).toBe(false);
  });

  test("row numbers 2 to 50,001, whole numbers", () => {
    for (const row_no of [1, 50002, 2.5, "2", -3]) expect(valid({ ...rejected, row_no }), String(row_no)).toBe(false);
  });

  test("codes come from the lists", () => {
    expect(valid({ ...rejected, problems: [] })).toBe(false);
    expect(valid({ ...rejected, problems: ["db_name"] })).toBe(false);
    expect(valid({ ...rejected, problems: Array(17).fill("name_missing") })).toBe(false);
    expect(valid({ ...staged, fixes: ["name_missing"] })).toBe(false);
    expect(valid({ ...staged, fixes: Array(17).fill("email_dropped") })).toBe(false);
    expect(valid({ ...staged, lead_status: "hot" })).toBe(false);
    expect(valid({ ...staged, lead_status: "Cold" })).toBe(false);
    expect(valid({ ...staged, country: "fr" })).toBe(false);
    expect(valid({ ...staged, country: "XX" })).toBe(false);
    expect(valid({ ...staged, owner_id: "not-a-uuid" })).toBe(false);
  });

  test("control, zero-width and bidi characters are refused in every string", () => {
    for (const bad of ["Bazar\u0007", "\u202EBazar", "Ba\u200Bzar", "Bazar\u0000", "Bazar\u0085", "Bazar\uFEFF", "\uD800Bazar"]) {
      expect(valid({ ...staged, name: bad }), JSON.stringify(bad)).toBe(false);
      expect(valid({ ...staged, city: bad }), JSON.stringify(bad)).toBe(false);
    }
    expect(valid({ ...staged, email: "a\u0000@example.com" })).toBe(false);
  });

  test("lengths are counted in characters, as Postgres does", () => {
    expect(valid({ ...staged, name: "😀".repeat(200) })).toBe(true);
    expect(valid({ ...staged, name: "😀".repeat(201) })).toBe(false);
    expect(valid({ ...staged, name: "" })).toBe(false);
    expect(valid({ ...staged, city: "x".repeat(120) })).toBe(true);
    expect(valid({ ...staged, city: "x".repeat(121) })).toBe(false);
    expect(valid({ ...staged, city: "" })).toBe(false);
    expect(valid({ ...staged, phone: "1".repeat(40) })).toBe(true);
    expect(valid({ ...staged, phone: "1".repeat(41) })).toBe(false);
    expect(valid({ ...staged, email: `${"a".repeat(242)}@example.com` })).toBe(true);
    expect(valid({ ...staged, email: `${"a".repeat(243)}@example.com` })).toBe(false);
  });

  test("phone charset, email shape and the canonical local date-time", () => {
    expect(valid({ ...staged, phone: "06 39 98 AB CD" })).toBe(false);
    expect(valid({ ...staged, phone: "" })).toBe(false);
    expect(valid({ ...staged, email: "contact@example" })).toBe(false);
    expect(valid({ ...staged, last_activity: "2025-03-15 14:32:00" })).toBe(false);
    expect(valid({ ...staged, last_activity: "2025-03-15T14:32" })).toBe(false);
    expect(valid({ ...staged, last_activity: "2025-02-30T00:00:00" })).toBe(false);
    expect(valid({ ...staged, last_activity: "2025-03-15T14:32:00Z" })).toBe(false);
    expect(isLocalDateTime("2024-02-29T23:59:59")).toBe(true);
    expect(isLocalDateTime("2023-02-29T00:00:00")).toBe(false);
    expect(isLocalDateTime("2025-03-15T24:00:00")).toBe(false);
  });
});

test.describe("chunk schema", () => {
  const rows = (n: number) => Array.from({ length: n }, (_, i) => ({ row_no: i + 2, problems: ["name_missing" as const] }));

  test("1 to 1,000 rows", () => {
    expect(importChunkSchema.safeParse(rows(1)).success).toBe(true);
    expect(importChunkSchema.safeParse(rows(1000)).success).toBe(true);
    expect(importChunkSchema.safeParse(rows(1001)).success).toBe(false);
    expect(importChunkSchema.safeParse([]).success).toBe(false);
    expect(importChunkSchema.safeParse({ 0: rejected }).success).toBe(false);
  });

  test("a row number appears once per chunk", () => {
    expect(importChunkSchema.safeParse([rejected, staged, { ...staged, row_no: 3 }]).success).toBe(false);
  });

  test("at most 750 KB of JSON", () => {
    const big = Array.from({ length: 1000 }, (_, i) => ({ ...staged, row_no: i + 2, name: "東".repeat(200), city: "京".repeat(120) }));
    expect(importChunkSchema.safeParse(big).success).toBe(false);
    expect(importChunkSchema.safeParse(big.slice(0, 500)).success).toBe(true);
  });
});
