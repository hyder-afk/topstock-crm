import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { makeOrg, moveTo, userId } from "./home-fixture";
import { appReady, createUser, fullSession, isCancelledPrefetch, settled, sql, trackRequests } from "./helpers";

// Day 7f evidence (local run only: DAY7F_SCREENS=1; CI skips the file): a won deal that stock records hold. The deal
// sheet says why where Reopen was and its stepper is off; the sheet's ⋯ menu and the board card's ⋯ menu have neither
// Reopen nor Delete. Photographed at 1280, 1440, 1728 and 390, light and dark, English and French, into
// test-results/screens/day7f (copied into docs/evidence/day7f/screens). Every shot also asserts the state, a clean
// console and no sideways scroll. Made-up people and deal in an organisation of their own for this run.
test.describe.configure({ mode: "serial", timeout: 900_000 });
test.skip(!process.env.DAY7F_SCREENS, "local evidence run: set DAY7F_SCREENS=1");

const dir = "test-results/screens/day7f";
const password = "Day7f-Held-Pass-42!";
const run = Date.now();
const adminEmail = `day7f-admin-${run}@example.test`;
const uuid = /^[0-9a-f-]{36}$/;
let adminState: Awaited<ReturnType<BrowserContext["storageState"]>>;
let deal = "";
const leadName = "Maison Verdane";

type Messages = Record<string, unknown>;
const messages: Record<"en" | "fr", Messages> = {
  en: JSON.parse(readFileSync(path.join(__dirname, "../../messages/en.json"), "utf8")),
  fr: JSON.parse(readFileSync(path.join(__dirname, "../../messages/fr.json"), "utf8")),
};
/** A message's text, so the same steps run in English and French. */
const m = (locale: "en" | "fr", key: string, value?: Record<string, string>) => {
  let text = key.split(".").reduce<unknown>((node, k) => (node as Messages)[k], messages[locale]) as string;
  for (const [k, v] of Object.entries(value ?? {})) text = text.replace(`{${k}}`, v);
  return text;
};

test.beforeAll(async ({ browser }) => {
  test.setTimeout(240_000);
  mkdirSync(dir, { recursive: true });
  const secret = await createUser(adminEmail, password, true);
  const org = makeOrg(`Day 7f ${run}`);
  moveTo(adminEmail, org, "admin", "Inès");
  const admin = userId(adminEmail);
  sql(`update public.profiles set last_name = 'Garnier' where id = '${admin}'`);
  const lead = sql(`insert into public.companies (org_id, name, owner_id, lead_status, phone, city, country)
                    values ('${org}', '${leadName}', '${admin}', 'warm', '06 12 34 56 78', 'Lyon', 'FR') returning id`);
  expect(lead).toMatch(uuid);
  // Won yesterday (superuser write: no guard, the history trigger writes the open row), then a confirmed sale names it.
  deal = sql(`insert into public.deals (org_id, company_id, stage_id, owner_id, created_by, title, value, fulfilment, status,
                                        closed_at, stage_entered_at, version, created_at)
              select '${org}', '${lead}', s.id, '${admin}', '${admin}', 'Vestes en jean, 2 palettes', 1500, 'from_stock', 'won',
                     now() - interval '1 day', now() - interval '1 day', 0, now() - interval '3 days'
                from public.pipeline_stages s where s.org_id = '${org}' and s.key = 'won' returning id`);
  expect(deal).toMatch(uuid);
  sql(`select set_config('request.jwt.claims', json_build_object('sub', '${admin}', 'role', 'authenticated')::text, true);
       insert into private.orders (company_id, deal_id, fulfilment) values ('${lead}', '${deal}', 'from_stock')`);
  adminState = await fullSession(browser, adminEmail, password, secret);
});

async function openBoard(browser: Browser, o: { locale: "en" | "fr"; scheme: "light" | "dark"; width: number }) {
  const context = await browser.newContext({
    storageState: adminState,
    viewport: { width: o.width, height: o.width < 600 ? 844 : 900 },
    colorScheme: o.scheme,
    timezoneId: "Europe/Paris",
    hasTouch: o.width < 600,
  });
  const baseURL = test.info().project.use.baseURL;
  if (!baseURL) throw new Error("baseURL is not set (playwright.auth.config.ts)");
  await context.addCookies([{ name: "locale", value: o.locale, url: baseURL }]);
  const page = await context.newPage();
  trackRequests(page);
  const errors: string[] = [];
  page.on("console", (msg) => msg.type() === "error" && !isCancelledPrefetch(msg.text()) && errors.push(`${msg.text()} (${msg.location().url})`));
  page.on("pageerror", (e) => !isCancelledPrefetch(e.message) && errors.push(e.message));
  await page.goto(`/pipeline?deal=${deal}`);
  await appReady(page);
  return { context, page, errors };
}

