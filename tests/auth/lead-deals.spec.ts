import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { appReady, choose, createUser, fullSession, isCancelledPrefetch, setRole, settled, sql, trackRequests } from "./helpers";

// Deals on the lead page (Day 5b, design 8.5 "lead-deals.spec.ts" and 7.9): the Deals tab opens a deal and its toast
// takes it back; Interested and Book meeting open a deal from the call panel (the switch is on when the lead has no
// open deal, off with the reason when it has one, D toggles it); one Undo takes back the call and its deal, or keeps a
// deal that changed since; a person who may not change the lead gets no switch and is told why; the header chip and
// the Summary card show the latest open deal; the composer's deal chip links an entry; the work queue (Day 4c, since the
// 4c rebase) shows the card's open deal and opens one with Interested; Reopen from the Deals tab starts at the stage the
// deal was closed from; U on the lead page takes back the newer of the last entry and the last deal move. Leads and
// deals are made-up fixtures written straight into the local database, found by id, never by name; outcomes are checked
// in the database.
test.describe.configure({ mode: "serial" });

const password = "Lead-Deals-Pass-42!";
const run = Date.now();
const adminEmail = `ldeals-admin-${run}@example.test`;
const repEmail = `ldeals-rep-${run}@example.test`;
let adminState: Awaited<ReturnType<BrowserContext["storageState"]>>;
let repState: Awaited<ReturnType<BrowserContext["storageState"]>>;
let admin = "";
let org = "";

const uuid = /^[0-9a-f-]{36}$/;
const userId = (email: string) => sql(`select id from auth.users where email = '${email}'`);

function makeLead(name: string, status = "cold") {
  const id = sql(`insert into public.companies (org_id, name, owner_id, lead_status, phone, email, city, country)
                  values ('${org}', '${name} ${run}', '${admin}', '${status}', '06 12 34 56 78', 'achats@example.com', 'Lyon', 'FR')
                  returning id`);
  expect(id).toMatch(uuid);
  return id;
}

// An open deal written by the superuser (no signed-in user: the guard is skipped). Stage keys and values are literals.
function makeDeal(lead: string, stage: string, title: string, value: string | null) {
  const id = sql(`insert into public.deals (org_id, company_id, stage_id, owner_id, created_by, title, value, status, stage_entered_at, version)
                  select '${org}', '${lead}', s.id, '${admin}', '${admin}', '${title} ${run}', ${value ?? "null"}, 'open',
                         now() - interval '2 days', 0
                    from public.pipeline_stages s where s.org_id = '${org}' and s.key = '${stage}' returning id`);
  expect(id).toMatch(uuid);
  return id;
}

const dealsOn = (lead: string) => sql(`select count(*) from public.deals where company_id = '${lead}'`);
const latestActivity = (lead: string) =>
  sql(`select id from public.activities where company_id = '${lead}' order by created_at desc, id desc limit 1`);

async function open(browser: Browser, state: typeof adminState, o: { width?: number; locale?: string } = {}) {
  const width = o.width ?? 1440;
  const context = await browser.newContext({
    storageState: state,
    viewport: { width, height: width < 600 ? 844 : 900 },
    timezoneId: "Europe/Paris",
    hasTouch: width < 600,
  });
  if (o.locale) await context.addCookies([{ name: "locale", value: o.locale, url: "http://localhost:3100" }]);
  // tel: links would leave the page: the app's own click handlers still run, only the browser's navigation is stopped.
  await context.addInitScript(() => {
    document.addEventListener(
      "click",
      (e) => {
        const a = (e.target as Element | null)?.closest?.("a[href^='tel:'],a[href^='mailto:'],a[href^='https://wa.me/']");
        if (a) e.preventDefault();
      },
      true,
    );
  });
  const page = await context.newPage();
  trackRequests(page);
  const errors: string[] = [];
  page.on("console", (m) => m.type() === "error" && !isCancelledPrefetch(m.text()) && errors.push(m.text()));
  page.on("pageerror", (e) => !isCancelledPrefetch(e.message) && errors.push(e.message));
  return { context, page, errors };
}

