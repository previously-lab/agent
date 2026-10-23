/**
 * Tests for the chase camera's pure half (src/lib/game/chase-camera.ts):
 * the screen-relative movement basis at TOPDOWN_YAW, the sphere cast
 * (slab test vs the analytic solids),
 * and the solid builders (door gaps stay open, drawn heights respected,
 * the room mirror lands the boxes in world space for both door sides).
 */
import { describe, it, expect } from "vitest";
import {
  CHASE_BOOM,
  CHASE_PROBE_RADIUS,
  TOPDOWN_YAW,
  castBoom,
  corridorSolids,
  moveBasisFor,
  roomSolids,
} from "@/lib/game/chase-camera";
import { WALL_Z } from "@/lib/game/clamps";
import { LOBBY_LENGTH, LOBBY_SOUTH_REACH, WALL_HEIGHT } from "@/lib/game/hotel";
import { roomPlanFor } from "@/lib/game/room-plan";
import { TERMINAL_H } from "@/lib/game/anchor";

const SQ = Math.SQRT1_2;

describe("moveBasisFor", () => {
  it("keeps movement screen-relative to the fixed southeast camera", () => {
    const b = moveBasisFor(TOPDOWN_YAW);
    // Repo north is +Z. Screen-up moves northwest; right moves southwest.
    expect(b.fx).toBeCloseTo(-SQ, 10);
    expect(b.fz).toBeCloseTo(SQ, 10);
    expect(b.rx).toBeCloseTo(-SQ, 10);
    expect(b.rz).toBeCloseTo(-SQ, 10);
  });

  it("is orthonormal at every yaw", () => {
    for (const yaw of [0, 0.3, -1.2, Math.PI / 2, Math.PI, -2.9]) {
      const b = moveBasisFor(yaw);
      expect(Math.hypot(b.fx, b.fz)).toBeCloseTo(1, 10);
      expect(Math.hypot(b.rx, b.rz)).toBeCloseTo(1, 10);
      expect(b.fx * b.rx + b.fz * b.rz).toBeCloseTo(0, 10);
    }
  });
});

describe("castBoom", () => {
  const wall = { x0: -0.1, x1: 0.1, z0: -5, z1: 5, y1: WALL_HEIGHT };

  it("hits a wall between pivot and camera at the expanded face", () => {
    // Pivot at (−3, 1.35, 0), camera desired at (0, 1.9, 0): the segment
    // crosses the wall plane x = 0. Probe radius 0.35 → entry at the
    // expanded face x = −0.45, t = (3 − 0.45) / 3.
    const t = castBoom(-3, 1.35, 0, 0, 1.9, 0, [wall], CHASE_PROBE_RADIUS);
    expect(t).toBeCloseTo((3 - 0.45) / 3, 6);
  });

  it("clears a segment that passes over a low sill", () => {
    const sill = { x0: -0.1, x1: 0.1, z0: -5, z1: 5, y1: 1.1 };
    const t = castBoom(-3, 1.35, 0, 0, 1.9, 0, [sill], CHASE_PROBE_RADIUS);
    expect(t).toBe(1);
  });

  it("answers 0 when the pivot starts inside a solid", () => {
    const t = castBoom(0, 1.35, 0, -3, 1.9, 0, [wall], CHASE_PROBE_RADIUS);
    expect(t).toBe(0);
  });

  it("answers 1 with no solids", () => {
    expect(castBoom(0, 1.35, 0, 3, 1.9, 0, [], CHASE_PROBE_RADIUS)).toBe(1);
  });
});

