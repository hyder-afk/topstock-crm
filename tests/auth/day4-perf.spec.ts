import { expect, test } from "@playwright/test";
import { appReady, createUser, fullSession, seedLeads, setRole, sql } from "./helpers";

// Lead page speed in the browser (Day 4 design 8.6, the lead page's part; the queue's joins in 4c), on a CPU slowed down
// 4 times: a cold deep link (largest contentful paint and layout shift), a route change from the leads list after the
// hover prefetch, a tab switch, and scrolling a timeline with 1,000 loaded entries (frame times; design D13 falls back to
// TanStack Virtual if it misses 60 fps). Only with PERF=1 on Chromium; results go into docs/evidence/day4b/README.md.
test.skip(!process.env.PERF, "speed run: set PERF=1");

const password = "Lead-Perf-Pass-42!";
const email = `lead-perf-${Date.now()}@example.test`;

test("lead page at 4x CPU slow-down: deep link, route change, tab switch, 1,000-entry timeline", async ({ browser, browserName }) => {
  test.skip(browserName !== "chromium", "CPU slow-down needs Chromium");
  test.setTimeout(600_000);
  const secret = await createUser(email, password, true);
  setRole(email, "admin");
  seedLeads([email], 120);
  const lead = sql(`select id from public.companies order by coalesce(last_activity_at, '-infinity'::timestamptz) desc, id desc limit 1`);
  sql(`insert into public.activities (org_id, company_id, user_id, type, outcome, body, created_at)
       select c.org_id, c.id, (select id from auth.users where email = '${email}'),
              (array['call','email','note','whatsapp','meeting'])[i % 5 + 1],
              (array['no_answer','sent',null,'sent','held'])[i % 5 + 1],
              'Entry ' || i || ': ' || repeat('denim jackets, grade A; ', 1 + i % 6),
              now() - i * interval '7 minutes'
       from public.companies c, generate_series(1, 1000) i where c.id = '${lead}'`);
  const state = await fullSession(browser, email, password, secret);
  const context = await browser.newContext({ storageState: state, viewport: { width: 1440, height: 900 } });
  await context.addInitScript(() => {
    const w = window as unknown as { __lcp: number; __cls: number; __tasks: number[] };
    w.__lcp = 0;
    w.__cls = 0;
    w.__tasks = [];
    new PerformanceObserver((l) => l.getEntries().forEach((e) => (w.__lcp = e.startTime))).observe({ type: "largest-contentful-paint", buffered: true });
    new PerformanceObserver((l) =>
      l.getEntries().forEach((e) => {
        const shift = e as unknown as { value: number; hadRecentInput: boolean };
        if (!shift.hadRecentInput) w.__cls += shift.value;
      }),
    ).observe({ type: "layout-shift", buffered: true });
    new PerformanceObserver((l) => l.getEntries().forEach((e) => w.__tasks.push(Math.round(e.duration)))).observe({ type: "longtask", buffered: true });
  });
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
  const results: Record<string, number | number[]> = {};

  // 1. Cold deep link: LCP and CLS once the page has settled.
  await page.goto(`/leads/${lead}`);
  await expect(page.locator("main h1")).toBeVisible();
  await appReady(page);
  await page.waitForTimeout(1500);
  const vitals = await page.evaluate(() => {
    const w = window as unknown as { __lcp: number; __cls: number };
    return { lcp: Math.round(w.__lcp), cls: Math.round(w.__cls * 1000) / 1000 };
  });
  results.deepLinkLcpMs = vitals.lcp;
  results.deepLinkCls = vitals.cls;

  // 2. Tab switch: Timeline's first page is already cached (server-rendered), so the panel draws at once.
  let t0 = Date.now();
  await page.getByRole("tab", { name: "Timeline" }).click();
  await expect(page.getByRole("tabpanel").getByRole("article").first()).toBeVisible();
  results.tabSwitchMs = Date.now() - t0;

  // 3. Route change from the list, three times: hover the row (120 ms intent, then the prefetch), open the preview,
  // then Open lead; timed from the click to the lead's name on the new page.
  const changes: number[] = [];
  for (const n of [2, 5, 9]) {
    await page.goto("/leads");
    await expect(page.getByRole("table")).toBeVisible();
    await appReady(page);
    const row = page.getByRole("table", { name: "Leads" }).getByRole("row").getByRole("link").nth(n);
    await row.hover();
    await page.waitForTimeout(600);
    await row.click();
    const open = page.locator("aside").getByRole("link", { name: "Open lead" });
    await open.hover();
    await page.waitForTimeout(600);
    const name = ((await page.locator("aside h2").textContent()) ?? "").trim();
    t0 = Date.now();
    await open.click();
    await expect(page.locator("main h1")).toHaveText(name);
    changes.push(Date.now() - t0);
  }
  results.routeChangeMs = changes;

  // 4. 1,000 loaded entries: load every page, then scroll the whole timeline and record frame times.
  await page.goto(`/leads/${lead}?tab=timeline`);
  await appReady(page);
  const articles = page.getByRole("tabpanel").getByRole("article");
  for (let i = 0; i < 60 && (await articles.count()) < 1000; i++) {
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    await page.waitForTimeout(250);
  }
  await expect(articles).toHaveCount(1000);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.evaluate(() => ((window as unknown as { __tasks: number[] }).__tasks = []));
  const frames = await page.evaluate(
    () =>
      new Promise<number[]>((resolve) => {
        const times: number[] = [];
        let last = performance.now();
        const end = document.documentElement.scrollHeight - window.innerHeight;
        const step = () => {
          const now = performance.now();
          times.push(now - last);
          last = now;
          window.scrollBy(0, 120);
          if (window.scrollY >= end - 1) resolve(times);
          else requestAnimationFrame(step);
        };
        requestAnimationFrame(step);
      }),
  );
  const sorted = [...frames].sort((a, b) => a - b);
  results.scrollFrames = frames.length;
  results.scrollP50Ms = Math.round(sorted[Math.floor(sorted.length * 0.5)] * 10) / 10;
  results.scrollP95Ms = Math.round(sorted[Math.floor(sorted.length * 0.95)] * 10) / 10;
  results.scrollLongTasksMs = await page.evaluate(() => (window as unknown as { __tasks: number[] }).__tasks);

  console.log(`LEAD-PERF ${JSON.stringify(results)}`);
  expect(vitals.cls).toBeLessThanOrEqual(0.05);
  await context.close();
});