async function gotoLead(page: Page, id: string, tab?: string) {
  await settled(page);
  await page.goto(`/leads/${id}${tab ? `?tab=${tab}` : ""}`);
  await expect(page.locator("main h1")).toBeVisible();
  await appReady(page);
}

const panel = (page: Page) => page.getByRole("region", { name: /^(Calling|How did it go)/ });
const toast = (page: Page) => page.getByRole("status").filter({ hasText: /\S/ }).last();
const dealSwitch = (page: Page) => panel(page).getByRole("switch", { name: /Open a deal/ });

// Call, End call, then the outcome by its key (Digit1 No answer, Digit5 Interested, Digit6 Book meeting).
async function callAndPick(page: Page, key: "Digit1" | "Digit5" | "Digit6") {
  await page.getByRole("link", { name: "Call", exact: true }).first().click();
  await expect(panel(page)).toBeVisible();
  await panel(page).getByRole("button", { name: "End call" }).click();
  await expect(panel(page).getByRole("group", { name: "How did the call go?" })).toBeVisible();
  await page.keyboard.press(key);
}

test.beforeAll(async ({ browser }) => {
  test.setTimeout(240_000);
  const adminSecret = await createUser(adminEmail, password, true);
  const repSecret = await createUser(repEmail, password, true);
  setRole(adminEmail, "admin");
  setRole(repEmail, "rep");
  admin = userId(adminEmail);
  org = sql(`select org_id from public.profiles where id = '${admin}'`);
  sql(`update public.profiles set first_name = 'Inès', last_name = 'Garnier' where id = '${admin}'`);
  sql(`update public.profiles set first_name = 'Malo', last_name = 'Perrin' where id = '${userId(repEmail)}'`);
  adminState = await fullSession(browser, adminEmail, password, adminSecret);
  repState = await fullSession(browser, repEmail, password, repSecret);
});

test("open_deal_from_tab_then_undo", async ({ browser }) => {
  const lead = makeLead("Deals Tab Lead");
  const { context, page, errors } = await open(browser, adminState);
  await gotoLead(page, lead, "deals");
  const tab = page.getByRole("tabpanel", { name: "Deals" });
  await expect(tab).toContainText("No deals yet. Open one when this lead is interested.");
  await tab.getByRole("button", { name: "Open a deal" }).first().click();
  const sheet = page.getByRole("dialog", { name: "New deal" });
  await expect(sheet).toBeVisible();
  // The lead is filled in from the page; only the title is typed.
  await expect(sheet).toContainText(`Deals Tab Lead ${run}`);
  await sheet.getByLabel("What’s being sold").fill(`Linen shirts ${run}`);
  await sheet.getByLabel("Value (excl. VAT)").fill("4200.50");
  await sheet.getByRole("button", { name: "Open deal" }).click();
  await expect(toast(page)).toContainText("Deal opened in Lead");
  await expect.poll(() => dealsOn(lead)).toBe("1");
  expect(sql(`select value::text from public.deals where company_id = '${lead}'`)).toBe("4200.50");
  // The new deal's sheet opens over the page (?deal=); closing it leaves the row in the tab.
  await expect(page).toHaveURL(/[?&]deal=[0-9a-f-]{36}/);
  await page.keyboard.press("Escape");
  await expect(tab.getByRole("button", { name: new RegExp(`Linen shirts ${run}`) })).toBeVisible();
  // The toast's Undo removes the new deal (inside the creator's 2 minutes, no code).
  await toast(page).getByRole("button", { name: "Undo last move" }).click();
  await expect.poll(() => dealsOn(lead)).toBe("0");
  await expect(tab).toContainText("No deals yet.");
  expect(errors).toEqual([]);
  await context.close();
});