const sideways = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);

// Waits for the dialogs' and menus' entrance springs to finish before a picture.
async function still(page: Page) {
  await page.mouse.move(0, 0);
  await settled(page);
  await page.waitForTimeout(450);
}

const widths = (process.env.DAY7F_WIDTHS ?? "1280,1440,1728,390").split(",").map((w) => Number(w.trim()));

for (const locale of ["en", "fr"] as const) {
  for (const scheme of ["light", "dark"] as const) {
    test(`held won deal: sheet, sheet menu and card menu, ${locale} ${scheme}`, async ({ browser }) => {
      for (const width of widths) {
        const label = `${locale} ${scheme} ${width}`;
        const shot = (name: string) => `${dir}/${name}-${locale}-${scheme}-${width}.png`;
        const { context, page, errors } = await openBoard(browser, { locale, scheme, width });
        const sheet = page.getByRole("dialog");
        // The reason sits where Reopen was; the stepper is off; no Reopen button.
        const held = sheet.locator("[data-reopen-held]");
        await expect(held.locator("p"), label).toHaveText(m(locale, "Errors.blocked"));
        await expect(held.getByRole("link", { name: m(locale, "Deals.sheet.heldStock") }), label).toHaveAttribute("href", /\?tab=stock$/);
        await expect(sheet.getByRole("button", { name: m(locale, "Deals.menu.reopen") }), label).toHaveCount(0);
        const group = sheet.getByRole("radiogroup", { name: m(locale, "Deals.sheet.stepper") });
        await expect(group, label).toHaveAttribute("aria-describedby", (await held.locator("p").getAttribute("id"))!);
        const steps = group.getByRole("radio");
        await expect(steps, label).toHaveCount(4);
        for (const step of await steps.all()) await expect(step, label).toBeDisabled();
        await sheet.locator("[data-reopen-held]").scrollIntoViewIfNeeded();
        await still(page);
        expect(await sideways(page), `sheet ${label}`).toBeLessThanOrEqual(0);
        await page.screenshot({ path: shot("sheet") });

        // The sheet's ⋯ menu: Copy link only.
        await sheet.getByRole("button", { name: m(locale, "Deals.sheet.more") }).click();
        await expect(page.getByRole("menuitem", { name: m(locale, "Deals.menu.copyLink") }), label).toBeVisible();
        await expect(page.getByRole("menuitem", { name: m(locale, "Deals.menu.delete") }), label).toHaveCount(0);
        await still(page);
        expect(await sideways(page), `sheet menu ${label}`).toBeLessThanOrEqual(0);
        await page.screenshot({ path: shot("sheet-menu") });
        await page.keyboard.press("Escape");
        await sheet.getByRole("button", { name: m(locale, "Deals.sheet.close") }).click();
        await expect(page.getByRole("dialog"), label).toHaveCount(0);

        // The board card's ⋯ menu, from the details the sheet loaded: no Reopen, no Delete.
        if (width < 600) {
          const tabs = page.getByRole("navigation", { name: m(locale, "Pipeline.stageTabs") });
          await tabs.getByRole("button", { name: new RegExp(`^${m(locale, "Stages.short.won")}`) }).click();
        }
        const card = page.locator(`[data-deal-card="${deal}"]`);
        await card.scrollIntoViewIfNeeded();
        await card.hover();
        await card.getByRole("button", { name: m(locale, "Deals.moreActions", { name: leadName }) }).click();
        await expect(page.getByRole("menuitem", { name: m(locale, "Deals.menu.copyLink") }), label).toBeVisible();
        await expect(page.getByRole("menuitem", { name: m(locale, "Deals.menu.reopen") }), label).toHaveCount(0);
        await expect(page.getByRole("menuitem", { name: m(locale, "Deals.menu.delete") }), label).toHaveCount(0);
        // The menu starts with an item, not a separator line (apple-design audit finding).
        await expect(page.getByRole("menu").locator(":scope > *").first(), label).toHaveAttribute("role", "menuitem");
        await still(page);
        expect(await sideways(page), `card menu ${label}`).toBeLessThanOrEqual(0);
        await page.screenshot({ path: shot("card-menu") });
        await page.keyboard.press("Escape");
        await settled(page);
        expect(errors, label).toEqual([]);
        await context.close();
      }
    });
  }
}
