/**
 * Tests for the window-view baker (src/lib/game/materials/window-view.ts).
 * The contract RoomWindow/RoomClerestory rely on: determinism per seed,
 * exact buffer shape, opaque pixels, a bright sky that lightens toward the
 * horizon haze, and — the whole point — actual STRUCTURE in the lower
 * half (two silhouette strata), never a uniform glowing plate.
 */
import { describe, it, expect } from "vitest";
import {
  buildWindowViewImage,
  WINDOW_VIEW_WIDTH,
  WINDOW_VIEW_HEIGHT,
  type WindowViewOptions,
} from "@/lib/game/materials/window-view";

const OPTS: WindowViewOptions = {
  seed: 12345,
  sky: "#a8c8e8",
  fog: "#c8d4e0",
  ground: "#7a8a6a",
  sunColor: "#ffd9b3",
};

function px(
  img: { width: number; data: Uint8ClampedArray },
  x: number,
  y: number,
): [number, number, number, number] {
  const i = (y * img.width + x) * 4;
  return [img.data[i], img.data[i + 1], img.data[i + 2], img.data[i + 3]];
}

describe("buildWindowViewImage", () => {
  it("is deterministic per seed and varies across seeds", () => {
    const a = buildWindowViewImage(OPTS);
    const b = buildWindowViewImage(OPTS);
    const c = buildWindowViewImage({ ...OPTS, seed: 999 });
    expect(Buffer.from(a.data).equals(Buffer.from(b.data))).toBe(true);
    expect(Buffer.from(a.data).equals(Buffer.from(c.data))).toBe(false);
  });

  it("returns an opaque RGBA buffer of the requested shape", () => {
    const img = buildWindowViewImage(OPTS);
    expect(img.width).toBe(WINDOW_VIEW_WIDTH);
    expect(img.height).toBe(WINDOW_VIEW_HEIGHT);
    expect(img.data.length).toBe(WINDOW_VIEW_WIDTH * WINDOW_VIEW_HEIGHT * 4);
    for (let i = 3; i < img.data.length; i += 4) {
      expect(img.data[i]).toBe(255);
    }
  });

  it("paints a sky that is bright at the top and hazier at the horizon", () => {
    const img = buildWindowViewImage(OPTS);
    const x = Math.floor(img.width / 2);
    const top = px(img, x, img.height - 1);
    const horizon = px(img, x, Math.floor(img.height * 0.45));
    const lum = (p: readonly [number, number, number, number]) =>
      p[0] + p[1] + p[2];
    // Both above 60% of white — the view reads as DAY, never a dark pit.
    expect(lum(top)).toBeGreaterThan(255 * 3 * 0.6);
    expect(lum(horizon)).toBeGreaterThan(255 * 3 * 0.6);
  });

  it("has silhouette structure in the lower half (not a glowing plate)", () => {
    const img = buildWindowViewImage(OPTS);
    // Sample a row near the bottom: a tree/roof line must produce real
    // variance across the row (uniform = the LED-panel bug).
    const y = Math.floor(img.height * 0.15);
    let min = 765;
    let max = 0;
    for (let x = 0; x < img.width; x++) {
      const p = px(img, x, y);
      const lum = p[0] + p[1] + p[2];
      if (lum < min) min = lum;
      if (lum > max) max = lum;
    }
    // The near layer's chunked skyline bumps its own value around.
    expect(max - min).toBeGreaterThan(8);
    // And the near silhouette is DARKER than the sky above it (depth by
    // value step — the orthographic camera's only parallax substitute).
    const sky = px(img, 10, img.height - 5);
    const near = px(img, 10, 3);
    expect(sky[0] + sky[1] + sky[2]).toBeGreaterThan(near[0] + near[1] + near[2]);
  });

  it("derives its hue from the palette (a blue room admits blue light)", () => {
    const blue = buildWindowViewImage({
      ...OPTS,
      sky: "#7aa0e0",
      fog: "#a0b8e0",
      sunColor: "#a0c0ff",
    });
    const warm = buildWindowViewImage({
      ...OPTS,
      sky: "#f0d0a0",
      fog: "#f0dcc0",
      sunColor: "#ffd0a0",
    });
    const x = Math.floor(blue.width / 2);
    const y = blue.height - 5;
    const bp = px(blue, x, y);
    const wp = px(warm, x, y);
    // Blue palette: B channel clearly above R; warm palette: the reverse.
    expect(bp[2]).toBeGreaterThan(bp[0]);
    expect(wp[0]).toBeGreaterThan(wp[2]);
  });
});