test("book_meeting_opens_deal (title and value), then undo_interested_removes_deal", async ({ browser }) => {
  const meeting = makeLead("Meeting Lead");
  const { context, page, errors } = await open(browser, adminState);
  await gotoLead(page, meeting);
  await callAndPick(page, "Digit6");
  await expect(dealSwitch(page)).toHaveAttribute("aria-checked", "true");
  await expect(dealSwitch(page)).toHaveAttribute("aria-keyshortcuts", "D");
  await panel(page).getByRole("button", { name: "Tomorrow" }).click();
  await panel(page).getByLabel("Deal title (optional)").fill(`Wool coats ${run}`);
  // A bad amount blocks the save and says how to write it; a French amount is read correctly.
  await panel(page).getByLabel("Value (optional)").fill("12,4,5");
  await expect(panel(page)).toContainText("Enter an amount like 6,800 or leave it empty.");
  await panel(page).getByLabel("Value (optional)").fill("6800.50");
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press("Control+Enter");
  await expect(panel(page)).toHaveCount(0);
  await expect(toast(page)).toContainText("deal opened in Lead");
  await expect.poll(() => dealsOn(meeting)).toBe("1");
  const activity = latestActivity(meeting);
  expect(sql(`select s.key || '|' || d.title || '|' || d.value::text || '|' || (d.source_activity_id = '${activity}')
                from public.deals d join public.pipeline_stages s on s.id = d.stage_id where d.company_id = '${meeting}'`)).toBe(
    `lead|Wool coats ${run}|6800.50|true`,
  );
  // The header chip follows (get_lead's deals brief), in whole euros like the cards (the sheet shows the cents).
  await expect(page.getByRole("button", { name: /^Deal: Lead · €6,801/ })).toBeVisible();

  // Interested with the switch on, then the toast's Undo: the call, its task and its deal all go.
  const interested = makeLead("Interested Lead");
  await gotoLead(page, interested);
  await callAndPick(page, "Digit5");
  await expect(dealSwitch(page)).toHaveAttribute("aria-checked", "true");
  await page.keyboard.press("Control+Enter");
  await expect(toast(page)).toContainText("deal opened in Lead");
  await expect.poll(() => dealsOn(interested)).toBe("1");
  await toast(page).getByRole("button", { name: "Undo" }).click();
  await expect(toast(page)).toContainText("Undone");
  await expect.poll(() => dealsOn(interested)).toBe("0");
  expect(sql(`select count(*) from public.activities where company_id = '${interested}'`)).toBe("0");

  // The deal changed before the Undo (a move bumps its version): the call goes, the deal stays, and the toast says so.
  const kept = makeLead("Kept Deal Lead");
  await gotoLead(page, kept);
  await callAndPick(page, "Digit5");
  await page.keyboard.press("Control+Enter");
  await expect.poll(() => dealsOn(kept)).toBe("1");
  sql(`update public.deals set version = version + 1 where company_id = '${kept}'`);
  await toast(page).getByRole("button", { name: "Undo" }).click();
  await expect(toast(page)).toContainText("The deal was kept: it changed since");
  expect(dealsOn(kept)).toBe("1");
  expect(sql(`select count(*) from public.activities where company_id = '${kept}'`)).toBe("0");
  expect(errors).toEqual([]);
  await context.close();
});

test("interested_existing_deal_switch_off (D toggles it), and the call keeps the one deal", async ({ browser }) => {
  const lead = makeLead("Existing Deal Lead", "warm");
  makeDeal(lead, "qualified", "Cotton tees", "6800");
  const { context, page, errors } = await open(browser, adminState);
  await gotoLead(page, lead);
  await callAndPick(page, "Digit5");
  await expect(dealSwitch(page)).toHaveAttribute("aria-checked", "false");
  await expect(panel(page)).toContainText("Already has an open deal: Qualified · €6,800");
  // D is read by event.key (a letter wherever it sits): on, then off again.
  await page.keyboard.press("d");
  await expect(dealSwitch(page)).toHaveAttribute("aria-checked", "true");
  await expect(panel(page).getByLabel("Deal title (optional)")).toBeVisible();
  await page.keyboard.press("d");
  await expect(dealSwitch(page)).toHaveAttribute("aria-checked", "false");
  await page.keyboard.press("Control+Enter");
  await expect(panel(page)).toHaveCount(0);
  await expect(toast(page)).toContainText("Logged:");
  await expect(toast(page)).not.toContainText("deal opened");
  expect(dealsOn(lead)).toBe("1");
  expect(errors).toEqual([]);
  await context.close();
});

