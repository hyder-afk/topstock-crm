import { expect, test, type Browser, type BrowserContext } from "@playwright/test";
import { ageStepUp, appReady, createUser, fullSession, isCancelledPrefetch, nextWindow, setRole, settled, sql, totp, trackRequests } from "./helpers";

// More > Team (go-live parts A and K): an admin promotes a rep with a fresh code; a stale code asks for one first; the
// last admin cannot step down; demoting yourself leaves the admin screens; a rep never sees the screen and the action
// refuses them. The people live in an organisation of their own made for this run, so the list holds exactly them
// (the local stack is reused across runs and holds many test users in the main organisation).
test.describe.configure({ mode: "serial" });

const password = "Team-Screen-Pass-42!";
const run = Date.now();
const adminEmail = `team-admin-${run}@example.test`;
const repEmail = `team-rep-${run}@example.test`;
const namelessEmail = `team-nameless-${run}@example.test`;
const admin = `Ada T${run}`;
const rep = `Remy T${run}`;
let adminSecret = "";
let adminState: Awaited<ReturnType<BrowserContext["storageState"]>>;
let repState: Awaited<ReturnType<BrowserContext["storageState"]>>;
let captured: { headers: Record<string, string>; body: string } | null = null;

const userId = (email: string) => sql(`select id from auth.users where email = '${email}'`);
const roleOf = (email: string) => sql(`select role from public.profiles where id = '${userId(email)}'`);

async function open(browser: Browser, state: typeof adminState, width = 1440) {
  const context = await browser.newContext({ storageState: state, viewport: { width, height: width < 600 ? 844 : 900 }, hasTouch: width < 600 });
  const page = await context.newPage();
  trackRequests(page);
  const errors: string[] = [];
  page.on("console", (m) => m.type() === "error" && !isCancelledPrefetch(m.text()) && errors.push(m.text()));
  page.on("pageerror", (e) => !isCancelledPrefetch(e.message) && errors.push(e.message));
  return { context, page, errors };
}

async function gotoTeam(page: import("@playwright/test").Page) {
  await settled(page);
  await page.goto("/more/team");
  await expect(page.getByRole("heading", { level: 1, name: "Team" })).toBeVisible();
  await appReady(page);
}

const roleButton = (page: import("@playwright/test").Page, who: string, role: string) => page.getByRole("button", { name: `Role for ${who}: ${role}` });
const said = (page: import("@playwright/test").Page, text: string) => page.locator("main").getByRole("status").filter({ hasText: text });

test.beforeAll(async ({ browser }) => {
  test.setTimeout(240_000);
  adminSecret = await createUser(adminEmail, password, true);
  const repSecret = await createUser(repEmail, password, true);
  await createUser(namelessEmail, password, false);
  const org = sql(`insert into public.orgs (name) values ('Team e2e ${run}') returning id`);
  expect(org).toMatch(/^[0-9a-f-]{36}$/);
  sql(`update public.profiles set org_id = '${org}' where id in (select id from auth.users where email in ('${adminEmail}', '${repEmail}', '${namelessEmail}'))`);
  setRole(adminEmail, "admin");
  setRole(repEmail, "rep");
  setRole(namelessEmail, "rep");
  sql(`update public.profiles set first_name = 'Ada', last_name = 'T${run}' where id = '${userId(adminEmail)}'`);
  sql(`update public.profiles set first_name = 'Remy', last_name = 'T${run}' where id = '${userId(repEmail)}'`);
  sql(`update public.profiles set first_name = '', last_name = '' where id = '${userId(namelessEmail)}'`);
  adminState = await fullSession(browser, adminEmail, password, adminSecret);
  repState = await fullSession(browser, repEmail, password, repSecret);
});

