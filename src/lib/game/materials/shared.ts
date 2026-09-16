/**
 * Shared base textures for the procedural material library — the
 * resource-discipline half of the wiring.
 *
 * Every tile/concrete surface in every room samples the SAME three
 * DataTextures per material kind, and every water surface the same three
 * ripple normal layers. They are built lazily on first use and live for the
 * app's lifetime (never disposed): a room mounts and unmounts on every door
 * opening, and a per-entry texture allocation would be a per-entry GPU
 * upload hitch. Per-surface repeat is NOT baked into the textures — it is a
 * per-material shader uniform (see surface.ts), so differing repeats never
 * fork the cache.
 *
 * Cache key: `${kind}:${size}[:cells]` — the builders' deterministic output
 * depends only on those parameters (all entropy derives from WORLD_SEED).
 * In practice the cache holds exactly three entries at default parameters:
 *   tile:256:8 · concrete:256 · water:256:3
 * = 9 GPU textures total (3 maps × tile/concrete + 3 water normal layers).
 *
 * Node-safe: DataTexture needs no DOM, so this module (unlike grunge.ts /
 * glow.ts) can be imported anywhere.
 */

import { DataTexture, FloatType, RepeatWrapping, RGBAFormat } from "three";
import { buildConcreteMaps } from "./concrete";
import { buildTileMaps } from "./tile";
import {
  createMaterialTextures,
  type MaterialTextures,
} from "./three";
import { buildWaterNormalMaps } from "./water";

const cache = new Map<string, MaterialTextures | DataTexture[]>();

/** The tile texture set (albedo + roughness + normal), built once. */
export function sharedTileTextures(): MaterialTextures {
  const key = "tile:256:8";
  let entry = cache.get(key);
  if (!entry) {
    entry = createMaterialTextures(buildTileMaps());
    cache.set(key, entry);
  }
  return entry as MaterialTextures;
}

/** The concrete texture set (albedo + roughness + normal), built once. */
export function sharedConcreteTextures(): MaterialTextures {
  const key = "concrete:256";
  let entry = cache.get(key);
  if (!entry) {
    entry = createMaterialTextures(buildConcreteMaps());
    cache.set(key, entry);
  }
  return entry as MaterialTextures;
}

/**
 * The water ripple normal layers as DataTextures, built once. Like the
 * MaterialMaps normals these store RAW vectors in [-1, 1] (FloatType) — no
 * [0,1] encoding, no `* 2 - 1` unpack at sample time. Every layer wraps
 * seamlessly in both axes (the builder's toroidal noise), so consumers may
 * scroll them freely.
 */
export function sharedWaterNormalTextures(): DataTexture[] {
  const key = "water:256:3";
  let entry = cache.get(key);
  if (!entry) {
    const { layers, size } = buildWaterNormalMaps();
    entry = layers.map((data) => {
      const texture = new DataTexture(
        data,
        size,
        size,
        RGBAFormat,
        FloatType,
      );
      texture.wrapS = RepeatWrapping;
      texture.wrapT = RepeatWrapping;
      texture.needsUpdate = true;
      return texture;
    });
    cache.set(key, entry);
  }
  return entry as DataTexture[];
}
