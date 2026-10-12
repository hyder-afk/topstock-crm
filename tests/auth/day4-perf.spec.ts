import { expect, test, type Page } from "@playwright/test";
import { appReady, countryInHours, createUser, fullSession, seedLeads, setRole, sql } from "./helpers";

// Lead page speed in the browser (Day 4 design 8.6, the lead page's part; the queue's in 4c), on a CPU slowed down 4
// times, each measure 3 times: a cold deep link (largest contentful paint and layout shift), a tab switch, a route change
// from the leads list after the hover prefetch, and scrolling a timeline with 1,000 loaded entries (frame times; the
// timeline is virtualised past 120 entries, design D13). Timings are taken inside the page: performance.now() just
// before a DOM click, then a MutationObserver until the content is there, then the next frame (requestAnimationFrame,
// then a macrotask: the frame with the change has been painted). Every budget is asserted (expect.soft, so all are
// reported). Only with PERF=1 on Chromium; results go into docs/evidence/day4b/README.md.
test.skip(!process.env.PERF, "speed run: set PERF=1");
// No Playwright trace here: its DOM snapshots run in the page around every action and were part of the old timings.
test.use({ trace: "off" });

const password = "Lead-Perf-Pass-42!";
const email = `lead-perf-${Date.now()}@example.test`;
const RUNS = 3;
// 60 fps: the median frame within 16.7 ms, and no more than 5% of frames dropped (a dropped frame lasts about 33 ms).
const BUDGET = { lcpMs: 2000, cls: 0.05, tabMs: 100, routeMs: 200, frameP50Ms: 1000 / 60, frameP95Ms: 20 };

type Done = { kind: "timelineVisible" } | { kind: "heading"; text: string };

/** Clicks `selector` from inside the page and answers the milliseconds until `done` holds and that frame is painted. */
async function timeClick(page: Page, selector: string, done: Done): Promise<number> {
  return page.evaluate(
    ({ selector, done }) =>
      new Promise<number>((resolve, reject) => {
        const check = () => {
          if (done.kind === "heading") return document.querySelector("main h1")?.textContent?.trim() === done.text;
          const article = document.querySelector('[role=tabpanel][id$="-panel-timeline"] article');
          return !!article && article.checkVisibility();
        };
        const el = document.querySelector<HTMLElement>(selector);
        if (!el) return reject(new Error(`no element for ${selector}`));
        let finished = false;
        const finish = () => {
          if (finished || !check()) return;
          finished = true;
          observer.disconnect();
          requestAnimationFrame(() => setTimeout(() => resolve(performance.now() - t0), 0));
        };
        const observer = new MutationObserver(finish);
        observer.observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true });
        window.setTimeout(() => !finished && reject(new Error(`timed out waiting for ${done.kind}`)), 15_000);
        const t0 = performance.now();
        el.click();
        finish();
      }),
    { selector, done },
  );
}

const round = (n: number) => Math.round(n * 10) / 10;

