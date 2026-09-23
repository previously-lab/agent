/**
 * Standard room modules + compositions (v0.11-room-interiors §8) — the
 * modular step past the layout templates (§7): a room is no longer one big
 * floor to scatter into, but ONE TO FOUR hand-authored functional units
 * (foyer, bedroom, study, gallery…) joined like building blocks, plus an
 * optional OPEN FIELD (随机区域 — a module-scale void dressed only
 * sparsely). "Large" is expressed by MORE modules, never by enlarging one
 * (§8.3).
 *
 * A module is DATA, never code: its footprint (an integer number of
 *  MODULE_GRID cells a side — 1×1 / 1×2 / 2×1 / 2×2, capped at 2×3), which of
 * its four edges may OPEN onto a sibling module, which exposed edges may
 * carry strand doors and how many, its floor/wall material roles and
 * light register, its feature slots, and its own KIT WHITELIST (ids of
 * kits.ts's hand-written groups — the module's character is exactly that
 * short list, §6's "少而准").
 *
 * THE OUTPUT IS WHAT THE RENDERER ALREADY CONSUMES. `resolveRoomComposition`
 * picks and places the modules; `compositionTemplateFor` folds the placed
 * composition into a synthetic RoomTemplate (room-templates.ts's shape —
 * today always a RECT silhouette, so roomPlanFor / wallSegmentsFor /
 * planContains / composeRoom / placeRoomDoors / stageInteriorKits all run
 * through the existing, verified math with zero new geometry (§7.3: the
 * clearance and door-capacity logic is never re-implemented here). The
 * per-module detail the current shapes cannot carry — the interior seams
 * with their openings, per-module material roles and light registers, the
 * per-module kit whitelists — rides along as OPTIONAL fields on the
 * resolved composition: a consumer that ignores them reproduces today's
 * behaviour byte-for-byte (§8's migration discipline).
 *
 * Determinism (A6): selection and placement ride ONE dedicated stream,
 * hashString(`${worldSeed}:${sliceId}:room-composition`), independent of
 * every other facet's stream and never perturbing them. No three.js, no
 * React, no Math.random, no wall clock.
 *
 * WIRING (2026-10, the renderer adoption). The renderer and the movement
 * clamp both derive the room's dims from ONE recipe view — room-plan.ts's
 * scaledRecipeFor — which swaps the tier dims for the composition's
 * width/extent for interior rooms via `compositionForRecipe` below.
 *
 * DOOR LOAD (§8.4 — the composition grows by content): `compositionForRecipe`
 * takes the runtime strand-door count as an OPTIONAL argument (default 0 —
 * a caller without the count sees today's behaviour byte-for-byte). The
 * count is a PURE DERIVATION of the memory/strand graph for the slice
 * (game-shell.tsx's buildRoomDoorMap — no clock, no randomness, no
 * render-time lookup), hence a legal pure-function input under A6: same
 * (worldSeed, sliceId, worldClass, archetype, doorCount) ⇒ same composition,
 * always. The integrator freezes the count into the ActiveSpace at the wall
 * crossing (game-canvas.tsx), so the renderer and the clamp share ONE value
 * for the whole visit — the room can never morph mid-stay when the strand
 * lane resolves after the mount. The size tier keeps its say as the count
 * hint (§8.3: S one module, M two, L three, XL four — "large" is MORE
 * modules); the door load then pushes the count UPWARD while the placement's
 * declared ceiling cannot absorb it (§8.2: each module declares its own
 * capacity): a busy day grows modules, and more modules ⇒ a longer north
 * wall (§10.5), never doors squeezed onto the east/west walls. A day busier
 * than the composition's declared ceiling rides the §10.5 placement ladder
 * (double-row screens, then axial overflow) exactly as the template layer's
 * overflows always did — room-doors.ts's six-rung ladder stays the last
 * insurance, unchanged.
 *
 * OPEN FIELDS (随机区域, §8.2): resolved as the bounding rect's voids and
 * DRESSED SPARSELY at staging time — kits.ts's stageInteriorKits takes the
 * fields as an optional channel (0–3 seeded pieces per field, drawn from
 * the room's module-filtered deck, riding the same clearance and 留白
 * machinery). Placement must clear the walk path and the door approaches,
 * which exist only on the SCALED plan — so the dressing lives in staging,
 * not here; this module only declares WHERE the fields are.
 */
import {
  KITS,
  kitsFor,
  type Kit,
  type KitClusterRect,
  type KitZoneRect,
  type KitZones,
} from "./kits";
import type {
  FeatureSlot,
  RoomTemplate,
  TemplateZone,
} from "./room-templates";
import { RESIDENTIAL_MODULES } from "./modules/residential";
import { SERVICE_MODULES } from "./modules/service";
import { PUBLIC_MODULES } from "./modules/public";
import { createRng, hashString, WORLD_SEED } from "./seed";
import { parseDebugSlice } from "./debug-slice";
import type { RoomPlan, WallSegment } from "./room-plan";
import type { ArchetypeId, SpaceRecipe, WorldClass } from "./space-types";
import {
  DOOR_LATTICE_HALF_CELL,
  MODULE_GRID,
  MODULE_GRID_MAX_AREA,
  MODULE_GRID_MAX_CELLS,
} from "./tuning/room";

/* ------------------------------------------------------------------ */
/* The data model (§8.2)                                               */
/* ------------------------------------------------------------------ */

/** One edge of a module, in its own frame: n = the far side, s = the side
 *  facing the room's eventual entrance, w/e = the flanks. */
export type ModuleEdge = "n" | "s" | "e" | "w";

/** Coarse floor-material role (the palette's wood/fabric layers supply the
 *  actual colours; the renderer maps the roles when it adopts per-module
 *  materials — design §11.1's four-layer palettes). */
export type FloorRole = "timber" | "carpet" | "tile" | "deck";

/** Coarse wall-material role (palette.wall / wood panelling). */
export type WallRoleM = "plaster" | "panelling" | "tile" | "shelf";

/** The module's light register — how it is lit, not with what colour
 *  (the palette owns colour): task pools over the desk, a cool wash over
 *  the shelf walls, daylight for the sunroom, underwater bounce for the
 *  pool deck. */
export type LightRegister =
  | "task"
  | "wash"
  | "daylight"
  | "pool-bounce"
  | "quiet";

/** One module-local feature slot: like the template's FeatureSlot, but
 *  attached to one of the module's own edges (mapped to a room wall role
 *  when the edge lands on the perimeter — an interior seam never grows a
 *  wall-bound feature). */
export interface ModuleFeature {
  kind: FeatureSlot["kind"];
  at: ModuleEdge | "floor";
  span?: readonly [number, number];
  /** Floor features only: the span's partner on the module's z axis (both
   *  in the module's own frame), carried to the room as spanZ — see
   *  FeatureSlot.spanZ. */
  spanZ?: readonly [number, number];
}

/**
 * A hand-authored standard room module (§8.2's RoomModule) — one
 * functional unit of an interior, an integer number of MODULE_GRID
 * (6 m) cells a side (v0.13 尺度收敛).
 */
