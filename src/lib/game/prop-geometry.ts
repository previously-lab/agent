/**
 * Prop geometry (2026-10 room-realism lane) — the REAL footprints of the
 * staged prop kinds, as oriented boxes (OBBs) in the plan's XZ frame.
 *
 * WHY THIS MODULE EXISTS. The fixture resolver (room-fixtures.ts) used to
 * reason about "is there furniture near the window" by sampling POINTS,
 * and the shelf wall cut books around a window by skipping whole bays —
 * both blind to what the staged props actually occupy. The renderer's
 * prop bodies (space.tsx / room-props.tsx) are real boxes: the Bookshelf
 * case is 1.84m wide × 0.44m deep × 2.2m tall, and a kit that sets three
 * of them 1.6m apart on center INTERLEAVES their bodies (half-width 0.92
 * > half-spacing 0.8). This module is the single pure source of those
 * real dimensions and of the OBB math every clearance test runs on.
 *
 * CONVENTIONS. A prop's local frame is the renderer's: +x is the prop's
 * width, +z its depth, y up from its base. A three.js Y-rotation θ maps
 * +x → (cos θ, −sin θ) and +z → (sin θ, cos θ) in the plan frame (the
 * same convention placeKit documents), so an OBB carries those two unit
 * axes and never collapses to an unrotated AABB — a rotated bookshelf
 * really does sweep a diamond footprint, and the SAT intersection tests
 * below honour it.
 *
 * Pure module: no three.js, no React, no wall clock, no seeding.
 */

import type { KitKind } from "./kits";
import { WALL_HEIGHT } from "./hotel";
/* The bookshelf's measured constants live in the dependency-free leaf
 *  prop-dimensions.ts — kits.ts, room-schematic.ts, and this module all
 *  read the SAME binding, so no consumer pulls a runtime cycle
 *  (kits ↔ prop-geometry ↔ room-plan ↔ room-modules) to reach them. */
import {
  BOOKSHELF_DIMENSIONS,
  BOOKSHELF_RUN_SPACING,
} from "./prop-dimensions";

export { BOOKSHELF_DIMENSIONS, BOOKSHELF_RUN_SPACING };

/* ------------------------------------------------------------------ */
/* Footprints                                                          */
/* ------------------------------------------------------------------ */

/** One prop kind's real footprint at human scale (meters, BEFORE the
 *  staged piece's own `scale` multiplier).
 *
 *  FLAGS:
 *   - `walkable`: a flat plane you step on (rugs, moss, jetty deck) — it
 *     never blocks a lamp spot or a window zone.
 *   - `hanging`: rides ON the wall (wallart) or on a host piece (the
 *     tabletop dressing) — no floor footprint, never blocks.
 *   - `light`: a light-emitting prop (floorlamp / desklamp) — the fixture
 *     resolver counts these as EXISTING lights, not obstacles. */
export interface PropFootprint {
  /** Local x extent (the prop's width). */
  width: number;
  /** Local z extent (the prop's depth — forward is +z). */
  depth: number;
  /** Height of the top above the piece's base. */
  height: number;
  walkable?: boolean;
  hanging?: boolean;
  light?: boolean;
}

/**
 * The footprint table — one explicit entry per kind the kit vocabulary
 * can stage (KitKind, enforced at compile time by the satisfies), plus
 * the legacy motif kinds the final furniture can carry outside the kit
 * vocabulary: `ladder`, the pool hall's rim ladder (space.tsx's
 * MotifGeometry — rails at ±0.2, hooks reaching z 0.35, 1.35m tall).
 * Dimensions were read off the prop geometry in space.tsx /
 * room-props.tsx; a few kinds are conservative bounds where the prop
 * is irregular (the lockerrow's ajar door swings +0.25m past its body;
 * the sofa's arms overhang its shadow plane; the bookpile's width
 * covers the leaning book at x 0.24; the floorlamp's footprint is its
 * 0.72m shade, not its 0.5m base disc; the plant's is the leaves'
 * ~1m reach, not the pot). Rugs/moss/jettydeck are walkable planes;
 * tabletop dressing (tray/bell/register/vase/frame/candle) rides on a
 * host piece whose OBB already covers it. Everything else — towelstack
 * stands on the floor in every kit that stages it, and wallart is a
 * real object ON the wall — blocks lamps by its floor projection and
 * windows by the real vertical intersection of its y-range with the
 * frame's.
 */
