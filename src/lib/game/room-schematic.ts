/**
 * RoomSchematic (v0.12-room-realism §2) — the STRUCTURE layer: a hand-
 * authored blueprint of what a standard room IS, fed to the existing kit
 * staging as a SECOND input (design §2's consumption contract). The generic
 * orchestrator (kits.ts stageInteriorKits) guarantees clearance, coverage
 * and door discipline but does not know what a living room is; the
 * schematic does — seats face the focal wall, the coffee table stands in
 * reach, the rug anchors the group, the TV answers the sofa on one axis.
 *
 * WHAT THIS MODULE IS. Pure data (the RoomSchematic catalogue, today the
 * living pilot) + pure resolution: resolveSchematic turns a placement +
 * the caller's seeded stream into RESOLVED GROUPS — synthetic kits (the
 * exact kits.ts shape) whose pieces' kinds were seeded from each slot's
 * `accepts`, whose offsets were computed from each slot's anchor and
 * tolerance, and whose facings were resolved from each slot's FacingSpec.
 * kits.ts pushes each group through its OWN pushKit clearance machinery —
 * the geometry rules are never re-implemented here (§7.3's discipline).
 *
 * DEGRADATION (§2's "no half-furnished room"). Groups place whole or not
 * at all (one pushKit attempt per group). An OPTIONAL group's failure drops
 * only that group. A REQUIRED group's failure forfeits the WHOLE placement:
 * kits.ts rolls every schematic piece back and the module furnishes with
 * the generic orchestration exactly as it did before blueprints existed.
 *
 * SEATING + MEDIA WALL skip the path-clearance check (the `terminus`
 * slots): the walk path leads TO the seating group the way it leads to the
 * generic hero — the path's cleared corridor is the promise; its
 * destination is not a violation. Every other check (walkable footprint,
 * entrance strip, strand-door approaches, water, keep-empty zones, the
 * coverage budget) runs on every schematic piece through the shared
 * machinery. The ≥1.4m door rule is the existing pathHalf/door machinery,
 * unchanged.
 *
 * ISOLATED GROUPS. The seating and media groups are ONE authored
 * composition (same axis, spec'd distances): they skip the mutual
 * footprint-disc gap check — a generic-kit breathing disc cannot express
 * "the coffee table 0.4m in front of the sofa". They still check against
 * every NON-schematic disc (obstacles, seam jambs, generic kits), and the
 * optional groups check against everything including the required groups.
 *
 * DETERMINISM (A6). Every draw rides the caller's staging stream in a fixed
 * order — groups in first-declared order, slots in declaration order, per
 * slot: chance → count → per-piece (kind, anchor, scale) → facing jitter.
 * Same slice ⇒ same stream ⇒ same room.
 *
 * COORDINATES. Slot distances are AUTHORED METERS scaled by the placement's
 * `scale` (plan meters per authored meter — the module's experienced scale
 * factor); piece sizes ride `propScale` exactly like every other prop
 * (kits grow with the room, §4). Distances off a wall are the piece
 * CENTER's distance, matching the generic wall-kit convention (the shared
 * planContains margin keeps centers clear of the wall boxes).
 */
import type { KitKind } from "./kits";
import type { PlacedModule } from "./room-modules";

/* ------------------------------------------------------------------ */
/* The data model (design §2)                                          */
/* ------------------------------------------------------------------ */

/** One edge of the module in its own frame: n = the side facing the
 *  room's far wall, s = the entrance side, w/e = the flanks. */
export type SchematicEdge = "n" | "s" | "e" | "w";

/** The module's frame rect in scaled plan coordinates (what pushKit
 *  validates against). */
export interface SchematicRect {
  x0: number;
  z0: number;
  x1: number;
  z1: number;
}

/** Where a slot's piece stands. Distances/lateral ranges are authored
 *  meters; every range is a SEEDED draw (the tolerance radius of §2). */
