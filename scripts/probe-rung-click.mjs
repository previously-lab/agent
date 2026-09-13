/**
 * probe-rung-click.mjs — the two things C6 has to get right that a rung
 * screenshot cannot show: clicking a card zooms ONE rung finer and ANCHORS on
 * that slice, and the anchored unit lands on screen where the card was.
 *
 *   node scripts/probe-rung-click.mjs [baseURL]
 */
import { chromium } from "playwright";

const BASE = process.argv[2] ?? "http://localhost:3100";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const errors = [];
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));

await page.goto(`${BASE}/en?view=timeline`, { waitUntil: "domcontentloaded" });
await page.waitForSelector("[data-card-field]", { timeout: 60000 });
await page.waitForTimeout(4000);

const RUNGS = ["Conversation", "Slice", "Day", "Week"];
const rungOf = () =>
  page.evaluate((rungs) => {
    for (const b of document.querySelectorAll("button[aria-pressed='true']")) {
      const l = b.getAttribute("aria-label");
      if (l && rungs.includes(l)) return l;
    }
    return null;
  }, RUNGS);

/** The card whose centre is nearest the viewport middle, with its rect. */
const centreCard = () =>
  page.evaluate(() => {
    const cards = [...document.querySelectorAll(".tl-card-in")];
    let best = null;
    for (const c of cards) {
      const r = c.getBoundingClientRect();
      const cy = r.top + r.height / 2;
      const d = Math.abs(cy - window.innerHeight / 2);
      if (!best || d < best.d) best = { d, cy, text: c.textContent?.slice(0, 40) };
    }
    return best;
  });

/** The conversation unit nearest the viewport middle, with its rect. */
const centreConversation = () =>
  page.evaluate(() => {
    const units = [...document.querySelectorAll("[data-slice-conversation]")];
    let best = null;
    for (const u of units) {
      const r = u.getBoundingClientRect();
      const cy = r.top + r.height / 2;
      const d = Math.abs(cy - window.innerHeight / 2);
      if (!best || d < best.d) {
        best = {
          d,
          cy,
          h: Math.round(r.height),
          id: u.getAttribute("data-slice-conversation"),
        };
      }
    }
    return best;
  });

async function selectRung(name) {
  await page.click(`[role="group"] button[aria-label="${name}"]`);
  await page.waitForTimeout(2000);
}

console.log("start rung:", await rungOf());
await selectRung("Slice");
console.log("at slice rung:", await rungOf());

const before = await centreCard();
console.log("centre card:", JSON.stringify(before));

// Click the card at the middle — one rung finer, anchored on it.
await page.evaluate(() => {
  const cards = [...document.querySelectorAll(".tl-card-in")];
  let best = null;
  for (const c of cards) {
    const r = c.getBoundingClientRect();
    const d = Math.abs(r.top + r.height / 2 - window.innerHeight / 2);
    if (!best || d < best.d) best = { d, c };
  }
  best?.c.click();
});
await page.waitForTimeout(3000);

const rungAfter = await rungOf();
const after = await centreConversation();
console.log("after click rung:", rungAfter);
console.log("centre conversation:", JSON.stringify(after));
console.log("one rung finer:", rungAfter === "Conversation" ? "PASS" : `FAIL(${rungAfter})`);
// The FACE's centre sits half a face above the unit's centre, because the
// measured div excludes the gate the layout counted. So the unit's centre is
// `cy + h/2` — and that is what `anchorScrollFor` aims at the viewport middle.
const unitCentre = after ? after.cy + after.h / 2 : NaN;
console.log(
  "anchored unit's CENTRE at the viewport middle:",
  Math.abs(unitCentre - 400) <= 40
    ? `PASS (${Math.round(unitCentre)}px)`
    : `FAIL (${Math.round(unitCentre)}px)`,
);

// Zoom back out and in with ctrl+wheel, then confirm the ladder is intact.
await page.mouse.move(640, 400);
for (let i = 0; i < 3; i++) {
  await page.keyboard.down("Control");
  await page.mouse.wheel(0, 200);
  await page.keyboard.up("Control");
  await page.waitForTimeout(400);
}
await page.waitForTimeout(1500);
console.log("after 3x ctrl+wheel out:", await rungOf());
for (let i = 0; i < 5; i++) {
  await page.keyboard.down("Control");
  await page.mouse.wheel(0, -200);
  await page.keyboard.up("Control");
  await page.waitForTimeout(400);
}
await page.waitForTimeout(1500);
console.log("after 5x ctrl+wheel in:", await rungOf());
console.log("errors:", errors.slice(0, 5));

await browser.close();
