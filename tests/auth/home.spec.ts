import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { appReady, createUser, fullSession, isCancelledPrefetch, settled, sql, trackRequests } from "./helpers";
import { makeOrg, moveTo, seedHome, userId } from "./home-fixture";

// The Home dashboard (Day 5c, design 8.5 "home.spec.ts"): greeting and calm line in English and French, KPIs equal to
// the API, the count-up on a first hard load only (never with reduced motion, never shifting the layout), ticking a
// task done with Undo, Needs attention opening the deal sheet over Home and Home refreshing after a move, the queue
// count after paint, Team and Mine for admins only (remembered), the profile zone for "today", the win rate hidden under
// 5 closed deals, a new org's empty states, one card failing alone, Low stock before and after Day 6 (Day 6's
// stock_alerts, decision B), no entry text in the feed, and the phone layout. Each person lives in an org made for this
// run (the reused local stack holds other specs' rows in the default org), so every figure is exact. Test titles carry
// the run id.
test.describe.configure({ mode: "serial" });

const password = "Home-Dash-Pass-42!";
const run = Date.now();
const adminEmail = `home-admin-${run}@example.test`;
const repEmail = `home-rep-${run}@example.test`;
const emptyEmail = `home-empty-${run}@example.test`;
let adminState: Awaited<ReturnType<BrowserContext["storageState"]>>;
let repState: typeof adminState;
let emptyState: typeof adminState;
let admin = "";
let rep = "";
let org = "";
let stalledDeal = "";
let overdueTask = "";

async function open(browser: Browser, state: typeof adminState, o: { width?: number; locale?: string; reducedMotion?: "reduce" | "no-preference" } = {}) {
  const width = o.width ?? 1440;
  const context = await browser.newContext({
    storageState: state,
    viewport: { width, height: width < 600 ? 844 : 900 },
    timezoneId: "Europe/Paris",
    hasTouch: width < 600,
    reducedMotion: o.reducedMotion ?? "no-preference",
  });
  if (o.locale) await context.addCookies([{ name: "locale", value: o.locale, url: "http://localhost:3100" }]);
  const page = await context.newPage();
  trackRequests(page);
  const errors: string[] = [];
  page.on("console", (m) => m.type() === "error" && !isCancelledPrefetch(m.text()) && errors.push(m.text()));
  page.on("pageerror", (e) => !isCancelledPrefetch(e.message) && errors.push(e.message));
  return { context, page, errors };
}
async function gotoHome(page: Page) {
  await settled(page);
  await page.goto("/");
  await expect(page.locator("main h1")).toBeVisible();
  await expect(page.getByRole("group", { name: /Key figures|Chiffres clés/ }).getByRole("link")).toHaveCount(4);
  await appReady(page);
}
const kpi = (page: Page, label: RegExp) => page.getByRole("group", { name: /Key figures|Chiffres clés/ }).getByRole("link", { name: label });
const card = (page: Page, title: RegExp) => page.getByRole("region", { name: title });
// The figure as screen readers get it (the final value, whatever frame the count-up is on).
const figure = (page: Page, label: RegExp) => kpi(page, label).locator("[data-kpi-number] .sr-only");

// Which public.stock_alerts() the local stack holds (rebase point, docs/evidence/day5c/README.md): the Day 5c stub
// (answers null: the calm placeholder) until Day 6's 6d migration replaces its body with create or replace (live counts
// and up to 5 low products). The body is recognised by what it does; any other body (a stand-in left behind, say) fails.
type StockAlerts = { kind: "stub" | "day6"; def: string };
function installedStockAlerts(): StockAlerts {
  const def = sql("select pg_get_functiondef('public.stock_alerts()'::regprocedure)");
  const src = sql("select prosrc from pg_proc where oid = 'public.stock_alerts()'::regprocedure");
  const stub = /\breturn null;/.test(src) && !/jsonb_build_object|private\./.test(src.replace("private.has_aal2()", ""));
  const day6 = /\bfrom private\.stock_rows\b/.test(src) && /'sample'/.test(src) && !/\breturn null;/.test(src);
  if (stub === day6) throw new Error(`stock_alerts() is neither the Day 5c stub nor Day 6's function:\n${def}`);
  return { kind: stub ? "stub" : "day6", def };
}
const en = new Intl.NumberFormat("en-GB");
// The Low stock card for whatever stock_alerts() is installed (no stand-in): the stub's placeholder and no link, or
// Day 6's live answer as the server parsed it (the strict schema), drawn as the card draws it.
async function expectInstalledLowStock(page: Page) {
  const low = card(page, /^Low stock/);
  if (installedStockAlerts().kind === "stub") {
    await expect(low).toContainText("Stock alerts will show here once inventory is set up.");
    await expect(low.getByRole("link")).toHaveCount(0);
    return;
  }
  const api = await (await page.request.get("/api/home?scope=team")).json();
  expect(api.lowStock.ok).toBe(true);
  const d = api.lowStock.data;
  expect(d).not.toBeNull();
  await expect(low).not.toContainText("Stock alerts will show here once inventory is set up.");
  await expect(low).not.toContainText("Couldn’t load");
  await expect(low.getByRole("link", { name: "Open inventory" })).toHaveAttribute("href", "/inventory?filter=low");
  if (d.low + d.sold_out === 0) {
    await expect(low).toContainText("All products are above their reorder level.");
    await expect(low.getByRole("listitem").filter({ hasText: /available · reorder at/ })).toHaveCount(0);
  } else {
    const waiting = d.deals_waiting > 0 ? ` · ${en.format(d.deals_waiting)} deal${d.deals_waiting === 1 ? "" : "s"} waiting` : "";
    await expect(low).toContainText(`${en.format(d.low)} low · ${en.format(d.sold_out)} sold out${waiting}`);
    for (const item of d.sample as { name: string; available: number; reorder_point: number }[]) {
      await expect(low.getByRole("listitem").filter({ hasText: item.name }).first())
        .toContainText(`${en.format(item.available)} available · reorder at ${en.format(item.reorder_point)}`);
    }
  }
}

