import { test, expect } from "./test";
import { clearEpisodic, makeSlice, seedSlices } from "./memory-fixture";

const status = {
  asOf: "2026-10-22T00:00:00Z",
  reflection: { state: "live", runId: "fixture-hq", status: "running", startedAt: null, ageMs: 1, attributes: {} },
  runs: { state: "live", live: [] },
};

test.afterEach(async () => clearEpisodic());

test("finished activity does not reattach, and a hidden open panel performs no polling", async ({ page }) => {
  await seedSlices([makeSlice("2026-02-01T09:00:00Z", { tag: "OLD" })]);
  let statusReads = 0;
  let logReads = 0;
  let streams = 0;
  await page.route("**/api/chat", (route) => route.abort());
  await page.route("**/api/evolution/hq-status", (route) => { statusReads += 1; return route.fulfill({ json: status }); });
  await page.route("**/api/evolution/hq-log", (route) => { logReads += 1; return route.fulfill({ json: { asOf: status.asOf, log: { state: "unavailable", reason: "fixture" } } }); });
  await page.route("**/api/evolution/hq/fixture-hq/stream", (route) => {
    streams += 1;
    return route.fulfill({ contentType: "text/event-stream", body: 'data: {"type":"data-hq-activity","data":{"kind":"finished","at":"t","status":"idle"}}\n\n' });
  });
  await page.goto("/en/app?view=field");
  await expect.poll(() => streams).toBe(1);
  await page.locator("[data-companion-pod]").click();
  await expect(page.locator("[data-companion-pod-panel]")).toBeVisible();
  await expect.poll(() => logReads).toBeGreaterThan(0);
  await page.clock.install();
  await page.clock.fastForward(16000);
  expect(streams).toBe(1);
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await page.clock.runFor(100);
  const before = { statusReads, logReads, streams };
  await page.clock.fastForward(31000);
  expect({ statusReads, logReads, streams }).toEqual(before);
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await page.clock.runFor(100);
  await expect.poll(() => statusReads).toBeGreaterThan(before.statusReads);
  expect(streams).toBe(1);
});
