/**
 * Tests for the shared room-orientation rule (tuning/room.ts) — the ONE
 * derivation of how a room's local frame maps to world around its
 * corridor door. These pin the three constraints that make the rule
 * unique: the doorway stays glued to (door.x, door.z), the entrance wall
 * stays flush with the corridor wall, and the room extends OUTWARD from
 * it. They also pin the cross-module agreement that the movement clamp
 * (clamps.ts, which keeps its own inline derivation at :177) reads the
 * same frame as the renderer (space.tsx, via roomOrientationFor) on both
 * door sides — a divergence there is exactly the "door on the wrong wall"
 * class of bug, and it cannot be seen from inside either module alone.
 */
import { describe, it, expect } from "vitest";
import type { DoorRef } from "@/lib/game/hotel";
import { GAP_HALF, WALL_Z, clampToSpace } from "@/lib/game/clamps";
import {
  crossedRoomDoor,
  hostableWallsFor,
  placeRoomDoors,
  type RoomDoorPlacement,
} from "@/lib/game/room-doors";
import { wallSegmentsFor, type RoomPlan } from "@/lib/game/room-plan";
import {
  ROOM_WALL_THICKNESS,
  roomLocalFor,
  roomOrientationFor,
} from "@/lib/game/tuning/room";

const NORTH_DOOR: DoorRef = {
  index: 0,
  side: "north",
  sliceId: "test-orient-north",
  x: -3,
  z: WALL_Z,
};
const SOUTH_DOOR: DoorRef = {
  index: 1,
  side: "south",
  sliceId: "test-orient-south",
  x: -9,
  z: -WALL_Z,
};
const WIDTH = 24;
const EXTENT = 16;
const RECT: RoomPlan = {
  id: "rect",
  width: WIDTH,
  extent: EXTENT,
  lSide: 1,
  stepZ: 0,
  columns: [],
};

/** Local → world, the exact inverse of roomLocalFor. */
function toWorld(
  door: DoorRef,
  lx: number,
  lz: number,
): { x: number; z: number } {
  const { dir } = roomOrientationFor(door);
  return { x: door.x + lx * dir, z: door.z + lz * dir };
}

/** Strand doors for a door side, laid out through the shared chain —
 *  the same calls roomGeometryForSpace makes in game-canvas.tsx. */
function strandDoorsFor(door: DoorRef): readonly RoomDoorPlacement[] {
  const walls = wallSegmentsFor(RECT, ROOM_WALL_THICKNESS);
  const hostable = hostableWallsFor(
    RECT,
    walls,
    roomOrientationFor(door).dir,
  );
  return placeRoomDoors(door.sliceId, RECT, walls, hostable, 2).doors;
}

describe("roomOrientationFor", () => {
  it("is the unique attachment-preserving rule per door side", () => {
    expect(roomOrientationFor(NORTH_DOOR)).toEqual({ dir: 1, rotationY: 0 });
    expect(roomOrientationFor(SOUTH_DOOR)).toEqual({
      dir: -1,
      rotationY: Math.PI,
    });
  });

  it("is deterministic in the door alone (A6)", () => {
    expect(roomOrientationFor({ z: 5 })).toBe(roomOrientationFor({ z: 42 }));
    expect(roomOrientationFor({ z: -5 })).toBe(roomOrientationFor({ z: -42 }));
  });
});

