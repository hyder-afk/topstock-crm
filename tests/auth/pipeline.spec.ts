import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { ageStepUp, appReady, createUser, fullSession, isCancelledPrefetch, settled, setRole, sql, trackRequests } from "./helpers";

// The pipeline board (Day 5b, design 8.5 "pipeline.spec.ts"): moving by drag, keyboard drag, Shift+arrows, digits by key
// position, the right-click menu; Won, Lost, Reopen and Delete with their rules; the display (days in stage, Stalled,
// the Won window, Show more, the sort note, the live region); reduced motion, offline, text never run as HTML, and the
// phone layout. Deals are made-up fixtures written straight into the local database, found by id (data-deal-card), never
// by name; outcomes are checked in the database.
test.describe.configure({ mode: "serial" });

const password = "Pipeline-Pass-42!";
const run = Date.now();
const adminEmail = `pipe-admin-${run}@example.test`;
let adminState: Awaited<ReturnType<BrowserContext["storageState"]>>;
let org = "";
let admin = "";

const uuid = /^[0-9a-f-]{36}$/;
const userId = (email: string) => sql(`select id from auth.users where email = '${email}'`);

function makeLead(name: string, status = "warm") {
  const id = sql(`insert into public.companies (org_id, name, owner_id, lead_status, phone, city, country)
                  values ('${org}', '${name} ${run}', '${admin}', '${status}', '06 12 34 56 78', 'Lyon', 'FR') returning id`);
  expect(id).toMatch(uuid);
  return id;
}

