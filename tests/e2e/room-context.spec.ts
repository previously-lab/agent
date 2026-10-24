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
  roomDoorCount: number;
  corridorSide: string;
}
interface Door { sliceId: string; x: number; z: number }
interface DebugHandle {
  x: number;
  z: number;
  elapsed: number;
  fadeT: number;
  space: string | null;
  snapshot: RoomSnapshot | null;
  windowDoors: Door[];
  room: null | { sliceId: string; modules: string[]; pieces: number[][] };
  teleport?: (x: number, z: number) => void;
}

const read = (page: Page) => page.evaluate(() => {
  const d = (window as unknown as { __gameDebug?: DebugHandle }).__gameDebug;
  if (!d) return null;
  return { x: d.x, z: d.z, elapsed: d.elapsed, space: d.space,
    snapshot: d.snapshot, windowDoors: d.windowDoors, room: d.room, fadeT: d.fadeT };
});

const teleport = (page: Page, x: number, z: number) => page.evaluate(([px, pz]) => {
  (window as unknown as { __gameDebug?: DebugHandle }).__gameDebug?.teleport?.(px, pz);
}, [x, z] as const);

async function doorFor(page: Page, id: string): Promise<Door> {
  await expect.poll(async () => (await read(page))?.windowDoors.some((d) => d.sliceId === id),
    { timeout: 60_000 }).toBe(true);
  return (await read(page))!.windowDoors.find((d) => d.sliceId === id)!;
}

async function enter(page: Page, door: Door): Promise<DebugHandle> {
  let entered: DebugHandle | null = null;
  // A pending profile clamps the approach. Retry the physical crossing once
  // it becomes ready, exactly as continuing to walk towards the door does.
  await expect.poll(async () => {
    const state = await read(page);
    if (state?.space === door.sliceId && state.room?.sliceId === door.sliceId &&
      state.snapshot?.sliceId === door.sliceId) {
      entered = state;
      return true;
    }
    await teleport(page, door.x, door.z + Math.sign(door.z) * 0.4);
    return false;
  }, { timeout: 60_000, intervals: [300] }).toBe(true);
  return entered!;
}

