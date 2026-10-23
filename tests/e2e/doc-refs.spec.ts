import { test, expect } from "./test";
import type { Page } from "@playwright/test";
import {
  clearCases,
  clearEpisodic,
  makeSlice,
  seedCases,
  seedSlices,
} from "./memory-fixture";

/**
 * In-paper reference links + the room's loose papers (v0.25a §五):
 *
 * LINKS — a case document's candidate references print as links once the
 * server verify pass finds them alive (a click swaps the desk's paper); a
 * dead reference stays visible as a dashed-underline span, never a button.
 *
 * STAMP — a `(refs: <sliceId>)` stamp links to the record paper. (The
 * footer's scene line is GONE since v0.28: the hotel left the paper — the
 * room belongs to the scene viewer, never to the document.)
 *
 * ROOM PAPERS — the slice's room carries its own record sheet plus the
 * documents that stamped it, flat on the floor; walking up (teleport — the
 * e2e GL budget never allows walking) and interacting opens the sheet in
 * the original manuscript.
 *
 * All data is seeded straight into the isolated MEMORY_ROOT (see
 * memory-fixture.ts); no chat turn ever runs.
 */

const DAY = 24 * 3600_000;

/** A UTC ISO `daysAgo` back — closed, days old: the arrival gate stays calm. */
function daysAgoIso(daysAgo: number, hour = 9): string {
  const d = new Date(Date.now() - daysAgo * DAY);
  return new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), hour),
  ).toISOString();
}

interface DebugHandle {
  space: string | null;
  x: number;
  z: number;
  windowDoors: { sliceId: string; x: number; z: number; side: string }[];
  papers: { ref: string; x: number; z: number }[];
  camera?: {
    projectPoint?: (x: number, y: number, z: number) => { sx: number; sy: number } | null;
  };
  teleport?: (x: number, z: number) => void;
}

function dbg(page: Page) {
  return {
    read: () =>
      page.evaluate(() => (window as unknown as { __gameDebug?: DebugHandle }).__gameDebug),
    teleport: (x: number, z: number) =>
      page.evaluate(
        ([px, pz]) =>
          (window as unknown as { __gameDebug?: DebugHandle }).__gameDebug?.teleport?.(px, pz),
        [x, z] as const,
      ),
    project: (x: number, z: number) =>
      page.evaluate(
        ([px, pz]) =>
          (window as unknown as { __gameDebug?: DebugHandle }).__gameDebug?.camera?.projectPoint?.(px, 0, pz) ?? null,
        [x, z] as const,
      ),
  };
}

/** Seed the scene slice + the source case citing it, and open the source
 *  case on the desk. Returns the slice id. */
async function openSourceCase(page: Page): Promise<{ sliceId: string }> {
  const scene = makeSlice(daysAgoIso(1, 9), { tag: "SCN" });
  await seedSlices([scene]);
  await seedCases([
    { category: "things", name: "target-case", opened: daysAgoIso(2).slice(0, 10), pieces: [] },
    {
      category: "research",
      name: "source-case",
      opened: daysAgoIso(1).slice(0, 10),
      body: [
        "这起案件的结论见 things/target-case 的整备。",
        "",
        "对照组 research/ghost-case 已经不在了。",
        "",
        `(refs: ${scene.id})`,
      ].join("\n"),
      pieces: [],
    },
  ]);
  await page.goto("/en/app?view=field");
  const pile = page.locator('[data-archive-pile="research/source-case"]');
  await expect(pile).toBeVisible({ timeout: 30_000 });
  await pile.click();
  await expect(page.locator("[data-desk-stack]")).toBeVisible({
    timeout: 30_000,
  });
  return { sliceId: scene.id };
}

