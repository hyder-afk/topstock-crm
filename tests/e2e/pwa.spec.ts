import { expect, test } from "@playwright/test";

// Day 7c PWA basics on the production build, signed out (placeholder Supabase values: no request reaches a project).
// Haider's answer to plan question 8: home-screen icon (maskable too), display standalone, theme colours, safe areas;
// no service worker, no offline cache, no install prompt. The CSP stays as it is (default-src 'self' covers the
// manifest and its icons).

test("the manifest and its icons are served to a signed-out visitor, with the security headers", async ({ request }) => {
  const res = await request.get("/manifest.webmanifest", { maxRedirects: 0 });
  expect(res.status()).toBe(200);
  expect(res.headers()["content-type"]).toContain("application/manifest+json");
  expect(res.headers()["x-content-type-options"]).toBe("nosniff");
  expect(res.headers()["content-security-policy"]).toContain("frame-ancestors 'none'");
  const m = await res.json();
  expect(m).toMatchObject({ name: "TopStock CRM", short_name: "TopStock", start_url: "/", display: "standalone", theme_color: "#f5f3ef" });
  const icons = m.icons as { src: string; sizes: string; purpose: string }[];
  expect(icons.filter((i) => i.purpose === "maskable").map((i) => i.sizes)).toEqual(["192x192", "512x512"]);
  for (const src of [...icons.map((i) => i.src), "/apple-icon.png"]) {
    const icon = await request.get(src, { maxRedirects: 0 });
    expect(icon.status(), src).toBe(200);
    expect(icon.headers()["content-type"], src).toBe("image/png");
  }
});

for (const scheme of ["light", "dark"] as const) {
  test(`the sign-in page links the manifest and the home-screen icon, covers the notch, ${scheme} theme colour, no service worker`, async ({ page }) => {
    const errors: string[] = [];
    page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
    page.on("pageerror", (e) => errors.push(e.message));
    await page.emulateMedia({ colorScheme: scheme });
    await page.goto("/login");
    await expect(page.locator('link[rel="manifest"]')).toHaveAttribute("href", "/manifest.webmanifest");
    await expect(page.locator('link[rel="apple-touch-icon"]')).toHaveAttribute("href", /\/apple-icon\.png/);
    await expect(page.locator('meta[name="viewport"]')).toHaveAttribute("content", /viewport-fit=cover/);
    await expect(page.locator('meta[name="theme-color"][media="(prefers-color-scheme: light)"]')).toHaveAttribute("content", "#f5f3ef");
    await expect(page.locator('meta[name="theme-color"][media="(prefers-color-scheme: dark)"]')).toHaveAttribute("content", "#0e0e10");
    await expect(page.locator('meta[name="apple-mobile-web-app-title"]')).toHaveAttribute("content", "TopStock");
    // The manifest is fetched by the browser under the page's CSP without a violation.
    const manifest = await page.evaluate(async () => (await fetch("/manifest.webmanifest")).status);
    expect(manifest).toBe(200);
    expect(await page.evaluate(async () => ("serviceWorker" in navigator ? (await navigator.serviceWorker.getRegistrations()).length : 0))).toBe(0);
    // Safe-area padding is on the body (0 on a desktop browser, which reports no insets).
    const pad = await page.evaluate(() => getComputedStyle(document.body).paddingLeft);
    expect(pad).toBe("0px");
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(0);
    expect(errors).toEqual([]);
  });
}
