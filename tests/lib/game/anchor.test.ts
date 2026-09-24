/**
 * Tests for the anchor terminal module (v0.11 §13.1/§14.4 step ④). The
 * contract under test: the room terminal's spot is a deterministic pure
 * function of (sliceId, plan, comp, width, wallThick, propScale, water)
 * (A6 — space.tsx and game-canvas.tsx resolve the SAME anchor through the
 * same call); it always stays inside the plan; it never blocks the doorway
 * strip, the walk path, or the water; it stands in the room's OPEN FIELD
 * (mid-depth — a floor lamp, not a wall fixture) unless the room is too
 * small to clear the path anywhere, in which case it degrades to the
 * entrance-wall spot; and it never overlaps the staged furniture. The
 * lobby terminal's constants are consistent with its blocker.
 */
import { describe, it, expect } from "vitest";
import {
  LOBBY_TERMINAL_ANCHOR,
  LOBBY_TERMINAL_BLOCKER,
  roomTerminalFor,
  terminalFootprint,
  terminalInsidePlan,
  TERMINAL_D,
  TERMINAL_REACH_LOBBY,
  TERMINAL_W,
  type RoomTerminalInput,
} from "@/lib/game/anchor";
import { compileSpaceRecipe } from "@/lib/game/space-recipe";
import {
  composeRoom,
  distToPath,
  roomPlanFor,
  scaledRecipeFor,
} from "@/lib/game/room-plan";
import { waterRectFor } from "@/lib/game/terrain";
import {
  stageInteriorKits,
  planArea,
  type StagedKitPiece,
} from "@/lib/game/kits";
import { createRng, deriveSubSeed, WORLD_SEED } from "@/lib/game/seed";
import { debugUnitsFor } from "@/lib/game/debug-catalog";
import {
  COLONNADE_BAY,
  ENTRANCE_CLEAR_RADIUS,
  HERO_CLEAR,
  PROP_SCALE_EXP,
  ROOM_WALL_THICKNESS,
} from "@/lib/game/tuning/room";
import { roomTemplateForDoorCount } from "@/components/game/space";
import { templatePlanFor } from "@/lib/game/room-templates";

/**
 * The exact renderer→anchor chain both call sites share, over a spread
 * of real compiled slices and strand-door counts (scale notations,
 * templates, and plan silhouettes all vary across the draw).
 */
function anchorFor(sliceId: string, count: number): {
  input: RoomTerminalInput;
  anchor: ReturnType<typeof roomTerminalFor>;
} {
  const recipe = compileSpaceRecipe(sliceId);
  const { recipe: scaledRecipe, scale } = scaledRecipeFor(recipe, count);
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
    count,
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
  const input: RoomTerminalInput = {
    sliceId,
    plan,
    comp,
    width,
    wallThick,
    propScale: Math.pow(scaleFactor, PROP_SCALE_EXP),
    water: waterRectFor(scaledRecipe),
  };
  return { input, anchor: roomTerminalFor(input) };
}

/** Every fixture slice exercised below — a spread of classes and ids. */
const FIXTURE_SLICES = [
  "2026-09-12-0941",
  "2026-09-13-1530",
  "2026-09-14-2207",
  "2026-09-15-1401",
  "2026-09-16-0746",
  "2026-09-17-2030",
  "2026-09-18-1111",
  "2026-09-19-2359",
] as const;

/** True when the anchor came from the entrance-wall fallback (the
 *  degenerate rooms too small to clear the path in the open field). */
function isFallback(
  input: RoomTerminalInput,
  anchor: ReturnType<typeof roomTerminalFor>,
): boolean {
  return anchor.z < input.plan.extent * 0.3 - 1e-6;
}

