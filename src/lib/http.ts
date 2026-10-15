// Small request checks for route handlers that change something (Day 4 design 4.2 and threat 28). Server actions carry
// Next.js's own Origin check; a route handler has to do it itself. One module for the work queue's routes (Day 4c) and
// the client stock link's anonymous routes (Day 6e, design 8.6); both read bodies through the same byte cap.

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
 * without a preflight), at most `maxBytes` (Content-Length first, then the bytes actually read: the stream is read
 * chunk by chunk and cancelled as soon as it passes the cap, so a body sent without a Content-Length, or with a false
 * one, is never held in full), it must be UTF-8 and it must parse. An empty body reads as `{}`.
 */
export async function readJsonBody(request: Request, maxBytes: number): Promise<JsonBody> {
  const type = (request.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
  if (type !== "application/json") return { ok: false, status: 415 };
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > maxBytes) return { ok: false, status: 413 };
  const bytes = await readCapped(request, maxBytes);
  if (bytes === "too_big") return { ok: false, status: 413 };
  if (bytes === "unreadable") return { ok: false, status: 400 };
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return { ok: false, status: 400 };
  }
  if (text.trim() === "") return { ok: true, value: {} };
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false, status: 400 };
  }
}

/** The body's bytes, at most `maxBytes` of them: reading stops (and the stream is cancelled) past the cap. */
async function readCapped(request: Request, maxBytes: number): Promise<Uint8Array | "too_big" | "unreadable"> {
  if (!request.body) return new Uint8Array(0);
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    const reader = request.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel().catch(() => undefined);
        return "too_big";
      }
      chunks.push(value);
    }
  } catch {
    return "unreadable";
  }
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    bytes.set(c, at);
    at += c.byteLength;
  }
  return bytes;
}

/** Headers for answers that hold someone's data: never stored by a browser or a shared cache. */
export const noStore = { "Cache-Control": "private, no-store" } as const;
