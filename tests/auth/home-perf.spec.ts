import { expect, test, type Page } from "@playwright/test";
import { appReady, createUser, fullSession } from "./helpers";
import { makeOrg, moveTo, seedHome, userId } from "./home-fixture";

// Home speed in the browser (Day 5 design 8.6 "Browser", Home rows), on a CPU slowed down 4 times: a cold deep link to
// / (LCP, CLS: Home ≤ 0.02), the count-up's longest frame and layout shifts while it runs, Pipeline → Home after the
// dock hover (Home's figures prefetched) and without it (time to the skeleton), and Home's extra JavaScript (gzip, from
// the browser's resource timings, against the Inventory placeholder). Timings are taken inside the page. Every budget
// is asserted with expect.soft, so all are reported. Only with PERF=1 on Chromium; results go into
// docs/evidence/day5c/perf.md.
test.skip(!process.env.PERF, "speed run: set PERF=1");
test.use({ trace: "off" });

const password = "Home-Perf-Pass-42!";
const run = Date.now();
const email = `home-perf-${run}@example.test`;
const BUDGET = { lcpMs: 2000, cls: 0.02, countFrameMs: 8, countShifts: 0, routeHoverMs: 200, skeletonMs: 100, extraJsKb: 20 };
const round = (n: number) => Math.round(n * 10) / 10;

/** Clicks `selector` from inside the page; the milliseconds until `doneSelector` is in the page, painted. */
function timeClick(page: Page, selector: string, doneSelector: string) {
  return page.evaluate(
    ({ selector, doneSelector }) =>
      new Promise<number>((resolve, reject) => {
        const el = document.querySelector<HTMLElement>(selector);
        if (!el) return reject(new Error(`no element for ${selector}`));
        let finished = false;
        const finish = () => {
          if (finished || !document.querySelector(doneSelector)) return;
          finished = true;
          observer.disconnect();
          requestAnimationFrame(() => setTimeout(() => resolve(performance.now() - t0), 0));
        };
        const observer = new MutationObserver(finish);
        observer.observe(document.body, { subtree: true, childList: true, attributes: true });
        window.setTimeout(() => !finished && reject(new Error(`timed out waiting for ${doneSelector}`)), 15_000);
        const t0 = performance.now();
        el.click();
        finish();
      }),
    { selector, doneSelector },
  );
}

