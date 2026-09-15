/**
 * One-off probe: walk to the Nth door, enter, screenshot the space interior.
 * Usage: node scripts/probe-space-walk.mjs <doorIndex> <side:north|south> <outname>
 */
import { chromium } from "@playwright/test";

const [doorIdxArg, sideArg, outArg] = process.argv.slice(2);
const DOOR_INDEX = Number(doorIdxArg ?? 1);
const SIDE = sideArg ?? "north";
const OUT = outArg ?? `shots/game-probe-space-${DOOR_INDEX}.png`;
const BASE = process.env.SCREENSHOT_BASE ?? "http://localhost:3000";
const TARGET_X = -3 - DOOR_INDEX * 6;

const browser = await chromium.launch();
const page = await browser.newPage({
  viewport: { width: 1440, height: 900 },
  deviceScaleFactor: 2,
  colorScheme: "dark",
});
await page.goto(`${BASE}/en/game`, { waitUntil: "networkidle" });
await page.waitForSelector("canvas", { timeout: 30000 });
await page.waitForTimeout(3500);

// Walk down the corridor (A+S = -x) until aligned with the target door.
await page.keyboard.down("a");
await page.keyboard.down("s");
await page.waitForFunction((t) => window.__gameDebug?.x <= t + 0.3, TARGET_X, {
  timeout: 30000,
});
await page.keyboard.up("a");
await page.keyboard.up("s");
await page.waitForTimeout(400);

// Enter: north = +z (S+D), south = -z (W+A).
const keys = SIDE === "north" ? ["s", "d"] : ["w", "a"];
await page.keyboard.down(keys[0]);
await page.keyboard.down(keys[1]);
await page.waitForFunction(() => window.__gameDebug?.space !== null, null, {
  timeout: 8000,
});
await page.keyboard.up(keys[0]);
await page.keyboard.up(keys[1]);
await page.waitForTimeout(1500);
console.log("entered:", await page.evaluate(() => ({ ...window.__gameDebug })));
await page.screenshot({ path: OUT });

// Wander inward a bit to reveal props, then screenshot again.
await page.keyboard.down(keys[0]);
await page.keyboard.down(keys[1]);
await page.waitForTimeout(2500);
await page.keyboard.up(keys[0]);
await page.keyboard.up(keys[1]);
await page.waitForTimeout(1200);
await page.screenshot({ path: OUT.replace(".png", "-deep.png") });

await browser.close();
console.log("captured:", OUT);
