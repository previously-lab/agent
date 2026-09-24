/**
 * Room visual tuning — every visual constant the space renderer
 * (src/components/game/space.tsx) consumes, plus the door geometry and
 * swing shared with the corridor renderer: the door is one physical slab
 * seen from both sides, so there is exactly one definition, here.
 *
 * Wall HEIGHT is shared too, but lives with the layout math: WALL_HEIGHT
 * in ../hotel. Pure data and pure functions — no three.js, no React, no
 * seeding.
 */

import { VIVID_PALETTES } from "../space-types";

/* ------------------------------------------------------------------ */
/* The fixed camera (ONE constant, every consumer shares it)            */
/* ------------------------------------------------------------------ */

/** Fixed-camera offset from the player/focus (world meters). The room
 *  orientation rule above, the dollhouse cutaway (room-doors.ts's
 *  wallFacesCamera), and the integrator's camera rig all read THIS one
 *  definition — it lives here, in the leaf tuning module, so the pure
 *  game chain (room-doors above all) never has to import the renderer
 *  tuning lane (tuning/render re-exports it for the render side). */
export const CAM_OFFSET = { x: -12, y: 16, z: 12 };

/* ------------------------------------------------------------------ */
/* Room orientation (the door-side rule — ONE derivation, every        */
/* consumer shares it).                                                */
/* ------------------------------------------------------------------ */

/**
 * The room's orientation about its corridor door. A room is built in a
 * local frame whose +z axis points OUTWARD from the corridor wall and
 * whose origin sits on the door axis: a north door (door.z > 0) maps the
 * local frame to world unchanged (root rotation 0); a south door rotates
 * it π about Y (mirroring both axes), so the room extends toward −z.
 *
 * WHY THIS IS THE UNIQUE RULE. Three hard constraints pin the room's
 * world transform to exactly one value per door side: (1) the doorway
 * must stay glued to the corridor door at (door.x, door.z) — the door
 * slab handoff and the movement clamp's gap both anchor there; (2) the
 * entrance wall must stay flush with the corridor wall plane, so the
 * local x axis maps to ±world x (any other rotation would slice the room
 * through the corridor wall); (3) the room must extend OUTWARD — the
 * door manager's whole containment model (the |z| hysteresis band in
 * game-canvas.tsx and clamps.ts) assumes the room lies beyond the wall
 * plane; a room extending into the corridor band would share the
 * corridor's z-range and the manager could no longer tell "in the
 * corridor" from "in the room". Together these leave exactly one
 * orientation per side — every transform that preserves the attachment
 * is this one, and any other "rotation" either detaches the room from
 * its door or is a relabeling of the same world map.
 *
 * CONSEQUENCE (the felt flip). With the camera fixed at CAM_OFFSET, a
 * north-door room presents with its entrance on the far screen edge and
 * its interior opening toward the camera, a south-door room mirrored —
 * the two sides are 180° apart ON SCREEN and that difference is forced
 * by the corridor having two door walls, not by anything in the room's
 * construction. The arrival itself is continuous: the doorway is
 * world-rigid through the crossing and the camera never rotates, so the
 * door you pushed is exactly where it was when you turn around.
 *
 * Consumers: the renderer's root group (space.tsx), the local-frame
 * transforms of the door swing / strand-door swing / strand-door
 * crossing detection (space.tsx), the movement clamp's geometry
 * derivation (roomGeometryForSpace, game-canvas.tsx), and the avatar
 * terrain height (game-canvas.tsx). clamps.ts derives the same
 * convention inline (it is another lane's module); the unit tests pin
 * the agreement.
 */
export interface RoomOrientation {
  /** Local-frame mirror: local = (world − door) · dir on both axes. */
  readonly dir: 1 | -1;
  /** The root group's rotation.y mapping the local frame to world. */
  readonly rotationY: number;
}

const NORTH_ROOM_ORIENTATION: RoomOrientation = { dir: 1, rotationY: 0 };
const SOUTH_ROOM_ORIENTATION: RoomOrientation = {
  dir: -1,
  rotationY: Math.PI,
};

/** The one orientation derivation — deterministic in the door alone (A6). */
export function roomOrientationFor(door: { z: number }): RoomOrientation {
  return door.z > 0 ? NORTH_ROOM_ORIENTATION : SOUTH_ROOM_ORIENTATION;
}

/** World → room-local: the doorway is the origin, +z points into the room. */
export function roomLocalFor(
  door: { x: number; z: number },
  x: number,
  z: number,
): { lx: number; lz: number } {
  const { dir } = roomOrientationFor(door);
  return { lx: (x - door.x) * dir, lz: (z - door.z) * dir };
}

export const GROUND_SEGMENTS = 48;
/** Room perimeter wall thickness — deliberately NOT the corridor wall
 *  thickness (CORRIDOR_WALL_THICKNESS in ./hotel, 0.2): different walls,
 *  different values, keep both. */
export const ROOM_WALL_THICKNESS = 0.3;
/** Half of the 2.4m doorway gap in the entrance-edge wall. One gameplay
 *  clearance: the terrain entrance funnel (terrain.ts) reads the same
 *  constant. */
export const DOOR_GAP_HALF = 1.2;
/** Space-side doorway mirrors the corridor door (1.4 × 3.0 slab, trim
 *  frame, accent glow) — the door is hotel property and reads identically
 *  from both sides. The entrance gets a 3.2m portal surround (filler
 *  panels + lintel) since the wall is 4.0m tall. */
export const DOOR_WIDTH = 1.4;
export const DOOR_HEIGHT = 3.0;
export const PORTAL_HEIGHT = 3.2;
export const DOOR_TRIM_COLOR = "#463f36";
export const DOOR_GLOW_INTENSITY = 1.6;
export const DOOR_HALO_OPACITY = 0.14;
/** Jamb/head light-leak seams around the closed slab (the exit landmark
 *  from deep inside a space). */
export const DOOR_SEAM_INTENSITY = 2.8;
/** Slab swing, mirroring the corridor face: open within this distance of
 *  the door center, ~100°, always rotating away from the player. */
