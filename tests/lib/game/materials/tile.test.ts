/**
 * Tests for the glazed-tile builder (src/lib/game/materials/tile.ts) — the
 * poolroom flagship. These lock down the contract its consumers rely on:
 * determinism from seeds, exact buffer shapes, grout landing exactly on the
 * cells×cells grid, and the physical split between a nearly-glossy glaze
 * and a matte grout.
 */
import { describe, it, expect } from "vitest";
import {
  buildTileMaps,
  TILE_ALBEDO_MEAN,
  TILE_BEVEL,
  TILE_GROUT_ALBEDO,
  TILE_GROUT_HALF,
  TILE_NORMAL_STRENGTH,
} from "@/lib/game/materials/tile";
import { expectValidMaterialMaps, roughnessAt, sameBytes } from "./helpers";

/** Pixel whose sample point sits exactly on the grout line between cells. */
function groutPixel(cell: number, size: number, cells: number): number {
  return Math.round((cell * size) / cells);
}

/** Pixel at the centre of a cell. */
function facePixel(cell: number, size: number, cells: number): number {
  return Math.floor(((cell + 0.5) * size) / cells);
}

describe("buildTileMaps", () => {
  it("is deterministic: same seed yields byte-identical buffers", () => {
    const a = buildTileMaps({ size: 64, cells: 4, seed: 1234 });
    const b = buildTileMaps({ size: 64, cells: 4, seed: 1234 });
    expect(sameBytes(a.albedo, b.albedo)).toBe(true);
    expect(sameBytes(a.roughness, b.roughness)).toBe(true);
    expect(sameBytes(a.normal, b.normal)).toBe(true);
  });

  it("produces different buffers for a different seed", () => {
    const a = buildTileMaps({ size: 64, cells: 4, seed: 1 });
    const b = buildTileMaps({ size: 64, cells: 4, seed: 2 });
    expect(sameBytes(a.albedo, b.albedo)).toBe(false);
  });

  it("satisfies the MaterialMaps contract at default and small sizes", () => {
    expectValidMaterialMaps(buildTileMaps(), 256, 16);
    expectValidMaterialMaps(buildTileMaps({ size: 64, cells: 4, seed: 7 }), 64);
  });

  it("lays grout exactly on the cells×cells grid: every boundary is rougher than every face centre", () => {
    // 64px per cell so a texel lands close enough to the centreline to
    // sample the hairline joint at near-full strength.
    const size = 256;
    const cells = 4;
    const maps = buildTileMaps({ size, cells, seed: 99 });
    for (let cell = 0; cell < cells; cell++) {
      const face = facePixel(cell, size, cells);
      const nextBoundary = groutPixel(cell + 1, size, cells);
      // Sample along the line: face centre vs the grout line at the cell's
      // right edge (and bottom edge), mid-cell in the other axis.
      const faceRough = roughnessAt(maps, face, face);
      expect(roughnessAt(maps, nextBoundary % size, face)).toBeGreaterThan(faceRough);
      expect(roughnessAt(maps, face, nextBoundary % size)).toBeGreaterThan(faceRough);
    }
  });

  it("keeps face roughness in the glaze band and grout roughness in the matte band", () => {
    const size = 256;
    const cells = 4;
    const maps = buildTileMaps({ size, cells, seed: 5 });
    for (let cell = 0; cell < cells; cell++) {
      const face = facePixel(cell, size, cells);
      const boundary = groutPixel(cell, size, cells);
      const faceR = roughnessAt(maps, face, face);
      const groutR = roughnessAt(maps, boundary, face);
      expect(faceR).toBeGreaterThanOrEqual(0.03);
      expect(faceR).toBeLessThanOrEqual(0.18);
      expect(groutR).toBeGreaterThanOrEqual(0.68);
      expect(groutR).toBeLessThanOrEqual(0.92);
      expect(faceR).toBeLessThan(groutR);
    }
  });

  it("darkens albedo on the grout lines relative to the tile faces", () => {
    const size = 256;
    const cells = 4;
    const maps = buildTileMaps({ size, cells, seed: 11 });
    for (let cell = 0; cell < cells; cell++) {
      const face = facePixel(cell, size, cells);
      const boundary = groutPixel(cell, size, cells);
      const faceAlbedo = maps.albedo[(face * size + face) * 4];
      const groutAlbedo = maps.albedo[(face * size + boundary) * 4];
      expect(groutAlbedo).toBeLessThan(faceAlbedo);
      expect(faceAlbedo).toBeGreaterThan(200); // near-white glaze
    }
  });

  it("keeps the joint a light grey (clean joints read light, not black)", () => {
    const size = 256;
    const cells = 4;
    const maps = buildTileMaps({ size, cells, seed: 11 });
    for (let cell = 0; cell < cells; cell++) {
      const face = facePixel(cell, size, cells);
      const boundary = groutPixel(cell, size, cells);
      const groutAlbedo = maps.albedo[(face * size + boundary) * 4] / 255;
      // The old 0.58-base grout (~0.52–0.64) would fail this floor.
      expect(groutAlbedo).toBeGreaterThan(0.68);
    }
  });

  it("keeps the grout's roughness footprint a small fraction of the cell", () => {
    // 128px per cell so the joint spans several texels and the coverage
    // measures the AUTHORED width, not texel quantization (at the default
    // 32px/cell a sub-pixel joint lights the two straddling texel rows no
    // matter how thin it is authored).
    const size = 512;
    const cells = 4;
    const maps = buildTileMaps({ size, cells, seed: 17 });
    // Count pixels whose roughness sits above the midpoint between the
    // glaze band (≈0.1) and the matte grout band (≈0.85) — i.e. pixels the
    // grout mask covers by half or more. The old 9%-wide joint covered
    // ≈17% of the texture by this measure and would fail; the ≈3.5%
    // joint measures ≈6%.
    let groutPixels = 0;
    for (let i = 0; i < size * size; i++) {
      if (maps.roughness[i * 4] / 255 > 0.55) groutPixels++;
    }
    const coverage = groutPixels / (size * size);
    expect(coverage).toBeLessThan(0.1);
    expect(coverage).toBeGreaterThan(0.01);
  });

  it("pins the grout tuning surface to the 1px-line cut", () => {
    // Full joint width 3–4% of a cell; bevel band (both sides) ≤ 3%;
    // soft seam shading; light-grey joint base.
    expect(2 * TILE_GROUT_HALF).toBeGreaterThanOrEqual(0.03);
    expect(2 * TILE_GROUT_HALF).toBeLessThanOrEqual(0.04);
    expect(2 * TILE_BEVEL).toBeLessThanOrEqual(0.03);
    expect(TILE_NORMAL_STRENGTH).toBe(0.5);
    expect(TILE_GROUT_ALBEDO).toBeGreaterThanOrEqual(0.7);
  });

  it("keeps TILE_ALBEDO_MEAN honest against the generated maps", () => {
    const maps = buildTileMaps({ size: 128, cells: 4, seed: 23 });
    let sum = 0;
    for (let i = 0; i < maps.size * maps.size; i++) {
      sum += maps.albedo[i * 4] / 255;
    }
    const mean = sum / (maps.size * maps.size);
    expect(Math.abs(mean - TILE_ALBEDO_MEAN)).toBeLessThan(0.05);
  });

  it("carries a beveled groove: normals tilt near the grout and flatten at cell centres", () => {
    // 128px per cell so the ~2% bevel band spans real pixels.
    const size = 512;
    const cells = 4;
    const maps = buildTileMaps({ size, cells, seed: 3 });
    const face = facePixel(1, size, cells);
    const boundary = groutPixel(1, size, cells);
    // One pixel inside the face next to the grout line the bevel must tilt
    // the normal away from straight-up.
    const bevelX = boundary + 1;
    const tilted = maps.normal[(face * size + bevelX) * 4 + 2];
    const flat = maps.normal[(face * size + face) * 4 + 2];
    expect(tilted).toBeLessThan(flat);
    expect(flat).toBeGreaterThan(0.999);
  });

  it("accumulates grime next to the grout (albedo dips beside the line)", () => {
    const size = 128;
    const cells = 4;
    const maps = buildTileMaps({ size, cells, seed: 21 });
    const face = facePixel(1, size, cells);
    const boundary = groutPixel(1, size, cells);
    const nearGrout = maps.albedo[(face * size + boundary + 4) * 4];
    const midFace = maps.albedo[(face * size + face) * 4];
    expect(nearGrout).toBeLessThanOrEqual(midFace);
  });
});