test.beforeAll(async ({ browser }) => {
  test.setTimeout(240_000);
  const adminSecret = await createUser(adminEmail, password, true);
  const repSecret = await createUser(repEmail, password, true);
  const emptySecret = await createUser(emptyEmail, password, true);
  admin = userId(adminEmail);
  rep = userId(repEmail);
  org = makeOrg(`Home e2e ${run}`);
  moveTo(adminEmail, org, "admin", "Nadia");
  moveTo(repEmail, org, "rep", "Rémi");
  moveTo(emptyEmail, makeOrg(`Home empty ${run}`), "admin", "Eva");
  ({ stalledDeal, overdueTask } = seedHome(org, admin, rep, String(run)));
  adminState = await fullSession(browser, adminEmail, password, adminSecret);
  repState = await fullSession(browser, repEmail, password, repSecret);
  emptyState = await fullSession(browser, emptyEmail, password, emptySecret);
});

test("greeting_and_calm_line_en_fr", async ({ browser }) => {
  for (const [locale, hello, calm] of [
    ["en", "Hello Nadia", "You have 2 tasks today and 1 meeting."],
    ["fr", "Bonjour Nadia", "Vous avez 2 tâches aujourd’hui et 1 rendez-vous."],
  ] as const) {
    const { context, page, errors } = await open(browser, adminState, { locale });
    await gotoHome(page);
    await expect(page.locator("main h1")).toHaveText(hello);
    await expect(page.getByText(calm)).toBeVisible();
    expect(errors).toEqual([]);
    await context.close();
  }
});

test("kpis_match_api", async ({ browser }) => {
  const { context, page, errors } = await open(browser, adminState);
  await gotoHome(page);
  const api = await (await page.request.get("/api/home?scope=team")).json();
  expect(api.summary.ok).toBe(true);
  expect(api.summary.data.open).toMatchObject({ count: 5, value: "55000.00", no_value: 1, stalled: 1, closing: 1, close_passed: 1 });
  await expect(kpi(page, /Open pipeline/)).toContainText("€55,000");
  await expect(kpi(page, /Open pipeline/)).toContainText("5 deals · 1 stalled · 1 without a value");
  await expect(kpi(page, /Won this month/)).toContainText("€4,200");
  await expect(kpi(page, /Won this month/)).toContainText("1 deal");
  await expect(kpi(page, /Calls today/)).toContainText(String(api.summary.data.calls_today.count));
  expect(api.summary.data.calls_today).toEqual({ count: 4, reached: 2 });
  await expect(kpi(page, /Calls today/)).toContainText("2 reached");
  await expect(kpi(page, /Tasks due/)).toContainText("3");
  await expect(kpi(page, /Tasks due/)).toContainText("1 overdue");
  await expect(kpi(page, /Open pipeline/)).toHaveAttribute("href", "/pipeline");
  await expect(kpi(page, /Tasks due/)).toHaveAttribute("href", "/tasks");
  // Unknown query parameters and a rep's team are refused by the route.
  expect((await page.request.get("/api/home?scope=everyone")).status()).toBe(400);
  expect((await page.request.get("/api/home?scope=team&x=1")).status()).toBe(400);
  expect(errors).toEqual([]);
  await context.close();
});

// Every write of the count-up's moving copy (its text node) is recorded from before the first paint.
async function recordCount(context: BrowserContext) {
  await context.addInitScript(() => {
    const w = window as unknown as { __frames: string[] };
    w.__frames = [];
    new MutationObserver((list) => {
      for (const m of list) {
        const el = m.target.parentElement;
        if (el?.closest("[data-kpi-number]") && el.getAttribute("aria-hidden") === "true" && !el.classList.contains("invisible")) {
          w.__frames.push(m.target.nodeValue ?? "");
        }
      }
    }).observe(document, { characterData: true, subtree: true });
  });
}
const frames = (page: Page) => page.evaluate(() => (window as unknown as { __frames: string[] }).__frames);

// Home's CLS (layout shifts without recent input), summed from before the first paint.
async function recordCls(context: BrowserContext) {
  await context.addInitScript(() => {
    const w = window as unknown as { __cls: number };
    w.__cls = 0;
    new PerformanceObserver((list) => {
      for (const e of list.getEntries() as PerformanceEntry[] & { value: number; hadRecentInput: boolean }[]) {
        if (!(e as unknown as { hadRecentInput: boolean }).hadRecentInput) w.__cls += (e as unknown as { value: number }).value;
      }
    }).observe({ type: "layout-shift", buffered: true });
  });
}
const cls = (page: Page) => page.evaluate(() => (window as unknown as { __cls: number }).__cls);

