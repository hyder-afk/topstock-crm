import { expect, test, type BrowserContext, type Page, type Route } from "@playwright/test";
import { ageStepUp, appReady, choose, createUser, fullSession, nextWindow, pickDate, setRole, settled, signedInPage, sql, totp } from "./helpers";

// The Tasks page (Day 4c, design 7.5 and 8.5): quick add with date chips lands in the right tab; done and dismiss with
// Undo; "Today" follows the person's own time zone (Karachi); Team is for admins only; delete asks for a fresh code;
// everything works from the keyboard and the focus never drops to the page. Rows are checked in the database.
test.describe.configure({ mode: "serial" });

const password = "Tasks-Page-Pass-42!";
const run = Date.now();
const adminEmail = `tasks-admin-${run}@example.test`;
const repEmail = `tasks-rep-${run}@example.test`;
let adminSecret = "";
let adminState: Awaited<ReturnType<BrowserContext["storageState"]>>;
let repState: Awaited<ReturnType<BrowserContext["storageState"]>>;

const userId = (email: string) => sql(`select id from auth.users where email = '${email}'`);
// Only this run's people (the local stack is reused across runs, and titles repeat).
const mine = () => `assignee_id in ('${userId(adminEmail)}', '${userId(repEmail)}')`;
const zoneOf = (email: string, zone: string) => sql(`update public.profiles set timezone = '${zone}' where id = '${userId(email)}'`);
const baseURL = () => test.info().project.use.baseURL ?? "http://localhost:3100";

/** A made-up task for `email` (fixed test literals only). */
function makeTask(email: string, title: string, due: { date?: string; at?: string } = {}, extra: { company?: string; kind?: string } = {}) {
  const id = userId(email);
  return sql(`insert into public.tasks (org_id, company_id, title, kind, due_date, due_at, assignee_id, created_by)
              select org_id, ${extra.company ? `'${extra.company}'` : "null"}, '${title}', '${extra.kind ?? "todo"}',
                     ${due.date ? `'${due.date}'` : "null"}, ${due.at ? `'${due.at}'` : "null"}, id, id
              from public.profiles where id = '${id}' returning id`);
}
const todayIn = (zone: string) => sql(`select (now() at time zone '${zone}')::date`);
const dayIn = (zone: string, days: number) => sql(`select (now() at time zone '${zone}')::date + ${days}`);

const tab = (page: Page, name: RegExp) => page.getByRole("tab", { name });
const rows = (page: Page) => page.getByRole("tabpanel").getByRole("listitem");
const row = (page: Page, title: string) => rows(page).filter({ hasText: title });
const toast = (page: Page) => page.getByRole("status").filter({ hasText: /\S/ }).last();
const focusedTag = (page: Page) => page.evaluate(() => document.activeElement?.tagName ?? "none");

async function openTasks(page: Page, query = "") {
  await settled(page);
  await page.goto(`/tasks${query}`);
  await expect(page.locator("main h1")).toContainText("Tasks");
  await appReady(page);
}

test.beforeAll(async ({ browser }) => {
  test.setTimeout(240_000);
  adminSecret = await createUser(adminEmail, password, true);
  const repSecret = await createUser(repEmail, password, true);
  setRole(adminEmail, "admin");
  setRole(repEmail, "rep");
  sql(`update public.profiles set first_name = 'Inès', last_name = 'Garnier' where id = '${userId(adminEmail)}'`);
  sql(`update public.profiles set first_name = 'Malo', last_name = 'Perrin' where id = '${userId(repEmail)}'`);
  zoneOf(adminEmail, "Europe/Paris");
  zoneOf(repEmail, "Europe/Paris");
  adminState = await fullSession(browser, adminEmail, password, adminSecret);
  repState = await fullSession(browser, repEmail, password, repSecret);
});

