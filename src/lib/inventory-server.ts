import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  MOVEMENT_PAGE_SIZE,
  RESERVATION_PAGE_SIZE,
  STOCK_PAGE_SIZE,
  type MovementFilters,
  type StockFilters,
} from "@/lib/inventory/filters";
import type {
  InventorySettings,
  MovementPage,
  Movement,
  ProductDetail,
  Reservation,
  ReservationCursor,
  ReservationPage,
  StockCursor,
  StockPage,
  StockRow,
  StockSummary,
} from "@/lib/inventory/types";

// Reads shared by the Inventory pages (first data, server-rendered) and the GET routes under /api/inventory (next pages,
// filter changes, refetch after a change). Each returns "invalid" when the database refused the request itself (a cursor
// or filter that does not fit), null when it could not answer. Values travel as RPC arguments, never as filter text.

function stockArgs(f: StockFilters) {
  return { p_search: f.q ?? null, p_filter: f.filter ?? "all", p_category: f.category ?? null };
}

export async function fetchStockPage(supabase: SupabaseClient, f: StockFilters, cursor: StockCursor): Promise<StockPage | "invalid" | null> {
  const [list, count] = await Promise.all([
    supabase.rpc("list_stock", {
      ...stockArgs(f),
      p_sort: f.sort ?? "name",
      p_after_value: cursor?.after_value ?? null,
      p_after_id: cursor?.after_id ?? null,
      p_limit: STOCK_PAGE_SIZE + 1,
    }),
    cursor ? Promise.resolve(null) : supabase.rpc("count_stock", stockArgs(f)),
  ]);
  if (list.error?.code === "22023" || count?.error?.code === "22023") return "invalid";
  if (list.error || count?.error) return null;
  const rows = (list.data ?? []) as StockRow[];
  const hasMore = rows.length > STOCK_PAGE_SIZE;
  const page = hasMore ? rows.slice(0, STOCK_PAGE_SIZE) : rows;
  const last = page[page.length - 1];
  return {
    rows: page,
    next: hasMore && last ? { after_value: last.sort_value, after_id: last.id } : null,
    total: count ? Number(count.data) : null,
  };
}

export async function fetchSummary(supabase: SupabaseClient): Promise<StockSummary | null> {
  const { data, error } = await supabase.rpc("stock_summary");
  return error ? null : (data as StockSummary);
}

/** The product, or "missing" (not there, or not visible: the same answer), or null when the database could not answer. */
export async function fetchProduct(supabase: SupabaseClient, id: string): Promise<ProductDetail | "missing" | null> {
  const { data, error } = await supabase.rpc("get_product", { p_id: id });
  if (error?.code === "P0002") return "missing";
  if (error) return null;
  return data as ProductDetail;
}

export async function fetchMovements(supabase: SupabaseClient, f: MovementFilters, before: number | null): Promise<MovementPage | "invalid" | null> {
  const { data, error } = await supabase.rpc("list_movements", {
    p_product: f.product ?? null,
    p_kinds: f.kinds && f.kinds.length > 0 ? f.kinds : null,
    p_user: f.user ?? null,
    p_from: f.from ?? null,
    p_to: f.to ?? null,
    p_before_id: before,
    p_limit: MOVEMENT_PAGE_SIZE + 1,
  });
  if (error?.code === "22023") return "invalid";
  if (error) return null;
  const rows = (data ?? []) as Movement[];
  const hasMore = rows.length > MOVEMENT_PAGE_SIZE;
  const page = hasMore ? rows.slice(0, MOVEMENT_PAGE_SIZE) : rows;
  return { rows: page, next: hasMore ? (page[page.length - 1]?.id ?? null) : null };
}

export async function fetchReservations(
  supabase: SupabaseClient,
  f: { company?: string; product?: string; status?: "active" | "closed" | "all" },
  cursor: ReservationCursor,
): Promise<ReservationPage | "invalid" | null> {
  const { data, error } = await supabase.rpc("list_reservations", {
    p_company: f.company ?? null,
    p_product: f.product ?? null,
    p_status: f.status ?? "active",
    p_before_created: cursor?.before_created ?? null,
    p_before_id: cursor?.before_id ?? null,
    p_limit: RESERVATION_PAGE_SIZE + 1,
  });
  if (error?.code === "22023") return "invalid";
  if (error) return null;
  const rows = (data ?? []) as Reservation[];
  const hasMore = rows.length > RESERVATION_PAGE_SIZE;
  const page = hasMore ? rows.slice(0, RESERVATION_PAGE_SIZE) : rows;
  const last = page[page.length - 1];
  return { rows: page, next: hasMore && last ? { before_created: last.created_at, before_id: last.id } : null };
}

export async function fetchInventorySettings(supabase: SupabaseClient): Promise<InventorySettings | null> {
  const { data, error } = await supabase.rpc("get_inventory_settings");
  return error ? null : (data as InventorySettings);
}

/** The page-load sweep of ended holds (design D8); at most once a minute per organisation, so it is cheap to call. */
export async function sweepEndedHolds(supabase: SupabaseClient): Promise<void> {
  await supabase.rpc("release_expired_reservations");
}

export const NO_STORE = { "Cache-Control": "private, no-store" } as const;
