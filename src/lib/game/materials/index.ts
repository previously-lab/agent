/**
 * Procedural material library — public API.
 *
 * Pure builders (node-safe, fully deterministic): buildTileMaps,
 * buildConcreteMaps, buildWaterNormalMaps, buildCausticsMaps. Browser-
 * coupled surfaces:
 *   - three.ts           DataTexture adapter (createMaterialTextures)
 *   - shared.ts          app-lifetime shared texture cache (node-safe)
 *   - surface.ts         tile/concrete PBR material factory (uTiling patch)
 *   - water-surface.ts   shallow-water material (scrolling ripples + depth tint)
 *   - caustics-surface.ts additive pool-floor light web (patch + scroll driver)
 *   - grunge.ts          seeded mottled roughnessMap (absorbed from corridor.tsx)
 *   - glow.ts            radial glow / wall-wash gradient textures (idem)
 */

export type { MaterialMaps } from "./types";
export {
  buildTileMaps,
  TILE_ALBEDO_MEAN,
  TILE_GROUT_HALF,
  TILE_GROUT_BOTTOM,
  TILE_BEVEL,
  TILE_NORMAL_STRENGTH,
  TILE_GROUT_ALBEDO,
} from "./tile";
export type { TileOptions } from "./tile";
export { buildConcreteMaps, CONCRETE_ALBEDO_MEAN } from "./concrete";
export type { ConcreteOptions } from "./concrete";
export { buildWaterNormalMaps } from "./water";
export type { WaterNormalMaps, WaterNormalOptions } from "./water";
export { buildCausticsMaps } from "./caustics";
export type { CausticsMaps, CausticsMapsOptions } from "./caustics";
export {
  applyTextureSampling,
  createMaterialTextures,
  disposeMaterialTextures,
  DEFAULT_TEXTURE_ANISOTROPY,
} from "./three";
export type { MaterialTextures, MaterialTextureOptions } from "./three";
export {
  sharedTileTextures,
  sharedConcreteTextures,
  sharedWaterNormalTextures,
  sharedCausticsTextures,
} from "./shared";
export { createSurfaceMaterial } from "./surface";
export type { SurfaceKind, SurfaceMaterialOptions } from "./surface";
export { createWaterSurfaceMaterial } from "./water-surface";
export type { WaterSurfaceMaterial, WaterSurfaceOptions } from "./water-surface";
export { applyPoolCaustics, CAUSTICS_CELL_METERS } from "./caustics-surface";
export type { PoolCaustics, PoolCausticsOptions } from "./caustics-surface";
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
export {
  buildWindowViewImage,
  createWindowViewTexture,
  WINDOW_VIEW_WIDTH,
  WINDOW_VIEW_HEIGHT,
} from "./window-view";
export type { WindowViewImage, WindowViewOptions } from "./window-view";
export { createWaveDriver } from "./wave-driver";
export type { WaveDriver } from "./wave-driver";
export { waveRectContains } from "./wave-sim";