export type SlotAnchor =
  | {
      /** On the wall's inner band: `dist` off the wall, `along` the wall. */
      kind: "wall";
      /** "focal" resolves to the schematic's focal edge. */
      wall: SchematicEdge | "focal";
      /** Piece-center distance off the wall's inner face (m, authored). */
      dist: readonly [number, number];
      /** Lateral position along the wall, normalized [0,1] across the
       *  module's span on that edge, ± `alongTol` (m, authored). */
      along: number;
      alongTol: number;
    }
  | {
      /** Like "wall", but the lateral FOLLOWS another anchor (§1's
       *  "与沙发同轴"): the media wall answers the seating anchor. */
      kind: "wallAligned";
      wall: SchematicEdge | "focal";
      withAnchor: string;
      dist: readonly [number, number];
      alongTol: number;
    }
  | {
      /** Offset from another slot's resolved position, drawn in THAT
       *  slot's local frame (+z = its facing). `dx` may carry a side
       *  draw (see `side`). */
      kind: "relative";
      slot: string;
      dx: readonly [number, number];
      dz: readonly [number, number];
      /** "seeded": draw the dx SIGN (stored for later opposite refs).
       *  { opposite }: the negated sign of an earlier seeded slot. */
      side?: "seeded" | { opposite: string };
    }
  | {
      /** The average of the listed slots' resolved positions (the rug's
       *  group center) plus a seeded offset. */
      kind: "center";
      slots: readonly string[];
      dx: readonly [number, number];
      dz: readonly [number, number];
    }
  | {
      /** A corner of the module's focal edge (the planted flank of the
       *  media wall), pushed `dist` inward along both edges. */
      kind: "focalCorner";
      corner: "left" | "right" | "seeded";
      dist: readonly [number, number];
    }
  | {
      /** A seeded pick among the module's exposed non-focal, non-entrance
       *  walls (§1's "非焦点墙" / "侧墙"). Fails when none is exposed. */
      kind: "flankWall";
      dist: readonly [number, number];
      along: number;
      alongTol: number;
    };

/** How a slot's piece faces (three.js convention: rotY = atan2(tx − x,
 *  tz − z) faces (x, z) toward the target). */
export type SlotFacing =
  /** Toward the focal wall (the seats watch the media wall). */
  | { kind: "focal" }
  /** Into the room, back to the given wall ("anchor" = whichever wall
   *  this slot's anchor picked — the flankWall slots). */
  | { kind: "intoRoom"; wall: SchematicEdge | "focal" | "anchor" }
  /** Square at another resolved slot (the armchair at the coffee table). */
  | { kind: "toward"; slot: string }
  /** Toward the module's center. */
  | { kind: "moduleCenter" }
  /** An authored angle plus a seeded jitter (rad, ±jitter). */
  | { kind: "fixed"; rotY: number; jitter: number };

/** One slot of the blueprint (design §2's RoomSlot). */
export interface RoomSlot {
  role: string;
  at: SlotAnchor;
  facing: SlotFacing;
  /** The prop kinds this slot may draw — seeded pick per piece (§2's
   *  "accepts 里种子抽一个 kind"). */
  accepts: readonly KitKind[];
  /** The piece's clearance radius (m, authored): the breathing room the
   *  group's footprint disc must cover around this piece. */
  clearance: number;
  /** A required slot's failed placement forfeits the whole placement
   *  (degradation, never a half-furnished room). */
  required: boolean;
  /** Slots of one group place whole or not at all. */
  group: string;
  /** Piece count, seeded in [min, max] (a shelf run). Default [1, 1]. */
  count?: readonly [number, number];
  /** Piece scale multiplier, seeded in [min, max] (rug sizes). */
  scale?: readonly [number, number];
  /** Flat floor dressing (a rug): walked over, no footprint disc. */
  flat?: boolean;
  /** Lift above the floor in authored meters, scaled by the HOST piece's
   *  own scale (tabletop dressing — supported by the top, never floating,
   *  §0 rule 4). */
  lift?: number;
  /** Seeded appearance probability for OPTIONAL slots. */
  chance?: number;
  /** The path's terminus seats (§2 rule 1-2): skip the path-clearance
   *  check like the generic hero — the path leads TO this group. */
  terminus?: boolean;
  /** The group's pieces relate by AUTHORED offsets (a composition, not
   *  islands): skip the mutual footprint-disc gap against OTHER
   *  schematic groups. External discs (obstacles, seam jambs, generic
   *  kits) still apply. */
  isolated?: boolean;
}

/** One room blueprint (design §2's RoomSchematic). */
export interface RoomSchematic {
  moduleId: string;
  /** The focal wall's preferred edge (a PREFERENCE, like the feature
   *  slots': a companion module's preference may land on a seam — the
   *  resolver falls back to the longest exposed non-entrance edge). */
  focalWall: SchematicEdge;
  slots: readonly RoomSlot[];
  /** The traffic contract (§2): door→focal and door→door stay ≥ min m.
   *  Declarative — the enforcement IS the shared staging machinery
   *  (pathHalf corridor, door-approach strips), never re-derived here. */
  paths: readonly { from: "door"; to: "focal" | "door"; min: number }[];
  /** 会客/餐厅 may be axially composed; studies must not (§2 rule 6 —
   *  an authoring discipline the tests assert on the resolved pieces). */
  symmetry?: "axial" | "none";
}

