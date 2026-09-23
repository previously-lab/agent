/**
 * Room language (v0.11 §3) — pure plan/scale/composition math for the
 * space behind a door. No three.js, no React, no wall clock: every result
 * is a deterministic function of (worldSeed, sliceId) plus the caller's
 * plan dims, so the same memory always rebuilds the same room (axiom A6).
 *
 * THREE ORTHOGONAL FACETS, each drawn from its own hash-derived stream:
 *
 *   scale  — the room's scale notation. v0.13 尺度收敛 retired the tier
 *            draw: every room is the ONE human-scale tier (×1 — the giant
 *            city is gone, user "移除巨人城"). The draw machinery stays
 *            (scaleNotationFor's signature, the construction-time scaling
 *            in scaledRecipeFor, the wall-height curve) so every consumer
 *            is untouched, but the factor is now identically 1 and the
 *            "large" of a room is expressed by joining MORE standard
 *            modules (room-modules.ts §8.3), never by enlarging one. The
 *            DOOR never scales (axiom A4: the human-scale anchor) — the
 *            doorway is built outside the scaled dims.
 *
 *   plan   — the floor-plan silhouette: rect (the legacy rectangle),
 *            l-shape (the rectangle narrows to one half past a seeded
 *            step) or colonnade (rectangle whose side walls are replaced
 *            by open column bays). The entrance wall and its 2.4m doorway
 *            gap are structurally identical on every plan — the door
 *            handoff is untouchable. S tiers stay rectangular: an L on a
 *            16m room would cramp its kept leg into a corridor, and
 *            cramped oppression is a hard-banned anti-pattern (§1).
 *
 *   composition — replaces uniform scatter with three authored rules:
 *            (a) one hero element in the far third of the room (the thing
 *            you see when you walk in), (b) a cleared walk path from the
 *            door to the hero, (c) clustered placement — props group
 *            around seeded cluster centers instead of drawing independent
 *            uniform positions, with a small lone-draw fraction so a
 *            solitary tree still reads as placed.
 *
 * SEEDING. seed.ts's SeedKey union is owned elsewhere, so this module
 * derives its streams by calling hashString directly with the same
 * `${worldSeed}:${sliceId}:${key}` convention and keys "scale" / "plan" /
 * "compose" — independent of, and never perturbing, the existing streams.
 */
import { createRng, hashString, WORLD_SEED } from "./seed";
import { compositionForRecipe } from "./room-modules";
import type { SpaceRecipe } from "./space-types";
import {
  CLUSTER_COUNT_BASE,
  CLUSTER_COUNT_SPAN,
  CLUSTER_RADIUS_MIN,
  CLUSTER_RADIUS_SPAN,
  DOOR_GAP_HALF,
  HERO_X_SPAN,
  HERO_Z_MIN,
  HERO_Z_SPAN,
  L_STEP_MIN,
  L_STEP_SPAN,
  PATH_HALF,
  PLAN_L_PROB,
  PLAN_NONRECT_MIN_EXTENT,
  PLAN_RECT_PROB,
  PORTAL_HEIGHT,
  ROOM_WALL_THICKNESS,
  WALL_HEIGHT_MAX,
  WALL_HEIGHT_MIN,
  WALL_PORTAL_MARGIN,
  WALL_SCALE_EXP,
} from "./tuning/room";
import { WALL_HEIGHT } from "./hotel";

/** Derive this module's stream for one facet of one space. */
function facetRng(worldSeed: string, sliceId: string, key: string) {
  return createRng(hashString(`${worldSeed}:${sliceId}:${key}`));
}

/* ------------------------------------------------------------------ */
/* Scale notation                                                      */
/* ------------------------------------------------------------------ */

export type ScaleId = "normal";

export interface ScaleNotation {
  id: ScaleId;
  /** Construction-time multiplier for plan dims and prop sizes (1 = human). */
  factor: number;
}

/**
 * The room's scale notation. v0.13 尺度收敛: the tier draw is retired —
 * every room is the single human-scale tier (×1), deterministically, with
 * no stream draw (the "scale" stream simply goes unread; it is this
 * facet's own stream, so nothing else is perturbed). "Large" is expressed
 * by joining more standard modules, never by scaling a room (user:
 * 移除巨人城 — a giant floor with nine pieces of furniture read as a bug).
 */
export function scaleNotationFor(
  sliceId: string,
  worldSeed: string = WORLD_SEED,
): ScaleNotation {
  void sliceId;
  void worldSeed;
  return { id: "normal", factor: 1 };
}

