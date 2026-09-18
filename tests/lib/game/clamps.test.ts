/**
 * Tests for the movement containment clamps (src/lib/game/clamps.ts) —
 * the corridor band and the space footprint. These lock down the
 * containment invariant: while a space is active its corridor wall is
 * solid in both directions except the door gap, the gap itself stays
 * passable, the corridor-side clamps keep their v1 behavior, and the
 * walkable region is the PLAN's, not the bounding box's — an l-shape's
 * abandoned quadrant is unreachable outside a strand door's slab passage.
 */
import { describe, it, expect } from "vitest";
import type { DoorRef } from "@/lib/game/hotel";
import {
  CLEAR_HALF,
  CORRIDOR_Z_LIMIT,
  END_WALL_PASS_DEPTH,
  GAP_HALF,
  LOBBY_CLEAR,
  ROOM_DOOR_PASS_DEPTH,
  SPACE_EDGE_MARGIN,
  WALL_Z,
  clampToCorridor,
  clampToSpace,
} from "@/lib/game/clamps";
import {
  crossedRoomDoor,
  hostableWallsFor,
  placeRoomDoors,
  type RoomDoorPlacement,
} from "@/lib/game/room-doors";
import { wallRoleFor, wallSegmentsFor, type RoomPlan } from "@/lib/game/room-plan";
import {
  ROOM_DOOR_CROSS_DEPTH,
  ROOM_DOOR_ROW_DEPTH,
  ROOM_WALL_THICKNESS,
} from "@/lib/game/tuning/room";

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

/* ------------------------------------------------------------------ */
/* Shared fixtures: plans, frames, door geometry                       */
/* ------------------------------------------------------------------ */

function rectPlan(width: number, extent: number): RoomPlan {
  return { id: "rect", width, extent, lSide: 1, stepZ: 0, columns: [] };
}
function lPlan(width: number, extent: number, lSide: 1 | -1 = 1): RoomPlan {
  return { id: "l-shape", width, extent, lSide, stepZ: extent * 0.5, columns: [] };
}
function colonnadePlan(width: number, extent: number): RoomPlan {
  return { id: "colonnade", width, extent, lSide: 1, stepZ: 0, columns: [] };
}

const RECT = rectPlan(WIDTH, EXTENT);

/** The clamp's inner-wall margin for an l-shape: the box's own side-wall
 *  margin (human 1 m, capped at half the room's half-span). Mirrors
 *  clamps.ts (`width / 2 - xHalf`). */
function innerMarginFor(width: number): number {
  return Math.min(SPACE_EDGE_MARGIN, (width / 2) * 0.5);
}

/** Is the plan-local position in the l-shape's forbidden zone (past the
 *  step, on the dropped side of the inner wall)? Mirrors the clamp's
 *  plan step — the definition of "outside the walkable region" these
 *  tests assert against. */
function inForbiddenZone(plan: RoomPlan, lx: number, lz: number): boolean {
  if (plan.id !== "l-shape" || lz <= plan.stepZ) return false;
  const m = innerMarginFor(plan.width);
  return plan.lSide > 0 ? lx < m : lx > -m;
}

/** Is the plan-local position inside a strand door's slab passage (the
 *  carve that keeps doorways legal)? Mirrors the clamp's carve gate. */
function inDoorWindow(
  lx: number,
  lz: number,
  doors: readonly RoomDoorPlacement[],
): boolean {
  return doors.some((d) => {
    const along = -(lx - d.x) * d.nz + (lz - d.z) * d.nx;
    if (Math.abs(along) >= GAP_HALF) return false;
    const perp = (lx - d.x) * d.nx + (lz - d.z) * d.nz;
    return Math.abs(perp) <= ROOM_DOOR_PASS_DEPTH + 1e-9;
  });
}

/** A clamped position is LEGAL when it is walkable or between a door's
 *  jambs — the single invariant every containment test asserts. */
function isLegal(
  plan: RoomPlan,
  lx: number,
  lz: number,
  doors: readonly RoomDoorPlacement[],
): boolean {
  return !inForbiddenZone(plan, lx, lz) || inDoorWindow(lx, lz, doors);
}

const dirOf = (door: DoorRef) => (door.z > 0 ? 1 : -1);
const toWorld = (door: DoorRef, lx: number, lz: number) => ({
  x: door.x + dirOf(door) * lx,
  z: door.z + dirOf(door) * lz,
});
const toLocal = (door: DoorRef, p: { x: number; z: number }) => ({
  lx: (p.x - door.x) * dirOf(door),
  lz: (p.z - door.z) * dirOf(door),
});
/** Local position at along-offset `a` and inward-perp `t` from a door. */
const atDoor = (d: RoomDoorPlacement, a: number, t: number) => ({
  lx: d.x - d.nz * a + d.nx * t,
  lz: d.z + d.nx * a + d.nz * t,
});
const perpOf = (d: RoomDoorPlacement, l: { lx: number; lz: number }) =>
  (l.lx - d.x) * d.nx + (l.lz - d.z) * d.nz;
