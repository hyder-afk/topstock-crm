import { mkdirSync } from "node:fs";
import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { ageStepUp, appReady, createUser, fullSession, isCancelledPrefetch, nextWindow, setRole, settled, sql, totp, trackRequests } from "./helpers";

// Sales, holds and requests (Day 6d, design 11.5): a sale from the lead's Stock tab with the keyboard and its Undo,
// a Supplier Stock sale that leaves the stock alone, a price below the minimum (confirmed by an admin), a hold then
// "Sell" that uses it, a team-logged request answered from the Requests inbox, an old sale cancelled behind "Confirm
// it's you", a read-only lead for a rep, the empty sections, Cmd+K "Record sale…", then the evidence screenshots.
// Products and leads are made-up and carry the run tag; people are picked by e-mail, never by display name.
test.describe.configure({ mode: "serial" });

const password = "Sales-Pass-42!";
const run = Date.now();
const tag = String(run).slice(-5);
const adminEmail = `sales-admin-${run}@example.test`;
const repEmail = `sales-rep-${run}@example.test`;
const seedEmail = `sales-seed-${run}@example.test`;
let adminSecret = "";
let adminState: Awaited<ReturnType<BrowserContext["storageState"]>>;
let repState: Awaited<ReturnType<BrowserContext["storageState"]>>;

const apron = `Tablier coton ${tag}`;
const cup = `Gobelet bambou ${tag}`;
const leadName = `Maison Sales ${tag}`;
const emptyLeadName = `Atelier Vide ${tag}`;
let leadId = "";
let emptyLeadId = "";

function userId(email: string) {
  return sql(`select id from auth.users where email = '${email}'`);
}
function asUser(email: string, body: string) {
  const claims = `json_build_object('sub', '${userId(email)}', 'role', 'authenticated', 'aal', 'aal2', 'amr',
                   json_build_array(json_build_object('method', 'totp', 'timestamp', extract(epoch from now())::bigint)))::text`;
  return sql(`begin; select set_config('request.jwt.claims', ${claims}, true); set local role authenticated; ${body}; commit;`);
}
const pid = (name: string) => sql(`select id from public.products where name = '${name}'`);
const onHand = (name: string) =>
  sql(`select l.on_hand from public.stock_levels l join public.locations x on x.id = l.location_id
       where l.product_id = '${pid(name)}' and x.kind = 'warehouse'`);

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

async function gotoStockTab(page: Page, id = leadId) {
  await settled(page);
  await page.goto(`/leads/${id}?tab=stock`);
  await appReady(page);
  await expect(page.getByRole("tabpanel")).toBeVisible();
}
async function gotoInventory(page: Page, query = "") {
  await settled(page);
  await page.goto(`/inventory${query}`);
  await expect(page.locator("main h1")).toBeVisible();
  await appReady(page);
}
const toast = (page: Page) => page.getByRole("status").filter({ hasText: /\S/ }).last();
const noSideways = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
const panel = (page: Page) => page.getByRole("tabpanel");

/** Picks a product in a combobox: types a few letters, waits for the option, Enter. */
async function pickProduct(page: Page, scope: ReturnType<Page["getByRole"]>, name: string) {
  const boxes = scope.getByRole("combobox", { name: /^(Product|Produit)$/ });
  const before = await boxes.count();
  const box = boxes.last();
  await box.fill(name);
  await expect(scope.getByRole("option", { name: new RegExp(name) })).toBeVisible();
  await box.press("Enter");
  // Enter may wait for the latest letters' results: the pick is done when the search box gives way to the product.
  await expect(boxes).toHaveCount(before - 1);
}