/**
 * Recipe view with scale applied to the plan dims (width / size.extent),
 * everything else untouched. terrainHeight / waterRectFor / clampToSpace
 * all read dims off the recipe, so feeding them THIS view keeps the
 * renderer, the avatar physics, and the movement clamp in one (scaled)
 * coordinate system. Normal-scale rooms get the identity view.
 *
 * MODULAR ROOMS (v0.11-room-interiors §8): for interior rooms the plan dims
 * come from the slice's MODULE COMPOSITION (room-modules.ts
 * compositionForRecipe — "large" is MORE modules, never a bigger tier),
 * scaled like any other dims. The composition is a pure function of the
 * recipe PLUS the caller's strand-door count (§8.4 — the composition grows
 * by content; default 0 = a doorless derivation, byte-for-byte the old
 * behaviour), so the renderer and the movement clamp derive the same room
 * by passing the SAME count — the integrator freezes it per visit in the
 * ActiveSpace. Rooms the catalogue cannot serve (every non-interior class
 * today) keep the tier dims byte-for-byte.
 */
export function scaledRecipeFor(recipe: SpaceRecipe, roomDoorCount: number = 0): {
  recipe: SpaceRecipe;
  scale: ScaleNotation;
} {
  const scale = scaleNotationFor(recipe.sliceId);
  const composition = compositionForRecipe(recipe, WORLD_SEED, roomDoorCount);
  const baseWidth = composition ? composition.width : recipe.width;
  const baseExtent = composition ? composition.extent : recipe.size.extent;
  if (scale.factor === 1 && !composition) return { recipe, scale };
  return {
    scale,
    recipe: {
      ...recipe,
      width: baseWidth * scale.factor,
      size: { ...recipe.size, extent: baseExtent * scale.factor },
    },
  };
}

/** Vertical-architecture size at room scale S: walls (and colonnade
 *  columns) scale sub-linearly, clamped to a legible range. v0.13 draws
 *  only factor ×1, so this is the identity path (WALL_HEIGHT in, 4m out);
 *  the curve and its rails stay so the factor pipeline remains total. The
 *  floor never drops below PORTAL_HEIGHT + WALL_PORTAL_MARGIN: the door
 *  never scales (A4), so even the smallest room's walls must contain its
 *  doorway — below factor ~0.77 the floor would bind instead of the
 *  curve. */
export function scaledWallHeight(factor: number): number {
  const h = WALL_HEIGHT * Math.pow(factor, WALL_SCALE_EXP);
  const floor = Math.max(WALL_HEIGHT_MIN, PORTAL_HEIGHT + WALL_PORTAL_MARGIN);
  return Math.min(WALL_HEIGHT_MAX, Math.max(floor, h));
}

/* ------------------------------------------------------------------ */
/* Plan                                                                */
/* ------------------------------------------------------------------ */

export type PlanId = "rect" | "l-shape" | "colonnade";

/**
 * The floor plan, in the space's canonical local frame (doorway at
 * (0, 0), +z outward, x centered on the door axis). `width`/`extent` are
 * the SCALED bounding dims the caller already multiplied by the scale
 * factor — the plan is drawn after scaling so every facet agrees.
 */
export interface RoomPlan {
  id: PlanId;
  width: number;
  extent: number;
  /** l-shape: which half the plan keeps beyond the step (+1 = +x, −1 = −x). */
  lSide: 1 | -1;
  /** l-shape: z where the plan narrows (0 on other plans). */
  stepZ: number;
  /** colonnade: column centers along each side wall line (empty otherwise). */
  columns: { x: number; z: number }[];
}

/** The plan a layout template (v0.11-room-interiors §7) is built on. When
 *  supplied, the template DECLARES the silhouette instead of drawing it
 *  from the probability table; the seeded parameters of that silhouette
 *  (l-shape side/step) still come from the "plan" stream, so the same
 *  slice under the same template always gets the same plan (A6). */
export interface TemplatePlan {
  plan: PlanId;
}

/** Column centers for a colonnade of the given dims: along both side wall
 *  lines, first/last bay inset half a bay from the corners so the corner
 *  posts read as piers. Shared by the legacy draw and the template path —
 *  the geometry is owned here, never re-implemented by a template. */
function colonnadeColumns(
  width: number,
  extent: number,
  colonnadeBay: number,
): { x: number; z: number }[] {
  const bay = Math.max(1.2, colonnadeBay);
  const columns: { x: number; z: number }[] = [];
  const halfW = width / 2;
  for (let z = bay / 2; z <= extent - bay / 2 + 1e-6; z += bay) {
    columns.push({ x: -halfW, z });
    columns.push({ x: halfW, z });
  }
  return columns;
}