const alongOf = (d: RoomDoorPlacement, l: { lx: number; lz: number }) =>
  -(l.lx - d.x) * d.nz + (l.lz - d.z) * d.nx;

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

  it("caps x at the window's far end — a solid wall at the oldest window (HD2)", () => {
    const p = { x: -100, z: 0 };
    clampToCorridor(p, [], { endX: -24, pageDoor: false });
    expect(p.x).toBe(-24 + LOBBY_CLEAR);
    // Even inside the z range a page door WOULD occupy, a solid end holds.
    const q = { x: -100, z: 0.2 };
    clampToCorridor(q, [], { endX: -24, pageDoor: false });
    expect(q.x).toBe(-24 + LOBBY_CLEAR);
  });

  it("relaxes the far end inside the page door's gap only (HD3)", () => {
    // Inside |z| < GAP_HALF the player may push END_WALL_PASS_DEPTH past
    // the end wall plane — the page-door crossing trigger lives there.
    const p = { x: -100, z: 0 };
    clampToCorridor(p, [], { endX: -24, pageDoor: true });
    expect(p.x).toBe(-24 - END_WALL_PASS_DEPTH);
    // Just outside the gap the end wall is solid like any other.
    const q = { x: -100, z: GAP_HALF + 0.01 };
    clampToCorridor(q, [], { endX: -24, pageDoor: true });
    expect(q.x).toBe(-24 + LOBBY_CLEAR);
  });
});

