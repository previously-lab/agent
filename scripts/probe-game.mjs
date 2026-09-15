/**
 * Game-route probe — walks the avatar from the lobby down the corridor and
 * through the first south door, capturing a frame at each stage. Drives off
 * the live player position exposed at window.__gameDebug (mutated per frame
 * by game-canvas), so it's robust to spawn-position changes.
 *
 * Usage:
 *   node scripts/probe-game.mjs            # against http://localhost:3000
 *   SCREENSHOT_BASE=http://localhost:3100 node scripts/probe-game.mjs
 *
 * Output: shots/game-probe-{1-spawn,2-corridor,3-space}.png
 */
import { chromium } from "@playwright/test";

const BASE = process.env.SCREENSHOT_BASE ?? "http://localhost:3000";
const SETTLE_MS = 3500;

const HIDE_CHROME = `
  #devtools-indicator, .nextjs-toast, nextjs-portal { display: none !important; }
`;

/** First south-side door sits at x=-3, z=-3 (door index 0). */
const TARGET_DOOR_X = -3;

async function readPos(page) {
  return page.evaluate(() => {
    const d = window.__gameDebug;
    return d ? { x: d.x, z: d.z, space: d.space } : null;
  });
}

async function main() {
  const browser = await chromium.launch();
  const page = await browser.newPage({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 2,
    colorScheme: "dark",
  });
  await page.addStyleTag({ content: HIDE_CHROME }).catch(() => {});
  await page.goto(`${BASE}/en/game`, { waitUntil: "networkidle" });
  await page.waitForSelector("canvas", { timeout: 30000 });
  await page.waitForTimeout(SETTLE_MS);

  await page.screenshot({ path: "shots/game-probe-1-spawn.png" });

  // Leg 1 — A+S = pure -x (down the corridor). Hold until aligned with the
  // first door's gap, polling the live position.
  await page.keyboard.down("a");
  await page.keyboard.down("s");
  await page.waitForFunction(
    (target) => window.__gameDebug && window.__gameDebug.x <= target + 0.3,
    TARGET_DOOR_X,
    { timeout: 15000 },
  );
  await page.keyboard.up("a");
  await page.keyboard.up("s");
  await page.waitForTimeout(600);
  console.log("after leg 1:", await readPos(page));
  await page.screenshot({ path: "shots/game-probe-2-corridor.png" });

  // Leg 2 — W+A = pure -z (through the south doorway). Hold until the door
  // manager reports an active space.
  await page.keyboard.down("w");
  await page.keyboard.down("a");
  await page.waitForFunction(() => window.__gameDebug?.space !== null, null, {
    timeout: 8000,
  });
  await page.keyboard.up("w");
  await page.keyboard.up("a");
  await page.waitForTimeout(1500);
  console.log("after leg 2:", await readPos(page));
  await page.screenshot({ path: "shots/game-probe-3-space.png" });

  // Leg 3 — containment check: walk away from the door gap (+x), then try to
  // breach the wall back into the corridor. The wall must hold.
  await page.keyboard.down("w");
  await page.keyboard.down("d");
  await page.waitForTimeout(2000);
  await page.keyboard.up("w");
  await page.keyboard.up("d");
  await page.keyboard.down("s");
  await page.keyboard.down("d");
  await page.waitForTimeout(2000);
  await page.keyboard.up("s");
  await page.keyboard.up("d");
  await page.waitForTimeout(800);
  const breach = await readPos(page);
  console.log("after breach attempt (must stay inside):", breach);
  await page.screenshot({ path: "shots/game-probe-4-containment.png" });

  // Leg 4 — walk back to the door gap and exit into the corridor.
  await page.keyboard.down("a");
  await page.keyboard.down("s");
  await page.waitForFunction(
    (target) => window.__gameDebug && window.__gameDebug.x <= target + 0.3,
    TARGET_DOOR_X,
    { timeout: 10000 },
  );
  await page.keyboard.up("a");
  await page.keyboard.up("s");
  await page.keyboard.down("s");
  await page.keyboard.down("d");
  await page.waitForFunction(() => window.__gameDebug?.space === null, null, {
    timeout: 8000,
  });
  await page.keyboard.up("s");
  await page.keyboard.up("d");
  await page.waitForTimeout(1500);
  console.log("after exit:", await readPos(page));
  await page.screenshot({ path: "shots/game-probe-5-exit.png" });

  await browser.close();
  console.log("captured: shots/game-probe-{1,2,3}.png");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
