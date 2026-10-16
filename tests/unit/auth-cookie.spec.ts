import { expect, test } from "@playwright/test";
import { claimsAskAuthServer, jwtPayload, sessionFromCookies } from "../auth/auth-cookie";

// The auth cookie reader and the "does getClaims ask the auth server" rule that day7a.spec.ts uses to pick what
// "Sign out of all devices" guarantees for the other browser (HS256 locally, asymmetric keys in CI; README R2).
const part = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
const jwt = (header: object, payload: object = { exp: 1_800_000_000, session_id: "11111111-2222-3333-4444-555555555555" }) =>
  `${part(header)}.${part(payload)}.c2lnbmF0dXJl`;
const key = "sb-127-auth-token";

test("the auth server is asked for HS256, a missing algorithm or a missing key id; not for asymmetric keys", () => {
  expect(claimsAskAuthServer(jwt({ alg: "HS256", typ: "JWT" }))).toBe(true);
  expect(claimsAskAuthServer(jwt({ alg: "HS256", kid: "legacy", typ: "JWT" }))).toBe(true);
  expect(claimsAskAuthServer(jwt({ typ: "JWT" }))).toBe(true);
  expect(claimsAskAuthServer(jwt({ alg: "ES256", typ: "JWT" }))).toBe(true);
  // The Supabase CLI stack and hosted Supabase: verified locally, valid until it expires.
  expect(claimsAskAuthServer(jwt({ alg: "ES256", kid: "b81269f1", typ: "JWT" }))).toBe(false);
  expect(claimsAskAuthServer(jwt({ alg: "RS256", kid: "b81269f1", typ: "JWT" }))).toBe(false);
  expect(() => claimsAskAuthServer("not-a-jwt")).toThrow();
});

test("the session is read from a plain, a base64- and a chunked auth cookie", () => {
  const session = { access_token: jwt({ alg: "ES256", kid: "k" }), refresh_token: "r3fr35h" };
  const json = JSON.stringify(session);
  const encoded = `base64-${Buffer.from(json).toString("base64url")}`;
  expect(sessionFromCookies([{ name: key, value: json }])).toEqual(session);
  expect(sessionFromCookies([{ name: "locale", value: "fr" }, { name: key, value: encoded }])).toEqual(session);
  // Chunks in any order are joined by their index (10 after 9, not after 1).
  const pieces = encoded.match(/.{1,7}/g)!;
  expect(pieces.length).toBeGreaterThan(10);
  const chunked = pieces.map((value, i) => ({ name: `${key}.${i}`, value })).reverse();
  expect(sessionFromCookies(chunked)).toEqual(session);
  expect(jwtPayload(sessionFromCookies(chunked).access_token).session_id).toBe("11111111-2222-3333-4444-555555555555");
  expect(() => sessionFromCookies([{ name: "locale", value: "fr" }])).toThrow("no auth cookie");
});