export interface RoomModule {
  id: string;
  /** Authoring label (设计稿上的名字). */
  label: string;
  /** World classes / archetypes this module may be PRIMARY for (companion
   *  modules are additionally gated on their kits being drawable in the
   *  room — see compositionCompanionsFor). */
  worldClasses: readonly WorldClass[];
  archetypes: readonly ArchetypeId[];
  /** Footprint in meters (unscaled, human scale): x span × z depth.
 *  MUST snap to the MODULE_GRID: an integer cell count per side, at most
 *  MODULE_GRID_MAX_CELLS cells long and at most MODULE_GRID_MAX_AREA
 *  cells of area (auditModule enforces — 小 1×1, 长 1×2/2×1, 大 2×2,
 *  hard cap 2×3). */
  size: { w: number; d: number };
  /** Edges that may OPEN onto a sibling module (a seam without both sides
   *  consenting stays a wall — the reading room's north shelf wall never
   *  opens). */
  openings: readonly ModuleEdge[];
  /** Edges that may carry STRAND DOORS when they land on the room's
   *  perimeter — §10.5 轴向语义: only the NORTH edge (which maps to the
   *  room's far wall, a north/south face) may ever host, so a module
   *  whose north edge is already authored (the shelf wall, the daylight
   *  glass, the water's edge) declares NO door edges and zero capacity
   *  instead of breaking its own wall. */
  doorEdges: readonly ModuleEdge[];
  /** Declared CEILING on the strand doors this module absorbs — like the
   *  template's doorCapacity: a declared cap, with the measured capacity
   *  of the room's permitted walls applied on top by the caller (Finding
   *  A's discipline, unchanged). */
  doorCapacity: number;
  floor: FloorRole;
  wall: WallRoleM;
  light: LightRegister;
  /** The module's own dressing (§3.2 features, module-local). */
  features: readonly ModuleFeature[];
  /** The module's furnishing whitelist — ids into kits.ts's hand-written
   *  catalogue. Short on
   *  purpose: 少而准 (§6). */
  kits: readonly string[];
  /** The module's composed centrepiece (a kits.ts heroSlot kit id) — the
   *  PRIMARY module's hero becomes the room's hero. */
  heroKit?: string;
  /** The daylight-glass module (the sunroom): its EXPOSED north edge is
   *  not a solid wall but a floor-to-top glass wall with the outside view
   *  (space.tsx's GlassWallSpan — the v0.12 附录 A `glasswall` 墙面处理;
   *  the wall registers stay SOLID for the movement clamp — glass is a
   *  boundary, not a door). Only ever declared on the sunroom, whose
   *  authored north edge carries no doors and no openings. */
  glassWall?: boolean;
  /** Content zones, normalized to the MODULE's frame (x ∈ [0,1] → west→east,
   *  z ∈ [0,1] → south→north). At most one hero zone. */
  zones: readonly TemplateZone[];
  /** Selection weight among eligible primary candidates. */
  weight: number;
}

/* ------------------------------------------------------------------ */
/* The module catalogue (§8.2) — thirteen functional units, each with a */
/* character, each furnished by a SHORT whitelist of the existing kits. */
/*                                                                    */
/* The module DATA lives in the lane-owned family files under         */
/* ./modules (each family keeps its historical relative order). The   */
/* GLOBAL order is pinned HERE: seed draws and staging pins read      */
/* ROOM_MODULES positionally, so MODULE_ORDER must never drift — the  */
/* lanes never edit this file.                                        */
/* ------------------------------------------------------------------ */

/** The catalogue's global order — the thirteen ids exactly as today,
 *  frozen. The family files keep their own relative order; this list is
 *  the single place the three families interleave. Never reorder or
 *  drop; a new module enters only with the main agent's sign-off. */
export const MODULE_ORDER: readonly string[] = [
  "foyer",
  "bedroom",
  "study",
  "reading-room",
  "kitchen",
  "bath",
  "storage",
  "gallery-module",
  "living",
  "sunroom",
  "pool-deck",
  "dining-hall",
  "workshop",
];

const MODULES_BY_ID: ReadonlyMap<string, RoomModule> = new Map(
  [...RESIDENTIAL_MODULES, ...SERVICE_MODULES, ...PUBLIC_MODULES].map(
    (m) => [m.id, m] as const,
  ),
);

/** The thirteen standard room modules, assembled in MODULE_ORDER. */
export const ROOM_MODULES: readonly RoomModule[] = MODULE_ORDER.map((id) => {
  const m = MODULES_BY_ID.get(id);
  if (!m) throw new Error(`MODULE_ORDER names unknown module "${id}"`);
  return m;
});

/** Look up a module by id. */
export function roomModuleById(id: string): RoomModule | undefined {
  return ROOM_MODULES.find((m) => m.id === id);
}

/* ------------------------------------------------------------------ */
/* Composition (§8.2) — placement + resolution                         */
/* ------------------------------------------------------------------ */

/** How the modules join (§8.2): a row, an L, a cross, or a ring. */
export type TopologyId = "row" | "ell" | "cross" | "ring";

/** The module counts each topology joins. */
export const TOPOLOGY_COUNTS: Record<TopologyId, readonly number[]> = {
  row: [1, 2, 3],
  ell: [2, 3],
  cross: [3, 4],
  ring: [4],
};

/** One placed module: its rect in the room's canonical local frame
 *  (meters, unscaled — the doorway sits at (0, 0), x centered, +z inward),
 *  which of its edges land on the room's perimeter, and which seams it
 *  consents to open. */
export interface PlacedModule {
  module: RoomModule;
  /** Room-frame rect: x0 ≤ x1 (centered on the entrance axis), z0 ≤ z1. */
  rect: { x0: number; z0: number; x1: number; z1: number };
  /** Perimeter exposure per edge — only exposed edges may carry strand
   *  doors or wall-bound features. */
  exposed: Record<ModuleEdge, boolean>;
  /** Seams this module shares with a sibling (both sides consented). */
  seams: { edge: ModuleEdge; withId: string }[];
  /** True for the composition's primary module (its hero becomes the
   *  room's hero). */
  primary: boolean;
}

/** An interior seam between two consenting modules — the OPTIONAL
 *  "partition + opening" data (§8's migration discipline): a consumer that
 *  draws it gets rooms-within-rooms; one that ignores it gets today's
 *  single floor, byte-for-byte. */
export interface ModuleSeam {
  aId: string;
  bId: string;
  /** The shared wall line in the room frame (axis-aligned: x0 === x1 for a
   *  vertical seam, z0 === z1 for a horizontal one). */
  line: { x0: number; z0: number; x1: number; z1: number };
  /** The opening's center along the seam (m from line start) and its
   *  clear width (m) — seeded, never equidistant between two seams. */
  opening: { at: number; width: number };
}

/** The resolved composition — the parsed result of (slice, seed). */
export interface RoomComposition {
  topology: TopologyId;
  /** Bounding dims of the placed modules (meters, unscaled): the room's
   *  width × extent — MORE modules, not bigger ones (§8.3). */
  width: number;
  extent: number;
  modules: readonly PlacedModule[];
  seams: readonly ModuleSeam[];
  /** The 随机区域: module-scale open fields inside the bounding rect that
   *  no module claims — room-frame rects, dressed only sparsely by the
   *  staging channel (kits.ts's openFields input: 0–3 seeded pieces per
   *  field from the room's module-filtered deck, same clearances and 留白
   *  budget as the module floors). */
  openFields: readonly { x0: number; z0: number; x1: number; z1: number }[];
  /** Declared door ceiling of the whole composition: the sum of the
   *  placed modules' ceilings, counting only modules that actually expose
   *  a door-eligible edge on the perimeter (a buried module cannot carry
   *  what it cannot touch). */
  doorCapacity: number;
}

/* ------------------------------------------------------------------ */
/* Placement math                                                      */
/* ------------------------------------------------------------------ */

type Rect = { x0: number; z0: number; x1: number; z1: number };

const OPPOSITE: Record<ModuleEdge, ModuleEdge> = { n: "s", s: "n", e: "w", w: "e" };

/** Room-frame rect for a module whose SOUTH-WEST corner sits at (x0, z0)
 *  in a provisional southwest-anchored frame (shifted to the centered
 *  entrance frame once the bounds are known). */
function moduleRect(m: RoomModule, x0: number, z0: number): Rect {
  return { x0, z0, x1: x0 + m.size.w, z1: z0 + m.size.d };
}

/** A shared edge counts as a SEAM only when it can hold a doorway: 1 m of
 *  jamb margin on both ends plus a 1 m clear opening (§: a shorter abutment
 *  is just two walls touching, never a connection). */
const SEAM_MIN = 3;

/** Do two southwest-frame rects share a seam (doorway-length shared
 *  edge)? Returns the seam line and each side's edge, else null. */
