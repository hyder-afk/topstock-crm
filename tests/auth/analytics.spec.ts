import { readFileSync } from "node:fs";
import path from "node:path";
import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { appReady, createUser, fullSession, isCancelledPrefetch, settled, trackRequests } from "./helpers";
import { makeOrg, moveTo, userId } from "./home-fixture";
import { XSS_NAME, expected, seedAnalytics } from "./analytics-fixture";

// Analytics P2 (design docs/evidence/analytics/design.md 5.3, the "This period" part): the page renders the seeded
// figures; the filters update the URL with replaceState and a reload restores the view; a rep sees no person picker and
// no Team table and only their own numbers (and the API refuses a colleague); the empty states; a 500 shows each card's
// Try again and a retry recovers; one failed block breaks only its card; a 429 keeps the old frame with the quiet line;
// prefetch waits 150 ms; "Show as table" holds the chart's numbers; the keyboard path through the charts and the
// heatmap; axe finds no aria-hidden-focus or nested-interactive; an untrusted product name renders as text. Each person
// lives in an org made for this run, so every figure is exact. Local stack only, fake data.
test.describe.configure({ mode: "serial" });

const password = "Analytics-Pass-42!";
const run = Date.now();
const adminEmail = `analytics-admin-${run}@example.test`;
const repEmail = `analytics-rep-${run}@example.test`;
const emptyEmail = `analytics-empty-${run}@example.test`;
type State = Awaited<ReturnType<BrowserContext["storageState"]>>;
let adminState: State;
let repState: State;
let emptyState: State;
let admin = "";
let rep = "";

const money = (n: number) => new Intl.NumberFormat("en", { style: "currency", currency: "EUR", maximumFractionDigits: 0 }).format(n);

async function open(browser: Browser, state: State, o: { width?: number; locale?: string; reducedMotion?: "reduce" | "no-preference"; bypassCSP?: boolean } = {}) {
  const width = o.width ?? 1440;
  const context = await browser.newContext({
    storageState: state,
    viewport: { width, height: width < 600 ? 844 : 900 },
    timezoneId: "Europe/Paris",
    hasTouch: width < 600,
    reducedMotion: o.reducedMotion ?? "reduce",
    bypassCSP: o.bypassCSP,
  });
  const base = test.info().project.use.baseURL ?? "http://localhost:3100";
  if (o.locale) await context.addCookies([{ name: "locale", value: o.locale, url: base }]);
  const page = await context.newPage();
  trackRequests(page);
  const errors: string[] = [];
  page.on("console", (m) => m.type() === "error" && !isCancelledPrefetch(m.text()) && errors.push(m.text()));
  page.on("pageerror", (e) => !isCancelledPrefetch(e.message) && errors.push(e.message));
  page.on("dialog", (d) => {
    errors.push(`dialog opened: ${d.message()}`);
    void d.dismiss();
  });
  return { context, page, errors };
}

async function gotoAnalytics(page: Page, search = "") {
  await settled(page);
  await page.goto(`/analytics${search}`);
  await expect(page.locator("main h1")).toBeVisible();
  await expect(page.locator("[data-analytics-body]")).toBeVisible();
  await appReady(page);
}

const tiles = (page: Page) => page.getByRole("group", { name: /Key figures for this period|Chiffres clés de la période/ });
// The figure as screen readers get it (the final value, whatever frame a count-up is on).
const tile = (page: Page, label: string) => tiles(page).locator("[data-tile]").filter({ has: page.getByText(label, { exact: true }) });
const figure = (page: Page, label: string) => tile(page, label).locator("[data-kpi-number] .sr-only");
const card = (page: Page, id: string) => page.locator(`section[data-block="analytics-${id}"]`);
const presets = (page: Page) => page.getByRole("group", { name: /^(Date range|Période)$/ });

