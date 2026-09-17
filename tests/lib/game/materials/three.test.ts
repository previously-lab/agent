/**
 * Tests for the three.js DataTexture adapter (src/lib/game/materials/three.ts).
 * The sampling policy these pin is the fix for the far-floor moiré: three's
 * DataTexture defaults (NearestFilter on both axes, generateMipmaps = false —
 * verified against three 0.185.1 src/textures/DataTexture.js) alias the maps'
 * fine detail under minification; every texture this library produces must
 * instead be linear + mipmapped + anisotropic.
 */
import { describe, it, expect } from "vitest";
import {
  LinearFilter,
  LinearMipmapLinearFilter,
  NoColorSpace,
  RepeatWrapping,
  SRGBColorSpace,
} from "three";
import {
  applyTextureSampling,
  createMaterialTextures,
  DEFAULT_TEXTURE_ANISOTROPY,
} from "@/lib/game/materials/three";
import { buildTileMaps } from "@/lib/game/materials/tile";

describe("createMaterialTextures sampling", () => {
  it("magnifies linearly, minifies trilinearly with mipmaps generated, on every map", () => {
    const textures = createMaterialTextures(
      buildTileMaps({ size: 32, cells: 4, seed: 1 }),
    );
    for (const texture of [
      textures.albedo,
      textures.roughness,
      textures.normal,
    ]) {
      expect(texture.magFilter).toBe(LinearFilter);
      expect(texture.minFilter).toBe(LinearMipmapLinearFilter);
      expect(texture.generateMipmaps).toBe(true);
      expect(texture.wrapS).toBe(RepeatWrapping);
      expect(texture.wrapT).toBe(RepeatWrapping);
    }
  });

  it("applies the default anisotropy and honours an explicit override", () => {
    const maps = buildTileMaps({ size: 32, cells: 4, seed: 1 });
    const fallback = createMaterialTextures(maps);
    expect(fallback.albedo.anisotropy).toBe(DEFAULT_TEXTURE_ANISOTROPY);
    expect(fallback.roughness.anisotropy).toBe(DEFAULT_TEXTURE_ANISOTROPY);
    expect(fallback.normal.anisotropy).toBe(DEFAULT_TEXTURE_ANISOTROPY);

    const raised = createMaterialTextures(maps, { anisotropy: 16 });
    expect(raised.albedo.anisotropy).toBe(16);
    expect(raised.normal.anisotropy).toBe(16);
  });

  it("keeps colour-space handling per map type: albedo is sRGB, data maps are linear", () => {
    const textures = createMaterialTextures(
      buildTileMaps({ size: 32, cells: 4, seed: 1 }),
    );
    expect(textures.albedo.colorSpace).toBe(SRGBColorSpace);
    expect(textures.roughness.colorSpace).toBe(NoColorSpace);
    expect(textures.normal.colorSpace).toBe(NoColorSpace);
  });

  it("applyTextureSampling is idempotent on an already-sampled texture", () => {
    const textures = createMaterialTextures(
      buildTileMaps({ size: 32, cells: 4, seed: 1 }),
    );
    applyTextureSampling(textures.albedo, 4);
    expect(textures.albedo.minFilter).toBe(LinearMipmapLinearFilter);
    expect(textures.albedo.anisotropy).toBe(4);
  });
});
