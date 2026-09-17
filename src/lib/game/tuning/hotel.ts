/**
 * Hotel visual tuning — every visual constant the corridor renderer
 * (src/components/game/corridor.tsx) consumes: wall
 * thickness, theme/void palettes, per-role PBR finishes and the shared
 * grunge map, sconce/lamp colors, the dimming tables and lerp rates,
 * signage palettes, painting palette and dimensions, the corridor-form
 * constants (cornice, wainscot, portal), the
 * sconce light pools, the fixture-light layout constants (B.13 灯廊: real
 * lights live ON fixtures — sconces, the baseboard light line, floor
 * lamps), and the hotel-door constants (page door, return doors, arrival
 * door, accent — HD3/§11.1). The door slab geometry itself is shared with the
 * space renderer and lives in ./room. Pure data — no three.js, no React.
 */

import { WALL_HEIGHT } from "../hotel";

/**
 * Day/night — the corridor INTERIOR follows the app's Tailwind dark mode (the
 * integrator reads it via next-themes and passes `dark` down; the R3F
 * reconciler never sees that React context, so it arrives as a plain
 * prop). The void behind the hotel, though, is always black: the hotel
 * floats in darkness whatever the app theme, and a bright corridor
 * suspended in a black void is the liminal look. Every themed surface
 * color lives in THEME_COLORS; one shared material per role (see
 * HotelMaterials) is lerped between its day and night targets by a single
 * useFrame in Corridor, so a theme toggle eases over ~a second instead of
 * snapping. Exported: the integrator keeps the scene background/fog on
 * VOID_COLORS so the corridor's end-fade planes always match.
 */
export const VOID_COLORS = { night: "#101219", day: "#101219" } as const;

/** Surface palette per theme — warm neutrals, day lifted from the night set. */
export const THEME_COLORS = {
  floor: { night: "#6b5d4f", day: "#bfae93" }, // wood; the runner below carries the carpet
  wall: { night: "#8a7f70", day: "#d9d2c5" }, // greige → warm off-white
  trim: { night: "#463f36", day: "#8f867a" }, // baseboards, frames, brackets
  slab: { night: "#7b6d5c", day: "#cbbfa9" }, // door slabs
  desk: { night: "#7a6a58", day: "#c4b49b" },
  cushion: { night: "#9c8b76", day: "#ded4c3" },
  pot: { night: "#5f5648", day: "#a79d8c" },
  foliage: { night: "#7d8a66", day: "#9cae87" },
  carpet: { night: "#54222b", day: "#9c626c" }, // corridor runner — deep wine → dusty rose
  carpetEdge: { night: "#33141b", day: "#6e4249" }, // runner binding stripes
  wainscot: { night: "#6e6252", day: "#cfc3ae" }, // wainscot band — a shade darker than the wall
} as const;

/**
 * Physical finish per surface role — the PBR half of "looks simple, light
 * is real". Values are real-material registers (waxed wood sheen, glazed
 * ceramic, matte plaster/fabric), deliberately NOT uniform: a flat
 * roughness=1/metalness=0 everywhere is what made the hotel read as a
 * cardboard model. The day/night lerp in Corridor only moves color; these
 * stays constant per role.
 */
export const MATERIAL_FINISH: Record<
  keyof typeof THEME_COLORS,
  { roughness: number; metalness: number }
> = {
  floor: { roughness: 0.55, metalness: 0 }, // waxed wood — soft sheen under the lamps
  wall: { roughness: 0.92, metalness: 0 }, // painted plaster — near-matte
  trim: { roughness: 0.45, metalness: 0.35 }, // darkened metal/brass fixtures
  slab: { roughness: 0.5, metalness: 0 }, // lacquered door leaf
  desk: { roughness: 0.5, metalness: 0.05 }, // polished wood counter
  cushion: { roughness: 0.95, metalness: 0 }, // fabric
  pot: { roughness: 0.35, metalness: 0 }, // glazed ceramic
  foliage: { roughness: 0.9, metalness: 0 }, // matte leaves (keeps flatShading)
  carpet: { roughness: 1, metalness: 0 }, // deep-pile runner — fully matte
  carpetEdge: { roughness: 0.9, metalness: 0 }, // runner binding
  wainscot: { roughness: 0.7, metalness: 0 }, // satin-painted wood paneling
};

