/**
 * Standard room modules + compositions (v0.11-room-interiors §8) — the
 * modular step past the layout templates (§7): a room is no longer one big
 * floor to scatter into, but ONE TO FOUR hand-authored functional units
 * (foyer, bedroom, study, gallery…) joined like building blocks, plus an
 * optional OPEN FIELD (随机区域 — a module-scale void dressed only
 * sparsely). "Large" is expressed by MORE modules, never by enlarging one
 * (§8.3).
 *
 * A module is DATA, never code: its footprint (8–16 m a side), which of
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
 */
import {
  INTERIOR_KITS,
  kitsFor,
  type Kit,
} from "./kits";
import type {
  FeatureSlot,
  RoomTemplate,
  TemplateZone,
} from "./room-templates";
import { createRng, hashString, WORLD_SEED } from "./seed";
import type { ArchetypeId, WorldClass } from "./space-types";

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
}

/**
 * A hand-authored standard room module (§8.2's RoomModule) — one
 * functional unit of an interior, 8–16 m a side.
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
  /** Footprint in meters (unscaled, human scale): x span × z depth. */
  size: { w: number; d: number };
  /** Edges that may OPEN onto a sibling module (a seam without both sides
   *  consenting stays a wall — the reading room's north shelf wall never
   *  opens). */
  openings: readonly ModuleEdge[];
  /** Edges that may carry STRAND DOORS when they land on the room's
   *  perimeter (the shelf wall and the sunroom's daylight wall never do). */
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
  /** The module's furnishing whitelist — ids into INTERIOR_KITS. Short on
   *  purpose: 少而准 (§6). */
  kits: readonly string[];
  /** The module's composed centrepiece (a kits.ts heroSlot kit id) — the
   *  PRIMARY module's hero becomes the room's hero. */
  heroKit?: string;
  /** Content zones, normalized to the MODULE's frame (x ∈ [0,1] → west→east,
   *  z ∈ [0,1] → south→north). At most one hero zone. */
  zones: readonly TemplateZone[];
  /** Selection weight among eligible primary candidates. */
  weight: number;
}

/* ------------------------------------------------------------------ */
/* The module catalogue (§8.2) — thirteen functional units, each with a */
/* character, each furnished by a SHORT whitelist of the existing kits. */
/* ------------------------------------------------------------------ */

