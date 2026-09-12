import { describe, expect, it } from "vitest";
import {
  activityYsByStrand,
  type FieldAnchor,
  laneAngleFor,
  laneDepthFor,
  smoothstep01,
  spinAt,
  strandPointAt,
  topStrands,
  wrapWeightAt,
} from "@/lib/timeline3d/winding";

const TAU = Math.PI * 2;

/** A lateral point's angle, unwrapped past the ±π seam into [0, TAU). */
function angleOf(p: { x: number; z: number }): number {
  const a = Math.atan2(p.z, p.x);
  return a < 0 ? a + TAU : a;
}

/** A lateral point's distance from the core (the band's vertical axis). */
function radiusOf(p: { x: number; z: number }): number {
  return Math.hypot(p.x, p.z);
}

/** The gap from `a` to `b` going forward around the core, in [0, TAU). */
function gapOf(a: number, b: number): number {
  return (((b - a) % TAU) + TAU) % TAU;
}

/** The signed angle that takes `from` to `to` the short way round. */
function shortestAngleDelta(from: number, to: number): number {
  let delta = (to - from) % TAU;
  if (delta > Math.PI) delta -= TAU;
  else if (delta <= -Math.PI) delta += TAU;
  return delta;
}

describe("smoothstep01", () => {
  it("clamps below 0 and above 1", () => {
    expect(smoothstep01(-3)).toBe(0);
    expect(smoothstep01(0)).toBe(0);
    expect(smoothstep01(1)).toBe(1);
    expect(smoothstep01(4)).toBe(1);
  });

  it("is 0.5 at the midpoint and monotone across [0,1]", () => {
    expect(smoothstep01(0.5)).toBeCloseTo(0.5, 9);
    let prev = -1;
    for (let t = 0; t <= 1; t += 0.01) {
      const v = smoothstep01(t);
      expect(v).toBeGreaterThanOrEqual(prev);
      prev = v;
    }
  });
});

describe("wrapWeightAt", () => {
  const centerY = 0;
  const lambda = 2;

  it("is 1 exactly at the centre", () => {
    expect(wrapWeightAt(centerY, centerY, lambda)).toBe(1);
    expect(wrapWeightAt(5, 5, lambda)).toBe(1);
  });

  it("is exactly 0 at ±lambda and beyond", () => {
    // The knot's window has to be EXACT at its edges, not merely small:
    // otherwise neighbouring knots bleed into each other and the bundle never
    // gets back to a straight line.
    expect(wrapWeightAt(centerY - lambda, centerY, lambda)).toBe(0);
    expect(wrapWeightAt(centerY + lambda, centerY, lambda)).toBe(0);
    expect(wrapWeightAt(centerY - 10 * lambda, centerY, lambda)).toBe(0);
    expect(wrapWeightAt(centerY + 10 * lambda, centerY, lambda)).toBe(0);
  });

  it("rises on the way in and falls on the way out, inside 0..1", () => {
    let prev = -1;
    for (let t = -1; t <= 0; t += 0.02) {
      const w = wrapWeightAt(centerY + t * lambda, centerY, lambda);
      expect(w).toBeGreaterThan(prev);
      expect(w).toBeGreaterThanOrEqual(0);
      expect(w).toBeLessThanOrEqual(1);
      prev = w;
    }
    prev = Infinity;
    for (let t = 0; t <= 1; t += 0.02) {
      const w = wrapWeightAt(centerY + t * lambda, centerY, lambda);
      expect(w).toBeLessThan(prev);
      expect(w).toBeGreaterThanOrEqual(0);
      expect(w).toBeLessThanOrEqual(1);
      prev = w;
    }
  });

  it("is symmetric about the centre", () => {
    for (const d of [0.1, 0.5, 1, 1.5, 1.9]) {
      expect(wrapWeightAt(centerY + d, centerY, lambda)).toBeCloseTo(
        wrapWeightAt(centerY - d, centerY, lambda),
        12,
      );
    }
  });

  it("treats a degenerate lambda as a point wound only at its centre", () => {
    for (const degenerate of [0, -3]) {
      expect(wrapWeightAt(centerY, centerY, degenerate)).toBe(1);
      expect(wrapWeightAt(centerY + 1e-3, centerY, degenerate)).toBe(0);
      expect(wrapWeightAt(centerY - 1e-3, centerY, degenerate)).toBe(0);
      expect(wrapWeightAt(100, centerY, degenerate)).toBe(0);
    }
  });
});

