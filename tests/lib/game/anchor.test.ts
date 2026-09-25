/**
 * Tests for the anchor terminal module (v0.11 §13.1/§14.4 step ④). The
 * contract under test: the room terminal's spot is a deterministic pure
 * function of (sliceId, plan, comp, width, wallThick, propScale, water)
 * (A6 — space.tsx and game-canvas.tsx resolve the SAME anchor through the
 * same call); it always stays inside the plan; it never blocks the doorway
 * strip, the walk path, or the water; it stands in the room's OPEN FIELD
 * (mid-depth — a floor lamp, not a wall fixture) unless the room is too
 * small to clear the path anywhere, in which case it degrades to the
 * entrance-wall spot; and it never overlaps the staged furniture. Its
 * hero clearance is HERO_CLEAR × propScale CLAMPED to what the room's
 * geometry can actually offer (heroClearCeilingFor): the raw 3m in every
 * room big enough to host it (the standard fixtures below assert the raw
 * value — the clamp is a no-op there), and the feasibility ceiling,
 * enforced as a hard gate, in the 6×6 single-module rooms (bath /
 * storage) where the raw 3m is unreachable. The lobby terminal's
 * constants are consistent with its blocker.
 */
import { describe, it, expect } from "vitest";
import {
  LOBBY_TERMINAL_ANCHOR,
  LOBBY_TERMINAL_BLOCKER,
  heroClearCeilingFor,
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

/** Every fixture slice exercised below — a spread of ids across
 *  archetypes and tiers. 世界分类收口（2026-09）：非标准间从注册表
 *  下架、世界只留室内 — the old cross-class spread is gone, so the
 *  list spreads the interior draw instead. These are all rooms big
 *  enough to host the raw HERO_CLEAR, so the clearance assertions
 *  below read the UNCLAMPED value — the clamp's no-op regression
 *  guarantee. The 6×6 single-module rooms (bath / storage), where the
 *  raw clearance is geometrically unreachable and the clamp binds, have
 *  their own describe block further down. */
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

/** True when the anchor came from the entrance-wall fallback (the
 *  degenerate rooms too small to clear the path in the open field). */
function isFallback(
  input: RoomTerminalInput,
  anchor: ReturnType<typeof roomTerminalFor>,
): boolean {
  return anchor.z < input.plan.extent * 0.3 - 1e-6;
}

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

/** Assert the one furniture guarantee both scans share: no staged
 *  piece's BODY may intersect the terminal's footprint. Piece-level, not
 *  placement-disc: a wall kit's footprint is its keep-away radius
 *  (lateral span included), while its bodies are thin panels AT the
 *  wall — the disc would flag museum-row standoffs as overlaps. Hung
 *  pieces (dy lifts them above a floor machine's head) cannot collide at
 *  all. Floor pieces model as body discs of half-meter at piece scale —
 *  the renderer's furniture is human-scale by construction. */
function expectNoFurnitureOverlap(
  label: string,
  sliceId: string,
  count: number,
  anchor: ReturnType<typeof roomTerminalFor>,
  propScale: number,
): void {
  const pieces = stagedFor(sliceId, count, anchor, propScale);
  const fp = terminalFootprint(anchor);
  for (const piece of pieces) {
    if (piece.dy * propScale >= 1.0) continue;
    const r = 0.5 * piece.scale;
    expect(
      overlapsPiece(fp, piece.x, piece.z, r),
      `${label} overlaps ${piece.kitId}#${piece.kitIndex} (${piece.kind})`,
    ).toBe(false);
  }
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

describe("the 11-module scan (gallery units × strand-door counts)", () => {
  it("places the terminal clear of the door, the path, and the furniture, in every module", () => {
    const units = debugUnitsFor("modules");
    // 世界分类收口（2026-09）：gallery-module 与 pool-deck 两个大厅
    // 下架（数据休眠在 modules/public.ts），注册表 13 → 11。
    expect(units.length).toBeGreaterThanOrEqual(11);
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
        // terminal's footprint (the shared piece-level rule — see
        // expectNoFurnitureOverlap).
        expectNoFurnitureOverlap(label, unit.sliceId, count, anchor, input.propScale);
      }
    }
    // Every gallery module resolves the open field (a non-zero count is a
    // real regression to investigate, not a number to raise blindly).
    expect(fallbacks).toBe(0);
  });
});

