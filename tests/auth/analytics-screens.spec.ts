import { mkdirSync } from "node:fs";
import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { appReady, createUser, fullSession, isCancelledPrefetch, youngSession } from "./helpers";
import { makeOrg, moveTo, userId } from "./home-fixture";
import { seedAnalytics } from "./analytics-fixture";

// Analytics evidence screenshots (P2 and P3; design 5.4, CLAUDE.md widths): the finished page with data ("This period",
// "Right now" and list quality) at 390, 768, 1024, 1280, 1440 and 1728, light and dark, English and French; and a
// representative set in EN light and FR dark at 390 and 1440: a new org's empty states, one card failing alone, the
// rep's view, a tooltip open on the Calls chart and on the heatmap (the phone's hour readout at 390), "Right now" in view
// (the admin's team and with a person picked), and the loading skeleton. URL asserted before each shot; no console error and no
// sideways scroll first. Saved to test-results/analytics-screens, or ANALYTICS_SCREENS_DIR (locally
// docs/evidence/analytics/screens). Local stack only, fake data.
test.describe.configure({ mode: "serial", timeout: 1_200_000 });

const dir = process.env.ANALYTICS_SCREENS_DIR || "test-results/analytics-screens";
const password = "Analytics-Screens-Pass-42!";
const run = Date.now();
const adminEmail = `analytics-shots-${run}@example.test`;
const repEmail = `analytics-shots-rep-${run}@example.test`;
const emptyEmail = `analytics-shots-empty-${run}@example.test`;
type State = Awaited<ReturnType<BrowserContext["storageState"]>>;
let state: State;
let repState: State;
let emptyState: State;
/** Who each saved session belongs to, so a session about to expire can be renewed (access tokens last 900 s). */
const who = new Map<State, { email: string; password: string; secret: string }>();
/** The saved session, or a new one when its access token is close to expiry (helpers.ts youngSession). */
async function fresh(browser: Browser, saved: State): Promise<State> {
  const person = who.get(saved);
  if (!person) throw new Error("unknown session");
  const next = await youngSession(browser, saved, person);
  if (next === saved) return saved;
  who.set(next, person);
  if (saved === state) state = next;
  else if (saved === repState) repState = next;
  else if (saved === emptyState) emptyState = next;
  return next;
}
let repId = "";

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
  name: string,
  combos: readonly { locale: string; scheme: "light" | "dark" }[],
  widths: number[],
  o: { as?: State; act?: (page: Page, width: number) => Promise<void>; path?: string; fullPage?: boolean; ready?: boolean } = {},
) {
  const base = test.info().project.use.baseURL ?? "http://localhost:3100";
  let session = o.as ?? state;
  for (const { locale, scheme } of combos) {
    for (const width of widths) {
      session = await fresh(browser, session);
      const context = await browser.newContext({
        storageState: session,
        viewport: { width, height: width < 600 ? 844 : 900 },
        colorScheme: scheme,
        timezoneId: "Europe/Paris",
        hasTouch: width < 600,
        reducedMotion: "reduce", // the figures at rest (no count-up or rise mid-frame)
      });
      await context.addCookies([{ name: "locale", value: locale, url: base }]);
      const page = await context.newPage();
      const errors: string[] = [];
      page.on("console", (m) => m.type() === "error" && !isCancelledPrefetch(m.text()) && errors.push(`${m.text()} (${m.location().url})`));
      page.on("pageerror", (e) => errors.push(e.message));
      const path = o.path ?? "/analytics";
      await page.goto(path);
      await expect(page).toHaveURL((url) => url.pathname === new URL(path, base).pathname);
      await appReady(page);
      if (o.ready !== false) {
        await expect(page.locator("[data-analytics-body]")).toBeVisible();
        // The lazy chart code has drawn (or the card has no chart).
        await page.waitForFunction(() => document.querySelectorAll(".analytics-chart").length === document.querySelectorAll(".analytics-chart svg.recharts-surface").length);
      }
      if (o.act) await o.act(page, width);
      await page.waitForTimeout(450);
      expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth), `${name} ${width} sideways scroll`).toBeLessThanOrEqual(0);
      await page.screenshot({ path: `${dir}/${name}-${locale}-${scheme}-${width}.png`, fullPage: o.fullPage ?? true });
      expect(errors.filter((e) => !/status of (500|429)/.test(e)), `${name} ${locale} ${scheme} ${width}`).toEqual([]);
      await context.close();
    }
  }
}

