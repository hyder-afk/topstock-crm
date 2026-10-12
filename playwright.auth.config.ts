import { defineConfig, devices } from "@playwright/test";

// Full sign-in journey and evidence screenshots against a throwaway local Supabase (CI job "auth-journey" in
// .github/workflows/ci.yml; locally scripts/local-auth/start.sh). Needs NEXT_PUBLIC_SUPABASE_URL/ANON_KEY,
// SUPABASE_LOCAL_URL, SUPABASE_LOCAL_SERVICE_ROLE_KEY (local stack only; helpers refuse non-local URLs) and MAILPIT_URL.
const executablePath = process.env.PW_CHROMIUM_PATH || undefined;

export default defineConfig({
  testDir: "./tests/auth",
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: 0,
  timeout: 180_000,
  reporter: process.env.CI ? "github" : "list",
  use: { baseURL: "http://localhost:3100", trace: "retain-on-failure" },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"], launchOptions: { executablePath } } },
    // Safari's engine for the shell, the leads screen and the import (dock drag, keyboard, command menu, table,
    // preview, file reading and the problems file download, and the lead page with its call panel; Master Plan: "Test in
    // Safari and Chrome").
    // CI installs WebKit; locally run `--project chromium` when only Chromium is available.
    { name: "webkit", testMatch: /(shell|leads|import|lead-page|inventory)\.spec\.ts/, use: { ...devices["Desktop Safari"] } },
  ],
  webServer: { command: "npm run start", url: "http://localhost:3100/login", reuseExistingServer: true, timeout: 60_000 },
});
