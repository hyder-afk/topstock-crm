import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { appReady, createUser, fullSession, seedLeads, setRole, sql } from "./helpers";

// Leads (Day 3a): the list pages and filters on the server, the preview shows contacts, leads and contacts can be
// added and edited, status and owner changes undo, saved views, phone layout, and an owner-only rule for reps.
// Fixtures are made-up companies seeded straight into the local database (helpers.seedLeads).
test.describe.configure({ mode: "serial" });

const password = "Leads-Pass-42!";
const run = Date.now();
const adminEmail = `leads-admin-${run}@example.test`;
const repEmail = `leads-rep-${run}@example.test`;
let adminState: Awaited<ReturnType<BrowserContext["storageState"]>>;
let repState: Awaited<ReturnType<BrowserContext["storageState"]>>;

test.beforeAll(async ({ browser }) => {
  test.setTimeout(240_000);
  const adminSecret = await createUser(adminEmail, password, true);
  const repSecret = await createUser(repEmail, password, true);
  setRole(adminEmail, "admin");
  setRole(repEmail, "rep");
  sql(`update public.profiles set first_name = 'Inès', last_name = 'Garnier'
       where id = (select id from auth.users where email = '${adminEmail}')`);
  sql(`update public.profiles set first_name = 'Malo', last_name = 'Perrin'
       where id = (select id from auth.users where email = '${repEmail}')`);
  // 120 leads, owned in turn by the admin and the rep (sorted by email: admin first).
  seedLeads([adminEmail, repEmail]);
  adminState = await fullSession(browser, adminEmail, password, adminSecret);
  repState = await fullSession(browser, repEmail, password, repSecret);
});

async function openLeads(page: Page, path = "/leads") {
  await page.goto(path);
  await expect(page.locator("main h1")).toContainText("Leads");
  await expect(page.getByRole("table")).toBeVisible();
  await appReady(page);
}

const table = (page: Page) => page.getByRole("table", { name: "Leads" });
const rowLinks = (page: Page) => table(page).getByRole("row").getByRole("link");
const preview = (page: Page) => page.locator("aside");

