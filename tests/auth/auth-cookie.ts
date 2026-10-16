// Pure helpers for the Supabase auth cookie a test browser holds (no Playwright, no network), so the unit suite can
// check them too (tests/unit/auth-cookie.spec.ts).

type Cookie = { name: string; value: string };

/** The auth cookie's name without its chunk suffix (sb-<ref>-auth-token), and its cookies (whole, or .0, .1, ...). */
export function authCookies<C extends Cookie>(cookies: C[]) {
  const auth = cookies.filter((c) => /^sb-.+-auth-token(\.\d+)?$/.test(c.name));
  if (auth.length === 0) throw new Error("no auth cookie in this browser");
  const key = auth[0].name.replace(/\.\d+$/, "");
  if (!/^sb-[a-z0-9-]+-auth-token$/.test(key)) throw new Error(`unexpected auth cookie ${key}`);
  return { key, cookies: auth.filter((c) => c.name === key || c.name.startsWith(`${key}.`)) };
}

/**
 * The session JSON in the auth cookie, in the format @supabase/ssr writes: plain JSON or "base64-" + base64url JSON,
 * whole or split into .0, .1, ... (joined in index order).
 */
export function sessionFromCookies(cookies: Cookie[]): { access_token: string; refresh_token: string } {
  const { key, cookies: auth } = authCookies(cookies);
  const whole = auth.find((c) => c.name === key);
  const raw =
    whole?.value ??
    auth
      .map((c) => ({ i: Number(c.name.slice(key.length + 1)), value: c.value }))
      .sort((a, b) => a.i - b.i)
      .map((c) => c.value)
      .join("");
  return JSON.parse(raw.startsWith("base64-") ? Buffer.from(raw.slice(7), "base64url").toString("utf8") : raw);
}

function jwtPart(token: string, index: 0 | 1) {
  const part = token.split(".")[index];
  if (!part) throw new Error("not a JWT");
  return JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as Record<string, unknown>;
}

export const jwtHeader = (token: string) => jwtPart(token, 0) as { alg?: string; kid?: string };
export const jwtPayload = (token: string) => jwtPart(token, 1) as { exp?: number; iat?: number; session_id?: string };

/**
 * Whether the app's getClaims asks the auth server about this access token (so a session ended elsewhere is refused at
 * once), with the same rule as @supabase/auth-js getClaims: a symmetric algorithm (HS256, the local stack), no
 * algorithm or no key id. Otherwise (asymmetric signing keys: the Supabase CLI stack in CI and hosted Supabase) the
 * token verifies locally and stays valid until it expires (docs/evidence/day7a/README.md, R2).
 */
export function claimsAskAuthServer(accessToken: string) {
  const { alg, kid } = jwtHeader(accessToken);
  return !alg || alg.startsWith("HS") || !kid;
}