test("quick_add_chips_buckets: Today, Tomorrow and a picked date land in their tabs, with their counts", async ({ browser }) => {
  const { context, page, errors } = await signedInPage(browser, adminState, { baseURL: baseURL() });
  await openTasks(page);
  await expect(page.getByRole("tabpanel")).toContainText("Nothing due today.");
  const input = page.getByRole("textbox", { name: "New task" });
  // Today (the chip on by default), Enter adds.
  await input.fill("Send the denim price list");
  await input.press("Enter");
  await expect(row(page, "Send the denim price list")).toBeVisible();
  await expect(input).toHaveValue("");
  await expect.poll(() => sql(`select due_date from public.tasks where ${mine()} and title = 'Send the denim price list' and created_by = '${userId(adminEmail)}'`)).toBe(todayIn("Europe/Paris"));
  // Tomorrow, as a call: Upcoming.
  await page.getByRole("button", { name: "Tomorrow", exact: true }).click();
  await page.getByRole("group", { name: "Kind" }).getByRole("button", { name: "Call" }).click();
  await input.fill("Call Brasserie Verdane back");
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await expect(toast(page)).toContainText("Task added: Call Brasserie Verdane back.");
  expect(sql(`select due_date || ' ' || kind from public.tasks where ${mine()} and title = 'Call Brasserie Verdane back'`)).toBe(`${dayIn("Europe/Paris", 1)} call`);
  // A picked date in the past: Overdue (the red count).
  await page.getByRole("button", { name: "Pick a date" }).click();
  await pickDate(page.getByLabel("Date", { exact: true }), dayIn("Europe/Paris", -2));
  await page.getByRole("group", { name: "Kind" }).getByRole("button", { name: "To-do" }).click();
  await input.fill("Chase the unpaid invoice");
  await input.press("Enter");
  await expect.poll(() => sql(`select due_date from public.tasks where ${mine()} and title = 'Chase the unpaid invoice'`)).toBe(dayIn("Europe/Paris", -2));
  // A meeting needs a time: Add says why and adds nothing.
  await page.getByRole("button", { name: "Today", exact: true }).click();
  await page.getByRole("group", { name: "Kind" }).getByRole("button", { name: "Meeting" }).click();
  await input.fill("Showroom visit");
  await input.press("Enter");
  await expect(page.getByRole("form", { name: "New task" }).getByRole("alert")).toHaveText("A meeting needs a date and a time.");
  expect(sql(`select count(*) from public.tasks where ${mine()} and title = 'Showroom visit'`)).toBe("0");
  await page.getByRole("combobox", { name: "Time", exact: true }).fill("15:30");
  await input.press("Enter");
  await expect.poll(() => sql(`select kind || ' ' || (due_at is not null) from public.tasks where ${mine()} and title = 'Showroom visit'`)).toBe("meeting true");

  // Tabs and their counts (count_tasks, in the person's zone).
  await expect(tab(page, /^Today/)).toContainText(/\d/);
  await tab(page, /^Upcoming/).click();
  await expect(row(page, "Call Brasserie Verdane back")).toBeVisible();
  await expect(row(page, "Call Brasserie Verdane back")).toContainText("Tomorrow");
  await tab(page, /^Overdue/).click();
  await expect(row(page, "Chase the unpaid invoice")).toContainText("Overdue");
  await expect(page).toHaveURL(/tab=overdue/);
  // The tab survives a reload (?tab=).
  await page.reload();
  await expect(tab(page, /^Overdue/)).toHaveAttribute("aria-selected", "true");
  await expect(row(page, "Chase the unpaid invoice")).toBeVisible();
  expect(errors).toEqual([]);
  await context.close();
});

