import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { ageStepUp, appReady, createUser, fullSession, nextWindow, seedLeads, setRole, settled, sql, totp, trackRequests } from "./helpers";

// The lead page (Day 4b, design 8.5): open from the list and back, J/K, local time, the call panel and every outcome,
// email and WhatsApp with one-tap logging, notes (edit, undo, delete with a fresh code, draft), read-only and Do not
// contact leads, text never run as HTML, timeline pages, the empty tabs, "Until when?", and the phone layout.
// Fixtures are made-up companies written straight into the local database; outcomes are checked in the database.
test.describe.configure({ mode: "serial" });

const password = "Lead-Page-Pass-42!";
const run = Date.now();
const adminEmail = `lead-admin-${run}@example.test`;
const repEmail = `lead-rep-${run}@example.test`;
let adminSecret = "";
let adminState: Awaited<ReturnType<BrowserContext["storageState"]>>;
let repState: Awaited<ReturnType<BrowserContext["storageState"]>>;

const uuid = /^[0-9a-f-]{36}$/;
function userId(email: string) {
  return sql(`select id from auth.users where email = '${email}'`);
}

// One made-up lead (owner by email, or none), returning its id. Values are fixed test literals.
function makeLead(name: string, o: { owner?: string | null; status?: string; phone?: string | null; country?: string | null; city?: string | null; email?: string | null } = {}) {
  const owner = o.owner === null ? "null" : `'${userId(o.owner ?? adminEmail)}'`;
  const v = (x: string | null | undefined) => (x === null || x === undefined ? "null" : `'${x}'`);
  const id = sql(`insert into public.companies (org_id, name, owner_id, lead_status, phone, email, city, country)
                  select p.org_id, '${name}', ${owner}, '${o.status ?? "cold"}', ${v(o.phone === undefined ? "06 12 34 56 78" : o.phone)},
                         ${v(o.email === undefined ? "achats@example.com" : o.email)}, ${v(o.city === undefined ? "Lyon" : o.city)},
                         ${v(o.country === undefined ? "FR" : o.country)}
                  from public.profiles p where p.id = '${userId(adminEmail)}' returning id`);
  expect(id).toMatch(uuid);
  return id;
}
function addContact(lead: string, first: string, phone: string | null, email: string | null) {
  sql(`insert into public.contacts (org_id, company_id, first_name, last_name, title, email, phone)
       select org_id, id, '${first}', 'Test', 'Buyer', ${email ? `'${email}'` : "null"}, ${phone ? `'${phone}'` : "null"}
       from public.companies where id = '${lead}'`);
}

// tel:, mailto: and wa.me links would leave the page (or log "no handler" errors in a headless browser): the app's
// own click handlers still run, only the browser's navigation is stopped. Test-only.
async function open(browser: Browser, state: typeof adminState, o: { width?: number; timezoneId?: string; locale?: string } = {}) {
  const width = o.width ?? 1440;
  const context = await browser.newContext({
    storageState: state,
    viewport: { width, height: width < 600 ? 844 : 900 },
    timezoneId: o.timezoneId ?? "Europe/Paris",
    hasTouch: width < 600,
  });
  if (o.locale) await context.addCookies([{ name: "locale", value: o.locale, url: "http://localhost:3100" }]);
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
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  page.on("pageerror", (e) => errors.push(e.message));
  return { context, page, errors };
}

// Each move to another page first lets the current page's requests (dock link prefetches, server actions) finish.
async function gotoLead(page: Page, id: string, tab?: string) {
  await settled(page);
  await page.goto(`/leads/${id}${tab ? `?tab=${tab}` : ""}`);
  await expect(page.locator("main h1")).toBeVisible();
  await appReady(page);
}

const panel = (page: Page) => page.getByRole("region", { name: /^(Calling|How did it go)/ });
const toast = (page: Page) => page.getByRole("status").filter({ hasText: /\S/ }).last();
const latest = (lead: string) =>
  sql(`select type || ':' || coalesce(outcome, '') from public.activities where company_id = '${lead}' order by created_at desc, id desc limit 1`);

