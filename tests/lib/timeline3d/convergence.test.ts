import { describe, it, expect } from "vitest";
import {
  radiusEnvelopeAt,
  screenFractionToWorldY,
} from "@/lib/timeline3d/convergence";

describe("radiusEnvelopeAt", () => {
  const opts = { depth: 0.7, sigma: 1 };

  it("is at its minimum (1 - depth) at an anchor center", () => {
    expect(radiusEnvelopeAt(0, [0], opts)).toBeCloseTo(0.3, 10);
    expect(radiusEnvelopeAt(5, [-3, 5], opts)).toBeCloseTo(0.3, 10);
  });

  it("approaches 1 far from every anchor", () => {
    expect(radiusEnvelopeAt(10, [0], opts)).toBeCloseTo(1, 6);
    expect(radiusEnvelopeAt(-10, [0], opts)).toBeCloseTo(1, 6);
  });

  it("takes the strongest pinch across multiple anchors", () => {
    // Near anchor A only → A's envelope; between two equal-distance anchors
    // the pinch is deeper than either alone at the same distance.
    const nearA = radiusEnvelopeAt(-1, [-1, 8], opts);
    const nearB = radiusEnvelopeAt(8, [-1, 8], opts);
    const far = radiusEnvelopeAt(3.5, [-1, 8], opts);
    expect(nearA).toBeLessThan(0.75);
    expect(nearB).toBeLessThan(0.75);
    expect(far).toBeGreaterThan(nearA);
    expect(far).toBeGreaterThan(nearB);
    // The minimum bound holds everywhere.
    for (const v of [nearA, nearB, far]) {
      expect(v).toBeGreaterThanOrEqual(1 - opts.depth);
      expect(v).toBeLessThanOrEqual(1);
    }
  });

  it("returns 1 for empty anchors", () => {
    expect(radiusEnvelopeAt(0, [], opts)).toBe(1);
  });

  it("clamps depth to [0, 1]", () => {
    expect(radiusEnvelopeAt(0, [0], { depth: 2, sigma: 1 })).toBeCloseTo(
      0,
      10,
    );
    expect(
      radiusEnvelopeAt(0, [0], { depth: -1, sigma: 1 }),
    ).toBeCloseTo(1, 10);
    expect(
      radiusEnvelopeAt(0, [0], { depth: 0, sigma: 1 }),
    ).toBeCloseTo(1, 10);
  });

  it("is symmetric around the anchor and σ controls the width", () => {
    const w = (d: number, sigma: number) =>
      radiusEnvelopeAt(d, [0], { depth: 0.7, sigma });
    expect(w(1, 1)).toBeCloseTo(w(-1, 1), 12);
    // A wider sigma pinches a WIDER band: at a fixed offset the coefficient
    // sits closer to the center minimum.
    expect(w(1, 2)).toBeLessThan(w(1, 1));
    expect(w(3, 2)).toBeLessThan(w(3, 1));
  });

  it("handles degenerate sigma", () => {
    expect(radiusEnvelopeAt(0, [0], { depth: 0.7, sigma: 0 })).toBeCloseTo(
      0.3,
      10,
    );
    expect(radiusEnvelopeAt(0.1, [0], { depth: 0.7, sigma: 0 })).toBe(1);
  });
});

describe("screenFractionToWorldY", () => {
  it("maps 0.5 to 0, 0 to +h/2, 1 to -h/2", () => {
    expect(screenFractionToWorldY(0.5, 10)).toBe(0);
    expect(screenFractionToWorldY(0, 10)).toBe(5);
    expect(screenFractionToWorldY(1, 10)).toBe(-5);
  });
});
