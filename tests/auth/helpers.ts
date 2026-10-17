import { execFileSync } from "node:child_process";
import { createHmac } from "node:crypto";
import { expect, type BrowserContext, type Locator, type Page, type Request } from "@playwright/test";
import { callZone, isOpen } from "../../src/lib/timezones";
import { authCookies, jwtPayload, sessionFromCookies } from "./auth-cookie";

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

// Tries to refresh a session with its refresh token (what a browser's Supabase client does when its access token is
// about to expire); returns the HTTP status and Supabase's error code, and whether a new access token came back.
export async function tryRefresh(refreshToken: string) {
  const key = env("NEXT_PUBLIC_SUPABASE_ANON_KEY");
  const res = await fetch(`${env("SUPABASE_LOCAL_URL")}/auth/v1/token?grant_type=refresh_token`, {
    method: "POST",
    headers: { apikey: key, ...(key.startsWith("eyJ") ? { Authorization: `Bearer ${key}` } : {}), "Content-Type": "application/json" },
    body: JSON.stringify({ refresh_token: refreshToken }),
  });
  const body = (await res.json().catch(() => ({}))) as { error_code?: string; code?: string; access_token?: string };
  return { status: res.status, code: body.error_code ?? body.code, refreshed: typeof body.access_token === "string" };
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

// Access tokens last 15 minutes (jwt_expiry 900, Haider's decision 9 of 16 Oct 2026) and auth-js renews a token 90 s
// before it ends. A saved session goes stale in two ways: contexts built from it after its token expires all renew
// with the same refresh token (the first rotates it, the later ones are refused and land on /login), and a page whose
// clock is moved ahead (clock.fastForward) sees its token as expired and its server calls fail (queue.spec
// claims_end_cards_leave on CI, a5b2fdb). `youngSession` returns `state` while its access token outlives `aheadMs` (the
// clock jump the test makes) by the renewal margin plus 2 minutes for the test itself, and otherwise signs in again.
export async function youngSession(
  browser: import("@playwright/test").Browser,
  state: Awaited<ReturnType<BrowserContext["storageState"]>>,
  who: { email: string; password: string; secret: string },
  aheadMs = 0,
) {
  const { exp } = jwtPayload(sessionFromCookies(state.cookies).access_token);
  const left = (exp ?? 0) * 1000 - Date.now();
  if (left - aheadMs > 90_000 + 120_000) return state;
  console.log(`youngSession: ${who.email.split("@")[0]} signed in again (token had ${Math.round(left / 1000)} s left, clock jump ${aheadMs / 1000} s)`);
  return fullSession(browser, who.email, who.password, who.secret);
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
// Diagnosis for WebKit's "ResizeObserver loop completed with undelivered notifications" (PR #19 CI): every observer
// callback is logged with the elements it saw, and when the loop is reported a console error names the observers that
// ran in the last 100 ms and where they were created, so the test's own error check shows the source.
export async function addResizeObserverProbe(context: BrowserContext) {
  await context.addInitScript(() => {
    const Native = window.ResizeObserver;
    if (!Native) return;
    const recent: { t: number; who: string; created: string }[] = [];
    const describe = (el: Element) => {
      const own = `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ""}${[...el.classList].slice(0, 4).map((c) => `.${c}`).join("")}`;
      const named = el.closest("[id],[role],[aria-label],[data-slot]");
      const anchor = named && named !== el ? ` in ${named.tagName.toLowerCase()}${named.id ? `#${named.id}` : ""}${named.getAttribute("role") ? `[role=${named.getAttribute("role")}]` : ""}${named.getAttribute("aria-label") ? `[aria-label=${named.getAttribute("aria-label")}]` : ""}` : "";
      return own + anchor;
    };
    class Probe extends Native {
      constructor(callback: ResizeObserverCallback) {
        const created = (new Error().stack ?? "").split("\n").slice(1, 4).map((l) => l.trim()).join(" < ");
        super((entries, observer) => {
          recent.push({ t: performance.now(), who: entries.map((e) => describe(e.target)).join(", "), created });
          if (recent.length > 60) recent.shift();
          callback(entries, observer);
        });
      }
    }
    window.ResizeObserver = Probe;
    window.addEventListener("error", (e) => {
      if (!String(e.message).includes("ResizeObserver loop")) return;
      const now = performance.now();
      const last = recent.filter((r) => now - r.t < 100).map((r) => `${r.who} {${r.created}}`);
      console.error(`ResizeObserver loop diagnosis: ${last.join(" | ") || "no observer callback in the last 100 ms"}`);
    });
  });
}

export function trackRequests(page: Page) {
  let pending = inFlight.get(page);
  if (!pending) {
    const set = new Set<Request>();
    // Next's link prefetches are speculative and never hold data a test waits for; on CI's Chromium 156 a prefetch the
    // router dropped was sometimes never reported finished or failed (PR #19: /inventory/import?_rsc= and
    // /inventory/settings?_rsc= open for good). Their cancellation noise is already filtered by isCancelledPrefetch.
    // CI's Chromium 156 also never ends a request the page was still making when a navigation replaced its document: no
    // finished, no failed (PR #25: day7b's first page.goto cut a chunk script, or /api/inventory/alerts, that the page
    // openPage() loaded had just asked for, and the next settled() waited on it for good). Reproduced with Chrome Headless
    // Shell 156.0.8078.4, which sends no loadingFinished or loadingFailed for them at all; Chromium 141 and WebKit report
    // them failed (net::ERR_ABORTED). So when the new document commits, the old document's requests are forgotten, as
    // those browsers do. A history change (pushState, replaceState) keeps the document and forgets nothing; settled()
    // still waits for everything the page on screen has started.
    let documentRequest: Request | undefined;
    const bare = (url: string) => url.split("#")[0];
    page.on("request", (r) => {
      if (r.isNavigationRequest() && r.frame() === page.mainFrame()) documentRequest = r;
      const h = r.headers();
      if (h["next-router-prefetch"] || h["next-router-segment-prefetch"]) return;
      set.add(r);
    });
    page.on("framenavigated", (frame) => {
      if (frame !== page.mainFrame() || !documentRequest || bare(frame.url()) !== bare(documentRequest.url())) return;
      for (const r of set) if (r !== documentRequest) set.delete(r);
      documentRequest = undefined;
    });
    page.on("requestfinished", (r) => set.delete(r));
    page.on("requestfailed", (r) => {
      set.delete(r);
      if (r === documentRequest) documentRequest = undefined;
    });
    inFlight.set(page, set);
    pending = set;
  }
  return pending;
}

// Waits until the page has no request in flight. Leaving a page while a fetch is running (a link prefetch, a server
// action) makes WebKit log "Fetch API cannot load … due to access control checks", which the console-error checks
// would rightly count. `waitForLoadState("networkidle")` resolves at once when the document reached that state
// earlier, so it cannot wait for a request started later; the page's own request count can.
// On a timeout the failure names the requests still open (method, kind and URL), so a CI failure says which one.
export async function settled(page: Page) {
  if (page.url() === "about:blank") return;
  const pending = trackRequests(page);
  await expect.poll(() => [...pending].map((r) => `${r.method()} ${r.resourceType()} ${r.url()}`), { timeout: 15_000 }).toEqual([]);
}

// WebKit reports a fetch the page itself cancelled as "Fetch API cannot load <url> due to access control checks" (as a
// console error, or as an uncaught page error when the fetch's promise is not awaited). Next.js
// cancels its own link prefetches (requests to this app with ?_rsc=) when a server action refreshes the page or a new
// navigation starts; Chromium logs nothing for that. Only that exact case is ignored: same-origin RSC requests cannot
// fail a real access-control check, and every other console error still counts.
const cancelledPrefetch = /^(?:Fetch API cannot load )?(?:http:)?\/\/?localhost:\d+\/[^\s?]*\?_rsc=[\w-]+ due to access control checks\.$/;
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

// Since Day 6 a lead with stock history (holds, sales) is kept (lead_delete_blocked_by_stock_history), so a spec that
// resets the leads first clears the earlier Day 6 specs' made-up stock history, whole: movements, holds, sales, requests
// and client links, a stock import's undo records, and the levels they built (every product back to nothing, consistent with an empty movement log).
// Their guards make that history append-only, so this throwaway-stack reset runs with triggers off
// (session_replication_role), which also turns off the foreign key actions: every table below is listed, children included.
export function clearStockHistory() {
  sql(`
    begin;
    set local session_replication_role = replica;
    delete from public.tasks where source_request_id is not null;
    delete from private.order_line_costs;
    delete from private.order_lines;
    delete from private.stock_hold_uses;
    delete from private.stock_request_lines;
    delete from private.stock_requests;
    delete from private.share_links;
    delete from private.orders;
    delete from private.stock_movements;
    delete from private.stock_reservations;
    delete from public.stock_levels;
    delete from private.stock_import_changes;
    commit;
  `);
}

// Replaces every lead with `count` made-up companies (names from fixed word lists, @example.com emails, +33 6 00
// numbers), owned in turn by the given test users, with a contact on every third one. File rows and deals go first: since
// Day 4d a lead with files cannot be deleted (their stored bytes, if any, are left to the throwaway stack), and a deal
// keeps its lead (deals_company_id_fkey has no cascade), so earlier specs' made-up files and deals would block the reset.
export function seedLeads(ownerEmails: string[], count = 120) {
  const owners = ownerEmails.map(emailLiteral).join(", ");
  clearStockHistory();
  sql(`
    delete from public.files;
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
  const { key, cookies } = authCookies(await context.cookies());
  const session = sessionFromCookies(cookies);
  const sessionId = jwtPayload(session.access_token).session_id ?? "";
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
  await addResizeObserverProbe(context);
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

// Day 7b: the app's own pickers (no native <select> or date inputs, docs/evidence/day7/pickers.md). These replace
// selectOption and fill on a native field with what a person does: open the trigger, pick an option, or type.

/**
 * Picks an option in a Select or Combobox the way a person does: click the trigger (role combobox), then the option.
 * `option` is the option's value (as selectOption took it: matched on data-option) or `{ label }` for its words. For a
 * Combobox, `search` is typed into its search box first (long lists such as time zones).
 */
export async function choose(trigger: Locator, option: string | { label: string | RegExp }, search?: string) {
  const page = trigger.page();
  await trigger.click();
  if (search !== undefined) await page.getByRole("dialog").last().getByRole("combobox").fill(search);
  const item =
    typeof option === "string"
      ? page.locator(`[role="option"][data-option="${option.replace(/"/g, '\\"')}"]`)
      : // The first option with those words, as selectOption({ label }) took it.
        page.getByRole("option", { name: option.label, exact: typeof option.label === "string" }).first();
  await item.click();
  await expect(item).toBeHidden();
}

/** The value a Select or Combobox submits (data-value on its trigger, which matches its hidden input). */
export async function expectChosen(trigger: Locator, value: string) {
  await expect(trigger).toHaveAttribute("data-value", value);
}

/**
 * Types a day into a DatePicker with `typed` (the locale's digit order, as a person types it) and leaves the field, or
 * picks it from the calendar when the picker is a button. `iso` is YYYY-MM-DD.
 */
export async function pickDate(field: Locator, iso: string, locale: "en" | "fr" = "en") {
  const [y, m, d] = iso.split("-");
  const tag = await field.evaluate((el) => el.tagName);
  if (tag === "INPUT") {
    await field.fill(locale === "fr" ? `${d}/${m}/${y}` : `${m}/${d}/${y}`);
    await field.press("Enter");
    return;
  }
  // A button: open the calendar, walk to the month, click the day.
  await field.click();
  const page = field.page();
  const grid = page.getByRole("grid");
  await expect(grid).toBeVisible();
  const target = grid.locator(`button[data-iso="${iso}"]`);
  for (let i = 0; i < 36 && !(await target.count()); i++) {
    const first = (await grid.locator("button[data-iso]").first().getAttribute("data-iso")) ?? "";
    await page.getByRole("button", { name: iso < first ? /^(Previous month|Mois précédent)$/ : /^(Next month|Mois suivant)$/ }).click();
  }
  await target.click();
  await expect(grid).toBeHidden();
}
