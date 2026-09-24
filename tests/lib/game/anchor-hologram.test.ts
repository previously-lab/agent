/**
 * Tests for the anchor hologram's pure geometry layer
 * (lib/game/anchor-hologram-geometry.ts).
 *
 * The contract under test: the braid is the band's coaxial model with TWO
 * blended knots — every thread stays on the cylinder at every height (the
 * winding never moves a line in or out); the twist runs over the object's
 * whole height at a nearly constant pitch and always in ONE direction (a
 * coil, not a knot spliced between straight rods); the bundle's size is
 * data-dense in (strands, neighborSlots) with strands keeping priority at
 * the cap; per-segment brightness stays inside the kind's range (the bundle
 * reads as volume, never as glare); and the same inputs bake the identical
 * bytes (A6 — layout is data, only the component's spin is time).
 */
import { describe, expect, it } from "vitest";
import {
  HOLO_BOTTOM,
  HOLO_CENTER_Y,
  HOLO_KNOT_SPREAD,
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
    expect(threads.filter((t) => t.kind === "strand")).toHaveLength(4);
    expect(threads.filter((t) => t.kind === "neighbor")).toHaveLength(0);
    // Fewer strands leave room for neighbors.
    const fewer = holoThreadsFor(many.slice(0, 2), 7);
    expect(fewer.filter((t) => t.kind === "strand")).toHaveLength(2);
    expect(fewer.filter((t) => t.kind === "neighbor")).toHaveLength(2);
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

  it("winds one way only: exactly the configured turns, never unwinding", () => {
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
    // The object carries MOST of the configured twist, and never more than
    // configured — nothing created. It is deliberately not the whole count:
    // the coil runs off both ends of the visible height (a spring cut at
    // both ends) instead of resting on the seats, because threads that are
    // straight for two thirds of their length are what read as unphysical.
    const sweptTotal = swept(1, HOLO_SEGMENTS - 1);
    expect(sweptTotal).toBeGreaterThan((HOLO_TURNS - 0.6) * Math.PI * 2);
    expect(sweptTotal).toBeLessThanOrEqual(HOLO_TURNS * Math.PI * 2 + 1e-6);
    // …and it swept them in ONE direction: a spring winds, it does not wind
    // and unwind. (The cable's "each end rests on its own seat" closure is
    // the BAND's property, where the twist belongs to one card; the
    // hologram coils across its whole height instead, which is what makes it
    // read as an object rather than a knot spliced into two straight rods.)
    for (let i = 2; i <= HOLO_SEGMENTS - 1; i++) {
      const d = angleAt(i) - angleAt(i - 1);
      const step =
        ((((d + Math.PI) % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2)) -
        Math.PI;
      expect(step).toBeGreaterThan(-1e-6);
    }
  });

  it("coils across its whole height at a nearly constant pitch", () => {
    const bake = holoThreadBake(thread("strand", 1, 4));
    const angleAt = (i: number): number =>
      Math.atan2(bake.points[i * 3 + 2], bake.points[i * 3]);
    // Unwrapped per-step rotation: the twist each sample adds.
    const stepAt = (i: number): number => {
      const d = angleAt(i) - angleAt(i - 1);
      return (
        ((((d + Math.PI) % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2)) -
        Math.PI
      );
    };
    const yToIndex = (y: number): number =>
      Math.round(((y - HOLO_BOTTOM) / (HOLO_TOP - HOLO_BOTTOM)) * HOLO_SEGMENTS);
    // THE PITCH IS CONSTANT WHERE THE COIL IS: across the two knot centres
    // (± HOLO_KNOT_SPREAD of the slice) the per-step twist must not vary by
    // more than a fifth — a real spring is evenly wound, and a varying rate
    // is what made the first cut read as a machine part rather than a coil.
    const lo = yToIndex(HOLO_CENTER_Y - HOLO_KNOT_SPREAD);
    const hi = yToIndex(HOLO_CENTER_Y + HOLO_KNOT_SPREAD);
    let min = Infinity;
    let max = 0;
    for (let i = lo + 1; i <= hi; i++) {
      const step = stepAt(i);
      min = Math.min(min, step);
      max = Math.max(max, step);
    }
    expect(min).toBeGreaterThan(0);
    expect(max / min).toBeLessThan(1.2);
    // AND IT IS NOT CRAMMED INTO A WINDOW: the twist reaches well outside
    // the slice's own half-metre — the threads are coil, not straight rods
    // with a knot in the middle.
    let outside = 0;
    let total = 0;
    const windowLo = yToIndex(HOLO_CENTER_Y - HOLO_KNOT_SPREAD);
    const windowHi = yToIndex(HOLO_CENTER_Y + HOLO_KNOT_SPREAD);
    for (let i = 1; i <= HOLO_SEGMENTS; i++) {
      const step = stepAt(i);
      total += step;
      if (i < windowLo || i > windowHi) outside += step;
    }
    expect(outside / total).toBeGreaterThan(0.25);
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
