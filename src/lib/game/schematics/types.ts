/**
 * The RoomSchematic data model (v0.12-room-realism §2) — TYPES ONLY.
 *
 * The v0.12b split: the blueprint DATA now lives in the lane-owned family
 * files (./residential, ./service, ./public — one lane each, appended in
 * P2b), spliced by ./index.ts. This module is the shared vocabulary those
 * files author against; room-schematic.ts owns the resolution machinery
 * and re-exports everything so existing import paths never change.
 */
import type { KitKind } from "../kits";

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
