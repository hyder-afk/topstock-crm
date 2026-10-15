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

/** Reads a whole number typed by a person ("1 200", "1200", "1.200" in French): digits only after spaces go. */
export function parseWhole(text: string): number | null {
  const cleaned = text.replace(/[\s   '.,]/g, "");
  if (!/^\d{1,9}$/.test(cleaned)) return null;
  return Number(cleaned);
}

/** Reads a price per piece typed by a person: "2,50", "2.50", "€2.50", "2,5 €"; at most 4 decimals. */
export function parsePrice(text: string): number | null {
  const cleaned = text.replace(/[\s  €]|EUR/gi, "").replace(",", ".");
  if (!/^\d{1,7}(\.\d{1,4})?$/.test(cleaned)) return null;
  const n = Number(cleaned);
  return n <= 1_000_000 ? n : null;
}

/** The availability bar's fill (design 10.1): available pieces against 3 × the reorder point, 0 to 1. */
export function availabilityFill(available: number, reorderPoint: number | null): number | null {
  if (reorderPoint === null || reorderPoint <= 0) return null;
  return Math.max(0, Math.min(1, available / (reorderPoint * 3)));
}
