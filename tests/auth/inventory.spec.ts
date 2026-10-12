import { mkdirSync } from "node:fs";
import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { ageStepUp, appReady, createUser, fullSession, isCancelledPrefetch, nextWindow, setRole, settled, sql, totp, trackRequests } from "./helpers";

// The Inventory page (Day 6b, design 11.5): the stock table with filters and the product panel, a new product with
// opening stock behind "Confirm it's you", a counted correction, a partial Arrived that moves a hold, the movement log
// and its pages, a rep without costs or manager actions, read-only GET routes, the phone layout, keyboard only, the
// empty and error states, and the admin settings. Then the evidence screenshots (6 widths, light and dark, EN and FR).
// Products are made-up and written through the RPCs as a seeding manager (so the engine's rules all apply); people are
// picked by e-mail, never by display name (the local stack is reused between runs).
test.describe.configure({ mode: "serial" });

const password = "Inventory-Pass-42!";
const run = Date.now();
const adminEmail = `inv-admin-${run}@example.test`;
const repEmail = `inv-rep-${run}@example.test`;
const seedEmail = `inv-seed-${run}@example.test`;
let adminSecret = "";
let adminState: Awaited<ReturnType<BrowserContext["storageState"]>>;
let repState: Awaited<ReturnType<BrowserContext["storageState"]>>;

function userId(email: string) {
  return sql(`select id from auth.users where email = '${email}'`);
}

// Runs SQL as a signed-in user with a fresh code, in one transaction (the RPCs' own checks all apply).
function asUser(email: string, body: string) {
  const claims = `json_build_object('sub', '${userId(email)}', 'role', 'authenticated', 'aal', 'aal2', 'amr',
                   json_build_array(json_build_object('method', 'totp', 'timestamp', extract(epoch from now())::bigint)))::text`;
  return sql(`begin; select set_config('request.jwt.claims', ${claims}, true); set local role authenticated; ${body}; commit;`);
}

const tag = String(run).slice(-5);
// The catalogue: invented products. Seeded once per stack (a marker product says so); the test's own products carry
// the run tag so reruns never collide on a name.
const catalogue: { name: string; cat: string; ppc: number; min: number; max: number; cost: number; wh: number; tr: number; reorder?: number; eta?: number; hidden?: boolean }[] = [
  { name: "T-shirt coton 180 g", cat: "Textile", ppc: 48, min: 2.1, max: 2.5, cost: 1.35, wh: 4200, tr: 0, reorder: 500 },
  { name: "Sweat capuche molleton", cat: "Textile", ppc: 24, min: 7.5, max: 9.9, cost: 5.2, wh: 960, tr: 1200, eta: 9 },
  { name: "Polo piqué marine", cat: "Textile", ppc: 36, min: 4.2, max: 5.5, cost: 2.9, wh: 180, tr: 0, reorder: 300 },
  { name: "Chaussettes sport lot de 3", cat: "Textile", ppc: 120, min: 1.1, max: 1.6, cost: 0.62, wh: 7200, tr: 0 },
  { name: "Casquette brodée", cat: "Accessoires", ppc: 50, min: 2.8, max: 3.9, cost: 1.7, wh: 0, tr: 600, eta: 16 },
  { name: "Sac cabas jute naturel", cat: "Bagagerie", ppc: 60, min: 1.9, max: 2.6, cost: 1.05, wh: 1500, tr: 0 },
  { name: "Sac à dos urbain 20 L", cat: "Bagagerie", ppc: 12, min: 11, max: 14.5, cost: 7.8, wh: 240, tr: 360, eta: 23 },
  { name: "Trousse toile enduite", cat: "Bagagerie", ppc: 80, min: 1.4, max: 2, cost: 0.75, wh: 0, tr: 0 },
  { name: "Gourde inox 500 ml", cat: "Maison", ppc: 40, min: 4.4, max: 5.9, cost: 2.6, wh: 800, tr: 0, reorder: 200 },
  { name: "Mug céramique blanc", cat: "Maison", ppc: 36, min: 1.6, max: 2.2, cost: 0.9, wh: 2160, tr: 0, hidden: true },
  { name: "Plaid polaire gris", cat: "Maison", ppc: 20, min: 6.9, max: 8.9, cost: 4.4, wh: 400, tr: 0 },
  { name: "Serviette éponge 50×100", cat: "Maison", ppc: 30, min: 3.2, max: 4.1, cost: 1.9, wh: 0, tr: 900, eta: 30 },
  { name: "Lampe LED de bureau", cat: "Maison", ppc: 10, min: 9.5, max: 12, cost: 6.1, wh: 70, tr: 0, reorder: 100 },
  { name: "Câble USB-C 1 m", cat: "Électronique", ppc: 100, min: 0.9, max: 1.4, cost: 0.38, wh: 5000, tr: 0 },
  { name: "Chargeur secteur 20 W", cat: "Électronique", ppc: 50, min: 3.6, max: 4.9, cost: 2.2, wh: 750, tr: 500, eta: 12 },
  { name: "Écouteurs filaires", cat: "Électronique", ppc: 100, min: 1.2, max: 1.8, cost: 0.55, wh: 0, tr: 0 },
  { name: "Batterie externe 10 000 mAh", cat: "Électronique", ppc: 40, min: 8.4, max: 10.9, cost: 5.6, wh: 320, tr: 0 },
  { name: "Carnet A5 ligné", cat: "Papeterie", ppc: 100, min: 0.8, max: 1.2, cost: 0.41, wh: 3000, tr: 0 },
  { name: "Stylo bille bleu (boîte de 50)", cat: "Papeterie", ppc: 20, min: 4.5, max: 6, cost: 2.7, wh: 260, tr: 0 },
  { name: "Ruban adhésif transparent", cat: "Papeterie", ppc: 72, min: 0.5, max: 0.8, cost: 0.21, wh: 0, tr: 1440, eta: 5 },
];

