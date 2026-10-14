import { execFileSync } from "node:child_process";
import { createHmac } from "node:crypto";
import { expect, type BrowserContext, type Page, type Request } from "@playwright/test";
import { callZone, isOpen } from "../../src/lib/timezones";

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

// The signed-in page is interactive once React has hydrated: the dock has measured its sections (the bead shows), and
// two more frames let the remaining effects (the keyboard shortcuts) attach. Keys pressed earlier go nowhere; WebKit in
// CI and a 20x-throttled Chromium both showed it.
export async function appReady(page: Page) {
  await expect(page.getByTestId("dock-bead")).not.toHaveClass(/opacity-0/);
  await twoFrames(page);
}

// Motion writes motion-value changes to the page on the next animation frame (frameloop "render" step), so a position
// set in a React commit shows up one frame later. Waiting two frames (~33 ms) covers it.
export async function twoFrames(page: Page) {
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

// Requests each page has in flight, counted from the first call for that page (call it right after opening the page).
const inFlight = new WeakMap<Page, Set<Request>>();
export function trackRequests(page: Page) {
  let pending = inFlight.get(page);
  if (!pending) {
    const set = new Set<Request>();
    page.on("request", (r) => set.add(r));
    page.on("requestfinished", (r) => set.delete(r));
    page.on("requestfailed", (r) => set.delete(r));
    inFlight.set(page, set);
    pending = set;
  }
  return pending;
}

// Waits until the page has no request in flight. Leaving a page while a fetch is running (a link prefetch, a server
// action) makes WebKit log "Fetch API cannot load … due to access control checks", which the console-error checks
// would rightly count. `waitForLoadState("networkidle")` resolves at once when the document reached that state
// earlier, so it cannot wait for a request started later; the page's own request count can.
export async function settled(page: Page) {
  if (page.url() === "about:blank") return;
  const pending = trackRequests(page);
  await expect.poll(() => pending.size, { timeout: 15_000 }).toBe(0);
}

// WebKit reports a fetch the page itself cancelled as "Fetch API cannot load <url> due to access control checks" (as a
// console error, or as an uncaught page error when the fetch's promise is not awaited). Next.js
// cancels its own link prefetches (requests to this app with ?_rsc=) when a server action refreshes the page or a new
// navigation starts; Chromium logs nothing for that. Only that exact case is ignored: same-origin RSC requests cannot
// fail a real access-control check, and every other console error still counts.
const cancelledPrefetch = /^(?:Fetch API cannot load )?(?:http:)?\/\/?localhost:3100\/[^\s?]*\?_rsc=[\w-]+ due to access control checks\.$/;
export function isCancelledPrefetch(text: string) {
  return cancelledPrefetch.test(text);
}

// Local stack only: runs SQL as the throwaway database's superuser, for fixtures the app cannot create on its own
// (fixed roles, many fake leads). SUPABASE_LOCAL_DB_URL must point at 127.0.0.1 or localhost (env() refuses others).
export function sql(query: string) {
  return execFileSync("psql", [env("SUPABASE_LOCAL_DB_URL"), "-X", "-q", "-A", "-t", "-v", "ON_ERROR_STOP=1", "-c", query], {
    encoding: "utf8",
  }).trim();
}

const testEmail = /^[a-z0-9.-]+@example\.test$/;
function emailLiteral(email: string) {
  if (!testEmail.test(email)) throw new Error(`not a test address: ${email}`);
  return `'${email}'`;
}

export function setRole(email: string, role: "admin" | "manager" | "rep") {
  sql(`update public.profiles set role = '${role}' where id = (select id from auth.users where email = ${emailLiteral(email)})`);
}

// Replaces every lead with `count` made-up companies (names from fixed word lists, @example.com emails, +33 6 00
// numbers), owned in turn by the given test users, with a contact on every third one. Deals go first: a deal keeps its
// lead (deals_company_id_fkey has no cascade), so earlier specs' made-up deals would block the reset.
export function seedLeads(ownerEmails: string[], count = 120) {
  const owners = ownerEmails.map(emailLiteral).join(", ");
  sql(`
    delete from public.deals;
    delete from public.companies;
    with o as (select array_agg(p.id order by u.email) as ids, min(p.org_id::text)::uuid as org
               from public.profiles p join auth.users u on u.id = p.id where u.email in (${owners})),
    w as (select array['Atelier','Comptoir','Maison','Brasserie','Distribution','Halles','Épicerie','Société'] as pre,
                 array['Verdane','Nordlys','Brécy','Altamar','Corvel','Lunéa','Marsac','Ophir','Tessan','Valmont',
                       'Ysor','Quillan','Ardent','Belmar','Cazal','Dorval'] as nm,
                 array['cold','warm','negotiation','customer','cool_off','do_not_contact','disqualified'] as st,
                 array['FR','BE','MA','ES','DE','FR','FR'] as co,
                 array['Lyon','Bruxelles','Casablanca','Valencia','Köln','Marseille','Lille'] as ci)
    insert into public.companies (org_id, name, owner_id, lead_status, phone, email, city, country, last_activity_at, created_at)
    select o.org, w.pre[i % 8 + 1] || ' ' || w.nm[i / 8 % 16 + 1], o.ids[i % cardinality(o.ids) + 1], w.st[(i * 3) % 7 + 1],
           '+33 6 00 00 ' || lpad((i % 100)::text, 2, '0') || ' ' || lpad(((i * 7) % 100)::text, 2, '0'),
           'contact' || i || '@example.com', w.ci[i % 7 + 1], w.co[i % 7 + 1],
           case when i % 9 = 0 then null else now() - i * interval '13 hours' end,
           now() - i * interval '1 day'
    from generate_series(0, ${count - 1}) as i, o, w;
    insert into public.contacts (org_id, company_id, first_name, last_name, title, email, phone)
    select c.org_id, c.id, (array['Inès','Malik','Sofia','Théo','Amina','Lucas'])[n % 6 + 1],
           (array['Moreau','Benali','Ferreira','Lambert','Haddad','Rousseau'])[n % 6 + 1],
           (array['Buyer','Owner','Purchasing manager'])[n % 3 + 1], 'person' || n || '@example.com',
           '+33 6 11 00 ' || lpad((n % 100)::text, 2, '0') || ' 00'
    from (select c.*, row_number() over (order by c.created_at desc) as n from public.companies c) c
    where c.n % 3 = 1;
  `);
}

// Local stack only: makes this browser's last authenticator code look `seconds` old, as if it was entered that long
// ago, so the "Confirm it's you" step can be tested without waiting 10 minutes. It back-dates the code in the auth
// database for this browser's session only, then refreshes the session and writes it back to the auth cookie (the
// format @supabase/ssr reads: "base64-" + base64url JSON, split into .0, .1, ... above 3180 characters).
export async function ageStepUp(context: BrowserContext, seconds: number) {
  const cookies = (await context.cookies()).filter((c) => /^sb-.+-auth-token(\.\d+)?$/.test(c.name));
  if (cookies.length === 0) throw new Error("no auth cookie in this browser");
  const key = cookies[0].name.replace(/\.\d+$/, "");
  if (!/^sb-[a-z0-9-]+-auth-token$/.test(key)) throw new Error(`unexpected auth cookie ${key}`);
  const whole = cookies.find((c) => c.name === key);
  const raw =
    whole?.value ??
    cookies
      .map((c) => ({ i: Number(c.name.slice(key.length + 1)), value: c.value }))
      .sort((a, b) => a.i - b.i)
      .map((c) => c.value)
      .join("");
  const session = JSON.parse(raw.startsWith("base64-") ? Buffer.from(raw.slice(7), "base64url").toString("utf8") : raw);
  const sessionId = JSON.parse(Buffer.from(session.access_token.split(".")[1], "base64url").toString("utf8")).session_id;
  if (!/^[0-9a-f-]{36}$/.test(sessionId) || !Number.isInteger(seconds)) throw new Error("bad session or age");
  sql(`update auth.mfa_amr_claims set created_at = now() - make_interval(secs => ${seconds}),
       updated_at = now() - make_interval(secs => ${seconds})
       where authentication_method = 'totp' and session_id = '${sessionId}'`);
  const fresh = await authFetch("/token?grant_type=refresh_token", { body: { refresh_token: session.refresh_token } });
  const value = `base64-${Buffer.from(JSON.stringify(fresh)).toString("base64url")}`;
  const chunks = value.length <= 3180 ? [{ name: key, value }] : value.match(/.{1,3180}/g)!.map((v, i) => ({ name: `${key}.${i}`, value: v }));
  const { domain, path, expires, httpOnly, secure, sameSite } = cookies[0];
  await context.clearCookies({ name: new RegExp(`^${key}(\\.\\d+)?$`) });
  await context.addCookies(chunks.map((c) => ({ ...c, domain, path, expires, httpOnly, secure, sameSite })));
}

// Day 4c: calling hours depend on the real clock (the database's now()), so queue fixtures pick their country at run
// time: a single-zone country whose calling hours are open now and for the next `minutes` (or closed, for the
// outside-hours case). Null when none qualifies (weekends: every zone closed from Saturday about 04:00 UTC to Sunday
// about 19:00 UTC); the tests then use "Show leads outside calling hours".
const QUEUE_COUNTRIES = ["FR", "GB", "DE", "PT", "GR", "AE", "PK", "IN", "TH", "JP", "NZ", "IS", "AR", "CO", "CR", "JM", "SN", "MA", "EG", "SA"];
export function countryInHours(open: boolean, minutes = 20, now = new Date()): string | null {
  for (const country of QUEUE_COUNTRIES) {
    const key = callZone(null, country);
    if (open ? isOpen(key, now) && isOpen(key, new Date(now.getTime() + minutes * 60_000)) : !isOpen(key, now) && !isOpen(key, new Date(now.getTime() + minutes * 60_000))) {
      return country;
    }
  }
  return null;
}

/** A fresh browser page for a signed-in person, with console and page errors collected (WebKit's cancelled prefetches
 * aside, as in lead-page.spec.ts), and tel:/mailto:/wa.me navigations stopped (no handler in a test browser). */
export async function signedInPage(
  browser: import("@playwright/test").Browser,
  state: Awaited<ReturnType<BrowserContext["storageState"]>>,
  o: { width?: number; timezoneId?: string; locale?: string; baseURL?: string } = {},
) {
  const width = o.width ?? 1440;
  const context = await browser.newContext({
    storageState: state,
    viewport: { width, height: width < 600 ? 844 : 900 },
    timezoneId: o.timezoneId ?? "Europe/Paris",
    hasTouch: width < 600,
  });
  if (o.locale) await context.addCookies([{ name: "locale", value: o.locale, url: o.baseURL ?? "http://localhost:3100" }]);
  await context.addInitScript(() => {
    document.addEventListener(
      "click",
      (e) => {
        const a = (e.target as Element | null)?.closest?.("a[href^='tel:'],a[href^='mailto:'],a[href^='https://wa.me/']");
        if (a) e.preventDefault();
      },
      true,
    );
  });
  const page = await context.newPage();
  trackRequests(page);
  const errors: string[] = [];
  page.on("console", (m) => m.type() === "error" && !isCancelledPrefetch(m.text()) && errors.push(m.text()));
  page.on("pageerror", (e) => !isCancelledPrefetch(e.message) && errors.push(e.message));
  return { context, page, errors };
}