// A deal written by the superuser (no signed-in user: the guard is skipped, the history trigger writes the open row).
// Stage keys and values are fixed test literals.
function makeDeal(o: { lead?: string; stage?: string; title?: string; value?: string | null; hoursInStage?: number; closedHoursAgo?: number; fulfilment?: string | null; createdHoursAgo?: number }) {
  const lead = o.lead ?? makeLead("Pipeline Lead");
  const stage = o.stage ?? "lead";
  const closed = stage === "won" || stage === "lost";
  const value = o.value === undefined ? "1200" : o.value;
  const title = (o.title ?? `Deal ${run}`).replace(/'/g, "''");
  const id = sql(`insert into public.deals (org_id, company_id, stage_id, owner_id, created_by, title, value, fulfilment, status, closed_at,
                                            lost_reason, stage_entered_at, version, created_at)
                  select '${org}', '${lead}', s.id, '${admin}', '${admin}', '${title}', ${value === null ? "null" : value},
                         ${o.fulfilment ? `'${o.fulfilment}'` : closed && stage === "won" ? "'from_stock'" : "null"},
                         '${closed ? stage : "open"}', ${closed ? `now() - interval '${o.closedHoursAgo ?? 1} hours'` : "null"},
                         ${stage === "lost" ? "'price'" : "null"}, now() - interval '${o.hoursInStage ?? 0} hours', 0,
                         now() - interval '${o.createdHoursAgo ?? 0} hours'
                    from public.pipeline_stages s where s.org_id = '${org}' and s.key = '${stage}' returning id`);
  expect(id).toMatch(uuid);
  return id;
}
const stageOf = (deal: string) => sql(`select s.key from public.deals d join public.pipeline_stages s on s.id = d.stage_id where d.id = '${deal}'`);
const card = (page: Page, deal: string) => page.locator(`[data-deal-card="${deal}"]`);
const mainOf = (page: Page, deal: string) => page.locator(`[data-deal-main="${deal}"]`);
const column = (page: Page, key: string) => page.locator(`[data-column="${key}"]`);
const toast = (page: Page) => page.getByRole("status").filter({ hasText: /\S/ }).last();

async function open(browser: Browser, o: { width?: number; locale?: string; reducedMotion?: "reduce" | "no-preference"; state?: typeof adminState } = {}) {
  const width = o.width ?? 1440;
  const context = await browser.newContext({
    storageState: o.state ?? adminState,
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

async function gotoBoard(page: Page, query = "") {
  await settled(page);
  await page.goto(`/pipeline${query}`);
  await expect(page.getByRole("region", { name: /Pipeline board|Tableau du pipeline/ })).toBeVisible();
  await appReady(page);
}

// Waits until a card has settled (its spring finished: the same place two frames running, no dialog's pointer lock).
async function stable(page: Page, deal: string) {
  let last = "";
  await expect
    .poll(async () => {
      const b = await card(page, deal).boundingBox();
      const locked = await page.evaluate(() => document.body.style.pointerEvents === "none");
      const now = b && !locked ? `${Math.round(b.x)},${Math.round(b.y)}` : "moving";
      const same = now !== "moving" && now === last;
      last = now;
      return same;
    }, { intervals: [100] })
    .toBe(true);
}

// A mouse drag with dnd-kit's 6 px activation, in steps so collisions update.
async function drag(page: Page, from: string, toSelector: string) {
  await mainOf(page, from).scrollIntoViewIfNeeded();
  await stable(page, from);
  const src = (await mainOf(page, from).boundingBox())!;
  const dst = (await page.locator(toSelector).first().boundingBox())!;
  await page.mouse.move(src.x + 40, src.y + 30);
  await page.mouse.down();
  await page.mouse.move(src.x + 50, src.y + 40, { steps: 4 });
  await page.mouse.move(dst.x + dst.width / 2, dst.y + Math.min(dst.height / 2, 160), { steps: 12 });
  await page.waitForTimeout(80);
  await page.mouse.up();
}

test.beforeAll(async ({ browser }) => {
  test.setTimeout(240_000);
  const secret = await createUser(adminEmail, password, true);
  setRole(adminEmail, "admin");
  admin = userId(adminEmail);
  org = sql(`select org_id from public.profiles where id = '${admin}'`);
  sql(`update public.profiles set first_name = 'Ada', last_name = 'Morel' where id = '${admin}'`);
  // The local stack is reused: clear earlier specs' made-up deals (every test user's but this run's) so this run's cards
  // are in the first page of each column.
  sql(`delete from public.deals where org_id = '${org}'
         and created_by in (select id from auth.users where email like '%@example.test' and email <> '${adminEmail}')`);
  adminState = await fullSession(browser, adminEmail, password, secret);
});

test("drag_lead_to_qualified_settles_then_undo_keeps_days", async ({ browser }) => {
  const deal = makeDeal({ hoursInStage: 24 * 3 + 1, title: `Drag ${run}` });
  const { context, page, errors } = await open(browser);
  await gotoBoard(page);
  await expect(card(page, deal)).toContainText("3 days in stage");
  await drag(page, deal, '[data-column="qualified"]');
  await expect(column(page, "qualified").locator(`[data-deal-card="${deal}"]`)).toBeVisible();
  await expect(card(page, deal)).toContainText("Today");
  await expect.poll(() => stageOf(deal)).toBe("qualified");
  await expect(toast(page)).toContainText("Moved to Qualified");
  // Undo (the toast) restores the stage and its clock (3 days), from the history row, not the browser.
  await toast(page).getByRole("button", { name: "Undo" }).click();
  await expect.poll(() => stageOf(deal)).toBe("lead");
  await expect(column(page, "lead").locator(`[data-deal-card="${deal}"]`)).toContainText("3 days in stage");
  expect(sql(`select kind from public.deal_stage_history where deal_id = '${deal}' order by id desc limit 1`)).toBe("undo");
  expect(errors).toEqual([]);
  await context.close();
});

test("keyboard_space_arrows_space_moves, enter_opens_sheet_not_drag, shift_arrow_moves_stage", async ({ browser }) => {
  const deal = makeDeal({ title: `Keys ${run}` });
  const { context, page, errors } = await open(browser);
  await gotoBoard(page);
  await mainOf(page, deal).focus();
  // Space picks up, → goes to the next stage, Space drops.
  await page.keyboard.press("Space");
  await expect(page.locator("[data-lost-band]")).toBeVisible();
  // The arrow is pressed straight after pick-up on purpose (targets are not measured yet); the announcement follows.
  const live = page.locator("[id^=DndLiveRegion]").first();
  await page.keyboard.press("ArrowRight");
  await expect(live).toContainText("Over Qualified.");
  await page.keyboard.press("Space");
  await expect.poll(() => stageOf(deal)).toBe("qualified");
  // Focus follows the card into its new column.
  await expect(mainOf(page, deal)).toBeFocused();
  // Enter opens the deal sheet (no drag).
  await page.keyboard.press("Enter");
  const sheet = page.getByRole("dialog");
  await expect(sheet).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`deal=${deal}`));
  await expect(page.locator("[data-lost-band]")).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(sheet).toBeHidden();
  await expect(mainOf(page, deal)).toBeFocused();
  // Shift+→ moves one stage.
  await page.keyboard.press("Shift+ArrowRight");
  await expect.poll(() => stageOf(deal)).toBe("negotiations");
  await page.keyboard.press("Shift+ArrowLeft");
  await expect.poll(() => stageOf(deal)).toBe("qualified");
  expect(errors).toEqual([]);
  await context.close();
});

test("digit_4_opens_win_azerty, drop_on_won_requires_value_and_ships", async ({ browser }) => {
  const deal = makeDeal({ stage: "negotiations", value: null, title: `Win ${run}` });
  const { context, page, errors } = await open(browser);
  await gotoBoard(page);
  await mainOf(page, deal).focus();
  // AZERTY: the 4 key types ' without Shift; the key's place (Digit4) is what counts.
  await page.keyboard.down("Quote");
  await page.keyboard.up("Quote");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.evaluate((id) => {
    const el = document.querySelector(`[data-deal-main="${id}"]`)!;
    el.dispatchEvent(new KeyboardEvent("keydown", { key: "'", code: "Digit4", bubbles: true, cancelable: true }));
  }, deal);
  const dialog = page.getByRole("dialog", { name: /as won/ });
  await expect(dialog).toBeVisible();
  // Value required (above 0) and how it ships required.
  await dialog.getByRole("button", { name: /Mark as won/ }).click();
  await expect(dialog.getByText("Enter the final value, above €0.")).toBeVisible();
  await dialog.getByLabel("Final value (excl. VAT)").fill("18,400");
  await dialog.getByRole("button", { name: /Mark as won/ }).click();
  await expect(dialog.getByText("Choose how it ships.")).toBeVisible();
  await dialog.getByRole("radio", { name: /Supplier Stock/ }).click();
  await dialog.getByRole("button", { name: /Mark as won/ }).click();
  await expect(dialog).toBeHidden();
  await expect.poll(() => sql(`select status || ' ' || value || ' ' || fulfilment from public.deals where id = '${deal}'`)).toBe("won 18400.00 direct_from_source");
  await expect(column(page, "won").locator(`[data-deal-card="${deal}"]`)).toBeVisible();
  await expect(toast(page)).toContainText("Won · €18,400");
  expect(errors).toEqual([]);
  await context.close();
});

test("drop_on_won_cancel_springs_back, lost_band_reason_other_needs_note", async ({ browser }) => {
  const deal = makeDeal({ stage: "qualified", title: `Cancel ${run}` });
  const { context, page, errors } = await open(browser);
  await gotoBoard(page);
  await drag(page, deal, '[data-column="won"]');
  const win = page.getByRole("dialog", { name: /as won/ });
  await expect(win).toBeVisible();
  await win.getByRole("button", { name: "Cancel" }).click();
  await expect(win).toBeHidden();
  await expect(column(page, "qualified").locator(`[data-deal-card="${deal}"]`)).toBeVisible();
  expect(stageOf(deal)).toBe("qualified");
  // Drop on the Lost band: Other needs a note.
  await stable(page, deal);
  const src = (await mainOf(page, deal).boundingBox())!;
  await page.mouse.move(src.x + 40, src.y + 30);
  await page.mouse.down();
  await page.mouse.move(src.x + 50, src.y + 40, { steps: 4 });
  const band = (await page.locator("[data-lost-band]").boundingBox())!;
  await page.mouse.move(band.x + band.width / 2, band.y + band.height / 2, { steps: 12 });
  await page.waitForTimeout(80);
  await page.mouse.up();
  const lose = page.getByRole("dialog", { name: /lost/ });
  await expect(lose).toBeVisible();
  await lose.getByRole("radio", { name: "Other" }).click();
  await lose.getByRole("button", { name: /Mark as lost/ }).click();
  await expect(lose.getByText("Other needs a note.")).toBeVisible();
  await lose.getByLabel("Note").fill("Moved to a cheaper supplier");
  await lose.getByRole("button", { name: /Mark as lost/ }).click();
  await expect(lose).toBeHidden();
  await expect.poll(() => sql(`select status || ' ' || lost_reason || ' ' || lost_note from public.deals where id = '${deal}'`)).toBe(
    "lost other Moved to a cheaper supplier",
  );
  await expect(card(page, deal)).toHaveCount(0);
  expect(errors).toEqual([]);
  await context.close();
});

test("context_menu_right_click_move_to, won_to_lost_needs_reopen, reopen_lost_one_click", async ({ browser }) => {
  const deal = makeDeal({ title: `Menu ${run}` });
  const won = makeDeal({ stage: "won", title: `Won ${run}`, value: "900" });
  const { context, page, errors } = await open(browser);
  await gotoBoard(page);
  await mainOf(page, deal).click({ button: "right" });
  const menu = page.getByRole("menu");
  await menu.getByRole("menuitem", { name: "Move to" }).hover();
  await page.getByRole("menuitem", { name: "Negotiations" }).click();
  await expect.poll(() => stageOf(deal)).toBe("negotiations");
  // A won deal's menu has no Mark lost: it must be reopened first (the database says reopen_first too).
  await mainOf(page, won).click({ button: "right" });
  await expect(page.getByRole("menuitem", { name: "Reopen…" })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "Mark lost…" })).toHaveCount(0);
  await page.keyboard.press("Escape");
  // A lost deal reopens in one click from the sheet's Reopen (no dialog for a lost deal).
  const lost = makeDeal({ stage: "lost", title: `Lost ${run}` });
  await page.goto(`/pipeline?deal=${lost}`);
  await appReady(page);
  const sheet = page.getByRole("dialog");
  await expect(sheet).toBeVisible();
  await sheet.getByRole("button", { name: "Reopen…" }).click();
  await expect.poll(() => sql(`select status from public.deals where id = '${lost}'`)).toBe("open");
  expect(errors).toEqual([]);
  await context.close();
});