// The count-up runs only when hydration lands within COUNT_UP_HYDRATION_MS (800) of navigation start
// (decideFirstVisit). How fast this machine hydrates must not decide which branch a test sees, so both tests hold the
// page's clock with Playwright's (page.clock fakes performance, Date, timers and requestAnimationFrame, from before the
// page's first script). A document loaded after install() replays the clock's log: performance.now() starts at the
// ticks the log adds up to (wall time between the clock calls, plus fastForward), stands still after pauseAt() and
// follows wall time again after resume(); runFor() fires the timers and animation frames due in that span itself.
test("count_up_first_visit_hard_load and count_up_not_on_second_visit", async ({ browser }) => {
  const { context, page, errors } = await open(browser, adminState);
  await recordCount(context);
  await recordCls(context);
  // Early branch: time stands still from just after install(), so the page loads and hydrates however slowly the CPU
  // runs while performance.now() reads a few milliseconds.
  const start = Date.now();
  await page.clock.install({ time: start });
  await page.clock.pauseAt(start + 1000);
  await page.goto("/");
  // The Home content has streamed in behind loading.tsx (the response is complete at "load"). React's inline runtime
  // reveals it on an animation frame and hydrates it a frame or two later, so the page's time moves one 16 ms frame
  // per poll until hydration has written the count's start frame. Each step is a page.evaluate, which waits for the
  // page's main thread: a slow CPU makes the wait longer in wall time, never in the page's time.
  await expect(page.locator("[data-kpi-number]")).toHaveCount(4);
  await expect
    .poll(async () => (await frames(page)).includes("€0") || (await page.clock.runFor(16), false), {
      message: "hydration wrote the start frame (counted)",
      intervals: [100],
      timeout: 30_000,
    })
    .toBe(true);
  await expect(kpi(page, /Open pipeline/)).toContainText("€55,000");
  // Hydration counted with performance.now() below 800 (decideFirstVisit read it no later than this).
  const hydratedAt = await page.evaluate(() => performance.now());
  test.info().annotations.push({ type: "count-up hydration", description: `performance.now() ${hydratedAt} ms` });
  expect(hydratedAt).toBeLessThan(800);
  // 1 s of the page's time (the count takes 0.7 s), frame by frame, then wall time again for the rest of the test.
  await page.clock.runFor(1000);
  await page.clock.resume();
  const first = await frames(page);
  // The numbers counted up: intermediate values, ending on the final one.
  expect(first.length, "frames written on the first hard load").toBeGreaterThan(3);
  expect(first).toContain("€0");
  expect(first.at(-1)).not.toBe("€0");
  expect(first.filter((f) => f !== "€0" && f !== "€55,000").length, "intermediate frames").toBeGreaterThan(0);
  await expect(kpi(page, /Open pipeline/).locator("[data-kpi-number] [aria-hidden]:not(.invisible)")).toHaveText("€55,000");
  expect(await cls(page), "Home CLS during the count-up").toBeLessThanOrEqual(0.02);
  // Second visit in this tab (Pipeline, then the dock back to Home): no count.
  await appReady(page);
  await settled(page);
  await page.getByRole("navigation", { name: "Sections" }).getByRole("link", { name: /^Pipeline/ }).click();
  await page.waitForURL(/\/pipeline/);
  await settled(page);
  await page.evaluate(() => ((window as unknown as { __frames: string[] }).__frames = []));
  await page.getByRole("navigation", { name: "Sections" }).getByRole("link", { name: /^Home/ }).click();
  await page.waitForURL((u) => u.pathname === "/");
  await expect(kpi(page, /Open pipeline/)).toContainText("€55,000");
  await page.waitForTimeout(900);
  expect((await frames(page)).filter((f) => f === "€0")).toEqual([]);
  expect(errors).toEqual([]);
  await context.close();
});

test("count_up_late_hydration_shows_final_number", async ({ browser }) => {
  const { context, page, errors } = await open(browser, adminState);
  await recordCount(context);
  await recordCls(context);
  // Late branch: performance.now() starts past 1000 and only grows, so hydration lands after 800 ms whenever it runs.
  const start = Date.now();
  await page.clock.install({ time: start });
  await page.clock.fastForward(1000);
  await page.goto("/");
  await expect(kpi(page, /Open pipeline/)).toContainText("€55,000");
  // Hydrated: React holds the number's node and the dock has measured (its effects ran after the count-up's).
  await expect
    .poll(() => kpi(page, /Open pipeline/).locator("[data-kpi-number] [aria-hidden]:not(.invisible)").evaluate((el) => Object.keys(el).some((k) => k.startsWith("__reactFiber"))))
    .toBe(true);
  await appReady(page);
  expect(await page.evaluate(() => performance.now())).toBeGreaterThanOrEqual(800);
  await page.waitForTimeout(1000);
  // No count: no start frame, nothing written over the server's text, the final number on screen, no layout shift.
  const late = await frames(page);
  expect(late.filter((f) => f === "€0"), "no start frame after a late hydration").toEqual([]);
  expect(late, "nothing written over the server's numbers").toEqual([]);
  await expect(kpi(page, /Open pipeline/).locator("[data-kpi-number] [aria-hidden]:not(.invisible)")).toHaveText("€55,000");
  expect(await cls(page), "Home CLS after a late hydration").toBeLessThanOrEqual(0.02);
  expect(errors).toEqual([]);
  await context.close();
});

