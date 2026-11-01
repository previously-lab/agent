import { test, expect } from "./test";
import type { Page } from "@playwright/test";
import path from "node:path";
import { clearCases, clearEpisodic, makeSlice, seedCases, seedSlices } from "./memory-fixture";

// Only isolated, fictional records are read. The shared test fixture blocks
// model POSTs and all remote requests; these tests never submit a chat turn.
interface RoomSnapshot {
  sliceId: string;
  generatorVersion: number;
  profile: { activity: string; revision: string };
  roomId?: string;
  timezone?: string;
}
interface DebugHandle {
  x: number;
  z: number;
  elapsed: number;
  space: string | null;
  snapshot: RoomSnapshot | null;
  hotel: string;
  timeRoom: { roomId: string; sliceId: string | null };
}

const read = (page: Page) => page.evaluate(() => {
  const d = (window as unknown as { __gameDebug?: DebugHandle }).__gameDebug;
  if (!d) return null;
  return { x: d.x, z: d.z, elapsed: d.elapsed, space: d.space,
    snapshot: d.snapshot, hotel: d.hotel, timeRoom: d.timeRoom };
});

async function settledPaper(page: Page) {
  await expect(page.locator(".desk-shell--top .desk-paper")).toBeVisible();
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
  await expect.poll(() => page.locator("[data-desk-stage]").evaluate((stage) =>
    stage.getAnimations({ subtree: true }).every((a) => !a.pending && a.playState !== "running"),
  )).toBe(true);
  await expect.poll(() => page.locator(".desk-shell--top .typeset p").first().evaluate((p) => {
    const range = document.createRange();
    range.selectNodeContents(p);
    return Array.from(range.getClientRects()).some((r) => r.width > 0 && r.height > 0 &&
      r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight &&
      p.contains(document.elementFromPoint((r.left + r.right) / 2, (r.top + r.bottom) / 2)));
  })).toBe(true);
}

async function expectPaintedBackground(page: Page) {
  // Capture the actual canvas pixels, temporarily hiding DOM overlays. A
  // visible canvas element alone also passes when its backing store is blank.
  const png = await page.locator("canvas").first().screenshot({
    style: "body *:not(canvas):not(:has(canvas)) { visibility: hidden !important; } canvas { visibility: visible !important; }",
  });
  const colors = await page.evaluate(async (base64) => {
    const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
    const bitmap = await createImageBitmap(new Blob([bytes], { type: "image/png" }));
    const sample = new OffscreenCanvas(32, 32);
    const ctx = sample.getContext("2d")!;
    ctx.drawImage(bitmap, 0, 0, 32, 32);
    const pixels = ctx.getImageData(0, 0, 32, 32).data;
    const bins = new Set<string>();
    for (let i = 0; i < pixels.length; i += 4) {
      if (pixels[i + 3] > 128) bins.add(`${pixels[i] >> 4},${pixels[i + 1] >> 4},${pixels[i + 2] >> 4}`);
    }
    bitmap.close();
    return bins.size;
  }, png.toString("base64"));
  expect(colors).toBeGreaterThan(8);
}