export const ROOM_MODULES: readonly RoomModule[] = [
  {
    // 门厅 — the threshold: coats, umbrellas, someone's bags waiting by the
    // door. Deliberately empty down its spine so arrival reads as arrival.
    id: "foyer",
    label: "门厅",
    worldClasses: ["interior"],
    archetypes: ["hotel-room", "library", "ballroom", "pool-hall"],
    size: { w: 10, d: 8 },
    openings: ["n", "e", "w"],
    doorEdges: ["e", "w"],
    doorCapacity: 3,
    floor: "tile",
    wall: "panelling",
    light: "quiet",
    features: [{ kind: "floor-inlay", at: "floor", span: [0.35, 0.65] }],
    kits: ["coat-bench", "luggage", "housekeeping"],
    zones: [
      { kind: "cluster", rect: { x: [0.04, 0.3], z: [0.1, 0.9] } },
      { kind: "cluster", rect: { x: [0.7, 0.96], z: [0.1, 0.9] } },
      { kind: "keep-empty", rect: { x: [0.34, 0.66], z: [0, 1] } },
    ],
    weight: 1,
  },
  {
    // 卧室 — the hotel-room signature: the bed corner against the far wall,
    // a desk under the window side, the room's calm arranged around sleep.
    id: "bedroom",
    label: "卧室",
    worldClasses: ["interior"],
    archetypes: ["hotel-room"],
    size: { w: 12, d: 10 },
    openings: ["s", "e", "w"],
    doorEdges: ["e", "w"],
    doorCapacity: 3,
    floor: "carpet",
    wall: "plaster",
    light: "quiet",
    features: [{ kind: "niche", at: "e", span: [0.35, 0.65] }],
    kits: ["bed-corner", "writing-desk", "tv-corner", "luggage", "reading"],
    heroKit: "bed-corner",
    zones: [
      { kind: "hero", rect: { x: [0.28, 0.72], z: [0.62, 0.94] } },
      { kind: "cluster", rect: { x: [0.04, 0.26], z: [0.1, 0.6] } },
      { kind: "cluster", rect: { x: [0.74, 0.96], z: [0.1, 0.6] } },
      { kind: "keep-empty", rect: { x: [0.36, 0.64], z: [0, 0.55] } },
    ],
    weight: 3,
  },
  {
    // 书房 — the writing desk is the altar: shelves on the north wall (never
    // a door, never an opening), one chair turned toward the spines.
    id: "study",
    label: "书房",
    worldClasses: ["interior"],
    archetypes: ["hotel-room", "library"],
    size: { w: 10, d: 10 },
    openings: ["s", "e", "w"],
    doorEdges: ["e", "w"],
    doorCapacity: 2,
    floor: "timber",
    wall: "shelf",
    light: "task",
    features: [{ kind: "pilaster-rhythm", at: "n" }],
    kits: ["writing-desk", "bookshelf-run", "reading"],
    heroKit: "reading",
    zones: [
      { kind: "hero", rect: { x: [0.3, 0.7], z: [0.56, 0.86] } },
      { kind: "cluster", rect: { x: [0.06, 0.94], z: [0.74, 0.96] } },
      { kind: "cluster", rect: { x: [0.04, 0.3], z: [0.12, 0.6] } },
      { kind: "keep-empty", rect: { x: [0.38, 0.62], z: [0, 0.5] } },
    ],
    weight: 2,
  },
  {
    // 阅览室 — the library hall in one unit: a shelf wall across the whole
    // north face, a bench to sit with a book, a reading corner. Its shelf
    // wall never opens and never carries a door.
    id: "reading-room",
    label: "阅览室",
    worldClasses: ["interior"],
    archetypes: ["library", "ballroom"],
    size: { w: 14, d: 12 },
    openings: ["s", "e", "w"],
    doorEdges: ["e", "w"],
    doorCapacity: 3,
    floor: "timber",
    wall: "shelf",
    light: "wash",
    features: [
      { kind: "pilaster-rhythm", at: "n" },
      { kind: "floor-inlay", at: "floor", span: [0.3, 0.7] },
    ],
    kits: ["bookshelf-run", "reading", "gallery-bench"],
    heroKit: "reading",
    zones: [
      { kind: "hero", rect: { x: [0.32, 0.68], z: [0.5, 0.76] } },
      { kind: "cluster", rect: { x: [0.04, 0.96], z: [0.76, 0.96] } },
      { kind: "cluster", rect: { x: [0.04, 0.26], z: [0.1, 0.6] } },
      { kind: "cluster", rect: { x: [0.74, 0.96], z: [0.1, 0.6] } },
      { kind: "keep-empty", rect: { x: [0.38, 0.62], z: [0, 0.44] } },
    ],
    weight: 3,
  },
  {
    // 备餐间 — the working end of a meal: a laid table, the housekeeping
    // trolley parked mid-round. Tile floor, everything washable.
    id: "kitchen",
    label: "备餐间",
    worldClasses: ["interior"],
    archetypes: ["hotel-room", "ballroom"],
    size: { w: 10, d: 8 },
    openings: ["n", "s", "e", "w"],
    doorEdges: ["n", "e", "w"],
    doorCapacity: 2,
    floor: "tile",
    wall: "tile",
    light: "task",
    features: [],
    kits: ["dining", "housekeeping", "coat-bench"],
    heroKit: "dining",
    zones: [
      { kind: "hero", rect: { x: [0.28, 0.72], z: [0.55, 0.9] } },
      { kind: "cluster", rect: { x: [0.04, 0.28], z: [0.1, 0.55] } },
      { kind: "cluster", rect: { x: [0.72, 0.96], z: [0.1, 0.55] } },
      { kind: "keep-empty", rect: { x: [0.34, 0.66], z: [0, 0.5] } },
    ],
    weight: 1,
  },
  {
    // 更衣浴室 — lockers along the wall, towels folded and waiting, one
    // bench. The pool wing's changing room (its kits are all pool-side —
    // a hotel-room draw would leave it a single coat bench, not a room).
    id: "bath",
    label: "更衣浴室",
    worldClasses: ["interior"],
    archetypes: ["pool-hall"],
    size: { w: 8, d: 8 },
    openings: ["n", "s", "e", "w"],
    doorEdges: ["n", "e", "w"],
    doorCapacity: 2,
    floor: "tile",
    wall: "tile",
    light: "wash",
    features: [],
    kits: ["lockers", "towel-station", "coat-bench"],
    zones: [
      { kind: "cluster", rect: { x: [0.04, 0.96], z: [0.68, 0.95] } },
      { kind: "cluster", rect: { x: [0.04, 0.3], z: [0.1, 0.6] } },
      { kind: "keep-empty", rect: { x: [0.36, 0.64], z: [0, 0.62] } },
    ],
    weight: 2,
  },
  {
    // 行李房 — the calm trace made a room: luggage carts and suitcases in
    // waiting rows, a coat bench by the door. Storage, not abandonment (I4).
    id: "storage",
    label: "行李房",
    worldClasses: ["interior"],
    archetypes: ["hotel-room", "library", "ballroom", "pool-hall"],
    size: { w: 8, d: 8 },
    openings: ["n", "s", "e", "w"],
    doorEdges: ["n", "e", "w"],
    doorCapacity: 2,
    floor: "timber",
    wall: "panelling",
    light: "quiet",
    features: [],
    kits: ["luggage", "housekeeping", "coat-bench"],
    zones: [
      { kind: "cluster", rect: { x: [0.06, 0.45], z: [0.12, 0.9] } },
      { kind: "cluster", rect: { x: [0.55, 0.94], z: [0.12, 0.9] } },
      { kind: "keep-empty", rect: { x: [0.44, 0.56], z: [0, 1] } },
    ],
    weight: 1,
  },
  {
    // 画廊 — the long wall built to LOOK at (and to carry a busy day's
    // doors): a pilastered north face, benches facing it, inlay underfoot.
    // The composition's door absorber — its north wall is the door wall.
    id: "gallery-module",
    label: "画廊",
    worldClasses: ["interior"],
    archetypes: ["ballroom", "library"],
    size: { w: 16, d: 10 },
    openings: ["e", "w"],
    doorEdges: ["n"],
    doorCapacity: 10,
    floor: "timber",
    wall: "plaster",
    light: "wash",
    features: [
      { kind: "pilaster-rhythm", at: "n" },
      { kind: "floor-inlay", at: "floor", span: [0.15, 0.85] },
    ],
    kits: ["gallery-bench", "reading", "bookshelf-run"],
    heroKit: "reading", // an armchair facing the long wall — gallery-bench
    // is the wall's companion, but kits.ts only grants the hero slot to
    // composed centrepieces, so the pin goes to the hero-eligible chair.
    zones: [
      { kind: "hero", rect: { x: [0.34, 0.66], z: [0.5, 0.76] } },
      { kind: "cluster", rect: { x: [0.08, 0.92], z: [0.2, 0.6] } },
      { kind: "keep-empty", rect: { x: [0, 1], z: [0.72, 1] } },
      { kind: "keep-empty", rect: { x: [0.4, 0.6], z: [0, 0.44] } },
    ],
    weight: 2,
  },
  {
    // 会客厅 — the conversation pair as the centrepiece, a tv corner to one
    // side, a reading chair to the other. A room for sitting with someone.
    id: "living",
    label: "会客厅",
    worldClasses: ["interior"],
    archetypes: ["hotel-room", "ballroom", "library"],
    size: { w: 12, d: 12 },
    openings: ["n", "s", "e", "w"],
    doorEdges: ["n", "e", "w"],
    doorCapacity: 3,
    floor: "carpet",
    wall: "plaster",
    light: "quiet",
    features: [{ kind: "floor-inlay", at: "floor", span: [0.25, 0.75] }],
    kits: ["sofa-group", "tv-corner", "reading", "coat-bench"],
    heroKit: "sofa-group",
    zones: [
      { kind: "hero", rect: { x: [0.28, 0.72], z: [0.52, 0.82] } },
      { kind: "cluster", rect: { x: [0.04, 0.26], z: [0.1, 0.55] } },
      { kind: "cluster", rect: { x: [0.74, 0.96], z: [0.1, 0.55] } },
      { kind: "keep-empty", rect: { x: [0.38, 0.62], z: [0, 0.46] } },
    ],
    weight: 2,
  },
  {
    // 日光房 — the room whose north wall is glass (the daylight wall: never
    // a door, never an opening): a chair in the sun, plants' worth of empty
    // floor, the inlay band marking where the light falls.
    id: "sunroom",
    label: "日光房",
    worldClasses: ["interior"],
    archetypes: ["hotel-room", "ballroom", "library"],
    size: { w: 12, d: 8 },
    openings: ["s", "e", "w"],
    doorEdges: ["e", "w"],
    doorCapacity: 2,
    floor: "tile",
    wall: "plaster",
    light: "daylight",
    features: [{ kind: "floor-inlay", at: "floor", span: [0.2, 0.8] }],
    kits: ["reading", "coat-bench", "gallery-bench"],
    heroKit: "reading",
    zones: [
      { kind: "hero", rect: { x: [0.3, 0.7], z: [0.6, 0.9] } },
      { kind: "cluster", rect: { x: [0.04, 0.28], z: [0.15, 0.6] } },
      { kind: "cluster", rect: { x: [0.72, 0.96], z: [0.15, 0.6] } },
      { kind: "keep-empty", rect: { x: [0.36, 0.64], z: [0, 0.55] } },
    ],
    weight: 1,
  },
  {
    // 泳池甲板 — the dry edge of the water: the lounger pair facing the
    // pool, towels and ring posts along the sides. Its north edge opens
    // onto the water itself, so it never carries a door there.
    id: "pool-deck",
    label: "泳池甲板",
    worldClasses: ["interior"],
    archetypes: ["pool-hall"],
    size: { w: 16, d: 10 },
    openings: ["e", "w"],
    doorEdges: ["e", "w"],
    doorCapacity: 4,
    floor: "deck",
    wall: "tile",
    light: "pool-bounce",
    features: [{ kind: "water-rill", at: "floor", span: [0.1, 0.9] }],
    kits: ["pool-loungers", "towel-station", "ring-post"],
    heroKit: "pool-loungers",
    zones: [
      { kind: "hero", rect: { x: [0.3, 0.7], z: [0.55, 0.85] } },
      { kind: "cluster", rect: { x: [0.04, 0.26], z: [0.1, 0.9] } },
      { kind: "cluster", rect: { x: [0.74, 0.96], z: [0.1, 0.9] } },
      { kind: "keep-empty", rect: { x: [0.38, 0.62], z: [0, 0.5] } },
    ],
    weight: 3,
  },
  {
    // 长桌餐厅 — one long table down the room's axis, the service kept to
    // the flanks. The dining kit repeats along the table's run — several
    // settings of ONE meal, never a warehouse (§6).
    id: "dining-hall",
    label: "长桌餐厅",
    worldClasses: ["interior"],
    archetypes: ["ballroom", "hotel-room"],
    size: { w: 14, d: 10 },
    openings: ["n", "s", "e", "w"],
    doorEdges: ["n", "e", "w"],
    doorCapacity: 4,
    floor: "timber",
    wall: "panelling",
    light: "task",
    features: [{ kind: "pilaster-rhythm", at: "n" }],
    kits: ["dining", "housekeeping", "gallery-bench"],
    heroKit: "dining",
    zones: [
      { kind: "hero", rect: { x: [0.32, 0.68], z: [0.5, 0.8] } },
      { kind: "cluster", rect: { x: [0.06, 0.28], z: [0.15, 0.85] } },
      { kind: "cluster", rect: { x: [0.72, 0.94], z: [0.15, 0.85] } },
      { kind: "keep-empty", rect: { x: [0, 1], z: [0, 0.12] } },
      { kind: "keep-empty", rect: { x: [0.4, 0.6], z: [0.12, 0.44] } },
    ],
    weight: 2,
  },
  {
    // 工作间 — the room where something was being made: the desk with its
    // lamp, lockers of materials, the trolley parked mid-task. Paused,
    // never abandoned (I4).
    id: "workshop",
    label: "工作间",
    worldClasses: ["interior"],
    archetypes: ["hotel-room", "library", "ballroom"],
    size: { w: 10, d: 10 },
    openings: ["n", "s", "e", "w"],
    doorEdges: ["n", "e", "w"],
    doorCapacity: 2,
    floor: "timber",
    wall: "panelling",
    light: "task",
    features: [],
    kits: ["writing-desk", "lockers", "housekeeping", "coat-bench"],
    // No heroKit pin: none of the workshop's whitelisted kits is a
    // heroSlot centrepiece, so the hero falls back to the seeded draw
    // among the room's hero-eligible kits (kits.ts's rule, unchanged).
    zones: [
      { kind: "hero", rect: { x: [0.28, 0.72], z: [0.55, 0.88] } },
      { kind: "cluster", rect: { x: [0.04, 0.28], z: [0.1, 0.6] } },
      { kind: "cluster", rect: { x: [0.72, 0.96], z: [0.1, 0.6] } },
      { kind: "keep-empty", rect: { x: [0.36, 0.64], z: [0, 0.5] } },
    ],
    weight: 1,
  },
];

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
   *  no module claims — room-frame rects, dressed only sparsely (today:
   *  kept empty; a future sparse-scatter channel reads this). */
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
 * Deterministic: same (worldSeed, sliceId, worldClass, archetype,
 * doorCount) ⇒ same composition, always; independent of call order.
 */