test.beforeAll(async ({ browser }) => {
  test.setTimeout(240_000);
  const adminSecret = await createUser(adminEmail, password, true);
  const repSecret = await createUser(repEmail, password, true);
  const emptySecret = await createUser(emptyEmail, password, true);
  admin = userId(adminEmail);
  rep = userId(repEmail);
  const org = makeOrg(`Analytics e2e ${run}`);
  moveTo(adminEmail, org, "admin", "Ada");
  moveTo(repEmail, org, "rep", "Rita");
  moveTo(emptyEmail, makeOrg(`Analytics empty ${run}`), "admin", "Eva");
  seedAnalytics(org, admin, rep);
  adminState = await fullSession(browser, adminEmail, password, adminSecret);
  repState = await fullSession(browser, repEmail, password, repSecret);
  emptyState = await fullSession(browser, emptyEmail, password, emptySecret);
});

test("renders_seeded_figures", async ({ browser }) => {
  const { context, page, errors } = await open(browser, adminState);
  await gotoAnalytics(page);
  const t = expected.team;
  await expect(figure(page, "Calls")).toHaveText(String(t.calls));
  await expect(tile(page, "Calls")).toContainText(`${t.reached} reached`);
  await expect(figure(page, "Connect rate")).toHaveText("47%");
  await expect(tile(page, "Connect rate")).toContainText("9 of 19 calls");
  await expect(figure(page, "Won")).toHaveText(money(t.won));
  await expect(tile(page, "Won")).toContainText("4 deals");
  await expect(figure(page, "Win rate")).toHaveText("67%");
  await expect(tile(page, "Win rate")).toContainText("4 won · 2 lost");
  await expect(figure(page, "Median cycle")).toHaveText("9 d");
  await expect(figure(page, "Revenue")).toHaveText(money(t.revenue));
  await expect(tile(page, "Revenue")).toContainText("2 sales");
  // The range line and the polite "Updated" line.
  await expect(page.locator("[data-updated]")).toHaveAttribute("aria-live", "polite");
  await expect(page.locator("[data-updated]")).toContainText(/Paris time · Updated \d\d:\d\d/);
  // Every block drew its figures; the Team table holds both people and no error shows.
  for (const id of ["calls", "speed", "funnel", "lost", "team", "heat", "revenue", "products"]) {
    await expect(card(page, id)).toBeVisible();
    await expect(card(page, id).locator("[data-block-error]")).toHaveCount(0);
  }
  await expect(card(page, "calls").locator("svg.recharts-surface").first()).toBeVisible();
  await expect(card(page, "speed")).toContainText("Median 26 h");
  await expect(card(page, "funnel")).toContainText("8 deals opened; 6 reached Qualified, 5 Negotiations and 4 were won.");
  await expect(card(page, "funnel")).toContainText("1 deal opened by mistake, not counted as lost.");
  await expect(card(page, "lost")).toContainText("2 deals lost");
  const team = card(page, "team").getByRole("table");
  await expect(team.getByRole("row")).toHaveCount(3); // the header and two people
  await expect(team.getByRole("row", { name: /^Ada / })).toContainText("14");
  await expect(team.getByRole("row", { name: /^Rita / })).toContainText("5");
  // No Signal Red anywhere in a chart: every bar fill is a chart ink token.
  const fills = await page.locator(".analytics-chart path, .analytics-chart rect").evaluateAll((els) =>
    [...new Set(els.map((e) => e.getAttribute("fill")).filter((f): f is string => !!f && f !== "none"))],
  );
  expect(fills.filter((f) => !/^var\(--chart-(ink|ink-65|ink-35|cursor)\)$/.test(f))).toEqual([]);
  // The figures match the API.
  const api = await (await page.request.get("/api/analytics")).json();
  expect(api.activity.data.totals.calls).toBe(t.calls);
  expect(api.sales.data.totals.revenue).toBe("1644.00");
  expect(errors).toEqual([]);
  await context.close();
});