describe("spinAt", () => {
  const centerY = 0;
  const lambda = 2;
  const turns = 1;

  it("is exactly zero below the knot and a full turn at its far edge", () => {
    expect(spinAt(centerY - lambda, centerY, lambda, turns)).toBe(0);
    expect(spinAt(centerY - 10 * lambda, centerY, lambda, turns)).toBe(0);
    expect(spinAt(centerY + lambda, centerY, lambda, turns)).toBeCloseTo(
      TAU * turns,
      9,
    );
  });

  it("is monotone across the knot, so the bundle turns as one", () => {
    let prev = -1;
    for (let t = -1; t <= 1; t += 0.02) {
      const s = spinAt(centerY + t * lambda, centerY, lambda, turns);
      expect(s).toBeGreaterThanOrEqual(prev);
      prev = s;
    }
  });

  it("is half way through its turns at the centre", () => {
    expect(spinAt(centerY, centerY, lambda, turns)).toBeCloseTo(
      Math.PI * turns,
      9,
    );
  });

  it("scales with turns — the one knob on the shared rotation", () => {
    expect(
      spinAt(centerY, centerY, lambda, 2) - spinAt(centerY, centerY, lambda, 1),
    ).toBeCloseTo(Math.PI, 9);
  });

  it("treats a degenerate lambda as no rotation", () => {
    for (const degenerate of [0, -3]) {
      expect(spinAt(centerY, centerY, degenerate, turns)).toBe(0);
      expect(spinAt(centerY + 5, centerY, degenerate, turns)).toBe(0);
    }
  });
});

