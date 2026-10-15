import { expect, test, type Page } from "@playwright/test";
import { appReady, createUser, fullSession, setRole, sql } from "./helpers";

// Pipeline speed in the browser (Day 5 design 8.6 "Browser"), on a CPU slowed down 4 times: a move painted in its new
// column (optimistic, Shift+arrow, p95 over 30 moves), drag frame times with 4 columns of 150 loaded cards (virtualised
// past 60), the settle after a drop, press feedback, the route change from Home after the dock hover (and the skeleton
// without it), a cold deep link (LCP, CLS) and the pipeline's extra JavaScript (gzip, from the browser's own resource
// timings). Timings are taken inside the page: performance.now() at the input, then a MutationObserver or a frame loop
// until the change is there, then the next frame (requestAnimationFrame, then a macrotask: that frame was painted).
// Every budget is asserted with expect.soft, so all are reported. Only with PERF=1 on Chromium; results go into
// docs/evidence/day5b/perf.md.
test.skip(!process.env.PERF, "speed run: set PERF=1");
declare function armInput(type: string): void;
declare function waitSince(check: (still: (ok: boolean, n: number) => boolean) => boolean): Promise<number>;
test.use({ trace: "off" });

const password = "Pipeline-Perf-Pass-42!";
const run = Date.now();
const email = `pipe-perf-${run}@example.test`;
const BUDGET = {
  moveP95Ms: 100,
  dragFrameP95Ms: 1000 / 60,
  dragLongestTaskMs: 50,
  settleMs: 450,
  pressMs: 100,
  routeHoverMs: 200,
  skeletonMs: 100,
  lcpMs: 2000,
  cls: 0.05,
  extraJsKb: 60,
};
const round = (n: number) => Math.round(n * 10) / 10;
const p95 = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(xs.length * 0.95))];

/** Presses Shift+arrow on the focused card from inside the page; the milliseconds until the card is in `toColumn`, painted. */
function timeMove(page: Page, deal: string, key: "ArrowRight" | "ArrowLeft", toColumn: string) {
  return page.evaluate(
    ({ deal, key, toColumn }) =>
      new Promise<number>((resolve, reject) => {
        const main = document.querySelector<HTMLElement>(`[data-deal-main="${deal}"]`);
        if (!main) return reject(new Error("no card"));
        main.focus();
        const inTarget = () => !!document.querySelector(`[data-column="${toColumn}"] [data-deal-card="${deal}"]`);
        let finished = false;
        const finish = () => {
          if (finished || !inTarget()) return;
          finished = true;
          observer.disconnect();
          requestAnimationFrame(() => setTimeout(() => resolve(performance.now() - t0), 0));
        };
        const observer = new MutationObserver(finish);
        observer.observe(document.body, { subtree: true, childList: true });
        window.setTimeout(() => !finished && reject(new Error("move timed out")), 10_000);
        const t0 = performance.now();
        main.dispatchEvent(new KeyboardEvent("keydown", { key, code: key, shiftKey: true, bubbles: true, cancelable: true }));
        finish();
      }),
    { deal, key, toColumn },
  );
}

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