function seedCatalogue() {
  if (sql(`select count(*) from public.products where name = 'T-shirt coton 180 g'`) !== "0") return;
  const lead = sql(`insert into public.companies (org_id, name, owner_id, lead_status, country, city)
                    select p.org_id, 'Maison Verdane', p.id, 'warm', 'FR', 'Lyon' from public.profiles p
                    where p.id = '${userId(seedEmail)}' returning id`);
  const today = new Date();
  const eta = (d: number) => new Date(today.getTime() + d * 86_400_000).toISOString().slice(0, 10);
  for (const p of catalogue) {
    const id = asUser(
      seedEmail,
      `select public.create_product(p_name => '${p.name}', p_pieces_per_carton => ${p.ppc}, p_price_min => ${p.min}, p_price_max => ${p.max},
        p_category => '${p.cat}', p_reorder_point => ${p.reorder ?? "null"}, p_cost_per_piece => ${p.cost},
        p_transit_eta => ${p.eta ? `'${eta(p.eta)}'` : "null"}, p_share_visible => ${p.hidden ? "false" : "true"},
        p_opening_qty => ${p.wh || "null"}, p_opening_location => 'warehouse')`,
    ).split("\n").find((l) => /^[0-9a-f-]{36}$/.test(l));
    if (p.tr) asUser(seedEmail, `select public.post_stock_movement('${id}', 'receive', ${p.tr}, 'transit', 'received')`);
  }
  // Holds for one lead: on warehouse stock and on stock still in transit.
  const pid = (name: string) => sql(`select id from public.products where name = '${name}'`);
  asUser(seedEmail, `select public.post_stock_movement('${pid("T-shirt coton 180 g")}', 'reserve', 480, 'warehouse', p_company => '${lead}')`);
  asUser(seedEmail, `select public.post_stock_movement('${pid("Sweat capuche molleton")}', 'reserve', 240, 'transit', p_company => '${lead}')`);
}