describe("strandPointAt", () => {
  const count = 5;
  const centerY = 0;
  const lambda = 2;
  const radius = 0.8;
  const turns = 1;

  /** The strand's angle at a height, for seat-index arithmetic. */
  const angleAt = (y: number, index: number): number =>
    angleOf(strandPointAt(y, index, count, centerY, lambda, radius, turns));

  /** The point a bare seat sits at on the cylinder — the "rest" position. */
  const seatPoint = (y: number, index: number): { x: number; z: number } => {
    const a = laneAngleFor(index, count);
    return { x: radius * Math.cos(a), z: radius * Math.sin(a) };
  };

  it("is a straight vertical line at its own seat away from the knot", () => {
    // `spin` is exactly 0 below the knot, so the angle IS the seat and the
    // position IS that seat's point on the cylinder — a vertical line, because
    // x and z do not change with y.
    for (const index of [0, 1, 2, 3, 4]) {
      const seat = seatPoint(0, index);
      for (const y of [
        centerY - lambda,
        centerY - lambda - 1,
        centerY - 10 * lambda,
      ]) {
        const p = strandPointAt(y, index, count, centerY, lambda, radius, turns);
        expect(spinAt(y, centerY, lambda, turns)).toBe(0);
        expect(p.y).toBe(y);
        expect(p.x).toBeCloseTo(seat.x, 12);
        expect(p.z).toBeCloseTo(seat.z, 12);
      }
    }
  });

  it("closes the helix: the line above the knot is the line below it", () => {
    // A whole number of turns lands every strand back on its OWN seat, so the
    // cable above the card is the same straight vertical line it was below —
    // which is why one formula can cover the whole height with no seam.
    for (const index of [0, 1, 2, 3, 4]) {
      const below = strandPointAt(
        centerY - lambda,
        index,
        count,
        centerY,
        lambda,
        radius,
        turns,
      );
      for (const y of [centerY + lambda, centerY + 10 * lambda]) {
        const above = strandPointAt(y, index, count, centerY, lambda, radius, turns);
        expect(above.x).toBeCloseTo(below.x, 12);
        expect(above.z).toBeCloseTo(below.z, 12);
      }
    }
  });

  it("advances the angle monotonically through the knot and makes exactly `turns` turns", () => {
    const steps = 400;
    for (let index = 0; index < count; index++) {
      let travelled = 0;
      let prev = angleAt(centerY - lambda, index);
      for (let k = 1; k <= steps; k++) {
        const a = angleAt(centerY + (k / steps - 0.5) * 2 * lambda, index);
        const step = shortestAngleDelta(prev, a);
        // Never backwards: one shared rotation, always the same way round.
        expect(step).toBeGreaterThanOrEqual(-1e-12);
        travelled += step;
        prev = a;
      }
      // …and it carries the strand exactly `turns` times around the core over
      // the knot, so it comes out on its own seat.
      expect(travelled).toBeCloseTo(TAU * turns, 9);
      expect(
        shortestAngleDelta(
          laneAngleFor(index, count),
          angleAt(centerY + lambda, index),
        ),
      ).toBeCloseTo(0, 9);
    }
  });

  it("scales the turns with `turns` — the shared rotation's only knob", () => {
    for (let index = 0; index < count; index++) {
      const seat = laneAngleFor(index, count);
      const at = (turns: number, t: number): number =>
        angleOf(
          strandPointAt(
            centerY + t * lambda,
            index,
            count,
            centerY,
            lambda,
            radius,
            turns,
          ),
        );
      // Both carry a whole number of turns, so both land back on the seat…
      expect(shortestAngleDelta(seat, at(1, 1))).toBeCloseTo(0, 9);
      expect(shortestAngleDelta(seat, at(2, 1))).toBeCloseTo(0, 9);
      // …but they get there at different rates: at the centre of the knot one
      // turn is half way round, two turns are all the way round.
      expect(shortestAngleDelta(seat, at(1, 0))).toBeCloseTo(Math.PI, 9);
      expect(shortestAngleDelta(seat, at(2, 0))).toBeCloseTo(0, 9);
    }
  });

  it("puts every strand at EXACTLY the radius, at every height", () => {
    // The whole point of the model, and the thing the flat row broke: the cross
    // section is one circle. Nothing gathers inward, nothing reaches further
    // out, and no blend dips under the radius.
    for (const index of [0, 1, 2, 3, 4]) {
      for (let t = -2; t <= 2; t += 0.01) {
        const p = strandPointAt(
          centerY + t * lambda,
          index,
          count,
          centerY,
          lambda,
          radius,
          turns,
        );
        expect(radiusOf(p)).toBeCloseTo(radius, 12);
      }
    }
  });

  it("gives two strands DIFFERENT depths at rest — it is not a flat row", () => {
    // The regression guard. The rejected model put every strand at the same
    // depth away from the card; on the cylinder the same radius at different
    // seats is a different `z`, and that is the entire point of the change.
    const a = strandPointAt(-10, 0, count, centerY, lambda, radius, turns);
    const b = strandPointAt(-10, 1, count, centerY, lambda, radius, turns);
    expect(a.z).not.toBeCloseTo(b.z, 6);
    expect(a.x).not.toBeCloseTo(b.x, 6);

    // …and the seats cover both the near and the far side of the core.
    const zs = Array.from({ length: count }, (_, i) =>
      strandPointAt(-10, i, count, centerY, lambda, radius, turns).z,
    );
    expect(Math.max(...zs)).toBeGreaterThan(0);
    expect(Math.min(...zs)).toBeLessThan(0);
  });

  it("seats the strands evenly, one 2π/count apart, at every height", () => {
    for (const y of [-10, -lambda, 0, 0.7, lambda, 10]) {
      for (let index = 0; index + 1 < count; index++) {
        expect(
          gapOf(angleAt(y, index), angleAt(y, index + 1)),
        ).toBeCloseTo(TAU / count, 9);
      }
    }
  });

  it("carries ONE shared rotation: a height's spin moves every strand the same", () => {
    // No strand turns on its own account. At a fixed height the angle gap
    // between neighbouring strands is identical for every pair, and changing
    // the spin (a different height, the same one for the whole bundle) advances
    // every strand by exactly the same angle.
    for (const [from, to] of [
      [-lambda, 0],
      [0, 0.6],
      [-0.6, 0.9],
    ] as const) {
      // What the shared rotation itself did between the two heights — the same
      // turn has to show up identically on every strand.
      const turn = shortestAngleDelta(
        spinAt(from, centerY, lambda, turns),
        spinAt(to, centerY, lambda, turns),
      );
      for (let index = 0; index < count; index++) {
        expect(
          shortestAngleDelta(angleAt(from, index), angleAt(to, index)),
        ).toBeCloseTo(turn, 9);
      }
      // …and the cross-section is rigid: every neighbour gap is the same at
      // both heights, so no strand has run ahead of another.
      for (let index = 0; index + 1 < count; index++) {
        const gapHere = gapOf(angleAt(to, index), angleAt(to, index + 1));
        const gapThere = gapOf(angleAt(from, index), angleAt(from, index + 1));
        expect(gapHere).toBeCloseTo(gapThere, 9);
      }
    }
  });

  it("keeps the seats distinct — the cross-section has to be legible", () => {
    const angles = Array.from({ length: count }, (_, i) =>
      angleAt(-10, i).toFixed(6),
    );
    expect(new Set(angles).size).toBe(count);
  });

  it("slides around the cylinder for a fractional index", () => {
    // The line-up joint eases a strand between seats; the position must be
    // continuous across a seat change instead of popping.
    const mid = angleAt(-10, 1.5);
    const a = angleAt(-10, 1);
    const b = angleAt(-10, 2);
    expect(shortestAngleDelta(a, mid)).toBeCloseTo(TAU / count / 2, 9);
    expect(shortestAngleDelta(mid, b)).toBeCloseTo(TAU / count / 2, 9);
    expect(radiusOf(strandPointAt(-10, 1.5, count, centerY, lambda, radius, turns)))
      .toBeCloseTo(radius, 12);
  });

  it("straightens a strand completely at winding 0 (focus / line-up joint)", () => {
    // 0 does NOT leave the cylinder (there is no flat row to go back to): it
    // drops the shared spin, so the strand is a straight vertical line at its
    // own seat — including inside the knot, where the rest of the bundle winds.
    for (const index of [0, 1, 2, 3, 4]) {
      const seat = seatPoint(0, index);
      for (const y of [-1, 0, 0.5, centerY, 1.4]) {
        const p = strandPointAt(
          y,
          index,
          count,
          centerY,
          lambda,
          radius,
          turns,
          0,
        );
        expect(p.x).toBeCloseTo(seat.x, 12);
        expect(p.z).toBeCloseTo(seat.z, 12);
        expect(radiusOf(p)).toBeCloseTo(radius, 12);
      }
    }
  });

  it("clamps the winding, and floors a non-finite one at fully wound", () => {
    const full = strandPointAt(centerY, 1, count, centerY, lambda, radius, turns, 1);
    const over = strandPointAt(centerY, 1, count, centerY, lambda, radius, turns, 4);
    expect(over.x).toBe(full.x);
    expect(over.z).toBe(full.z);
    expect(over.y).toBe(centerY);

    // A NaN amplitude must never reach the vertex buffer.
    for (const bad of [Number.NaN, Infinity, -Infinity]) {
      const p = strandPointAt(centerY, 1, count, centerY, lambda, radius, turns, bad);
      expect(Number.isFinite(p.x)).toBe(true);
      expect(Number.isFinite(p.z)).toBe(true);
      expect(radiusOf(p)).toBeCloseTo(radius, 12);
    }
  });

  it("degenerates safely with no strands / one strand", () => {
    for (const n of [0, 1]) {
      for (const y of [-1, 0, 1]) {
        const p = strandPointAt(y, 0, n, centerY, lambda, radius, turns);
        expect(Number.isFinite(p.x)).toBe(true);
        expect(Number.isFinite(p.z)).toBe(true);
        expect(p.y).toBe(y);
        expect(radiusOf(p)).toBeCloseTo(radius, 12);
      }
    }
  });

  it("straightens out of a degenerate knot instead of going NaN", () => {
    // lambda <= 0 is no knot at all: the spin is 0 everywhere, so the strand is
    // simply a vertical line at its seat — including exactly at the centre.
    for (const degenerate of [0, -2]) {
      for (const y of [centerY - 1, centerY, centerY + 1]) {
        for (let index = 0; index < count; index++) {
          const p = strandPointAt(
            y,
            index,
            count,
            centerY,
            degenerate,
            radius,
            turns,
          );
          const seat = seatPoint(y, index);
          expect(Number.isFinite(p.x)).toBe(true);
          expect(Number.isFinite(p.z)).toBe(true);
          expect(p.x).toBeCloseTo(seat.x, 12);
          expect(p.z).toBeCloseTo(seat.z, 12);
        }
      }
    }
  });
});