test("reduced_motion_static_numbers and kpis_no_layout_shift", async ({ browser }) => {
  const reduced = await open(browser, adminState, { reducedMotion: "reduce" });
  await recordCount(reduced.context);
  await reduced.page.goto("/");
  await expect(kpi(reduced.page, /Open pipeline/)).toContainText("€55,000");
  await reduced.page.waitForTimeout(1000);
  expect(await frames(reduced.page), "no frame is written under reduced motion").toEqual([]);
  expect(reduced.errors).toEqual([]);
  await reduced.context.close();

  const { context, page, errors } = await open(browser, adminState);
  await recordCls(context);
  await page.goto("/");
  await expect(kpi(page, /Open pipeline/)).toContainText("€55,000");
  await page.waitForTimeout(1500);
  expect(await cls(page), "Home CLS during the count-up").toBeLessThanOrEqual(0.02);
  expect(errors).toEqual([]);
  await context.close();
});

// Apple audit #15: a figure that changes while it is still counting starts the next run from the number on screen,
// never from the previous target. The page's clock is held, so each step is an exact number of frames.
test("count_up_interrupted_starts_from_the_value_on_screen", async ({ browser }) => {
  const { context, page, errors } = await open(browser, adminState);
  await recordCount(context);
  // Late hydration (no first-visit count from 0): only scope switches move the figure.
  const start = Date.now();
  await page.clock.install({ time: start });
  await page.clock.fastForward(1000);
  await gotoHome(page);
  const group = page.getByRole("group", { name: "Figures for" });
  const shownText = kpi(page, /Open pipeline/).locator("[data-kpi-number] [aria-hidden]:not(.invisible)");
  // Both scopes in the cache first, each figure at rest: Mine €50,000, Team €55,000.
  await group.getByRole("button", { name: "Mine" }).click();
  await expect(shownText).toHaveText("€50,000");
  await group.getByRole("button", { name: "Team" }).click();
  await expect(shownText).toHaveText("€55,000");
  await page.clock.pauseAt(new Date((await page.evaluate(() => Date.now())) + 1000));
  await page.evaluate(() => ((window as unknown as { __frames: string[] }).__frames = []));
  // Team → Mine, cut short after 100 ms by Mine → Team.
  await group.getByRole("button", { name: "Mine" }).click();
  await expect(group.getByRole("button", { name: "Mine" })).toHaveAttribute("aria-pressed", "true");
  await page.clock.runFor(100);
  // Only Open pipeline's frames (the other tiles' counts move between scopes too; Won this month does not change).
  const money = async () => (await frames(page)).filter((f) => f.startsWith("€"));
  const before = await money();
  const mid = before.at(-1) as string;
  expect(before.length, "the Team to Mine run has started").toBeGreaterThan(1);
  expect(mid, "cut short mid-run").not.toBe("€50,000");
  expect(mid).not.toBe("€55,000");
  await group.getByRole("button", { name: "Team" }).click();
  await expect(group.getByRole("button", { name: "Team" })).toHaveAttribute("aria-pressed", "true");
  await page.clock.runFor(600);
  const after = (await money()).slice(before.length);
  // The next run starts where the number stood and only moves on towards the new target: every frame lies between the
  // mid value and €55,000 (React may first write the final text, which the effect covers before paint), and the old
  // target never shows.
  const euros = (f: string) => Number(f.replace(/[^0-9]/g, ""));
  expect(after.filter((f) => f !== "€55,000")[0], "the next run starts from the value on screen").toBe(mid);
  expect(after, "no jump to the previous target").not.toContain("€50,000");
  for (const f of after) expect(euros(f), f).toBeGreaterThanOrEqual(euros(mid));
  expect(after.at(-1)).toBe("€55,000");
  await page.clock.resume();
  await expect(shownText).toHaveText("€55,000");
  expect(errors).toEqual([]);
  await context.close();
});

test("today_toggle_done_undo", async ({ browser }) => {
  const { context, page, errors } = await open(browser, adminState);
  await gotoHome(page);
  const today = card(page, /^Today/);
  await expect(today.getByRole("listitem")).toHaveCount(3);
  // Overdue first (with the word, in the red token), then the meeting with its time, then today's task.
  await expect(today.getByRole("listitem").nth(0)).toContainText("Call back about sizes");
  await expect(today.getByRole("listitem").nth(0)).toContainText("Overdue · 2 days");
  await expect(today.getByRole("listitem").nth(1)).toContainText("Showroom visit");
  await expect(today.getByRole("listitem").nth(1)).toContainText(/\d{2}:\d{2}/);
  await today.getByRole("checkbox", { name: "Mark “Call back about sizes” done" }).click();
  await expect(today.getByText("Call back about sizes")).toHaveCount(0);
  await expect(kpi(page, /Tasks due/)).toContainText("0 overdue");
  await expect.poll(() => sql(`select done_at is not null from public.tasks where id = '${overdueTask}'`)).toBe("t");
  // Focus moved to the next row's check, never to the page body.
  expect(await page.evaluate(() => document.activeElement?.getAttribute("role"))).toBe("checkbox");
  await page.getByRole("status").filter({ hasText: "Task done" }).getByRole("button", { name: "Undo" }).click();
  await expect.poll(() => sql(`select done_at is null from public.tasks where id = '${overdueTask}'`)).toBe("t");
  await expect(today.getByText("Call back about sizes")).toBeVisible();
  expect(errors).toEqual([]);
  await context.close();
});

