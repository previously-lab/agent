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
 * SKIN OVERRIDES (v0.12 P3 §6.2 — the orchestration wiring). resolveSchematic
 * takes the biome skin the room is forced into as an OPTIONAL argument: a
 * slot whose role the skin overrides (skins.ts skinSlotFeatureFor) draws the
 * skin's environment kind INSTEAD of its seeded accepts pick. The kind is
 * all that changes — the authored anchor, facing, clearance and the pushKit
 * machinery ride unchanged, and the seeded pick's draw is still consumed, so
 * every NON-overridden slot (and the whole room downstream) keeps the legacy
 * stream byte-for-byte. Absent / null reproduces today's bytes exactly.
 * COMPANION RULE — THE GENERAL HOST-DROP (P3-b2): when an override
 * replaced a slot that HOSTS lifted dressing (an EARLIER relative slot
 * with `lift` resting on it), the dressing's authored top may not exist
 * on the replacement (a fountain basin is not the coffee table's 0.4 m
 * dressing surface; a moss bed carries none at all) — the dependent
 * lifted slot then stages NOTHING, so no piece hangs in the air (I2's
 * never-floating rule). Same stream discipline (the dropped slot's draws
 * are still consumed); the rule binds to ANY override × ANY lifted
 * dependent, never to one skin's data.
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
import { skinSlotFeatureFor, type BiomeSkin } from "./skins";
import { SCHEMATICS } from "./schematics";
import type {
  RoomSchematic,
  RoomSlot,
  SchematicEdge,
  SchematicRect,
} from "./schematics/types";

/* The data model lives in ./schematics/types.ts (the lane-owned family
 * files under ./schematics author against it); re-exported here so every
 * existing import path keeps working unchanged. */
export type {
  RoomSchematic,
  RoomSlot,
  SchematicEdge,
  SchematicRect,
  SlotAnchor,
  SlotFacing,
} from "./schematics/types";

/* ------------------------------------------------------------------ */
/* The catalogue — one blueprint per standard room. The blueprint DATA */
/* lives in the lane-owned family files under ./schematics (spliced     */
/* residential → service → public by ./schematics/index.ts; the data   */
/* model in ./schematics/types.ts). This module owns the queries and   */
/* the resolution machinery.                                           */
/* ------------------------------------------------------------------ */

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
  /** §6.2 (P3 wiring): the biome skin the room is forced into, if any —
   *  an overridden role draws the skin's environment kind instead of its
   *  seeded accepts pick (kind-only replacement; see the module header).
   *  Absent / null = the legacy resolution, byte-for-byte. */
  skin?: BiomeSkin | null,
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
  /** §6.2: roles whose kind a skin override replaced — a lifted slot
   *  resting on one of them is skin-dropped (the host-drop rule, below). */
  const skinReplacedRoles = new Set<string>();
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

      // §6.2: ask the skin FIRST — an overridden role draws the skin's
      // environment kind. The seeded pick below still consumes its draw
      // (its result is discarded), so the stream — and with it every
      // non-overridden slot's anchor, facing and clearance — stays the
      // legacy one byte-for-byte.
      const skinKind = skin ? skinSlotFeatureFor(skin, slot.role) : undefined;
      if (skinKind !== undefined) skinReplacedRoles.add(slot.role);

      // §6.2 companion rule — the GENERAL host-drop (see the module
      // header): a LIFTED slot (tabletop dressing, `slot.lift`) rests ON
      // its relative host's authored top. When a skin override replaced
      // the HOST's kind, that top may no longer exist and the lifted
      // pieces would hang in the air (I2) — so the slot stages NOTHING.
      // The slot's seeded draws are still consumed (the stream stays
      // legacy, same discipline as the kind override) and its resolved
      // role still registers (the SPOT is real — the host's replacement
      // stands there, so later relative/toward references keep their
      // legacy behavior); only the pieces, the group's first-piece anchor
      // claim and the footprint contribution are suppressed. Any override
      // × any lifted dependent resolves by this one rule.
      const hostSkinDropped =
        slot.lift !== undefined &&
        slot.at.kind === "relative" &&
        skinReplacedRoles.has(slot.at.slot);

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
        // The seeded pick ALWAYS consumes its draw — even when the skin
        // overrides the result — so the stream (and with it every
        // non-overridden slot's anchors, facings and chance gates) stays
        // byte-identical to the legacy room; the override changes the
        // KIND and nothing else.
        const seededKind = pickKind(slot.accepts);
        const kind = skinKind ?? seededKind;
        const rotAbs = abs(p);
        // the group anchors at its FIRST EMITTED piece — a skin-dropped
        // lifted slot anchors nothing (the host-drop rule)
        if (!placedAny && !hostSkinDropped) {
          placedAny = true;
          gx = p.x;
          gz = p.z;
          grot = rotAbs;
          groupAnchors.set(gid, { x: p.x, z: p.z });
        }
        const resolved: ResolvedSlot = {
          x: p.x,
          z: p.z,
          rotY: rotAbs,
          scale: pieceScale,
          flat: slot.flat === true,
          clearance: slot.clearance,
        };
        // The role registers regardless (the SPOT is real — the host's
        // replacement stands there); only the PIECES are suppressed when
        // the slot is skin-dropped.
        if (k === 0) roles.set(slot.role, resolved);
        if (hostSkinDropped) continue;
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
        pieces.push({
          kind,
          dx,
          dz,
          rotY: rotAbs - grot,
          dy,
          scale: pieceScale,
        });
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

/** The default 禁止栏 (v0.12 §6.4): park-bench / pool-furniture /
 *  housekeeping vocabulary that no blueprint may draw UNLESS it declares
 *  its own `bans` (per-room lists replaced the old one-size ban — the
 *  bath's lockers, the pool deck's loungers and the like are legal in
 *  their own rooms). */
export const DEFAULT_BANNED_KINDS: readonly KitKind[] = [
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

/** Blueprint soundness: anchors/facings reference only roles and groups
 *  declared EARLIER (resolution is sequential), counts/scales are
 *  ordered, chances live in (0, 1], required slots never carry a
 *  chance, and the 禁止栏 holds — no kind from the room's own `bans`
 *  list (DEFAULT_BANNED_KINDS when the blueprint declares none) in any
 *  accepts. Returns the violations (empty = sound). */
export function auditSchematic(schematic: RoomSchematic): string[] {
  const problems: string[] = [];
  const banned = schematic.bans ?? DEFAULT_BANNED_KINDS;
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
