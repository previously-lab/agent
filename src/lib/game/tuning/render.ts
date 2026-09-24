/**
 * Renderer tuning — every visual constant the integrator
 * (src/components/game/game-canvas.tsx) consumes: the fixed camera, scene
 * mood colors, the key/fill/ambient lighting hierarchy (sun base levels,
 * shadow rig, IBL environment cards), the post-processing chain (bloom,
 * N8AO, vignette), atmosphere lerp, player avatar colors and motion
 * rates, wade depth, interaction distances, and spawn. The water plane
 * height itself is shared with the room renderer and lives in ./room
 * (WATER_Y). Pure data — no three.js, no React.
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

export const PLAYER_BODY = "#e8935c"; // warm accent
export const PLAYER_HEAD = "#f4d3ae";
export const SUN_BASE_COLOR = "#fff4e0";
/** Key-light base level. The sun is the ONE strong, shadow-casting light
 *  that pools (doc §1 A3). 2.5 (measured, v0.11 shadow fix): with the fill
 *  levels below (ENV_INTENSITY 0.12, ambient floors ~0.04–0.09), a sunlit
 *  interior floor lands at ~135/255 display luminance while its shadowed
 *  floor sits at ~20–90 — a cast shadow reads clearly at every palette.
 *  History: 0.65 under the old ambient-dominant model; 1.5 in the first
 *  key/fill/ambient pass, which measured as INVISIBLE shadows — ambient +
 *  IBL fill alone lit floors to ~112/255 and AgX's shoulder compressed the
 *  sun's added term to a ~13/255 step, so removing it (a shadow) was a ~5%
 *  dip. The key must dominate the fill by a wide margin for shadows to
 *  exist perceptually, not just mathematically. Inside a space this is
 *  multiplied by palette.sunIntensity — and, per B.13, by
 *  ROOM_INTERIOR_SUN_FILL in interior rooms, where the key moves to the
 *  room's own fixtures and this light is only the fill/studio overall. */
export const SUN_BASE_INTENSITY = 2.5;
/** Ambient floor in the corridor; inside a space the palette's own
 *  `ambient` (scaled by SPACE_AMBIENT_SCALE) takes over. Kept very low on
 *  purpose: fill is the IBL environment's job, and a high ambient is
 *  exactly the directionless flat light the doc forbids — and the fill
 *  level is what a cast shadow drops to, so every point of ambient
 *  directly erases shadow contrast (measured: ambient 0.15 + env 0.45 put
 *  the corridor's no-sun floor at ~84/255, swallowing the sun's ~13-unit
 *  contribution). */
export const CORRIDOR_AMBIENT = 0.06;
/** In-room directional level for INTERIOR rooms, as a fraction of the
 *  palette-authored sun term (doc B.13, user 2026-09-18 — "everything is
 *  indoors": an interior's key must come from its own fixtures, so the
 *  sun drops to a FILL here; outdoor-class sets keep it at 1 as the
 *  soundstage's overall key, justified by the clerestory band). It stays
 *  shadow-casting at the reduced level — the fill still grounds furniture
 *  with a soft shadow everywhere, while the window's spot is the room's
 *  true key with the strong motivated shadows. 0.32 keeps the measured
 *  shadow separation comfortably open (the fill's shadow-to-lit step is
 *  proportional, and the key adds on top of the lit side only) while the
 *  lamp and window visibly own the room. */
export const ROOM_INTERIOR_SUN_FILL = 0.32;
/** Space palettes still carry ambient values (0.28–0.6) authored for the
 *  old ambient-dominant model; scale them into the same key-dominant
 *  hierarchy here (the palette data itself is owned by another lane). 0.15
 *  lands the in-room ambient floor at 0.04–0.09 — the level the shadow-
 *  visibility measurements (see SUN_BASE_INTENSITY) were taken at. */
export const SPACE_AMBIENT_SCALE = 0.15;
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
 *  the light DIRECTION stays the original (8, 14, 4) → origin, so surface
 *  response is unchanged. */
export const SUN_OFFSET = { x: 8, y: 14, z: 4 };
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
/* ------------------------------------------------------------------ */

