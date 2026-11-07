import { defineConfig, devices } from "@playwright/test";
import { readFileSync } from "node:fs";
import path from "node:path";
if (process.env.SCROLL_QA_BASE_URL !== "http://localhost:3100" || !process.env.SCROLL_QA_FIXTURE_ROOT) throw new Error("Isolated 3100 root required");
const provider = process.env.SCROLL_QA_PROVIDER_ROOT ?? path.join(process.env.SCROLL_QA_FIXTURE_ROOT!, "home", "dialogue-provider");
if (readFileSync(path.join(provider, "scroll-qa-server-sentinel"), "utf8") !== "isolated-scroll-qa-3100") throw new Error("Invalid fixture provider sentinel");
export default defineConfig({ testDir: "./tests/e2e", testMatch: "dialogue-server-started.spec.ts", workers: 1, retries: 0, timeout: 180_000, expect: {timeout: 25_000}, outputDir: process.env.SCROLL_QA_OUTPUT_DIR, reporter: "list", use: { baseURL: process.env.SCROLL_QA_BASE_URL, trace: "on", screenshot: "on", video: "retain-on-failure" }, projects: [{ name: "desktop", use: { ...devices["Desktop Chrome"] } }, { name: "mobile", use: { ...devices["iPhone 13"], defaultBrowserType: "chromium" } }] });
