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
import {
  DOOR_GAP_HALF,
  NICHE_DOOR_CLEAR,
  NICHE_WIDTH,
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
      flatFloor: true,
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