test.beforeAll(async ({ browser }) => {
  test.setTimeout(300_000);
  adminSecret = await createUser(adminEmail, password, true);
  const repSecret = await createUser(repEmail, password, true);
  await createUser(seedEmail, password, false);
  setRole(adminEmail, "admin");
  setRole(repEmail, "rep");
  setRole(seedEmail, "manager");
  sql(`update public.profiles set first_name = 'Henri', last_name = 'Test' where id = '${userId(adminEmail)}'`);
  for (const [name, ppc, min, max, wh] of [
    [apron, 24, 3, 4, 960],
    [cup, 50, 1, 1.5, 500],
  ] as const) {
    asUser(
      seedEmail,
      `select public.create_product(p_name => '${name}', p_pieces_per_carton => ${ppc}, p_price_min => ${min}, p_price_max => ${max},
        p_category => 'Test', p_cost_per_piece => ${min / 2}, p_opening_qty => ${wh}, p_opening_location => 'warehouse')`,
    );
  }
  asUser(seedEmail, `select public.post_stock_movement('${pid(cup)}', 'receive', 300, 'transit', 'received')`);
  const lead = (name: string) =>
    sql(`insert into public.companies (org_id, name, owner_id, lead_status, country, city)
         select p.org_id, '${name}', p.id, 'warm', 'FR', 'Lyon' from public.profiles p where p.id = '${userId(adminEmail)}' returning id`)
      .split("\n")
      .find((l) => /^[0-9a-f-]{36}$/.test(l)) as string;
  leadId = lead(leadName);
  emptyLeadId = lead(emptyLeadName);
  adminState = await fullSession(browser, adminEmail, password, adminSecret);
  repState = await fullSession(browser, repEmail, password, repSecret);
});

test("record_sale_keyboard_then_undo", async ({ browser }) => {
  const { context, page, errors } = await open(browser, adminState);
  await gotoStockTab(page);
  await panel(page).getByRole("button", { name: "Record sale" }).click();
  const sheet = page.getByRole("dialog", { name: "Record sale" });
  await expect(sheet).toBeVisible();
  // The lead is set; the product search has the focus: a few letters, Enter, the quantity, Ctrl+Enter.
  await expect(sheet.getByRole("combobox", { name: "Product" })).toBeFocused();
  await page.keyboard.type(apron);
  await expect(sheet.getByRole("option", { name: new RegExp(apron) })).toBeVisible();
  await page.keyboard.press("Enter");
  // The pick moves the focus to the quantity (never back to the page).
  await expect(sheet.getByRole("combobox", { name: "Product" })).toHaveCount(0);
  await expect(sheet.getByLabel("Quantity")).toBeFocused();
  await sheet.getByLabel("Quantity").fill("48");
  await expect(sheet.getByLabel("Price per piece")).toHaveValue("4");
  await page.keyboard.press("ControlOrMeta+Enter");
  await expect(toast(page)).toContainText(/Sale \d+ recorded · 1 product · €192\.00/);
  expect(onHand(apron)).toBe("912");
  await expect(panel(page).getByRole("region", { name: "Bought" }).getByText("€192.00").first()).toBeVisible();
  // Undo (120 s): the pieces come back and the sale is cancelled.
  await toast(page).getByRole("button", { name: "Undo" }).click();
  await expect(toast(page)).toContainText(/Sale \d+ undone/);
  expect(onHand(apron)).toBe("960");
  expect(sql(`select status from private.orders where company_id = '${leadId}' order by created_at desc limit 1`)).toBe("cancelled");
  expect(errors).toEqual([]);
  await context.close();
});

test("supplier_stock_sale_no_stock_change", async ({ browser }) => {
  const { context, page, errors } = await open(browser, adminState);
  await gotoStockTab(page);
  await panel(page).getByRole("button", { name: "Record sale" }).click();
  const sheet = page.getByRole("dialog", { name: "Record sale" });
  await sheet.getByRole("radio", { name: "Supplier Stock" }).click();
  await expect(sheet.getByText("your stock does not change")).toBeVisible();
  await pickProduct(page, sheet, cup);
  await sheet.getByLabel("Quantity").fill("2000");
  await sheet.getByRole("button", { name: "Record sale" }).click();
  await expect(toast(page)).toContainText(/Sale \d+ recorded/);
  expect(onHand(cup)).toBe("500");
  expect(sql(`select fulfilment from private.orders where company_id = '${leadId}' order by created_at desc limit 1`)).toBe("direct_from_source");
  expect(errors).toEqual([]);
  await context.close();
});

