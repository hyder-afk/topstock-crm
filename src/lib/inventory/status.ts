import type { StockStatus } from "@/lib/inventory/types";

// A product's status is a dot plus a word (DESIGN.md: never colour alone, never the accent). Design 10: In stock (green),
// Low (amber), Sold out (red), Arriving and Archived (neutral).
export const stockStatusTone: Record<StockStatus, "green" | "amber" | "red" | "neutral"> = {
  in_stock: "green",
  low: "amber",
  sold_out: "red",
  arriving: "neutral",
  archived: "neutral",
};

/** The same rule as private.stock_rows (the database is the source; this is for rows changed in the cache). */
export function stockStatus(p: {
  archived: boolean;
  wh_available: number;
  tr_on_hand: number;
  reorder_point: number | null;
}): StockStatus {
  if (p.archived) return "archived";
  if (p.wh_available <= 0 && p.tr_on_hand === 0) return "sold_out";
  if (p.wh_available <= 0) return "arriving";
  if (p.reorder_point !== null && p.wh_available <= p.reorder_point) return "low";
  return "in_stock";
}

/** "P-0042": a product's short reference (design D14). */
export function productRef(number: number): string {
  return `P-${String(number).padStart(4, "0")}`;
}

/** Monday of a date's week (ISO), as YYYY-MM-DD: clients and lists say "week of 13 Oct", never the day (design D31). */
export function weekStart(isoDate: string): string {
  const [y, m, d] = isoDate.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  const back = (date.getUTCDay() + 6) % 7;
  date.setUTCDate(date.getUTCDate() - back);
  return date.toISOString().slice(0, 10);
}
