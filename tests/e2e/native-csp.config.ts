import { defineConfig } from "@playwright/test";

/** Pure browser fixtures: no Next server, model, user state, or open port. */
export default defineConfig({
  testDir: ".", testMatch: "native-csp.spec.ts", workers: 1, retries: 0,
  reporter: "list", use: { browserName: "chromium", headless: true },
});
