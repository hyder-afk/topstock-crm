import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { choose, clearStockHistory, createUser, fullSession, setRole, sql } from "./helpers";

// Import speed in the browser at Release 1 size (design 6E): a 30,000-row made-up file, on a CPU slowed down 4 times
// (an older laptop). Records how long reading, matching, checking and importing take, the longest the page stays busy
// without answering (a "long task"; the budget is 200 ms) and the size of every request body (under 1 MB).
// Only with PERF=1 on Chromium (CPU slow-down is a Chromium feature); results go into docs/evidence/day3b/perf.md.
test.skip(!process.env.PERF, "speed run: set PERF=1");

const rows = 30_000;
const password = "Import-Perf-42!";
const email = `import-perf-${Date.now()}@example.test`;

test("a 30,000-row file at 4x CPU slow-down: reading, matching, checking, importing", async ({ browser, browserName }) => {
  test.skip(browserName !== "chromium", "CPU slow-down needs Chromium");
  test.setTimeout(600_000);
  const dir = mkdtempSync(path.join(tmpdir(), "import-perf-"));
  try {
    execFileSync(process.execPath, [path.join(__dirname, "..", "..", "scripts", "make-fake-leads.mjs"), "--rows", String(rows), "--out", dir]);
    const file = path.join(dir, readdirSync(dir).find((f) => f.endsWith(".csv"))!);
    clearStockHistory();
  sql(`delete from public.files; delete from public.deals; delete from public.companies; delete from public.import_batches;
         update public.profiles set last_name = 'Earlier run'
         where last_name = 'Test' and first_name in ('Haider', 'Henri', 'Kais')`);
    const secret = await createUser(email, password, true);
    setRole(email, "admin");
    sql(`update public.profiles set first_name = 'Haider', last_name = 'Test'
         where id = (select id from auth.users where email = '${email}')`);
    const state = await fullSession(browser, email, password, secret);

    const context = await browser.newContext({ storageState: state, viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    // Long tasks (over 50 ms), counted from the moment the file is chosen.
    await page.addInitScript(() => {
      const w = window as unknown as { __tasks: number[] };
      w.__tasks = [];
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) w.__tasks.push(Math.round(entry.duration));
      }).observe({ type: "longtask", buffered: true });
    });
    const bodies: number[] = [];
    page.on("request", (request) => {
      if (request.method() === "POST") bodies.push(request.postDataBuffer()?.length ?? 0);
    });
    await page.goto("/leads/import");
    await expect(page.getByRole("heading", { name: "Choose your file" })).toBeVisible();
    const cdp = await context.newCDPSession(page);
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
    // The long tasks since the last call (each step's own), in milliseconds.
    const takeTasks = () =>
      page.evaluate(() => {
        const w = window as unknown as { __tasks: number[] };
        return w.__tasks.splice(0);
      });
    await takeTasks();

    const t0 = Date.now();
    await page.locator('input[type="file"]').setInputFiles(file);
    await expect(page.getByRole("heading", { name: "Match your columns" })).toBeVisible({ timeout: 120_000 });
    const read = Date.now() - t0;
    const readTasks = await takeTasks();
    // Day 7b: the app's own Select (a combobox button), picked like a person does; each choice clears its aria-invalid.
    const open = page.locator('[role="combobox"][aria-invalid="true"]');
    for (let left = await open.count(); left > 0; left = await open.count()) await choose(open.first(), "cold");
    const t1 = Date.now();
    await page.getByRole("button", { name: /^Check file/ }).click();
    await expect(page.getByRole("heading", { name: "Check results" })).toBeVisible({ timeout: 300_000 });
    const checked = Date.now() - t1;
    const checkTasks = await takeTasks();
    const ready = Number((await page.locator("dl > div").first().locator("dd").first().textContent())?.replace(/\D/g, ""));
    const t2 = Date.now();
    await page.getByRole("button", { name: /^Import [\d,]+ leads/ }).click();
    await expect(page.getByRole("heading", { name: /leads added$/ })).toBeVisible({ timeout: 300_000 });
    const imported = Date.now() - t2;
    const importTasks = await takeTasks();
    const tasks = [...readTasks, ...checkTasks, ...importTasks];
    const longest = Math.max(0, ...tasks);
    const result = {
      rows,
      fileMB: +(statSync(file).size / 1e6).toFixed(1),
      ready,
      readMs: read,
      checkMs: checked,
      importMs: imported,
      totalMs: read + checked + imported,
      longestTaskMs: longest,
      tasksOver200: tasks.filter((d) => d > 200).length,
      tasksOver50: tasks.length,
      longTasks: { read: readTasks, check: checkTasks, import: importTasks },
      largestBodyKB: Math.round(Math.max(...bodies) / 1024),
      posts: bodies.length,
    };
    console.log(`IMPORT-PERF ${JSON.stringify(result)}`);
    await test.info().attach("import-perf.json", { body: JSON.stringify(result, null, 2), contentType: "application/json" });
    expect(ready).toBe(rows);
    expect(result.largestBodyKB).toBeLessThan(1024);
    expect(result.totalMs).toBeLessThan(90_000);
    expect(longest).toBeLessThan(200);
    await context.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
    clearStockHistory();
  sql(`delete from public.files; delete from public.deals; delete from public.companies; delete from public.import_batches`);
  }
});