test("pipeline at 4x CPU slow-down: moves, drag frames, settle, press, route, deep link, chunk size", async ({ browser, browserName }) => {
  test.skip(browserName !== "chromium", "CPU slow-down needs Chromium");
  test.setTimeout(1_800_000);
  const secret = await createUser(email, password, true);
  setRole(email, "admin");
  const me = sql(`select id from auth.users where email = '${email}'`);
  const org = sql(`select org_id from public.profiles where id = '${me}'`);
  // Earlier speed runs' 641 deals would crowd other specs' boards on the reused local stack.
  sql(`delete from public.deals where created_by in (select id from auth.users where email like 'pipe-perf-%' and email <> '${email}')`);
  const lead = sql(`insert into public.companies (org_id, name, owner_id, lead_status, phone, city, country)
                    values ('${org}', 'Perf Lead ${run}', '${me}', 'warm', '06 12 34 56 78', 'Lyon', 'FR') returning id`);
  // 160 deals in each of Lead, Qualified and Negotiations, and 160 won in the last 30 days, all this person's, with the
  // newest stage clocks so they come first; one more in Lead (the newest) is the card that moves.
  sql(`insert into public.deals (org_id, company_id, stage_id, owner_id, created_by, title, value, status, closed_at, fulfilment, stage_entered_at)
       select '${org}', '${lead}', s.id, '${me}', '${me}', 'Perf ${run} ' || s.key || ' ' || i, (500 + i * 37)::numeric,
              case when s.key = 'won' then 'won' else 'open' end,
              case when s.key = 'won' then now() - (i || ' minutes')::interval end,
              case when s.key = 'won' then 'from_stock' end,
              now() - (i || ' minutes')::interval
         from public.pipeline_stages s, generate_series(1, 160) i
        where s.org_id = '${org}' and s.key in ('lead', 'qualified', 'negotiations', 'won')`);
  const deal = sql(`insert into public.deals (org_id, company_id, stage_id, owner_id, created_by, title, value, stage_entered_at)
                    select '${org}', '${lead}', s.id, '${me}', '${me}', 'Perf mover ${run}', 4200, now()
                      from public.pipeline_stages s where s.org_id = '${org}' and s.key = 'lead' returning id`);
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
  // In-page helpers for the input-to-paint measures: armInput notes when the next event of a type arrives (capture
  // phase); waitSince resolves with the milliseconds from that moment until check() has held for n frames running, or
  // 5,000 when it never does within 5 s (the run never hangs).
  await context.addInitScript(() => {
    const w = window as unknown as Record<string, unknown>;
    w.armInput = (type: string) => {
      w.__t0 = 0;
      document.addEventListener(type, () => (w.__t0 = performance.now()), { capture: true, once: true });
    };
    w.waitSince = (check: (still: (ok: boolean, n: number) => boolean) => boolean) =>
      new Promise<number>((resolve) => {
        let run = 0;
        const still = (ok: boolean, n: number) => {
          run = ok && (w.__t0 as number) > 0 ? run + 1 : 0;
          return run >= n;
        };
        const give = window.setTimeout(() => resolve(5_000), 5_000);
        const step = () => {
          if (check(still)) {
            window.clearTimeout(give);
            resolve(performance.now() - (w.__t0 as number));
          } else requestAnimationFrame(step);
        };
        requestAnimationFrame(step);
      });
  });
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  const results: Record<string, number[]> = {
    lcpMs: [], cls: [], moveP95Ms: [], moveMs: [], dragFrameP95Ms: [], dragFrames: [], dragLongestTaskMs: [], settleMs: [], pressMs: [],
    routeHoverMs: [], routeBackHoverMs: [], skeletonMs: [], extraJsKb: [],
  };

  // Extra JavaScript: the scripts a cold /pipeline loads, against a cold /inventory (the same shell, a placeholder page),
  // as gzip bytes on the wire (resource timing encodedBodySize; next start compresses). No CPU slow-down here.
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
  results.extraJsKb.push(round(((await scriptBytes("/pipeline")) - (await scriptBytes("/inventory"))) / 1024));

  await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });

  // 1. Cold deep link, three times: LCP and CLS once the board has settled.
  for (let i = 0; i < 3; i++) {
    await page.goto("/pipeline");
    await expect(page.locator(`[data-deal-card="${deal}"]`)).toBeVisible();
    await appReady(page);
    await page.waitForTimeout(1500);
    const v = await page.evaluate(() => {
      const w = window as unknown as { __lcp: number; __cls: number };
      return { lcp: Math.round(w.__lcp), cls: Math.round(w.__cls * 1000) / 1000 };
    });
    results.lcpMs.push(v.lcp);
    results.cls.push(v.cls);
  }

  // 2. 30 optimistic moves (Shift+→ then Shift+←, the server answer awaited between them so each starts settled).
  const moves: number[] = [];
  for (let i = 0; i < 30; i++) {
    const right = i % 2 === 0;
    moves.push(round(await timeMove(page, deal, right ? "ArrowRight" : "ArrowLeft", right ? "qualified" : "lead")));
    await expect.poll(() => sql(`select s.key from public.deals d join public.pipeline_stages s on s.id = d.stage_id where d.id = '${deal}'`)).toBe(
      right ? "qualified" : "lead",
    );
    await page.waitForTimeout(500);
  }
  results.moveMs = moves;
  results.moveP95Ms.push(p95(moves));
  console.log(`PIPELINE-PERF (moves) ${JSON.stringify(results)}`);

  // 3. Load 150 cards in each column (Show more twice), then drag the mover across the board three times and record
  // frame times and long tasks; Escape cancels each drag.
  for (const key of ["lead", "qualified", "negotiations", "won"]) {
    const col = page.locator(`[data-column="${key}"]`);
    for (let k = 0; k < 2; k++) {
      const more = col.getByRole("button", { name: /^Show \d+ more$/ });
      if (!(await more.isVisible())) break;
      await more.click();
      await expect(col.getByText(new RegExp(`^Showing ${100 + k * 50} of`))).toBeVisible({ timeout: 30_000 });
    }
    // Back to the top of the column (Show more leaves it scrolled to the end, where the mover is not drawn).
    await col.locator("[data-column-scroll]").evaluate((el) => el.scrollTo(0, 0));
  }
  await expect(page.locator(`[data-deal-main="${deal}"]`)).toBeVisible();
  for (let i = 0; i < 3; i++) {
    const src = (await page.locator(`[data-deal-main="${deal}"]`).boundingBox())!;
    const far = (await page.locator('[data-column="negotiations"]').boundingBox())!;
    await page.mouse.move(src.x + 40, src.y + 30);
    await page.mouse.down();
    await page.mouse.move(src.x + 50, src.y + 40, { steps: 4 });
    await page.evaluate(() => {
      const w = window as unknown as { __frames: number[]; __stop: boolean; __tasks: number[] };
      w.__frames = [];
      w.__stop = false;
      w.__tasks = [];
      let last = performance.now();
      const step = () => {
        const now = performance.now();
        w.__frames.push(now - last);
        last = now;
        if (!w.__stop) requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    });
    await page.mouse.move(far.x + far.width / 2, far.y + 200, { steps: 60 });
    await page.mouse.move(src.x + 60, src.y + 200, { steps: 60 });
    const sample = await page.evaluate(() => {
      const w = window as unknown as { __frames: number[]; __stop: boolean; __tasks: number[] };
      w.__stop = true;
      return { frames: w.__frames.slice(1), tasks: w.__tasks };
    });
    await page.keyboard.press("Escape");
    await page.mouse.up();
    results.dragFrames.push(sample.frames.length);
    results.dragFrameP95Ms.push(round(p95(sample.frames)));
    results.dragLongestTaskMs.push(sample.tasks.length ? Math.max(...sample.tasks) : 0);
    await page.waitForTimeout(600);
  }

  console.log(`PIPELINE-PERF (drag) ${JSON.stringify(results)}`);

  // 4. Settle: from the pointer up over Qualified until the card sits still in that column (identity transform two
  // frames running); then Shift+← puts it back.
  for (let i = 0; i < 3; i++) {
    const src = (await page.locator(`[data-deal-main="${deal}"]`).boundingBox())!;
    const dst = (await page.locator('[data-column="qualified"]').boundingBox())!;
    await page.mouse.move(src.x + 40, src.y + 30);
    await page.mouse.down();
    await page.mouse.move(src.x + 50, src.y + 40, { steps: 4 });
    await page.mouse.move(dst.x + dst.width / 2, dst.y + 160, { steps: 12 });
    await page.waitForTimeout(100);
    // The listener goes in first (an awaited evaluate), so the pointer up cannot arrive before it.
    await page.evaluate((type) => armInput(type), "pointerup");
    await page.mouse.up();
    results.settleMs.push(
      round(
        await page.evaluate(
          (deal) =>
            waitSince((still) => {
              const el = document.querySelector<HTMLElement>(`[data-column="qualified"] [data-deal-card="${deal}"]`);
              const t = el ? getComputedStyle(el).transform : "x";
              return still(!!el && (t === "none" || t === "matrix(1, 0, 0, 1, 0, 0)"), 2);
            }),
          deal,
        ),
      ),
    );
    await expect.poll(() => sql(`select s.key from public.deals d join public.pipeline_stages s on s.id = d.stage_id where d.id = '${deal}'`)).toBe("qualified");
    await page.waitForTimeout(400);
    await timeMove(page, deal, "ArrowLeft", "lead");
    await expect.poll(() => sql(`select s.key from public.deals d join public.pipeline_stages s on s.id = d.stage_id where d.id = '${deal}'`)).toBe("lead");
    await page.waitForTimeout(500);
  }

  // 5. Press feedback: from the pointer down until the card's 0.97 scale is painted.
  for (let i = 0; i < 3; i++) {
    const box = (await page.locator(`[data-deal-main="${deal}"]`).boundingBox())!;
    await page.mouse.move(box.x + 40, box.y + 30);
    await page.evaluate((type) => armInput(type), "pointerdown");
    await page.mouse.down();
    results.pressMs.push(
      round(
        await page.evaluate(
          (deal) =>
            waitSince((still) => {
              // Tailwind 4's scale-[0.97] is the CSS scale property (not transform); the first frame below 1 counts.
              const el = document.querySelector<HTMLElement>(`[data-deal-card="${deal}"]`);
              const sc = el ? getComputedStyle(el).scale : "none";
              return still(sc !== "none" && Number(sc.split(" ")[0]) < 1, 1);
            }),
          deal,
        ),
      ),
    );
    await page.mouse.up();
    await page.keyboard.press("Escape");
    await page.waitForTimeout(400);
  }

  console.log(`PIPELINE-PERF (settle, press) ${JSON.stringify(results)}`);

  // 6. Route Home → Pipeline after the dock hover (the board's data prefetched), and back; then without a hover, the
  // time to the skeleton.
  const board = '[data-column="lead"] [data-deal-card]';
  for (let i = 0; i < 3; i++) {
    await page.goto("/");
    await appReady(page);
    await page.locator('nav a[href="/pipeline"]').first().hover();
    await page.waitForTimeout(1500);
    results.routeHoverMs.push(round(await timeClick(page, 'nav a[href="/pipeline"]', board)));
    await appReady(page);
    await page.locator('nav a[href="/"]').first().hover();
    await page.waitForTimeout(1500);
    results.routeBackHoverMs.push(round(await timeClick(page, 'nav a[href="/"]', "main h1")));
  }
  for (let i = 0; i < 3; i++) {
    await page.goto("/leads");
    await appReady(page);
    results.skeletonMs.push(round(await timeClick(page, 'nav a[href="/pipeline"]', `[aria-busy="true"], ${board}`)));
    await expect(page.locator(board).first()).toBeVisible();
  }

  console.log(`PIPELINE-PERF ${JSON.stringify(results)}`);
  sql(`delete from public.deals where created_by = '${me}'`);
  for (const key of Object.keys(BUDGET) as (keyof typeof BUDGET)[]) {
    for (const [i, value] of results[key].entries()) {
      expect.soft(value, `${key} run ${i + 1}: ${value} (budget ${round(BUDGET[key])})`).toBeLessThanOrEqual(BUDGET[key]);
    }
  }
  await context.close();
});
