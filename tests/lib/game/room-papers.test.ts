/**
 * Tests for the room-paper spot resolver (v0.25a §五 B②). The contract
 * under test: the sheets' floor spots are a deterministic pure function of
 * the renderer's own inputs (A6); every spot stays inside the plan, out of
 * the doorway clearing, off the walk path's corridor, out of the water, and
 * clear of the terminal; every spot is outside the composition's cluster
 * circles (the furniture-footprint proxy) and stands where the movement
 * clamp leaves it (the reader can stand on the sheet — clampToSpace run on
 * the spot relocates nothing); sheets keep their spacing; and a smaller
 * count's result is a PREFIX of a larger one's (the late-arriving document
 * list never relocates a sheet already drawn).
 */
import { describe, it, expect } from "vitest";
import {
  PAPER_DOOR_CLEAR,
  PAPER_MARGIN,
  PAPER_PATH_CLEAR,
  PAPER_SPACING,
  roomPaperSpotsFor,
  type RoomPaperSpotsInput,
} from "@/lib/game/room-papers";
import { compileSpaceRecipe } from "@/lib/game/space-recipe";
import {
  composeRoom,
  distToPath,
  planContains,
  roomPlanFor,
  scaledRecipeFor,
} from "@/lib/game/room-plan";
import { roomTerminalFor, terminalFootprint } from "@/lib/game/anchor";
import { clampToSpace, WALL_Z } from "@/lib/game/clamps";
import type { DoorRef } from "@/lib/game/hotel";
import { waterRectFor } from "@/lib/game/terrain";
import {
  COLONNADE_BAY,
  PROP_SCALE_EXP,
  ROOM_WALL_THICKNESS,
} from "@/lib/game/tuning/room";
import { roomTemplateForDoorCount } from "@/components/game/space";
import { templatePlanFor } from "@/lib/game/room-templates";

/** The exact renderer→geometry chain the game canvas resolves (the anchor
 *  test's own fixture), extended with the paper spots. */
function spotsFor(sliceId: string, doorCount: number, count: number) {
  const recipe = compileSpaceRecipe(sliceId);
  const { recipe: scaledRecipe, scale } = scaledRecipeFor(recipe, doorCount);
  const scaleFactor = scale.factor;
  const width = scaledRecipe.width;
  const extent = scaledRecipe.size.extent;
  const wallThick = ROOM_WALL_THICKNESS * Math.max(scaleFactor, 0.35);
  const template = roomTemplateForDoorCount(
    recipe,
    width,
    extent,
    scaleFactor,
    wallThick,
    doorCount,
  );
  const plan = roomPlanFor(
    recipe.sliceId,
    width,
    extent,
    COLONNADE_BAY * Math.sqrt(Math.max(scaleFactor, 0.35)),
    undefined,
    template ? templatePlanFor(template) : undefined,
  );
  const comp = composeRoom(recipe.sliceId, plan, scaleFactor);
  const input: RoomPaperSpotsInput = {
    sliceId,
    plan,
    comp,
    width,
    wallThick,
    water: waterRectFor(scaledRecipe),
    terminal: roomTerminalFor({
      sliceId: recipe.sliceId,
      plan,
      comp,
      width,
      wallThick,
      propScale: Math.pow(scaleFactor, PROP_SCALE_EXP),
      water: waterRectFor(scaledRecipe),
    }),
    count,
  };
  return { input, spots: roomPaperSpotsFor(input) };
}

const FIXTURE_SLICES = [
  "2026-09-22-0512",
  "2026-09-13-1530",
  "2026-09-14-2207",
  "2026-09-23-1212",
  "2026-09-16-0746",
  "2026-09-17-2030",
  "2026-09-18-1111",
  "2026-09-19-2359",
] as const;

