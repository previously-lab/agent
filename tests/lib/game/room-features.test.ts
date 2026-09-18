/**
 * Tests for buildRoomFeatures (space.tsx) — the template feature-slot
 * resolver. The contract under test: door-clearance checks compare
 * positions in ONE coordinate frame. Door `along`s are measured from the
 * SOURCE wall segment's center (placeRoomDoors), while a run's feature
 * offsets are measured from the RUN's center — after a door splits a wall,
 * those centers differ. The resolver must shift frames before comparing,
 * or a niche can be carved inside a strand door's clearance (and a
 * legitimate niche elsewhere forfeited).
 */
import { describe, it, expect } from "vitest";
import { buildRoomFeatures } from "@/components/game/space";
import { WALL_HEIGHT } from "@/lib/game/hotel";
import {
  wallRoleFor,
  wallSegmentsFor,
  type RoomPlan,
} from "@/lib/game/room-plan";
import {
  splitWallsForDoors,
  type RoomDoorPlacement,
} from "@/lib/game/room-doors";
import type { RoomTemplate } from "@/lib/game/room-templates";
import { roomTemplateById } from "@/lib/game/room-templates";
import {
  COLUMN_SHAFT_RADIUS,
  DOOR_GAP_HALF,
  NICHE_DOOR_CLEAR,
  NICHE_WIDTH,
  PATH_HALF,
  WALL_SILL_HEIGHT,
} from "@/lib/game/tuning/room";

const THICK = 0.3;

function rectPlan(width: number, extent: number): RoomPlan {
  return { id: "rect", width, extent, lSide: 1, stepZ: 0, columns: [] };
}

function nicheTemplate(span: readonly [number, number]): RoomTemplate {
  return {
    id: "test-niche",
    label: "测试",
    worldClasses: ["interior"],
    footprint: "rect",
    minExtent: 16,
    doorCapacity: 10,
    doorWalls: ["left", "right"],
    features: [{ kind: "niche", at: "far", span }],
    zones: [],
    weight: 1,
  };
}

describe("buildRoomFeatures niche/door frame alignment", () => {
  const plan = rectPlan(24, 20);
  const walls = wallSegmentsFor(plan, THICK);
  const farIdx = walls.findIndex((w) => wallRoleFor(plan, w) === "far");
  const far = walls[farIdx];
  const doorAt = (index: number, along: number): RoomDoorPlacement => ({
    index,
    wall: farIdx,
    x: far.x + along,
    z: far.z,
    nx: 0,
    nz: -1,
    along,
    row: 0,
  });
  // Two doors on the far wall, splitting it into three runs.
  const doors = [doorAt(0, -8), doorAt(1, -1.2)];
  const runs = splitWallsForDoors(walls, doors);
  const heights = runs.map(() => WALL_HEIGHT);

  // The long run to the right of the second door, and the niche's
  // run-frame offset at that run's door-side extreme.
  const runIdx = runs.findIndex(
    (r) => r.source === farIdx && r.wall.x - far.x > 0,
  );
  const run = runs[runIdx];
  const lenC = run.wall.sizeX;
  const runShift = run.wall.x - far.x;
  const half = NICHE_WIDTH / 2; // ws = 1 at wallHeight = WALL_HEIGHT
  const along = -(lenC / 2 - 0.3 - half) + 0.25;
  const spanMid = 0.5 + along / lenC;
  const clear = half + DOOR_GAP_HALF + NICHE_DOOR_CLEAR;

  const build = (span: readonly [number, number]) =>
    buildRoomFeatures({
      template: nicheTemplate(span),
      plan,
      walls,
      wallRuns: runs,
      wallHeights: heights,
      wallHeight: WALL_HEIGHT,
      wallThick: THICK,
      doors,
      ground: "flat",
      water: null,
    });

  it("the fixture discriminates the two frames", () => {
    // True (shifted) distance from the nearer door to the niche opening is
    // INSIDE the clearance; the unshifted comparison would call it clear.
    const trueDist = Math.min(
      ...doors.map((d) => Math.abs(d.along - runShift - along)),
    );
    const buggyDist = Math.min(...doors.map((d) => Math.abs(d.along - along)));
    expect(trueDist).toBeLessThan(clear);
    expect(buggyDist).toBeGreaterThanOrEqual(clear);
  });

  it("forfeits a niche whose opening sits inside a strand door's clearance", () => {
    const features = build([spanMid - 0.01, spanMid + 0.01]);
    expect(features.niches).toHaveLength(0);
  });

  it("keeps a niche genuinely clear of every door", () => {
    // Same run, opening at the end AWAY from the doors.
    const farAlong = lenC / 2 - 0.3 - half - 0.05;
    const farMid = 0.5 + farAlong / lenC;
    const features = build([farMid - 0.01, farMid + 0.01]);
    expect(features.niches).toHaveLength(1);
    expect(features.niches[0].run).toBe(runIdx);
  });
});

