import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { appReady, countryInHours, createUser, fullSession, setRole, settled, signedInPage, sql } from "./helpers";

// The work queue (Day 4c, design 5.4, 7.4 and 8.5): every outcome key (AZERTY digits too), Skip and Undo (the lead comes
// back), the follow-up chips and Enter, a meeting needs a time, the outside-hours state and its escape, Do not contact
// never served, typing a note never fires keys, a lost connection saves the outcome once, closing the tab lets the
// claims go, a rep sees only their own leads, and the lead page says who is on a lead. Calling hours follow the real
// clock (the database's now()), so the leads are put in a country that is in hours now (countryInHours); when none is
// (weekends), the tests use "Show leads outside calling hours". Outcomes are checked in the database.
test.describe.configure({ mode: "serial" });

const password = "Work-Queue-Pass-42!";
const run = Date.now();
const adminEmail = `queue-admin-${run}@example.test`;
const repEmail = `queue-rep-${run}@example.test`;
let adminState: Awaited<ReturnType<BrowserContext["storageState"]>>;
let repState: Awaited<ReturnType<BrowserContext["storageState"]>>;
const open = countryInHours(true, 30);
const country = open ?? "FR";

const userId = (email: string) => sql(`select id from auth.users where email = '${email}'`);
const baseURL = () => test.info().project.use.baseURL ?? "http://localhost:3100";

/** Takes every earlier lead of these people out of the queue (no rank), so each test sees only its own leads. */
function fresh(...emails: string[]) {
  for (const e of emails) sql(`update public.companies set lead_status = 'disqualified' where owner_id = '${userId(e)}'`);
  for (const e of emails) sql(`delete from private.queue_claims where user_id = '${userId(e)}'`);
}

/** Made-up leads for `email` in `where` (fixed test literals), oldest first so they come in this order. */
function makeLeads(email: string, names: string[], o: { status?: string; country?: string } = {}) {
  return names.map((name, i) =>
    sql(`insert into public.companies (org_id, name, owner_id, lead_status, phone, city, country, created_at)
         select org_id, '${name}', id, '${o.status ?? "cold"}', '+33 6 00 00 00 ${String(i).padStart(2, "0")}', 'Testville', '${o.country ?? country}',
                now() - interval '${names.length - i} minutes'
         from public.profiles where id = '${userId(email)}' returning id`),
  );
}
const leadId = (email: string, name: string) => sql(`select id from public.companies where owner_id = '${userId(email)}' and name = '${name}'`);
const outcomes = (id: string) => sql(`select coalesce(string_agg(outcome, ',' order by created_at), '') from public.activities where company_id = '${id}'`);
const claims = (email: string) => sql(`select count(*) from private.queue_claims where user_id = '${userId(email)}' and expires_at > now()`);

const card = (page: Page) => page.locator("main section[role=region]:not([data-leaving])");
const heading = (page: Page) => card(page).locator("h2");
const toast = (page: Page) => page.getByRole("status").filter({ hasText: /\S/ }).last();

async function openQueue(page: Page) {
  await settled(page);
  await page.goto("/leads/queue");
  await expect(page.locator("main h1")).toContainText("Work queue");
  await appReady(page);
}

/** Start (↩ from the keyboard), past the outside-hours state when every zone is closed now. */
async function start(page: Page) {
  await page.keyboard.press("Enter");
  if (!open) {
    await expect(page.getByRole("button", { name: "Show leads outside calling hours" })).toBeVisible();
    await page.getByRole("button", { name: "Show leads outside calling hours" }).click();
  }
  await expect(card(page)).toHaveCount(1);
}

/** The lead on screen (once the advance has finished: one card). */
async function current(page: Page) {
  await expect(card(page)).toHaveCount(1);
  return ((await heading(page).textContent()) ?? "").trim();
}

test.beforeAll(async ({ browser }) => {
  test.setTimeout(240_000);
  const adminSecret = await createUser(adminEmail, password, true);
  const repSecret = await createUser(repEmail, password, true);
  setRole(adminEmail, "admin");
  setRole(repEmail, "rep");
  sql(`update public.profiles set first_name = 'Inès', last_name = 'Garnier', timezone = 'Europe/Paris' where id = '${userId(adminEmail)}'`);
  sql(`update public.profiles set first_name = 'Malo', last_name = 'Perrin', timezone = 'Europe/Paris' where id = '${userId(repEmail)}'`);
  adminState = await fullSession(browser, adminEmail, password, adminSecret);
  repState = await fullSession(browser, repEmail, password, repSecret);
});

