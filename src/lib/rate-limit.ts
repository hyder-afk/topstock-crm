import { NextResponse } from "next/server";
import { noStore } from "@/lib/http";

// Per-person limit on the search and list APIs (Gate 1 item 28; Day 7a): leads search and the lead pickers
// (/api/leads), the pipeline board, columns and summary, and the Tasks lists. A sliding window per server instance, keyed
// by the signed-in person's id (from the verified JWT, never from the request), in a Map capped at 5,000 keys (least
// recently used out first). It stops a script with a stolen session from paging through every lead at full speed; the
// database guards on writes and the auth server's own limits stay as they are. Per instance, so a burst spread over
// several Vercel instances gets more; the Vercel Firewall rule (Day 8) is the platform-wide layer. Nothing is stored or
// logged. Day 6e has a per-IP limiter for the public share pages (src/lib/share/rate-limit.ts on its branch): the two
// are unified at the Day 6 merge.

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
