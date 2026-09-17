/**
 * Tests for the strand-door layout module (v0.11 §B.8/B.11). The contract
 * under test: door placement is a deterministic pure function of
 * (worldSeed, sliceId, plan, count) — the same memory grows the same doors
 * (axiom A6); doors land ONLY on solid walls (never the entrance pair,
 * never the colonnade's open sides, always facing the walkable side of an
 * l-shape); domestic composition keeps a minimum spacing; and every
 * requested door is placed — including the tight case, which relaxes
 * spacing instead of dropping doors.
 */
import { describe, it, expect } from "vitest";
import {
  crossedRoomDoor,
  hostableWallsFor,
  placeRoomDoors,
  plaqueLabelFor,
  splitWallsForDoors,
  type RoomDoorPlacement,
} from "@/lib/game/room-doors";
import {
  planContains,
  roomPlanFor,
  wallRoleFor,
  wallSegmentsFor,
  type RoomPlan,
  type WallSegment,
} from "@/lib/game/room-plan";
import { hashString } from "@/lib/game/seed";
import {
  COLONNADE_BAY,
  DOOR_GAP_HALF,
  DOOR_WIDTH,
  ROOM_DOOR_MIN_GAP,
  ROOM_DOOR_PLAQUE_MAX_CHARS,
} from "@/lib/game/tuning/room";
import { GAP_HALF } from "@/lib/game/clamps";

const THICK = 0.3;

function rectPlan(width: number, extent: number): RoomPlan {
  return { id: "rect", width, extent, lSide: 1, stepZ: 0, columns: [] };
}

function lPlan(width: number, extent: number, lSide: 1 | -1, stepZ: number): RoomPlan {
  return { id: "l-shape", width, extent, lSide, stepZ, columns: [] };
}

function colonnadePlan(width: number, extent: number): RoomPlan {
  return { id: "colonnade", width, extent, lSide: 1, stepZ: 0, columns: [] };
}

/** The "solid wall" set: every non-entrance segment is hostable. */
function allSolid(walls: readonly WallSegment[]): boolean[] {
  return walls.map((w) => !w.entrance);
}

/** Same-wall pairwise center spacing of a placement set. */
function minSameWallSpacing(doors: readonly RoomDoorPlacement[]): number {
  let min = Infinity;
  for (let i = 0; i < doors.length; i++) {
    for (let j = i + 1; j < doors.length; j++) {
      if (doors[i].wall !== doors[j].wall) continue;
      min = Math.min(min, Math.abs(doors[i].along - doors[j].along));
    }
  }
  return min;
}

