import { mkdirSync } from "node:fs";
import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { ageStepUp, appReady, createUser, fullSession, setRole, sql } from "./helpers";

// Evidence screenshots of More > Team: the list at every CLAUDE.md width in light and dark, English and French; the
// role menu, the confirmation (yours, with the warning), "Confirm it's you", the last-admin refusal, the route skeleton
// and More's Administration row at phone and desktop width. Made-up people in an organisation of their own for this
// run. Saved to test-results/screens/team; copied into docs/evidence/team/screens. Each shot checks for console errors
// and sideways scroll first.
test.describe.configure({ mode: "serial", timeout: 900_000 });

const dir = "test-results/screens/team";
const password = "Team-Screens-Pass-42!";
const run = Date.now();
const email = (who: string) => `team-shots-${who}-${run}@example.test`;
let state: Awaited<ReturnType<BrowserContext["storageState"]>>;

const all = [
  { locale: "en", scheme: "light" },
  { locale: "en", scheme: "dark" },
  { locale: "fr", scheme: "light" },
  { locale: "fr", scheme: "dark" },
] as const;
const widths = [390, 768, 1024, 1280, 1440, 1728];
const brief = [
  { locale: "en", scheme: "light", widths: [390, 1440] },
  { locale: "fr", scheme: "dark", widths: [390, 1440] },
] as const;

test.beforeAll(async ({ browser }) => {
  test.setTimeout(240_000);
  mkdirSync(dir, { recursive: true });
  const secret = await createUser(email("ines"), password, true);
  for (const who of ["malo", "sofia", "new"]) await createUser(email(who), password, false);
  const org = sql(`insert into public.orgs (name) values ('Team screens ${run}') returning id`);
  const people: [string, string, string, "admin" | "manager" | "rep"][] = [
    ["ines", "Inès", "Garnier", "admin"],
    ["malo", "Malo", "Perrin", "manager"],
    ["sofia", "Sofia", "Lambert", "rep"],
    ["new", "", "", "rep"],
  ];
  for (const [who, first, last, role] of people) {
    sql(`update public.profiles set org_id = '${org}', first_name = '${first}', last_name = '${last}'
         where id = (select id from auth.users where email = '${email(who)}')`);
    setRole(email(who), role);
  }
  state = await fullSession(browser, email("ines"), password, secret);
});

async function shoot(
  browser: Browser,
  name: string,
  combos: readonly { locale: string; scheme: "light" | "dark"; widths: readonly number[] }[],
  act?: (page: Page, context: BrowserContext) => Promise<void>,
  { path = "/more/team", fullPage = true, storage = state }: { path?: string; fullPage?: boolean; storage?: typeof state } = {},
) {
  for (const { locale, scheme, widths: ws } of combos) {
    for (const width of ws) {
      const context = await browser.newContext({ storageState: storage, viewport: { width, height: width < 600 ? 844 : 900 }, colorScheme: scheme });
      await context.addCookies([{ name: "locale", value: locale, url: "http://localhost:3100" }]);
      const page = await context.newPage();
      const errors: string[] = [];
      page.on("console", (m) => m.type() === "error" && errors.push(`${m.text()} (${m.location().url})`));
      page.on("pageerror", (e) => errors.push(e.message));
      await page.goto(path);
      await expect(page.locator("main h1").first()).toBeVisible();
      await appReady(page);
      if (act) await act(page, context);
      expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
      await page.screenshot({ path: `${dir}/${name}-${locale}-${scheme}-${width}.png`, fullPage });
      expect(errors, `${name} ${locale} ${scheme} ${width}`).toEqual([]);
      await context.close();
    }
  }
}

const roleButton = (page: Page, nth: number) => page.locator("main ul > li").nth(nth).getByRole("button");

test("team list: every width, light and dark, English and French", async ({ browser }) => {
  await shoot(
    browser,
    "team",
    all.map((c) => ({ ...c, widths })),
  );
});

test("More with the Administration row", async ({ browser }) => {
  await shoot(browser, "more-admin", brief, undefined, { path: "/more" });
});

test("team route skeleton", async ({ browser }) => {
  for (const { locale, scheme } of [
    { locale: "en", scheme: "light" },
    { locale: "fr", scheme: "dark" },
  ] as const) {
    for (const width of [390, 1024, 1440]) {
      const context = await browser.newContext({ storageState: state, viewport: { width, height: width < 600 ? 844 : 900 }, colorScheme: scheme });
      await context.addCookies([{ name: "locale", value: locale, url: "http://localhost:3100" }]);
      const page = await context.newPage();
      await page.goto("/more");
      await appReady(page);
      await page.waitForLoadState("networkidle");
      let release: () => void = () => {};
      const held = new Promise<void>((resolve) => (release = resolve));
      await page.route(/\/more\/team(\?|$)/, async (route) => {
        const headers = route.request().headers();
        if (headers.rsc && !headers["next-router-prefetch"]) await held;
        await route.continue();
      });
      await page.getByRole("link", { name: locale === "en" ? /^Team/ : /^Équipe/ }).click();
      await expect(page).toHaveURL(/\/more\/team$/);
      await expect(page.locator("main [aria-busy=true]")).toBeVisible();
      await page.waitForTimeout(300);
      expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
      await page.screenshot({ path: `${dir}/team-skeleton-${locale}-${scheme}-${width}.png` });
      release();
      await expect(page.locator("main h1").first()).toBeVisible();
      await context.close();
    }
  }
});

test("role menu, confirmation, confirm it's you, last admin", async ({ browser }) => {
  await shoot(browser, "team-menu", brief, async (page) => {
    await roleButton(page, 2).click();
    await expect(page.getByRole("menu")).toBeVisible();
    await page.waitForTimeout(250);
  }, { fullPage: false });
  // Yours: stepping down shows the warning.
  await shoot(browser, "team-confirm-self", brief, async (page) => {
    await roleButton(page, 0).click();
    await page.getByRole("menuitemradio").nth(2).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await page.waitForTimeout(350);
  }, { fullPage: false });
  // Only Inès is an admin here: stepping down is refused and the row says why.
  await shoot(browser, "team-last-admin", brief, async (page) => {
    await roleButton(page, 0).click();
    await page.getByRole("menuitemradio").nth(2).click();
    await page.getByRole("dialog").getByRole("button").last().click();
    await expect(page.locator("main ul > li").nth(0).locator("p.text-status-red")).toBeVisible();
    await page.waitForTimeout(350);
  });
  // Last: back-dating the code rotates this session, so it is done once and the shots share the result.
  const aged = await browser.newContext({ storageState: state });
  await ageStepUp(aged, 900);
  const stale = await aged.storageState();
  await aged.close();
  await shoot(
    browser,
    "team-step-up",
    brief,
    async (page) => {
      await roleButton(page, 2).click();
      await page.getByRole("menuitemradio").nth(1).click();
      await page.getByRole("dialog").getByRole("button").last().click();
      await expect(page.getByRole("dialog").getByRole("textbox")).toBeFocused();
      await page.waitForTimeout(350);
    },
    { fullPage: false, storage: stale },
  );
});

test.afterAll(() => {
  // Leave Inès an admin for any later run that reuses the stack.
  setRole(email("ines"), "admin");
});
