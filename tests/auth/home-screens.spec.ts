import { mkdirSync } from "node:fs";
import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { appReady, createUser, fullSession } from "./helpers";
import { makeOrg, moveTo, seedHome, userId } from "./home-fixture";

// Day 5c evidence screenshots (design 8.5 "Screens", CLAUDE.md widths): Home with data (before Day 6, so Low stock shows
// its placeholder) at 390, 768, 1024, 1280, 1440 and 1728, light and dark, English and French; a representative set in
// EN light and FR dark at 390 and 1440: a new org's empty states, one card failing alone, Low stock filled from the
// Day 6 contract, the deal sheet over Home, the loading skeleton, and the Work queue card with Day 4c's counts. The
// person is an admin in an org made for this run, so the figures are the fixture's. URL asserted before each shot; no
// console error and no sideways scroll first. Saved to test-results/home-screens, or DAY5C_SCREENS_DIR (locally
// docs/evidence/day5c/screens).
test.describe.configure({ mode: "serial", timeout: 900_000 });

const dir = process.env.DAY5C_SCREENS_DIR || "test-results/home-screens";
const password = "Home-Screens-Pass-42!";
const run = Date.now();
const adminEmail = `home-shots-${run}@example.test`;
const repEmail = `home-shots-rep-${run}@example.test`;
const emptyEmail = `home-shots-empty-${run}@example.test`;
let state: Awaited<ReturnType<BrowserContext["storageState"]>>;
let emptyState: typeof state;

const full = [
  { locale: "en", scheme: "light" },
  { locale: "en", scheme: "dark" },
  { locale: "fr", scheme: "light" },
  { locale: "fr", scheme: "dark" },
] as const;
const ALL = [390, 768, 1024, 1280, 1440, 1728];
const some = [
  { locale: "en", scheme: "light" },
  { locale: "fr", scheme: "dark" },
] as const;
// Day 4c's queue_summary is not on this branch (the card says the count could not load); the shots show the card as it
// will look with 4c's contract, mocked, except the one shot named home-queue-before-4c.
const queueMock = { callable_now: 412, later_today: 1030 };

async function shoot(
  browser: Browser,
  name: string,
  combos: readonly { locale: string; scheme: "light" | "dark" }[],
  widths: number[],
  o: { as?: typeof state; act?: (page: Page) => Promise<void>; before?: (page: Page) => Promise<void>; path?: string; queue?: boolean; fullPage?: boolean } = {},
) {
  for (const { locale, scheme } of combos) {
    for (const width of widths) {
      const context = await browser.newContext({
        storageState: o.as ?? state,
        viewport: { width, height: width < 600 ? 844 : 900 },
        colorScheme: scheme,
        timezoneId: "Europe/Paris",
        hasTouch: width < 600,
        reducedMotion: "reduce", // the figures at rest (no count-up mid-frame)
      });
      await context.addCookies([{ name: "locale", value: locale, url: "http://localhost:3100" }]);
      const page = await context.newPage();
      const errors: string[] = [];
      page.on("console", (m) => m.type() === "error" && !/status of 502/.test(m.text()) && errors.push(`${m.text()} (${m.location().url})`));
      page.on("pageerror", (e) => errors.push(e.message));
      if (o.queue !== false) {
        await page.route("**/api/queue/summary", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(queueMock) }));
      }
      await o.before?.(page);
      await page.goto(o.path ?? "/");
      await expect(page).toHaveURL((url) => url.pathname === new URL(o.path ?? "/", "http://localhost:3100").pathname);
      if (!o.path) await expect(page.locator("main h1")).toBeVisible();
      await appReady(page);
      if (o.act) await o.act(page);
      await page.waitForTimeout(450);
      expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth), `${name} ${width} sideways scroll`).toBeLessThanOrEqual(0);
      await page.screenshot({ path: `${dir}/${name}-${locale}-${scheme}-${width}.png`, fullPage: o.fullPage ?? true });
      expect(errors, `${name} ${locale} ${scheme} ${width}`).toEqual([]);
      await context.close();
    }
  }
}