test("below_min_confirm", async ({ browser }) => {
  const { context, page, errors } = await open(browser, adminState);
  await gotoStockTab(page);
  await panel(page).getByRole("button", { name: "Record sale" }).click();
  const sheet = page.getByRole("dialog", { name: "Record sale" });
  await pickProduct(page, sheet, apron);
  await sheet.getByLabel("Quantity").fill("24");
  await sheet.getByLabel("Price per piece").fill("2,50");
  await expect(sheet.getByText("Below your minimum price")).toBeVisible();
  const record = sheet.getByRole("button", { name: "Record sale" });
  await expect(record).toHaveAttribute("aria-disabled", "true");
  await expect(sheet.getByText("Confirm the price below the minimum")).toBeVisible();
  await sheet.getByRole("checkbox", { name: "Sell below the minimum price" }).check();
  await record.click();
  await expect(toast(page)).toContainText(/Sale \d+ recorded · 1 product · €60\.00/);
  expect(sql(`select bool_and(ol.below_min) from private.order_lines ol join private.orders o on o.id = ol.order_id
              where o.company_id = '${leadId}' and ol.unit_price = 2.5`)).toBe("t");
  expect(onHand(apron)).toBe("936");
  expect(errors).toEqual([]);
  await context.close();
});

test("hold_then_sell_held_uses_the_hold", async ({ browser }) => {
  const { context, page, errors } = await open(browser, adminState);
  await gotoStockTab(page);
  await panel(page).getByRole("button", { name: "Hold stock" }).click();
  const sheet = page.getByRole("dialog", { name: "Hold stock" });
  await pickProduct(page, sheet, apron);
  await sheet.getByLabel("Quantity").fill("4");
  await sheet.getByRole("radio", { name: "ctn" }).click();
  await sheet.getByRole("button", { name: "Hold 96 pcs" }).click();
  await expect(toast(page)).toContainText(`96 pcs of ${apron} held until`);
  const reserved = panel(page).getByRole("region", { name: /^Reserved/ });
  await expect(reserved.getByText(apron)).toBeVisible();
  // Extend adds 14 days; Sell opens the sale with the held pieces.
  await reserved.getByRole("button", { name: `Extend the hold on ${apron}` }).click();
  await expect(toast(page)).toContainText("Held until");
  await reserved.getByRole("button", { name: `Sell held ${apron}` }).click();
  const sale = page.getByRole("dialog", { name: "Record sale" });
  await expect(sale.getByLabel("Quantity")).toHaveValue("96");
  await sale.getByRole("button", { name: "Record sale" }).click();
  await expect(toast(page)).toContainText(/Sale \d+ recorded/);
  await expect(reserved.getByText("No stock held for this lead.")).toBeVisible();
  expect(sql(`select r.status || '/' || r.remaining from private.stock_reservations r where r.company_id = '${leadId}' order by r.created_at desc limit 1`)).toBe("fulfilled/0");
  expect(onHand(apron)).toBe("840");
  expect(errors).toEqual([]);
  await context.close();
});

test("team_logged_request_answered_from_inbox", async ({ browser }) => {
  const { context, page, errors } = await open(browser, adminState);
  await gotoStockTab(page);
  await panel(page).getByRole("button", { name: "Log a request" }).click();
  const sheet = page.getByRole("dialog", { name: "Log a request" });
  await pickProduct(page, sheet, cup);
  await sheet.getByLabel("Quantity").fill("100");
  await sheet.getByRole("button", { name: "Add item" }).click();
  await sheet.getByRole("button", { name: "Something not in the list" }).last().click();
  await sheet.getByLabel("What they want").fill("Sacs kraft 30 cm");
  await sheet.getByLabel("Quantity (pcs)").fill("200");
  await sheet.getByLabel("Note").fill("Pour le salon de mars");
  await sheet.getByRole("button", { name: "Log request" }).click();
  await expect(toast(page)).toHaveText("Request logged");
  const wants = panel(page).getByRole("region", { name: /Wants/ });
  await expect(wants.getByText("Asked 100 pcs · 500 pcs available now")).toBeVisible();
  await expect(wants.getByText("Asked 200 pcs · not in the list: ask the supplier")).toBeVisible();
  // The Requests inbox (team requests make no task: the person logging it is on it).
  await gotoInventory(page, "?tab=requests");
  const row = panel(page).getByRole("button", { name: new RegExp(leadName) });
  await row.click();
  await expect(row).toHaveAttribute("aria-expanded", "true");
  await panel(page).getByRole("button", { name: "Record sale" }).click();
  const sale = page.getByRole("dialog", { name: "Record sale" });
  await expect(sale.getByText(leadName)).toBeVisible();
  await expect(sale.getByLabel("Quantity")).toHaveValue("100");
  await sale.getByRole("button", { name: "Record sale" }).click();
  await expect(toast(page)).toContainText(/Sale \d+ recorded/);
  expect(sql(`select status from private.stock_requests where company_id = '${leadId}'`)).toBe("done");
  expect(onHand(cup)).toBe("400");
  expect(errors).toEqual([]);
  await context.close();
});

