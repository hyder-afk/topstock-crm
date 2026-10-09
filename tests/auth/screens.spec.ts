import { mkdirSync } from "node:fs";
import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { appReady, createUser, nextWindow, totp } from "./helpers";

// Evidence screenshots of every sign-in screen, signed out and signed in, against a real Supabase Auth server.
// Saved to test-results/screens; CI uploads them as the "auth-screens" artifact, locally they are copied into
// docs/evidence. Each shot waits for the real screen (not the loading skeleton) and checks for console errors and
// sideways scroll first.
test.describe.configure({ mode: "serial", timeout: 600_000 });

const dir = "test-results/screens";
// CLAUDE.md widths: all six for EN light, the desktop set plus phone for FR dark, phone and laptop for the rest.
const matrix = [
  { locale: "en", scheme: "light", widths: [390, 768, 1024, 1280, 1440, 1728] },
  { locale: "fr", scheme: "dark", widths: [390, 1280, 1440, 1728] },
  { locale: "en", scheme: "dark", widths: [390, 1440] },
  { locale: "fr", scheme: "light", widths: [390, 1440] },
] as const;
const password = "Screens-Pass-42!";
const withFactor = `screens-a-${Date.now()}@example.test`;
const noFactor = `screens-b-${Date.now()}@example.test`;
let secret = "";
const states: Record<string, Awaited<ReturnType<BrowserContext["storageState"]>> | undefined> = { none: undefined };

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

// Placeholder sections share one component: EN light and FR dark at phone and laptop width are enough for them
// (logged waiver, Tooling Protocol section 6 item 9; Leads, the shared template, gets the full matrix).
const lightMatrix = [
  { locale: "en", scheme: "light", widths: [390, 1440] },
  { locale: "fr", scheme: "dark", widths: [390, 1440] },
] as const;

async function shoot(
  browser: Browser,
  state: string,
  path: string,
  name: string,
  act?: (page: Page) => Promise<void>,
  combos: readonly { locale: string; scheme: "light" | "dark"; widths: readonly number[] }[] = matrix,
) {
  for (const { locale, scheme, widths } of combos) {
    for (const width of widths) {
      const context = await browser.newContext({
        storageState: states[state],
        viewport: { width, height: width < 600 ? 844 : 900 },
        colorScheme: scheme,
      });
      await context.addCookies([{ name: "locale", value: locale, url: "http://localhost:3100" }]);
      const page = await context.newPage();
      const errors: string[] = [];
      page.on("console", (m) => m.type() === "error" && errors.push(`${m.text()} (${m.location().url})`));
      page.on("pageerror", (e) => errors.push(e.message));
      await page.goto(path);
      // The right page (no unexpected redirect), then the real screen, not the loading skeleton (which has no heading).
      await expect(page).toHaveURL((url) => url.pathname === new URL(path, "http://localhost:3100").pathname);
      await expect(page.locator("main h1").first()).toBeVisible();
      if (act) await act(page);
      expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
      await page.screenshot({ path: `${dir}/${name}-${locale}-${scheme}-${width}.png`, fullPage: true });
      expect(errors, `${name} ${locale} ${scheme} ${width}`).toEqual([]);
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

test("signed out: sign in, wrong password, forgot, link landing", async ({ browser }) => {
  await shoot(browser, "none", "/login", "login");
  await shoot(browser, "none", "/login", "login-error", async (page) => {
    await page.locator("input[name=email]").fill("nobody@example.test");
    await page.locator("input[name=password]").fill("Wrong-Password-1!");
    await page.locator("button[type=submit]").click();
    await expect(page.getByRole("main").getByRole("alert")).not.toBeEmpty();
  });
  await shoot(browser, "none", "/forgot-password", "forgot");
  await shoot(browser, "none", "/forgot-password", "forgot-done", async (page) => {
    await page.locator("input[name=email]").fill("nobody@example.test");
    await page.locator("button[type=submit]").click();
    await expect(page.getByRole("main").getByRole("status")).not.toBeEmpty();
  });
  await shoot(browser, "none", "/auth/confirm?token_hash=fake&type=invite", "confirm-invite");
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

test("app shell: leads and more in full, the other sections in brief", async ({ browser }) => {
  await shoot(browser, "full", "/leads", "leads");
  await shoot(browser, "full", "/more", "more");
  for (const section of ["pipeline", "inventory", "tasks", "analytics"]) {
    await shoot(browser, "full", `/${section}`, section, undefined, lightMatrix);
  }
});

test("command menu and shortcuts list", async ({ browser }) => {
  await shoot(browser, "full", "/", "palette", async (page) => {
    await appReady(page);
    await page.keyboard.press("Control+k");
    await expect(page.getByRole("dialog")).toBeVisible();
    await page.waitForTimeout(250); // let the entrance settle before the shot
  });
  await shoot(
    browser,
    "full",
    "/",
    "shortcuts",
    async (page) => {
      await appReady(page);
      await page.keyboard.press("Shift+Slash");
      await expect(page.getByRole("dialog")).toBeVisible();
      await page.waitForTimeout(250);
    },
  );
});
