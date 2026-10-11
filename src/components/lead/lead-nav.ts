"use client";

import type { InfiniteData, QueryClient } from "@tanstack/react-query";
import type { LeadPage } from "@/lib/leads";

// Moving between the leads list and a lead page (Day 4 design 7.1): Back returns to the same list URL and scroll
// position, and J/K walk the same filtered list. The list's URL, query key and scroll position are kept for this tab
// in sessionStorage (a per-viewer convenience, in try/catch: storage can be blocked, and the page works without it).
const RETURN_KEY = "topstock.leads.return";

export type ListReturn = { url: string; key: string; scroll: number };

function isReturn(v: unknown): v is ListReturn {
  if (!v || typeof v !== "object") return false;
  const r = v as Record<string, unknown>;
  return typeof r.url === "string" && r.url.startsWith("/leads") && !r.url.startsWith("//") && typeof r.key === "string" && typeof r.scroll === "number";
}

export function saveListReturn(r: ListReturn) {
  try {
    window.sessionStorage.setItem(RETURN_KEY, JSON.stringify(r));
  } catch {
    // Storage blocked: Back goes to the plain list.
  }
}

export function readListReturn(): ListReturn | null {
  try {
    const parsed: unknown = JSON.parse(window.sessionStorage.getItem(RETURN_KEY) ?? "null");
    return isReturn(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** The scroll position to restore on the list at `url` (once: it is cleared when read). */
export function takeListScroll(url: string): number | null {
  const r = readListReturn();
  if (!r || r.url !== url || r.scroll <= 0) return null;
  saveListReturn({ ...r, scroll: 0 });
  return r.scroll;
}

/**
 * The leads before and after this one in the list it was opened from, read from that list's cached pages (nothing is
 * fetched). Null after a deep link or once the cache is gone: J/K and "3 of 1,204" are then hidden.
 */
export function listNeighbours(queryClient: QueryClient, leadId: string) {
  const r = readListReturn();
  if (!r) return null;
  const data = queryClient.getQueryData<InfiniteData<LeadPage>>(["leads", r.key]);
  if (!data) return null;
  const rows = data.pages.flatMap((p) => p.rows);
  const index = rows.findIndex((row) => row.id === leadId);
  if (index < 0) return null;
  return {
    index,
    total: data.pages[0]?.total ?? rows.length,
    previous: rows[index - 1]?.id ?? null,
    next: rows[index + 1]?.id ?? null,
    backUrl: r.url,
  };
}