test.describe("In-paper reference links", () => {
  test.afterEach(async () => {
    await clearCases();
    await clearEpisodic();
  });

  test("a live case ref prints as a link that swaps the paper; a dead ref stays a dashed span", async ({
    page,
  }) => {
    await openSourceCase(page);

    // The verify pass resolves async — the candidate first prints as plain
    // text, then inks as a link. The dead one never becomes a button.
    const live = page.locator('button.doc-ref[data-ref="things/target-case"]');
    await expect(live.first()).toBeVisible({ timeout: 30_000 });
    const dead = page.locator('.doc-ref--dead[data-ref="research/ghost-case"]');
    await expect(dead.first()).toBeVisible({ timeout: 30_000 });
    expect(await dead.first().evaluate((el) => el.tagName)).toBe("SPAN");

    // A click swaps the desk's paper to the cited case.
    await live.first().click();
    await expect(
      page.getByText("Case target-case — the seeded index.").first(),
    ).toBeVisible({ timeout: 30_000 });
  });

  test("the (refs:) stamp links to the record paper", async ({
    page,
  }) => {
    const { sliceId } = await openSourceCase(page);

    // The stamp's slice id inks as a record link; clicking it opens the
    // transcript paper (speaker labels + the seeded turns).
    const stamp = page.locator(`button.doc-ref[data-ref="records/${sliceId}"]`);
    await expect(stamp.first()).toBeVisible({ timeout: 30_000 });
    await stamp.first().click();
    await expect(
      page.getByText("TURN SCN user question", { exact: false }).first(),
    ).toBeVisible({ timeout: 30_000 });

    // The hotel left the paper (v0.28): no scene line prints anywhere on
    // the sheet — the room belongs to the scene viewer, not the document.
    await expect(page.locator("[data-desk-place]")).toHaveCount(0);
    // Related travel follows the open record even when the world cursor has
    // never been set. Reading alone must not silently move that cursor.
    await page.getByRole("button", { name: "Related scenario" }).click();
    await page.getByRole("menuitem", { name: "Go to this record’s room" }).click();
    await expect(page.locator('[data-app-world="game"]')).toBeVisible({ timeout: 30_000 });
    await expect(page.locator("[data-desk-field]")).toHaveCount(0);
    await expect.poll(() => dbg(page).read().then((d) => {
      const door = d?.windowDoors.find((entry) => entry.sliceId === sliceId);
      return door && d ? Math.abs(d.x - door.x) : 999;
    }), { timeout: 30_000 }).toBeLessThan(1);
  });

  test("the room carries its papers and a sheet opens in the manuscript", async ({
    page,
  }) => {
    // Three pickups and resumes share one real WebGL world. Software-rendered
    // browser runs need room for each transition; assertion limits stay local.
    test.setTimeout(120_000);
    const scene = makeSlice(daysAgoIso(1, 9), { tag: "SCN" });
    await seedSlices([scene]);
    await seedCases([
      {
        category: "research",
        name: "stamping-case",
        opened: daysAgoIso(1).slice(0, 10),
        body: `这份文档记录了现场。\n\n(refs: ${scene.id})`,
        pieces: [],
      },
    ]);

    await page.goto("/en/app?view=game");
    // The canvas (dynamic chunk) mounts when the corridor's doors resolve.
    await expect
      .poll(() => dbg(page).read().then((d) => d !== undefined), {
        timeout: 60_000,
      })
      .toBe(true);

    // Into the room: teleport past the wall plane at the slice's door (the
    // crossing check is positional — |z| beyond the wall inside the door's
    // grab range), then wait for the space to engage.
    const door = await dbg(page)
      .read()
      .then((d) => d?.windowDoors.find((w) => w.sliceId === scene.id));
    expect(door).toBeDefined();
    await dbg(page).teleport(door!.x, door!.z * 1.2);
    await expect
      .poll(() => dbg(page).read().then((d) => d?.space ?? null), {
        timeout: 60_000,
      })
      .toBe(scene.id);

    // The room's papers resolve async: the record sheet first, then the
    // stamping case.
    await expect
      .poll(() => dbg(page).read().then((d) => d?.papers.length ?? 0), {
        timeout: 30_000,
      })
      .toBe(2);

    // Stand on the record sheet and read it: the desk opens on the
    // transcript, the game world waiting behind it.
    const paper = await dbg(page).read().then((d) => d!.papers[0]);
    expect(paper.ref).toBe(`records/${scene.id}`);
    await dbg(page).teleport(paper.x, paper.z);
    await expect
      .poll(
        () =>
          dbg(page)
            .read()
            .then((d) =>
              d ? Math.hypot(d.x - paper.x, d.z - paper.z) : 999,
            ),
        { timeout: 30_000 },
      )
      .toBeLessThan(0.5);
    await expect(page.locator('[data-game-interact="paper"]')).toBeVisible();
    await page.keyboard.press("Enter");

    await expect(page.locator("[data-desk-stack]")).toBeVisible({
      timeout: 30_000,
    });
    await expect(
      page.getByText("TURN SCN user question", { exact: false }).first(),
    ).toBeVisible({ timeout: 30_000 });
    const paused = await dbg(page).read();
    await page.keyboard.down("w");
    // Give the input/frame loops time to observe W while reading is open.
    await page.waitForTimeout(350);
    await page.keyboard.up("w");
    const stillPaused = await dbg(page).read();
    expect(stillPaused?.x).toBe(paused?.x);
    expect(stillPaused?.z).toBe(paused?.z);
    expect(stillPaused?.space).toBe(scene.id);
    await page.locator("[data-scene-resume]").click();
    await expect(page.locator('[data-game-interact="paper"]')).toBeVisible();
    const resumed = await dbg(page).read();
    expect(resumed?.x).toBe(paused?.x);
    expect(resumed?.z).toBe(paused?.z);
    expect(resumed?.space).toBe(scene.id);
    // The same nearby sheet can be picked up with E after resuming.
    await page.keyboard.press("e");
    await expect(page.locator("[data-desk-stack]")).toBeVisible();
    await page.locator("[data-desk-close]").click();
    await expect(page.locator('[data-app-world="game"]')).toBeVisible();
    await expect(page.locator('[data-game-interact="paper"]')).toBeVisible();
    const putDown = await dbg(page).read();
    expect(putDown?.x).toBe(paused?.x);
    expect(putDown?.z).toBe(paused?.z);

    // Real mouse gestures on the rendered sheet: debug only supplies the
    // projection, never dispatches pickup. Dragging out and back is not a click.
    const projected = await dbg(page).project(paper.x, paper.z);
    expect(projected).not.toBeNull();
    const { sx, sy } = projected!;
    expect(await page.evaluate(([x, y]) =>
      Boolean(document.elementFromPoint(x, y)?.closest("[data-game-pointer-surface]")),
    [sx, sy] as const)).toBe(true);
    await page.mouse.move(sx, sy);
    await page.mouse.down();
    await page.mouse.move(sx + 35, sy);
    await page.mouse.move(sx, sy);
    await page.mouse.up();
    await page.waitForTimeout(550);
    await expect(page.locator('[data-app-world="game"]')).toBeVisible();
    await expect(page.locator("[data-desk-stack]")).not.toBeVisible();

    const clickPoint = await dbg(page).project(paper.x, paper.z);
    expect(clickPoint).not.toBeNull();
    await page.mouse.click(clickPoint!.sx, clickPoint!.sy);
    await expect(page.locator("[data-desk-stack]")).toBeVisible();
    await expect(page.getByText("TURN SCN user question", { exact: false }).first()).toBeVisible();
  });
});