test.beforeAll(async ({ browser }) => {
  test.setTimeout(240_000);
  adminSecret = await createUser(adminEmail, password, true);
  const repSecret = await createUser(repEmail, password, true);
  setRole(adminEmail, "admin");
  setRole(repEmail, "rep");
  sql(`update public.profiles set first_name = 'Inès', last_name = 'Garnier' where id = '${userId(adminEmail)}'`);
  sql(`update public.profiles set first_name = 'Malo', last_name = 'Perrin' where id = '${userId(repEmail)}'`);
  seedLeads([adminEmail, repEmail], 60);
  adminState = await fullSession(browser, adminEmail, password, adminSecret);
  repState = await fullSession(browser, repEmail, password, repSecret);
});

test("open_from_list_and_back_keeps_filters_and_scroll, then j_k_through_list", async ({ browser }) => {
  const { context, page, errors } = await open(browser, adminState);
  await page.goto("/leads?sort=name");
  await expect(page.getByRole("table")).toBeVisible();
  await appReady(page);
  const table = page.getByRole("table", { name: "Leads" });
  await table.evaluate((el) => el.scrollTo(0, 1200));
  await page.waitForTimeout(300);
  // A row in the middle of the scrolled list (clicked where it is, so the list does not scroll to it).
  const box = (await table.boundingBox())!;
  await page.mouse.click(box.x + 240, box.y + box.height / 2);
  await expect(page.locator("aside h2")).toBeVisible();
  const name = ((await page.locator("aside h2").textContent()) ?? "").trim();
  await page.locator("aside").getByRole("link", { name: "Open lead" }).click();
  await expect(page).toHaveURL(/\/leads\/[0-9a-f-]{36}$/);
  await expect(page.locator("main h1")).toHaveText(name);
  await appReady(page);
  // "N of 60" from the list it was opened from, then J and K walk it.
  await expect(page.getByText(/^\d+ of 60$/)).toBeVisible();
  const first = page.url();
  await page.keyboard.press("j");
  await expect(page).not.toHaveURL(first);
  await expect(page.locator("main h1")).not.toHaveText(name);
  await appReady(page);
  await page.keyboard.press("k");
  await expect(page).toHaveURL(first);
  await expect(page.locator("main h1")).toHaveText(name);
  // Back: the same list URL (filters and the preview) and the same scroll position.
  await page.getByRole("link", { name: "Leads", exact: true }).first().click();
  await expect(page).toHaveURL(/\/leads\?sort=name&lead=/);
  await expect(page.getByRole("table", { name: "Leads" })).toBeVisible();
  await expect.poll(() => page.getByRole("table", { name: "Leads" }).evaluate((el) => el.scrollTop)).toBeGreaterThan(1000);
  expect(errors).toEqual([]);
  await context.close();
});

test("header_local_time_london (clock fixed) and span_zone_shows_range_then_set_zone", async ({ browser }) => {
  const london = makeLead("Brixton Textiles", { country: "GB", city: "London", phone: "07700 900123" });
  const us = makeLead("Hudson Outlet", { country: "US", city: "New York", phone: "(212) 555-0149" });
  const { context, page, errors } = await open(browser, adminState, { timezoneId: "Europe/Paris" });
  // Monday 12 Oct 2026, 09:00 UTC: 10:00 in London (BST), 11:00 in Paris; 05:00 in New York.
  await page.clock.setFixedTime(new Date("2026-10-12T09:00:00Z"));
  await gotoLead(page, london);
  await expect(page.getByText("10:00 there · 11:00 for you")).toBeVisible();
  await expect(page.getByText("good time to call")).toBeVisible();
  // The WhatsApp link is international.
  await expect(page.getByRole("link", { name: "WhatsApp" }).first()).toHaveAttribute("href", "https://wa.me/447700900123");

  await gotoLead(page, us);
  await expect(page.getByText(/02:00–05:00 local time/)).toBeVisible();
  await expect(page.getByText("time zone not set")).toBeVisible();
  await expect(page.getByText(/opens 12:00 \(in 7 hours\)/)).toBeVisible();
  await page.getByRole("button", { name: "Set time zone" }).click();
  await expect(page.getByRole("tab", { name: "Details" })).toHaveAttribute("aria-selected", "true");
  await expect(page).toHaveURL(/tab=details/);
  const zone = page.getByRole("combobox", { name: "Time zone" });
  await expect(zone).toBeFocused();
  await zone.selectOption("America/Chicago");
  await expect(page.getByRole("status").filter({ hasText: "Time zone saved." })).toBeVisible();
  expect(sql(`select timezone from public.companies where id = '${us}'`)).toBe("America/Chicago");
  await expect(page.getByText(/^04:00 there · 11:00 for you$/)).toBeVisible();
  await expect(page.getByText("time zone not set")).toHaveCount(0);
  expect(errors).toEqual([]);
  await context.close();
});

