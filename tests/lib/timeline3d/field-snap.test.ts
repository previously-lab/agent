/**
 * Elastic snap scrolling — the settle physics' pure math.
 *
 * The contract under test, straight from the feature spec:
 *  - snap targets are ROW BOUNDARIES off the shared offset table, never a
 *    card and never a constant height;
 *  - a row taller than the viewport never snaps (the reader stays EXACTLY
 *    where they stopped);
 *  - overscroll past the ends resists progressively and stays bounded;
 *  - the head and foot are the range's own rests — they always qualify, and
 *    they are what releases the rubber band.
 */
import { describe, expect, it } from "vitest";
import {
  elasticAdd,
  rubberOverscroll,
  RUBBER_BAND_PX,
  snapBoundaryFor,
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

describe("snapBoundaryFor", () => {
  // Four rows of 100px each: tops[0..3] = 0,100,200,300; total 400.
  const tops = [0, 100, 200, 300, 400];
  const total = 400;
  const min = -50;
  const max = 350;

  it("lands on the nearest row boundary, not on a card", () => {
    expect(snapBoundaryFor(tops, total, 150, min, max, 130, "future")).toBe(100);
    expect(snapBoundaryFor(tops, total, 150, min, max, 170, "future")).toBe(200);
  });

  it("reads geometry from the table, not a constant height", () => {
    // Uneven rows (as the turns rung measures them): 0, 250, 300.
    const uneven = [0, 250, 300, 300];
    expect(snapBoundaryFor(uneven, 300, 400, min, 300, 210, "future")).toBe(250);
    expect(snapBoundaryFor(uneven, 300, 400, min, 300, 240, "future")).toBe(250);
  });

  it("breaks an exact midpoint tie toward the direction of travel", () => {
    expect(snapBoundaryFor(tops, total, 150, min, max, 150, "future")).toBe(200);
    expect(snapBoundaryFor(tops, total, 150, min, max, 150, "past")).toBe(100);
  });

  it("never snaps when the nearest row is taller than the viewport", () => {
    // Row 0 is 500px tall against a 400px viewport.
    const tallFirst = [0, 500, 600, 600];
    expect(snapBoundaryFor(tallFirst, 600, 400, 0, 500, 100, "future")).toBeNull();
    // Even 1px below the boundary: the nearest boundary is the tall row's own
    // top, and it does not fit — no snap, not a skip to the next fitting row.
    expect(snapBoundaryFor(tallFirst, 600, 400, 0, 500, 1, "future")).toBeNull();
  });

  it("snaps to a fitting row when the gesture has left the tall one", () => {
    // Near the BOTTOM of the 500px row the next boundary (300px... here 500)
    // is the nearest — and that row fits.
    const tallFirst = [0, 500, 600, 600];
    expect(snapBoundaryFor(tallFirst, 600, 400, 0, 500, 470, "future")).toBe(500);
  });

  it("treats the head and foot as rests even when every row is tall", () => {
    const allTall = [0, 900, 1800, 1800];
    expect(snapBoundaryFor(allTall, 1800, 400, -100, 700, 640, "past")).toBe(700);
    expect(snapBoundaryFor(allTall, 1800, 400, -100, 700, -60, "future")).toBe(
      -100,
    );
  });

  it("releases the rubber band at the nearest end", () => {
    expect(snapBoundaryFor(tops, total, 150, min, max, max + 60, "future")).toBe(
      max,
    );
    expect(snapBoundaryFor(tops, total, 150, min, max, min - 60, "past")).toBe(
      min,
    );
  });

  it("ignores row tops outside the range (the foot rest covers the tail)", () => {
    // Row tops past max are not rests; the foot is. 220 is nearer 200, but
    // 230 has already passed the midpoint and belongs to the foot.
    expect(snapBoundaryFor(tops, total, 150, min, 250, 220, "future")).toBe(200);
    expect(snapBoundaryFor(tops, total, 150, min, 250, 230, "future")).toBe(250);
    expect(snapBoundaryFor(tops, total, 150, min, 250, 245, "future")).toBe(250);
  });

  it("returns null for an empty field or a range with no room", () => {
    expect(snapBoundaryFor([0], 0, 800, 0, 0, 0, "future")).toBeNull();
    expect(snapBoundaryFor(tops, total, 150, 100, 100, 100, "future")).toBeNull();
  });

  it("keeps the foot rest exact when the reader is already there", () => {
    expect(snapBoundaryFor(tops, total, 150, min, max, max, "future")).toBe(max);
  });
});