/**
 * Draw the plan for a space. S tiers are always rect (anti-cramp); on
 * eligible tiers the "plan" stream draws 70% rect / 15% l-shape / 15%
 * colonnade. The entrance wall exists on every plan — see wallSegmentsFor.
 *
 * With a `template` the silhouette is DECLARED, not drawn, and the S-tier
 * guard is bypassed: template selection (room-templates.ts) already enforces
 * the template's minExtent against the UNSCALED tier, and a room whose
 * scaled extent sits below PLAN_NONRECT_MIN_EXTENT still keeps the
 * template's layout. Omitting the parameter reproduces the legacy draw
 * exactly.
 */
export function roomPlanFor(
  sliceId: string,
  width: number,
  extent: number,
  colonnadeBay: number,
  worldSeed: string = WORLD_SEED,
  template?: TemplatePlan,
): RoomPlan {
  const base: RoomPlan = { id: "rect", width, extent, lSide: 1, stepZ: 0, columns: [] };
  if (template) {
    if (template.plan === "rect") return base;
    const rng = facetRng(worldSeed, sliceId, "plan");
    if (template.plan === "l-shape") {
      return {
        ...base,
        id: "l-shape",
        lSide: rng() < 0.5 ? 1 : -1,
        stepZ: extent * (L_STEP_MIN + rng() * L_STEP_SPAN),
      };
    }
    return { ...base, id: "colonnade", columns: colonnadeColumns(width, extent, colonnadeBay) };
  }
  if (extent < PLAN_NONRECT_MIN_EXTENT) return base;
  const rng = facetRng(worldSeed, sliceId, "plan");
  const r = rng();
  if (r < PLAN_RECT_PROB) return base;
  if (r < PLAN_RECT_PROB + PLAN_L_PROB) {
    return {
      ...base,
      id: "l-shape",
      lSide: rng() < 0.5 ? 1 : -1,
      stepZ: extent * (L_STEP_MIN + rng() * L_STEP_SPAN),
    };
  }
  // Colonnade: column centers along both side wall lines, first/last bay
  // inset half a bay from the corners so the corner posts read as piers.
  return { ...base, id: "colonnade", columns: colonnadeColumns(width, extent, colonnadeBay) };
}

/**
 * Walkable-footprint test: is (x, z) inside the plan, shrunk by `margin`
 * from the walls? rect/colonnade fill the bounding box; l-shape drops the
 * abandoned quadrant beyond the step. The doorway strip (|x| <
 * DOOR_GAP_HALF near z = 0) is always inside — the entrance never narrows.
 */
export function planContains(
  plan: RoomPlan,
  x: number,
  z: number,
  margin: number,
): boolean {
  const halfW = plan.width / 2;
  if (Math.abs(x) > halfW - margin) return false;
  if (z < margin || z > plan.extent - margin) return false;
  if (plan.id === "l-shape" && z > plan.stepZ) {
    // Beyond the step only the kept half exists; the margin also clears
    // the step wall itself and the inner wall on the plan's center line.
    if (z < plan.stepZ + margin) return false;
    return plan.lSide > 0 ? x >= margin : x <= -margin;
  }
  return true;
}

/** One perimeter wall segment as an axis-aligned box (footprint only —
 *  the renderer supplies the height). */
export interface WallSegment {
  x: number;
  z: number;
  sizeX: number;
  sizeZ: number;
  /** Entrance-edge segment: built at human thickness to mate with the
   *  corridor wall and the doorway assembly, whatever the room scale. */
  entrance: boolean;
}

/**
 * Perimeter wall segments for a plan. Every plan keeps the entrance edge
 * as two segments split around the 2.4m doorway gap at x = 0, z = 0 —
 * the door handoff is structurally untouchable. Segments overlap corners
 * by `thick` so no seam shows (the legacy rectangle did the same).
 *
 *   rect:      side / side / far + entrance pair (the legacy five).
 *   l-shape:   the full-width near zone keeps both sides; past the step
 *              the kept half gets its own outer side + inner side + far
 *              wall, and a step wall closes the abandoned quadrant.
 *   colonnade: far wall + entrance pair only — the sides are open column
 *              bays (plan.columns), the room opening onto the mist skirt.
 */