test("non_editor_no_open_switch: a rep on the admin's lead logs Interested, gets no switch and is told why", async ({ browser }) => {
  const lead = makeLead("Read Only Deals Lead");
  const { context, page, errors } = await open(browser, repState);
  await gotoLead(page, lead);
  await callAndPick(page, "Digit5");
  await expect(panel(page).locator('[data-outcome="interested"]')).toHaveAttribute("aria-pressed", "true");
  await expect(dealSwitch(page)).toHaveCount(0);
  await page.keyboard.press("Control+Enter");
  await expect(panel(page)).toHaveCount(0);
  await expect(toast(page)).toContainText("Logged:");
  expect(dealsOn(lead)).toBe("0");
  // The Summary card and the Deals tab say who may open one; no Open a deal button.
  await expect(page.getByText("Only Inès Garnier or an admin can open a deal on this lead.").first()).toBeVisible();
  await page.getByRole("tab", { name: "Deals" }).click();
  const tab = page.getByRole("tabpanel", { name: "Deals" });
  await expect(tab).toContainText("Only Inès Garnier or an admin can open a deal on this lead.");
  await expect(tab.getByRole("button", { name: "Open a deal" })).toHaveCount(0);
  expect(errors).toEqual([]);
  await context.close();
});

test("header_chip_and_summary_card, the deal sheet over the page, the composer's deal chip (EN and FR)", async ({ browser }) => {
  const lead = makeLead("Chip Lead", "warm");
  const older = makeDeal(lead, "lead", "Older deal", null);
  sql(`update public.deals set created_at = now() - interval '3 days' where id = '${older}'`);
  const latest = makeDeal(lead, "qualified", "Denim jackets", "22000");
  const { context, page, errors } = await open(browser, adminState);
  await gotoLead(page, lead);
  const chip = page.getByRole("button", { name: /^Deal: Qualified · €22,000/ });
  await expect(chip).toBeVisible();
  const summary = page.getByRole("tabpanel", { name: "Summary" });
  await expect(summary).toContainText(`Denim jackets ${run}`);
  await expect(summary).toContainText("Qualified · €22,000 · 2 days in stage");
  await expect(summary.getByRole("button", { name: "+1 more open deal" })).toBeVisible();
  await expect(summary.getByRole("link", { name: "Open on the board" })).toHaveAttribute("href", `/pipeline?deal=${latest}`);
  // The chip opens the Deals tab: open deals first, newest first.
  await chip.click();
  await expect(page.getByRole("tab", { name: "Deals" })).toHaveAttribute("aria-selected", "true");
  const tab = page.getByRole("tabpanel", { name: "Deals" });
  await expect(tab.getByRole("button", { name: new RegExp(`Denim jackets ${run}`) })).toBeVisible();
  await expect(tab.getByRole("button", { name: new RegExp(`Older deal ${run}`) })).toBeVisible();
  // A row opens the deal sheet over the page, with the deal in the address; Escape closes it and focus comes back.
  await tab.getByRole("button", { name: new RegExp(`Denim jackets ${run}`) }).click();
  await expect(page).toHaveURL(new RegExp(`[?&]deal=${latest}`));
  const sheet = page.getByRole("dialog");
  await expect(sheet.getByLabel("What’s being sold")).toHaveValue(`Denim jackets ${run}`);
  await page.keyboard.press("Escape");
  await expect(sheet).toHaveCount(0);
  await expect(page).not.toHaveURL(/[?&]deal=/);
  await expect(page.locator("body")).not.toBeFocused();

  // The composer: with two open deals the chip is a menu that chooses one or none; the entry carries the choice.
  await page.getByRole("tab", { name: "Summary" }).click();
  const composer = page.getByRole("form", { name: "Log activity" });
  const about = composer.getByRole("combobox", { name: "Choose the deal" });
  await expect(about).toBeVisible();
  await choose(about, latest);
  await composer.getByRole("textbox", { name: "Note" }).fill(`About the jackets ${run}`);
  await composer.getByRole("button", { name: /^Save to timeline/ }).click();
  await expect(toast(page)).toContainText("Logged:");
  await expect.poll(() => sql(`select coalesce(deal_id::text, 'none') from public.activities where company_id = '${lead}' order by created_at desc limit 1`)).toBe(latest);
  await expect(about).toBeVisible();
  await choose(about, "");
  await composer.getByRole("textbox", { name: "Note" }).fill(`No deal ${run}`);
  await composer.getByRole("button", { name: /^Save to timeline/ }).click();
  await expect
    .poll(() => sql(`select coalesce(deal_id::text, 'none') from public.activities where company_id = '${lead}' and body = 'No deal ${run}'`))
    .toBe("none");
  expect(errors).toEqual([]);
  await context.close();

  // French: the chip, the stage and the money read the French way (narrow no-break spaces, € after the amount).
  const fr = await open(browser, adminState, { locale: "fr" });
  await gotoLead(fr.page, lead);
  await expect(fr.page.getByRole("button", { name: /^Affaire\s:\sQualifiée · 22\s000\s€/ })).toBeVisible();
  expect(fr.errors).toEqual([]);
  await fr.context.close();
});