test.beforeAll(async ({ browser }) => {
  test.setTimeout(240_000);
  mkdirSync(dir, { recursive: true });
  const secret = await createUser(adminEmail, password, true);
  await createUser(repEmail, password, false);
  const emptySecret = await createUser(emptyEmail, password, true);
  const org = makeOrg(`Home screens ${run}`);
  moveTo(adminEmail, org, "admin", "Haider");
  moveTo(repEmail, org, "rep", "Kais");
  moveTo(emptyEmail, makeOrg(`Home screens empty ${run}`), "admin", "Henri");
  seedHome(org, userId(adminEmail), userId(repEmail), "");
  state = await fullSession(browser, adminEmail, password, secret);
  emptyState = await fullSession(browser, emptyEmail, password, emptySecret);
});

test("Home with data, every width, light and dark, EN and FR (before Day 6)", async ({ browser }) => {
  await shoot(browser, "home", full, ALL);
});

test("representative set: empty org, card error, low stock contract, deal sheet, skeleton, queue before 4c", async ({ browser }) => {
  await shoot(browser, "home-new-org", some, [390, 1440], { as: emptyState });
  const swap = (mutate: (d: Record<string, unknown>) => void) => async (page: Page) => {
    await page.route((url) => url.pathname === "/api/home" && url.searchParams.get("scope") === "mine", async (route) => {
      const res = await route.fetch();
      const data = (await res.json()) as Record<string, unknown>;
      mutate(data);
      await route.fulfill({ response: res, body: JSON.stringify(data) });
    });
    await page.getByRole("group", { name: /Figures for|Chiffres de/ }).getByRole("button", { name: /Mine|Moi/ }).click();
    await expect(page.getByRole("group", { name: /Figures for|Chiffres de/ }).getByRole("button", { name: /Mine|Moi/ })).toHaveAttribute("aria-pressed", "true");
    await page.waitForTimeout(300);
  };
  await shoot(browser, "home-card-error", some, [390, 1440], { act: swap((d) => (d.attention = { ok: false })) });
  await shoot(browser, "home-low-stock-day6", some, [390, 1440], {
    act: swap((d) => {
      d.lowStock = {
        ok: true,
        data: {
          low: 3, out: 1, deals_waiting: 2,
          items: [
            { product_id: "6f1c1c1e-7a3b-4c1d-9e2f-0a1b2c3d4e5f", name: "Denim jacket, washed blue", available: 120, reorder_point: 200, in_transit: 300, next_eta: "2026-10-24", state: "low" },
            { product_id: "7f1c1c1e-7a3b-4c1d-9e2f-0a1b2c3d4e5f", name: "Cargo trousers, khaki", available: 0, reorder_point: 50, in_transit: 0, next_eta: null, state: "out" },
            { product_id: "8f1c1c1e-7a3b-4c1d-9e2f-0a1b2c3d4e5f", name: "Wool scarf", available: 35, reorder_point: 60, in_transit: 80, next_eta: "2026-11-02", state: "low" },
          ],
        },
      };
    }),
  });
  await shoot(browser, "home-deal-sheet", some, [390, 1440], {
    fullPage: false,
    act: async (page) => {
      await page.getByRole("region", { name: /Needs attention|À surveiller/ }).getByRole("button").nth(1).click();
      await expect(page.getByRole("dialog")).toBeVisible();
    },
  });
  // The skeleton (loading.tsx): a client navigation from Leads with Home's server answer held back, so the route's
  // loading layout shows where the page will be.
  await shoot(browser, "home-loading", some, [390, 1440], {
    path: "/leads",
    fullPage: false,
    act: async (page) => {
      await page.waitForTimeout(800);
      await page.route((url) => url.pathname === "/" && url.searchParams.has("_rsc"), async (route) => {
        await new Promise((r) => setTimeout(r, 6000));
        await route.continue().catch(() => {});
      });
      await page.getByRole("navigation", { name: /Sections/ }).getByRole("link").first().click();
      await expect(page.locator("main [aria-busy='true']")).toBeVisible();
      await page.waitForTimeout(200);
    },
  });
  await shoot(browser, "home-queue-before-4c", [{ locale: "en", scheme: "light" }], [1440], { queue: false });
});
