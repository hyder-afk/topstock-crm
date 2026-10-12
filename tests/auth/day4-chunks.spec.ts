import { expect, test } from "@playwright/test";
import fs from "node:fs";
import zlib from "node:zlib";
import { appReady, createUser, fullSession, seedLeads, setRole, sql } from "./helpers";

// Route chunk size (Day 4 design 8.6: the lead page at most 60 KB gzip extra). Method: the JavaScript files a signed-in
// browser loads for a deep link to a lead page, minus those it loads for a bare section page (/more, the app shell),
// each gzipped at level 9 from the production build in .next. Only with PERF=1, after `npm run build`; the numbers go
// into docs/evidence/day4b/README.md.
test.skip(!process.env.PERF, "speed run: set PERF=1");
test.use({ trace: "off" });

const password = "Lead-Chunks-Pass-42!";
const email = `lead-chunks-${Date.now()}@example.test`;

test("lead page route chunk: at most 60 KB gzip over the app shell", async ({ browser, browserName }) => {
  test.skip(browserName !== "chromium", "one engine is enough for file sizes");
  const secret = await createUser(email, password, true);
  setRole(email, "admin");
  seedLeads([email], 5);
  const lead = sql(`select id from public.companies order by created_at desc limit 1`);
  const state = await fullSession(browser, email, password, secret);
  const gzipped = (path: string) => {
    const file = path.match(/\/_next\/(static\/.*\.js)$/);
    return file ? zlib.gzipSync(fs.readFileSync(`.next/${file[1]}`), { level: 9 }).length : 0;
  };
  const scriptsFor = async (url: string) => {
    const context = await browser.newContext({ storageState: state });
    const page = await context.newPage();
    const paths = new Set<string>();
    page.on("response", (r) => {
      const path = new URL(r.url()).pathname;
      if (path.startsWith("/_next/static/") && path.endsWith(".js")) paths.add(path);
    });
    await page.goto(url);
    await appReady(page);
    await page.waitForTimeout(1500);
    await context.close();
    return paths;
  };
  const shell = await scriptsFor("/more");
  const leadPage = await scriptsFor(`/leads/${lead}`);
  const kb = (paths: Iterable<string>) => Math.round([...paths].reduce((sum, p) => sum + gzipped(p), 0) / 102.4) / 10;
  const extra = [...leadPage].filter((p) => !shell.has(p));
  console.log(`LEAD-CHUNKS ${JSON.stringify({ shellKB: kb(shell), leadPageKB: kb(leadPage), extraKB: kb(extra), extraFiles: extra.length })}`);
  expect(kb(extra)).toBeLessThanOrEqual(60);
});

// Day 4c (design 8.6): the work queue at most 40 KB gzip over the app shell, the Tasks page at most 35 KB; same method.
test("queue and tasks route chunks: at most 40 KB and 35 KB gzip over the app shell", async ({ browser, browserName }) => {
  test.skip(browserName !== "chromium", "one engine is enough for file sizes");
  const mail = `queue-chunks-${Date.now()}@example.test`;
  const secret = await createUser(mail, password, true);
  setRole(mail, "admin");
  const state = await fullSession(browser, mail, password, secret);
  const gzipped = (path: string) => {
    const file = path.match(/\/_next\/(static\/.*\.js)$/);
    return file ? zlib.gzipSync(fs.readFileSync(`.next/${file[1]}`), { level: 9 }).length : 0;
  };
  const scriptsFor = async (url: string) => {
    const context = await browser.newContext({ storageState: state });
    const page = await context.newPage();
    const paths = new Set<string>();
    page.on("response", (r) => {
      const path = new URL(r.url()).pathname;
      if (path.startsWith("/_next/static/") && path.endsWith(".js")) paths.add(path);
    });
    await page.goto(url);
    await appReady(page);
    await page.waitForTimeout(1500);
    await context.close();
    return paths;
  };
  const shell = await scriptsFor("/more");
  const kb = (paths: Iterable<string>) => Math.round([...paths].reduce((sum, p) => sum + gzipped(p), 0) / 102.4) / 10;
  const queue = [...(await scriptsFor("/leads/queue"))].filter((p) => !shell.has(p));
  const tasks = [...(await scriptsFor("/tasks"))].filter((p) => !shell.has(p));
  console.log(`QUEUE-TASKS-CHUNKS ${JSON.stringify({ shellKB: kb(shell), queueExtraKB: kb(queue), queueFiles: queue.length, tasksExtraKB: kb(tasks), tasksFiles: tasks.length })}`);
  expect.soft(kb(queue)).toBeLessThanOrEqual(40);
  expect.soft(kb(tasks)).toBeLessThanOrEqual(35);
});