/**
 * Shared mottled roughnessMap — a seeded grayscale noise canvas multiplied
 * into material.roughness so reflections "breathe" instead of reading as
 * one uniform value (spec §2 hard requirement 2). The map itself (and the
 * GRUNGE_MAP_* shape constants) lives in the procedural material library:
 * src/lib/game/materials/grunge.ts. GRUNGE_ROLES stays here because which
 * corridor roles receive the map is a corridor material decision.
 */
/** Roles that receive the mottled roughnessMap (soft-sheen surfaces; matte
 *  fabric/foliage stay untextured). */
export const GRUNGE_ROLES = ["floor", "wall", "trim", "slab", "desk", "pot", "wainscot"] as const;

/** Corridor sconce glow — warm constant, architecture rather than memory. */
export const SCONCE_COLOR = "#ffd9a0";
export const LAMP_COLOR = "#ffb46b";

/* ------------------------------------------------------------------ */
/* Hotel doors beyond rooms — the page door and the return door (HD3)   */
/* ------------------------------------------------------------------ */

/** Brand blue — the core timeline's hotel accent (v0.11-room-interiors
 *  §11.1: what belongs to Previously itself wears #0066ff). Corridor door
 *  plates, the page door, and the lobby's return door take the current
 *  hotel's accent; the core hotel's accent is this. */
export const HOTEL_ACCENT_CORE = "#0066ff";

/** Where the lobby's NORTH return door hangs: on the junction band's north
 *  wall (z = +CORRIDOR_WIDTH/2), this far along x. Clear of the portal posts
 *  at the corridor seam and of the lobby's east wall. */
export const RETURN_DOOR_X = 10;

/** Where the lobby's SOUTH return door hangs (§10.5: 大堂南北墙各挂一扇 —
 *  the wall you find your way back on is the side you came from). The south
 *  wall is the leg's far wall (z = −LOBBY_SOUTH_REACH, the front desk's
 *  wall); the door sits at this x — west of the desk (desk centers at
 *  x ≥ 5.5) and clear of the west-corner plant and the armchair pair. */
export const RETURN_DOOR_SOUTH_X = 2.6;

/** Crossing trigger of the south return door: the player has pushed this
 *  far past the south wall's plane inside the door gap — mirrors the north
 *  door's WALL_OUT hysteresis (clamps.ts). */
export const RETURN_DOOR_SOUTH_CROSS_DEPTH = 0.2;

/* ------------------------------------------------------------------ */
/* Lobby register board (§9.2/§10.3 — the 目录板)                       */
/* ------------------------------------------------------------------ */

/** The register board hangs on the lobby's south wall ABOVE the front desk
 *  — the classic hotel rate-board spot, the one fixed place every arrival
 *  faces (§10.2a). Its center x follows the desk (LOBBY_LAYOUT's desk x
 *  band). */
export const REGISTER_BOARD_Y = 2.35;
/** Board width/height in meters (the R3F backing panel the DOM text sits
 *  on). Big on purpose: the fixed ortho camera maps ~44 px to a meter, so
 *  an 8-slice register only stays readable when the board spans a real
 *  notice board's share of the wall (floor-to-cornice tall behind the
 *  desk, like a rate board that means it). */
export const REGISTER_BOARD_W = 4.4;
export const REGISTER_BOARD_H = 3.0;

/** How far the arriving player stands off the return door, facing the
 *  lobby interior (§10.2a: arrival is always in the lobby, the door you
 *  came through hangs on the wall behind you). */
export const LOBBY_ARRIVAL_INSET = 1.6;