test.describe("desktop", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("120 leads, newest activity first; scrolling loads the rest page by page", async ({ browser }) => {
    const context = await browser.newContext({ storageState: adminState, viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
    await openLeads(page);
    await expect(page.locator("main h1")).toContainText("120");
    // Only the rows on screen exist in the page (virtualised), never all 120.
    expect(await rowLinks(page).count()).toBeLessThan(40);
    await expect(rowLinks(page).first()).toHaveText(/Comptoir Verdane/);
    // Scroll to the end: the next pages load until the end line appears.
    for (let i = 0; i < 12; i++) {
      await table(page).evaluate((el) => el.scrollTo(0, el.scrollHeight));
      if (await page.getByText("That is every lead for these filters.").isVisible()) break;
      await page.waitForTimeout(400);
    }
    await expect(page.getByText("That is every lead for these filters.")).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
    expect(errors).toEqual([]);
    await context.close();
  });

  test("search and filters narrow the list, live in the URL, and survive a reload", async ({ browser }) => {
    const context = await browser.newContext({ storageState: adminState, viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    await openLeads(page);
    await page.getByRole("searchbox", { name: "Search leads" }).fill("nordlys");
    await expect(page).toHaveURL(/q=nordlys/);
    await expect(page.locator("main h1")).toContainText("8");
    await expect(rowLinks(page).first()).toContainText("Nordlys");
    // A contact's name finds their company too.
    await page.getByRole("searchbox", { name: "Search leads" }).fill("Benali");
    await expect(rowLinks(page).first()).toBeVisible();
    await page.getByRole("searchbox", { name: "Search leads" }).fill("");
    await expect(page).not.toHaveURL(/q=/);

    await page.getByRole("button", { name: "Filters" }).click();
    await page.getByRole("checkbox", { name: "Customer", exact: true }).check();
    await page.getByRole("checkbox", { name: "Belgium" }).check({ timeout: 1000 }).catch(async () => {
      await page.getByRole("searchbox", { name: "Find a country" }).fill("belg");
      await page.getByRole("checkbox", { name: "Belgium" }).check();
    });
    await page.getByRole("button", { name: "Done" }).click();
    await expect(page).toHaveURL(/status=customer/);
    await expect(page).toHaveURL(/country=BE/);
    await expect(page.getByText("Status: Customer")).toBeVisible();
    await expect(page.getByText("Country: Belgium")).toBeVisible();
    // The count in the title arrives after the rows (it is hidden while it loads): wait for the filtered count.
    const titleCount = async () => Number((await page.locator("main h1").innerText()).replace(/\D/g, "") || "0");
    await expect.poll(titleCount).toBeGreaterThan(0);
    await expect.poll(titleCount).toBeLessThan(120);
    const filteredCount = String(await titleCount());

    await page.reload();
    await appReady(page);
    await expect(page.getByText("Status: Customer")).toBeVisible();
    await expect(page.locator("main h1")).toContainText(filteredCount);

    await page.getByRole("button", { name: "Remove filter Status: Customer" }).click();
    await page.getByRole("button", { name: "Remove filter Country: Belgium" }).click();
    await expect(page.locator("main h1")).toContainText("120");
    await context.close();
  });

  test("preview shows the lead; contacts can be added and edited; arrow keys move between leads", async ({ browser }) => {
    const context = await browser.newContext({ storageState: adminState, viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    await openLeads(page);
    await rowLinks(page).first().click();
    await expect(page).toHaveURL(/lead=/);
    await expect(preview(page).getByRole("heading", { level: 2 })).toHaveText("Comptoir Verdane");
    await expect(preview(page).getByRole("link", { name: "Call" })).toHaveAttribute("href", /^tel:\+3360000/);

    await preview(page).getByRole("button", { name: "Add contact" }).click();
    await preview(page).getByLabel("First name").fill("Clémence");
    await preview(page).getByLabel("Last name").fill("Aubry");
    await preview(page).getByLabel("Role").fill("Buyer");
    await preview(page).getByLabel("Email").fill("not-an-email");
    await preview(page).getByRole("button", { name: "Save contact" }).click();
    await expect(preview(page).getByText("Enter a valid email address, or leave it empty.")).toBeVisible();
    await preview(page).getByLabel("Email").fill("clemence@example.com");
    await preview(page).getByLabel("Phone").fill("+33 6 12 34 56 78");
    await preview(page).getByRole("button", { name: "Save contact" }).click();
    await expect(preview(page).getByText("Clémence Aubry")).toBeVisible();
    await expect(preview(page).getByRole("link", { name: "clemence@example.com" })).toHaveAttribute("href", "mailto:clemence@example.com");
    await expect(table(page).getByRole("row").filter({ hasText: "Comptoir Verdane" })).toContainText("1 contact");

    await preview(page).getByRole("button", { name: "Edit Clémence Aubry" }).click();
    await preview(page).getByLabel("Role").fill("Purchasing manager");
    await preview(page).getByRole("button", { name: "Save contact" }).click();
    await expect(preview(page).getByText("Purchasing manager")).toBeVisible();

    // Down arrow from the focused row opens the next lead in the preview.
    await rowLinks(page).first().focus();
    await page.keyboard.press("ArrowDown");
    await expect(preview(page).getByRole("heading", { level: 2 })).toHaveText("Maison Verdane");
    await expect(rowLinks(page).nth(1)).toBeFocused();
    await context.close();
  });

  test("adding a lead validates, then opens it; status change shows at once and undoes", async ({ browser }) => {
    const context = await browser.newContext({ storageState: adminState, viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    await openLeads(page);
    await page.getByRole("button", { name: "Add lead" }).first().click();
    const dialog = page.getByRole("dialog", { name: "Add a lead" });
    await dialog.getByRole("button", { name: "Save lead" }).click();
    await expect(dialog.getByText("Enter the company name.")).toBeVisible();
    await dialog.getByLabel("Company name").fill("Atelier Quintane");
    await dialog.getByLabel("Lead status").selectOption("warm");
    await dialog.getByLabel("Owner").selectOption({ label: "Malo Perrin" });
    await dialog.getByLabel("Phone").fill("+33 6 00 00 99 01");
    await dialog.getByLabel("Email").fill("bonjour@quintane.example.com");
    await dialog.getByLabel("City").fill("Nantes");
    await dialog.getByLabel("Country").selectOption("FR");
    await dialog.getByRole("button", { name: "Save lead" }).click();
    await expect(dialog).toBeHidden();
    await expect(preview(page).getByRole("heading", { level: 2 })).toHaveText("Atelier Quintane");
    await expect(preview(page).getByText("Malo Perrin").first()).toBeVisible();
    await expect(page.locator("main h1")).toContainText("121");

    await preview(page).getByRole("button", { name: "Set status" }).click();
    await page.getByRole("menuitemradio", { name: "Customer" }).click();
    await expect(preview(page).getByText("Customer").first()).toBeVisible();
    const toast = page.getByRole("status").filter({ hasText: "Status changed." });
    await expect(toast).toBeVisible();
    await toast.getByRole("button", { name: "Undo" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Change undone." })).toBeVisible();
    await expect(preview(page).getByText("Warm (in progress)").first()).toBeVisible();
    await expect.poll(() => sql("select lead_status from public.companies where name = 'Atelier Quintane'")).toBe("warm");
    await context.close();
  });

  test("bulk: select two leads and set their status; saved views save, apply and delete", async ({ browser }) => {
    const context = await browser.newContext({ storageState: adminState, viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    await openLeads(page, "/leads?sort=name");
    const rows = table(page).getByRole("row");
    await rows.nth(1).getByRole("checkbox").check();
    await rows.nth(2).getByRole("checkbox").check();
    await expect(page.getByText("2 selected")).toBeVisible();
    await page.getByRole("button", { name: "Set status" }).click();
    await page.getByRole("menuitem", { name: "Cool off" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Status changed on 2 leads." })).toBeVisible();
    await expect(rows.nth(1)).toContainText("Cool off");
    await expect(rows.nth(2)).toContainText("Cool off");

    await page.goto("/leads?status=cool_off");
    await appReady(page);
    await page.getByRole("button", { name: "Views" }).click();
    await page.getByLabel("Name for these filters").fill("Cooling off");
    await page.getByRole("button", { name: "Save view" }).click();
    await expect(page.getByRole("status").filter({ hasText: "View saved." })).toBeVisible();
    await page.keyboard.press("Escape");
    await page.goto("/leads");
    await appReady(page);
    await page.getByRole("button", { name: "Views" }).click();
    await page.getByRole("button", { name: "Cooling off", exact: true }).click();
    await expect(page).toHaveURL(/status=cool_off/);
    await page.getByRole("button", { name: "Views" }).click();
    await page.getByRole("button", { name: "Delete view Cooling off" }).click();
    await expect(page.getByRole("status").filter({ hasText: "View deleted." })).toBeVisible();
    await context.close();
  });
});

test("saved views with bad filters are tidied or left out; email links cannot add mail fields; cursors are checked", async ({
  browser,
}) => {
  sql(`insert into public.saved_views (org_id, user_id, section, name, filters_json)
       select p.org_id, p.id, 'leads', v.name, v.filters::jsonb
       from public.profiles p join auth.users u on u.id = p.id,
            (values ('Broken view', '"not filters"'), ('Tidied view', '{"q": "Verdane", "status": 5, "inactive": "soon"}'))
              as v (name, filters)
       where u.email = '${adminEmail}'`);
  const lead = sql(`select id from public.companies order by lower(name), id limit 1`);
  sql(`update public.companies set email = 'sales?cc=x&co@example.test' where id = '${lead}'`);
  const context = await browser.newContext({ storageState: adminState, viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  await openLeads(page, `/leads?sort=name&lead=${lead}`);
  await expect(preview(page).getByRole("link", { name: "sales?cc=x&co@example.test" })).toHaveAttribute(
    "href",
    "mailto:sales%3Fcc%3Dx%26co@example.test",
  );
  await page.getByRole("button", { name: "Views" }).click();
  await expect(page.getByRole("button", { name: "Broken view", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Tidied view", exact: true }).click();
  await expect(page).toHaveURL(/q=Verdane/);
  expect(page.url()).not.toMatch(/status=|inactive=/);
  // Paging cursors carry the last lead's sort value: a 200-character name (up to 400 UTF-16 units) is accepted.
  const afterId = "00000000-0000-4000-8000-000000000000";
  const cursor = (value: string) => `/api/leads?sort=name&after_value=${encodeURIComponent(value)}&after_id=${afterId}`;
  expect((await context.request.get(cursor("é".repeat(150)))).status()).toBe(200);
  expect((await context.request.get(cursor("😀".repeat(200)))).status()).toBe(200);
  expect((await context.request.get(cursor("a".repeat(401)))).status()).toBe(400);
  // On a sort by time the cursor must be a time: anything else is a bad request, not a server failure.
  const timeCursor = `/api/leads?sort=created&after_value=not-a-time&after_id=${afterId}`;
  expect((await context.request.get(timeCursor)).status()).toBe(400);
  expect(errors).toEqual([]);
  await context.close();
});

test("a rep reads every lead but changes only their own", async ({ browser }) => {
  const context = await browser.newContext({ storageState: repState, viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  await openLeads(page, "/leads?sort=name");
  await expect(page.locator("main h1")).toContainText("121");
  // A lead owned by the admin: visible, read-only.
  const adminLead = sql(`select c.id from public.companies c join auth.users u on u.id = c.owner_id
                         where u.email = '${adminEmail}' order by c.name limit 1`);
  await page.goto(`/leads?lead=${adminLead}`);
  await expect(preview(page).getByText("Only Inès Garnier or an admin can change this lead.")).toBeVisible();
  await expect(preview(page).getByRole("button", { name: "Edit lead" })).toHaveCount(0);
  await expect(preview(page).getByRole("button", { name: "Add contact" })).toHaveCount(0);
  // Their own lead: editable; the owner picker is locked to themselves.
  const repLead = sql(`select c.id from public.companies c join auth.users u on u.id = c.owner_id
                       where u.email = '${repEmail}' order by c.name limit 1`);
  await page.goto(`/leads?lead=${repLead}`);
  await preview(page).getByRole("button", { name: "Edit lead" }).click();
  await expect(preview(page).getByLabel("Owner")).toBeDisabled();
  await preview(page).getByLabel("City").fill("Rennes");
  await preview(page).getByRole("button", { name: "Save lead" }).click();
  await expect(preview(page).getByText("Rennes")).toBeVisible();
  // No bulk owner change for reps.
  await page.goto("/leads");
  await appReady(page);
  await table(page).getByRole("row").nth(1).getByRole("checkbox").check();
  await expect(page.getByRole("button", { name: "Set owner" })).toHaveCount(0);
  await context.close();
});

test("phone: list, then the lead full screen with a way back", async ({ browser }) => {
  const context = await browser.newContext({ storageState: adminState, viewport: { width: 390, height: 844 }, hasTouch: true });
  const page = await context.newPage();
  await openLeads(page);
  // Day 4b: below desktop width a tap opens the full lead page (design 7.1), with a way back to the same list.
  await rowLinks(page).first().tap();
  await expect(page).toHaveURL(/\/leads\/[0-9a-f-]{36}$/);
  await expect(page.locator("main h1")).toBeVisible();
  await expect(page.getByRole("searchbox", { name: "Search leads" })).toHaveCount(0);
  await page.getByRole("link", { name: "Leads", exact: true }).first().tap();
  await expect(table(page)).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
  await context.close();
});

test("the leads API refuses signed-out and bad requests", async ({ request }) => {
  const anon = await request.get("/api/leads", { maxRedirects: 0 });
  expect(anon.status()).toBe(401);
  const lead = await request.get("/api/leads/not-a-uuid", { maxRedirects: 0 });
  expect(lead.status()).toBe(401);
});