test("lead page at 4x CPU slow-down: deep link, tab switch, route change, 1,000-entry timeline", async ({ browser, browserName }) => {
  test.skip(browserName !== "chromium", "CPU slow-down needs Chromium");
  test.setTimeout(900_000);
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
  const results: Record<string, number[]> = { lcpMs: [], cls: [], tabMs: [], routeMs: [], frameP50Ms: [], frameP95Ms: [], frames: [], longTasksMs: [] };

  for (let run = 0; run < RUNS; run++) {
    // 1. Cold deep link: LCP and CLS once the page has settled.
    await page.goto(`/leads/${lead}`);
    await expect(page.locator("main h1")).toBeVisible();
    await appReady(page);
    await page.waitForTimeout(1500);
    const vitals = await page.evaluate(() => {
      const w = window as unknown as { __lcp: number; __cls: number };
      return { lcp: Math.round(w.__lcp), cls: Math.round(w.__cls * 1000) / 1000 };
    });
    results.lcpMs.push(vitals.lcp);
    results.cls.push(vitals.cls);

    // 2. Tab switch, Summary to Timeline: until a timeline entry is visible in the selected panel.
    results.tabMs.push(round(await timeClick(page, '[role=tab][id$="-tab-timeline"]', { kind: "timelineVisible" })));
    await expect(page.locator('[role=tabpanel][id$="-panel-timeline"]').getByRole("article").first()).toBeVisible();
  }

  // 3. Route change from the list: hover the row (120 ms intent, then the prefetch), open the preview, hover Open lead
  // (its full prefetch), then click it; until the lead's name is the page's heading.
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
    await page.waitForTimeout(1500);
    const name = ((await page.locator("aside h2").textContent()) ?? "").trim();
    results.routeMs.push(round(await timeClick(page, 'aside a[data-open-lead]', { kind: "heading", text: name })));
    await expect(page.locator("main h1")).toHaveText(name);
  }

  console.log(`LEAD-PERF (part) ${JSON.stringify(results)}`);

  // 4. 1,000 loaded entries: load every page, then scroll the whole timeline three times and record frame times.
  await page.goto(`/leads/${lead}?tab=timeline`);
  await appReady(page);
  const panel = page.locator('[role=tabpanel][id$="-panel-timeline"]');
  const end = panel.getByText("That’s the whole history.");
  for (let i = 0; i < 80 && !(await end.isVisible()); i++) {
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    await page.waitForTimeout(250);
  }
  await expect(end).toBeVisible();
  await expect(panel.getByRole("article").first()).toHaveAttribute("aria-setsize", "1000");
  for (let run = 0; run < RUNS; run++) {
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(500);
    await page.evaluate(() => ((window as unknown as { __tasks: number[] }).__tasks = []));
    const frames = await page.evaluate(
      () =>
        new Promise<number[]>((resolve) => {
          const times: number[] = [];
          let last = performance.now();
          const step = () => {
            const now = performance.now();
            times.push(now - last);
            last = now;
            window.scrollBy(0, 120);
            if (window.scrollY >= document.documentElement.scrollHeight - window.innerHeight - 1) resolve(times.slice(1));
            else requestAnimationFrame(step);
          };
          requestAnimationFrame(step);
        }),
    );
    const sorted = [...frames].sort((a, b) => a - b);
    results.frames.push(frames.length);
    results.frameP50Ms.push(round(sorted[Math.floor(sorted.length * 0.5)]));
    results.frameP95Ms.push(round(sorted[Math.floor(sorted.length * 0.95)]));
    const tasks = await page.evaluate(() => (window as unknown as { __tasks: number[] }).__tasks);
    results.longTasksMs.push(tasks.length ? Math.max(...tasks) : 0);
  }

  console.log(`LEAD-PERF ${JSON.stringify(results)}`);
  for (const key of Object.keys(BUDGET) as (keyof typeof BUDGET)[]) {
    for (const [i, value] of results[key].entries()) {
      expect.soft(value, `${key} run ${i + 1}: ${value} (budget ${round(BUDGET[key])})`).toBeLessThanOrEqual(BUDGET[key]);
    }
  }
  await context.close();
});