describe("buildRoomFeatures N3/N4 features (§3.2)", () => {
  const plan = rectPlan(24, 20);
  const walls = wallSegmentsFor(plan, THICK);
  const noDoors: RoomDoorPlacement[] = [];

  const featureTemplate = (
    features: RoomTemplate["features"],
  ): RoomTemplate => ({
    id: "test-features",
    label: "测试",
    worldClasses: ["interior"],
    footprint: "rect",
    minExtent: 16,
    doorCapacity: 10,
    doorWalls: ["left", "right"],
    features,
    zones: [],
    weight: 1,
  });

  const build = (
    features: RoomTemplate["features"],
    opts: {
      /** The per-run DRAWN heights (cutaway sills) — wallHeight (the
       *  scale base) stays WALL_HEIGHT so the ws ratio is 1, matching
       *  how the renderer reports a cutaway room. */
      drawnHeights?: number;
      doors?: readonly RoomDoorPlacement[];
      water?: { cx: number; cz: number; halfX: number; halfZ: number } | null;
      ground?: "flat" | "rolling" | "sunken";
    } = {},
  ) => {
    const doors = opts.doors ?? noDoors;
    return buildRoomFeatures({
      template: featureTemplate(features),
      plan,
      walls,
      wallRuns: splitWallsForDoors(walls, doors),
      wallHeights: walls.map(() => opts.drawnHeights ?? WALL_HEIGHT),
      wallHeight: WALL_HEIGHT,
      wallThick: THICK,
      doors,
      ground: opts.ground ?? "flat",
      water: opts.water ?? null,
    });
  };

  it("resolves a raised platform on the far wall, railed and run-bounded", () => {
    const f = build([{ kind: "raised-platform", at: "far", span: [0.3, 0.7] }]);
    expect(f.platforms).toHaveLength(1);
    const p = f.platforms[0];
    expect(p.width).toBeGreaterThan(3);
    expect(p.height).toBeGreaterThan(0.2);
    // The host run is the door-split far wall — the platform fits inside.
    const run = splitWallsForDoors(walls, [])[p.run];
    expect(Math.abs(p.along) + p.width / 2).toBeLessThanOrEqual(
      (run.wall.sizeX <= run.wall.sizeZ ? run.wall.sizeZ : run.wall.sizeX) / 2,
    );
  });

  it("grows the mezzanine only on a wall tall enough to hold it", () => {
    expect(build([{ kind: "mezzanine", at: "far" }]).mezzanines).toHaveLength(1);
    // A cutaway sill (drawn at 1.1m) has no business carrying a half-floor.
    const short = build([{ kind: "mezzanine", at: "far" }], {
      drawnHeights: WALL_SILL_HEIGHT,
    });
    expect(short.mezzanines).toHaveLength(0);
  });

  it("grows the arch only where its crown clears the drawn wall top", () => {
    expect(build([{ kind: "arch-frame", at: "far" }]).arches).toHaveLength(1);
    const short = build([{ kind: "arch-frame", at: "far" }], {
      drawnHeights: WALL_SILL_HEIGHT,
    });
    expect(short.arches).toHaveLength(0);
  });

  it("spreads the column order inside the declared span, clear of door frames", () => {
    const wide = build([
      { kind: "column-order", at: "far", span: [0.1, 0.9] },
    ]);
    expect(wide.columnOrders.length).toBeGreaterThan(0);
    const total = wide.columnOrders.reduce((n, c) => n + c.alongs.length, 0);
    expect(total).toBeGreaterThanOrEqual(3);
    const narrow = build([
      { kind: "column-order", at: "far", span: [0.45, 0.55] },
    ]);
    const narrowTotal = narrow.columnOrders.reduce(
      (n, c) => n + c.alongs.length,
      0,
    );
    expect(narrowTotal).toBeLessThan(total);
    expect(narrowTotal).toBeGreaterThanOrEqual(0);

    // A strand door on the far wall: no column lands inside its frame
    // clearance (the same frame-shifted discipline as the niche).
    const farIdx = walls.findIndex((w) => wallRoleFor(plan, w) === "far");
    const far = walls[farIdx];
    const door: RoomDoorPlacement = {
      index: 0,
      wall: farIdx,
      x: far.x - 6,
      z: far.z,
      nx: 0,
      nz: -1,
      along: -6,
      row: 0,
    };
    const withDoor = build(
      [{ kind: "column-order", at: "far", span: [0.1, 0.9] }],
      { doors: [door] },
    );
    for (const co of withDoor.columnOrders) {
      const src = walls[
        splitWallsForDoors(walls, [door])[co.run].source
      ];
      const run = splitWallsForDoors(walls, [door])[co.run];
      const runShift = run.wall.x - src.x;
      for (const a of co.alongs) {
        expect(Math.abs(door.along - runShift - a)).toBeGreaterThanOrEqual(
          DOOR_GAP_HALF + COLUMN_SHAFT_RADIUS,
        );
      }
    }
  });

  it("resolves a flank water rill wholly clear of the walk corridor", () => {
    const f = build([
      { kind: "water-rill", at: "floor", span: [0.7, 0.95], spanZ: [0.2, 0.7] },
    ]);
    expect(f.rill).not.toBeNull();
    const r = f.rill!;
    expect(r.x1).toBeGreaterThanOrEqual(PATH_HALF);
    expect(r.x0).toBeGreaterThanOrEqual(PATH_HALF);
  });

  it("clips a straddling rill declaration to one side rather than blocking the path", () => {
    const f = build([
      { kind: "water-rill", at: "floor", span: [0.1, 0.9], spanZ: [0.3, 0.6] },
    ]);
    expect(f.rill).not.toBeNull();
    const r = f.rill!;
    // Wholly on ONE side of the corridor.
    expect(r.x1 <= -(PATH_HALF) || r.x0 >= PATH_HALF).toBe(true);
  });

  it("degrades the rill to nothing on rolling terrain or over the basin", () => {
    const rolling = build(
      [{ kind: "water-rill", at: "floor", span: [0.7, 0.95], spanZ: [0.2, 0.7] }],
      { ground: "rolling" },
    );
    expect(rolling.rill).toBeNull();
    const wet = build(
      [{ kind: "water-rill", at: "floor", span: [0.55, 0.9], spanZ: [0.2, 0.7] }],
      { water: { cx: 6, cz: 10, halfX: 4, halfZ: 5 } },
    );
    expect(wet.rill).toBeNull();
  });

  it("keeps the rill out of a strand door's approach", () => {
    const rightIdx = walls.findIndex((w) => wallRoleFor(plan, w) === "right");
    const right = walls[rightIdx];
    // A door on the right wall a metre shy of the rill's mid-depth: its
    // approach strip (1.8m half-width, 3m inward) reaches into the rill's
    // rectangle, so the slot must degrade to nothing.
    const door: RoomDoorPlacement = {
      index: 0,
      wall: rightIdx,
      x: right.x,
      z: right.z - 1,
      nx: -1,
      nz: 0,
      along: -1,
      row: 0,
    };
    const f = build(
      [
        {
          kind: "water-rill",
          at: "floor",
          span: [0.78, 0.98],
          spanZ: [0.3, 0.6],
        },
      ],
      { doors: [door] },
    );
    expect(f.rill).toBeNull();
  });
});