test("keys_each_outcome and keyboard_only: every key logs its outcome, the focus moves to the next lead", async ({ browser }) => {
  test.setTimeout(240_000);
  fresh(adminEmail);
  const names = ["Queue Alpha", "Queue Bravo", "Queue Charlie", "Queue Delta", "Queue Echo", "Queue Foxtrot", "Queue Golf", "Queue Hotel"];
  makeLeads(adminEmail, names);
  const { context, page, errors } = await signedInPage(browser, adminState, { baseURL: baseURL() });
  await openQueue(page);
  await expect(page.getByText(/to call now/)).toBeVisible();
  await start(page);
  const keys: [string, string, boolean][] = [
    ["Digit1", "no_answer", false],
    ["Digit2", "voicemail", false],
    ["Digit3", "wrong_number", false],
    ["Digit4", "not_interested", false],
    ["Digit5", "interested", true],
    ["Digit6", "meeting_booked", true],
    ["Numpad7", "do_not_contact", true],
    ["Digit0", "connected", true],
  ];
  const logged: Record<string, string> = {};
  for (const [key, outcome, confirm] of keys) {
    const name = await current(page);
    await page.keyboard.press(key);
    if (confirm) {
      await expect(page.getByRole("button", { name: /^(Confirm|Mark as do not contact)$/ })).toBeVisible();
      await expect(heading(page)).toHaveText(name); // nothing logged before ↩
      await page.keyboard.press("Enter");
    }
    logged[name] = outcome;
    if (Object.keys(logged).length < names.length) {
      await expect(heading(page)).not.toHaveText(name);
      // Keyboard first: the new lead's heading has the focus (after the advance, never the page).
      await expect(heading(page)).toBeFocused();
    }
  }
  await expect(page.getByRole("heading", { name: "Everyone due has been called." })).toBeVisible();
  for (const [name, outcome] of Object.entries(logged)) {
    await expect.poll(() => outcomes(leadId(adminEmail, name))).toBe(outcome);
  }
  // Interested made the follow-up task, Book meeting the meeting; no claim is left behind.
  const interested = Object.keys(logged).find((n) => logged[n] === "interested") as string;
  expect(sql(`select kind from public.tasks where company_id = '${leadId(adminEmail, interested)}'`)).toBe("call");
  const meeting = Object.keys(logged).find((n) => logged[n] === "meeting_booked") as string;
  expect(sql(`select kind || ' ' || (due_at is not null) from public.tasks where company_id = '${leadId(adminEmail, meeting)}'`)).toBe("meeting true");
  await expect.poll(() => claims(adminEmail)).toBe("0");
  expect(errors).toEqual([]);
  await context.close();
});

test("azerty_digits: the key that types & is Digit1 (No answer)", async ({ browser }) => {
  fresh(adminEmail);
  makeLeads(adminEmail, ["Azerty Un", "Azerty Deux"]);
  const { context, page, errors } = await signedInPage(browser, adminState, { baseURL: baseURL() });
  await openQueue(page);
  await start(page);
  const name = await current(page);
  await page.evaluate(() => document.body.dispatchEvent(new KeyboardEvent("keydown", { code: "Digit1", key: "&", bubbles: true })));
  await expect(heading(page)).not.toHaveText(name);
  await expect.poll(() => outcomes(leadId(adminEmail, name))).toBe("no_answer");
  expect(errors).toEqual([]);
  await context.close();
});

test("skip_and_undo, undo_reclaims_lead: Skip writes nothing; U takes the outcome back and the lead returns", async ({ browser }) => {
  fresh(adminEmail);
  makeLeads(adminEmail, ["Retour Un", "Retour Deux", "Retour Trois"]);
  const { context, page, errors } = await signedInPage(browser, adminState, { baseURL: baseURL() });
  await openQueue(page);
  await start(page);
  const skipped = await current(page);
  await page.keyboard.press("s");
  await expect(heading(page)).not.toHaveText(skipped);
  await expect.poll(() => sql(`select count(*) from private.queue_claims where company_id = '${leadId(adminEmail, skipped)}'`)).toBe("0");
  expect(outcomes(leadId(adminEmail, skipped))).toBe("");
  const called = await current(page);
  await page.keyboard.press("1");
  await expect(heading(page)).not.toHaveText(called);
  await expect(toast(page)).toContainText("Logged: No answer");
  await expect.poll(() => outcomes(leadId(adminEmail, called))).toBe("no_answer");
  await page.keyboard.press("u");
  await expect(heading(page)).toHaveText(called);
  await expect(toast(page)).toContainText("Undone");
  await expect.poll(() => outcomes(leadId(adminEmail, called))).toBe("");
  expect(sql(`select count(*) from private.queue_claims where company_id = '${leadId(adminEmail, called)}' and user_id = '${userId(adminEmail)}'`)).toBe("1");
  expect(errors).toEqual([]);
  await context.close();
});

