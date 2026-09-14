/**
 * Rail-highlight probe — the picked strand must be a CURVE, not a line.
 *
 * THE BUG THIS EXISTS FOR, reported twice. Selecting a strand used to scale
 * that strand's share of the braid's shared spin to zero, so it left the helix
 * and ran straight up its own seat: a second straight vertical, parallel to the
 * core and beside it. The reader described it exactly — "highlight one of the
 * grey surrounding curves, do not draw a new line" — and the second time they
 * had a screenshot.
 *
 * It is a rendering property, so nothing in the unit suite can see it: the
 * geometry is computed inside a `useFrame` callback against a live camera, and
 * `winding.ts` (which IS unit-tested) is correct either way — it is the
 * component that was passing it a different `unwind`. So this probe reads the
 * PIXELS.
 *
 * HOW IT MEASURES A CURVE. Take the strand's own palette colour off its swatch
 * in the popover, find every pixel in the rail's strip within tolerance of that
 * colour, and take the horizontal spread of their x positions. A thread wound
 * around the core crosses the strip, so its pixels fan out across the cylinder's
 * diameter; a thread that has been straightened sits at one x for its whole
 * length and spreads by the tube's width. The two are not close — measured:
 * ~20px of spread against ~2px — so the threshold is not a tuning exercise.
 *
 * Usage: node scripts/probe-rail-highlight.mjs [--base http://localhost:3000]
 */
import { chromium } from "@playwright/test";

const BASE = process.env.SCREENSHOT_BASE ?? "http://localhost:3000";
const baseArg = process.argv.indexOf("--base");
const base = baseArg >= 0 ? process.argv[baseArg + 1] : BASE;

/** The rail strip, in CSS px, excluding the floating chrome at the top and the
 *  dev-mode indicator at the bottom. */
const CLIP = { x: 0, y: 60, width: 64, height: 760 };

/** How far apart the picked strand's pixels must range across x, in CSS px, to
 *  count as wound around the core rather than straightened beside it. The
 *  cylinder's on-screen diameter is ~25px at this tier; a straight tube is its
 *  own ~2px width. 8 is nearer the straight case than the curve case on
 *  purpose: it fails the bug decisively and cannot fail a legitimate render. */
const MIN_SPREAD_PX = 8;

const browser = await chromium.launch({ headless: true });
let failures = 0;
const check = (name, ok, detail = "") => {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  ${detail}` : ""}`);
};

try {
  const ctx = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 2,
  });
  const page = await ctx.newPage();
  await page.goto(`${base}/en?z=slice`, {
    waitUntil: "domcontentloaded",
    timeout: 60_000,
  });
  await page.waitForTimeout(9000);

  // Open the strand selector (the board bar's last control) and take the first
  // strand that is actually offered.
  const board = page.locator("[data-board-bar]");
  await board.getByRole("button").last().click();
  await page.waitForTimeout(600);

  const popover = page.locator("[role=dialog]").last();
  const row = popover.getByRole("button").nth(1); // 0 is 「核心时间线」 (clears)
  const strandName = (await row.innerText()).trim().split("\n")[0];
  // The swatch's rendered background IS `strandColor(name)` — the palette
  // entry the canvas will paint the highlight in, read from the same source
  // rather than hard-coded here.
  //
  // It comes back as `lab(…)`, not `rgb(…)`: the palette is authored in oklch
  // and Chrome echoes the computed colour in whatever space it was written in.
  // So it is RASTERISED rather than parsed — the identical two-step the canvas
  // side does in `threadline-scene.tsx`'s `resolveCssHex`, and for the
  // identical reason (a string parser needs one grammar per colour space and
  // silently returns nothing for the ones it does not know).
  const [tr, tg, tb] = await row.evaluate((el) => {
    const swatch = el.querySelector("[style*='background'], span");
    const css = getComputedStyle(swatch ?? el).backgroundColor;
    const c = document.createElement("canvas");
    c.width = 1;
    c.height = 1;
    const g = c.getContext("2d");
    g.fillStyle = css;
    g.fillRect(0, 0, 1, 1);
    return [...g.getImageData(0, 0, 1, 1).data].slice(0, 3);
  });
  await row.click();
  await page.keyboard.press("Escape");
  // Let the focus tween (FOCUS_SMOOTH_SPEED) finish before the shutter.
  await page.waitForTimeout(2500);

  const resolved =
    Number.isFinite(tr) && (tr > 0 || tg > 0 || tb > 0);
  check(
    "the picked strand's palette colour resolved",
    resolved,
    `${strandName} → rgb(${tr}, ${tg}, ${tb})`,
  );

  if (resolved) {
    const shot = await page.screenshot({ clip: CLIP });
    // Decode in the browser: no PNG dependency, and the page already has a
    // canvas. Playwright hands us PNG bytes; an <img> + a 2D context is the
    // shortest path from those bytes to numbers.
    const spread = await page.evaluate(
      async ({ b64, tr, tg, tb, clip }) => {
        const img = new Image();
        img.src = "data:image/png;base64," + b64;
        await img.decode();
        const c = document.createElement("canvas");
        c.width = img.width;
        c.height = img.height;
        const g = c.getContext("2d");
        g.drawImage(img, 0, 0);
        const { data } = g.getImageData(0, 0, c.width, c.height);
        const scale = img.width / clip.width;
        let minX = Infinity;
        let maxX = -Infinity;
        let hits = 0;
        for (let i = 0; i < data.length; i += 4) {
          const r = data[i];
          const gg = data[i + 1];
          const b = data[i + 2];
          const a = data[i + 3];
          if (a < 200) continue;
          // Within tolerance of the strand's own colour...
          if (
            Math.abs(r - tr) > 46 ||
            Math.abs(gg - tg) > 46 ||
            Math.abs(b - tb) > 46
          ) {
            continue;
          }
          // ...and not a neutral pixel that happens to sit near it. The resting
          // bundle is grey, so low chroma is background no matter how close it
          // lands numerically.
          const chroma = Math.max(r, gg, b) - Math.min(r, gg, b);
          if (chroma < 24) continue;
          const x = ((i / 4) % c.width) / scale;
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          hits++;
        }
        return hits > 0 ? { spread: maxX - minX, hits } : { spread: -1, hits: 0 };
      },
      { b64: shot.toString("base64"), tr, tg, tb, clip: CLIP },
    );

    check(
      "the picked strand was found in the rail",
      spread.hits > 0,
      `${spread.hits} px of ${strandName}`,
    );
    check(
      "the picked strand WINDS around the core instead of running straight",
      spread.spread >= MIN_SPREAD_PX,
      `x spread ${spread.spread.toFixed(1)}px (straightening it drops this to ~2, a wound thread spans ~20)`,
    );
  }

  await ctx.close();
} finally {
  await browser.close();
}

console.log(
  failures === 0
    ? "\nThe highlight is a thread in the braid."
    : `\n${failures} check(s) failed.`,
);
process.exit(failures === 0 ? 0 : 1);
