/**
 * Tests for the water surface material's pure contract
 * (src/lib/game/materials/water-surface.ts): the Beer–Lambert absorption
 * the DEPTH_ABSORPTION chunk must implement, and the mirror-constant
 * guard that keeps the shader's analytic pool bowl in sync with
 * terrain.ts's heightfield (the two must agree EXACTLY or the water's
 * depth tint and the displaced floor diverge).
 */
import { describe, it, expect } from "vitest";
import {
  WATER_ABSORPTION_SIGMA,
  WATER_BOWL_DEPTH,
  WATER_BOWL_FEATHER,
  WATER_GROUND_Y,
  createWaterSurfaceMaterial,
  waterTransmittance,
} from "@/lib/game/materials/water-surface";
import { WATER_Y } from "@/lib/game/tuning/room";
import { createWaveDriver } from "@/lib/game/materials/wave-driver";
import { terrainHeight, waterRectFor } from "@/lib/game/terrain";
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
    // The documented tuning anchors: ankle-clear rim, deep turquoise bowl.
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

describe("pool-bowl mirror constants vs terrain.ts", () => {
  it("reconstructs the exact floor height at the bowl center", () => {
    const recipe = poolRecipe();
    const rect = waterRectFor(recipe);
    if (!rect) throw new Error("pool archetype must have a water rect");
    // At the 32m tier the bowl center sits far outside the doorway funnel
    // (cz ≥ 5 ⇒ entranceMask = 1), so terrain hits the full bowl depth.
    const floor = terrainHeight(recipe, rect.cx, rect.cz);
    expect(rect.cz).toBeGreaterThanOrEqual(5);
    expect(floor).toBeCloseTo(WATER_GROUND_Y - WATER_BOWL_DEPTH, 10);
  });

  it("puts the deep end in the 0.5–2m band the absorption is tuned for", () => {
    const depth = WATER_Y - (WATER_GROUND_Y - WATER_BOWL_DEPTH);
    expect(depth).toBeGreaterThan(1.5);
    expect(depth).toBeLessThanOrEqual(2);
  });

  it("keeps the rect CORNERS ankle-shallow (the bowl feathers outside rho = 1)", () => {
    const recipe = poolRecipe();
    const rect = waterRectFor(recipe);
    if (!rect) throw new Error("pool archetype must have a water rect");
    // terrain.ts's bowl is full-depth across the whole inscribed ellipse
    // (rho ≤ 1) and feathers back to deck level over rho ∈ (1, 1.3) — so
    // inside the water RECTANGLE the shallow water lives at the corners
    // (rho → √2), not at the edge midpoints.
    const cornerX = rect.cx + rect.halfX * 0.98;
    const cornerZ = rect.cz + rect.halfZ * 0.98;
    const floor = terrainHeight(recipe, cornerX, cornerZ);
    expect(floor).toBeCloseTo(WATER_GROUND_Y, 1);
    const cornerDepth = WATER_Y - floor;
    expect(cornerDepth).toBeLessThan(0.5);
    // ...and the edge midpoints are already at full depth (rho = 1).
    const midFloor = terrainHeight(recipe, rect.cx + rect.halfX * 0.98, rect.cz);
    expect(midFloor).toBeCloseTo(WATER_GROUND_Y - WATER_BOWL_DEPTH, 1);
  });

  it("documents the feather it mirrors", () => {
    // terrain.ts BOWL_FEATHER is 0.3 in normalized ellipse-radius units.
    expect(WATER_BOWL_FEATHER).toBe(0.3);
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
      "previously-water-v2",
    );
    water.update(1.5); // scroll offsets advance without a GL context
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