function sharedSeam(a: Rect, b: Rect): { edge: ModuleEdge; line: Rect } | null {
  const eps = 1e-9;
  // b east of a (a's east edge = b's west edge).
  if (Math.abs(a.x1 - b.x0) < eps) {
    const z0 = Math.max(a.z0, b.z0);
    const z1 = Math.min(a.z1, b.z1);
    if (z1 - z0 >= SEAM_MIN) return { edge: "e", line: { x0: a.x1, z0, x1: a.x1, z1 } };
  }
  if (Math.abs(b.x1 - a.x0) < eps) {
    const z0 = Math.max(a.z0, b.z0);
    const z1 = Math.min(a.z1, b.z1);
    if (z1 - z0 >= SEAM_MIN) return { edge: "w", line: { x0: a.x0, z0, x1: a.x0, z1 } };
  }
  if (Math.abs(a.z1 - b.z0) < eps) {
    const x0 = Math.max(a.x0, b.x0);
    const x1 = Math.min(a.x1, b.x1);
    if (x1 - x0 >= SEAM_MIN) return { edge: "n", line: { x0, z0: a.z1, x1, z1: a.z1 } };
  }
  if (Math.abs(b.z1 - a.z0) < eps) {
    const x0 = Math.max(a.x0, b.x0);
    const x1 = Math.min(a.x1, b.x1);
    if (x1 - x0 >= SEAM_MIN) return { edge: "s", line: { x0, z0: a.z0, x1, z1: a.z0 } };
  }
  return null;
}

function rectsOverlap(a: Rect, b: Rect): boolean {
  return a.x0 < b.x1 - 1e-9 && b.x0 < a.x1 - 1e-9 && a.z0 < b.z1 - 1e-9 && b.z0 < a.z1 - 1e-9;
}

/**
 * Lay out the modules (index 0 = primary) in the given topology, in a
 * provisional southwest-anchored frame. Placement consumes the caller's
 * seeded rng only where a choice exists (the L's wing side, the cross's
 * missing arm). Returns null when the modules cannot join under this
 * topology (an opening refused, an overlap) — the resolver then tries the
 * next topology, deterministically.
 */
function layoutModules(
  rng: () => number,
  modules: readonly RoomModule[],
  topology: TopologyId,
): Rect[] | null {
  const rects: Rect[] = [];
  const place = (m: RoomModule, x0: number, z0: number): Rect | null => {
    const r = moduleRect(m, x0, z0);
    if (rects.some((o) => rectsOverlap(r, o))) return null;
    // Every module after the first must CONSENT to at least one seam with
    // an already-placed module (both edges in the other's openings).
    if (rects.length > 0) {
      const joined = rects.some((o, i) => {
        const seam = sharedSeam(r, o);
        if (!seam) return false;
        return (
          m.openings.includes(seam.edge) &&
          modules[i].openings.includes(OPPOSITE[seam.edge])
        );
      });
      if (!joined) return null;
    }
    rects.push(r);
    return r;
  };

  if (topology === "row") {
    // West→east along the south edge, centered later: each next module
    // abuts the previous one's east edge, south-aligned at z = 0.
    let x = 0;
    for (const m of modules) {
      if (!place(m, x, 0)) return null;
      x += m.size.w;
    }
    return rects;
  }

  if (topology === "ell") {
    // Primary at the southwest corner; the wing rises north of one of its
    // flanks (seeded side): module 1 sits north of the primary, hugging
    // the seeded side; module 2 abuts module 1's other flank.
    if (!place(modules[0], 0, 0)) return null;
    const wingEast = rng() < 0.5;
    const a = rects[0];
    const m1 = modules[1];
    const x1 = wingEast ? a.x1 - m1.size.w : a.x0;
    if (!place(m1, x1, a.z1)) return null;
    if (modules.length > 2) {
      const b = rects[1];
      const m2 = modules[2];
      const x2 = wingEast ? b.x0 - m2.size.w : b.x1;
      if (!place(m2, x2, b.z0)) return null;
    }
    return rects;
  }

  if (topology === "cross") {
    // Primary at the center; arms on three of its four edges (four
    // modules = all four arms), the south arm kept LAST so the entrance
    // apron stays open toward z = 0. The missing arm (3 modules) is
    // seeded — never the south one.
    const c = modules[0];
    if (!place(c, 0, 0)) return null;
    const cr = rects[0];
    // Seeded rotation of which side arm is placed first reads as variety
    // without ever blocking the entrance side.
    const rot = Math.floor(rng() * 2);
    const sides: ModuleEdge[] = rot === 0 ? ["e", "w"] : ["w", "e"];
    const edges: ModuleEdge[] =
      modules.length === 4 ? ["n", ...sides, "s"] : ["n", ...sides];
    for (let i = 1; i < modules.length; i++) {
      const edge = edges[i - 1];
      const m = modules[i];
      let x0 = 0;
      let z0 = 0;
      if (edge === "n") {
        x0 = cr.x0 + (cr.x1 - cr.x0) / 2 - m.size.w / 2;
        z0 = cr.z1;
      } else if (edge === "s") {
        x0 = cr.x0 + (cr.x1 - cr.x0) / 2 - m.size.w / 2;
        z0 = cr.z0 - m.size.d;
      } else if (edge === "e") {
        x0 = cr.x1;
        z0 = cr.z0 + (cr.z1 - cr.z0) / 2 - m.size.d / 2;
      } else {
        x0 = cr.x0 - m.size.w;
        z0 = cr.z0 + (cr.z1 - cr.z0) / 2 - m.size.d / 2;
      }
      if (!place(m, x0, z0)) return null;
    }
    return rects;
  }

  // ring: four modules at the four corners around a central crossing (the
  // crossing is the open field — 随机区域 as the composition's hinge).
  // Primary takes the southwest corner; the east module abuts it across
  // the crossing gap, the north module rises above the primary, and the
  // fourth closes the ring above the east one — a chain of three seams
  // (sw–se, sw–nw, se–ne) that always exists geometrically; consent
  // decides whether it JOINS (a refused seam fails the topology, and the
  // resolver tries the next one).
  const gap = 3; // the crossing's clear width (m)
  const [sw, se, nw, ne] = modules;
  if (!place(sw, 0, 0)) return null;
  if (!place(se, sw.size.w + gap, 0)) return null;
  if (!place(nw, 0, sw.size.d + gap)) return null;
  if (!place(ne, sw.size.w + gap, se.size.d + gap)) return null;
  return rects;
}

/** Axis-aligned difference: the parts of `outer` not covered by any of
 *  `holes`, as a disjoint rect list (the 随机区域 open fields). Sliver
 *  rects under 1 m² are dropped. */
export function rectDifference(outer: Rect, holes: readonly Rect[]): Rect[] {
  let rest: Rect[] = [outer];
  for (const h of holes) {
    const next: Rect[] = [];
    for (const r of rest) {
      if (!rectsOverlap(r, h)) {
        next.push(r);
        continue;
      }
      const x0 = Math.max(r.x0, h.x0);
      const x1 = Math.min(r.x1, h.x1);
      const z0 = Math.max(r.z0, h.z0);
      const z1 = Math.min(r.z1, h.z1);
      // West / east strips full height, then south / north strips between.
      if (r.x0 < x0 - 1e-9) next.push({ x0: r.x0, z0: r.z0, x1: x0, z1: r.z1 });
      if (x1 < r.x1 - 1e-9) next.push({ x0: x1, z0: r.z0, x1: r.x1, z1: r.z1 });
      if (r.z0 < z0 - 1e-9) next.push({ x0, z0: r.z0, x1, z1: z0 });
      if (z1 < r.z1 - 1e-9) next.push({ x0, z0: z1, x1, z1: r.z1 });
    }
    rest = next;
  }
  return rest.filter((r) => (r.x1 - r.x0) * (r.z1 - r.z0) >= 1);
}

/* ------------------------------------------------------------------ */
/* Selection                                                           */
/* ------------------------------------------------------------------ */

/** The kit ids of `module` that a room of this archetype may actually draw
 *  (kits.ts's own eligibility — the whitelist never widens a kit's
 *  archetype gate). */
export function moduleKitsFor(module: RoomModule, archetype: string): readonly Kit[] {
  const drawable = kitsFor("interior", archetype, 96);
  return drawable.filter((k) => module.kits.includes(k.id));
}

/** Modules eligible to be the composition's PRIMARY for this room. */
export function primaryModulesFor(
  worldClass: string,
  archetype: string,
): readonly RoomModule[] {
  return ROOM_MODULES.filter(
    (m) =>
      (m.worldClasses as readonly string[]).includes(worldClass) &&
      (m.archetypes as readonly string[]).includes(archetype) &&
      moduleKitsFor(m, archetype).length > 0,
  );
}