describe("reading-hall niche after audit #7 (§7.2)", () => {
  // The template data moved the niche off the far (door) wall onto the left
  // flank. These lock the geometry: the niche builds on the flank when that
  // wall is drawn full height, and forfeits (never clips) when the room's
  // orientation cuts the flank to a sill.
  const hall = roomTemplateById("reading-hall")!;
  const plan = rectPlan(48, 32);
  const walls = wallSegmentsFor(plan, THICK);
  const runs = splitWallsForDoors(walls, []);
  const roleOf = (i: number) => wallRoleFor(plan, walls[runs[i].source]);
  const build = (wallHeights: number[]) =>
    buildRoomFeatures({
      template: hall,
      plan,
      walls,
      wallRuns: runs,
      wallHeights,
      wallHeight: WALL_HEIGHT,
      wallThick: THICK,
      doors: [],
      ground: "flat",
      water: null,
    });
  const heightsFor = (sillRole: "left" | "right") =>
    runs.map((_, i) => (roleOf(i) === sillRole ? WALL_SILL_HEIGHT : WALL_HEIGHT));

  it("declares the niche off every door wall (data lock)", () => {
    const niche = hall.features.find((f) => f.kind === "niche")!;
    expect(niche.at).toBe("left");
    expect(hall.doorWalls).not.toContain(niche.at);
    expect(hall.doorWalls).toEqual(["far"]);
  });

  it("builds the flank niche when the left wall stands full height (south room)", () => {
    // South-facing room: the RIGHT wall faces the camera (sill), the LEFT
    // stands full height — the niche resolves on a left run.
    const features = build(heightsFor("right"));
    expect(features.niches).toHaveLength(1);
    expect(roleOf(features.niches[0].run)).toBe("left");
  });

  it("forfeits the niche when the left wall is a cutaway sill (north room)", () => {
    // North-facing room: the LEFT wall is the sill — a niche in a 1.1 m
    // wall would be a hole in nothing, so the slot stays absent.
    const features = build(heightsFor("left"));
    expect(features.niches).toHaveLength(0);
  });
});
