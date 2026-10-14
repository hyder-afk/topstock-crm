import { mkdirSync } from "node:fs";
import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { appReady, createUser, fullSession, setRole, sql } from "./helpers";

// Day 5b evidence screenshots (design 8.5 "Screens"): the pipeline board and the deal sheet at every CLAUDE.md width
// (390, 768, 1024, 1280, 1440, 1728), light and dark, English and French; a representative set of the rest (the lead's
// Deals tab, the Win dialog, New deal, the call panel's Open a deal switch, the board's loading skeleton) in EN light
// and FR dark at 390 and 1440. The person is a rep, so the board holds only their own made-up deals (D21) whatever
// else the reused local stack holds. URL asserted before each shot; no console error and no sideways scroll first.
// Saved to test-results/day5-screens (CI artifact), or DAY5_SCREENS_DIR.
test.describe.configure({ mode: "serial", timeout: 900_000 });

// DAY5_SCREENS_DIR moves them out of test-results, which Playwright empties at the start of every run (locally:
// docs/evidence/day5b/screens).
const dir = process.env.DAY5_SCREENS_DIR || "test-results/day5-screens";
const password = "Day5-Screens-Pass-42!";
const run = Date.now();
const email = `d5screens-${run}@example.test`;
let state: Awaited<ReturnType<BrowserContext["storageState"]>>;
let leadA = "";
let sheetDeal = "";
let me = "";
let org = "";

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

async function shoot(
  browser: Browser,
  path: string,
  name: string,
  combos: readonly { locale: string; scheme: "light" | "dark" }[],
  widths: number[],
  act?: (page: Page, width: number) => Promise<void>,
  { fullPage = false, before }: { fullPage?: boolean; before?: (page: Page) => Promise<void> } = {},
) {
  for (const { locale, scheme } of combos) {
    for (const width of widths) {
      const context = await browser.newContext({
        storageState: state,
        viewport: { width, height: width < 600 ? 844 : 900 },
        colorScheme: scheme,
        timezoneId: "Europe/Paris",
        hasTouch: width < 600,
      });
      await context.addCookies([{ name: "locale", value: locale, url: "http://localhost:3100" }]);
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
      const errors: string[] = [];
      page.on("console", (m) => m.type() === "error" && errors.push(`${m.text()} (${m.location().url})`));
      page.on("pageerror", (e) => errors.push(e.message));
      await before?.(page);
      await page.goto(path);
      await expect(page).toHaveURL((url) => url.pathname === new URL(path, "http://localhost:3100").pathname);
      if (act) await act(page, width);
      // The cards' and sheets' springs finish before the shot.
      await page.waitForTimeout(450);
      expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth), `${name} ${width} sideways scroll`).toBeLessThanOrEqual(0);
      await page.screenshot({ path: `${dir}/${name}-${locale}-${scheme}-${width}.png`, fullPage });
      expect(errors, `${name} ${locale} ${scheme} ${width}`).toEqual([]);
      await context.close();
    }
  }
}

const boardReady = async (page: Page) => {
  await expect(page.locator('[data-column="lead"] [data-deal-card]').first()).toBeVisible();
  await appReady(page);
};

