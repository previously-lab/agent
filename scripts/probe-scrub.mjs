/**
 * Scrub probe — drives the time rail and checks the field actually moved.
 *
 * The scrubber is the kind of feature that looks right in a screenshot and does
 * nothing: the pointer surface can sit under a canvas, the seek can be written
 * to an object nobody reads, the field can own the feed on the wrong predicate.
 * So this drives the real gesture and the real keys, and reads the result back
 * off the rendered pixels.
 *
 * WHY PIXELS. Every cheaper observable was tried and each one lied:
 *
 *   - The canvas wrapper's `innerText` is empty — drei's `<Html>` mounts into a
 *     separate React root, so the billboards are not its descendants.
 *   - `document.body.innerText` is SCROLL-INVARIANT in the conversation field:
 *     every block stays mounted, so the text does not change when the camera
 *     moves, only where it is drawn. It reported "End does nothing" for a field
 *     that was moving correctly, and its other checks passed only because the
 *     scrub readout's text happened to be in the string.
 *   - Portal `transform` values are right for the conversation field
 *     (`translate3d`) but the card field renders through `<Html transform>` and
 *     gets a `matrix3d` — so that selector missed the timeline entirely and
 *     silently measured the hidden chat field behind it.
 *
 * Usage:
 *   node scripts/probe-scrub.mjs [--base http://localhost:3000] [--shot out.png]
 *
 * NOTE: from Git Bash (MSYS) a leading-slash route gets path-converted. Run
 * from PowerShell, or prefix MSYS_NO_PATHCONV=1.
 */
import { chromium } from "@playwright/test";

const BASE = process.env.SCREENSHOT_BASE ?? "http://localhost:3000";
const baseArg = process.argv.indexOf("--base");
const base = baseArg >= 0 ? process.argv[baseArg + 1] : BASE;
/** `--shot <path>` captures the field mid-drag, with the thumb and readout up. */
const shotArg = process.argv.indexOf("--shot");
const shot = shotArg >= 0 ? process.argv[shotArg + 1] : null;

/**
 * The visible field region. Excludes the band (x < 80), the header (y < 120)
 * and the lens pill (bottom-right), so it is field content and nothing else.
 */
const CLIP = { x: 80, y: 120, width: 1100, height: 600 };

/** A pixel fingerprint of the field region. */
const fingerprint = async (page) =>
  (await page.screenshot({ clip: CLIP })).toString("base64");

/** Did the page render a field at all? A guard against a 500 or a blank page
 *  passing every movement check by never changing. */
const renderedNodes = () =>
  [...document.querySelectorAll("p, div, span, h1, h2, h3, li")].filter((el) => {
    if (el.childElementCount > 0) return false;
    if (el.closest('[aria-hidden="true"]')) return false;
    const text = (el.textContent ?? "").trim();
    if (text.length < 20) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }).length;

// Both fields are in the DOM at once — the chat pane stays mounted behind the
// timeline — so a compound selector picks whichever comes first in document
// order, which is the HIDDEN one. Name the visible field explicitly.
const ROUTES = [
  { path: "/en?z=slice", field: "[data-card-field]" },
  { path: "/en", field: "[data-conversation-field]" },
];

const browser = await chromium.launch({ headless: true });
let failures = 0;
const check = (name, ok, detail = "") => {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  ${detail}` : ""}`);
};

try {
  for (const { path: route, field: fieldSel } of ROUTES) {
    const ctx = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      deviceScaleFactor: 1,
      colorScheme: "dark",
    });
    const page = await ctx.newPage();
    await page.goto(`${base}${route}`, {
      waitUntil: "networkidle",
      timeout: 30_000,
    });
    await page.waitForTimeout(3000);

    const surface = page.locator("[data-scrub-surface]");
    const count = await surface.count();
    check(`${route} — scrub surface exists`, count === 1, `found ${count}`);
    if (count !== 1) {
      await ctx.close();
      continue;
    }

    const box = await surface.first().boundingBox();
    check(
      `${route} — surface has a hit area`,
      !!box && box.height > 100,
      box ? `${Math.round(box.width)}x${Math.round(box.height)}` : "none",
    );
    if (!box) {
      await ctx.close();
      continue;
    }

    const nodes = await page.evaluate(renderedNodes);
    check(`${route} — field rendered something`, nodes >= 3, `${nodes} text nodes`);

    const before = await fingerprint(page);

    // A real press-drag-release down the rail: from 20% to 75% of its height.
    const x = box.x + box.width / 2;
    const fromY = box.y + box.height * 0.2;
    const toY = box.y + box.height * 0.75;

    await page.mouse.move(x, fromY);
    await page.mouse.down();

    // The readout must be live while the pointer is down — and it must NAME
    // the landing, not report a fraction, which is the whole reason the band
    // reads the field's anchors instead of interpolating from progress.
    let midReadout = "";
    for (let i = 1; i <= 8; i++) {
      await page.mouse.move(x, fromY + ((toY - fromY) * i) / 8);
      await page.waitForTimeout(70);
      const r = await page
        .locator("[data-scrub-readout]")
        .evaluate((el) => el.textContent ?? "")
        .catch(() => "");
      if (r) midReadout = r;
    }
    check(
      `${route} — readout names the landing while dragging`,
      midReadout.length > 0,
      midReadout ? `"${midReadout}"` : "empty",
    );

    if (shot) {
      await page.screenshot({ path: shot });
      console.log(`      captured mid-drag → ${shot}`);
    }

    await page.mouse.up();
    await page.waitForTimeout(1400);

    const after = await fingerprint(page);
    check(
      `${route} — the field MOVED`,
      before !== after,
      before === after ? "pixels identical before/after" : "",
    );

    // HOME FIRST, then End. Both fields land at the NEWEST end on mount, so
    // pressing End first is a no-op by definition and reads as a failure — the
    // first version of this probe reported "End does nothing" for exactly that
    // reason. Home always has somewhere to go; End then has to come back.
    const field = page.locator(fieldSel).first();
    await field.focus().catch(() => {});
    const beforeKey = await fingerprint(page);

    await page.keyboard.press("Home");
    await page.waitForTimeout(1600);
    const afterHome = await fingerprint(page);
    check(
      `${route} — Home key moves the field`,
      beforeKey !== afterHome,
      beforeKey === afterHome ? "no movement on Home" : "",
    );

    await page.keyboard.press("End");
    await page.waitForTimeout(1600);
    const afterEnd = await fingerprint(page);
    check(
      `${route} — End key moves the field back`,
      afterHome !== afterEnd,
      afterHome === afterEnd ? "no movement on End" : "",
    );

    await ctx.close();
  }
} finally {
  await browser.close();
}

console.log(
  failures === 0 ? "\nScrub rail works." : `\n${failures} check(s) failed.`,
);
process.exit(failures === 0 ? 0 : 1);
