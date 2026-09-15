/**
 * Game-route theme probe — captures the corridor in BOTH app themes.
 *
 * Walks the avatar from the lobby into the past corridor (same A+S leg as
 * probe-game.mjs, driven off window.__gameDebug), screenshots the hall in
 * dark mode, then flips next-themes to light (localStorage + the html
 * class the provider watches), waits out the theme lerp, and screenshots
 * again. The space side is seed-palette and theme-independent, so only
 * corridor frames are captured.
 *
 * Usage: node scripts/probe-game-theme.mjs   # against http://localhost:3000
 * Output: shots/game-theme-{corridor-dark,corridor-light}.png
 */
import { chromium } from "@playwright/test";

const BASE = process.env.SCREENSHOT_BASE ?? "http://localhost:3000";
const SETTLE_MS = 3500;
const THEME_LERP_MS = 2500; // corridor theme lerp ~2.5/s → fully settled

const HIDE_CHROME = `
  #devtools-indicator, .nextjs-toast, nextjs-portal { display: none !important; }
`;

/** First south-side door sits at x=-3 (door index 0). */
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
  console.log("spawn:", await readPos(page));

  // A+S = pure -x, down the corridor to the first door bay.
  await page.keyboard.down("a");
  await page.keyboard.down("s");
  await page.waitForFunction(
    (target) => window.__gameDebug && window.__gameDebug.x <= target + 0.3,
    TARGET_DOOR_X,
    { timeout: 15000 },
  );
  await page.keyboard.up("a");
  await page.keyboard.up("s");
  await page.waitForTimeout(800);
  console.log("corridor:", await readPos(page));

  await page.screenshot({ path: "shots/game-theme-corridor-dark.png" });

  // Flip the app to light mode and reload — next-themes reads its theme
  // from localStorage on load (attribute="class", storage="local").
  // Mutating the html class in place gets reverted by the provider's own
  // observer (its in-memory state still says system=dark), so a reload is
  // the deterministic way.
  await page.evaluate(() => {
    localStorage.setItem("theme", "light");
  });
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForSelector("canvas", { timeout: 30000 });
  await page.waitForTimeout(SETTLE_MS);

  // Player reset to spawn on reload — walk the same leg again.
  await page.keyboard.down("a");
  await page.keyboard.down("s");
  await page.waitForFunction(
    (target) => window.__gameDebug && window.__gameDebug.x <= target + 0.3,
    TARGET_DOOR_X,
    { timeout: 15000 },
  );
  await page.keyboard.up("a");
  await page.keyboard.up("s");
  await page.waitForTimeout(800 + THEME_LERP_MS); // theme colors fully settled
  console.log("corridor (light):", await readPos(page));
  await page.screenshot({ path: "shots/game-theme-corridor-light.png" });

  await browser.close();
  console.log("captured: shots/game-theme-corridor-{dark,light}.png");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