test.beforeAll(async ({ browser }) => {
  test.setTimeout(240_000);
  mkdirSync(dir, { recursive: true });
  const secret = await createUser(email, password, true);
  setRole(email, "rep");
  me = sql(`select id from auth.users where email = '${email}'`);
  org = sql(`select org_id from public.profiles where id = '${me}'`);
  sql(`update public.profiles set first_name = 'Camille', last_name = 'Dubois' where id = '${me}'`);
  const lead = (name: string, city: string, status = "warm") =>
    sql(`insert into public.companies (org_id, name, owner_id, lead_status, phone, email, city, country)
         values ('${org}', '${name}', '${me}', '${status}', '06 12 34 56 78', 'achats@example.com', '${city}', 'FR') returning id`);
  leadA = lead("Maison Lefèvre Textiles", "Lyon");
  const leads = [
    leadA,
    lead("Comptoir du Nord", "Lille"),
    lead("Atelier Garonne", "Toulouse"),
    lead("Bazar Méditerranée", "Marseille"),
    lead("Les Halles de Nantes", "Nantes"),
    lead("Rive Gauche Distribution", "Paris"),
  ];
  // Made-up deals across the board: stage, title, value (null: no value yet), hours in stage, closed hours ago.
  const deals: [string, string, string | null, number, number | null, number][] = [
    ["lead", "Denim jackets, 2 pallets", "6800", 5, null, 0],
    ["lead", "Linen shirts, summer range", null, 30, null, 1],
    ["lead", "Wool scarves, 400 units", "2150.50", 200, null, 2],
    ["qualified", "Leather belts, mixed sizes", "11900", 50, null, 3],
    ["qualified", "Cotton tees, 1,200 units", "4380", 24 * 9, null, 4],
    ["negotiations", "Winter coats, full container", "48250", 24 * 3, null, 5],
    ["negotiations", "Sneakers, end of line", "18400", 26, null, 0],
    ["won", "Silk ties, 600 units", "9600", 0, 24 * 2, 1],
    ["won", "Polo shirts, 3 pallets", "22000", 0, 24 * 9, 2],
    ["lost", "Rain jackets", "7300", 0, 24 * 4, 3],
  ];
  for (const [stage, title, value, hours, closedAgo, l] of deals) {
    const closed = stage === "won" || stage === "lost";
    const id = sql(`insert into public.deals (org_id, company_id, stage_id, owner_id, created_by, title, value, fulfilment, status, closed_at,
                                              lost_reason, stage_entered_at, expected_close, version)
                    select '${org}', '${leads[l]}', s.id, '${me}', '${me}', '${title}', ${value ?? "null"},
                           ${stage === "won" ? "'from_stock'" : "null"}, '${closed ? stage : "open"}',
                           ${closed ? `now() - interval '${closedAgo} hours'` : "null"}, ${stage === "lost" ? "'price'" : "null"},
                           now() - interval '${closed ? closedAgo : hours} hours',
                           ${stage === "negotiations" ? "current_date + 12" : "null"}, 0
                      from public.pipeline_stages s where s.org_id = '${org}' and s.key = '${stage}' returning id`);
    if (title.startsWith("Winter coats")) sheetDeal = id;
  }
  // The deal sheet's history: moved Lead → Qualified → Negotiations over the last days (as the history trigger would
  // have written it; superuser fixture).
  sql(`update public.deals set version = 2 where id = '${sheetDeal}'`);
  state = await fullSession(browser, email, password, secret);
});

test("pipeline board: every width, light and dark, EN and FR", async ({ browser }) => {
  await shoot(browser, "/pipeline", "pipeline", full, ALL, boardReady);
});

test("deal sheet: every width, light and dark, EN and FR", async ({ browser }) => {
  await shoot(browser, `/pipeline?deal=${sheetDeal}`, "deal-sheet", full, ALL, async (page) => {
    await expect(page.getByRole("dialog")).toContainText("Rive Gauche Distribution");
    await appReady(page);
  });
});

test("representative set: lead Deals tab, Win dialog, New deal, call panel switch, loading skeleton", async ({ browser }) => {
  await shoot(browser, `/leads/${leadA}?tab=deals`, "lead-deals", some, [390, 1440], async (page) => {
    await expect(page.locator("main h1")).toHaveText("Maison Lefèvre Textiles");
    await expect(page.getByRole("tabpanel", { name: /^(Deals|Affaires)$/ })).toContainText("Denim jackets");
    await appReady(page);
  }, { fullPage: true });
  await shoot(browser, "/pipeline", "win-dialog", some, [390, 1440], async (page) => {
    await boardReady(page);
    const main = page.locator("[data-deal-card]").filter({ hasText: "Winter coats" }).first().locator("[data-deal-main]");
    await main.focus();
    await page.keyboard.press("Digit4");
    await expect(page.getByRole("dialog")).toBeVisible();
  });
  await shoot(browser, "/pipeline?new=1", "new-deal", some, [390, 1440], async (page) => {
    await expect(page.getByRole("dialog")).toBeVisible();
    await appReady(page);
  });
  await shoot(browser, `/leads/${leadA}`, "call-open-deal", some, [390, 1440], async (page) => {
    await expect(page.locator("main h1")).toBeVisible();
    await appReady(page);
    await page.locator('a[href^="tel:"]').filter({ visible: true }).first().click();
    const panel = page.getByRole("region", { name: /^(Calling|How did it go|Appel|Comment)/ });
    await expect(panel).toBeVisible();
    await panel.locator("button").filter({ hasText: /^(End call|Raccrocher)/ }).first().click();
    await page.keyboard.press("Digit5");
    await expect(panel.getByRole("switch")).toBeVisible();
  });
  // The skeleton (loading.tsx): a client navigation from the leads list with the pipeline's server answer held back
  // 6 s, so the route's loading layout shows where the board will be.
  await shoot(browser, "/leads", "pipeline-loading", some, [390, 1440], async (page) => {
    await expect(page.locator("main h1").first()).toBeVisible();
    await appReady(page);
    await page.route(/\/pipeline\?_rsc=/, async (route) => {
      await new Promise((r) => setTimeout(r, 6_000));
      await route.continue().catch(() => {});
    });
    await page.locator('nav a[href="/pipeline"]').first().click();
    await expect(page.locator('[aria-busy="true"]').first()).toBeVisible();
  });
});
