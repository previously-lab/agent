/**
 * Shared assertions for the procedural material library tests. Not a test
 * file — vitest only picks up *.test.ts.
 */
import { expect } from "vitest";
import type { MaterialMaps } from "@/lib/game/materials/types";

/**
 * The contract every MaterialMaps must satisfy: exact buffer dimensions,
 * finite values everywhere, roughness bytes trivially in [0,1], and normal
 * components in [-1,1] forming unit-length vectors with A = 1.
 */
export function expectValidMaterialMaps(
  maps: MaterialMaps,
  size: number,
  stride = 1,
): void {
  expect(maps.size).toBe(size);
  expect(maps.albedo.length).toBe(size * size * 4);
  expect(maps.roughness.length).toBe(size * size * 4);
  expect(maps.normal.length).toBe(size * size * 4);

  // `stride` samples every Nth pixel so 256² maps don't blow the test
  // timeout on hundreds of thousands of individual assertions.
  for (let i = 0; i < size * size; i += stride) {
    const p = i * 4;
    expect(maps.albedo[p + 3]).toBe(255);
    expect(maps.roughness[p + 3]).toBe(255);
    expect(maps.roughness[p + 1]).toBe(maps.roughness[p]);
    expect(maps.roughness[p + 2]).toBe(maps.roughness[p]);

    const nx = maps.normal[p];
    const ny = maps.normal[p + 1];
    const nz = maps.normal[p + 2];
    for (const c of [nx, ny, nz]) {
      expect(Number.isFinite(c)).toBe(true);
      expect(c).toBeGreaterThanOrEqual(-1);
      expect(c).toBeLessThanOrEqual(1);
    }
    expect(Math.hypot(nx, ny, nz)).toBeCloseTo(1, 4);
    expect(maps.normal[p + 3]).toBe(1);
  }
}

/**
 * Byte-exact comparison for typed arrays. Buffer.from(float32Array) would
 * truncate each float to a byte; compare the underlying bytes instead.
 */
export function sameBytes(
  a: Uint8ClampedArray | Float32Array,
  b: Uint8ClampedArray | Float32Array,
): boolean {
  return Buffer.from(a.buffer, a.byteOffset, a.byteLength).equals(
    Buffer.from(b.buffer, b.byteOffset, b.byteLength),
  );
}

/** Roughness in [0,1] at pixel (x, y). */
export function roughnessAt(maps: MaterialMaps, x: number, y: number): number {
  return maps.roughness[(y * maps.size + x) * 4] / 255;
}
