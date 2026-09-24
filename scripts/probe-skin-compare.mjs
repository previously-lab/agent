/**
 * The P3 skin comparison — ONE room, N worlds.
 *
 * The skin force rides in the slice id (`dbg-skin:<id>+dbg-m:<module>`), and the
 * gallery hands them out itself once `&skin=<id>` is on the URL, so this shoots
 * the same module under each skin in turn. The room's STRUCTURE is skin
 * independent by design (the seed path strips the force), so the frames are the
 * same room wearing different worlds — which is the whole point.
 *
 * Usage: MODULE=living SKINS=temperate,dune,grove,moss,shallows \
 *          node scripts/probe-skin-compare.mjs
 */
import { chromium } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";

const BASE = process.env.SCREENSHOT_BASE ?? "http://localhost:3000";
const OUT = process.env.SHOT_DIR ?? "shots/review/v0.12b/skins";
const SETTLE = Number(process.env.SETTLE_MS ?? 3200);
const MODULE = process.env.MODULE ?? "living";
const SKINS = (process.env.SKINS ?? "temperate,dune,grove,moss,shallows")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage({
  viewport: { width: 1600, height: 1000 },
  deviceScaleFactor: 2,
});
page.setDefaultTimeout(120000);
const problems = [];
page.on("console", (m) => {
  if (m.type() === "error") problems.push(m.text().slice(0, 160));
});

const want = `dbg-m:${MODULE}`;

async function collapsePanel() {
  for (let i = 0; i < 4; i++) {
    const hit = await page.evaluate(() => {
      const btn = Array.from(document.querySelectorAll("button")).find((b) =>
        /collapse/i.test(b.getAttribute("aria-label") || ""),
      );
      if (!btn) return false;
      btn.click();
      return true;
    });
    if (!hit) break;
    await page.waitForTimeout(500);
  }
  await page.evaluate(() => document.activeElement?.blur?.());
}

async function boot(skin) {
  const url = `${BASE}/en/?view=game&debug=rooms&page=modules&skin=${skin}`;
  await page.goto(url, { waitUntil: "networkidle" });
  await page.waitForSelector("canvas", { timeout: 30000 });
  await page.waitForFunction(() => !!globalThis.__gameDebug, null, {
    timeout: 30000,
  });
  await page.waitForTimeout(SETTLE);
  await collapsePanel();
}

/** The gallery door carrying this module, whatever skin prefix it wears. */
async function findDoor() {
  for (let hop = 0; hop < 14; hop++) {
    const door = await page.evaluate(
      (w) =>
        (globalThis.__gameDebug?.windowDoors ?? []).find(
          (d) => d.sliceId === w || d.sliceId.endsWith("+" + w),
        ) ?? null,
      want,
    );
    if (door) return door;
    const px = await page.evaluate(() => globalThis.__gameDebug?.x ?? 0);
    await page.evaluate((x) => globalThis.__gameDebug?.teleport?.(x, 0), px - 6);
    await page.waitForTimeout(1400);
  }
  return null;
}

async function shoot(skin) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    await boot(skin);
    const door = await findDoor();
    if (!door) {
      console.log(`  ${skin}: door never materialised`);
      continue;
    }
    // THE ROOM IS THE WITNESS. The door list reports plan x while the door's
    // world position is the negative, and Enter mounts the NEAREST door — so a
    // mount can land on the neighbour while the plate, the slice id and even
    // the door we matched all say otherwise. Take the room's own record (the
    // modules it furnished with, its footprint) AS the evidence, shoot one
    // frame from where we stand, and report which module really came up: the
    // comparison is only valid when every skin produced the same module.
    let standX = null;
    let facts = null;
    for (const candidate of [door.x, -door.x]) {
      await page.evaluate(
        ([x, z]) => globalThis.__gameDebug?.teleport?.(x, z),
        [candidate, door.side === "north" ? 3.4 : -3.4],
      );
      await page.waitForTimeout(2400);
      await page.keyboard.press("Enter");
      for (let i = 0; i < 14; i++) {
        const r = await page.evaluate(() => {
          const room = globalThis.__gameDebug?.room;
          return room
            ? {
                sliceId: room.sliceId,
                width: room.width,
                extent: room.extent,
                schematics: room.schematics,
                furniture: room.furniture,
                pieceKinds: room.pieceKinds,
              }
            : null;
        });
        if (r) {
          facts = r;
          standX = candidate;
          break;
        }
        await page.waitForTimeout(700);
      }
      if (facts) break;
    }
    if (!facts) {
      console.log(`  ${skin} attempt ${attempt}: nothing mounted`);
      continue;
    }
    await page.waitForTimeout(1400);
    await page.screenshot({ path: `${OUT}/${MODULE}-${skin}.png` });
    writeFileSync(
      `${OUT}/${MODULE}-${skin}.json`,
      JSON.stringify({ skin, standX, facts }, null, 2),
    );
    console.log(
      `  ${skin}: mounted ${facts.schematics.join(",") || "-generic-"} ` +
        `${facts.width}x${facts.extent} — ${facts.pieceKinds.length} pieces`,
    );
    return;
  }
  console.log(`  ${skin}: FAILED`);
}

for (const skin of SKINS) await shoot(skin);

console.log("  console errors:", problems.length, problems.slice(0, 2).join(" | "));
await browser.close();
console.log("skin comparison done");
