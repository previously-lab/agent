/**
 * Elastic scroll — the settle physics' pure math.
 *
 * The contract under test, straight from the feature spec:
 *  - overscroll past the ends resists progressively and stays bounded;
 *  - the band holds while the input holds and releases by clamping back into
 *    the range when the hand goes quiet (the deadline that fires the clamp
 *    lives in card-field.tsx, not here).
 *
 * The idle snap-to-boundary that used to live beside the band was removed on
 * user decision (2026-09-29) — settling leaves the offset exactly where the
 * reader stopped — so there is nothing here to test about snapping.
 */
import { describe, expect, it } from "vitest";
import {
  elasticAdd,
  rubberOverscroll,
  RUBBER_BAND_PX,
} from "@/lib/timeline3d/field-snap";

describe("rubberOverscroll", () => {
  it("is zero at zero and near-identity for the first pixels", () => {
    expect(rubberOverscroll(0)).toBe(0);
    // slope 1 at the edge: a small push moves almost exactly its own length
    expect(rubberOverscroll(5)).toBeGreaterThan(4);
    expect(rubberOverscroll(5)).toBeLessThan(5);
  });

  it("never reaches the band, no matter how hard the push", () => {
    expect(rubberOverscroll(RUBBER_BAND_PX)).toBe(RUBBER_BAND_PX / 2);
    expect(rubberOverscroll(10_000)).toBeLessThan(RUBBER_BAND_PX);
    expect(rubberOverscroll(Number.POSITIVE_INFINITY)).toBe(RUBBER_BAND_PX);
  });

  it("resists progressively: each further px buys less", () => {
    const gains = [50, 100, 200, 400, 800].map(
      (o) => rubberOverscroll(o) - rubberOverscroll(o - 50),
    );
    for (let i = 1; i < gains.length; i++) {
      expect(gains[i]).toBeLessThan(gains[i - 1]);
    }
  });
});

describe("elasticAdd", () => {
  const min = -128;
  const max = 900;

  it("adds plainly inside the range", () => {
    expect(elasticAdd(300, 120, min, max)).toBe(420);
    expect(elasticAdd(300, -120, min, max)).toBe(180);
  });

  it("resists past the foot and never hard-stops", () => {
    const next = elasticAdd(max, 150, min, max);
    expect(next).toBeGreaterThan(max);
    expect(next - max).toBeLessThan(150); // progressive, not 1:1
    // the band holds: ten thousand px of push stays under the ceiling
    expect(elasticAdd(max, 10_000, min, max)).toBeLessThan(max + RUBBER_BAND_PX);
  });

  it("resists past the head symmetrically", () => {
    expect(elasticAdd(min, -150, min, max)).toBeLessThan(min);
    expect(elasticAdd(min, -10_000, min, max)).toBeGreaterThan(
      min - RUBBER_BAND_PX,
    );
  });
});
