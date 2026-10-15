import { expect, test } from "@playwright/test";
import { detectNumberStyle, lineTotalCents, parseNumber, toCents } from "@/lib/stock-import";

// Numbers in stock sheets (design 7.3).
const num = (raw: string, style: "fr" | "en") => {
  const c = parseNumber(raw, style);
  return c.kind === "number" ? (c.negative ? `-${c.text}` : c.text) : c.kind;
};

test("French numbers: decimal comma, every thousands space, euro signs", () => {
  expect(num("12,50", "fr")).toBe("12.5");
  expect(num("12,50 €", "fr")).toBe("12.5");
  expect(num("€12,50", "fr")).toBe("12.5");
  expect(num("12,50 EUR", "fr")).toBe("12.5");
  expect(num("1 234,56", "fr")).toBe("1234.56");
  expect(num("1 234,56", "fr")).toBe("1234.56");
  expect(num("1 234,56", "fr")).toBe("1234.56");
  expect(num("1 234,56", "fr")).toBe("1234.56");
  expect(num("1.234,56", "fr")).toBe("1234.56");
  expect(num("1'234,56", "fr")).toBe("1234.56");
  expect(num("1 200,00", "fr")).toBe("1200");
  expect(num("1.234", "fr")).toBe("1234");
  expect(num("12.5", "fr")).toBe("12.5");
  expect(num("1,2,3", "fr")).toBe("invalid");
});

test("English numbers: decimal dot, comma thousands", () => {
  expect(num("€12.50", "en")).toBe("12.5");
  expect(num("1,234.56", "en")).toBe("1234.56");
  expect(num("1'234.56", "en")).toBe("1234.56");
  expect(num("1 234.56", "en")).toBe("1234.56");
  expect(num("12,50", "en")).toBe("invalid");
  expect(num("1,234", "en")).toBe("1234");
});

test("signs, scientific notation, Excel errors, blanks and words", () => {
  expect(num("-3", "fr")).toBe("-3");
  expect(num("−3", "fr")).toBe("-3");
  expect(num("-0", "fr")).toBe("0");
  expect(num("3,6E+03", "fr")).toBe("mangled");
  expect(num("3.6e3", "en")).toBe("mangled");
  for (const e of ["#VALEUR!", "#N/A", "#DIV/0!", "#REF!", "#NOM?", "#value!"]) expect(num(e, "fr")).toBe("excel_error");
  expect(num("", "fr")).toBe("empty");
  expect(num("   ", "fr")).toBe("empty");
  expect(num("€", "fr")).toBe("empty");
  expect(num("beaucoup", "fr")).toBe("invalid");
  expect(num("0012,500", "fr")).toBe("12.5");
});

test("auto-detection per file", () => {
  expect(detectNumberStyle(["12,50", "3"], ",")).toEqual({ style: "fr", ambiguous: false });
  expect(detectNumberStyle(["12.50", "3"], ";")).toEqual({ style: "en", ambiguous: false });
  expect(detectNumberStyle(["3", "40"], ";")).toEqual({ style: "fr", ambiguous: false });
  expect(detectNumberStyle(["3", "40"], ",")).toEqual({ style: "en", ambiguous: false });
  expect(detectNumberStyle(["12,345"], ",").ambiguous).toBe(true);
  expect(detectNumberStyle(["12,345"], ";")).toEqual({ style: "fr", ambiguous: false });
  expect(detectNumberStyle(["1 234,56 €", "abc"], ",")).toEqual({ style: "fr", ambiguous: false });
  expect(detectNumberStyle(["12,50", "12.50"], ",").ambiguous).toBe(true);
});

test("line totals in cents without float drift", () => {
  expect(lineTotalCents(3, "0.1")).toBe(30);
  expect(lineTotalCents(1200, "29.66")).toBe(3559200);
  expect(lineTotalCents(7, "0.0015")).toBe(1); // 0.0105 rounds half up to 0.01
  expect(lineTotalCents(50_000_000, "1000000")).toBe(5e15);
  expect(toCents("12.345")).toBe(1235);
  expect(toCents("0")).toBe(0);
});
