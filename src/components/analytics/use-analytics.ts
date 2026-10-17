"use client";

import { useRef } from "react";
import { keepPreviousData, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import type { AnalyticsData } from "@/lib/analytics/fetch";
import { analyticsKey } from "@/lib/analytics/key";

// Analytics in the query cache (design 3.6). One entry per view, keyed by its canonical query string: seeded from the
// server's first paint (or a prefetch), fresh for 60 s, never refetched on focus or on a timer (analytics should not
// jitter). A filter change keeps the old frame (placeholderData) until the new figures land. No retries, with one
// exception: a 429 from the per-person limiter keeps the old frame and retries once, after Retry-After.

export const ANALYTICS_STALE_MS = 60_000;
/** A prefetch waits for the pointer (or focus) to rest this long, so passing over a preset sends nothing. */
export const PREFETCH_DELAY_MS = 150;

/** The limiter said "too many": the seconds it asked to wait (Retry-After). */
export class RateLimited extends Error {
  constructor(readonly seconds: number) {
    super("429");
  }
}

export async function fetchAnalyticsClient(search: string): Promise<AnalyticsData> {
  const res = await fetch(`/api/analytics${search ? `?${search}` : ""}`, { headers: { accept: "application/json" } });
  if (!res.ok) {
    await res.text().catch(() => ""); // read the error body, so the request completes (and the connection is freed)
    if (res.status === 429) {
      const after = Number(res.headers.get("retry-after"));
      throw new RateLimited(Number.isFinite(after) && after > 0 ? Math.min(Math.ceil(after), 120) : 30);
    }
    throw new Error(String(res.status));
  }
  return (await res.json()) as AnalyticsData;
}

export function useAnalytics(search: string, initial: AnalyticsData | undefined) {
  return useQuery({
    queryKey: analyticsKey(search),
    queryFn: () => fetchAnalyticsClient(search),
    initialData: initial,
    initialDataUpdatedAt: initial?.at,
    staleTime: ANALYTICS_STALE_MS,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    placeholderData: keepPreviousData,
    retry: (failures, error) => error instanceof RateLimited && failures < 1,
    retryDelay: (_, error) => (error instanceof RateLimited ? error.seconds * 1000 : 0),
  });
}

/** Warms one view (a fresh or in-flight entry is not fetched again; prefetches never retry). */
export function prefetchAnalytics(queryClient: QueryClient, search: string) {
  // A view already loading, or one that just failed (a 429 waiting out its Retry-After), is left alone.
  const state = queryClient.getQueryState(analyticsKey(search));
  if (state && (state.fetchStatus !== "idle" || state.status === "error")) return;
  void queryClient.prefetchQuery({
    queryKey: analyticsKey(search),
    queryFn: () => fetchAnalyticsClient(search),
    staleTime: ANALYTICS_STALE_MS,
    retry: false,
  });
}

/** The dock warms the default view only: 30 days, the person's own figures or the team's by role (the server decides). */
export function prefetchAnalyticsDefault(queryClient: QueryClient) {
  prefetchAnalytics(queryClient, "");
}

/**
 * A delayed prefetch: starts after the pointer or focus has rested PREFETCH_DELAY_MS on the target; leaving or pressing
 * earlier cancels it. Returns the handlers to spread on the target.
 */
export function delayedPrefetch(run: () => void) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const start = () => {
    clearTimeout(timer);
    timer = setTimeout(run, PREFETCH_DELAY_MS);
  };
  const cancel = () => clearTimeout(timer);
  // A press is the real request: the warm-up is not needed any more.
  return { onPointerEnter: start, onPointerLeave: cancel, onPointerDown: cancel, onFocus: start, onBlur: cancel };
}

/** Stable delayed-prefetch handlers per view (one timer per target across renders), for the filter row's presets. */
export function useViewWarmers() {
  const qc = useQueryClient();
  const handlers = useRef(new Map<string, ReturnType<typeof delayedPrefetch>>());
  return (search: string) => {
    let h = handlers.current.get(search);
    if (!h) {
      h = delayedPrefetch(() => prefetchAnalytics(qc, search));
      handlers.current.set(search, h);
    }
    return h;
  };
}