/** scene.environmentIntensity — the soft-fill half of the hierarchy and
 *  the reflection budget every PBR material in the game shares. 0.12
 *  (measured, v0.11 shadow fix): the five Lightformer cards carry their
 *  own intensities (1–2.5), so even 0.45 of them flooded every floor to
 *  ~112/255 display luminance with the sun off — the key light only added
 *  ~13 more after AgX compression and cast shadows (~5% dips) were
 *  invisible. At 0.12 the no-sun floor sits low enough that the sun owns
 *  the room and shadows ground the furniture (doc §2 req 1). */
export const ENV_INTENSITY = 0.12;
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
    intensity: 2.5,
    position: [-3, 4.6, -1],
    rotation: [-Math.PI / 2, 0, 0],
    scale: [7, 0.4, 1],
  },
  {
    form: "rect",
    color: "#dcebf2",
    intensity: 2.5,
    position: [3, 4.6, 1],
    rotation: [-Math.PI / 2, 0, 0],
    scale: [7, 0.4, 1],
  },
  {
    form: "rect",
    color: "#ffd9a0",
    intensity: 1.2,
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
/* Stage backdrop — the diorama sits on a pool, not in a void           */
/* ------------------------------------------------------------------ */

/** Master switch: set to false to revert to the flat void background
 *  (game-canvas.tsx mounts the stage plane only while this is true). */
export const STAGE_BACKDROP_ENABLED = true;
/** Vertical drop (m) of the stage plane below the corridor floor. Deep
 *  enough to stay clear of every room's displaced terrain (rolling
 *  amplitude is ~1.2 m; pool basins wade, never dig), far enough that the
 *  radial falloff reads as depth rather than as a floor at the model's
 *  feet. */
export const STAGE_BACKDROP_Y = -30;
/** Radial falloff (m): the pool is at full strength inside POOL_RADIUS
 *  around the player and fades to fully transparent at BACKDROP_RADIUS,
 *  so the model reads as sitting on a soft pool of its own atmosphere —
 *  never on a hard-edged disc. */
export const STAGE_POOL_RADIUS = 26;
export const STAGE_BACKDROP_RADIUS = 150;
/** Peak opacity at the pool's center. Kept well under 1: the void color
 *  keeps lerping through underneath, so the background lerp stays the
 *  single driver of the mood. */
export const STAGE_BACKDROP_OPACITY = 0.6;
/** How far the pool color lifts the CURRENT lerped background color
 *  toward white (0 = background, 1 = white). Derived per frame from the
 *  same resolveAtmosphere target as the scene background, so entering a
 *  room re-tints the stage with the room's palette exactly like the
 *  void — a shadow of the room's own hue, never a fixed gray. */
export const STAGE_BACKDROP_LIFT = 0.08;

/* ------------------------------------------------------------------ */
/* Post-processing chain                                                */
/* ------------------------------------------------------------------ */

/** MSAA samples for the composer's render target (WebGL2); the package
 *  default of 8 is wasted at dpr 2 on a mid-range laptop. */
export const POST_MSAA_SAMPLES = 4;
/** Bloom — the highest-impact effect for this look. Threshold 1.0 keeps
 *  it on emissive fixtures and the sun's hot pools, off lit walls, so the
 *  frame does not turn milky. */
export const BLOOM_INTENSITY = 0.4;
export const BLOOM_LUMINANCE_THRESHOLD = 1.0;
export const BLOOM_LUMINANCE_SMOOTHING = 0.25;
/** N8AO (half-res, performance quality) — screen-space contact shading;
 *  the first half of the depth cue that replaced scene fog. Unlike
 *  distance fog it is camera-distance independent, so it cannot wash the
 *  whole room into a veil from the 45° camera 23 m up. */
export const AO_INTENSITY = 1.5;
export const AO_RADIUS = 1.0;
export const AO_DISTANCE_FALLOFF = 1.0;
/** Vignette — mild frame-edge falloff; the second half of the depth cue.
 *  Screen-space like AO, so it shares the same safety argument. */
export const VIGNETTE_OFFSET = 0.35;
export const VIGNETTE_DARKNESS = 0.4;

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