describe("placeRoomDoors", () => {
  it("is deterministic per (sliceId, plan, count) — axiom A6", () => {
    const plan = rectPlan(48, 32);
    const walls = wallSegmentsFor(plan, THICK);
    for (const count of [1, 3, 6]) {
      const a = placeRoomDoors("2026-09-15-0746", plan, walls, allSolid(walls), count);
      const b = placeRoomDoors("2026-09-15-0746", plan, walls, allSolid(walls), count);
      expect(a).toEqual(b);
    }
  });

  it("varies with the slice id and the door count", () => {
    const plan = rectPlan(48, 32);
    const walls = wallSegmentsFor(plan, THICK);
    const seen = new Set<string>();
    for (const id of ["2026-06-22-1400", "2026-09-15-0746", "2027-01-03-2330"]) {
      seen.add(
        JSON.stringify(placeRoomDoors(id, plan, walls, allSolid(walls), 4).doors),
      );
    }
    expect(seen.size).toBe(3);
    const c3 = placeRoomDoors("2026-06-22-1400", plan, walls, allSolid(walls), 3);
    const c4 = placeRoomDoors("2026-06-22-1400", plan, walls, allSolid(walls), 4);
    expect(JSON.stringify(c3.doors)).not.toBe(JSON.stringify(c4.doors));
  });

  it("is composed, not evenly spaced (B.8): irregular gaps on shared walls", () => {
    // Across many seeds, at least one wall hosts 2+ doors with gaps that
    // are NOT all equal — clustering + rejection-sampled positions.
    const plan = rectPlan(48, 32);
    const walls = wallSegmentsFor(plan, THICK);
    let clustered = 0;
    for (let i = 0; i < 40; i++) {
      const { doors } = placeRoomDoors(`2026-03-${i}`, plan, walls, allSolid(walls), 4);
      const byWall = new Map<number, number[]>();
      for (const d of doors) byWall.set(d.wall, [...(byWall.get(d.wall) ?? []), d.along]);
      for (const alongs of byWall.values()) {
        if (alongs.length < 2) continue;
        const sorted = [...alongs].sort((a, b) => a - b);
        const gaps = sorted.slice(1).map((v, k) => v - sorted[k]);
        if (gaps.some((g) => Math.abs(g - gaps[0]) > 0.01)) clustered += 1;
      }
    }
    expect(clustered).toBeGreaterThan(0);
  });

  it("keeps the domestic minimum spacing at the primary rung", () => {
    const plan = rectPlan(64, 48);
    const walls = wallSegmentsFor(plan, THICK);
    for (let i = 0; i < 25; i++) {
      const layout = placeRoomDoors(`2026-07-${i}`, plan, walls, allSolid(walls), 5);
      expect(layout.relaxed).toBe(false);
      expect(minSameWallSpacing(layout.doors)).toBeGreaterThanOrEqual(
        DOOR_WIDTH + ROOM_DOOR_MIN_GAP - 1e-9,
      );
    }
  });

  it("never hosts on the entrance wall and never overlaps the doorway", () => {
    for (const plan of [rectPlan(48, 32), lPlan(48, 32, 1, 16), colonnadePlan(48, 32)]) {
      const walls = wallSegmentsFor(plan, THICK);
      for (let i = 0; i < 10; i++) {
        const { doors } = placeRoomDoors(`2026-08-${i}`, plan, walls, allSolid(walls), 5);
        for (const d of doors) {
          expect(walls[d.wall].entrance).toBe(false);
          // The entrance gap sits at (0, 0): every strand door keeps clear.
          expect(Math.hypot(d.x, d.z)).toBeGreaterThan(DOOR_GAP_HALF + 1);
        }
      }
    }
  });

  it("places doors only on walls whose face is walkable (probed normals)", () => {
    for (const plan of [
      rectPlan(32, 32),
      lPlan(48, 40, 1, 20),
      lPlan(48, 40, -1, 22),
      colonnadePlan(64, 40),
    ]) {
      const walls = wallSegmentsFor(plan, THICK);
      const { doors } = placeRoomDoors("2026-09-01-1200", plan, walls, allSolid(walls), 6);
      expect(doors).toHaveLength(6);
      for (const d of doors) {
        // Axis-aligned unit normal.
        expect(Math.abs(Math.abs(d.nx) + Math.abs(d.nz) - 1)).toBeLessThan(1e-9);
        // One meter inward from the door is walkable plan — the door
        // approaches from inside, never from the abandoned quadrant/void.
        expect(planContains(plan, d.x + d.nx, d.z + d.nz, 0.3)).toBe(true);
      }
    }
  });

  it("colonnade rooms host only on the far wall (sides are open bays)", () => {
    const plan = colonnadePlan(64, 40);
    const walls = wallSegmentsFor(plan, THICK);
    const farWall = walls.length - 1; // entrance pair + far wall only
    expect(walls.filter((w) => !w.entrance)).toHaveLength(1);
    for (let i = 0; i < 8; i++) {
      const { doors } = placeRoomDoors(`2026-05-${i}`, plan, walls, allSolid(walls), 4);
      for (const d of doors) expect(d.wall).toBe(farWall);
    }
  });

  it("respects the caller's hostable flags (e.g. cutaway sills excluded)", () => {
    const plan = rectPlan(48, 32);
    const walls = wallSegmentsFor(plan, THICK);
    // Only the far wall hostable.
    const hostable = walls.map((w, i) => !w.entrance && i === walls.length - 1);
    const { doors } = placeRoomDoors("2026-09-15-0746", plan, walls, hostable, 3);
    expect(doors).toHaveLength(3);
    for (const d of doors) expect(d.wall).toBe(walls.length - 1);
  });

  it("places exactly N doors for N requested — including the tight case", () => {
    // A closet of a room (8×8) asked for eight doors: domestic spacing
    // fits six, so the ladder relaxes — but never drops a door.
    const plan = rectPlan(8, 8);
    const walls = wallSegmentsFor(plan, THICK);
    const layout = placeRoomDoors("2026-09-15-0746", plan, walls, allSolid(walls), 8);
    expect(layout.doors).toHaveLength(8);
    expect(layout.relaxed).toBe(true);
    for (const d of layout.doors) {
      expect(walls[d.wall].entrance).toBe(false);
      expect(planContains(plan, d.x + d.nx, d.z + d.nz, 0.05)).toBe(true);
    }
    // A normal request is not marked relaxed.
    const easy = placeRoomDoors("2026-09-15-0746", plan, walls, allSolid(walls), 2);
    expect(easy.doors).toHaveLength(2);
    expect(easy.relaxed).toBe(false);
    // Zero requested, zero placed.
    expect(placeRoomDoors("x", plan, walls, allSolid(walls), 0).doors).toHaveLength(0);
  });

  it("survives the absurd case with every door still placed", () => {
    // 3.2m miniature room, four doors: no domestic spacing can apply.
    const plan = rectPlan(3.2, 3.2);
    const walls = wallSegmentsFor(plan, THICK);
    const layout = placeRoomDoors("2026-09-15-0746", plan, walls, allSolid(walls), 4);
    expect(layout.doors).toHaveLength(4);
    expect(layout.relaxed).toBe(true);
  });
});