/* ------------------------------------------------------------------ */
/* The catalogue — one blueprint per standard room (P1: the living)    */
/* ------------------------------------------------------------------ */

/**
 * The living room (v0.12-room-specs §1, the P1 pilot): a conversation
 * group on one axis with its media wall. Every slot's numbers are the
 * spec's: the sofa 2.4–3.6m off the focal wall facing it; the coffee
 * table 0.35–0.5m in front of the sofa (sofa half-depth 0.425 + table
 * half-depth 0.275 ⇒ dz 1.05–1.2) carrying 1–2 tabletop pieces; the rug
 * under sofa + table + chair; the reading chair at the table's corner in
 * an L (45° side-on, facing the table); the floor lamp within a seat's
 * reach (≤1.2m of the sofa center, opposite the chair for balance); the
 * media unit against the focal wall with the TV on it, on the sofa's
 * axis. The sideboard / shelf run / planted corner / console are optional
 * (§1 可选) and each degrades alone.
 *
 * 禁止栏 (§1): no bench / poolbench / lounger / towel stack / towel rail /
 * bucket / luggage cart / locker row / chair stack anywhere in the
 * accepts — the whitelist holds no kit that stages them either (v0.12
 * declarations audit), and the schematic's vocabulary is its accepts
 * lists, so the ban holds by construction.
 */