test("reopen_won_asks_code, delete_deal_asks_for_code", async ({ browser }) => {
  const won = makeDeal({ stage: "won", title: `Reopen ${run}`, value: "1500" });
  // Opened an hour ago: past the 2 minutes in which one's own untouched deal deletes without a code.
  const del = makeDeal({ title: `Delete ${run}`, createdHoursAgo: 1 });
  const { context, page, errors } = await open(browser);
  await ageStepUp(context, 900);
  await gotoBoard(page, `?deal=${won}`);
  const sheet = page.getByRole("dialog");
  await sheet.getByRole("button", { name: "Reopen…" }).click();
  const reopen = page.getByRole("dialog", { name: "Reopen this deal" });
  await expect(reopen).toContainText("leaves this month’s won total");
  await reopen.getByRole("button", { name: "Reopen", exact: true }).click();
  // The code is stale: "Confirm it's you" asks for a fresh one; cancelling leaves the deal won.
  const stepUp = page.getByRole("dialog", { name: "Confirm it’s you" });
  await expect(stepUp).toBeVisible();
  await expect(stepUp).toContainText("Reopening a won deal");
  await stepUp.getByRole("button", { name: "Cancel" }).click();
  expect(sql(`select status from public.deals where id = '${won}'`)).toBe("won");
  await page.keyboard.press("Escape");
  // Delete: confirm, then the code (an admin; the deal was not opened by this person in the last 2 minutes).
  await page.goto(`/pipeline?deal=${del}`);
  await appReady(page);
  await page.getByRole("dialog").getByRole("button", { name: "More actions" }).click();
  await page.getByRole("menuitem", { name: "Delete…" }).click();
  await page.getByRole("dialog", { name: "Delete this deal?" }).getByRole("button", { name: "Delete deal" }).click();
  await expect(page.getByRole("dialog", { name: "Confirm it’s you" })).toContainText("Deleting a deal");
  await page.getByRole("dialog", { name: "Confirm it’s you" }).getByRole("button", { name: "Cancel" }).click();
  expect(sql(`select count(*) from public.deals where id = '${del}'`)).toBe("1");
  expect(errors).toEqual([]);
  await context.close();
});