test("toggle_done_undo: the row leaves at once, Undo brings it back; Done lists it", async ({ browser }) => {
  makeTask(adminEmail, "Confirm the container date", { date: todayIn("Europe/Paris") });
  makeTask(adminEmail, "Book the transport", { date: todayIn("Europe/Paris") });
  const { context, page, errors } = await signedInPage(browser, adminState, { baseURL: baseURL() });
  await openTasks(page);
  const check = page.getByRole("checkbox", { name: "Mark “Confirm the container date” done" });
  await check.click();
  await expect(row(page, "Confirm the container date")).toHaveCount(0);
  await expect(toast(page)).toContainText("Done: Confirm the container date.");
  await expect.poll(() => sql(`select done_at is not null from public.tasks where ${mine()} and title = 'Confirm the container date'`)).toBe("t");
  // The focus moved to a neighbour's check, never to the page.
  expect(await focusedTag(page)).toBe("BUTTON");
  await toast(page).getByRole("button", { name: "Undo" }).click();
  await expect.poll(() => sql(`select done_at is null from public.tasks where ${mine()} and title = 'Confirm the container date'`)).toBe("t");
  await expect(row(page, "Confirm the container date")).toBeVisible();
  // Done again, then from the Done tab back to not done.
  await page.getByRole("checkbox", { name: "Mark “Confirm the container date” done" }).click();
  await expect.poll(() => sql(`select done_at is not null from public.tasks where ${mine()} and title = 'Confirm the container date'`)).toBe("t");
  await tab(page, /^Done/).click();
  const done = page.getByRole("checkbox", { name: "Mark “Confirm the container date” not done" });
  await expect(done).toHaveAttribute("aria-checked", "true");
  await done.click();
  await expect.poll(() => sql(`select done_at is null from public.tasks where ${mine()} and title = 'Confirm the container date'`)).toBe("t");
  await expect(toast(page)).toContainText("Not done: Confirm the container date.");
  expect(errors).toEqual([]);
  await context.close();
});

test("dismiss_and_undo: Dismiss from the menu, Undo puts it back", async ({ browser }) => {
  makeTask(adminEmail, "Ask for the VAT number", { date: todayIn("Europe/Paris") });
  const { context, page, errors } = await signedInPage(browser, adminState, { baseURL: baseURL() });
  await openTasks(page);
  await page.getByRole("button", { name: "More actions for “Ask for the VAT number”" }).click();
  await page.getByRole("menuitem", { name: "Dismiss" }).click();
  await expect(row(page, "Ask for the VAT number")).toHaveCount(0);
  await expect.poll(() => sql(`select cancelled_at is not null from public.tasks where ${mine()} and title = 'Ask for the VAT number'`)).toBe("t");
  await expect(toast(page)).toContainText("Dismissed: Ask for the VAT number.");
  await toast(page).getByRole("button", { name: "Undo" }).click();
  await expect.poll(() => sql(`select cancelled_at is null from public.tasks where ${mine()} and title = 'Ask for the VAT number'`)).toBe("t");
  await expect(row(page, "Ask for the VAT number")).toBeVisible();
  // Dismissed tasks are listed nowhere: dismiss again and look in every tab.
  await page.getByRole("button", { name: "More actions for “Ask for the VAT number”" }).click();
  await page.getByRole("menuitem", { name: "Dismiss" }).click();
  await expect.poll(() => sql(`select cancelled_at is not null from public.tasks where ${mine()} and title = 'Ask for the VAT number'`)).toBe("t");
  for (const name of [/^Overdue/, /^Upcoming/, /^Done/, /^Today/]) {
    await tab(page, name).click();
    await expect(page.getByRole("tabpanel")).not.toContainText("Ask for the VAT number");
  }
  expect(errors).toEqual([]);
  await context.close();
});

