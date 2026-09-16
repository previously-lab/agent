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
 */

import {
  DataTexture,
  FloatType,
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

export function createMaterialTextures(maps: MaterialMaps): MaterialTextures {
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
