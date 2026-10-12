import { defineConfig } from "@playwright/test";

// Unit tests of the pure import rules (src/lib/import) in Node: no web server and no browser project. The specs use
// only `test` and `expect`, never the `page` fixture, so no browser starts (design 6C). Run with `npm run test:unit`.
export default defineConfig({
  testDir: "./tests/unit",
  testMatch: /.*\.spec\.ts$/,
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: 0,
  timeout: 60_000,
  reporter: process.env.CI ? "github" : "list",
  // Its own output folder: the default (test-results) would wipe the e2e screenshots kept there between runs.
  outputDir: "test-results/unit",
});
