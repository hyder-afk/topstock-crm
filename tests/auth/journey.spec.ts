import { expect, test, type Page } from "@playwright/test";
import { confirmPathFromEmail, invite, nextWindow, totp, trySignup } from "./helpers";

// One person, start to finish: invited -> chooses a password -> must set up two-factor -> signed in ->
// signs out -> password alone is not enough -> code -> signed in -> resets the password (code required first).
test.describe.configure({ mode: "serial" });

const email = `e2e-${Date.now()}@example.test`;
const password = "Correct-Horse-42!";
const newPassword = "Battery-Staple-77?";
let secret = "";

async function noSidewaysScroll(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
}

test("invite, password, two-factor setup, signed in", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await invite(email);
  const confirmPath = await confirmPathFromEmail(email, "invite");

  // The link alone does nothing; the token is spent only when the button is pressed.
  await page.goto(confirmPath);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Continue to TopStock");
  await page.getByRole("button", { name: "Choose a password" }).click();

  await expect(page).toHaveURL(/\/set-password$/);
  // Long enough for the browser, but no symbol: the server's rule (same as Supabase's) rejects it.
  await page.getByLabel("New password").fill("Abcdefghijkl1");
  await page.getByLabel("Repeat password").fill("Abcdefghijkl1");
  await page.getByRole("button", { name: "Save password" }).click();
  await expect(page.getByRole("main").getByRole("alert")).toContainText("at least 12 characters");
  await page.getByLabel("New password").fill(password);
  await page.getByLabel("Repeat password").fill(`${password}x`);
  await page.getByRole("button", { name: "Save password" }).click();
  await expect(page.getByRole("main").getByRole("alert")).toHaveText("The two passwords don’t match.");
  await page.getByLabel("New password").fill(password);
  await page.getByLabel("Repeat password").fill(password);
  await page.getByRole("button", { name: "Save password" }).click();

  // The enrolment wall: the app itself is out of reach until two-factor is set up.
  await expect(page).toHaveURL(/\/mfa\/setup$/);
  await page.goto("/");
  await expect(page).toHaveURL(/\/mfa/);
  await page.goto("/mfa/setup");
  await page.getByRole("button", { name: "Show QR code" }).click();
  await expect(page.getByRole("img", { name: "QR code for your authenticator app" })).toBeVisible();
  secret = (await page.locator("code").innerText()).replace(/\s/g, "");
  expect(secret).toMatch(/^[A-Z2-7]{16,}$/);
  await noSidewaysScroll(page);

  await page.getByLabel("2. Enter the 6-digit code it shows").fill("000000");
  await page.getByRole("button", { name: "Finish setup" }).click();
  await expect(page.getByRole("main").getByRole("alert")).toContainText("That code didn’t work");
  await page.getByLabel("2. Enter the 6-digit code it shows").fill(totp(secret));
  await page.getByRole("button", { name: "Finish setup" }).click();

  await expect(page).toHaveURL(/\/$/);
  await expect(page.locator("main h1")).toHaveText("Hello");
  expect(errors).toEqual([]);
});

test("sign out, password alone is not enough, code signs in", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill("Wrong-Password-1!");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("main").getByRole("alert")).toHaveText("That email and password don’t match. Try again.");

  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/mfa$/);
  // aal1 (password only) cannot reach the app or set up a second authenticator.
  await page.goto("/");
  await expect(page).toHaveURL(/\/mfa$/);
  await page.goto("/mfa/setup");
  await expect(page).toHaveURL(/\/mfa$/);

  await nextWindow();
  await page.getByLabel("6-digit code").fill(totp(secret));
  await page.getByRole("button", { name: "Verify" }).click();
  await expect(page).toHaveURL(/\/$/);

  await page.getByRole("navigation", { name: "Sections" }).getByRole("link", { name: "More", exact: true }).click();
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await expect(page).toHaveURL(/\/login$/);
  await page.goto("/");
  await expect(page).toHaveURL(/\/login$/);
});

test("password reset asks for the code before the new password", async ({ page }) => {
  const sentAfter = Date.now() - 1_000;
  await page.goto("/forgot-password");
  await page.getByLabel("Email").fill(email);
  await page.getByRole("button", { name: "Send link" }).click();
  await expect(page.getByRole("main").getByRole("status")).toContainText("If that address has an account");

  await page.goto(await confirmPathFromEmail(email, "recovery", sentAfter));
  await page.getByRole("button", { name: "Choose a new password" }).click();
  await expect(page).toHaveURL(/\/mfa\?next=%2Fset-password$|\/mfa\?next=\/set-password$/);

  await nextWindow();
  await page.getByLabel("6-digit code").fill(totp(secret));
  await page.getByRole("button", { name: "Verify" }).click();
  await expect(page).toHaveURL(/\/set-password$/);
  await page.getByLabel("New password").fill(newPassword);
  await page.getByLabel("Repeat password").fill(newPassword);
  await page.getByRole("button", { name: "Save password" }).click();
  await expect(page).toHaveURL(/\/$/);
});

test("an unknown address gets the same answer as a real one", async ({ page }) => {
  await page.goto("/forgot-password");
  await page.getByLabel("Email").fill("nobody@example.test");
  await page.getByRole("button", { name: "Send link" }).click();
  await expect(page.getByRole("main").getByRole("status")).toContainText("If that address has an account");
});

test("nobody can sign up: accounts come from invitations only", async () => {
  const res = await trySignup(`walk-in-${Date.now()}@example.test`, "Walk-In-Pass-42!");
  expect(res.status).toBeGreaterThanOrEqual(400);
  expect(res.code).toBe("signup_disabled");
});
