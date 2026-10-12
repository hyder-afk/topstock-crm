// The stock error contract (design 4.8; the importError pattern): only the SQLSTATE and the hint are read, never the
// database's message (constant pre-checks keep values out of messages anyway). Each action answers
// { ok: false, error, hint? } and the screen words it from messages (Inventory.errors).

export type StockErrorCode =
  | "step_up" // a fresh authenticator code is needed: "Confirm it's you" opens, then the call is retried
  | "forbidden"
  | "stock_short" // not enough available now: the screen re-reads the levels ("Only {n} available now")
  | "stale"
  | "invalid" // a value refused; `hint` says which rule when the screen words it
  | "not_found"
  | "busy" // someone else is changing this stock (lock timeout)
  | "timeout"
  | "has_history"
  | "rate_limited"
  | "unavailable";

/** 22023 hints with their own wording (design 4.8 plus the 6a/6b field rules). */
export const STOCK_HINTS = [
  "reservation_state",
  "deal_mismatch",
  "deal_closed",
  "deal_direct",
  "deal_lost",
  "product_archived",
  "has_stock",
  "name_taken",
  "product_name",
  "category",
  "carton",
  "pallet",
  "reorder",
  "price",
  "price_order",
  "eta",
  "cost",
  "quantity",
  "reason",
  "note",
  "note_required",
  "hold_until",
  "location_name",
  "hold_days",
  "assignee",
  "below_min",
  "duplicate_line",
  "lines",
  "too_many_links",
  "undo_window",
  "sale_state",
  "cancel_reason",
  "fulfilment",
  "country",
  "description",
  "request_status",
  "request_mismatch",
  "document",
] as const;
export type StockHint = (typeof STOCK_HINTS)[number];

export type StockFailure = { ok: false; error: StockErrorCode; hint?: StockHint };
export type StockResult<T> = { ok: true; data: T } | StockFailure;

const shortHints = new Set(["insufficient_stock", "over_reservation", "reserved_by_others", "below_reserved", "not_reserved"]);

export function stockError(error: { code?: string | null; hint?: string | null } | null | undefined): StockFailure {
  const code = error?.code ?? "";
  const hint = error?.hint ?? "";
  if (code === "42501") {
    if (hint === "step_up") return { ok: false, error: "step_up" };
    return hint === "below_min" ? { ok: false, error: "forbidden", hint: "below_min" } : { ok: false, error: "forbidden" };
  }
  if (code === "P0002") return { ok: false, error: "not_found" };
  if (code === "55P03") return { ok: false, error: "busy" };
  if (code === "57014") return { ok: false, error: "timeout" };
  if (code === "23503") return { ok: false, error: "has_history" };
  if (code === "22023" || code === "23514" || code === "22P02" || code === "22007" || code === "22008") {
    if (shortHints.has(hint)) return { ok: false, error: "stock_short" };
    if (hint === "stale") return { ok: false, error: "stale" };
    if (hint === "rate_limited") return { ok: false, error: "rate_limited" };
    return (STOCK_HINTS as readonly string[]).includes(hint)
      ? { ok: false, error: "invalid", hint: hint as StockHint }
      : { ok: false, error: "invalid" };
  }
  return { ok: false, error: "unavailable" };
}

/** A request refused before any database call (Zod), worded like the database's own refusal. */
export function stockInvalid(hint?: StockHint): StockFailure {
  return hint ? { ok: false, error: "invalid", hint } : { ok: false, error: "invalid" };
}