/** Page-door crossing trigger: the player has pushed this far past the end
 *  wall's plane (inside the door gap) — mirrors the room doors'
 *  ROOM_DOOR_CROSS_DEPTH pattern. Reachable through the clamp's
 *  END_WALL_PASS_DEPTH overtravel (clamps.ts). */
export const PAGE_DOOR_CROSS_DEPTH = 0.3;

/** Arrival-door crossing trigger (§10.5 西出东进): the player has pushed
 *  this far past the lobby EAST wall's plane inside the arrival door's gap
 *  — mirrors the south return door's RETURN_DOOR_SOUTH_CROSS_DEPTH. */
export const ARRIVAL_DOOR_CROSS_DEPTH = 0.2;

/** The lobby east wall's passage: inside the arrival door's gap the east
 *  bound relaxes this far past the wall plane so the crossing trigger is
 *  reachable — the same overtravel the south return door gets
 *  (LOBBY_SOUTH_PASS_DEPTH, game-canvas.tsx). */
export const EAST_DOOR_PASS_DEPTH = 0.6;

/** Walking BACK through an arrival door lands the player this far inside
 *  the departure hotel's west end (past the page door's gap), facing the
 *  corridor — the mirror of LOBBY_ARRIVAL_INSET: out the west end, in at
 *  the east (§10.5 西出东进). */
export const WEST_END_ARRIVAL_INSET = 1.2;

/* ------------------------------------------------------------------ */
/* Door pitch — time gaps become door spacing (v0.11-strand-field §1:  */
/* 时间线 = 间隔 — a timeline is intervals, so the corridor shows them) */
/* ------------------------------------------------------------------ */

/**
 * Pitch formula (implemented in src/lib/game/corridor-pitch.ts):
 *
 *   doorPitchMeters(gapDays) = clamp(
 *     DOOR_PITCH_MIN,
 *     DOOR_PITCH_BASE + DOOR_PITCH_GAIN * log10(max(1, gapDays)),
 *     DOOR_PITCH_MAX,
 *   )
 *
 * where gapDays is the gap between chronologically adjacent slices in the
 * corridor's door order. The pitch lives purely in corridor space — it is
 * independent of room dimensions; a room merely mounts at its door's
 * position.
 */
/** Under a day apart → today's spacing, unchanged. */
export const DOOR_PITCH_BASE = 6;
/** Meters of pitch added per decade of silence (per log10 of the gap). */
export const DOOR_PITCH_GAIN = 12;
/** A bay never shrinks tighter than this, however dense the slices. */
export const DOOR_PITCH_MIN = 5;
/** ≈4× a dense stretch: felt, not tedious at 4 m/s. */
export const DOOR_PITCH_MAX = 24;

/** Corridor/lobby wall thickness; walls are centered on
 *  z = ±CORRIDOR_WIDTH / 2. Deliberately NOT the room wall thickness
 *  (ROOM_WALL_THICKNESS in ./room, 0.3): different walls, different
 *  values, keep both. */
export const CORRIDOR_WALL_THICKNESS = 0.2;

/**
 * Full vs dimmed levels for every light and glow material in the scene.
 * Single source of truth: the JSX initial values read `.full` from here
 * and the dimming lerp targets `.dimmed`, so the two can never drift
 * apart. Dimmed emissive/opacity levels are ~30% of full (a ~70% cut);
 * real lights dim to the task-specified levels. Entries with a `day`
 * override use it instead of `full` while the app is in light mode
 * (the fake-glow decals — sconce pools, wall washes, the light line's
 * wash and floor glow — switch off: daylight needs no fake glow; the
 * fixtures' real lights stay on, lamps burning in a bright hotel — and
 * the hemisphere opens up).
 *
 * B.13 灯廊: the hemisphere keeps only the "we are indoors" floor; the
 * mood is carried by fixture lights — sconceLight at the sconces,
 * stripLight along the baseboard light line, the floor lamps. There is
 * no abstract mid-hall chunk light any more.
 */