export const PROP_DIMENSIONS = {
  /* The tall furniture — the window-zone blockers. */
  bookshelf: {
    width: BOOKSHELF_DIMENSIONS.width,
    depth: BOOKSHELF_DIMENSIONS.depth,
    height: BOOKSHELF_DIMENSIONS.height,
  },
  wardrobe: { width: 1.3, depth: 0.58, height: 2.16 },
  lockerrow: { width: 1.64, depth: 0.62, height: 1.95 },
  storagerack: { width: 1.44, depth: 0.56, height: 1.84 },
  grandfatherclock: { width: 0.56, depth: 0.36, height: 2.2 },
  column: { width: 0.9, depth: 0.9, height: WALL_HEIGHT },

  /* Seating and tables. */
  sofa: { width: 2.15, depth: 1.05, height: 0.95 },
  bed: { width: 1.7, depth: 2.2, height: 1.05 },
  desk: { width: 1.7, depth: 0.95, height: 0.78 },
  diningtable: { width: 2.3, depth: 1.05, height: 0.79 },
  counter: { width: 2.55, depth: 0.7, height: 0.96 },
  workbench: { width: 1.8, depth: 0.8, height: 0.9 },
  sideboard: { width: 1.8, depth: 0.45, height: 1.4 },
  tv: { width: 1.25, depth: 0.4, height: 1.35 },
  mediaunit: { width: 1.6, depth: 0.55, height: 0.5 },
  coffeetable: { width: 0.9, depth: 0.55, height: 0.4 },
  bench: { width: 1.6, depth: 0.55, height: 0.82 },
  poolbench: { width: 1.6, depth: 0.55, height: 0.55 },
  nightstand: { width: 0.5, depth: 0.45, height: 0.9 },
  readingchair: { width: 0.95, depth: 0.95, height: 1.05 },
  chair: { width: 0.62, depth: 0.62, height: 0.85 },
  vanity: { width: 1.2, depth: 0.45, height: 1.35 },
  chairstack: { width: 0.7, depth: 0.7, height: 1.0 },
  screen: { width: 1.6, depth: 0.4, height: 1.8 },
  lounger: { width: 0.7, depth: 1.8, height: 0.5 },

  /* Lamps and small floor pieces. */
  floorlamp: { width: 0.72, depth: 0.72, height: 2.12, light: true },
  desklamp: { width: 0.36, depth: 0.36, height: 0.71, light: true },
  plant: { width: 1.0, depth: 1.0, height: 1.3 },
  pedestal: { width: 0.44, depth: 0.44, height: 1.4 },
  bookpile: { width: 0.66, depth: 0.32, height: 0.25 },
  coatstand: { width: 0.6, depth: 0.6, height: 1.9 },
  umbrellastand: { width: 0.4, depth: 0.4, height: 0.85 },
  giftbox: { width: 0.6, depth: 0.6, height: 0.66 },
  suitcase: { width: 0.5, depth: 0.35, height: 0.7 },
  luggagecart: { width: 0.9, depth: 0.6, height: 1.1 },
  towelrail: { width: 0.9, depth: 0.4, height: 1.2 },
  ring: { width: 0.5, depth: 0.5, height: 1.1 },
  ringpost: { width: 0.4, depth: 0.4, height: 1.4 },
  /* The pool deck's umbrella-table — the footprint is the CANOPY, not
   *  the pole: space.tsx's model carries a 1.35m-radius cone (y 1.475 →
   *  2.025) on a slim 1.7m pole, so the body really sweeps 2.7 × 2.7m
   *  and stands ~2.05m tall. The old 0.5 × 0.5 disc only covered the
   *  pole and let a staged chair sit inside the fabric. */
  umbrella: { width: 2.7, depth: 2.7, height: 2.05 },
  mop: { width: 0.2, depth: 0.2, height: 1.5 },
  bucket: { width: 0.35, depth: 0.35, height: 0.35 },
  board: { width: 2.5, depth: 0.9, height: 1.2 },
  poolladder: { width: 0.9, depth: 0.9, height: 1.6 },
  ladder: { width: 0.5, depth: 0.7, height: 1.4 },
  fountain: { width: 2.4, depth: 2.4, height: 0.9 },

  /* Tabletop dressing — rides on a host piece, never blocks clearance. */
  tray: { width: 0.4, depth: 0.3, height: 0.12, hanging: true },
  bell: { width: 0.15, depth: 0.15, height: 0.15, hanging: true },
  register: { width: 0.4, depth: 0.3, height: 0.2, hanging: true },
  towelstack: { width: 0.45, depth: 0.35, height: 0.3 },
  vase: { width: 0.2, depth: 0.2, height: 0.35, hanging: true },
  frame: { width: 0.35, depth: 0.2, height: 0.3, hanging: true },
  candle: { width: 0.12, depth: 0.12, height: 0.25, hanging: true },
  wallart: { width: 0.8, depth: 0.1, height: 0.8 },

  /* Walkable planes — rugs, moss, the jetty's deck: stepped ON, they
   *  never stand in a lamp's or a window's way. */
  rug: { width: 1.6, depth: 1.1, height: 0.02, walkable: true },
  moss: { width: 1.2, depth: 0.9, height: 0.03, walkable: true },
  jettydeck: { width: 1.4, depth: 1.15, height: 0.45, walkable: true },

  /* The nature set (conservative bounds for irregular silhouettes). */
  standingstone: { width: 0.8, depth: 0.6, height: 1.8 },
  boulder: { width: 1.6, depth: 1.4, height: 1.2 },
  reeds: { width: 0.8, depth: 0.8, height: 1.2 },
  firepit: { width: 1.2, depth: 1.2, height: 0.4 },
  ruinwall: { width: 1.6, depth: 0.5, height: 0.9 },
  log: { width: 2.2, depth: 0.6, height: 0.6 },
  mushroom: { width: 0.5, depth: 0.5, height: 0.4 },
  cairn: { width: 0.7, depth: 0.7, height: 0.9 },
  signpost: { width: 0.4, depth: 0.4, height: 1.9 },

  /* The wonder set. */
  toyblock: { width: 0.8, depth: 0.8, height: 0.8 },
  marblerun: { width: 1.2, depth: 1.2, height: 2.2 },
  marblechute: { width: 1.6, depth: 0.6, height: 0.5 },
  chessking: { width: 0.9, depth: 0.9, height: 2.0 },
  chessrook: { width: 0.8, depth: 0.8, height: 1.5 },
  chesspawn: { width: 0.6, depth: 0.6, height: 1.0 },
  paperboat: { width: 0.4, depth: 0.7, height: 0.3 },
  paperlantern: { width: 0.5, depth: 0.5, height: 0.8 },
  swingframe: { width: 2.6, depth: 1.2, height: 2.6 },
  swingseat: { width: 0.5, depth: 0.5, height: 1.8 },
} satisfies Record<KitKind | "ladder", PropFootprint>;

