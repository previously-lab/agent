/**
 * Tests for the terrain module (src/lib/game/terrain.ts) — the shared
 * heightfield contract the renderer's ground displacement AND the avatar's
 * Y-snapping physics both consume. These lock down: determinism, a walkable
 * entrance strip for every archetype × size tier, flat/sunken/rolling shape
 * guarantees, amplitude bounds, rect water-deck rules, and finiteness.
 */
import { describe, it, expect } from "vitest";
import {
  terrainHeight,
  waterRectFor,
  waterSideFor,
  GROUND_Y,
  POOL_DEPTH,
} from "@/lib/game/terrain";
import {
  ARCHETYPE_IDS,
  PALETTES,
  SIZE_TIERS,
  type ArchetypeId,
  type SpaceRecipe,
} from "@/lib/game/space-types";

const ARCH_IDS: readonly ArchetypeId[] = ARCHETYPE_IDS;

/** Documented rolling amplitude (terrain.ts ROLLING_AMPLITUDE). */
const ROLLING_AMPLITUDE = 1.2;

function makeRecipe(
  archetype: ArchetypeId,
  extent: number,
  width?: number,
): SpaceRecipe {
  const tier = SIZE_TIERS.find((t) => t.extent === extent);
  if (!tier) throw new Error(`no size tier for extent ${extent}`);
  return {
    sliceId: "terrain-test",
    worldClass: "nature",
    archetype,
    size: tier,
    width: width ?? extent,
    palette: PALETTES[0],
    layoutSeed: 1234567,
    lightSeed: 0,
  };
}

describe("terrainHeight", () => {
  it("is deterministic across separate calls and identical recipes", () => {
    const a = makeRecipe("forest", 32);
    const b = makeRecipe("forest", 32);
    for (const [x, z] of [
      [0, 0],
      [3.5, 8.25],
      [-11.75, 30.5],
      [100.5, -40.25],
    ]) {
      expect(terrainHeight(a, x, z)).toBe(terrainHeight(a, x, z));
      expect(terrainHeight(a, x, z)).toBe(terrainHeight(b, x, z));
    }
  });

  it("flattens the entrance strip to GROUND_Y for every archetype × tier", () => {
    for (const archetype of ARCH_IDS) {
      for (const tier of SIZE_TIERS) {
        const recipe = makeRecipe(archetype, tier.extent);
        expect(terrainHeight(recipe, 0, 0)).toBeCloseTo(GROUND_Y, 10);
        expect(terrainHeight(recipe, 0.5, 1)).toBeCloseTo(GROUND_Y, 10);
      }
    }
  });

  it("returns GROUND_Y everywhere for flat archetypes", () => {
    const FLAT: readonly ArchetypeId[] = [
      "meadow",
      "snowfield",
      "hotel-room",
      "library",
      "cats",
      "balloons",
    ];
    for (const archetype of FLAT) {
      for (const tier of SIZE_TIERS) {
        const recipe = makeRecipe(archetype, tier.extent);
        for (let x = -tier.extent; x <= tier.extent; x += 2) {
          for (let z = -tier.extent; z <= tier.extent; z += 2) {
            expect(terrainHeight(recipe, x, z)).toBe(GROUND_Y);
          }
        }
      }
    }
  });

  it("sinks the pool basin below its rim", () => {
    for (const tier of SIZE_TIERS) {
      const recipe = makeRecipe("pool", tier.extent);
      const rect = waterRectFor(recipe);
      expect(rect).not.toBeNull();
      if (!rect) continue;
      const center = terrainHeight(recipe, rect.cx, rect.cz);
      const corner = terrainHeight(recipe, recipe.width / 2, 0);
      expect(center).toBeLessThan(GROUND_Y - 1.5);
      expect(corner).toBeCloseTo(GROUND_Y, 6);
    }
  });

  it("builds a straight-walled, flat-bottomed basin (no curved slope)", () => {
    for (const tier of SIZE_TIERS) {
      const recipe = makeRecipe("pool", tier.extent);
      const rect = waterRectFor(recipe);
      expect(rect).not.toBeNull();
      if (!rect) continue;
      const bottom = GROUND_Y - POOL_DEPTH;
      // Flat bottom: every interior sample clear of the doorway funnel
      // sits at exactly the same depth (center, edges, corners alike).
      for (const [x, z] of [
        [rect.cx, rect.cz],
        [rect.cx + rect.halfX * 0.98, rect.cz],
        [rect.cx - rect.halfX * 0.98, rect.cz],
        [rect.cx, rect.cz + rect.halfZ * 0.98],
        [rect.cx + rect.halfX * 0.98, rect.cz + rect.halfZ * 0.98],
      ]) {
        expect(terrainHeight(recipe, x, z)).toBeCloseTo(bottom, 10);
      }
      // Straight walls: a 2cm step across the waterline crosses the full
      // depth — there is no feathered rim anywhere on the rectangle.
      const outX = rect.cx + rect.halfX + 0.01;
      const inX = rect.cx + rect.halfX - 0.01;
      expect(terrainHeight(recipe, outX, rect.cz)).toBeCloseTo(GROUND_Y, 10);
      expect(terrainHeight(recipe, inX, rect.cz)).toBeCloseTo(bottom, 10);
      const outZ = rect.cz + rect.halfZ + 0.01;
      const inZ = rect.cz + rect.halfZ - 0.01;
      expect(terrainHeight(recipe, rect.cx, outZ)).toBeCloseTo(GROUND_Y, 10);
      expect(terrainHeight(recipe, rect.cx, inZ)).toBeCloseTo(bottom, 10);
    }
  });

  it("stays within ±ROLLING_AMPLITUDE of GROUND_Y for rolling archetypes", () => {
    for (const archetype of ["plains", "forest"] as const) {
      for (const tier of SIZE_TIERS) {
        const recipe = makeRecipe(archetype, tier.extent);
        for (let x = -tier.extent; x <= tier.extent; x += 2) {
          for (let z = -tier.extent; z <= tier.extent; z += 2) {
            const delta = Math.abs(terrainHeight(recipe, x, z) - GROUND_Y);
            expect(delta).toBeLessThanOrEqual(ROLLING_AMPLITUDE + 1e-9);
          }
        }
      }
    }
  });

  it("is finite at the plan center for every archetype × tier", () => {
    for (const archetype of ARCH_IDS) {
      for (const tier of SIZE_TIERS) {
        const recipe = makeRecipe(archetype, tier.extent);
        expect(
          Number.isFinite(terrainHeight(recipe, 0, tier.extent / 2)),
        ).toBe(true);
      }
    }
  });
});