test("stalled_badge_with_clock, won_column_last_30_days, xss_deal_title_is_text", async ({ browser }) => {
  const stalled = makeDeal({ hoursInStage: 24 * 9, title: `Stalled ${run}` });
  const recentWin = makeDeal({ stage: "won", closedHoursAgo: 24 * 3, title: `Recent ${run}` });
  const oldWin = makeDeal({ stage: "won", closedHoursAgo: 24 * 40, title: `Old ${run}` });
  const xss = makeDeal({ title: `<img src=x onerror="window.__xss=1"> ${run}` });
  const { context, page, errors } = await open(browser);
  await gotoBoard(page);
  await expect(card(page, stalled)).toContainText("9 days in stage");
  await expect(card(page, stalled)).toContainText("Stalled");
  await expect(column(page, "won").locator(`[data-deal-card="${recentWin}"]`)).toBeVisible();
  await expect(card(page, oldWin)).toHaveCount(0);
  await expect(card(page, xss)).toContainText('<img src=x onerror="window.__xss=1">');
  expect(await page.evaluate(() => (window as unknown as { __xss?: number }).__xss)).toBeUndefined();
  // Stalled only: the chip filters the board.
  await page.getByRole("button", { name: /Stalled only/ }).click();
  await expect(page).toHaveURL(/stalled=1/);
  await expect(card(page, stalled)).toBeVisible();
  await expect(card(page, xss)).toHaveCount(0);
  expect(errors).toEqual([]);
  await context.close();
});

