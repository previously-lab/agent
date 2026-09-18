/**
 * Tests for the anchor terminal module (v0.11 §13.1/§14.4 step ④). The
 * contract under test: the room terminal's spot is a deterministic pure
 * function of (sliceId, plan, comp, width, wallThick, propScale, water)
 * (A6 — space.tsx and game-canvas.tsx resolve the SAME anchor through the
 * same call); it always clears the doorway strip, the walk path, the
 * hero clearing, and the water; it always stays inside the plan; the
 * lobby terminal's constants are consistent with its blocker; and the
 * catalog-jump plan picks the soft router push exactly when the shell's
 * rung is a live card rung (the `z` param mirrors rung state).
 */
import { describe, it, expect } from "vitest";
import {
  anchorNavPlan,
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
        // The entrance strip is UNSCALED (candidateOk's rule — the door
        // never scales, A4); the machine may only overlap it when the
        // plan itself is narrower than the strip (degenerate dollhouse).
        const halfRoom = input.width / 2 - input.wallThick / 2;
        if (halfRoom > ENTRANCE_CLEAR_RADIUS + 0.26 + w) {
          expect(Math.abs(anchor.x) - w).toBeGreaterThanOrEqual(
            ENTRANCE_CLEAR_RADIUS - 1e-6,
          );
        }
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

  it("hugs the entrance wall (prominent on entry, never a corner prop)", () => {
    for (const sliceId of FIXTURE_SLICES) {
      const { input, anchor } = anchorFor(sliceId, 0);
      const zMax = input.wallThick / 2 + (TERMINAL_D * anchor.scale) / 2 + 0.3;
      expect(anchor.z).toBeLessThanOrEqual(zMax);
      // Beside the doorway — except in degenerate dollhouse rooms where
      // the unscaled doorway strip alone outspans the half-width (the
      // same exemption the strip test uses).
      const w = (TERMINAL_W * anchor.scale) / 2;
      const halfRoom = input.width / 2 - input.wallThick / 2;
      if (halfRoom > ENTRANCE_CLEAR_RADIUS + 0.26 + w) {
        expect(Math.abs(anchor.x)).toBeGreaterThan(ENTRANCE_CLEAR_RADIUS);
      }
    }
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

describe("anchorNavPlan", () => {
  it("soft-pushes when a card rung is live in the URL", () => {
    for (const search of ["?z=slice", "?z=day&view=game", "?z=day&x=1"]) {
      const nav = anchorNavPlan(search, "en", "2026-09-15-1401");
      expect(nav).toEqual({ mode: "push", href: "?at=2026-09-15-1401" });
    }
  });

  it("treats an unknown rung like the conversation default (hard path)", () => {
    const nav = anchorNavPlan("?z=bogus", "en", "2026-09-15-1401");
    expect(nav.mode).toBe("assign");
  });

  it("hard-navigates with the slice rung when the rung is the conversation default", () => {
    for (const search of ["", "?view=game", "?slice=2026-09-15-1401", "?z=conversation"]) {
      const nav = anchorNavPlan(search, "zh", "2026-09-15-1401");
      expect(nav).toEqual({
        mode: "assign",
        href: "/zh?z=slice&at=2026-09-15-1401",
      });
    }
  });

  it("encodes exotic slice ids", () => {
    const nav = anchorNavPlan("?view=game", "en", "slice with spaces/ä");
    expect(nav.mode).toBe("assign");
    expect(nav.href).toBe(`/en?z=slice&at=${encodeURIComponent("slice with spaces/ä")}`);
  });
});