/**
 * The resolver's own worst-of soft score, re-derived on a fine grid over
 * the open-field band (the scan's 30–70% depth, the same hard gates, the
 * same four boundaries with the CLAMPED hero clearance, and the same hero
 * gate when the clamp binds). Returns the hero distance of the grid's
 * best-scoring legal spot — what "as far from the hero as the room
 * allows" means under the resolver's own objective. (The absolute
 * farthest legal spot is NOT the target: those spots hug the walls,
 * which is exactly what the worst-of score trades against.)
 */
function openFieldArgmaxHeroDist(
  input: RoomTerminalInput,
  anchor: ReturnType<typeof roomTerminalFor>,
): number {
  const { plan, comp, width, wallThick, propScale, water } = input;
  const hw = (TERMINAL_W * anchor.scale) / 2;
  const hd = (TERMINAL_D * anchor.scale) / 2;
  const halfRoom = width / 2 - wallThick / 2;
  const band = 1.2 * Math.max(propScale, 0.35);
  const rawClear = HERO_CLEAR * propScale;
  const effective = Math.min(
    rawClear,
    heroClearCeilingFor(plan, width, wallThick, propScale, comp.hero, hw),
  );
  const gated = effective < rawClear;
  const legal = (x: number, z: number): boolean => {
    if (
      !terminalInsidePlan(plan, width, plan.extent, wallThick, {
        x0: x - hw,
        x1: x + hw,
        z0: z - hd,
        z1: z + hd,
      })
    )
      return false;
    if (Math.hypot(x, z) < ENTRANCE_CLEAR_RADIUS + hw + 0.1) return false;
    if (distToPath(comp, x, z) < comp.pathHalf + hw + 0.12) return false;
    if (water) {
      const dx = Math.max(0, Math.abs(x - water.cx) - water.halfX);
      const dz = Math.max(0, Math.abs(z - water.cz) - water.halfZ);
      if (Math.hypot(dx, dz) < hw + 0.1) return false;
    }
    return true;
  };
  const score = (x: number, z: number): number => {
    const heroBoundary = Math.hypot(x - comp.hero.x, z - comp.hero.z) - effective - hw;
    const clusterBoundary = comp.clusters.reduce(
      (min, c) => Math.min(min, Math.hypot(x - c.x, z - c.z) - c.radius - hw),
      Number.POSITIVE_INFINITY,
    );
    return Math.min(
      heroBoundary,
      clusterBoundary,
      halfRoom - Math.abs(x) - hw - band,
      plan.extent - z - hd - band,
    );
  };
  let bestScore = Number.NEGATIVE_INFINITY;
  let bestHeroDist = 0;
  for (let x = -width / 2; x <= width / 2; x += 0.05) {
    for (let z = plan.extent * 0.3; z <= plan.extent * 0.7; z += 0.05) {
      if (!legal(x, z)) continue;
      const heroDist = Math.hypot(x - comp.hero.x, z - comp.hero.z);
      if (gated && heroDist - effective - hw < 0) continue;
      const s = score(x, z);
      if (s > bestScore) {
        bestScore = s;
        bestHeroDist = heroDist;
      }
    }
  }
  return bestHeroDist;
}