describe("clampToSpace", () => {
  it("boxes x to door.x ± (width/2 − 1)", () => {
    const p = { x: 100, z: 10 };
    clampToSpace(p, NORTH_DOOR, WIDTH, EXTENT, [], RECT);
    expect(p.x).toBe(NORTH_DOOR.x + (WIDTH / 2 - 1));
    const q = { x: -100, z: 10 };
    clampToSpace(q, NORTH_DOOR, WIDTH, EXTENT, [], RECT);
    expect(q.x).toBe(NORTH_DOOR.x - (WIDTH / 2 - 1));
  });

  it("boxes the outward z to wall + extent − 1 (mirrored for south)", () => {
    const p = { x: NORTH_DOOR.x, z: 100 };
    clampToSpace(p, NORTH_DOOR, WIDTH, EXTENT, [], RECT);
    expect(p.z).toBe(WALL_Z + EXTENT - 1);
    const q = { x: SOUTH_DOOR.x, z: -100 };
    clampToSpace(q, SOUTH_DOOR, WIDTH, EXTENT, [], RECT);
    expect(q.z).toBe(-(WALL_Z + EXTENT - 1));
  });

  it("treats the wall as solid from inside, outside the gap", () => {
    const p = { x: NORTH_DOOR.x + 2, z: WALL_Z - 1 }; // corridor side, |dx| > GAP_HALF
    clampToSpace(p, NORTH_DOOR, WIDTH, EXTENT, [], RECT);
    expect(p.z).toBe(WALL_Z + 0.4);
  });

  it("holds the player 0.4 m off the wall from the space side", () => {
    const p = { x: NORTH_DOOR.x + 2, z: WALL_Z };
    clampToSpace(p, NORTH_DOOR, WIDTH, EXTENT, [], RECT);
    expect(p.z).toBe(WALL_Z + 0.4);
    const q = { x: SOUTH_DOOR.x - 2, z: -WALL_Z };
    clampToSpace(q, SOUTH_DOOR, WIDTH, EXTENT, [], RECT);
    expect(q.z).toBe(-(WALL_Z + 0.4));
  });

  it("keeps the doorway gap passable in both directions", () => {
    // In the gap the inner bound relaxes to the corridor band (±4.5), so a
    // player returning through the wall is not pushed back out.
    const returning = { x: NORTH_DOOR.x + 0.4, z: WALL_Z - 0.5 };
    clampToSpace(returning, NORTH_DOOR, WIDTH, EXTENT, [], RECT);
    expect(returning.z).toBe(WALL_Z - 0.5);
    const entering = { x: SOUTH_DOOR.x - 0.4, z: -(WALL_Z - 0.5) };
    clampToSpace(entering, SOUTH_DOOR, WIDTH, EXTENT, [], RECT);
    expect(entering.z).toBe(-(WALL_Z - 0.5));
  });

  it("seals the gap at its edge: just outside GAP_HALF the wall applies", () => {
    const p = { x: NORTH_DOOR.x + GAP_HALF + 0.01, z: WALL_Z - 0.5 };
    clampToSpace(p, NORTH_DOOR, WIDTH, EXTENT, [], RECT);
    expect(p.z).toBe(WALL_Z + 0.4);
  });

  it("uses width (not extent) for the x bound on rectangular plans", () => {
    // Narrow plan: a square clamp at ±(extent/2−1) would let the player
    // walk through the long side walls.
    const narrow = { x: NORTH_DOOR.x + EXTENT / 2, z: 10 };
    clampToSpace(narrow, NORTH_DOOR, EXTENT * 0.66, EXTENT, [], rectPlan(EXTENT * 0.66, EXTENT));
    expect(narrow.x).toBeCloseTo(
      NORTH_DOOR.x + ((EXTENT * 0.66) / 2 - 1),
      6,
    );
    // Wide plan: the x bound must reach the far side walls.
    const wide = { x: NORTH_DOOR.x + EXTENT, z: 10 };
    clampToSpace(wide, NORTH_DOOR, EXTENT * 1.5, EXTENT, [], rectPlan(EXTENT * 1.5, EXTENT));
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
    clampToSpace(p, NORTH_DOOR, M, M, [], rectPlan(M, M));
    expect(p.x).toBe(NORTH_DOOR.x + (M / 2 - 1));
    expect(p.z).toBe(WALL_Z + M - 1);
    const q = { x: -1000, z: -1000 };
    clampToSpace(q, NORTH_DOOR, M, M, [], rectPlan(M, M));
    expect(q.x).toBe(NORTH_DOOR.x - (M / 2 - 1));
    expect(q.z).toBe(WALL_Z + 0.4);
  });

  it.each(SCALES)("$name leaves a walkable strip with numeric spans", ({ width, extent, xHalf, far }) => {
    const p = { x: 1e6, z: 1e6 };
    clampToSpace(p, NORTH_DOOR, width, extent, [], rectPlan(width, extent));
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
      clampToSpace(p, NORTH_DOOR, width, extent, [], rectPlan(width, extent));
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
    clampToSpace(p, NORTH_DOOR, w, e, [], rectPlan(w, e));
    expect(p.z).toBeGreaterThan(WALL_Z);
    expect(p.z).toBeLessThanOrEqual(WALL_Z + e);
  });

  it("shrinks the wall clear with depth so miniature depth does not degenerate", () => {
    // Rectangular plan wide enough to have a non-gap area (8 m) but only
    // 1 m deep: the 0.4 m wall clear and 1 m edge margin would leave a
    // negative depth span at human values. Scaled: each margin caps at
    // 0.5·(extent/2) = 0.25, so near = wall + 0.25, far = wall + 0.75.
    const p = { x: NORTH_DOOR.x + 3, z: -1000 };
    clampToSpace(p, NORTH_DOOR, 8, 1, [], rectPlan(8, 1));
    expect(p.z).toBeCloseTo(WALL_Z + 0.25, 9);
    const q = { x: NORTH_DOOR.x + 3, z: 1000 };
    clampToSpace(q, NORTH_DOOR, 8, 1, [], rectPlan(8, 1));
    expect(q.z).toBeCloseTo(WALL_Z + 0.75, 9);
    // 0.5 m of walkable depth = 50% of the 1 m room.
    expect(q.z - p.z).toBeCloseTo(0.5, 9);
  });

  it("keeps the miniature doorway gap passable in both directions", () => {
    // At ×0.05 the whole 1.6 m room sits inside the unscaled gap
    // (GAP_HALF is human-scale, axiom A4) — the return path must not
    // push the player back out.
    const returning = { x: NORTH_DOOR.x + 0.3, z: WALL_Z - 0.5 };
    clampToSpace(returning, NORTH_DOOR, M * 0.05, M * 0.05, [], rectPlan(M * 0.05, M * 0.05));
    expect(returning.z).toBe(WALL_Z - 0.5);
  });
});