/** Modules eligible to JOIN as companions: any interior module whose
 *  whitelist still yields at least one drawable kit in this room (a
 *  companion that would render empty never joins). The primary's own id
 *  may repeat at most as the catalogue allows — a composition never
 *  contains the same module twice (the jigsaw reads as different rooms). */
function companionsFor(archetype: string, taken: readonly string[]): readonly RoomModule[] {
  return ROOM_MODULES.filter(
    (m) =>
      m.worldClasses.includes("interior") &&
      !taken.includes(m.id) &&
      moduleKitsFor(m, archetype).length > 0,
  );
}

/** Seeded weighted pick. */
function weightedPick(
  rng: () => number,
  items: readonly RoomModule[],
): RoomModule {
  let ticket = rng() * items.reduce((sum, m) => sum + m.weight, 0);
  for (const m of items) {
    ticket -= m.weight;
    if (ticket < 0) return m;
  }
  return items[items.length - 1];
}

/** The composition's declared door ceiling for one placement. */
function placedCapacity(
  modules: readonly RoomModule[],
  rects: readonly Rect[],
  bounds: Rect,
): number {
  const eps = 1e-6;
  let cap = 0;
  modules.forEach((m, i) => {
    const r = rects[i];
    const exposed = {
      n: Math.abs(r.z1 - bounds.z1) < eps,
      s: Math.abs(r.z0 - bounds.z0) < eps,
      e: Math.abs(r.x1 - bounds.x1) < eps,
      w: Math.abs(r.x0 - bounds.x0) < eps,
    };
    if (m.doorEdges.some((e) => exposed[e])) cap += m.doorCapacity;
  });
  return cap;
}

function boundsOf(rects: readonly Rect[]): Rect {
  return {
    x0: Math.min(...rects.map((r) => r.x0)),
    z0: Math.min(...rects.map((r) => r.z0)),
    x1: Math.max(...rects.map((r) => r.x1)),
    z1: Math.max(...rects.map((r) => r.z1)),
  };
}

/* ------------------------------------------------------------------ */
/* The resolver                                                        */
/* ------------------------------------------------------------------ */

/** The stream key for this facet — its own stream, never shared (A6). */
function compositionRng(worldSeed: string, sliceId: string): () => number {
  return createRng(hashString(`${worldSeed}:${sliceId}:room-composition`));
}

/**
 * Resolve a slice's room composition: the primary module, its companions,
 * the topology joining them, and the open fields left over (§8.2).
 *
 * Selection steers by the strand-door count exactly as the template layer
 * does (§7.2's 门数匹配在源头承担): the module count starts seeded (1–4,
 * weighted toward 2) and rises while the placement's DECLARED ceiling
 * cannot absorb `doorCount` — the measured capacity of the permitted
 * walls stays the caller's check on top (Finding A), and overflow still
 * relaxes at placement, never drops (room-doors.ts).
 *
 * Returns null where the catalogue cannot serve the room at all (today:
 * every non-interior world class — the module set covers interior only,
 * matching the template layer's first-step scope).
 *
 * `countHint` (optional, §8.3 convergence) pins the seeded module count —
 * the size tier's say in how many units the room joins ("large" is MORE
 * modules, never bigger ones). The rng draw that would have picked the
 * count is still consumed, so a hinted and an unhinted resolution of the
 * same slice draw the same primary and companions. The door load may still
 * push the count upward from the hint.
 *
 * Deterministic: same (worldSeed, sliceId, worldClass, archetype,
 * doorCount, countHint) ⇒ same composition, always; independent of call
 * order.
 */
export function resolveRoomComposition(
  sliceId: string,
  worldClass: string,
  archetype: string,
  doorCount: number = 0,
  worldSeed: string = WORLD_SEED,
  countHint?: number,
  /** Debug gallery (debug-slice.ts): pin the primary module rather than
   *  drawing it. Callers pass a countHint of 1 alongside, so the forced room
   *  is exactly that module; a real slice never sets it. */
  forcedPrimaryId?: string,
): RoomComposition | null {
  const primaries = primaryModulesFor(worldClass, archetype);
  const forcedPrimary = forcedPrimaryId
    ? roomModuleById(forcedPrimaryId)
    : undefined;
  if (primaries.length === 0 && !forcedPrimary) return null;
  const rng = compositionRng(worldSeed, sliceId);
  const primary = forcedPrimary ?? weightedPick(rng, primaries);

  // Topology order for each module count, seeded: the resolver walks the
  // list and keeps the first placement that joins.
  const topologiesFor = (count: number): TopologyId[] => {
    const all = (Object.keys(TOPOLOGY_COUNTS) as TopologyId[]).filter((t) =>
      TOPOLOGY_COUNTS[t].includes(count),
    );
    // Seeded rotation so the same count does not always try row first.
    const rot = all.length === 0 ? 0 : Math.floor(rng() * all.length);
    return [...all.slice(rot), ...all.slice(0, rot)];
  };

  // Seeded module count, weighted toward two (the suite reads as the
  // default home); the door load may push it upward below. A countHint
  // (§8.3 — the size tier's say) overrides the draw but still consumes it,
  // so the streams of hinted and unhinted resolutions stay aligned.
  const countWeights = [1, 3, 2, 1];
  let countTicket = rng() * countWeights.reduce((a, b) => a + b, 0);
  let count = 1;
  for (let i = 0; i < countWeights.length; i++) {
    countTicket -= countWeights[i];
    if (countTicket < 0) {
      count = i + 1;
      break;
    }
    count = i + 1;
  }
  if (countHint !== undefined) {
    count = Math.max(1, Math.min(4, Math.round(countHint)));
  }

  // Candidate counts: the seeded count first, then upward while the door
  // load demands capacity, then downward in case the seeded count's
  // modules cannot join at all (a companion set no topology accepts).
  const candidateCounts: number[] = [];
  for (let c = count; c <= 4; c++) candidateCounts.push(c);
  for (let c = count - 1; c >= 1; c--) candidateCounts.push(c);

  // The best placement that JOINED so far (first topology of its count),
  // kept as the fallback when nothing meets the door load — overflow then
  // relaxes at placement, never drops (room-doors.ts).
  let best: { modules: RoomModule[]; rects: Rect[]; topology: TopologyId; capacity: number } | null =
    null;

  for (const c of candidateCounts) {
    if (companionsFor(archetype, [primary.id]).length < c - 1) continue;
    // Companions: seeded weighted picks without replacement — drawn once
    // per count so the topologies below re-seat the SAME modules (the
    // stream stays ordered, the picks never depend on topology order).
    const companions: RoomModule[] = [];
    const taken = [primary.id];
    for (let i = 0; i < c - 1; i++) {
      const picked = weightedPick(rng, companionsFor(archetype, taken));
      companions.push(picked);
      taken.push(picked.id);
    }
    const modules = [primary, ...companions];
    for (const topology of topologiesFor(c)) {
      const rects = layoutModules(rng, modules, topology);
      if (!rects) continue;
      const capacity = placedCapacity(modules, rects, boundsOf(rects));
      if (capacity >= doorCount) {
        return buildComposition(rng, modules, rects, topology, boundsOf(rects));
      }
      if (!best || capacity > best.capacity) {
        best = { modules, rects, topology, capacity };
      }
      break; // one joined placement per count is enough — grow instead
    }
  }
  // Nothing absorbed the door load (or only lesser placements joined):
  // the highest-capacity fallback carries the overflow. The single-module
  // row always joins, so `best` is set whenever the catalogue is sound;
  // the guard below is for the unsound-catalogue case only.
  const b = best ?? {
    modules: [primary],
    rects: layoutModules(rng, [primary], "row") ?? [],
    topology: "row" as TopologyId,
    capacity: 0,
  };
  return buildComposition(rng, b.modules, b.rects, b.topology, boundsOf(b.rects));
}

/* ------------------------------------------------------------------ */
/* The renderer's entry point (§8.3 convergence)                        */
/* ------------------------------------------------------------------ */

