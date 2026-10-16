// A remembered stock column matching per header row (a per-person convenience in this browser): stored under a hash of
// the header row, never the header text. Every access is in try/catch: storage can be blocked or full.
import { STOCK_TARGETS, type StockTarget } from "@/lib/stock-import";

const prefix = "topstock.stockimport.mapping.";

export function readStockMapping(headerKey: string, length: number): StockTarget[] | null {
  try {
    const raw = window.localStorage.getItem(prefix + headerKey);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    if (Array.isArray(parsed) && parsed.length === length && parsed.every((x) => (STOCK_TARGETS as readonly string[]).includes(x))) {
      return parsed as StockTarget[];
    }
  } catch {
    // Storage blocked: start from the suggestions.
  }
  return null;
}

export function saveStockMapping(headerKey: string, mapping: readonly StockTarget[]) {
  try {
    window.localStorage.setItem(prefix + headerKey, JSON.stringify(mapping));
  } catch {
    // Storage blocked: nothing to remember.
  }
}
