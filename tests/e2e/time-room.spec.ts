import type { ElementHandle, Page } from "@playwright/test";
import { test, expect } from "./test";
import {
  clearCases,
  clearEpisodic,
  makeSlice,
  seedCases,
  seedSlices,
} from "./memory-fixture";

interface RoomSnapshot {
  sliceId: string;
  generatorVersion: number;
  roomId?: string;
  timezone?: string;
  profile: { activity: string };
}

interface DebugHandle {
  x: number;
  z: number;
  elapsed: number;
  hotel: string;
  snapshot: RoomSnapshot | null;
  papers: { ref: string; x: number; z: number }[];
  timeRoom: {
    roomId: string;
    sliceId: string | null;
    atmosphere: string;
    timezone: string;
    previousSliceId: string | null;
    nextSliceId: string | null;
  };
  camera: {
    yaw: number;
    camX: number;
    camY: number;
    camZ: number;
    dist: number;
    walking: boolean;
  };
}

interface PostedChatBody {
  view?: {
    sliceId?: string;
    surface?: string;
    snapshot?: RoomSnapshot;
  };
}

function readRoom(page: Page) {
  return page.evaluate(() => {
    const d = (window as unknown as { __gameDebug?: DebugHandle }).__gameDebug;
    if (!d) return null;
    return {
      x: d.x,
      z: d.z,
      elapsed: d.elapsed,
      hotel: d.hotel,
      snapshot: d.snapshot,
      papers: d.papers.map((paper) => ({ ...paper })),
      timeRoom: { ...d.timeRoom },
      camera: {
        yaw: d.camera.yaw,
        camX: d.camera.camX,
        camY: d.camera.camY,
        camZ: d.camera.camZ,
        dist: d.camera.dist,
        walking: d.camera.walking,
      },
    };
  });
}

async function projectPoint(page: Page, x: number, z: number) {
  return page.evaluate(([px, pz]) => {
    const d = (window as unknown as { __gameDebug?: DebugHandle }).__gameDebug;
    return d?.camera && "projectPoint" in d.camera
      ? (d.camera as unknown as { projectPoint?: (x: number, y: number, z: number) => { sx: number; sy: number } | null }).projectPoint?.(px, 0, pz) ?? null
      : null;
  }, [x, z] as const);
}

async function waitForCameraSettled(page: Page): Promise<void> {
  let previous: DebugHandle["camera"] | null = null;
  await expect.poll(async () => {
    const current = (await readRoom(page))?.camera ?? null;
    if (!current || current.walking) {
      previous = current;
      return false;
    }
    const stable = previous !== null && !previous.walking &&
      (["yaw", "camX", "camY", "camZ", "dist"] as const).every((key) => Math.abs(current[key] - previous![key]) < 0.001);
    previous = current;
    return stable;
  }, { timeout: 30_000, intervals: [250] }).toBe(true);
}

function localTime(iso: string): string {
  return new Intl.DateTimeFormat("en", {
    timeZone: "Asia/Shanghai",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(iso));
}

function offlineSse(answer: string): string {
  const chunks = [
    { type: "start", messageId: "time-room-fixture-reply" },
    { type: "text-start", id: "text" },
    { type: "text-delta", id: "text", delta: answer },
    { type: "text-end", id: "text" },
    { type: "finish" },
  ];
  return `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}

`).join("")}data: [DONE]

`;
}

async function expectSameCanvas(page: Page, original: ElementHandle | null): Promise<void> {
  expect(original).not.toBeNull();
  expect(await page.locator("canvas").first().evaluate((current, before) => current === before, original)).toBe(true);
}

test.describe("persistent time room", () => {
  test.use({
    timezoneId: "Asia/Shanghai",
    viewport: { width: 1440, height: 1000 },
  });

  test.afterEach(async () => {
    await clearCases();
    await clearEpisodic();
  });

  test("time changes update papers and atmosphere without moving or remounting the room", async ({ page }, testInfo) => {
    test.setTimeout(180_000);
    await page.emulateMedia({ reducedMotion: "reduce" });
    const winter = makeSlice("2026-02-01T06:00:00.000Z", { tag: "WINTER-ROOM" });
    const summer = makeSlice("2026-07-01T10:00:00.000Z", { tag: "SUMMER-ROOM" });
    await seedSlices([winter, summer]);
    await seedCases([{
      category: "research",
      name: "winter-room-paper",
      opened: "2026-02-01",
      body: `A paper from the winter slice.