/** The size tier's module count (§8.3: "large" is MORE modules, never a
 *  bigger one): S keeps a single standard room, M joins two, L three, XL
 *  four. The composition's bounding box — not the tier's extent — then
 *  sizes the room (scaledRecipeFor). */
export const TIER_MODULE_COUNTS: Record<SpaceRecipe["size"]["id"], number> = {
  S: 1,
  M: 2,
  L: 3,
  XL: 4,
};

/**
 * The composition of one recipe's room — the ONE resolution the whole
 * render/contain chain shares (scaledRecipeFor sizes the plan from it;
 * the renderer's template branch folds the same value into a synthetic
 * RoomTemplate). Pure function of the recipe plus the caller's strand-door
 * count (default 0 — identical to every pre-door-load resolution): the
 * count is derived from the strand graph by the data lane, and freezing it
 * per visit keeps the renderer and the clamp on one value (see the module
 * header). Returns null for every non-interior class, where the room stays
 * byte-for-byte as it was before modules.
 */
export function compositionForRecipe(
  recipe: SpaceRecipe,
  worldSeed: string = WORLD_SEED,
  doorCount: number = 0,
): RoomComposition | null {
  if (recipe.worldClass !== "interior") return null;
  // Debug gallery (debug-slice.ts): a `dbg-m:` slice composes THAT module and
  // nothing else, so the standard rooms can be reviewed one at a time.
  const dbg = parseDebugSlice(recipe.sliceId);
  const forced = dbg?.page === "modules" ? dbg.id : undefined;
  return resolveRoomComposition(
    recipe.sliceId,
    recipe.worldClass,
    recipe.archetype,
    doorCount,
    worldSeed,
    forced ? 1 : TIER_MODULE_COUNTS[recipe.size.id],
    forced,
  );
}

/* ------------------------------------------------------------------ */
/* Seam partitions (§8) — ONE derivation, two consumers.               */
/* ------------------------------------------------------------------ */

/**
 * One interior seam as built geometry: the two full-height JAMB boxes and
 * the HEADER over the opening. Same footprint shape as the perimeter's
 * WallSegment (the renderer supplies the height); `aId` is the seam's
 * a-side module — the tint owner for the per-module wall register (§8.2).
 */
export interface SeamPartition {
  flanks: WallSegment[];
  header: WallSegment;
  aId: string;
}

/**
 * The interior seam partitions of a composition — the walls BETWEEN the
 * joined modules — in the room's local plan frame (doorway at (0,0), +z
 * outward), SCALED by `scaleFactor` at thickness `wallThick`. THE single
 * derivation both consumers build from, so the clamp can never disagree
 * with the drawn wall:
 *
 *  - space.tsx renders each partition (jambs + header, opaque, full
 *    height) and feeds the jamb runs to the kit obstacle channel;
 *  - clamps.ts contains the player to the JAMBS only — the header sits
 *    above human height (A4) and the opening between the jambs must stay
 *    walkable, so neither belongs to any solid box.
 *
 * A seam too short to hold a walkable opening at this scale (a miniature
 * dollhouse room) is left open instead of growing an unenterable doorway.
 */
export function seamPartitionsFor(
  comp: RoomComposition,
  scaleFactor: number,
  wallThick: number,
): SeamPartition[] {
  const out: SeamPartition[] = [];
  const jamb = Math.max(0.3, wallThick);
  // The entrance doorway gap half — clamps.ts's GAP_HALF (0.6), the one
  // doorway constant, restated here so this module stays cycle-free.
  const DOOR_GAP_HALF = 0.6;
  for (const seam of comp.seams) {
    const horizontal = Math.abs(seam.line.z0 - seam.line.z1) < 1e-9;
    const sx0 = seam.line.x0 * scaleFactor;
    const sz0 = seam.line.z0 * scaleFactor;
    const sx1 = seam.line.x1 * scaleFactor;
    const sz1 = seam.line.z1 * scaleFactor;
    const len = horizontal ? sx1 - sx0 : sz1 - sz0;
    const openW = Math.min(seam.opening.width, len - jamb * 2);
    if (openW < 1.2) continue;
    let at = Math.min(
      Math.max(seam.opening.at * scaleFactor, jamb + openW / 2),
      len - jamb - openW / 2,
    );
    // ENTRANCE DOORWAY STRIP (门廊净空): no partition wall may cross the
    // doorway gap. A row of equal-width modules can center a vertical
    // seam on the door axis, and the cross's south arm can lay a
    // horizontal one along the entrance plane — either would plant a jamb
    // in the doorway. Such a seam's opening is FORCED over the strip: a
    // vertical seam opens right at the entrance (the two modules share an
    // open vestibule there, the partition starts past the apron), a
    // horizontal one's opening centers on the door axis. Any flank still
    // overlapping the strip after the forced opening (only possible when
    // the clamped opening could not reach) is dropped rather than allowed
    // to block the gap. Pure geometry override — the composition's seeded
    // data and rng streams are untouched.
    const onEntrance = sz0 <= 1e-9;
    const crossesStrip = onEntrance && (
      horizontal
        ? sx0 < DOOR_GAP_HALF && sx1 > -DOOR_GAP_HALF
        : Math.abs(sx0) < DOOR_GAP_HALF + wallThick
    );
    if (crossesStrip) {
      at = horizontal
        ? Math.min(Math.max(-sx0, jamb + openW / 2), len - jamb - openW / 2)
        : Math.min(Math.max(openW / 2 + 0.2, jamb + openW / 2), len - jamb - openW / 2);
    }
    const o0 = at - openW / 2;
    const o1 = at + openW / 2;
    const flank = (a: number, b: number): WallSegment =>
      horizontal
        ? { x: sx0 + (a + b) / 2, z: sz0, sizeX: b - a, sizeZ: wallThick, entrance: false }
        : { x: sx0, z: sz0 + (a + b) / 2, sizeX: wallThick, sizeZ: b - a, entrance: false };
    const stripLo = -(DOOR_GAP_HALF + wallThick);
    const stripHi = DOOR_GAP_HALF + wallThick;
    const overlapsStrip = (s: WallSegment) =>
      s.z - s.sizeZ / 2 < wallThick &&
      s.z + s.sizeZ / 2 > -wallThick &&
      s.x - s.sizeX / 2 < stripHi &&
      s.x + s.sizeX / 2 > stripLo;
    const flanks = [flank(-wallThick, o0), flank(o1, len + wallThick)].filter(
      (s) => Math.max(s.sizeX, s.sizeZ) > 0.05 && !(crossesStrip && overlapsStrip(s)),
    );
    const header: WallSegment = horizontal
      ? { x: sx0 + at, z: sz0, sizeX: openW + wallThick, sizeZ: wallThick, entrance: false }
      : { x: sx0, z: sz0 + at, sizeX: wallThick, sizeZ: openW + wallThick, entrance: false };
    out.push({ flanks, header, aId: seam.aId });
  }
  return out;
}

/** The module whose exposed edge one PERIMETER segment of a composed room
 *  sits on — the source of that span's wall-material role (§8.2's
 *  per-module wall register). The composition's room is always a rect (x
 *  centered on the doorway, z ∈ [0, extent]), so the segment's edge is
 *  classified by its outer face. Returns null for the entrance wall, a
 *  span no single module covers (two modules share the edge), or a
 *  segment off the perimeter — the caller keeps the room default there.
 *  Pure. */
