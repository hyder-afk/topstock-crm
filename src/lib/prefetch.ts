import type { QueryClient } from "@tanstack/react-query";
import type { Board, BoardOrder, DealCard, DealDetail } from "@/lib/deals";

// Cache-first routes (Day 5 design D32): Next 16 prefetches a dynamic route only up to its loading.tsx, so a route
// change under 200 ms needs the data already in the query cache. The dock warms the pipeline board on hover and focus;
// the page renders from the cache at once, or from the server's promise when the cache is empty.

/**
 * The board's cache key. The page asks for "team" by default; a rep silently gets their own deals (pipeline_board). The
 * order is the server's keyset order: "Longest in stage" is another first page, not the same cards re-sorted.
 */
export const boardKey = (scope: "team" | "mine", owner: string | null, order: BoardOrder = "recent") =>
  ["pipeline", "board", scope, owner, order] as const;
export const dealKey = (id: string) => ["deal", id] as const;
export const leadDealsKey = (leadId: string) => ["lead-deals", leadId] as const;

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(String(res.status));
  return (await res.json()) as T;
}

export function fetchBoardClient(scope: "team" | "mine", owner: string | null, order: BoardOrder = "recent"): Promise<Board> {
  const p = new URLSearchParams({ scope });
  if (owner) p.set("owner", owner);
  if (order === "oldest") p.set("order", order);
  return getJson<Board>(`/api/pipeline/board?${p}`);
}

export async function fetchDealClient(id: string): Promise<DealDetail | null> {
  const res = await fetch(`/api/deals/${id}`, { headers: { accept: "application/json" } });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(String(res.status));
  return (await res.json()) as DealDetail;
}

export function fetchLeadDealsClient(leadId: string): Promise<DealCard[]> {
  return getJson<DealCard[]>(`/api/leads/${leadId}/deals`);
}

/** Warms the pipeline's default board (dock hover or focus on Pipeline). Fresh data is kept for 30 s. */
export function prefetchPipeline(queryClient: QueryClient) {
  void queryClient.prefetchQuery({ queryKey: boardKey("team", null), queryFn: () => fetchBoardClient("team", null), staleTime: 30_000 });
}
