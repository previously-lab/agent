/**
 * Clipping probe — the regression test for the responsive field.
 *
 * WHY THIS EXISTS. The field had no responsive concept: `CONVERSATION_COLUMN_PX`
 * was a flat 680 and the camera is derived from viewport HEIGHT, so the reading
 * column was 680px wide on a 390px phone. The field wrapper is `overflow-hidden`
 * and owns its own virtual scroll, so the overflow was not scrollable — it was
 * silently CROPPED. Measured before the fix:
 *
 *     1440×900  0/16 clipped      390×844  14/16 clipped
 *      768×1024  0/16 clipped      320×568  14/15 clipped
 *
 * This script is that measurement, kept. It walks every tier boundary and fails
 * on any text node that leaves the viewport. Run it against a live dev server.
 *
 * Usage:
 *   node scripts/probe-clipping.mjs                 # assert, exit 1 on failure
 *   node scripts/probe-clipping.mjs --verbose       # print every clipped node
 *   node scripts/probe-clipping.mjs --base http://localhost:3000
 *
 * NOTE: from Git Bash (MSYS) a leading-slash route gets path-converted. Run
 * from PowerShell, or prefix MSYS_NO_PATHCONV=1.
 */
import { chromium } from "@playwright/test";

const BASE = process.env.SCREENSHOT_BASE ?? "http://localhost:3000";

/** Every tier boundary, plus the common devices inside each tier. */
const VIEWPORTS = [
  { name: "phone-320", width: 320, height: 568 },
  { name: "phone-390", width: 390, height: 844 },
  { name: "tablet-640", width: 640, height: 900 },
  { name: "tablet-768", width: 768, height: 1024 },
  { name: "laptop-1024", width: 1024, height: 768 },
  { name: "laptop-1440", width: 1440, height: 900 },
  { name: "wide-1600", width: 1600, height: 1000 },
];

const ROUTES = [
  { name: "conversation", path: "/en" },
  { name: "slice-rung", path: "/en?z=slice" },
];

/** Fewest long text nodes a genuinely rendered route can have. Well under what
 *  either route actually produces, so it guards against a blank or errored page
 *  without being brittle about content. */
const MIN_EXPECTED_NODES = 8;

/** A text node is CLIPPED when its box leaves the viewport horizontally. The
 *  field crops rather than scrolls, so there is no scroll position that would
 *  bring it back — being outside the viewport IS the failure. */
const MEASURE = () => {
  const clipped = [];
  let total = 0;
  const els = document.querySelectorAll(
    "p, h1, h2, h3, span, li, blockquote, td, div",
  );
  for (const el of els) {
    if (el.childElementCount > 0) continue;
    const text = el.textContent?.trim() ?? "";
    if (text.length < 24) continue;
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    total++;
    // 1px of slack: sub-pixel layout rounds, and a box flush to the edge is
    // not clipping. Anything past that is content the reader cannot reach.
    if (r.left < -1 || r.right > window.innerWidth + 1) {
      clipped.push({
        text: text.slice(0, 40),
        left: Math.round(r.left),
        right: Math.round(r.right),
      });
    }
  }
  return {
    total,
    clipped,
    innerWidth: window.innerWidth,
    docScrollWidth: document.documentElement.scrollWidth,
    // The card's root em — the number the portrait variant exists to raise.
    cardFontSize: (() => {
      const card = document.querySelector('[data-card-field] [style*="font-size"]');
      return card
        ? Math.round(parseFloat(getComputedStyle(card).fontSize) * 10) / 10
        : null;
    })(),
  };
};

const verbose = process.argv.includes("--verbose");
const baseArg = process.argv.indexOf("--base");
const base = baseArg >= 0 ? process.argv[baseArg + 1] : BASE;

const browser = await chromium.launch({ headless: true });
let failures = 0;
try {
  for (const vp of VIEWPORTS) {
    for (const route of ROUTES) {
      const ctx = await browser.newContext({
        viewport: { width: vp.width, height: vp.height },
        deviceScaleFactor: 1,
        colorScheme: "dark",
      });
      const page = await ctx.newPage();
      await page.goto(`${base}${route.path}`, {
        waitUntil: "networkidle",
        timeout: 30_000,
      });
      await page.waitForTimeout(2500);
      const m = await page.evaluate(MEASURE);
      // A PAGE THAT RENDERED NOTHING IS NOT A PASS. This probe once reported
      // "all viewports clean" against a dev server returning 500, because zero
      // text nodes means zero clipped text nodes. The floor below is what makes
      // the assertion mean something: every route here has a loaded
      // conversation, so a real render always has text to measure.
      const empty = m.total < MIN_EXPECTED_NODES;
      const ok = !empty && m.clipped.length === 0;
      if (!ok) failures++;
      console.log(
        `${ok ? "PASS" : "FAIL"}  ${vp.name.padEnd(12)} ${route.name.padEnd(13)} ` +
          `clipped ${String(m.clipped.length).padStart(2)}/${String(m.total).padEnd(3)}` +
          (m.cardFontSize ? `  card-em ${m.cardFontSize}px` : "") +
          (m.docScrollWidth > m.innerWidth ? `  OVERFLOW ${m.docScrollWidth}` : "") +
          (empty ? "  <- NO TEXT RENDERED (page did not load?)" : ""),
      );
      if (verbose && !ok) {
        for (const c of m.clipped.slice(0, 6)) {
          console.log(`        [${c.left}..${c.right}] "${c.text}"`);
        }
      }
      await ctx.close();
    }
  }
} finally {
  await browser.close();
}

console.log(
  failures === 0
    ? "\nAll viewports clean — no clipped text."
    : `\n${failures} viewport/route combination(s) still clip text.`,
);
process.exit(failures === 0 ? 0 : 1);
