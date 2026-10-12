// The client link's secret (design 8.3): "tss_" and 43 base64url characters (256 bits), carried in the URL fragment so
// it never reaches a server log, a Referer header or a link preview. Pure; unit-tested.

export const TOKEN_RE = /^tss_[A-Za-z0-9_-]{43}$/;

/** The token in `location.hash` ("#tss_…" or "tss_…"), or null when anything else is there. */
export function tokenFromHash(hash: string | null | undefined): string | null {
  if (typeof hash !== "string") return null;
  const raw = hash.startsWith("#") ? hash.slice(1) : hash;
  return TOKEN_RE.test(raw) ? raw : null;
}

/** The address a teammate sends: `${origin}/s/${language}#${token}`; null for a bad origin or token. */
export function shareUrl(origin: string, language: "en" | "fr", token: string): string | null {
  if (!TOKEN_RE.test(token) || !/^https?:\/\/[A-Za-z0-9.-]+(:\d{1,5})?$/.test(origin)) return null;
  return `${origin}/s/${language}#${token}`;
}