test("show_more_keyset, sort_value_note_when_more, column_virtualised_drag_from_bottom", async ({ browser }) => {
  test.setTimeout(180_000);
  const lead = makeLead("Many Deals");
  // 120 deals in Qualified (one stage clock each, a minute apart), so the column has more than the first 50.
  sql(`insert into public.deals (org_id, company_id, stage_id, owner_id, created_by, title, value, stage_entered_at)
       select '${org}', '${lead}', s.id, '${admin}', '${admin}', 'Bulk ${run} ' || i, (i * 10)::numeric, now() - (i || ' minutes')::interval
         from public.pipeline_stages s, generate_series(1, 120) i where s.org_id = '${org}' and s.key = 'qualified'`);
  const { context, page, errors } = await open(browser);
  await gotoBoard(page);
  const qualified = column(page, "qualified");
  const before = await qualified.locator("[data-deal-card]").count();
  expect(before).toBeLessThanOrEqual(60);
  await qualified.getByRole("button", { name: /^Show \d+ more$/ }).click();
  await expect(qualified.getByText(/^Showing 100 of \d+$/)).toBeVisible();
  // Past 60 loaded cards the column is virtualised: only the drawn rows are in the page.
  expect(await qualified.locator("[data-deal-card]").count()).toBeLessThan(100);
  // Value sort re-sorts the loaded cards only, and says so.
  await page.getByRole("button", { name: /^Sort:/ }).click();
  await page.getByRole("menuitemradio", { name: /Value/ }).click();
  await expect(page.getByRole("button", { name: "Sort: Value" })).toBeVisible();
  // Drag a card from far down the column (scrolled into view) to Negotiations.
  const scroller = qualified.locator("[data-column-scroll]");
  await scroller.evaluate((el) => el.scrollTo(0, el.scrollHeight));
  await page.waitForTimeout(200);
  const bottom = qualified.locator("[data-deal-card]").last();
  const bottomId = (await bottom.getAttribute("data-deal-card"))!;
  await drag(page, bottomId, '[data-column="negotiations"]');
  await expect.poll(() => stageOf(bottomId)).toBe("negotiations");
  expect(errors).toEqual([]);
  await context.close();
});