test("karachi_today_boundary: Today and Tomorrow follow the profile's zone, not the browser's", async ({ browser }) => {
  // A timed task at 02:00 Karachi time tomorrow, and an all-day task on Karachi's today.
  const at = sql(`select to_char((date_trunc('day', now() at time zone 'Asia/Karachi') + interval '1 day 2 hours') at time zone 'Asia/Karachi' at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')`);
  makeTask(adminEmail, "Karachi early call", { at }, { kind: "call" });
  makeTask(adminEmail, "Karachi all-day", { date: todayIn("Asia/Karachi") });
  zoneOf(adminEmail, "Asia/Karachi");
  // The browser stays in Paris: only the profile decides.
  const { context, page, errors } = await signedInPage(browser, adminState, { timezoneId: "Europe/Paris", baseURL: baseURL() });
  await openTasks(page, "?tab=upcoming");
  await expect(row(page, "Karachi early call")).toContainText("Tomorrow 02:00");
  await tab(page, /^Today/).click();
  await expect(row(page, "Karachi all-day")).toContainText("Today");
  // Back to Paris (the More page's time zone form).
  await settled(page);
  await page.goto("/more");
  await appReady(page);
  const zone = page.getByRole("combobox", { name: "Time zone" });
  await choose(zone, "Europe/Paris");
  await page.getByRole("button", { name: "Save time zone" }).click();
  await expect(page.getByText("Time zone saved.")).toBeVisible();
  expect(sql(`select timezone from public.profiles where id = '${userId(adminEmail)}'`)).toBe("Europe/Paris");
  // A zone nobody knows is refused: an error, and nothing changes. The app's own list cannot be given a made-up option
  // in the page (Day 7b), so the request that saves the zone is rewritten on its way to the server instead.
  await page.route("**/more", async (route) => {
    const request = route.request();
    if (request.method() !== "POST" || !request.headers()["next-action"]) return route.continue();
    const body = request.postData() ?? "";
    expect(body).toContain("Europe/Paris");
    return route.continue({ postData: body.replaceAll("Europe/Paris", "Mars/Olympus_Mons") });
  });
  await page.getByRole("button", { name: "Save time zone" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "time zone" })).toBeVisible();
  await page.unroute("**/more");
  expect(sql(`select timezone from public.profiles where id = '${userId(adminEmail)}'`)).toBe("Europe/Paris");
  // The same timed task in Paris: its time and day there worked out by the database (22:00 or 23:00 depending on
  // daylight saving; Paris's today, or tomorrow while Paris is still on the day before Karachi's).
  const parisTime = sql(`select to_char(timestamptz '${at}' at time zone 'Europe/Paris', 'HH24:MI')`);
  const parisDays = sql(`select (timestamptz '${at}' at time zone 'Europe/Paris')::date - (now() at time zone 'Europe/Paris')::date`);
  expect(["0", "1"]).toContain(parisDays);
  await openTasks(page, parisDays === "0" ? "" : "?tab=upcoming");
  await expect(row(page, "Karachi early call")).toContainText(`${parisDays === "0" ? "Today" : "Tomorrow"} ${parisTime}`);
  expect(errors).toEqual([]);
  await context.close();
});

test("team_scope_admin_only: a rep has no Team switch and the API refuses it; an admin sees the rep's task with initials", async ({ browser }) => {
  makeTask(repEmail, `Rep follow-up call ${run}`, { date: todayIn("Europe/Paris") });
  const rep = await signedInPage(browser, repState, { baseURL: baseURL() });
  await openTasks(rep.page);
  await expect(row(rep.page, `Rep follow-up call ${run}`)).toBeVisible();
  await expect(rep.page.getByRole("group", { name: "Whose tasks" })).toHaveCount(0);
  const refused = await rep.context.request.get("/api/tasks?bucket=today&scope=team");
  expect(refused.status()).toBe(403);
  expect(await refused.json()).toEqual({ error: "forbidden" });
  // ?scope=team in the address is ignored for a rep.
  await openTasks(rep.page, "?scope=team");
  await expect(row(rep.page, `Rep follow-up call ${run}`)).toBeVisible();
  expect(rep.errors).toEqual([]);
  await rep.context.close();

  const admin = await signedInPage(browser, adminState, { baseURL: baseURL() });
  await openTasks(admin.page);
  await expect(row(admin.page, `Rep follow-up call ${run}`)).toHaveCount(0);
  await admin.page.getByRole("group", { name: "Whose tasks" }).getByRole("button", { name: "Team" }).click();
  await expect(admin.page).toHaveURL(/scope=team/);
  await expect(row(admin.page, `Rep follow-up call ${run}`)).toContainText("MP");
  expect(admin.errors).toEqual([]);
  await admin.context.close();
});

