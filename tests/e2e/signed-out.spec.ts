import { expect, test } from "@playwright/test";

// Signed-out checks. These run against placeholder Supabase values, so no request ever reaches a real project.
// The full invite + password + two-factor journey runs against a local Supabase in tests/auth (CI job "auth").

for (const locale of ["en", "fr"] as const) {
  for (const scheme of ["light", "dark"] as const) {
    test(`sign-in renders (${locale}, ${scheme}) with no console errors and no sideways scroll`, async ({ page, context }) => {
      const errors: string[] = [];
      page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
      page.on("pageerror", (e) => errors.push(e.message));
      await context.addCookies([{ name: "locale", value: locale, url: "http://localhost:3100" }]);
      await page.emulateMedia({ colorScheme: scheme });
      await page.goto("/login");

      await expect(page.locator("html")).toHaveAttribute("lang", locale);
      await expect(page.getByRole("heading", { level: 1 })).toHaveText(locale === "en" ? "Sign in" : "Connexion");
      await expect(page.getByRole("img", { name: "TopStock" })).toBeVisible();
      // Desktop (fine pointer) focuses the email field; phones wait for a tap so the keyboard does not jump up.
      const finePointer = await page.evaluate(() => window.matchMedia("(pointer: fine)").matches);
      if (finePointer) await expect(page.getByLabel(locale === "en" ? "Email" : "E-mail")).toBeFocused();
      else await expect(page.getByLabel(locale === "en" ? "Email" : "E-mail")).not.toBeFocused();
      await expect(page.getByLabel(locale === "en" ? "Password" : "Mot de passe")).toHaveAttribute("autocomplete", "current-password");
      await expect(page.locator("html")).toHaveClass(new RegExp(scheme === "dark" ? "dark" : "light"));
      await expect(page.getByRole("button", { name: locale === "en" ? "System" : "Système" })).toHaveAttribute("aria-pressed", "true");

      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      expect(overflow).toBeLessThanOrEqual(0);
      expect(errors).toEqual([]);
    });
  }
}

test("every app page sends a signed-out visitor to sign-in", async ({ page }) => {
  for (const path of ["/", "/mfa", "/mfa/setup", "/set-password", "/leads"]) {
    await page.goto(path);
    await expect(page, `${path} should redirect`).toHaveURL(/\/login$/);
  }
});

// Gate 1 item 2 (Day 7d): no repository or environment file is served. Signed out, the wall sends every such path to
// sign-in; tests/auth/gate1.spec.ts checks the 404 a signed-in person gets.
const REPO_FILES = ["/.env", "/.env.local", "/.env.production", "/.env.example", "/.git/config", "/package.json", "/next.config.ts", "/supabase/config.toml", "/.mcp.json"];
test("no repository or environment file is served (/.env and the like)", async ({ request }) => {
  for (const path of REPO_FILES) {
    const res = await request.get(path, { maxRedirects: 0 });
    expect([307, 404], path).toContain(res.status());
    if (res.status() === 307) expect(res.headers()["location"], path).toBe("/login");
    const body = await res.text();
    expect(body, path).not.toMatch(/SUPABASE|ANON_KEY|SERVICE_ROLE|\[core\]|"dependencies"|project_ref/);
  }
});

test("security headers are present, also on the sign-in redirect", async ({ request }) => {
  for (const res of [await request.get("/login"), await request.get("/", { maxRedirects: 0 })]) {
    const h = res.headers();
    expect(h["content-security-policy"]).toContain("frame-ancestors 'none'");
    expect(h["content-security-policy"]).toMatch(/script-src 'self' 'nonce-/);
    expect(h["x-frame-options"]).toBe("DENY");
    expect(h["x-content-type-options"]).toBe("nosniff");
    expect(h["x-powered-by"]).toBeUndefined();
    // Plain-HTTP test server: no "upgrade to HTTPS" (that directive is sent on HTTPS only).
    expect(h["content-security-policy"]).not.toContain("upgrade-insecure-requests");
  }
  const redirect = await request.get("/", { maxRedirects: 0 });
  expect(redirect.status()).toBe(307);
  expect(redirect.headers()["location"]).toBe("/login");
});

test("behind HTTPS (Vercel sets x-forwarded-proto), the CSP upgrades insecure requests", async ({ request }) => {
  const res = await request.get("/login", { headers: { "x-forwarded-proto": "https" } });
  expect(res.headers()["content-security-policy"]).toContain("upgrade-insecure-requests");
});

test("language switch sets the cookie and re-renders in French", async ({ page }) => {
  await page.goto("/login");
  await page.getByRole("button", { name: "FR" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Connexion");
});

test("forgot-password page links back to sign-in", async ({ page }) => {
  await page.goto("/login");
  await page.getByRole("link", { name: "Forgot your password?" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Reset your password");
  await page.getByRole("link", { name: "Back to sign in" }).click();
  await expect(page).toHaveURL(/\/login$/);
});

test("an email link without a token shows a plain message, not an error page", async ({ page }) => {
  await page.goto("/auth/confirm");
  await expect(page.getByText("This link has expired or was already used. Ask for a new one.")).toBeVisible();
  await page.goto("/auth/confirm?token_hash=abc&type=signup");
  await expect(page.getByText("This link has expired or was already used. Ask for a new one.")).toBeVisible();
});