describe("corridorSolids", () => {
  const base = {
    endX: -24,
    pageDoor: true,
    doorXs: [-3, -9, -15, -21],
    returnDoorSouthX: null,
    eastArrivalDoor: false,
    blockers: [],
  };

  it("opens a gap at every door (the cast passes through a doorway)", () => {
    const solids = corridorSolids(base);
    // Segment straight north through the door at x = −3 (wall plane +5).
    const t = castBoom(-3, 1.35, 0, -3, 1.9, 5 + CHASE_BOOM, solids, CHASE_PROBE_RADIUS);
    expect(t).toBe(1);
  });

  it("holds between doors (a wall pull-in)", () => {
    const solids = corridorSolids(base);
    const t = castBoom(-6, 1.35, 0, -6, 1.9, 5 + CHASE_BOOM, solids, CHASE_PROBE_RADIUS);
    expect(t).toBeLessThan(1);
    expect(t).toBeGreaterThan(0);
  });

  it("opens the page door's z = 0 gap at the far end", () => {
    const solids = corridorSolids(base);
    const t = castBoom(-20, 1.35, 0, -30, 1.9, 0, solids, CHASE_PROBE_RADIUS);
    expect(t).toBe(1);
    // ...but not off-axis, where the end wall is solid.
    const t2 = castBoom(-20, 1.35, 3, -30, 1.9, 3, solids, CHASE_PROBE_RADIUS);
    expect(t2).toBeLessThan(1);
  });

  it("keeps the lobby parapet at its cutaway height (sight line clears it)", () => {
    const solids = corridorSolids(base);
    const parapet = solids.find((s) => s.y1 < 2);
    expect(parapet).toBeDefined();
    expect(parapet!.x0).toBeLessThanOrEqual(0);
    expect(parapet!.x1).toBeGreaterThanOrEqual(0);
    expect(parapet!.z1).toBeCloseTo(-WALL_Z, 6);
    expect(parapet!.z0).toBeCloseTo(-LOBBY_SOUTH_REACH, 6);
  });

  it("caps the lobby at the east wall, gap only with the arrival door", () => {
    const closed = corridorSolids(base);
    expect(
      castBoom(LOBBY_LENGTH - 3, 1.35, 0, LOBBY_LENGTH + 2, 1.9, 0, closed, CHASE_PROBE_RADIUS),
    ).toBeLessThan(1);
    const open = corridorSolids({ ...base, eastArrivalDoor: true });
    expect(
      castBoom(LOBBY_LENGTH - 3, 1.35, 0, LOBBY_LENGTH + 2, 1.9, 0, open, CHASE_PROBE_RADIUS),
    ).toBe(1);
  });
});

describe("roomSolids", () => {
  const plan = roomPlanFor("test-slice", 12, 12, 4);
  const terminal = { x: 2, z: 6, rotY: 0, scale: 1 };

  it("mirrors the perimeter into world space for a north door", () => {
    const door = { x: -9, z: WALL_Z };
    const solids = roomSolids({
      door,
      plan,
      wallThick: 0.3,
      wallHeight: WALL_HEIGHT,
      seams: [],
      terminal,
    });
    // The far wall (local z = extent − t/2) lands at world z ≈ 5 + 12.
    const far = solids.find((s) => s.z1 > WALL_Z + 11);
    expect(far).toBeDefined();
    // The terminal's box sits at world (door + local).
    const term = solids.find((s) => Math.abs(s.y1 - TERMINAL_H) < 1e-9);
    expect(term).toBeDefined();
    expect((term!.x0 + term!.x1) / 2).toBeCloseTo(door.x + terminal.x, 6);
    expect((term!.z0 + term!.z1) / 2).toBeCloseTo(door.z + terminal.z, 6);
  });

  it("mirrors a south door the other way (room extends toward −z)", () => {
    const door = { x: -9, z: -WALL_Z };
    const solids = roomSolids({
      door,
      plan,
      wallThick: 0.3,
      wallHeight: WALL_HEIGHT,
      seams: [],
      terminal,
    });
    const term = solids.find((s) => Math.abs(s.y1 - TERMINAL_H) < 1e-9);
    expect(term).toBeDefined();
    expect((term!.x0 + term!.x1) / 2).toBeCloseTo(door.x - terminal.x, 6);
    expect((term!.z0 + term!.z1) / 2).toBeCloseTo(door.z - terminal.z, 6);
    expect(term!.x0).toBeLessThan(term!.x1);
    expect(term!.z0).toBeLessThan(term!.z1);
  });

  it("leaves the entrance doorway open (the camera follows through it)", () => {
    const door = { x: -9, z: WALL_Z };
    const solids = roomSolids({
      door,
      plan,
      wallThick: 0.3,
      wallHeight: WALL_HEIGHT,
      seams: [],
      terminal: null,
    });
    // Straight through the doorway axis: corridor → deep inside the room.
    const t = castBoom(door.x, 1.35, 0, door.x, 1.9, WALL_Z + CHASE_BOOM, solids, CHASE_PROBE_RADIUS);
    expect(t).toBe(1);
  });
});