export const DOOR_OPEN_DIST = 2.2;
export const DOOR_OPEN_ANGLE = 1.75;
export const DOOR_SWING_RATE = 5;
/** Scatter keeps this clearance from the wall boxes. */
export const WALL_CLEARANCE = 1;
/** Dollhouse cutaway: the perimeter walls facing the fixed camera are
 *  drawn at this low sill height instead of full height, so the interior
 *  reads over them — the classic dollhouse trick that replaced the old
 *  50%-opacity "translucent veil" walls (which made every room read as a
 *  milk-glass box and, writing no depth, never occluded anything). Which
 *  walls face the camera is computed once per room in world space from the
 *  constant CAM_OFFSET (tuning/render.ts); the entrance wall is never cut
 *  (the door handoff depends on it). 1.1m is chest height — a low wall you
 *  could see over, not a curb. */
export const WALL_SILL_HEIGHT = 1.1;
/** No props within this distance of the door axis near the doorway. */
export const ENTRANCE_CLEAR_RADIUS = 1.5;
/** Depth outward from the wall that counts as "the doorway". Shared with
 *  the terrain entrance funnel (terrain.ts). */
export const ENTRANCE_DEPTH = 2.5;
/** Mount/unmount crossfade: the room condenses out of (and dissolves back
 *  into) its own shadow in 150 ms — fast, but never a pop. */
export const SPACE_FADE_S = 0.15;
/** Water plane height — one definition for the renderer (space.tsx) and
 *  the avatar's wade clamp (game-canvas.tsx). */
export const WATER_Y = 0.35;
/** Grounding skirt: dark apron extending this far beyond the walls, so the
 *  space reads as grounded terrain in the mist instead of a floating
 *  board. 40m — the unfoggable background shows past the apron's side
 *  edges at the fixed CAM_OFFSET when the player stands near the door, so
 *  the apron is deliberately oversized (only one space is mounted at a
 *  time, making it free). Sits just below the corridor floor (y = 0). */
export const SKIRT_OVERHANG = 40;
export const SKIRT_Y = -0.005;
/** Trees / rocks per instance: count = max(min, round(density · extent² / N)). */
export const TREE_DIVISOR = 22;
export const ROCK_DIVISOR = 45;
export const TREE_MIN = 3;
export const ROCK_MIN = 2;
/** Motif props per size tier — S stays restrained; big plans scale up so
 *  an L/XL room never reads as an empty hangar. */
export const PROP_COUNT: Record<number, number> = {
  16: 3,
  32: 5,
  64: 8,
  96: 12,
};
/** Motif props keep the doorway corridor clear: |x| < 1.8 out to z = 3m. */
export const PROP_DOOR_HALF = 1.8;
export const PROP_DOOR_DEPTH = 3;
/** Internal structures only on big plans. */
export const STRUCTURE_MIN_EXTENT = 64;
/** Wonder-animal counts per size tier. */
export const DUCK_COUNT: Record<number, number> = {
  16: 20,
  32: 30,
  64: 45,
  96: 60,
};
export const PET_COUNT: Record<number, number> = { 16: 4, 32: 5, 64: 6, 96: 8 };
/** Balloon bunches per size tier — a big ballroom of a room needs many. */
export const BALLOON_BUNCHES: Record<number, number> = {
  16: 4,
  32: 6,
  64: 10,
  96: 15,
};
/** Parquet checkerboard cell size in meters. */
export const PARQUET_CELL = 4;
/** How far the parquet's light checker cell is lerped from the floor's base
 *  color toward white. Visual review (2026-09) found the checkerboard was
 *  the loudest thing in frame at 0.13 — it fought every prop in the room.
 *  At near-tone-on-tone the floor reads as MATERIAL and the furniture reads
 *  first. The pattern itself stays; only its contrast is budgeted. */
export const PARQUET_TONE_LIFT = 0.045;
/** Balloon colors come from the vivid palette set. */
export const BALLOON_COLORS = VIVID_PALETTES.map((p) => p.accent);

/* ------------------------------------------------------------------ */
/* Strand doors (v0.11-hotel-rooms B.8/B.11): one extra door per        */
/* strand through the slice, composed like the doors of a home —        */
/* clustered, never evenly sprinkled, always human-scale (A4). All      */
/* parts are opaque objects (hard requirement #5). Consumed by          */
/* lib/game/room-doors.ts (pure layout) and space.tsx (geometry).       */
/* ------------------------------------------------------------------ */

/** Clear wall between two strand doors' frames on the same wall (m):
 *  center spacing = DOOR_WIDTH + this = 3.0m — the spacing of bedroom
 *  doors off a hall, close enough to read as a cluster, never touching. */
export const ROOM_DOOR_MIN_GAP = 1.6;
/** A door's center keeps this far from its wall segment's ends (m):
 *  the 1.2m gap half plus jamb room, so a door never crowds a corner. */
export const ROOM_DOOR_END_PAD = DOOR_GAP_HALF + 0.6;
/** Composition: probability that the next door sticks to the same wall as
 *  the previous one (capacity permitting) — doors collect into domestic
 *  clusters instead of being dealt evenly around the perimeter. */
export const ROOM_DOOR_CLUSTER_STICK = 0.55;
/** Crossing detection: the player has "walked through" a strand door when
 *  their inward distance from the wall plane drops below this (m), inside
 *  the gap — past the wall's inner face, genuinely between the jambs.
 *  MUST stay reachable under the door manager's gap clearance. */
export const ROOM_DOOR_CROSS_DEPTH = 0.55;
/** Plaque labels are pre-formatted by the data lane; this caps the glyph
 *  count so a long strand name still fits the plate (deterministic
 *  truncation with an ellipsis — pure, unit-tested in room-doors.ts). */
export const ROOM_DOOR_PLAQUE_MAX_CHARS = 24;
/** Strand-door approach clearance (B.11): the strip in front of every
 *  strand door is kept exactly as clear as the entrance's own doorway
 *  corridor — same shaping (the doorway gap plus a body's margin) — so no
 *  kit piece, prop, animal or column can park in front of a door and make
 *  it unreachable. Deliberately UNSCALED: the door never scales (A4) and
 *  neither does the human walking up to it. Door centers sit
 *  ≥ ROOM_DOOR_END_PAD from corners and ≥ DOOR_WIDTH + gap apart, so
 *  strips this size can neither swallow the entrance's approach (which is
 *  the same size) nor a neighbouring door's. */
