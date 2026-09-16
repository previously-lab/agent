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
await tp(-3, -5.6);
await tp(-3, -14);
await page.waitForTimeout(2000);
const d = await page.evaluate(() => {
  const g = window.__gameDebug;
  return { fogNear: +g.fogNear.toFixed(0), fadeT: g.fadeT, mats: g.fadeMats, transparent: g.matsTransparent, faded: g.matsFaded };
});
console.log("IN ROOM:", JSON.stringify(d));
await browser.close();
