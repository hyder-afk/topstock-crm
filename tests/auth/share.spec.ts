import { mkdirSync } from "node:fs";
import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { ageStepUp, appReady, createUser, fullSession, isCancelledPrefetch, nextWindow, setRole, settled, sql, totp, trackRequests } from "./helpers";

// The client stock link (Day 6e, design 11.5): sharing switched on behind "Confirm it's you", a link made on the lead's
// Stock tab (shown once), the public page in a fresh context with no storage state (warehouse stock at the max price,
// never the cost or the minimum price, arriving stock by week, a request that lands as a task for the lead's owner),
// the route guards (honeypot, time trap, Origin, size, method), the same page for every link that does not work,
// revoke, the headers, robots.txt, a signed-in teammate staying anonymous, the rate limit, then the screenshots.
// Products and leads are invented and carry the run tag; people are picked by e-mail.
test.describe.configure({ mode: "serial" });

const password = "Share-Pass-42!";
const run = Date.now();
const tag = String(run).slice(-5);
const adminEmail = `share-admin-${run}@example.test`;
const repEmail = `share-rep-${run}@example.test`;
let adminSecret = "";
let adminState: Awaited<ReturnType<BrowserContext["storageState"]>>;
let repState: Awaited<ReturnType<BrowserContext["storageState"]>>;
// Not "Sac …": inventory.spec searches "Sac" and counts its own two products on the same database.
const visible = `Pochette kraft ${tag}`;
const hidden = `Caché ${tag}`;
const soldOut = `Épuisé ${tag}`;
const arriving = `Gobelet arrivage ${tag}`;
const xss = `<img src=x onerror=alert(1)> ${tag}`;
const leadName = `Boutique Lien ${tag}`;
let leadId = "";
let link = "";
let token = "";

const uid = (email: string) => sql(`select id from auth.users where email = '${email}'`);
function asUser(email: string, body: string) {
  const claims = `json_build_object('sub', '${uid(email)}', 'role', 'authenticated', 'aal', 'aal2', 'amr',
                   json_build_array(json_build_object('method', 'totp', 'timestamp', extract(epoch from now())::bigint)))::text`;
  return sql(`begin; select set_config('request.jwt.claims', ${claims}, true); set local role authenticated; ${body}; commit;`);
}
const requests = () => Number(sql(`select count(*) from private.stock_requests where company_id = '${leadId}' and source = 'share_link'`));

async function openApp(browser: Browser, state: typeof adminState, o: { width?: number; locale?: string; scheme?: "light" | "dark" } = {}) {
  const width = o.width ?? 1440;
  const context = await browser.newContext({
    storageState: state,
    viewport: { width, height: width < 600 ? 844 : 900 },
    hasTouch: width < 600,
    colorScheme: o.scheme ?? "light",
    timezoneId: "Europe/Paris",
  });
  if (o.locale) await context.addCookies([{ name: "locale", value: o.locale, url: "http://localhost:3100" }]);
  const page = await context.newPage();
  trackRequests(page);
  const errors: string[] = [];
  page.on("console", (m) => m.type() === "error" && !isCancelledPrefetch(m.text()) && errors.push(m.text()));
  page.on("pageerror", (e) => !isCancelledPrefetch(e.message) && errors.push(e.message));
  return { context, page, errors };
}

/** A client's phone: a fresh context, no storage state, no cookies. Collects every request URL and response body. */
async function openPublic(
  browser: Browser,
  url: string,
  o: { width?: number; scheme?: "light" | "dark"; state?: typeof adminState; ip?: string } = {},
) {
  const width = o.width ?? 390;
  const context = await browser.newContext({
    ...(o.state ? { storageState: o.state } : {}),
    // A documentation address (RFC 5737) as the platform's x-forwarded-for: the route's per-IP limiter (60 views a
    // minute) then counts this client apart from the other tests, which all come from localhost.
    ...(o.ip ? { extraHTTPHeaders: { "x-forwarded-for": o.ip } } : {}),
    viewport: { width, height: width < 600 ? 844 : 900 },
    hasTouch: width < 600,
    colorScheme: o.scheme ?? "light",
    timezoneId: "Europe/Paris",
  });
  const page = await context.newPage();
  const errors: string[] = [];
  const urls: string[] = [];
  const bodies: string[] = [];
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("request", (r) => urls.push(r.url()));
  page.on("response", async (r) => {
    if (r.url().includes("/api/share/")) bodies.push(await r.text().catch(() => ""));
  });
  await page.goto(url);
  return { context, page, errors, urls, bodies };
}

