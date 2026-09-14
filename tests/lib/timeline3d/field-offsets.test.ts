import { describe, expect, it } from "vitest";
import {
  anchorScrollFor,
  buildOffsets,
  unitAtPx,
  visibleRangeFor,
} from "@/lib/timeline3d/field-offsets";

describe("buildOffsets", () => {
  it("walks a uniform height into a running table", () => {
    const { tops, total } = buildOffsets(4, () => 100, 320);
    expect(tops).toEqual([0, 100, 200, 300, 400]);
    expect(total).toBe(400);
  });

  it("has one more entry than units, so the last is the total extent", () => {
    const { tops } = buildOffsets(3, () => 50, 320);
    expect(tops).toHaveLength(4);
  });

  it("carries the last real height across an unmeasured unit", () => {
    // The field's whole contract is that a unit which has not reported yet
    // cannot move the ones above it, so an index with no height inherits one.
    const heights = [200, 0, 0, 300];
    const { tops } = buildOffsets(4, (i) => heights[i], 320);
    expect(tops).toEqual([0, 200, 400, 600, 900]);
  });

  it("seeds from the first positive height ANYWHERE, not the first seen", () => {
    // A window whose head has not measured still sizes itself like the blocks
    // it is made of rather than like the fallback estimate.
    const heights = [0, 0, 250];
    const { tops } = buildOffsets(3, (i) => heights[i], 320);
    expect(tops).toEqual([0, 250, 500, 750]);
  });

  it("falls back when nothing has measured", () => {
    const { tops, total } = buildOffsets(2, () => 0, 320);
    expect(tops).toEqual([0, 320, 640]);
    expect(total).toBe(640);
  });

  it("is degenerate but well-formed for an empty list", () => {
    const { tops, total } = buildOffsets(0, () => 100, 320);
    expect(tops).toEqual([0]);
    expect(total).toBe(0);
  });
});

describe("visibleRangeFor", () => {
  // Five 100px units: [0,500).
  const table = buildOffsets(5, () => 100, 100).tops;

  it("returns the units intersecting the viewport", () => {
    expect(visibleRangeFor(table, 5, 0, 200, 0, 100)).toEqual([0, 1, 2]);
  });

  it("includes a unit the viewport only clips", () => {
    expect(visibleRangeFor(table, 5, 150, 100, 0, 100)).toEqual([1, 2]);
  });

  it("grows the window by the margin on both sides", () => {
    // The range is CLOSED at both ends, so a unit that merely touches an edge
    // counts as intersecting it.
    expect(visibleRangeFor(table, 5, 200, 100, 100, 100)).toEqual([0, 1, 2, 3, 4]);
  });

  it("collapses units past the end of a stale table onto the origin", () => {
    // The frames between a unit list growing and its table being rebuilt. A
    // unit with no entry in the table has no position yet, so it reads as
    // starting at 0 — which is inside the window, so it mounts, measures, and
    // is placed by the next frame's table. Mounting extra units for one frame
    // is the safe direction; dropping units the reader can see is not.
    const stale = table.slice(0, 3); // tops for 2 units, asked about 4
    expect(visibleRangeFor(stale, 4, 0, 200, 0, 100)).toEqual([0, 1, 2, 3]);
  });

  it("returns nothing when the viewport is far from every unit", () => {
    expect(visibleRangeFor(table, 5, 5000, 100, 0, 100)).toEqual([]);
  });
});

describe("anchorScrollFor", () => {
  const table = buildOffsets(10, () => 100, 100).tops;

  it("lands the anchor's centre on the requested screen line", () => {
    // Unit 3 spans [300,400); its centre is 350. At screen line 50 the scroll
    // must be 300.
    expect(anchorScrollFor(table, 3, 100, 50, 0, 1000)).toBe(300);
  });

  it("preserves an anchor's off-centre screen position", () => {
    // The point of the screenY argument: a rung change re-anchors, and it must
    // keep where the reader was looking rather than centring the unit.
    expect(anchorScrollFor(table, 3, 100, 200, 0, 1000)).toBe(150);
  });

  it("clamps to the content", () => {
    expect(anchorScrollFor(table, 0, 100, 50, 0, 1000)).toBe(0);
    expect(anchorScrollFor(table, 9, 100, 50, 0, 100)).toBe(100);
  });

  it("accepts a negative minimum (a field with a head region)", () => {
    expect(anchorScrollFor(table, 0, 100, 50, -128, 1000)).toBe(0);
    expect(anchorScrollFor(table, 0, 100, 200, -128, 1000)).toBe(-128);
  });
});

describe("unitAtPx", () => {
  const table = buildOffsets(5, () => 100, 100).tops;

  it("finds the unit containing a position", () => {
    expect(unitAtPx(table, 5, 0)).toBe(0);
    expect(unitAtPx(table, 5, 99)).toBe(0);
    expect(unitAtPx(table, 5, 100)).toBe(1);
    expect(unitAtPx(table, 5, 450)).toBe(4);
  });

  it("answers with the nearest unit past either end", () => {
    // A clamped scroll can land a hair outside; that is a rounding artefact,
    // not a place with no unit.
    expect(unitAtPx(table, 5, 999)).toBe(4);
    expect(unitAtPx(table, 5, -50)).toBe(0);
  });

  it("returns -1 when there is nothing to be inside of", () => {
    expect(unitAtPx(table, 0, 0)).toBe(-1);
  });
});
