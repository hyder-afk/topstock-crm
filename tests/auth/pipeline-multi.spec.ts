import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { appReady, createUser, fullSession, isCancelledPrefetch, setRole, settled, sql, trackRequests } from "./helpers";

// Two people, one deal (Day 5b, design 8.5 "pipeline-multi.spec.ts" and 5.7): two browsers drag the same card at the
// same moment to different columns. The database takes one move (the version check in move_deal); the other screen
// puts the card where it really is and names who moved it; the history holds one move. Fixtures are made-up rows
// written straight into the local database, found by id; the outcome is checked in the database.
test.describe.configure({ mode: "serial" });

const password = "Pipeline-Multi-Pass-42!";
const run = Date.now();
const aEmail = `pmulti-a-${run}@example.test`;
const bEmail = `pmulti-b-${run}@example.test`;
let aState: Awaited<ReturnType<BrowserContext["storageState"]>>;
let bState: Awaited<ReturnType<BrowserContext["storageState"]>>;
let org = "";
let a = "";

const uuid = /^[0-9a-f-]{36}$/;
const userId = (email: string) => sql(`select id from auth.users where email = '${email}'`);
const stageOf = (deal: string) => sql(`select s.key from public.deals d join public.pipeline_stages s on s.id = d.stage_id where d.id = '${deal}'`);
const card = (page: Page, deal: string) => page.locator(`[data-deal-card="${deal}"]`);
const mainOf = (page: Page, deal: string) => page.locator(`[data-deal-main="${deal}"]`);
const column = (page: Page, key: string) => page.locator(`[data-column="${key}"]`);
const toast = (page: Page) => page.getByRole("status").filter({ hasText: /\S/ }).last();

async function open(browser: Browser, state: typeof aState) {
  const context = await browser.newContext({ storageState: state, viewport: { width: 1440, height: 900 }, timezoneId: "Europe/Paris" });
  const page = await context.newPage();
  trackRequests(page);
  const errors: string[] = [];
  page.on("console", (m) => m.type() === "error" && !isCancelledPrefetch(m.text()) && errors.push(m.text()));
  page.on("pageerror", (e) => !isCancelledPrefetch(e.message) && errors.push(e.message));
  await settled(page);
  await page.goto("/pipeline");
  await expect(page.getByRole("region", { name: "Pipeline board" })).toBeVisible();
  await appReady(page);
  return { context, page, errors };
}

// The drag up to the moment before the drop (dnd-kit's 6 px activation, then over the target column).
async function pickAndHover(page: Page, deal: string, target: string) {
  await mainOf(page, deal).scrollIntoViewIfNeeded();
  const src = (await mainOf(page, deal).boundingBox())!;
  const dst = (await column(page, target).boundingBox())!;
  await page.mouse.move(src.x + 40, src.y + 30);
  await page.mouse.down();
  await page.mouse.move(src.x + 50, src.y + 40, { steps: 4 });
  await page.mouse.move(dst.x + dst.width / 2, dst.y + Math.min(dst.height / 2, 160), { steps: 12 });
  await page.waitForTimeout(80);
}

test.beforeAll(async ({ browser }) => {
  test.setTimeout(240_000);
  const aSecret = await createUser(aEmail, password, true);
  const bSecret = await createUser(bEmail, password, true);
  setRole(aEmail, "admin");
  setRole(bEmail, "admin");
  a = userId(aEmail);
  org = sql(`select org_id from public.profiles where id = '${a}'`);
  sql(`update public.profiles set first_name = 'Anouk', last_name = 'Lemaire' where id = '${a}'`);
  sql(`update public.profiles set first_name = 'Bastien', last_name = 'Roux' where id = '${userId(bEmail)}'`);
  // The local stack is reused: earlier runs' made-up deals go, so this run's card is in the first page of its column.
  sql(`delete from public.deals where org_id = '${org}'
         and created_by in (select id from auth.users where email like 'pmulti-%' and email not in ('${aEmail}', '${bEmail}'))`);
  aState = await fullSession(browser, aEmail, password, aSecret);
  bState = await fullSession(browser, bEmail, password, bSecret);
});

test("two people drag the same deal within 200 ms: one move lands, the other screen shows it with the conflict toast", async ({ browser }) => {
  const lead = sql(`insert into public.companies (org_id, name, owner_id, lead_status, phone, city, country)
                    values ('${org}', 'Multi Lead ${run}', '${a}', 'warm', '06 12 34 56 78', 'Lyon', 'FR') returning id`);
  const deal = sql(`insert into public.deals (org_id, company_id, stage_id, owner_id, created_by, title, value, stage_entered_at, version)
                    select '${org}', '${lead}', s.id, '${a}', '${a}', 'Contested ${run}', 5000, now(), 0
                      from public.pipeline_stages s where s.org_id = '${org}' and s.key = 'lead' returning id`);
  expect(deal).toMatch(uuid);
  const pa = await open(browser, aState);
  const pb = await open(browser, bState);
  await expect(card(pa.page, deal)).toBeVisible();
  await expect(card(pb.page, deal)).toBeVisible();
  // Both pick the card up and hover their targets; then both drop within the same few milliseconds.
  await pickAndHover(pa.page, deal, "qualified");
  await pickAndHover(pb.page, deal, "negotiations");
  // Each page notes when its pointer up arrived (wall clock), so the gap between the two drops is measured where they
  // happen, not around Playwright's round trips.
  for (const p of [pa.page, pb.page]) {
    await p.evaluate(() => document.addEventListener("pointerup", () => ((window as unknown as { __up: number }).__up = Date.now()), { capture: true, once: true }));
  }
  await Promise.all([pa.page.mouse.up(), pb.page.mouse.up()]);
  const ups = await Promise.all([pa.page, pb.page].map((p) => p.evaluate(() => (window as unknown as { __up: number }).__up)));
  expect(Math.abs(ups[0] - ups[1])).toBeLessThan(200);
  // One move is stored; the history has exactly one move row.
  await expect.poll(() => sql(`select count(*) from public.deal_stage_history where deal_id = '${deal}' and kind = 'move'`)).toBe("1");
  const winner = stageOf(deal);
  expect(["qualified", "negotiations"]).toContain(winner);
  const [won, lost] = winner === "qualified" ? [pa, pb] : [pb, pa];
  const winnerName = winner === "qualified" ? "Anouk" : "Bastien";  // the toast names people by first name
  const stageWord = winner === "qualified" ? "Qualified" : "Negotiations";
  // The winner's screen keeps the card where it was dropped; the other screen moves it there and names the winner.
  await expect(column(won.page, winner).locator(`[data-deal-card="${deal}"]`)).toBeVisible();
  await expect(column(lost.page, winner).locator(`[data-deal-card="${deal}"]`)).toBeVisible();
  await expect(toast(lost.page)).toContainText(`${winnerName} moved this to ${stageWord} a moment ago.`);
  // Nothing else changed: still one move, and the version moved once.
  expect(sql(`select count(*) from public.deal_stage_history where deal_id = '${deal}' and kind = 'move'`)).toBe("1");
  expect(sql(`select version from public.deals where id = '${deal}'`)).toBe("1");
  expect(pa.errors).toEqual([]);
  expect(pb.errors).toEqual([]);
  await pa.context.close();
  await pb.context.close();
});
