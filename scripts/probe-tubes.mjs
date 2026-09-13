/**
 * Reads the band's real pixels back: how many device pixels wide a line
 * actually is, and what colour it actually is.
 *
 * This is the only way to check the two claims the band makes about itself that
 * cannot be read off the source — that "1 px" really is one CSS pixel on
 * screen, and that the resting braid is NEUTRAL GREY rather than something
 * tinted or over-bright. Both have been wrong before in ways that looked fine
 * in the code and obvious in a pixel dump.
 *
 * The band is drawn UNLIT (see `tube-line.tsx`), so a horizontal cut through a
 * line is a flat plateau by design — do not read a flat profile here as a bug.
 * What matters is the run's WIDTH (a strand should be 2 device pixels at 2x)
 * and the channel spread of its colour (`rgb(196,196,196)` is a grey;
 * `rgb(196,180,150)` is not).
 *
 * Read-only: it drives the dev server that is already running and writes PNGs
 * into the gitignored `shots/`. Nothing in `src/` is touched.
 *
 *   node scripts/probe-tubes.mjs [--url http://localhost:3000/zh] [--theme dark]
 */
import { chromium } from "@playwright/test";
import { mkdirSync } from "node:fs";

const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const URL = arg("url", "http://localhost:3000/zh");
const THEME = arg("theme", "light");
const OUT = "shots";
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch();
// 2x, so "one CSS pixel" and "two device pixels" are distinguishable — which is
// the whole question about a hairline.
const page = await browser.newPage({
  viewport: { width: 1440, height: 900 },
  deviceScaleFactor: 2,
  colorScheme: THEME,
});

const noise = [];
page.on("console", (m) => {
  if (m.type() === "error") noise.push(m.text());
});
page.on("pageerror", (e) => noise.push(String(e)));

await page.goto(URL, { waitUntil: "networkidle" });
// The band fades in over 500 ms once WebGL reports ready.
await page.waitForTimeout(4000);

const box = await page.locator("canvas").first().boundingBox();
if (!box) throw new Error("no canvas — WebGL is not up");
console.log("canvas box:", box);

const shot = `${OUT}/tubes-${THEME}.png`;
const buffer = await page.screenshot({ path: shot, clip: box });

// Decoded back inside the page: the only PNG reader this repo has is the
// browser, and a screenshot is what forces the canvas to be composited at all
// (a WebGL drawing buffer is not readable after the fact without it).
const sample = await page.evaluate(async (b64) => {
  const img = new Image();
  await new Promise((resolve, reject) => {
    img.onload = resolve;
    img.onerror = reject;
    img.src = `data:image/png;base64,${b64}`;
  });
  const c = document.createElement("canvas");
  c.width = img.width;
  c.height = img.height;
  const ctx = c.getContext("2d");
  ctx.drawImage(img, 0, 0);
  const { data } = ctx.getImageData(0, 0, c.width, c.height);
  const rows = [];
  for (const fraction of [0.3, 0.5, 0.7]) {
    const y = Math.round(c.height * fraction);
    const row = new Array(c.width);
    for (let x = 0; x < c.width; x++) {
      const i = (y * c.width + x) * 4;
      row[x] = [data[i], data[i + 1], data[i + 2]];
    }
    rows.push({ y, row });
  }
  return { width: c.width, height: c.height, rows };
}, buffer.toString("base64"));

const W = sample.width;
console.log(`captured ${sample.width}x${sample.height} device px`);

/** How far a pixel is from the page, 0 (background) → 1 (full ink). */
const inkOf = (rgb) =>
  THEME === "dark"
    ? (rgb[0] + rgb[1] + rgb[2]) / 3 / 255
    : 1 - (rgb[0] + rgb[1] + rgb[2]) / 3 / 255;

/** A run of consecutive lit pixels is one line's cross-section. */
function runs(row) {
  const out = [];
  let start = -1;
  for (let x = 0; x <= W; x++) {
    const lit = x < W && inkOf(row[x]) > 0.04;
    if (lit && start < 0) start = x;
    if (!lit && start >= 0) {
      let peak = 0;
      let peakRgb = [0, 0, 0];
      for (let i = start; i < x; i++) {
        const ink = inkOf(row[i]);
        if (ink > peak) {
          peak = ink;
          peakRgb = row[i];
        }
      }
      out.push({ x: start, w: x - start, peak, rgb: peakRgb });
      start = -1;
    }
  }
  return out;
}

for (const { y, row } of sample.rows) {
  console.log(`\ny=${y}:`);
  for (const r of runs(row)) {
    // The channel spread is the neutrality check: 0 means a true grey.
    const spread = Math.max(...r.rgb) - Math.min(...r.rgb);
    console.log(
      `  x=${r.x} width=${r.w}px peak=${r.peak.toFixed(2)} ` +
        `rgb(${r.rgb.join(",")}) spread=${spread}`,
    );
  }
}

if (noise.length) {
  console.log("\n--- console errors ---");
  for (const line of noise.slice(0, 20)) console.log(line.slice(0, 600));
} else {
  console.log("\nno console errors");
}

await browser.close();
