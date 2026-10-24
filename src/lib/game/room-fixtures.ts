/**
 * Room fixtures resolver (2026-10 realism lane) — the PURE replacement
 * for space.tsx's buildRoomFixtures: decides the room's motivated
 * fixtures (the lamp, the window, the clerestory) from what the room
 * REALLY contains — the staged furniture's oriented boxes, the authored
 * building openings (glass wall spans, architectural windows), and the
 * light sources already standing in the furniture (floorlamp / desk
 * lamp / module sconces).
 *
 * WHY THIS MODULE EXISTS. The old in-renderer builder sampled POINTS
 * and ignored the staged furniture: a generic lamp could land inside a
 * staged sofa, a window could hang behind a bookshelf, and a failed
 * candidate fell back to an ILLEGAL position (the midpoint beside the
 * path bend) rather than to nothing. Here every rule is geometry over
 * the prop OBBs (prop-geometry.ts):
 *
 *  LAMP — every physical OBB, every door approach, the water, the
 *     entrance, and the cleared path (pathHalf + the lamp's REAL disc
 *     radius + margin — never relaxed in a second pass) must all be
 *     clear; when no candidate survives the lamp is NONE, not a
 *     fallback point. When the furniture already carries a light
 *     (a floorlamp / desk lamp piece, or a module sconce), the
 *     resolution is REUSE — space.tsx adds the real light to that
 *     source instead of growing a second lamp model.
 *  WINDOW — fills the gap, never stacks: an authored glass span or
 *     window turns the generic window to null. Otherwise the host is a
 *     full-height, non-entrance, non-camera, non-feature wall (the
 *     vertical walls first — §10.5 gives east/west to light), the
 *     frame's REAL width (WINDOW_WIDTH·wallScale + frame) must fit a
 *     legal interval between corners, doors, the entrance gap and
 *     every other opening's frame, and the window's clearance zone
 *     (frame range + ~0.9·propScale into the room) must be free of any
 *     tall furniture whose top reaches the sill — low pieces may stand
 *     under the window. Every candidate wall is tried; a small room
 *     with no legal spot gets NO window.
 *  CLERESTORY — the same discipline one register up: it avoids the
 *     generic window's frame and every authored opening's frame,
 *     prefers a different wall (two sources, two directions), and is
 *     null when nothing legal remains.
 *
 * DETERMINISM. Same inputs + the same caller-supplied rng stream ⇒ the
 * same result (A6). The resolver never touches the furniture stream and
 * never creates a stream of its own.
 *
 * Pure module: no three.js, no React, no wall clock.
 */

import {
  planContains,
  distToPath,
  type Composition,
  type RoomPlan,
  type WallSegment,
} from "./room-plan";
import {
  wallFacesCamera,
  type RoomDoorPlacement,
} from "./room-doors";
import {
  makeObb,
  obbCorners,
  obbIntersectsRect,
  obbsIntersect,
  type PlanRect,
  type PropObb,
} from "./prop-geometry";
import {
  CLERESTORY_DROP,
  CLERESTORY_END_PAD,
  CLERESTORY_HEIGHT,
  CLERESTORY_UNIT,
  DOOR_GAP_HALF,
  DOOR_WIDTH,
  ENTRANCE_CLEAR_RADIUS,
  ENTRANCE_DEPTH,
  ROOM_DOOR_CLEAR_DEPTH,
  ROOM_DOOR_CLEAR_HALF,
  ROOM_WALL_THICKNESS,
  WALL_SILL_HEIGHT,
  WINDOW_DOOR_CLEAR,
  WINDOW_HEIGHT,
  WINDOW_SILL_Y,
  WINDOW_WIDTH,
} from "./tuning/room";
import { subtractIntervals } from "./shelf-wall";

/* ------------------------------------------------------------------ */
/* Constants (the resolver's own discipline)                           */
/* ------------------------------------------------------------------ */

/** Frame margin around the window's glass width (m, ×wallScale inside). */
export const WINDOW_FRAME_EXTRA = 0.3;
/** A window candidate's center keeps this far from the host run's ends
 *  (m, scaled with the frame by the caller's wall scale — here plain
 *  meters on the already-scaled wall). */
export const WINDOW_END_PAD = 1;
/** The window's clearance reach INTO the room (× propScale): the frame
 *  range plus this depth must hold no tall furniture. */
