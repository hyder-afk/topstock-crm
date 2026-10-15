import { createHash, randomBytes } from "node:crypto";

// The per-IP limiter of the public routes (design 8.7): a sliding window per server instance, keyed by
// sha256(ip + a random salt that rotates daily), truncated to 16 bytes, in a Map capped at 5,000 keys (least recently
// used out first). Nothing is stored or logged; the database's per-link limits are the real guard. Unit-tested.

export type Limiter = { take: (ip: string, now?: number) => boolean; size: () => number };

export function createLimiter({ windowMs, max, cap = 5000 }: { windowMs: number; max: number; cap?: number }): Limiter {
  const hits = new Map<string, number[]>();
  let salt = randomBytes(16);
  let saltDay = -1;
  const keyOf = (ip: string, now: number) => {
    const day = Math.floor(now / 86_400_000);
    if (day !== saltDay) {
      salt = randomBytes(16);
      saltDay = day;
      hits.clear(); // the old keys cannot be recomputed after a rotation
    }
    return createHash("sha256").update(salt).update(ip).digest("base64url").slice(0, 22);
  };
  return {
    take(ip, now = Date.now()) {
      const key = keyOf(ip, now);
      const recent = (hits.get(key) ?? []).filter((t) => t > now - windowMs);
      hits.delete(key); // re-inserted below: Map order is the LRU order
      if (recent.length >= max) {
        hits.set(key, recent);
        return false;
      }
      recent.push(now);
      hits.set(key, recent);
      while (hits.size > cap) hits.delete(hits.keys().next().value as string);
      return true;
    },
    size: () => hits.size,
  };
}

/** The client's address as the platform reports it (Vercel sets x-forwarded-for); one shared key when it is absent. */
export function clientIp(headers: Headers): string {
  const first = headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return first && first.length <= 64 ? first : "unknown";
}
