/**
 * Terrain height for a space — the single source of truth shared by the
 * renderer (ground displacement in src/components/game/space.tsx) and the
 * avatar physics (Y snapping in game-canvas). Both must agree exactly, so
 * this module owns ALL heightfield math; neither consumer may re-derive it.
 *
 * Local frame (same as the renderer's): the doorway is at (0, 0), x is
 * centered on the door axis, and +z points outward from the corridor wall
 * with the floor plan occupying x ∈ [−width/2, width/2], z ∈ [0, extent].
 *
 * PURITY & TOTALITY. terrainHeight is a pure function of the recipe and
 * coordinates, defined for ANY (localX, localZ) — including outside the
 * floor plan; nothing is clamped to the plan:
 *   - flat (meadow, interiors, wonders, snow, …) is GROUND_Y everywhere.
 *   - rolling (plains, forest) continues as fbm noise beyond the plan edges.
 *   - sunken (pool, pool-hall, ducks) is a rectangular straight-walled
 *     basin with a flat bottom: full POOL_DEPTH inside the water rectangle
 *     (see waterRectFor), GROUND_Y outside it, no rim slope. The only
 *     softening is the doorway entrance funnel below.
 * The entrance funnel (a 2.4m-wide strip at the doorway, flattened so the
 * player can always walk in) applies to every ground kind — for sunken it
 * matters on small tiers, where the basin rim would otherwise cross the
 * threshold.
 *
 * The returned height is ABSOLUTE local y: it includes the GROUND_Y lift
 * above the corridor floor (top at y = 0), so the seam at the doorway can
 * never be coplanar with the corridor floor.
 *
 * A value-noise field is constructed per call; the permutation shuffle is
 * cheap (256 entries), but callers doing heavy work should batch their
 * samples rather than call this per frame per vertex.
 */

import { createValueNoise2D, fbm } from "./noise";
import { smoothstep } from "./math";
import { ARCHETYPES } from "./space-types";
import type { SpaceRecipe } from "./space-types";
import { DOOR_GAP_HALF, ENTRANCE_DEPTH } from "./tuning/room";

/** Ground lift above the corridor floor (top at y = 0). */
export const GROUND_Y = 0.02;
/** Rolling terrain peak-to-mean amplitude in meters. */
const ROLLING_AMPLITUDE = 1.2;
/** Rolling noise frequency: ~1 sample per 11m before octaves. */
const ROLLING_FREQUENCY = 0.09;
const ROLLING_OCTAVES = 4;
/** Sunken basin depth in meters — every sunken room is a rectangular
 *  straight-walled pool with a flat bottom this far below GROUND_Y.
 *  Exported as the SINGLE definition of the basin shape: the water
 *  material (materials/water-surface.ts) rebuilds the water depth from
 *  this constant plus waterRectFor, so geometry and shading can never
 *  drift apart. */
export const POOL_DEPTH = 1.6;

/**
 * Terrain flattening mask at the doorway: 1 everywhere except a funnel
 * around the door axis near the wall, where it falls to 0. The funnel
 * reads the shared doorway clearance constants (tuning/room.ts).
 */
function entranceMask(localX: number, localZ: number): number {
  return Math.max(
    smoothstep(DOOR_GAP_HALF, DOOR_GAP_HALF + 1, Math.abs(localX)),
    smoothstep(ENTRANCE_DEPTH, ENTRANCE_DEPTH + 2.5, localZ),
  );
}

/** Water rectangle in space-local coords (cx/cz center, half extents). */
export interface WaterRect {
  cx: number;
  cz: number;
  halfX: number;
  halfZ: number;
}

/**
 * Water rectangle for a recipe: covers the archetype's waterCoverage area
 * fraction, always leaves a walkable deck (≥3m on M+ tiers, 2m on S) on
 * every side, and is centered along z at the archetype's waterCenter
 * fraction (beach pushes the shore toward the far wall). Returns null for
 * dry rooms. The sunken basin, the water plane, and prop water-avoidance
 * all derive from this one rectangle.
 */
export function waterRectFor(recipe: SpaceRecipe): WaterRect | null {
  const { extent, width } = planDims(recipe);
  const coverage = ARCHETYPES[recipe.archetype].waterCoverage;
  if (coverage <= 0) return null;
  const deck = extent >= 32 ? 3 : 2;
  const base = extent * Math.sqrt(coverage);
  const halfZ = Math.max(1, Math.min(base, extent - deck * 2) / 2);
  const halfX = Math.max(1, Math.min(base, width - deck * 2) / 2);
  const center = ARCHETYPES[recipe.archetype].waterCenter;
  const cz = Math.min(
    Math.max(extent * center, halfZ + deck),
    extent - halfZ - deck,
  );
  return { cx: 0, cz, halfX, halfZ };
}

/**
 * LEGACY square water side (the z-side length of the water rectangle),
 * kept so existing consumers that assume a square, z-centered water area
 * (game-canvas's wade-depth check) keep working: centered rooms (pool,
 * lake, ducks, pool-hall — every sunken room) are exact, and offset-water
 * rooms (beach, ocean) only affect a forgiving gameplay depth clamp. New
 * code should use waterRectFor.
 */
export function waterSideFor(recipe: SpaceRecipe): number {
  const rect = waterRectFor(recipe);
  return rect ? rect.halfZ * 2 : 0;
}

/** Plan dims helper: width (x span) and extent (z depth). */
function planDims(recipe: SpaceRecipe): { extent: number; width: number } {
  return { extent: recipe.size.extent, width: recipe.width };
}

/**
 * Absolute terrain height (local y, GROUND_Y included) at a space-local
 * position. Pure, total, and deterministic: the same recipe and coordinates
 * always yield the same height, on any machine, for any coordinates —
 * inside or outside the floor plan (see module doc for outside behavior).
 */
export function terrainHeight(
  recipe: SpaceRecipe,
  localX: number,
  localZ: number,
): number {
  const spec = ARCHETYPES[recipe.archetype];
  let height = 0;
  if (spec.ground === "rolling") {
    const noise = createValueNoise2D(recipe.layoutSeed);
    height =
      fbm(
        noise,
        localX * ROLLING_FREQUENCY,
        localZ * ROLLING_FREQUENCY,
        ROLLING_OCTAVES,
      ) *
      ROLLING_AMPLITUDE *
      entranceMask(localX, localZ);
  } else if (spec.ground === "sunken") {
    const rect = waterRectFor(recipe);
    if (rect) {
      // Straight walls, flat bottom: full depth inside the water
      // rectangle, deck level outside it. The entrance funnel is the one
      // softening, so the player can always walk in at the doorway.
      const inside =
        Math.abs(localX - rect.cx) <= rect.halfX &&
        Math.abs(localZ - rect.cz) <= rect.halfZ;
      if (inside) {
        height = -POOL_DEPTH * entranceMask(localX, localZ);
      }
    }
  }
  return GROUND_Y + height;
}