test("delete_needs_code: Delete asks first, then a fresh code; the task is gone", async ({ browser }) => {
  makeTask(adminEmail, "Old supplier reminder", { date: todayIn("Europe/Paris") });
  const { context, page, errors } = await signedInPage(browser, adminState, { baseURL: baseURL() });
  await ageStepUp(context, 900);
  await openTasks(page);
  await page.getByRole("button", { name: "More actions for “Old supplier reminder”" }).click();
  await page.getByRole("menuitem", { name: "Delete" }).click();
  const confirm = page.getByRole("dialog", { name: "Delete this task?" });
  await expect(confirm).toBeVisible();
  await confirm.getByRole("button", { name: "Delete task" }).click();
  const stepUp = page.getByRole("dialog", { name: "Confirm it’s you" });
  await expect(stepUp).toContainText("Deleting a task can’t be undone.");
  await nextWindow();
  await stepUp.getByLabel("6-digit code").fill(totp(adminSecret));
  await expect(stepUp).toHaveCount(0);
  await expect(toast(page)).toContainText("Task deleted.");
  expect(sql(`select count(*) from public.tasks where ${mine()} and title = 'Old supplier reminder'`)).toBe("0");
  await expect(row(page, "Old supplier reminder")).toHaveCount(0);
  expect(await focusedTag(page)).not.toBe("BODY");
  expect(errors).toEqual([]);
  await context.close();
});