test("today_tick_reaches_the_tasks_page: its list in this tab's cache is read again (bugs audit L3)", async ({ browser }) => {
  const task = sql(`select id from public.tasks where org_id = '${org}' and title = 'Send the price list'`);
  const { context, page, errors } = await open(browser, adminState);
  try {
    // The Tasks page first: its Today list is now in this tab's cache (fresh for 15 s).
    await settled(page);
    await page.goto("/tasks");
    const listed = page.getByRole("tabpanel").getByRole("listitem").filter({ hasText: "Send the price list" });
    await expect(listed).toBeVisible();
    await appReady(page);
    // Home in the same tab (the dock), the task ticked on the Today card, then Tasks again (the dock).
    const dock = page.getByRole("navigation", { name: /Sections/ });
    await dock.getByRole("link", { name: "Home", exact: true }).click();
    await card(page, /^Today/).getByRole("checkbox", { name: "Mark “Send the price list” done" }).click();
    await expect.poll(() => sql(`select done_at is not null from public.tasks where id = '${task}'`)).toBe("t");
    await dock.getByRole("link", { name: "Tasks", exact: true }).click();
    await expect(page.locator("main h1")).toContainText("Tasks");
    await expect(listed).toHaveCount(0);
    expect(errors).toEqual([]);
  } finally {
    sql(`update public.tasks set done_at = null where id = '${task}'`);
    await context.close();
  }
});

test("attention_opens_deal_sheet and refetch_after_move", async ({ browser }) => {
  const { context, page, errors } = await open(browser, adminState);
  await gotoHome(page);
  const attention = card(page, /^Needs attention/);
  const rows = attention.getByRole("button");
  await expect(rows).toHaveCount(3);
  // Close date passed first (red, with the words), then the stalled deal (amber dot and words), then closing soon.
  await expect(rows.nth(0)).toContainText(`Halles Altamar ${run}`);
  await expect(rows.nth(0)).toContainText("Close date passed");
  await expect(rows.nth(1)).toContainText(`Atelier Nordlys ${run}`);
  await expect(rows.nth(1)).toContainText("Stalled · no move or contact for 20 days");
  await expect(rows.nth(2)).toContainText("Closes");
  await expect(rows.nth(2)).toContainText(`Comptoir Brécy ${run}`);

  // 1. Home's refetch lands after the sheet closed (held until then): focus first comes back to the row that opened the
  // sheet; when that row leaves, the row now at its place takes it (never the page body).
  let release: () => void = () => {};
  const held = new Promise<void>((r) => (release = r));
  let holding = false;
  await page.route("**/api/home**", async (route) => {
    if (holding) await held;
    await route.continue();
  });
  await rows.nth(1).click();
  const sheet = page.getByRole("dialog");
  await expect(sheet).toBeVisible();
  await expect(sheet).toContainText(`Atelier Nordlys ${run}`);
  await expect(page).toHaveURL((u) => u.pathname === "/" && u.searchParams.get("deal") === stalledDeal);
  // A move from the sheet: Home refetches (the deal is no longer stalled, so it leaves Needs attention).
  holding = true;
  await sheet.getByRole("radio", { name: /^Nego/ }).click();
  await expect.poll(() => sql(`select s.key from public.deals d join public.pipeline_stages s on s.id = d.stage_id where d.id = '${stalledDeal}'`)).toBe("negotiations");
  await page.keyboard.press("Escape");
  await expect(sheet).toBeHidden();
  await expect(page).toHaveURL((u) => u.pathname === "/" && !u.searchParams.has("deal"));
  await expect(rows.nth(1)).toBeFocused();
  holding = false;
  release();
  await expect(rows).toHaveCount(2);
  await expect(attention).not.toContainText(`Atelier Nordlys ${run}`);
  await expect(rows.nth(1)).toBeFocused();
  await expect(rows.nth(1)).toContainText(`Comptoir Brécy ${run}`);
  await page.unroute("**/api/home**");

  // 2. Home's refetch lands while the sheet is still open (the row is gone before it closes): the row now at the
  // opener's place takes the focus. The deal is made stalled again in Negotiations first (21 days there).
  sql(`set session_replication_role = replica;
       update public.deals set stage_entered_at = now() - interval '30 days' where id = '${stalledDeal}'`);
  await settled(page);
  await gotoHome(page);
  await expect(rows).toHaveCount(3);
  await expect(rows.nth(1)).toContainText(`Atelier Nordlys ${run}`);
  await rows.nth(1).click();
  await expect(sheet).toContainText(`Atelier Nordlys ${run}`);
  // To Lead (not back to Qualified: a move back within 2 minutes is the same Undo, which restores the stalled clock).
  await sheet.getByRole("radio", { name: /^Lead/ }).click();
  // (The modal sheet hides the page from the accessibility tree, so the rows are counted by their markup here.)
  await expect(page.locator('section[aria-labelledby="home-attention"] [data-deal-row]')).toHaveCount(2);
  await page.keyboard.press("Escape");
  await expect(sheet).toBeHidden();
  await expect(rows.nth(1)).toBeFocused();
  await expect(rows.nth(1)).toContainText(`Comptoir Brécy ${run}`);
  // ?deal= opens the sheet over Home on arrival.
  await settled(page);
  await page.goto(`/?deal=${stalledDeal}`);
  await expect(page.getByRole("dialog")).toContainText(`Atelier Nordlys ${run}`);
  expect(errors).toEqual([]);
  await context.close();
});

