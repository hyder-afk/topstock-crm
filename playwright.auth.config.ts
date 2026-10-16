import { defineConfig, devices } from "@playwright/test";

// Full sign-in journey and evidence screenshots against a throwaway local Supabase (CI job "auth-journey" in
// .github/workflows/ci.yml; locally scripts/local-auth/start.sh). Needs NEXT_PUBLIC_SUPABASE_URL/ANON_KEY,
// SUPABASE_LOCAL_URL, SUPABASE_LOCAL_SERVICE_ROLE_KEY (local stack only; helpers refuse non-local URLs) and MAILPIT_URL.
const executablePath = process.env.PW_CHROMIUM_PATH || undefined;
// The app's address: PLAYWRIGHT_BASE_URL when set (a second checkout serves on another port at the same time), else the
// port `npm run start` uses. Specs read it from here (test.info().project.use.baseURL or the page's own relative URLs).
const baseURL = process.env.PLAYWRIGHT_BASE_URL || "http://localhost:3100";
const port = new URL(baseURL).port || "80";
const startCommand = port === "3100" ? "npm run start" : `npx next start -p ${port}`;

export default defineConfig({
  testDir: "./tests/auth",
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: 0,
  timeout: 180_000,
  reporter: process.env.CI ? "github" : "list",
  use: { baseURL, trace: "retain-on-failure" },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"], launchOptions: { executablePath } } },
    // Safari's engine for the shell, the leads screen and the import (dock drag, keyboard, command menu, table,
    // preview, file reading and the problems file download, the lead page with its call panel, Day 4c's work queue
    // (three people at once too) and Tasks page, the Files tab with its uploads (Day 4d), Day 5b's pipeline board and
    // lead page deals, Day 5c's Home, the Team screen, and Day 6's inventory, stock sheet import, sales and client stock
    // link; Master Plan: "Test in Safari and Chrome").
    // CI installs WebKit; locally run `--project chromium` when only Chromium is available.
    { name: "webkit", testMatch: /(shell|leads|import|lead-page|queue|queue-multi|tasks|files|pipeline|lead-deals|home|team|inventory|sales|share)\.spec\.ts/, use: { ...devices["Desktop Safari"] } },
  ],
  webServer: { command: startCommand, url: `${baseURL}/login`, reuseExistingServer: true, timeout: 60_000 },
});
