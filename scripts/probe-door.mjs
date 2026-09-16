/**
 * Teleport probe: place the player at exact spots around one door and
 * screenshot each beat — approach (door swings), deep inside (single
 * slab + seams), back out (corridor returns, room dissolves).
 * Usage: node scripts/probe-door.mjs <doorIndex> <side:north|south> <outPrefix>
 */
import { chromium } from "@playwright/test";

const [idxArg, sideArg, outArg] = process.argv.slice(2);
const DOOR_INDEX = Number(idxArg ?? 1);
const SIDE = sideArg ?? "south";
const OUT = outArg ?? `shots/door-${DOOR_INDEX}-${SIDE}`;
const BASE = process.env.SCREENSHOT_BASE ?? "http://localhost:3000";
const DOOR_X = -3 - DOOR_INDEX * 6;
const WALL_Z = 5;
const s = SIDE === "north" ? 1 : -1;

const browser = await chromium.launch();
const page = await browser.newPage({
  viewport: { width: 1440, height: 900 },
  deviceScaleFactor: 2,
  colorScheme: "dark",
});
await page.goto(`${BASE}/en/game`, { waitUntil: "networkidle" });
await page.waitForSelector("canvas", { timeout: 30000 });
await page.waitForFunction(() => window.__gameDebug?.teleport, null, {
  timeout: 30000,
});
await page.waitForTimeout(2500);

const tp = (x, z) =>
  page.evaluate(([px, pz]) => window.__gameDebug.teleport(px, pz), [x, z]);
const state = () =>
  page.evaluate(() => ({
    x: window.__gameDebug.x,
    z: window.__gameDebug.z,
    space: window.__gameDebug.space,
  }));

// A. Approach: 1.8m in front of the door on the corridor side — the slab
// must swing INTO the room (away from the player), glow in the room tone.
await tp(DOOR_X, s * (WALL_Z - 1.8));
await page.waitForTimeout(1400);
await page.screenshot({ path: `${OUT}-a-approach.png` });

// B. Deep inside: step over the threshold first (the door manager only
// resolves within 2.5m), then teleport deep — the space stays mounted.
await tp(DOOR_X, s * (WALL_Z + 0.4));
await page.waitForTimeout(500);
await tp(DOOR_X, s * (WALL_Z + 9));
await page.waitForTimeout(1800);
console.log("deep:", await state());
await page.screenshot({ path: `${OUT}-b-deep.png` });

// C. Back out: corridor returns, the room dissolves behind.
await tp(DOOR_X, s * (WALL_Z - 1.8));
await page.waitForTimeout(1400);
console.log("back:", await state());
await page.screenshot({ path: `${OUT}-c-back.png` });

await browser.close();
console.log("captured:", `${OUT}-{a,b,c}`);