test.beforeAll(async ({ browser }) => {
  test.setTimeout(240_000);
  mkdirSync(dir, { recursive: true });
  const secret = await createUser(adminEmail, password, true);
  const repSecret = await createUser(repEmail, password, true);
  const emptySecret = await createUser(emptyEmail, password, true);
  const org = makeOrg(`Analytics screens ${run}`);
  moveTo(adminEmail, org, "admin", "Haider");
  moveTo(repEmail, org, "rep", "Kais");
  moveTo(emptyEmail, makeOrg(`Analytics screens empty ${run}`), "admin", "Henri");
  repId = userId(repEmail);
  seedAnalytics(org, userId(adminEmail), repId);
  state = await fullSession(browser, adminEmail, password, secret);
  repState = await fullSession(browser, repEmail, password, repSecret);
  emptyState = await fullSession(browser, emptyEmail, password, emptySecret);
  who.set(state, { email: adminEmail, password, secret });
  who.set(repState, { email: repEmail, password, secret: repSecret });
  who.set(emptyState, { email: emptyEmail, password, secret: emptySecret });
});

test("Analytics with data, every width, light and dark, EN and FR", async ({ browser }) => {
  await shoot(browser, "analytics", full, ALL);
});

test("representative set: empty org, one card failing, rep view, tooltips, skeleton", async ({ browser }) => {
  await shoot(browser, "analytics-empty", some, [390, 1440], { as: emptyState });
  await shoot(browser, "analytics-rep", some, [390, 1440], { as: repState });
  // One block failing alone: the 90-day view's answer with its heatmap part broken.
  await shoot(browser, "analytics-card-error", some, [390, 1440], {
    act: async (page) => {
      await page.route("**/api/analytics?*", async (route) => {
        const res = await route.fetch();
        const body = await res.json();
        body.callTimes = { ok: false };
        await route.fulfill({ response: res, json: body });
      });
      await page.getByRole("group", { name: /^(Date range|Période)$/ }).getByRole("button").nth(2).click();
      await expect(page.locator("[data-block-error]")).toHaveCount(1);
      await page.waitForFunction(() => document.querySelectorAll(".analytics-chart").length === document.querySelectorAll(".analytics-chart svg.recharts-surface").length);
    },
  });
  // A tooltip on the Calls chart (keyboard: the chart's one tab stop, then an arrow key), viewport only.
  await shoot(browser, "analytics-calls-tooltip", some, [390, 1440], {
    fullPage: false,
    act: async (page) => {
      const svg = page.locator("section[data-block=analytics-calls] svg.recharts-surface").first();
      await svg.scrollIntoViewIfNeeded();
      await svg.focus();
      for (let i = 0; i < 27; i++) await page.keyboard.press("ArrowRight"); // Paris today minus 2: the 6-call day
      await expect(page.locator("section[data-block=analytics-calls] .recharts-tooltip-wrapper").first()).toBeVisible();
    },
  });
  // The heatmap: a cell's tooltip on desktop; the hour readout on a phone (a tap on the 10:00 row).
  await shoot(browser, "analytics-heat", some, [390, 1440], {
    fullPage: false,
    act: async (page, width) => {
      const heat = page.locator("section[data-block=analytics-heat]");
      await heat.scrollIntoViewIfNeeded();
      if (width < 640) {
        await heat.locator("[data-heat=phone] [data-heat-row='10']").click();
        await expect(heat.locator("[data-heat-readout]")).toContainText("10:00");
        await heat.locator("[data-heat-readout]").scrollIntoViewIfNeeded();
      } else {
        await heat.locator("[data-heat=desktop] [role=gridcell][aria-label*='50']").first().hover();
        await expect(heat.locator("[data-heat=desktop] .absolute")).toBeVisible();
      }
    },
  });
  // "Right now" in view: the team's (links on Untouched and Overdue), and a person picked (no Overdue link).
  for (const [name, search] of [
    ["analytics-right-now", ""],
    ["analytics-right-now-person", "?idle=90&rep=REP"],
  ] as const) {
    await shoot(browser, name, some, [390, 1440], {
      path: `/analytics${search.replace("REP", repId)}`,
      fullPage: false,
      act: async (page) => {
        const section = page.locator("section[data-right-now]");
        await section.scrollIntoViewIfNeeded();
        await page.evaluate(() => document.querySelector("section[data-right-now]")!.scrollIntoView({ block: "start" }));
        await expect(section.locator("[data-coverage-tile=untouched] [data-kpi-number]")).toBeVisible();
      },
    });
  }
  // The skeleton (loading.tsx): a client navigation from More (its section list on a phone, the dock from 1024) with
  // Analytics' server answer held back, so the route's loading layout shows where the page will be.
  await shoot(browser, "analytics-loading", some, [390, 1440], {
    path: "/more",
    fullPage: false,
    ready: false,
    act: async (page) => {
      await page.waitForTimeout(800);
      await page.route((url) => url.pathname === "/analytics" && url.searchParams.has("_rsc"), async (route) => {
        await new Promise((r) => setTimeout(r, 6000));
        await route.continue().catch(() => {});
      });
      await page.locator('a[href="/analytics"]:visible').first().click();
      await expect(page.locator("[aria-busy=true] [data-analytics-skeleton]")).toBeVisible();
    },
  });
});