describe("splitWallsForDoors", () => {
  it("cuts each host wall around its door gaps and tiles the rest", () => {
    const plan = rectPlan(32, 24);
    const walls = wallSegmentsFor(plan, THICK);
    const { doors } = placeRoomDoors("2026-09-15-0746", plan, walls, allSolid(walls), 4);
    const runs = splitWallsForDoors(walls, doors);
    // Coverage: per source wall, runs + gaps reconstitute the wall length.
    for (let i = 0; i < walls.length; i++) {
      const src = walls[i];
      const len = Math.max(src.sizeX, src.sizeZ);
      const hosted = doors.filter((d) => d.wall === i);
      const runLen = runs
        .filter((r) => r.source === i)
        .reduce((a, r) => a + Math.max(r.wall.sizeX, r.wall.sizeZ), 0);
      expect(runLen + hosted.length * DOOR_GAP_HALF * 2).toBeCloseTo(len, 6);
      // No run intrudes into any gap interval along the wall's axis.
      for (const r of runs.filter((r) => r.source === i)) {
        const horizontal = src.sizeZ <= src.sizeX;
        const mid = horizontal ? r.wall.x - src.x : r.wall.z - src.z;
        const half = Math.max(r.wall.sizeX, r.wall.sizeZ) / 2;
        for (const d of hosted) {
          const overlap =
            Math.min(mid + half, d.along + DOOR_GAP_HALF) -
            Math.max(mid - half, d.along - DOOR_GAP_HALF);
          expect(overlap).toBeLessThan(1e-3);
        }
      }
    }
    // Untouched walls pass through with their identity (entrance pair).
    const entranceRuns = runs.filter((r) => walls[r.source].entrance);
    expect(entranceRuns).toHaveLength(2);
    for (const r of entranceRuns) expect(r.wall.entrance).toBe(true);
  });

  it("is the identity when no doors are placed", () => {
    const plan = rectPlan(32, 24);
    const walls = wallSegmentsFor(plan, THICK);
    const runs = splitWallsForDoors(walls, []);
    expect(runs.map((r) => r.wall)).toEqual(walls);
  });
});

describe("crossedRoomDoor", () => {
  const plan = rectPlan(32, 24);
  const walls = wallSegmentsFor(plan, THICK);
  const { doors } = placeRoomDoors("2026-09-15-0746", plan, walls, allSolid(walls), 3);

  it("fires between the jambs at the wall plane, and only there", () => {
    expect(doors.length).toBeGreaterThan(0);
    for (const d of doors) {
      // Inside the doorway, past the inner face: crossed.
      expect(crossedRoomDoor(d.x + d.nx * 0.3, d.z + d.nz * 0.3, doors)).toBe(d.index);
      // Just outside the slab passage (|along| ≥ GAP_HALF): no.
      const tx = -d.nz;
      const tz = d.nx;
      expect(
        crossedRoomDoor(
          d.x + tx * (GAP_HALF + 0.4) + d.nx * 0.3,
          d.z + tz * (GAP_HALF + 0.4) + d.nz * 0.3,
          doors,
        ),
      ).toBeNull();
      // Standing in the room in front of the door but not through it: no.
      expect(crossedRoomDoor(d.x + d.nx * 2, d.z + d.nz * 2, doors)).toBeNull();
    }
  });

  it("never fires for the entrance", () => {
    // Walking the entrance doorway (local origin, any depth): no strand
    // door lives on the entrance wall, so nothing can fire.
    expect(crossedRoomDoor(0, 0.3, doors)).toBeNull();
    expect(crossedRoomDoor(0, -0.3, doors)).toBeNull();
  });
});

describe("plaqueLabelFor", () => {
  it("round-trips labels that fit, whitespace collapsed", () => {
    expect(plaqueLabelFor("海边的卡夫卡 · 06·22")).toBe("海边的卡夫卡 · 06·22");
    expect(plaqueLabelFor("kafka  on   the shore")).toBe("kafka on the shore");
    expect(plaqueLabelFor("")).toBe("");
  });

  it("truncates deterministically with an ellipsis when over the cap", () => {
    const long = "a very long strand name that will not fit the plaque at all";
    const out = plaqueLabelFor(long);
    expect(out.length).toBeLessThanOrEqual(ROOM_DOOR_PLAQUE_MAX_CHARS);
    expect(out.endsWith("…")).toBe(true);
    expect(out.startsWith("a very long")).toBe(true);
    expect(plaqueLabelFor(long)).toBe(out);
  });
});

