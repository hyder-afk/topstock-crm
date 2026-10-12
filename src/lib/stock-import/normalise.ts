// Row rules for a stock sheet (design 7.4): every row becomes either a staged row (cleaned values as canonical text, plus
// warnings) or a rejected row (problem codes only, no values). The database checks every value again.
import type { ParsedRecord } from "../import/parse";
import { cleanCell, cleanText, codePointLength, stripFormulaGuard } from "../import/text";
import { LIMITS as LEAD_LIMITS } from "../import/rules";
import type { StockField, StockMapping } from "./headers";
import { lineTotalCents, parseNumber, toCents, type NumberCell } from "./numbers";
import {
  RESALE_TOLERANCE,
  STOCK_FIX_CODES,
  STOCK_LIMITS,
  STOCK_PROBLEM_CODES,
  StockRulesError,
  type LocationKind,
  type NumberStyle,
  type StockFix,
  type StockProblem,
} from "./rules";
import type { StagedStockRow, RejectedStockRow } from "./schema";
import { stockStatusKey, suggestLocation } from "./values";

export type StockNormaliseOptions = {
  mapping: StockMapping;
  style: NumberStyle;
  /** Choices made on the matching screen for STATUS spellings, by stockStatusKey. */
  statusChoices?: ReadonlyMap<string, LocationKind>;
  /** Where a row with a blank STATUS (or no STATUS column) goes. */
  defaultLocation: LocationKind;
};

export type StockDisplay = {
  name: string;
  location: LocationKind;
  quantity: string | null;
  pieces_per_carton: string | null;
  price_min: string | null;
  price_max: string | null;
  total_cost: string | null;
  /** The CRM's own totals (round(QUANTITE x PRIX, 2)), shown next to a REVENTE mismatch. */
  resale_min_expected: string | null;
  resale_max_expected: string | null;
};

export type StockNormalised = {
  row_no: number;
  rejected: boolean;
  payload: StagedStockRow | RejectedStockRow;
  problems: StockProblem[];
  fixes: StockFix[];
  display: StockDisplay;
  /** REVENTE MAX fits QUANTITE x PRIX MIN while missing PRIX MAX (or the reverse): the columns may be swapped. */
  swapHint: boolean;
  /** The row has REVENTE values compared against prices. */
  resaleCompared: boolean;
};

const cents = (n: number) => `${Math.floor(n / 100)}.${String(n % 100).padStart(2, "0")}`;

/** True when |sheet - expected| is above max(0.50 EUR, 0.5 % of expected) (both in cents). */
export function resaleMismatch(sheetCents: number, expectedCents: number): boolean {
  const tolerance = Math.max(RESALE_TOLERANCE.euros * 100, Math.abs(expectedCents) * RESALE_TOLERANCE.ratio);
  return Math.abs(sheetCents - expectedCents) > tolerance + 1e-9;
}

type Bad = { problem: StockProblem };
const isBad = (x: unknown): x is Bad => typeof x === "object" && x !== null && "problem" in x;

function numberProblem(cell: NumberCell, fallback: StockProblem): StockProblem | null {
  if (cell.kind === "excel_error") return "excel_error";
  if (cell.kind === "mangled") return "number_mangled";
  if (cell.kind === "invalid") return fallback;
  return null;
}