test("cancel_old_sale_needs_code", async ({ browser }) => {
  test.setTimeout(180_000);
  const out = asUser(
    adminEmail,
    `select (public.record_sale(p_company => '${leadId}', p_fulfilment => 'from_stock',
        p_lines => jsonb_build_array(jsonb_build_object('product_id', '${pid(apron)}', 'description', null, 'quantity', '10', 'unit_price', '4')),
        p_request_id => gen_random_uuid()))->>'number'`,
  );
  const number = out.split("\n").find((l) => /^\d+$/.test(l)) as string;
  // Ten minutes old: past the 2-minute Undo, so only a manager or an admin with a fresh code may cancel it.
  sql(`begin; set local session_replication_role = replica; update private.orders set created_at = now() - interval '10 minutes'
       where number = ${number} and company_id = '${leadId}'; commit;`);
  expect(onHand(apron)).toBe("830");
  const { context, page, errors } = await open(browser, adminState);
  await ageStepUp(context, 700);
  await gotoInventory(page, `?tab=sales&company=${leadId}`);
  await expect(panel(page).getByRole("button", { name: new RegExp(`Show sales of every lead \\(now ${leadName}\\)`) })).toBeVisible();
  await panel(page).getByRole("button", { name: new RegExp(`^No\\.\\s${number}\\s`) }).click();
  await panel(page).getByRole("button", { name: "Cancel sale" }).click();
  const dialog = page.getByRole("dialog", { name: `Cancel sale ${number}` });
  await dialog.getByLabel("Reason").fill("Client a annulé la commande");
  await dialog.getByRole("button", { name: "Cancel sale" }).click();
  const stepUp = page.getByRole("dialog", { name: "Confirm it’s you" });
  await expect(stepUp).toBeVisible();
  await nextWindow();
  await stepUp.getByLabel("6-digit code").fill(totp(adminSecret));
  await expect(toast(page)).toHaveText(`Sale ${number} cancelled`);
  expect(sql(`select status from private.orders where number = ${number} and company_id = '${leadId}'`)).toBe("cancelled");
  expect(onHand(apron)).toBe("840");
  expect(errors).toEqual([]);
  await context.close();
});

test("rep_sees_read_only_stock_tab", async ({ browser }) => {
  const { context, page, errors } = await open(browser, repState);
  await gotoStockTab(page);
  await expect(panel(page).getByText("Only Henri, a manager or an admin can sell to this lead.")).toBeVisible();
  await expect(panel(page).getByRole("button", { name: "Record sale" })).toHaveCount(0);
  await expect(panel(page).getByRole("region", { name: "Bought" })).toBeVisible();
  expect(errors).toEqual([]);
  await context.close();
});

