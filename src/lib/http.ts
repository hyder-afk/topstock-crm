// Small request guards for route handlers (Day 4 signature; 6e adds it here because Day 4c is not merged yet):
// assertSameOrigin refuses a cross-site POST (Origin must equal this site), readJsonCapped reads at most `max` bytes of
// a JSON body (a bigger body is refused before it is parsed). Pure apart from reading the request; unit-tested.

/** True when the request's Origin header is this site's own origin (a browser always sends it on a POST). */
export function assertSameOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return false;
  const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host");
  if (!host) return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

export type CappedJson = { ok: true; value: unknown } | { ok: false; status: 400 | 413 | 415 };

/** The JSON body, read with a byte cap: 415 for another content type, 413 over the cap, 400 for bad JSON. */
export async function readJsonCapped(request: Request, max: number): Promise<CappedJson> {
  const type = (request.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
  if (type !== "application/json") return { ok: false, status: 415 };
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > max) return { ok: false, status: 413 };
  if (!request.body) return { ok: false, status: 400 };
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => undefined);
      return { ok: false, status: 413 };
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    bytes.set(c, at);
    at += c.byteLength;
  }
  try {
    return { ok: true, value: JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) };
  } catch {
    return { ok: false, status: 400 };
  }
}