test("queue_card_loads_after_paint", async ({ browser }) => {
  // Day 4c's queue_summary (on main since the 4c rebase), unmocked: the card shows what GET /api/queue/summary answers
  // (the counts, or "Nobody to call right now." outside calling hours), and Start calling carries 4c's "G Q" key.
  const plain = await open(browser, adminState);
  await gotoHome(plain.page);
  const queue = card(plain.page, /^Work queue/);
  const res = await plain.page.request.get("/api/queue/summary");
  expect(res.status()).toBe(200);
  const real = (await res.json()) as { callable_now: number; later_today: number };
  await expect(queue).toContainText(
    real.callable_now + real.later_today === 0
      ? "Nobody to call right now."
      : `${real.callable_now.toLocaleString("en")} to call now · ${real.later_today.toLocaleString("en")} later today`,
  );
  await expect(queue.getByRole("link", { name: "Start calling" })).toHaveAttribute("href", "/leads/queue");
  await expect(queue.getByRole("link", { name: "Start calling" })).toHaveAttribute("aria-keyshortcuts", "G Q");
  await expect(queue).toContainText("No new leads this week");
  expect(plain.errors).toEqual([]);
  await plain.context.close();
  // With Day 4c's queue_summary contract (mocked): the counts arrive after the page has painted.
  const { context, page, errors } = await open(browser, adminState);
  let painted = false;
  await page.route("**/api/queue/summary", async (route) => {
    painted = await page.evaluate(() => !!document.querySelector("main h1")).catch(() => false);
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ callable_now: 412, later_today: 1030, no_number: 3 }) });
  });
  await gotoHome(page);
  await expect(card(page, /^Work queue/)).toContainText("412 to call now · 1,030 later today");
  expect(painted, "the queue count is asked for after the greeting painted").toBe(true);
  expect(errors).toEqual([]);
  await context.close();
});

test("scope_switch_admin_only and rep_has_no_scope_switch", async ({ browser }) => {
  const { context, page, errors } = await open(browser, adminState);
  await gotoHome(page);
  const group = page.getByRole("group", { name: "Figures for" });
  await expect(group.getByRole("button", { name: "Team" })).toHaveAttribute("aria-pressed", "true");
  await expect(card(page, /Needs attention · Team/)).toBeVisible();
  await group.getByRole("button", { name: "Mine" }).click();
  await expect(group.getByRole("button", { name: "Mine" })).toHaveAttribute("aria-pressed", "true");
  // Nadia's own: 3 open deals worth €50,000; the rep's two are gone.
  await expect(kpi(page, /Open pipeline/)).toContainText("€50,000");
  await expect(card(page, /^Needs attention$/)).toBeVisible();
  // Remembered on this device.
  await settled(page);
  await page.reload();
  await expect(page.getByRole("group", { name: "Figures for" }).getByRole("button", { name: "Mine" })).toHaveAttribute("aria-pressed", "true");
  await expect(kpi(page, /Open pipeline/)).toContainText("€50,000");
  await page.getByRole("group", { name: "Figures for" }).getByRole("button", { name: "Team" }).click();
  await expect(kpi(page, /Open pipeline/)).toContainText("€55,000");
  expect(errors).toEqual([]);
  await context.close();

  const r = await open(browser, repState);
  await gotoHome(r.page);
  await expect(r.page.getByRole("group", { name: "Figures for" })).toHaveCount(0);
  await expect(kpi(r.page, /Open pipeline/)).toContainText("€5,000");
  // A rep's own token cannot ask for the team.
  expect((await r.page.request.get("/api/home?scope=team")).status()).toBe(403);
  expect(r.errors).toEqual([]);
  await r.context.close();
});

test("karachi_today_boundary", async ({ browser }) => {
  // A call a minute before and a minute after the start of the day in each zone: Calls today follows the profile's.
  const starts = sql(`select string_agg(to_char(w.day_start at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'), ',' order by z)
                        from unnest(array['Asia/Karachi', 'Europe/Paris']) z, private.home_window(now(), z) w`).split(",");
  expect(starts).toHaveLength(2);
  sql(`set session_replication_role = replica;
       insert into public.activities (org_id, company_id, user_id, type, outcome, created_at)
       select '${org}', c.id, '${admin}', 'call', 'connected', t
         from public.companies c, unnest(array['${starts[0]}'::timestamptz - interval '1 minute', '${starts[0]}'::timestamptz + interval '1 minute',
                                              '${starts[1]}'::timestamptz - interval '1 minute', '${starts[1]}'::timestamptz + interval '1 minute']) t
        where c.org_id = '${org}' and c.name = 'Maison Verdane ${run}';
       set session_replication_role = origin;`);
  const want = (z: string) =>
    sql(`select count(*) from public.activities a, private.home_window(now(), '${z}') w
          where a.org_id = '${org}' and a.type = 'call' and a.created_at >= w.day_start`);
  const karachi = want("Asia/Karachi");
  const paris = want("Europe/Paris");
  expect(karachi).not.toBe(paris);
  try {
    for (const [zone, count] of [["Asia/Karachi", karachi], ["Europe/Paris", paris]] as const) {
      sql(`update public.profiles set timezone = '${zone}' where id = '${admin}'`);
      const { context, page, errors } = await open(browser, adminState);
      await gotoHome(page);
      await expect(figure(page, /Calls today/)).toHaveText(count);
      expect(errors).toEqual([]);
      await context.close();
    }
  } finally {
    sql(`update public.profiles set timezone = 'Europe/Paris' where id = '${admin}';
         delete from public.activities where org_id = '${org}' and type = 'call'
            and created_at = any(array['${starts[0]}'::timestamptz - interval '1 minute', '${starts[0]}'::timestamptz + interval '1 minute',
                                       '${starts[1]}'::timestamptz - interval '1 minute', '${starts[1]}'::timestamptz + interval '1 minute'])`);
  }
});

