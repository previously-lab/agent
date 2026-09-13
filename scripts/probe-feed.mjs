/**
 * probe-feed.mjs — is the band actually being fed, in both views?
 *
 * The band is a separate WebGL canvas reached through a mutable object, so the
 * only honest end-to-end check is the one DOM node the feed drives: the
 * crossing dot, which fades in when a boundary is announcing itself and carries
 * the unit's position in its transform.
 *
 *   node scripts/probe-feed.mjs [baseURL]
 */
import { chromium } from "playwright";

const BASE = process.argv[2] ?? "http://localhost:3100";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const errors = [];
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));

const dot = () =>
  page.evaluate(() => {
    const el = document.querySelector("[data-crossing-dot]");
    if (!el) return null;
    return { opacity: el.style.opacity, transform: el.style.transform };
  });

async function scrollOnField(dy) {
  await page.mouse.move(800, 400);
  await page.mouse.wheel(0, dy);
  await page.waitForTimeout(700);
}

async function survey(label) {
  // Sample the dot across a scroll, so "it never armed" and "it is armed
  // somewhere the reader actually is" are told apart.
  const seen = new Set();
  for (let i = 0; i < 8; i++) {
    const d = await dot();
    seen.add(d ? `${d.opacity}|${d.transform ? "placed" : "unplaced"}` : "missing");
    await scrollOnField(700);
  }
  const armedSomewhere = [...seen].some((k) => k.startsWith("1|"));
  const placed = [...seen].some((k) => k.includes("placed"));
  console.log(
    `${label}: dot present=${![...seen].includes("missing")} armed=${armedSomewhere} placed=${placed}`,
    JSON.stringify([...seen]),
  );
  return { armedSomewhere, placed };
}

console.log("--- timeline view ---");
await page.goto(`${BASE}/en?view=timeline`, { waitUntil: "domcontentloaded" });
await page.waitForSelector("[data-card-field]", { timeout: 60000 });
await page.waitForTimeout(4000);
const tl = await survey("timeline");

console.log("--- chat view ---");
await page.goto(`${BASE}/en`, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(5000);
const chat = await survey("chat");

console.log("--- invariants ---");
console.log("timeline arms the dot:", tl.armedSomewhere ? "PASS" : "FAIL");
console.log("chat arms the dot:", chat.armedSomewhere ? "PASS" : "FAIL");
console.log("no console errors:", errors.length === 0 ? "PASS" : `FAIL ${errors.length}`);
console.log(errors.slice(0, 6));

await browser.close();