const noSideways = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
const toast = (page: Page) => page.getByRole("status").filter({ hasText: /\S/ }).last();

test.beforeAll(async ({ browser }) => {
  test.setTimeout(300_000);
  adminSecret = await createUser(adminEmail, password, true);
  const repSecret = await createUser(repEmail, password, true);
  setRole(adminEmail, "admin");
  setRole(repEmail, "rep");
  sql(`update public.profiles set first_name = 'Henri', last_name = 'Test' where id = '${uid(adminEmail)}'`);
  sql(`update private.inventory_settings set sharing_enabled = false`);
  const eta = sql(`select (current_date + 30 + ((10 - extract(isodow from current_date + 30)::integer) % 7))::text`); // a Wednesday
  for (const [name, ppc, min, max, qty, place, visibleFlag, cat] of [
    [visible, 24, 1.11, 999.99, 480, "warehouse", true, "Pochettes"],
    [hidden, 10, 1, 2, 100, "warehouse", false, "Pochettes"],
    [soldOut, 10, 1, 2, null, null, true, "Pochettes"],
    [arriving, 50, 1, 1.5, 500, "transit", true, "Gobelets"],
    [xss, 12, 1, 3, 60, "warehouse", true, "Gobelets"],
  ] as const) {
    asUser(
      adminEmail,
      `select public.create_product(p_name => $n$${name}$n$, p_pieces_per_carton => ${ppc}, p_price_min => ${min}, p_price_max => ${max},
         p_category => '${cat}', p_cost_per_piece => 0.42, p_share_visible => ${visibleFlag},
         p_transit_eta => ${place === "transit" ? `'${eta}'` : "null"}, p_opening_qty => ${qty ?? "null"},
         p_opening_location => ${place ? `'${place}'` : "null"})`,
    );
  }
  leadId = sql(`insert into public.companies (org_id, name, owner_id, lead_status, country, city, phone)
                select p.org_id, '${leadName}', p.id, 'warm', 'FR', 'Lyon', '06 12 34 56 78' from public.profiles p
                 where p.id = '${uid(adminEmail)}' returning id`)
    .split("\n")
    .find((l) => /^[0-9a-f-]{36}$/.test(l)) as string;
  adminState = await fullSession(browser, adminEmail, password, adminSecret);
  repState = await fullSession(browser, repEmail, password, repSecret);
});

test("enable_sharing_needs_admin_fresh_code", async ({ browser }) => {
  const { context, page, errors } = await openApp(browser, adminState);
  await ageStepUp(context, 700);
  await page.goto("/inventory/settings");
  await appReady(page);
  await expect(page.getByText("Sharing is off")).toBeVisible();
  await page.getByRole("button", { name: "Switch sharing on" }).click();
  const stepUp = page.getByRole("dialog", { name: "Confirm it’s you" });
  await expect(stepUp).toBeVisible();
  await nextWindow();
  await stepUp.getByLabel("6-digit code").fill(totp(adminSecret));
  await expect(toast(page)).toContainText("Sharing is on. Client links work now.");
  expect(sql(`select bool_and(sharing_enabled) from private.inventory_settings`)).toBe("t");
  expect(errors).toEqual([]);
  adminState = await context.storageState(); // ageStepUp used the stored refresh token: keep the new session
  await context.close();
});