/* ------------------------------------------------------------------ */
/* Template affordance (v0.11-room-interiors §7): the optional           */
/* DoorAffordance parameter. ADDITIVE-ONLY PIN: the hashes below were    */
/* captured from this module BEFORE the parameter existed, over the      */
/* fixed matrix — omitting it must reproduce today's layouts            */
/* byte-for-byte.                                                       */
/* ------------------------------------------------------------------ */

describe("door affordance parameter (§7) — additive", () => {
  const pin = (v: unknown) => {
    const s = JSON.stringify(v);
    return `${s.length}:${hashString(s)}`;
  };
  /** [sliceId, width, extent] — plans drawn exactly as the capture did. */
  const CASES: [string, number, number][] = [
    ["2026-10-02", 32, 32],
    ["2026-10-03", 48, 32],
    ["2026-10-04", 64, 64],
    ["2026-10-05", 96, 96],
    ["2026-10-06", 144, 96],
    ["2026-10-07", 21.12, 32],
    ["2026-10-08", 64, 64],
  ];
  /** Pins per case, in count order [0, 2, 5, 12]. */
  const PINS: string[][] = [
    ["28:572605569", "217:3734579729", "507:1897690691", "1180:1595498093"],
    ["28:572605569", "218:45983427", "505:2635510601", "1179:3353548360"],
    ["28:572605569", "220:1256333126", "507:2010783316", "1172:3586942758"],
    ["28:572605569", "219:1513487658", "504:860977800", "1180:3354572437"],
    ["28:572605569", "217:2787794349", "504:3971847597", "1161:3357926252"],
    ["28:572605569", "218:730247303", "503:242676963", "1171:424305385"],
    ["28:572605569", "221:3212720819", "506:4130105954", "1160:3633062894"],
  ];
  const COUNTS = [0, 2, 5, 12];

  it("reproduces the pre-affordance layouts byte-for-byte when omitted", () => {
    CASES.forEach(([id, w, e], ci) => {
      const plan = roomPlanFor(id, w, e, COLONNADE_BAY);
      const walls = wallSegmentsFor(plan, THICK);
      const hostable = hostableWallsFor(plan, walls, 1);
      COUNTS.forEach((count, ki) => {
        expect(pin(placeRoomDoors(id, plan, walls, hostable, count))).toBe(
          PINS[ci][ki],
        );
      });
    });
  });

  it("treats an explicit undefined exactly as omitted", () => {
    const plan = roomPlanFor("2026-10-04", 64, 64, COLONNADE_BAY);
    const walls = wallSegmentsFor(plan, THICK);
    const hostable = hostableWallsFor(plan, walls, 1);
    expect(
      placeRoomDoors("2026-10-04", plan, walls, hostable, 5, undefined, undefined),
    ).toEqual(placeRoomDoors("2026-10-04", plan, walls, hostable, 5));
  });

  it("hangs every door on the permitted wall roles only — even when relaxed", () => {
    // The gallery's affordance: the far wall is the door wall.
    const plan = colonnadePlan(96, 64);
    const walls = wallSegmentsFor(plan, THICK);
    const hostable = hostableWallsFor(plan, walls, 1);
    const layout = placeRoomDoors("2026-10-30", plan, walls, hostable, 20, undefined, {
      walls: ["far"],
    });
    expect(layout.doors).toHaveLength(20); // never drops a door
    for (const d of layout.doors) {
      expect(wallRoleFor(plan, walls[d.wall])).toBe("far");
    }
  });

  it("never places a door on a template-banned wall in tight rooms", () => {
    // Reading-hall affordance (left/right only) on a small rect asked for
    // more doors than the sides can hold at domestic spacing: the ladder
    // relaxes, but the far wall stays doorless.
    const plan = rectPlan(21.12, 32);
    const walls = wallSegmentsFor(plan, THICK);
    const hostable = hostableWallsFor(plan, walls, 1);
    const layout = placeRoomDoors("2026-10-31", plan, walls, hostable, 12, undefined, {
      walls: ["left", "right"],
    });
    expect(layout.doors).toHaveLength(12);
    for (const d of layout.doors) {
      expect(["left", "right"]).toContain(wallRoleFor(plan, walls[d.wall]));
    }
  });

  it("is deterministic under an affordance (A6)", () => {
    const plan = rectPlan(48, 32);
    const walls = wallSegmentsFor(plan, THICK);
    const hostable = hostableWallsFor(plan, walls, 1);
    const affordance = { walls: ["left", "right"] as const };
    expect(
      placeRoomDoors("2026-11-01", plan, walls, hostable, 4, undefined, affordance),
    ).toEqual(
      placeRoomDoors("2026-11-01", plan, walls, hostable, 4, undefined, affordance),
    );
  });
});
