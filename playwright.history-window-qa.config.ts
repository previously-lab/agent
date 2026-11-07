import { defineConfig, devices } from "@playwright/test";
if (process.env.SCROLL_QA_BASE_URL !== "http://localhost:3100" || !process.env.SCROLL_QA_HISTORY_ROOT) {
  throw new Error("A fresh dedicated 3100 history fixture root is required");
}
export default defineConfig({
  testDir: "./tests/qa", testMatch: "history-window-qa.spec.ts", workers: 1, retries: 0,
  timeout: 120_000, expect: { timeout: 20_000 }, reporter: "list", outputDir: process.env.SCROLL_QA_OUTPUT_DIR,
  use: { baseURL: process.env.SCROLL_QA_BASE_URL, trace: "on", screenshot: "on", video: "retain-on-failure" },
  projects: [ { name: "desktop", use: { ...devices["Desktop Chrome"] } }, { name: "mobile", use: { ...devices["iPhone 13"], defaultBrowserType: "chromium" } } ],
});