test("share_link_create_needs_code_and_shows_once", async ({ browser }) => {
  const { context, page, errors } = await openApp(browser, adminState);
  // Clipboard permissions exist in Chromium only; WebKit checks the address field instead.
  const chromium = test.info().project.name === "chromium";
  if (chromium) await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: "http://localhost:3100" });
  await ageStepUp(context, 700);
  await settled(page);
  await page.goto(`/leads/${leadId}?tab=stock`);
  await appReady(page);
  const card = page.getByRole("region", { name: "Client link" });
  await expect(card).toBeVisible();
  await expect(card.getByText("No active link for this client.")).toBeVisible();
  await card.getByRole("button", { name: "Copy link" }).click();
  const stepUp = page.getByRole("dialog", { name: "Confirm it’s you" });
  await expect(stepUp).toBeVisible();
  await nextWindow();
  await stepUp.getByLabel("6-digit code").fill(totp(adminSecret));
  const field = card.getByLabel("Client link", { exact: true });
  await expect(field).toHaveValue(/^http:\/\/localhost:3100\/s\/fr#tss_[A-Za-z0-9_-]{43}$/);
  link = await field.inputValue();
  token = link.split("#")[1];
  if (chromium) expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(link);
  // WhatsApp and e-mail carry the message with the link; the lead's number is dialled in international form.
  await expect(card.getByRole("link", { name: "Share on WhatsApp" })).toHaveAttribute("href", /^https:\/\/wa\.me\/33612345678\?text=Bonjour/);
  await expect(card.getByRole("link", { name: "Email" })).toHaveAttribute("href", /^mailto:\?subject=/);
  // Only the hash is kept: after a reload the address is gone, the link is listed by its last 4 characters.
  await page.reload();
  await appReady(page);
  await expect(card.getByLabel("Client link", { exact: true })).toHaveCount(0);
  await expect(card.getByText(`…${token.slice(-4)}`)).toBeVisible();
  expect(sql(`select count(*) from private.share_links where company_id = '${leadId}' and revoked_at is null`)).toBe("1");
  expect(sql(`select count(*) from public.audit_log where diff_json::text like '%${token}%'`)).toBe("0");
  expect(errors).toEqual([]);
  adminState = await context.storageState();
  await context.close();
});

test("share_public_lists_warehouse_stock_with_max_price_and_never_cost", async ({ browser }) => {
  const { context, page, errors, urls, bodies } = await openPublic(browser, link);
  await expect(page.getByRole("heading", { name: "Stock disponible", level: 1 })).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("lang", "fr");
  const warehouse = page.getByRole("region", { name: /Dans notre entrepôt en France/ });
  const row = warehouse.getByRole("button", { name: new RegExp(visible) });
  await expect(row).toBeVisible();
  await expect(row.getByText("999,99 €", { exact: true })).toBeVisible();
  await expect(row.getByText("999,99 € la pièce, hors TVA")).toBeAttached();
  await expect(row.getByText("480 pcs · 20 cartons de 24")).toBeVisible();
  // share_public_hides_sold_out_and_hidden; the arriving section shows the week, never the day.
  await expect(page.getByText(hidden)).toHaveCount(0);
  await expect(page.getByText(soldOut)).toHaveCount(0);
  const arrivingSection = page.getByRole("region", { name: /Arrive bientôt/ });
  const arrivingRow = arrivingSection.getByRole("button", { name: new RegExp(arriving) });
  await expect(arrivingRow).toBeVisible();
  await expect(arrivingRow.getByText(/^Arrive la semaine du \d{1,2} [a-zéû]+\.?$/)).toBeVisible();
  // share_public_xss_name_is_text
  await expect(page.getByText(xss)).toBeVisible();
  expect(await page.locator("img[src='x']").count()).toBe(0);
  await expect(page.getByText("Votre contact : Henri")).toBeVisible();
  // share_public_never_shows_cost_or_min_price: the planted 1.11 and 0.42 are in neither the page nor any answer.
  const html = await page.content();
  for (const planted of ["1,11", "1.11", "0,42", "0.42"]) {
    expect(html).not.toContain(planted);
    for (const b of bodies) expect(b).not.toContain(planted);
  }
  expect(bodies.join("")).toContain("999.99");
  // share_public_token_not_in_requests_urls, share_public_no_supabase_requests
  for (const u of urls) {
    expect(u).not.toContain(token);
    expect(new URL(u).host).toBe("localhost:3100");
  }
  expect(await noSideways(page)).toBeLessThanOrEqual(0);
  expect(errors).toEqual([]);
  await context.close();
});