async function open(browser: Browser, state: typeof adminState, o: { width?: number; locale?: string; scheme?: "light" | "dark" } = {}) {
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

async function gotoInventory(page: Page, query = "") {
  await settled(page);
  await page.goto(`/inventory${query}`);
  await expect(page.locator("main h1")).toBeVisible();
  await appReady(page);
}

const toast = (page: Page) => page.getByRole("status").filter({ hasText: /\S/ }).last();
const noSideways = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);

test.beforeAll(async ({ browser }) => {
  test.setTimeout(300_000);
  adminSecret = await createUser(adminEmail, password, true);
  const repSecret = await createUser(repEmail, password, true);
  await createUser(seedEmail, password, false);
  setRole(adminEmail, "admin");
  setRole(repEmail, "rep");
  setRole(seedEmail, "manager");
  sql(`update public.profiles set first_name = 'Henri', last_name = 'Test' where id = '${userId(adminEmail)}'`);
  sql(`update public.profiles set first_name = 'Kais', last_name = 'Test' where id = '${userId(seedEmail)}'`);
  seedCatalogue();
  adminState = await fullSession(browser, adminEmail, password, adminSecret);
  repState = await fullSession(browser, repEmail, password, repSecret);
});

test("stock_table_filters_and_panel", async ({ browser }) => {
  const { context, page, errors } = await open(browser, adminState);
  await gotoInventory(page);
  await expect(page.getByRole("heading", { level: 1, name: /Inventory/ })).toBeVisible();
  await expect(page.getByText("Held for clients")).toBeVisible();
  const table = page.getByRole("table", { name: "Stock" });
  // Rows are virtualised: the first products by name are drawn.
  await expect(table.getByRole("link", { name: /Batterie externe 10 000 mAh/ })).toBeVisible();
  // Low: products at or under their reorder point (Polo 180 ≤ 300, Lampe 70 ≤ 100).
  await page.getByRole("button", { name: /^Low/ }).click();
  await expect(page).toHaveURL(/filter=low/);
  await expect(table.getByRole("link", { name: /Polo piqué marine/ })).toBeVisible();
  await expect(table.getByRole("link", { name: /Câble USB-C/ })).toHaveCount(0);
  await page.getByRole("button", { name: /^All/ }).click();
  // Search, with the 150 ms debounce.
  await page.getByRole("searchbox", { name: "Search products" }).fill("jute");
  await expect(page).toHaveURL(/q=jute/);
  await expect(table.getByRole("link", { name: /Sac cabas jute naturel/ })).toBeVisible();
  await expect(table.getByRole("row")).toHaveCount(3); // header, the product, the end line
  // Open it: the panel beside the table shows its figures; Esc closes and the focus returns to its row.
  await table.getByRole("link", { name: /Sac cabas jute naturel/ }).click();
  const panel = page.getByRole("complementary", { name: "Product" });
  await expect(panel.getByRole("heading", { name: "Sac cabas jute naturel" })).toBeVisible();
  await expect(panel.getByText("Available in the warehouse")).toBeVisible();
  await expect(panel.getByText("Cost per piece")).toBeVisible();
  await expect(page).toHaveURL(/product=[0-9a-f-]{36}/);
  await page.keyboard.press("Escape");
  await expect(panel).toHaveCount(0);
  await expect(table.getByRole("link", { name: /Sac cabas jute naturel/ })).toBeFocused();
  expect(errors).toEqual([]);
  await context.close();
});