export function wallSegmentsFor(
  plan: RoomPlan,
  thick: number,
  entranceThick: number = ROOM_WALL_THICKNESS,
): WallSegment[] {
  const halfW = plan.width / 2;
  const { extent } = plan;
  const entranceLength = halfW - DOOR_GAP_HALF + entranceThick;
  const entranceCenter = DOOR_GAP_HALF + entranceLength / 2;
  const entrancePair: WallSegment[] = [
    { x: -entranceCenter, z: entranceThick / 2, sizeX: entranceLength, sizeZ: entranceThick, entrance: true },
    { x: entranceCenter, z: entranceThick / 2, sizeX: entranceLength, sizeZ: entranceThick, entrance: true },
  ];

  if (plan.id === "l-shape") {
    const step = plan.stepZ;
    const kept = plan.lSide; // +1 keeps +x beyond the step
    const keptCenter = (kept * halfW) / 2;
    const keptHalf = halfW / 2;
    const segs: WallSegment[] = [
      // Near zone (full width): both side walls up to the step.
      { x: -(halfW - thick / 2), z: step / 2, sizeX: thick, sizeZ: step, entrance: false },
      { x: halfW - thick / 2, z: step / 2, sizeX: thick, sizeZ: step, entrance: false },
      // Step wall closing the abandoned quadrant (facing the entrance).
      { x: (-kept * halfW) / 2, z: step + thick / 2, sizeX: halfW + thick, sizeZ: thick, entrance: false },
      // Kept half beyond the step: inner side (at the plan's center line),
      // outer side, far wall.
      { x: (kept * thick) / 2, z: (step + extent) / 2, sizeX: thick, sizeZ: extent - step, entrance: false },
      { x: kept * (halfW - thick / 2), z: (step + extent) / 2, sizeX: thick, sizeZ: extent - step, entrance: false },
      { x: keptCenter, z: extent - thick / 2, sizeX: keptHalf * 2 + thick * 2, sizeZ: thick, entrance: false },
    ];
    return [...entrancePair, ...segs];
  }

  const segs: WallSegment[] = [
    {
      x: 0,
      z: extent - thick / 2,
      sizeX: plan.width + thick * 2,
      sizeZ: thick,
      entrance: false,
    },
  ];
  if (plan.id === "rect") {
    segs.unshift(
      { x: -(halfW - thick / 2), z: extent / 2, sizeX: thick, sizeZ: extent, entrance: false },
      { x: halfW - thick / 2, z: extent / 2, sizeX: thick, sizeZ: extent, entrance: false },
    );
  }
  return [...entrancePair, ...segs];
}

/**
 * A wall segment's role in the room's composition — the vocabulary layout
 * templates (v0.11-room-interiors §7) use to declare which walls may carry
 * doors or features ("never the shelf wall", "the far wall is the door
 * wall"). Classified geometrically, never by segment index, so the roles
 * survive any change to wallSegmentsFor's emission order:
 *
 *   entrance — the entrance pair (owns the corridor doorway; never hosts).
 *   far      — the wall closing the plan at z = extent.
 *   step     — l-shape only: the wall closing the abandoned quadrant.
 *   inner    — l-shape only: the kept leg's inner side, on the center line.
 *   left/right — any full side wall off the center line (the rect's sides,
 *              the l-shape's near-zone sides and kept leg's outer side).
 *
 * Colonnade plans have no side segments at all (open bays), so "left" and
 * "right" simply match nothing there — a template permitting doors on the
 * sides gets the colonnade's far wall only.
 */
export type WallRole = "entrance" | "left" | "right" | "far" | "step" | "inner";

/** The role of one perimeter segment of `plan` (see WallRole). Pure. */
export function wallRoleFor(plan: RoomPlan, wall: WallSegment): WallRole {
  if (wall.entrance) return "entrance";
  const horizontal = wall.sizeZ <= wall.sizeX;
  if (horizontal) {
    // The far wall's outer face sits exactly at z = extent; every other
    // horizontal wall (the l-shape's step wall) lies strictly inside.
    return wall.z + wall.sizeZ / 2 >= plan.extent - 1e-6 ? "far" : "step";
  }
  // Vertical walls: off the center line they are side walls (left = −x);
  // on it (an l-shape's kept-leg inner side) they are the inner wall.
  if (Math.abs(wall.x) > plan.width / 4) return wall.x < 0 ? "left" : "right";
  return "inner";
}

/* ------------------------------------------------------------------ */
/* Composition                                                         */
/* ------------------------------------------------------------------ */

/** The room's staging: where the hero stands, the cleared path to it, and
 *  the cluster centers the scatter groups around. */
export interface Composition {
  /** Focal element position in the far third of the room. */
  hero: { x: number; z: number };
  /** Walk path from the door (0,0) through one seeded bend to the hero. */
  path: { bx: number; bz: number };
  /** Cleared half-width around the path (already scale-adjusted). */
  pathHalf: number;
  /** Cluster centers + radii for grouped scatter (off-path, in-plan). */
  clusters: { x: number; z: number; radius: number }[];
}