test("keyboard_only: T, Enter, J/K, X, E, D, Backspace and Enter to the lead, the focus always somewhere", async ({ browser }) => {
  const lead = sql(`insert into public.companies (org_id, name, owner_id, lead_status, phone, city, country)
                    select org_id, 'Comptoir Clavier', id, 'warm', '04 72 00 00 01', 'Lyon', 'FR'
                    from public.profiles where id = '${userId(adminEmail)}' returning id`);
  sql(`update public.tasks set cancelled_at = now() where assignee_id = '${userId(adminEmail)}' and done_at is null and cancelled_at is null`);
  makeTask(adminEmail, "Alpha keyboard task", { date: todayIn("Europe/Paris") });
  makeTask(adminEmail, "Bravo keyboard task", { date: todayIn("Europe/Paris") }, { company: lead });
  const { context, page, errors } = await signedInPage(browser, adminState, { baseURL: baseURL() });
  await openTasks(page);
  await page.keyboard.press("t");
  await expect(page.getByRole("textbox", { name: "New task" })).toBeFocused();
  await page.keyboard.type("Charlie keyboard task");
  await page.keyboard.press("Enter");
  await expect.poll(() => sql(`select count(*) from public.tasks where ${mine()} and title = 'Charlie keyboard task'`)).toBe("1");
  await page.keyboard.press("Escape");
  await page.locator("main h1").click(); // out of the field (a click on plain text), so single keys work
  await expect(rows(page)).toHaveCount(3);
  await expect(page.locator("[data-task-check]:disabled")).toHaveCount(0); // the new task is confirmed
  // J to the first task's check, J again to the second.
  await page.keyboard.press("j");
  await expect(page.locator("[data-task-check]").first()).toBeFocused();
  await page.keyboard.press("j");
  await expect(page.locator("[data-task-check]").nth(1)).toBeFocused();
  await page.keyboard.press("k");
  await expect(page.locator("[data-task-check]").first()).toBeFocused();
  // E edits inline: the title field takes the focus; Enter saves; the focus comes back to the row's check.
  const firstTitle = (await rows(page).first().textContent()) ?? "";
  const which = ["Alpha", "Bravo", "Charlie"].find((w) => firstTitle.includes(w)) as string;
  await page.keyboard.press("e");
  const title = page.getByRole("form", { name: "Edit task" }).getByRole("textbox", { name: "Title" });
  await expect(title).toBeFocused();
  await title.fill(`${which} keyboard task (edited)`);
  await page.keyboard.press("Enter");
  await expect.poll(() => sql(`select count(*) from public.tasks where ${mine()} and title = '${which} keyboard task (edited)'`)).toBe("1");
  await expect(page.locator("[data-task-check]").first()).toBeFocused();
  // X: done, the focus goes to the next check.
  await page.keyboard.press("x");
  await expect.poll(() => sql(`select done_at is not null from public.tasks where ${mine()} and title = '${which} keyboard task (edited)'`)).toBe("t");
  await expect(rows(page)).toHaveCount(2);
  await expect(page.locator("[data-task-check]").first()).toBeFocused();
  // D: dismiss the focused task.
  const focusedRow = await page.evaluate(() => document.activeElement?.closest("[data-task-id]")?.textContent ?? "");
  const second = ["Alpha", "Bravo", "Charlie"].find((w) => focusedRow.includes(w)) as string;
  await page.keyboard.press("d");
  await expect(rows(page)).toHaveCount(1);
  await expect.poll(() => sql(`select count(*) from public.tasks where ${mine()} and title like '${second} keyboard task%' and cancelled_at is not null`)).toBe("1");
  expect(await focusedTag(page)).not.toBe("BODY");
  // Backspace on the last one asks first; Escape keeps it and the focus returns to it.
  await page.keyboard.press("j");
  await page.keyboard.press("Backspace");
  await expect(page.getByRole("dialog", { name: "Delete this task?" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.locator("[data-task-check]").first()).toBeFocused();
  // Enter on a task with a lead opens the lead page.
  if (((await rows(page).first().textContent()) ?? "").includes("Bravo")) {
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(new RegExp(`/leads/${lead}$`));
    await expect(page.locator("main h1")).toHaveText("Comptoir Clavier");
  }
  expect(errors).toEqual([]);
  await context.close();
});

test("phone_lead_link_target: on a phone, a task's lead link is a 44 px tap target without making the row taller", async ({ browser }) => {
  const lead = sql(`insert into public.companies (org_id, name, owner_id, lead_status, phone, country)
                    select org_id, 'Tap Target Textiles', id, 'cold', '+33 6 00 00 00 44', 'FR' from public.profiles
                    where id = '${userId(adminEmail)}' returning id`);
  makeTask(adminEmail, `Phone tap task ${run}`, { date: todayIn("Europe/Paris") }, { company: lead });
  const { context, page, errors } = await signedInPage(browser, adminState, { width: 390, baseURL: baseURL() });
  await openTasks(page);
  const link = row(page, `Phone tap task ${run}`).locator("a[data-task-lead]");
  await expect(link).toBeVisible();
  const box = await link.boundingBox();
  if (!box) throw new Error("no lead link box");
  // The link stays 24 px in the line (the row and its skeleton keep their height) ...
  expect(box.height).toBeLessThanOrEqual(28);
  // ... and a tap up to 10 px above or below it still lands on it: 44 px in all.
  const hits = await page.evaluate(
    ({ x, top, bottom }) =>
      [top - 9, bottom + 9].map((y) => !!document.elementFromPoint(x, y)?.closest("a[data-task-lead]")),
    { x: box.x + Math.min(box.width / 2, 20), top: box.y, bottom: box.y + box.height },
  );
  expect(hits).toEqual([true, true]);
  expect(errors).toEqual([]);
  await settled(page);
  await context.close();
});

test("lead_picker_focus: picking a lead from the keyboard puts the focus on the chip's remove button, never the page", async ({ browser }) => {
  const name = `Picker Focus Textiles ${run}`;
  sql(`insert into public.companies (org_id, name, owner_id, lead_status, phone, country)
       select org_id, '${name}', id, 'cold', '+33 6 00 00 00 45', 'FR' from public.profiles where id = '${userId(adminEmail)}'`);
  const { context, page, errors } = await signedInPage(browser, adminState, { baseURL: baseURL() });
  await openTasks(page);
  const search = page.getByRole("combobox", { name: "Search leads" });
  await search.fill(name);
  await expect(page.getByRole("option", { name: new RegExp(name) })).toBeVisible();
  await search.press("ArrowDown");
  await search.press("ArrowUp");
  await search.press("Enter");
  const remove = page.getByRole("button", { name: `Remove the link to ${name}` });
  await expect(remove).toBeFocused();
  expect(await focusedTag(page)).toBe("BUTTON");
  // Removing it gives the focus back to the field.
  await remove.click();
  await expect(page.getByRole("combobox", { name: "Search leads" })).toBeFocused();
  expect(errors).toEqual([]);
  await context.close();
});

test("failed_toggle_reverts: a toggle that cannot be sent puts the row back with an empty check", async ({ browser }) => {
  sql(`update public.tasks set cancelled_at = now() where assignee_id = '${userId(adminEmail)}' and done_at is null and cancelled_at is null`);
  makeTask(adminEmail, "Offline toggle task", { date: todayIn("Europe/Paris") });
  // A second row keeps the list on screen while the first leaves (alone, the list would give way to the empty state and
  // the row would come back as a new one, hiding the bug).
  makeTask(adminEmail, "Offline toggle neighbour", { date: todayIn("Europe/Paris") });
  const { context, page } = await signedInPage(browser, adminState, { baseURL: baseURL() });
  await openTasks(page);
  const check = page.getByRole("checkbox", { name: "Mark “Offline toggle task” done" });
  await expect(check).toHaveAttribute("aria-checked", "false");
  await context.setOffline(true);
  await check.click();
  // The toggle is refused (no connection): the row comes back as it was, with an empty check, and a toast says so.
  await expect(toast(page)).toContainText(/connection|try again|Couldn’t/i);
  await expect(row(page, "Offline toggle task")).toBeVisible();
  await expect(page.getByRole("checkbox", { name: "Mark “Offline toggle task” done" })).toHaveAttribute("aria-checked", "false");
  await page.waitForTimeout(600); // past the row's exit spring
  await expect(page.getByRole("checkbox", { name: "Mark “Offline toggle task” done" })).toHaveAttribute("aria-checked", "false");
  await context.setOffline(false);
  expect(sql(`select done_at is null from public.tasks where ${mine()} and title = 'Offline toggle task'`)).toBe("t");
  // A refusal that arrives while the row is still fading out (the request held 150 ms, then cut): the same row comes
  // back, and its check is empty again (it does not keep the click that sent it away).
  const cut = async (route: Route) => {
    if (route.request().method() === "POST" && route.request().headers()["next-action"]) {
      await new Promise((r) => setTimeout(r, 150));
      await route.abort();
    } else await route.continue();
  };
  const onTasks = (u: URL) => u.pathname.startsWith("/tasks");
  await page.route(onTasks, cut);
  await page.getByRole("checkbox", { name: "Mark “Offline toggle task” done" }).click();
  await expect(row(page, "Offline toggle task")).toBeVisible();
  await page.waitForTimeout(600); // past the exit spring
  await expect(page.getByRole("checkbox", { name: "Mark “Offline toggle task” done" })).toHaveAttribute("aria-checked", "false");
  await page.unroute(onTasks, cut);
  expect(sql(`select done_at is null from public.tasks where ${mine()} and title = 'Offline toggle task'`)).toBe("t");
  // Back online, the same check completes it.
  await page.getByRole("checkbox", { name: "Mark “Offline toggle task” done" }).click();
  await expect.poll(() => sql(`select done_at is not null from public.tasks where ${mine()} and title = 'Offline toggle task'`)).toBe("t");
  await context.close();
});

test("enter_on_task_without_lead: Enter on a task's check never ticks it (X or Space do)", async ({ browser }) => {
  sql(`update public.tasks set cancelled_at = now() where assignee_id = '${userId(adminEmail)}' and done_at is null and cancelled_at is null`);
  makeTask(adminEmail, "Renew the warehouse insurance", { date: todayIn("Europe/Paris") });
  const { context, page, errors } = await signedInPage(browser, adminState, { baseURL: baseURL() });
  await openTasks(page);
  await page.locator("main h1").click();
  await page.keyboard.press("j");
  const check = page.getByRole("checkbox", { name: "Mark “Renew the warehouse insurance” done" });
  await expect(check).toBeFocused();
  await page.keyboard.press("Enter");
  await page.waitForTimeout(700); // longer than the toggle's 160 ms delay and a round trip
  await expect(row(page, "Renew the warehouse insurance")).toBeVisible();
  await expect(check).toHaveAttribute("aria-checked", "false");
  expect(sql(`select done_at is null from public.tasks where ${mine()} and title = 'Renew the warehouse insurance'`)).toBe("t");
  await expect(page).toHaveURL(/\/tasks/);
  // Space does tick it.
  await page.keyboard.press("Space");
  await expect.poll(() => sql(`select done_at is not null from public.tasks where ${mine()} and title = 'Renew the warehouse insurance'`)).toBe("t");
  expect(errors).toEqual([]);
  await context.close();
});

/** Watches the tab panel's rows for 700 ms: the most any row containing `text` was lowered, its lowest opacity, and
 * whether rows containing `old` were still in the panel at the same time. */
function watchRows(page: Page, text: string, old: string) {
  return page.evaluate(
    ([want, before]) =>
      new Promise<{ maxY: number; minOp: number; seen: boolean; mixed: boolean }>((resolve) => {
        let maxY = 0;
        let minOp = 1;
        let seen = false;
        let mixed = false;
        const t0 = performance.now();
        const tick = () => {
          const lis = [...document.querySelectorAll<HTMLElement>("[role=tabpanel] li[data-task-id]")];
          const fresh = lis.filter((li) => li.textContent?.includes(want));
          if (fresh.length && lis.some((li) => li.textContent?.includes(before))) mixed = true;
          for (const li of fresh) {
            seen = true;
            const cs = getComputedStyle(li);
            const m = new DOMMatrixReadOnly(cs.transform === "none" ? undefined : cs.transform);
            maxY = Math.max(maxY, Math.abs(m.m42));
            minOp = Math.min(minOp, parseFloat(cs.opacity));
          }
          if (performance.now() - t0 < 700) requestAnimationFrame(tick);
          else resolve({ maxY, minOp, seen, mixed });
        };
        requestAnimationFrame(tick);
      }),
    [text, old] as const,
  );
}

test("switch_without_motion: rows already in a cached tab or scope do not fade in or rise when it is shown again", async ({ browser }) => {
  // Team shows the whole org (earlier runs' people too): their tasks of this test are put away first.
  sql(`update public.tasks set cancelled_at = now() where (assignee_id in ('${userId(adminEmail)}', '${userId(repEmail)}') or title like 'Switch %') and done_at is null and cancelled_at is null`);
  for (const t of ["Switch today one", "Switch today two"]) makeTask(adminEmail, t, { date: todayIn("Europe/Paris") });
  for (const [t, d] of [["Switch late one", -2], ["Switch late two", -3], ["Switch late three", -4]] as const) makeTask(adminEmail, t, { date: dayIn("Europe/Paris", d) });
  const teamOnly = `Switch team only ${run}`;
  makeTask(repEmail, teamOnly, { date: todayIn("Europe/Paris") });
  const { context, page, errors } = await signedInPage(browser, adminState, { baseURL: baseURL() });
  await openTasks(page);
  await expect(row(page, "Switch today one")).toBeVisible();
  // Visit Overdue and come back: both tabs are cached now.
  await tab(page, /^Overdue/).click();
  await expect(row(page, "Switch late one")).toBeVisible();
  await tab(page, /^Today/).click();
  await expect(row(page, "Switch today one")).toBeVisible();
  await page.waitForTimeout(800);
  // Before: the list stayed mounted, so every Overdue row faded in and rose while the Today rows faded out beside them.
  let watch = watchRows(page, "Switch late", "Switch today");
  await tab(page, /^Overdue/).click();
  let s = await watch;
  expect(s.seen).toBe(true);
  expect(s.maxY).toBeLessThan(0.5);
  expect(s.minOp).toBeGreaterThan(0.99);
  expect(s.mixed).toBe(false);
  // The same for the scope: Today in Team, back to Mine, then Team again.
  await tab(page, /^Today/).click();
  await page.getByRole("button", { name: "Team", exact: true }).click();
  await expect(row(page, teamOnly)).toBeVisible();
  await page.getByRole("button", { name: "Mine", exact: true }).click();
  await expect(row(page, teamOnly)).toHaveCount(0);
  await page.waitForTimeout(800);
  watch = watchRows(page, teamOnly, "Switch today");
  await page.getByRole("button", { name: "Team", exact: true }).click();
  s = await watch;
  expect(s.seen).toBe(true);
  expect(s.maxY).toBeLessThan(0.5);
  expect(s.minOp).toBeGreaterThan(0.99);
  // A task added now still fades in (design 7.8).
  const input = page.getByRole("textbox", { name: "New task" });
  await input.fill("Switch added now");
  watch = watchRows(page, "Switch added now", "nothing-old");
  await input.press("Enter");
  s = await watch;
  expect(s.seen).toBe(true);
  expect(s.minOp).toBeLessThan(0.99);
  expect(errors).toEqual([]);
  await context.close();
});
