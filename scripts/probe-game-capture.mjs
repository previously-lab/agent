/**
 * Teleport-based capture probe. The walk-based `probe-game.mjs` stalls here:
 * headless software rendering runs under 1 fps, while player movement is
 * dt-clamped at 0.05 s/frame, so walking a few metres takes minutes. This
 * version teleports through the game's `window.__gameDebug` hook instead, so
 * it is frame-rate independent, and it shoots both the room and the corridor
 * view at each target.
 *
 * Usage:
 *   node scripts/probe-game-capture.mjs                 # default targets
 *   TARGETS='[{"name":"x","x":-3,"z":-6}]' node scripts/probe-game-capture.mjs
 *
 * Door positions: door index i sits at x = -(i + 0.5) * pitch (6-24 m, see
 * src/lib/game/corridor-pitch.ts); north door z = +6, south z = -6. A room
 * clamps the player inside itself, so each target reloads the page first —
 * a fresh page starts in the corridor, where teleports take effect.
 */
import { chromium } from "@playwright/test";

const BASE = process.env.SCREENSHOT_BASE ?? "http://localhost:3000";
const OUT = process.env.SHOT_DIR ?? "shots/review/after-lighting";
const SETTLE = Number(process.env.SETTLE_MS ?? 5000);

const DEFAULT_TARGETS = [
  { name: "5-colossal-interior", x: -3, z: 6, rank: 0 },
  { name: "6-duck-pool", x: -9, z: 6, rank: 2 },
  { name: "7-pool-hall", x: -96.739, z: 6, rank: 20 },
  { name: "8-pool-nature", x: -96.739, z: -6, rank: 21 },
  { name: "9-library", x: -3, z: -6, rank: 1 },
];
const TARGETS = process.env.TARGETS
  ? JSON.parse(process.env.TARGETS)
  : DEFAULT_TARGETS;

const HIDE_CHROME = `
  #devtools-indicator, .nextjs-toast, nextjs-portal { display: none !important; }
`;

async function state(page) {
  return page.evaluate(() => {
    const d = globalThis.__gameDebug ?? {};
    return {
      x: Number((d.x ?? 0).toFixed(1)),
      z: Number((d.z ?? 0).toFixed(1)),
      space: d.space ?? null,
      sun: d.sunIntensity,
      ambient: d.ambient,
      bg: d.bg,
      fadeT: d.fadeT,
      mats: d.matsFaded,
    };
  });
}

const browser = await chromium.launch();
const page = await browser.newPage({
  viewport: { width: 1440, height: 900 },
  deviceScaleFactor: 2,
});
page.setDefaultTimeout(120000);

const problems = [];
page.on("console", (m) => {
  if (m.type() === "error") problems.push("[error] " + m.text().slice(0, 300));
});
page.on("pageerror", (e) =>
  problems.push("[pageerror] " + String(e?.message).slice(0, 300)),
);

await page.addStyleTag({ content: HIDE_CHROME }).catch(() => {});

for (const t of TARGETS) {
  await page.goto(`${BASE}/en/game`, { waitUntil: "networkidle" });
  await page.waitForSelector("canvas", { timeout: 30000 });
  await page.waitForFunction(() => !!globalThis.__gameDebug, null, {
    timeout: 30000,
  });
  await page.waitForTimeout(SETTLE);
  await page.evaluate((x) => globalThis.__gameDebug?.teleport?.(x, 0), t.x);
  await page.waitForTimeout(1500);
  console.log(`  ${t.name}: corridor`, JSON.stringify(await state(page)));
  await page.screenshot({ path: `${OUT}/${t.name}-corridor.png` });
  await page.evaluate(
    ([x, z]) => globalThis.__gameDebug?.teleport?.(x, z),
    [t.x, t.z],
  );
  await page.waitForTimeout(SETTLE);
  await page.screenshot({ path: `${OUT}/${t.name}.png` });
  console.log(`  ${t.name} (rank ${t.rank}):`, JSON.stringify(await state(page)));
}

console.log("  console errors:", problems.length, problems.slice(0, 5).join(" | "));
await browser.close();
console.log("done");