test("filters_update_the_url_without_history_entries", async ({ browser }) => {
  const { context, page, errors } = await open(browser, adminState);
  await gotoAnalytics(page);
  const length = await page.evaluate(() => history.length);
  await presets(page).getByRole("button", { name: "7 days" }).click();
  await expect(page).toHaveURL(/\/analytics\?range=7d$/);
  await expect(figure(page, "Calls")).toHaveText(String(expected.team.calls7d));
  await expect(presets(page).getByRole("button", { name: "7 days" })).toHaveAttribute("aria-pressed", "true");
  await presets(page).getByRole("button", { name: "90 days" }).click();
  await expect(page).toHaveURL(/\/analytics\?range=90d$/);
  await expect(card(page, "calls").getByRole("button", { name: "Show as table" }).or(card(page, "calls").getByText("Show as table"))).toBeVisible();
  expect(await page.evaluate(() => history.length)).toBe(length); // replaceState: no Back entries
  // A reload restores the view from the URL.
  await page.reload();
  await expect(page.locator("[data-analytics-body]")).toBeVisible();
  await expect(presets(page).getByRole("button", { name: "90 days" })).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("[data-updated]")).toContainText(/2026|2027/);
  // Custom dates from the picker: two days in this month.
  const today = await page.evaluate(() => new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Paris" }).format(new Date()));
  const first = `${today.slice(0, 8)}01`;
  await page.getByRole("combobox", { name: "Custom dates" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.locator(`button[data-iso="${first}"]`).click();
  await dialog.locator(`button[data-iso="${today}"]`).click();
  await expect(page).toHaveURL(new RegExp(`/analytics\\?range=custom&from=${first}&to=${today}$`));
  await expect(page.locator("[data-updated]")).toContainText("Paris time");
  // The person filter: Rita's figures, rep= in the URL, the Team table hidden; then the whole team again.
  await presets(page).getByRole("button", { name: "30 days" }).click();
  await page.getByRole("combobox", { name: "Figures for" }).click();
  await page.getByRole("option", { name: "Rita" }).click();
  await expect(page).toHaveURL(new RegExp(`/analytics\\?rep=${rep}$`));
  await expect(figure(page, "Calls")).toHaveText(String(expected.rep.calls));
  await expect(card(page, "team")).toHaveCount(0);
  await page.getByRole("combobox", { name: "Figures for" }).click();
  await page.getByRole("option", { name: "Whole team" }).click();
  await expect(page).toHaveURL(/\/analytics$/);
  await expect(figure(page, "Calls")).toHaveText(String(expected.team.calls));
  await expect(card(page, "team")).toBeVisible();
  expect(await page.evaluate(() => history.length)).toBe(length);
  expect(errors).toEqual([]);
  await context.close();
});

test("rep_sees_own_numbers_only", async ({ browser }) => {
  const { context, page, errors } = await open(browser, repState);
  await gotoAnalytics(page);
  await expect(page.getByRole("combobox", { name: "Figures for" })).toHaveCount(0);
  await expect(card(page, "team")).toHaveCount(0);
  await expect(figure(page, "Calls")).toHaveText(String(expected.rep.calls));
  await expect(figure(page, "Won")).toHaveText(money(expected.rep.won));
  await expect(figure(page, "Revenue")).toHaveText(money(expected.rep.revenue));
  // ?rep=<the admin> silently shows the rep's own figures; the API refuses it.
  await gotoAnalytics(page, `?rep=${admin}`);
  await expect(figure(page, "Calls")).toHaveText(String(expected.rep.calls));
  expect((await page.request.get(`/api/analytics?rep=${admin}`)).status()).toBe(403);
  expect((await page.request.get("/api/analytics?foo=1")).status()).toBe(400);
  expect(errors).toEqual([]);
  await context.close();
  const anon = await browser.newContext();
  expect((await anon.request.get(`${test.info().project.use.baseURL}/api/analytics`)).status()).toBe(401);
  await anon.close();
});

test("empty_states", async ({ browser }) => {
  const { context, page, errors } = await open(browser, emptyState);
  await gotoAnalytics(page);
  await expect(card(page, "calls")).toContainText("No calls, emails or messages logged in this period.");
  await expect(card(page, "calls").getByRole("link", { name: "Open the work queue" })).toHaveAttribute("href", "/leads/queue");
  await expect(card(page, "speed")).toContainText("No leads added by hand in this period.");
  await expect(card(page, "funnel")).toContainText("No deals opened or closed in this period.");
  await expect(card(page, "lost")).toContainText("No deals lost in this period.");
  await expect(card(page, "heat")).toContainText("The map fills in once an hour slot has 5 calls.");
  await expect(card(page, "revenue")).toContainText("No sales recorded in this period.");
  await expect(card(page, "products")).toContainText("No sales recorded in this period.");
  await expect(figure(page, "Calls")).toHaveText("0");
  await expect(tile(page, "Win rate")).toContainText("Not enough closed deals yet");
  expect(errors).toEqual([]);
  await context.close();
});

test("errors_per_card_and_retry", async ({ browser }) => {
  const { context, page, errors } = await open(browser, adminState);
  await gotoAnalytics(page);
  let fail = true;
  await page.route("**/api/analytics?*", (route) => (fail ? route.fulfill({ status: 500, body: "{}" }) : route.continue()));
  await presets(page).getByRole("button", { name: "7 days" }).click();
  for (const id of ["calls", "speed", "funnel", "lost", "team", "heat", "revenue", "products"]) {
    await expect(card(page, id).getByRole("button", { name: "Try again" })).toBeVisible();
  }
  await expect(tiles(page).getByRole("button", { name: "Try again" }).first()).toBeVisible();
  fail = false;
  await card(page, "calls").getByRole("button", { name: "Try again" }).click();
  await expect(figure(page, "Calls")).toHaveText(String(expected.team.calls7d));
  await expect(page.locator("[data-block-error]")).toHaveCount(0);
  // One block failing breaks only its card.
  await page.unroute("**/api/analytics?*");
  await page.route("**/api/analytics?*", async (route) => {
    const res = await route.fetch();
    const body = await res.json();
    body.callTimes = { ok: false };
    await route.fulfill({ response: res, json: body });
  });
  await presets(page).getByRole("button", { name: "90 days" }).click();
  await expect(card(page, "heat").getByRole("button", { name: "Try again" })).toBeVisible();
  await expect(page.locator("[data-block-error]")).toHaveCount(1);
  await expect(card(page, "calls").locator("svg.recharts-surface").first()).toBeVisible();
  // Console errors from the mocked 500s are the browser's own network lines; nothing else.
  expect(errors.filter((e) => !/status of 500/.test(e))).toEqual([]);
  await context.close();
});

test("rate_limited_keeps_the_old_frame", async ({ browser }) => {
  const { context, page, errors } = await open(browser, adminState);
  await gotoAnalytics(page);
  let limited = true;
  let calls = 0;
  await page.route("**/api/analytics?*", (route) => {
    calls++;
    return limited
      ? route.fulfill({ status: 429, headers: { "Retry-After": "2", "content-type": "application/json" }, body: '{"error":"rate_limited"}' })
      : route.continue();
  });
  // A click without a pointer resting on the button first (a resting pointer would warm the view itself: one more read).
  await presets(page).getByRole("button", { name: "7 days" }).dispatchEvent("click");
  await expect(page.locator("[data-rate-limited]")).toHaveText("Too many updates, showing the last figures. Try again in 2 s.");
  await expect(figure(page, "Calls")).toHaveText(String(expected.team.calls)); // the old frame stays
  await expect(page.locator("[data-block-error]")).toHaveCount(0);
  limited = false;
  // It retries once, after Retry-After.
  await expect(figure(page, "Calls")).toHaveText(String(expected.team.calls7d), { timeout: 10_000 });
  await expect(page.locator("[data-rate-limited]")).toHaveCount(0);
  expect(calls).toBe(2);
  expect(errors.filter((e) => !/status of 429/.test(e))).toEqual([]);
  await context.close();
});

test("prefetch_waits_150ms_once_per_fresh_key", async ({ browser }) => {
  const { context, page } = await open(browser, adminState);
  await gotoAnalytics(page);
  const seen: string[] = [];
  page.on("request", (r) => r.url().includes("/api/analytics") && seen.push(new URL(r.url()).search));
  const button = presets(page).getByRole("button", { name: "90 days" });
  const box = (await button.boundingBox())!;
  // A pass under 150 ms sends nothing: the pointer enters and leaves 60 ms later, timed inside the page (a loaded
  // machine's round trips must not stretch the pass).
  await button.evaluate(
    (el) =>
      new Promise<void>((resolve) => {
        el.dispatchEvent(new PointerEvent("pointerover", { bubbles: true, pointerType: "mouse" }));
        setTimeout(() => {
          el.dispatchEvent(new PointerEvent("pointerout", { bubbles: true, pointerType: "mouse", relatedTarget: document.body }));
          resolve();
        }, 60);
      }),
  );
  await page.waitForTimeout(400);
  expect(seen).toEqual([]);
  // Resting sends one; resting again while fresh sends nothing more.
  for (let i = 0; i < 2; i++) {
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.waitForTimeout(400);
    await page.mouse.move(0, 0);
    await page.waitForTimeout(200);
  }
  expect(seen).toEqual(["?range=90d"]);
  await context.close();
});

test("show_as_table_equals_the_chart_and_the_keyboard_path", async ({ browser }) => {
  const { context, page, errors } = await open(browser, adminState);
  await gotoAnalytics(page);
  const api = (await (await page.request.get("/api/analytics")).json()) as { activity: { data: { buckets: { calls: number; reached: number }[] } } };
  const calls = card(page, "calls");
  await calls.getByText("Show as table").click();
  const rows = calls.getByRole("table").locator("tbody tr");
  await expect(rows).toHaveCount(api.activity.data.buckets.length);
  const cells = await rows.evaluateAll((trs) => trs.map((tr) => [...tr.querySelectorAll("td")].slice(0, 2).map((td) => Number(td.textContent!.replace(/\D/g, "")))));
  expect(cells).toEqual(api.activity.data.buckets.map((b) => [b.calls, b.reached]));
  // The chart's one tab stop is its svg, named and described by the caption; arrow keys move the tooltip.
  const svg = calls.locator("svg.recharts-surface").first();
  await expect(svg).toHaveAttribute("aria-label", /Calls chart\. Arrow keys move through the days/);
  const describedBy = await svg.getAttribute("aria-describedby");
  expect(describedBy).toBeTruthy();
  await expect(page.locator(`[id="${describedBy}"]`)).toContainText("19 calls, 47% reached");
  await svg.focus();
  await page.keyboard.press("ArrowRight");
  const tip = calls.locator(".recharts-tooltip-wrapper").first();
  await expect(tip).toBeVisible();
  // The tooltip's numbers are the table's for the same bucket.
  await expect(tip.locator("p").first()).not.toBeEmpty();
  const lead = (await tip.locator("p").first().textContent())!.trim();
  const row = rows.filter({ has: page.getByRole("rowheader", { name: lead, exact: true }) });
  await expect(row).toHaveCount(1);
  const [n, reached] = await row.locator("td").evaluateAll((tds) => tds.slice(0, 2).map((td) => td.textContent!.trim()));
  await expect(tip).toContainText(n === "0" ? "No calls" : `${n} call${n === "1" ? "" : "s"} · ${reached} reached`);
  // Heatmap: one tab stop, arrows, Home and End, PageUp and PageDown move between cells; each cell reads its numbers.
  const grid = card(page, "heat").locator("[data-heat=desktop] [role=grid]");
  await expect(grid.getByRole("row")).toHaveCount(8); // the hour header row and 7 weekdays
  await expect(grid.locator("[role=gridcell][tabindex='0']")).toHaveCount(1);
  await grid.locator("[role=gridcell][tabindex='0']").focus();
  await page.keyboard.press("ArrowRight");
  await expect(grid.locator("[role=gridcell]:focus")).toHaveAttribute("aria-label", /^Monday 08:00, /);
  await page.keyboard.press("End");
  await expect(grid.locator("[role=gridcell]:focus")).toHaveAttribute("aria-label", /^Monday 20:00, /);
  await page.keyboard.press("PageDown");
  await expect(grid.locator("[role=gridcell]:focus")).toHaveAttribute("aria-label", /^Sunday 20:00, /);
  await page.keyboard.press("Home");
  await expect(grid.locator("[role=gridcell]:focus")).toHaveAttribute("aria-label", /^Sunday 07:00, /);
  await expect(grid.locator("[role=gridcell][tabindex='0']")).toHaveCount(1);
  // A cell with enough calls reads its rate.
  await expect(grid.locator("[role=gridcell][aria-label*='6 calls, 3 reached, 50%']")).toHaveCount(1);
  expect(errors).toEqual([]);
  await context.close();
});

test("axe_no_aria_hidden_focus_or_nested_interactive", async ({ browser }) => {
  const { context, page } = await open(browser, adminState, { bypassCSP: true });
  await gotoAnalytics(page);
  await card(page, "products").locator("svg.recharts-surface").waitFor();
  await page.addScriptTag({ content: readFileSync(path.join(__dirname, "..", "..", "node_modules", "axe-core", "axe.min.js"), "utf8") });
  const run = async () =>
    page.evaluate(async () => {
      const axe = (window as unknown as { axe: { run: (ctx: unknown, opts: unknown) => Promise<{ violations: { id: string; nodes: { target: string[] }[] }[] }> } }).axe;
      // The page's own content (the dock's bead is the shell's, outside this page: logged in p2.md).
      const r = await axe.run({ include: [["main"]] }, { runOnly: { type: "rule", values: ["aria-hidden-focus", "nested-interactive", "aria-required-children", "aria-required-parent", "aria-allowed-role", "button-name", "duplicate-id-aria"] } });
      return r.violations.map((v) => `${v.id}: ${v.nodes.map((n) => `${n.target.join(" ")} ${(n as unknown as { html: string }).html.slice(0, 300)}`).join(", ")}`);
    });
  expect(await run()).toEqual([]);
  // With a tooltip open too.
  await card(page, "calls").locator("svg.recharts-surface").first().focus();
  await page.keyboard.press("ArrowRight");
  expect(await run()).toEqual([]);
  // Both orientations of the heatmap are real grids.
  for (const which of ["desktop", "phone"]) {
    const grid = card(page, "heat").locator(`[data-heat=${which}] [role=grid]`);
    expect(await grid.locator("[role=row] [role=gridcell]").count()).toBeGreaterThan(0);
    expect(await grid.locator("[role=row] [role=rowheader]").count()).toBeGreaterThan(0);
    expect(await grid.locator("[role=row] [role=columnheader]").count()).toBeGreaterThan(0);
  }
  await context.close();
});

test("untrusted_product_name_renders_as_text", async ({ browser }) => {
  const { context, page, errors } = await open(browser, adminState, { reducedMotion: "no-preference" });
  await gotoAnalytics(page);
  const products = card(page, "products");
  await expect(products.locator("figcaption")).toContainText(XSS_NAME);
  await products.getByText("Show as table").click();
  await expect(products.getByRole("table").getByRole("rowheader", { name: XSS_NAME })).toBeVisible();
  // The tick shows the name cut, as text; the tooltip shows it whole.
  await expect(products.locator(".recharts-yAxis-tick-labels text").first()).toHaveText("<img src=x onerro…");
  await products.locator("svg.recharts-surface").focus();
  await page.keyboard.press("ArrowRight");
  await expect(products.locator(".recharts-tooltip-wrapper")).toContainText(XSS_NAME);
  expect(await page.locator("main img").count()).toBe(0);
  expect(errors).toEqual([]); // no dialog opened, no console error
  await context.close();
});

test("count_up_and_entrance_on_the_first_view_only", async ({ browser }) => {
  // Motion allowed: the first view of Analytics in this tab (a client navigation from the dock) counts up and the bars
  // rise; a second view in the same tab does neither.
  const { context, page, errors } = await open(browser, adminState, { reducedMotion: "no-preference" });
  await context.addInitScript(() => {
    const w = window as unknown as { __seen: { pending: number; numbers: string[] } };
    w.__seen = { pending: 0, numbers: [] };
    new MutationObserver(() => {
      if (document.querySelector("[data-enter=pending]")) w.__seen.pending++;
    }).observe(document, { subtree: true, childList: true, attributes: true, attributeFilter: ["data-enter"] });
    const tick = () => {
      const el = document.querySelector("[data-tile] [data-kpi-number] [aria-hidden=true]:not(.invisible)");
      if (el?.textContent) w.__seen.numbers.push(el.textContent);
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  await settled(page);
  await page.goto("/pipeline");
  await appReady(page);
  const seen = () => page.evaluate(() => (window as unknown as { __seen: { pending: number; numbers: string[] } }).__seen);
  await page.locator('nav a[href="/analytics"]').click();
  await expect(page.locator("[data-analytics-body]")).toBeVisible();
  await expect(figure(page, "Calls")).toHaveText(String(expected.team.calls));
  await page.waitForTimeout(1500);
  const first = await seen();
  expect(first.pending).toBeGreaterThan(0);
  expect(first.numbers.some((n) => Number(n) < expected.team.calls)).toBe(true);
  expect(first.numbers.at(-1)).toBe(String(expected.team.calls));
  await expect(page.locator("[data-enter=pending]")).toHaveCount(0);
  // Away and back in the same tab: no count, no rise.
  await page.locator('nav a[href="/pipeline"]').click();
  await expect(page).toHaveURL(/\/pipeline$/);
  await page.evaluate(() => {
    const w = window as unknown as { __seen: { pending: number; numbers: string[] } };
    w.__seen.pending = 0;
    w.__seen.numbers = [];
  });
  await page.locator('nav a[href="/analytics"]').click();
  await expect(page.locator("[data-analytics-body]")).toBeVisible();
  await page.waitForTimeout(1000);
  const again = await seen();
  expect(again.pending).toBe(0);
  expect(again.numbers.every((n) => n === String(expected.team.calls))).toBe(true);
  expect(errors).toEqual([]);
  await context.close();
  // Reduced motion: the final figures at once, nothing collapsed waiting to rise.
  const reduced = await open(browser, adminState, { reducedMotion: "reduce" });
  await gotoAnalytics(reduced.page);
  await expect(reduced.page.locator("[data-enter=pending]")).toHaveCount(0);
  const shown = await tile(reduced.page, "Calls").locator("[data-kpi-number] [aria-hidden=true]:not(.invisible)").textContent();
  expect(shown).toBe(String(expected.team.calls));
  await reduced.context.close();
});

test("phone_heatmap_fits_326px_and_hour_rows_read_out", async ({ browser }) => {
  const { context, page, errors } = await open(browser, adminState, { width: 390 });
  await gotoAnalytics(page);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
  const phone = card(page, "heat").locator("[data-heat=phone]");
  const grid = phone.getByRole("grid");
  // 32 px labels + 7 × 40 px columns + 7 × 2 px gaps = 326 px; rows 44 px tall; hours as rows, weekdays as columns.
  const box = (await grid.boundingBox())!;
  expect(Math.round(box.width)).toBe(326);
  const row = grid.locator("[data-heat-row='10']");
  expect(Math.round((await row.boundingBox())!.height)).toBe(44);
  await expect(grid.locator("[role=columnheader]")).toHaveCount(8);
  await expect(card(page, "heat").locator("[data-heat=desktop]")).toBeHidden();
  const readout = phone.locator("[data-heat-readout]");
  await expect(readout).toHaveText("Tap an hour to see its numbers.");
  const before = (await readout.boundingBox())!.height;
  await row.click();
  await expect(readout).toHaveText(/^10:00 · 6 calls · 3 reached \(50%\) · best \w{3} 50%$/);
  expect((await readout.boundingBox())!.height).toBe(before); // two lines reserved: nothing moves
  expect(errors).toEqual([]);
  await context.close();
});
