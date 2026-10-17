"use client";

import { createContext, startTransition, use, useCallback, useContext, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { AnalyticsData, AnalyticsRole } from "@/lib/analytics/fetch";
import { analyticsKey } from "@/lib/analytics/key";
import { filtersToSearch, type AnalyticsFilters } from "@/lib/analytics/view";
import { useAnalytics } from "@/components/analytics/use-analytics";

// The page's filter state (design 2): the presets, the custom dates and the person, kept in the URL with
// history.replaceState (Next keeps useSearchParams in sync; no Back entries; a reload or a shared link restores the
// view, because the server parses the same URL). The body renders the server's filters until it has mounted, then the
// chosen ones (Home's rule: a tap before the streamed body hydrated must not make React hydrate it with other data,
// which would throw its server HTML away).

type Initial = { search: string; promise: Promise<AnalyticsData | null> };
type Ctx = {
  /** What the filter row shows: the person's choice at once. */
  filters: AnalyticsFilters;
  /** What the body renders: the server's filters until the body has mounted, then the chosen ones. */
  viewFilters: AnalyticsFilters;
  setFilters: (next: AnalyticsFilters) => void;
  bodyMounted: () => void;
  initial: Initial;
  role: AnalyticsRole;
  /** The signed-in person's id (from the verified session): whose own figures "Right now" links to. */
  self: string;
  /** The Paris date today on the server (the custom picker's last day). */
  today: string;
};

const AnalyticsContext = createContext<Ctx | null>(null);

export function useAnalyticsFilters(): Ctx {
  const v = useContext(AnalyticsContext);
  if (!v) throw new Error("useAnalyticsFilters outside AnalyticsProvider");
  return v;
}

export function AnalyticsProvider({
  initialFilters,
  promise,
  role,
  self,
  today,
  children,
}: {
  initialFilters: AnalyticsFilters;
  promise: Promise<AnalyticsData | null>;
  role: AnalyticsRole;
  self: string;
  today: string;
  children: React.ReactNode;
}) {
  const [filters, setState] = useState(initialFilters);
  const [ready, setReady] = useState(false);
  const bodyMounted = useCallback(() => setReady(true), []);
  const setFilters = useCallback((next: AnalyticsFilters) => {
    // A transition: the new figures may suspend without hiding what is on screen.
    startTransition(() => setState(next));
    const search = filtersToSearch(next);
    window.history.replaceState(window.history.state, "", `${window.location.pathname}${search ? `?${search}` : ""}`);
  }, []);
  const initial = useMemo(() => ({ search: filtersToSearch(initialFilters), promise }), [initialFilters, promise]);
  const value = useMemo(
    () => ({ filters, viewFilters: ready ? filters : initialFilters, setFilters, bodyMounted, initial, role, self, today }),
    [filters, ready, initialFilters, setFilters, bodyMounted, initial, role, self, today],
  );
  return <AnalyticsContext.Provider value={value}>{children}</AnalyticsContext.Provider>;
}

/**
 * The figures for the view on screen, cache first (D32): the query cache's entry when a prefetch or an earlier visit
 * warmed it, otherwise the server's promise (read with use() under the page's Suspense) for the view it rendered.
 */
export function useAnalyticsView() {
  const { viewFilters, initial } = useAnalyticsFilters();
  const qc = useQueryClient();
  const search = filtersToSearch(viewFilters);
  const cached = qc.getQueryData<AnalyticsData>(analyticsKey(search));
  const first = cached ?? (search === initial.search ? use(initial.promise) : null) ?? undefined;
  const query = useAnalytics(search, first);
  return { search, query, data: query.data };
}
