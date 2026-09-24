/**
 * Tests for the anchor hologram's pure geometry layer
 * (lib/game/anchor-hologram-geometry.ts).
 *
 * The contract under test: the braid is the band's coaxial model with
 * ONE knot — every thread stays on the cylinder at every height (the
 * winding never moves a line in or out); an integral number of turns
 * closes the helix back onto each thread's own seat (straight above,
 * straight below, braided in between — the two-states-one-formula); the
 * bundle's size is data-dense in (strands, neighborSlots) with strands
 * keeping priority at the cap; per-segment brightness stays inside the
 * kind's range (the bundle reads as volume, never as glare); and the
 * same inputs bake the identical bytes (A6 — layout is data, only the
 * component's spin is time).
 */
import { describe, expect, it } from "vitest";
import {
  HOLO_BOTTOM,
  HOLO_CENTER_Y,
  HOLO_KNOT_LAMBDA,
  HOLO_NEIGHBOR_BRIGHTNESS,
  HOLO_RADIUS,
  HOLO_SEGMENTS,
  HOLO_STRAND_BRIGHTNESS,
  HOLO_STRAND_MAX,
  HOLO_TOP,
  HOLO_TURNS,
  holoCoreBake,
  holoThreadsFor,
  holoThreadBake,
  type HoloThread,
} from "@/lib/game/anchor-hologram-geometry";
import { laneAngleFor } from "@/lib/timeline3d/winding";