test.describe("Room context from real records", () => {
  test.beforeEach(async () => { await clearCases(); await clearEpisodic(); });
  test.afterEach(async () => { await clearCases(); await clearEpisodic(); });

  test("record activities keep one fixed v2 room across time", async ({ page }) => {
    test.setTimeout(180_000);
    const fixtures = [
      { slice: makeSlice("2026-02-01T09:00:00.000Z", { focus: "Rewrite the ending of my short story.", summary: "We revised the manuscript." }), activity: "writing" },
      { slice: makeSlice("2026-02-01T10:00:00.000Z", { focus: "研究文献，核对论文资料和引用。", summary: "比较研究资料与论文证据。" }), activity: "research" },
      { slice: makeSlice("2026-02-01T11:00:00.000Z", { focus: "Implement and debug the application.", summary: "We implemented the new API and fixed the code." }), activity: "making" },
    ];
    await seedSlices(fixtures.map((fixture) => fixture.slice));
    await page.goto("/en/game");
    const canvas = await page.locator("canvas").first().elementHandle();
    let architecture: { hotel: string; roomId: string; x: number; z: number } | null = null;
    const newestFirst = [...fixtures].reverse();
    for (let index = 0; index < newestFirst.length; index += 1) {
      const fixture = newestFirst[index]!;
      await expect.poll(async () => (await read(page))?.snapshot?.sliceId, { timeout: 60_000 }).toBe(fixture.slice.id);
      await expect.poll(async () => (await read(page))?.snapshot?.profile.activity, { timeout: 30_000 }).toBe(fixture.activity);
      const current = (await read(page))!;
      expect(current.snapshot?.generatorVersion).toBe(2);
      expect(current.snapshot?.roomId).toBe("default-indoor-room-v1");
      expect(current.timeRoom.roomId).toBe(current.snapshot?.roomId);
      const nextArchitecture = { hotel: current.hotel, roomId: current.timeRoom.roomId, x: current.x, z: current.z };
      if (architecture) expect(nextArchitecture).toEqual(architecture);
      architecture = nextArchitecture;
      expect(await page.locator("canvas").first().evaluate((node, before) => node === before, canvas)).toBe(true);
      if (process.env.E2E_ROOM_ART_OUTPUT) {
        await expect.poll(async () => (await read(page))?.elapsed ?? 0).toBeGreaterThan(current.elapsed + 1);
        await page.screenshot({
          path: path.join(process.env.E2E_ROOM_ART_OUTPUT, `fixed-${fixture.activity}.png`),
          style: "nextjs-portal { visibility: hidden !important; }",
        });
      }
      if (index < newestFirst.length - 1) await page.locator("[data-game-time-prev]").click();
    }
  });

  test("a late profile updates the current fixed room without moving it", async ({ page }) => {
    test.setTimeout(120_000);
    const slice = makeSlice("2026-02-02T09:00:00.000Z", { focus: "Research the history using academic sources.", summary: "Compare the research papers." });
    await seedSlices([slice]);
    let held = false;
    let delivered = false;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    await page.route("**/en/game**", async (route) => {
      const request = route.request();
      if (request.method() !== "POST" || !request.headers()["next-action"]) {
        await route.fallback();
        return;
      }
      const response = await route.fetch();
      const body = await response.body();
      const text = body.toString();
      if (!held && text.includes("\"activity\"") && text.includes("\"revision\"")) {
        held = true;
        await gate;
        await route.fulfill({ response, body });
        delivered = true;
      } else {
        await route.fulfill({ response, body });
      }
    });
    try {
      await page.goto("/en/game");
      await expect.poll(() => held, { timeout: 60_000 }).toBe(true);
      await expect.poll(async () => (await read(page))?.snapshot?.sliceId, { timeout: 60_000 }).toBe(slice.id);
      const before = (await read(page))!;
      expect(before.snapshot?.profile.activity).toBe("neutral");
      release();
      await expect.poll(() => delivered).toBe(true);
      await expect.poll(async () => (await read(page))?.snapshot?.profile.activity, { timeout: 30_000 }).toBe("research");
      const after = (await read(page))!;
      expect(after.snapshot?.generatorVersion).toBe(2);
      expect(after.snapshot?.roomId).toBe(before.snapshot?.roomId);
      expect(after.timeRoom).toEqual(before.timeRoom);
      expect({ x: after.x, z: after.z }).toEqual({ x: before.x, z: before.z });
    } finally {
      release();
      await page.unrouteAll({ behavior: "wait" });
    }
  });

  test("reading, scrolling and resizing preserve the paused scene and resume the same room", async ({ page }) => {
    test.setTimeout(120_000);
    const slice = makeSlice("2026-02-03T09:00:00.000Z", { focus: "Write a short story and revise the manuscript.", summary: "Writing a fictional manuscript." });
    await seedSlices([slice]);
    await seedCases([{ category: "research", name: "room-pause-paper", opened: "2026-02-03", pieces: [],
      body: "ROOM PAUSE PAPER — a fictional page for the reading pause.\n\nThe scene waits while this paper is read." }]);
    await page.goto("/en/game");
    await expect.poll(async () => (await read(page))?.snapshot?.sliceId, { timeout: 60_000 }).toBe(slice.id);
    await page.locator("[data-pill-expand]").click();
    await page.locator(".conversation-panel-heading .workspace-route-nav").getByRole("button", { name: "Library", exact: true }).click();
    await expect(page.locator('[data-workspace-surface="library"]')).toBeVisible();
    await page.getByRole("button", { name: /^Research/ }).click();
    await page.getByRole("button", { name: /room-pause-paper/ }).click();
    await expect(page.locator('[data-workspace-surface="reader"]')).toBeVisible();
    const host = page.locator("[data-workspace-game-host]");
    await expect(host).toBeHidden();
    await expect(host).toHaveAttribute("inert", "");
    const frozen = await read(page);
    expect(frozen?.snapshot?.sliceId).toBe(slice.id);
    await settledPaper(page);
    await page.mouse.move(640, 360);
    await page.mouse.wheel(0, 24);
    await page.setViewportSize({ width: 900, height: 650 });
    // No extra scroll may be needed to restore the reader after resize.
    await settledPaper(page);
    const paused = await read(page);
    expect({ x: paused?.x, z: paused?.z, elapsed: paused?.elapsed, snapshot: paused?.snapshot })
      .toEqual({ x: frozen?.x, z: frozen?.z, elapsed: frozen?.elapsed, snapshot: frozen?.snapshot });
    await page.locator(".workspace-reader-nav .workspace-route-nav").getByRole("button", { name: "Room", exact: true }).click();
    await expect(page).toHaveURL(/\/en\/game$/);
    await expect(host).toBeVisible();
    await expect(host).toHaveAttribute("data-game-active", "true");
    await expect.poll(async () => (await read(page))?.elapsed ?? 0).toBeGreaterThan(frozen!.elapsed);
    const resumed = await read(page);
    expect(resumed?.snapshot).toEqual(frozen?.snapshot);
    expect(resumed?.x).toBeCloseTo(frozen!.x, 4);
    expect(resumed?.z).toBeCloseTo(frozen!.z, 4);
    await expectPaintedBackground(page);
  });
});
