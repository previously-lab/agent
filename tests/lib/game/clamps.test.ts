/**
 * Tests for the movement containment clamps (src/lib/game/clamps.ts) —
 * the corridor band and the space footprint. These lock down the
 * containment invariant: while a space is active its corridor wall is
 * solid in both directions except the door gap, the gap itself stays
 * passable, and the corridor-side clamps keep their v1 behavior.
 */
import { describe, it, expect } from "vitest";
import type { DoorRef } from "@/lib/game/hotel";
import {
  CLEAR_HALF,
  CORRIDOR_Z_LIMIT,
  GAP_HALF,
  LOBBY_CLEAR,
  WALL_Z,
  clampToCorridor,
  clampToSpace,
} from "@/lib/game/clamps";

const NORTH_DOOR: DoorRef = {
  index: 0,
  side: "north",
  sliceId: "test-north",
  x: -3,
  z: WALL_Z,
};
const SOUTH_DOOR: DoorRef = {
  index: 1,
  side: "south",
  sliceId: "test-south",
  x: -9,
  z: -WALL_Z,
};
const EXTENT = 16;
const WIDTH = 24; // rectangular plan in the clampToSpace tests

describe("clampToCorridor", () => {
  it("holds the player 0.5 m off both walls", () => {
    const p = { x: 0, z: 5.5 };
    clampToCorridor(p, []);
    expect(p.z).toBe(WALL_Z - 0.5);
    const q = { x: 0, z: -5.5 };
    clampToCorridor(q, []);
    expect(q.z).toBe(-(WALL_Z - 0.5));
  });

  it("blocks the lobby east wall but leaves the past corridor unbounded", () => {
    const p = { x: 20, z: 0 };
    clampToCorridor(p, []);
    expect(p.x).toBe(14 - LOBBY_CLEAR);
    const q = { x: -500, z: 0 };
    clampToCorridor(q, []);
    expect(q.x).toBe(-500);
  });

  it("lets the player reach past the wall plane inside a door gap", () => {
    const p = { x: NORTH_DOOR.x - 0.5, z: WALL_Z + 0.5 };
    clampToCorridor(p, [NORTH_DOOR.x]);
    expect(p.z).toBe(WALL_Z + 0.5);
  });

  it("keeps the wall solid just outside the gap", () => {
    const p = { x: NORTH_DOOR.x + GAP_HALF + 0.01, z: WALL_Z + 0.5 };
    clampToCorridor(p, [NORTH_DOOR.x]);
    expect(p.z).toBe(WALL_Z - 0.5);
  });
});