export function moduleWallForSegment(
  comp: RoomComposition,
  seg: { x: number; z: number; sizeX: number; sizeZ: number },
  scaleFactor: number,
): WallRoleM | null {
  const eps = 1e-6;
  const halfW = (comp.width / 2) * scaleFactor;
  const extent = comp.extent * scaleFactor;
  const horizontal = seg.sizeZ <= seg.sizeX;
  let edge: ModuleEdge;
  let lo: number;
  let hi: number;
  if (horizontal) {
    const outerZ = seg.z + seg.sizeZ / 2;
    if (Math.abs(outerZ - extent) < eps) edge = "n";
    else if (Math.abs(outerZ) < eps) return null; // the entrance wall
    else return null;
    lo = seg.x - seg.sizeX / 2;
    hi = seg.x + seg.sizeX / 2;
  } else {
    const outerX = seg.x + (seg.x < 0 ? -seg.sizeX / 2 : seg.sizeX / 2);
    if (Math.abs(outerX + halfW) < eps) edge = "w";
    else if (Math.abs(outerX - halfW) < eps) edge = "e";
    else return null;
    lo = seg.z - seg.sizeZ / 2;
    hi = seg.z + seg.sizeZ / 2;
  }
  const w = comp.width * scaleFactor;
  const found: WallRoleM[] = [];
  for (const placed of comp.modules) {
    if (!placed.exposed[edge]) continue;
    const r = placed.rect;
    const rLo = (edge === "w" || edge === "e" ? r.z0 : r.x0) * scaleFactor;
    const rHi = (edge === "w" || edge === "e" ? r.z1 : r.x1) * scaleFactor;
    // The module's span along the wall must COVER the whole segment.
    if (rLo > lo + eps || rHi < hi - eps) continue;
    // And the segment must actually sit on the module's own edge line
    // (the exposure flag says the edge is on the perimeter; this pins
    // which perimeter line that is).
    if (edge === "n" && Math.abs(r.z1 * scaleFactor - extent) > eps) continue;
    if (edge === "w" && Math.abs(r.x0 * scaleFactor + halfW) > eps) continue;
    if (edge === "e" && Math.abs(r.x1 * scaleFactor - halfW) > eps) continue;
    found.push(placed.module.wall);
  }
  return found.length === 1 ? found[0] : null;
}

/** A module register sconce's wall anchor: the point on the wall's inner
 *  face (plan-local, scaled) and the wall's inward normal. */
export interface ModuleSconceAnchor {
  x: number;
  z: number;
  nx: number;
  nz: number;
  register: LightRegister;
}

/** How far a sconce's center must sit from a strand door's slab (m,
 *  scaled): the door's gap half plus a hand's margin — a sconce never
 *  shares its wall with a doorway. */
const SCONE_DOOR_CLEAR = 1.7;

/**
 * Where one module's register sconce hangs: the midpoint of the module's
 * first exposed edge — north, then east, then west (never the entrance
 * wall) — that is neither a cutaway sill (`blockedEdges`, no wall face at
 * fixture height there) nor within SCONE_DOOR_CLEAR of a strand door's
 * slab along the wall. Null when every candidate is disqualified: the
 * register then shows only through the module's floor tint, never through
 * a floating light (B.13 — no sourceless light). Pure. */
export function moduleSconceFor(
  placed: PlacedModule,
  comp: RoomComposition,
  scaleFactor: number,
  wallThick: number,
  doors: readonly { x: number; z: number }[],
  blockedEdges: ReadonlySet<ModuleEdge>,
): ModuleSconceAnchor | null {
  const r = placed.rect;
  const candidates: { edge: ModuleEdge; x: number; z: number; nx: number; nz: number }[] = [
    {
      edge: "n",
      x: ((r.x0 + r.x1) / 2) * scaleFactor,
      z: r.z1 * scaleFactor - wallThick - 0.08,
      nx: 0,
      nz: -1,
    },
    {
      edge: "e",
      x: r.x1 * scaleFactor - wallThick - 0.08,
      z: ((r.z0 + r.z1) / 2) * scaleFactor,
      nx: -1,
      nz: 0,
    },
    {
      edge: "w",
      x: r.x0 * scaleFactor + wallThick + 0.08,
      z: ((r.z0 + r.z1) / 2) * scaleFactor,
      nx: 1,
      nz: 0,
    },
  ];
  for (const c of candidates) {
    if (!placed.exposed[c.edge]) continue;
    if (blockedEdges.has(c.edge)) continue;
    const tx = -c.nz;
    const tz = c.nx;
    const conflicts = doors.some((d) => {
      const along = (d.x - c.x) * tx + (d.z - c.z) * tz;
      const perp = (d.x - c.x) * c.nx + (d.z - c.z) * c.nz;
      return Math.abs(along) < SCONE_DOOR_CLEAR && Math.abs(perp) < 1.2;
    });
    if (conflicts) continue;
    return { x: c.x, z: c.z, nx: c.nx, nz: c.nz, register: placed.module.light };
  }
  return null;
}

/** Fold a successful placement into the resolved composition: shift to
 *  the centered entrance frame, compute exposure, seams (with seeded
 *  openings), open fields, and the declared door ceiling. */
function buildComposition(
  rng: () => number,
  modules: readonly RoomModule[],
  sw: readonly Rect[],
  topology: TopologyId,
  bounds: Rect,
): RoomComposition {
  const dx = -(bounds.x0 + bounds.x1) / 2;
  const dz = -bounds.z0;
  const rects = sw.map((r) => ({
    x0: r.x0 + dx,
    z0: r.z0 + dz,
    x1: r.x1 + dx,
    z1: r.z1 + dz,
  }));
  const room: Rect = {
    x0: bounds.x0 + dx,
    z0: 0,
    x1: bounds.x1 + dx,
    z1: bounds.z1 + dz,
  };
  const eps = 1e-6;

  const seams: ModuleSeam[] = [];
  const perModuleSeams = modules.map(() => [] as { edge: ModuleEdge; withId: string }[]);
  for (let i = 0; i < modules.length; i++) {
    for (let j = i + 1; j < modules.length; j++) {
      const seam = sharedSeam(rects[i], rects[j]);
      if (!seam) continue;
      if (
        !modules[i].openings.includes(seam.edge) ||
        !modules[j].openings.includes(OPPOSITE[seam.edge])
      ) {
        continue; // a refused seam stays a wall — no opening is emitted
      }
      const horizontal = Math.abs(seam.line.z0 - seam.line.z1) < eps;
      const len = horizontal ? seam.line.x1 - seam.line.x0 : seam.line.z1 - seam.line.z0;
      // A seam under 3 m cannot hold a doorway with a body's margin on
      // both sides — it stays a wall (no opening is emitted).
      if (len < 3) continue;
      const width = Math.min(2.4, len - 2);
      // Seeded, then snapped to the seam-local CELL-CENTER lattice (v0.13
      // module grid): grid lines fall ON module edges, so an opening whose
      // center sits half a cell off the seam's own start lines up
      // door-to-door with the openings of abutting modules. The snap is
      // clamped into the 1 m jamb margins — a tiny seam degenerates to its
      // seeded spot exactly as before.
      const lo = 1 + width / 2;
      const hi = len - 1 - width / 2;
      const seeded = lo + rng() * (hi - lo);
      const at = Math.min(
        hi,
        Math.max(
          lo,
          DOOR_LATTICE_HALF_CELL +
            Math.round((seeded - DOOR_LATTICE_HALF_CELL) / MODULE_GRID) * MODULE_GRID,
        ),
      );
      seams.push({
        aId: modules[i].id,
        bId: modules[j].id,
        line: seam.line,
        opening: { at, width },
      });
      perModuleSeams[i].push({ edge: seam.edge, withId: modules[j].id });
      perModuleSeams[j].push({ edge: OPPOSITE[seam.edge], withId: modules[i].id });
    }
  }

  const placed: PlacedModule[] = modules.map((m, i) => ({
    module: m,
    rect: rects[i],
    exposed: {
      n: Math.abs(rects[i].z1 - room.z1) < eps,
      s: Math.abs(rects[i].z0 - room.z0) < eps,
      e: Math.abs(rects[i].x1 - room.x1) < eps,
      w: Math.abs(rects[i].x0 - room.x0) < eps,
    },
    seams: perModuleSeams[i],
    primary: i === 0,
  }));

  // Open fields: the parts of the bounding rect no module claims, minus a
  // 1.2 m door apron along the entrance edge (the doorway's clearing is
  // the keep-empty zone's job, not a "field").
  const apron: Rect = { x0: room.x0, z0: 0, x1: room.x1, z1: Math.min(1.2, room.z1) };
  const openFields = rectDifference(room, [...rects, apron]).filter(
    (r) => (r.x1 - r.x0) * (r.z1 - r.z0) >= 4,
  );

  return {
    topology,
    width: room.x1 - room.x0,
    extent: room.z1,
    modules: placed,
    seams,
    openFields,
    doorCapacity: placedCapacity(
      modules,
      sw,
      bounds,
    ),
  };
}

