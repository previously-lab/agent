import { defineConfig, devices } from "@playwright/test";

// A separately started, offline server is mandatory. Never reuse port 3000.
if (process.env.SCROLL_QA_BASE_URL !== "http://localhost:3100" || !process.env.SCROLL_QA_PROVIDER_ROOT) {
  throw new Error("Start the isolated 3100 transport-fixture server and set SCROLL_QA_BASE_URL and SCROLL_QA_PROVIDER_ROOT");
}
export default defineConfig({
  testDir: "./tests/qa",
  testMatch: "dialogue-interaction-qa.spec.ts",
  workers: 1,
  retries: 0,
  timeout: 180_000,
  expect: { timeout: 25_000 },
  outputDir: process.env.SCROLL_QA_OUTPUT_DIR,
  reporter: "list",
  use: { baseURL: process.env.SCROLL_QA_BASE_URL, actionTimeout: 10_000, trace: "on", screenshot: "on", video: "retain-on-failure" },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"] } },
    { name: "mobile", use: { ...devices["iPhone 13"], defaultBrowserType: "chromium" } },
  ],
});
