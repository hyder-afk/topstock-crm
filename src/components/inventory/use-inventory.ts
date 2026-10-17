"use client";

import { useInfiniteQuery, useQuery, type QueryClient } from "@tanstack/react-query";
import { stockFiltersToParams, type MovementFilters, type StockFilters } from "@/lib/inventory/filters";
import type {
  MovementPage,
  ProductDetail,
  ReservationCursor,
  ReservationPage,
  StockCursor,
  StockPage,
  StockSummary,
} from "@/lib/inventory/types";

// Inventory reads in the browser (design 10.1): TanStack Query over the read-only GET routes. Keys:
// ["stock", filters] (keyset pages of 100), ["stock-summary"], ["product", id], ["movements", filters],
// ["reservations", filters]. Every change refreshes them through refreshInventory().

export const stockKey = (f: StockFilters) => ["stock", stockFiltersToParams(f).toString()] as const;
export const summaryKey = ["stock-summary"] as const;
export const productKey = (id: string) => ["product", id] as const;

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(String(res.status));
  return (await res.json()) as T;
}

export function fetchStockPage(f: StockFilters, cursor: StockCursor): Promise<StockPage> {
  const params = stockFiltersToParams(f);
  if (cursor) {
    params.set("after_value", cursor.after_value);
    params.set("after_id", cursor.after_id);
  }
  return getJson<StockPage>(`/api/inventory/stock?${params}`);
}

export function useStock(f: StockFilters, initial: { key: string; page: StockPage | null }) {
  const key = stockKey(f);
  const seeded = initial.page && key[1] === initial.key;
  return useInfiniteQuery({
    queryKey: key,
    queryFn: ({ pageParam }) => fetchStockPage(f, pageParam),
    initialPageParam: null as StockCursor,
    getNextPageParam: (last) => last.next,
    initialData: seeded ? { pages: [initial.page as StockPage], pageParams: [null] } : undefined,
  });
}

export function useSummary(initial: StockSummary | null) {
  return useQuery({
    queryKey: summaryKey,
    queryFn: () => getJson<StockSummary>("/api/inventory/summary"),
    initialData: initial ?? undefined,
  });
}

export async function fetchProductDetail(id: string): Promise<ProductDetail | null> {
  const res = await fetch(`/api/inventory/products/${id}`, { headers: { accept: "application/json" } });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(String(res.status));
  return (await res.json()) as ProductDetail;
}

export function useProduct(id: string | null, initial?: ProductDetail | null) {
  return useQuery({
    queryKey: productKey(id ?? "none"),
    queryFn: () => fetchProductDetail(id as string),
    enabled: !!id,
    initialData: initial ?? undefined,
  });
}

/** Hover intent on a row (120 ms): the panel's data is ready before the click. */
export function prefetchProduct(queryClient: QueryClient, id: string) {
  void queryClient.prefetchQuery({ queryKey: productKey(id), queryFn: () => fetchProductDetail(id), staleTime: 15_000 });
}

function movementParams(f: MovementFilters) {
  const p = new URLSearchParams();
  if (f.product) p.set("product", f.product);
  if (f.kinds && f.kinds.length) p.set("kinds", f.kinds.join(","));
  if (f.user) p.set("user", f.user);
  if (f.from) p.set("from", f.from);
  if (f.to) p.set("to", f.to);
  return p;
}

export function useMovements(f: MovementFilters, enabled = true) {
  return useInfiniteQuery({
    queryKey: ["movements", movementParams(f).toString()],
    queryFn: ({ pageParam }) => {
      const p = movementParams(f);
      if (pageParam) p.set("before", String(pageParam));
      return getJson<MovementPage>(`/api/inventory/movements?${p}`);
    },
    initialPageParam: null as number | null,
    getNextPageParam: (last) => last.next,
    enabled,
  });
}

export function useReservations(f: { company?: string; product?: string; status?: "active" | "closed" | "all" }, enabled = true) {
  const base = new URLSearchParams();
  if (f.company) base.set("company", f.company);
  if (f.product) base.set("product", f.product);
  if (f.status) base.set("status", f.status);
  return useInfiniteQuery({
    queryKey: ["reservations", base.toString()],
    queryFn: ({ pageParam }) => {
      const p = new URLSearchParams(base);
      if (pageParam) {
        p.set("before_created", pageParam.before_created);
        p.set("before_id", pageParam.before_id);
      }
      return getJson<ReservationPage>(`/api/inventory/reservations?${p}`);
    },
    initialPageParam: null as ReservationCursor,
    getNextPageParam: (last) => last.next,
    enabled,
  });
}

/** After any stock change: every list, the KPIs, the product (when known) and Home (low stock) are fetched again. */
export function refreshInventory(queryClient: QueryClient, productId?: string) {
  void queryClient.invalidateQueries({ queryKey: ["stock"] });
  void queryClient.invalidateQueries({ queryKey: summaryKey });
  void queryClient.invalidateQueries({ queryKey: ["movements"] });
  void queryClient.invalidateQueries({ queryKey: ["reservations"] });
  if (productId) void queryClient.invalidateQueries({ queryKey: productKey(productId) });
  else void queryClient.invalidateQueries({ queryKey: ["product"] });
  void queryClient.invalidateQueries({ queryKey: ["home"] });
}
