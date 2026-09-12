import { describe, expect, it } from "vitest";
import {
  anchorSpacingWorld,
  anchorWorldYs,
  KNOT_LAMBDA_MIN_FRACTION,
  KNOT_LAMBDA_VIEWPORT_FRACTION,
  knotLambda,
  MID_STRAND_LIMIT,
  NARROW_BAND_PX,
  NARROW_STRAND_LIMIT,
  strandLimitForBandWidth,
  WIDE_BAND_PX,
  WIDE_STRAND_LIMIT,
} from "@/lib/timeline3d/strand-band";
import type { FieldAnchor } from "@/lib/timeline3d/winding";

describe("strandLimitForBandWidth", () => {
  it("draws the narrow set on a chat / phone strip", () => {
    // The AxisBand's real widths: w-10 (phone timeline) and w-14 (chat).
    expect(strandLimitForBandWidth(40)).toBe(NARROW_STRAND_LIMIT);
    expect(strandLimitForBandWidth(56)).toBe(NARROW_STRAND_LIMIT);
    expect(strandLimitForBandWidth(NARROW_BAND_PX)).toBe(MID_STRAND_LIMIT);
  });

  it("draws an intermediate set while the band is mid-transition", () => {
    expect(strandLimitForBandWidth(120)).toBe(MID_STRAND_LIMIT);
    expect(strandLimitForBandWidth(WIDE_BAND_PX - 1)).toBe(MID_STRAND_LIMIT);
  });

  it("draws the full desktop set on the wide band", () => {
    // md:w-44 = 176 px.
    expect(strandLimitForBandWidth(WIDE_BAND_PX)).toBe(WIDE_STRAND_LIMIT);
    expect(strandLimitForBandWidth(1440)).toBe(WIDE_STRAND_LIMIT);
  });

  it("never exceeds the desktop limit and never goes non-positive", () => {
    for (const w of [0, -20, 40, 99, 100, 176, 4000, Number.NaN]) {
      const limit = strandLimitForBandWidth(w);
      expect(limit).toBeGreaterThan(0);
      expect(limit).toBeLessThanOrEqual(WIDE_STRAND_LIMIT);
    }
  });

  it("is monotone non-decreasing in width", () => {
    let prev = 0;
    for (let w = 0; w <= 400; w += 4) {
      const limit = strandLimitForBandWidth(w);
      expect(limit).toBeGreaterThanOrEqual(prev);
      prev = limit;
    }
  });
});

describe("anchorWorldYs", () => {
  it("maps the top of the viewport positive and the bottom negative", () => {
    const anchors: FieldAnchor[] = [
      { y: 0, strands: ["a"] },
      { y: 0.5, strands: ["a"] },
      { y: 1, strands: ["a"] },
    ];
    expect(anchorWorldYs(anchors, 4)).toEqual([2, 0, -2]);
  });

  it("keeps the anchors' order and converts each height", () => {
    const anchors: FieldAnchor[] = [
      { y: 0.25, strands: ["a"] },
      { y: 0.75, strands: ["b"] },
    ];
    expect(anchorWorldYs(anchors, 4)).toEqual([1, -1]);
  });

  it("returns empty for an empty field", () => {
    expect(anchorWorldYs([], 4)).toEqual([]);
  });
});

describe("anchorSpacingWorld", () => {
  it("returns null with fewer than two heights", () => {
    expect(anchorSpacingWorld([])).toBeNull();
    expect(anchorSpacingWorld([3])).toBeNull();
  });

  it("returns the gap for two heights, in either order", () => {
    expect(anchorSpacingWorld([0, 2])).toBe(2);
    expect(anchorSpacingWorld([2, 0])).toBe(2);
  });

  it("takes the median gap so a missing row cannot stretch the pitch", () => {
    // Four evenly pitched rows with a fifth far below (a catalog jump).
    expect(anchorSpacingWorld([10, 8, 6, 4, -40])).toBe(2);
  });

  it("ignores duplicate heights", () => {
    expect(anchorSpacingWorld([5, 5, 5])).toBeNull();
    expect(anchorSpacingWorld([5, 5, 7])).toBe(2);
  });
});

describe("knotLambda", () => {
  it("is half the row pitch — one turn spans the content row", () => {
    expect(knotLambda([0, 2, 4], 4.8)).toBeCloseTo(1, 9);
  });

  it("falls back to a fraction of the viewport with no pitch to measure", () => {
    expect(knotLambda([], 10)).toBeCloseTo(
      10 * KNOT_LAMBDA_VIEWPORT_FRACTION,
      9,
    );
    expect(knotLambda([7], 10)).toBeCloseTo(
      10 * KNOT_LAMBDA_VIEWPORT_FRACTION,
      9,
    );
  });

  it("never returns a non-positive or non-finite length", () => {
    const cases: number[][] = [[], [0], [0, 0], [Number.NaN, 1], [0, 1e-12]];
    for (const ys of cases) {
      const lambda = knotLambda(ys, 4.8);
      expect(Number.isFinite(lambda)).toBe(true);
      expect(lambda).toBeGreaterThanOrEqual(4.8 * KNOT_LAMBDA_MIN_FRACTION);
    }
  });
});