describe("roomPaperSpotsFor", () => {
  it("is deterministic: the same inputs resolve the same spots", () => {
    for (const sliceId of FIXTURE_SLICES) {
      for (const doorCount of [0, 2, 5]) {
        expect(spotsFor(sliceId, doorCount, 4).spots).toEqual(
          spotsFor(sliceId, doorCount, 4).spots,
        );
      }
    }
  });

  it("places nothing for a zero count", () => {
    expect(spotsFor(FIXTURE_SLICES[0], 0, 0).spots).toEqual([]);
  });

  it("keeps every sheet inside the plan, clear of the door, the path, and the terminal", () => {
    for (const sliceId of FIXTURE_SLICES) {
      for (const doorCount of [0, 2, 5]) {
        const { input, spots } = spotsFor(sliceId, doorCount, 4);
        const tfp = terminalFootprint(input.terminal);
        for (const spot of spots) {
          expect(planContains(input.plan, spot.x, spot.z, PAPER_MARGIN - 0.01))
            .toBe(true);
          expect(Math.hypot(spot.x, spot.z)).toBeGreaterThanOrEqual(
            PAPER_DOOR_CLEAR - 1e-9,
          );
          expect(distToPath(input.comp, spot.x, spot.z)).toBeGreaterThanOrEqual(
            input.comp.pathHalf + PAPER_PATH_CLEAR - 1e-9,
          );
          const inTerminal =
            spot.x > tfp.x0 - 0.3 &&
            spot.x < tfp.x1 + 0.3 &&
            spot.z > tfp.z0 - 0.3 &&
            spot.z < tfp.z1 + 0.3;
          expect(inTerminal).toBe(false);
          if (input.water !== null) {
            const inWater =
              Math.abs(spot.x - input.water.cx) < input.water.halfX + 0.25 &&
              Math.abs(spot.z - input.water.cz) < input.water.halfZ + 0.25;
            expect(inWater).toBe(false);
          }
        }
      }
    }
  });

  it("keeps every sheet outside the cluster circles (the furniture proxy)", () => {
    for (const sliceId of FIXTURE_SLICES) {
      for (const doorCount of [0, 2, 5]) {
        const { input, spots } = spotsFor(sliceId, doorCount, 4);
        for (const spot of spots) {
          for (const c of input.comp.clusters) {
            expect(
              Math.hypot(spot.x - c.x, spot.z - c.z),
            ).toBeGreaterThanOrEqual(c.radius + PAPER_MARGIN - 1e-9);
          }
        }
      }
    }
  });

  it("places every sheet where the movement clamp leaves it (the reader can stand on it)", () => {
    // The same synthetic door the resolver's own gate uses: the plan
    // frame's doorway, no strand doors (the conservative box).
    const door: DoorRef = { index: 0, side: "north", sliceId: "", x: 0, z: WALL_Z };
    for (const sliceId of FIXTURE_SLICES) {
      for (const doorCount of [0, 2, 5]) {
        const { input, spots } = spotsFor(sliceId, doorCount, 4);
        for (const spot of spots) {
          const p = { x: spot.x, z: spot.z + WALL_Z };
          clampToSpace(p, door, input.width, input.plan.extent, [], input.plan, []);
          expect(p.x).toBe(spot.x);
          expect(p.z).toBe(spot.z + WALL_Z);
        }
      }
    }
  });

  it("keeps the sheets spaced (dropped, not stacked)", () => {
    for (const sliceId of FIXTURE_SLICES) {
      const { spots } = spotsFor(sliceId, 2, 4);
      for (let i = 0; i < spots.length; i++) {
        for (let j = i + 1; j < spots.length; j++) {
          expect(
            Math.hypot(spots[i].x - spots[j].x, spots[i].z - spots[j].z),
          ).toBeGreaterThanOrEqual(PAPER_SPACING - 1e-9);
        }
      }
    }
  });

  it("is prefix-stable: a smaller count never relocates a sheet", () => {
    for (const sliceId of FIXTURE_SLICES) {
      for (const doorCount of [0, 2, 5]) {
        const full = spotsFor(sliceId, doorCount, 4).spots;
        for (const n of [1, 2, 3]) {
          expect(spotsFor(sliceId, doorCount, n).spots).toEqual(
            full.slice(0, n),
          );
        }
      }
    }
  });

  it("fills the requested count in ordinary rooms (the fallback is a safety net, not the norm)", () => {
    let placed = 0;
    for (const sliceId of FIXTURE_SLICES) {
      placed += spotsFor(sliceId, 2, 4).spots.length;
    }
    // Across the spread, the scan band alone lands nearly every sheet —
    // tolerate at most one fallback-short room in the draw.
    expect(placed).toBeGreaterThanOrEqual(FIXTURE_SLICES.length * 4 - 1);
  });
});