(refs: ${winter.id})`,
      pieces: [],
    }]);
    const posts: PostedChatBody[] = [];
    await page.route("**/api/chat", async (route) => {
      if (route.request().method() !== "POST") {
        await route.fallback();
        return;
      }
      posts.push(route.request().postDataJSON() as PostedChatBody);
      await route.fulfill({ contentType: "text/event-stream", body: offlineSse("Time room reply") });
    });

    await page.goto("/en/game");
    await expect(page.locator("[data-game-time-navigation]")).toBeVisible({ timeout: 60_000 });
    await expect.poll(async () => (await readRoom(page))?.snapshot?.sliceId, { timeout: 60_000 }).toBe(summer.id);
    await expect.poll(async () => (await readRoom(page))?.papers.length ?? 0).toBe(1);
    await expect.poll(async () => (await readRoom(page))?.elapsed ?? 0).toBeGreaterThan(1);
    const canvas = page.locator("canvas").first();
    const originalCanvas = await canvas.elementHandle();
    const start = (await readRoom(page))!;
    const walkTarget = { x: start.x + 1.25, z: start.z };
    const walkPoint = await projectPoint(page, walkTarget.x, walkTarget.z);
    expect(walkPoint).not.toBeNull();
    expect(await page.evaluate(([x, y]) => Boolean(document.elementFromPoint(x!, y!)?.closest("[data-game-pointer-surface]")), [walkPoint!.sx, walkPoint!.sy] as const)).toBe(true);
    await page.mouse.click(walkPoint!.sx, walkPoint!.sy);
    await expect.poll(async () => {
      const current = await readRoom(page);
      return current ? Math.hypot(current.x - start.x, current.z - start.z) : 0;
    }, { timeout: 30_000 }).toBeGreaterThan(0.25);
    await expect.poll(async () => (await readRoom(page))?.camera.walking, { timeout: 30_000 }).toBe(false);
    await waitForCameraSettled(page);
    const before = (await readRoom(page))!;
    expect(before.snapshot).toMatchObject({
      generatorVersion: 2,
      roomId: "default-indoor-room-v1",
      timezone: "Asia/Shanghai",
    });
    expect(before.timeRoom.atmosphere).toMatch(/^summer\/dusk\//);
    expect(before.papers.map((paper) => paper.ref)).toEqual([`records/${summer.id}`]);
    await expect(page.locator("[data-game-time-navigation]")).toContainText(localTime(summer.start));
    await testInfo.attach("room-summer", {
      body: await page.screenshot({ path: testInfo.outputPath("room-summer.png") }),
      contentType: "image/png",
    });

    await page.locator("[data-game-time-prev]").click();
    await expect.poll(async () => (await readRoom(page))?.snapshot?.sliceId).toBe(winter.id);
    await expect.poll(async () => (await readRoom(page))?.papers.length ?? 0, { timeout: 30_000 }).toBe(2);
    await expect.poll(async () => (await readRoom(page))?.elapsed ?? 0).toBeGreaterThan(before.elapsed + 1);
    await waitForCameraSettled(page);
    const after = (await readRoom(page))!;
    await testInfo.attach("room-winter", {
      body: await page.screenshot({ path: testInfo.outputPath("room-winter.png") }),
      contentType: "image/png",
    });

    expect(after.snapshot).toMatchObject({
      sliceId: winter.id,
      generatorVersion: 2,
      roomId: before.snapshot?.roomId,
      timezone: "Asia/Shanghai",
    });
    expect(after.timeRoom).toMatchObject({
      roomId: before.timeRoom.roomId,
      sliceId: winter.id,
      timezone: "Asia/Shanghai",
      previousSliceId: null,
      nextSliceId: summer.id,
    });
    expect(after.timeRoom.atmosphere).toMatch(/^winter\/day\//);
    expect(after.hotel).toBe(before.hotel);
    expect({ x: after.x, z: after.z }).toEqual({ x: before.x, z: before.z });
    for (const key of ["yaw", "camX", "camY", "camZ", "dist"] as const) {
      expect(Math.abs(after.camera[key] - before.camera[key])).toBeLessThanOrEqual(0.005);
    }
    expect(after.camera.walking).toBe(false);
    expect(after.papers.map((paper) => paper.ref)).toEqual([
      `records/${winter.id}`,
      "research/winter-room-paper",
    ]);
    expect({ x: after.papers[0]!.x, z: after.papers[0]!.z }).toEqual({ x: before.papers[0]!.x, z: before.papers[0]!.z });
    await expectSameCanvas(page, originalCanvas);
    await expect(page.locator("[data-game-slice]")).toHaveAttribute("data-game-slice", winter.id);
    await expect(page.locator("[data-game-atmosphere]")).toHaveAttribute("data-game-atmosphere", after.timeRoom.atmosphere);
    await expect(page.locator("[data-game-timezone]")).toHaveAttribute("data-game-timezone", "Asia/Shanghai");
    await expect(page.locator("[data-game-time-navigation]")).toContainText(localTime(winter.start));
    const paperPoint = await projectPoint(page, after.papers[0]!.x, after.papers[0]!.z);
    expect(paperPoint).not.toBeNull();
    await page.mouse.click(paperPoint!.sx, paperPoint!.sy);
    await expect(page.locator("[data-desk-stack]")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText("TURN WINTER-ROOM user question", { exact: false }).first()).toBeVisible();
    await page.locator("[data-desk-close]").click();
    await expect(page.locator("[data-workspace-game-host][data-game-active]")).toBeVisible();
    await expect.poll(async () => (await readRoom(page))?.snapshot?.sliceId).toBe(winter.id);

    const input = page.locator("[data-manuscript-input]");
    await expect(input).toBeVisible();
    await input.fill("Send the current winter room context");
    await input.press("Enter");
    await expect(page.getByText("Time room reply", { exact: true })).toBeVisible({ timeout: 30_000 });
    expect(posts).toHaveLength(1);
    expect(posts[0]?.view).toMatchObject({
      sliceId: winter.id,
      surface: "room",
      snapshot: {
        sliceId: winter.id,
        generatorVersion: 2,
        roomId: "default-indoor-room-v1",
        timezone: "Asia/Shanghai",
      },
    });
  });

for (const delayed of ["profile", "papers"] as const) {
  test(`fullscreen holds late ${delayed} results until resume`, async ({ page }) => {
    test.setTimeout(180_000);
    const slice = makeSlice("2026-02-02T06:00:00.000Z", {
      focus: "Research the history using academic sources.",
      summary: "Compare the research papers.",
    });
    await seedSlices([slice]);
    await seedCases([{
      category: "research",
      name: "freeze-room-paper",
      opened: "2026-02-02",
      body: `A delayed paper for the frozen room.\n\n(refs: ${slice.id})`,
      pieces: [],
    }]);
    let releaseTarget!: () => void;
    const targetGate = new Promise<void>((resolve) => { releaseTarget = resolve; });
    let targetHeld = false;
    let targetDelivered = false;
    let profileResponses = 0;
    let paperResponses = 0;
    await page.route("**/en/game**", async (route) => {
      const request = route.request();
      if (request.method() !== "POST" || !request.headers()["next-action"]) {
        await route.fallback();
        return;
      }
      const response = await route.fetch();
      const body = await response.body();
      const text = body.toString();
      const isProfile = text.includes("\"activity\"") && text.includes("\"revision\"");
      const isPaper = text.includes("freeze-room-paper");
      if (isProfile) profileResponses += 1;
      if (isPaper) paperResponses += 1;
      const shouldHold = !targetHeld && ((delayed === "profile" && isProfile) || (delayed === "papers" && isPaper));
      if (shouldHold) {
        targetHeld = true;
        await targetGate;
        await route.fulfill({ response, body });
        targetDelivered = true;
      } else {
        await route.fulfill({ response, body });
      }
    });
    const posts: PostedChatBody[] = [];
    await page.route("**/api/chat", async (route) => {
      if (route.request().method() !== "POST") {
        await route.fallback();
        return;
      }
      posts.push(route.request().postDataJSON() as PostedChatBody);
      await route.fulfill({ contentType: "text/event-stream", body: offlineSse("Frozen room reply") });
    });

    try {
      await page.goto("/en/game");
      await expect.poll(() => targetHeld, { timeout: 60_000 }).toBe(true);
      expect(delayed === "profile" ? profileResponses : paperResponses).toBeGreaterThan(0);
      await expect.poll(async () => (await readRoom(page))?.snapshot?.sliceId, { timeout: 60_000 }).toBe(slice.id);
      await page.locator("[data-pill-expand]").click();
      await expect(page.locator(".conversation-panel")).toHaveAttribute("data-panel-tier", "fullscreen");
      const frozen = (await readRoom(page))!;
      expect(frozen.snapshot?.generatorVersion).toBe(2);

      releaseTarget();
      await expect.poll(() => targetDelivered).toBe(true);
      await expect.poll(() => profileResponses).toBeGreaterThan(0);
      await expect.poll(() => paperResponses).toBeGreaterThan(0);
      await page.waitForTimeout(350);
      const stillFrozen = (await readRoom(page))!;
      expect(stillFrozen.snapshot).toEqual(frozen.snapshot);
      expect(stillFrozen.timeRoom).toEqual(frozen.timeRoom);
      expect(stillFrozen.papers).toEqual(frozen.papers);

      const input = page.locator("[data-manuscript-input]");
      await input.fill("Send the frozen room snapshot");
      await input.press("Enter");
      await expect(page.getByText("Frozen room reply", { exact: true })).toBeVisible({ timeout: 30_000 });
      expect(posts).toHaveLength(1);
      expect(posts[0]?.view?.snapshot).toEqual(frozen.snapshot);

      await page.getByRole("button", { name: "Exit full screen" }).click();
      await expect.poll(async () => (await readRoom(page))?.snapshot?.profile, { timeout: 30_000 }).toMatchObject({ activity: "research" });
      await expect.poll(async () => (await readRoom(page))?.papers.length ?? 0, { timeout: 30_000 }).toBe(2);
      expect((await readRoom(page))?.snapshot?.sliceId).toBe(slice.id);
    } finally {
      releaseTarget();
      await page.unrouteAll({ behavior: "wait" });
    }
  });
}
});