test("new_product_with_opening_stock_step_up", async ({ browser }) => {
  test.setTimeout(180_000);
  const { context, page, errors } = await open(browser, adminState);
  await ageStepUp(context, 700);
  await gotoInventory(page);
  await page.getByRole("button", { name: "New product" }).click();
  const dialog = page.getByRole("dialog", { name: "New product" });
  await dialog.getByLabel("Name").fill(`Bonnet laine ${tag}`);
  await dialog.getByLabel("Pieces per carton").fill("48");
  await dialog.getByLabel("Minimum price per piece").fill("2,10");
  await dialog.getByLabel("Price per piece for clients").fill("2.90");
  await dialog.getByLabel("Opening stock").fill("2");
  await dialog.getByRole("radio", { name: "ctn" }).click();
  await expect(dialog.getByText("= 96 pcs")).toBeVisible();
  await dialog.getByRole("button", { name: "Create product" }).click();
  // The code is 700 s old: "Confirm it's you" first.
  const stepUp = page.getByRole("dialog", { name: "Confirm it’s you" });
  await expect(stepUp).toBeVisible();
  await nextWindow();
  await stepUp.getByLabel("6-digit code").fill(totp(adminSecret));
  await expect(toast(page)).toHaveText(`Bonnet laine ${tag} added.`);
  const panel = page.getByRole("complementary", { name: "Product" });
  await expect(panel.getByRole("heading", { name: `Bonnet laine ${tag}` })).toBeVisible();
  expect(sql(`select l.on_hand from public.stock_levels l join public.products p on p.id = l.product_id
              join public.locations x on x.id = l.location_id where p.name = 'Bonnet laine ${tag}' and x.kind = 'warehouse'`)).toBe("96");
  expect(sql(`select p.price_min || '/' || p.price_max from public.products p where p.name = 'Bonnet laine ${tag}'`)).toBe("2.1000/2.9000");
  expect(errors).toEqual([]);
  await context.close();
});

test("count_sets_quantity_then_movements_log", async ({ browser }) => {
  const { context, page, errors } = await open(browser, adminState);
  const id = sql(`select id from public.products where name = 'Bonnet laine ${tag}'`);
  await gotoInventory(page, `?product=${id}`);
  const panel = page.getByRole("complementary", { name: "Product" });
  await panel.getByRole("button", { name: "Correct stock" }).click();
  const dialog = page.getByRole("dialog", { name: "Correct stock" });
  await expect(dialog.getByRole("radio", { name: "Set counted quantity" })).toHaveAttribute("aria-checked", "true");
  await dialog.getByLabel("Counted quantity").fill("90");
  await expect(dialog.getByText("After: 90 pcs")).toBeVisible();
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(toast(page)).toHaveText("Stock corrected.");
  await expect(panel.getByRole("listitem").filter({ hasText: "Count" }).first()).toContainText("−6");
  // The same count again changes nothing (worked out under the lock).
  await panel.getByRole("button", { name: "Correct stock" }).click();
  await dialog.getByLabel("Counted quantity").fill("90");
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(toast(page)).toHaveText("Nothing changed: that is already the count.");
  await panel.getByRole("link", { name: "See all movements" }).click();
  await expect(page).toHaveURL(/tab=movements&product=/);
  await expect(page.getByText(`Product: Bonnet laine ${tag}`)).toBeVisible();
  const log = page.getByRole("list", { name: "Movements" });
  await expect(log.getByRole("listitem")).toHaveCount(2);
  await expect(log.getByRole("listitem").first()).toContainText("Count");
  expect(errors).toEqual([]);
  await context.close();
});