export function createStockNormaliser(options: StockNormaliseOptions): (record: ParsedRecord) => StockNormalised {
  const { mapping, style, defaultLocation } = options;
  if (!mapping.includes("name")) throw new StockRulesError("name_unmapped");
  if (!mapping.includes("quantity")) throw new StockRulesError("quantity_unmapped");
  const col = (f: StockField) => mapping.indexOf(f);
  const cols = {
    name: col("name"),
    quantity: col("quantity"),
    ppc: col("pieces_per_carton"),
    max: col("price_max"),
    min: col("price_min"),
    cost: col("total_cost"),
    rmin: col("resale_min_total"),
    rmax: col("resale_max_total"),
    status: col("status"),
  };
  const imported = mapping.flatMap((t, i) => (t === "ignore" ? [] : [i]));
  const headerCount = mapping.length;
  const statusCache = new Map<string, LocationKind>();
  const location = (raw: string): LocationKind => {
    const key = stockStatusKey(raw);
    if (!key) return defaultLocation;
    const cached = statusCache.get(key);
    if (cached) return cached;
    const chosen = options.statusChoices?.get(key) ?? suggestLocation(raw);
    if (!chosen) throw new StockRulesError("status_unmapped");
    statusCache.set(key, chosen);
    return chosen;
  };

  return (record) => {
    const cells = record.cells;
    const cell = (i: number) => (i >= 0 ? (cells[i] ?? "") : "");
    const problems = new Set<StockProblem>();
    const fixes = new Set<StockFix>();
    for (let i = headerCount; i < cells.length; i++) {
      if (cleanText(cells[i]) !== "") {
        problems.add("columns_extra");
        break;
      }
    }
    for (const i of imported) {
      const raw = stripFormulaGuard(cells[i] ?? "");
      if (raw.length > LEAD_LIMITS.maxCellChars && codePointLength(raw) > LEAD_LIMITS.maxCellChars) problems.add("cell_too_long");
    }

    const name = cleanCell(cell(cols.name));
    if (!name) problems.add("name_missing");
    else if (codePointLength(name) > STOCK_LIMITS.maxNameChars) problems.add("name_too_long");

    // QUANTITE: required, whole, 0 to 50,000,000.
    const qCell = parseNumber(cell(cols.quantity), style);
    let quantity: number | null = null;
    if (qCell.kind === "empty") problems.add("quantity_missing");
    else if (qCell.kind !== "number") problems.add(numberProblem(qCell, "quantity_invalid") ?? "quantity_invalid");
    else if (qCell.negative) problems.add("quantity_negative");
    else if (qCell.decimals > 0) problems.add("quantity_not_whole");
    else if (qCell.value > STOCK_LIMITS.maxQuantity) problems.add("quantity_too_big");
    else quantity = qCell.value;

    // QTY PAR CARTON: optional (required for a new product: the database says carton_required), whole, 1 to 1,000,000.
    const cCell = parseNumber(cell(cols.ppc), style);
    let ppc: number | null = null;
    if (cCell.kind === "number") {
      if (cCell.negative || cCell.decimals > 0 || cCell.value < 1 || cCell.value > STOCK_LIMITS.maxCarton) problems.add("carton_invalid");
      else ppc = cCell.value;
    } else if (cCell.kind !== "empty") problems.add(numberProblem(cCell, "carton_invalid") ?? "carton_invalid");

    // Prices per piece (ex VAT) and PP.
    const price = (i: number): string | null | Bad => {
      const c = parseNumber(cell(i), style);
      if (c.kind === "empty") return null;
      if (c.kind !== "number") return { problem: numberProblem(c, "price_invalid") ?? "price_invalid" };
      if (c.negative || c.value > STOCK_LIMITS.maxPrice || c.decimals > STOCK_LIMITS.maxDecimals) return { problem: "price_invalid" };
      return c.text;
    };
    const pMin = price(cols.min);
    const pMax = price(cols.max);
    for (const p of [pMin, pMax]) if (isBad(p)) problems.add(p.problem);
    const min = isBad(pMin) ? null : pMin;
    const max = isBad(pMax) ? null : pMax;
    if (min !== null && max !== null && Number(min) > Number(max)) problems.add("price_order");

    const costCell = parseNumber(cell(cols.cost), style);
    let cost: string | null = null;
    if (costCell.kind === "number") {
      if (costCell.negative || costCell.value > STOCK_LIMITS.maxCost || costCell.decimals > STOCK_LIMITS.maxDecimals) problems.add("cost_invalid");
      else cost = costCell.text;
    } else if (costCell.kind !== "empty") problems.add(numberProblem(costCell, "cost_invalid") ?? "cost_invalid");

    const loc = location(cell(cols.status));

    // Warnings (only meaningful on a row that is imported).
    let swapHint = false;
    let resaleCompared = false;
    let expMin: number | null = null;
    let expMax: number | null = null;
    if (quantity !== null) {
      expMin = min !== null ? lineTotalCents(quantity, min) : null;
      expMax = max !== null ? lineTotalCents(quantity, max) : null;
      const resale = (i: number, expected: number | null, code: "resale_min_mismatch" | "resale_max_mismatch") => {
        if (i < 0) return null;
        const c = parseNumber(cell(i), style);
        if (c.kind === "empty") return null;
        if (c.kind !== "number" || c.negative) {
          fixes.add("resale_unreadable");
          return null;
        }
        const sheet = toCents(c.text);
        if (expected !== null) {
          resaleCompared = true;
          if (resaleMismatch(sheet, expected)) fixes.add(code);
        }
        return sheet;
      };
      const rMin = resale(cols.rmin, expMin, "resale_min_mismatch");
      const rMax = resale(cols.rmax, expMax, "resale_max_mismatch");
      if (rMax !== null && expMin !== null && fixes.has("resale_max_mismatch") && !resaleMismatch(rMax, expMin)) swapHint = true;
      if (rMin !== null && expMax !== null && fixes.has("resale_min_mismatch") && !resaleMismatch(rMin, expMax)) swapHint = true;
      if (cost === null && quantity > 0) fixes.add("cost_missing");
      if (cost !== null && quantity === 0) fixes.add("cost_kept_sold_out");
      if (cost !== null && quantity > 0 && max !== null && Number(cost) / quantity > Number(max)) fixes.add("cost_above_price");
      if (ppc !== null && quantity % ppc !== 0) fixes.add("loose_pieces");
    }
    if (min === null && max === null) fixes.add("price_missing");

    const display: StockDisplay = {
      name,
      location: loc,
      quantity: quantity !== null ? String(quantity) : null,
      pieces_per_carton: ppc !== null ? String(ppc) : null,
      price_min: min,
      price_max: max,
      total_cost: cost,
      resale_min_expected: expMin !== null ? cents(expMin) : null,
      resale_max_expected: expMax !== null ? cents(expMax) : null,
    };
    if (problems.size > 0) {
      const sorted = STOCK_PROBLEM_CODES.filter((p) => problems.has(p));
      return {
        row_no: record.row_no,
        rejected: true,
        payload: { row_no: record.row_no, problems: sorted },
        problems: sorted,
        fixes: [],
        display,
        swapHint: false,
        resaleCompared: false,
      };
    }
    const sortedFixes = STOCK_FIX_CODES.filter((f) => fixes.has(f));
    return {
      row_no: record.row_no,
      rejected: false,
      payload: {
        row_no: record.row_no,
        name,
        location_kind: loc,
        quantity: String(quantity),
        pieces_per_carton: ppc !== null ? String(ppc) : null,
        price_min: min,
        price_max: max,
        total_cost: cost,
        fixes: sortedFixes,
      },
      problems: [],
      fixes: sortedFixes,
      display,
      swapHint,
      resaleCompared,
    };
  };
}

export function normaliseStockRecords(records: readonly ParsedRecord[], options: StockNormaliseOptions): StockNormalised[] {
  if (records.length > STOCK_LIMITS.maxDataRows) throw new StockRulesError("too_many_rows");
  const run = createStockNormaliser(options);
  return records.map(run);
}

export type StockTally = {
  rows: number;
  rejected: number;
  problems: Partial<Record<StockProblem, number>>;
  fixes: Partial<Record<StockFix, number>>;
  /** More than half the compared rows look like PRIX MIN and MAX were swapped. */
  swapped: boolean;
};

export function tallyStock(rows: readonly StockNormalised[]): StockTally {
  const t: StockTally = { rows: rows.length, rejected: 0, problems: {}, fixes: {}, swapped: false };
  let compared = 0;
  let swaps = 0;
  for (const r of rows) {
    if (r.rejected) t.rejected++;
    for (const p of r.problems) t.problems[p] = (t.problems[p] ?? 0) + 1;
    for (const f of r.fixes) t.fixes[f] = (t.fixes[f] ?? 0) + 1;
    if (r.resaleCompared) compared++;
    if (r.swapHint) swaps++;
  }
  t.swapped = compared > 0 && swaps * 2 > compared;
  return t;
}
