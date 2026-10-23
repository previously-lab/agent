import { test as base, expect } from "@playwright/test";

/** Every browser test starts offline. A spec may register a later route for a
 * deterministic SSE fixture; Playwright applies that more specific mock first. */
export const test = base.extend({
  page: async ({ page }, run) => {
    await page.route("**/*", async (route) => {
      const url = new URL(route.request().url());
      if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) {
        await route.abort("blockedbyclient");
        return;
      }
      if (route.request().method() === "POST" && /^\/api\/(chat|companion|evolution)(\/|$)/.test(url.pathname)) {
        await route.fulfill({ status: 503, json: { error: "Offline E2E requires an explicit response fixture" } });
        return;
      }
      await route.continue();
    });
    await run(page);
  },
});

export { expect };