export const ROOM_DOOR_CLEAR_HALF = PROP_DOOR_HALF;
export const ROOM_DOOR_CLEAR_DEPTH = PROP_DOOR_DEPTH;
/** 门厅式 double bank (§10.5 fallback ②): how far inward of its host wall
 *  the freestanding screen row stands (m). Deep enough that the band
 *  between screen and wall reads as a shallow vestibule and two staggered
 *  frames never touch (the diagonal between rows always exceeds the door
 *  width), shallow enough that the room keeps its floor. Deliberately
 *  UNSCALED, like every door measure (A4). */
export const ROOM_DOOR_ROW_DEPTH = 1.8;
/** Thickness of the freestanding door screen the second row hangs on (m) —
 *  a shallow slab in the same opaque wall language, thick enough to read
 *  as architecture and to carry a door frame, thin enough to stay a
 *  screen. UNSCALED like the doors themselves (A4). */
export const ROOM_DOOR_SCREEN_THICK = 0.15;

/* ------------------------------------------------------------------ */
/* Procedural material wiring (lib/game/materials → room surfaces).    */
/* ------------------------------------------------------------------ */

/** Real-world edge length of one glazed pool tile. REPEAT MATH: the tile
 *  texture's grout sits exactly on a cells×cells grid (materials/tile.ts),
 *  so mapping one texture cell to one physical tile makes the repeat of a
 *  surface of L meters exactly L / TILE_SPAN_METERS — e.g. a 10m pool wall
 *  repeats 10 / 2.4 ≈ 4.17 times and every tile on it is truly 30cm. */
export const POOL_TILE_METERS = 0.3;
/** Tiles per tile-texture edge — MUST match the shared texture's `cells`
 *  (buildTileMaps() default used by materials/shared.ts). */
export const TILE_MAP_CELLS = 8;
/** Meters covered by one full tile-texture repeat: 8 cells × 0.3m = 2.4m. */
export const TILE_SPAN_METERS = POOL_TILE_METERS * TILE_MAP_CELLS;
/** Meters covered by one concrete-texture repeat — at 5m the builder's
 *  stains (0.12–0.38 of the texture) land at 0.6–1.9m, a plausible scale
 *  for damp patches on a wall. */
export const CONCRETE_SPAN_METERS = 5;
/** Normal-map strengths (material.normalScale) per surface. Concrete stays
 *  subtle — its grain must not read as texture from the fixed camera. */
export const TILE_NORMAL_SCALE = 1;
export const CONCRETE_NORMAL_SCALE = 0.7;

/* Shallow-water look (materials/water-surface.ts) — the §2 worked example. */
/** Alpha at the rim (ankle-deep: the tile shows through almost clear) and
 *  at full depth (tinted, but the pool bottom ALWAYS reads through — a flat
 *  opaque disc is the forbidden anti-pattern). */
export const WATER_EDGE_ALPHA = 0.3;
export const WATER_DEEP_ALPHA = 0.65;
/** Meters from the water's rim over which the depth tint reaches full
 *  strength (the basin feathers to 1.6m deep at center — terrain.ts). */
export const WATER_DEPTH_RAMP_METERS = 2.2;
/** Near-glossy so the IBL environment and key light answer with a real
 *  specular streak on the ripples. */
export const WATER_ROUGHNESS = 0.08;

/* ------------------------------------------------------------------ */
/* Room language (v0.11 §3): scale notation, plan, composition.        */
/* Consumed by lib/game/room-plan.ts (pure) and space.tsx.            */
/* ------------------------------------------------------------------ */

/** Scale notation (v0.13 尺度收敛, user: "移除巨人城" — the giant city is
 *  gone): every room draws the ONE human-scale tier. The old three-tier
 *  draw (78% normal / 12% colossal ×2.5–3.5 / 10% miniature ×0.2–0.35)
 *  collapsed into the single normal outcome — a giant floor with nine
 *  pieces of furniture spread across it read as a bug, and "large" is
 *  expressed by joining MORE standard modules (room-modules.ts §8.3),
 *  never by enlarging the room. scaleNotationFor keeps its signature so
 *  every consumer is untouched; the scale-aware math below (wall-height
 *  curve, prop/creature exponents, margin scaling) stays as the identity
 *  path at the only factor now drawn, ×1. */

/** The module grid (v0.13 尺度收敛): a standard room module's footprint is
 *  an integer number of these cells per side — 小房间 1×1, 长房间 1×2 /
 *  2×1, 大房间 2×2 — so composed rooms tile like building blocks and every
 *  interior seam lands on a grid line. The hard cap is 2×3: no side longer
 *  than MODULE_GRID_MAX_CELLS cells, no footprint larger than
 *  MODULE_GRID_MAX_AREA cells (room-modules.ts's audit enforces both). */
export const MODULE_GRID = 6;
/** Longest legal footprint side, in cells (the 2×3 cap's 3). */
export const MODULE_GRID_MAX_CELLS = 3;
/** Largest legal footprint area, in cells (2×3 = 6). */
export const MODULE_GRID_MAX_AREA = 6;
/** Door lattice: strand-door centers sit at CELL CENTERS of the module
 *  grid (half a cell off every grid line), measured in the room's plan
 *  frame, so a door's 2.4m gap can never straddle a module seam and doors
 *  in abutting modules align door-to-door (room-doors.ts). */
export const DOOR_LATTICE_HALF_CELL = MODULE_GRID / 2;

/** Wall height scales by S^0.5, not S: full-S walls (14m at ×3.5) would make
 *  the far walls the only thing on screen at the fixed camera (the near
 *  walls are cut to WALL_SILL_HEIGHT, so they no longer veil the room). */
export const WALL_SCALE_EXP = 0.5;
/** Wall-height clamps (m): MIN is the absolute safety floor — in practice
 *  the portal floor (PORTAL_HEIGHT + WALL_PORTAL_MARGIN, below) binds first;
 *  MAX is the curve's ceiling rail (live only if a future draw ever passes
 *  a factor > 1 again — v0.13 leaves every room at ×1). */
export const WALL_HEIGHT_MIN = 0.8;
export const WALL_HEIGHT_MAX = 16;
/** Extra wall above the 3.2m portal surround: the door never scales (the
 *  A4 human-scale anchor), so even the smallest room's walls must contain
 *  the portal plus this margin of visible wall over the lintel. */
export const WALL_PORTAL_MARGIN = 0.3;
/** Furniture/motif props scale by S^0.75 — giant enough to sell the room's
 *  scale, always shorter than the walls they stand between. */