const LIVING_SCHEMATIC: RoomSchematic = {
  moduleId: "living",
  focalWall: "n",
  symmetry: "axial",
  paths: [
    { from: "door", to: "focal", min: 1.4 },
    { from: "door", to: "door", min: 1.4 },
  ],
  slots: [
    {
      // 沙发 — the seat, facing the media wall 2.4–3.6m off it.
      role: "sofa",
      group: "seating",
      required: true,
      terminus: true,
      isolated: true,
      at: { kind: "wall", wall: "focal", dist: [2.4, 3.6], along: 0.5, alongTol: 0.6 },
      facing: { kind: "focal" },
      accepts: ["sofa"],
      clearance: 1.15,
    },
    {
      // 茶几 — 0.35–0.5m in front of the sofa, on its axis.
      role: "coffeetable",
      group: "seating",
      required: true,
      terminus: true,
      isolated: true,
      at: { kind: "relative", slot: "sofa", dx: [-0.1, 0.1], dz: [1.05, 1.2] },
      facing: { kind: "fixed", rotY: 0, jitter: 0.04 },
      accepts: ["coffeetable"],
      clearance: 0.6,
      scale: [0.95, 1.05],
    },
    {
      // 台面摆件 — the "someone lives here" signal (§0 rule 2), 1–2
      // pieces on the coffee table's top (lift rides the table's scale).
      role: "tabletop",
      group: "seating",
      required: true,
      terminus: true,
      isolated: true,
      at: {
        kind: "relative",
        slot: "coffeetable",
        dx: [-0.28, -0.08],
        dz: [-0.16, 0.16],
      },
      facing: { kind: "fixed", rotY: 0, jitter: Math.PI },
      accepts: ["vase", "frame", "candle", "bookpile", "tray"],
      count: [1, 2],
      lift: 0.4,
      clearance: 0.15,
    },
    {
      // 单椅 — the L: beside the sofa's front corner, square at the
      // table (45° side-on by position). Seeded side.
      role: "armchair",
      group: "seating",
      required: true,
      terminus: true,
      isolated: true,
      at: {
        kind: "relative",
        slot: "sofa",
        dx: [1.35, 1.7],
        dz: [0.8, 1.15],
        side: "seeded",
      },
      facing: { kind: "toward", slot: "coffeetable" },
      accepts: ["readingchair"],
      clearance: 0.55,
    },
    {
      // 地毯 — under the three seats (flat: walked over, no disc).
      role: "rug",
      group: "seating",
      required: true,
      terminus: true,
      isolated: true,
      flat: true,
      at: {
        kind: "center",
        slots: ["sofa", "coffeetable", "armchair"],
        dx: [-0.12, 0.12],
        dz: [-0.05, 0.2],
      },
      facing: { kind: "fixed", rotY: 0, jitter: Math.PI },
      accepts: ["rug"],
      scale: [1.35, 1.55],
      clearance: 0,
    },
    {
      // 落地灯 — a seat's reach (≤1.2m of the sofa center), opposite
      // the chair so the pair balances.
      role: "floorlamp",
      group: "seating",
      required: true,
      terminus: true,
      isolated: true,
      at: {
        kind: "relative",
        slot: "sofa",
        dx: [0.95, 1.1],
        dz: [-0.3, 0.05],
        side: { opposite: "armchair" },
      },
      facing: { kind: "fixed", rotY: 0, jitter: Math.PI },
      accepts: ["floorlamp"],
      clearance: 0.35,
    },
    {
      // 电视柜 — against the focal wall, on the sofa's axis.
      role: "mediaunit",
      group: "media",
      required: true,
      terminus: true,
      isolated: true,
      at: {
        kind: "wallAligned",
        wall: "focal",
        withAnchor: "seating",
        dist: [0.7, 0.95],
        alongTol: 0.3,
      },
      facing: { kind: "intoRoom", wall: "focal" },
      accepts: ["mediaunit"],
      clearance: 0.85,
      scale: [0.95, 1.1],
    },
    {
      // 电视 — ON the media unit, facing the sofa.
      role: "tv",
      group: "media",
      required: true,
      terminus: true,
      isolated: true,
      at: { kind: "relative", slot: "mediaunit", dx: [-0.04, 0.04], dz: [-0.02, 0.08] },
      facing: { kind: "toward", slot: "sofa" },
      accepts: ["tv"],
      lift: 0.5,
      clearance: 0.35,
    },
    {
      // 餐边柜 — a non-focal wall, optional.
      role: "sideboard",
      group: "sideboard",
      required: false,
      chance: 0.65,
      at: { kind: "flankWall", dist: [0.7, 0.9], along: 0.5, alongTol: 2 },
      facing: { kind: "intoRoom", wall: "anchor" },
      accepts: ["sideboard"],
      clearance: 0.95,
    },
    {
      // 书架 — a flank wall, 1–3 shelves in a run, optional.
      role: "bookshelf",
      group: "shelf",
      required: false,
      chance: 0.5,
      at: { kind: "flankWall", dist: [0.65, 0.85], along: 0.5, alongTol: 2.2 },
      facing: { kind: "intoRoom", wall: "anchor" },
      accepts: ["bookshelf"],
      count: [1, 3],
      clearance: 0.95,
    },
    {
      // 角植 — pedestal + plant at a focal-edge corner, optional.
      role: "pedestal",
      group: "plant",
      required: false,
      chance: 0.6,
      at: { kind: "focalCorner", corner: "seeded", dist: [0.7, 1.0] },
      facing: { kind: "moduleCenter" },
      accepts: ["pedestal"],
      clearance: 0.4,
    },
    {
      role: "plant",
      group: "plant",
      required: false,
      at: {
        kind: "relative",
        slot: "pedestal",
        dx: [0.55, 0.75],
        dz: [-0.15, 0.2],
        side: "seeded",
      },
      facing: { kind: "fixed", rotY: 0, jitter: Math.PI },
      accepts: ["plant"],
      clearance: 0.4,
      scale: [0.85, 1.05],
    },
    {
      // 沙发背几 — behind the sofa, optional; stands only when it
      // clears the walk path (it usually doesn't in a 12×12 — an
      // honest degradation, never a blocked corridor).
      role: "console",
      group: "console",
      required: false,
      chance: 0.5,
      at: { kind: "relative", slot: "sofa", dx: [-0.25, 0.25], dz: [-1.05, -0.8] },
      facing: { kind: "fixed", rotY: 0, jitter: 0.2 },
      accepts: ["nightstand"],
      clearance: 0.4,
    },
  ],
};

const SCHEMATICS: readonly RoomSchematic[] = [LIVING_SCHEMATIC];

/** The blueprint authored for one standard room module, if any. */
export function roomSchematicFor(moduleId: string): RoomSchematic | undefined {
  return SCHEMATICS.find((s) => s.moduleId === moduleId);
}

/** Every authored blueprint (the tests audit the catalogue). */
export function roomSchematics(): readonly RoomSchematic[] {
  return SCHEMATICS;
}

/* ------------------------------------------------------------------ */
/* Placement + resolution                                              */
/* ------------------------------------------------------------------ */

/** One module's schematic ready for staging: the blueprint, the module's
 *  rect in SCALED plan coordinates, which edges are real walls, and the
 *  plan-meters-per-authored-meter scale. Built by the renderer (space.tsx)
 *  and the describer (describe-room.ts) from the same composition. */
export interface SchematicPlacement {
  schematic: RoomSchematic;
  rect: SchematicRect;
  exposed: Record<SchematicEdge, boolean>;
  /** The module's scale factor (plan meters per authored meter). */
  scale: number;
}