export const WINDOW_CLEAR_DEPTH_RATIO = 0.9;
/** The generic lamp's REAL footprint: the shade's radius (space.tsx's
 *  RoomLamp cone r 0.42, × propScale in the group) — not the base
 *  disc's. */
export const GENERIC_LAMP_RADIUS = 0.42;
/** The generic lamp's body height (shade top, m × propScale). */
export const GENERIC_LAMP_HEIGHT = 2.25;
/** Extra path margin beside the lamp's own bounding radius (× propScale)
 *  — the old first-pass margin, kept for every pass now. */
export const LAMP_PATH_MARGIN_RATIO = 0.3;
/** Water margin around a lamp candidate (× propScale). */
export const LAMP_WATER_MARGIN_RATIO = 0.6;
/** Rejection-sampling budget per fixture (the old builder's 24/16). */
export const LAMP_TRIES = 24;
/** A clerestory band keeps this gap from the generic window's frame
 *  (m, unscaled — a real frame gap, like the window's own margins). */
export const CLERESTORY_WINDOW_GAP = 0.3;

/* ------------------------------------------------------------------ */
/* Inputs                                                              */
/* ------------------------------------------------------------------ */

/** A rectangle along one wall's run, INCLUDING its frame — an authored
 *  building opening the generic fixtures must never double or touch.
 *  `along0/along1` are offsets from the wall segment's center along
 *  its run; both edges carry the frame already. */
export interface AuthoredOpening {
  /** Index into the `walls` array passed alongside. */
  wall: number;
  along0: number;
  along1: number;
}

export interface FixtureOpenings {
  /** The composition's glass wall spans (GlassWallSpan runs). */
  glassSpans?: readonly AuthoredOpening[];
  /** Authored architectural windows (the same register as the generic
   *  window — their presence turns the generic one to null). */
  windows?: readonly AuthoredOpening[];
  /** An authored clerestory band (outdoor sets). */
  clerestories?: readonly AuthoredOpening[];
}

/** A light source already standing in the room's furniture or module
 *  layer — a staged floorlamp/desk lamp piece (y = its base, a host
 *  top for a desk lamp riding a desk), or a module sconce (y = its
 *  plate height). */
export interface ExistingLight {
  kind: "floorlamp" | "desklamp" | "sconce";
  x: number;
  z: number;
  y: number;
  scale: number;
}

export interface FixtureWater {
  cx: number;
  cz: number;
  halfX: number;
  halfZ: number;
}

export interface RoomFixtureInput {
  plan: RoomPlan;
  comp: Composition;
  walls: readonly WallSegment[];
  wallHeight: number;
  /** The room's orientation (south doors mirror the plan frame). */
  dir: 1 | -1;
  water: FixtureWater | null;
  /** Strand doors (indexed into `walls`). */
  doors: readonly RoomDoorPlacement[];
  propScale: number;
  wallScale: number;
  hasClerestory: boolean;
  /** The staged furniture's OBBs (propObbsForPieces) — what the
   *  fixtures must clear. */
  props: readonly PropObb[];
  /** The authored building openings (already frame-inclusive). */
  openings: FixtureOpenings;
  /** Light sources already present. */
  lights: readonly ExistingLight[];
  /** Source wall indices hosting a wall feature (niche, pilaster,
   *  arch, columns, platform, mezzanine) — and therefore closed to
   *  the generic window. */
  featureSources: ReadonlySet<number>;
  /** The fixture stream — the caller's INDEPENDENT rng (space.tsx's
   *  "fixtures" stream). The only stream this resolver consumes. */
  rng: () => number;
}

/* ------------------------------------------------------------------ */
/* Outputs                                                             */
/* ------------------------------------------------------------------ */

export type LampResolution =
  | {
      kind: "generic";
      x: number;
      z: number;
    }
  | {
      kind: "reuse";
      source: "floorlamp" | "desklamp" | "sconce";
      x: number;
      z: number;
      y: number;
      scale: number;
    }
  | { kind: "none" };

export interface WindowResolution {
  /** Index into `walls`. */
  wall: number;
  /** Window center along the host's run (from the segment center). */
  along: number;
  /** Inward unit normal (probed with planContains). */
  nx: number;
  nz: number;
  thick: number;
  drawnHeight: number;
  /** The glass's vertical span (sill..sill+height, capped at the wall's
   *  drawn top) — the shelf wall cuts around THIS, not around an
   *  infinitely tall hole. */
  bottom: number;
  top: number;
  /** The host run's length. */
  len: number;
  /** The frame's FULL width (glass + frame margin), as reserved. */
  width: number;
}