test("phone_390: the Deals tab's Open a deal is full width and the page has no sideways scroll", async ({ browser }) => {
  const lead = makeLead("Phone Deals Lead");
  makeDeal(lead, "negotiations", "Phone deal", "18400");
  const { context, page, errors } = await open(browser, adminState, { width: 390 });
  await gotoLead(page, lead, "deals");
  const tab = page.getByRole("tabpanel", { name: "Deals" });
  await expect(tab.getByRole("button", { name: new RegExp(`Phone deal ${run}`) })).toBeVisible();
  const button = tab.getByRole("button", { name: "Open a deal" }).first();
  await expect(button).toBeVisible();
  const box = (await button.boundingBox())!;
  expect(box.height).toBeGreaterThanOrEqual(44);
  expect(box.width).toBeGreaterThan(300);
  expect(await page.evaluate(() => document.documentElement.scrollWidth === document.documentElement.clientWidth)).toBe(true);
  expect(errors).toEqual([]);
  await context.close();
});

// A closed deal with its closing history (written by the superuser): lost (or won) from `from`.
function makeClosedDeal(lead: string, status: "lost" | "won", from: string, title: string) {
  const id = sql(`insert into public.deals (org_id, company_id, stage_id, owner_id, created_by, title, value, status, closed_at, lost_reason,
                                            fulfilment, stage_entered_at, version)
                  select '${org}', '${lead}', s.id, '${admin}', '${admin}', '${title} ${run}', 900, '${status}', now() - interval '1 day',
                         ${status === "lost" ? "'price'" : "null"}, ${status === "won" ? "'from_stock'" : "null"}, now() - interval '1 day', 1
                    from public.pipeline_stages s where s.org_id = '${org}' and s.key = '${status}' returning id`);
  expect(id).toMatch(uuid);
  sql(`insert into public.deal_stage_history (org_id, deal_id, actor_id, kind, from_stage, to_stage, value_after, version_after, created_at)
       values ('${org}', '${id}', '${admin}', '${status}', '${from}', '${status}', 900, 1, now() - interval '1 day')`);
  return id;
}
const stageOf = (deal: string) => sql(`select s.key from public.deals d join public.pipeline_stages s on s.id = d.stage_id where d.id = '${deal}'`);
const statusOf = (lead: string) => sql(`select lead_status from public.companies where id = '${lead}'`);