/** Fold a composition's placed modules into schematic placements — the
 *  modules the catalogue has a blueprint for. Pure; a composition with
 *  no schematic-bearing module yields []. */
export function schematicPlacementsFor(
  modules: readonly PlacedModule[],
  scaleFactor: number,
): SchematicPlacement[] {
  const out: SchematicPlacement[] = [];
  for (const placed of modules) {
    const schematic = roomSchematicFor(placed.module.id);
    if (!schematic) continue;
    const s = scaleFactor;
    out.push({
      schematic,
      rect: {
        x0: placed.rect.x0 * s,
        z0: placed.rect.z0 * s,
        x1: placed.rect.x1 * s,
        z1: placed.rect.z1 * s,
      },
      exposed: placed.exposed,
      scale: s,
    });
  }
  return out;
}

/** One resolved piece of a group, in the group's local frame (placeKit
 *  maps it into the plan with the group's transform). */
export interface ResolvedSchematicPiece {
  kind: KitKind;
  /** Plan-meter offsets from the group's anchor (already scaled). */
  dx: number;
  dz: number;
  /** Facing relative to the group's rotY. */
  rotY: number;
  /** Plan-meter lift above the floor (tabletop pieces). */
  dy: number;
  /** ABSOLUTE piece scale (propScale × the slot's seeded variety). */
  scale: number;
}

/** One resolved group — a synthetic kit + its plan-space transform. */
export interface ResolvedSchematicGroup {
  /** `${moduleId}:${group}` — the placement id the probe mirror and the
   *  room outline report. */
  id: string;
  required: boolean;
  x: number;
  z: number;
  rotY: number;
  /** The external clearance disc radius (plan meters). */
  footprint: number;
  skipPath: boolean;
  isolated: boolean;
  pieces: ResolvedSchematicPiece[];
}

/** The focal edge, resolved: the preference when it is a real wall (and
 *  not the entrance side), else the longest exposed non-entrance edge,
 *  else the preference itself (an interior module's seam wall — pushKit
 *  validates against the seam's jamb obstacles). Pure. */
function focalEdgeFor(
  schematic: RoomSchematic,
  rect: SchematicRect,
  exposed: Record<SchematicEdge, boolean>,
): SchematicEdge {
  const pref = schematic.focalWall;
  if (pref !== "s" && exposed[pref]) return pref;
  const spans: Record<SchematicEdge, number> = {
    n: rect.x1 - rect.x0,
    s: rect.x1 - rect.x0,
    e: rect.z1 - rect.z0,
    w: rect.z1 - rect.z0,
  };
  let best: SchematicEdge | null = null;
  for (const edge of ["n", "e", "w"] as const) {
    if (!exposed[edge]) continue;
    if (best === null || spans[edge] > spans[best]) best = edge;
  }
  return best ?? pref;
}

/** rotY whose +z points AT the wall from inside the module (the group
 *  frame's forward for a seating group facing that wall). */
function edgeAngle(edge: SchematicEdge): number {
  switch (edge) {
    case "n":
      return 0;
    case "e":
      return Math.PI / 2;
    case "w":
      return -Math.PI / 2;
    case "s":
      return Math.PI;
  }
}

/** Piece-center point `dist` (plan m) off the wall's inner face and `u`
 *  (normalized across the module's span) along it. */
function edgePoint(
  rect: SchematicRect,
  edge: SchematicEdge,
  dist: number,
  u: number,
): { x: number; z: number } {
  switch (edge) {
    case "n":
      return { x: rect.x0 + u * (rect.x1 - rect.x0), z: rect.z1 - dist };
    case "s":
      return { x: rect.x0 + u * (rect.x1 - rect.x0), z: rect.z0 + dist };
    case "e":
      return { x: rect.x1 - dist, z: rect.z0 + u * (rect.z1 - rect.z0) };
    case "w":
      return { x: rect.x0 + dist, z: rect.z0 + u * (rect.z1 - rect.z0) };
  }
}

function edgeSpan(rect: SchematicRect, edge: SchematicEdge): number {
  return edge === "n" || edge === "s" ? rect.x1 - rect.x0 : rect.z1 - rect.z0;
}

interface ResolvedSlot {
  x: number;
  z: number;
  rotY: number;
  scale: number;
  flat: boolean;
  clearance: number;
}

/**
 * Resolve one placement into synthetic kit groups. Every draw rides
 * `rng` in a fixed order (A6 — see the module header). Returns null on
 * inconsistent authoring (a dangling reference — the catalogue audit is
 * the guard; staging treats null as a required-group failure and falls
 * back to the generic orchestration).
 */