describe("holoThreadsFor", () => {
  it("draws no bundle for a bare newest slice", () => {
    expect(holoThreadsFor([], 0)).toEqual([]);
  });

  it("seats strands first, neighbors top up, count rides the total", () => {
    const threads = holoThreadsFor(["工作", " fitness "], 2);
    expect(threads).toHaveLength(4);
    expect(threads.map((t) => t.kind)).toEqual([
      "strand",
      "strand",
      "neighbor",
      "neighbor",
    ]);
    expect(threads.map((t) => t.seat)).toEqual([0, 1, 2, 3]);
    for (const t of threads) expect(t.count).toBe(4);
  });

  it("caps at HOLO_STRAND_MAX with strands keeping priority", () => {
    const many = Array.from({ length: 12 }, (_, i) => `s${i}`);
    const threads = holoThreadsFor(many, 7);
    expect(threads).toHaveLength(HOLO_STRAND_MAX);
    expect(threads.filter((t) => t.kind === "strand")).toHaveLength(8);
    expect(threads.filter((t) => t.kind === "neighbor")).toHaveLength(0);
    // Fewer strands leave room for neighbors.
    const fewer = holoThreadsFor(many.slice(0, 5), 7);
    expect(fewer.filter((t) => t.kind === "strand")).toHaveLength(5);
    expect(fewer.filter((t) => t.kind === "neighbor")).toHaveLength(3);
  });

  it("treats negative and non-integer inputs as the data allows", () => {
    expect(holoThreadsFor([], -3)).toEqual([]);
    const threads = holoThreadsFor(["a", "b"], 2.9);
    expect(threads.filter((t) => t.kind === "neighbor")).toHaveLength(2);
  });

  it("is deterministic for the same inputs", () => {
    const a = holoThreadsFor(["x", "y"], 3);
    const b = holoThreadsFor(["x", "y"], 3);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

describe("holoThreadBake", () => {
  const thread = (kind: HoloThread["kind"], seat: number, count: number): HoloThread => ({
    kind,
    seat,
    count,
  });

  it("keeps every sample on the cylinder radius", () => {
    const bake = holoThreadBake(thread("strand", 2, 5));
    for (let i = 0; i <= HOLO_SEGMENTS; i++) {
      const x = bake.points[i * 3];
      const z = bake.points[i * 3 + 2];
      expect(Math.hypot(x, z)).toBeCloseTo(HOLO_RADIUS, 6);
    }
  });

  it("spans the full cable height, monotone upward", () => {
    const bake = holoThreadBake(thread("neighbor", 0, 1));
    expect(bake.points[1]).toBeCloseTo(HOLO_BOTTOM, 6);
    expect(bake.points[HOLO_SEGMENTS * 3 + 1]).toBeCloseTo(HOLO_TOP, 6);
    for (let i = 1; i <= HOLO_SEGMENTS; i++) {
      expect(bake.points[i * 3 + 1]).toBeGreaterThan(bake.points[(i - 1) * 3 + 1]);
    }
  });

  it("closes the helix: below and above the knot the thread rests on its own seat", () => {
    const seat = 3;
    const count = 7;
    const bake = holoThreadBake(thread("strand", seat, count));
    const angleAt = (i: number): number => {
      const x = bake.points[i * 3];
      const z = bake.points[i * 3 + 2];
      return Math.atan2(z, x);
    };
    // Unwrapped total rotation between two samples — raw atan2 spans
    // alias past ±π, so the walk has to wrap each step itself. JS `%`
    // truncates toward zero, so the wrap must floor-mod explicitly or
    // negative steps come out six radians off.
    const wrapStep = (d: number): number =>
      ((((d + Math.PI) % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2)) -
      Math.PI;
    const swept = (i0: number, i1: number): number => {
      let total = 0;
      let prev = angleAt(i0);
      for (let i = i0 + 1; i <= i1; i++) {
        total += wrapStep(angleAt(i) - prev);
        prev = angleAt(i);
      }
      return total;
    };
    // Below the knot to above it the shared spin swept exactly
    // HOLO_TURNS whole turns — nothing created, nothing lost.
    expect(swept(1, HOLO_SEGMENTS - 1)).toBeCloseTo(HOLO_TURNS * Math.PI * 2, 6);
    // And each end rests on the seat angle itself: a straight vertical
    // line at its own seat, above and below the braid.
    const seatAngle = laneAngleFor(seat, count);
    const residue = (a: number): number => {
      // Wrap to (-π, π] — the +π shift comes BEFORE the mod, and JS `%`
      // truncates so the double mod has to floor it back.
      const d = a - seatAngle;
      const wrapped =
        ((((d + Math.PI) % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2)) -
        Math.PI;
      return Math.abs(wrapped);
    };
    expect(residue(angleAt(1))).toBeLessThan(1e-6);
    expect(residue(angleAt(HOLO_SEGMENTS - 1))).toBeLessThan(1e-6);
  });

  it("does nearly all of its winding inside the knot window", () => {
    const bake = holoThreadBake(thread("strand", 1, 4));
    const angleAt = (i: number): number =>
      Math.atan2(bake.points[i * 3 + 2], bake.points[i * 3]);
    const swept = (i0: number, i1: number): number => {
      let total = 0;
      let prev = angleAt(i0);
      for (let i = i0 + 1; i <= i1; i++) {
        // Floor-mod wrap — JS `%` truncates, which mis-wraps negatives.
        const d = angleAt(i) - prev;
        total +=
          Math.abs(
            ((((d + Math.PI) % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2)) -
              Math.PI,
          );
        prev = angleAt(i);
      }
      return total;
    };
    const yToIndex = (y: number): number =>
      Math.round(((y - HOLO_BOTTOM) / (HOLO_TOP - HOLO_BOTTOM)) * HOLO_SEGMENTS);
    const inside = swept(
      yToIndex(HOLO_CENTER_Y - HOLO_KNOT_LAMBDA),
      yToIndex(HOLO_CENTER_Y + HOLO_KNOT_LAMBDA),
    );
    const total = swept(0, HOLO_SEGMENTS);
    expect(inside / total).toBeGreaterThan(0.9);
  });

  it("keeps brightness inside the kind's range, with neighbors dimmer", () => {
    const strand = holoThreadBake(thread("strand", 0, 3));
    const neighbor = holoThreadBake(thread("neighbor", 0, 3));
    for (let i = 0; i < HOLO_SEGMENTS; i++) {
      expect(strand.brightness[i]).toBeGreaterThanOrEqual(HOLO_STRAND_BRIGHTNESS[0] - 1e-6);
      expect(strand.brightness[i]).toBeLessThanOrEqual(HOLO_STRAND_BRIGHTNESS[1] + 1e-6);
      expect(neighbor.brightness[i]).toBeGreaterThanOrEqual(HOLO_NEIGHBOR_BRIGHTNESS[0] - 1e-6);
      expect(neighbor.brightness[i]).toBeLessThanOrEqual(HOLO_NEIGHBOR_BRIGHTNESS[1] + 1e-6);
      expect(neighbor.brightness[i]).toBeLessThan(strand.brightness[i]);
      expect(Number.isFinite(strand.brightness[i])).toBe(true);
    }
  });

  it("contains no NaN anywhere", () => {
    const bake = holoThreadBake(thread("strand", 5, 8));
    for (let i = 0; i < bake.points.length; i++) {
      expect(Number.isFinite(bake.points[i])).toBe(true);
    }
  });

  it("bakes the identical bytes for the same thread (A6)", () => {
    const a = holoThreadBake(thread("strand", 2, 6));
    const b = holoThreadBake(thread("strand", 2, 6));
    expect(a.points).toEqual(b.points);
    expect(a.brightness).toEqual(b.brightness);
  });
});

describe("holoCoreBake", () => {
  it("is a straight line on the axis, spanning the cable", () => {
    const bake = holoCoreBake();
    expect(bake.kind).toBe("core");
    expect(bake.points).toHaveLength((HOLO_SEGMENTS + 1) * 3);
    for (let i = 0; i <= HOLO_SEGMENTS; i++) {
      expect(bake.points[i * 3]).toBe(0);
      expect(bake.points[i * 3 + 2]).toBe(0);
    }
    expect(bake.points[1]).toBeCloseTo(HOLO_BOTTOM, 6);
    expect(bake.points[HOLO_SEGMENTS * 3 + 1]).toBeCloseTo(HOLO_TOP, 6);
  });
});
