import { defineConfig, devices } from "@playwright/test";

// Full sign-in journey against a throwaway local Supabase (CI job "auth" in .github/workflows/db.yml).
// Needs SUPABASE_LOCAL_URL, SUPABASE_LOCAL_SERVICE_ROLE_KEY (the local stack's built-in demo key) and MAILPIT_URL.
const executablePath = process.env.PW_CHROMIUM_PATH || undefined;

export default defineConfig({
  testDir: "./tests/auth",
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: 0,
  timeout: 180_000,
  reporter: process.env.CI ? "github" : "list",
  use: { baseURL: "http://localhost:3100", trace: "retain-on-failure", ...devices["Desktop Chrome"], launchOptions: { executablePath } },
  webServer: { command: "npm run start", url: "http://localhost:3100/login", reuseExistingServer: true, timeout: 60_000 },
});