export function resolveSchematic(
  placement: SchematicPlacement,
  rng: () => number,
  propScale: number,
): ResolvedSchematicGroup[] | null {
  const { schematic, rect, exposed, scale } = placement;
  const focal = focalEdgeFor(schematic, rect, exposed);
  const focalA = edgeAngle(focal);
  const cx = (rect.x0 + rect.x1) / 2;
  const cz = (rect.z0 + rect.z1) / 2;
  const range = (r: readonly [number, number]) => r[0] + rng() * (r[1] - r[0]);
  const pickKind = (accepts: readonly KitKind[]) =>
    accepts[Math.floor(rng() * accepts.length)];

  // First-seen group order; the group's first piece anchors it.
  const groupOrder: string[] = [];
  for (const s of schematic.slots) {
    if (!groupOrder.includes(s.group)) groupOrder.push(s.group);
  }

  /** Resolved slots by role — relative/center/toward anchors read these
   *  (they must be declared EARLIER — the audit enforces it). */
  const roles = new Map<string, ResolvedSlot>();
  /** Seeded dx signs by role (the "opposite" side refs read these). */
  const signs = new Map<string, 1 | -1>();
  /** Group anchor positions (the wallAligned anchors read these). */
  const groupAnchors = new Map<string, { x: number; z: number }>();

  const groups: ResolvedSchematicGroup[] = [];

  for (const gid of groupOrder) {
    const gslots = schematic.slots.filter((s) => s.group === gid);
    const gRequired = gslots.some((s) => s.required);
    const gSkipPath = gslots.some((s) => s.terminus);
    const gIsolated = gslots.some((s) => s.isolated);
    const pieces: ResolvedSchematicPiece[] = [];
    let footprint = 0;
    let gx = 0;
    let gz = 0;
    let grot = 0;
    let placedAny = false;

    for (const slot of gslots) {
      if (slot.chance !== undefined && rng() >= slot.chance) continue;
      const count = slot.count ? Math.max(1, Math.round(range(slot.count))) : 1;
      const variety = slot.scale ? range(slot.scale) : 1;
      const pieceScale = propScale * variety;

      // — anchor: world position (and the wall it landed on, for the
      // facing/spread) for every piece of this slot.
      const world: { x: number; z: number; edge: SchematicEdge }[] = [];
      let anchorErr = false;
      const resolveWall = (
        edge: SchematicEdge | "flank" | "focal",
        distR: readonly [number, number],
        along: number,
        alongTol: number,
        lateralFrom?: { x: number; z: number },
      ): { x: number; z: number; edge: SchematicEdge } | null => {
        let e: SchematicEdge;
        if (edge === "focal") e = focal;
        else if (edge === "flank") {
          const options = (["e", "w", "n"] as const).filter(
            (c) => c !== focal && exposed[c],
          );
          if (options.length === 0) return null;
          e = options[Math.floor(rng() * options.length)];
        } else e = edge;
        const span = edgeSpan(rect, e);
        const lat = lateralFrom
          ? // keep the reference's lateral along THIS wall
            e === "n" || e === "s"
            ? (lateralFrom.x - rect.x0) / Math.max(1e-6, rect.x1 - rect.x0)
            : (lateralFrom.z - rect.z0) / Math.max(1e-6, rect.z1 - rect.z0)
          : along + ((rng() * 2 - 1) * alongTol) / Math.max(1e-6, span);
        const u = Math.min(0.94, Math.max(0.06, lat));
        const p = edgePoint(rect, e, range(distR) * scale, u);
        return { ...p, edge: e };
      };

      // Wall rows resolve ONCE per slot — one edge, one distance draw (the
      // row is straight); the count then steps the pieces along that wall.
      // (Per-piece draws would let a shelf run's pieces land on different
      // walls.) Non-wall anchors resolve per piece — their own draws.
      const at = slot.at;
      const wallish =
        at.kind === "wall" || at.kind === "wallAligned" || at.kind === "flankWall";
      let base: { x: number; z: number; edge: SchematicEdge } | null = null;
      if (at.kind === "wall") {
        base = resolveWall(at.wall, at.dist, at.along, at.alongTol);
      } else if (at.kind === "wallAligned") {
        const ref = groupAnchors.get(at.withAnchor);
        base = ref ? resolveWall(at.wall, at.dist, 0.5, at.alongTol, ref) : null;
      } else if (at.kind === "flankWall") {
        base = resolveWall("flank", at.dist, at.along, at.alongTol);
      }
      if (wallish && !base) {
        if (slot.required) return null;
        continue;
      }

      for (let k = 0; k < count; k++) {
        let p: { x: number; z: number; edge: SchematicEdge };
        if (base) {
          if (count > 1) {
            const step = 1.8 * scale;
            const off = (k - (count - 1) / 2) * step;
            const horizontal = base.edge === "n" || base.edge === "s";
            p = {
              x: base.x + (horizontal ? off : 0),
              z: base.z + (horizontal ? 0 : off),
              edge: base.edge,
            };
          } else {
            p = base;
          }
        } else if (at.kind === "relative") {
          const ref = roles.get(at.slot);
          if (!ref) {
            anchorErr = true;
            break;
          }
          let mag = range(at.dx);
          if (at.side) {
            let sign: 1 | -1;
            if (at.side === "seeded") {
              sign = rng() < 0.5 ? -1 : 1;
              signs.set(slot.role, sign);
            } else {
              const other = signs.get(at.side.opposite);
              if (!other) {
                anchorErr = true;
                break;
              }
              sign = other === 1 ? -1 : 1;
            }
            mag *= sign;
          }
          const dz = range(at.dz);
          // offset in the referenced slot's local frame (+z = its facing)
          const c = Math.cos(ref.rotY);
          const s = Math.sin(ref.rotY);
          p = {
            x: ref.x + mag * c + dz * s,
            z: ref.z - mag * s + dz * c,
            edge: focal,
          };
        } else if (at.kind === "center") {
          const refs = at.slots.map((r) => roles.get(r));
          if (refs.some((r) => !r)) {
            anchorErr = true;
            break;
          }
          const mx = refs.reduce((a, r) => a + r!.x, 0) / refs.length;
          const mz = refs.reduce((a, r) => a + r!.z, 0) / refs.length;
          p = {
            x: mx + range(at.dx) * scale,
            z: mz + range(at.dz) * scale,
            edge: focal,
          };
        } else if (at.kind === "focalCorner") {
          const left = at.corner === "seeded" ? rng() < 0.5 : at.corner === "left";
          const d = range(at.dist) * scale;
          // the focal edge's ends (left = the edge's low-coordinate end)
          p =
            focal === "n" || focal === "s"
              ? {
                  x: left ? rect.x0 + d : rect.x1 - d,
                  z: focal === "n" ? rect.z1 - d : rect.z0 + d,
                  edge: focal,
                }
              : {
                  x: focal === "w" ? rect.x0 + d : rect.x1 - d,
                  z: left ? rect.z0 + d : rect.z1 - d,
                  edge: focal,
                };
        } else {
          // unreachable (wall anchors resolve through `base`) — defensive
          anchorErr = true;
          break;
        }
        world.push(p);
      }
      if (anchorErr) {
        // an optional slot with a failed anchor simply stays out; a
        // required slot forfeits the whole placement
        if (slot.required) return null;
        continue;
      }

      // — facing (absolute), per piece.
      const f = slot.facing;
      const abs = (p: { x: number; z: number; edge: SchematicEdge }): number => {
        switch (f.kind) {
          case "focal":
            return focalA;
          case "intoRoom":
            return (
              edgeAngle(f.wall === "anchor" ? p.edge : f.wall === "focal" ? focal : f.wall) +
              Math.PI
            );
          case "toward": {
            const ref = roles.get(f.slot);
            if (!ref) return focalA;
            return Math.atan2(ref.x - p.x, ref.z - p.z);
          }
          case "moduleCenter":
            return Math.atan2(cx - p.x, cz - p.z);
          case "fixed":
            return f.rotY + (f.jitter > 0 ? (rng() * 2 - 1) * f.jitter : 0);
        }
      };

      for (let k = 0; k < world.length; k++) {
        const p = world[k];
        const kind = pickKind(slot.accepts);
        const rotAbs = abs(p);
        // the group anchors at its FIRST placed piece
        if (!placedAny) {
          placedAny = true;
          gx = p.x;
          gz = p.z;
          grot = rotAbs;
          groupAnchors.set(gid, { x: p.x, z: p.z });
        }
        // group-frame offsets (placeKit maps them back with grot)
        const c = Math.cos(grot);
        const s = Math.sin(grot);
        const dx = (p.x - gx) * c - (p.z - gz) * s;
        const dz = (p.x - gx) * s + (p.z - gz) * c;
        // lift rides the HOST piece's own scale (tabletop support)
        const host =
          slot.lift !== undefined
            ? slot.at.kind === "relative"
              ? roles.get(slot.at.slot)
              : undefined
            : undefined;
        const dy =
          slot.lift !== undefined
            ? slot.lift * (host?.scale ?? pieceScale)
            : 0;
        const resolved: ResolvedSlot = {
          x: p.x,
          z: p.z,
          rotY: rotAbs,
          scale: pieceScale,
          flat: slot.flat === true,
          clearance: slot.clearance,
        };
        pieces.push({
          kind,
          dx,
          dz,
          rotY: rotAbs - grot,
          dy,
          scale: pieceScale,
        });
        if (k === 0) roles.set(slot.role, resolved);
        if (!slot.flat) {
          footprint = Math.max(
            footprint,
            Math.hypot(p.x - gx, p.z - gz) + slot.clearance * scale,
          );
        }
      }
    }

    if (!placedAny) {
      // an empty optional group is simply absent; an empty required
      // group forfeits the placement
      if (gRequired) return null;
      continue;
    }
    groups.push({
      id: `${schematic.moduleId}:${gid}`,
      required: gRequired,
      x: gx,
      z: gz,
      rotY: grot,
      footprint,
      skipPath: gSkipPath,
      isolated: gIsolated,
      pieces,
    });
  }
  return groups;
}