describe("clampToSpace", () => {
  it("boxes x to door.x ± (width/2 − 1)", () => {
    const p = { x: 100, z: 10 };
    clampToSpace(p, NORTH_DOOR, WIDTH, EXTENT);
    expect(p.x).toBe(NORTH_DOOR.x + (WIDTH / 2 - 1));
    const q = { x: -100, z: 10 };
    clampToSpace(q, NORTH_DOOR, WIDTH, EXTENT);
    expect(q.x).toBe(NORTH_DOOR.x - (WIDTH / 2 - 1));
  });

  it("boxes the outward z to wall + extent − 1 (mirrored for south)", () => {
    const p = { x: NORTH_DOOR.x, z: 100 };
    clampToSpace(p, NORTH_DOOR, WIDTH, EXTENT);
    expect(p.z).toBe(WALL_Z + EXTENT - 1);
    const q = { x: SOUTH_DOOR.x, z: -100 };
    clampToSpace(q, SOUTH_DOOR, WIDTH, EXTENT);
    expect(q.z).toBe(-(WALL_Z + EXTENT - 1));
  });

  it("treats the wall as solid from inside, outside the gap", () => {
    const p = { x: NORTH_DOOR.x + 2, z: WALL_Z - 1 }; // corridor side, |dx| > GAP_HALF
    clampToSpace(p, NORTH_DOOR, WIDTH, EXTENT);
    expect(p.z).toBe(WALL_Z + 0.4);
  });

  it("holds the player 0.4 m off the wall from the space side", () => {
    const p = { x: NORTH_DOOR.x + 2, z: WALL_Z };
    clampToSpace(p, NORTH_DOOR, WIDTH, EXTENT);
    expect(p.z).toBe(WALL_Z + 0.4);
    const q = { x: SOUTH_DOOR.x - 2, z: -WALL_Z };
    clampToSpace(q, SOUTH_DOOR, WIDTH, EXTENT);
    expect(q.z).toBe(-(WALL_Z + 0.4));
  });

  it("keeps the doorway gap passable in both directions", () => {
    // In the gap the inner bound relaxes to the corridor band (±4.5), so a
    // player returning through the wall is not pushed back out.
    const returning = { x: NORTH_DOOR.x + 0.4, z: WALL_Z - 0.5 };
    clampToSpace(returning, NORTH_DOOR, WIDTH, EXTENT);
    expect(returning.z).toBe(WALL_Z - 0.5);
    const entering = { x: SOUTH_DOOR.x - 0.4, z: -(WALL_Z - 0.5) };
    clampToSpace(entering, SOUTH_DOOR, WIDTH, EXTENT);
    expect(entering.z).toBe(-(WALL_Z - 0.5));
  });

  it("seals the gap at its edge: just outside GAP_HALF the wall applies", () => {
    const p = { x: NORTH_DOOR.x + GAP_HALF + 0.01, z: WALL_Z - 0.5 };
    clampToSpace(p, NORTH_DOOR, WIDTH, EXTENT);
    expect(p.z).toBe(WALL_Z + 0.4);
  });

  it("uses width (not extent) for the x bound on rectangular plans", () => {
    // Narrow plan: a square clamp at ±(extent/2−1) would let the player
    // walk through the long side walls.
    const narrow = { x: NORTH_DOOR.x + EXTENT / 2, z: 10 };
    clampToSpace(narrow, NORTH_DOOR, EXTENT * 0.66, EXTENT);
    expect(narrow.x).toBeCloseTo(
      NORTH_DOOR.x + ((EXTENT * 0.66) / 2 - 1),
      6,
    );
    // Wide plan: the x bound must reach the far side walls.
    const wide = { x: NORTH_DOOR.x + EXTENT, z: 10 };
    clampToSpace(wide, NORTH_DOOR, EXTENT * 1.5, EXTENT);
    expect(wide.x).toBeCloseTo(NORTH_DOOR.x + ((EXTENT * 1.5) / 2 - 1), 6);
  });
});

describe("containment contract", () => {
  it("release zone is wider than the physical gap", () => {
    // The door manager clears space mode within CLEAR_HALF of the door's
    // x; if that ever shrank to the gap width, a player hugging the frame
    // would oscillate between corridor and space clamps.
    expect(CLEAR_HALF).toBeGreaterThan(GAP_HALF);
  });
});

