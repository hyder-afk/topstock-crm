import { defineConfig, devices } from "@playwright/test";

// Local VMs may only have an older preinstalled Chromium: set PW_CHROMIUM_PATH to use it. CI installs the matching build.
const executablePath = process.env.PW_CHROMIUM_PATH || undefined;
// The app's address: PLAYWRIGHT_BASE_URL when set (a second checkout serves on another port at the same time), else the
// port `npm run start` uses. Specs read it from here (test.info().project.use.baseURL or the page's own relative URLs).
const baseURL = process.env.PLAYWRIGHT_BASE_URL || "http://localhost:3100";
const port = new URL(baseURL).port || "80";
const startCommand = port === "3100" ? "npm run start" : `npx next start -p ${port}`;

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: process.env.CI ? "github" : "list",
  use: { baseURL, trace: "retain-on-failure" },
  projects: [
    { name: "chromium-1440", use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 }, launchOptions: { executablePath } } },
    { name: "chromium-390", use: { ...devices["Desktop Chrome"], viewport: { width: 390, height: 844 }, hasTouch: true, launchOptions: { executablePath } } },
  ],
  webServer: { command: startCommand, url: baseURL, reuseExistingServer: true, timeout: 60_000 },
});