describe("roomTerminalFor", () => {
  it("is deterministic in its inputs (A6)", () => {
    for (const sliceId of FIXTURE_SLICES) {
      for (const count of [0, 1, 3]) {
        const a = anchorFor(sliceId, count);
        const again = roomTerminalFor(a.input);
        expect(again).toEqual(a.anchor);
      }
    }
  });

  it("stays inside the plan (footprint containment)", () => {
    for (const sliceId of FIXTURE_SLICES) {
      for (const count of [0, 2, 5]) {
        const { input, anchor } = anchorFor(sliceId, count);
        expect(
          terminalInsidePlan(
            input.plan,
            input.width,
            input.plan.extent,
            input.wallThick,
            terminalFootprint(anchor),
          ),
          `${sliceId}@${count} at ${anchor.x.toFixed(2)},${anchor.z.toFixed(2)}`,
        ).toBe(true);
      }
    }
  });

  it("clears the doorway strip, the walk path, and the hero", () => {
    for (const sliceId of FIXTURE_SLICES) {
      for (const count of [0, 1, 4]) {
        const { input, anchor } = anchorFor(sliceId, count);
        const w = (TERMINAL_W * anchor.scale) / 2;
        // The entrance strip is UNSCALED (the door never scales, A4). The
        // machine stands well past it — except in degenerate dollhouse
        // rooms the strip alone outspans (the fallback may hug the wall
        // beside the door, still outside the strip's circle).
        expect(
          Math.hypot(anchor.x, anchor.z) - w,
        ).toBeGreaterThanOrEqual(ENTRANCE_CLEAR_RADIUS - 1e-6);
        expect(
          distToPath(input.comp, anchor.x, anchor.z),
        ).toBeGreaterThanOrEqual(input.comp.pathHalf + w - 1e-6);
        const heroClear = HERO_CLEAR * input.propScale;
        if (heroClear > 0) {
          expect(
            Math.hypot(anchor.x - input.comp.hero.x, anchor.z - input.comp.hero.z),
          ).toBeGreaterThanOrEqual(heroClear - 1e-6);
        }
      }
    }
  });

  it("never stands in the water", () => {
    for (const sliceId of FIXTURE_SLICES) {
      const { input, anchor } = anchorFor(sliceId, 0);
      if (!input.water) continue;
      const w = (TERMINAL_W * anchor.scale) / 2;
      const dx = Math.max(0, Math.abs(anchor.x - input.water.cx) - input.water.halfX);
      const dz = Math.max(0, Math.abs(anchor.z - input.water.cz) - input.water.halfZ);
      expect(Math.hypot(dx, dz)).toBeGreaterThanOrEqual(w - 1e-6);
    }
  });

  it("stands in the open field (mid-depth) unless the room cannot clear the path", () => {
    let fallbacks = 0;
    for (const sliceId of FIXTURE_SLICES) {
      for (const count of [0, 1, 4]) {
        const { input, anchor } = anchorFor(sliceId, count);
        if (isFallback(input, anchor)) {
          fallbacks += 1;
          // The fallback is the wall-side spot: beside the doorway, still
          // outside the strip circle (asserted above).
          expect(Math.abs(anchor.x)).toBeGreaterThan(ENTRANCE_CLEAR_RADIUS - 1e-6);
        } else {
          // The middle band — a floor lamp in the room's open area.
          expect(anchor.z).toBeGreaterThanOrEqual(input.plan.extent * 0.3 - 1e-6);
          expect(anchor.z).toBeLessThanOrEqual(input.plan.extent * 0.7 + 1e-6);
        }
      }
    }
    // The fixtures are standard-scale rooms: the open field resolves
    // everywhere. (A non-zero count here means a REAL small-room draw
    // regressed to the fallback — investigate before raising the number.)
    expect(fallbacks).toBe(0);
  });
});