describe("roomLocalFor", () => {
  it.each([
    ["north", NORTH_DOOR],
    ["south", SOUTH_DOOR],
  ])("glues the doorway to (door.x, door.z) — %s", (_side, door) => {
    const { lx, lz } = roomLocalFor(door, door.x, door.z);
    expect(lx).toBeCloseTo(0, 12);
    expect(lz).toBeCloseTo(0, 12);
  });

  it.each([
    ["north", NORTH_DOOR],
    ["south", SOUTH_DOOR],
  ])("round-trips world ↔ local at sample points — %s", (_side, door) => {
    for (const [lx, lz] of [
      [0, 0],
      [3.5, 8],
      [-7.25, 15.5],
    ]) {
      const w = toWorld(door, lx, lz);
      const back = roomLocalFor(door, w.x, w.z);
      expect(back.lx).toBeCloseTo(lx, 12);
      expect(back.lz).toBeCloseTo(lz, 12);
    }
  });

  it.each([
    ["north", NORTH_DOOR, 1],
    ["south", SOUTH_DOOR, -1],
  ])(
    "extends the room OUTWARD from the corridor wall — %s",
    (_side, door, zSign) => {
      // Local +z (into the room) must land strictly beyond the wall plane,
      // on the opposite side from the corridor band.
      const deep = toWorld(door, 0, EXTENT / 2);
      expect(Math.sign(deep.z)).toBe(zSign);
      expect(Math.abs(deep.z)).toBeGreaterThan(WALL_Z);
      // Local x stays parallel to the corridor wall (flush entrance).
      const side = toWorld(door, WIDTH / 4, 1);
      expect(side.x - door.x).toBeCloseTo((WIDTH / 4) * zSign, 12);
    },
  );
});

describe("clamp agreement (clamps.ts's inline derivation vs the rule)", () => {
  it.each([
    ["north", NORTH_DOOR],
    ["south", SOUTH_DOOR],
  ])(
    "contains the player on the room's own side of the wall — %s",
    (_side, door) => {
      // A point mirrored to the WRONG side (the bug signature) is pulled
      // back across the wall plane through the entrance gap.
      const wrong = roomOrientationFor(door).dir * -1;
      const p = { x: door.x, z: door.z + wrong * EXTENT };
      clampToSpace(p, door, WIDTH, EXTENT, [], RECT);
      expect(Math.abs(p.x - door.x)).toBeLessThan(GAP_HALF);
      expect(Math.sign(p.z)).toBe(Math.sign(door.z));
    },
  );

  it.each([
    ["north", NORTH_DOOR],
    ["south", SOUTH_DOOR],
  ])("keeps the doorway passable through the crossing — %s", (_side, door) => {
    // Points straddling the wall plane inside the entrance gap are left
    // exactly where they are — the arrival is continuous through the
    // doorway. (The corridor side of the gap starts at CORRIDOR_Z_LIMIT,
    // 0.5 m off the wall, so the straddle begins at lz = −0.4.)
    for (const lz of [-0.4, 0, 1]) {
      const w = toWorld(door, 0, lz);
      const p = { ...w };
      clampToSpace(p, door, WIDTH, EXTENT, [], RECT);
      expect(p.x).toBeCloseTo(w.x, 12);
      expect(p.z).toBeCloseTo(w.z, 12);
    }
  });

  it.each([
    ["north", NORTH_DOOR],
    ["south", SOUTH_DOOR],
  ])(
    "keeps every strand door's crossing reachable after the clamp — %s",
    (_side, door) => {
      const doors = strandDoorsFor(door);
      expect(doors).toHaveLength(2);
      for (const d of doors) {
        // Between the jambs, at the crossing trigger's depth: the clamp's
        // ±ROOM_DOOR_PASS_DEPTH carve must leave the point inside the
        // crossedRoomDoor window (perp < ROOM_DOOR_CROSS_DEPTH, perp > −1).
        for (const perp of [0.45, -0.45]) {
          const w = toWorld(door, d.x + d.nx * perp, d.z + d.nz * perp);
          const p = { ...w };
          clampToSpace(p, door, WIDTH, EXTENT, doors, RECT);
          const { lx, lz } = roomLocalFor(door, p.x, p.z);
          expect(crossedRoomDoor(lx, lz, doors)).toBe(d.index);
        }
      }
    },
  );
});

describe("determinism (A6)", () => {
  it.each([
    ["north", NORTH_DOOR],
    ["south", SOUTH_DOOR],
  ])("lays out identical strand doors on repeat calls — %s", (_side, door) => {
    expect(strandDoorsFor(door)).toEqual(strandDoorsFor(door));
  });
});
