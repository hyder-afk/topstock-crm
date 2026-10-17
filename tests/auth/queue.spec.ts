import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { appReady, countryInHours, createUser, fullSession, setRole, settled, signedInPage, sql, youngSession } from "./helpers";

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
const mateEmail = `queue-mate-${run}@example.test`;
let adminState: Awaited<ReturnType<BrowserContext["storageState"]>>;
let adminSecret = "";
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
/** Who holds a live claim on this lead (a user id, or nothing). */
const holder = (lead: string) => sql(`select coalesce((select user_id::text from private.queue_claims where company_id = '${lead}' and expires_at > now()), '')`);
/** A teammate takes the lead in the queue (written as the superuser, past the claim guard: the teammate's own claim). */
const takeClaim = (email: string, lead: string) =>
  sql(`set session_replication_role = replica;
       delete from private.queue_claims where company_id = '${lead}';
       insert into private.queue_claims (company_id, org_id, user_id, expires_at)
       select '${lead}', org_id, id, now() + interval '10 minutes' from public.profiles where id = '${userId(email)}'`);

const card = (page: Page) => page.locator("main section[role=region]:not([data-leaving])");
const heading = (page: Page) => card(page).locator("h2");
// The toast as drawn (a "Logged" toast is shown but not read out: the page's own live message says it once).
const toast = (page: Page) => page.locator("[data-toast]").last();

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
  adminSecret = await createUser(adminEmail, password, true);
  const repSecret = await createUser(repEmail, password, true);
  await createUser(mateEmail, password, true);
  setRole(mateEmail, "admin");
  setRole(adminEmail, "admin");
  setRole(repEmail, "rep");
  sql(`update public.profiles set first_name = 'Inès', last_name = 'Garnier', timezone = 'Europe/Paris' where id = '${userId(adminEmail)}'`);
  sql(`update public.profiles set first_name = 'Malo', last_name = 'Perrin', timezone = 'Europe/Paris' where id = '${userId(repEmail)}'`);
  sql(`update public.profiles set first_name = 'Henri', last_name = 'Mate', timezone = 'Europe/Paris' where id = '${userId(mateEmail)}'`);
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
  await page.route("**/api/queue/outcome", async (route) => {
    if (route.request().method() === "POST" && cut > 0) {
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

test("call_keeps_claims: Call and the C key follow the tel: link and the claims stay (Chromium fires beforeunload)", async ({ browser, browserName }) => {
  // Chromium fires beforeunload when a tel: link is followed, although the page stays. WebKit has no tel: handler in a
  // test browser and its tab-close path is covered by pagehide_releases_claims.
  test.skip(browserName !== "chromium", "beforeunload on a tel: link is Chromium's behaviour");
  fresh(adminEmail);
  makeLeads(adminEmail, ["Appel Un", "Appel Deux", "Appel Trois"]);
  // A context without the test guard that stops tel: navigation: the link is really followed, as on a rep's laptop.
  const context = await browser.newContext({ storageState: adminState, baseURL: baseURL(), viewport: { width: 1440, height: 900 }, timezoneId: "Europe/Paris" });
  const page = await context.newPage();
  await openQueue(page);
  await start(page);
  await expect.poll(() => claims(adminEmail)).toBe("2");
  await page.evaluate(() => {
    (window as unknown as { unloads: number }).unloads = 0;
    window.addEventListener("beforeunload", () => (window as unknown as { unloads: number }).unloads++);
  });
  await card(page).locator("a[href^='tel:']").first().click();
  await page.keyboard.press("KeyC");
  // The browser did treat both as leaving (so the test reproduces the bug), and the page is still the queue.
  await expect.poll(() => page.evaluate(() => (window as unknown as { unloads: number }).unloads)).toBe(2);
  await page.waitForTimeout(3_000);
  await expect(card(page)).toHaveCount(1);
  expect(claims(adminEmail)).toBe("2");
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

test("claims_end_cards_leave: 10 minutes without a key or a click, the cards go and the start screen says so", async ({ browser }) => {
  test.setTimeout(180_000);
  fresh(adminEmail, mateEmail);
  makeLeads(adminEmail, ["Held Alpha", "Held Bravo", "Held Charlie", "Held Delta"]);
  // The page's clock jumps 10.5 minutes ahead below, and access tokens last 15 minutes (jwt_expiry 900) with auth-js
  // renewing 90 s early: a session saved minutes ago would be expired after the jump and the queue's calls would fail,
  // so this test signs in again unless the saved session is young enough (helpers.ts youngSession).
  const session = await youngSession(browser, adminState, { email: adminEmail, password, secret: adminSecret }, 630_000);
  const { context, page, errors } = await signedInPage(browser, session, { baseURL: baseURL() });
  // The page's own clock, so 10 minutes can pass at once (it flows normally otherwise).
  await page.clock.install();
  await openQueue(page);
  await start(page);
  const first = await current(page);
  const firstId = leadId(adminEmail, first);
  // Away for 10.5 minutes: by then the database has ended the claims (no renewal without a key or a click), and a
  // teammate takes the lead that was on screen.
  sql(`update private.queue_claims set expires_at = now() - interval '1 second' where user_id = '${userId(adminEmail)}'`);
  takeClaim(mateEmail, firstId);
  await page.clock.fastForward("10:30");
  // The card is gone (no lead on two screens); the start screen says why, with a link to log a call made meanwhile.
  await expect(card(page)).toHaveCount(0);
  await expect(page.getByText("Your leads went back to the team")).toBeVisible();
  await expect(page.getByRole("link", { name: `Log your call to ${first}` })).toHaveAttribute("href", `/leads/${firstId}`);
  // Keyboard first: Start has the focus (never the page); an outcome key does nothing here.
  await expect(page.getByRole("button", { name: "Start" })).toBeFocused();
  await page.keyboard.press("Digit1");
  await page.waitForTimeout(500);
  expect(outcomes(firstId)).toBe("");
  // Start again (↩ on the focused Start): the teammate's lead is not served; the new card is held by this person.
  await start(page);
  const next = await current(page);
  expect(next).not.toBe(first);
  expect(holder(leadId(adminEmail, next))).toBe(userId(adminEmail));
  expect(holder(firstId)).toBe(userId(mateEmail));
  await expect(page.getByText("Your leads went back to the team")).toHaveCount(0);
  expect(errors).toEqual([]);
  await settled(page);
  await context.close();
});

test("lost_claim_quiet_swap: a reserve card a teammate holds now leaves the screen at once, with a toast", async ({ browser }) => {
  test.setTimeout(180_000);
  fresh(adminEmail, mateEmail);
  makeLeads(adminEmail, ["Swap Alpha", "Swap Bravo", "Swap Charlie", "Swap Delta"]);
  const { context, page, errors } = await signedInPage(browser, adminState, { baseURL: baseURL() });
  await openQueue(page);
  await start(page);
  const first = await current(page);
  // The reserve card (the other lead this person holds) goes to a teammate: its claim ended and Henri took it.
  await expect.poll(() => claims(adminEmail)).toBe("2");
  const reserve = sql(`select c.name from private.queue_claims q join public.companies c on c.id = q.company_id
                        where q.user_id = '${userId(adminEmail)}' and c.name <> '${first}'`);
  takeClaim(mateEmail, leadId(adminEmail, reserve));
  await page.keyboard.press("Digit1");
  // The save's answer says the database no longer holds the reserve for this person: it leaves, the next card shows
  // and has the focus.
  await expect(page.getByText("A teammate is on that one now. Here’s the next.")).toBeVisible();
  await expect(heading(page)).not.toHaveText(reserve);
  await expect(heading(page)).not.toHaveText(first);
  await expect(heading(page)).toBeFocused();
  const next = await current(page);
  expect(holder(leadId(adminEmail, next))).toBe(userId(adminEmail));
  await expect.poll(() => outcomes(leadId(adminEmail, first))).toBe("no_answer");
  expect(outcomes(leadId(adminEmail, reserve))).toBe("");
  expect(holder(leadId(adminEmail, reserve))).toBe(userId(mateEmail));
  expect(errors).toEqual([]);
  await settled(page);
  await context.close();
});

test("focus_never_drops_to_body: after Start, Done for now, the empty state and Back to the start", async ({ browser }) => {
  test.setTimeout(180_000);
  fresh(adminEmail);
  makeLeads(adminEmail, ["Focus Alpha", "Focus Bravo"]);
  const { context, page, errors } = await signedInPage(browser, adminState, { baseURL: baseURL() });
  await openQueue(page);
  const onBody = () => page.evaluate(() => !document.activeElement || document.activeElement === document.body);
  // Start with the pointer: the button goes, the first card's heading takes the focus.
  await page.getByRole("button", { name: "Start" }).click();
  expect(await onBody()).toBe(false);
  if (!open) await page.getByRole("button", { name: "Show leads outside calling hours" }).click();
  await expect(heading(page)).toBeFocused();
  // Done for now: back on the start screen, Start has the focus.
  await page.getByRole("button", { name: "Done for now" }).click();
  await expect(page.getByRole("button", { name: "Start" })).toBeFocused();
  // Nothing left to call: the empty state’s heading has the focus; Back to the start gives it to Start.
  fresh(adminEmail);
  await page.getByRole("button", { name: "Start" }).click();
  await expect(page.getByRole("button", { name: "Back to the start" })).toBeVisible();
  await expect(page.locator("main h2:focus")).toHaveCount(1);
  expect(await onBody()).toBe(false);
  await page.getByRole("button", { name: "Back to the start" }).click();
  await expect(page.getByRole("button", { name: "Start" })).toBeFocused();
  expect(errors).toEqual([]);
  await settled(page);
  await context.close();
});

/** Holds this page's requests to `match` (POST only) for `ms` before sending them on: a slow connection. */
async function slow(page: Page, match: (url: URL) => boolean, ms: number, also: (h: Record<string, string>) => boolean = () => true) {
  await page.route(
    (url) => match(url),
    async (route) => {
      if (route.request().method() === "POST" && also(route.request().headers())) await new Promise((r) => setTimeout(r, ms));
      await route.continue().catch(() => {});
    },
  );
}

test("stop_while_in_flight: Done for now while a save or Start is on its way leaves no hidden claim and no jump", async ({ browser }) => {
  test.setTimeout(180_000);
  fresh(adminEmail);
  makeLeads(adminEmail, ["Stop Alpha", "Stop Bravo", "Stop Charlie", "Stop Delta"]);
  const { context, page, errors } = await signedInPage(browser, adminState, { baseURL: baseURL() });
  await openQueue(page);
  await start(page);
  // 1. A save on its way (it also claims the next reserve card) when Done for now is pressed.
  await slow(page, (u) => u.pathname === "/api/queue/outcome", 1500);
  const first = await current(page);
  await page.keyboard.press("Digit1");
  await page.getByRole("button", { name: "Done for now" }).click();
  await expect.poll(() => outcomes(leadId(adminEmail, first)), { timeout: 10_000 }).toBe("no_answer");
  // The lead that answer claimed is let go at once (before: held for 10 minutes by nobody on screen).
  await expect.poll(() => claims(adminEmail), { timeout: 10_000 }).toBe("0");
  await expect(page.getByRole("button", { name: "Start" })).toBeVisible();
  await expect(card(page)).toHaveCount(0);
  // 2. The last lead: the answer finds nothing more, and the start screen stays (before: "Everyone due has been called").
  fresh(adminEmail);
  makeLeads(adminEmail, ["Stop Last"]);
  await page.getByRole("button", { name: "Start" }).click();
  if (!open) await page.getByRole("button", { name: "Show leads outside calling hours" }).click();
  await expect(heading(page)).toHaveText("Stop Last");
  await page.keyboard.press("Digit1");
  await page.getByRole("button", { name: "Done for now" }).click();
  await expect.poll(() => outcomes(leadId(adminEmail, "Stop Last")), { timeout: 10_000 }).toBe("no_answer");
  await page.waitForTimeout(500);
  await expect(page.getByRole("button", { name: "Start" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Everyone due has been called." })).toHaveCount(0);
  // 3. Start's own claim on its way when Done for now is pressed: its cards are let go, nothing shows.
  await page.unrouteAll({ behavior: "wait" });
  fresh(adminEmail);
  makeLeads(adminEmail, ["Stop Echo", "Stop Foxtrot", "Stop Golf"]);
  await slow(page, (u) => u.pathname === "/leads/queue", 1500, (h) => !!h["next-action"]);
  await page.getByRole("button", { name: "Start" }).click();
  if (!open) {
    // Every zone is closed: Start lands on the outside-hours state first; take the escape, then stop at once.
    await page.getByRole("button", { name: "Show leads outside calling hours" }).click();
  }
  await page.getByRole("button", { name: "Done for now" }).click();
  await page.waitForTimeout(2500);
  await expect.poll(() => claims(adminEmail), { timeout: 10_000 }).toBe("0");
  await expect(page.getByRole("button", { name: "Start" })).toBeVisible();
  await expect(card(page)).toHaveCount(0);
  expect(errors).toEqual([]);
  await page.unrouteAll({ behavior: "ignoreErrors" });
  await settled(page);
  await context.close();
});

test("restart_while_in_flight: Done for now then Start at once while a save is on its way: the lead on screen stays held", async ({ browser }) => {
  test.setTimeout(180_000);
  fresh(adminEmail);
  makeLeads(adminEmail, ["Restart Alpha", "Restart Bravo", "Restart Charlie", "Restart Delta", "Restart Echo"]);
  const { context, page, errors } = await signedInPage(browser, adminState, { baseURL: baseURL() });
  await openQueue(page);
  await start(page);
  // The save (which also claims the next card) is slow; Done for now and Start again are pressed before it lands. Its
  // answer belongs to the old session; the new session's Start may get that same lead back as its card.
  await slow(page, (u) => u.pathname === "/api/queue/outcome", 1500);
  const first = await current(page);
  await page.keyboard.press("Digit1");
  await page.getByRole("button", { name: "Done for now" }).click();
  await page.getByRole("button", { name: "Start" }).click();
  if (!open) await page.getByRole("button", { name: "Show leads outside calling hours" }).click();
  await expect.poll(() => outcomes(leadId(adminEmail, first)), { timeout: 10_000 }).toBe("no_answer");
  // Every job on the chain has run (the old answer's release included).
  await page.waitForTimeout(4000);
  const shown = await current(page);
  // Before: the old answer's release ran after the new Start and let go of the lead now on screen (held by nobody).
  expect(holder(leadId(adminEmail, shown))).toBe(userId(adminEmail));
  expect(errors).toEqual([]);
  await page.unrouteAll({ behavior: "ignoreErrors" });
  await settled(page);
  await context.close();
});

test("undo_on_start_screen: U on the start screen right after Done for now takes back the outcome its toast offers", async ({ browser }) => {
  test.setTimeout(180_000);
  fresh(adminEmail);
  makeLeads(adminEmail, ["Back Alpha", "Back Bravo", "Back Charlie"]);
  const { context, page, errors } = await signedInPage(browser, adminState, { baseURL: baseURL() });
  await openQueue(page);
  await start(page);
  const first = await current(page);
  await page.keyboard.press("Digit1");
  await expect.poll(() => outcomes(leadId(adminEmail, first))).toBe("no_answer");
  await expect(toast(page)).toContainText("Undo (U)");
  await page.getByRole("button", { name: "Done for now" }).click();
  await expect(page.getByRole("button", { name: "Start" })).toBeVisible();
  await expect(toast(page)).toContainText("Undo (U)");
  // Before: the start screen returned before reading U, so the outcome stayed while the toast offered Undo (U).
  await page.keyboard.press("u");
  await expect(heading(page)).toHaveText(first, { timeout: 10_000 });
  await expect(heading(page)).toBeFocused();
  await expect.poll(() => outcomes(leadId(adminEmail, first))).toBe("");
  expect(holder(leadId(adminEmail, first))).toBe(userId(adminEmail));
  expect(errors).toEqual([]);
  await settled(page);
  await context.close();
});

test("undo_latest_outcome: U right after a key takes back that outcome (not the one before), and its lead's heading has the focus", async ({ browser }) => {
  test.setTimeout(180_000);
  fresh(adminEmail);
  makeLeads(adminEmail, ["Latest Alpha", "Latest Bravo", "Latest Charlie", "Latest Delta"]);
  const { context, page, errors } = await signedInPage(browser, adminState, { baseURL: baseURL() });
  await openQueue(page);
  await start(page);
  const first = await current(page);
  await page.keyboard.press("Digit1");
  await expect.poll(() => outcomes(leadId(adminEmail, first))).toBe("no_answer");
  await expect(toast(page)).toContainText("Logged: No answer");
  // The next save is slow; U pressed before it lands waits for it and takes back that one.
  await slow(page, (u) => u.pathname === "/api/queue/outcome", 1500);
  const second = await current(page);
  await page.keyboard.press("Digit2");
  await expect(heading(page)).not.toHaveText(second);
  await page.keyboard.press("u");
  await expect(heading(page)).toHaveText(second, { timeout: 10_000 });
  await expect(heading(page)).toBeFocused();
  await expect.poll(() => outcomes(leadId(adminEmail, second))).toBe("");
  expect(outcomes(leadId(adminEmail, first))).toBe("no_answer");
  expect(errors).toEqual([]);
  await page.unrouteAll({ behavior: "ignoreErrors" });
  await settled(page);
  await context.close();
});

test("undo_on_empty_screen and queue_owns_u: U on the empty state brings the lead back; a lead-page entry is never undone from the queue", async ({ browser }) => {
  test.setTimeout(180_000);
  fresh(adminEmail);
  // A lead outside the queue, with a note logged on its page (the lead page's U would take that back).
  const pageLead = sql(`insert into public.companies (org_id, name, owner_id, lead_status, phone, country)
                        select org_id, 'Undo Page Lead', id, 'disqualified', '+33 6 00 00 00 77', 'FR' from public.profiles
                        where id = '${userId(adminEmail)}' returning id`);
  makeLeads(adminEmail, ["Undo Only"]);
  const { context, page, errors } = await signedInPage(browser, adminState, { baseURL: baseURL() });
  await settled(page);
  await page.goto(`/leads/${pageLead}`);
  await appReady(page);
  const composer = page.getByRole("form", { name: "Log activity" });
  await composer.getByRole("textbox", { name: "Note" }).fill("Kept on the lead page");
  await composer.getByRole("button", { name: /^Save to timeline/ }).click();
  await expect.poll(() => sql(`select count(*) from public.activities where company_id = '${pageLead}'`)).toBe("1");
  // G then Q: the queue opens inside the app (its key listener comes after the lead page's).
  await page.locator("main h1").click();
  await page.keyboard.press("g");
  await page.keyboard.press("q");
  await expect(page.locator("main h1")).toContainText("Work queue");
  await page.getByRole("button", { name: "Start" }).click();
  if (!open) await page.getByRole("button", { name: "Show leads outside calling hours" }).click();
  await expect(heading(page)).toHaveText("Undo Only");
  await page.keyboard.press("Digit1");
  // The last lead: the empty state, whose toast offers Undo (U).
  await expect(page.getByRole("heading", { name: "Everyone due has been called." })).toBeVisible();
  await expect.poll(() => outcomes(leadId(adminEmail, "Undo Only"))).toBe("no_answer");
  await expect(toast(page)).toContainText("Undo (U)");
  await page.keyboard.press("u");
  await expect(heading(page)).toHaveText("Undo Only", { timeout: 10_000 });
  await expect(heading(page)).toBeFocused();
  await expect.poll(() => outcomes(leadId(adminEmail, "Undo Only"))).toBe("");
  // The note on the other lead's page is still there.
  expect(sql(`select count(*) from public.activities where company_id = '${pageLead}'`)).toBe("1");
  expect(errors).toEqual([]);
  await settled(page);
  await context.close();
});

test("not_saved_in_every_phase: an outcome that never saved stays visible on the empty state, and Retry saves it", async ({ browser }) => {
  test.setTimeout(180_000);
  fresh(adminEmail);
  makeLeads(adminEmail, ["Unsaved Only"]);
  const { context, page } = await signedInPage(browser, adminState, { baseURL: baseURL() });
  await openQueue(page);
  await start(page);
  let cut = true;
  await page.route("**/api/queue/outcome", async (route) => (cut && route.request().method() === "POST" ? route.abort() : route.continue()));
  await page.keyboard.press("Digit1");
  // Every try fails; nothing is left to call: the empty state shows, and so does the outcome not saved.
  await expect(page.getByRole("heading", { name: "Everyone due has been called." })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText("1 outcome not saved")).toBeVisible({ timeout: 15_000 });
  expect(outcomes(leadId(adminEmail, "Unsaved Only"))).toBe("");
  cut = false;
  await page.getByRole("button", { name: "Retry" }).click();
  await expect(page.getByText("1 outcome not saved")).toHaveCount(0);
  await expect.poll(() => outcomes(leadId(adminEmail, "Unsaved Only"))).toBe("no_answer");
  await page.unrouteAll({ behavior: "ignoreErrors" });
  await settled(page);
  await context.close();
});

test("caches_after_outcome: back on the lead page after a queue outcome, its timeline and tasks show it", async ({ browser }) => {
  test.setTimeout(180_000);
  fresh(adminEmail);
  const [lead] = makeLeads(adminEmail, ["Cache Comptoir"]);
  const { context, page, errors } = await signedInPage(browser, adminState, { baseURL: baseURL() });
  await settled(page);
  await page.goto(`/leads/${lead}`);
  await appReady(page);
  await expect(page.locator("main h1")).toHaveText("Cache Comptoir");
  await page.locator("main h1").click();
  await page.keyboard.press("g");
  await page.keyboard.press("q");
  await expect(page.locator("main h1")).toContainText("Work queue");
  await page.getByRole("button", { name: "Start" }).click();
  if (!open) await page.getByRole("button", { name: "Show leads outside calling hours" }).click();
  await expect(heading(page)).toHaveText("Cache Comptoir");
  await page.keyboard.press("Digit5");
  await page.keyboard.press("Enter");
  await expect.poll(() => outcomes(lead)).toBe("interested");
  // Back inside the app, within the lead page's cache time (30 s): the new task and the entry are there.
  await page.goBack();
  await expect(page.locator("main h1")).toHaveText("Cache Comptoir");
  await expect(page.getByRole("main").getByText("Follow up with Cache Comptoir").first()).toBeVisible({ timeout: 5_000 });
  await expect(page.getByRole("main").getByText("Interested").first()).toBeVisible();
  expect(errors).toEqual([]);
  await settled(page);
  await context.close();
});

test("phone_followup_in_view: at 390 the follow-up and the Do not contact question come into view above the dock", async ({ browser }) => {
  test.setTimeout(180_000);
  fresh(adminEmail);
  makeLeads(adminEmail, ["Phone Alpha", "Phone Bravo", "Phone Charlie"]);
  const { context, page, errors } = await signedInPage(browser, adminState, { width: 390, baseURL: baseURL() });
  await openQueue(page);
  await start(page);
  const clear = (name: string) =>
    expect
      .poll(async () => {
        const b = page.getByRole("button", { name, exact: true });
        const box = await b.boundingBox();
        if (!box) return "no box";
        return page.evaluate(
          ({ x, y, name }) => {
            const el = document.elementFromPoint(x, y)?.closest("button");
            return el && el.textContent?.trim().startsWith(name) && y < window.innerHeight ? "clear" : `covered at ${Math.round(y)}`;
          },
          { x: box.x + box.width / 2, y: box.y + box.height / 2, name },
        );
      })
      .toBe("clear");
  await page.locator('button[data-outcome="interested"]').tap();
  await clear("Confirm");
  expect(await page.evaluate(() => document.activeElement?.getAttribute("role"))).toBe("group");
  await page.getByRole("button", { name: "Cancel" }).tap();
  await expect(page.getByRole("button", { name: "Confirm" })).toHaveCount(0);
  expect(await page.evaluate(() => document.activeElement !== document.body)).toBe(true);
  await page.locator('button[data-outcome="do_not_contact"]').tap();
  await clear("Mark as do not contact");
  expect(errors).toEqual([]);
  await settled(page);
  await context.close();
});