describe("waterRectFor", () => {
  it("leaves a walkable deck on every side (≥3m, S ≥2m)", () => {
    for (const tier of SIZE_TIERS) {
      const recipe = makeRecipe("pool", tier.extent);
      const rect = waterRectFor(recipe);
      expect(rect).not.toBeNull();
      if (!rect) continue;
      const minDeck = tier.extent >= 32 ? 3 : 2;
      // z axis
      expect(rect.cz - rect.halfZ).toBeGreaterThanOrEqual(minDeck - 1e-6);
      expect(tier.extent - rect.cz - rect.halfZ).toBeGreaterThanOrEqual(
        minDeck - 1e-6,
      );
      // x axis (plan width)
      expect(rect.halfX).toBeLessThanOrEqual(recipe.width / 2 - minDeck + 1e-6);
    }
  });

  it("respects a narrow rectangular plan on the x axis", () => {
    const recipe = makeRecipe("pool", 32, 21); // 0.66 width factor
    const rect = waterRectFor(recipe);
    expect(rect).not.toBeNull();
    if (!rect) return;
    expect(rect.halfX).toBeLessThanOrEqual(21 / 2 - 3 + 1e-6);
  });

  it("caps at the coverage area fraction on large tiers", () => {
    // XL is coverage-limited; L is deck-limited.
    const xl = waterRectFor(makeRecipe("pool", 96));
    expect(xl?.halfZ).toBeCloseTo((96 * Math.sqrt(0.85)) / 2, 4);
    const l = waterRectFor(makeRecipe("pool", 64));
    expect(l?.halfZ).toBeCloseTo((64 - 6) / 2, 6);
  });

  it("offsets beach water toward the far wall", () => {
    const rect = waterRectFor(makeRecipe("beach", 32));
    expect(rect).not.toBeNull();
    if (!rect) return;
    expect(rect.cz).toBeGreaterThan(16); // beyond plan center
  });

  it("is null for dry archetypes", () => {
    expect(waterRectFor(makeRecipe("meadow", 16))).toBeNull();
    expect(waterRectFor(makeRecipe("hotel-room", 32))).toBeNull();
    expect(waterRectFor(makeRecipe("cats", 16))).toBeNull();
  });
});

describe("waterSideFor (legacy compat)", () => {
  it("returns the water rectangle's z-side length (0 when dry)", () => {
    for (const tier of SIZE_TIERS) {
      const recipe = makeRecipe("pool", tier.extent);
      const rect = waterRectFor(recipe);
      expect(waterSideFor(recipe)).toBeCloseTo(rect ? rect.halfZ * 2 : 0, 6);
    }
    expect(waterSideFor(makeRecipe("meadow", 16))).toBe(0);
  });
});
