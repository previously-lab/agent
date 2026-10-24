/**
 * Tests for the material wiring layer: the shared texture cache
 * (src/lib/game/materials/shared.ts), the matte tile/concrete surface
 * factory (surface.ts), and the shallow-water material (water-surface.ts).
 * Node-safe — DataTexture and MeshStandardMaterial need no DOM, and the
 * shader patches are driven with stub shader objects so the exact
 * ShaderChunk strings they rewrite stay pinned against the installed three.
 */
import { describe, it, expect } from "vitest";
import {
  LinearFilter,
  LinearMipmapLinearFilter,
  MeshStandardMaterial,
  RepeatWrapping,
} from "three";
import type { WebGLProgramParametersWithUniforms } from "three";
import {
  sharedConcreteTextures,
  sharedTileTextures,
  sharedWaterNormalTextures,
} from "@/lib/game/materials/shared";
import { createSurfaceMaterial } from "@/lib/game/materials/surface";
import { createWaterSurfaceMaterial } from "@/lib/game/materials/water-surface";
import { POOL_DEPTH } from "@/lib/game/terrain";

/** The tangent-space packed sample the patch must eliminate (the dead
 *  object-space branch keeps its own unpack — assert on the exact line). */
const PACKED_MAPN_LINE =
  "vec3 mapN = texture2D( normalMap, vNormalMapUv ).xyz * 2.0 - 1.0;";

/** Minimal stand-in for the parameters object three passes onBeforeCompile. */
function stubShader() {
  return {
    uniforms: {} as Record<string, { value: unknown }>,
    defines: {} as Record<string, string>,
    vertexShader: "void main() {\n#include <uv_vertex>\n}",
    fragmentShader:
      "void main() {\n#include <color_fragment>\n#include <normal_fragment_maps>\n}",
  } as unknown as WebGLProgramParametersWithUniforms;
}

describe("shared texture cache", () => {
  it("returns the same texture set on every call (no per-room re-creation)", () => {
    expect(sharedTileTextures()).toBe(sharedTileTextures());
    expect(sharedConcreteTextures()).toBe(sharedConcreteTextures());
    expect(sharedWaterNormalTextures()).toBe(sharedWaterNormalTextures());
  });

  it("serves three repeat-wrapped water ripple layers", () => {
    const layers = sharedWaterNormalTextures();
    expect(layers).toHaveLength(3);
    for (const layer of layers) {
      expect(layer.wrapS).toBe(RepeatWrapping);
      expect(layer.wrapT).toBe(RepeatWrapping);
    }
  });

  it("samples every cached texture set linearly with mipmaps (the moiré fix)", () => {
    const tile = sharedTileTextures();
    const concrete = sharedConcreteTextures();
    const textures = [
      tile.albedo,
      tile.roughness,
      tile.normal,
      concrete.albedo,
      concrete.roughness,
      concrete.normal,
      ...sharedWaterNormalTextures(),
    ];
    for (const texture of textures) {
      expect(texture.magFilter).toBe(LinearFilter);
      expect(texture.minFilter).toBe(LinearMipmapLinearFilter);
      expect(texture.generateMipmaps).toBe(true);
      expect(texture.anisotropy).toBeGreaterThanOrEqual(8);
    }
  });
});

describe("createSurfaceMaterial", () => {
  it("returns a matte map-less material: no albedo/roughness/normal maps", () => {
    const material = createSurfaceMaterial({
      kind: "tile",
      color: "#ffffff",
      spanX: 10,
      spanY: 4,
    });
    expect(material.map).toBeNull();
    expect(material.roughnessMap).toBeNull();
    expect(material.normalMap).toBeNull();
    // No custom shader patch: the factory leaves the stock program alone.
    expect(material.onBeforeCompile).toHaveLength(0);
    const stock = new MeshStandardMaterial();
    expect(material.customProgramCacheKey()).toBe(stock.customProgramCacheKey());
    stock.dispose();
    material.dispose();
  });

  it("roughness .9 for tile and .98 for concrete, metalness 0", () => {
    const tile = createSurfaceMaterial({
      kind: "tile",
      color: "#ffffff",
      spanX: 10,
      spanY: 4,
    });
    const concrete = createSurfaceMaterial({
      kind: "concrete",
      color: "#ffffff",
      spanX: 10,
      spanY: 4,
    });
    expect(tile.roughness).toBe(0.9);
    expect(concrete.roughness).toBe(0.98);
    expect(tile.metalness).toBe(0);
    expect(concrete.metalness).toBe(0);
    tile.dispose();
    concrete.dispose();
  });

  it("keeps the palette color exactly (no albedo compensation)", () => {
    const color = "#d0c1a2";
    const tile = createSurfaceMaterial({ kind: "tile", color, spanX: 5, spanY: 5 });
    const concrete = createSurfaceMaterial({ kind: "concrete", color, spanX: 5, spanY: 5 });
    // Both kinds render the input color as-is: surface.ts no longer
    // pre-divides by any map mean.
    expect(tile.color.getHexString()).toBe(concrete.color.getHexString());
    expect(`#${tile.color.getHexString()}`).toBe(color);
    tile.dispose();
    concrete.dispose();
  });

  it("preserves transparency, opacity and flatShading options", () => {
    const material = createSurfaceMaterial({
      kind: "tile",
      color: "#ffffff",
      spanX: 10,
      spanY: 4,
      transparent: true,
      opacity: 0.6,
      flatShading: true,
    });
    expect(material.transparent).toBe(true);
    expect(material.opacity).toBe(0.6);
    expect(material.flatShading).toBe(true);
    material.dispose();
  });
});

describe("createWaterSurfaceMaterial", () => {
  const opts = {
    color: "#45a8c8",
    shallowColor: "#cfeef5",
    spanX: 12,
    spanY: 8,
  };

  it("compiles the wave-field-only normal and the Beer–Lambert depth model", () => {
    const water = createWaterSurfaceMaterial(opts);
    // The normalMap slot stays bound (never sampled) so three compiles the
    // tangent-frame math; the packed texture sample must be gone.
    expect(water.material.normalMap).not.toBeNull();
    expect(water.material.normalScale.x).toBe(1);
    expect(water.material.transparent).toBe(true);
    expect(water.material.defines).toMatchObject({ USE_UV: "" });

    const shader = stubShader();
    water.material.onBeforeCompile(shader, null as never);
    expect(shader.fragmentShader).toContain("waveSlope");
    expect(shader.fragmentShader).not.toContain(PACKED_MAPN_LINE);
    // No texture pattern on the surface: the old scrolling ripple layers
    // left no samplers or scroll uniforms behind.
    expect(shader.uniforms.uWaterNormalB).toBeUndefined();
    expect(shader.uniforms.uWaterScrollA).toBeUndefined();
    expect(shader.uniforms.uWaterSigma).toBeDefined();
    expect(shader.uniforms.uWaveHeight).toBeDefined();
    // The depth model is the straight-walled basin: a single depth
    // uniform, fed from terrain.ts's POOL_DEPTH — no bowl constants.
    expect(shader.uniforms.uWaterDepth.value).toBe(POOL_DEPTH);
    expect(shader.uniforms.uWaterBowl).toBeUndefined();
    water.dispose();
  });

  it("keeps update() as a stable no-op for the frame loop's call site", () => {
    const water = createWaterSurfaceMaterial(opts);
    expect(typeof water.update).toBe("function");
    expect(() => water.update(1.5)).not.toThrow();
    water.dispose();
  });
});
