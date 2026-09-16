/**
 * Tests for the tiling water normal maps (src/lib/game/materials/water.ts).
 * The contract the water material relies on: determinism, exact buffer
 * shapes, unit normals in [-1, 1], and — the whole point of the module —
 * layers that wrap seamlessly in both axes.
 */
import { describe, it, expect } from "vitest";
import { buildWaterNormalMaps } from "@/lib/game/materials/water";
import { sameBytes } from "./helpers";

/** Max per-component difference between two rows of a normal layer. */
function rowDiff(layer: Float32Array, size: number, y0: number, y1: number): number {
  let max = 0;
  for (let x = 0; x < size; x++) {
    for (let c = 0; c < 3; c++) {
      const a = layer[(y0 * size + x) * 4 + c];
      const b = layer[(y1 * size + x) * 4 + c];
      max = Math.max(max, Math.abs(a - b));
    }
  }
  return max;
}

/** Max per-component difference between two columns of a normal layer. */
function colDiff(layer: Float32Array, size: number, x0: number, x1: number): number {
  let max = 0;
  for (let y = 0; y < size; y++) {
    for (let c = 0; c < 3; c++) {
      const a = layer[(y * size + x0) * 4 + c];
      const b = layer[(y * size + x1) * 4 + c];
      max = Math.max(max, Math.abs(a - b));
    }
  }
  return max;
}

describe("buildWaterNormalMaps", () => {
  it("is deterministic: same seed yields byte-identical layers", () => {
    const a = buildWaterNormalMaps({ size: 64, seed: 555 });
    const b = buildWaterNormalMaps({ size: 64, seed: 555 });
    expect(a.layers.length).toBe(b.layers.length);
    for (let i = 0; i < a.layers.length; i++) {
      expect(sameBytes(a.layers[i], b.layers[i])).toBe(true);
    }
  });

  it("produces different layers for a different seed", () => {
    const a = buildWaterNormalMaps({ size: 64, seed: 1 });
    const b = buildWaterNormalMaps({ size: 64, seed: 2 });
    expect(sameBytes(a.layers[0], b.layers[0])).toBe(false);
  });

  it("honours the requested layer count and defaults to 3", () => {
    expect(buildWaterNormalMaps({ size: 32, seed: 9 }).layers.length).toBe(3);
    expect(buildWaterNormalMaps({ size: 32, seed: 9, layers: 5 }).layers.length).toBe(5);
  });

  it("gives every layer exact dimensions, finite values, and unit normals", () => {
    const size = 64;
    const { layers } = buildWaterNormalMaps({ size, seed: 77, layers: 4 });
    for (const layer of layers) {
      expect(layer.length).toBe(size * size * 4);
      for (let i = 0; i < size * size; i++) {
        const p = i * 4;
        const nx = layer[p];
        const ny = layer[p + 1];
        const nz = layer[p + 2];
        for (const c of [nx, ny, nz]) {
          expect(Number.isFinite(c)).toBe(true);
          expect(c).toBeGreaterThanOrEqual(-1);
          expect(c).toBeLessThanOrEqual(1);
        }
        expect(Math.hypot(nx, ny, nz)).toBeCloseTo(1, 4);
        expect(layer[p + 3]).toBe(1);
      }
    }
  });

  it("tiles seamlessly in both axes for every layer", () => {
    const size = 128;
    const { layers } = buildWaterNormalMaps({ size, seed: 314, layers: 3 });
    for (const layer of layers) {
      // First vs last row/column: on the torus these are neighbouring
      // scanlines, so a seamless field keeps them within one pixel-step of
      // normal tilt. A non-wrapping field would show O(1) jumps here.
      expect(rowDiff(layer, size, 0, size - 1)).toBeLessThan(0.2);
      expect(colDiff(layer, size, 0, size - 1)).toBeLessThan(0.2);
    }
  });

  it("makes the layers distinct from one another (independent frequencies)", () => {
    const { layers } = buildWaterNormalMaps({ size: 64, seed: 2718 });
    for (let i = 0; i + 1 < layers.length; i++) {
      expect(sameBytes(layers[i], layers[i + 1])).toBe(false);
    }
  });

  it("actually ripples: normals deviate from straight-up", () => {
    const size = 64;
    const { layers } = buildWaterNormalMaps({ size, seed: 161 });
    let minZ = 1;
    for (let i = 0; i < size * size; i++) {
      minZ = Math.min(minZ, layers[0][i * 4 + 2]);
    }
    expect(minZ).toBeLessThan(0.98);
  });
});