test("reopen_from_deals_tab_uses_closing_stage, the row keeps the focus (verifier finding 4)", async ({ browser }) => {
  // A lost deal closed from Qualified, on a Cool off lead: it reopens in Qualified (the lead follows: Warm), never in
  // Negotiations (which would have made the lead Negotiation).
  const lead = makeLead("Reopen Lead", "cool_off");
  const deal = makeClosedDeal(lead, "lost", "qualified", "Lost from qualified");
  const { context, page, errors } = await open(browser, adminState);
  await gotoLead(page, lead, "deals");
  await page.getByRole("button", { name: "Actions for this deal" }).click();
  await page.getByRole("menuitem", { name: "Reopen…" }).click();
  await expect.poll(() => sql(`select status from public.deals where id = '${deal}'`)).toBe("open");
  expect(stageOf(deal)).toBe("qualified");
  await expect.poll(() => statusOf(lead)).toBe("warm");
  // The row menu went with the closed row: the deal's row in Open takes the focus.
  await expect(page.locator(`[data-deal-row="${deal}"]`)).toBeFocused();
  expect(await page.evaluate(() => document.activeElement !== document.body)).toBe(true);
  expect(errors).toEqual([]);
  await context.close();
});

test("u_on_lead_page_undoes_the_newer_deal_move, else the entry (verifier finding 7)", async ({ browser }) => {
  const lead = makeLead("Undo Order Lead", "warm");
  const deal = makeDeal(lead, "lead", "Undo order", "1500");
  const { context, page, errors } = await open(browser, adminState);
  await gotoLead(page, lead);
  // 1. An entry first (a no answer from the call panel), then a deal move from the sheet over the page.
  await callAndPick(page, "Digit1");
  await page.keyboard.press("Control+Enter");
  await expect(panel(page)).toHaveCount(0);
  await expect.poll(() => sql(`select count(*) from public.activities where company_id = '${lead}'`)).toBe("1");
  await page.getByRole("button", { name: /^Deal: Lead/ }).click();
  await page.locator(`[data-deal-row="${deal}"]`).click();
  const sheet = page.getByRole("dialog");
  await expect(sheet).toBeVisible();
  await sheet.getByRole("radio", { name: /^Qualified/ }).click();
  await expect.poll(() => stageOf(deal)).toBe("qualified");
  await page.keyboard.press("Escape");
  await expect(sheet).toBeHidden();
  await page.locator("main h1").click();
  // U takes back the move (the newer change); the entry stays.
  await page.keyboard.press("u");
  await expect.poll(() => stageOf(deal)).toBe("lead");
  expect(sql(`select count(*) from public.activities where company_id = '${lead}'`)).toBe("1");
  // 2. Now the entry is the newest undoable change (the move was undone): U takes it back.
  await page.keyboard.press("u");
  await expect.poll(() => sql(`select count(*) from public.activities where company_id = '${lead}'`)).toBe("0");
  expect(stageOf(deal)).toBe("lead");
  expect(errors).toEqual([]);
  await context.close();
});