export const PROP_SCALE_EXP = 0.75;
/** Creatures (ducks/pets/balloons) scale by S^0.5: they are characters whose
 *  readability matters more than their role as a scale cue. */
export const CREATURE_SCALE_EXP = 0.5;
/** Terrain tessellation cap: segments grow with S^0.75 so big rolling
 *  ground doesn't alias, but vertex count stays bounded (one-time cost). */
export const GROUND_SEGMENTS_MAX = 256;
/** Even the smallest room gets a readable grounding apron under it. */
export const SKIRT_OVERHANG_MIN = 8;
/** Non-rectangular plans need room to breathe — S tiers (16m) would turn an
 *  L's kept leg into a cramped corridor (hard-banned anti-pattern). */
export const PLAN_NONRECT_MIN_EXTENT = 32;
/** Plan draw on eligible tiers: 70% rectangle, 15% L-shape, 15% colonnade. */
export const PLAN_RECT_PROB = 0.7;
export const PLAN_L_PROB = 0.15;
/** L-shape step (where the plan narrows to one half) at 45–60% of depth. */
export const L_STEP_MIN = 0.45;
export const L_STEP_SPAN = 0.15;
/** Colonnade bay spacing in meters, scaled by S^0.5 so the column rhythm
 *  survives at any room scale. */
export const COLONNADE_BAY = 4;
/** Hero focal element sits in the far third of the room: 68–85% of depth,
 *  within ±25% of the half-width — the thing you see when you walk in. */
export const HERO_Z_MIN = 0.68;
export const HERO_Z_SPAN = 0.17;
export const HERO_X_SPAN = 0.25;
/** Hero size multiplier (before room scale) — unmistakably the set piece. */
export const HERO_SCALE = 2.2;
/** No-scatter clearing around the hero (m, ×prop scale) — it owns its stage. */
export const HERO_CLEAR = 3;
/** Cleared walk path (door → hero) half-width in meters at human scale;
 *  room-plan.ts scales it by clamp(S, 0.35, 2) — at v0.13's single ×1
 *  tier the clamp is the identity and the path keeps its 1.4 m half-width
 *  everywhere. */
export const PATH_HALF = 1.4;
/** Clustered scatter: 2–3 seeded cluster centers (+1 on L/XL tiers). */
export const CLUSTER_COUNT_BASE = 2;
export const CLUSTER_COUNT_SPAN = 2;
/** Cluster radius 2–5 m (×S^0.5) — groupings read as authored, not noise. */
export const CLUSTER_RADIUS_MIN = 2;
export const CLUSTER_RADIUS_SPAN = 3;
/** Fraction of scatter drawn uniformly instead of clustered — a lone tree
 *  far from any grouping reads as placed, not as leftover. */
export const LONE_PROB = 0.15;
/** Pet waypoint radius cap (m): in the biggest rooms pets stay near the
 *  door, where the player actually is, instead of wandering a 150m orbit. */
export const PET_NEAR_RADIUS_MAX = 24;

/* ------------------------------------------------------------------ */
/* Kits (v0.11-room-interiors §3.1) — composed furnishing groups.      */
/* ------------------------------------------------------------------ */

/** Floor area (m² of the UNSCALED tier) per kit — the I3 density target.
 *  B.12 (user, 2026-09-18): strong cast shadows amplify emptiness and the
 *  closer camera sees less floor, so density rose ~+43% (areas ÷ ~1.43
 *  from 15/20/32/48). S/M tiers now sit past the doc's old 12–18 m²/kit
 *  band; L/XL keep the upward taper so a great hall keeps its sweep
 *  instead of becoming a furniture warehouse (§6 塞满). The area law's
 *  demand sits above KIT_COUNT_MAX at every tier, so the cap below is
 *  what actually binds — the same regime as before this change. */
export const KIT_AREA_PER_KIT: Record<number, number> = {
  16: 10,
  32: 14,
  64: 22,
  96: 34,
};
/** Absolute kit-count ceiling per tier — the taper's hard backstop, and a
 *  draw-call budget: kit pieces are real meshes, not instanced scatter.
 *  This cap is the operative density constraint at every tier (the area
 *  law above always demands more), so B.12's +40% density rise lands
 *  here: 10/20/40/60 → 14/28/56/84. */
export const KIT_COUNT_MAX: Record<number, number> = {
  16: 14,
  32: 28,
  64: 56,
  96: 84,
};
/** The 留白 hard floor (I1 / §4.5): kit footprint discs may cover at most
 *  (1 − this) of the actual scaled floor — at least 35% stays empty. */
export const KIT_EMPTY_FLOOR_MIN = 0.35;
/** Gap kept between two kits' footprint discs (m, ×prop scale) — every kit
 *  owns its breathing room; kits never touch. 0.4 (was 0.6): B.12's density
 *  rise needs small rooms to fit closer to their target, and 0.4 m still
 *  reads as deliberate spacing at the closer camera. */
export const KIT_GAP = 0.4;
/** Per-piece clearance from the cleared walk path (m, ×prop scale): the
 *  path's ≥1.4 m promise is measured to kit GEOMETRY, not kit centers. */
export const KIT_PATH_CLEAR = 0.5;
/** Per-piece margin from the walls (m, ×prop scale). */
export const KIT_WALL_CLEAR = 0.35;
/** Rejection-sampling budget per wanted kit before the room settles for
 *  fewer (a narrow plan physically cannot host every kit). 120 (was 40):
 *  B.12 raised the targets, and at 40 the small tiers settled short of
 *  them even when a legal spot existed — the budget is pure CPU at mount
 *  time, no draw-call cost. */
export const KIT_PLACE_ATTEMPTS = 120;
/** §6's anti-warehouse rule as a CHECKABLE number (2026-10 XL repetition
 *  audit): one kit id may be set down at most this many times in ONE room.
 *  3 = "several settings of one meal, never a warehouse" (the dining
 *  hall's own comment): three reads as an arrangement, four reads as a
 *  pattern. kits.ts's draw re-rolls onto an uncapped kit — the zone's own
 *  deck first, then any room kit, then the zone deck's least-used — so
 *  the cap binds room-wide in every realistic pool, and only a fully
 *  saturated room falls through, where the B.12 density promise
 *  rightfully outranks it (a deck that cannot honour both is a deck-size
 *  problem, and the module whitelists own that). */
