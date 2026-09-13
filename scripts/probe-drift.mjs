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
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
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

await page.click(`[role="group"] button[aria-label="Conversation"]`);

// Sample with NO input at all, from just after the switch out to well past the
// settle. Same id + same y = the reader did not move.
const samples = [];
for (const t of [400, 1200, 2500, 4000, 6000, 9000, 12000]) {
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