describe("laneAngleFor", () => {
  it("spreads lanes evenly around the cylinder", () => {
    const angles = Array.from({ length: 4 }, (_, i) => laneAngleFor(i, 4));
    expect(angles[0]).toBeCloseTo(0, 9);
    expect(angles[1]).toBeCloseTo(Math.PI / 2, 9);
    expect(angles[2]).toBeCloseTo(Math.PI, 9);
    expect(angles[3]).toBeCloseTo((3 * Math.PI) / 2, 9);
  });

  it("is stable for a given count — lanes must not shuffle", () => {
    for (let i = 0; i < 5; i++) {
      expect(laneAngleFor(i, 5)).toBeCloseTo(laneAngleFor(i, 5), 12);
    }
  });

  it("degenerates safely at zero count", () => {
    expect(laneAngleFor(0, 0)).toBe(0);
    expect(laneAngleFor(3, 0)).toBe(0);
  });
});

describe("laneDepthFor", () => {
  it("stays inside 0..1 for every lane", () => {
    for (let count = 1; count <= 12; count++) {
      for (let i = 0; i < count; i++) {
        const d = laneDepthFor(i, count);
        expect(d).toBeGreaterThanOrEqual(0);
        expect(d).toBeLessThanOrEqual(1);
      }
    }
  });

  it("alternates near and far so the bundle reads as a volume", () => {
    // A monotone ramp would read as a flat fan; alternation is the point.
    const depths = Array.from({ length: 6 }, (_, i) => laneDepthFor(i, 6));
    for (let i = 0; i + 1 < depths.length; i++) {
      expect(Math.abs(depths[i] - depths[i + 1])).toBeGreaterThan(0.1);
    }
  });

  it("puts a lone lane in the middle", () => {
    expect(laneDepthFor(0, 1)).toBe(0.5);
  });

  it("is stable for a given count", () => {
    expect(laneDepthFor(3, 7)).toBe(laneDepthFor(3, 7));
  });
});

