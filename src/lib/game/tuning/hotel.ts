/**
 * Hotel visual tuning — every visual constant the corridor renderer
 * (src/components/game/corridor.tsx) consumes: streaming radius, wall
 * thickness, theme/void palettes, per-role PBR finishes and the shared
 * grunge map, sconce/lamp colors, the dimming tables and lerp rates,
 * signage palettes, painting palette and dimensions, the corridor-form
 * constants (cornice, wainscot, portal), the
 * sconce light pools, the fixture-light layout constants (B.13 灯廊: real
 * lights live ON fixtures — sconces, the baseboard light line, floor
 * lamps), and the end-fade curtain + end-glow termination. The door slab geometry itself is shared with the
 * space renderer and lives in ./room. Pure data — no three.js, no React.
 */

import { CHUNK_LENGTH, WALL_HEIGHT } from "../hotel";

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

export const CHUNK_RADIUS = 1;

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
  endGlow: { full: 0.45, dimmed: 0.14, day: 0.3 }, // haze glow past the end-fade curtains
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

export const FADE_WIDTH = CHUNK_LENGTH;
export const FADE_HEIGHT = WALL_HEIGHT * 3;
/** Alpha never quite reaches 0 — a whisper of haze keeps the raw floor cut
 *  at the world edge soft even where the gradient bottoms out. */
export const FADE_ALPHA_FLOOR = 0.1;
export const FADE_RAMP_Y0 = 0.2; // meters — gradient starts just above the floor
export const FADE_RAMP_Y1 = WALL_HEIGHT; // opaque from the wall top up

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

/* ------------------------------------------------------------------ */
/* End-of-world termination — haze, never a black wall                */
/* ------------------------------------------------------------------ */

/** Warm haze glow behind each end-fade curtain: the corridor dissolves
 *  into light, not darkness (the anti-pattern list forbids a black end). */
export const END_GLOW_COLOR = "#f0e2c4";
export const END_GLOW_WIDTH = 9; // glow plane size, m
export const END_GLOW_HEIGHT = 5.5;
export const END_GLOW_OFFSET = 0.7; // sits this far beyond the fade curtain