test("share_public_request_creates_task_for_owner", async ({ browser }) => {
  const { context, page, errors } = await openPublic(browser, link);
  await page.getByRole("button", { name: new RegExp(visible) }).click();
  const sheet = page.getByRole("dialog", { name: visible });
  await expect(sheet).toBeVisible();
  await sheet.getByRole("radio", { name: "ctn" }).click();
  await sheet.getByLabel("Quantité").fill("25");
  await expect(sheet.getByText("= 600 pcs")).toBeVisible();
  await expect(sheet.getByText("Nous avons 480 pcs. Nous demandons le reste au fournisseur.")).toBeVisible();
  await sheet.getByRole("button", { name: "Ajouter à la demande" }).click();
  await expect(sheet).toHaveCount(0);
  await expect(page.getByRole("button", { name: new RegExp(visible) })).toBeFocused();
  await expect(page.getByText("Votre demande · 1 article")).toBeVisible();
  await page.waitForTimeout(2100); // the time trap: a person takes more than 2 s
  await page.getByRole("button", { name: "Voir" }).click();
  const review = page.getByRole("dialog", { name: "Votre demande" });
  await review.getByLabel("Vous cherchez autre chose ? Dites-le-nous").fill("Des gobelets 30 cl aussi");
  await review.getByLabel("Votre nom (facultatif)").fill("Marie");
  await review.getByRole("button", { name: "Envoyer la demande" }).click();
  await expect(page.getByText("Merci. Henri vous répond rapidement.")).toBeVisible();
  expect(requests()).toBe(1);
  expect(sql(`select string_agg(l.pieces || ':' || l.unit || ':' || l.availability, ',') from private.stock_request_lines l
              join private.stock_requests r on r.id = l.request_id where r.company_id = '${leadId}'`)).toBe("600:carton:in_warehouse");
  expect(sql(`select t.title || '|' || (t.assignee_id = '${uid(adminEmail)}') || '|' || (t.created_by is null) from public.tasks t
              where t.company_id = '${leadId}' and t.source_request_id is not null`)).toBe("Stock request (client link)|true|true");
  expect(errors).toEqual([]);
  await context.close();
});

test("share_public_route_guards", async ({ browser }) => {
  const { context, page } = await openPublic(browser, link);
  const post = (path: string, data: unknown, headers: Record<string, string> = {}) =>
    page.request.post(path, { data: typeof data === "string" ? data : JSON.stringify(data), headers: { "content-type": "application/json", origin: "http://localhost:3100", ...headers } });
  const body = (o: Record<string, unknown> = {}) => ({
    token, lines: [], note: "Bonjour, encore une demande", name: "", idempotencyKey: crypto.randomUUID(), website: "", t: 5000, ...o,
  });
  // share_public_honeypot_silently_dropped and share_public_fast_submit_fake_success: "received", nothing written.
  for (const fake of [body({ website: "http://spam.example" }), body({ t: 300 })]) {
    const r = await post("/api/share/request", fake);
    expect(r.status()).toBe(200);
    expect(await r.json()).toEqual({ status: "received", signature: null });
  }
  expect(requests()).toBe(1);
  // share_public_cross_origin_post_refused, share_public_non_json_refused, request_body_413, share_rpc_get_405
  expect((await post("/api/share/view", { token }, { origin: "https://evil.example" })).status()).toBe(403);
  expect((await post("/api/share/view", { token }, { "content-type": "text/plain" })).status()).toBe(415);
  expect((await post("/api/share/request", body({ note: "x".repeat(20_000) }))).status()).toBe(413);
  expect((await post("/api/share/request", body({ lines: Array.from({ length: 21 }, () => ({ productId: null, description: "a", quantity: 1, unit: "piece" })) }))).status()).toBe(400);
  expect((await page.request.get("/api/share/view")).status()).toBe(405);
  // An unknown, well-formed token: 404 with the one answer.
  const unknown = await post("/api/share/view", { token: `tss_${"A".repeat(43)}` });
  expect(unknown.status()).toBe(404);
  expect(await unknown.json()).toEqual({ status: "inactive" });
  await context.close();
});

