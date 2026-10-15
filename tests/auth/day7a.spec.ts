import { expect, test, type BrowserContext } from "@playwright/test";
import { createUser, fullSession, nextWindow, sql, totp } from "./helpers";

// Day 7a (Gate 1 security fixes; docs/evidence/day7a/README.md), against the throwaway local stack:
// - a sign-in writes exactly one "sign_in" audit row (no IP, no details); the password step alone writes none;
// - the auth cookies carry Secure on HTTPS (x-forwarded-proto, as Vercel sends it), SameSite=Lax, Path=/;
// - the search and list APIs answer 429 with a generic code after 300 requests a minute from one person, and only
//   for that person;
// - "Sign out of all devices" on More (confirmation sheet, Cancel keeps the session) ends the other browser's session.
const password = "Day7a-Local-Pass!";
type State = Awaited<ReturnType<BrowserContext["storageState"]>>;
let auditState: State;

const userId = (email: string) => sql(`select id from auth.users where email = '${email}'`);
const authRows = (id: string) => sql(`select count(*) from public.audit_log where actor_id = '${id}' and table_name = 'auth'`);

test.describe.configure({ mode: "serial" });

test("a sign-in writes exactly one audit row; the password step alone writes none", async ({ browser }) => {
  const email = "d7a-audit@example.test";
  const secret = await createUser(email, password, true);
  const id = userId(email);
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL(/\/mfa$/);
  expect(authRows(id)).toBe("0");
  await nextWindow();
  await page.getByLabel("6-digit code").fill(totp(secret));
  await page.getByRole("button", { name: "Verify" }).click();
  await page.waitForURL((url) => url.pathname === "/");
  expect(authRows(id)).toBe("1");
  expect(
    sql(`select action || '|' || coalesce(record_id, 'null') || '|' || coalesce(diff_json::text, 'null') || '|' ||
                (org_id = (select org_id from public.profiles where id = '${id}'))::text
           from public.audit_log where actor_id = '${id}' and table_name = 'auth'`),
  ).toBe("sign_in|null|null|true");
  // Moving around the app writes no more sign-in rows.
  await page.goto("/more");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  expect(authRows(id)).toBe("1");
  auditState = await context.storageState();
  await context.close();
});

for (const https of [true, false]) {
  test(`auth cookie flags (${https ? "HTTPS via the platform header" : "plain HTTP"})`, async ({ browser }) => {
    const email = "d7a-audit@example.test";
    const context = await browser.newContext(https ? { extraHTTPHeaders: { "x-forwarded-proto": "https" } } : {});
    const page = await context.newPage();
    await page.goto("/login");
    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Password").fill(password);
    await page.getByRole("button", { name: "Sign in" }).click();
    await page.waitForURL(/\/mfa$/);
    const auth = (await context.cookies()).filter((c) => /^sb-.+-auth-token(\.\d+)?$/.test(c.name));
    expect(auth.length).toBeGreaterThan(0);
    for (const c of auth) {
      expect({ name: c.name, secure: c.secure, sameSite: c.sameSite, httpOnly: c.httpOnly, path: c.path }).toEqual({
        name: c.name,
        secure: https,
        sameSite: "Lax",
        httpOnly: false,
        path: "/",
      });
    }
    await context.close();
  });
}