/** Does this footprint occupy floor space a lamp or window must avoid?
 *  Walkable planes and hanging dressing never block. */
export function footprintBlocks(fp: PropFootprint): boolean {
  return !fp.walkable && !fp.hanging;
}

/* ------------------------------------------------------------------ */
/* OBBs                                                                */
/* ------------------------------------------------------------------ */

/** A 2D oriented box in the plan's XZ frame, with the vertical range the
 *  prop's body occupies (baseY..topY, both scaled). */
export interface PropObb {
  kind: string;
  /** Center. */
  cx: number;
  cz: number;
  /** Unit axis u — the prop's local +x mapped through rotY:
   *  (cos rotY, −sin rotY). */
  ux: number;
  uz: number;
  /** Unit axis v — the prop's local +z mapped through rotY:
   *  (sin rotY, cos rotY). */
  vx: number;
  vz: number;
  /** Half-extents along u (width·scale/2) and v (depth·scale/2). */
  hx: number;
  hz: number;
  /** Vertical range the body occupies (baseY = the piece's floor lift,
   *  topY = baseY + height·scale). */
  baseY: number;
  topY: number;
  /** False for walkable planes and hanging dressing — see
   *  footprintBlocks. */
  blocks: boolean;
  /** A light-emitting prop (floorlamp / desklamp). */
  light: boolean;
}

/** One staged piece's OBB inputs. */
export interface StagedPropRef {
  kind: string;
  x: number;
  z: number;
  rotY: number;
  scale: number;
  /** Floor-relative lift (the staged piece's y — 0 for floor pieces, a
   *  host top for tabletop dressing). Default 0. */
  baseY?: number;
}

/**
 * Build the OBB one staged piece really occupies. rotY follows the
 * three.js convention documented above; `scale` multiplies the REAL
 * width/depth/height (not a nominal box), so a rotated, scaled prop's
 * footprint is exactly its swept body — never an unrotated AABB.
 * Throws on a kind missing from PROP_DIMENSIONS (the table is
 * exhaustive for the kit vocabulary AND the legacy ladder; a new kind
 * must land there).
 */
