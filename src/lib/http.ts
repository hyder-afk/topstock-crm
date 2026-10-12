// Small request checks for route handlers that change something (Day 4 design 4.2 and threat 28). Server actions carry
// Next.js's own Origin check; a route handler has to do it itself.

/**
 * True when the request comes from a page of this app: its Origin header names this host (the host the request was
 * sent to, `x-forwarded-host` first, as Next.js compares for server actions), or, when a browser sends no Origin, its
 * Sec-Fetch-Site header says same-origin. A request with neither is refused: every browser this app supports sends at
 * least one of them on a POST.
 */
export function assertSameOrigin(headers: Headers): boolean {
  const host = (headers.get("x-forwarded-host") ?? headers.get("host") ?? "").split(",")[0].trim().toLowerCase();
  const origin = headers.get("origin");
  if (origin !== null) {
    if (!host || origin === "null") return false;
    try {
      return new URL(origin).host.toLowerCase() === host;
    } catch {
      return false;
    }
  }
  return headers.get("sec-fetch-site") === "same-origin";
}

export type JsonBody = { ok: true; value: unknown } | { ok: false; status: 400 | 413 | 415 };

/**
 * Reads a small JSON body: the Content-Type must be application/json (a form post from another site cannot send it
 * without a preflight), at most `maxBytes` (Content-Length first, then the bytes actually read), and it must parse.
 * An empty body reads as `{}`.
 */
export async function readJsonBody(request: Request, maxBytes: number): Promise<JsonBody> {
  const type = (request.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
  if (type !== "application/json") return { ok: false, status: 415 };
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > maxBytes) return { ok: false, status: 413 };
  let text: string;
  try {
    text = await request.text();
  } catch {
    return { ok: false, status: 400 };
  }
  if (new TextEncoder().encode(text).length > maxBytes) return { ok: false, status: 413 };
  if (text.trim() === "") return { ok: true, value: {} };
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false, status: 400 };
  }
}

/** Headers for answers that hold someone's data: never stored by a browser or a shared cache. */
export const noStore = { "Cache-Control": "private, no-store" } as const;
