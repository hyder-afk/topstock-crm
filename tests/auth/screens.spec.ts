import { mkdirSync } from "node:fs";
import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { createUser, nextWindow, totp } from "./helpers";

// Evidence screenshots of the signed-in sign-in screens (they need a real session, so they live here, not in tests/e2e).
// Saved to test-results/screens and uploaded by the CI job "auth-journey".
test.describe.configure({ mode: "serial" });

const dir = "test-results/screens";
const combos = [
  { locale: "en", scheme: "light" },
  { locale: "fr", scheme: "dark" },
  { locale: "en", scheme: "dark" },
  { locale: "fr", scheme: "light" },
] as const;
const widths = [390, 1440];
const password = "Screens-Pass-42!";
const withFactor = `screens-a-${Date.now()}@example.test`;
const noFactor = `screens-b-${Date.now()}@example.test`;
let secret = "";
const states: Record<string, Awaited<ReturnType<BrowserContext["storageState"]>>> = {};

async function signIn(browser: Browser, email: string) {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/mfa/);
  return { context, page };
}

async function shoot(browser: Browser, state: string, path: string, name: string, before?: (page: Page) => Promise<void>) {
  for (const { locale, scheme } of combos) {
    for (const width of widths) {
      const context = await browser.newContext({ storageState: states[state], viewport: { width, height: width < 600 ? 844 : 900 }, colorScheme: scheme });
      await context.addCookies([{ name: "locale", value: locale, url: "http://localhost:3100" }]);
      const page = await context.newPage();
      const errors: string[] = [];
      page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
      await page.goto(path);
      await expect(page).toHaveURL(new RegExp(`${path.replace(/\//g, "\\/")}$`));
      if (before) await before(page);
      expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
      await page.screenshot({ path: `${dir}/${name}-${locale}-${scheme}-${width}.png`, fullPage: true });
      expect(errors).toEqual([]);
      await context.close();
    }
  }
}

test.beforeAll(async ({ browser }) => {
  mkdirSync(dir, { recursive: true });
  secret = await createUser(withFactor, password, true);
  await createUser(noFactor, password, false);

  const b = await signIn(browser, noFactor);
  states.setup = await b.context.storageState();
  await b.context.close();

  const a = await signIn(browser, withFactor);
  states.verify = await a.context.storageState();
  await nextWindow();
  await a.page.getByLabel("6-digit code").fill(totp(secret));
  await a.page.getByRole("button", { name: "Verify" }).click();
  await expect(a.page).toHaveURL(/\/$/);
  states.full = await a.context.storageState();
  await a.context.close();
});

test("two-factor setup (QR shown)", async ({ browser }) => {
  await shoot(browser, "setup", "/mfa/setup", "mfa-setup", async (page) => {
    await page.getByRole("button", { name: /Show QR code|Afficher le QR code/ }).click();
    await expect(page.locator("img[src^='data:']")).toBeVisible();
  });
});

test("choose a password", async ({ browser }) => {
  await shoot(browser, "setup", "/set-password", "set-password");
});

test("enter your code", async ({ browser }) => {
  await shoot(browser, "verify", "/mfa", "mfa");
});

test("home, signed in", async ({ browser }) => {
  await shoot(browser, "full", "/", "home");
});