/* ------------------------------------------------------------------ */
/* The composition as the renderer's existing input (§8's migration     */
/* discipline): one synthetic RoomTemplate — always a RECT silhouette,  */
/* so every downstream consumer (roomPlanFor / wallSegmentsFor /        */
/* planContains / composeRoom / placeRoomDoors / stageInteriorKits)     */
/* runs the verified math unchanged.                                    */
/* ------------------------------------------------------------------ */

/** Map a module edge that landed on the perimeter to the room's wall role
 *  (the south edge is the entrance wall — structurally never a host). */
function edgeToWallRole(edge: ModuleEdge): "left" | "right" | "far" | null {
  if (edge === "w") return "left";
  if (edge === "e") return "right";
  if (edge === "n") return "far";
  return null;
}

/**
 * The composition as a synthetic RoomTemplate: silhouette, door
 * affordance, feature slots and content zones the existing consumption
 * adapters (templatePlanFor / doorAffordanceFor / templateZonesFor) turn
 * into the renderer's inputs with zero new geometry.
 *
 * Zones: each module's module-local zones are mapped through its placed
 * rect into room-normalized coordinates; the PRIMARY module's hero zone
 * and heroKit become the room's hero (every other module's hero zone
 * demotes to a cluster rect); a full-width entrance apron joins the
 * keep-empty set, so the ≥35%-empty-floor rule (§4.5) holds at the module
 * level by construction, not by scatter luck. The open fields stay OUT of
 * the zone set — they are dressed sparsely by the staging channel instead
 * (see the openFields note in the function body).
 *
 * Doors: the affordance permits exactly the wall roles at least one
 * EXPOSED door-eligible module edge maps to — a module buried inside the
 * composition cannot put a door on a wall it does not touch. (Role
 * granularity means a module's door ban protects the roles it owns; the
 * segment-level nuance "this third of the far wall" is the renderer's
 * future seam work, see the module header.)
 */
export function compositionTemplateFor(comp: RoomComposition): RoomTemplate {
  const toNorm = (placed: PlacedModule, zone: TemplateZone): TemplateZone => {
    const { rect } = placed;
    const w = rect.x1 - rect.x0;
    const d = rect.z1 - rect.z0;
    return {
      kind: zone.kind,
      rect: {
        x: [
          (rect.x0 + zone.rect.x[0] * w + comp.width / 2) / comp.width,
          (rect.x0 + zone.rect.x[1] * w + comp.width / 2) / comp.width,
        ],
        z: [
          (rect.z0 + zone.rect.z[0] * d) / comp.extent,
          (rect.z0 + zone.rect.z[1] * d) / comp.extent,
        ],
      },
    };
  };

  const zones: TemplateZone[] = [];
  let heroKit: string | undefined;
  for (const placed of comp.modules) {
    for (const zone of placed.module.zones) {
      if (zone.kind === "hero") {
        if (placed.primary) {
          zones.push(toNorm(placed, zone));
          heroKit = placed.module.heroKit;
        } else {
          // A companion's would-be hero is just its densest cluster.
          zones.push({ ...toNorm(placed, zone), kind: "cluster" });
        }
      } else {
        zones.push(toNorm(placed, zone));
      }
    }
  }
  // The entrance apron: full width, the doorway's clearing.
  zones.push({
    kind: "keep-empty",
    rect: { x: [0, 1], z: [0, Math.min(1.2 / comp.extent, 0.12)] },
  });
  // The open fields are NOT keep-empty zones: they are dressed — sparsely —
  // by the staging channel (kits.ts's openFields input, fed straight from
  // comp.openFields). The ≥35%-empty-floor rule (§4.5) still binds there:
  // field pieces draw from the same seeded deck and count against the same
  // global coverage budget as every other kit.

  const doorWalls = new Set<"left" | "right" | "far">();
  for (const placed of comp.modules) {
    for (const edge of placed.module.doorEdges) {
      if (!placed.exposed[edge]) continue;
      const role = edgeToWallRole(edge);
      if (role) doorWalls.add(role);
    }
  }
  // §10.5: when NO module exposes a door-eligible edge (every authored
  // north wall is a shelf/glass/water wall), an empty list would read as
  // a total ban and push placement into the scatter fallback — off the
  // axis. The room's structural north wall still carries the doors.
  if (doorWalls.size === 0) doorWalls.add("far");

  // Features: floor features keep their kind with the module's room-span;
  // wall-bound features attach only to EXPOSED edges, spanned to the
  // module's run along that wall.
  const features: FeatureSlot[] = [];
  for (const placed of comp.modules) {
    const { rect } = placed;
    for (const f of placed.module.features) {
      if (f.at === "floor") {
        features.push({
          kind: f.kind,
          at: "floor",
          span: f.span
            ? [
                (rect.x0 + f.span[0] * (rect.x1 - rect.x0) + comp.width / 2) / comp.width,
                (rect.x0 + f.span[1] * (rect.x1 - rect.x0) + comp.width / 2) / comp.width,
              ]
            : undefined,
          spanZ: f.spanZ
            ? [
                (rect.z0 + f.spanZ[0] * (rect.z1 - rect.z0)) / comp.extent,
                (rect.z0 + f.spanZ[1] * (rect.z1 - rect.z0)) / comp.extent,
              ]
            : undefined,
        });
        continue;
      }
      if (!placed.exposed[f.at]) continue;
      const role = edgeToWallRole(f.at);
      if (!role) continue;
      // Span along the wall: for side walls the run is z, for the far wall x.
      const span = f.span
        ? f.at === "n"
          ? ([
              (rect.x0 + f.span[0] * (rect.x1 - rect.x0) + comp.width / 2) / comp.width,
              (rect.x0 + f.span[1] * (rect.x1 - rect.x0) + comp.width / 2) / comp.width,
            ] as const)
          : ([
              (rect.z0 + f.span[0] * (rect.z1 - rect.z0)) / comp.extent,
              (rect.z0 + f.span[1] * (rect.z1 - rect.z0)) / comp.extent,
            ] as const)
        : undefined;
      features.push({ kind: f.kind, at: role, span });
    }
  }

  return {
    id: `comp:${comp.modules.map((p) => p.module.id).join("+")}`,
    label: comp.modules.map((p) => p.module.label).join("+"),
    worldClasses: ["interior"],
    footprint: "rect",
    minExtent: 16,
    doorCapacity: comp.doorCapacity,
    doorWalls: [...doorWalls],
    features,
    zones,
    heroKit,
    weight: 1,
  };
}

/**
 * The composition's content zones as staging's KitZones, WITH each module's
 * kit whitelist attached to its cluster rects (2026-10 XL repetition
 * audit) — §8.1.4's promise ("不再是'同一套件撒八遍'，而是'不同模块各自
 * 的陈设'") as data: kits.ts's side-kit draw picks a ZONE first and deals
 * from that module's own short list, so one kit can repeat inside its
 * module (themed) but never sprawls across the whole room (a warehouse).
 *
 * The rects are THE SAME mapping compositionTemplateFor/templateZonesFor
 * produce (module zones → normalized → plan coords), and the hero/keepEmpty
 * handling matches the template fold exactly — the primary's hero zone is
 * the room's hero, a companion's demotes to a cluster, the entrance apron
 * joins keep-empty — so this is a STRICT widening of the plain zones: a
 * consumer that ignores kitIds reproduces today's behaviour. The heroKit
 * comes from the primary exactly when it authors a hero zone (the foyer
 * primary leaves the hero to the seeded far-third draw, as today).
 */
