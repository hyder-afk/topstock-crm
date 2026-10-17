// Pieces and cartons (design D12): stock is stored and entered in pieces; a cartons toggle shows "= 3 ctn" live. Haider,
// 11 Oct 2026: pieces only ("pcs"), no per-product unit word.

export type QtyUnit = "piece" | "carton";
export const MAX_PIECES = 50_000_000;

/** Pieces for a quantity typed in pieces or cartons; null when it is not a whole positive number in range. */
export function toPieces(quantity: number, unit: QtyUnit, piecesPerCarton: number): number | null {
  if (!Number.isInteger(quantity) || quantity < 0 || !Number.isInteger(piecesPerCarton) || piecesPerCarton < 1) return null;
  const pieces = unit === "carton" ? quantity * piecesPerCarton : quantity;
  return pieces <= MAX_PIECES ? pieces : null;
}

/** Whole cartons and the loose pieces left over: 1210 at 24 a carton is 50 cartons and 10 pieces. */
export function packs(pieces: number, piecesPerCarton: number): { cartons: number; loose: number } {
  if (piecesPerCarton < 1 || pieces <= 0) return { cartons: 0, loose: Math.max(0, pieces) };
  return { cartons: Math.floor(pieces / piecesPerCarton), loose: pieces % piecesPerCarton };
}

/** Pallets, to one decimal ("≈ 2.1 pallets"); null without a pallet size. */
export function pallets(pieces: number, piecesPerCarton: number, cartonsPerPallet: number | null): number | null {
  if (!cartonsPerPallet || cartonsPerPallet < 1 || piecesPerCarton < 1) return null;
  return Math.round((pieces / piecesPerCarton / cartonsPerPallet) * 10) / 10;
}

/**
 * Reads a whole number typed by a person ("1 200", "1200", "1.200" or "1,200"): a dot, comma or apostrophe only as a
 * thousands separator, so each one is followed by exactly three digits. "1.5" or "12,50" is refused (null), never read
 * as 15 or 1250 (bugs audit L4).
 */
export function parseWhole(text: string): number | null {
  const cleaned = text.replace(/[\s\u00a0\u202f]/g, "");
  if (!/^\d+$/.test(cleaned) && !/^\d{1,3}([.,'])\d{3}(?:\1\d{3})*$/.test(cleaned)) return null;
  const digits = cleaned.replace(/[.,']/g, "");
  if (!/^\d{1,9}$/.test(digits)) return null;
  return Number(digits);
}

/**
 * Reads a price per piece typed by a person: "2,50", "2.50", "€2.50", "2,5 €", "1 250"; at most 4 decimals. One
 * separator followed by 1, 2 or 4 digits is the decimal point whatever the language. Followed by exactly 3 digits it
 * is ambiguous ("1,250": €1,250 in English, €1.25 in French), so it reads as decimals only with the language's own
 * decimal mark (the dot in English, the comma in French) and is refused (null) otherwise, never silently misread (bugs
 * audit L4). Thousands with the language's grouping and decimal marks ("1,250.50", "1.250,50") are read too.
 */
export function parsePrice(text: string, locale: string): number | null {
  const fr = locale.toLowerCase().startsWith("fr");
  const [dec, grp] = fr ? [",", "."] : [".", ","];
  const cleaned = text.replace(/[\s\u00a0\u202f€]|EUR/gi, "");
  let plain: string | null = null;
  const one = /^(\d+)([.,])(\d{1,4})$/.exec(cleaned);
  if (/^\d+$/.test(cleaned)) plain = cleaned;
  else if (one) plain = one[3].length === 3 && one[2] === grp ? null : `${one[1]}.${one[3]}`;
  else {
    const g = grp === "." ? "\\." : ",";
    const d = dec === "." ? "\\." : ",";
    const grouped = new RegExp(`^(\\d{1,3}(?:${g}\\d{3})+)(?:${d}(\\d{1,4}))?$`).exec(cleaned);
    if (grouped) plain = grouped[1].split(grp).join("") + (grouped[2] ? `.${grouped[2]}` : "");
  }
  if (plain === null || !/^\d{1,7}(\.\d{1,4})?$/.test(plain)) return null;
  const n = Number(plain);
  return n <= 1_000_000 ? n : null;
}

/** A stored price as the person's language writes it, for a field parsePrice reads back: 2.125 is "2,125" in French. */
export function priceInput(n: number | null | undefined, locale: string): string {
  if (n === null || n === undefined) return "";
  const text = String(Number(n));
  return locale.toLowerCase().startsWith("fr") ? text.replace(".", ",") : text;
}

/** The availability bar's fill (design 10.1): available pieces against 3 × the reorder point, 0 to 1. */
export function availabilityFill(available: number, reorderPoint: number | null): number | null {
  if (reorderPoint === null || reorderPoint <= 0) return null;
  return Math.max(0, Math.min(1, available / (reorderPoint * 3)));
}
