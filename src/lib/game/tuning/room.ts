/**
 * Room visual tuning — every visual constant the space renderer
 * (src/components/game/space.tsx) consumes, plus the door geometry and
 * swing shared with the corridor renderer: the door is one physical slab
 * seen from both sides, so there is exactly one definition, here.
 *
 * Wall HEIGHT is shared too, but lives with the layout math: WALL_HEIGHT
 * in ../hotel. Pure data — no three.js, no React, no seeding.
 */

import { VIVID_PALETTES } from "../space-types";

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
/** Ripple normal strength (material.normalScale). */
export const WATER_NORMAL_SCALE = 0.75;
/** The three scrolling ripple layers: `meters` = one texture repeat's
 *  physical span (the builder's base period of 6 cells/repeat puts ripple
 *  features at meters/6 ≈ 0.4–1.2m), vx/vy = scroll velocity in uv/sec.
 *  Different scales, directions, and speeds so the sum never correlates. */
export const WATER_RIPPLE_LAYERS = [
  { meters: 7, vx: 0.021, vy: 0.013 },
  { meters: 4.5, vx: -0.017, vy: 0.026 },
  { meters: 2.5, vx: 0.033, vy: -0.009 },
] as const;

/* ------------------------------------------------------------------ */
/* Room language (v0.11 §3): scale notation, plan, composition.        */
/* Consumed by lib/game/room-plan.ts (pure) and space.tsx.            */
/* ------------------------------------------------------------------ */

/** Scale draw: 78% of rooms stay human-scale — the distortion must stay
 *  special to read as a dream (A2), not as the new normal. */
export const SCALE_NORMAL_PROB = 0.78;
/** Scale draw: 12% colossal; the remaining 10% are miniature (slightly
 *  rarer — tiny rooms risk readability more than huge ones). */
export const SCALE_COLOSSAL_PROB = 0.12;
/** Colossal factor = MIN + r·SPAN → ×2.5–3.5, centered on ×3 (doc 附录
 *  B.12, user 2026-09-18: a merely big space is worth little — "colossal"
 *  keeps the bigger-than-expected surprise but no longer sprawls into an
 *  empty floor; recognizability now comes from light/material/set-dressing,
 *  not area). Was ×8–20 per the original §3 notation. */
export const SCALE_COLOSSAL_MIN = 2.5;
export const SCALE_COLOSSAL_SPAN = 1;
/** Miniature factor = MIN + r·SPAN → ×0.2–0.35: small enough to read as a
 *  room built too small for you, large enough to actually walk into — an
 *  M-tier (32m) room lands 6.4–11.2m across, never near the player's own
 *  0.9m capsule (the old 0.05 floor built unenterable 1.6m boxes). */
export const SCALE_MINIATURE_MIN = 0.2;
export const SCALE_MINIATURE_SPAN = 0.15;
/** Wall height scales by S^0.5, not S: full-S walls (14m at ×3.5) would make
 *  the far walls the only thing on screen at the fixed camera (the near
 *  walls are cut to WALL_SILL_HEIGHT, so they no longer veil the room). */
export const WALL_SCALE_EXP = 0.5;
/** Wall-height clamps (m): MIN is the absolute safety floor — in practice
 *  the portal floor (PORTAL_HEIGHT + WALL_PORTAL_MARGIN, below) binds
 *  first; MAX stops colossal walls before they become the only thing on
 *  screen. */
export const WALL_HEIGHT_MIN = 0.8;
export const WALL_HEIGHT_MAX = 16;
/** Extra wall above the 3.2m portal surround: the door never scales (the
 *  A4 human-scale anchor), so miniature walls must still contain the
 *  portal plus this margin of visible wall over the lintel. */
export const WALL_PORTAL_MARGIN = 0.3;
/** Furniture/motif props scale by S^0.75 — giant enough to sell the room's
 *  scale, always shorter than the walls they stand between. */
export const PROP_SCALE_EXP = 0.75;
/** Creatures (ducks/pets/balloons) scale by S^0.5: they are characters whose
 *  readability matters more than their role as a scale cue. */
export const CREATURE_SCALE_EXP = 0.5;
/** Terrain tessellation cap: segments grow with S^0.75 so colossal rolling
 *  ground doesn't alias, but vertex count stays bounded (one-time cost). */
export const GROUND_SEGMENTS_MAX = 256;
/** Miniature rooms still get a readable grounding apron under the diorama. */
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
 *  room-plan.ts scales it by clamp(S, 0.35, 2) so miniature rooms keep
 *  props and colossal rooms keep a passable gap between giant props. */
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
/** Pet waypoint radius cap (m): in colossal rooms pets stay near the door,
 *  where the player actually is, instead of wandering a 150m orbit. */
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
/* Motivated fixtures (v0.11-hotel-rooms B.13 「摄影棚论」, user        */
/* 2026-09-18): this world has NO outdoors, so every lit surface must  */
/* have a findable source. Every room grows a LAMP (shade + bulb + a   */
/* real point light + a floor pool) and a WINDOW (frame + bright pane  */
/* + spill; in interior rooms its spot is the room's KEY light and     */
/* casts the strong shadows); outdoor-class sets (nature/wonder/hybrid, */
/* plus the pool hall — §2's worked example: water needs a skylight to */
/* reflect) add a SKYLIGHT that justifies the overall key. Consumed by */
/* space.tsx; placement is seeded (a dedicated "fixtures" stream, the  */
/* room-plan.ts convention). Sizes ride the room's own scale laws: the */
/* lamp is furniture (×propScale), the window/skylight are             */
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
/** Bright face — the bloom threshold is 1.0, so the pane reads as a lit
 *  opening, not a picture of one. Color comes from palette.sunColor. */
export const WINDOW_PANE_EMISSIVE = 2.4;
/** The interior KEY light: a spot just inside the pane, aimed down into
 *  the room (×wall scale²). 60 candela lands ≈2.5 at the spill pool's
 *  center (~5 m out) — the level the old full sun delivered, now with a
 *  source you can point at. It casts the room's strong shadows. */
export const WINDOW_SPOT_INTENSITY = 60;
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

/** Skylight: opening half-size (m, ×wall scale) and how far the frame
 *  floats above the drawn wall top — the rooms have no ceilings (the
 *  dollhouse IS the point), so the opening hangs like the chandelier
 *  does: present, glowing, unmoorable. */
export const SKYLIGHT_HALF = 1.7;
export const SKYLIGHT_LIFT = 0.6;
export const SKYLIGHT_PANE_EMISSIVE = 2.6;
/** The spot through the opening (×wall scale²): ~80 candela puts a hot
 *  ~3.5 pool on the floor directly under a 4.6 m opening at human scale —
 *  the visible light column's landing. Never casts (the sun owns the
 *  outdoor shadows; two near-coincident shadow casters would double-print). */
export const SKYLIGHT_SPOT_INTENSITY = 80;
export const SKYLIGHT_SPOT_ANGLE = 0.55;
export const SKYLIGHT_SPOT_PENUMBRA = 0.6;
/** Additive shaft quads along the sun's direction + the floor pool where
 *  it lands (peak opacities; pool radius m ×wall scale). */
export const SKYLIGHT_SHAFT_OPACITY = 0.14;
export const SKYLIGHT_POOL_RADIUS = 2.8;
export const SKYLIGHT_POOL_OPACITY = 0.28;