describe("strand-door passages", () => {
  // The clamp's strand-door relaxation (v0.11 B.8/B.11): inside a placed
  // door's along-wall window the box bound widens to the wall plane +
  // ROOM_DOOR_PASS_DEPTH so the crossing trigger (perp < ROOM_DOOR_CROSS_DEPTH)
  // is reachable; everywhere else the box holds byte-identically. Fixtures
  // run the SAME pure chain the renderer and the canvas integrator use —
  // wallSegmentsFor → hostableWallsFor → placeRoomDoors — on the plans in
  // use (rect / l-shape / colonnade) at normal, miniature, and colossal
  // scale, and the clamp is given the fixture's own plan: the passages
  // must survive plan-aware containment, whose carve is what keeps an
  // l-shape's step/inner-wall doorways crossable now that those walls
  // bound the walkable region.

  const BASE = 32; // M-tier footprint before scaling
  const DOOR_COUNT = 3;

  const CASES = [
    { name: "rect", make: rectPlan },
    { name: "l-shape", make: lPlan },
    { name: "colonnade", make: colonnadePlan },
  ].flatMap((p) =>
    [0.35, 1, 3].map((factor) => ({ ...p, factor })),
  );

  interface Fixture {
    doors: readonly RoomDoorPlacement[];
    plan: RoomPlan;
    width: number;
    extent: number;
  }

  /** The shared derivation: plan → walls → hostable → placements, with the
   *  renderer's wall-thickness formula, for a north door (dir 1). */
  function fixtureFor(
    name: string,
    make: (w: number, e: number) => RoomPlan,
    factor: number,
    door: DoorRef = NORTH_DOOR,
  ): Fixture {
    const width = BASE * factor;
    const extent = BASE * factor;
    const plan = make(width, extent);
    const thick = ROOM_WALL_THICKNESS * Math.max(factor, 0.35);
    const walls = wallSegmentsFor(plan, thick);
    const dir = door.z > 0 ? 1 : -1;
    const hostable = hostableWallsFor(plan, walls, dir);
    const { doors } = placeRoomDoors(
      `clamp-passage-${name}-${factor}`,
      plan,
      walls,
      hostable,
      DOOR_COUNT,
    );
    expect(doors).toHaveLength(DOOR_COUNT);
    return { doors, plan, width, extent };
  }

  it.each(CASES)(
    "$name ×$factor: the crossing band is reachable at EVERY placed door (and was not without the relaxation)",
    ({ name, make, factor }) => {
      const { doors, plan, width, extent } = fixtureFor(name, make, factor);
      for (const d of doors) {
        for (const perp of [ROOM_DOOR_CROSS_DEPTH - 0.25, -0.3]) {
          const target = atDoor(d, 0, perp);
          const p = toWorld(NORTH_DOOR, target.lx, target.lz);
          clampToSpace(p, NORTH_DOOR, width, extent, doors, plan);
          const after = toLocal(NORTH_DOOR, p);
          // The perp coordinate survives the clamp (only the along axis may
          // move, and only for a door sitting past the box's corner bound),
          // the final position is between the jambs, and the crossing
          // trigger fires there. Plan containment keeps the doorway legal:
          // the surviving position is never in the plan's forbidden zone
          // unless it sits inside the door's own slab passage.
          expect(perpOf(d, after)).toBeCloseTo(perp, 9);
          expect(Math.abs(alongOf(d, after))).toBeLessThan(GAP_HALF);
          expect(crossedRoomDoor(after.lx, after.lz, doors)).not.toBeNull();
          expect(
            isLegal(plan, after.lx, after.lz, doors),
            `doorway at perp ${perp} clamped into the forbidden zone`,
          ).toBe(true);
          // The legacy plain box (a RECT plan reproduces the pre-plan-aware
          // clamp exactly, plan step included as a no-op) would have held
          // the player strictly farther off the wall — the original gap.
          // (Only where the box bound this wall at all: an l-shape's
          // interior step wall is outside the rectangular box entirely, so
          // it was never blocked — the box relaxation is a no-op there by
          // design; its doorway is the PLAN carve's business, asserted
          // above.)
          const plain = toWorld(NORTH_DOOR, target.lx, target.lz);
          clampToSpace(plain, NORTH_DOOR, width, extent, [], rectPlan(width, extent));
          const plainLocal = toLocal(NORTH_DOOR, plain);
          const moved =
            Math.abs(plainLocal.lx - target.lx) > 1e-9 ||
            Math.abs(plainLocal.lz - target.lz) > 1e-9;
          if (moved) {
            expect(perpOf(d, plainLocal)).toBeGreaterThan(perp + 0.2);
          }
        }
      }
    },
  );

  it.each(CASES)(
    "$name ×$factor: the passage is bounded by the wall plane + overtravel",
    ({ name, make, factor }) => {
      const { doors, plan, width, extent } = fixtureFor(name, make, factor);
      let exercised = 0;
      for (const d of doors) {
        // Deep outside the room through the doorway. Two honest outcomes:
        // a BOUNDARY wall's passage stops the player exactly at the plane +
        // ROOM_DOOR_PASS_DEPTH; an INTERIOR wall (an l-shape's step wall)
        // is plan-bounded now, so a deep shot projects back into the
        // walkable region — identically with and without the door — and is
        // skipped below. The passage never loosens anything else.
        const target = atDoor(d, 0, -5);
        const p = toWorld(NORTH_DOOR, target.lx, target.lz);
        const plain = { ...p };
        clampToSpace(p, NORTH_DOOR, width, extent, doors, plan);
        clampToSpace(plain, NORTH_DOOR, width, extent, [], plan);
        if (p.x === plain.x && p.z === plain.z) continue;
        exercised += 1;
        const after = toLocal(NORTH_DOOR, p);
        const perp = perpOf(d, after);
        // Two honest bounds: the door's OWN plane + overtravel (a wall-row
        // door, or a screen-row door on an interior wall whose carve
        // measures perp from the door itself), or — a screen-row (row 1)
        // door on a boundary wall whose staggered wall-row neighbour's
        // window overlaps its along — the HOST WALL's plane + overtravel,
        // i.e. ROW_DEPTH deeper. Never anything in between or beyond.
        const ownBound = Math.abs(perp + ROOM_DOOR_PASS_DEPTH) < 1e-9;
        const hostBound =
          d.row === 1 &&
          Math.abs(perp + ROOM_DOOR_ROW_DEPTH + ROOM_DOOR_PASS_DEPTH) < 1e-9;
        expect(
          ownBound || hostBound,
          `door row ${d.row} bounded at perp ${perp}`,
        ).toBe(true);
      }
      // Every fixture places at least one door on a boundary wall.
      expect(exercised).toBeGreaterThan(0);
    },
  );

  it.each(CASES)(
    "$name ×$factor: a door's flanks clamp byte-identically to the plain box",
    ({ name, make, factor }) => {
      const { doors, plan, width, extent } = fixtureFor(name, make, factor);
      for (const d of doors) {
        // Probe just outside the window on the flank toward the wall's
        // midpoint (the outward flank of a corner-hugging door can sit
        // inside the window AFTER the box clamp — a genuine pass-through
        // position, not a flank).
        const inward = d.along === 0 ? 1 : -Math.sign(d.along);
        const a = inward * (GAP_HALF + 0.01);
        for (const perp of [-2, 0.1, 3]) {
          const target = atDoor(d, a, perp);
          const withDoors = toWorld(NORTH_DOOR, target.lx, target.lz);
          const plain = { ...withDoors };
          clampToSpace(withDoors, NORTH_DOOR, width, extent, doors, plan);
          clampToSpace(plain, NORTH_DOOR, width, extent, [], plan);
          if (d.row === 1) {
            // A screen-row door's own window never relaxes the box (the
            // screen stands inside the room, off the box face) — but its
            // staggered wall-row neighbours' windows may overlap the
            // probe's along, and THOSE relax legitimately. Only where no
            // wall-row window covers the probe must the clamp be inert.
            const covered = doors.some(
              (o) =>
                o.row === 0 &&
                o.wall === d.wall &&
                Math.abs(o.along - (d.along + a)) < GAP_HALF,
            );
            if (covered) continue;
          }
          expect(withDoors.x).toBe(plain.x);
          expect(withDoors.z).toBe(plain.z);
        }
      }
    },
  );

  it.each(CASES)(
    "$name ×$factor: only door windows ever differ from the plain box (perimeter sweep)",
    ({ name, make, factor }) => {
      const { doors, plan, width, extent } = fixtureFor(name, make, factor);
      const halfW = width / 2;
      // Sweep a grid over and beyond the whole footprint; wherever the
      // relaxed clamp deviates from the plain box, the deviated position
      // must sit inside some door's window and no further out than the
      // plane + overtravel. And everywhere, deviation or not, the clamped
      // position must be LEGAL: walkable, or between a door's jambs —
      // the assertion that would have caught the abandoned-quadrant bug.
      for (let ix = 0; ix <= 8; ix++) {
        for (let iz = 0; iz <= 8; iz++) {
          const lx = -halfW - 2 + ((width + 4) * ix) / 8;
          const lz = -1 + ((extent + 3) * iz) / 8;
          const withDoors = toWorld(NORTH_DOOR, lx, lz);
          const plain = { ...withDoors };
          clampToSpace(withDoors, NORTH_DOOR, width, extent, doors, plan);
          clampToSpace(plain, NORTH_DOOR, width, extent, [], plan);
          const after = toLocal(NORTH_DOOR, withDoors);
          expect(
            isLegal(plan, after.lx, after.lz, doors),
            `clamped into the forbidden zone at local (${lx}, ${lz})`,
          ).toBe(true);
          if (withDoors.x === plain.x && withDoors.z === plain.z) continue;
          const host = doors.find(
            (d) =>
              Math.abs(alongOf(d, after)) < GAP_HALF &&
              perpOf(d, after) >= -ROOM_DOOR_PASS_DEPTH - 1e-9,
          );
          expect(host, `deviation at local (${lx}, ${lz}) outside every door window`).toBeDefined();
        }
      }
    },
  );

  it("mirrors the passages for a south door", () => {
    const { doors, plan, width, extent } = fixtureFor("rect", rectPlan, 1, SOUTH_DOOR);
    for (const d of doors) {
      const target = atDoor(d, 0, 0.3);
      const p = toWorld(SOUTH_DOOR, target.lx, target.lz);
      clampToSpace(p, SOUTH_DOOR, width, extent, doors, plan);
      const after = toLocal(SOUTH_DOOR, p);
      expect(perpOf(d, after)).toBeCloseTo(0.3, 9);
      expect(crossedRoomDoor(after.lx, after.lz, doors)).not.toBeNull();
    }
  });

  it("packs a crowded room onto the axial wall's double bank (relaxed ladder), all reachable", () => {
    // 12 doors on a 32×32 rect exceed the far wall's single-row run, so
    // the ladder relaxes into §10.5 fallback ② — the same-wall second
    // bank (门厅式) — BEFORE any east/west overflow: every door still
    // hangs on the axial (far) wall, half of them on the freestanding
    // screen row. The passage relaxation must work for both rows.
    const plan = rectPlan(32, 32);
    const walls = wallSegmentsFor(plan, ROOM_WALL_THICKNESS);
    const hostable = hostableWallsFor(plan, walls, 1);
    const layout = placeRoomDoors("clamp-passage-crowded", plan, walls, hostable, 12);
    expect(layout.relaxed).toBe(true);
    expect(layout.doors).toHaveLength(12);
    expect(layout.doubleRow).toBe(true);
    expect(layout.axialOverflow).toBe(false);
    for (const d of layout.doors) {
      expect(wallRoleFor(plan, walls[d.wall])).toBe("far");
    }
    for (const d of layout.doors) {
      const target = atDoor(d, 0, 0.3);
      const p = toWorld(NORTH_DOOR, target.lx, target.lz);
      clampToSpace(p, NORTH_DOOR, 32, 32, layout.doors, plan);
      const after = toLocal(NORTH_DOOR, p);
      expect(perpOf(d, after)).toBeCloseTo(0.3, 9);
      expect(crossedRoomDoor(after.lx, after.lz, layout.doors)).not.toBeNull();
    }
  });
});

