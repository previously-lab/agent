/**
 * Tests for the board-formed concrete builder
 * (src/lib/game/materials/concrete.ts): determinism, the MaterialMaps
 * contract, a matte roughness band that never breaks, and a field that is
 * visibly non-constant (drift + stains + speckle).
 */
import { describe, it, expect } from "vitest";
import { buildConcreteMaps } from "@/lib/game/materials/concrete";
import { expectValidMaterialMaps, sameBytes } from "./helpers";

function variance(values: number[]): number {
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  return (
    values.reduce((a, b) => a + (b - mean) * (b - mean), 0) / values.length
  );
}

describe("buildConcreteMaps", () => {
  it("is deterministic: same seed yields byte-identical buffers", () => {
    const a = buildConcreteMaps({ size: 64, seed: 42 });
    const b = buildConcreteMaps({ size: 64, seed: 42 });
    expect(sameBytes(a.albedo, b.albedo)).toBe(true);
    expect(sameBytes(a.roughness, b.roughness)).toBe(true);
    expect(sameBytes(a.normal, b.normal)).toBe(true);
  });

  it("produces different buffers for a different seed", () => {
    const a = buildConcreteMaps({ size: 64, seed: 1 });
    const b = buildConcreteMaps({ size: 64, seed: 2 });
    expect(sameBytes(a.albedo, b.albedo)).toBe(false);
  });

  it("satisfies the MaterialMaps contract at default and small sizes", () => {
    expectValidMaterialMaps(buildConcreteMaps(), 256, 16);
    expectValidMaterialMaps(buildConcreteMaps({ size: 64, seed: 7 }), 64);
  });

  it("keeps roughness inside the matte band [0.7, 0.9] everywhere", () => {
    const maps = buildConcreteMaps({ size: 128, seed: 17 });
    for (let i = 0; i < 128 * 128; i++) {
      const r = maps.roughness[i * 4] / 255;
      expect(r).toBeGreaterThanOrEqual(0.7);
      expect(r).toBeLessThanOrEqual(0.9);
    }
  });

  it("is not a constant field: albedo and roughness vary well above noise floor", () => {
    const maps = buildConcreteMaps({ size: 128, seed: 23 });
    const albedoR: number[] = [];
    const roughR: number[] = [];
    for (let i = 0; i < 128 * 128; i++) {
      albedoR.push(maps.albedo[i * 4]);
      roughR.push(maps.roughness[i * 4]);
    }
    // A flat texture has variance 0; even gentle drift + stains + speckle
    // lands orders of magnitude above these floors.
    expect(variance(albedoR)).toBeGreaterThan(4);
    expect(variance(roughR)).toBeGreaterThan(0.5);
  });

  it("has a low-frequency drift: distant regions differ in average tone", () => {
    const size = 256;
    const maps = buildConcreteMaps({ size, seed: 31 });
    // Compare quadrant means; at least one pair must disagree meaningfully.
    const quadrantMean = (qx: number, qy: number): number => {
      let sum = 0;
      let n = 0;
      for (let y = qy * (size / 2); y < (qy + 1) * (size / 2); y += 4) {
        for (let x = qx * (size / 2); x < (qx + 1) * (size / 2); x += 4) {
          sum += maps.albedo[(y * size + x) * 4];
          n++;
        }
      }
      return sum / n;
    };
    const means = [
      quadrantMean(0, 0),
      quadrantMean(1, 0),
      quadrantMean(0, 1),
      quadrantMean(1, 1),
    ];
    const spread = Math.max(...means) - Math.min(...means);
    expect(spread).toBeGreaterThan(1.5);
  });

  it("keeps the normal map near-flat (fine grain only)", () => {
    const maps = buildConcreteMaps({ size: 128, seed: 13 });
    for (let i = 0; i < 128 * 128; i++) {
      // z component stays close to 1: no macro structure in the normal map.
      expect(maps.normal[i * 4 + 2]).toBeGreaterThan(0.85);
    }
  });
});