/** Point-to-segment distance in the XZ plane. */
function segDist(
  x: number,
  z: number,
  ax: number,
  az: number,
  bx: number,
  bz: number,
): number {
  const dx = bx - ax;
  const dz = bz - az;
  const len2 = dx * dx + dz * dz;
  const t = len2 === 0 ? 0 : Math.min(1, Math.max(0, ((x - ax) * dx + (z - az) * dz) / len2));
  return Math.hypot(x - (ax + t * dx), z - (az + t * dz));
}

/** Shortest distance from (x, z) to the composition's cleared path
 *  (door → bend → hero). */
export function distToPath(comp: Composition, x: number, z: number): number {
  const { path, hero } = comp;
  return Math.min(
    segDist(x, z, 0, 0, path.bx, path.bz),
    segDist(x, z, path.bx, path.bz, hero.x, hero.z),
  );
}

/**
 * Stage a room: hero in the far third (68–85% depth, near the central
 * axis), a two-bend path from the door to the hero kept clear at
 * pathHalf, and 2–3 (+1 on L/XL-scale plans) cluster centers drawn inside
 * the plan off the path. Pure function of the "compose" stream.
 *
 * The path half-width scales by clamp(S, 0.35, 2) — at v0.13's single ×1
 * tier the clamp is the identity and the cleared corridor keeps its 1.4 m
 * half-width in every room; the rails stay so the factor pipeline remains
 * total.
 */
export function composeRoom(
  sliceId: string,
  plan: RoomPlan,
  scaleFactor: number,
  worldSeed: string = WORLD_SEED,
): Composition {
  const rng = facetRng(worldSeed, sliceId, "compose");
  const { width, extent } = plan;
  const halfW = width / 2;
  const pathHalf = PATH_HALF * Math.min(2, Math.max(0.35, scaleFactor));
  const edge = ROOM_WALL_THICKNESS + 1;

  // Hero: far third, inside the kept footprint, biased toward the axis.
  let hero = { x: 0, z: extent * 0.75 };
  for (let tries = 0; tries < 24; tries++) {
    const hx = (rng() * 2 - 1) * halfW * HERO_X_SPAN;
    const hz = extent * (HERO_Z_MIN + rng() * HERO_Z_SPAN);
    if (planContains(plan, hx, hz, edge)) {
      hero = { x: hx, z: hz };
      break;
    }
  }
  if (!planContains(plan, hero.x, hero.z, edge)) {
    // Footprint fallback (an l-shape whose far third sits in the abandoned
    // quadrant): snap to the kept half's center line at the same depth.
    hero = {
      x: plan.id === "l-shape" ? (plan.lSide * halfW) / 2 : 0,
      z: Math.min(hero.z, extent - edge),
    };
  }

  // One seeded bend at ~35% depth, off the door axis, inside the plan.
  let bend = { x: 0, z: extent * 0.35 };
  for (let tries = 0; tries < 24; tries++) {
    const bx = (rng() * 2 - 1) * halfW * 0.4;
    if (planContains(plan, bx, bend.z, edge)) {
      bend = { x: bx, z: bend.z };
      break;
    }
  }

  const comp: Composition = {
    hero,
    path: { bx: bend.x, bz: bend.z },
    pathHalf,
    clusters: [],
  };

  // Cluster centers: grouped placement reads as authored; uniform draws
  // read as noise. Centers keep clear of the path and the hero (the hero
  // owns its clearing), and sit inside the walkable footprint.
  const count =
    CLUSTER_COUNT_BASE +
    Math.floor(rng() * CLUSTER_COUNT_SPAN) +
    (extent >= 64 ? 1 : 0);
  for (let i = 0; i < count; i++) {
    const radius =
      (CLUSTER_RADIUS_MIN + rng() * CLUSTER_RADIUS_SPAN) *
      Math.sqrt(Math.max(scaleFactor, 0.35));
    for (let tries = 0; tries < 24; tries++) {
      const cx = (rng() * 2 - 1) * Math.max(1, halfW - edge - radius);
      const cz = edge + radius + rng() * Math.max(1, extent - (edge + radius) * 2);
      if (!planContains(plan, cx, cz, edge)) continue;
      if (distToPath(comp, cx, cz) < pathHalf + radius) continue;
      if (Math.hypot(cx - hero.x, cz - hero.z) < radius + 3) continue;
      comp.clusters.push({ x: cx, z: cz, radius });
      break;
    }
  }
  return comp;
}
