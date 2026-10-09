import { defineConfig, devices } from "@playwright/test";

// Local VMs may only have an older preinstalled Chromium: set PW_CHROMIUM_PATH to use it. CI installs the matching build.
const executablePath = process.env.PW_CHROMIUM_PATH || undefined;

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: process.env.CI ? "github" : "list",
  use: { baseURL: "http://localhost:3100", trace: "retain-on-failure" },
  projects: [
    { name: "chromium-1440", use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 }, launchOptions: { executablePath } } },
    { name: "chromium-390", use: { ...devices["Desktop Chrome"], viewport: { width: 390, height: 844 }, hasTouch: true, launchOptions: { executablePath } } },
  ],
  webServer: { command: "npm run start", url: "http://localhost:3100", reuseExistingServer: true, timeout: 60_000 },
});
