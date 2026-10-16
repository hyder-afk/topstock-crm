"use client";

import { useInfiniteQuery, useQuery, type QueryClient } from "@tanstack/react-query";
import { refreshInventory } from "@/components/inventory/use-inventory";
import type { StockPage } from "@/lib/inventory/types";
import type { LeadStock, RequestPage, SaleCursor, SaleDetail, SalePage, StockAlerts, StockRequest } from "@/lib/sales/types";

// Day 6d reads in the browser: ["lead-stock", id], ["sales", filters], ["requests", status], ["sale", id],
// ["request", id], ["stock-alerts"]. Every sale, hold or request
// change refreshes them and the inventory keys (refreshSales).

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(String(res.status));
  return (await res.json()) as T;
}

export const leadStockKey = (id: string) => ["lead-stock", id] as const;
export function fetchLeadStock(id: string) {
  return getJson<LeadStock>(`/api/leads/${id}/stock`);
}
export function useLeadStock(id: string | null) {
  return useQuery({ queryKey: leadStockKey(id ?? "none"), queryFn: () => fetchLeadStock(id as string), enabled: !!id, staleTime: 10_000 });
}

export function useSales(f: { company?: string; fulfilment?: string }, enabled = true) {
  return useInfiniteQuery({
    queryKey: ["sales", f.company ?? "", f.fulfilment ?? ""],
    queryFn: ({ pageParam }) => {
      const p = new URLSearchParams();
      if (f.company) p.set("company", f.company);
      if (f.fulfilment) p.set("fulfilment", f.fulfilment);
      if (pageParam) {
        p.set("before_created", pageParam.before_created);
        p.set("before_id", pageParam.before_id);
      }
      return getJson<SalePage>(`/api/inventory/sales?${p}`);
    },
    initialPageParam: null as SaleCursor,
    getNextPageParam: (last) => last.next,
    enabled,
  });
}

export function useRequests(status: string, enabled = true) {
  return useInfiniteQuery({
    queryKey: ["requests", status],
    queryFn: ({ pageParam }) => {
      const p = new URLSearchParams({ status });
      if (pageParam) {
        p.set("before_created", pageParam.before_created);
        p.set("before_id", pageParam.before_id);
      }
      return getJson<RequestPage>(`/api/inventory/requests?${p}`);
    },
    initialPageParam: null as SaleCursor,
    getNextPageParam: (last) => last.next,
    enabled,
  });
}

export const saleKey = (id: string) => ["sale", id] as const;
export function useSale(id: string | null) {
  return useQuery({ queryKey: saleKey(id ?? "none"), queryFn: () => getJson<SaleDetail>(`/api/inventory/sales/${id}`), enabled: !!id, staleTime: 10_000 });
}
export const requestKey = (id: string) => ["request", id] as const;
export function useRequest(id: string | null) {
  return useQuery({ queryKey: requestKey(id ?? "none"), queryFn: () => getJson<StockRequest>(`/api/inventory/requests/${id}`), enabled: !!id, staleTime: 10_000 });
}
export const alertsKey = ["stock-alerts"] as const;
export function useAlerts() {
  return useQuery({ queryKey: alertsKey, queryFn: () => getJson<StockAlerts>("/api/inventory/alerts"), staleTime: 30_000 });
}

/** Products for the pickers: the first page of the stock list for a search (name or P-0042). */
export function searchProducts(q: string) {
  const p = new URLSearchParams({ sort: "name" });
  if (q.trim()) p.set("q", q.trim());
  return getJson<StockPage>(`/api/inventory/stock?${p}`).then((page) => page.rows.slice(0, 8));
}

export function refreshSales(queryClient: QueryClient, companyId?: string | null) {
  refreshInventory(queryClient);
  void queryClient.invalidateQueries({ queryKey: ["sales"] });
  void queryClient.invalidateQueries({ queryKey: ["requests"] });
  void queryClient.invalidateQueries({ queryKey: ["request"] });
  void queryClient.invalidateQueries({ queryKey: ["sale"] });
  void queryClient.invalidateQueries({ queryKey: alertsKey });
  if (companyId) void queryClient.invalidateQueries({ queryKey: leadStockKey(companyId) });
  else void queryClient.invalidateQueries({ queryKey: ["lead-stock"] });
}