export const KIT_ROOM_CAP = 3;
/** The 随机区域 sparse-dressing ceiling (§8.2): each open field grows at
 *  most this many kit pieces — 0–3 seeded, sparse by construction (most
 *  fields draw none), never a grid (positions are uniform draws, never
 *  equidistant), and every piece still counts against the 留白 floor
 *  above (§6's bans bind in the fields exactly as on the module floors). */
export const OPEN_FIELD_PIECE_MAX = 3;
/** Nature hero redraw budget (§3.1 N4): a water biome's composed focal
 *  point can land inside the basin, where no dry furniture may stand.
 *  The nature hero redraws along the far-third band, seeded, until it
 *  finds dry ground. Interiors keep the single original draw — the
 *  retry branch is gated on the nature world class, so their staging
 *  stays byte-for-byte. */
export const KIT_HERO_ATTEMPTS = 6;
/** §4.4 trace visibility band (m, ×prop scale): the room's one trace must
 *  sit within this distance of the cleared walk path (measured beyond the
 *  path's own half-width) or of the hero's clearing (HERO_CLEAR on top) —
 *  the band a walker's sightline sweep and the focal stage actually take
 *  in. 12 m: most hosts are wall-anchored pieces, which stand at the
 *  perimeter by construction — a tighter band would push the trace out of
 *  every room it was meant to be found in. */
export const TRACE_VIEW_MARGIN = 12;

/* ------------------------------------------------------------------ */
/* dado-band (v0.11-room-interiors §3.2): baseboard + panelled          */
/* wainscot along the room's walls — a geometric feature, not a         */
/* texture. Heights are authored at human scale and multiplied by the   */
/* wall scale ratio (drawn wall height / WALL_HEIGHT) at render time,   */
/* so a colossal room gets a colossal dado and a miniature room a       */
/* dollhouse one. All parts are opaque (hard requirement #5) and        */
/* wall-supported (I2).                                                 */
/* ------------------------------------------------------------------ */

/** Baseboard height / inward projection from the wall face (m, ×wall
 *  scale). Runs on every wall tall enough to hold it, including the low
 *  cutaway sills. */
export const DADO_BASE_HEIGHT = 0.14;
export const DADO_BASE_PROJECT = 0.06;
/** Top of the wainscot (the chair-rail line, m ×wall scale) — classic
 *  dado height, safely below the 1.1 m cutaway sill at normal scale. */
export const DADO_TOP = 0.9;
/** Chair-rail strip height / projection (m, ×wall scale). */
export const DADO_RAIL_HEIGHT = 0.07;
export const DADO_RAIL_PROJECT = 0.05;
/** Panel stile width / projection (m, ×wall scale) and the target bay
 *  width between stiles. */
export const DADO_STILE_WIDTH = 0.09;
export const DADO_STILE_PROJECT = 0.035;
export const DADO_PANEL_SPAN = 1.2;
/** Stiles per wall run capped — past this the bays widen instead of
 *  emitting hundreds of boxes down a colossal XL wall. */
export const DADO_PANEL_MAX = 24;
/** The full band (rail + stiles) is drawn only when the wall's DRAWN
 *  height clears the dado top by this margin (m, ×wall scale); a shorter
 *  (cutaway) wall keeps just the baseboard — a band running past the top
 *  of a short wall is a bug. */
export const DADO_FULL_MARGIN = 0.15;
/** Snow point-count cap — the area formula explodes quadratically at
 *  colossal scale; density beyond this adds nothing at the fixed camera. */
export const SNOW_COUNT_MAX = 1500;

/* ------------------------------------------------------------------ */
/* Template feature geometry (v0.11-room-interiors §7.2 feature slots:  */
/* niche / pilaster-rhythm / floor-inlay — §3.2's dressing, declared    */
/* by the layout templates as DATA and built by space.tsx as            */
/* architecture: opaque, wall/floor-material, lit only by the room's    */
/* own fixtures (B.13 — a niche must NOT glow; this world has no        */
/* outdoors, so nothing may shine without a fixture). Sizes ride the    */
/* wall scale (these are architecture, like the dado band), so a        */
/* colossal room gets colossal features and a miniature room a          */
/* dollhouse set. Placement math lives in space.tsx (buildRoomFeatures) */
/* on top of room-plan.ts's wall roles and the door-split wall runs —   */
/* the pure modules keep owning the geometry.                           */
/* ------------------------------------------------------------------ */

/** Niche (凹龛): a TRUE recess opened in a full-height wall — the host
 *  run is rebuilt as two flank boxes plus a header over the opening, so
 *  the alcove reads with real depth. Never on a cutaway sill (a niche in
 *  a 1.1m wall is a hole in nothing) and never where it would swallow a
 *  doorway or a strand-door approach. Opening width / height (m, ×wall
 *  scale); the top stays below the wall top so the header and cap rail
 *  keep the wall's top edge continuous. */
export const NICHE_WIDTH = 1.8;
export const NICHE_HEIGHT = 2.2;
/** Recess depth (m, unscaled): capped at wall thickness − 0.08 so the
 *  alcove always keeps a real back panel inside the wall instead of
 *  punching through. */
export const NICHE_MAX_DEPTH = 0.26;
/** Clear margin between the niche opening and any strand door's gap on
 *  the same wall (m) — the template data already bans doors on niche
 *  walls; this is the renderer's own backstop (a relaxed door ladder
 *  near the opening forfeits the niche, never the door). */
export const NICHE_DOOR_CLEAR = 1.0;
/** The plinth standing in the alcove (§3.2: 内部放长凳/盆/台座): height
 *  (m, ×wall scale) and the fraction of the opening width it fills. */
export const NICHE_PEDESTAL_HEIGHT = 0.5;
export const NICHE_PEDESTAL_FILL = 0.55;

/** Pilaster rhythm (壁柱节奏): flat strips repeating along a wall run,
 *  standing ON the dado band (they start at the chair-rail line and stop
 *  below the cap rail) and breaking at every opening — the runs are
 *  already split at door gaps, so per-run placement breaks the rhythm
 *  for free. Cutaway sills get none: a pilaster needs the full dado to
 *  stand on (the same DADO_FULL_MARGIN rule the band itself uses).
 *  Strip width / projection from the wall face (m, ×wall scale). */
export const PILASTER_WIDTH = 0.34;
export const PILASTER_PROJECT = 0.09;
/** Target bay spacing and the end pad from a run's ends (m, ×wall
 *  scale) — corners and door frames stay clean. */
