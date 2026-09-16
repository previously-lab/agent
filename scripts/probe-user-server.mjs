import { chromium } from "playwright";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1492, height: 822 } });
await page.goto("http://localhost:3000/en/game", { waitUntil: "networkidle" });
await page.waitForFunction(() => window.__gameDebug !== undefined, { timeout: 30000 });
await page.waitForTimeout(2500);
async function tp(x, z) {
  await page.evaluate(([x, z]) => window.__gameDebug.teleport(x, z), [x, z]);
  await page.waitForTimeout(150);
}
// Same room, same approach as the user's screenshot: butter library via
// the south door at x=-3.
await tp(-3, -5.6);
await tp(-3, -14);
await page.waitForTimeout(2000);
await page.screenshot({ path: "shots/review/user-server-room.png" });
console.log(JSON.stringify(await page.evaluate(() => ({ ...window.__gameDebug }))));
await browser.close();