test("win_rate_hidden_under_5 and recent_activity_has_no_note_text and low_stock_placeholder_when_null (or Day 6's live card)", async ({ browser }) => {
  const { context, page, errors } = await open(browser, adminState);
  await gotoHome(page);
  await expect(card(page, /^Pipeline/)).toContainText("Not enough closed deals yet");
  await expect(card(page, /^Pipeline/)).toContainText("Lost (30 days): 1 · Price 1");
  const recent = card(page, /^Recent activity/);
  await expect(recent).toContainText(`Nadia won Société Lunéa ${run} · €4,200`);
  await expect(recent).toContainText(`Nadia · Call · Interested · Comptoir Brécy ${run}`);
  await expect(recent).toContainText(`Nadia · Note · Maison Verdane ${run}`);
  await expect(page.locator("body")).not.toContainText("SECRET-NOTE");
  const api = await (await page.request.get("/api/home?scope=team")).text();
  expect(api).not.toContain("SECRET-NOTE");
  // Day 7b: the full date and time is screen-reader text inside <time> (no title= tooltip any more).
  await expect(recent.locator("time").first().locator(".sr-only")).toHaveText(/\(.*\d.*\)/);
  await expect(recent.locator("time").first()).not.toHaveAttribute("title", /./);
  await expectInstalledLowStock(page);
  expect(errors).toEqual([]);
  await context.close();
});

test("new_org_empty_states", async ({ browser }) => {
  const { context, page, errors } = await open(browser, emptyState);
  await gotoHome(page);
  await expect(page.locator("main h1")).toHaveText("Hello Eva");
  await expect(page.getByText("Nothing due today.").first()).toBeVisible();
  await expect(kpi(page, /Open pipeline/)).toContainText("€0");
  await expect(kpi(page, /Open pipeline/)).toContainText("No open deals yet. Mark a lead Interested to open one.");
  await expect(kpi(page, /Calls today/)).toContainText("No calls yet today");
  await expect(kpi(page, /Tasks due/)).toContainText("Nothing due");
  await expect(card(page, /^Needs attention/)).toContainText("All deals are moving.");
  await expect(card(page, /^Pipeline/)).toContainText("No deals yet. Deals open when a lead says they’re interested.");
  await expect(card(page, /^Recent activity/)).toContainText("No calls or notes yet today.");
  await expect(card(page, /^Today/)).toContainText("Add a task");
  expect(errors).toEqual([]);
  await context.close();
});

// The page's first paint comes from the server; switching scope fetches /api/home in the browser, which these mock.
async function viaScopeSwitch(page: Page, mutate: (data: Record<string, unknown>) => void) {
  await page.route((url) => url.pathname === "/api/home" && url.searchParams.get("scope") === "mine", async (route) => {
    const res = await route.fetch();
    const data = (await res.json()) as Record<string, unknown>;
    mutate(data);
    await route.fulfill({ response: res, body: JSON.stringify(data) });
  });
  await page.getByRole("group", { name: "Figures for" }).getByRole("button", { name: "Mine" }).click();
}

// Day 6's stock_alerts() stand-in for the filled card (Haider's decision B): installed as the database superuser on the
// local stack only, with Day 6's signature and checks, answering a fixed payload in Day 6's exact shape; the 5c stub is
// put back afterwards from its own definition (pg_get_functiondef), grants kept by create or replace (after Day 6's 6d
// migration it is Day 6's real function that is put back, the same way). The page then
// reads it through the real server path (fetchHome, the strict Zod parse). Auth specs run one worker at a time.
function fakeStockAlerts(payload: Record<string, unknown>) {
  const json = JSON.stringify(payload).replaceAll("'", "''");
  sql(`create or replace function public.stock_alerts() returns jsonb
       language plpgsql stable security invoker set search_path = '' as $f$
       begin
         if (select auth.uid()) is null or not private.has_aal2() then
           raise exception 'two-factor sign-in required' using errcode = '42501', hint = 'forbidden';
         end if;
         return '${json}'::jsonb;
       end;
       $f$`);
}
const day6Alerts = {
  low: 3, sold_out: 1, arriving_late: 2, requests_new: 4, holds_ending_soon: 1, deals_waiting: 2,
  sample: [
    { id: "6f1c1c1e-7a3b-4c1d-9e2f-0a1b2c3d4e5f", name: "Denim jacket", available: 120, reorder_point: 200, arriving: 300 },
    { id: "7f1c1c1e-7a3b-4c1d-9e2f-0a1b2c3d4e5f", name: "Cargo trousers", available: 12, reorder_point: 50, arriving: 0 },
  ],
};

test("card_error_isolated", async ({ browser }) => {
  const { context, page, errors } = await open(browser, adminState);
  await gotoHome(page);
  await viaScopeSwitch(page, (d) => {
    d.attention = { ok: false };
  });
  await expect(card(page, /^Needs attention/)).toContainText("Couldn’t load");
  await expect(card(page, /^Needs attention/).getByRole("button", { name: "Retry" })).toBeVisible();
  // Every other card keeps working.
  await expect(kpi(page, /Open pipeline/)).toContainText("€50,000");
  await expect(card(page, /^Recent activity/)).toContainText(`Comptoir Brécy ${run}`);
  await expectInstalledLowStock(page);
  expect(errors).toEqual([]);
  await page.getByRole("group", { name: "Figures for" }).getByRole("button", { name: "Team" }).click();
  await settled(page);
  await context.close();
});