export const PILASTER_SPAN = 2.6;
export const PILASTER_END_PAD = 0.9;
/** A slightly wider, slightly prouder cap block finishes each strip
 *  below the wall top (m, ×wall scale). */
export const PILASTER_CAP_HEIGHT = 0.14;
/** Runs shorter than this (m, ×wall scale) get no pilaster — a lone stub
 *  between two doors reads as leftover, not rhythm. */
export const PILASTER_MIN_RUN = 2.4;
/** A pilaster shorter than this (m, ×wall scale) between the dado rail and
 *  its cap is not a pilaster — this is what keeps the rhythm OFF cutaway
 *  sills (a 1.1m wall passes the dado's own full-band test but has no room
 *  for a strip above the rail). */
export const PILASTER_MIN_STRIP = 0.6;

/** Shelf wall (书架墙, v0.12 declarations audit): the wall-register
 *  treatment that turns a module's "shelf" role into a real bookcase wall
 *  — bay stiles + plinth/top/shelf boards + book rows in the bookshelf
 *  prop's material language, standing on the floor against the run's inner
 *  face (opaque, wall-supported, no hanging). Sizes ride the wall scale
 *  like every other wall feature. */
/** Bookcase height (m, ×wall scale), capped under the host run's drawn top. */
export const SHELF_WALL_HEIGHT = 2.6;
/** Projection off the inner face (m, ×wall scale) — the case depth. */
export const SHELF_WALL_DEPTH = 0.3;
/** Target bay width / per-run bay cap (m, ×wall scale / bays). */
export const SHELF_WALL_BAY = 1.2;
export const SHELF_WALL_BAY_MAX = 24;
/** A run shorter than this bookcase height (m, ×wall scale) keeps its
 *  plain wall — a case you could not shelve reads as a crate. */
export const SHELF_WALL_MIN_H = 1.0;
export const SHELF_WALL_STILE = 0.06;
export const SHELF_WALL_BOARD = 0.05;
export const SHELF_WALL_PLINTH = 0.14;
/** Shelf pitch (m, ×wall scale) — four to five rows under the 2.6m case. */
export const SHELF_WALL_SHELF_GAP = 0.48;
/** The bookshelf prop's own palette (space.tsx's "bookshelf" case). */
export const SHELF_WALL_WOOD = "#6b4f3a";
export const SHELF_WALL_BOARD_COLOR = "#7a6a55";
export const SHELF_WALL_ROW_COLORS = ["#c4553f", "#5a7a44", "#e8c95a"] as const;

/** Floor inlay (地面镶边): a border band in a contrasting stone, flat on
 *  the floor. Lifted 14mm — above the parquet's 6mm dressing plane so
 *  the two never z-fight, low enough to read as flush. The band is a
 *  calm, narrow frame: it must not fight the room's checker (A3 — the
 *  room's pattern budget belongs to light). Flat-floor rooms only:
 *  rolling terrain would clip straight through it. */
export const INLAY_LIFT = 0.014;
/** Band width (m, ×wall scale). */
export const INLAY_BAND_WIDTH = 0.4;
/** Smallest figure side (m, ×wall scale) that still reads as a figure —
 *  below this the feature is skipped. */
export const INLAY_MIN_SPAN = 1.6;

/* ------------------------------------------------------------------ */
/* The N3/N4 feature set (v0.11-room-interiors §3.2, 2026-10): the      */
/* raised platform, mezzanine, arch frame, column order and water rill  */
/* that complete the §3.2 catalogue alongside dado/pilaster/niche/inlay. */
/* Same conventions: sizes are human-scale meters ×wall scale (the      */
/* wallScale ratio the renderer already computes), every feature is    */
/* opaque architecture lit only by the room's own fixtures (B.13), and  */
/* each carries a minimum-host rule so a host that cannot hold it       */
/* degrades to NOTHING rather than clipping through (the cutaway/small  */
/* room discipline the dado and pilaster established).                 */
/* ------------------------------------------------------------------ */

/** Raised platform (抬高平台): a dais of two 18cm steps against a wall,
 *  railed on its open faces — a stage, a head table's floor. Sits on the
 *  floor; the railing keeps the edge honest (a raised edge you could
 *  fall from reads as architecture, a bare box as a crate). */
export const PLATFORM_HEIGHT = 0.36;
/** Step tread depth (m, ×wall scale) — each of the two steps. */
export const PLATFORM_STEP_DEPTH = 0.32;
/** Platform depth off the wall (m, ×wall scale). */
export const PLATFORM_DEPTH = 2.2;
/** Railing height above the platform (m, ×wall scale). */
export const PLATFORM_RAIL_HEIGHT = 0.9;
/** A run shorter than this (m, ×wall scale) gets no platform. */
export const PLATFORM_MIN_RUN = 3.4;
/** A platform opening this close (m, ×wall scale, center-to-center) to a
 *  strand door on its run forfeits the slot — the door's approach must
 *  stay open (same frame-shifted discipline as NICHE_DOOR_CLEAR). */
export const PLATFORM_DOOR_CLEAR = 1.4;

/** Mezzanine (夹层): a half-floor ledge along one full-height wall —
 *  the high-value piece under the dollhouse camera, where the room's
 *  silhouette gains a second layer. Deck + parapet on the open edge +
 *  corbel brackets underneath; nothing hangs (I2 — the deck is walled
 *  at both ends by the host wall's neighbours). */
export const MEZZANINE_DECK_Y = 2.3;
/** Ledge depth off the wall (m, ×wall scale). */
export const MEZZANINE_DEPTH = 2.2;
/** Parapet height above the deck (m, ×wall scale). */
export const MEZZANINE_PARAPET = 0.9;
/** Deck slab thickness (m, ×wall scale). */
export const MEZZANINE_SLAB = 0.16;
/** A host wall shorter than deck + parapet + this headroom (m, ×wall
 *  scale) gets no mezzanine — a ledge you would crack your head on is
 *  a bug, so cutaway sills and low rooms simply skip. */
export const MEZZANINE_HEADROOM = 1.0;
export const MEZZANINE_MIN_RUN = 3.6;

/** Arch frame (拱门框): two posts + a round arch spanning them, standing
 *  on the floor before a wall — a portal that needs no ceiling (the arch
 *  closes its own top, §3.2). Frames the wall behind it; walks the room's
 *  trim/stone register. */