export const LIGHT_LEVELS = {
  hemisphere: { full: 0.4, dimmed: 0.04, day: 0.85 },
  sconceLight: { full: 4.5, dimmed: 0.25 },
  stripLight: { full: 3.5, dimmed: 0.2 },
  corridorLamp: { full: 4, dimmed: 0.4 },
  lobbyLamp: { full: 5, dimmed: 0.5 },
  lampShade: { full: 1.4, dimmed: 0.42 },
  sconceShade: { full: 1.2, dimmed: 0.36 },
  // Gradient-textured pools: peak opacity at the pool center — the radial
  // alpha texture does the falloff, so these can run far hotter than the
  // old bare-circle pair (0.07/0.15) that read as nothing.
  sconcePool: { full: 0.5, dimmed: 0.15, day: 0 },
  sconceWash: { full: 0.35, dimmed: 0.1, day: 0 },
  // The light line: the strip itself is the visible fixture, so it only
  // tones down in day (a cove line burning in a bright hotel); its wash
  // and floor glow are fake-glow decals and switch off like the sconce's.
  stripGlow: { full: 1.6, dimmed: 0.48, day: 0.4 },
  stripWash: { full: 0.3, dimmed: 0.09, day: 0 },
  stripPool: { full: 0.22, dimmed: 0.07, day: 0 },
  doorGlow: { full: 1.6, dimmed: 0.48 },
  doorHalo: { full: 0.14, dimmed: 0.042 },
  doorStrip: { full: 2.2, dimmed: 0.66 },
  plaque: { full: 1, dimmed: 0.15 },
} as const;

export interface LightLevels {
  readonly full: number;
  readonly dimmed: number;
  readonly day?: number;
}

/**
 * Lerp rates for the dimming hook. Recovery (dimmed → full) keeps the
 * game canvas's atmosphere rate (tuning/render.ts ATMOSPHERE_LERP_RATE,
 * 2.5/s) so the hotel returns gently; the descent toward dimmed runs
 * faster (6/s) because it ends in an unmount — by HIDE_DELAY_MS it is
 * ~95% dark, so removing the last ghost of geometry does not pop. Same
 * dt clamp as the canvas so a background tab never overshoots.
 */
export const DIM_LERP_RATE = 2.5;
export const DIM_LERP_RATE_DESCEND = 6;
export const DIM_MAX_DT = 0.05;
/**
 * Delay between `dimmed` turning true and the hotel unmounting. Tuned
 * against DIM_LERP_RATE_DESCEND: 0.5 s ≈ three descent time constants.
 * Exported: the game canvas mirrors this delay so the space-side door
 * slab mounts exactly when the corridor's slab unmounts — never both.
 */
export const HIDE_DELAY_MS = 500;

/** Day/night color & level transitions ease at the atmosphere rate. */
export const THEME_LERP_RATE = 2.5;

export const PLATE_BG = "#17130f";
export const PLATE_INK = "#ece2cc";

/**
 * Muted abstract-art palette for the corridor paintings. A fixed pool —
 * the art hangs in either theme; the lighting moves around it.
 */
export const ART_PALETTE = [
  "#8a4a3a",
  "#c8b48a",
  "#5a6b7a",
  "#7a8a5a",
  "#a3748a",
  "#4a4a58",
  "#b0643f",
  "#6d7f8c",
] as const;

export const PAINTING_W = 1.0;
export const PAINTING_H = 1.3;

/* ------------------------------------------------------------------ */
/* Corridor form — wall detail, lobby anchor                           */
/* ------------------------------------------------------------------ */

/** Cornice band crowning every wall, slightly proud of the inner face. */
export const CORNICE_HEIGHT = 0.16;
export const CORNICE_DEPTH = 0.16;
/** Wainscot band + chair rail along the walls (broken at door gaps). */
export const WAINSCOT_HEIGHT = 1.05;
export const WAINSCOT_DEPTH = 0.04;
export const CHAIR_RAIL_HEIGHT = 0.06;
export const CHAIR_RAIL_DEPTH = 0.06;

