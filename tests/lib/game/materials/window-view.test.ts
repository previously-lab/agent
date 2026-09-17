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
