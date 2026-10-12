// Stock sheet import rules shared by the browser, the server actions and the tests (design docs/evidence/day6/design.md,
// sections 7.2 to 7.4). The code lists and bounds must equal the stock import migration
// (supabase/migrations/20261018090000_stock_import.sql); tests/unit/stock-parity.spec.ts compares them. Pure module: no
// DOM, no React, no server-only imports.

// Row problems found in the browser: such a row is sent as {row_no, problems} only (no values).
export const STOCK_PROBLEM_CODES = [
  "name_missing",
  "name_too_long",
  "quantity_missing",
  "quantity_invalid",
  "quantity_negative",
  "quantity_not_whole",
  "quantity_too_big",
  "carton_invalid",
  "price_invalid",
  "price_order",
  "cost_invalid",
  "excel_error",
  "number_mangled",
  "columns_extra",
  "cell_too_long",
] as const;
export type StockProblem = (typeof STOCK_PROBLEM_CODES)[number];

// Warnings found in the browser: the row is still imported.
export const STOCK_FIX_CODES = [
  "resale_min_mismatch",
  "resale_max_mismatch",
  "resale_unreadable",
  "cost_above_price",
  "cost_missing",
  "cost_kept_sold_out",
  "price_missing",
  "loose_pieces",
] as const;
export type StockFix = (typeof STOCK_FIX_CODES)[number];

// Warnings and reasons set only by the database during the check and the commit; the screen needs a label for each.
export const STOCK_DB_WARNINGS = ["prices_differ", "carton_kept", "restored"] as const;
export type StockDbWarning = (typeof STOCK_DB_WARNINGS)[number];
export const STOCK_REASONS = [
  "db_name",
  "db_quantity",
  "db_carton",
  "db_price",
  "db_cost",
  "carton_conflict",
  "carton_required",
  "below_reserved",
  "moved_in_crm",
  "added_meanwhile",
] as const;
export type StockReason = (typeof STOCK_REASONS)[number];
export const STOCK_OUTCOMES = [
  "pending",
  "new",
  "update",
  "moved",
  "unchanged",
  "rejected",
  "repeated",
  "applied",
  "kept",
  "skipped",
] as const;
export type StockOutcome = (typeof STOCK_OUTCOMES)[number];
// Why an undo left a product as it is (stock_import_changes.kept_reason).
export const STOCK_KEPT_REASONS = ["moved", "held", "edited", "later_import"] as const;
export type StockKeptReason = (typeof STOCK_KEPT_REASONS)[number];

export const LOCATION_KINDS = ["warehouse", "transit"] as const;
export type LocationKind = (typeof LOCATION_KINDS)[number];
export const MOVED_POLICIES = ["keep_crm", "use_sheet"] as const;
export type MovedPolicy = (typeof MOVED_POLICIES)[number];

export const STOCK_LIMITS = {
  /** Data rows in one sheet (the header is row 1, so the last data row is at most row 5,001). */
  maxDataRows: 5_000,
  minRowNo: 2,
  maxRowNo: 5_001,
  /** Characters (code points) in a product name, as products.name. */
  maxNameChars: 200,
  /** Pieces at one place. */
  maxQuantity: 50_000_000,
  maxCarton: 1_000_000,
  /** Price per piece, ex VAT. */
  maxPrice: 1_000_000,
  /** PP (the purchase price of the line). */
  maxCost: 10_000_000_000,
  maxDecimals: 4,
  /** Rows per stage_stock_import_rows call and UTF-8 bytes of its JSON (under the 1 MB server action limit). */
  chunkRows: 1_000,
  chunkBytes: 750 * 1024,
  maxCodes: 16,
} as const;

/**
 * Products per commit or undo call: 125, the design 11.6 cap rule (chunks of 250 missed 1.5 s on the runner); halved
 * after a timeout, down to MIN_CHUNK.
 */
export const COMMIT_CHUNK = 125;
export const MIN_CHUNK = 25;

// REVENTE (check only, never sent): a mismatch is more than max(0.50 EUR, 0.5 %) away from round(QUANTITE x PRIX, 2).
export const RESALE_TOLERANCE = { euros: 0.5, ratio: 0.005 } as const;

// STATUS values after aliasKey() folding (accents and case removed, punctuation to spaces). Anything else must be chosen
// on the matching screen.
export const STOCK_STATUS_ALIASES: ReadonlyArray<readonly [string, LocationKind]> = [
  ["in warehouse", "warehouse"],
  ["warehouse", "warehouse"],
  ["en entrepot", "warehouse"],
  ["entrepot", "warehouse"],
  ["en stock", "warehouse"],
  ["stock", "warehouse"],
  ["disponible", "warehouse"],
  ["available", "warehouse"],
  ["arrive", "warehouse"],
  ["france", "warehouse"],
  ["in transit", "transit"],
  ["transit", "transit"],
  ["en transit", "transit"],
  ["en route", "transit"],
  ["en cours", "transit"],
  ["en mer", "transit"],
  ["at sea", "transit"],
  ["on the way", "transit"],
  ["shipped", "transit"],
  ["expedie", "transit"],
];

/** Number styles of a sheet: French "1 234,56" or English "1,234.56". */
export const NUMBER_STYLES = ["fr", "en"] as const;
export type NumberStyle = (typeof NUMBER_STYLES)[number];

// A caller broke a precondition (for example normalising before every status value has a choice). Never user data.
export class StockRulesError extends Error {
  constructor(code: "name_unmapped" | "quantity_unmapped" | "status_unmapped" | "too_many_rows") {
    super(code);
    this.name = "StockRulesError";
  }
}