export interface ClerestoryResolution {
  wall: number;
  along: number;
  nx: number;
  nz: number;
  thick: number;
  drawnHeight: number;
  /** The band's vertical span (drop+height below the wall top..drop
   *  below the top) — the shelf wall and the renderer share it. */
  bottom: number;
  top: number;
  len: number;
}

export interface RoomFixtureResult {
  lamp: LampResolution;
  window: WindowResolution | null;
  clerestory: ClerestoryResolution | null;
}

/* ------------------------------------------------------------------ */
/* Wall helpers                                                        */
/* ------------------------------------------------------------------ */

function wallRun(wall: WallSegment): {
  horizontal: boolean;
  len: number;
  thick: number;
} {
  const horizontal = wall.sizeZ <= wall.sizeX;
  return {
    horizontal,
    len: horizontal ? wall.sizeX : wall.sizeZ,
    thick: horizontal ? wall.sizeZ : wall.sizeX,
  };
}

/** The wall's inward unit normal, probed with planContains (the same
 *  probe inwardNormal uses — walls are axis-aligned, so the answer is
 *  exactly one of the four unit directions). */
function inwardNormal(
  plan: RoomPlan,
  wall: WallSegment,
  x: number,
  z: number,
): { nx: number; nz: number } {
  if (wall.sizeZ <= wall.sizeX) {
    return { nx: 0, nz: planContains(plan, x, z + 0.5, 0) ? 1 : -1 };
  }
  return { nx: planContains(plan, x + 0.5, z, 0) ? 1 : -1, nz: 0 };
}

/** The drawn height a fixture on this wall inherits: a full-height wall
 *  gets the room's wall height, a cutaway sill the sill height. */
function drawnHeightFor(
  plan: RoomPlan,
  wall: WallSegment,
  dir: number,
  wallHeight: number,
): number {
  return wall.entrance || !wallFacesCamera(plan, wall, dir)
    ? wallHeight
    : Math.min(wallHeight, WALL_SILL_HEIGHT);
}

/** Wall thickness for clearance margins (the perimeter's own). */
function perimeterThick(walls: readonly WallSegment[]): number {
  let thick = ROOM_WALL_THICKNESS;
  for (const w of walls) {
    if (!w.entrance) thick = Math.max(thick, Math.min(w.sizeX, w.sizeZ));
  }
  return thick;
}

