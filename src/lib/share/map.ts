import {
  shareItemSchema,
  shareSnapshotSchema,
  shareUnchangedSchema,
  type ShareItem,
  type ShareRequestAnswer,
  type ShareSnapshot,
  type ShareViewAnswer,
} from "@/lib/share/schema";

// The database answers with positional arrays (design 8.5: about 70 bytes an item); these turn them into fixed keys and
// re-parse the whole answer strictly, so only the public fields ever leave the server. Pure; unit-tested.

/** [number, name, category, price_max, pieces_per_carton, warehouse, transit, eta_week] → ShareItem; null if wrong. */
export function mapShareItem(row: unknown): ShareItem | null {
  if (!Array.isArray(row) || row.length !== 8) return null;
  const [number, name, category, priceMax, piecesPerCarton, warehouse, transit, etaWeek] = row;
  const parsed = shareItemSchema.safeParse({ number, name, category, priceMax, piecesPerCarton, warehouse, transit, etaWeek });
  return parsed.success ? parsed.data : null;
}

/** The item back to its positional form for the wire (about 50 bytes an item; design I10). */
export function itemToWire(i: ShareItem): unknown[] {
  return [i.number, i.name, i.category, i.priceMax, i.piecesPerCarton, i.warehouse, i.transit, i.etaWeek];
}

/** What /api/share/view sends: the checked snapshot with its items as positional arrays (only whitelisted fields). */
export function snapshotToWire(s: ShareSnapshot): Omit<ShareSnapshot, "items"> & { items: unknown[][] } {
  return { ...s, items: s.items.map(itemToWire) };
}

/** The browser's side: the wire answer back to a checked snapshot (null when anything is off). */
export function snapshotFromWire(raw: unknown): ShareSnapshot | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const items = mapShareItems(r.items);
  if (!items) return null;
  const parsed = shareSnapshotSchema.safeParse({ ...r, items });
  return parsed.success ? parsed.data : null;
}

export function mapShareItems(rows: unknown): ShareItem[] | null {
  if (!Array.isArray(rows)) return null;
  const out: ShareItem[] = [];
  for (const r of rows) {
    const item = mapShareItem(r);
    if (!item) return null;
    out.push(item);
  }
  return out;
}

/** The share_view answer, mapped and checked; anything unexpected is "unavailable". */
export function mapShareView(raw: unknown): ShareViewAnswer {
  if (!raw || typeof raw !== "object") return { status: "unavailable" };
  const r = raw as Record<string, unknown>;
  if (r.status === "inactive" || r.status === "slow_down") return { status: r.status };
  if (r.status !== "ok") return { status: "unavailable" };
  if (r.unchanged === true) {
    const u = shareUnchangedSchema.safeParse({ status: "ok", unchanged: true, version: r.version });
    return u.success ? u.data : { status: "unavailable" };
  }
  const items = mapShareItems(r.items);
  if (!items) return { status: "unavailable" };
  const parsed = shareSnapshotSchema.safeParse({
    status: "ok",
    version: r.version,
    language: r.language,
    currency: r.currency,
    showInTransit: r.show_in_transit,
    allowRequests: r.allow_requests,
    signature: r.signature ?? null,
    generatedAt: r.generated_at,
    items,
  });
  return parsed.success ? parsed.data : { status: "unavailable" };
}

const REQUEST_STATUSES = ["inactive", "closed", "invalid", "slow_down", "too_many_open"] as const;

export function mapShareRequest(raw: unknown): ShareRequestAnswer {
  if (!raw || typeof raw !== "object") return { status: "unavailable" };
  const r = raw as Record<string, unknown>;
  if (r.status === "received") {
    const sig = typeof r.signature === "string" && r.signature.length <= 60 ? r.signature : null;
    return { status: "received", signature: sig };
  }
  const s = REQUEST_STATUSES.find((x) => x === r.status);
  return s ? { status: s } : { status: "unavailable" };
}