export const ARCH_WIDTH = 2.6;
/** Post section (m, ×wall scale), square. */
export const ARCH_POST = 0.34;
/** Springing height — post top / arch foot (m, ×wall scale). */
export const ARCH_SPRING_Y = 2.35;
/** Arch tube radius (m, ×wall scale) — the round arch's thickness. */
export const ARCH_TUBE = 0.17;
/** A host wall whose DRAWN height cannot clear spring + tube + this (m,
 *  ×wall scale) gets no arch. */
export const ARCH_HEADROOM = 0.15;
export const ARCH_MIN_RUN = ARCH_WIDTH + 0.8;
export const ARCH_DOOR_CLEAR = 1.2;

/** Column order (柱式): a rhythm of free-standing classical columns —
 *  plinth + tapering shaft + echinus capital — standing off a wall like
 *  a colonnade in front of it (the §3.2 note: these REPLACE the old
 *  light-shaft vocabulary with real load-looking stone). Round where
 *  the pilaster is flat, off the wall where the pilaster hugs it. */
export const COLUMN_SHAFT_HEIGHT = 2.9;
export const COLUMN_SHAFT_RADIUS = 0.16;
export const COLUMN_PLINTH_HEIGHT = 0.22;
export const COLUMN_PLINTH_SIZE = 0.52;
export const COLUMN_CAPITAL_HEIGHT = 0.2;
export const COLUMN_CAPITAL_SIZE = 0.46;
/** Stand-off from the wall's inner face (m, ×wall scale). */
export const COLUMN_OFF_WALL = 0.85;
/** Center-to-center rhythm (m, ×wall scale) — a tighter, walkable
 *  colonnade spacing than the pilaster's flat rhythm. */
export const COLUMN_SPAN = 2.4;
export const COLUMN_END_PAD = 0.7;
export const COLUMN_MIN_RUN = 3.0;
export const COLUMN_DOOR_CLEAR = 1.0;

/** Water rill (地面水渠): a shallow stone runnel crossing a declared
 *  floor band, carrying REAL water on the room's own wave machinery — a
 *  second WaveDriver over the rill rectangle feeds the same
 *  createWaterSurfaceMaterial family the pool uses (Beer-Lambert
 *  absorption, wave-driven normals), so wading the rill ripples it
 *  exactly like wading the pool. The square sim grid stretches over the
 *  runnel's long rectangle: impulses elongate along the channel, which
 *  is also how a real narrow channel carries a disturbance — guided
 *  along its run. The rill claims NO caustics (its bed is its own stone
 *  geometry a handspan under 10–14cm of water — basin caustics stay the
 *  pool basin's, masked to the basin rect, untouched). Shallow enough to
 *  read as water over stone, never as a second pool. */
export const RILL_WIDTH = 0.8;
/** Runnel rim height above the floor (m, ×wall scale) — its side walls. */
export const RILL_RIM_HEIGHT = 0.24;
/** Water depth inside the runnel (m, ×wall scale). */
export const RILL_WATER_DEPTH = 0.12;
/** Bed thickness below the water (m, ×wall scale). */
export const RILL_BED = 0.06;
/** The rill never intrudes into the walk-path corridor: its rectangle
 *  must sit entirely outside |x| ≥ PATH_HALF + this (m, scaled), or the
 *  slot degrades to nothing (a channel you must step across mid-path is
 *  an obstruction, not a feature). */
export const RILL_PATH_CLEAR = 0.6;
/** Smallest runnel length (m, ×wall scale) that still reads as a
 *  crossing — below this the slot is skipped. */
export const RILL_MIN_LENGTH = 2.4;

/* ------------------------------------------------------------------ */
/* Motivated fixtures (v0.11-hotel-rooms B.13 「摄影棚论」, user        */
/* 2026-09-18): this world has NO outdoors, so every lit surface must  */
/* have a findable source. Every room grows a LAMP (shade + bulb + a   */
/* real point light + a floor pool) and a WINDOW (frame + a layered    */
/* outside view + mullions + spill; in interior rooms its spot is the  */
/* room's KEY light and casts the strong shadows); outdoor-class sets  */
/* (nature/wonder/hybrid, plus the pool hall — §2's worked example:    */
/* water needs a bright source to reflect) add a CLERESTORY — a high   */
/* window band along a full-height wall — that justifies the overall   */
/* key: light arrives from one side and above, never from a floating   */
/* panel (the transparent ceiling made the old skylight read as a      */
/* levitating plate; user 2026-09-19). Consumed by space.tsx;          */
/* placement is seeded (a dedicated "fixtures" stream, the             */
/* room-plan.ts convention). Sizes ride the room's own scale laws: the */
/* lamp is furniture (×propScale), the window/clerestory are           */
/* architecture (×wall scale). Light reach scales with the fixture: a  */
/* decay-2 light whose pool radius grows by k needs intensity ×k².     */
/* ------------------------------------------------------------------ */

/** Floor lamp: pole height, shade/bulb heights (m, ×propScale). */
export const LAMP_POLE_HEIGHT = 1.8;
export const LAMP_SHADE_Y = 2.0;
export const LAMP_BULB_Y = 1.82;
/** Tungsten warm — the hotel's architecture color (the corridor sconce's
 *  constant), not palette-bound: a lamp reads as hotel property. */
export const LAMP_COLOR = "#ffd9a0";
/** Point-light level at human scale (×propScale² in the renderer so a
 *  colossal room's giant lamp actually reaches its giant floor). Matches
 *  the corridor's measured chunk light (6, decay 2). */
export const LAMP_LIGHT_INTENSITY = 7;
/** Hard cutoff (m, ×propScale) — bounds the light's influence like the
 *  corridor chunk light's distance term. */
export const LAMP_LIGHT_DISTANCE = 9;
export const LAMP_SHADE_EMISSIVE = 1.6;
/** Above the bloom threshold (1.0): the bulb is the one hot core. */
export const LAMP_BULB_EMISSIVE = 2.2;
/** Additive floor pool under the lamp (m / peak opacity, ×propScale). */
export const LAMP_POOL_RADIUS = 2.3;
export const LAMP_POOL_OPACITY = 0.42;

/** Window: pane size and sill height (m, ×wall scale — a window is
 *  architecture, scaled like the dado band). */