export function compositionKitZonesFor(
  comp: RoomComposition,
  plan: RoomPlan,
): KitZones {
  const w = plan.width;
  const e = plan.extent;
  const toPlanRect = (placed: PlacedModule, zone: TemplateZone): KitZoneRect => {
    const rw = placed.rect.x1 - placed.rect.x0;
    const rd = placed.rect.z1 - placed.rect.z0;
    const nx0 = (placed.rect.x0 + zone.rect.x[0] * rw + comp.width / 2) / comp.width;
    const nx1 = (placed.rect.x0 + zone.rect.x[1] * rw + comp.width / 2) / comp.width;
    const nz0 = (placed.rect.z0 + zone.rect.z[0] * rd) / comp.extent;
    const nz1 = (placed.rect.z0 + zone.rect.z[1] * rd) / comp.extent;
    return { x0: (nx0 - 0.5) * w, x1: (nx1 - 0.5) * w, z0: nz0 * e, z1: nz1 * e };
  };
  const clusters: KitClusterRect[] = [];
  const keepEmpty: KitZoneRect[] = [];
  let hero: KitZoneRect | undefined;
  let heroKit: string | undefined;
  for (const placed of comp.modules) {
    for (const zone of placed.module.zones) {
      const rect = toPlanRect(placed, zone);
      if (zone.kind === "hero") {
        if (placed.primary) {
          hero = rect;
          heroKit = placed.module.heroKit;
        } else {
          // A companion's would-be hero is just its densest cluster —
          // same rule as the template fold.
          clusters.push({ ...rect, kitIds: placed.module.kits });
        }
      } else if (zone.kind === "cluster") {
        clusters.push({ ...rect, kitIds: placed.module.kits });
      } else {
        keepEmpty.push(rect);
      }
    }
  }
  // The entrance apron: full width, the doorway's clearing (same rule as
  // compositionTemplateFor's fold).
  keepEmpty.push({
    x0: -w / 2,
    z0: 0,
    x1: w / 2,
    z1: Math.min(1.2, 0.12 * comp.extent) * (e / comp.extent),
  });
  return { hero, heroKit, clusters, keepEmpty };
}

/* ------------------------------------------------------------------ */
/* Audits (run by the tests — pure data checking, no geometry is        */
/* re-implemented here)                                                 */
/* ------------------------------------------------------------------ */

// Lazy: room-plan.ts imports this module for scaledRecipeFor while kits.ts
// imports room-plan.ts back — an eager Set over the kit catalogue would read
// it before its module finished evaluating on that entry order. The set
// holds every hand-written kit (interior + nature); the interior gate the
// modules draw through lives in kitsFor, unchanged.
let KIT_IDS: Set<string> | null = null;
function kitIds(): Set<string> {
  KIT_IDS ??= new Set(KITS.map((k) => k.id));
  return KIT_IDS;
}

/** Catalogue soundness: every module's whitelist names real kits, its
 *  heroKit is a whitelisted heroSlot kit, its zones are normalized with at
 *  most one hero, its footprint is a legal MODULE_GRID cell multiple
 *  (≤ 2×3, ≤ 6 cells of area), and its
 *  door edges / openings stay off the entrance-consent rules. Returns the
 *  violations (empty = sound). */
export function auditModule(module: RoomModule): string[] {
  const problems: string[] = [];
  const { w, d } = module.size;
  const cellsW = w / MODULE_GRID;
  const cellsD = d / MODULE_GRID;
  if (!Number.isInteger(cellsW) || !Number.isInteger(cellsD) || cellsW < 1 || cellsD < 1) {
    problems.push(
      `${module.id}: footprint ${w}×${d} not a ${MODULE_GRID} m grid cell multiple`,
    );
  } else if (
    cellsW > MODULE_GRID_MAX_CELLS ||
    cellsD > MODULE_GRID_MAX_CELLS ||
    cellsW * cellsD > MODULE_GRID_MAX_AREA
  ) {
    problems.push(
      `${module.id}: footprint ${w}×${d} exceeds the 2×3 (${MODULE_GRID_MAX_AREA}-cell) cap`,
    );
  }
  if (module.kits.length === 0) problems.push(`${module.id}: empty kit whitelist`);
  for (const id of module.kits) {
    if (!kitIds().has(id)) problems.push(`${module.id}: unknown kit "${id}"`);
  }
  if (module.heroKit) {
    const kit = KITS.find((k) => k.id === module.heroKit);
    if (!module.kits.includes(module.heroKit)) {
      problems.push(`${module.id}: heroKit "${module.heroKit}" not in its whitelist`);
    } else if (!kit?.heroSlot) {
      problems.push(`${module.id}: heroKit "${module.heroKit}" is not heroSlot-eligible`);
    }
  }
  const heroes = module.zones.filter((z) => z.kind === "hero");
  if (heroes.length > 1) problems.push(`${module.id}: ${heroes.length} hero zones`);
  for (const z of module.zones) {
    for (const [a, b] of [z.rect.x, z.rect.z]) {
      if (a < 0 || b > 1 || a >= b) {
        problems.push(`${module.id}: zone outside [0,1] or inverted`);
      }
    }
  }
  if (module.doorCapacity < 0) problems.push(`${module.id}: negative doorCapacity`);
  if (module.doorCapacity > 0 && module.doorEdges.length === 0) {
    problems.push(`${module.id}: capacity ${module.doorCapacity} with no door edges`);
  }
  // The entrance wall never carries a strand door: a module on the south
  // perimeter must not offer doors there (the composition may place any
  // module south).
  if (module.doorEdges.includes("s")) {
    problems.push(`${module.id}: doorEdges includes the south (entrance-side) edge`);
  }
  // §10.5 轴向语义: the north edge (the room's far wall) is the ONLY edge
  // that may carry a door — east/west edges belong to windows and light.
  for (const e of module.doorEdges) {
    if (e !== "n") {
      problems.push(`${module.id}: doorEdges includes the non-axial "${e}" edge`);
    }
  }
  // Module-level留白 (§4.5/§6): the authored cluster + hero zones may
  // claim at most ~65% of the module's floor — the furnishing budget
  // (kits.ts KIT_EMPTY_FLOOR_MIN) is then never tight by construction.
  let claimed = 0;
  for (const z of module.zones) {
    if (z.kind === "keep-empty") continue;
    claimed +=
      (z.rect.x[1] - z.rect.x[0]) * (z.rect.z[1] - z.rect.z[0]);
  }
  if (claimed > 0.65) {
    problems.push(
      `${module.id}: content zones claim ${(claimed * 100).toFixed(0)}% of the floor (> 65%)`,
    );
  }
  return problems;
}

/** Resolved-composition soundness: the modules tile their bounding rect
 *  without overlap, every companion shares a consented seam, the hero
 *  exists, zones stay normalized, and the declared ceiling matches the
 *  exposed modules. Returns the violations (empty = sound). */
export function auditComposition(comp: RoomComposition): string[] {
  const problems: string[] = [];
  const rects = comp.modules.map((p) => p.rect);
  for (let i = 0; i < rects.length; i++) {
    for (let j = i + 1; j < rects.length; j++) {
      if (rectsOverlap(rects[i], rects[j])) {
        problems.push(`${comp.modules[i].module.id} overlaps ${comp.modules[j].module.id}`);
      }
    }
  }
  for (const placed of comp.modules) {
    if (placed.primary) continue;
    if (placed.seams.length === 0) {
      problems.push(`${placed.module.id}: companion with no consented seam`);
    }
  }
  const template = compositionTemplateFor(comp);
  // The primary's hero zone (when it authors one) becomes the room's
  // exactly-one hero; a primary without one (the foyer) leaves the hero
  // to the seeded far-third slot, as the pre-template staging did.
  const primaryHasHero = comp.modules
    .find((p) => p.primary)
    ?.module.zones.some((z) => z.kind === "hero");
  const heroZones = template.zones.filter((z) => z.kind === "hero");
  if (primaryHasHero && heroZones.length !== 1) {
    problems.push(`expected exactly one hero zone, got ${heroZones.length}`);
  }
  if (!primaryHasHero && heroZones.length !== 0) {
    problems.push("a companion's hero zone leaked through as the room hero");
  }
  for (const z of template.zones) {
    for (const [a, b] of [z.rect.x, z.rect.z]) {
      if (a < -1e-9 || b > 1 + 1e-9 || a >= b) {
        problems.push(`resolved zone outside [0,1] or inverted (${z.kind})`);
      }
    }
  }
  if ((template.doorWalls as readonly string[]).includes("entrance")) {
    problems.push("the entrance wall may carry a door");
  }
  return problems;
}
