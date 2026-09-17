/**
 * three.js adapter for the procedural material library — converts the plain
 * typed arrays of a `MaterialMaps` into `DataTexture`s and nothing more; all
 * generation logic lives in the pure builders (tile/concrete/water). Other
 * browser-coupled modules in this library: shared.ts (texture cache),
 * surface.ts / water-surface.ts (material factories), grunge.ts / glow.ts
 * (canvas textures).
 *
 * Colour-space contract:
 *   - albedo    → SRGBColorSpace (it stores sRGB-ish display colour)
 *   - roughness → linear (default NoColorSpace); data texture, R channel
 *   - normal    → linear FloatType, and note the vectors are stored RAW in
 *     [-1, 1] — the consumer's material must use them as-is, NOT apply the
 *     usual normalTexture * 2 - 1 unpack meant for [0,1]-encoded maps.
 *
 * Everything gets RepeatWrapping so callers can scale UVs freely.
 *
 * Sampling contract: DataTexture ships with NearestFilter on both axes and
 * generateMipmaps = false (verified against three 0.185.1,
 * src/textures/DataTexture.js). Left as-is, every minified surface —
 * which, at the game's 45° orthographic camera, is most of the far floor —
 * aliases the maps' fine detail (tile grout, concrete pores) into moiré
 * clumps. applyTextureSampling() below is the single place that overrides
 * those defaults for every DataTexture this library produces; shared.ts's
 * water path uses it too.
 */

import {
  DataTexture,
  FloatType,
  LinearFilter,
  LinearMipmapLinearFilter,
  RepeatWrapping,
  RGBAFormat,
  SRGBColorSpace,
  UnsignedByteType,
} from "three";
import type { MaterialMaps } from "./types";

export interface MaterialTextures {
  albedo: DataTexture;
  roughness: DataTexture;
  normal: DataTexture;
}

/**
 * Anisotropy used when the caller does not say otherwise. The renderer's
 * true maximum (renderer.capabilities.getMaxAnisotropy()) is only known
 * after WebGLRenderer construction — out of reach for this pure module —
 * so render-side code should raise it to that maximum once the renderer
 * exists. 8 is the floor every desktop GPU of the last decade supports.
 */
export const DEFAULT_TEXTURE_ANISOTROPY = 8;

export interface MaterialTextureOptions {
  /** See DEFAULT_TEXTURE_ANISOTROPY. */
  anisotropy?: number;
}

/**
 * The library-wide sampling policy: linear magnification, trilinear
 * (mipmapped) minification with mipmaps actually generated, and anisotropic
 * filtering for the grazing angles a floor is always seen at. All maps are
 * power-of-two, so mipmapping is legal in both WebGL1 and WebGL2 — the
 * float normal maps included.
 */
export function applyTextureSampling(
  texture: DataTexture,
  anisotropy: number = DEFAULT_TEXTURE_ANISOTROPY,
): void {
  texture.magFilter = LinearFilter;
  texture.minFilter = LinearMipmapLinearFilter;
  texture.generateMipmaps = true;
  texture.anisotropy = anisotropy;
}

export function createMaterialTextures(
  maps: MaterialMaps,
  options: MaterialTextureOptions = {},
): MaterialTextures {
  const albedo = new DataTexture(
    maps.albedo,
    maps.size,
    maps.size,
    RGBAFormat,
    UnsignedByteType,
  );
  albedo.colorSpace = SRGBColorSpace;

  const roughness = new DataTexture(
    maps.roughness,
    maps.size,
    maps.size,
    RGBAFormat,
    UnsignedByteType,
  );

  const normal = new DataTexture(
    maps.normal,
    maps.size,
    maps.size,
    RGBAFormat,
    FloatType,
  );

  for (const texture of [albedo, roughness, normal]) {
    texture.wrapS = RepeatWrapping;
    texture.wrapT = RepeatWrapping;
    applyTextureSampling(texture, options.anisotropy);
    texture.needsUpdate = true;
  }

  return { albedo, roughness, normal };
}

/** Dispose every texture produced by createMaterialTextures. */
export function disposeMaterialTextures(textures: MaterialTextures): void {
  textures.albedo.dispose();
  textures.roughness.dispose();
  textures.normal.dispose();
}