test("arrived_partial_moves_hold", async ({ browser }) => {
  const { context, page, errors } = await open(browser, adminState);
  // Its own product: 500 in transit, 100 of them held for Maison Verdane.
  const lead = sql(`select id from public.companies where name = 'Maison Verdane' order by created_at limit 1`);
  const id = asUser(seedEmail, `select public.create_product(p_name => 'Housse coussin ${tag}', p_pieces_per_carton => 50,
                     p_opening_qty => 500, p_opening_location => 'transit')`).split("\n").find((l) => /^[0-9a-f-]{36}$/.test(l));
  asUser(seedEmail, `select public.post_stock_movement('${id}', 'reserve', 100, 'transit', p_company => '${lead}')`);
  await gotoInventory(page, "?tab=arriving");
  const row = page.getByRole("listitem").filter({ hasText: `Housse coussin ${tag}` });
  await expect(row).toContainText("100 pcs held");
  await row.getByRole("button", { name: "Arrived" }).click();
  const dialog = page.getByRole("dialog", { name: "Mark as arrived" });
  await dialog.getByText("Only part arrived").click();
  await dialog.getByLabel("Pieces that arrived").fill("300");
  await dialog.getByRole("button", { name: "Mark arrived" }).click();
  await expect(toast(page)).toHaveText("300 pcs arrived in the warehouse.");
  const levels = sql(`select string_agg(x.kind || ':' || l.on_hand || '/' || l.reserved, ' ' order by x.kind) from public.stock_levels l
                      join public.locations x on x.id = l.location_id where l.product_id = '${id}'`);
  expect(levels).toBe("transit:200/0 warehouse:300/100");
  await expect(row).toContainText("200 pcs");
  expect(errors).toEqual([]);
  await context.close();
});

test("movements_log_keyset", async ({ browser }) => {
  const { context, page, errors } = await open(browser, adminState);
  const id = asUser(seedEmail, `select public.create_product(p_name => 'Bougie parfumée ${tag}', p_pieces_per_carton => 24,
                     p_opening_qty => 10, p_opening_location => 'warehouse')`).split("\n").find((l) => /^[0-9a-f-]{36}$/.test(l));
  asUser(seedEmail, `select count(public.post_stock_movement('${id}', 'adjust_in', 1, 'warehouse', 'found')) from generate_series(1, 54)`);
  await gotoInventory(page, `?tab=movements&product=${id}`);
  const log = page.getByRole("list", { name: "Movements" });
  await expect(log.getByRole("listitem")).toHaveCount(50);
  await page.getByRole("button", { name: "Show older" }).click();
  await expect(log.getByRole("listitem")).toHaveCount(55);
  await expect(log.getByRole("listitem").last()).toContainText("Received");
  await expect(page.getByRole("button", { name: "Show older" })).toHaveCount(0);
  expect(errors).toEqual([]);
  await context.close();
});

