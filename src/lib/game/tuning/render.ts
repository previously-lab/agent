/**
 * Renderer tuning — every visual constant the integrator
 * (src/components/game/game-canvas.tsx) consumes: the fixed camera, scene
 * mood colors, the key/ambient lighting hierarchy (sun base levels and the
 * shadow rig), the post-processing chain (N8AO), atmosphere lerp, player
 * avatar colors and motion rates, wade depth, interaction distances, and
 * spawn. The water plane height itself is shared with the room renderer and
 * lives in ./room (WATER_Y). Pure data — no three.js, no React.
 *
 * The matte art overhaul (v0.11-streams) removed the game's IBL environment,
 * stage backdrop, Bloom and Vignette: broad matte surfaces are shaped by the
 * single directional sun plus a lifted ambient alone, and depth is carried
 * by N8AO + the background color. The ENV, BLOOM and VIGNETTE families and the
 * remaining STAGE_BACKDROP_* constants below are STILL consumed by
 * src/components/playground/playground-scene.tsx (the material testbed),
 * which is outside this pass's ownership — they stay until that scene is
 * migrated; the game canvas imports none of them.
 */

import { VOID_COLORS } from "./hotel";
import {
  ALPHA_WALL_KINDS,
  skinForSlice,
  type BiomeSkin,
  type SkinHorizon,
  type SkinSilhouette,
} from "../skins";

/** Scene mood while no space is active — the void color for the active
 *  theme (shared with the corridor so the end-fade planes always match
 *  the background). There is no scene fog anywhere in the game. */
export const SCENE_COLORS = VOID_COLORS;

/** Ortho zoom for the fixed camera. 44 (doc 附录 B.12, user 2026-09-18:
 *  "closer reads as more immersive") — pulled in ~29% from the old 34, so
 *  the view half-width at 1080p shrinks from ≈28 m to ≈22 m. The corridor
 *  still frames ~7 dense bays (6 m pitch) down to ~2 sparse ones (24 m
 *  pitch, corridor-pitch.ts) per screen. */
export const CAMERA_ZOOM = 44;
/** The camera offset itself lives in ./room (CAM_OFFSET) — the leaf module
 *  the pure game chain reads; re-exported here for the render lane. */
export { CAM_OFFSET } from "./room";
/** Follow smoothing: factor = 1 − e^(−rate·dt). */
export const CAMERA_LERP_RATE = 6;
/** Wormhole hand-off (doc B.11): when a strand door teleports the player
 *  ~90 m down the timeline, snap the camera's smoothed focus to the new
 *  position on that frame instead of letting the lerp glide the new room
 *  into frame over ~1 s (review flagged the slide as reading like a
 *  defect). Set to false to re-enable the glide. */
export const STRAND_TELEPORT_CAMERA_SNAP = true;
/** Room legibility zoom (first pass, expect tuning): inside a space the
 *  ortho zoom TARGET divides by clamp(S, 1, ∞)^0.5, lerped with the camera
 *  easing — the rail stays for any future factor > 1; at v0.13's single ×1
 *  tier the clamp is the identity and the zoom target is unchanged. */
export const ROOM_ZOOM_SCALE_EXP = 0.5;
/** Hard cap on the pull-back: the view never gets more than ~3× wider than
 *  normal — the dollhouse must stay readable (doc §1 A4: a human-scale
 *  anchor must stay legible). A safety rail today: no live draw reaches it
 *  (every room is ×1). */
export const ROOM_ZOOM_MAX_PULLBACK = 3;

export const PLAYER_SPEED = 4; // m/s
/** In-room speed boost: while a space is active the player moves at
 *  PLAYER_SPEED × clamp(S, 1, ∞)^0.75 (the corridor stays exactly 4 m/s) —
 *  the room should feel immense, not waste the player's time. */
export const ROOM_SPEED_SCALE_EXP = 0.75;
export const BOB_RATE = 9; // rad/s while walking
export const BOB_HEIGHT = 0.05;
export const TURN_LERP_RATE = 12;
/** Avatar Y snapping toward the terrain (or back to corridor floor). */
export const GROUND_LERP_RATE = 10;