test("interested_opens_deal_in_queue, the queue card's deal line (Day 4c rebase)", async ({ browser }) => {
  // Only this test's two leads are in the admin's queue: Negotiation first (with an open deal), then Warm (none).
  sql(`update public.companies set lead_status = 'disqualified' where owner_id = '${admin}'`);
  sql(`delete from private.queue_claims where user_id = '${admin}'`);
  const withDeal = makeLead("Queue Deal Lead", "negotiation");
  makeDeal(withDeal, "qualified", "Linen shirts", "6800");
  const without = makeLead("Queue Fresh Lead", "warm");
  const { context, page, errors } = await open(browser, adminState);
  await settled(page);
  await page.goto("/leads/queue");
  await expect(page.locator("main h1")).toContainText("Work queue");
  await appReady(page);
  await page.keyboard.press("Enter");
  const card = page.locator("main section[role=region]:not([data-leaving])");
  const outside = page.getByRole("button", { name: "Show leads outside calling hours" });
  await expect(card.or(outside).first()).toBeVisible();
  if (await outside.isVisible()) await outside.click();
  await expect(card).toHaveCount(1);
  await expect(card.locator("h2")).toContainText(`Queue Deal Lead ${run}`);
  await expect(card.locator("[data-queue-deal]")).toHaveText("Deal open: Qualified · €6,800");
  const qSwitch = page.getByRole("switch", { name: /Open a deal/ });
  // Interested on a lead with an open deal: the switch is off and says why; D turns it on and off.
  await page.keyboard.press("Digit5");
  await expect(qSwitch).toHaveAttribute("aria-checked", "false");
  await expect(page.getByRole("group", { name: "Interested" })).toContainText("Already has an open deal: Qualified · €6,800");
  await page.keyboard.press("d");
  await expect(qSwitch).toHaveAttribute("aria-checked", "true");
  await page.keyboard.press("d");
  await expect(qSwitch).toHaveAttribute("aria-checked", "false");
  await page.keyboard.press("Enter");
  await expect.poll(() => sql(`select count(*) from public.activities where company_id = '${withDeal}' and outcome = 'interested'`)).toBe("1");
  expect(dealsOn(withDeal)).toBe("1");
  // The next card has no deal: no deal line, and Interested opens one in the same call.
  await expect(card.locator("h2")).toContainText(`Queue Fresh Lead ${run}`);
  await expect(card.locator("[data-queue-deal]")).toHaveCount(0);
  await page.keyboard.press("Digit5");
  await expect(qSwitch).toHaveAttribute("aria-checked", "true");
  await page.keyboard.press("Enter");
  await expect.poll(() => dealsOn(without)).toBe("1");
  expect(sql(`select s.key || '|' || (d.source_activity_id is not null) from public.deals d join public.pipeline_stages s on s.id = d.stage_id
               where d.company_id = '${without}'`)).toBe("lead|true");
  await expect(page.locator("[data-toast]").last()).toContainText("deal opened in Lead");
  // U in the queue takes back the outcome and its untouched deal.
  await page.keyboard.press("u");
  await expect.poll(() => dealsOn(without)).toBe("0");
  expect(sql(`select count(*) from public.activities where company_id = '${without}'`)).toBe("0");
  expect(errors).toEqual([]);
  await context.close();
});

test("queue_outcome_deal_reaches_the_board: the board in this tab's cache is read again (bugs audit L3)", async ({ browser }) => {
  sql(`update public.companies set lead_status = 'disqualified' where owner_id = '${admin}'`);
  sql(`delete from private.queue_claims where user_id = '${admin}'`);
  const lead = makeLead("Queue Board Lead", "warm");
  const { context, page, errors } = await open(browser, adminState);
  // The board first: it is now in this tab's cache (fresh for 30 s).
  await settled(page);
  await page.goto("/pipeline");
  await expect(page.getByRole("region", { name: "Pipeline board" })).toBeVisible();
  await appReady(page);
  // The queue in the same tab (the dock, then the leads page's link): Interested opens a deal.
  const dock = page.getByRole("navigation", { name: /Sections/ });
  await dock.getByRole("link", { name: "Leads", exact: true }).click();
  await page.getByRole("link", { name: "Work queue" }).click();
  await expect(page.locator("main h1")).toContainText("Work queue");
  await appReady(page);
  await page.keyboard.press("Enter");
  const card = page.locator("main section[role=region]:not([data-leaving])");
  const outside = page.getByRole("button", { name: "Show leads outside calling hours" });
  await expect(card.or(outside).first()).toBeVisible();
  if (await outside.isVisible()) await outside.click();
  await expect(card.locator("h2")).toContainText(`Queue Board Lead ${run}`);
  await page.keyboard.press("Digit5");
  await expect(page.getByRole("switch", { name: /Open a deal/ })).toHaveAttribute("aria-checked", "true");
  await page.keyboard.press("Enter");
  await expect.poll(() => dealsOn(lead)).toBe("1");
  const deal = sql(`select id from public.deals where company_id = '${lead}'`);
  // Back on the board (the dock): the new deal is there at once, not after the cache's 30 s.
  await dock.getByRole("link", { name: "Pipeline", exact: true }).click();
  await expect(page.getByRole("region", { name: "Pipeline board" })).toBeVisible();
  await expect(page.locator(`[data-deal-card="${deal}"]`)).toBeVisible();
  expect(errors).toEqual([]);
  await context.close();
});