describe("the 6×6 single-module rooms (bath / storage)", () => {
  /** The registry's only 1×1-module draws (modules/service.ts: bath —
   *  pool-hall's changing room — and storage, both 6×6 on the module
   *  grid), forced one-module through the debug slice ids
   *  (compositionForRecipe: a dbg-m: slice composes THAT module and
   *  nothing else) and resolved through the same anchorFor chain as
   *  every other fixture. Count 0 only: any strand door grows the
   *  composition past the 6×6 footprint these tests exist for. */
  const SMALL_ROOMS = ["dbg-m:bath", "dbg-m:storage"] as const;

  it("the fixtures really are the 6×6 single-module rooms", () => {
    for (const sliceId of SMALL_ROOMS) {
      const { input } = anchorFor(sliceId, 0);
      expect(input.width, sliceId).toBe(6);
      expect(input.plan.extent, sliceId).toBe(6);
      expect(input.plan.id, sliceId).toBe("rect");
    }
  });

  it("every hard gate still holds", () => {
    for (const sliceId of SMALL_ROOMS) {
      const { input, anchor } = anchorFor(sliceId, 0);
      const w = (TERMINAL_W * anchor.scale) / 2;
      const label = `${sliceId}@0`;
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
      // Not in the doorway strip, not on the walk path, not in the water
      // (the bath's plunge pool waters the 6×6 floor — the dry-rim
      // assertion is the one that used to be impossible to run here).
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
      // The open field, not the degenerate entrance-wall fallback.
      expect(isFallback(input, anchor), label).toBe(false);
      // The same piece-level furniture guarantee the 11-module scan
      // asserts.
      expectNoFurnitureOverlap(label, sliceId, 0, anchor, input.propScale);
    }
  });

  it("meets the clamped hero clearance — the room's actual offer, not the raw 3m", () => {
    for (const sliceId of SMALL_ROOMS) {
      const { input, anchor } = anchorFor(sliceId, 0);
      const w = (TERMINAL_W * anchor.scale) / 2;
      const label = `${sliceId}@0`;
      const heroDist = Math.hypot(
        anchor.x - input.comp.hero.x,
        anchor.z - input.comp.hero.z,
      );
      const rawClear = HERO_CLEAR * input.propScale;
      const ceiling = heroClearCeilingFor(
        input.plan,
        input.width,
        input.wallThick,
        input.propScale,
        input.comp.hero,
        w,
      );
      // The clamp genuinely binds — this fixture's whole reason to exist
      // (if a future tuning change makes 3m reachable in a 6×6 room, this
      // is the line that should be revisited, not deleted).
      expect(ceiling, label).toBeLessThan(rawClear);
      // The new contract: the machine stands at least as far from the
      // hero as the room's geometry can offer (the ceiling), and the
      // resolver's hard gate — not the test's tolerance — is what keeps
      // it so.
      const effective = Math.min(rawClear, ceiling);
      expect(heroDist, label).toBeGreaterThanOrEqual(effective - 1e-6);
      // ...and it is genuinely as far from the hero as the room allows
      // under the resolver's own objective: within a draw's granularity
      // of the best-scoring legal spot on a fine grid (measured ≤0.18m;
      // 0.3 leaves room for the seeded scan's coarser sampling without
      // ever letting the machine park next to the hero while a better
      // field spot exists).
      const argmaxHeroDist = openFieldArgmaxHeroDist(input, anchor);
      expect(heroDist, label).toBeGreaterThanOrEqual(argmaxHeroDist - 0.3);
    }
  });

  it("the clamp is a no-op in rooms that can host the raw clearance", () => {
    // The regression guarantee for every standard/large room: when the
    // ceiling meets or beats HERO_CLEAR × propScale the resolver's scores
    // and anchors are byte-for-byte the pre-clamp ones.
    for (const sliceId of FIXTURE_SLICES) {
      for (const count of [0, 1, 4]) {
        const { input, anchor } = anchorFor(sliceId, count);
        const w = (TERMINAL_W * anchor.scale) / 2;
        const ceiling = heroClearCeilingFor(
          input.plan,
          input.width,
          input.wallThick,
          input.propScale,
          input.comp.hero,
          w,
        );
        expect(
          ceiling,
          `${sliceId}@${count}`,
        ).toBeGreaterThanOrEqual(HERO_CLEAR * input.propScale);
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