describe("scale-aware margins", () => {
  // M-tier room (32 m) at each scale notation: normal ×1, colossal ×20,
  // miniature ×0.05 (room-plan.ts scaledRecipeFor feeds the SCALED dims).
  const M = 32;
  const SCALES = [
    { name: "normal ×1", width: M, extent: M, xHalf: 15, far: WALL_Z + 31 },
    { name: "colossal ×20", width: M * 20, extent: M * 20, xHalf: 319, far: WALL_Z + 639 },
    { name: "miniature ×0.05", width: M * 0.05, extent: M * 0.05, xHalf: 0.4, far: WALL_Z + 1.2 },
  ];

  it("normal scale is byte-identical to the pre-scale-aware formula", () => {
    // The historical constants applied verbatim: x half-span = 32/2 − 1,
    // far z = wall + 32 − 1, near z = wall + 0.4.
    const p = { x: 1000, z: 1000 };
    clampToSpace(p, NORTH_DOOR, M, M);
    expect(p.x).toBe(NORTH_DOOR.x + (M / 2 - 1));
    expect(p.z).toBe(WALL_Z + M - 1);
    const q = { x: -1000, z: -1000 };
    clampToSpace(q, NORTH_DOOR, M, M);
    expect(q.x).toBe(NORTH_DOOR.x - (M / 2 - 1));
    expect(q.z).toBe(WALL_Z + 0.4);
  });

  it.each(SCALES)("$name leaves a walkable strip with numeric spans", ({ width, extent, xHalf, far }) => {
    const p = { x: 1e6, z: 1e6 };
    clampToSpace(p, NORTH_DOOR, width, extent);
    expect(p.x).toBeCloseTo(NORTH_DOOR.x + xHalf, 9);
    expect(p.z).toBeCloseTo(far, 9);
    // Never inverted, never negative: the x half-span and the far reach
    // stay strictly positive.
    expect(xHalf).toBeGreaterThan(0);
    expect(far).toBeGreaterThan(WALL_Z);
  });

  it.each(SCALES)("$name keeps at least ~45% of every span walkable", ({ width, extent, xHalf, far }) => {
    // Walkable x is door.x ± xHalf → full span 2·xHalf; walkable depth is
    // near..far, and near ≥ WALL_Z, so far − WALL_Z − near's margin is a
    // lower bound. With the 0.5 half-span cap both land at ≥ 50%.
    expect(2 * xHalf).toBeGreaterThanOrEqual(0.45 * width);
    expect(far - (WALL_Z + 0.4)).toBeGreaterThanOrEqual(0.45 * extent);
  });

  it.each(SCALES)("$name never lets the bounds exceed the geometry", ({ width, extent }) => {
    // Throw the player far outside the room on every axis; the clamped
    // position must stay inside the plan rectangle (x within ±width/2 of
    // the door, z within wall..wall + extent for a north door).
    for (const start of [
      { x: 1e6, z: 1e6 },
      { x: -1e6, z: 1e6 },
      { x: NORTH_DOOR.x + width, z: 1e6 },
    ]) {
      const p = { ...start };
      clampToSpace(p, NORTH_DOOR, width, extent);
      expect(Math.abs(p.x - NORTH_DOOR.x)).toBeLessThanOrEqual(width / 2);
      expect(p.z).toBeLessThanOrEqual(WALL_Z + extent);
      expect(p.z).toBeGreaterThanOrEqual(CORRIDOR_Z_LIMIT);
    }
  });

  it.each(SCALES)("$name keeps the corridor wall solid outside the gap", ({ width, extent }) => {
    // Player on the corridor side, outside the door gap: pushed back into
    // the space, never through the wall. (At miniature widths the whole
    // room is inside the gap, so probe with a rectangular plan that keeps
    // a non-gap area: 8 m wide, 1 m deep.)
    const w = Math.max(width, 8);
    const e = Math.min(extent, 1);
    const p = { x: NORTH_DOOR.x + w / 2 - 0.01, z: WALL_Z - 1 };
    clampToSpace(p, NORTH_DOOR, w, e);
    expect(p.z).toBeGreaterThan(WALL_Z);
    expect(p.z).toBeLessThanOrEqual(WALL_Z + e);
  });

  it("shrinks the wall clear with depth so miniature depth does not degenerate", () => {
    // Rectangular plan wide enough to have a non-gap area (8 m) but only
    // 1 m deep: the 0.4 m wall clear and 1 m edge margin would leave a
    // negative depth span at human values. Scaled: each margin caps at
    // 0.5·(extent/2) = 0.25, so near = wall + 0.25, far = wall + 0.75.
    const p = { x: NORTH_DOOR.x + 3, z: -1000 };
    clampToSpace(p, NORTH_DOOR, 8, 1);
    expect(p.z).toBeCloseTo(WALL_Z + 0.25, 9);
    const q = { x: NORTH_DOOR.x + 3, z: 1000 };
    clampToSpace(q, NORTH_DOOR, 8, 1);
    expect(q.z).toBeCloseTo(WALL_Z + 0.75, 9);
    // 0.5 m of walkable depth = 50% of the 1 m room.
    expect(q.z - p.z).toBeCloseTo(0.5, 9);
  });

  it("keeps the miniature doorway gap passable in both directions", () => {
    // At ×0.05 the whole 1.6 m room sits inside the unscaled gap
    // (GAP_HALF is human-scale, axiom A4) — the return path must not
    // push the player back out.
    const returning = { x: NORTH_DOOR.x + 0.3, z: WALL_Z - 0.5 };
    clampToSpace(returning, NORTH_DOOR, M * 0.05, M * 0.05);
    expect(returning.z).toBe(WALL_Z - 0.5);
  });
});