async function leave(page: Page, door: Door) {
  // The DOM owner and canvas portal commit separately. Finish the visible
  // visit, then wait for the actual fade-out handshake before a new crossing.
  await expect.poll(async () => (await read(page))?.fadeT).toBe(1);
  await teleport(page, door.x, 0);
  await expect.poll(async () => {
    const state = await read(page);
    return state?.space === null && state.fadeT === 0;
  }).toBe(true);
}

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

  test("record activities produce distinct rooms and preserve a room on re-entry", async ({ page }) => {
    test.setTimeout(180_000);
    const fixtures = [
      { slice: makeSlice("2026-02-01T09:00:00.000Z", { focus: "Rewrite the ending of my short story.", summary: "We revised the manuscript." }), activity: "writing", module: "study" },
      { slice: makeSlice("2026-02-01T10:00:00.000Z", { focus: "研究文献，核对论文资料和引用。", summary: "比较研究资料与论文证据。" }), activity: "research", module: "reading-room" },
      { slice: makeSlice("2026-02-01T11:00:00.000Z", { focus: "Implement and debug the application.", summary: "We implemented the new API and fixed the code." }), activity: "making", module: "workshop" },
    ];
    await seedSlices(fixtures.map((f) => f.slice));
    await page.goto("/en/app");
    for (const fixture of fixtures) {
      const door = await doorFor(page, fixture.slice.id);
      const first = await enter(page, door);
      expect(first.snapshot?.profile.activity).toBe(fixture.activity);
      expect(first.room?.modules).toContain(fixture.module);
      if (process.env.E2E_ROOM_ART_OUTPUT) {
        await expect.poll(async () => (await read(page))?.elapsed ?? 0)
          .toBeGreaterThan(first.elapsed + 1);
        await page.screenshot({
          path: path.join(process.env.E2E_ROOM_ART_OUTPUT, `illustrated-${fixture.activity}.png`),
          style: "nextjs-portal { visibility: hidden !important; }",
        });
      }
      await leave(page, door);
      const second = await enter(page, door);
      expect(second.snapshot).toEqual(first.snapshot);
      expect(second.room?.pieces).toEqual(first.room?.pieces);
      await leave(page, door);
    }
  });

  test("a delayed profile holds the threshold and a late result cannot replace an explicit basic room", async ({ page }) => {
    test.setTimeout(120_000);
    const slice = makeSlice("2026-02-02T09:00:00.000Z", { focus: "Research the history using academic sources.", summary: "Compare the research papers." });
    await seedSlices([slice]);
    let held = false;
    let delivered = false;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    await page.route("**/en/app**", async (route) => {
      const request = route.request();
      if (request.method() !== "POST" || !request.headers()["next-action"]) {
        await route.fallback();
        return;
      }
      const response = await route.fetch();
      const body = await response.body();
      if (!held && body.toString().includes("room-activity-rules-v1")) {
        held = true;
        await gate;
        await route.fulfill({ response, body });
        delivered = true;
      } else {
        await route.fulfill({ response, body });
      }
    });
    try {
      await page.goto("/en/app");
      const door = await doorFor(page, slice.id);
      await teleport(page, door.x, door.z + Math.sign(door.z) * 0.4);
      await expect.poll(() => held, { timeout: 30_000 }).toBe(true);
      await expect.poll(async () => {
        const d = await read(page);
        return !!d && d.space === null && d.snapshot === null &&
          Math.abs(d.x - door.x) < 0.5 && Math.abs(d.z) <= Math.abs(door.z) + 0.19;
      }).toBe(true);
      // The real loader's bounded deadline supplies this recovery UI.
      await page.getByRole("button", { name: "Enter a basic room" }).click({ timeout: 20_000 });
      const basic = await enter(page, door);
      expect(basic.snapshot?.profile.activity).toBe("neutral");
      release();
      await expect.poll(() => delivered).toBe(true);
      await expect.poll(async () => (await read(page))?.elapsed ?? 0).toBeGreaterThan(basic.elapsed + 0.3);
      const after = await read(page);
      expect(after?.snapshot).toEqual(basic.snapshot);
      expect(after?.room?.pieces).toEqual(basic.room?.pieces);
      expect(after?.x).toBeCloseTo(basic.x, 4);
      expect(after?.z).toBeCloseTo(basic.z, 4);
      await leave(page, door);
      const research = await enter(page, door);
      expect(research.snapshot?.profile.activity).toBe("research");
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
    await page.goto("/en/app");
    await enter(page, await doorFor(page, slice.id));
    await page.locator("[data-game-manuscripts]").click();
    await expect(page.locator('[data-app-world="field"][data-scene-suspended="true"]')).toBeVisible();
    const frozen = await read(page);
    expect(frozen?.snapshot?.sliceId).toBe(slice.id);
    await page.locator('[data-archive-pile="research/room-pause-paper"]').click();
    await settledPaper(page);
    await page.mouse.move(640, 360);
    await page.mouse.wheel(0, 24);
    await page.setViewportSize({ width: 900, height: 650 });
    // No extra scroll may be needed to restore the reader after resize.
    await settledPaper(page);
    await expectPaintedBackground(page);
    const paused = await read(page);
    expect({ x: paused?.x, z: paused?.z, elapsed: paused?.elapsed, snapshot: paused?.snapshot })
      .toEqual({ x: frozen?.x, z: frozen?.z, elapsed: frozen?.elapsed, snapshot: frozen?.snapshot });
    await page.locator("[data-scene-resume]").click();
    await expect(page.locator('[data-app-world="game"]')).toBeVisible();
    await expect.poll(async () => (await read(page))?.elapsed ?? 0).toBeGreaterThan(frozen!.elapsed);
    const resumed = await read(page);
    expect(resumed?.snapshot).toEqual(frozen?.snapshot);
    expect(resumed?.x).toBeCloseTo(frozen!.x, 4);
    expect(resumed?.z).toBeCloseTo(frozen!.z, 4);
  });
});
