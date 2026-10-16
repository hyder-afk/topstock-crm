import type { ShareItem, ShareSnapshot } from "@/lib/share/schema";

// The browser's reading of /api/share/view (design 8.6, I10): the positional items back to named fields, checked by
// hand so the client page does not ship a schema library (Zod costs about 40 KB gzip there). The rules equal the
// server's strict schema (shareItemSchema, shareSnapshotSchema); share.spec.ts checks both agree. Pure.
// Lengths are counted in characters (code points), as Zod and Postgres count them, not in UTF-16 units: a name of 200
// characters ending in an emoji is 201 units long and must still pass. A date must exist on the calendar (2026-02-30
// does not), as z.iso.date() requires.

const int = (v: unknown, min: number) => typeof v === "number" && Number.isInteger(v) && v >= min && v <= 2_147_483_647;
// A character is one or two UTF-16 units, so a string longer than 2 × max units is too long without counting it.
const text = (v: unknown, max: number, min = 0) => {
  if (typeof v !== "string" || v.length > max * 2) return false;
  const n = [...v].length;
  return n >= min && n <= max;
};
const PRICE = /^\d{1,7}(\.\d{1,4})?$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const calendarDay = (v: string) => DATE.test(v) && !Number.isNaN(Date.parse(v)) && new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) === v;
const VERSION = /^[0-9a-f]{16}$/;
const SNAPSHOT_KEYS = ["allowRequests", "currency", "generatedAt", "items", "language", "showInTransit", "signature", "status", "version"];

/** [number, name, category, price_max, pieces_per_carton, warehouse, transit, eta_week] → ShareItem; null if wrong. */
export function itemFromWire(row: unknown): ShareItem | null {
  if (!Array.isArray(row) || row.length !== 8) return null;
  const [number, name, category, priceMax, piecesPerCarton, warehouse, transit, etaWeek] = row;
  if (!int(number, 1) || !text(name, 200, 1) || !(category === null || text(category, 80))) return null;
  if (!(priceMax === null || (typeof priceMax === "string" && PRICE.test(priceMax)))) return null;
  if (!int(piecesPerCarton, 1) || !int(warehouse, 0) || !int(transit, 0)) return null;
  if (!(etaWeek === null || (typeof etaWeek === "string" && calendarDay(etaWeek)))) return null;
  return { number, name, category, priceMax, piecesPerCarton, warehouse, transit, etaWeek } as ShareItem;
}

export function snapshotFromWire(raw: unknown): ShareSnapshot | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (Object.keys(r).sort().join() !== SNAPSHOT_KEYS.join()) return null;
  if (r.status !== "ok" || typeof r.version !== "string" || !VERSION.test(r.version)) return null;
  if ((r.language !== "en" && r.language !== "fr") || r.currency !== "EUR") return null;
  if (typeof r.showInTransit !== "boolean" || typeof r.allowRequests !== "boolean") return null;
  if (!(r.signature === null || text(r.signature, 60)) || !text(r.generatedAt, 40)) return null;
  if (!Array.isArray(r.items) || r.items.length > 2000) return null;
  const items: ShareItem[] = [];
  for (const row of r.items) {
    const item = itemFromWire(row);
    if (!item) return null;
    items.push(item);
  }
  return {
    status: "ok",
    version: r.version,
    language: r.language,
    currency: "EUR",
    showInTransit: r.showInTransit,
    allowRequests: r.allowRequests,
    signature: r.signature as string | null,
    generatedAt: r.generatedAt as string,
    items,
  };
}

/** The request's `t` (milliseconds since the page loaded, design 8.6): only its 2-second floor matters, so a page left
 *  open longer than the server's 24-hour bound sends the bound instead of being refused. Never negative. */
export const MAX_ELAPSED_MS = 86_400_000;
export function requestElapsed(now: number, loadedAt: number): number {
  return Math.min(MAX_ELAPSED_MS, Math.max(0, Math.round(now - loadedAt)));
}