test("home at 4x CPU slow-down: deep link, count-up frames, route, chunk size", async ({ browser, browserName }) => {
  test.skip(browserName !== "chromium", "CPU slow-down needs Chromium");
  test.setTimeout(900_000);
  const secret = await createUser(email, password, true);
  const repEmail = `home-perf-rep-${run}@example.test`;
  await createUser(repEmail, password, false);
  const org = makeOrg(`Home perf ${run}`);
  moveTo(email, org, "admin", "Haider");
  moveTo(repEmail, org, "rep", "Kais");
  seedHome(org, userId(email), userId(repEmail), "");
  const state = await fullSession(browser, email, password, secret);
  const results: Record<keyof typeof BUDGET, number[]> = {
    lcpMs: [], cls: [], countFrameMs: [], countShifts: [], routeHoverMs: [], skeletonMs: [], extraJsKb: [],
  };

  const scriptBytes = async (path: string) => {
    const c = await browser.newContext({ storageState: state, viewport: { width: 1440, height: 900 } });
    const p = await c.newPage();
    await p.goto(path);
    await appReady(p);
    await p.waitForTimeout(1500);
    const bytes = await p.evaluate(() =>
      performance
        .getEntriesByType("resource")
        .filter((e) => (e as PerformanceResourceTiming).initiatorType === "script" || e.name.endsWith(".js"))
        .reduce((sum, e) => sum + (e as PerformanceResourceTiming).encodedBodySize, 0),
    );
    await c.close();
    return bytes;
  };
  results.extraJsKb.push(round(((await scriptBytes("/")) - (await scriptBytes("/inventory"))) / 1024));

  // 1. Cold deep links (a new tab each time, so the count-up plays when hydration is early enough): LCP, CLS, and the
  // longest frame and layout-shift entries during the first 1.2 s.
  for (let i = 0; i < 3; i++) {
    const context = await browser.newContext({ storageState: state, viewport: { width: 1440, height: 900 } });
    await context.addInitScript(() => {
      const w = window as unknown as { __lcp: number; __cls: number; __shifts: number; __frames: number[] };
      w.__lcp = 0;
      w.__cls = 0;
      w.__shifts = 0;
      w.__frames = [];
      new PerformanceObserver((l) => l.getEntries().forEach((e) => (w.__lcp = e.startTime))).observe({ type: "largest-contentful-paint", buffered: true });
      new PerformanceObserver((l) =>
        l.getEntries().forEach((e) => {
          const shift = e as unknown as { value: number; hadRecentInput: boolean };
          if (!shift.hadRecentInput) {
            w.__cls += shift.value;
            w.__shifts += 1;
          }
        }),
      ).observe({ type: "layout-shift", buffered: true });
      // Frame times from the first frame after the KPI numbers exist until 1.2 s later (the count runs 0.7 s).
      const start = () => {
        if (!document.querySelector("[data-kpi-number]")) return requestAnimationFrame(start);
        let last = performance.now();
        const until = last + 1200;
        const step = () => {
          const now = performance.now();
          w.__frames.push(now - last);
          last = now;
          if (now < until) requestAnimationFrame(step);
        };
        requestAnimationFrame(step);
      };
      requestAnimationFrame(start);
    });
    const page = await context.newPage();
    const cdp = await context.newCDPSession(page);
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
    await page.goto("/");
    await expect(page.locator("[data-kpi-number]").first()).toBeVisible();
    await page.waitForTimeout(2000);
    const v = await page.evaluate(() => {
      const w = window as unknown as { __lcp: number; __cls: number; __shifts: number; __frames: number[] };
      return { lcp: Math.round(w.__lcp), cls: Math.round(w.__cls * 1000) / 1000, shifts: w.__shifts, frames: w.__frames.slice(1) };
    });
    results.lcpMs.push(v.lcp);
    results.cls.push(v.cls);
    results.countShifts.push(v.shifts);
    // The longest frame, at 4x slow-down divided back by 4 (the budget is for an unthrottled machine).
    results.countFrameMs.push(round(Math.max(...v.frames) / 4));
    await context.close();
  }

  // 2. Pipeline → Home after the dock hover (Home warmed in the query cache), then from Leads without a hover (the time
  // to Home's skeleton or content).
  const context = await browser.newContext({ storageState: state, viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await page.goto("/");
  await appReady(page);
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
  for (let i = 0; i < 3; i++) {
    await page.goto("/pipeline");
    await appReady(page);
    await page.locator('nav a[href="/"]').first().hover();
    await page.waitForTimeout(1500);
    results.routeHoverMs.push(round(await timeClick(page, 'nav a[href="/"]', "[data-kpi-number]")));
    await page.waitForTimeout(500);
  }
  for (let i = 0; i < 3; i++) {
    await page.goto("/leads");
    await appReady(page);
    results.skeletonMs.push(round(await timeClick(page, 'nav a[href="/"]', '[aria-busy="true"], [data-kpi-number]')));
    await expect(page.locator("[data-kpi-number]").first()).toBeVisible();
  }
  await context.close();

  console.log(`HOME-PERF ${JSON.stringify(results)}`);
  for (const key of Object.keys(BUDGET) as (keyof typeof BUDGET)[]) {
    for (const [i, value] of results[key].entries()) {
      expect.soft(value, `${key} run ${i + 1}: ${value} (budget ${BUDGET[key]})`).toBeLessThanOrEqual(BUDGET[key]);
    }
  }
});