export function propObbFor(p: StagedPropRef): PropObb {
  const fp: PropFootprint =
    PROP_DIMENSIONS[p.kind as keyof typeof PROP_DIMENSIONS];
  if (!fp) {
    throw new Error(`propObbFor: no footprint for kind "${p.kind}"`);
  }
  const c = Math.cos(p.rotY);
  const s = Math.sin(p.rotY);
  const baseY = p.baseY ?? 0;
  return makeObb({
    cx: p.x,
    cz: p.z,
    ux: c,
    uz: -s,
    hx: (fp.width * p.scale) / 2,
    vx: s,
    vz: c,
    hz: (fp.depth * p.scale) / 2,
    baseY,
    topY: baseY + fp.height * p.scale,
    blocks: footprintBlocks(fp),
    light: fp.light === true,
    kind: p.kind,
  });
}

/** Build an OBB from explicit axes and half-extents — the constructor
 *  the fixture predicates use for non-prop bodies (the generic lamp's
 *  shade disc, a door approach rectangle). */
export function makeObb(o: {
  cx: number;
  cz: number;
  ux: number;
  uz: number;
  hx: number;
  vx: number;
  vz: number;
  hz: number;
  baseY?: number;
  topY?: number;
  blocks?: boolean;
  light?: boolean;
  kind?: string;
}): PropObb {
  return {
    kind: o.kind ?? "__obb__",
    cx: o.cx,
    cz: o.cz,
    ux: o.ux,
    uz: o.uz,
    vx: o.vx,
    vz: o.vz,
    hx: o.hx,
    hz: o.hz,
    baseY: o.baseY ?? 0,
    topY: o.topY ?? 0,
    blocks: o.blocks ?? true,
    light: o.light ?? false,
  };
}

/** Map a room's staged pieces to their OBBs (the fixture resolver's
 *  input shape — anything carrying kind/x/z/rotY/scale/y works). */
export function propObbsForPieces(
  pieces: readonly {
    kind: string;
    x: number;
    z: number;
    rotY: number;
    scale: number;
    y?: number;
  }[],
): PropObb[] {
  return pieces.map((p) =>
    propObbFor({ kind: p.kind, x: p.x, z: p.z, rotY: p.rotY, scale: p.scale, baseY: p.y ?? 0 }),
  );
}

/** The OBB's four corners, order (u−v−, u+v−, u+v+, u−v+). */
export function obbCorners(o: PropObb): { x: number; z: number }[] {
  const c = [
    [o.hx, o.hz],
    [o.hx, -o.hz],
    [-o.hx, -o.hz],
    [-o.hx, o.hz],
  ] as const;
  return c.map(([a, b]) => ({
    x: o.cx + o.ux * a + o.vx * b,
    z: o.cz + o.uz * a + o.vz * b,
  }));
}

/** SAT intersection of two 2D OBBs over both axes of each box. */
export function obbsIntersect(a: PropObb, b: PropObb): boolean {
  const axes: [number, number][] = [
    [a.ux, a.uz],
    [a.vx, a.vz],
    [b.ux, b.uz],
    [b.vx, b.vz],
  ];
  for (const [ax, az] of axes) {
    const ra = a.hx * Math.abs(ax * a.ux + az * a.uz) + a.hz * Math.abs(ax * a.vx + az * a.vz);
    const rb = b.hx * Math.abs(ax * b.ux + az * b.uz) + b.hz * Math.abs(ax * b.vx + az * b.vz);
    const d = (b.cx - a.cx) * ax + (b.cz - a.cz) * az;
    if (Math.abs(d) > ra + rb + 1e-9) return false;
  }
  return true;
}

/** An axis-aligned rectangle in the plan frame. */
export interface PlanRect {
  x0: number;
  z0: number;
  x1: number;
  z1: number;
}

/** SAT intersection of an OBB and an axis-aligned rectangle (the rect
 *  enters the axis set as two perpendicular unit axes). */
export function obbIntersectsRect(o: PropObb, r: PlanRect): boolean {
  const rect: PropObb = {
    kind: "__rect__",
    cx: (r.x0 + r.x1) / 2,
    cz: (r.z0 + r.z1) / 2,
    ux: 1,
    uz: 0,
    vx: 0,
    vz: 1,
    hx: (r.x1 - r.x0) / 2,
    hz: (r.z1 - r.z0) / 2,
    baseY: 0,
    topY: 0,
    blocks: true,
    light: false,
  };
  return obbsIntersect(o, rect);
}
