/**
 * probe-drift.mjs — does the reader's place survive at the conversation rung
 * while its units measure?
 *
 * The one behaviour the whole field design promises is "the reader's place is
 * preserved". A conversation unit is as tall as its text and reports its height
 * AFTER it mounts, so the offset table changes under the reader several times
 * on entry. This samples WHICH SLICE is at the viewport centre, with NO input
 * in between: a changing answer is the view moving on its own.
 */
import { chromium } from "playwright";
const BASE = process.argv[2] ?? "http://localhost:3100";
const browser = await chromium.launch();
// `reduced` removes the deal-in animation, which is the other thing that moves
// a unit after it mounts. A shift that survives reduced motion is drift; one
// that disappears with it was the animation finishing.
const page = await browser.newPage({
  viewport: { width: 1280, height: 800 },
  ...(process.argv[5] === "reduced" ? { reducedMotion: "reduce" } : {}),
});
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));

await page.goto(`${BASE}/en?view=timeline`, { waitUntil: "domcontentloaded" });
await page.waitForSelector("[data-card-field]", { timeout: 60000 });
await page.waitForTimeout(4000);

/** The slice whose face crosses the viewport middle, and its screen y. */
const centreSlice = () =>
  page.evaluate(() => {
    const units = [...document.querySelectorAll("[data-slice-conversation]")];
    let best = null;
    for (const u of units) {
      const r = u.getBoundingClientRect();
      if (r.top <= 400 && r.bottom >= 400) {
        return { id: u.getAttribute("data-slice-conversation"), y: Math.round(r.top) };
      }
      const d = Math.min(Math.abs(r.top - 400), Math.abs(r.bottom - 400));
      if (!best || d < best.d) best = { d, id: u.getAttribute("data-slice-conversation"), y: Math.round(r.top) };
    }
    return best;
  });

// WORST CASE FIRST (optional). The drift scales with the anchor's INDEX: the
// column's carry is seeded from the first measured height, so the anchor's top
// is `index x carry` and a change in the seed moves it by `index x delta`.
// Scrolling deep into history before entering the rung is therefore the case
// most likely to expose it — a probe that only ever enters near the newest
// slice is testing the cheapest version of the bug.
if (process.argv[3] === "deep") {
  await page.mouse.move(640, 400);
  for (let i = 0; i < 14; i++) {
    await page.mouse.wheel(0, -900);
    await page.waitForTimeout(120);
  }
  await page.waitForTimeout(2500);
}

await page.click(`[role="group"] button[aria-label="Conversation"]`);

// Sample with NO input at all, from just after the switch out to well past the
// settle. Same id + same y = the reader did not move.
const samples = [];
const TIMES = process.argv[4] === "dense"
  ? [150, 300, 500, 700, 900, 1200, 1500, 1800, 2200, 2600, 3200, 4200, 6000, 9000]
  : [400, 1200, 2500, 4000, 6000, 9000, 12000];
for (const t of TIMES) {
  await page.waitForTimeout(t - (samples.length ? samples[samples.length - 1].t : 0));
  const s = await centreSlice();
  samples.push({ t, ...(s ?? {}) });
}
for (const s of samples) console.log(`t=${String(s.t).padStart(5)}ms  ${s.id ?? "(none)"}  top=${s.y}`);
const ids = new Set(samples.map((s) => s.id));
const ys = samples.map((s) => s.y).filter((y) => y != null);
console.log("distinct slices at centre:", ids.size, ids.size === 1 ? "PASS" : "FAIL");
console.log("top-edge range:", Math.min(...ys), "..", Math.max(...ys), "drift:", Math.max(...ys) - Math.min(...ys), "px");
console.log("errors:", errors.slice(0, 3));
await browser.close();
