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


test("conversation workflow controls stay in the viewport and retain their actions", async ({ page }) => {
  const rows = Array.from({ length: 12 }, (_, index) => ({
    runId: `fixture-summary-${index}`,
    status: "running",
    role: "summary",
    slice: `slice-${index}`,
    turn: null,
    burst: null,
    ageMs: 65_000,
  }));
  let statusReads = 0;
  const cancelled: string[] = [];
  await page.route("**/api/chat", (route) => route.abort());
  await page.route("**/api/evolution/hq-status", (route) => {
    statusReads += 1;
    return route.fulfill({
      json: {
        asOf: new Date().toISOString(),
        reflection: { state: "none" },
        runs: { state: "live", live: rows },
      },
    });
  });
  await page.route("**/api/evolution/hq-log", (route) => route.fulfill({
    json: { asOf: new Date().toISOString(), log: { state: "unavailable", reason: "fixture" } },
  }));
  await page.route("**/api/chat/fixture-summary-*/stream*", (route) => route.abort());
  await page.route("**/api/evolution/hq-status/cancel", async (route) => {
    cancelled.push((await route.request().postDataJSON()).runId);
    return route.fulfill({ json: { ok: true } });
  });

  await page.goto("/en/app?view=conversation");
  const trigger = page.getByRole("button", { name: "Workflows", exact: true });
  const send = page.locator("[data-conversation-primary]");
  await expect(trigger).toBeVisible();
  await expect(send).toBeVisible();
  const geometry = await page.evaluate(() => {
    const pod = document.querySelector("[data-companion-pod]")!.getBoundingClientRect();
    const primary = document.querySelector("[data-conversation-primary]")!.getBoundingClientRect();
    return {
      separated: pod.bottom <= primary.top || pod.top >= primary.bottom || pod.right <= primary.left || pod.left >= primary.right,
      inside: pod.left >= 0 && pod.right <= innerWidth && pod.top >= 0 && pod.bottom <= innerHeight,
    };
  });
  expect(geometry).toEqual({ separated: true, inside: true });

  await trigger.click();
  const panel = page.locator("[data-companion-pod-panel]");
  await expect(panel).toBeVisible();
  const desktopPanel = await panel.boundingBox();
  expect(desktopPanel!.width).toBeLessThanOrEqual(384);
  const overflow = await page.locator("[data-slot='scroll-area-viewport']").evaluate((viewport) => ({
    clientHeight: viewport.clientHeight,
    scrollHeight: viewport.scrollHeight,
    panelHeight: document.querySelector("[data-companion-pod-panel]")!.clientHeight,
  }));
  expect(overflow.clientHeight).toBeGreaterThan(0);
  expect(overflow.clientHeight).toBeLessThan(overflow.panelHeight);
  expect(overflow.scrollHeight).toBeGreaterThan(overflow.clientHeight);

  await page.locator("[data-slot='tabs-trigger']").filter({ hasText: "Workflows" }).click();
  await expect(page.getByText("12 running", { exact: true })).toBeVisible();
  await expect(page.getByText("1m", { exact: true }).first()).toBeVisible();
  await page.getByRole("button", { name: "Stop", exact: true }).first().click();
  await page.getByRole("menuitem", { name: /Stop archiving/ }).click();
  await expect.poll(() => cancelled).toEqual(["fixture-summary-0"]);

  const beforeRefresh = statusReads;
  await page.getByRole("button", { name: "Refresh", exact: true }).first().click();
  await expect.poll(() => statusReads).toBeGreaterThan(beforeRefresh);

  await page.setViewportSize({ width: 390, height: 844 });
  await expect.poll(async () => (await panel.boundingBox())!.width).toBeCloseTo(358, 0);
  const mobilePanel = await panel.boundingBox();
  expect(mobilePanel!.x).toBeGreaterThanOrEqual(0);
  expect(mobilePanel!.x + mobilePanel!.width).toBeLessThanOrEqual(390);
  expect(mobilePanel!.y).toBeGreaterThanOrEqual(0);
  expect(mobilePanel!.y + mobilePanel!.height).toBeLessThanOrEqual(844);
});

test("stopping a turn requires dialog confirmation and sends exactly one cancel", async ({ page }) => {
  const runId = "fixture-turn-confirmation";
  const cancelled: string[] = [];
  await page.route("**/api/chat", (route) => route.abort());
  await page.route("**/api/evolution/hq-status", (route) => route.fulfill({
    json: {
      asOf: new Date().toISOString(),
      reflection: { state: "none" },
      runs: {
        state: "live",
        live: [{ runId, status: "running", role: "turn", slice: "fixture-slice", turn: "turn-1", burst: null, ageMs: 65_000 }],
      },
    },
  }));
  await page.route("**/api/evolution/hq-log", (route) => route.fulfill({
    json: { asOf: new Date().toISOString(), log: { state: "unavailable", reason: "fixture" } },
  }));
  await page.route(`**/api/chat/${runId}/stream*`, (route) => route.abort());
  await page.route("**/api/evolution/hq-status/cancel", (route) => {
    expect(route.request().method()).toBe("POST");
    cancelled.push(route.request().postDataJSON().runId);
    return route.fulfill({ json: { ok: true } });
  });

  await page.goto("/en/app?view=conversation");
  await page.getByRole("button", { name: "Workflows", exact: true }).click();
  const panel = page.locator("[data-companion-pod-panel]");
  await panel.getByRole("tab", { name: "Workflows", exact: true }).click();
  const stop = panel.getByRole("button", { name: "Stop", exact: true });
  const dialog = page.getByRole("dialog", { name: "Stop this answer", exact: true });
  const cancel = dialog.getByRole("button", { name: "Cancel", exact: true });
  const confirm = dialog.getByRole("button", { name: "Stop this answer", exact: true });
  const openConfirmation = async () => {
    await stop.click();
    await page.getByRole("menuitem", { name: /^Stop this answer/ }).click();
    await expect(dialog).toBeVisible();
    await expect(dialog).toHaveAccessibleDescription(
      "This answer will be interrupted; the part already on screen may not make it into the history. You can simply send it again.",
    );
    await expect(cancel).toBeFocused();
  };
  const expectNoCancellation = async () => {
    await expect(dialog).not.toBeVisible();
    await expect(panel).toBeVisible();
    await expect(stop).toBeFocused();
    // Include the popup's exit transition and queued handlers in the no-POST check.
    await page.waitForTimeout(200);
    expect(cancelled).toEqual([]);
  };

  await openConfirmation();
  expect(cancelled).toEqual([]);
  await page.keyboard.press("Shift+Tab");
  await expect(confirm).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(cancel).toBeFocused();
  await page.keyboard.press("Escape");
  await expectNoCancellation();

  await openConfirmation();
  await cancel.click();
  await expectNoCancellation();

  await openConfirmation();
  await confirm.click();
  await expect(dialog).not.toBeVisible();
  await expect(stop).toBeFocused();
  await expect.poll(() => cancelled).toEqual([runId]);
  await page.waitForTimeout(200);
  expect(cancelled).toEqual([runId]);
});
