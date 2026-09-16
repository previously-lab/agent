/**
 * Procedural material library — public API.
 *
 * Pure builders (node-safe, fully deterministic): buildTileMaps,
 * buildConcreteMaps, buildWaterNormalMaps. Browser-coupled surfaces:
 *   - three.ts        DataTexture adapter (createMaterialTextures)
 *   - shared.ts       app-lifetime shared texture cache (node-safe)
 *   - surface.ts      tile/concrete PBR material factory (uTiling patch)
 *   - water-surface.ts shallow-water material (scrolling ripples + depth tint)
 *   - grunge.ts       seeded mottled roughnessMap (absorbed from corridor.tsx)
 *   - glow.ts         radial glow / wall-wash gradient textures (idem)
 */

export type { MaterialMaps } from "./types";
export { buildTileMaps, TILE_ALBEDO_MEAN } from "./tile";
export type { TileOptions } from "./tile";
export { buildConcreteMaps, CONCRETE_ALBEDO_MEAN } from "./concrete";
export type { ConcreteOptions } from "./concrete";
export { buildWaterNormalMaps } from "./water";
export type { WaterNormalMaps, WaterNormalOptions } from "./water";
export { createMaterialTextures, disposeMaterialTextures } from "./three";
export type { MaterialTextures } from "./three";
export {
  sharedTileTextures,
  sharedConcreteTextures,
  sharedWaterNormalTextures,
} from "./shared";
export { createSurfaceMaterial } from "./surface";
export type { SurfaceKind, SurfaceMaterialOptions } from "./surface";
export { createWaterSurfaceMaterial } from "./water-surface";
export type { WaterSurfaceMaterial, WaterSurfaceOptions } from "./water-surface";
export {
  createGrungeRoughnessMap,
  GRUNGE_MAP_BASE,
  GRUNGE_MAP_SIZE,
  GRUNGE_MAP_VARIANCE,
} from "./grunge";
export {
  createRadialGlowTexture,
  createWallWashTexture,
  sharedRadialGlowTexture,
  sharedWallWashTexture,
  GLOW_TEXTURE_SIZE,
} from "./glow";