test("product_keys_s_and_r_then_palette_hold_stock", async ({ browser }) => {
  const { context, page, errors } = await open(browser, adminState);
  await gotoInventory(page, `?q=${encodeURIComponent(cup)}`);
  const table = page.getByRole("table", { name: "Stock" });
  const row = table.getByRole("link", { name: new RegExp(cup) });
  await row.click();
  const product = page.getByRole("complementary", { name: "Product" });
  await expect(product.getByRole("heading", { name: cup })).toBeVisible();
  await expect(product.getByRole("button", { name: /^Record sale/ })).toBeVisible();
  // S: the sale sheet with this product on its first line and the lead search focused; Esc gives the focus back.
  await row.focus();
  await page.keyboard.press("s");
  const sale = page.getByRole("dialog", { name: "Record sale" });
  await expect(sale.getByRole("combobox", { name: "Lead" })).toBeFocused();
  await expect(sale.getByText(cup).first()).toBeVisible();
  await expect(sale.getByLabel("Quantity")).toHaveValue("");
  await page.keyboard.press("Escape");
  await expect(sale).toHaveCount(0);
  await expect(row).toBeFocused();
  // R: the hold sheet with this product; the lead, the quantity, Hold.
  await page.keyboard.press("r");
  const hold = page.getByRole("dialog", { name: "Hold stock" });
  await expect(hold.getByRole("combobox", { name: "Lead" })).toBeFocused();
  await page.keyboard.type(leadName);
  await expect(hold.getByRole("option", { name: new RegExp(leadName) })).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(hold.getByLabel("Quantity")).toBeFocused();
  await page.keyboard.type("10");
  await hold.getByRole("button", { name: "Hold 10 pcs" }).click();
  await expect(toast(page)).toContainText(`10 pcs of ${cup} held until`);
  expect(sql(`select count(*) from private.stock_reservations r where r.company_id = '${leadId}' and r.product_id = '${pid(cup)}'
              and r.status = 'active' and r.quantity = 10`)).toBe("1");
  // Cmd+K "Hold stock…": lead and product searched in the sheet; closing it leaves the focus on the page, not <body>.
  await page.keyboard.press("ControlOrMeta+k");
  await page.getByRole("combobox").first().fill("Hold stock");
  await page.keyboard.press("Enter");
  const fromPalette = page.getByRole("dialog", { name: "Hold stock" });
  await expect(fromPalette.getByRole("combobox", { name: "Lead" })).toBeFocused();
  await expect(fromPalette.getByRole("combobox", { name: "Product" })).toBeVisible();
  await expect(page).not.toHaveURL(/hold=1/);
  await page.keyboard.press("Escape");
  await expect(fromPalette).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => document.activeElement !== document.body)).toBe(true);
  // The ? sheet lists both keys.
  await page.keyboard.press("?");
  const help = page.getByRole("dialog", { name: "Keyboard shortcuts" });
  await expect(help.getByText("Record a sale of the open product")).toBeVisible();
  await expect(help.getByText("Hold the open product for a lead")).toBeVisible();
  expect(errors).toEqual([]);
  await context.close();
});

test("empty_sections_and_palette_record_sale", async ({ browser }) => {
  const { context, page, errors } = await open(browser, adminState);
  await gotoStockTab(page, emptyLeadId);
  await expect(panel(page).getByText("No requests from this client yet. Share your stock to get some.")).toBeVisible();
  await expect(panel(page).getByText("No stock held for this lead.")).toBeVisible();
  await expect(panel(page).getByText("No sales to this lead yet.")).toBeVisible();
  await page.keyboard.press("ControlOrMeta+k");
  await page.getByRole("combobox").first().fill("Record sale");
  await page.keyboard.press("Enter");
  const sheet = page.getByRole("dialog", { name: "Record sale" });
  await expect(sheet).toBeVisible();
  await expect(sheet.getByRole("combobox", { name: "Lead" })).toBeFocused();
  // The whole name: in CI's order leads.spec has just made 120 leads, many of them "Atelier …", before this spec.
  await page.keyboard.type(emptyLeadName);
  await expect(sheet.getByRole("option", { name: new RegExp(emptyLeadName) })).toBeVisible();
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await expect(sheet).toHaveCount(0);
  await expect(page).toHaveURL(/tab=sales/);
  await expect(page).not.toHaveURL(/record=1/);
  expect(errors).toEqual([]);
  await context.close();
});

test("sales_and_requests_filters_in_the_url", async ({ browser }) => {
  const { context, page, errors } = await open(browser, adminState);
  await gotoInventory(page, "?tab=sales");
  await panel(page).getByRole("radio", { name: "Supplier Stock" }).click();
  await expect(page).toHaveURL(/tab=sales&type=direct_from_source/);
  await page.reload();
  await appReady(page);
  await expect(panel(page).getByRole("radio", { name: "Supplier Stock" })).toHaveAttribute("aria-checked", "true");
  await expect(panel(page).getByText("Supplier Stock").first()).toBeVisible();
  await page.getByRole("tab", { name: /Requests/ }).click();
  await expect(page).not.toHaveURL(/type=/);
  await panel(page).getByRole("radio", { name: "Done" }).click();
  await expect(page).toHaveURL(/tab=requests&status=done/);
  await expect(panel(page).getByRole("button", { name: new RegExp(leadName) }).first()).toBeVisible();
  expect(errors).toEqual([]);
  await context.close();
});