describe("the 12-module scan (gallery units × strand-door counts)", () => {
  /** The terminal's footprint rectangle vs one kit piece's body disc. */
  function overlapsPiece(
    fp: ReturnType<typeof terminalFootprint>,
    cx: number,
    cz: number,
    r: number,
  ): boolean {
    const nx = Math.max(fp.x0, Math.min(cx, fp.x1));
    const nz = Math.max(fp.z0, Math.min(cz, fp.z1));
    return Math.hypot(cx - nx, cz - nz) < r;
  }

  /** Stage the room's real furniture through the kit machine (the same
   *  entry space.tsx uses), with the anchor's obstacle disc in the
   *  obstacles — exactly what production passes (space.tsx's
   *  terminalObstacle) — so the scan asserts the guarantee from the
   *  pieces the machine actually staged. */
  function stagedFor(
    sliceId: string,
    count: number,
    anchor: ReturnType<typeof roomTerminalFor>,
    propScale: number,
  ): StagedKitPiece[] {
    const recipe = compileSpaceRecipe(sliceId);
    const { recipe: scaledRecipe, scale } = scaledRecipeFor(recipe, count);
    const scaleFactor = scale.factor;
    const wallThick = ROOM_WALL_THICKNESS * Math.max(scaleFactor, 0.35);
    const template = roomTemplateForDoorCount(
      recipe,
      scaledRecipe.width,
      scaledRecipe.size.extent,
      scaleFactor,
      wallThick,
      count,
    );
    const plan = roomPlanFor(
      recipe.sliceId,
      scaledRecipe.width,
      scaledRecipe.size.extent,
      COLONNADE_BAY * Math.sqrt(Math.max(scaleFactor, 0.35)),
      undefined,
      template ? templatePlanFor(template) : undefined,
    );
    const comp = composeRoom(recipe.sliceId, plan, scaleFactor);
    const water = waterRectFor(scaledRecipe);
    const fp = terminalFootprint(anchor);
    const terminalObstacle = {
      x: anchor.x,
      z: anchor.z,
      r: Math.hypot((fp.x1 - fp.x0) / 2, (fp.z1 - fp.z0) / 2) + 0.1,
    };
    const baseArea = planArea(plan) / (scaleFactor * scaleFactor);
    const waterArea = water
      ? (water.halfX * 2 * water.halfZ * 2) / (scaleFactor * scaleFactor)
      : 0;
    const rng = createRng(
      deriveSubSeed(WORLD_SEED, recipe.sliceId, "furniture"),
    );
    return stageInteriorKits({
      rng,
      worldClass: recipe.worldClass,
      archetype: recipe.archetype,
      plan,
      comp,
      baseExtent: recipe.size.extent,
      baseArea: Math.max(0, baseArea - waterArea),
      propScale,
      wallThick,
      water,
      obstacles: [terminalObstacle],
      heightAt: () => 0,
    });
  }

  it("places the terminal clear of the door, the path, and the furniture, in every module", () => {
    const units = debugUnitsFor("modules");
    expect(units.length).toBeGreaterThanOrEqual(12);
    let fallbacks = 0;
    for (const unit of units) {
      for (const count of [0, 2, 4]) {
        const { input, anchor } = anchorFor(unit.sliceId, count);
        const w = (TERMINAL_W * anchor.scale) / 2;
        const label = `${unit.sliceId}@${count}`;

        // Inside the plan.
        expect(
          terminalInsidePlan(
            input.plan,
            input.width,
            input.plan.extent,
            input.wallThick,
            terminalFootprint(anchor),
          ),
          label,
        ).toBe(true);

        // Not in the doorway strip, not on the walk path, not in the water.
        expect(
          Math.hypot(anchor.x, anchor.z) - w,
          label,
        ).toBeGreaterThanOrEqual(ENTRANCE_CLEAR_RADIUS - 1e-6);
        expect(
          distToPath(input.comp, anchor.x, anchor.z),
          label,
        ).toBeGreaterThanOrEqual(input.comp.pathHalf + w - 1e-6);
        if (input.water) {
          const dx = Math.max(
            0,
            Math.abs(anchor.x - input.water.cx) - input.water.halfX,
          );
          const dz = Math.max(
            0,
            Math.abs(anchor.z - input.water.cz) - input.water.halfZ,
          );
          expect(Math.hypot(dx, dz), label).toBeGreaterThanOrEqual(w - 1e-6);
        }

        // The open field — or the counted, still-inside fallback.
        if (isFallback(input, anchor)) {
          fallbacks += 1;
          expect(Math.abs(anchor.x), label).toBeGreaterThan(
            ENTRANCE_CLEAR_RADIUS - 1e-6,
          );
        } else {
          expect(anchor.z, label).toBeGreaterThanOrEqual(
            input.plan.extent * 0.3 - 1e-6,
          );
        }

        // The furniture: no staged piece's BODY may intersect the
        // terminal's footprint. Piece-level, not placement-disc: a wall
        // kit's footprint is its keep-away radius (lateral span included),
        // while its bodies are thin panels AT the wall — the disc would
        // flag museum-row standoffs as overlaps. Hung pieces (dy lifts
        // them above a floor machine's head) cannot collide at all. Floor
        // pieces model as body discs of half-meter at piece scale — the
        // renderer's furniture is human-scale by construction.
        const pieces = stagedFor(unit.sliceId, count, anchor, input.propScale);
        const fp = terminalFootprint(anchor);
        for (const piece of pieces) {
          if (piece.dy * input.propScale >= 1.0) continue;
          const r = 0.5 * piece.scale;
          expect(
            overlapsPiece(fp, piece.x, piece.z, r),
            `${label} overlaps ${piece.kitId}#${piece.kitIndex} (${piece.kind})`,
          ).toBe(false);
        }
      }
    }
    // Every gallery module resolves the open field (a non-zero count is a
    // real regression to investigate, not a number to raise blindly).
    expect(fallbacks).toBe(0);
  });
});

describe("lobby terminal constants", () => {
  it("the blocker wraps the machine and leaves the arrival door approach", () => {
    const t = LOBBY_TERMINAL_ANCHOR;
    const halfD = (TERMINAL_D * t.scale) / 2;
    const halfW = (TERMINAL_W * t.scale) / 2;
    // Blocker contains the whole footprint.
    expect(LOBBY_TERMINAL_BLOCKER.x0).toBeLessThanOrEqual(t.x - halfD);
    expect(LOBBY_TERMINAL_BLOCKER.x1).toBeGreaterThan(t.x + halfD);
    expect(LOBBY_TERMINAL_BLOCKER.z0).toBeLessThan(t.z - halfW);
    expect(LOBBY_TERMINAL_BLOCKER.z1).toBeGreaterThan(t.z + halfW);
    // The east arrival door's gap sits at |z| < 0.6 on the wall — the
    // machine stands well clear of its approach.
    expect(LOBBY_TERMINAL_BLOCKER.z1).toBeLessThan(-1);
    // Reach radius is a positive, human-scale distance.
    expect(TERMINAL_REACH_LOBBY).toBeGreaterThan(0.5);
    expect(TERMINAL_REACH_LOBBY).toBeLessThan(5);
  });
});