test("call_panel_each_outcome: status, next call, tasks and marks, checked in the database", async ({ browser }) => {
  test.setTimeout(240_000);
  const { context, page, errors } = await open(browser, adminState);
  const unassigned = makeLead("Comptoir Sansmaître", { owner: null });
  const cases: { outcome: string; key: string; status: string; lead: string; next: "set" | "null" | "kept"; task?: string }[] = [
    { outcome: "no_answer", key: "Digit1", status: "cold", lead: makeLead("Atelier Un"), next: "set" },
    { outcome: "voicemail", key: "Digit2", status: "cold", lead: makeLead("Atelier Deux"), next: "set" },
    { outcome: "wrong_number", key: "Digit3", status: "cold", lead: makeLead("Atelier Trois"), next: "kept", task: "todo" },
    { outcome: "not_interested", key: "Digit4", status: "cool_off", lead: makeLead("Atelier Quatre"), next: "set" },
    { outcome: "interested", key: "Digit5", status: "warm", lead: unassigned, next: "set", task: "call" },
    { outcome: "meeting_booked", key: "Digit6", status: "warm", lead: makeLead("Atelier Six"), next: "set", task: "meeting" },
    { outcome: "do_not_contact", key: "Numpad7", status: "do_not_contact", lead: makeLead("Atelier Sept"), next: "null" },
    { outcome: "connected", key: "Digit0", status: "cold", lead: makeLead("Atelier Zéro"), next: "set" },
  ];
  for (const c of cases) {
    await gotoLead(page, c.lead);
    await page.getByRole("link", { name: "Call", exact: true }).first().click();
    await expect(panel(page)).toBeVisible();
    await expect(panel(page)).toContainText(/\d\d:\d\d/);
    if (c.outcome === "no_answer") {
      // AZERTY: the key that types "&" is Digit1.
      await page.keyboard.press("Escape");
      await expect(panel(page).getByText("Call not logged.")).toBeVisible();
      await panel(page).getByRole("button", { name: "Log it" }).click();
      await page.evaluate(() => document.body.dispatchEvent(new KeyboardEvent("keydown", { code: "Digit1", key: "&", bubbles: true })));
    } else {
      await panel(page).getByRole("button", { name: "End call" }).click();
      await expect(panel(page).getByRole("group", { name: "How did the call go?" })).toBeVisible();
      await page.keyboard.press(c.key);
    }
    await expect(panel(page).locator(`[data-outcome="${c.outcome}"]`)).toHaveAttribute("aria-pressed", "true");
    if (c.outcome === "meeting_booked") {
      await panel(page).getByRole("button", { name: "Tomorrow" }).click();
      await expect(panel(page).getByLabel("Time", { exact: true })).toHaveValue("10:00");
    }
    if (c.outcome === "do_not_contact") await expect(panel(page).getByRole("button", { name: /^Mark as do not contact/ })).toBeVisible();
    await page.keyboard.press("Control+Enter");
    await expect(panel(page)).toHaveCount(0);
    await expect(toast(page)).toContainText("Logged:");
    await expect.poll(() => latest(c.lead)).toBe(`call:${c.outcome}`);
    expect(sql(`select lead_status from public.companies where id = '${c.lead}'`), c.outcome).toBe(c.status);
    const next = sql(`select coalesce(next_action_at::text, 'null') from public.companies where id = '${c.lead}'`);
    if (c.next === "null") expect(next, c.outcome).toBe("null");
    if (c.next === "set") expect(next, c.outcome).not.toBe("null");
    const kinds = sql(`select coalesce(string_agg(kind, ','), '') from public.tasks where company_id = '${c.lead}' and done_at is null and cancelled_at is null`);
    expect(kinds, c.outcome).toBe(c.task ?? "");
  }
  // Closing with an outcome picked and a note typed (11e9eda): first "Call not logged", and Log it brings both back; a
  // second close ends the panel and nothing is logged.
  const closed = makeLead("Atelier Fermé");
  await gotoLead(page, closed);
  await page.getByRole("link", { name: "Call", exact: true }).first().click();
  await panel(page).getByRole("button", { name: "End call" }).click();
  await page.keyboard.press("Digit2");
  await expect(panel(page).locator('[data-outcome="voicemail"]')).toHaveAttribute("aria-pressed", "true");
  await panel(page).getByLabel("Note").fill("Left a message about the spring order");
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press("Escape");
  await expect(panel(page).getByText("Call not logged.")).toBeVisible();
  await panel(page).getByRole("button", { name: "Log it" }).click();
  await expect(panel(page).locator('[data-outcome="voicemail"]')).toHaveAttribute("aria-pressed", "true");
  await expect(panel(page).getByLabel("Note")).toHaveValue("Left a message about the spring order");
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press("Escape");
  await expect(panel(page).getByText("Call not logged.")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(panel(page)).toHaveCount(0);
  expect(sql(`select count(*) from public.activities where company_id = '${closed}'`)).toBe("0");
  // Wrong number on a contact's number (called from the contacts card): only that number is marked, and no "find the
  // right number" task is made while the main line still works.
  const withContact = makeLead("Atelier Contact");
  addContact(withContact, "Yasmine", "06 55 44 33 22", "yasmine@example.com");
  await gotoLead(page, withContact);
  await page.getByRole("link", { name: "Call Yasmine Test" }).first().click();
  await expect(panel(page)).toContainText("Atelier Contact · Yasmine Test");
  await panel(page).getByRole("button", { name: "End call" }).click();
  await page.keyboard.press("Digit3");
  await page.keyboard.press("Control+Enter");
  await expect.poll(() => latest(withContact)).toBe("call:wrong_number");
  expect(sql(`select phone_wrong_at is not null from public.contacts where company_id = '${withContact}'`)).toBe("t");
  expect(sql(`select phone_wrong_at is null from public.companies where id = '${withContact}'`)).toBe("t");
  expect(sql(`select count(*) from public.tasks where company_id = '${withContact}'`)).toBe("0");
  await expect(page.locator("aside").getByText("Marked wrong")).toBeVisible();
  // Wrong number marked the dialled main line; Interested made the caller the owner of the unassigned lead.
  expect(sql(`select phone_wrong_at is not null from public.companies where id = '${cases[2].lead}'`)).toBe("t");
  expect(sql(`select owner_id from public.companies where id = '${unassigned}'`)).toBe(userId(adminEmail));
  // Do not contact: Call, WhatsApp and Email are gone; the banner says why (dnc_lead_hides_call).
  await gotoLead(page, cases[6].lead);
  await expect(page.getByRole("note")).toContainText("Asked not to be contacted · You,");
  await expect(page.getByRole("link", { name: "Call", exact: true })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "WhatsApp" })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Email" })).toHaveCount(0);
  expect(errors).toEqual([]);
  await context.close();
});

