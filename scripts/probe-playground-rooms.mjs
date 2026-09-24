/**
 * The playground batch — one frame per standard room, straight from the route
 * that renders a single room and nothing else.
 *
 * No corridor, no doors, no mounting: the room is the page. The route's own
 * readout panel carries the same facts describeRoom derives, so a frame and its
 * numbers come from one source.
 *
 * Usage: node scripts/probe-playground-rooms.mjs            (all 13, no skin)
 *        SKIN=dune node scripts/probe-playground-rooms.mjs  (same rooms, one world)
 *        MODULES=living,bath node scripts/probe-playground-rooms.mjs
 */
import { chromium } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";

const BASE = process.env.SCREENSHOT_BASE ?? "http://localhost:3000";
const SKIN = process.env.SKIN ?? "";
const OUT = process.env.SHOT_DIR ?? `shots/review/v0.12b/rooms${SKIN ? "-" + SKIN : ""}`;
const MODULES = (
  process.env.MODULES ??
  "foyer,bedroom,study,reading-room,kitchen,bath,storage,workshop,gallery-module,living,sunroom,pool-deck,dining-hall"
)
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage({
  viewport: { width: 1600, height: 1000 },
  deviceScaleFactor: 2,
});
page.setDefaultTimeout(120000);
const problems = [];
page.on("console", (m) => {
  if (m.type() === "error") problems.push(m.text().slice(0, 160));
});

for (const id of MODULES) {
  const url = `${BASE}/en/playground?m=${id}${SKIN ? `&skin=${SKIN}` : ""}`;
  let done = false;
  for (let attempt = 1; attempt <= 2 && !done; attempt++) {
    try {
      await page.goto(url, { waitUntil: "domcontentloaded" });
      // attached is enough — React re-mounts the canvas and "visible" gets
      // raced (measured: a canvas that IS visible times the wait out).
      await page.waitForSelector("canvas", { state: "attached", timeout: 60000 });
      await page.waitForTimeout(5200);
      await page.screenshot({ path: `${OUT}/${id}.png` });
      // the route's own readout, so the frame and the facts travel together
      const readout = await page.evaluate(() => {
        const text = document.body.innerText.replace(/\s+/g, " ").trim();
        return text.slice(0, 1200);
      });
      writeFileSync(`${OUT}/${id}.txt`, readout);
      const line = readout.match(/([\d.]+×[\d.]+|[\d.]+m × [\d.]+m)/);
      console.log(`  ${id}: ${line ? line[0] : "?"} — ${readout.slice(0, 120)}`);
      done = true;
    } catch (err) {
      console.log(`  ${id} attempt ${attempt}: ${String(err).split("\n")[0]}`);
    }
  }
  if (!done) console.log(`  ${id}: FAILED`);
}

console.log("  console errors:", problems.length, problems.slice(0, 2).join(" | "));
await browser.close();
console.log("playground batch done");