export function resolveRoomComposition(
  sliceId: string,
  worldClass: string,
  archetype: string,
  doorCount: number = 0,
  worldSeed: string = WORLD_SEED,
): RoomComposition | null {
  const primaries = primaryModulesFor(worldClass, archetype);
  if (primaries.length === 0) return null;
  const rng = compositionRng(worldSeed, sliceId);
  const primary = weightedPick(rng, primaries);

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
  // default home); the door load may push it upward below.
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
      const at = 1 + rng() * (len - 2 - width) + width / 2;
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
 * demotes to a cluster rect); the open fields and a full-width entrance
 * apron join the keep-empty set, so the ≥35%-empty-floor rule (§4.5)
 * holds at the module level by construction, not by scatter luck.
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
  // The open fields stay empty today (the sparse-dressing channel reads
  // comp.openFields when it lands).
  for (const f of comp.openFields) {
    zones.push({
      kind: "keep-empty",
      rect: {
        x: [(f.x0 + comp.width / 2) / comp.width, (f.x1 + comp.width / 2) / comp.width],
        z: [f.z0 / comp.extent, f.z1 / comp.extent],
      },
    });
  }

  const doorWalls = new Set<"left" | "right" | "far">();
  for (const placed of comp.modules) {
    for (const edge of placed.module.doorEdges) {
      if (!placed.exposed[edge]) continue;
      const role = edgeToWallRole(edge);
      if (role) doorWalls.add(role);
    }
  }

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

/* ------------------------------------------------------------------ */
/* Audits (run by the tests — pure data checking, no geometry is        */
/* re-implemented here)                                                 */
/* ------------------------------------------------------------------ */

const KIT_IDS = new Set(INTERIOR_KITS.map((k) => k.id));

/** Catalogue soundness: every module's whitelist names real kits, its
 *  heroKit is a whitelisted heroSlot kit, its zones are normalized with at
 *  most one hero, its footprint is the promised 8–16 m a side, and its
 *  door edges / openings stay off the entrance-consent rules. Returns the
 *  violations (empty = sound). */
export function auditModule(module: RoomModule): string[] {
  const problems: string[] = [];
  const { w, d } = module.size;
  if (w < 8 || w > 16 || d < 8 || d > 16) {
    problems.push(`${module.id}: footprint ${w}×${d} outside 8–16 m`);
  }
  if (module.kits.length === 0) problems.push(`${module.id}: empty kit whitelist`);
  for (const id of module.kits) {
    if (!KIT_IDS.has(id)) problems.push(`${module.id}: unknown kit "${id}"`);
  }
  if (module.heroKit) {
    const kit = INTERIOR_KITS.find((k) => k.id === module.heroKit);
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
