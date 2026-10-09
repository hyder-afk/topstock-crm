import { createHmac } from "node:crypto";

// RFC 6238 TOTP (SHA-1, 6 digits, 30 s), the same maths an authenticator app does.
function base32Decode(input: string) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const c of input.replace(/[\s=]/g, "").toUpperCase()) {
    const i = alphabet.indexOf(c);
    if (i < 0) throw new Error("not base32");
    value = (value << 5) | i;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out.push((value >>> bits) & 0xff);
      value &= (1 << bits) - 1;
    }
  }
  return Buffer.from(out);
}

export function totp(secret: string, now = Date.now()) {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(now / 30_000)));
  const h = createHmac("sha1", base32Decode(secret)).update(counter).digest();
  const offset = h[h.length - 1] & 0x0f;
  return ((h.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).toString().padStart(6, "0");
}

// A code is single-use per 30 s window, so wait for the next window before reusing the authenticator.
export async function nextWindow() {
  await new Promise((r) => setTimeout(r, 30_000 - (Date.now() % 30_000) + 1_000));
}

function env(name: string) {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set (see playwright.auth.config.ts)`);
  // These helpers send the local stack's service key: refuse anything that is not this machine.
  if (name.endsWith("_URL") && !["127.0.0.1", "localhost"].includes(new URL(v).hostname)) {
    throw new Error(`${name} must point at a local stack (127.0.0.1 or localhost)`);
  }
  return v;
}

// Local stack only: invite a user the way an admin does from the Supabase dashboard.
export async function invite(email: string) {
  const key = env("SUPABASE_LOCAL_SERVICE_ROLE_KEY");
  const res = await fetch(`${env("SUPABASE_LOCAL_URL")}/auth/v1/invite`, {
    method: "POST",
    headers: {
      apikey: key,
      // Legacy JWT-style keys also go in Authorization; new sb_secret_ keys travel in apikey only.
      ...(key.startsWith("eyJ") ? { Authorization: `Bearer ${key}` } : {}),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ email }),
  });
  if (!res.ok) throw new Error(`invite failed: ${res.status}`);
}

// Reads the newest email to this address from the local Mailpit inbox and returns the /auth/confirm path in it.
export async function confirmPathFromEmail(email: string, type: "invite" | "recovery", after = 0) {
  const mailpit = env("MAILPIT_URL");
  for (let attempt = 0; attempt < 30; attempt++) {
    const search = await fetch(`${mailpit}/api/v1/search?query=${encodeURIComponent(`to:"${email}"`)}`);
    const { messages = [] } = (await search.json()) as { messages?: { ID: string; Created: string }[] };
    for (const m of messages) {
      if (Date.parse(m.Created) < after) continue;
      const html = ((await (await fetch(`${mailpit}/api/v1/message/${m.ID}`)).json()) as { HTML: string }).HTML;
      const href = html.match(/href="([^"]*\/auth\/confirm\?[^"]*)"/)?.[1]?.replace(/&amp;/g, "&");
      if (!href) continue;
      const url = new URL(href);
      if (url.searchParams.get("type") === type) return `${url.pathname}${url.search}`;
    }
    await new Promise((r) => setTimeout(r, 1_000));
  }
  throw new Error(`no ${type} email for ${email}`);
}

async function authFetch(path: string, init: { method?: string; token?: string; body?: unknown; admin?: boolean }) {
  const key = init.admin ? env("SUPABASE_LOCAL_SERVICE_ROLE_KEY") : env("NEXT_PUBLIC_SUPABASE_ANON_KEY");
  const bearer = init.token ?? (key.startsWith("eyJ") ? key : undefined);
  const res = await fetch(`${env("SUPABASE_LOCAL_URL")}/auth/v1${path}`, {
    method: init.method ?? "POST",
    headers: { apikey: key, ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}), "Content-Type": "application/json" },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  if (!res.ok) throw new Error(`${path} failed: ${res.status} ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

// Local stack only: a confirmed user with a password, optionally with a verified authenticator. Returns its TOTP secret.
export async function createUser(email: string, password: string, withAuthenticator: boolean) {
  await authFetch("/admin/users", { admin: true, body: { email, password, email_confirm: true } });
  if (!withAuthenticator) return "";
  const { access_token } = await authFetch("/token?grant_type=password", { body: { email, password } });
  const factor = await authFetch("/factors", { token: access_token, body: { factor_type: "totp", friendly_name: "e2e", issuer: "TopStock CRM" } });
  const challenge = await authFetch(`/factors/${factor.id}/challenge`, { token: access_token, body: {} });
  await authFetch(`/factors/${factor.id}/verify`, {
    token: access_token,
    body: { challenge_id: challenge.id, code: totp(factor.totp.secret) },
  });
  return factor.totp.secret as string;
}

// Tries a public sign-up with the publishable key; returns the HTTP status and Supabase's error code.
export async function trySignup(email: string, password: string) {
  const key = env("NEXT_PUBLIC_SUPABASE_ANON_KEY");
  const res = await fetch(`${env("SUPABASE_LOCAL_URL")}/auth/v1/signup`, {
    method: "POST",
    headers: { apikey: key, ...(key.startsWith("eyJ") ? { Authorization: `Bearer ${key}` } : {}), "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  const body = (await res.json().catch(() => ({}))) as { error_code?: string; code?: string };
  return { status: res.status, code: body.error_code ?? body.code };
}

// Signs in through the UI (password, then the TOTP code in a fresh window) and returns the aal2 session state.
export async function fullSession(browser: import("@playwright/test").Browser, email: string, password: string, secret: string) {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL(/\/mfa$/);
  await nextWindow();
  await page.getByLabel("6-digit code").fill(totp(secret));
  await page.getByRole("button", { name: "Verify" }).click();
  await page.waitForURL((url) => url.pathname === "/");
  const state = await context.storageState();
  await context.close();
  return state;
}
