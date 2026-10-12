import { z } from "zod";

// The Stock tab's filters live in the URL (shareable, survive reload, Back works). Bad values are dropped, never sent:
// every value reaches the database as a function argument (list_stock), never as filter text.
export const STOCK_FILTERS = ["all", "in_warehouse", "in_transit", "low", "sold_out", "held", "hidden", "archived"] as const;
export type StockFilter = (typeof STOCK_FILTERS)[number];
export const STOCK_SORTS = ["name", "available", "updated"] as const;
export type StockSort = (typeof STOCK_SORTS)[number];
export const INVENTORY_TABS = ["stock", "arriving", "reserved", "movements"] as const;
export type InventoryTab = (typeof INVENTORY_TABS)[number];

/** Rows per page from list_stock (design 10.1: server keyset pages of 100). */
export const STOCK_PAGE_SIZE = 100;
export const MOVEMENT_PAGE_SIZE = 50;
export const RESERVATION_PAGE_SIZE = 50;

export const stockFilterParams = z.object({
  q: z.string().trim().max(100).optional().catch(undefined),
  filter: z.enum(STOCK_FILTERS).optional().catch(undefined),
  category: z.string().trim().min(1).max(80).optional().catch(undefined),
  sort: z.enum(STOCK_SORTS).optional().catch(undefined),
});
export type StockFilters = z.infer<typeof stockFilterParams>;

type ParamSource = URLSearchParams | Record<string, string | string[] | undefined>;
function getter(params: ParamSource) {
  return (k: string) => {
    const v = params instanceof URLSearchParams ? params.get(k) : params[k];
    const s = Array.isArray(v) ? v[0] : v;
    return s === null || s === "" ? undefined : s;
  };
}

export function parseStockFilters(params: ParamSource): StockFilters {
  const get = getter(params);
  return stockFilterParams.parse({ q: get("q"), filter: get("filter"), category: get("category"), sort: get("sort") });
}

export function stockFiltersToParams(f: StockFilters): URLSearchParams {
  const p = new URLSearchParams();
  if (f.q) p.set("q", f.q);
  if (f.filter && f.filter !== "all") p.set("filter", f.filter);
  if (f.category) p.set("category", f.category);
  if (f.sort && f.sort !== "name") p.set("sort", f.sort);
  return p;
}

export function parseTab(value: string | string[] | undefined | null): InventoryTab {
  const v = Array.isArray(value) ? value[0] : value;
  return (INVENTORY_TABS as readonly string[]).includes(v ?? "") ? (v as InventoryTab) : "stock";
}

export const stockCursorParams = z.object({ after_value: z.string().min(1).max(400), after_id: z.uuid() });

const uuid = z.uuid();
const isoDate = z.iso.date();
export const movementParams = z.object({
  product: uuid.optional(),
  kinds: z
    .string()
    .max(400)
    .transform((s) => s.split(",").filter(Boolean))
    .pipe(z.array(z.enum(["receive", "adjust_in", "adjust_out", "transfer_out", "transfer_in", "reserve", "release", "expire", "ship", "return", "import_in", "import_out", "undo_in", "undo_out"])).max(14))
    .optional(),
  user: uuid.optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
  before: z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
});
export type MovementFilters = Omit<z.infer<typeof movementParams>, "before">;

/** UI groups of movement kinds (the Movements tab's kind filter). */
export const MOVEMENT_GROUPS = {
  sales: ["ship", "return"],
  corrections: ["receive", "adjust_in", "adjust_out"],
  holds: ["reserve", "release", "expire"],
  arrived: ["transfer_out", "transfer_in"],
  imports: ["import_in", "import_out", "undo_in", "undo_out"],
} as const;
export type MovementGroup = keyof typeof MOVEMENT_GROUPS;

export const reservationParams = z.object({
  company: uuid.optional(),
  product: uuid.optional(),
  status: z.enum(["active", "closed", "all"]).optional(),
  before_created: z.iso.datetime({ offset: true }).optional(),
  before_id: uuid.optional(),
});
