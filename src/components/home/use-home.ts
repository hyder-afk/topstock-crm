"use client";

import { keepPreviousData, useQuery, type QueryClient } from "@tanstack/react-query";
import {
  HOME_REFRESH_MS,
  HOME_SCOPE_COOKIE,
  HOME_STALE_MS,
  homeScopes,
  type HomeData,
  type HomeScope,
  type QueueSummary,
} from "@/lib/home";

// Home's data in the query cache (Day 5 design 7.10, D31, D32). ['home', scope] holds every part: seeded from the
// server's first paint (or the dock's prefetch), fresh for 30 s, refetched on focus and every 60 s while the tab is
// visible, and invalidated by deal, task and outcome writes (they invalidate ['home']). The queue count loads after
// paint as ['queue', 'summary'].

export const homeKey = (scope: HomeScope) => ["home", scope] as const;
export const queueSummaryKey = ["queue", "summary"] as const;

export async function fetchHomeClient(scope: HomeScope): Promise<HomeData> {
  const res = await fetch(`/api/home?scope=${scope}`, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(String(res.status));
  return (await res.json()) as HomeData;
}

export function useHome(scope: HomeScope, initial: HomeData | undefined) {
  return useQuery({
    queryKey: homeKey(scope),
    queryFn: () => fetchHomeClient(scope),
    initialData: initial,
    initialDataUpdatedAt: initial?.at,
    staleTime: HOME_STALE_MS,
    refetchOnWindowFocus: true,
    refetchInterval: HOME_REFRESH_MS, // paused while the tab is hidden (refetchIntervalInBackground is off)
    placeholderData: keepPreviousData, // switching scope keeps the old figures until the new ones land
  });
}

export function useQueueSummary() {
  return useQuery({
    queryKey: queueSummaryKey,
    queryFn: async (): Promise<QueueSummary> => {
      const res = await fetch("/api/queue/summary", { headers: { accept: "application/json" } });
      if (!res.ok) throw new Error(String(res.status));
      return (await res.json()) as QueueSummary;
    },
    staleTime: HOME_STALE_MS,
    refetchOnWindowFocus: true,
    retry: false,
  });
}

/** The scope this device remembers (D28), read from its cookie in the browser; undefined when none is saved. */
export function rememberedScope(): HomeScope | undefined {
  try {
    const raw = document.cookie.split("; ").find((c) => c.startsWith(`${HOME_SCOPE_COOKIE}=`))?.split("=")[1];
    return homeScopes.find((s) => s === raw);
  } catch {
    return undefined;
  }
}

/** Remembers the scope on this device for a year (a preference, not a secret; the server re-checks every request). */
export function rememberScope(scope: HomeScope) {
  try {
    document.cookie = `${HOME_SCOPE_COOKIE}=${scope}; path=/; max-age=31536000; samesite=lax${location.protocol === "https:" ? "; secure" : ""}`;
  } catch {
    // Cookies blocked: the switch still works for this visit.
  }
}

/** Warms Home for the remembered scope (dock hover or focus on Home), so the route change renders from the cache. */
export function prefetchHome(queryClient: QueryClient) {
  const scope = rememberedScope();
  if (!scope) return; // the first Home visit writes it; until then the page's own first paint is used
  void queryClient.prefetchQuery({ queryKey: homeKey(scope), queryFn: () => fetchHomeClient(scope), staleTime: HOME_STALE_MS });
}