function authoredOn(
  openings: FixtureOpenings,
  wallIndex: number,
): { along0: number; along1: number }[] {
  const out: { along0: number; along1: number }[] = [];
  for (const list of [
    openings.glassSpans ?? [],
    openings.windows ?? [],
    openings.clerestories ?? [],
  ]) {
    for (const o of list) {
      if (o.wall === wallIndex) out.push({ along0: o.along0, along1: o.along1 });
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Geometric predicates (exported for the tests)                       */
/* ------------------------------------------------------------------ */

/** The window frame's half-width on an already-scaled wall. */
export function windowFrameHalf(wallScale: number): number {
  return (WINDOW_WIDTH * wallScale + WINDOW_FRAME_EXTRA) / 2;
}

/** The window glass's REAL vertical span on a wall drawn at
 *  `drawnHeight` — the RoomWindow formula VERBATIM (space.tsx), so the
 *  resolver, the renderer, and the shelf wall cut around one shared
 *  rectangle:
 *    h      = min(WINDOW_HEIGHT·ws,  max(0.6, drawnHeight − 0.4))
 *    bottom = min(WINDOW_SILL_Y·ws, max(0.15, drawnHeight − h − 0.15))
 *    top    = bottom + h */
export function windowVerticalSpan(
  drawnHeight: number,
  wallScale: number,
): { bottom: number; top: number } {
  const h = Math.min(WINDOW_HEIGHT * wallScale, Math.max(0.6, drawnHeight - 0.4));
  const bottom = Math.min(
    WINDOW_SILL_Y * wallScale,
    Math.max(0.15, drawnHeight - h - 0.15),
  );
  return { bottom, top: bottom + h };
}

/** The clerestory band's REAL vertical span — the RoomClerestory formula
 *  VERBATIM (space.tsx):
 *    bandH  = min(CLERESTORY_HEIGHT·ws, max(0.4, drawnHeight·0.5))
 *    bandY  = max(bandH/2 + 0.1, drawnHeight − CLERESTORY_DROP·ws − bandH/2)
 *    bottom = bandY − bandH/2;  top = bandY + bandH/2 */
export function clerestoryVerticalSpan(
  drawnHeight: number,
  wallScale: number,
): { bottom: number; top: number } {
  const bandH = Math.min(
    CLERESTORY_HEIGHT * wallScale,
    Math.max(0.4, drawnHeight * 0.5),
  );
  const bandY = Math.max(
    bandH / 2 + 0.1,
    drawnHeight - CLERESTORY_DROP * wallScale - bandH / 2,
  );
  return { bottom: bandY - bandH / 2, top: bandY + bandH / 2 };
}

/**
 * The legal center intervals for a window on one wall: between the
 * corners (frame half + end pad), the entrance gap (on the entrance
 * pair), every strand door's frame-plus-clearance, and every authored
 * opening's frame (expanded by this window's own frame half). Returns
 * the empty list when the wall cannot hold the frame legally — a
 * candidate must come from a REAL interval, never from a failed one's
 * unconditional center.
 */
export function legalWindowIntervals(
  wall: WallSegment,
  wallIndex: number,
  frameHalf: number,
  doors: readonly RoomDoorPlacement[],
  openings: FixtureOpenings,
): [number, number][] {
  const { len } = wallRun(wall);
  let intervals: [number, number][] = [
    [-len / 2 + frameHalf + WINDOW_END_PAD, len / 2 - frameHalf - WINDOW_END_PAD],
  ];
  const cut = (lo: number, hi: number): void => {
    const next: [number, number][] = [];
    for (const [a, b] of intervals) {
      if (hi <= a || lo >= b) {
        next.push([a, b]);
        continue;
      }
      if (lo > a) next.push([a, Math.min(lo, b)]);
      if (hi < b) next.push([Math.max(hi, a), b]);
    }
    intervals = next.filter(([a, b]) => b - a > 1e-4);
  };
  if (wall.entrance) {
    // The doorway gap sits at WORLD x = 0 — on an entrance flank the
    // wall-local along of that axis is −wall.x (the flanks are off-
    // center segments), NOT 0. Cutting around 0 would guard the
    // segment's middle, a meaningless point.
    const gapCenter = wall.sizeZ <= wall.sizeX ? -wall.x : -wall.z;
    const gapHalf = DOOR_GAP_HALF + frameHalf + 0.6;
    cut(gapCenter - gapHalf, gapCenter + gapHalf);
  }
  const doorHalf = frameHalf + DOOR_WIDTH / 2 + WINDOW_DOOR_CLEAR;
  for (const d of doors) {
    if (d.wall !== wallIndex) continue;
    cut(d.along - doorHalf, d.along + doorHalf);
  }
  for (const o of authoredOn(openings, wallIndex)) {
    cut(o.along0 - frameHalf, o.along1 + frameHalf);
  }
  // The base interval itself may be inverted (a wall shorter than frame
  // + pads) — validate it even when no cut ever ran.
  return intervals.filter(([a, b]) => b - a > 1e-4);
}

/** The window's clearance zone in plan coordinates: the frame's
 *  along-range on the wall, reaching `depth` meters INTO the room from
 *  the wall's inner face. Any tall furniture intersecting this rect
 *  blocks the candidate. */
export function windowZoneRect(
  plan: RoomPlan,
  wall: WallSegment,
  along: number,
  frameHalf: number,
  depth: number,
): PlanRect {
  const { horizontal, thick } = wallRun(wall);
  const { nx, nz } = inwardNormal(
    plan,
    wall,
    horizontal ? wall.x + along : wall.x,
    horizontal ? wall.z : wall.z + along,
  );
  const wx = horizontal ? wall.x + along : wall.x;
  const wz = horizontal ? wall.z : wall.z + along;
  const faceX = horizontal ? wx : wall.x + nx * (thick / 2);
  const faceZ = horizontal ? wall.z + nz * (thick / 2) : wz;
  const inX = faceX + nx * depth;
  const inZ = faceZ + nz * depth;
  return {
    x0: horizontal ? wx - frameHalf : Math.min(faceX, inX),
    x1: horizontal ? wx + frameHalf : Math.max(faceX, inX),
    z0: horizontal ? Math.min(faceZ, inZ) : wz - frameHalf,
    z1: horizontal ? Math.max(faceZ, inZ) : wz + frameHalf,
  };
}

/** Does any BLOCKING prop intersect the zone AND the window's real
 *  vertical span? Low furniture whose top stays under the glass may
 *  stand under the window; a hung wallart whose y-range crosses the
 *  glass blocks it; walkable planes and tabletop dressing never
 *  block. */
export function propBlocksWindowZone(
  props: readonly PropObb[],
  zone: PlanRect,
  winBottom: number,
  winTop: number,
): boolean {
  return props.some(
    (p) =>
      p.blocks &&
      p.topY >= winBottom - 1e-6 &&
      p.baseY <= winTop + 1e-6 &&
      obbIntersectsRect(p, zone),
  );
}

/** Footprint containment: are ALL FOUR of the OBB's corners inside the
 *  plan (shrunk by `margin`)? A rotated prop whose center sits inside
 *  but whose corner pokes past an l-shape's step wall fails — the
 *  center-point test alone would pass it. (Lives here, not in
 *  prop-geometry, to keep that module free of the room-plan import —
 *  kits.ts depends on it.) */
export function planContainsObb(
  plan: RoomPlan,
  o: PropObb,
  margin: number,
): boolean {
  return obbCorners(o).every((c) => planContains(plan, c.x, c.z, margin));
}

/* ------------------------------------------------------------------ */
/* Lamp                                                                */
/* ------------------------------------------------------------------ */

/** The generic lamp's body at a candidate spot: a square OBB the shade
 *  really sweeps (half-extent GENERIC_LAMP_RADIUS·propScale on both
 *  axes — rotation-free, so axes are the plan's). */
export function genericLampObbAt(x: number, z: number, propScale: number): PropObb {
  const r = GENERIC_LAMP_RADIUS * propScale;
  return makeObb({
    cx: x,
    cz: z,
    ux: 1,
    uz: 0,
    hx: r,
    vx: 0,
    vz: 1,
    hz: r,
    baseY: 0,
    topY: GENERIC_LAMP_HEIGHT * propScale,
    kind: "generic-lamp",
  });
}

/** The conservative bounding radius of the scaled lamp body — the
 *  half-diagonal of its square footprint (hypot(hx, hz)). */
export function lampBoundingRadius(propScale: number): number {
  const r = GENERIC_LAMP_RADIUS * propScale;
  return Math.hypot(r, r);
}

/** One strand door's approach strip as an OBB: the rectangle reaching
 *  ROOM_DOOR_CLEAR_DEPTH inward from the wall plane, ROOM_DOOR_CLEAR_HALF
 *  to each side (inDoorApproach's strip, as a body the lamp can
 *  intersect). */
function doorApproachObb(d: RoomDoorPlacement): PropObb {
  return makeObb({
    cx: d.x + (d.nx * ROOM_DOOR_CLEAR_DEPTH) / 2,
    cz: d.z + (d.nz * ROOM_DOOR_CLEAR_DEPTH) / 2,
    ux: -d.nz,
    uz: d.nx,
    hx: ROOM_DOOR_CLEAR_HALF,
    vx: d.nx,
    vz: d.nz,
    hz: ROOM_DOOR_CLEAR_DEPTH / 2,
    kind: "door-approach",
  });
}

/**
 * The generic-lamp clearance predicate — pure, so a test can probe a
 * FAILING candidate directly instead of hoping the sampler stumbles on
 * it. The lamp's scaled OBB must:
 *   1. keep all four corners inside the plan (margin: wall thickness +
 *      0.65·propScale),
 *   2. miss the entrance rectangle (|x| < ENTRANCE_CLEAR_RADIUS out to
 *      ENTRANCE_DEPTH),
 *   3. miss every strand door's approach strip OBB,
 *   4. miss the water rectangle plus 0.6·propScale,
 *   5. keep the cleared path: distToPath ≥ pathHalf + the lamp's
 *      bounding radius + 0.3·propScale (never relaxed),
 *   6. miss every blocking furniture OBB.
 */
export function lampCandidateClear(
  plan: RoomPlan,
  comp: Composition,
  water: FixtureWater | null,
  doors: readonly RoomDoorPlacement[],
  props: readonly PropObb[],
  x: number,
  z: number,
  propScale: number,
  wallThick: number = ROOM_WALL_THICKNESS,
): boolean {
  const obb = genericLampObbAt(x, z, propScale);
  if (!planContainsObb(plan, obb, wallThick + 0.65 * propScale)) return false;
  if (
    obbIntersectsRect(obb, {
      x0: -ENTRANCE_CLEAR_RADIUS,
      z0: -2,
      x1: ENTRANCE_CLEAR_RADIUS,
      z1: ENTRANCE_DEPTH,
    })
  ) {
    return false;
  }
  for (const d of doors) {
    if (obbsIntersect(obb, doorApproachObb(d))) return false;
  }
  if (water) {
    const m = LAMP_WATER_MARGIN_RATIO * propScale;
    if (
      obbIntersectsRect(obb, {
        x0: water.cx - water.halfX - m,
        z0: water.cz - water.halfZ - m,
        x1: water.cx + water.halfX + m,
        z1: water.cz + water.halfZ + m,
      })
    ) {
      return false;
    }
  }
  if (
    distToPath(comp, x, z) <
    comp.pathHalf + lampBoundingRadius(propScale) + LAMP_PATH_MARGIN_RATIO * propScale
  ) {
    return false;
  }
  return !props.some((p) => p.blocks && obbsIntersect(obb, p));
}

function resolveLamp(input: RoomFixtureInput): LampResolution {
  // REUSE: the furniture already carries a light — prefer a real lamp
  // model (floor lamp first, then the desk lamp), then a sconce. Space
  // grows the actual light on THAT source, never a second lamp model.
  for (const kind of ["floorlamp", "desklamp", "sconce"] as const) {
    const l = input.lights.find((q) => q.kind === kind);
    if (l) {
      return { kind: "reuse", source: l.kind, x: l.x, z: l.z, y: l.y, scale: l.scale };
    }
  }

  // GENERIC: one strict pass, every candidate an OBB clearance test.
  const { rng, plan, comp, propScale } = input;
  const { width, extent } = plan;
  const thick = perimeterThick(input.walls);
  const bound = lampBoundingRadius(propScale);
  const margin = thick + 0.65 * propScale;
  for (let tries = 0; tries < LAMP_TRIES; tries++) {
    const x = (rng() * 2 - 1) * Math.max(0.5, width / 2 - (margin + bound));
    const z = margin + bound + rng() * Math.max(0.5, extent - (margin + bound) * 2);
    if (
      !lampCandidateClear(
        plan,
        comp,
        input.water,
        input.doors,
        input.props,
        x,
        z,
        propScale,
        thick,
      )
    ) {
      continue;
    }
    return { kind: "generic", x, z };
  }
  // No legal spot: NONE. The old illegal midpoint fallback is gone.
  return { kind: "none" };
}

/* ------------------------------------------------------------------ */
/* Window                                                              */
/* ------------------------------------------------------------------ */

/**
 * One blocking prop's cut interval on a wall's run: the along-range a
 * window center must NOT use because this prop stands in the glass's
 * way. The prop projects onto the wall's tangent and inward normal;
 * it cuts only when all three ranges really intersect the window's:
 *   - vertical: the prop's [baseY, topY] crosses the glass's
 *     [winBottom, winTop] (a bench under the sill does not cut),
 *   - normal: the prop reaches into [inner face, inner face + depth],
 *   - tangent: whatever remains — the returned interval is the prop's
 *     tangent projection inflated by the frame half-width.
 * Returns null when the prop cannot block this window geometry.
 */
export function propWindowCut(
  plan: RoomPlan,
  wall: WallSegment,
  prop: PropObb,
  frameHalf: number,
  depth: number,
  winBottom: number,
  winTop: number,
): [number, number] | null {
  if (!prop.blocks) return null;
  if (prop.topY < winBottom - 1e-6 || prop.baseY > winTop + 1e-6) return null;
  const { horizontal, thick } = wallRun(wall);
  const { nx, nz } = inwardNormal(plan, wall, wall.x, wall.z);
  const tx = horizontal ? 1 : 0;
  const tz = horizontal ? 0 : 1;
  let minT = Infinity;
  let maxT = -Infinity;
  let minN = Infinity;
  let maxN = -Infinity;
  for (const c of obbCorners(prop)) {
    const rx = c.x - wall.x;
    const rz = c.z - wall.z;
    const t = rx * tx + rz * tz;
    const n = rx * nx + rz * nz;
    if (t < minT) minT = t;
    if (t > maxT) maxT = t;
    if (n < minN) minN = n;
    if (n > maxN) maxN = n;
  }
  const face = thick / 2;
  if (maxN < face - 1e-6 || minN > face + depth + 1e-6) return null;
  return [minT - frameHalf, maxT + frameHalf];
}

function resolveWindow(input: RoomFixtureInput): WindowResolution | null {
  // FILL THE GAP, NEVER STACK: an authored window or glass wall span is
  // already the room's window — the generic one stands down.
  if ((input.openings.glassSpans?.length ?? 0) > 0) return null;
  if ((input.openings.windows?.length ?? 0) > 0) return null;

  const { plan, walls, dir, propScale, wallScale } = input;
  const frameHalf = windowFrameHalf(wallScale);
  const depth = WINDOW_CLEAR_DEPTH_RATIO * propScale;

  // Host pools, strictest first: full-height (non-entrance, non-camera,
  // non-feature) walls, the vertical ones first (§10.5: east/west belong
  // to light); then any remaining full-height wall; then the entrance
  // pair (its doorway gap cuts the legal intervals). No pathological
  // "longest wall regardless" rung — no legal spot means no window.
  const isFullHeight = (w: WallSegment, i: number) =>
    !w.entrance &&
    !wallFacesCamera(plan, w, dir) &&
    !input.featureSources.has(i);
  const fullHeight = walls.filter((_, i) => isFullHeight(walls[i], i));
  const pools: WallSegment[][] = [
    fullHeight.filter((w) => w.sizeZ > w.sizeX),
    fullHeight.filter((w) => w.sizeZ <= w.sizeX),
    walls.filter((w) => w.entrance),
  ];

  for (const pool of pools) {
    if (pool.length === 0) continue;
    const start = Math.floor(input.rng() * pool.length);
    for (let o = 0; o < pool.length; o++) {
      const wall = pool[(start + o) % pool.length];
      const wallIndex = walls.indexOf(wall);
      const { horizontal, len, thick } = wallRun(wall);
      const drawnHeight = drawnHeightFor(plan, wall, dir, input.wallHeight);
      const { bottom, top } = windowVerticalSpan(drawnHeight, wallScale);
      // The legal center intervals, minus — deterministically, not by
      // hoping random tries miss them — every blocking prop's cut: what
      // survives is guaranteed window clearance, so a seeded pick inside
      // it always lands legal.
      let intervals = legalWindowIntervals(
        wall,
        wallIndex,
        frameHalf,
        input.doors,
        input.openings,
      );
      for (const prop of input.props) {
        if (intervals.length === 0) break;
        const cut = propWindowCut(plan, wall, prop, frameHalf, depth, bottom - 0.12, top + 0.12);
        if (cut) {
          intervals = subtractIntervals(intervals, cut[0], cut[1]);
        }
      }
      if (intervals.length === 0) continue;
      // Every candidate in the surviving intervals is clear — pick one
      // seeded spot and assert it with the zone predicate.
      const pick = intervals[Math.floor(input.rng() * intervals.length)];
      const along = pick[0] + input.rng() * (pick[1] - pick[0]);
      const zone = windowZoneRect(plan, wall, along, frameHalf, depth);
      if (propBlocksWindowZone(input.props, zone, bottom - 0.12, top + 0.12)) continue;
      const { nx, nz } = inwardNormal(
        plan,
        wall,
        horizontal ? wall.x + along : wall.x,
        horizontal ? wall.z : wall.z + along,
      );
      return {
        wall: wallIndex,
        along,
        nx,
        nz,
        thick,
        drawnHeight,
        bottom,
        top,
        len,
        width: frameHalf * 2,
      };
    }
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Clerestory                                                          */
/* ------------------------------------------------------------------ */

function resolveClerestory(
  input: RoomFixtureInput,
  win: WindowResolution | null,
): ClerestoryResolution | null {
  if (!input.hasClerestory) return null;

  const { plan, walls, dir, wallScale } = input;
  const pad = CLERESTORY_END_PAD * wallScale;
  const unit = CLERESTORY_UNIT * wallScale;
  const minRun = (CLERESTORY_END_PAD * 2 + CLERESTORY_UNIT) * wallScale;

  // Feature walls (niche, pilaster, arch, columns, platform, mezzanine)
  // rebuild or project off the run — the band never hosts there, same
  // discipline as the window's pool.
  const fullHeight = walls.filter(
    (w, i) =>
      !w.entrance &&
      !wallFacesCamera(plan, w, dir) &&
      !input.featureSources.has(i),
  );
  // Walls already carrying authored LIGHT (a glass span or an authored
  // window) are the last clerestory hosts — a second opening beside the
  // glass is a worse reading than a band over plain wall.
  const authoredLightWalls = new Set<number>();
  for (const list of [
    input.openings.glassSpans ?? [],
    input.openings.windows ?? [],
  ]) {
    for (const o of list) authoredLightWalls.add(o.wall);
  }
  // Pools, strictest first: a wall that is not the window's host and
  // carries no authored light; then any non-host full-height wall; then
  // — the fallback that keeps a one-wall room from losing its band — the
  // window's OWN wall, its frame subtracted from the band interval so
  // the two never overlap; then the entrance pair, non-host first.
  const notWindowHost = (w: WallSegment) =>
    win === null || walls.indexOf(w) !== win.wall;
  const pools: WallSegment[][] = [
    fullHeight.filter(
      (w) => notWindowHost(w) && !authoredLightWalls.has(walls.indexOf(w)),
    ),
    fullHeight.filter(notWindowHost),
    fullHeight,
    walls.filter((w) => w.entrance && notWindowHost(w)),
    walls.filter((w) => w.entrance),
  ];

  for (const pool of pools) {
    if (pool.length === 0) continue;
    const start = Math.floor(input.rng() * pool.length);
    for (let o = 0; o < pool.length; o++) {
      const wall = pool[(start + o) % pool.length];
      const wallIndex = walls.indexOf(wall);
      const { len, thick } = wallRun(wall);
      if (len < minRun) continue;
      const drawnHeight = drawnHeightFor(plan, wall, dir, input.wallHeight);
      const { bottom, top } = clerestoryVerticalSpan(drawnHeight, wallScale);
      // Band interval: the run minus the end pads, minus the authored
      // openings' frames and (on the window's wall) the window frame.
      let intervals: [number, number][] = [[-len / 2 + pad, len / 2 - pad]];
      const cut = (lo: number, hi: number): void => {
        intervals = subtractIntervals(intervals, lo, hi);
      };
      for (const ao of authoredOn(input.openings, wallIndex)) {
        cut(ao.along0, ao.along1);
      }
      // A high band must clear actual tall furniture too. Subtract the
      // occupied spans before choosing its length, including the frame.
      for (const prop of input.props) {
        const occupied = propWindowCut(input.plan, wall, prop, 0.1,
          WINDOW_CLEAR_DEPTH_RATIO * input.propScale, bottom - 0.1, top + 0.1);
        if (occupied) cut(occupied[0], occupied[1]);
      }
      if (win !== null && win.wall === wallIndex) {
        const gap = win.width / 2 + CLERESTORY_WINDOW_GAP;
        cut(win.along - gap, win.along + gap);
      }
      intervals = intervals.filter(([a, b]) => b - a >= unit);
      if (intervals.length === 0) continue;
      // The longest surviving interval hosts the band, centered.
      const pick = intervals.reduce((m, c) => (c[1] - c[0] > m[1] - m[0] ? c : m));
      const along = (pick[0] + pick[1]) / 2;
      const { horizontal } = wallRun(wall);
      const { nx, nz } = inwardNormal(
        plan,
        wall,
        horizontal ? wall.x + along : wall.x,
        horizontal ? wall.z : wall.z + along,
      );
      return {
        wall: wallIndex,
        along,
        nx,
        nz,
        thick,
        drawnHeight,
        bottom,
        top,
        len: Math.min(pick[1] - pick[0], len - 2 * pad),
      };
    }
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* The resolver                                                        */
/* ------------------------------------------------------------------ */

/**
 * Resolve the room's motivated fixtures. Deterministic in the inputs
 * and the caller-supplied rng: the same room always resolves the same
 * way (A6). The resolver consumes ONLY the rng it is handed — the
 * furniture stream (and every other stream) is never perturbed.
 */
export function resolveRoomFixtures(input: RoomFixtureInput): RoomFixtureResult {
  const lamp = resolveLamp(input);
  const window = resolveWindow(input);
  const clerestory = resolveClerestory(input, window);
  return { lamp, window, clerestory };
}