/* ------------------------------------------------------------------ */
/* v0.12 P3 — the biome skin's silhouette mix (skins.ts slot ④).      */
/* ------------------------------------------------------------------ */

const MIXES = [
  "soft-hills",
  "dunes",
  "treeline",
  "mist-forest",
  "open-water",
] as const;

/** Luminance of a pixel. */
function lum(p: readonly [number, number, number, number]): number {
  return p[0] + p[1] + p[2];
}

/** The brightest pixel's coordinates in the top half (the sun halo). */
function sunSpot(img: { width: number; height: number; data: Uint8ClampedArray }): {
  x: number;
  y: number;
} {
  let best = { x: -1, y: -1, l: -1 };
  for (let y = Math.floor(img.height / 2); y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      const l = lum(px(img, x, y));
      if (l > best.l) best = { x, y, l };
    }
  }
  return { x: best.x, y: best.y };
}

describe("silhouette mixes (v0.12 P3)", () => {
  it("omitted silhouette === soft-hills, byte-for-byte (default path unchanged)", () => {
    const legacy = buildWindowViewImage(OPTS);
    const softHills = buildWindowViewImage({ ...OPTS, silhouette: "soft-hills" });
    expect(Buffer.from(legacy.data).equals(Buffer.from(softHills.data))).toBe(true);
  });

  it("every mix bakes a different skyline", () => {
    const bytes = MIXES.map((silhouette) =>
      buildWindowViewImage({ ...OPTS, silhouette }),
    ).map((img) => Buffer.from(img.data));
    for (let i = 0; i < bytes.length; i++) {
      for (let j = i + 1; j < bytes.length; j++) {
        expect(bytes[i].equals(bytes[j]), `${MIXES[i]} vs ${MIXES[j]}`).toBe(false);
      }
    }
  });

  it("open-water paints no silhouette strata — a clean horizon", () => {
    const sea = buildWindowViewImage({ ...OPTS, silhouette: "open-water" });
    // The bottom 20% of the view must stay bright (no dark near/far
    // layer may reach it) — silhouettes top out at half height.
    let min = 765;
    for (let y = 0; y < Math.floor(sea.height * 0.2); y++) {
      for (let x = 0; x < sea.width; x++) {
        min = Math.min(min, lum(px(sea, x, y)));
      }
    }
    expect(min).toBeGreaterThan(255 * 3 * 0.55);
  });

  it("the sun keeps its seeded spot in every mix (silhouettes draw after the halo)", () => {
    const spots = MIXES.map((silhouette) =>
      sunSpot(buildWindowViewImage({ ...OPTS, silhouette })),
    );
    for (const spot of spots) {
      expect(spot).toEqual(spots[0]);
    }
  });

  it("a forest mix puts real structure in the lower half (not a glowing plate)", () => {
    const forest = buildWindowViewImage({ ...OPTS, silhouette: "treeline" });
    const y = Math.floor(forest.height * 0.15);
    let min = 765;
    let max = 0;
    for (let x = 0; x < forest.width; x++) {
      const l = lum(px(forest, x, y));
      if (l < min) min = l;
      if (l > max) max = l;
    }
    expect(max - min).toBeGreaterThan(8);
  });
});
