/**
 * probe-rung.mjs — drive the merged field's rung ladder and report what the
 * DOM actually contains at each rung. Verification scaffolding for the C6
 * wiring, not a product script.
 *
 *   node scripts/probe-rung.mjs [baseURL]
 */
import { chromium } from "playwright";

const BASE = process.argv[2] ?? "http://localhost:3100";

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });

const errors = [];
page.on("console", (m) => {
  if (m.type() === "error") errors.push(m.text());
});
page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));

await page.goto(`${BASE}/en?view=timeline`, { waitUntil: "domcontentloaded" });
await page.waitForSelector("[data-card-field]", { timeout: 60000 });
// Let the catalog land and the first rows measure.
await page.waitForTimeout(4000);

async function snapshot(label) {
  assertNoCrash(label);
  const out = await page.evaluate(() => {
    const field = document.querySelector("[data-card-field]");
    if (!field) return { error: "no field" };
    // drei's Html portals land inside the canvas's sibling wrapper.
    const frames = [...field.querySelectorAll(".tl-card-in")];
    const turns = [...field.querySelectorAll("[data-slice-conversation]")];
    const gates = [...field.querySelectorAll('[role="separator"][data-armed]')];
    const armed = gates.filter((g) => g.getAttribute("data-armed") === "true");
    const allArmed = document.querySelectorAll('[role="separator"][data-armed="true"]').length;
    // A conversation unit is a big DOM column; a card is a fixed box.
    const boxes = [...field.querySelectorAll("div")].filter((d) => {
      const r = d.getBoundingClientRect();
      return r.width > 400 && r.height > 200;
    });
    return {
      cards: frames.length,
      conversations: turns.length,
      gates: gates.length,
      armed: armed.length,
      armedPageWide: allArmed,
      bigBoxes: boxes.length,
      cardBox: boxes[0]
        ? {
            w: Math.round(boxes[0].getBoundingClientRect().width),
            h: Math.round(boxes[0].getBoundingClientRect().height),
          }
        : null,
      canvasCount: document.querySelectorAll("canvas").length,
      turnText: turns[0]?.textContent?.slice(0, 60) ?? null,
    };
  });
  console.log(label, JSON.stringify(out));
  return out;
}

function assertNoCrash(label) {
  if (page.isClosed()) throw new Error(`${label}: page closed`);
}

/** Click a lens segment by its aria-label. */
async function selectRung(name) {
  await page.click(`[role="group"] button[aria-label="${name}"]`);
  await page.waitForTimeout(1800);
}

console.log("--- rungs ---");
await snapshot("default(day?)");

for (const name of ["Conversation", "Slice", "Day", "Week"]) {
  await selectRung(name);
  const s = await snapshot(name);
  await page.screenshot({
    path: `.next/probe-${name.toLowerCase()}.png`,
    fullPage: false,
  });
  void s;
}

// Back to the conversation rung for the pixel assertions.
await selectRung("Conversation");
const conv = await snapshot("conversation");

console.log("--- invariants ---");
console.log(
  "conversation renders turns:",
  conv.conversations > 0 ? "PASS" : "FAIL",
);
console.log("exactly one armed gate:", conv.armed === 1 ? "PASS" : `FAIL(${conv.armed})`);
console.log("no console errors:", errors.length === 0 ? "PASS" : `FAIL ${errors.length}`);
console.log("errors:", errors.slice(0, 8));

await browser.close();