test("announcements_live_region_en_fr", async ({ browser }) => {
  const deal = makeDeal({ title: `Announce ${run}`, value: "12400" });
  for (const locale of ["en", "fr"] as const) {
    const { context, page, errors } = await open(browser, { locale });
    await gotoBoard(page);
    await mainOf(page, deal).focus();
    await page.keyboard.press("Space");
    const live = page.locator("[role=status][aria-live=assertive], #DndLiveRegion-pipeline-board, [id^=DndLiveRegion]").first();
    await expect(live).toContainText(locale === "en" ? "Picked up" : "prise dans");
    await page.keyboard.press("Escape");
    await expect(live).toContainText(locale === "en" ? "Move cancelled" : "Déplacement annulé");
    expect(errors).toEqual([]);
    await context.close();
  }
});

test("reduced_motion_no_settle, offline_disables_drag, quick_second_move_same_card_no_conflict", async ({ browser }) => {
  const deal = makeDeal({ title: `Quiet ${run}` });
  const { context, page, errors } = await open(browser, { reducedMotion: "reduce" });
  await gotoBoard(page);
  await mainOf(page, deal).focus();
  // Two quick moves on one card run one after the other (one scope per deal): both land, no conflict.
  await page.keyboard.press("Shift+ArrowRight");
  await page.keyboard.press("Shift+ArrowRight");
  await expect.poll(() => stageOf(deal)).toBe("negotiations");
  expect(sql(`select count(*) from public.deal_stage_history where deal_id = '${deal}' and kind = 'move'`)).toBe("2");
  await expect(toast(page)).not.toContainText("moved this");
  // Reduced motion: the card is not transformed after the move (no travel, at most a short fade).
  await page.waitForTimeout(150);
  expect(await card(page, deal).evaluate((el) => getComputedStyle(el).transform)).toMatch(/^(none|matrix\(1, 0, 0, 1, 0, 0\))$/);
  // Offline: the chip says moves are paused and a drag does nothing.
  await context.setOffline(true);
  await expect(page.getByText("You’re offline · moves are paused")).toBeVisible();
  await drag(page, deal, '[data-column="lead"]');
  await expect(page.locator("[data-lost-band]")).toHaveCount(0);
  await context.setOffline(false);
  expect(stageOf(deal)).toBe("negotiations");
  expect(errors.filter((e) => !/Failed to fetch|ERR_INTERNET_DISCONNECTED|NetworkError/.test(e))).toEqual([]);
  await context.close();
});

test("phone_390_stepper_moves_and_tabs_sync", async ({ browser }) => {
  const deal = makeDeal({ title: `Phone ${run}` });
  const { context, page, errors } = await open(browser, { width: 390 });
  await gotoBoard(page);
  expect(await page.evaluate(() => document.documentElement.scrollWidth === document.documentElement.clientWidth)).toBe(true);
  const tabs = page.getByRole("navigation", { name: "Stages" });
  await expect(tabs.getByRole("button", { name: /^Lead/ })).toHaveAttribute("aria-current", "true");
  await tabs.getByRole("button", { name: /^Won/ }).click();
  await expect(tabs.getByRole("button", { name: /^Won/ })).toHaveAttribute("aria-current", "true");
  await tabs.getByRole("button", { name: /^Lead/ }).click();
  // A tap opens the sheet; the stepper moves the deal.
  await mainOf(page, deal).click();
  const sheet = page.getByRole("dialog");
  await expect(sheet).toBeVisible();
  await sheet.getByRole("radio", { name: "Qualified" }).click();
  await expect.poll(() => stageOf(deal)).toBe("qualified");
  await expect(sheet.getByRole("radio", { name: "Qualified" })).toHaveAttribute("aria-checked", "true");
  expect(await page.evaluate(() => document.documentElement.scrollWidth === document.documentElement.clientWidth)).toBe(true);
  expect(errors).toEqual([]);
  await context.close();
});
