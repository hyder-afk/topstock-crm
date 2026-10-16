// Numbers in a stock sheet (design 7.3): one style per file, French "1 234,56" or English "1,234.56", detected from the
// file and shown on the matching screen with a live example. Values come back as canonical decimal text ("1234.56"),
// the form the database pre-check accepts, so no float ever rounds a price.
import { cleanText } from "../import/text";
import type { NumberStyle } from "./rules";

export type NumberCell =
  | { kind: "empty" }
  | { kind: "number"; text: string; value: number; negative: boolean; decimals: number }
  | { kind: "excel_error" }
  | { kind: "mangled" }
  | { kind: "invalid" };

const EXCEL_ERROR = /^#(?:VALEUR!|VALUE!|N\/A|NA|DIV\/0!|REF!|NOM\?|NAME\?|NUM!|NOMBRE!|NULL!|NUL!|CALC!|SPILL!|PROPAGATION!)$/i;
const SCIENTIFIC = /^[+-]?\d+(?:[.,]\d+)?e[+-]?\d+$/i;
// Spaces a spreadsheet puts between thousands: space, NBSP, narrow NBSP, thin space; and the Swiss apostrophe.
const GROUP_SPACES = /[     '’]/g;

/** Canonical decimal text: no sign, no leading zeros, no trailing decimal zeros ("012.500" -> "12.5"). */
function canonical(intPart: string, fracPart: string): { text: string; decimals: number } {
  const i = intPart.replace(/^0+(?=\d)/, "") || "0";
  const f = fracPart.replace(/0+$/, "");
  return { text: f ? `${i}.${f}` : i, decimals: f.length };
}

/** Reads one cell. Currency signs (EUR) are stripped; Excel errors and scientific notation are reported as such. */
export function parseNumber(raw: string | null | undefined, style: NumberStyle): NumberCell {
  let s = cleanText(raw ?? "").replace(/€|\bEUR\b/gi, "").trim();
  if (s === "") return { kind: "empty" };
  if (EXCEL_ERROR.test(s)) return { kind: "excel_error" };
  let negative = false;
  if (/^[-−]/.test(s)) {
    negative = true;
    s = s.slice(1).trim();
  } else if (s.startsWith("+")) {
    s = s.slice(1).trim();
  }
  if (SCIENTIFIC.test(s)) return { kind: "mangled" };
  s = s.replace(GROUP_SPACES, "");
  let intPart: string;
  let fracPart = "";
  if (style === "fr") {
    const comma = s.split(",");
    if (comma.length > 2) return { kind: "invalid" };
    if (comma.length === 2) {
      // "1.234,56": dots group thousands before a decimal comma.
      if (comma[0].includes(".") && !/^\d{1,3}(?:\.\d{3})+$/.test(comma[0])) return { kind: "invalid" };
      intPart = comma[0].replace(/\./g, "");
      fracPart = comma[1];
    } else if (/^\d{1,3}(?:\.\d{3})+$/.test(s)) {
      intPart = s.replace(/\./g, ""); // "1.234" in a French file is a thousand
    } else {
      const dot = s.split(".");
      if (dot.length > 2) return { kind: "invalid" };
      intPart = dot[0];
      fracPart = dot[1] ?? "";
    }
  } else {
    const dot = s.split(".");
    if (dot.length > 2) return { kind: "invalid" };
    if (dot[0].includes(",") && !/^\d{1,3}(?:,\d{3})+$/.test(dot[0])) return { kind: "invalid" };
    intPart = dot[0].replace(/,/g, "");
    fracPart = dot[1] ?? "";
  }
  if (!/^\d+$/.test(intPart) || !/^\d*$/.test(fracPart)) return { kind: "invalid" };
  if (intPart.length > 15) return { kind: "invalid" };
  const { text, decimals } = canonical(intPart, fracPart);
  return { kind: "number", text, value: Number(text), negative: negative && text !== "0", decimals };
}

export type StyleGuess = { style: NumberStyle; ambiguous: boolean };

/**
 * The number style of a file from its separator and its number cells: a ";" separator or a cell like "12,50" means
 * French; "12.50" means English; only cells like "12,345" (a thousand or twelve?) leave it ambiguous.
 */
export function detectNumberStyle(cells: Iterable<string>, delimiter: string): StyleGuess {
  let fr = 0;
  let en = 0;
  let ambiguous = 0;
  for (const raw of cells) {
    const s = cleanText(raw).replace(/€|\bEUR\b/gi, "").replace(GROUP_SPACES, "").replace(/^[-−+]/, "");
    if (!/^[\d.,]+$/.test(s) || !/\d/.test(s)) continue;
    if (/^\d+,\d{1,2}$/.test(s) || /^\d+,\d{4,}$/.test(s) || /^\d{1,3}(?:\.\d{3})+,\d+$/.test(s)) fr++;
    else if (/^\d+\.\d{1,2}$/.test(s) || /^\d+\.\d{4,}$/.test(s) || /^\d{1,3}(?:,\d{3})+\.\d+$/.test(s)) en++;
    else if (/^\d{1,3}(?:,\d{3})+$/.test(s) || /^\d{1,3}(?:\.\d{3})+$/.test(s)) ambiguous++;
  }
  if (fr > 0 && en === 0) return { style: "fr", ambiguous: false };
  if (en > 0 && fr === 0) return { style: "en", ambiguous: false };
  const style: NumberStyle = fr > en ? "fr" : en > fr ? "en" : delimiter === "," ? "en" : "fr";
  if (fr === 0 && en === 0) return { style, ambiguous: ambiguous > 0 && delimiter !== ";" };
  return { style, ambiguous: true };
}

const TEN_K = BigInt(10000);
const FIFTY = BigInt(50);
const HUNDRED = BigInt(100);

/** round(quantity x price, 2) in cents, without float drift (price has at most 4 decimals). */
export function lineTotalCents(quantity: number, priceText: string): number {
  const [i, f = ""] = priceText.split(".");
  const tenThousandths = BigInt(i) * TEN_K + BigInt((f + "0000").slice(0, 4));
  const total = BigInt(quantity) * tenThousandths; // in 1/10000 EUR
  return Number((total + FIFTY) / HUNDRED); // half up, to cents
}

/** Cents of a decimal text ("12.345" -> 1235, half up). */
export function toCents(text: string): number {
  const [i, f = ""] = text.split(".");
  const tenThousandths = BigInt(i) * TEN_K + BigInt((f + "0000").slice(0, 4));
  return Number((tenThousandths + FIFTY) / HUNDRED);
}
