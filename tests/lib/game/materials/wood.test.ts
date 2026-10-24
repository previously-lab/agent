/**
 * Tests for the low-contrast wood-grain builder
 * (src/lib/game/materials/wood.ts): determinism, the MaterialMaps
 * contract, the near-neutral albedo mean the consumers pre-divide by, a
 * LOW-CONTRAST grain (a few 1/255 levels, never a color band), a matte
 * roughness band, and the flat placeholder normal.
 */
import { describe, it, expect } from "vitest";
import {
  buildWoodMaps,
  WOOD_ALBEDO_MEAN,
  WOOD_ROUGHNESS_BASE,
  WOOD_ROUGHNESS_VARIANCE,
} from "@/lib/game/materials/wood";
import { expectValidMaterialMaps, sameBytes } from "./helpers";

function mean(values: number[]): number {
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function variance(values: number[]): number {
  const m = mean(values);
  return values.reduce((a, b) => a + (b - m) * (b - m), 0) / values.length;
}

describe("buildWoodMaps", () => {
  it("is deterministic: same options yield byte-identical buffers", () => {
    const a = buildWoodMaps({ size: 64, seed: 42 });
    const b = buildWoodMaps({ size: 64, seed: 42 });
    expect(sameBytes(a.albedo, b.albedo)).toBe(true);
    expect(sameBytes(a.roughness, b.roughness)).toBe(true);
    expect(sameBytes(a.normal, b.normal)).toBe(true);
  });

  it("produces different buffers for a different seed", () => {
    const a = buildWoodMaps({ size: 64, seed: 1 });
    const b = buildWoodMaps({ size: 64, seed: 2 });
    expect(sameBytes(a.albedo, b.albedo)).toBe(false);
  });

  it("satisfies the MaterialMaps contract at default and small sizes", () => {
    expectValidMaterialMaps(buildWoodMaps(), 256, 16);
    expectValidMaterialMaps(buildWoodMaps({ size: 64, seed: 7 }), 64);
  });

  it("keeps the albedo near-neutral with a documented mean consumers pre-divide by", () => {
    const maps = buildWoodMaps({ size: 128, seed: 17 });
    let sum = 0;
    const greens: number[] = [];
    for (let i = 0; i < 128 * 128; i++) {
      const g = maps.albedo[i * 4 + 1] / 255;
      sum += g;
      greens.push(maps.albedo[i * 4 + 1]);
    }
    expect(sum / (128 * 128)).toBeCloseTo(WOOD_ALBEDO_MEAN, 1);
    // Low contrast by decree: the grain's green-channel spread stays within
    // a few 1/255 levels — variation a viewer reads as grain, not stripes.
    expect(Math.sqrt(variance(greens))).toBeLessThan(14);
  });

  it("stays matte: roughness within the grain band around the nominal everywhere", () => {
    const maps = buildWoodMaps({ size: 128, seed: 23 });
    for (let i = 0; i < 128 * 128; i++) {
      const r = maps.roughness[i * 4] / 255;
      expect(r).toBeGreaterThanOrEqual(
        WOOD_ROUGHNESS_BASE - WOOD_ROUGHNESS_VARIANCE - 0.08,
      );
      expect(r).toBeLessThanOrEqual(WOOD_ROUGHNESS_BASE + WOOD_ROUGHNESS_VARIANCE + 0.01);
    }
  });

  it("varies: albedo and roughness are visibly non-constant fields", () => {
    const maps = buildWoodMaps({ size: 128, seed: 29 });
    const albedoG: number[] = [];
    const roughR: number[] = [];
    for (let i = 0; i < 128 * 128; i++) {
      albedoG.push(maps.albedo[i * 4 + 1]);
      roughR.push(maps.roughness[i * 4]);
    }
    expect(variance(albedoG)).toBeGreaterThan(0.5);
    expect(variance(roughR)).toBeGreaterThan(0.2);
  });

  it("ships the flat placeholder normal (0, 0, 1) — furniture never patches normals", () => {
    const maps = buildWoodMaps({ size: 64, seed: 5 });
    for (let i = 0; i < 64 * 64; i++) {
      const p = i * 4;
      expect(maps.normal[p]).toBe(0);
      expect(maps.normal[p + 1]).toBe(0);
      expect(maps.normal[p + 2]).toBe(1);
      expect(maps.normal[p + 3]).toBe(1);
    }
  });
});