test("interested_chips_enter and meeting_requires_time", async ({ browser }) => {
  fresh(adminEmail);
  makeLeads(adminEmail, ["Suivi Un", "Suivi Deux", "Suivi Trois"]);
  const { context, page, errors } = await signedInPage(browser, adminState, { baseURL: baseURL() });
  await openQueue(page);
  await start(page);
  const first = await current(page);
  await page.keyboard.press("5");
  const followUp = page.getByRole("group", { name: "Follow-up" });
  await expect(followUp.locator("button[aria-pressed=true]")).toHaveCount(1); // the default (next working day) is chosen
  await followUp.getByRole("button", { name: "In 2 days" }).click();
  await page.keyboard.press("Enter");
  await expect(heading(page)).not.toHaveText(first);
  const in2 = sql(`select (now() at time zone 'Europe/Paris')::date + 2`);
  await expect.poll(() => sql(`select due_date from public.tasks where company_id = '${leadId(adminEmail, first)}'`)).toBe(in2);
  expect(outcomes(leadId(adminEmail, first))).toBe("interested");

  const second = await current(page);
  await page.keyboard.press("6");
  const time = page.getByLabel("Time", { exact: true });
  await expect(time).toHaveValue("10:00");
  await time.fill("");
  await time.press("Enter");
  await expect(page.getByText("A meeting needs a date and a time.")).toBeVisible();
  await expect(heading(page)).toHaveText(second);
  expect(outcomes(leadId(adminEmail, second))).toBe("");
  await time.fill("11:30");
  await page.getByRole("button", { name: "Confirm" }).click();
  await expect(heading(page)).not.toHaveText(second);
  await expect.poll(() => outcomes(leadId(adminEmail, second))).toBe("meeting_booked");
  // Esc closes a follow-up without logging.
  const third = await current(page);
  await page.keyboard.press("0");
  await expect(page.getByRole("button", { name: "Confirm" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: "Confirm" })).toHaveCount(0);
  await expect(heading(page)).toHaveText(third);
  expect(outcomes(leadId(adminEmail, third))).toBe("");
  expect(errors).toEqual([]);
  await context.close();
});

test("outside_hours_state_then_show_outside, dnc_never_served", async ({ browser }) => {
  fresh(adminEmail);
  const closed = countryInHours(false, 30);
  test.skip(!closed, "no closed calling zone right now");
  makeLeads(adminEmail, ["Nuit Un"], { country: closed as string });
  makeLeads(adminEmail, ["Jamais Appeler"], { country: closed as string, status: "do_not_contact" });
  const { context, page, errors } = await signedInPage(browser, adminState, { baseURL: baseURL() });
  await openQueue(page);
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { name: "Nobody to call right now." })).toBeVisible();
  await expect(page.getByText(/opens .*their time \(in /)).toBeVisible();
  await page.getByRole("button", { name: "Show leads outside calling hours" }).click();
  await expect(heading(page)).toHaveText("Nuit Un");
  await expect(card(page)).toContainText("Outside calling hours");
  await page.keyboard.press("1");
  await expect(page.getByRole("heading", { name: "Everyone due has been called." })).toBeVisible();
  // The Do not contact lead was never offered nor claimed.
  expect(outcomes(leadId(adminEmail, "Jamais Appeler"))).toBe("");
  expect(sql(`select count(*) from private.queue_claims where company_id = '${leadId(adminEmail, "Jamais Appeler")}'`)).toBe("0");
  expect(errors).toEqual([]);
  await context.close();
});

test("note_typing_does_not_trigger_keys: N, typing digits and letters, Esc, then 2 logs with the note", async ({ browser }) => {
  fresh(adminEmail);
  makeLeads(adminEmail, ["Note Un", "Note Deux"]);
  const { context, page, errors } = await signedInPage(browser, adminState, { baseURL: baseURL() });
  await openQueue(page);
  await start(page);
  const name = await current(page);
  await page.keyboard.press("n");
  const note = page.getByRole("textbox", { name: "Note" });
  await expect(note).toBeFocused();
  await page.keyboard.type("1 2 s u c rappeler mardi");
  await expect(heading(page)).toHaveText(name);
  expect(outcomes(leadId(adminEmail, name))).toBe("");
  await page.keyboard.press("Escape");
  await expect(heading(page)).toBeFocused();
  await page.keyboard.press("2");
  await expect(heading(page)).not.toHaveText(name);
  await expect.poll(() => outcomes(leadId(adminEmail, name))).toBe("voicemail");
  expect(sql(`select body from public.activities where company_id = '${leadId(adminEmail, name)}'`)).toBe("1 2 s u c rappeler mardi");
  // The next lead starts with an empty note.
  await expect(note).toHaveValue("");
  expect(errors).toEqual([]);
  await context.close();
});

