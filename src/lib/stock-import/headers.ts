// Column matching for a stock sheet (design 7.2): which column feeds which product field. Mappings are arrays indexed by
// column, never objects keyed by header text. Haider's header row maps with zero clicks, with or without accents and
// parentheses.
import { cleanText, fold } from "../import/text";

export const STOCK_FIELDS = [
  "name",
  "quantity",
  "pieces_per_carton",
  "price_max",
  "price_min",
  "total_cost",
  "resale_min_total",
  "resale_max_total",
  "status",
] as const;
export type StockField = (typeof STOCK_FIELDS)[number];
export const STOCK_TARGETS = [...STOCK_FIELDS, "ignore"] as const;
export type StockTarget = (typeof STOCK_TARGETS)[number];
export type StockMapping = readonly StockTarget[];

const words = (s: string) => s.replace(/[^\p{L}\p{N}]+/gu, " ").trim();

/** A header split in two: the folded words outside parentheses, and the folded words inside them. */
export function splitHeader(header: string): { outside: string; inside: string } {
  const folded = fold(cleanText(header));
  const inside = [...folded.matchAll(/\(([^)]*)\)/g)].map((m) => m[1]).join(" ");
  return { outside: words(folded.replace(/\([^)]*\)/g, " ")), inside: words(inside) };
}

// Exact synonyms (after splitHeader, outside the parentheses). Haider's own words first.
const EXACT: ReadonlyArray<readonly [StockField, readonly string[]]> = [
  ["name", ["categorie", "produit", "nom du produit", "designation", "article", "libelle", "product", "product name", "item", "lot"]],
  ["price_max", ["prix par pcs max", "prix max", "prix par piece max", "prix de vente max", "selling price max", "max price"]],
  [
    "price_min",
    ["prix par pcs", "prix par pcs min", "prix min", "prix par piece", "prix de vente min", "selling price min", "min price"],
  ],
  ["quantity", ["quantite", "qte", "qty", "quantity", "pieces", "pcs", "nombre de pieces"]],
  [
    "pieces_per_carton",
    ["qty par carton", "quantite par carton", "pcs par carton", "pieces par carton", "colisage", "pcb", "units per carton"],
  ],
  ["total_cost", ["pp", "prix d achat", "prix d achat total", "cout total", "cout du lot", "purchase price", "total cost"]],
  ["resale_min_total", ["revente min", "total revente min", "resale min"]],
  ["resale_max_total", ["revente max", "total revente max", "resale max"]],
  ["status", ["status", "statut", "etat", "emplacement", "location"]],
];

// "Contains" matches on whole words (the longest wins). Short synonyms (qty, pp, pcs) are exact only.
const CONTAINS: ReadonlyArray<readonly [StockField, readonly string[]]> = [
  ["name", ["designation"]],
  ["pieces_per_carton", ["par carton", "per carton"]],
  ["resale_min_total", ["revente min"]],
  ["resale_max_total", ["revente max"]],
];

// Columns of a problems file that are never imported, so a fixed file re-imports with no clicks.
const IGNORED = new Set(["row", "ligne", "problem", "probleme", "problems", "problemes"]);

const has = (text: string, word: string) => ` ${text} `.includes(` ${word} `);

// A price or REVENTE header without an exact synonym: max outside the parentheses wins, then max inside, then min
// anywhere; a plain "prix par pcs" is the min price. REVENTE needs min or max somewhere.
function sidedTarget(outside: string, inside: string): StockField | null {
  const isResale = has(outside, "revente") || has(outside, "resale");
  const isPrice = !isResale && (has(outside, "prix") || has(outside, "price"));
  if (!isResale && !isPrice) return null;
  if (has(outside, "achat") || has(outside, "purchase") || has(outside, "cout") || has(outside, "cost")) return null;
  const side = has(outside, "max") ? "max" : has(inside, "max") ? "max" : has(outside, "min") || has(inside, "min") ? "min" : null;
  if (isResale) return side === "max" ? "resale_max_total" : side === "min" ? "resale_min_total" : null;
  return side === "max" ? "price_max" : "price_min";
}

function containsTarget(outside: string, taken: ReadonlySet<StockField>): StockField | null {
  let best: { field: StockField; length: number } | null = null;
  for (const [field, list] of CONTAINS) {
    if (taken.has(field)) continue;
    for (const w of list) if (w.length > (best?.length ?? 0) && has(outside, w)) best = { field, length: w.length };
  }
  return best?.field ?? null;
}

export type StockAutoMapping = { targets: StockTarget[]; matched: boolean[] };

/** Suggests a target per column: exact synonyms, then the price and REVENTE rule, then "contains"; one column per field. */
export function autoMapStock(headers: readonly string[]): StockAutoMapping {
  const parts = headers.map(splitHeader);
  const targets: StockTarget[] = headers.map(() => "ignore");
  const matched = headers.map(() => false);
  const taken = new Set<StockField>();
  const assign = (field: StockField | null, i: number) => {
    if (field && !taken.has(field) && targets[i] === "ignore" && !matched[i]) {
      targets[i] = field;
      matched[i] = true;
      taken.add(field);
    }
  };
  parts.forEach(({ outside }, i) => {
    if (IGNORED.has(outside)) matched[i] = true;
  });
  parts.forEach(({ outside }, i) => assign(EXACT.find(([, list]) => list.includes(outside))?.[0] ?? null, i));
  parts.forEach(({ outside, inside }, i) => assign(sidedTarget(outside, inside), i));
  parts.forEach(({ outside }, i) => {
    if (outside) assign(containsTarget(outside, taken), i);
  });
  return { targets, matched };
}

/** Gives `column` the target; a field already used by another column moves there in exchange (swap). */
export function assignStockTarget(mapping: StockMapping, column: number, target: StockTarget): StockTarget[] {
  const next = [...mapping];
  if (column < 0 || column >= next.length) return next;
  const previous = next[column];
  if (target !== "ignore") {
    const other = next.indexOf(target);
    if (other !== -1 && other !== column) next[other] = previous;
  }
  next[column] = target;
  return next;
}

/** Stable text for remembering a mapping per header row (stored only as a hash). */
export function stockHeaderFingerprint(headers: readonly string[]): string {
  return JSON.stringify(["stock", ...headers.map((h) => { const p = splitHeader(h); return `${p.outside}|${p.inside}`; })]);
}