// Day 4c: the queue at 4x CPU (design 8.6). 30 advances, each a digit key sent inside the page: the time until the
// next card's heading is painted (from the reserve: ≤ 100 ms p95), the time until that outcome is saved (the "Logged"
// toast; recorded, it feeds the D3 switch rule: over 400 ms p95 moves claim and log to route handlers), the longest
// task during an advance (≤ 50 ms), then 10 keys in a row (a key as soon as each card shows): the loading card may show
// at most once. Leads in a country in calling hours now, or any hours when every zone is closed.
test("work queue at 4x CPU slow-down: key to next card, key to saved, 10 keys in a row", async ({ browser, browserName }) => {
  test.skip(browserName !== "chromium", "CPU slow-down needs Chromium");
  test.setTimeout(900_000);
  const queueEmail = `queue-perf-${Date.now()}@example.test`;
  const secret = await createUser(queueEmail, password, true);
  setRole(queueEmail, "admin");
  const open = countryInHours(true, 30);
  sql(`insert into public.companies (org_id, name, owner_id, lead_status, phone, city, country)
       select p.org_id, 'Perf Queue ' || lpad(i::text, 3, '0'), p.id, 'cold', '+33 6 00 00 ' || lpad(i::text, 4, '0'), 'Testville', '${open ?? "FR"}'
       from public.profiles p, generate_series(1, 60) i where p.id = (select id from auth.users where email = '${queueEmail}')`);
  const state = await fullSession(browser, queueEmail, password, secret);
  const context = await browser.newContext({ storageState: state, viewport: { width: 1440, height: 900 } });
  await context.addInitScript(() => {
    const w = window as unknown as { __tasks: number[] };
    w.__tasks = [];
    new PerformanceObserver((l) => l.getEntries().forEach((e) => w.__tasks.push(Math.round(e.duration)))).observe({ type: "longtask", buffered: true });
  });
  const page = await context.newPage();
  await page.goto("/leads/queue");
  await appReady(page);
  await page.getByRole("button", { name: "Start" }).click();
  if (!open) await page.getByRole("button", { name: "Show leads outside calling hours" }).click();
  const card = page.locator("main section[role=region]:not([data-leaving]) h2");
  await expect(card).toBeVisible();
  await page.waitForTimeout(1000);
  const cdp = await context.newCDPSession(page);
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });

  const paint: number[] = [];
  const saved: number[] = [];
  const longest: number[] = [];
  for (let i = 0; i < 30; i++) {
    await page.evaluate(() => ((window as unknown as { __tasks: number[] }).__tasks = []));
    const t = await page.evaluate(
      () =>
        new Promise<{ paint: number; saved: number }>((resolve, reject) => {
          const heading = () => document.querySelector("main section[role=region]:not([data-leaving]) h2")?.textContent ?? "";
          const toastText = () => [...document.querySelectorAll("[role=status]")].map((n) => n.textContent ?? "").join("|");
          const before = heading();
          const toastBefore = document.querySelector("[aria-live=polite] > div");
          let painted = -1;
          const t0 = performance.now();
          const observer = new MutationObserver(() => {
            if (painted < 0 && heading() && heading() !== before) {
              painted = 0;
              requestAnimationFrame(() => setTimeout(() => (painted = performance.now() - t0), 0));
            }
            const toast = document.querySelector("[aria-live=polite] > div");
            if (toast && toast !== toastBefore && toastText().includes("Logged")) {
              const done = () => (painted > 0 ? (observer.disconnect(), resolve({ paint: painted, saved: performance.now() - t0 })) : setTimeout(done, 5));
              done();
            }
          });
          observer.observe(document.body, { subtree: true, childList: true, characterData: true });
          window.setTimeout(() => reject(new Error("no advance")), 20_000);
          document.body.dispatchEvent(new KeyboardEvent("keydown", { code: "Digit1", key: "1", bubbles: true }));
        }),
    );
    paint.push(round(t.paint));
    saved.push(round(t.saved));
    const tasks = await page.evaluate(() => (window as unknown as { __tasks: number[] }).__tasks);
    longest.push(tasks.length ? Math.max(...tasks) : 0);
  }
  // 10 keys in a row: a key as soon as each new card shows; count the times the loading card appeared.
  const skeletons = await page.evaluate(
    () =>
      new Promise<number>((resolve) => {
        let seen = 0;
        let wasBusy = false;
        const observer = new MutationObserver(() => {
          const busy = !!document.querySelector("main [aria-busy=true]");
          if (busy && !wasBusy) seen += 1;
          wasBusy = busy;
        });
        observer.observe(document.body, { subtree: true, childList: true, attributes: true });
        window.setTimeout(() => resolve(-1), 60_000); // stuck: reported as -1 (fails the budget)
        let keys = 0;
        let last = "";
        const tick = () => {
          const h = document.querySelector("main section[role=region]:not([data-leaving]) h2")?.textContent ?? "";
          if (h && h !== last) {
            last = h;
            keys += 1;
            if (keys > 10) {
              observer.disconnect();
              return resolve(seen);
            }
            document.body.dispatchEvent(new KeyboardEvent("keydown", { code: "Digit1", key: "1", bubbles: true }));
          }
          setTimeout(tick, 10);
        };
        tick();
      }),
  );
  const p95 = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length * 0.95)];
  const result = { paintP95Ms: p95(paint), savedP95Ms: p95(saved), longestTaskMs: Math.max(...longest), skeletonsIn10Keys: skeletons, paint, saved };
  console.log(`QUEUE-PERF ${JSON.stringify(result)}`);
  expect.soft(result.paintP95Ms, `key to next card p95 ${result.paintP95Ms} ms (budget 100)`).toBeLessThanOrEqual(100);
  expect.soft(result.longestTaskMs, `longest task ${result.longestTaskMs} ms (budget 50)`).toBeLessThanOrEqual(50);
  expect.soft(result.skeletonsIn10Keys, "loading card in 10 keys (at most once)").toBeGreaterThanOrEqual(0);
  expect.soft(result.skeletonsIn10Keys, "loading card in 10 keys (at most once)").toBeLessThanOrEqual(1);
  await context.close();
});