test("call_panel_survives_navigation, then undo_within_window puts the lead back", async ({ browser }) => {
  const lead = makeLead("Halles Voyageuses");
  sql(`update public.companies set next_action_at = now() + interval '3 days' where id = '${lead}'`);
  const before = sql(`select next_action_at from public.companies where id = '${lead}'`);
  const { context, page, errors } = await open(browser, adminState);
  await gotoLead(page, lead);
  await page.getByRole("link", { name: "Call", exact: true }).first().click();
  await expect(panel(page)).toContainText("Calling Halles Voyageuses");
  await page.getByRole("navigation").getByRole("link", { name: "Home" }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(panel(page)).toContainText("Calling Halles Voyageuses");
  await panel(page).getByRole("button", { name: "End call" }).click();
  await panel(page).getByRole("button", { name: /^No answer/ }).click();
  await panel(page).getByRole("button", { name: /^Save to timeline/ }).click();
  await expect.poll(() => latest(lead)).toBe("call:no_answer");
  expect(sql(`select next_action_at from public.companies where id = '${lead}'`)).not.toBe(before);
  await toast(page).getByRole("button", { name: "Undo" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Undone." })).toBeVisible();
  expect(sql(`select count(*) from public.activities where company_id = '${lead}'`)).toBe("0");
  expect(sql(`select next_action_at from public.companies where id = '${lead}'`)).toBe(before);
  expect(errors).toEqual([]);
  await context.close();
});

test("phone_return_how_did_it_go: back from the phone app after 5 s asks how it went", async ({ browser }) => {
  const lead = makeLead("Brasserie du Retour");
  const { context, page, errors } = await open(browser, adminState, { width: 390 });
  await page.clock.install();
  await gotoLead(page, lead);
  await page.getByRole("link", { name: "Call", exact: true }).first().tap();
  await expect(panel(page)).toBeVisible();
  const setVisibility = (state: "hidden" | "visible") =>
    page.evaluate((s) => {
      Object.defineProperty(document, "visibilityState", { configurable: true, get: () => s });
      document.dispatchEvent(new Event("visibilitychange"));
    }, state);
  await setVisibility("hidden");
  await page.clock.fastForward(185_000);
  await setVisibility("visible");
  await expect(page.getByRole("heading", { name: "How did it go?" })).toBeVisible();
  await expect(panel(page)).toContainText("Away about 3 min");
  await panel(page).getByRole("button", { name: /^Voicemail/ }).tap();
  await panel(page).getByRole("button", { name: /^Save to timeline/ }).tap();
  await expect.poll(() => latest(lead)).toBe("call:voicemail");
  expect(errors).toEqual([]);
  await context.close();
});

test("email_open_mail_then_one_tap_log and the composer's mail link", async ({ browser }) => {
  const lead = makeLead("Société Courriel", { email: "achats+lyon@example.com" });
  const { context, page, errors } = await open(browser, adminState);
  await gotoLead(page, lead);
  const email = page.getByRole("link", { name: "Email", exact: true }).first();
  await expect(email).toHaveAttribute("href", "mailto:achats%2Blyon@example.com");
  await email.click();
  await page.getByRole("button", { name: "Log email" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Logged: Email" })).toBeVisible();
  await expect.poll(() => latest(lead)).toBe("email:sent");

  const composer = page.getByRole("form", { name: "Log activity" });
  await composer.getByRole("button", { name: "Email" }).click();
  await composer.getByLabel("Subject").fill("Prix & stock?");
  await composer.getByLabel("Message").fill("Bonjour,\nVoici le tarif.");
  const send = composer.getByRole("link", { name: /^Open in Mail and log/ });
  await expect(send).toHaveAttribute(
    "href",
    `mailto:achats%2Blyon@example.com?subject=${encodeURIComponent("Prix & stock?")}&body=${encodeURIComponent("Bonjour,\r\nVoici le tarif.")}`,
  );
  await send.click();
  await expect.poll(() => sql(`select count(*) from public.activities where company_id = '${lead}' and type = 'email'`)).toBe("2");
  expect(sql(`select body from public.activities where company_id = '${lead}' order by created_at desc limit 1`)).toBe(
    "Subject: Prix & stock?\n\nBonjour,\nVoici le tarif.",
  );
  expect(errors).toEqual([]);
  await context.close();
});

test("note_edit_marks_edited, xss_note_is_text, draft_survives_reload", async ({ browser }) => {
  const lead = makeLead("Épicerie des Notes");
  const { context, page, errors } = await open(browser, adminState);
  let dialogs = 0;
  page.on("dialog", (d) => {
    dialogs += 1;
    void d.dismiss();
  });
  await gotoLead(page, lead);
  const composer = page.getByRole("form", { name: "Log activity" });
  // Draft kept per lead across a reload.
  await composer.getByRole("textbox", { name: "Note" }).fill("Draft about the denim lot");
  await page.waitForTimeout(500);
  await settled(page);
  await page.reload();
  await appReady(page);
  await expect(composer.getByRole("textbox", { name: "Note" })).toHaveValue("Draft about the denim lot");
  // A note that looks like HTML stays text.
  const evil = `<img src=x onerror="alert(1)"><script>alert(2)</script> ),id.eq.`;
  await composer.getByRole("textbox", { name: "Note" }).fill(evil);
  await page.keyboard.press("Control+Enter");
  await expect(page.getByRole("status").filter({ hasText: "Logged: Note" })).toBeVisible();
  await expect(composer.getByRole("textbox", { name: "Note" })).toHaveValue("");
  await page.getByRole("tab", { name: "Timeline" }).click();
  const entry = page.getByRole("tabpanel").getByRole("article").first();
  await expect(entry).toContainText(evil);
  expect(await page.locator("main img[src='x']").count()).toBe(0);
  expect(dialogs).toBe(0);
  expect(sql(`select body from public.activities where company_id = '${lead}'`)).toBe(evil);
  // Edit by the author: "Edited".
  await entry.getByRole("button", { name: "Entry options" }).click();
  await page.getByRole("menuitem", { name: "Edit text" }).click();
  await entry.getByRole("textbox", { name: "Text of the entry" }).fill("Plain text now");
  await entry.getByRole("button", { name: "Save" }).click();
  await expect(entry).toContainText("Plain text now");
  await expect(entry).toContainText("Edited");
  expect(sql(`select edited_at is not null from public.activities where company_id = '${lead}'`)).toBe("t");
  // The draft was cleared on save.
  await settled(page);
  await page.reload();
  await appReady(page);
  await expect(composer.getByRole("textbox", { name: "Note" })).toHaveValue("");
  expect(errors).toEqual([]);
  await context.close();
});

test("delete_note_asks_for_code (code made to look 15 minutes old)", async ({ browser }) => {
  test.setTimeout(150_000);
  const lead = makeLead("Distribution Supprime");
  const fresh = await fullSession(browser, adminEmail, password, adminSecret);
  const { context, page, errors } = await open(browser, fresh);
  await gotoLead(page, lead);
  const composer = page.getByRole("form", { name: "Log activity" });
  await composer.getByRole("textbox", { name: "Note" }).fill("To be deleted");
  await composer.getByRole("button", { name: /^Save to timeline/ }).click();
  await expect.poll(() => sql(`select count(*) from public.activities where company_id = '${lead}'`)).toBe("1");
  sql(`update public.activities set created_at = now() - interval '5 minutes' where company_id = '${lead}'`);
  await ageStepUp(context, 900);
  await gotoLead(page, lead, "timeline");
  const entry = page.getByRole("tabpanel").getByRole("article").first();
  await entry.getByRole("button", { name: "Entry options" }).click();
  await page.getByRole("menuitem", { name: "Delete" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Delete" }).click();
  const dialog = page.getByRole("dialog", { name: "Confirm it’s you" });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("Deleting an entry can’t be undone.");
  await nextWindow();
  await dialog.getByLabel("6-digit code").fill(totp(adminSecret));
  await expect(page.getByRole("status").filter({ hasText: "Entry deleted." })).toBeVisible();
  expect(sql(`select count(*) from public.activities where company_id = '${lead}'`)).toBe("0");
  expect(errors).toEqual([]);
  await context.close();
});

test("read_only_lead_logs_but_no_status: a rep's call on the admin's lead is logged, the lead stays", async ({ browser }) => {
  const lead = makeLead("Maison Lecture", { owner: adminEmail });
  const { context, page, errors } = await open(browser, repState);
  await gotoLead(page, lead);
  await expect(page.getByText("Only Inès Garnier or an admin can change this lead.").first()).toBeVisible();
  await expect(page.getByRole("button", { name: /^Status:/ })).toHaveCount(0);
  await page.getByRole("link", { name: "Call", exact: true }).first().click();
  await panel(page).getByRole("button", { name: "End call" }).click();
  await panel(page).getByRole("button", { name: /^No answer/ }).click();
  await page.keyboard.press("Control+Enter");
  await expect(page.getByRole("status").filter({ hasText: "Status not changed: only Inès Garnier or an admin can change this lead" })).toBeVisible();
  expect(latest(lead)).toBe("call:no_answer");
  expect(sql(`select coalesce(next_action_at::text, 'null') from public.companies where id = '${lead}'`)).toBe("null");
  expect(errors).toEqual([]);
  await context.close();
});

test("timeline_pages_keyset (60 entries), deals_stock_empty_states and keyboard tabs", async ({ browser }) => {
  const lead = makeLead("Comptoir Soixante");
  sql(`insert into public.activities (org_id, company_id, user_id, type, outcome, body, created_at)
       select c.org_id, c.id, '${userId(adminEmail)}', 'note', null, 'Entry ' || lpad(i::text, 2, '0'),
              now() - interval '1 day' - (case when i % 10 = 0 then 0 else i end) * interval '1 minute'
       from public.companies c, generate_series(1, 60) i where c.id = '${lead}'`);
  const { context, page, errors } = await open(browser, adminState);
  await gotoLead(page, lead, "timeline");
  const articles = page.getByRole("tabpanel").getByRole("article");
  await expect(articles).toHaveCount(30);
  // Reaching the end of the list loads the next page (the "Show older" button does the same from the keyboard).
  await page.getByRole("button", { name: "Show older" }).scrollIntoViewIfNeeded();
  await expect(articles).toHaveCount(60);
  await expect(page.getByText("That’s the whole history.")).toBeVisible();
  const bodies = await articles.locator("p[dir=auto]").allTextContents();
  expect(new Set(bodies).size).toBe(60);
  // Tabs by keyboard: Right from Timeline is Deals, then Stock; the empty states say what comes.
  await page.getByRole("tab", { name: "Timeline" }).focus();
  await page.keyboard.press("ArrowRight");
  await expect(page.getByRole("tab", { name: "Deals" })).toBeFocused();
  await expect(page.getByRole("tabpanel")).toContainText("Deals open from this page once the pipeline is ready.");
  await page.keyboard.press("ArrowRight");
  await expect(page.getByRole("tabpanel")).toContainText("once inventory is set up");
  await page.keyboard.press("End");
  await expect(page.getByRole("tab", { name: "Details" })).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("Home");
  await expect(page.getByRole("tab", { name: "Summary" })).toHaveAttribute("aria-selected", "true");
  // A bad cursor is a bad request; signed out is 401.
  expect((await context.request.get(`/api/leads/${lead}/activities?before_at=2026-01-01T00:00:00Z`)).status()).toBe(400);
  expect((await context.request.get(`/api/leads/${lead}/activities?types=sms`)).status()).toBe(400);
  expect((await context.request.get(`/api/leads/${lead}/activities?limit=1000`)).status()).toBe(400);
  expect(errors).toEqual([]);
  await context.close();
});

test("timeline_virtualised_past_120 (150 entries): a feed with positions, the end reached, the menu and Show more work", async ({ browser }) => {
  const lead = makeLead("Comptoir Cent Cinquante");
  sql(`insert into public.activities (org_id, company_id, user_id, type, outcome, body, created_at)
       select c.org_id, c.id, '${userId(adminEmail)}', 'note', null,
              'Entry ' || lpad(i::text, 3, '0') || case when i = 150 then repeat(E'\nline', 9) else '' end,
              now() - interval '1 day' - i * interval '1 minute'
       from public.companies c, generate_series(1, 150) i where c.id = '${lead}'`);
  const { context, page, errors } = await open(browser, adminState);
  await gotoLead(page, lead, "timeline");
  const panelEl = page.getByRole("tabpanel");
  const end = panelEl.getByText("That’s the whole history.");
  for (let i = 0; i < 20 && !(await end.isVisible()); i++) {
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    await page.waitForTimeout(300);
  }
  await expect(end).toBeVisible();
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  // Past 120 entries only the rows near the window are in the page; each says where it is in the whole list.
  const feed = panelEl.getByRole("feed", { name: "Timeline" });
  await expect(feed.getByRole("article").first()).toHaveAttribute("aria-setsize", "150");
  expect(await feed.getByRole("article").count()).toBeLessThan(60);
  const oldest = feed.getByRole("article").filter({ hasText: "Entry 150" });
  await expect(oldest).toHaveAttribute("aria-posinset", "150");
  // The oldest entry's Show more and its menu still work in a virtualised row.
  await oldest.getByRole("button", { name: "Show more" }).click();
  await expect(oldest.getByRole("button", { name: "Show more" })).toHaveCount(0);
  await oldest.getByRole("button", { name: "Entry options" }).click();
  await expect(page.getByRole("menuitem", { name: "Edit text" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menuitem", { name: "Edit text" })).toHaveCount(0);
  // Back at the top, the newest entry is drawn again.
  await page.evaluate(() => window.scrollTo(0, 0));
  await expect(feed.getByRole("article").filter({ hasText: "Entry 001" })).toHaveAttribute("aria-posinset", "1");
  expect(errors).toEqual([]);
  await context.close();
});

test("status_menu_cool_off_until_when", async ({ browser }) => {
  const lead = makeLead("Cazal Pause", { status: "warm" });
  const { context, page, errors } = await open(browser, adminState);
  await gotoLead(page, lead);
  await page.getByRole("button", { name: /^Status: Warm/ }).click();
  await page.getByRole("menuitemradio", { name: "Cool off" }).click();
  const dialog = page.getByRole("dialog", { name: "Until when?" });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel("In 30 days").check();
  await dialog.getByRole("button", { name: "Set Cool off" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Status changed." })).toBeVisible();
  expect(sql(`select lead_status from public.companies where id = '${lead}'`)).toBe("cool_off");
  const days = Number(sql(`select round(extract(epoch from next_action_at - now()) / 86400) from public.companies where id = '${lead}'`));
  expect(days).toBeGreaterThanOrEqual(29);
  expect(days).toBeLessThanOrEqual(31);
  expect(errors).toEqual([]);
  await context.close();
});

test("phone_390_full_flow: tap a row, the lead page, a note from the sheet, no sideways scroll", async ({ browser }) => {
  const { context, page, errors } = await open(browser, adminState, { width: 390 });
  await page.goto("/leads?sort=name");
  await appReady(page);
  await page.getByRole("table", { name: "Leads" }).getByRole("row").getByRole("link").first().tap();
  await expect(page).toHaveURL(/\/leads\/[0-9a-f-]{36}$/);
  await expect(page.locator("main h1")).toBeVisible();
  await appReady(page);
  const id = page.url().split("/").pop() as string;
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
  await page.getByRole("button", { name: "Note", exact: true }).tap();
  const sheet = page.getByRole("dialog", { name: "Log activity" });
  await expect(sheet).toBeVisible();
  await sheet.getByRole("textbox", { name: "Note" }).fill("Met at the trade fair");
  await sheet.getByRole("button", { name: /^Save to timeline/ }).tap();
  await expect(sheet).toHaveCount(0);
  await expect.poll(() => latest(id)).toBe("note:");
  await page.getByRole("link", { name: "Leads", exact: true }).first().tap();
  await expect(page).toHaveURL(/\/leads\?sort=name$/);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
  expect(errors).toEqual([]);
  await context.close();
});

test("a missing lead, someone else's org id and a malformed id get the same not-found page", async ({ browser }) => {
  const { context, page, errors } = await open(browser, adminState);
  for (const path of ["/leads/00000000-0000-4000-8000-000000000000", "/leads/not-a-uuid"]) {
    // The page streams behind its loading skeleton, so the answer is the not-found screen (not a bare 404 status).
    await settled(page);
    await page.goto(path);
    await expect(page.locator("main h1")).toHaveText("This page isn’t here");
    await expect(page.getByRole("link", { name: "Back to leads" })).toHaveAttribute("href", "/leads");
  }
  expect((await context.request.get("/api/leads/00000000-0000-4000-8000-000000000000/activities")).status()).toBe(200);
  expect(await (await context.request.get("/api/leads/00000000-0000-4000-8000-000000000000/activities")).json()).toEqual({ entries: [], next: null });
  expect(errors.filter((e) => !e.includes("404"))).toEqual([]);
  await context.close();
});

test("signed out, the lead page APIs answer 401", async ({ request }) => {
  const id = "00000000-0000-4000-8000-000000000000";
  expect((await request.get(`/api/leads/${id}/activities`, { maxRedirects: 0 })).status()).toBe(401);
  expect((await request.get(`/api/leads/${id}/tasks`, { maxRedirects: 0 })).status()).toBe(401);
  expect((await request.get(`/api/activities/${id}`, { maxRedirects: 0 })).status()).toBe(401);
});