// Evidence screenshots (CLAUDE.md: 390, 768, 1024, 1280, 1440, 1728; light and dark; EN and FR): the lead's Stock tab
// and the Sales tab at every width; the sale, hold and request sheets and the Requests tab at 390 and 1440.
test("screens", async ({ browser }) => {
  test.setTimeout(900_000);
  const dir = "test-results/sales-screens";
  mkdirSync(dir, { recursive: true });
  // One open request for the Wants section and the inbox.
  asUser(
    adminEmail,
    `select public.log_stock_request(p_company => '${leadId}', p_lines => jsonb_build_array(
       jsonb_build_object('product_id', '${pid(apron)}', 'description', null, 'quantity', '5', 'unit', 'carton'),
       jsonb_build_object('product_id', null, 'description', 'Sacs kraft 30 cm', 'quantity', '200', 'unit', 'piece')),
       p_note => 'Livraison avant le 15', p_request_id => gen_random_uuid())`,
  );
  asUser(adminEmail, `select public.post_stock_movement('${pid(cup)}', 'reserve', 150, 'warehouse', p_company => '${leadId}')`);
  const widths = [390, 768, 1024, 1280, 1440, 1728];
  for (const locale of ["en", "fr"]) {
    const fr = locale === "fr";
    for (const scheme of ["light", "dark"] as const) {
      for (const width of widths) {
        const { context, page, errors } = await open(browser, adminState, { width, locale, scheme });
        const name = (s: string) => `${dir}/${s}-${locale}-${scheme}-${width}.png`;
        await gotoStockTab(page);
        await expect(panel(page).getByRole("region").first()).toBeVisible();
        expect(await noSideways(page), `stock tab ${locale} ${scheme} ${width}`).toBeLessThanOrEqual(0);
        await page.screenshot({ path: name("lead-stock"), fullPage: true });
        if ([390, 1440].includes(width)) {
          for (const [button, shot] of [
            [fr ? "Enregistrer une vente" : "Record sale", "sale-sheet"],
            [fr ? "Réserver du stock" : "Hold stock", "hold-sheet"],
            [fr ? "Noter une demande" : "Log a request", "request-sheet"],
          ] as const) {
            await panel(page).getByRole("button", { name: button, exact: true }).first().click();
            const dialog = page.getByRole("dialog").last();
            await expect(dialog).toBeVisible();
            if (shot === "sale-sheet") await pickProduct(page, dialog, apron);
            await page.waitForTimeout(350);
            await page.screenshot({ path: name(shot) });
            await page.keyboard.press("Escape");
            if (shot === "sale-sheet") await page.keyboard.press("Escape");
            await expect(page.getByRole("dialog")).toHaveCount(0);
          }
        }
        await gotoInventory(page, "?tab=sales");
        const first = panel(page).getByRole("button", { expanded: false }).first();
        await first.click();
        await expect(panel(page).getByRole("table")).toBeVisible();
        expect(await noSideways(page), `sales ${locale} ${scheme} ${width}`).toBeLessThanOrEqual(0);
        await page.screenshot({ path: name("sales"), fullPage: true });
        if ([390, 1440].includes(width)) {
          await gotoInventory(page, "?tab=requests");
          await panel(page).getByRole("button", { name: new RegExp(leadName) }).first().click();
          await expect(panel(page).getByText(fr ? "Sacs kraft 30 cm" : "Sacs kraft 30 cm").last()).toBeVisible();
          expect(await noSideways(page)).toBeLessThanOrEqual(0);
          await page.screenshot({ path: name("requests"), fullPage: true });
        }
        expect(errors, `${locale} ${scheme} ${width}`).toEqual([]);
        await context.close();
      }
    }
  }
});