test("low_stock_filled_from_day6_stock_alerts, all clear, and a wrong shape failing alone", async ({ browser }) => {
  const installed = installedStockAlerts();
  expect(installed.def).toContain(installed.kind === "stub" ? "return null" : "private.stock_rows");
  try {
    fakeStockAlerts(day6Alerts);
    const { context, page, errors } = await open(browser, adminState);
    await gotoHome(page);
    const low = card(page, /^Low stock/);
    await expect(low).toContainText("3 low · 1 sold out · 2 deals waiting");
    await expect(low.getByRole("listitem").filter({ hasText: "Denim jacket" })).toContainText("120 available · reorder at 200");
    await expect(low.getByRole("listitem").filter({ hasText: "Denim jacket" })).toContainText("+300 in transit");
    // No per-row "Low" badge (every listed product is low; the count line says so once).
    await expect(low.getByRole("listitem").filter({ hasText: "Denim jacket" })).toHaveText("Denim jacket120 available · reorder at 200+300 in transit");
    // Nothing in transit: no transit line.
    await expect(low.getByRole("listitem").filter({ hasText: "Cargo trousers" })).toHaveText("Cargo trousers12 available · reorder at 50");
    await expect(low.getByRole("link", { name: "Open inventory" })).toHaveAttribute("href", "/inventory?filter=low");
    const follow = low.getByRole("list", { name: "Also in inventory" });
    await expect(follow.getByRole("link", { name: "2 arrivals past their expected date" })).toHaveAttribute("href", "/inventory?tab=arriving");
    await expect(follow.getByRole("link", { name: "4 new stock requests" })).toHaveAttribute("href", "/inventory?tab=requests");
    await expect(follow.getByRole("link", { name: "1 hold ends within 2 days" })).toHaveAttribute("href", "/inventory?tab=reserved");
    expect(errors).toEqual([]);
    await context.close();

    // French: French typography (narrow no-break space before the colon) and plurals.
    const fr = await open(browser, adminState, { locale: "fr" });
    await gotoHome(fr.page);
    const bas = card(fr.page, /^Stock bas/);
    await expect(bas).toContainText("3 en stock bas · 1 épuisé · 2 affaires en attente");
    await expect(bas).toContainText("Disponible\u202f: 120 · seuil\u202f: 200");
    await expect(bas).toContainText("+300 en transit");
    await expect(bas).toContainText("4 nouvelles demandes de stock");
    expect(fr.errors).toEqual([]);
    await fr.context.close();

    // All clear: the calm line, no product list, no follow-up lines; a follow-up count alone still shows its line.
    fakeStockAlerts({ low: 0, sold_out: 0, arriving_late: 0, requests_new: 1, holds_ending_soon: 0, deals_waiting: 0, sample: [] });
    const clear = await open(browser, adminState);
    await gotoHome(clear.page);
    const ok = card(clear.page, /^Low stock/);
    await expect(ok).toContainText("All products are above their reorder level.");
    await expect(ok.getByRole("link", { name: "1 new stock request" })).toBeVisible();
    await expect(ok.getByRole("link", { name: /arrival|hold/ })).toHaveCount(0);
    expect(clear.errors).toEqual([]);
    await clear.context.close();

    // A wrong shape (an unknown key: a purchase cost) fails the strict parse: that card's error, the rest standing.
    fakeStockAlerts({ ...day6Alerts, cost_per_piece: 4.1 });
    const bad = await open(browser, adminState);
    await gotoHome(bad.page);
    await expect(card(bad.page, /^Low stock/)).toContainText("Couldn’t load");
    await expect(card(bad.page, /^Low stock/)).not.toContainText("Denim jacket");
    await expect(card(bad.page, /^Recent activity/)).toContainText(`Comptoir Brécy ${run}`);
    await expect(card(bad.page, /^Needs attention/)).not.toContainText("Couldn’t load");
    const api = await (await bad.page.request.get("/api/home?scope=team")).json();
    expect(api.lowStock).toEqual({ ok: false });
    expect(JSON.stringify(api)).not.toContain("cost_per_piece");
    expect(bad.errors).toEqual([]);
    await bad.context.close();
  } finally {
    sql(installed.def);
  }
  expect(installedStockAlerts()).toEqual(installed);
});

test("phone_390_no_horizontal_scroll", async ({ browser }) => {
  const { context, page, errors } = await open(browser, adminState, { width: 390 });
  await gotoHome(page);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
  // KPIs 2 x 2; Start calling full width and 56 px tall; checks and rows are at least 44 px.
  const boxes = await Promise.all([/Open pipeline/, /Won this month/, /Calls today/, /Tasks due/].map((l) => kpi(page, l).boundingBox()));
  expect(boxes[0]!.y).toBe(boxes[1]!.y);
  expect(boxes[2]!.y).toBeGreaterThan(boxes[0]!.y);
  const start = await card(page, /^Work queue/).getByRole("link", { name: "Start calling" }).boundingBox();
  expect(start!.height).toBeGreaterThanOrEqual(56);
  const check = await card(page, /^Today/).getByRole("checkbox").first().boundingBox();
  expect(Math.min(check!.width, check!.height)).toBeGreaterThanOrEqual(44);
  expect(errors).toEqual([]);
  await context.close();
});