test("rep_sees_no_cost_column_and_no_manager_actions; get_routes_read_only", async ({ browser }) => {
  const { context, page, errors } = await open(browser, repState);
  await gotoInventory(page, "?q=T-shirt");
  const table = page.getByRole("table", { name: "Stock" });
  await expect(table.getByRole("link", { name: /T-shirt coton 180 g/ })).toBeVisible();
  await expect(table.getByRole("columnheader", { name: "Cost/pc" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "New product" })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Settings" })).toHaveCount(0);
  await table.getByRole("link", { name: /T-shirt coton 180 g/ }).click();
  const panel = page.getByRole("complementary", { name: "Product" });
  await expect(panel.getByText("Available in the warehouse")).toBeVisible();
  await expect(panel.getByText("Cost per piece")).toHaveCount(0);
  await expect(panel.getByRole("button", { name: "Correct stock" })).toHaveCount(0);
  // The API never carries a cost to a rep, and the GET routes accept nothing else.
  const body = await (await page.request.get("/api/inventory/stock?q=T-shirt")).json();
  expect(body.rows.length).toBeGreaterThan(0);
  expect(body.rows.every((r: { cost_per_piece: unknown }) => r.cost_per_piece === null)).toBe(true);
  for (const path of ["/api/inventory/stock", "/api/inventory/summary", "/api/inventory/movements", "/api/inventory/reservations"]) {
    expect((await page.request.post(path, { data: {} })).status(), path).toBe(405);
  }
  expect((await page.request.get("/api/inventory/stock?after_id=nope&after_value=x")).status()).toBe(400);
  expect((await page.request.get("/api/inventory/movements?kinds=steal")).status()).toBe(400);
  expect((await page.request.get("/api/inventory/products/not-a-uuid")).status()).toBe(404);
  // Settings are admin-only: the standard not-found screen (streamed, so the status stays 200), no settings form.
  await settled(page);
  await page.goto("/inventory/settings");
  await expect(page.getByRole("heading", { name: "This page isn’t here" })).toBeVisible();
  await expect(page.getByLabel("Default hold length (days)")).toHaveCount(0);
  expect(errors).toEqual([]);
  await context.close();
});

test("inventory_390_no_horizontal_scroll_and_product_page", async ({ browser }) => {
  const { context, page, errors } = await open(browser, adminState, { width: 390 });
  await gotoInventory(page);
  expect(await noSideways(page)).toBeLessThanOrEqual(0);
  await page.getByRole("link", { name: /Câble USB-C 1 m/ }).tap();
  await expect(page).toHaveURL(/\/inventory\/p\/[0-9a-f-]{36}$/);
  await expect(page.getByRole("heading", { level: 1, name: "Câble USB-C 1 m" })).toBeVisible();
  expect(await noSideways(page)).toBeLessThanOrEqual(0);
  // Touch targets: every button and link on the product page is at least 44 px tall.
  const small = await page.locator("main button:visible, main a:visible").evaluateAll((els) =>
    els.filter((e) => e.getBoundingClientRect().height < 44).map((e) => e.textContent?.trim()),
  );
  expect(small).toEqual([]);
  await page.getByRole("link", { name: "Inventory" }).first().tap();
  await expect(page).toHaveURL(/\/inventory$/);
  expect(errors).toEqual([]);
  await context.close();
});

test("inventory_keyboard_only", async ({ browser }) => {
  const { context, page, errors } = await open(browser, adminState);
  await gotoInventory(page);
  await page.keyboard.press("/");
  await expect(page.getByRole("searchbox", { name: "Search products" })).toBeFocused();
  await page.keyboard.type("Sac");
  await expect(page).toHaveURL(/q=Sac/);
  const table = page.getByRole("table", { name: "Stock" });
  await expect(table.getByRole("link")).toHaveCount(2);
  // Tab into the table, Enter opens, Down moves to the next product (and opens it), Esc closes.
  await table.getByRole("link").first().focus();
  await page.keyboard.press("Enter");
  const panel = page.getByRole("complementary", { name: "Product" });
  const first = (await panel.getByRole("heading").first().textContent())?.trim();
  await page.keyboard.press("ArrowDown");
  await expect(panel.getByRole("heading").first()).not.toHaveText(first ?? "");
  await expect(table.getByRole("link").nth(1)).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(panel).toHaveCount(0);
  await expect(table.getByRole("link").nth(1)).toBeFocused();
  // Tabs: arrows move between them; the focus is never dropped to the page body.
  await page.getByRole("tab", { name: "Stock" }).focus();
  await page.keyboard.press("ArrowRight");
  await expect(page.getByRole("tab", { name: /Arriving/ })).toBeFocused();
  await expect(page).toHaveURL(/tab=arriving/);
  expect(await page.evaluate(() => document.activeElement === document.body)).toBe(false);
  expect(errors).toEqual([]);
  await context.close();
});

test("inventory_empty_and_error_states", async ({ browser }) => {
  const { context, page, errors } = await open(browser, adminState);
  await gotoInventory(page, "?q=zzzz-nothing");
  await expect(page.getByRole("heading", { name: "No products match" })).toBeVisible();
  await page.getByRole("button", { name: "Clear filters" }).click();
  await expect(page.getByRole("table", { name: "Stock" })).toBeVisible();
  // The server fails for a filter change: the error card with Try again (no raw text), then the retry works.
  let fail = true;
  await page.route("**/api/inventory/stock?*", (route) => (fail ? route.fulfill({ status: 502, body: '{"error":"unavailable"}' }) : route.continue()));
  await page.getByRole("button", { name: /^Sold out/ }).click();
  await expect(page.getByRole("alert").filter({ hasText: "Couldn't load the stock" })).toBeVisible();
  fail = false;
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(page.getByRole("table", { name: "Stock" }).getByRole("link", { name: /Trousse toile enduite/ })).toBeVisible();
  // Server-side failures are expected in this test only.
  expect(errors.filter((e) => !/502/.test(e))).toEqual([]);
  await context.close();
});

test("admin_settings", async ({ browser }) => {
  const { context, page, errors } = await open(browser, adminState);
  await settled(page);
  await page.goto("/inventory/settings");
  await expect(page.getByRole("heading", { level: 1, name: "Inventory settings" })).toBeVisible();
  await page.getByLabel("Default hold length (days)").fill("21");
  await page.getByRole("button", { name: "Save" }).nth(1).click();
  await expect(toast(page)).toHaveText("Settings saved.");
  expect(sql(`select hold_days from private.inventory_settings s join public.profiles p on p.org_id = s.org_id where p.id = '${userId(adminEmail)}'`)).toBe("21");
  await page.getByLabel("Default hold length (days)").fill("14");
  await page.getByRole("button", { name: "Save" }).nth(1).click();
  await expect(toast(page)).toHaveText("Settings saved.");
  await page.getByLabel("Default hold length (days)").fill("99");
  await page.getByRole("button", { name: "Save" }).nth(1).click();
  await expect(page.getByRole("alert").filter({ hasText: "Enter 1 to 90 days." })).toBeVisible();
  expect(errors).toEqual([]);
  await context.close();
});

// Evidence screenshots (CLAUDE.md: 390, 768, 1024, 1280, 1440, 1728; light and dark; EN and FR): the Stock tab, the
// product panel (beside the table from 1280, the sheet at 1024, the product page below), the Arriving and Movements
// tabs and the correction dialog. Each shot checks for console errors and sideways scroll first.
test("screens", async ({ browser }) => {
  test.setTimeout(900_000);
  const dir = "test-results/inventory-screens";
  mkdirSync(dir, { recursive: true });
  const product = sql(`select id from public.products where name = 'Sweat capuche molleton'`);
  const widths = [390, 768, 1024, 1280, 1440, 1728];
  for (const locale of ["en", "fr"]) {
    for (const scheme of ["light", "dark"] as const) {
      for (const width of widths) {
        const { context, page, errors } = await open(browser, adminState, { width, locale, scheme });
        const name = (s: string) => `${dir}/${s}-${locale}-${scheme}-${width}.png`;
        await gotoInventory(page);
        await expect(page.locator("[data-stock-scroll]")).toBeVisible();
        expect(await noSideways(page), `stock ${locale} ${scheme} ${width}`).toBeLessThanOrEqual(0);
        await page.screenshot({ path: name("inventory") });
        if (width >= 1024) {
          await gotoInventory(page, `?product=${product}`);
          await expect(page.getByRole("heading", { name: "Sweat capuche molleton" })).toBeVisible();
        } else {
          await settled(page);
          await page.goto(`/inventory/p/${product}`);
          await expect(page.getByRole("heading", { level: 1, name: "Sweat capuche molleton" })).toBeVisible();
          await appReady(page);
        }
        expect(await noSideways(page)).toBeLessThanOrEqual(0);
        await page.screenshot({ path: name("product"), fullPage: width < 1024 });
        if ([390, 1440].includes(width)) {
          await page.getByRole("button", { name: locale === "fr" ? "Corriger le stock" : "Correct stock" }).click();
          await expect(page.getByRole("dialog").last()).toBeVisible();
          await page.waitForTimeout(350);
          await page.screenshot({ path: name("correct") });
          await page.keyboard.press("Escape");
          await gotoInventory(page, "?tab=arriving");
          await expect(page.getByRole("tabpanel")).toBeVisible();
          await page.screenshot({ path: name("arriving"), fullPage: true });
          await gotoInventory(page, "?tab=movements");
          await expect(page.getByRole("list").first()).toBeVisible();
          await page.screenshot({ path: name("movements"), fullPage: true });
        }
        expect(errors, `${locale} ${scheme} ${width}`).toEqual([]);
        await context.close();
      }
    }
  }
});