test("the search and list APIs answer 429 after 300 requests a minute, for that person only", async ({ browser }) => {
  const email = "d7a-burst@example.test";
  const secret = await createUser(email, password, true);
  const state = await fullSession(browser, email, password, secret);
  const context = await browser.newContext({ storageState: state });
  const statuses: number[] = [];
  for (let batch = 0; batch < 15; batch++) {
    const answers = await Promise.all(Array.from({ length: 20 }, () => context.request.get("/api/leads")));
    statuses.push(...answers.map((r) => r.status()));
  }
  expect(statuses.filter((s) => s === 200).length).toBe(300);
  const refused = await context.request.get("/api/leads");
  expect(refused.status()).toBe(429);
  expect(await refused.json()).toEqual({ error: "rate_limited" });
  expect(Number(refused.headers()["retry-after"])).toBeGreaterThan(0);
  expect(refused.headers()["cache-control"]).toContain("no-store");
  // One limit for every list API of that person.
  expect((await context.request.get("/api/tasks?bucket=today")).status()).toBe(429);
  expect((await context.request.get("/api/pipeline/summary")).status()).toBe(429);
  await context.close();
  // Someone else is not held back.
  const other = await browser.newContext({ storageState: auditState });
  expect((await other.request.get("/api/leads")).status()).toBe(200);
  await other.close();
});

test("Sign out of all devices ends the session in the other browser too", async ({ browser }) => {
  const email = "d7a-devices@example.test";
  const secret = await createUser(email, password, true);
  const laptop = await browser.newContext({ storageState: await fullSession(browser, email, password, secret) });
  const phone = await browser.newContext({ storageState: await fullSession(browser, email, password, secret) });
  const id = userId(email);
  const sessions = () => Number(sql(`select count(*) from auth.sessions where user_id = '${id}'`));
  expect(sessions()).toBeGreaterThanOrEqual(2); // the two browsers (and the helper's own sign-in that set up the app)
  const errors: string[] = [];
  const page = await laptop.newPage();
  page.on("console", (m) => (m.type() === "error" ? errors.push(m.text()) : null));
  await page.goto("/more");
  // Cancel keeps everyone signed in.
  await page.getByRole("button", { name: "Sign out of all devices" }).click();
  const sheet = page.getByRole("dialog", { name: "Sign out of all devices?" });
  await expect(sheet).toBeVisible();
  // The sheet is honest about timing: another device's access token stays valid until it expires (README R2).
  await expect(sheet).toContainText("Other devices lose access within an hour at most.");
  await sheet.getByRole("button", { name: "Cancel" }).click();
  await expect(sheet).toBeHidden();
  const before = sessions();
  expect(before).toBeGreaterThanOrEqual(2);
  // Confirm: this browser lands on the sign-in screen, every session of the person is gone.
  await page.getByRole("button", { name: "Sign out of all devices" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Sign out everywhere" }).click();
  await page.waitForURL(/\/login$/);
  expect(sessions()).toBe(0);
  expect((await laptop.cookies()).filter((c) => /^sb-.+-auth-token/.test(c.name))).toEqual([]);
  // The other browser still holds its cookie, but the session behind it is gone: the next page asks for a sign-in,
  // and its APIs answer 401. (Local stack: HS256, so getClaims asks the auth server. On hosted Supabase with asymmetric
  // keys the access token verifies locally and PostgREST does not check the session, so up to 1 hour: README R2.)
  const other = await phone.newPage();
  await other.goto("/");
  await expect(other).toHaveURL(/\/login$/);
  expect((await phone.request.get("/api/leads")).status()).toBe(401);
  expect(errors).toEqual([]);
  await laptop.close();
  await phone.close();
});

test("French: the More button and the sheet speak French", async ({ browser, baseURL }) => {
  const context = await browser.newContext({ storageState: auditState });
  await context.addCookies([{ name: "locale", value: "fr", url: baseURL ?? "http://localhost:3100" }]);
  const page = await context.newPage();
  await page.goto("/more");
  await page.getByRole("button", { name: "Se déconnecter de tous les appareils" }).click();
  const sheet = page.getByRole("dialog", { name: "Se déconnecter de tous les appareils ?" });
  await expect(sheet).toBeVisible();
  await expect(sheet.getByRole("button", { name: "Tout déconnecter" })).toBeVisible();
  await expect(sheet).toContainText("Les autres appareils perdent l’accès en une heure au plus.");
  await sheet.getByRole("button", { name: "Annuler" }).click();
  await context.close();
});