test("share_public_headers_and_robots", async ({ browser }) => {
  const { context, page } = await openPublic(browser, link);
  for (const path of ["/s/fr", "/s/en"]) {
    const r = await page.request.get(path);
    const h = r.headers();
    expect(h["content-security-policy"]).toContain("default-src 'none'");
    expect(h["content-security-policy"]).toContain("connect-src 'self'");
    expect(h["content-security-policy"]).not.toMatch(/54321|supabase/);
    expect(h["x-robots-tag"]).toBe("noindex, nofollow, noarchive, nosnippet");
    expect(h["referrer-policy"]).toBe("no-referrer");
    expect(h["cache-control"]).toContain("no-store");
    expect(h["set-cookie"]).toBeUndefined();
    // share_html_has_no_internal_strings: the shell carries only the Share words, no CRM vocabulary.
    const html = await r.text();
    for (const internal of ["Pipeline", "Prospects", "price_min", "Supplier Stock", "Record sale", "supabase"]) expect(html).not.toContain(internal);
  }
  const api = await page.request.post("/api/share/view", { data: JSON.stringify({ token }), headers: { "content-type": "application/json", origin: "http://localhost:3100" } });
  expect(api.headers()["referrer-policy"]).toBe("no-referrer");
  expect(api.headers()["set-cookie"]).toBeUndefined();
  const robots = await page.request.get("/robots.txt");
  expect(robots.status()).toBe(200);
  expect(await robots.text()).toMatch(/Disallow: \//);
  await context.close();
});

test("share_public_signed_in_teammate_still_anon", async ({ browser }) => {
  const { context, page, errors } = await openPublic(browser, link, { state: adminState, width: 1440 });
  await expect(page.getByText(visible)).toBeVisible();
  // No app chrome and no session refresh on the client page.
  await expect(page.getByTestId("dock-bead")).toHaveCount(0);
  const r = await page.request.get("/s/fr");
  expect(r.headers()["set-cookie"]).toBeUndefined();
  expect(errors).toEqual([]);
  await context.close();
});

test("share_public_keyboard_only_and_language_toggle", async ({ browser }) => {
  const { context, page, errors } = await openPublic(browser, link, { width: 1280 });
  await expect(page.getByText(visible)).toBeVisible();
  const row = page.getByRole("button", { name: new RegExp(visible) });
  await row.focus();
  await page.keyboard.press("Enter");
  const sheet = page.getByRole("dialog", { name: visible });
  await expect(sheet.getByLabel("Quantité")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(sheet).toHaveCount(0);
  await expect(row).toBeFocused();
  // share_public_language_toggle_keeps_fragment
  await page.getByRole("link", { name: "EN", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/s/en#${token}$`));
  await expect(page.getByRole("heading", { name: "Stock available now", level: 1 })).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await expect(page.getByRole("button", { name: new RegExp(visible) }).getByText("€999.99", { exact: true })).toBeVisible();
  expect(errors).toEqual([]);
  await context.close();
});

test("share_public_unknown_revoked_same_page_and_rep_cannot_create", async ({ browser }) => {
  const same = "Ce lien n’est pas actif. Demandez-en un nouveau à votre contact TopStock.";
  for (const url of ["/s/fr", `/s/fr#tss_${"z".repeat(43)}`, "/s/fr#nonsense"]) {
    const { context, page } = await openPublic(browser, `http://localhost:3100${url}`);
    await expect(page.getByText(same)).toBeVisible();
    await context.close();
  }
  // The lead's owner revokes: the next view is the same page.
  const app = await openApp(browser, adminState);
  await settled(app.page);
  await app.page.goto(`/leads/${leadId}?tab=stock`);
  await appReady(app.page);
  const card = app.page.getByRole("region", { name: "Client link" });
  await card.getByRole("button", { name: /^Revoke the link made/ }).click();
  await expect(toast(app.page)).toContainText("Link revoked.");
  await expect(card.getByText("No active link for this client.")).toBeVisible();
  expect(app.errors).toEqual([]);
  await app.context.close();
  const pub = await openPublic(browser, link);
  await expect(pub.page.getByText(same)).toBeVisible();
  await pub.context.close();
  // rep_on_other_lead_cannot_create_link: the card is read-only for a rep on someone else's lead.
  const rep = await openApp(browser, repState);
  await settled(rep.page);
  await rep.page.goto(`/leads/${leadId}?tab=stock`);
  await appReady(rep.page);
  const repCard = rep.page.getByRole("region", { name: "Client link" });
  await expect(repCard.getByText("Only Henri, a manager or an admin can share stock with this lead.")).toBeVisible();
  await expect(repCard.getByRole("button", { name: "Copy link" })).toHaveCount(0);
  expect(rep.errors).toEqual([]);
  await rep.context.close();
});

test("share_public_rate_limit_message", async ({ browser }) => {
  // A fresh link (through the RPC as the admin), 30 views in a minute, then the page.
  const fresh = asUser(adminEmail, `select public.create_share_link('${leadId}', 'en') ->> 'token'`)
    .split("\n")
    .find((l) => /^tss_/.test(l)) as string;
  const { context, page } = await openPublic(browser, `http://localhost:3100/s/en#${fresh}`, { ip: "198.51.100.200" });
  await expect(page.getByText(visible)).toBeVisible();
  for (let i = 0; i < 30; i++) {
    await page.request.post("/api/share/view", { data: JSON.stringify({ token: fresh }), headers: { "content-type": "application/json", origin: "http://localhost:3100" } });
  }
  await page.reload();
  await expect(page.getByText("Too many refreshes. Wait a minute.")).toBeVisible();
  await context.close();
});

// Evidence screenshots: the client page at 360, 390, 768, 1024, 1280, 1440 and 1728 (light and dark, EN and FR), its
// item and review sheets at 390 and 1440; the lead's client link card, Settings › Client links and What clients see
// at 390 and 1440.
test("screens", async ({ browser }) => {
  test.setTimeout(900_000);
  const dir = "test-results/share-screens";
  mkdirSync(dir, { recursive: true });
  // A fresh link for each language and scheme (it replaces the previous one): a link answers 30 views a minute.
  const mint = () =>
    asUser(adminEmail, `select public.create_share_link('${leadId}', 'fr', p_label => 'Salon', p_replace => true) ->> 'token'`)
      .split("\n")
      .find((l) => /^tss_/.test(l)) as string;
  let client = 0;
  for (const locale of ["fr", "en"] as const) {
    for (const scheme of ["light", "dark"] as const) {
      const shot = mint();
      // Its own address too: the run opens the client page 28 times (the route allows 60 views a minute an address).
      const ip = `198.51.100.${++client}`;
      for (const width of [360, 390, 768, 1024, 1280, 1440, 1728]) {
        const name = (s: string) => `${dir}/${s}-${locale}-${scheme}-${width}.png`;
        const { context, page, errors } = await openPublic(browser, `http://localhost:3100/s/${locale}#${shot}`, { width, scheme, ip });
        await expect(page.getByText(visible)).toBeVisible();
        expect(await noSideways(page), `client ${locale} ${scheme} ${width}`).toBeLessThanOrEqual(0);
        await page.screenshot({ path: name("client"), fullPage: true });
        if ([390, 1440].includes(width)) {
          await page.getByRole("button", { name: new RegExp(visible) }).click();
          const sheet = page.getByRole("dialog").last();
          await sheet.getByRole("textbox").first().fill("4");
          await page.waitForTimeout(350);
          await page.screenshot({ path: name("client-item") });
          await sheet.getByRole("button", { name: locale === "fr" ? "Ajouter à la demande" : "Add to request" }).click();
          await page.getByRole("button", { name: locale === "fr" ? "Voir" : "Review" }).click();
          await page.waitForTimeout(350);
          await page.screenshot({ path: name("client-review") });
          await page.keyboard.press("Escape");
        }
        expect(errors, `client ${locale} ${scheme} ${width}`).toEqual([]);
        await context.close();
        if ([390, 1440].includes(width)) {
          const app = await openApp(browser, adminState, { width, locale, scheme });
          await settled(app.page);
          await app.page.goto(`/leads/${leadId}?tab=stock`);
          await appReady(app.page);
          await expect(app.page.getByRole("region", { name: locale === "fr" ? "Lien client" : "Client link" })).toBeVisible();
          await app.page.locator("details summary").first().click();
          expect(await noSideways(app.page)).toBeLessThanOrEqual(0);
          await app.page.screenshot({ path: name("lead-link-card"), fullPage: true });
          await settled(app.page);
          await app.page.goto("/inventory/settings");
          await appReady(app.page);
          await expect(app.page.getByRole("region", { name: locale === "fr" ? "Liens clients" : "Client links" })).toBeVisible();
          await app.page.screenshot({ path: name("settings-sharing"), fullPage: true });
          await settled(app.page);
          await app.page.goto("/inventory/client-view");
          await appReady(app.page);
          await expect(app.page.getByText(visible)).toBeVisible();
          expect(await noSideways(app.page)).toBeLessThanOrEqual(0);
          await app.page.screenshot({ path: name("client-view"), fullPage: true });
          expect(app.errors, `app ${locale} ${scheme} ${width}`).toEqual([]);
          await app.context.close();
        }
      }
    }
  }
});
