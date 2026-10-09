import { expect, test } from "@playwright/test";

for (const locale of ["en", "fr"] as const) {
  for (const scheme of ["light", "dark"] as const) {
    test(`home renders (${locale}, ${scheme}) with no console errors and no sideways scroll`, async ({ page, context }) => {
      const errors: string[] = [];
      page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
      page.on("pageerror", (e) => errors.push(e.message));
      await context.addCookies([{ name: "locale", value: locale, url: "http://localhost:3100" }]);
      await page.emulateMedia({ colorScheme: scheme });
      await page.goto("/");

      await expect(page.locator("html")).toHaveAttribute("lang", locale);
      await expect(page.getByRole("heading", { level: 1 })).toHaveText(
        locale === "en" ? "The foundation is ready" : "Les fondations sont prêtes",
      );
      await expect(page.getByRole("img", { name: "TopStock" })).toBeVisible();
      await expect(page.locator("html")).toHaveClass(new RegExp(scheme === "dark" ? "dark" : "light"));
      await expect(page.getByRole("button", { name: locale === "en" ? "System" : "Système" })).toHaveAttribute("aria-pressed", "true");

      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      expect(overflow).toBeLessThanOrEqual(0);
      expect(errors).toEqual([]);
    });
  }
}

test("security headers are present", async ({ request }) => {
  const res = await request.get("/");
  const h = res.headers();
  expect(h["content-security-policy"]).toContain("frame-ancestors 'none'");
  expect(h["content-security-policy"]).toMatch(/script-src 'self' 'nonce-/);
  expect(h["x-frame-options"]).toBe("DENY");
  expect(h["x-content-type-options"]).toBe("nosniff");
  expect(h["x-powered-by"]).toBeUndefined();
});

test("language switch sets the cookie and re-renders in French", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "FR" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Les fondations sont prêtes");
});
