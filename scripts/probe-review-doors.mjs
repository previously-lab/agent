/* Verify the four review fixes:
   1. void is black (day mode)
   2. door-glow hue matches the room's actual palette
   3. room no longer reads translucent (fog starts past the player's bubble)
   4. corridor dissolves immediately on threshold crossing; fades back on exit */
import { chromium } from "playwright";

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
await page.goto("http://localhost:3000/en/game", { waitUntil: "networkidle" });
await page.waitForFunction(() => window.__gameDebug !== undefined, { timeout: 30000 });
await page.waitForTimeout(2500);

async function tp(x, z) {
  await page.evaluate(([x, z]) => window.__gameDebug.teleport(x, z), [x, z]);
  await page.waitForTimeout(150);
}

// 1+2: corridor view in day mode — black void, door glow for 0746 (butter
// library, south door at x=-9) should read warm honey, not cream white.
await tp(-9, -3.2);
await page.waitForTimeout(700);
await page.screenshot({ path: "shots/review/v2-corridor-void-glow.png" });

// 4a: cross the threshold — the corridor behind must start dissolving.
await tp(-9, -5.6);
await tp(-9, -7.2);
await page.waitForTimeout(250);
await page.screenshot({ path: "shots/review/v2-just-entered.png" });

// 3: deep in the room, settled — furniture around the player must be
// solid, not veiled.
await tp(-9, -14);
await page.waitForTimeout(1200);
await page.screenshot({ path: "shots/review/v2-deep-room.png" });

// 4b: walk back out — the corridor returns faded-in (no full-brightness pop).
await tp(-9, -2.5);
await page.waitForTimeout(120);
await page.screenshot({ path: "shots/review/v2-just-exited.png" });
await page.waitForTimeout(900);
await page.screenshot({ path: "shots/review/v2-exited-settled.png" });

await browser.close();