/** Portal posts at the lobby/corridor seam (x = 0) — the threshold you can
 *  recognise from far down the hall. */
export const PORTAL_POST_SIZE = 0.3; // square cross-section, m

/** The lobby's west leg wall (x = 0, south of the corridor band) faces the
 *  camera (−x side), so it stays a low parapet — the dollhouse cutaway that
 *  lets the 45° camera read the leg's floor and the desk against its far
 *  wall. The far (south/east) walls run full height as the backdrop. */
export const LOBBY_CUTAWAY_HEIGHT = 1.1; // m
/** Trim cap crowning the cutaway parapet, slightly proud of its faces. */
export const LOBBY_CUTAWAY_CAP = 0.06; // m tall

/* ------------------------------------------------------------------ */
/* Sconce light pools — textured quads, not bare additive circles     */
/* ------------------------------------------------------------------ */

export const SCONCE_POOL_RADIUS = 1.7; // floor pool quad radius, m
export const SCONCE_POOL_OFFSET = 1.3; // pool center distance in from the wall face, m
export const SCONCE_WASH_WIDTH = 2.4; // wall-wash quad width, m
export const SCONCE_WASH_HEIGHT = 2.7; // wall-wash quad height (floor → shade), m
/* The glow gradient textures themselves (and GLOW_TEXTURE_SIZE) live in the
 * material library: src/lib/game/materials/glow.ts. */

/* ------------------------------------------------------------------ */
/* Fixture lights — real point lights live ON fixtures (B.13 灯廊)      */
/* ------------------------------------------------------------------ */

/** A sconce's real point light hangs just under and in front of its shade
 *  — the fixture IS the source, nothing floats mid-hall. */
export const SCONCE_LIGHT_HEIGHT = 2.45; // m, just below the shade at 2.55
export const SCONCE_LIGHT_INSET = 0.5; // m in from the inner wall face
/** Real-light budget per chunk: every sconce is lit up to this count; a
 *  longer chunk (a silent stretch) thins the lit set to an even spread
 *  with a proportionally longer reach, so shader cost stays bounded while
 *  the lamp rhythm (shades + pool decals on every sconce) never breaks. */
export const SCONCE_LIGHT_MAX_PER_CHUNK = 6;

/** The baseboard light line — the south wall's own fixture: a continuous
 *  low cove strip just above the baseboard (no ceiling exists in the
 *  dollhouse cutaway, so the cove lives at ankle height). Warm, a touch
 *  deeper than the sconce glow for variety. */
export const STRIP_COLOR = "#ffc98a";
export const STRIP_HEIGHT = 0.35; // strip center above the floor, m
export const STRIP_WASH_HEIGHT = 1.5; // wall wash above the strip, m
export const STRIP_POOL_WIDTH = 1.6; // floor glow width along the wall, m
/** The line's real lights: low and close to the wall, so their grazing
 *  pools read as cast by the strip itself. */
export const STRIP_LIGHT_HEIGHT = 0.55;
export const STRIP_LIGHT_INSET = 0.7; // m in from the inner wall face
export const STRIP_LIGHT_TARGET_SPACING = 12; // m between strip lights
export const STRIP_LIGHT_MAX_PER_CHUNK = 6;

/** Corridor floor lamps — the lobby fixture, at intervals along the hall
 *  on the fixed architectural grid, alternating walls by grid parity and
 *  skipping positions a door swings through. */
export const FLOOR_LAMP_SPACING = 24; // m — every fourth sconce grid point
export const FLOOR_LAMP_Z = 4.35; // hugs the wall like the plants
export const FLOOR_LAMP_DOOR_CLEARANCE = 2; // m from any bay door center
export const FLOOR_LAMP_LIGHT_DISTANCE = 10; // shorter reach than the lobby's 13

