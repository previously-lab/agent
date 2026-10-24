/**
 * PBR surface materials — a clean MeshStandardMaterial factory.
 *
 * The matte art overhaul (v0.11-streams) retired the procedural tile and
 * concrete albedo/roughness/normal maps together with the custom
 * onBeforeCompile tiling patch: the target look is broad matte surfaces in
 * flat palette colors (the reference isometric illustration — sage, cream,
 * pale wood — not photoreal texture). Each material is now just its
 * palette color at a high roughness; face separation comes from the
 * lighting, variation from the geometry itself.
 *
 * OPTIONS CONTRACT. `spanX`/`spanY`/`normalScale` remain in
 * SurfaceMaterialOptions so existing callers (space.tsx) keep compiling
 * unchanged; with no maps bound they no longer alter shading. Transparency,
 * opacity and flatShading behave exactly as before. Pool caustics may still
 * patch the returned ground material at its own boundary
 * (materials/caustics-surface.ts).
 */

import { MeshStandardMaterial, type ColorRepresentation } from "three";

export type SurfaceKind = "tile" | "concrete";

export interface SurfaceMaterialOptions {
  kind: SurfaceKind;
  /** Palette color; the material renders it flat (no map darkening). */
  color: ColorRepresentation;
  /** Physical span in meters the material covers along u and v. Retained
   *  for caller compatibility; unused while no maps are bound. */
  spanX: number;
  spanY: number;
  transparent?: boolean;
  opacity?: number;
  flatShading?: boolean;
  /** Retained for caller compatibility; unused while no normal map is
   *  bound. */
  normalScale?: number;
}

/**
 * One tile or concrete matte material: the palette color at roughness 0.9
 * (tile) / 0.98 (concrete), metalness 0, no maps, no shader patch. Dispose
 * the material when its surface unmounts.
 */
export function createSurfaceMaterial(
  opts: SurfaceMaterialOptions,
): MeshStandardMaterial {
  return new MeshStandardMaterial({
    color: opts.color,
    roughness: opts.kind === "tile" ? 0.9 : 0.98,
    metalness: 0,
    transparent: opts.transparent ?? false,
    opacity: opts.opacity ?? 1,
    flatShading: opts.flatShading ?? false,
  });
}