export const PLAYER_BODY = "#c9875b"; // a small, warm focal point
export const PLAYER_HEAD = "#f4d3ae";
/** Legs and hair stay quiet so the warm torso reads as the focal point
 *  (sage/dark family, per the reference illustration's figure). */
export const PLAYER_LEG = "#5f6a52";
export const PLAYER_HAIR = "#657053";
export const SUN_BASE_COLOR = "#fff3d5";
/** Key-light base level. The sun is the ONE strong, shadow-casting light
 *  (doc §1 A3). The matte overhaul runs it at a moderate 1.35 — broad
 *  even daylight with the ambient lifted to match (CORRIDOR_AMBIENT 0.52),
 *  so shadows stay visible as gentle direction separation, never the hard
 *  black pools the old strong-sun model produced. Inside a space this is
 *  multiplied by palette.sunIntensity — and, per B.13, by
 *  ROOM_INTERIOR_SUN_FILL in interior rooms, where the key moves to the
 *  room's own fixtures and this light is only the soft overall. */
export const SUN_BASE_INTENSITY = 1.35;
/** Ambient floor in the corridor; inside a space the palette's own
 *  `ambient` (scaled by SPACE_AMBIENT_SCALE) takes over. Lifted to 0.52 in
 *  the matte overhaul: with the IBL environment gone, the ambient IS the
 *  diffuse fill — the reference look is broad soft daylight, not
 *  directional drama. It stays below the sun's effective level so face
 *  separation survives. */
export const CORRIDOR_AMBIENT = 0.52;
/** In-room directional level for INTERIOR rooms, as a fraction of the
 *  palette-authored sun term (doc B.13, user 2026-09-18 — "everything is
 *  indoors": an interior's key must come from its own fixtures, so the
 *  sun drops to a FILL here; outdoor-class sets keep it at 1 as the
 *  soundstage's overall key, justified by the clerestory band). It stays
 *  shadow-casting at 0.55: enough to separate faces and ground furniture,
 *  but not enough to own the room's tonal range. The window spot remains
 *  a motivated accent under the same quiet budget. */
export const ROOM_INTERIOR_SUN_FILL = 0.55;
/** Broad bounced light preserves the room's material colors from the RTS
 *  view. At 2.0 the palette's ambient becomes 1.12 by day and 0.88 at
 *  night: a stable diffuse floor that lifts unlit faces into the light
 *  blue-gray/cream family while the reduced directional key keeps their
 *  separation modest. This changes no exposure, tone mapping or fog. */
export const SPACE_AMBIENT_SCALE = 2;
/** Background/fog/sun lerp rate when a space opens or closes. */
export const ATMOSPHERE_LERP_RATE = 2.5;
/** Wade depth below the water plane inside a pool basin. */
export const WADE_DEPTH = 0.25;

/* ------------------------------------------------------------------ */
/* Key-light shadow rig (the sun is the one shadow caster)              */
/* ------------------------------------------------------------------ */

/** Key-light offset from the player. The light + its shadow camera follow
 *  the player (the target tracks the player on the ground plane), so
 *  shadows exist down the whole streaming corridor and inside every space;
 *  the direction stays fixed southeast → northwest in the repo's +Z-north
 *  coordinates, lighting the room from the same side as the RTS view. */
export const SUN_OFFSET = { x: 8, y: 14, z: -6 };
/** PCF shadow-map resolution for the key light (three 0.185 runs
 *  PCFShadowMap — PCFSoft was deprecated and is silently rewritten to
 *  PCF, so the canvas asks for "percentage" to match what ships). */