test("admin_promotes_rep_with_fresh_code: More > Team > the person > Role > Admin > Confirm; focus and announcement", async ({ browser }) => {
  const { context, page, errors } = await open(browser, adminState);
  await page.goto("/more");
  await appReady(page);
  await page.getByRole("link", { name: /^Team/ }).click();
  await expect(page).toHaveURL(/\/more\/team$/);
  await expect(page.getByRole("heading", { level: 1, name: "Team" })).toBeVisible();
  await appReady(page);

  // Exactly this run's three people: you first with the marker, then the rep, then the person without a name, told
  // apart by the start of their user id.
  await expect(page.getByRole("heading", { name: "3 people" })).toBeVisible();
  const rows = page.locator("main ul > li");
  await expect(rows).toHaveCount(3);
  await expect(rows.nth(0)).toContainText(admin);
  await expect(rows.nth(0)).toContainText("You");
  await expect(rows.nth(1)).toContainText(rep);
  await expect(rows.nth(2)).toContainText("No name yet");
  await expect(rows.nth(2)).toContainText(`User ID ${userId(namelessEmail).slice(0, 8)}`);
  await expect(roleButton(page, `Account ${userId(namelessEmail).slice(0, 8)}`, "Rep")).toBeVisible();

  page.on("request", (request) => {
    if (request.method() === "POST" && request.headers()["next-action"] && request.postData()?.includes('"role"')) {
      captured = { headers: request.headers(), body: request.postData() ?? "" };
    }
  });

  // Keyboard path: the role button, Enter opens the menu, arrows to Admin, Enter; then the confirmation.
  await roleButton(page, rep, "Rep").focus();
  await page.keyboard.press("Enter");
  const menu = page.getByRole("menu");
  await expect(menu).toBeVisible();
  await expect(menu.getByRole("menuitemradio", { name: /^Rep/ })).toHaveAttribute("aria-checked", "true");
  await menu.getByRole("menuitemradio", { name: /^Admin/ }).focus();
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog", { name: "Change role?" });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText(`${rep} becomes an admin.`);
  await expect(dialog).not.toContainText("You will lose the admin screens");
  await dialog.getByRole("button", { name: "Confirm" }).click();

  // The code is fresh (entered at sign-in): no "Confirm it's you"; the row shows Admin, it is said, the focus is back.
  await expect(page.getByRole("dialog", { name: "Confirm it’s you" })).toHaveCount(0);
  await expect(said(page, `${rep} is now an admin.`)).toHaveCount(1);
  await expect(roleButton(page, rep, "Admin")).toBeFocused();
  await expect.poll(() => roleOf(repEmail)).toBe("admin");
  expect(
    sql(`select count(*) from public.audit_log where action = 'role_change' and record_id = '${userId(repEmail)}'
         and actor_id = '${userId(adminEmail)}' and diff_json -> 'role' ->> 'new' = 'admin'`),
  ).toBe("1");
  expect(captured).not.toBeNull();
  await settled(page);
  expect(errors).toEqual([]);
  await context.close();
});

test("rep_cannot_see_or_reach_team: no row on More, 404 on the page, the action refused", async ({ browser }) => {
  setRole(repEmail, "rep");
  const { context, page, errors } = await open(browser, repState);
  await page.goto("/more");
  await appReady(page);
  await expect(page.getByRole("heading", { name: "Your name" })).toBeVisible();
  await expect(page.getByRole("link", { name: /^Team/ })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Administration" })).toHaveCount(0);
  await settled(page);
  await page.goto("/more/team");
  await expect(page.getByRole("heading", { name: "This page isn’t here" })).toBeVisible();
  await expect(page.getByText(admin)).toHaveCount(0);

  // The admin's own request, sent with the rep's session to make the rep an admin: refused, nothing changes.
  expect(captured).not.toBeNull();
  const { headers, body } = captured as unknown as { headers: Record<string, string>; body: string };
  delete headers.cookie;
  const repId = userId(repEmail);
  const forged = body.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/, repId);
  expect(forged).toContain(repId);
  const before = sql(`select count(*) from public.audit_log where action = 'role_change' and record_id = '${repId}'`);
  const answer = await context.request.post("/more/team", { headers, data: forged, maxRedirects: 0 });
  expect(await answer.text()).toMatch(/"error":"forbidden"/);
  expect(roleOf(repEmail)).toBe("rep");
  expect(sql(`select count(*) from public.audit_log where action = 'role_change' and record_id = '${repId}'`)).toBe(before);
  // Extra fields are refused before any database call (strictObject).
  const extra = body.replace(/"role":"(\w+)"/, '"role":"$1","org_id":"x"');
  const refused = await context.request.post("/more/team", { headers, data: extra, maxRedirects: 0 });
  expect(await refused.text()).toMatch(/"error":"invalid"/);
  expect(errors).toEqual([]);
  await context.close();
});