describe("activityYsByStrand", () => {
  const anchors: FieldAnchor[] = [
    { y: 0.1, strands: ["a", "b"] },
    { y: 0.3, strands: ["b"] },
    { y: 0.5, strands: ["c", "b"] },
    { y: 0.7, strands: [] },
  ];

  it("groups every anchor height under each strand it carries", () => {
    const byStrand = activityYsByStrand(anchors);
    expect(byStrand.get("a")).toEqual([0.1]);
    expect(byStrand.get("b")).toEqual([0.1, 0.3, 0.5]);
    expect(byStrand.get("c")).toEqual([0.5]);
  });

  it("omits strands that never appear", () => {
    expect(activityYsByStrand(anchors).has("zzz")).toBe(false);
  });

  it("returns empty for an empty field", () => {
    expect(activityYsByStrand([]).size).toBe(0);
  });
});

describe("topStrands", () => {
  const anchors: FieldAnchor[] = [
    { y: 0.1, strands: ["a", "b"] },
    { y: 0.3, strands: ["b"] },
    { y: 0.5, strands: ["c", "b"] },
  ];

  it("ranks by how present a strand is in view", () => {
    expect(topStrands(anchors, 3)).toEqual(["b", "a", "c"]);
  });

  it("truncates to the limit", () => {
    expect(topStrands(anchors, 1)).toEqual(["b"]);
    expect(topStrands(anchors, 2)).toEqual(["b", "a"]);
  });

  it("returns everything for a non-positive limit", () => {
    expect(topStrands(anchors, 0)).toHaveLength(3);
    expect(topStrands(anchors, -1)).toHaveLength(3);
  });

  it("breaks ties on the name so the line-up never reshuffles", () => {
    // Counts drift by one constantly while scrolling; an unstable tiebreak
    // would make the drawn set flicker between frames.
    const tied: FieldAnchor[] = [
      { y: 0.1, strands: ["zebra", "alpha"] },
      { y: 0.2, strands: ["zebra", "alpha"] },
    ];
    expect(topStrands(tied, 2)).toEqual(["alpha", "zebra"]);
    expect(topStrands([...tied].reverse(), 2)).toEqual(["alpha", "zebra"]);
  });

  it("returns empty for an empty field", () => {
    expect(topStrands([], 5)).toEqual([]);
  });
});