export const SUN_SHADOW_MAP_SIZE = 2048;
/** Ortho shadow-camera half-extent (m) — covers the visible diorama
 *  (view half-width ≈ 22 m at 1080p / zoom 44, B.12's closer camera) with
 *  margin. Derived from the view width, not left generous: a tighter
 *  frustum is better shadow texel density on the same 2048² map. Inside a
 *  scaled room the integrator multiplies this by the camera's zoom
 *  pull-back (up to ROOM_ZOOM_MAX_PULLBACK) so the frustum keeps covering
 *  the widened view; shadow texel density drops by the same factor. */
export const SUN_SHADOW_EXTENT = 24;
export const SUN_SHADOW_NEAR = 1;
export const SUN_SHADOW_FAR = 60;
/** Acne guards: small negative depth bias plus a normal offset that suits
 *  the hotel's box-built geometry. */
export const SUN_SHADOW_BIAS = -0.0003;
export const SUN_SHADOW_NORMAL_BIAS = 0.02;

/* ------------------------------------------------------------------ */
/* IBL — one scene-wide Environment of Lightformer cards (no HDRI)      */
/*                                                                      */
/* RETIRED from the game in the matte overhaul: game-canvas no longer   */
/* mounts an <Environment>; the sun + lifted ambient shape everything.  */
/* Kept here ONLY because playground-scene.tsx (the material testbed,   */
/* outside this pass) still builds its own Environment from these.      */
/* ------------------------------------------------------------------ */

/** Soft environment fill and the reflection budget every PBR material
 *  shares. Game-unused since the matte overhaul (no live <Environment> in
 *  game-canvas); the playground testbed still reads it. */
export const ENV_INTENSITY = 0.24;
/** Env cube-map resolution; the map is a few broad emissive cards, so
 *  256 px is plenty and cheap. */
export const ENV_RESOLUTION = 256;

/** One emissive card baked into the environment map. */
export interface EnvFormerSpec {
  form: "rect" | "circle";
  color: string;
  intensity: number;
  position: readonly [number, number, number];
  rotation: readonly [number, number, number];
  scale: readonly [number, number, number];
}

/** The light cards: a broad soft overhead, two cool fluorescent strips
 *  (the backrooms register — steady, never flickering per the doc's
 *  anti-pattern list), one warm side card, and one small red accent
 *  (Control-style — reflective materials need something worth
 *  reflecting). Deliberately few and broad: IBL fill, not a photostudio. */
export const ENV_FORMERS: readonly EnvFormerSpec[] = [
  {
    form: "rect",
    color: "#f2efe6",
    intensity: 1,
    position: [0, 5, 0],
    rotation: [-Math.PI / 2, 0, 0],
    scale: [9, 9, 1],
  },
  {
    form: "rect",
    color: "#dcebf2",
    intensity: 2.0,
    position: [-3, 4.6, -1],
    rotation: [-Math.PI / 2, 0, 0],
    scale: [7, 0.4, 1],
  },
  {
    form: "rect",
    color: "#dcebf2",
    intensity: 2.0,
    position: [3, 4.6, 1],
    rotation: [-Math.PI / 2, 0, 0],
    scale: [7, 0.4, 1],
  },
  {
    form: "rect",
    color: "#ffd9a0",
    intensity: 1.0,
    position: [-5, 2, 3],
    rotation: [0, Math.PI / 2, 0],
    scale: [4, 2, 1],
  },
  {
    form: "rect",
    color: "#e8543f",
    intensity: 1.5,
    position: [4, 1.2, -4],
    rotation: [0, -Math.PI / 3, 0],
    scale: [1.6, 1.6, 1],
  },
];

/* ------------------------------------------------------------------ */
/* Stage backdrop — RETIRED from the game (matte overhaul)              */
/*                                                                      */
/* The game no longer renders the radial pool disc (it was an all-over  */
/* opacity veil); the void/background color lerp is the only mood       */
/* driver. Only the three constants the playground testbed still        */
/* consumes remain here.                                                */
/* ------------------------------------------------------------------ */

/** Vertical drop (m) of the stage plane below the floor (playground
 *  testbed only — the game canvas mounts no stage). */