describe("plan-aware containment", () => {
  // The user-facing bug: an l-shape's abandoned quadrant lies INSIDE the
  // rectangular box the clamp used to enforce, so the player could walk
  // straight through the step and inner walls. The clamp now takes the
  // room's plan and projects forbidden-zone positions back to the nearest
  // walkable point, carving strand-door slab passages out of the zone.
  // These tests pin that behaviour on both lSide values and at miniature
  // / normal / colossal scale, and prove rect and colonnade plans are
  // untouched (the plan step is a no-op where the box IS the footprint).

  const FACTORS = [0.35, 1, 3];
  const L_W = 24;
  const L_E = 16;

  it.each([1, -1] as const)(
    "l-shape lSide %i: walking at the abandoned quadrant never leaves the walkable region",
    (lSide) => {
      for (const factor of FACTORS) {
        const width = L_W * factor;
        const extent = L_E * factor;
        const plan = lPlan(width, extent, lSide);
        const kept = lSide;
        const halfW = width / 2;
        // Through the step wall, through the inner wall, diagonally at
        // their corner, deep at the far edge, and from outside the box.
        const starts = [
          { lx: -kept * halfW * 0.5, lz: plan.stepZ + 3 * factor },
          { lx: -kept * halfW * 0.25, lz: extent - 0.5 },
          { lx: kept * 0.2, lz: plan.stepZ + 4 * factor },
          { lx: -kept * 0.5, lz: plan.stepZ + 0.5 },
          { lx: -kept * halfW * 2, lz: plan.stepZ + 1 },
        ];
        for (const s of starts) {
          const p = toWorld(NORTH_DOOR, s.lx, s.lz);
          clampToSpace(p, NORTH_DOOR, width, extent, [], plan);
          const after = toLocal(NORTH_DOOR, p);
          expect(
            isLegal(plan, after.lx, after.lz, []),
            `×${factor} start (${s.lx}, ${s.lz}) landed at (${after.lx}, ${after.lz}) in the abandoned quadrant`,
          ).toBe(true);
        }
      }
    },
  );

  it.each([1, -1] as const)(
    "l-shape lSide %i: no grid point ever lands in the abandoned quadrant (sweep)",
    (lSide) => {
      for (const factor of FACTORS) {
        const width = L_W * factor;
        const extent = L_E * factor;
        const plan = lPlan(width, extent, lSide);
        for (let ix = 0; ix <= 12; ix++) {
          for (let iz = 0; iz <= 12; iz++) {
            const lx = -width / 2 - 2 + ((width + 4) * ix) / 12;
            const lz = -1 + ((extent + 3) * iz) / 12;
            const p = toWorld(NORTH_DOOR, lx, lz);
            clampToSpace(p, NORTH_DOOR, width, extent, [], plan);
            const after = toLocal(NORTH_DOOR, p);
            expect(
              inForbiddenZone(plan, after.lx, after.lz),
              `×${factor} grid (${lx}, ${lz}) landed at (${after.lx}, ${after.lz})`,
            ).toBe(false);
          }
        }
      }
    },
  );

  it("projects to the NEAREST walkable point — step wall or inner wall, mirrored", () => {
    const plan = lPlan(L_W, L_E, 1); // step at 8, kept +x, inner margin 1
    // Closer to the step wall: pulled straight back onto the step plane.
    const near = toWorld(NORTH_DOOR, -3, plan.stepZ + 0.4);
    clampToSpace(near, NORTH_DOOR, L_W, L_E, [], plan);
    expect(toLocal(NORTH_DOOR, near)).toEqual({ lx: -3, lz: plan.stepZ });
    // Closer to the inner wall: slid sideways onto its margin line.
    const side = toWorld(NORTH_DOOR, 0.2, plan.stepZ + 4);
    clampToSpace(side, NORTH_DOOR, L_W, L_E, [], plan);
    expect(toLocal(NORTH_DOOR, side)).toEqual({ lx: 1, lz: plan.stepZ + 4 });
    // Mirrored for lSide −1.
    const mirror = lPlan(L_W, L_E, -1);
    const q = toWorld(NORTH_DOOR, -0.2, plan.stepZ + 4);
    clampToSpace(q, NORTH_DOOR, L_W, L_E, [], mirror);
    expect(toLocal(NORTH_DOOR, q)).toEqual({ lx: -1, lz: plan.stepZ + 4 });
    // Idempotent: re-clamping a projected position changes nothing.
    const again = { ...side };
    clampToSpace(again, NORTH_DOOR, L_W, L_E, [], plan);
    expect(again).toEqual(side);
  });

  it("keeps the near zone full-width and the kept leg fully walkable (no over-containment)", () => {
    for (const lSide of [1, -1] as const) {
      const plan = lPlan(L_W, L_E, lSide);
      const kept = lSide;
      const untouched = [
        { lx: -kept * 10, lz: plan.stepZ - 0.01 }, // near zone, dropped side, hugging the step
        { lx: -kept * 10.9, lz: 4 }, // near zone at the box's x bound (24/2−1 = 11)
        { lx: kept * 10.9, lz: 15 }, // kept leg far corner at the box bounds
        { lx: kept * 5, lz: plan.stepZ + 0.01 }, // kept leg just past the step line
        { lx: 0, lz: 0.4 }, // entrance approach on the center line
      ];
      for (const s of untouched) {
        const p = toWorld(NORTH_DOOR, s.lx, s.lz);
        clampToSpace(p, NORTH_DOOR, L_W, L_E, [], plan);
        const after = toLocal(NORTH_DOOR, p);
        // Close-compare, not toEqual: the test's own world→local frame
        // round-trip is off by ~1 ulp on some values (5.4 − 5 ≠ 0.4).
        expect(after.lx).toBeCloseTo(s.lx, 12);
        expect(after.lz).toBeCloseTo(s.lz, 12);
      }
    }
  });

  it("mirrors the plan step for a south door", () => {
    const plan = lPlan(L_W, L_E, 1);
    const p = toWorld(SOUTH_DOOR, -3, plan.stepZ + 0.4);
    clampToSpace(p, SOUTH_DOOR, L_W, L_E, [], plan);
    expect(toLocal(SOUTH_DOOR, p)).toEqual({ lx: -3, lz: plan.stepZ });
  });

  it("leaves the entrance exactly as crossable as on a rect plan", () => {
    const plan = lPlan(L_W, L_E, 1);
    // Returning through the doorway, entering, and standing in the gap:
    // the l-shape's plan step never touches the entrance band.
    for (const start of [
      { x: NORTH_DOOR.x + 0.4, z: WALL_Z - 0.5 },
      { x: NORTH_DOOR.x - 0.4, z: WALL_Z + 0.5 },
      { x: NORTH_DOOR.x, z: WALL_Z - 1 },
      { x: NORTH_DOOR.x + 0.2, z: WALL_Z + 0.4 },
    ]) {
      const a = { ...start };
      const b = { ...start };
      clampToSpace(a, NORTH_DOOR, L_W, L_E, [], plan);
      clampToSpace(b, NORTH_DOOR, L_W, L_E, [], RECT);
      expect(a).toEqual(b);
    }
  });

  it("colonnade: the open sides hold the footprint, byte-identical to rect", () => {
    // The colonnade replaces its side walls with open column bays — there
    // is no wall to walk through, but the mist skirt is out of bounds:
    // containment is the box itself, so the colonnade plan must clamp
    // EXACTLY like a rect plan (the plan step is a no-op), including past
    // the column line, at every scale.
    for (const factor of FACTORS) {
      const width = L_W * factor;
      const extent = L_E * factor;
      const colonnade = colonnadePlan(width, extent);
      const rect = rectPlan(width, extent);
      for (let ix = 0; ix <= 8; ix++) {
        for (let iz = 0; iz <= 8; iz++) {
          const lx = -width / 2 - 2 + ((width + 4) * ix) / 8;
          const lz = -1 + ((extent + 3) * iz) / 8;
          const a = toWorld(NORTH_DOOR, lx, lz);
          const b = { ...a };
          clampToSpace(a, NORTH_DOOR, width, extent, [], colonnade);
          clampToSpace(b, NORTH_DOOR, width, extent, [], rect);
          expect(a).toEqual(b);
        }
      }
    }
  });

  it("keeps step- and inner-wall strand doors crossable — the doorway is an opening in the plan's boundary", () => {
    const plan = lPlan(L_W, L_E, 1); // step at 8, kept +x, inner margin 1
    const thick = ROOM_WALL_THICKNESS; // the renderer's ×1 wall thickness
    const stepDoor: RoomDoorPlacement = {
      index: 0,
      wall: 0,
      x: -L_W / 4,
      z: plan.stepZ + thick / 2,
      nx: 0,
      nz: -1,
      along: 0,
      row: 0,
    };
    const innerDoor: RoomDoorPlacement = {
      index: 1,
      wall: 1,
      x: thick / 2,
      z: plan.stepZ + 3,
      nx: 1,
      nz: 0,
      along: 0,
      row: 0,
    };
    const doors = [stepDoor, innerDoor];
    for (const d of doors) {
      // The crossing band survives plan containment at BOTH walls — the
      // inner wall's band (0.55 m from a plane the 1 m margin hides) is
      // reachable ONLY through the carve.
      for (const perp of [ROOM_DOOR_CROSS_DEPTH - 0.25, -0.3]) {
        const target = atDoor(d, 0, perp);
        const p = toWorld(NORTH_DOOR, target.lx, target.lz);
        clampToSpace(p, NORTH_DOOR, L_W, L_E, doors, plan);
        const after = toLocal(NORTH_DOOR, p);
        expect(perpOf(d, after)).toBeCloseTo(perp, 9);
        expect(crossedRoomDoor(after.lx, after.lz, doors)).not.toBeNull();
      }
      // Pushing deep through an unlit doorway ejects into the walkable
      // region — never into the abandoned quadrant beyond.
      const deep = atDoor(d, 0, -2);
      const p = toWorld(NORTH_DOOR, deep.lx, deep.lz);
      clampToSpace(p, NORTH_DOOR, L_W, L_E, doors, plan);
      const afterDeep = toLocal(NORTH_DOOR, p);
      expect(inForbiddenZone(plan, afterDeep.lx, afterDeep.lz)).toBe(false);
      // The doorway's flanks stay solid: just outside the window the
      // result is byte-identical to the no-door projection.
      const flank = atDoor(d, GAP_HALF + 0.01, 0.1);
      const withDoors = toWorld(NORTH_DOOR, flank.lx, flank.lz);
      const plain = { ...withDoors };
      clampToSpace(withDoors, NORTH_DOOR, L_W, L_E, doors, plan);
      clampToSpace(plain, NORTH_DOOR, L_W, L_E, [], plan);
      expect(withDoors).toEqual(plain);
    }
  });

  it("a far-wall strand door near the center line keeps its doorway legal on the dropped side", () => {
    // A miniature l-shape can hang a far-wall door whose slab window
    // straddles the inner wall's margin line: the carve must cover the
    // doorway's dropped-side sliver without opening anything else.
    const factor = 0.35;
    const width = L_W * factor; // 8.4 — inner margin stays 1 (cap 2.1)
    const extent = L_E * factor; // 5.6
    const plan = lPlan(width, extent, 1);
    const thick = ROOM_WALL_THICKNESS * Math.max(factor, 0.35);
    const farDoor: RoomDoorPlacement = {
      index: 0,
      wall: 0,
      x: 0.9, // inside the inner margin (1.0): the window crosses it
      z: extent - thick / 2,
      nx: 0,
      nz: -1,
      along: 0,
      row: 0,
    };
    const doors = [farDoor];
    for (const perp of [ROOM_DOOR_CROSS_DEPTH - 0.25, -0.3]) {
      const target = atDoor(farDoor, -0.5, perp); // the dropped-side sliver
      const p = toWorld(NORTH_DOOR, target.lx, target.lz);
      clampToSpace(p, NORTH_DOOR, width, extent, doors, plan);
      const after = toLocal(NORTH_DOOR, p);
      expect(perpOf(farDoor, after)).toBeCloseTo(perp, 9);
      expect(crossedRoomDoor(after.lx, after.lz, doors)).not.toBeNull();
    }
    // Just outside that window on the dropped side, the quadrant stays
    // forbidden: same depth, offset past the jamb.
    const outside = atDoor(farDoor, -(GAP_HALF + 0.01), -0.3);
    const p = toWorld(NORTH_DOOR, outside.lx, outside.lz);
    clampToSpace(p, NORTH_DOOR, width, extent, doors, plan);
    const after = toLocal(NORTH_DOOR, p);
    expect(inForbiddenZone(plan, after.lx, after.lz)).toBe(false);
    expect(Math.abs(perpOf(farDoor, after))).toBeGreaterThan(ROOM_DOOR_PASS_DEPTH);
  });
});
