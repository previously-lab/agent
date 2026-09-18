/**
 * Tests for the water surface material's pure contract
 * (src/lib/game/materials/water-surface.ts): the Beer–Lambert absorption
 * the DEPTH_ABSORPTION chunk must implement, and the basin contract that
 * keeps the shader's analytic floor in sync with terrain.ts's heightfield
 * (the two must agree EXACTLY or the water's depth tint and the displaced
 * floor diverge). terrain.ts exports POOL_DEPTH/GROUND_Y and owns
 * waterRectFor, so the sync is structural — these tests lock the numbers
 * the shader rebuilds with.
 */
import { describe, it, expect } from "vitest";
import {
  WATER_ABSORPTION_SIGMA,
  createWaterSurfaceMaterial,
  waterTransmittance,
} from "@/lib/game/materials/water-surface";
import { WATER_Y } from "@/lib/game/tuning/room";
import { createWaveDriver } from "@/lib/game/materials/wave-driver";
import {
  GROUND_Y,
  POOL_DEPTH,
  terrainHeight,
  waterRectFor,
} from "@/lib/game/terrain";
import {
  PALETTES,
  SIZE_TIERS,
  type SpaceRecipe,
} from "@/lib/game/space-types";

function poolRecipe(): SpaceRecipe {
  const tier = SIZE_TIERS.find((t) => t.extent === 32);
  if (!tier) throw new Error("no 32m size tier");
  return {
    sliceId: "water-surface-test",
    worldClass: "nature",
    archetype: "pool",
    size: tier,
    width: 32,
    palette: PALETTES[0],
    layoutSeed: 99,
    lightSeed: 0,
  };
}

describe("waterTransmittance (Beer–Lambert)", () => {
  it("is fully clear at zero depth", () => {
    const t = waterTransmittance(0);
    expect(t.r).toBeCloseTo(1, 10);
    expect(t.g).toBeCloseTo(1, 10);
    expect(t.b).toBeCloseTo(1, 10);
    expect(t.alpha).toBeCloseTo(0, 10);
  });

  it("absorbs red fastest, blue slowest (the blue-green read)", () => {
    for (const d of [0.3, 0.5, 1, 1.6, 1.93]) {
      const t = waterTransmittance(d);
      expect(t.r).toBeLessThan(t.g);
      expect(t.g).toBeLessThan(t.b);
    }
    // The sigma ordering is the physical one for clear water.
    expect(WATER_ABSORPTION_SIGMA.x).toBeGreaterThan(WATER_ABSORPTION_SIGMA.y);
    expect(WATER_ABSORPTION_SIGMA.y).toBeGreaterThan(WATER_ABSORPTION_SIGMA.z);
  });

  it("decays monotonically and keeps the pool floor visible at max depth", () => {
    let prev = 1;
    for (const d of [0.33, 0.5, 1, 1.5, 1.93]) {
      const t = waterTransmittance(d);
      expect(t.alpha).toBeGreaterThan(prev - 1);
      expect(t.alpha).toBeGreaterThan(0);
      expect(t.alpha).toBeLessThan(1); // tile ALWAYS reads through
      prev = t.alpha;
    }
    // The documented tuning anchors: ankle-clear doorway ramp, light-blue
    // flat bottom that still lets the tile read through.
    expect(waterTransmittance(0.33).alpha).toBeLessThan(0.25);
    expect(waterTransmittance(1.93).alpha).toBeGreaterThan(0.5);
    expect(waterTransmittance(1.93).alpha).toBeLessThan(0.75);
  });

  it("is monotonic in depth", () => {
    let prev = -1;
    for (let d = 0; d <= 2; d += 0.1) {
      const a = waterTransmittance(d).alpha;
      expect(a).toBeGreaterThanOrEqual(prev);
      prev = a;
    }
  });
});

describe("basin contract vs terrain.ts (single source of truth)", () => {
  it("reconstructs the exact flat-bottom floor height inside the rect", () => {
    const recipe = poolRecipe();
    const rect = waterRectFor(recipe);
    if (!rect) throw new Error("pool archetype must have a water rect");
    // At the 32m tier the rect sits far outside the doorway funnel
    // (cz ≥ 5 ⇒ entranceMask = 1), so terrain hits the full POOL_DEPTH
    // across the whole interior — center, edge midpoints, AND corners
    // (the straight-walled basin has no shallow corners anymore).
    expect(rect.cz).toBeGreaterThanOrEqual(5);
    const bottom = GROUND_Y - POOL_DEPTH;
    for (const [x, z] of [
      [rect.cx, rect.cz],
      [rect.cx + rect.halfX * 0.98, rect.cz],
      [rect.cx, rect.cz + rect.halfZ * 0.98],
      [rect.cx + rect.halfX * 0.98, rect.cz + rect.halfZ * 0.98],
    ]) {
      expect(terrainHeight(recipe, x, z)).toBeCloseTo(bottom, 10);
    }
  });

  it("has straight walls: deck level just outside, full depth just inside", () => {
    const recipe = poolRecipe();
    const rect = waterRectFor(recipe);
    if (!rect) throw new Error("pool archetype must have a water rect");
    const outX = rect.cx + rect.halfX + 0.01;
    const inX = rect.cx + rect.halfX - 0.01;
    // Far enough from the door axis that the entrance funnel cannot
    // soften the wall (|x| ≫ DOOR_GAP_HALF + 1).
    expect(Math.abs(inX)).toBeGreaterThan(3);
    expect(terrainHeight(recipe, outX, rect.cz)).toBeCloseTo(GROUND_Y, 10);
    expect(terrainHeight(recipe, inX, rect.cz)).toBeCloseTo(
      GROUND_Y - POOL_DEPTH,
      10,
    );
  });

  it("puts the flat bottom in the 0.5–2m band the absorption is tuned for", () => {
    const depth = WATER_Y - (GROUND_Y - POOL_DEPTH);
    expect(depth).toBeGreaterThan(1.5);
    expect(depth).toBeLessThanOrEqual(2);
  });
});

describe("createWaterSurfaceMaterial", () => {
  it("builds a transparent standard material with the depth/wave patch wired", () => {
    const water = createWaterSurfaceMaterial({
      color: "#2e6f6a",
      shallowColor: "#e8f2ee",
      spanX: 8,
      spanY: 12,
    });
    expect(water.material.transparent).toBe(true);
    expect(water.material.normalMap).not.toBeNull();
    expect(typeof water.update).toBe("function");
    expect(water.material.customProgramCacheKey?.()).toBe(
      "previously-water-v3",
    );
    water.update(1.5); // a stable no-op without a GL context
    water.dispose();
  });

  it("accepts a live wave texture without owning it", () => {
    const driver = createWaveDriver({ cx: 0, cz: 10, halfX: 4, halfZ: 6 });
    const water = createWaterSurfaceMaterial({
      color: "#2e6f6a",
      shallowColor: "#e8f2ee",
      spanX: 8,
      spanY: 12,
      centerZ: 10,
      waveTexture: driver.texture,
      waveTexelMeters: driver.texelMeters,
    });
    water.dispose();
    // The driver texture survives the material's dispose (it is the
    // driver's property); disposing the driver is the caller's job.
    driver.dispose();
  });
});