export const STAGE_BACKDROP_Y = -30;
export const STAGE_BACKDROP_RADIUS = 150;
/** How far the pool color lifts the background toward white (playground
 *  testbed only). */
export const STAGE_BACKDROP_LIFT = 0.08;

/* ------------------------------------------------------------------ */
/* Post-processing chain (game: N8AO only)                              */
/* ------------------------------------------------------------------ */

/** MSAA samples for the composer's render target (WebGL2); the package
 *  default of 8 is wasted at dpr 2 on a mid-range laptop. */
export const POST_MSAA_SAMPLES = 4;
/** N8AO (half-res, performance quality) — screen-space contact shading,
 *  the game's only live post effect in the matte overhaul: it grounds
 *  furniture and walls gently (intensity 0.45, radius 0.7) without any
 *  veil or frame-edge darkening. Unlike distance fog it is
 *  camera-distance independent, so it cannot wash the whole room into a
 *  veil from the 45° camera 23 m up. */
export const AO_INTENSITY = 0.45;
export const AO_RADIUS = 0.7;
export const AO_DISTANCE_FALLOFF = 0.8;

/** Bloom + Vignette — RETIRED from the game in the matte overhaul (no
 *  blown light blobs, no frame-edge darkening). Kept ONLY because
 *  playground-scene.tsx still wires them into its own composer. */
export const BLOOM_INTENSITY = 0.22;
export const BLOOM_LUMINANCE_THRESHOLD = 1.0;
export const BLOOM_LUMINANCE_SMOOTHING = 0.25;
export const VIGNETTE_OFFSET = 0.35;
export const VIGNETTE_DARKNESS = 0.18;

/** Door grab distance when resolving which space a wall crossing enters. */
export const DOOR_GRAB_DIST = 2.5;
/** Room prewarm radius (responsiveness): while the player walks the
 *  corridor within this distance of a door and no space is active, the
 *  door's room is mounted with its root group visible=false (it draws
 *  nothing and lights nothing) and the scene's shader programs are
 *  precompiled with staged gl.compile calls (LightConfigCompiler) — the
 *  mount frame's measured ~1 s compile storm (plus the React/geometry
 *  construction) happens during the approach, so crossing the threshold
 *  only flips the root visible and starts the crossfade. At 4 m/s this
 *  gives ~2 s of head start along the wall; a walk-by that never enters
 *  pays one hidden mount and an unmount, never a visible stall. */
export const ROOM_PREWARM_DIST = 9;
/** HUD prompt radius around a door. */
export const HUD_DIST = 1.8;

/** Strand-door wormhole (doc 附录 B.11): how far past the destination
 *  door's wall plane the player materializes, on the door axis — inside
 *  the room and clear of the doorway hysteresis band, so the room
 *  condenses around them and the corridor never appears. */
export const STRAND_DOOR_ARRIVAL_INSET = 1;

/** Player spawn: lobby floor, clear of the desk and armchairs. */
export const SPAWN = { x: 6, z: 0 };

/* ------------------------------------------------------------------ */
/* Biome-skin render inputs (v0.12 P3) — the pure resolver lane:      */
/* skin DATA (lib/game/skins.ts) → the plain values the renderer      */
/* consumes. Every resolver answers null (or the exact legacy         */
/* constant) for skin === null, so each call site can keep its        */
/* legacy expression behind a `??` and the default path stays         */
/* pixel-for-pixel today. Pure: no three.js, no React.                */
/* ------------------------------------------------------------------ */

/** Slot 1 — the floor albedo for the current theme. null = the palette
 *  path (callers keep their legacy palette expression — zero change). */
export function skinFloorHex(skin: BiomeSkin | null, night: boolean): string | null {
  if (!skin) return null;
  return night ? skin.floor.colors.night : skin.floor.colors.day;
}

/** Slot 2 — the wall surface colour for the current theme. Same null
 *  convention as skinFloorHex. */
export function skinWallHex(skin: BiomeSkin | null, night: boolean): string | null {
  if (!skin) return null;
  return night ? skin.wall.colors.night : skin.wall.colors.day;
}

