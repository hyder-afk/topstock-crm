import { NextResponse } from "next/server";
import { noStore } from "@/lib/http";

// Per-person limit on the search and list APIs (Gate 1 item 28; Day 7a): leads search and the lead pickers
// (/api/leads), the pipeline board, columns and summary, the Tasks lists, the lead page's list tabs, the two import
// issue lists and Day 6's inventory lists (the full list and the routes left out: tests/unit/rate-limit.spec.ts). A
// sliding window per server instance, keyed by the signed-in person's id (from the verified JWT, never from the
// request), in a Map capped at 5,000 keys (least recently used out first). A speed bump against a runaway client or
// casual scripting of these routes, NOT scrape protection: a signed-in session can read public.companies straight from
// PostgREST (RLS and max_rows 1000 per request are the only limits there), so a stolen session never needs these
// routes. Per server instance: on Vercel each function instance has its own window and a cold start resets it. The real
// layers are two-factor sign-in, the Vercel Firewall rule (Day 8) and, later, an RPC-only read path
// (docs/evidence/day7a/README.md, residuals). Nothing is stored or logged.

export type UserLimiter = {
  /** Records one request; answers 0 when it may go ahead, else the seconds until the next one may. */
  take: (userId: string, now?: number) => number;
  size: () => number;
};

export function createUserLimiter({ windowMs, max, cap = 5000 }: { windowMs: number; max: number; cap?: number }): UserLimiter {
  const hits = new Map<string, number[]>();
  return {
    take(userId, now = Date.now()) {
      const recent = (hits.get(userId) ?? []).filter((t) => t > now - windowMs);
      hits.delete(userId); // re-inserted below: Map order is the least-recently-used order
      if (recent.length >= max) {
        hits.set(userId, recent);
        return Math.max(1, Math.ceil((recent[0] + windowMs - now) / 1000));
      }
      recent.push(now);
      hits.set(userId, recent);
      while (hits.size > cap) hits.delete(hits.keys().next().value as string);
      return 0;
    },
    size: () => hits.size,
  };
}

// 300 list requests a minute per person across these APIs: about five a second, well above a person scrolling,
// typing in a picker or moving between pipeline columns (a page is 50 rows).
export const LIST_LIMIT = { windowMs: 60_000, max: 300 } as const;
const listLimiter = createUserLimiter(LIST_LIMIT);

/** null when the request may go ahead; otherwise the 429 answer (a generic code, no detail). */
export function listRateLimited(userId: string, limiter: UserLimiter = listLimiter): NextResponse | null {
  const wait = limiter.take(userId);
  if (wait === 0) return null;
  return NextResponse.json({ error: "rate_limited" }, { status: 429, headers: { ...noStore, "Retry-After": String(wait) } });
}

// Analytics (design 3.6): 30 reads a minute per person on GET /api/analytics, its own window. Each read runs seven
// aggregate functions over up to a year of rows, so the cap is far lower than the list APIs'; the page prefetches a
// preset only after a 150 ms hover, once per fresh key, and keeps the last figures on a 429 (Retry-After).
export const ANALYTICS_LIMIT = { windowMs: 60_000, max: 30 } as const;
const analyticsLimiter = createUserLimiter(ANALYTICS_LIMIT);

/** null when the Analytics read may go ahead; otherwise the 429 answer (generic code, Retry-After, no detail). */
export function analyticsRateLimited(userId: string, limiter: UserLimiter = analyticsLimiter): NextResponse | null {
  return listRateLimited(userId, limiter);
}