export const WINDOW_WIDTH = 2.4;
export const WINDOW_HEIGHT = 1.9;
export const WINDOW_SILL_Y = 1.0;
/** The pane is a VIEW, not a glowing plate (§11.2): a layered outside —
 *  sky gradient + sun halo + far/near silhouettes, all palette-driven —
 *  baked by materials/window-view.ts and shown on an unlit plane. These
 *  gains are the plane's color multiplier: >1 in daylight so the sky
 *  just clears the bloom threshold, a cool half-strength wash at night
 *  (the window goes dark and cold, never black). */
export const WINDOW_VIEW_DAY_GAIN = 1.35;
export const WINDOW_VIEW_NIGHT_GAIN = 0.5;
export const WINDOW_VIEW_NIGHT_TINT = "#8ea0c8";
/** Cross bars over the view (m, ×wall scale) — what makes it a window
 *  and not a screen. */
export const WINDOW_MULLION = 0.07;
/** Faint glass sheen over the view (opacity; glass is one of the two
 *  sanctioned alpha materials). */
export const WINDOW_SHEEN_OPACITY = 0.1;
/** The interior KEY light: a spot just inside the pane, aimed down into
 *  the room (×wall scale²). 68 candela lands ≈2.6 at the spill pool's
 *  center (~5 m out) — the level the old full sun delivered, now with a
 *  source you can point at. It casts the room's strong shadows. At night
 *  the spot cools and dims (×WINDOW_NIGHT_SPOT_SCALE) and the lamp takes
 *  over as the room's primary. */
export const WINDOW_SPOT_INTENSITY = 68;
export const WINDOW_NIGHT_SPOT_SCALE = 0.5;
/** The lamp burns a little brighter after dark (×LAMP_NIGHT_BOOST) so
 *  the room's readability never depends on the window. */
export const LAMP_NIGHT_BOOST = 1.2;
export const WINDOW_SPOT_ANGLE = 0.62;
export const WINDOW_SPOT_PENUMBRA = 0.5;
/** Spot shadow rig (interior key): one 1024² map per mounted room. */
export const WINDOW_SPOT_SHADOW_MAP = 1024;
export const WINDOW_SPOT_SHADOW_NEAR = 0.4;
/** Shadow far plane (×wall scale): must reach the floor across the cone. */
export const WINDOW_SPOT_SHADOW_FAR = 26;
/** Additive spill quad on the floor in front of the pane (m / peak
 *  opacity; length ×wall scale) — the visible "light spilling inward". */
export const WINDOW_SPILL_LENGTH = 4.2;
export const WINDOW_SPILL_OPACITY = 0.3;
/** Clearance between the window frame and any door on the same wall (m). */
export const WINDOW_DOOR_CLEAR = 1.0;

/** Clerestory (the skylight's replacement): a window BAND high on a
 *  full-height wall. Band height and the drop below the wall top (m,
 *  ×wall scale); the span is the host wall's length minus END_PAD per
 *  side. Mullion bays repeat the view texture every UNIT meters. */
export const CLERESTORY_HEIGHT = 1.05;
export const CLERESTORY_DROP = 0.45;
export const CLERESTORY_END_PAD = 0.8;
export const CLERESTORY_UNIT = 2.3;
/** The spot through the band (×wall scale²): ~80 candela from a 3.5 m
 *  sill throws a broad warm wash across the floor — the outdoor set's
 *  "soundstage sky" with a source you can point at (walk to the wall and
 *  the sun was a row of high windows all along). Never casts (the sun
 *  owns the outdoor shadows; two near-coincident casters double-print). */
export const CLERESTORY_SPOT_INTENSITY = 80;
export const CLERESTORY_SPOT_ANGLE = 0.72;
export const CLERESTORY_SPOT_PENUMBRA = 0.7;
/** How far into the room the band's light is aimed (m, ×wall scale). */
export const CLERESTORY_SPOT_THROW = 5.5;
/** Additive floor wash below the band (m / peak opacity, ×wall scale). */
export const CLERESTORY_SPILL_LENGTH = 4.6;
export const CLERESTORY_SPILL_OPACITY = 0.26;

/** Light registers (v0.11-hotel-rooms §3, design §11.2 item 4): one
 *  room, one light mood, derived deterministically from the recipe's
 *  lightSeed. The register TINTS the window/clerestory light so it never
 *  fights the room's mood; the lamp stays hotel-tungsten (architecture,
 *  not palette). Ember is kept warm-soft — a late-evening glow, never a
 *  horror red (the anti-pattern list). */
export const LIGHT_REGISTER_TINTS = {
  tungsten: "#ffd9a8",
  fluorescent: "#cfe2ff",
  daylight: "#fff4dc",
  ember: "#ffb08a",
} as const;
export type LightRegister = keyof typeof LIGHT_REGISTER_TINTS;
/** Draw weights: tungsten 40 / fluorescent 25 / daylight 25 / ember 10. */
export const LIGHT_REGISTER_WEIGHTS: readonly {
  id: LightRegister;
  weight: number;
}[] = [
  { id: "tungsten", weight: 0.4 },
  { id: "fluorescent", weight: 0.25 },
  { id: "daylight", weight: 0.25 },
  { id: "ember", weight: 0.1 },
];

/** Module light registers → sconce fixture (v0.11-room-interiors §8.2):
 *  each composed-room module carries its own register — HOW it is lit,
 *  not with what colour — and the renderer grows one small wall sconce
 *  per module in that register, so neighbouring modules read as
 *  differently lit (a warm task pool over the desk, a cool wash over the
 *  shelf walls, pale daylight, the pool deck's bounced aqua, a dim quiet
 *  corner). Colours come from the same family as LIGHT_REGISTER_TINTS
 *  (pool-bounce is the water's own bounce — pale aqua, never saturated);
 *  intensity is the sconce's point-light level at human scale (×scale² in
 *  the renderer, the lamp's law), pool the additive floor quad's peak. */
export const MODULE_LIGHT_FIXTURES: Record<
  string,
  { color: string; intensity: number; pool: number }
> = {
  task: { color: "#ffd9a8", intensity: 4.5, pool: 0.34 },
  wash: { color: "#cfe2ff", intensity: 4.5, pool: 0.3 },
  daylight: { color: "#fff4dc", intensity: 5.5, pool: 0.36 },
  "pool-bounce": { color: "#bfeadb", intensity: 4.5, pool: 0.32 },
  quiet: { color: "#e6d3b3", intensity: 2.2, pool: 0.22 },
};