/* ------------------------------------------------------------------ */
/* Catalogue audit (pure data checking — the tests run it)             */
/* ------------------------------------------------------------------ */

/** Blueprint soundness: anchors/facings reference only roles and groups
 *  declared EARLIER (resolution is sequential), counts/scales are
 *  ordered, chances live in (0, 1], required slots never carry a
 *  chance, and the 禁止栏 holds — no banned kind in any accepts. Returns
 *  the violations (empty = sound). */
export function auditSchematic(schematic: RoomSchematic): string[] {
  const problems: string[] = [];
  const banned: readonly KitKind[] = [
    "bench",
    "poolbench",
    "lounger",
    "towelstack",
    "towelrail",
    "bucket",
    "luggagecart",
    "lockerrow",
    "chairstack",
  ];
  const seenRoles: string[] = [];
  const seenGroups: string[] = [];
  for (const slot of schematic.slots) {
    if (slot.accepts.length === 0) {
      problems.push(`${schematic.moduleId}/${slot.role}: empty accepts`);
    }
    for (const kind of slot.accepts) {
      if (banned.includes(kind)) {
        problems.push(`${schematic.moduleId}/${slot.role}: banned kind "${kind}"`);
      }
    }
    if (slot.count && (slot.count[0] < 1 || slot.count[1] < slot.count[0])) {
      problems.push(`${schematic.moduleId}/${slot.role}: bad count range`);
    }
    if (slot.scale && slot.scale[1] < slot.scale[0]) {
      problems.push(`${schematic.moduleId}/${slot.role}: bad scale range`);
    }
    if (slot.chance !== undefined) {
      if (slot.required) {
        problems.push(`${schematic.moduleId}/${slot.role}: required slot with a chance`);
      }
      if (slot.chance <= 0 || slot.chance > 1) {
        problems.push(`${schematic.moduleId}/${slot.role}: chance outside (0, 1]`);
      }
    }
    const needRole = (ref: string, what: string) => {
      if (!seenRoles.includes(ref)) {
        problems.push(`${schematic.moduleId}/${slot.role}: ${what} "${ref}" not declared earlier`);
      }
    };
    if (slot.at.kind === "relative") needRole(slot.at.slot, "relative anchor");
    if (slot.at.kind === "center") {
      for (const r of slot.at.slots) needRole(r, "center anchor");
    }
    if (slot.at.kind === "wallAligned") {
      if (!seenGroups.includes(slot.at.withAnchor)) {
        problems.push(`${schematic.moduleId}/${slot.role}: wallAligned group "${slot.at.withAnchor}" not declared earlier`);
      }
    }
    if (slot.at.kind === "relative" && typeof slot.at.side === "object") {
      if (!signsSeededEarlier(schematic, slot)) {
        problems.push(`${schematic.moduleId}/${slot.role}: opposite side without an earlier seeded side`);
      }
    }
    if (slot.facing.kind === "toward") needRole(slot.facing.slot, "toward facing");
    seenRoles.push(slot.role);
    if (!seenGroups.includes(slot.group)) seenGroups.push(slot.group);
  }
  if (schematic.paths.length === 0) {
    problems.push(`${schematic.moduleId}: no path rules`);
  }
  return problems;

  function signsSeededEarlier(s: RoomSchematic, slot: RoomSlot): boolean {
    if (slot.at.kind !== "relative" || typeof slot.at.side !== "object") return true;
    const idx = s.slots.indexOf(slot);
    return s.slots.slice(0, idx).some(
      (other) => other.at.kind === "relative" && other.at.side === "seeded",
    );
  }
}