test("stale_code_asks_for_a_code: Cancel keeps the role, a fresh code saves it", async ({ browser }) => {
  test.setTimeout(150_000);
  // A session of its own: back-dating the code rotates the session, and the later tests keep using adminState.
  const fresh = await fullSession(browser, adminEmail, password, adminSecret);
  const { context, page, errors } = await open(browser, fresh);
  await ageStepUp(context, 660);
  await gotoTeam(page);
  const pick = async () => {
    await roleButton(page, rep, "Rep").click();
    await page.getByRole("menuitemradio", { name: /^Manager/ }).click();
    const dialog = page.getByRole("dialog", { name: "Change role?" });
    await expect(dialog).toContainText(`${rep} becomes a manager.`);
    await dialog.getByRole("button", { name: "Confirm" }).click();
  };
  await pick();
  const stepUp = page.getByRole("dialog", { name: "Confirm it’s you" });
  await expect(stepUp).toBeVisible();
  await expect(stepUp).toContainText("Changing a role decides what someone can see and change.");
  await expect(stepUp.getByLabel("6-digit code")).toBeFocused();
  await stepUp.getByRole("button", { name: "Cancel" }).click();
  await expect(said(page, "Role not changed.")).toHaveCount(1);
  await expect(roleButton(page, rep, "Rep")).toBeFocused();
  expect(roleOf(repEmail)).toBe("rep");

  await pick();
  await expect(stepUp.getByLabel("6-digit code")).toBeFocused();
  await nextWindow();
  await stepUp.getByLabel("6-digit code").fill(totp(adminSecret));
  await expect(stepUp).toHaveCount(0);
  await expect(said(page, `${rep} is now a manager.`)).toHaveCount(1);
  await expect(roleButton(page, rep, "Manager")).toBeFocused();
  await expect.poll(() => roleOf(repEmail)).toBe("manager");
  await settled(page);
  expect(errors).toEqual([]);
  await context.close();
});

test("last_admin_refused: the only admin cannot step down; the row goes back and says why", async ({ browser }) => {
  // This run's organisation has one admin (Remy is a manager now).
  expect(sql(`select count(*) from public.profiles where role = 'admin' and org_id = (select org_id from public.profiles where id = '${userId(adminEmail)}')`)).toBe("1");
  const { context, page, errors } = await open(browser, adminState);
  await gotoTeam(page);
  await roleButton(page, admin, "Admin").click();
  await page.getByRole("menuitemradio", { name: /^Rep/ }).click();
  const dialog = page.getByRole("dialog", { name: "Change role?" });
  await expect(dialog).toContainText(`${admin} becomes a rep.`);
  await expect(dialog).toContainText("You will lose the admin screens (Team and Import leads) as soon as this is saved.");
  await dialog.getByRole("button", { name: "Confirm" }).click();
  const why = "You are the last admin. Make someone else an admin first.";
  await expect(said(page, why)).toHaveCount(1);
  await expect(page.locator("main ul > li").nth(0)).toContainText(why);
  await expect(roleButton(page, admin, "Admin")).toBeFocused();
  await expect(roleButton(page, admin, "Admin")).toHaveAccessibleDescription(why);
  expect(roleOf(adminEmail)).toBe("admin");
  await settled(page);
  expect(errors).toEqual([]);
  await context.close();
});

test("demoting_yourself: with another admin, you become a manager and land on More without Team", async ({ browser }) => {
  setRole(repEmail, "admin");
  const { context, page, errors } = await open(browser, adminState, 390);
  await gotoTeam(page);
  await roleButton(page, admin, "Admin").click();
  await page.getByRole("menuitemradio", { name: /^Manager/ }).click();
  const dialog = page.getByRole("dialog", { name: "Change role?" });
  await expect(dialog).toContainText("You will lose the admin screens");
  // Phone: the confirmation's buttons are 44 px tall at least.
  for (const name of ["Confirm", "Cancel"]) {
    expect((await dialog.getByRole("button", { name }).boundingBox())!.height).toBeGreaterThanOrEqual(44);
  }
  await dialog.getByRole("button", { name: "Confirm" }).click();
  await expect(page).toHaveURL(/\/more$/);
  await expect(page.getByRole("heading", { name: "Your name" })).toBeVisible();
  await expect(page.getByRole("link", { name: /^Team/ })).toHaveCount(0);
  expect(roleOf(adminEmail)).toBe("manager");
  setRole(adminEmail, "admin");
  await settled(page);
  expect(errors).toEqual([]);
  await context.close();
});