test("offline_outcome_retried_once: saved once after lost answers; when every try fails, Retry saves it once", async ({ browser }) => {
  fresh(adminEmail);
  makeLeads(adminEmail, ["Réseau Un", "Réseau Deux", "Réseau Trois"]);
  const { context, page } = await signedInPage(browser, adminState, { baseURL: baseURL() });
  await openQueue(page);
  await start(page);
  // The next two saves are cut off (as if the connection dropped), then the network comes back.
  let cut = 2;
  await page.route("**/leads/queue", async (route) => {
    if (route.request().method() === "POST" && route.request().headers()["next-action"] && cut > 0) {
      cut -= 1;
      await route.abort();
    } else {
      await route.continue();
    }
  });
  const first = await current(page);
  await page.keyboard.press("1");
  await expect(heading(page)).not.toHaveText(first);
  await expect.poll(() => outcomes(leadId(adminEmail, first)), { timeout: 15_000 }).toBe("no_answer");
  await expect(toast(page)).toContainText("Logged: No answer");
  // Now every try fails: the rail says so, the outcome is kept; Retry saves it, once.
  cut = 100;
  const second = await current(page);
  await page.keyboard.press("2");
  await expect(page.getByText("1 outcome not saved")).toBeVisible({ timeout: 15_000 });
  expect(outcomes(leadId(adminEmail, second))).toBe("");
  cut = 0;
  await page.getByRole("button", { name: "Retry" }).click();
  await expect(page.getByText("1 outcome not saved")).toHaveCount(0);
  await expect.poll(() => outcomes(leadId(adminEmail, second))).toBe("voicemail");
  await page.getByRole("button", { name: "Done for now" }).click();
  await context.close();
});

test("pagehide_releases_claims: closing the tab lets the claims go", async ({ browser }) => {
  fresh(adminEmail);
  makeLeads(adminEmail, ["Fermer Un", "Fermer Deux", "Fermer Trois"]);
  const { context, page } = await signedInPage(browser, adminState, { baseURL: baseURL() });
  await openQueue(page);
  await start(page);
  await expect.poll(() => claims(adminEmail)).toBe("2"); // the lead on screen and the one in reserve
  await page.close({ runBeforeUnload: true });
  await expect.poll(() => claims(adminEmail), { timeout: 10_000 }).toBe("0");
  await context.close();
});

test("rep_sees_only_mine, and the lead page says who is on a lead", async ({ browser }) => {
  fresh(adminEmail, repEmail);
  const [repLead] = makeLeads(repEmail, ["Malo Prospect"]);
  makeLeads(adminEmail, ["Inès Prospect", "Inès Second"]);
  const rep = await signedInPage(browser, repState, { baseURL: baseURL() });
  await openQueue(rep.page);
  await expect(rep.page.getByRole("group", { name: "Whose leads" })).toHaveCount(0);
  const refused = await rep.context.request.get("/api/queue/summary?scope=team");
  expect(refused.status()).toBe(403);
  await start(rep.page);
  await expect(heading(rep.page)).toHaveText("Malo Prospect");
  // The admin works their own queue: the rep, on the admin's lead page, sees who is on it and until when.
  const admin = await signedInPage(browser, adminState, { baseURL: baseURL() });
  await openQueue(admin.page);
  await start(admin.page);
  const worked = await current(admin.page);
  await settled(rep.page);
  await rep.page.goto(`/leads/${leadId(adminEmail, worked)}`);
  await expect(rep.page.locator("main h1")).toHaveText(worked);
  await expect(rep.page.getByText(/^Inès is on this lead in the queue \(until \d\d:\d\d\)$/)).toBeVisible();
  // The admin's own lead page never names the admin.
  await settled(admin.page);
  await admin.page.goto(`/leads/${repLead}`);
  await expect(admin.page.locator("main h1")).toHaveText("Malo Prospect");
  await expect(admin.page.getByText(/^Inès is on this lead/)).toHaveCount(0);
  expect(rep.errors).toEqual([]);
  expect(admin.errors).toEqual([]);
  await rep.context.close();
  await admin.context.close();
});