/** Slot 2 — THE TRANSPARENCY BUDGET at the renderer's gate (§5): alpha
 *  comes back ONLY for a glass / water-wall kind that actually declared
 *  an opacity < 1; every other kind answers null and the caller's
 *  material stays opaque — the renderer never widens what the data
 *  allowed (skins.test.ts audits the catalogue; this refuses anyway). */
export function skinWallAlpha(skin: BiomeSkin | null): {
  transparent: true;
  opacity: number;
} | null {
  if (!skin) return null;
  const opacity = skin.wall.opacity ?? 1;
  if (opacity >= 1) return null;
  if (!(ALPHA_WALL_KINDS as readonly string[]).includes(skin.wall.kind)) {
    return null;
  }
  return { transparent: true, opacity };
}

/** Slot 4 — the window-view bake inputs: the skin's DAY colours (the
 *  night state is applied as the view plane's tint — the
 *  WINDOW_VIEW_NIGHT_* law) plus the silhouette mix the bake layers.
 *  null = the palette's own four colours, no silhouette option. */
export function skinWindowBake(skin: BiomeSkin | null): {
  sky: string;
  fog: string;
  ground: string;
  sunColor: string;
  silhouette: SkinSilhouette;
} | null {
  if (!skin) return null;
  return {
    sky: skin.window.day.sky,
    fog: skin.window.day.fog,
    ground: skin.window.day.ground,
    sunColor: skin.window.day.sun,
    silhouette: skin.window.silhouette,
  };
}

/** Slot 4, night — the view plane's tint hex: the skin's own night haze
 *  (its world melts into its night fog at night). null = the legacy
 *  WINDOW_VIEW_NIGHT_TINT constant. */
export function skinWindowNightTintHex(skin: BiomeSkin | null): string | null {
  return skin ? skin.window.night.fog : null;
}

/** Slot 5 — the far-field colour the room melts into. The integrator's
 *  background consumes this when that lane hooks it; today the room's
 *  own apron reads it (skinSkirtApronHex). null = palette.fog. */
export function skinFogHex(skin: BiomeSkin | null, night: boolean): string | null {
  if (!skin) return null;
  return night ? skin.fog.night : skin.fog.day;
}

/** Slot 5 — the apron's reach: fog density multiplies the grounding
 *  skirt's overhang — the only "fog falloff" this fog-less renderer
 *  has, the skirt IS the mist band past the walls. 1 on the default
 *  path (×1 is exact, so the legacy overhang math is untouched). */
export function skinSkirtOverhangScale(skin: BiomeSkin | null): number {
  return skin ? skin.fog.density : 1;
}

/** Slot 5 — how the apron reads against the far field (§3's 远景读法):
 *  the darkening factor the skirt colour takes per horizon kind. The
 *  legacy factor 0.62 is soft-hills' entry — the default path's exact
 *  value. Haze horizons keep the apron close to the fog colour (low
 *  contrast reads as depth); clear depth sits it darker and crisper. */
export const SKIN_APRON_DARKEN: Record<SkinHorizon, number> = {
  "soft-hills": 0.62,
  "sand-haze": 0.78,
  "light-shafts": 0.68,
  "wet-mist": 0.8,
  "clear-depth": 0.5,
};

/** Slot 5 — the apron's base colour: the skin's own FOG (the far field
 *  runs right up to the room's feet — haze horizon, wet mist, clear
 *  depth). null = palette.ground (the legacy apron base). */
export function skinSkirtApronHex(skin: BiomeSkin | null, night: boolean): string | null {
  return skinFogHex(skin, night);
}

/** Slot 1 walk — the wade multiplier on the in-room walk speed (dry
 *  floors and the whole default path answer 1, an exact ×1). Pure in
 *  the slice id (A6): same slice, same speed, any machine. */
export function skinWalkSpeedScale(sliceId: string): number {
  return skinForSlice(sliceId)?.floor.speed ?? 1;
}
