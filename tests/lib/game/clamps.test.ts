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
