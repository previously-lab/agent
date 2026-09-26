"use client";

/**
 * GameCanvas — the integrator: canvas, camera, player, door manager, HUD.
 *
 * WHAT IT IS. The owner of the R3F canvas that stitches the hotel together:
 * the corridor diorama (corridor.tsx), the space behind one open door
 * (space.tsx), the walkable player avatar, the fixed Red-Alert-style camera,
 * the scene-wide lighting, and the door prompt HUD. Corridor and space
 * modules stay render-pure; every cross-module decision (where the player
 * may stand, which space is active, what the sky looks like) happens here.
 * The movement clamps themselves live in src/lib/game/clamps.ts (pure,
 * unit-tested); this file only decides when to apply them.
 *
 * CAMERA. Fixed 45° top-down: an orthographic camera parked at a (−12, +16,
 * +12) offset from the player, looking back at them — the corridor runs
 * top-right→bottom-left on screen. It never rotates; useFrame lerps the
 * follow point (factor 1 − e^(−6·dt)), so the view glides instead of
 * snapping — except on a hotel hop (page/return/strand door), whose
 * cross-hotel teleport snaps the focus on the spot
 * (STRAND_TELEPORT_CAMERA_SNAP, tuning/render.ts).
 * The zoom TARGET is CAMERA_ZOOM (44 — pulled in ~29% per doc B.12) in the
 * corridor and eases down
 * by clamp(S, 1, ∞)^ROOM_ZOOM_SCALE_EXP (capped at ~3× pull-back) inside a
 * scaled room, so a colossal room stays legible as a room instead of
 * reading as a local patch — the dollhouse stays readable (doc §1 A4).
 *
 * MOVEMENT & CLAMPS. WASD + arrow keys move the player on the XZ plane at
 * 4 m/s in the corridor, delta-time corrected, screen-relative (screen-up
 * is world (+x, −z), screen-right (+x, +z) for this camera — verified
 * against the lookAt direction). Inside a space the speed is boosted by
 * clamp(S, 1, ∞)^ROOM_SPEED_SCALE_EXP so a colossal room feels immense
 * without wasting the player's time. The door manager alternates
 * clampToCorridor and clampToSpace on a hysteresis band around the wall
 * plane (|z| 4.8–5.2 with the ten-meter corridor). All space consumers —
 * the clamp, the terrain/wade height, the water side — read the SCALED
 * recipe view (scaledRecipeFor, lib/game/room-plan.ts): the renderer builds
 * the room at scale, so the physics must measure it at the same scale.
 *
 * CONTAINMENT INVARIANT. While a space is active, its corridor wall is
 * solid in both directions everywhere except the door gap: clampToSpace
 * only relaxes the wall-side bound inside |x − door.x| < GAP_HALF, and
 * space mode releases the player only when they are back inside the
 * corridor band AND within CLEAR_HALF of the door's x. If the player ever
 * ends up in the corridor band outside that zone with a space active
 * (shouldn't happen with correct clamps), they are re-clamped into the
 * space, not released.
 *
 * TERRAIN. While a space is active the avatar's Y snaps to the shared
 * heightfield (src/lib/game/terrain.ts — the same field space.tsx displaces
 * its ground by), lerped at ~10/s; in the corridor it lerps back to 0. Pool
 * basins are waded, not walked: inside the water square the target is
 * clamped to a fixed depth below the water plane.
 *
 * DOOR MANAGER. One space at a time. Crossing a wall plane (|z| > WALL_OUT)
 * resolves the containing door via nearestDoor (maxDist 2.5) and mounts its
 * SpaceScene with compileSpaceRecipe(sliceId) plus the fixture's archetype
 * override; re-entering the corridor band through the door gap (|z| < WALL_IN
 * and |x − door.x| < CLEAR_HALF) unmounts it. Unmount is the memory model:
 * exactly one window is materialized per hotel, at most one space exists,
 * and the corridor dims
 * while a space holds the player. Both sides of the door crossfade instead
 * of popping: the room condenses out of its shadow on entry and dissolves
 * back on exit (SPACE_FADE_S), while the corridor dims/undims on its own
 * lerp — the door frame is the only constant between the two worlds.
 *
 * ATMOSPHERE & LIGHTING. Background and the directional sun lerp (factor 1 −
 * e^(−2.5·dt)) between two target moods defined once in resolveAtmosphere:
 * the corridor (the void color) and the active space's palette — inside a
 * space the background becomes the room's own shadow (the palette's
 * atmosphere fog), so its far edge melts seamlessly. The lighting model is
 * a key/fill/ambient hierarchy (v0.11 P2), re-anchored by B.13 「摄影棚论」
 * (this world has no outdoors): the directional "sun" is the STUDIO key —
 * full strength in the corridor and in outdoor-class sets (nature/wonder/
 * hybrid, where the room's skylight is its visible source), dropped to
 * ROOM_INTERIOR_SUN_FILL inside interior rooms, whose key is the window
 * spot mounted by space.tsx. It is always the one broad shadow caster (its
 * shadow camera follows the player so the whole streaming corridor and
 * every space stay inside the frustum); soft FILL comes from one scene-wide
 * <Environment> of Lightformer cards (IBL, no HDRI) that also gives every
 * PBR material something to reflect; the AMBIENT term is a deliberately low
 * floor so light pools instead of filling evenly (doc §1 A3). Tone mapping
 * is AgX, not the ACES default — saturated accent colors clip under ACES.
 *
 * DEPTH CUE. There is NO scene fog
 * anywhere: with the camera ~23m above the player, every fog band that
 * could sell depth also washed the whole visible room into the fog color
 * (commits 9116243/09c757b/d9edf93 — do not re-add). Depth is carried by
 * things that are camera-distance INDEPENDENT instead: the background
 * color, the stage backdrop disc the diorama sits on (plain geometry at a
 * fixed depth — no distance term), and
 * the post chain — N8AO
 * (screen-space contact shading) plus a mild Vignette (frame-edge
 * falloff), both of which darken by geometry and screen position, never
 * by distance from the camera, so they cannot reproduce the
 * translucent-room bug. Bloom (threshold 1.0) glows only emissive
 * fixtures and the sun's hot pools.
 *
 * HOTELS (HD2/HD3/HD4). The world is a chain of HOTELS: one per timeline
 * (the core timeline plus one per strand), each hotel showing ONE window
 * of its timeline — CHUNK_DOORS bays × two walls — at a time. The
 * integrator's `location` state is the (timelineId, windowIndex) pair;
 * the corridor renderer re-bases every hotel into the same local frame
 * (lobby at x ∈ [0, LOBBY_LENGTH), corridor at negative x), so a hotel
 * switch is a data swap plus a teleport, never new geometry math. The
 * doors that move the player between hotels: the PAGE DOOR at the
 * corridor's far (west) end (same timeline, next-older window) — out the
 * west end, in through the next lobby's EAST wall (§10.5 西出东进) — the
 * ARRIVAL DOOR on that east wall (back to the departure hotel's west
 * end), the RETURN DOORS in every lobby you arrived into — one per wall
 * the trips in came from (§10.5: a north-wall room's way back hangs on
 * the lobby's north wall, a south-wall room's on the south wall; each
 * door unwinds the newest trip of its own lateral — strand-door arrivals
 * land back inside the room they left) — and the strand doors below. The
 * oldest window's end wall carries no page door — the timeline simply
 * ends.
 *
 * STRAND DOORS (doc 附录 B.11, HD4). A room grows one extra door per
 * strand passing through its slice, each leading to that strand's OWN
 * hotel (the window holding the destination slice — strand-doors.ts
 * resolves the destination). Crossing dissolves the current room on the
 * ordinary fade machinery, pushes the current hotel onto the navigation
 * stack (remembering the room and door the player left by), and lands the
 * player in the destination hotel's LOBBY — arrival is always in the
 * lobby (§10.2a), the return door hangs on the wall behind them. The
 * transition is a pure reducer (reduceStrandTransition below); this
 * file only feeds it events and executes its phases. The corridor door
 * remains the only way back out to the corridor — entrance semantics are
 * untouched.
 *
 * DETERMINISM. No randomness in this file at all — every generated thing the
 * player sees comes from corridor/space renderers fed by the seed module.
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { useFrame, useThree } from "@react-three/fiber";
import { Environment, Lightformer, OrthographicCamera } from "@react-three/drei";
import { Bloom, EffectComposer, N8AO, Vignette } from "@react-three/postprocessing";
import { useTranslations, useLocale } from "next-intl";
import { useReducedMotion } from "motion/react";
import { useTheme } from "@teispace/next-themes";
import type { JSX, MutableRefObject, ReactNode } from "react";
import { GAME_DEBUG } from "./debug";
import { useWorldScene } from "@/components/timeline-3d/world-slot";
import { AnchorHologram } from "@/lib/game/anchor-hologram";
import {
  LOBBY_TERMINAL_ANCHOR,
  LOBBY_TERMINAL_BLOCKER,
  roomTerminalFor,
  TERMINAL_D,
  TERMINAL_DEPART,
  TERMINAL_FLARE_MS,
  TERMINAL_REACH_LOBBY,
  TERMINAL_REACH_ROOM,
  type TerminalAnchor,
} from "@/lib/game/anchor";
import {
  WORLD_TRANSITION,
  hotelShotPose,
  type FollowPose,
} from "@/lib/timeline3d/world-transition";
import { CURSOR_HOOKS } from "@/lib/timeline3d/cursor";
import {
  LOBBY_LENGTH,
  LOBBY_SOUTH_REACH,
  WINDOW_SLICES,
  chunkBounds,
  doorPosition,
  materializedDoorXs,
  nearestDoor,
  type DoorRef,
  type Side,
} from "@/lib/game/hotel";
import {
  corridorLayoutFromDoors,
  windowCountForLayout,
  windowLayout,
  type CorridorLayout,
} from "@/lib/game/corridor-pitch";
import {
  CLEAR_HALF,
  CORRIDOR_Z_LIMIT,
  GAP_HALF,
  GAP_Z_LIMIT,
  LOBBY_CLEAR,
  WALL_IN,
  WALL_OUT,
  WALL_Z,
  clampToCorridor,
  clampToSpace,
  type CorridorEnd,
  type SeamWall,
} from "@/lib/game/clamps";
import { compositionForRecipe, seamPartitionsFor } from "@/lib/game/room-modules";
import { WORLD_SEED } from "@/lib/game/seed";
import { debugSliceIdWithoutSkin } from "@/lib/game/debug-slice";
import { compileSpaceRecipe } from "@/lib/game/space-recipe";
import type { ArchetypeId, SpaceRecipe } from "@/lib/game/space-types";
import {
  CORE_TIMELINE_ID,
  strandAccentFor,
  type StrandDestination,
} from "@/lib/game/strand-doors";
import {
  roomPlanFor,
  scaledRecipeFor,
  wallSegmentsFor,
  composeRoom,
  type RoomPlan,
  type ScaleNotation,
} from "@/lib/game/room-plan";
import {
  hostableWallsFor,
  placeRoomDoors,
  type RoomDoorPlacement,
} from "@/lib/game/room-doors";
import {
  doorAffordanceFor,
  templatePlanFor,
} from "@/lib/game/room-templates";
import { terrainHeight, waterRectFor, waterSideFor } from "@/lib/game/terrain";
import { Corridor, LOBBY_BLOCKERS, type CorridorDoor } from "./corridor";
import { SpaceScene, roomTemplateForDoorCount, MOUNT_TRACE, ROOM_ROOT } from "./space";
import {
  ARRIVAL_DOOR_CROSS_DEPTH,
  EAST_DOOR_PASS_DEPTH,
  HIDE_DELAY_MS,
  HOTEL_ACCENT_CORE,
  LOBBY_ARRIVAL_INSET,
  PAGE_DOOR_CROSS_DEPTH,
  RETURN_DOOR_SOUTH_CROSS_DEPTH,
  RETURN_DOOR_SOUTH_X,
  RETURN_DOOR_X,
  WEST_END_ARRIVAL_INSET,
} from "@/lib/game/tuning/hotel";
import {
  COLONNADE_BAY,
  PROP_SCALE_EXP,
  ROOM_WALL_THICKNESS,
  WATER_Y,
  roomLocalFor,
  roomOrientationFor,
} from "@/lib/game/tuning/room";
import {
  AO_DISTANCE_FALLOFF,
  AO_INTENSITY,
  AO_RADIUS,
  ATMOSPHERE_LERP_RATE,
  BOB_HEIGHT,
  BOB_RATE,
  BLOOM_INTENSITY,
  BLOOM_LUMINANCE_SMOOTHING,
  BLOOM_LUMINANCE_THRESHOLD,
  CAMERA_LERP_RATE,
  CAMERA_ZOOM,
  CAM_OFFSET,
  CORRIDOR_AMBIENT,
  DOOR_GRAB_DIST,
  ENV_FORMERS,
  ENV_INTENSITY,
  ENV_RESOLUTION,
  GROUND_LERP_RATE,
  HUD_DIST,
  PLAYER_BODY,
  PLAYER_HEAD,
  PLAYER_SPEED,
  POST_MSAA_SAMPLES,
  ROOM_INTERIOR_SUN_FILL,
  ROOM_PREWARM_DIST,
  ROOM_SPEED_SCALE_EXP,
  ROOM_ZOOM_MAX_PULLBACK,
  ROOM_ZOOM_SCALE_EXP,
  SCENE_COLORS,
  SPACE_AMBIENT_SCALE,
  SPAWN,
  STAGE_BACKDROP_ENABLED,
  STAGE_BACKDROP_LIFT,
  STAGE_BACKDROP_OPACITY,
  STAGE_BACKDROP_RADIUS,
  STAGE_BACKDROP_Y,
  STAGE_POOL_RADIUS,
  STRAND_DOOR_ARRIVAL_INSET,
  STRAND_TELEPORT_CAMERA_SNAP,
  SUN_BASE_COLOR,
  SUN_BASE_INTENSITY,
  SUN_OFFSET,
  SUN_SHADOW_BIAS,
  SUN_SHADOW_EXTENT,
  SUN_SHADOW_FAR,
  SUN_SHADOW_MAP_SIZE,
  SUN_SHADOW_NEAR,
  SUN_SHADOW_NORMAL_BIAS,
  TURN_LERP_RATE,
  VIGNETTE_DARKNESS,
  VIGNETTE_OFFSET,
  WADE_DEPTH,
  skinWalkSpeedScale,
} from "@/lib/game/tuning/render";

/* ------------------------------------------------------------------ */
/* Shared types & constants                                            */
/* ------------------------------------------------------------------ */

interface PlayerPos {
  x: number;
  z: number;
}

/** Last normalized move direction + whether the player is moving. */
interface Motion {
  x: number;
  z: number;
  moving: boolean;
}

/** The one space that may be mounted at a time. `recipe` is the authored
 *  recipe (palette, archetype); `scaledRecipe` is the same recipe with the
 *  room-language scale notation applied to its plan dims — the ONE scaled
 *  view (room-plan.ts) that the renderer, the movement clamp, and the
 *  avatar physics all share. `roomDoorCount` is the strand-door count the
 *  space was resolved with, FROZEN at the wall crossing (the data lane's
 *  pure derivation for the slice): the composition that sized scaledRecipe
 *  grew by it (§8.4), and freezing it here keeps the renderer and the
 *  clamp on one value for the whole visit — the room can never morph
 *  mid-stay when the strand lane resolves after the mount. */
interface ActiveSpace {
  door: DoorRef;
  recipe: SpaceRecipe;
  scaledRecipe: SpaceRecipe;
  scale: ScaleNotation;
  roomDoorCount: number;
}

/** Stand-in plan while no space is active — the space clamp never runs
 *  then, and rect is the plain box even for a stray call. */
const NO_ROOM_PLAN: RoomPlan = {
  id: "rect",
  width: 0,
  extent: 0,
  lSide: 1,
  stepZ: 0,
  columns: [],
};

/** Referentially stable empty seam list — no space active, or a room the
 *  catalogue serves without a composition (every non-interior class). */
const NO_ROOM_SEAMS: readonly SeamWall[] = [];

/** Referentially stable empty door list — the current hotel's list when a
 *  strand hotel is missing from `timelines` (the strand lane off, or a
 *  stale destination). Referential stability keeps the derived memos from
 *  re-running every render. */
const NO_TIMELINE_DOORS: readonly CorridorDoor[] = [];

type PlayerRef = MutableRefObject<PlayerPos>;

/** The anchor HUD payload (§13.1) — set while the player stands in reach
 *  of a terminal; wins over the door prompt in the Hud. `x`/`z`/`faceX`/
 *  `faceZ` are the terminal's world pose (the interaction point and the
 *  direction the terminal faces): the transition's scripted camera shot
 *  descends to it, so the thing the camera flies to is the thing the loop
 *  measured — the same A6 double-call-site discipline as the placement. */
interface AnchorHud {
  kind: "room" | "lobby";
  sliceId: string;
  label: string;
  x: number;
  z: number;
  faceX: number;
  faceZ: number;
}

/** Live player/atmosphere/fade state for probes — re-exported from the
 *  shared module (see debug.ts). */
export { GAME_DEBUG } from "./debug";

declare global {
  interface Window {
    /** Mount-cost trace (see MOUNT_TRACE in space.tsx) — probe mirror. */
    __gameMountTrace?: typeof MOUNT_TRACE;
  }
}

/** Clamp per-frame dt so a background tab can't tunnel the player through a wall. */
const MAX_DT = 0.05;

/**
 * Screen-relative key directions for the fixed camera at a (−12, +16, +12)
 * offset: screen-up (W) is world (+x, −z) — straight away from the camera —
 * and screen-right (D) is world (+x, +z). Derived from the lookAt
 * direction (forward (+x, −z)/√2, right = forward × up), not just the
 * offset signs.
 */
const KEY_DIRS: Record<string, readonly [number, number]> = {
  w: [Math.SQRT1_2, -Math.SQRT1_2],
  arrowup: [Math.SQRT1_2, -Math.SQRT1_2],
  s: [-Math.SQRT1_2, Math.SQRT1_2],
  arrowdown: [-Math.SQRT1_2, Math.SQRT1_2],
  a: [-Math.SQRT1_2, -Math.SQRT1_2],
  arrowleft: [-Math.SQRT1_2, -Math.SQRT1_2],
  d: [Math.SQRT1_2, Math.SQRT1_2],
  arrowright: [Math.SQRT1_2, Math.SQRT1_2],
};

const HANDLED_KEYS = new Set(Object.keys(KEY_DIRS));

/* ------------------------------------------------------------------ */
/* Pure helpers (no React)                                             */
/* ------------------------------------------------------------------ */

/** Shortest-path angle lerp — rotation.y never takes the long way round. */
function lerpAngle(a: number, b: number, t: number): number {
  const d = Math.atan2(Math.sin(b - a), Math.cos(b - a));
  return a + d * t;
}

/** Normalized move vector for the pressed keys (diagonals stay unit length). */
function moveVectorFromKeys(keys: ReadonlySet<string>): { x: number; z: number } {
  let x = 0;
  let z = 0;
  for (const key of keys) {
    const dir = KEY_DIRS[key];
    if (dir) {
      x += dir[0];
      z += dir[1];
    }
  }
  const len = Math.hypot(x, z);
  if (len > 1) {
    x /= len;
    z /= len;
  }
  return { x, z };
}

/** In-room speed factor: clamp(S, 1, ∞)^EXP — miniature rooms keep corridor
 *  speed; colossal rooms get a sub-linear boost so crossing one is a walk,
 *  not a commute. */
function roomSpeedFactor(scaleFactor: number): number {
  return Math.pow(Math.max(1, scaleFactor), ROOM_SPEED_SCALE_EXP);
}

/** Ortho zoom pull-back for a scaled room: clamp(S, 1, ∞)^EXP, hard-capped
 *  so the view never widens past ~ROOM_ZOOM_MAX_PULLBACK× (doc §1 A4). */
function roomZoomPullback(scaleFactor: number): number {
  return Math.min(
    ROOM_ZOOM_MAX_PULLBACK,
    Math.pow(Math.max(1, scaleFactor), ROOM_ZOOM_SCALE_EXP),
  );
}

/**
 * Avatar ground target at a world position inside an active space: the
 * shared terrainHeight in the space's local frame, with pool basins waded
 * at a fixed depth instead of walked on the floor. The terrain and the
 * water rectangle read the SCALED recipe view — the same dims space.tsx
 * displaced the ground by — so the avatar's feet agree with the rendered
 * floor at any room scale. The local transform is roomLocalFor — the same
 * shared derivation SpaceScene's root group uses (tuning/room.ts): north
 * doors sit at rotation 0 → local = world − door; south doors rotate π
 * about Y → local = −(world − door).
 */
function groundTargetY(
  space: ActiveSpace,
  waterSide: number,
  x: number,
  z: number,
): number {
  const { door, scaledRecipe } = space;
  const { lx, lz } = roomLocalFor(door, x, z);
  const terrainY = terrainHeight(scaledRecipe, lx, lz);
  const waterHalf = waterSide / 2;
  if (
    waterHalf > 0 &&
    terrainY < WATER_Y &&
    Math.abs(lx) <= waterHalf &&
    Math.abs(lz - scaledRecipe.size.extent / 2) <= waterHalf
  ) {
    return Math.max(terrainY, WATER_Y - WADE_DEPTH);
  }
  return terrainY;
}

/** The atmosphere's target mood — one place defines both states. */
interface AtmosphereTargets {
  background: THREE.Color;
  sunColor: THREE.Color;
  sunIntensity: number;
  ambient: number;
}

/**
 * Resolve the target atmosphere for the current state into `out` (no
 * per-frame allocation): the corridor mood in the active theme's void
 * color, or the active space's palette — background becomes the room's own
 * shadow, the sun tints to palette.sunColor, and the ambient floor uses
 * the palette's own value scaled down into the key/fill/ambient hierarchy
 * (SPACE_AMBIENT_SCALE; the palette values were authored for the old
 * ambient-dominant model, and a space's lighting is seed-fixed, not part
 * of the app dark mode). No fog targets exist: scene fog has been removed
 * entirely (the camera geometry made any usable band wash the whole room).
 */
function resolveAtmosphere(
  space: ActiveSpace | null,
  dark: boolean,
  out: AtmosphereTargets,
): AtmosphereTargets {
  if (space !== null) {
    const { palette } = space.recipe;
    // Background uses the recipe's atmosphere fog: a deep, hue-faithful
    // shadow of the room's own palette (see atmosphereFog in space-recipe),
    // so the room's far edge melts seamlessly into its own shadow. There
    // is no scene fog to target (removed — see Atmosphere).
    out.background.set(palette.fog);
    out.sunColor.set(palette.sunColor);
    // B.13 摄影棚论 (user 2026-09-18): nothing here is lit by a sun
    // overhead. INTERIOR rooms get the directional at FILL level only —
    // the key moves to the room's own fixtures (the window's spot carries
    // the strong shadows) — while outdoor-class sets keep it at full
    // strength as the soundstage's overall key, justified by the visible
    // skylight. The fill keeps casting: furniture stays grounded by a
    // soft shadow everywhere the key's pool does not reach.
    out.sunIntensity =
      SUN_BASE_INTENSITY *
      palette.sunIntensity *
      (space.recipe.worldClass === "interior" ? ROOM_INTERIOR_SUN_FILL : 1);
    out.ambient = palette.ambient * SPACE_AMBIENT_SCALE;
  } else {
    out.background.set(SCENE_COLORS[dark ? "night" : "day"]);
    out.sunColor.set(SUN_BASE_COLOR);
    out.sunIntensity = SUN_BASE_INTENSITY;
    out.ambient = CORRIDOR_AMBIENT;
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Strand-door hotel hop (doc 附录 B.11, HD4) — pure state machine      */
/* ------------------------------------------------------------------ */

/**
 * One hotel: a timeline at one window — the integrator's location state
 * and the strand doors' destination shape (HD4). The core timeline's id
 * is CORE_TIMELINE_ID ("core"); every other hotel's id is its strand
 * name.
 */
export interface HotelRef {
  readonly timelineId: string;
  readonly windowIndex: number;
}

/**
 * One strand door in a room, pre-resolved by the data lane
 * (lib/game/strand-doors.ts) and handed to the canvas keyed by sliceId.
 * `destination` is the HOTEL the door leads to (the destination slice's
 * own strand, at the window holding that slice) — `lit: false` or a null
 * destination means the strand has no chapter to lead to (B.4: the door
 * is a promise, not a passage). The list carries no positions: where a
 * door hangs on the walls is staging, owned by the room renderer.
 */
export interface StrandDoorSpec {
  readonly key: string;
  readonly label: string;
  readonly lit: boolean;
  readonly destination: StrandDestination | null;
  /**
   * Every strand this door represents (the data lane's merged group,
   * primary first) — OPTIONAL at the type level because the spec only
   * requires the door fields; the data lane hands the full `RoomDoor`
   * through (a structural superset), so this is present at runtime and
   * the anchor hologram braids one thread per entry.
   */
  readonly strands?: readonly string[];
}

/**
 * Strand-door transition phases — a strand door hops between two HOTELS,
 * so there is no room-local crossing geometry at all:
 *
 *   idle ──cross (valid)──▶ fadingOut ──fadedOut──▶ mounting ──arrived──▶ idle
 *     ▲                        │                      │
 *     │                        └─ cross: DROPPED       └─ cross: DROPPED
 *     └─ invalid cross: DROPPED      (the latch — one crossing at a time)
 *
 * idle: no crossing in flight. fadingOut: latched — the current room is
 * dissolving on the ordinary fade machinery (activeSpace → null flips
 * SpaceScene to fade="out"); movement and the corridor door manager are
 * suspended so the player cannot wander the void and the half-dissolved
 * room cannot re-engage. mounting: the fade completed; the canvas has
 * pushed the current hotel onto the navigation stack, switched the
 * location to the destination hotel, and landed the player in its LOBBY
 * (§10.2a: arrival is always in the lobby). `arrived` releases the latch
 * — the player is in an ordinary corridor again and the door manager owns
 * them. `abort` (the crossing cannot complete at fade completion) drops
 * the latch so the current room can fade back in.
 */
export type StrandTransition =
  | { readonly phase: "idle" }
  | { readonly phase: "fadingOut"; readonly key: string; readonly destination: HotelRef }
  | { readonly phase: "mounting"; readonly key: string; readonly destination: HotelRef };

export type StrandTransitionEvent =
  | {
      readonly type: "cross";
      readonly key: string;
      readonly lit: boolean;
      readonly destination: HotelRef | null;
      /** The hotel the player stands in; null = none (no room active). */
      readonly current: HotelRef | null;
    }
  | { readonly type: "fadedOut" }
  | { readonly type: "arrived" }
  | { readonly type: "abort" };

/**
 * The reducer. Trust nothing from geometry: a crossing latches only from
 * idle, only for a LIT door whose destination is a real hotel OTHER than
 * the one the player stands in; every other event/phase combination is a
 * no-op, so stale or double deliveries can never wedge the machine.
 */
export function reduceStrandTransition(
  state: StrandTransition,
  event: StrandTransitionEvent,
): StrandTransition {
  switch (event.type) {
    case "cross": {
      if (state.phase !== "idle") return state;
      const ok =
        event.lit &&
        event.destination !== null &&
        event.current !== null &&
        (event.destination.timelineId !== event.current.timelineId ||
          event.destination.windowIndex !== event.current.windowIndex);
      return ok
        ? { phase: "fadingOut", key: event.key, destination: event.destination }
        : state;
    }
    case "fadedOut":
      return state.phase === "fadingOut"
        ? { phase: "mounting", key: state.key, destination: state.destination }
        : state;
    case "arrived":
      return state.phase === "mounting" ? { phase: "idle" } : state;
    case "abort":
      return state.phase === "idle" ? state : { phase: "idle" };
  }
}

/**
 * One navigation-stack entry (HD3): the hotel to return to, and — for a
 * strand-door hop — the room and strand door the player left by, so the
 * lobby's return door can land them back INSIDE that room (§10.2a). A
 * page-door hop records `returnTo: null` — its way back is the lobby's
 * EAST arrival door, landing at the departure hotel's west end.
 *
 * `side` is the trip's DOOR (§10.5): for a strand-door hop, which corridor
 * wall the departed room's door hung on, so the lobby can hang the way back
 * on the matching wall (north-wall room → north return door, south-wall
 * room → south). Page-door and travel hops are east-west trips — out the
 * corridor's WEST end, in through the next lobby's EAST wall — so they
 * record "east" and their way back hangs on the lobby's east wall.
 */
export type TripSide = Side | "east";

export interface NavEntry {
  readonly hotel: HotelRef;
  readonly returnTo: { readonly sliceId: string; readonly key: string } | null;
  readonly side: TripSide;
}

/** Which lobby walls carry a door back (§10.5): one per side the stack's
 *  trips came in from — the same side never hangs two doors, and several
 *  walls carry one when the stack holds trips from several sides. */
export function returnDoorSides(
  stack: readonly NavEntry[],
): { north: boolean; south: boolean; east: boolean } {
  let north = false;
  let south = false;
  let east = false;
  for (const entry of stack) {
    if (entry.side === "north") north = true;
    else if (entry.side === "south") south = true;
    else east = true;
  }
  return { north, south, east };
}

/**
 * Walking through one wall's door: split off the stack down to and
 * including the NEWEST trip of that side — the entry the door returns
 * to, and the stack as it becomes (everything pushed after that trip is
 * left behind: the player walked straight back past those hotels without
 * unwinding them). Null when no trip of that side exists (the door is not
 * hung then, so this never fires from geometry).
 */
export function splitReturnTrip(
  stack: readonly NavEntry[],
  side: TripSide,
): { entry: NavEntry; rest: NavEntry[] } | null {
  for (let i = stack.length - 1; i >= 0; i--) {
    if (stack[i].side === side) {
      return { entry: stack[i], rest: stack.slice(0, i) };
    }
  }
  return null;
}

/** The lobby leg's south-wall passage: inside the south return door's gap
 *  the south bound relaxes this far past the wall plane so the crossing
 *  trigger (RETURN_DOOR_SOUTH_CROSS_DEPTH) is reachable — the same
 *  overtravel the page door gets (END_WALL_PASS_DEPTH). */
const LOBBY_SOUTH_PASS_DEPTH = 0.6;
/** West parapet clearance, deep in the lobby leg (the cutaway wall at
 *  x = 0 is low but it is still a wall). */
const LOBBY_PARAPET_CLEAR = 0.5;

/** Where a page-door (or travel) hop lands: just inside the CURRENT
 *  hotel's EAST arrival door, facing the lobby — 西出东进 (§10.5): the
 *  west end's page door leads out, the east wall's arrival door is where
 *  you come in. z = 0 keeps the corridor's axis. */
export function eastDoorArrivalPos(): { x: number; z: number } {
  return { x: LOBBY_LENGTH - LOBBY_ARRIVAL_INSET, z: 0 };
}

/** Where an arrival-door return lands: just inside the DEPARTURE hotel's
 *  west end (its page door's gap), facing the corridor — the mirror of
 *  eastDoorArrivalPos, so the round trip reads as one straight walk. */
export function westEndArrivalPos(endX: number): { x: number; z: number } {
  return { x: endX + WEST_END_ARRIVAL_INSET, z: 0 };
}

/**
 * The hotel clamp — clampToCorridor PLUS the lobby leg (§10.5: the south
 * return door and the register board must be approachable). clamps.ts owns
 * the corridor band and is not extended; this wrapper owns the lobby band
 * (x > 0, the L's short leg) and delegates everything west of the seam.
 * In the leg the player may walk south to the far wall (kept LOBBY_CLEAR
 * off it, or past its plane inside the south return door's gap), the west
 * parapet blocks x, and the front desk and armchairs are solid
 * (LOBBY_BLOCKERS — pushed out along the shallowest axis). The north side
 * keeps the corridor's exact rule (gap windows over the same doorXs).
 */
export function clampToHotel(
  p: { x: number; z: number },
  doorXs: readonly number[],
  end: CorridorEnd | undefined,
  southReturnDoorX: number | null,
  eastArrivalDoor: boolean,
  terminalBlocker?: { x0: number; x1: number; z0: number; z1: number } | null,
): void {
  if (p.x <= 0) {
    clampToCorridor(p, doorXs, end);
    return;
  }
  // The east wall caps the lobby — solid everywhere except inside the
  // arrival door's gap, where it relaxes EAST_DOOR_PASS_DEPTH past the
  // wall plane so the crossing trigger (ARRIVAL_DOOR_CROSS_DEPTH) is
  // reachable (§10.5 西出东进).
  const inEastGap = eastArrivalDoor && Math.abs(p.z) < GAP_HALF;
  const xCap = inEastGap
    ? LOBBY_LENGTH + EAST_DOOR_PASS_DEPTH
    : LOBBY_LENGTH - LOBBY_CLEAR;
  if (p.x > xCap) p.x = xCap;
  const inGap = doorXs.some((dx) => Math.abs(p.x - dx) < GAP_HALF);
  const zHi = inGap ? GAP_Z_LIMIT : CORRIDOR_Z_LIMIT;
  const inSouthGap =
    southReturnDoorX !== null && Math.abs(p.x - southReturnDoorX) < GAP_HALF;
  const zLo = inSouthGap
    ? -(LOBBY_SOUTH_REACH + LOBBY_SOUTH_PASS_DEPTH)
    : -(LOBBY_SOUTH_REACH - LOBBY_CLEAR);
  p.z = Math.min(zHi, Math.max(zLo, p.z));
  if (p.z < -CORRIDOR_Z_LIMIT && p.x < LOBBY_PARAPET_CLEAR) {
    p.x = LOBBY_PARAPET_CLEAR;
  }
  for (const b of LOBBY_BLOCKERS) {
    if (p.x > b.x0 && p.x < b.x1 && p.z > b.z0 && p.z < b.z1) {
      const west = p.x - b.x0;
      const east = b.x1 - p.x;
      const south = p.z - b.z0;
      const north = b.z1 - p.z;
      const min = Math.min(west, east, south, north);
      if (min === west) p.x = b.x0;
      else if (min === east) p.x = b.x1;
      else if (min === south) p.z = b.z0;
      else p.z = b.z1;
    }
  }
  // The lobby's anchor terminal is solid like the desk (clip-through a
  // console you're interacting with would read as a bug, not a stylistic
  // choice like the small props).
  if (terminalBlocker) {
    const b = terminalBlocker;
    if (p.x > b.x0 && p.x < b.x1 && p.z > b.z0 && p.z < b.z1) {
      p.x = b.x0;
    }
  }
}

/** The corridor door materialized for a flat slice-list index (within ONE
 *  window's slice list and re-based layout), or null when the index falls
 *  outside the list — an unresolvable return-to-room landing falls back to
 *  the lobby, never a missing-coordinate crash. */
function doorRefForFlatIndex(
  flatIndex: number,
  sliceIds: readonly string[],
  layout: CorridorLayout,
): DoorRef | null {
  const sliceId = sliceIds[flatIndex];
  if (sliceId === undefined) return null;
  const bay = Math.floor(flatIndex / 2);
  const side: Side = flatIndex % 2 === 0 ? "north" : "south";
  return { index: bay, side, sliceId, ...doorPosition(bay, side, layout) };
}

/** Build the ActiveSpace for a corridor door — the ONE construction shared
 *  by the door manager's wall-crossing mount and the return door's
 *  back-into-the-room landing, so a room mounted either way is identical
 *  (recipe, archetype override, and the single scaled view the clamps and
 *  terrain consume). `roomDoorCount` is the strand-door count for this
 *  slice AT RESOLUTION TIME — frozen into the space (see ActiveSpace), so
 *  every consumer of the room shares one value. */
function resolveSpaceForDoor(
  door: DoorRef,
  archetypeById: ReadonlyMap<string, ArchetypeId>,
  roomDoorCount: number = 0,
): ActiveSpace {
  // P3-b1: the recipe compiles from the SKIN-STRIPPED id — the skin is a
  // view-layer force and must never perturb the room's own streams
  // (palette/size/lightSeed feed every downstream seed, composition and
  // scale notation included). The raw id survives on `space.door`,
  // where the view layer (skinForSlice, probe mirrors) reads it.
  // Identity for every non-skinned id, so the default path is untouched.
  const recipe = compileSpaceRecipe(debugSliceIdWithoutSkin(door.sliceId));
  const archetype = archetypeById.get(door.sliceId);
  const finalRecipe = archetype === undefined ? recipe : { ...recipe, archetype };
  const { recipe: scaledRecipe, scale } = scaledRecipeFor(finalRecipe, roomDoorCount);
  return { door, recipe: finalRecipe, scaledRecipe, scale, roomDoorCount };
}

/**
 * The active room's geometry for the movement clamp — its floor plan AND
 * its placed strand doors — derived through the exact pure chain the
 * renderer (space.tsx) builds its room from: the ActiveSpace's recipes →
 * resolveRoomTemplate (measured selection, UNSCALED extent tier, real
 * door count) → roomPlanFor (template-declared silhouette when one
 * resolves) → wallSegmentsFor → hostableWallsFor → placeRoomDoors
 * (template affordance when one resolved), with the renderer's own
 * colonnade-bay and wall-thickness formulas. Everything is deterministic
 * in (sliceId, dims, scale, dir, count), so the movement clamp contains
 * to the same plan and relaxes at the same doors the renderer draws —
 * the two call sites share the pure functions AND their inputs rather
 * than handing geometry through props (SpaceScene owns its memo; its
 * prop contract is unchanged). The plan is returned even when the room
 * grows no strand doors: plan-aware containment needs it regardless.
 *
 * SEAM WALLS (§8): for a composed room, the jamb boxes of its interior
 * partitions (room-modules.ts seamPartitionsFor over the SAME composition
 * + scale factor + wall thickness the renderer draws) — the clamp's
 * solid interior walls. Empty for every non-composed room.
 *
 * Also resolves the room's ANCHOR TERMINAL (§13.1) through the renderer's
 * own inputs — same comp, same plan, same prop scale — so the proximity
 * prompt and the interaction measure the exact machine space.tsx drew
 * (the A6 double-call-site discipline; lib/game/anchor.ts).
 */
function roomGeometryForSpace(
  space: ActiveSpace,
  count: number,
): {
  plan: RoomPlan;
  doors: readonly RoomDoorPlacement[];
  seams: readonly SeamWall[];
  terminal: TerminalAnchor;
} {
  const { door, recipe, scaledRecipe, scale } = space;
  const scaleFactor = scale.factor;
  const width = scaledRecipe.width;
  const extent = scaledRecipe.size.extent;
  const bay = COLONNADE_BAY * Math.sqrt(Math.max(scaleFactor, 0.35));
  const wallThick = ROOM_WALL_THICKNESS * Math.max(scaleFactor, 0.35);
  // The composition sizes the scaled recipe (scaledRecipeFor), so the
  // same call with the space's frozen door count returns the composition
  // the renderer built the room from — one derivation, both lanes.
  const composition = compositionForRecipe(recipe, WORLD_SEED, count);
  const seams: SeamWall[] = composition
    ? seamPartitionsFor(composition, scaleFactor, wallThick).flatMap((sp) => sp.flanks)
    : [];
  // The template declares the silhouette (v0.11-room-interiors §7):
  // selected through the renderer's OWN helper (space.tsx
  // roomTemplateForDoorCount) — one source for the measured selection, so
  // the clamp can never drift onto a plan the room was not built on.
  const template = roomTemplateForDoorCount(
    recipe,
    width,
    extent,
    scaleFactor,
    wallThick,
    count,
  );
  const plan = roomPlanFor(
    recipe.sliceId,
    width,
    extent,
    bay,
    undefined,
    template ? templatePlanFor(template) : undefined,
  );
  if (count <= 0) {
    return {
      plan,
      doors: [],
      seams,
      terminal: terminalForSpace(space, plan),
    };
  }
  const walls = wallSegmentsFor(plan, wallThick);
  const hostable = hostableWallsFor(plan, walls, roomOrientationFor(door).dir);
  const { doors } = placeRoomDoors(
    recipe.sliceId,
    plan,
    walls,
    hostable,
    count,
    undefined,
    template ? doorAffordanceFor(template) : undefined,
  );
  return { plan, doors, seams, terminal: terminalForSpace(space, plan) };
}

/**
 * The room terminal's anchor through the SAME pure inputs space.tsx
 * renders from: the composition over the same plan at the same scale
 * factor, the renderer's wall thickness, the prop scale (scaleFactor^
 * PROP_SCALE_EXP — the room's furniture scale), and the scaled water
 * rect. Called from roomGeometryForSpace only.
 */
function terminalForSpace(space: ActiveSpace, plan: RoomPlan): TerminalAnchor {
  const { recipe, scaledRecipe, scale } = space;
  const scaleFactor = scale.factor;
  const wallThick = ROOM_WALL_THICKNESS * Math.max(scaleFactor, 0.35);
  const comp = composeRoom(recipe.sliceId, plan, scaleFactor);
  return roomTerminalFor({
    sliceId: recipe.sliceId,
    plan,
    comp,
    width: scaledRecipe.width,
    wallThick,
    propScale: Math.pow(scaleFactor, PROP_SCALE_EXP),
    water: waterRectFor(scaledRecipe),
  });
}

/* ------------------------------------------------------------------ */
/* Scene parts                                                         */
/* ------------------------------------------------------------------ */

/** Fixed 45° camera: lerped follow point + constant offset, lookAt player.
 *  The ortho zoom lerps (same easing) toward CAMERA_ZOOM divided by the
 *  active room's bounded pull-back — colossal rooms stay legible as rooms,
 *  and the corridor eases back to normal. One exception to the glide: a
 *  strand-door wormhole teleports the player ~90 m down the timeline, so
 *  `snapRef` (set by the transition's fade-out midpoint) snaps the smoothed
 *  focus to the new position on that frame — gated by
 *  STRAND_TELEPORT_CAMERA_SNAP (tuning/render.ts); flip it to false if the
 *  glide is ever wanted back. */
function CameraRig({
  playerRef,
  space,
  snapRef,
}: {
  playerRef: PlayerRef;
  space: ActiveSpace | null;
  snapRef: MutableRefObject<boolean>;
}): JSX.Element {
  const focus = useRef(
    new THREE.Vector3(playerRef.current.x, 0, playerRef.current.z),
  );
  const zoomRef = useRef(CAMERA_ZOOM);
  const initialPosition = useMemo<[number, number, number]>(
    () => [
      playerRef.current.x + CAM_OFFSET.x,
      CAM_OFFSET.y,
      playerRef.current.z + CAM_OFFSET.z,
    ],
    [playerRef],
  );

  useFrame(({ camera }, dt) => {
    if (STRAND_TELEPORT_CAMERA_SNAP && snapRef.current) {
      snapRef.current = false;
      focus.current.x = playerRef.current.x;
      focus.current.z = playerRef.current.z;
    }
    const k = 1 - Math.exp(-CAMERA_LERP_RATE * Math.min(dt, MAX_DT));
    focus.current.x += (playerRef.current.x - focus.current.x) * k;
    focus.current.z += (playerRef.current.z - focus.current.z) * k;
    const pullback = space === null ? 1 : roomZoomPullback(space.scale.factor);
    zoomRef.current += (CAMERA_ZOOM / pullback - zoomRef.current) * k;
    const ortho = camera as THREE.OrthographicCamera;

    // THE TRANSITION SHOT (world-transition.ts): while a world transition
    // runs, a scripted pose takes the camera down from this follow pose to
    // eye level in front of the anchor terminal (leaving) or back up from
    // it (entering). The follow rig's own state keeps easing above, so
    // the hand back is seamless — the rise ends exactly ON the live pose.
    // Movement is frozen by GameLoop for the same window, so the follow
    // pose is stationary underneath the shot.
    const wt = WORLD_TRANSITION;
    if (wt.active) {
      const follow: FollowPose = {
        x: focus.current.x + CAM_OFFSET.x,
        y: CAM_OFFSET.y,
        z: focus.current.z + CAM_OFFSET.z,
        lookX: focus.current.x,
        lookY: 0,
        lookZ: focus.current.z,
        zoom: zoomRef.current,
      };
      const shot = hotelShotPose(
        wt.progress,
        wt.from,
        wt.to,
        wt.reducedMotion,
        wt.anchor,
        follow,
      );
      if (shot !== null) {
        camera.position.set(shot.x, shot.y, shot.z);
        camera.lookAt(shot.lookX, shot.lookY, shot.lookZ);
        ortho.zoom = shot.zoom;
        ortho.updateProjectionMatrix();
        return;
      }
    }

    camera.position.set(
      focus.current.x + CAM_OFFSET.x,
      CAM_OFFSET.y,
      focus.current.z + CAM_OFFSET.z,
    );
    camera.lookAt(focus.current.x, 0, focus.current.z);
    ortho.zoom = zoomRef.current;
    ortho.updateProjectionMatrix();
  });

  return <OrthographicCamera makeDefault zoom={CAMERA_ZOOM} position={initialPosition} />;
}

/**
 * Scene background, ambient floor, and the directional "sun" — B.13's STUDIO
 * light, not a sun: full-strength key in the corridor and on outdoor-class
 * sets (where the room's skylight is its visible source), dropped to fill
 * level (ROOM_INTERIOR_SUN_FILL) inside interior rooms, whose own fixtures
 * carry the key. Color/intensity lerp continuously toward the target mood
 * (corridor vs active space palette) instead of swapping on mount;
 * resolveAtmosphere is the single source of the targets. `dark` follows the
 * app theme — the corridor branch of the targets uses the theme's void
 * color; a toggle eases through the same lerp.
 *
 * The sun and its shadow camera FOLLOW the player: the light sits at
 * player + SUN_OFFSET and its target tracks the player on the ground
 * plane, so the ortho shadow frustum always covers the visible diorama
 * down the whole streaming corridor and inside every space; the frustum
 * half-extent also tracks the room zoom pull-back (up to
 * ROOM_ZOOM_MAX_PULLBACK) so that stays true while the camera is pulled
 * back inside a scaled room. The light direction (SUN_OFFSET → origin) is
 * identical to the old fixed rig, so surface response is unchanged — only
 * coverage moved.
 */
function Atmosphere({
  space,
  dark,
  playerRef,
}: {
  space: ActiveSpace | null;
  dark: boolean;
  playerRef: PlayerRef;
}): JSX.Element {
  const bgRef = useRef<THREE.Color>(null);
  const sunRef = useRef<THREE.DirectionalLight>(null);
  const ambientRef = useRef<THREE.AmbientLight>(null);
  // The shadow target must live in the scene graph for its matrixWorld to
  // update; it is positioned per frame on the ground under the player.
  const [sunTarget] = useState(() => {
    const target = new THREE.Object3D();
    target.position.set(playerRef.current.x, 0, playerRef.current.z);
    return target;
  });
  // Reusable target bucket — resolved fresh each frame, never reallocated.
  const [targets] = useState<AtmosphereTargets>(() => ({
    background: new THREE.Color(SCENE_COLORS.night),
    sunColor: new THREE.Color(SUN_BASE_COLOR),
    sunIntensity: SUN_BASE_INTENSITY,
    ambient: CORRIDOR_AMBIENT,
  }));

  useFrame((_, dt) => {
    const bg = bgRef.current;
    const sun = sunRef.current;
    const ambient = ambientRef.current;
    if (!bg || !sun || !ambient) return;
    const k = 1 - Math.exp(-ATMOSPHERE_LERP_RATE * Math.min(dt, MAX_DT));
    resolveAtmosphere(space, dark, targets);
    bg.lerp(targets.background, k);
    sun.color.lerp(targets.sunColor, k);
    sun.intensity += (targets.sunIntensity - sun.intensity) * k;
    ambient.intensity += (targets.ambient - ambient.intensity) * k;
    // Keep the key light and its shadow frustum centered on the player.
    const p = playerRef.current;
    sun.position.set(p.x + SUN_OFFSET.x, SUN_OFFSET.y, p.z + SUN_OFFSET.z);
    sunTarget.position.set(p.x, 0, p.z);
    sunTarget.updateMatrixWorld();
    // The shadow frustum must cover what the camera shows: inside a scaled
    // room the ortho zoom pulls back (roomZoomPullback, up to
    // ROOM_ZOOM_MAX_PULLBACK), so the ±SUN_SHADOW_EXTENT box grows by the
    // same factor — otherwise most of the visible floor of a big room
    // leaves the shadow map and the room reads shadowless.
    const pullback = space === null ? 1 : roomZoomPullback(space.scale.factor);
    const shadowExtent = SUN_SHADOW_EXTENT * pullback;
    const shadowCam = sun.shadow.camera;
    if (shadowCam.right !== shadowExtent) {
      shadowCam.left = -shadowExtent;
      shadowCam.right = shadowExtent;
      shadowCam.top = shadowExtent;
      shadowCam.bottom = -shadowExtent;
      shadowCam.updateProjectionMatrix();
    }
    // Probe mirror — lets the browser console read the live background and
    // light state when diagnosing a room-wide color veil.
    GAME_DEBUG.fogNear = -1;
    GAME_DEBUG.fogFar = -1;
    GAME_DEBUG.bg = `#${bg.getHexString()}`;
    GAME_DEBUG.sunColor = `#${sun.color.getHexString()}`;
    GAME_DEBUG.sunIntensity = +sun.intensity.toFixed(3);
    GAME_DEBUG.ambient = +ambient.intensity.toFixed(3);
  });

  return (
    <>
      <color ref={bgRef} attach="background" args={[SCENE_COLORS.night]} />
      {/* No scene fog anywhere: with the 45° camera parked ~23m above the
          player, any fog band wide enough to matter covered the whole
          visible room and washed it into the fog color (the 'translucent
          room'). Depth is sold by the background color, the corridor's
          end-fade planes, and the post chain (N8AO + vignette) instead. */}
      <ambientLight ref={ambientRef} intensity={CORRIDOR_AMBIENT} />
      <primitive object={sunTarget} />
      <directionalLight
        ref={sunRef}
        castShadow
        target={sunTarget}
        position={[
          playerRef.current.x + SUN_OFFSET.x,
          SUN_OFFSET.y,
          playerRef.current.z + SUN_OFFSET.z,
        ]}
        intensity={SUN_BASE_INTENSITY}
        color={SUN_BASE_COLOR}
        shadow-mapSize={[SUN_SHADOW_MAP_SIZE, SUN_SHADOW_MAP_SIZE]}
        shadow-camera-left={-SUN_SHADOW_EXTENT}
        shadow-camera-right={SUN_SHADOW_EXTENT}
        shadow-camera-top={SUN_SHADOW_EXTENT}
        shadow-camera-bottom={-SUN_SHADOW_EXTENT}
        shadow-camera-near={SUN_SHADOW_NEAR}
        shadow-camera-far={SUN_SHADOW_FAR}
        shadow-bias={SUN_SHADOW_BIAS}
        shadow-normalBias={SUN_SHADOW_NORMAL_BIAS}
      />
    </>
  );
}

/**
 * Radial gradient texture for the stage pool: white with alpha 1 at the
 * center, smoothstep-fading to 0 at the rim — the mesh's material color
 * supplies the hue per frame. Generated in code (DataTexture, no assets)
 * exactly like the material library's maps (lib/game/materials/three.ts).
 */
function createStageGradientTexture(): THREE.DataTexture {
  const size = 256;
  const data = new Uint8Array(size * size * 4);
  const inner = STAGE_POOL_RADIUS / STAGE_BACKDROP_RADIUS;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (x + 0.5) / size - 0.5;
      const dy = (y + 0.5) / size - 0.5;
      const r = Math.hypot(dx, dy) * 2; // 0 at center → 1 at the circle rim
      const t = Math.min(1, Math.max(0, (r - inner) / (1 - inner)));
      const a = 1 - t * t * (3 - 2 * t); // smoothstep falloff
      const i = (y * size + x) * 4;
      data[i] = 255;
      data[i + 1] = 255;
      data[i + 2] = 255;
      data[i + 3] = Math.round(a * 255);
    }
  }
  const texture = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  texture.needsUpdate = true;
  return texture;
}

/**
 * The stage the diorama sits on: a huge unlit disc parked STAGE_BACKDROP_Y
 * below the floor, following the player in XZ exactly like the sun rig
 * does, textured with the radial gradient above. Its color is the SAME
 * lerped background target the scene background uses (resolveAtmosphere
 * stays the single source), lifted a touch toward white — so the pool is
 * always a faint glow of the current mood: the corridor void by default,
 * the room's own palette shadow while a space is active, easing between
 * the two on the shared ATMOSPHERE_LERP_RATE.
 *
 * Deliberately NOT scene fog and never to be "fixed" back into it: fog
 * blends by camera distance, and from this 45° camera parked ~23 m up,
 * every usable fog band washed the whole visible room into the fog color
 * (the translucent-room bug, commits 9116243/09c757b/d9edf93). This disc
 * is plain geometry at a fixed depth — its shading has no camera-distance
 * term, so it structurally cannot reproduce that failure. The disc IS tone
 * mapped like every lit surface: anything visible through or above the
 * room's walls must ride the same AgX curve as the room itself, otherwise
 * the backdrop renders relatively brighter than the tone-mapped scene and
 * bleeds milk through every opening. The scene background stays the
 * renderer's clear color (a Color background bypasses tone mapping by
 * design — WebGLBackground), but the disc covers the entire view and its
 * transparent rim converges to that exact color at opacity 0, so the two
 * still meet seamlessly.
 */
function StageBackdrop({
  space,
  dark,
  playerRef,
}: {
  space: ActiveSpace | null;
  dark: boolean;
  playerRef: PlayerRef;
}): JSX.Element {
  const meshRef = useRef<THREE.Mesh>(null);
  const matRef = useRef<THREE.MeshBasicMaterial>(null);
  const gradient = useMemo(() => createStageGradientTexture(), []);
  useEffect(() => () => gradient.dispose(), [gradient]);
  const [targets] = useState<AtmosphereTargets>(() => ({
    background: new THREE.Color(SCENE_COLORS.night),
    sunColor: new THREE.Color(SUN_BASE_COLOR),
    sunIntensity: SUN_BASE_INTENSITY,
    ambient: CORRIDOR_AMBIENT,
  }));
  const [scratch] = useState(() => new THREE.Color());
  const [white] = useState(() => new THREE.Color("#ffffff"));
  const initializedRef = useRef(false);

  useFrame((_, dt) => {
    const mesh = meshRef.current;
    const mat = matRef.current;
    if (!mesh || !mat) return;
    const k = 1 - Math.exp(-ATMOSPHERE_LERP_RATE * Math.min(dt, MAX_DT));
    resolveAtmosphere(space, dark, targets);
    scratch.copy(targets.background).lerp(white, STAGE_BACKDROP_LIFT);
    // Snap on the first frame — the material constructs white, and lerping
    // down from there would flash a bright disc at mount.
    if (initializedRef.current) {
      mat.color.lerp(scratch, k);
    } else {
      mat.color.copy(scratch);
      initializedRef.current = true;
    }
    const p = playerRef.current;
    mesh.position.set(p.x, STAGE_BACKDROP_Y, p.z);
  });

  return (
    <mesh
      ref={meshRef}
      rotation={[-Math.PI / 2, 0, 0]}
      position={[playerRef.current.x, STAGE_BACKDROP_Y, playerRef.current.z]}
    >
      <circleGeometry args={[STAGE_BACKDROP_RADIUS, 64]} />
      <meshBasicMaterial
        ref={matRef}
        map={gradient}
        transparent
        opacity={STAGE_BACKDROP_OPACITY}
        depthWrite={false}
      />
    </mesh>
  );
}

/**
 * The walkable avatar: capsule body + sphere head + a small visor cone so
 * the facing direction reads at distance. Position/rotation are driven
 * imperatively from playerRef/motionRef in useFrame — no React re-render
 * per frame. Bob is a gentle y sine while moving; facing lerps toward the
 * travel heading. Y snaps to the active space's terrain (wading pools) and
 * lerps back to the corridor floor on exit.
 */
function PlayerAvatar({
  playerRef,
  motionRef,
  space,
  waterSide,
}: {
  playerRef: PlayerRef;
  motionRef: MutableRefObject<Motion>;
  space: ActiveSpace | null;
  waterSide: number;
}): JSX.Element {
  const rootRef = useRef<THREE.Group>(null);
  const bodyRef = useRef<THREE.Group>(null);
  const headingRef = useRef(0);
  const bobPhaseRef = useRef(0);
  const bobRef = useRef(0);
  const yRef = useRef(0);

  useFrame((_, dt) => {
    const root = rootRef.current;
    const body = bodyRef.current;
    if (!root || !body) return;
    const step = Math.min(dt, MAX_DT);
    const motion = motionRef.current;

    const p = playerRef.current;
    const targetY = space ? groundTargetY(space, waterSide, p.x, p.z) : 0;
    yRef.current += (targetY - yRef.current) * (1 - Math.exp(-GROUND_LERP_RATE * step));
    root.position.set(p.x, yRef.current, p.z);
    if (motion.moving) {
      bobPhaseRef.current += step * BOB_RATE;
      bobRef.current = Math.abs(Math.sin(bobPhaseRef.current)) * BOB_HEIGHT;
      headingRef.current = lerpAngle(
        headingRef.current,
        Math.atan2(motion.x, motion.z),
        1 - Math.exp(-TURN_LERP_RATE * step),
      );
    } else {
      bobRef.current += (0 - bobRef.current) * (1 - Math.exp(-TURN_LERP_RATE * step));
    }
    body.position.y = bobRef.current;
    root.rotation.y = headingRef.current;
  });

  return (
    <group ref={rootRef}>
      <group ref={bodyRef}>
        {/* Capsule body — total height 0.9 m. */}
        <mesh castShadow position={[0, 0.45, 0]}>
          <capsuleGeometry args={[0.26, 0.38, 4, 10]} />
          <meshStandardMaterial color={PLAYER_BODY} roughness={1} flatShading />
        </mesh>
        <mesh castShadow position={[0, 1.04, 0.02]}>
          <sphereGeometry args={[0.19, 12, 10]} />
          <meshStandardMaterial color={PLAYER_HEAD} roughness={1} flatShading />
        </mesh>
        {/* Visor nub — marks the facing direction (+z local). */}
        <mesh castShadow position={[0, 1.04, 0.2]} rotation={[Math.PI / 2, 0, 0]}>
          <coneGeometry args={[0.06, 0.14, 6]} />
          <meshStandardMaterial color={PLAYER_BODY} roughness={1} flatShading />
        </mesh>
      </group>
    </group>
  );
}

/**
 * The per-frame game loop: integrates movement, runs the door manager
 * (mount/release activeSpace on a hysteresis band around the wall plane),
 * applies the corridor/space clamps, and refreshes the HUD door prompt —
 * each state setter guarded so steady frames cost nothing.
 *
 * Containment: a space releases the player only through its own door gap —
 * inside the corridor band (|z| < WALL_IN) AND within CLEAR_HALF of the
 * door's x. Any other corridor-band position with a space active means the
 * wall was somehow crossed outside the gap; the player is re-clamped into
 * the space (clampToSpace pushes them back through the solid wall side)
 * instead of being released.
 *
 * Strand-door latch: while a room→room crossing is in flight
 * (`transitionActive`) the world is FROZEN — no movement, no clamps, and
 * the door manager is suspended, because the player is standing inside a
 * dissolving room whose activeSpace is already null: an unsuspended
 * manager would resolve the nearest door and re-mount the very room that
 * is fading out. The corridor stays dissolved for the whole crossing too
 * (step 3b) — the wormhole must never flash the hotel into view.
 */
function GameLoop({
  playerRef,
  keysRef,
  motionRef,
  doors,
  sliceIds,
  doorXs,
  layout,
  corridorEnd,
  returnDoorX,
  returnDoorSouthX,
  eastArrivalDoor,
  onPageDoor,
  onReturnDoor,
  onArrivalDoor,
  hopGuard,
  hotelLabel,
  archetypeById,
  activeSpace,
  setActiveSpace,
  corridorHidden,
  setCorridorHidden,
  hudIdRef,
  setHudDoor,
  prewarmIdRef,
  setPrewarmDoor,
  transitionActive,
  roomDoors,
  roomDoorCountFor,
  roomPlan,
  roomSeams,
  roomTerminal,
  lobbyAnchorLabel,
  departingRef,
  departWatchRef,
  anchorHudRef,
  setHudAnchor,
}: {
  playerRef: PlayerRef;
  keysRef: MutableRefObject<Set<string>>;
  motionRef: MutableRefObject<Motion>;
  /** The CURRENT hotel's full door list (the HUD's label source) — the
   *  integrator swaps it on a hotel hop. */
  doors: readonly CorridorDoor[];
  /** The current window's slice ids (≤ WINDOW_SLICES) — the materialized
   *  doors, positioned by the window's re-based layout. */
  sliceIds: readonly string[];
  doorXs: readonly number[];
  /** The current window's layout, re-based so its lobby sits at
   *  x ∈ [0, LOBBY_LENGTH) (windowLayout, corridor-pitch.ts). */
  layout: CorridorLayout;
  /** The corridor's far end (HD2/HD3): x is capped at the end wall —
   *  solid at the oldest window, relaxed inside the page door's gap. */
  corridorEnd: CorridorEnd;
  /** The lobby's NORTH return door x when the nav stack holds a
   *  north-lateral trip, else null (no door on that wall). */
  returnDoorX: number | null;
  /** The lobby's SOUTH return door x when the nav stack holds a
   *  south-lateral trip, else null (§10.5). */
  returnDoorSouthX: number | null;
  /** The lobby's EAST arrival door is hung (the nav stack holds an
   *  east-west trip — a page-door or travel hop; §10.5 西出东进). */
  eastArrivalDoor: boolean;
  /** Hotel hops (HD3): the player pushed through the page door / one
   *  wall's return door / the east arrival door. Called from inside the
   *  frame; the handlers teleport and switch the integrator's location
   *  state. */
  onPageDoor: () => void;
  onReturnDoor: (side: Side) => void;
  onArrivalDoor: () => void;
  /** One-frame guard set by every hotel-hop handler: the next frame may
   *  still run with the pre-hop closure, so it skips movement, door
   *  triggers and clamps once (consumed, not a latch). */
  hopGuard: MutableRefObject<boolean>;
  /** "timelineId@windowIndex" — written to GAME_DEBUG.hotel every frame. */
  hotelLabel: string;
  archetypeById: ReadonlyMap<string, ArchetypeId>;
  activeSpace: ActiveSpace | null;
  setActiveSpace: (space: ActiveSpace | null) => void;
  corridorHidden: boolean;
  setCorridorHidden: (hidden: boolean) => void;
  hudIdRef: MutableRefObject<string | null>;
  setHudDoor: (door: CorridorDoor | null) => void;
  /** Prewarm target identity guard + setter (see step 2b). */
  prewarmIdRef: MutableRefObject<string | null>;
  setPrewarmDoor: (door: DoorRef | null) => void;
  transitionActive: boolean;
  /** The active space's placed strand doors (plan-local frame) — the
   *  clamp's passage windows; empty when the room grows none. */
  roomDoors: readonly RoomDoorPlacement[];
  /** The runtime strand-door count for ANY slice of the current window —
   *  the pure door-map lookup (data lane), consumed at the wall crossing
   *  to freeze the count into the new ActiveSpace. GameLoop sees only the
   *  ACTIVE space's placements above, so the mount asks here per slice. */
  roomDoorCountFor: (sliceId: string) => number;
  /** The active space's floor plan (same derivation as roomDoors) — the
   *  clamp's plan-aware containment; a placeholder rect when no space is
   *  active (the space clamp never runs then). */
  roomPlan: RoomPlan;
  /** The active space's interior seam jamb walls (§8 — same derivation as
   *  the renderer's partitions; empty for non-composed rooms): the clamp's
   *  solid interior walls. */
  roomSeams: readonly SeamWall[];
  /** The active room's anchor terminal (room-local frame — the same pure
   *  resolution space.tsx rendered; null when no space is active, then the
   *  lobby machine is the anchor candidate). */
  roomTerminal: TerminalAnchor | null;
  /** Localized label for the lobby terminal's HUD prompt. */
  lobbyAnchorLabel: string;
  /** Latched by the anchor interaction: freezes movement while the
   *  depart flare plays and the view dissolves to the catalog. */
  departingRef: MutableRefObject<boolean>;
  /** Set once the latch has seen WORLD_TRANSITION.active — the latch only
   *  self-clears AFTER the move it belongs to has run and ended (the flare
   *  window alone must not clear it). See the frame note below. */
  departWatchRef: MutableRefObject<boolean>;
  /** The latest in-reach anchor (also read by the interact key handler
   *  and the GAME_DEBUG probe mirror). */
  anchorHudRef: MutableRefObject<AnchorHud | null>;
  setHudAnchor: (anchor: AnchorHud | null) => void;
}): null {
  useFrame((_, delta) => {
    const p = playerRef.current;
    let space = activeSpace;

    // THE DEPART LATCH SELF-CLEARS — structurally, not by timeout. The
    // shell's transition machine guarantees WORLD_TRANSITION.active is
    // false exactly when no move runs (its single settle clears it on
    // completion, reversal, interrupt AND unmount — app-shell.tsx), so
    // "latched, saw the move active, and the move is over" means the
    // entrance already ended (completed, reversed, or interrupted) and
    // the walk must resume. The sawActive guard keeps the 700 ms flare
    // window (latch set, move not yet started) from clearing it early.
    if (WORLD_TRANSITION.active) {
      departWatchRef.current = true;
    } else if (departingRef.current && departWatchRef.current) {
      departingRef.current = false;
      departWatchRef.current = false;
    }

    if (hopGuard.current) {
      // A hotel hop teleported the player between frames: this frame may
      // still run with the PRE-hop closure (React has not committed the
      // location change yet) — its door triggers and clamps describe the
      // hotel the player just LEFT, and the fresh position (e.g. another
      // hotel's west end, inside the page door's gap) can read as a
      // crossing. Skip one frame's movement, triggers and clamps; the
      // next frame runs on the committed hotel.
      hopGuard.current = false;
      motionRef.current = { x: 0, z: 0, moving: false };
    } else if (
      !transitionActive &&
      !departingRef.current &&
      !WORLD_TRANSITION.active
    ) {
      // 1. Movement — screen-relative, dt-corrected, no acceleration. Inside
      // a space the speed scales with the room (clamp(S,1,∞)^EXP): a colossal
      // room should feel immense, not waste the player's time; the corridor
      // stays exactly PLAYER_SPEED.
      const move = moveVectorFromKeys(keysRef.current);
      const moving = move.x !== 0 || move.z !== 0;
      motionRef.current = { x: move.x, z: move.z, moving };
      if (moving) {
        const dt = Math.min(delta, MAX_DT);
        const speed =
          PLAYER_SPEED *
          (space === null
            ? 1
            : // v0.12 P3: a forced biome skin's floor walk semantics —
              // wade floors slow the walk (skin.floor.speed, < 1). The
              // scale answers 1 on every dry floor and the whole default
              // path (×1 is exact, so the legacy speed math is untouched).
              // The force reads the DOOR's raw id — the recipe rides the
              // skin-stripped id since P3-b1.
              roomSpeedFactor(space.scale.factor) *
              skinWalkSpeedScale(space.door.sliceId));
        p.x += move.x * speed * dt;
        p.z += move.z * speed * dt;
      }

      // 1b. HOTEL DOORS (HD3) — checked before the room door manager, only
      // in the corridor: the page door at the far end (the end clamp
      // relaxed inside its gap; pushing PAGE_DOOR_CROSS_DEPTH past the wall
      // plane hops to the next-older window's lobby) and the lobby's doors
      // back — one per wall the trip in came from (§10.5): the north
      // door's trigger sits past the junction's north wall plane, the south
      // door's past the leg's far south wall plane, the east arrival
      // door's past the lobby's east wall plane, each inside its own
      // gap. All teleport: skip the rest of this frame.
      if (space === null) {
        if (
          corridorEnd.pageDoor &&
          p.x < corridorEnd.endX - PAGE_DOOR_CROSS_DEPTH &&
          Math.abs(p.z) < GAP_HALF
        ) {
          onPageDoor();
          return;
        }
        if (
          returnDoorX !== null &&
          p.z > WALL_OUT &&
          Math.abs(p.x - returnDoorX) < GAP_HALF
        ) {
          onReturnDoor("north");
          return;
        }
        if (
          returnDoorSouthX !== null &&
          p.z < -(LOBBY_SOUTH_REACH + RETURN_DOOR_SOUTH_CROSS_DEPTH) &&
          Math.abs(p.x - returnDoorSouthX) < GAP_HALF
        ) {
          onReturnDoor("south");
          return;
        }
        if (
          eastArrivalDoor &&
          p.x > LOBBY_LENGTH + ARRIVAL_DOOR_CROSS_DEPTH &&
          Math.abs(p.z) < GAP_HALF
        ) {
          onArrivalDoor();
          return;
        }
      }

      // 2. Door manager — hysteresis band around the wall plane. While a
      // space is active ONLY its own door can matter: a big room spans many
      // door bays, and re-resolving nearestDoor here would let the player
      // "walk through the wall" into the neighboring door's space.
      const az = Math.abs(p.z);
      if (az > WALL_OUT && space === null) {
        const door = nearestDoor(p.x, p.z, sliceIds, DOOR_GRAB_DIST, layout);
        if (door) {
          // The scaled view is computed ONCE inside resolveSpaceForDoor —
          // room-plan.ts is the single definition of "how big is this room";
          // clamps, terrain, and water below all consume it, matching the
          // geometry space.tsx builds. The strand-door count is frozen in
          // with it (§8.4 — the composition grew by it): the room the
          // player walks in is the room the clamp contains.
          MOUNT_TRACE.tRequest = performance.now();
          space = resolveSpaceForDoor(door, archetypeById, roomDoorCountFor(door.sliceId));
          setActiveSpace(space);
        }
      } else if (az < WALL_IN && space !== null) {
        // Release only through THE door gap: inside the corridor band and
        // near the door's x. Outside that zone the wall is solid both ways —
        // stay in space mode and let clampToSpace push the player back in.
        if (Math.abs(p.x - space.door.x) < CLEAR_HALF) {
          space = null;
          setActiveSpace(null);
        }
      } else if (az > WALL_OUT && space !== null) {
        // Opposite-side recovery (v0.12 declarations audit): the release
        // window above is a hysteresis band a jumped position can skip —
        // a probe/teleport (or a clamp relaxation) landing on the FAR side
        // of the corridor from the active room used to leave `space` stale
        // forever: the mount branch below requires space === null, so the
        // new room never mounted and the old one held the slot ("prewarm
        // latch pins the previous room"). A walker can never reach here —
        // the space/hotel clamps keep them inside their room or the
        // corridor band — so releasing on the opposite side is pure
        // recovery, never a behaviour change for walking play.
        const roomSide = space.door.z > 0 ? 1 : -1;
        if (Math.sign(p.z) === -roomSide) {
          space = null;
          setActiveSpace(null);
        }
      }

      // 2b. Prewarm — while no space is active, the nearest door within
      // the prewarm radius gets its room mounted invisible (root
      // visible=false) and the scene's programs precompiled
      // (LightConfigCompiler), so the crossing frame has nothing left to
      // build or compile.
      // Identity-guarded like the HUD prompt. Left stale while a space is
      // active (the room slot ignores it then) — recomputed on the first
      // frame back in the corridor, where it also hands the just-exited
      // room's fiber back as the (invisible) prewarm mount.
      if (space === null) {
        const pre = nearestDoor(p.x, p.z, sliceIds, ROOM_PREWARM_DIST, layout);
        const preId = pre ? pre.sliceId : null;
        if (preId !== prewarmIdRef.current) {
          prewarmIdRef.current = preId;
          setPrewarmDoor(pre);
        }
      }

      // 3. Clamps for wherever the player ended up. The space clamp boxes to
      // the SCALED footprint — the same dims the room was built at, so the
      // player can reach the far end of a colossal room and cannot walk
      // through a miniature room's walls. It also receives the room's plan,
      // its placed strand doors, and its interior seam jamb walls (same pure
      // derivation the renderer draws): the plan keeps the player out of an
      // l-shape's abandoned quadrant (the plain box is only the plan's
      // bounding box), each door's passage relaxes the wall bound enough for
      // the crossing trigger to fire, and each seam partition's jambs are
      // solid in both directions — the opening between them stays walkable
      // because no wall box covers it.
      if (space !== null) {
        clampToSpace(
          p,
          space.door,
          space.scaledRecipe.width,
          space.scaledRecipe.size.extent,
          roomDoors,
          roomPlan,
          roomSeams,
        );
      } else {
        clampToHotel(
          p,
          doorXs,
          corridorEnd,
          returnDoorSouthX,
          eastArrivalDoor,
          LOBBY_TERMINAL_BLOCKER,
        );
      }
    } else {
      // Frozen mid-crossing: report "not moving" so the avatar settles
      // instead of bobbing in place while its room dissolves.
      motionRef.current = { x: 0, z: 0, moving: false };
    }

    // 3b. Corridor visibility: the instant a space engages — the player has
    //  crossed the threshold — the world behind them begins to dissolve
    //  (dim at 6/s, unmount after HIDE_DELAY_MS), so entering a room reads
    //  as leaving the hotel behind, not as a window next door. The release
    //  is symmetric: back in the corridor band the hotel returns the same
    //  frame, remounting dark and easing up (useDimLerp's recovery lerp in
    //  corridor.tsx), so neither direction pops. A strand-door crossing
    //  holds the corridor dissolved for the whole hotel hop — it must never
    //  flash into view between the two hotels.
    const gone = space !== null || transitionActive;
    if (gone !== corridorHidden) setCorridorHidden(gone);

    // 4. THE ANCHOR TERMINAL (§13.1): proximity of the one machine that
    // matters right now — the room's terminal while a space is active, the
    // lobby's index terminal otherwise. The interaction point is the world
    // transform of the renderer's anchor (room-local → world through the
    // same door/dir mirror the clamp and the return-door landing use),
    // so the thing measured here IS the thing space.tsx drew.
    let ax = 0;
    let az = 0;
    let aFaceX = 0;
    let aFaceZ = 1;
    let aKind: "" | "room" | "lobby" = "";
    let aSlice: string | null = null;
    let aReach = TERMINAL_REACH_LOBBY;
    if (space !== null && roomTerminal !== null) {
      const dir = space.door.z > 0 ? 1 : -1;
      const front = (TERMINAL_D * roomTerminal.scale) / 2;
      ax = space.door.x + dir * roomTerminal.x;
      az = space.door.z + dir * (roomTerminal.z + front);
      // The terminal's local +z front maps to world (0, dir) under the
      // same mirror — the direction the scripted shot's eye pose stands
      // from.
      aFaceX = 0;
      aFaceZ = dir;
      aKind = "room";
      aSlice = space.door.sliceId;
      aReach = TERMINAL_REACH_ROOM;
    } else if (space === null) {
      const t = LOBBY_TERMINAL_ANCHOR;
      ax = t.x - (TERMINAL_D * t.scale) / 2;
      az = t.z;
      // The lobby terminal's rotY = −π/2: its front faces −x, which is
      // where the interaction point sits.
      aFaceX = -1;
      aFaceZ = 0;
      aKind = "lobby";
      aSlice = sliceIds[0] ?? null;
    }
    // The transition's shot target — written every frame (single writer,
    // mutated in place), whether or not the player is in reach: entering
    // the hotel dissolves to the nearest terminal's eye pose even when the
    // player never stood next to it.
    const wtAnchor = WORLD_TRANSITION.anchor;
    wtAnchor.x = ax;
    wtAnchor.z = az;
    wtAnchor.faceX = aFaceX;
    wtAnchor.faceZ = aFaceZ;
    wtAnchor.has = aKind !== "";
    const aDist = Math.hypot(p.x - ax, p.z - az);
    const aHud: AnchorHud | null =
      aSlice !== null && aDist <= aReach
        ? {
            kind: aKind as "room" | "lobby",
            sliceId: aSlice,
            label:
              aKind === "lobby"
                ? lobbyAnchorLabel
                : (doors.find((d) => d.sliceId === aSlice)?.label ?? aSlice),
            x: ax,
            z: az,
            faceX: aFaceX,
            faceZ: aFaceZ,
          }
        : null;
    const prevAnchor = anchorHudRef.current;
    if (
      (prevAnchor === null) !== (aHud === null) ||
      prevAnchor?.kind !== aHud?.kind ||
      prevAnchor?.sliceId !== aHud?.sliceId
    ) {
      anchorHudRef.current = aHud;
      setHudAnchor(aHud);
    }
    // Probe mirror — single writer, mutated in place.
    const dbgAnchor = GAME_DEBUG.anchor;
    dbgAnchor.active = aHud !== null;
    dbgAnchor.kind = aKind;
    dbgAnchor.x = ax;
    dbgAnchor.z = az;
    dbgAnchor.sliceId = aSlice;
    dbgAnchor.near = aSlice !== null ? Math.max(0, 1 - aDist / aReach) : 0;

    // 5. HUD prompt — setState only when the nearest door identity changes.
    // The anchor wins while in reach (its prompt replaces the door's).
    const near = aHud !== null ? null : nearestDoor(p.x, p.z, sliceIds, HUD_DIST, layout);
    const nearId = near ? near.sliceId : null;
    if (nearId !== hudIdRef.current) {
      hudIdRef.current = nearId;
      setHudDoor(nearId === null ? null : (doors.find((d) => d.sliceId === nearId) ?? null));
    }

    // 6. Probe/e2e debug handle — mutate the preallocated object, no re-render.
    GAME_DEBUG.x = p.x;
    GAME_DEBUG.z = p.z;
    GAME_DEBUG.space = space === null ? null : space.door.sliceId;
    GAME_DEBUG.hotel = hotelLabel;
  });
  return null;
}

/** Bottom-center prompt — label + localized hint, pointer-transparent.
 *  The anchor terminal (§13.1) wins over a door while the player stands
 *  in reach; the hint is the same "Enter" the doors use (E works too).
 *  Sits bottom-24 (not bottom-6): the conversation pill floats centred at
 *  the bottom edge (16px gap + 48px tall + its subtitle line above), so
 *  the prompt must clear the whole pill stack — no overlap, no shrink. */
function Hud({
  door,
  anchor,
  enterHint,
}: {
  door: CorridorDoor | null;
  anchor: AnchorHud | null;
  enterHint: string;
}): JSX.Element | null {
  const label = anchor ? anchor.label : door?.label;
  if (label === undefined) return null;
  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-24 z-10 flex justify-center">
      <div className="rounded-full bg-black/35 px-4 py-1.5 font-serif text-sm text-neutral-300 backdrop-blur-sm">
        <span className="text-neutral-100">{label}</span>
        <span className="mx-2 text-neutral-500">·</span>
        <span>{enterHint}</span>
      </div>
    </div>
  );
}

/**
 * Shader prewarm (responsiveness). three keys every material's program on
 * the scene's LIGHT CONFIGURATION, so mounting a room (its lamp, window
 * spot, skylight join the corridor's ~23 lights) re-keys every program in
 * the scene — measured as a ~1 s synchronous compile inside the mount
 * frame's render (SwiftShader; MOUNT_TRACE), with a second wave when the
 * corridor's lights unmount (HIDE_DELAY_MS after entry) and smaller ones
 * on exit/return. After any commit that can change the light configuration
 * (the `epoch` string) this precompiles the programs the NEXT renders will
 * need with synchronous gl.compile calls, staging the light configuration
 * with visibility flags — three 0.185 WebGLRenderer.compile gathers lights
 * via traverseVisible (invisible subtrees contribute none) but materials
 * via traverse (visibility-independent):
 *   - prewarm: the room root (ROOM_ROOT — mounted visible=false) is
 *     flipped visible for the call, so every program compiles under the
 *     corridor+room config while the room stays invisible to all renders;
 *   - crossed: the corridor wrapper is hidden for the call, so the room's
 *     programs also exist under the room-only config the corridor's
 *     unmount (HIDE_DELAY_MS) will switch to;
 *   - exit: the room is dissolving and the corridor is back with FRESH
 *     materials (its old ones were disposed with the unmount) — compile
 *     once under the live corridor+room config, and once with the room's
 *     lights hidden (the corridor-only config the room's unmount will
 *     switch to ~SPACE_FADE_S later, enough lead time for the links).
 * All flips are restored inside the same JS task, so no render ever sees
 * them. compile() only SUBMITS compile/link (with
 * KHR_parallel_shader_compile the driver work runs off the main thread),
 * so these calls cost a traversal plus a few main-thread ms and no RENDER
 * pays the storm. three's compileAsync is deliberately NOT used: its
 * readiness poll crashes when a material is disposed mid-poll (the
 * properties WeakMap entry is gone → undefined.isReady()).
 */
function LightConfigCompiler({
  epoch,
  phase,
  corridorRef,
}: {
  epoch: string;
  /** Which light configuration the coming renders will need (see above). */
  phase: "prewarm" | "crossed" | "exit" | "plain";
  /** The corridor's wrapper group (hidden around the crossed compile). */
  corridorRef: MutableRefObject<THREE.Group | null>;
}): null {
  const gl = useThree((s) => s.gl);
  const scene = useThree((s) => s.scene);
  const camera = useThree((s) => s.camera);
  const firstRef = useRef(true);
  useLayoutEffect(() => {
    // The initial corridor-only scene compiles on its first render already
    // (startup is masked by page load) — don't double-compile it here. But
    // a spawn-time PREWARM (a door within ROOM_PREWARM_DIST of SPAWN) is
    // invisible to that first render, so its programs only compile here.
    if (firstRef.current) {
      firstRef.current = false;
      if (phase === "plain") return;
    }
    const run = () => {
      const t0 = performance.now();
      const root = ROOM_ROOT.current;
      const corridor = corridorRef.current;
      if (phase === "prewarm" && root) {
        const was = root.visible;
        root.visible = true;
        gl.compile(scene, camera);
        root.visible = was;
      } else if (phase === "crossed" && corridor) {
        corridor.visible = false;
        gl.compile(scene, camera);
        corridor.visible = true;
      } else if (phase === "exit" && root) {
        gl.compile(scene, camera);
        const roomLights: THREE.Light[] = [];
        root.traverse((obj) => {
          if ((obj as THREE.Light).isLight) {
            roomLights.push(obj as THREE.Light);
          }
        });
        for (const light of roomLights) light.visible = false;
        gl.compile(scene, camera);
        for (const light of roomLights) light.visible = true;
      } else {
        gl.compile(scene, camera);
      }
      MOUNT_TRACE.compileSyncMs = performance.now() - t0;
    };
    run();
    // The corridor's hide→unmount rides its OWN HIDE_DELAY_MS timer
    // (corridor.tsx, a different reconciler root — effect order across
    // roots is not guaranteed), which can land a commit after this one;
    // recompile once more shortly after so that light-removal is covered
    // either way. A no-change run is pure program-cache hits.
    const timer = setTimeout(run, 150);
    return () => clearTimeout(timer);
  }, [epoch, phase, gl, scene, camera, corridorRef]);
  return null;
}

/**
 * Mount-cost probe (responsiveness): wraps gl.render to wall-clock every
 * render call and ring-buffer [t, ms, programCount] into MOUNT_TRACE.frames.
 * This is where shader compilation shows up: three compiles material
 * programs synchronously inside the render call that first draws them, so
 * the mount frame's render ms IS the compile storm (plus texture uploads).
 * Two performance.now() calls per render pass — negligible next to a draw.
 */
function RenderTrace(): null {
  const gl = useThree((s) => s.gl);
  useEffect(() => {
    const render = gl.render.bind(gl);
    gl.render = (scene: THREE.Object3D, camera: THREE.Camera) => {
      const t0 = performance.now();
      render(scene as THREE.Scene, camera);
      const frames = MOUNT_TRACE.frames;
      frames.push([
        t0,
        performance.now() - t0,
        gl.info.programs ? gl.info.programs.length : -1,
      ]);
      if (frames.length > 300) frames.splice(0, frames.length - 300);
    };
    return () => {
      gl.render = render;
    };
  }, [gl]);
  return null;
}

/* ------------------------------------------------------------------ */
/* GameCanvas                                                          */
/* ------------------------------------------------------------------ */

export default function GameCanvas({
  doors,
  roomDoors,
  timelines,
  onActiveSliceChange,
  focusSlice = null,
}: {
  /** The CORE timeline's door list (newest first) — the spawn hotel. */
  doors: readonly CorridorDoor[];
  /** Strand doors per room, keyed by sliceId — pre-resolved by the data
   *  lane (game-shell.tsx / lib/game/strand-doors.ts). Absent while that
   *  lane is off; rooms then grow no extra doors and nothing here runs. */
  roomDoors?: ReadonlyMap<string, readonly StrandDoorSpec[]>;
  /** The strand hotels (HD4): strand name → its timeline's door list
   *  (newest first), same shape as `doors`. Absent while the strand lane
   *  is off — strand doors then never resolve lit, so no hop can reference
   *  a missing hotel. */
  timelines?: ReadonlyMap<string, readonly CorridorDoor[]>;
  /** Push feed for the narration panel (game-shell.tsx): the mounted
   *  room's slice id, or null in the corridor. Fired from an effect on
   *  activeSpace, so it tracks the door manager exactly. */
  onActiveSliceChange?: (sliceId: string | null) => void;
  /** The shared `?slice=` address (§14): enter the slice's own hotel window
   *  and stand at its door. Resolved once per value, through the same pure
   *  layout math the door manager uses; an unknown id is ignored (the
   *  corridor opens at its spawn, exactly as without the param). */
  focusSlice?: string | null;
}): JSX.Element {
  const t = useTranslations("game");
  const locale = useLocale();
  const reducedMotion = useReducedMotion() ?? false;
  // THE ANCHOR INTERACTION (§13.1): interactRef fires the depart flare +
  // catalog jump when a terminal is in reach (Enter/E key and the
  // GAME_DEBUG.interact probe share it). departingRef latches so a double
  // press can never double-navigate, and freezes movement in GameLoop.
  const [hudAnchor, setHudAnchor] = useState<AnchorHud | null>(null);
  const anchorHudRef = useRef<AnchorHud | null>(null);
  const departingRef = useRef(false);
  const departWatchRef = useRef(false);
  const interactRef = useRef<() => void>(() => {});
  useEffect(() => {
    interactRef.current = () => {
      const anchor = anchorHudRef.current;
      if (anchor === null || departingRef.current) return;
      if (WORLD_TRANSITION.active) return;
      departingRef.current = true;
      TERMINAL_DEPART.t0 = performance.now();
      // The depart flare plays first; then the shell's transition machine
      // takes over — the scripted camera move + dissolve replace this
      // interaction's old instant catalog jump (world-transition.ts). The
      // URL is written at completion, not here.
      window.setTimeout(
        () => WORLD_TRANSITION.hooks.enter?.(anchor.sliceId),
        reducedMotion ? 0 : TERMINAL_FLARE_MS,
      );
    };
  }, [reducedMotion]);
  // The runtime strand-door count for a slice — the data lane's pure
  // derivation (buildRoomDoorMap in game-shell.tsx), read off the map.
  // Every room resolution (prewarm, wall crossing, return landing) freezes
  // THIS value into its ActiveSpace, so a room never depends on when the
  // strand lane resolved relative to the mount.
  const roomDoorCountFor = useCallback(
    (sliceId: string): number => roomDoors?.get(sliceId)?.length ?? 0,
    [roomDoors],
  );
  // App dark mode, read OUTSIDE the Canvas — React context never crosses
  // the R3F reconciler boundary, so it is handed down as plain props.
  const { resolvedTheme } = useTheme();
  const dark = resolvedTheme !== "light";
  const playerRef = useRef<PlayerPos>({ ...SPAWN });
  /** One-shot flag: a hotel hop teleported the player, so the
   *  camera rig snaps its lerped focus instead of gliding (see CameraRig). */
  const cameraSnapRef = useRef(false);
  /** One-frame guard handed to GameLoop: every hotel hop sets it, so the
   *  frame that may still run with the pre-hop closure skips its door
   *  triggers and clamps instead of firing a stale door against the
   *  fresh position (observed: an arrival-door return landing at the
   *  west end re-fired the OLD hotel's page door one frame later). */
  const hopGuardRef = useRef(false);
  // Hotels (HD2/HD3): WHERE the player is — one timeline at one window.
  // The navigation stack records how they got here: each entry is the
  // hotel to return to plus, for a strand-door hop, the room and door the
  // player left by (the return door lands them back inside that room),
  // and the trip's lateral side (§10.5 — which lobby wall the way back
  // hangs on). The stack lives in a ref (mutated from frame handlers);
  // `returnSides` is its render-visible shadow — it gates the lobby's
  // return doors, one per side.
  const [location, setLocation] = useState<HotelRef>({
    timelineId: CORE_TIMELINE_ID,
    windowIndex: 0,
  });
  const navStackRef = useRef<NavEntry[]>([]);
  const [returnSides, setReturnSides] = useState<{
    north: boolean;
    south: boolean;
    east: boolean;
  }>({
    north: false,
    south: false,
    east: false,
  });
  /** Re-derive the render-visible shadow after every stack mutation. */
  const syncNavStack = (): void => {
    setReturnSides(returnDoorSides(navStackRef.current));
  };
  const keysRef = useRef<Set<string>>(new Set());
  const motionRef = useRef<Motion>({ x: 0, z: 0, moving: false });
  const hudIdRef = useRef<string | null>(null);
  const [activeSpace, setActiveSpace] = useState<ActiveSpace | null>(null);
  const [corridorHidden, setCorridorHidden] = useState(false);
  const [hudDoor, setHudDoor] = useState<CorridorDoor | null>(null);
  // The mounted room follows the door manager the instant the wall plane
  // is crossed, and on exit it stays mounted for a short dissolve
  // (fade="out", see SPACE_FADE_S in lib/game/tuning/room.ts) before
  // unmounting — the
  // space neither pre-renders nor pops out of existence.
  const [shownSpace, setShownSpace] = useState<ActiveSpace | null>(null);
  useEffect(() => {
    if (activeSpace !== null) setShownSpace(activeSpace);
  }, [activeSpace]);
  // Narration panel feed (game-shell.tsx): push the mounted room's slice.
  useEffect(() => {
    onActiveSliceChange?.(activeSpace === null ? null : activeSpace.door.sliceId);
  }, [activeSpace, onActiveSliceChange]);
  // ONE CURSOR (v0.13 §6): walking IS moving the shared slice cursor — the
  // room the reader stands in is the slice the cursor names. A QUIET write
  // through the module hook (lib/timeline3d/cursor.ts, the
  // WORLD_TRANSITION.hooks idiom — NOT context: this file's import chain is
  // loaded by the pure-function vitest suites, and the shell provider would
  // drag the chat tree into it). It steers no world, and the focus effect
  // below refuses to re-apply the slice the player is already standing in,
  // so the write cannot yank the walk back to the door. The corridor
  // reports NOTHING: between rooms the cursor keeps the last room — which
  // is exactly the "where was I" the card gate's 回到原来的房间 restores.
  useEffect(() => {
    if (activeSpace !== null) CURSOR_HOOKS.report?.(activeSpace.door.sliceId);
  }, [activeSpace]);
  // Prewarm (responsiveness): the nearest door within ROOM_PREWARM_DIST
  // (GameLoop step 2b) gets its room mounted invisible in the ONE room
  // slot below — geometry built, root group visible=false, so it draws
  // nothing and lights nothing — while LightConfigCompiler precompiles
  // the scene's programs under the new light configuration. Crossing the
  // threshold then only flips the root visible and starts the crossfade
  // on the already-mounted, already-compiled instance (same key), instead
  // of paying construction + the measured ~1 s compile storm inside the
  // visible frame. At most one SpaceScene exists at any moment: the slot
  // holds the shown space when there is one, the prewarm space otherwise.
  const [prewarmDoor, setPrewarmDoor] = useState<DoorRef | null>(null);
  const prewarmIdRef = useRef<string | null>(null);
  // Wrapper around the corridor so LightConfigCompiler can exclude its
  // lights from a proxy compile (compile gathers lights via
  // traverseVisible) without touching corridor.tsx.
  const corridorGroupRef = useRef<THREE.Group>(null);
  // Door-slab handover: the corridor keeps the one physical slab until it
  // unmounts (HIDE_DELAY_MS after the hide threshold); the space's own
  // slab mounts exactly then — never two doors in one frame.
  const [corridorGone, setCorridorGone] = useState(false);
  useEffect(() => {
    if (!corridorHidden) {
      setCorridorGone(false);
      return;
    }
    const timer = setTimeout(() => setCorridorGone(true), HIDE_DELAY_MS);
    return () => clearTimeout(timer);
  }, [corridorHidden]);

  // Strand-door wormhole (doc B.11): the transition's phase lives in a
  // pure reducer (reduceStrandTransition); the effects below only execute
  // its phases — dissolve the current room on latch, release the latch
  // once the destination room is the active space.
  const [strandTransition, setStrandTransition] = useState<StrandTransition>({
    phase: "idle",
  });
  // A latched crossing dissolves the current room exactly like a corridor
  // exit does: activeSpace → null flips the mounted SpaceScene to
  // fade="out" (its onFadedOut handshake below finishes the wormhole).
  useEffect(() => {
    if (strandTransition.phase === "fadingOut" && activeSpace !== null) {
      setActiveSpace(null);
    }
  }, [strandTransition, activeSpace]);
  // Latch release: the hop completes the moment the fade-out handshake has
  // landed the player in the destination hotel's LOBBY (handleFadedOut) —
  // no destination room mounts (§10.2a: arrival is always in the lobby),
  // so mounting flips straight back to idle on the next render.
  useEffect(() => {
    if (strandTransition.phase === "mounting") {
      setStrandTransition(
        reduceStrandTransition(strandTransition, { type: "arrived" }),
      );
    }
  }, [strandTransition]);

  // The CURRENT hotel's door list and its one materialized window (HD2):
  // the core timeline renders `doors`, a strand hotel renders its entry
  // from `timelines`. Every hotel shares one local frame — the window
  // layout re-bases the current window's CHUNK_DOORS bays so the lobby
  // always sits at x ∈ [0, LOBBY_LENGTH) (windowLayout).
  const currentDoors = useMemo(
    () =>
      location.timelineId === CORE_TIMELINE_ID
        ? doors
        : (timelines?.get(location.timelineId) ?? NO_TIMELINE_DOORS),
    [location, doors, timelines],
  );
  // The current hotel's display name — the corridor's header, and the
  // lobby terminal's HUD label: "PREVIOUSLY · Enter" reads as the
  // invitation into the catalog that the machine is.
  const hotelName =
    location.timelineId === CORE_TIMELINE_ID
      ? "PREVIOUSLY"
      : location.timelineId;
  // The lobby hologram's braid: every strand threading the window — the
  // room-door lane's strands for the current window's slices, deduped in
  // first-seen order — plus one context thread per slice in the window
  // (the whole index, where a room claims only its newer neighbors).
  const lobbyHoloStrands = useMemo(() => {
    const out: string[] = [];
    for (const d of currentDoors) {
      for (const door of roomDoors?.get(d.sliceId) ?? []) {
        for (const s of door.strands ?? []) {
          if (!out.includes(s)) out.push(s);
        }
      }
    }
    return out;
  }, [currentDoors, roomDoors]);
  const sliceIds = useMemo(() => currentDoors.map((d) => d.sliceId), [currentDoors]);
  const globalLayout = useMemo(() => corridorLayoutFromDoors(currentDoors), [currentDoors]);
  const layout = useMemo(
    () => windowLayout(globalLayout, location.windowIndex),
    [globalLayout, location.windowIndex],
  );
  const windowIds = useMemo(
    () =>
      sliceIds.slice(
        location.windowIndex * WINDOW_SLICES,
        (location.windowIndex + 1) * WINDOW_SLICES,
      ),
    [sliceIds, location.windowIndex],
  );
  // The far end: a page door while an older window exists, a plain wall
  // at the oldest (§10: "直到尽头就什么都没有了").
  const hasOlder = location.windowIndex + 1 < windowCountForLayout(globalLayout);
  const corridorEnd = useMemo<CorridorEnd>(
    () => ({ endX: chunkBounds(0, layout).xStart, pageDoor: hasOlder }),
    [layout, hasOlder],
  );
  // The hotel's accent (§11.1): brand blue for the core timeline, the
  // strand's deterministic palette accent otherwise.
  const accent =
    location.timelineId === CORE_TIMELINE_ID
      ? HOTEL_ACCENT_CORE
      : strandAccentFor(location.timelineId);
  // Clamp door gaps: the window's materialized doors plus the lobby's
  // NORTH return door (its gap opens the junction's north wall once the
  // nav stack holds a north-lateral trip). The south return door's gap is
  // the lobby clamp's own business (clampToHotel's southReturnDoorX).
  const doorXs = useMemo(() => {
    const xs = materializedDoorXs(windowIds, layout);
    return returnSides.north ? [...xs, RETURN_DOOR_X] : xs;
  }, [windowIds, layout, returnSides]);
  // Probe/e2e mirror: the current window's corridor doors (sliceId +
  // wall-plane position + side) and the data lane's per-slice strand-door
  // counts — probes pick slices and assert §8/§10.5 facts from these
  // instead of walking the corridor blind.
  useEffect(() => {
    GAME_DEBUG.windowDoors = windowIds.map((sliceId, i) => {
      const ref = doorRefForFlatIndex(i, windowIds, layout);
      return {
        sliceId,
        x: ref?.x ?? 0,
        z: ref?.z ?? 0,
        side: (i % 2 === 0 ? "north" : "south") as "north" | "south",
      };
    });
    GAME_DEBUG.doorCounts = roomDoors
      ? Object.fromEntries([...roomDoors.entries()].map(([id, list]) => [id, list.length]))
      : {};
  }, [windowIds, layout, roomDoors]);
  const archetypeById = useMemo(() => {
    const map = new Map<string, ArchetypeId>();
    for (const door of currentDoors) {
      if (door.archetype !== undefined) map.set(door.sliceId, door.archetype);
    }
    return map;
  }, [currentDoors]);
  // 0 for every archetype without water (waterCoverage = 0 → side 0). The
  // scaled view keeps the wade rectangle coincident with the water plane
  // the renderer built.
  const waterSide = useMemo(
    () => (activeSpace !== null ? waterSideFor(activeSpace.scaledRecipe) : 0),
    [activeSpace],
  );
  // The prewarm target's space, resolved through the SAME construction the
  // door manager uses — a prewarmed room is identical to a crossed-into
  // one (A6), including the frozen strand-door count (re-resolved when the
  // door map lands, while the mount is still invisible).
  const prewarmSpace = useMemo(
    () =>
      prewarmDoor === null
        ? null
        : resolveSpaceForDoor(prewarmDoor, archetypeById, roomDoorCountFor(prewarmDoor.sliceId)),
    [prewarmDoor, archetypeById, roomDoorCountFor],
  );
  // The one room slot: the shown space (active or dissolving) wins; the
  // prewarm space fills it while the corridor is walked.
  const mountedSpace = shownSpace ?? prewarmSpace;
  const mountedIsPrewarm = shownSpace === null && mountedSpace !== null;
  // Light-config epoch for LightConfigCompiler: any identity/visibility
  // change that can add or remove scene lights — prewarm mount/unmount,
  // room mount/unmount, the corridor's hide→unmount and return.
  const compileEpoch = `${prewarmDoor?.sliceId ?? ""}|${shownSpace?.recipe.sliceId ?? ""}|${corridorHidden ? 1 : 0}|${corridorGone ? 1 : 0}`;
  // Which configuration the coming renders will need (the proxy compiles
  // are staged per phase — see LightConfigCompiler).
  const compilePhase: "prewarm" | "crossed" | "exit" | "plain" =
    mountedIsPrewarm
      ? "prewarm"
      : shownSpace !== null && corridorHidden && !corridorGone
        ? "crossed"
        : shownSpace !== null && !corridorHidden
          ? "exit"
          : "plain";
  // The active room's plan + placed strand doors for the movement clamp:
  // the same pure derivation (roomGeometryForSpace — template, plan,
  // doors) the mounted SpaceScene renders — one chain, two call sites,
  // identical results (A6). Memoised per room: the per-frame clamp then
  // costs a handful of closed-form compares, never a plan rebuild. The
  // count is the space's OWN frozen value — the same one the renderer's
  // composition resolved with, so the clamp can never relax at a door the
  // room did not draw (or box a floor the room outgrew).
  const activeRoomGeometry = useMemo(
    () =>
      activeSpace === null
        ? null
        : roomGeometryForSpace(activeSpace, activeSpace.roomDoorCount),
    [activeSpace],
  );

  /** Land the player in the CURRENT hotel's lobby, just inside the return
   *  door on the north wall — the arrival point strand-door hops and
   *  unresolvable fallbacks share (§10.2a: arrival is always in the lobby,
   *  the door you came through on the wall behind you). The camera snaps
   *  (STRAND_TELEPORT_CAMERA_SNAP). */
  const arriveInLobby = (): void => {
    playerRef.current = { x: RETURN_DOOR_X, z: WALL_Z - LOBBY_ARRIVAL_INSET };
    cameraSnapRef.current = true;
    hopGuardRef.current = true;
  };

  /** Land the player just inside the CURRENT hotel's EAST arrival door —
   *  the 西出东进 arrival (§10.5): every page-door/travel hop comes in
   *  through the east wall, the way out was the last hotel's west end. */
  const arriveAtEastDoor = (): void => {
    playerRef.current = eastDoorArrivalPos();
    cameraSnapRef.current = true;
    hopGuardRef.current = true;
  };

  /** Page door (HD3): the corridor's far (WEST) end leads to the NEXT-OLDER
   *  window of the same timeline. Push the current hotel as an east-west
   *  trip, page forward, arrive through the (identical) lobby's EAST
   *  arrival door (§10.5 西出东进). */
  const handlePageDoor = (): void => {
    navStackRef.current.push({ hotel: location, returnTo: null, side: "east" });
    syncNavStack();
    setLocation({
      timelineId: location.timelineId,
      windowIndex: location.windowIndex + 1,
    });
    arriveAtEastDoor();
  };

  /** Arrival door (§10.5 西出东进): the lobby's EAST door unwinds the
   *  NEWEST east-west trip and lands the player back at the departure
   *  hotel's WEST end — just inside the page door they left through,
   *  facing the corridor (the exact mirror of handlePageDoor). Trips of
   *  other sides taken after it are walked past, not unwound. */
  const handleArrivalDoor = (): void => {
    const trip = splitReturnTrip(navStackRef.current, "east");
    if (trip === null) return;
    navStackRef.current = trip.rest;
    syncNavStack();
    const entry = trip.entry;
    setLocation(entry.hotel);
    // The departure hotel's west end, resolved inline like handleReturnDoor
    // (the memos above still describe the hotel being left this render).
    const backDoors =
      entry.hotel.timelineId === CORE_TIMELINE_ID
        ? doors
        : (timelines?.get(entry.hotel.timelineId) ?? []);
    const backLayout = windowLayout(
      corridorLayoutFromDoors(backDoors),
      entry.hotel.windowIndex,
    );
    playerRef.current = westEndArrivalPos(chunkBounds(0, backLayout).xStart);
    cameraSnapRef.current = true;
    hopGuardRef.current = true;
  };

  /** Return door (HD3/§10.5): the north/south lobby door unwinds the NEWEST
   *  trip of ITS lateral — trips taken after it (from another side) are
   *  walked past, not unwound. A lateral trip is always a strand-door hop,
   *  so the return lands back INSIDE the room the player left, at the
   *  strand door they left by (HD4) — the thread walk reads as one
   *  continuous passage. (A stray returnTo-null entry still falls back to
   *  the lobby; east-west trips belong to the arrival door.) */
  const handleReturnDoor = (side: Side): void => {
    const trip = splitReturnTrip(navStackRef.current, side);
    if (trip === null) return;
    navStackRef.current = trip.rest;
    syncNavStack();
    const entry = trip.entry;
    setLocation(entry.hotel);
    const returnTo = entry.returnTo;
    if (returnTo === null) {
      arriveInLobby();
      return;
    }
    // Resolve the room in the RESTORED hotel — computed inline, not from
    // the memos above (those still describe the hotel being left this
    // render; they re-derive on the location change).
    const backDoors =
      entry.hotel.timelineId === CORE_TIMELINE_ID
        ? doors
        : (timelines?.get(entry.hotel.timelineId) ?? []);
    const backIds = backDoors.map((d) => d.sliceId);
    const backLayout = windowLayout(
      corridorLayoutFromDoors(backDoors),
      entry.hotel.windowIndex,
    );
    const backWindowIds = backIds.slice(
      entry.hotel.windowIndex * WINDOW_SLICES,
      (entry.hotel.windowIndex + 1) * WINDOW_SLICES,
    );
    const flatIndex = backWindowIds.indexOf(returnTo.sliceId);
    const door =
      flatIndex >= 0
        ? doorRefForFlatIndex(flatIndex, backWindowIds, backLayout)
        : null;
    if (door === null) {
      // The room fell out of its window (the timeline changed under the
      // stack): land in the lobby rather than dropping the return.
      arriveInLobby();
      return;
    }
    const backArchetypes = new Map<string, ArchetypeId>();
    for (const d of backDoors) {
      if (d.archetype !== undefined) backArchetypes.set(d.sliceId, d.archetype);
    }
    const space = resolveSpaceForDoor(
      door,
      backArchetypes,
      roomDoorCountFor(door.sliceId),
    );
    // The strand door the player left by: land just inside the room at
    // that door. placement.index is the placement's index into the room's
    // door list (room-doors.ts), so the spec's own index finds it. The
    // geometry rebuild uses the space's OWN frozen count — resolved just
    // above from the same map — so the landing matches the room as it
    // stands now.
    const specs = roomDoors?.get(door.sliceId) ?? [];
    const specIndex = specs.findIndex((s) => s.key === returnTo.key);
    const placement =
      specIndex >= 0
        ? roomGeometryForSpace(space, space.roomDoorCount).doors.find(
            (pl) => pl.index === specIndex,
          )
        : undefined;
    if (placement === undefined) {
      // The strand door is gone from the room (the door set changed):
      // arrive by the corridor entrance instead.
      playerRef.current = {
        x: door.x,
        z: door.z + Math.sign(door.z) * STRAND_DOOR_ARRIVAL_INSET,
      };
    } else {
      // Placement frame → world (mirror of clampToSpace's local frame):
      // lx = (x − door.x)·dir, lz = (z − door.z)·dir.
      const dir = door.z > 0 ? 1 : -1;
      const lx = placement.x + placement.nx * STRAND_DOOR_ARRIVAL_INSET;
      const lz = placement.z + placement.nz * STRAND_DOOR_ARRIVAL_INSET;
      playerRef.current = { x: door.x + dir * lx, z: door.z + dir * lz };
    }
    cameraSnapRef.current = true;
    hopGuardRef.current = true;
    setShownSpace(null);
    MOUNT_TRACE.tRequest = performance.now();
    setActiveSpace(space);
  };

  /** Room-renderer callback: the player walked through the strand door
   *  `key`. The reducer re-validates everything (lit, a real destination
   *  hotel, a room actually active) before latching. */
  const handleRoomDoor = (key: string): void => {
    const spec = roomDoors
      ?.get(activeSpace?.recipe.sliceId ?? "")
      ?.find((d) => d.key === key);
    setStrandTransition((prev) =>
      reduceStrandTransition(prev, {
        type: "cross",
        key,
        lit: spec?.lit ?? false,
        destination: spec?.destination ?? null,
        current: activeSpace === null ? null : location,
      }),
    );
  };

  /** SpaceScene fade-out handshake: either the ordinary corridor exit
   *  (unmount the dissolved room) or, with a crossing latched, the hop's
   *  midpoint — push the current hotel (remembering the room and strand
   *  door the player is leaving by, for the return door) and land in the
   *  destination hotel's LOBBY (§10.2a: arrival is always in the lobby;
   *  the destination room does NOT mount). */
  const handleFadedOut = (): void => {
    if (strandTransition.phase !== "fadingOut") {
      setShownSpace(null);
      return;
    }
    if (shownSpace === null) {
      // The room vanished mid-fade: abort the crossing — there is nothing
      // to leave from any more, and nothing to bring back.
      setStrandTransition(reduceStrandTransition(strandTransition, { type: "abort" }));
      return;
    }
    navStackRef.current.push({
      hotel: location,
      returnTo: { sliceId: shownSpace.door.sliceId, key: strandTransition.key },
      // §10.5: the lateral this trip came in from — the corridor wall the
      // departed room's door hangs on — so the destination lobby hangs the
      // way back on the matching wall.
      side: shownSpace.door.side,
    });
    syncNavStack();
    setLocation(strandTransition.destination);
    setShownSpace(null);
    arriveInLobby();
    setStrandTransition(reduceStrandTransition(strandTransition, { type: "fadedOut" }));
  };

  // Probe/e2e debug handle on window (GAME_DEBUG is updated every frame).
  // `travel` hops straight to any hotel (nav stack pushed, east-door
  // arrival) so probes and e2e can reach strand hotels without walking the
  // thread; the optional side fakes the trip's side (§10.5) so every
  // return-door wall is reachable from a probe — a faked lateral lands in
  // the lobby by its own wall's door.
  useEffect(() => {
    GAME_DEBUG.teleport = (x, z) => {
      playerRef.current.x = x;
      playerRef.current.z = z;
    };
    GAME_DEBUG.travel = (timelineId, windowIndex, side = "east") => {
      navStackRef.current.push({ hotel: location, returnTo: null, side });
      syncNavStack();
      setLocation({ timelineId, windowIndex });
      if (side === "east") arriveAtEastDoor();
      else arriveInLobby();
    };
    // Probe/e2e: the anchor interaction itself — fires only when a
    // terminal is in reach, exactly like the Enter/E key.
    GAME_DEBUG.interact = () => interactRef.current();
    window.__gameDebug = GAME_DEBUG;
    window.__gameMountTrace = MOUNT_TRACE;
    return () => {
      GAME_DEBUG.teleport = undefined;
      GAME_DEBUG.travel = undefined;
      GAME_DEBUG.interact = undefined;
      delete window.__gameDebug;
      delete window.__gameMountTrace;
    };
  }, [location]);

  // ── THE SHARED ADDRESS (?slice=, §14) ──────────────────────────────────
  // The field focuses the slice's card; the game stands at the slice's DOOR,
  // in the hotel window that holds it. Resolution reuses the return door's
  // own math (flat index → window → door position); the hotel hop itself is
  // the same setLocation + snap + one-frame guard every handler here uses,
  // minus the nav stack — a deep link ARRIVES, it does not travel. The core
  // timeline is searched first, then each strand hotel (they resolve a frame
  // later than the core doors, so an unresolved id simply waits for them).
  //
  // THE ONE-CURSOR GUARD (v0.13 §6): the cursor now ALSO moves when the
  // reader walks — the room mount above reports it, and the shell hands the
  // same address back as this prop. Re-applying THAT slice would teleport
  // the player out of the room they just entered and onto its door. Standing
  // inside the addressed slice's room IS standing at the address: mark it
  // applied and leave the walk alone.
  const focusAppliedRef = useRef<string | null>(null);
  useEffect(() => {
    if (!focusSlice || focusAppliedRef.current === focusSlice) return;
    if (activeSpace?.door.sliceId === focusSlice) {
      focusAppliedRef.current = focusSlice;
      return;
    }
    let timelineId = CORE_TIMELINE_ID;
    let list: readonly CorridorDoor[] = doors;
    let idx = doors.findIndex((d) => d.sliceId === focusSlice);
    if (idx < 0 && timelines) {
      for (const [name, strandDoors] of timelines) {
        const i = strandDoors.findIndex((d) => d.sliceId === focusSlice);
        if (i >= 0) {
          timelineId = name;
          list = strandDoors;
          idx = i;
          break;
        }
      }
    }
    if (idx < 0) return;
    focusAppliedRef.current = focusSlice;
    const windowIndex = Math.floor(idx / WINDOW_SLICES);
    const layout = windowLayout(corridorLayoutFromDoors(list), windowIndex);
    const windowIds = list.slice(
      windowIndex * WINDOW_SLICES,
      (windowIndex + 1) * WINDOW_SLICES,
    );
    const door = doorRefForFlatIndex(idx % WINDOW_SLICES, windowIds.map((d) => d.sliceId), layout);
    if (timelineId !== location.timelineId || windowIndex !== location.windowIndex) {
      setLocation({ timelineId, windowIndex });
    }
    if (door) {
      playerRef.current = { x: door.x, z: 0 };
      cameraSnapRef.current = true;
      hopGuardRef.current = true;
    }
  }, [focusSlice, doors, timelines, location, activeSpace]);

  // Keyboard: track pressed keys, swallow the arrows' page scroll, and clear
  // the set on window blur so a released key can never stick.
  useEffect(() => {
    const pressed = keysRef.current;
    function isEditableTarget(target: EventTarget | null): boolean {
      return (
        target instanceof HTMLElement &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.isContentEditable)
      );
    }
    function onKeyDown(event: KeyboardEvent): void {
      const key = event.key.toLowerCase();
      // THE ANCHOR INTERACTION (§13.1): Enter (the same word the door
      // prompt shows) or E fires the terminal in reach. Only swallowed
      // when one IS in reach, so focused buttons and inputs keep their
      // default keys otherwise.
      if (key === "enter" || key === "e") {
        if (isEditableTarget(event.target)) return;
        if (anchorHudRef.current !== null) {
          event.preventDefault();
          interactRef.current();
        }
        return;
      }
      if (!HANDLED_KEYS.has(key) || isEditableTarget(event.target)) return;
      event.preventDefault();
      pressed.add(key);
    }
    function onKeyUp(event: KeyboardEvent): void {
      pressed.delete(event.key.toLowerCase());
    }
    function onBlur(): void {
      pressed.clear();
    }
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur);
    };
  }, [keysRef]);

  // THE CANVAS IS THE SHELL'S (§14 merge). This component keeps every
  // cross-module decision and the DOM HUD; the scene subtree renders in the
  // app's ONE shared canvas through the world slot (`useWorldScene`). The
  // renderer-level props the old standalone canvas carried moved to the
  // WORLD CONTRACT (world-canvas.tsx / world-contract.ts), applied whenever
  // the game world is mounted:
  //   shadows → PCFShadowMap (three 0.185 deprecated PCFSoft; the shared
  //   canvas declares it via fiber's object form, world-canvas.tsx),
  //   AgX tone mapping (saturated accents clip under the ACES default),
  //   and the §14.1 frameloop freeze is the shared canvas's `paused` prop.
  // Softer shadows stay rejected: VSM leaks through thin interior geometry,
  // drei <SoftShadows> recompiles every material per streamed room, and
  // AccumulativeShadows needs a static scene.
  //
  // Registered on every render — the element is a description, and this
  // component re-renders only when its own state does — under the game
  // world's kind (the slot is per-world now; a transition keeps both
  // worlds registered, and the canvas portals each into its own scene).
  useWorldScene(
    "game",
    <>
      <Atmosphere space={activeSpace} dark={dark} playerRef={playerRef} />
        <RenderTrace />
        {/* The stage pool under the diorama — kills the featureless void
            around the model. One named constant reverts it:
            STAGE_BACKDROP_ENABLED (tuning/render.ts). */}
        {STAGE_BACKDROP_ENABLED && (
          <StageBackdrop space={activeSpace} dark={dark} playerRef={playerRef} />
        )}
        {/* One scene-wide IBL: a few broad Lightformer cards baked into an
            env map (no HDRI, no assets). This is the soft fill of the
            key/fill/ambient hierarchy and the shared reflection source for
            every PBR material the material lanes author. */}
        <Environment resolution={ENV_RESOLUTION} environmentIntensity={ENV_INTENSITY}>
          {ENV_FORMERS.map((f, i) => (
            <Lightformer
              key={i}
              form={f.form}
              color={f.color}
              intensity={f.intensity}
              position={[f.position[0], f.position[1], f.position[2]]}
              rotation={[f.rotation[0], f.rotation[1], f.rotation[2]]}
              scale={[f.scale[0], f.scale[1], f.scale[2]]}
            />
          ))}
        </Environment>
        <CameraRig playerRef={playerRef} space={activeSpace} snapRef={cameraSnapRef} />
        {/* The corridor dissolves the moment a space engages (GameLoop above)
          and unmounts HIDE_DELAY_MS later; on return it remounts dark and
          eases back up. The wrapper group lets LightConfigCompiler stage
          light configurations around it (visibility flips that no render
          ever sees). */}
        <group ref={corridorGroupRef}>
          <Corridor
            playerRef={playerRef}
            doors={currentDoors}
            windowIndex={location.windowIndex}
            accent={accent}
            returnDoors={returnSides}
            hotelName={hotelName}
            dimmed={corridorHidden}
            dark={dark}
          />
          {/* The lobby's anchor hologram (§13.1): one size bigger, the
              window's whole braid (every threading strand + every slice
              as a context thread). Lives in the corridor wrapper so it
              unmounts with the corridor (HIDE_DELAY_MS after a room
              engages) and eases down with the same dissolve (`dimmed`).
              Emissive-only, so the light configuration — and the compile
              budget — never changes. */}
          {!corridorGone && (
            <group
              position={[
                LOBBY_TERMINAL_ANCHOR.x,
                0,
                LOBBY_TERMINAL_ANCHOR.z,
              ]}
              rotation={[0, LOBBY_TERMINAL_ANCHOR.rotY, 0]}
              scale={LOBBY_TERMINAL_ANCHOR.scale}
            >
              <AnchorHologram
                dimmed={corridorHidden}
                strands={lobbyHoloStrands}
                neighborSlots={currentDoors.length}
              />
            </group>
          )}
        </group>
        <PlayerAvatar
          playerRef={playerRef}
          motionRef={motionRef}
          space={activeSpace}
          waterSide={waterSide}
        />
        {mountedSpace !== null && (
          <SpaceScene
            key={mountedSpace.recipe.sliceId}
            recipe={mountedSpace.recipe}
            door={mountedSpace.door}
            playerRef={playerRef}
            corridorGone={corridorGone}
            fade={activeSpace !== null || mountedIsPrewarm ? "in" : "out"}
            prewarm={mountedIsPrewarm}
            onFadedOut={handleFadedOut}
            roomDoors={roomDoors?.get(mountedSpace.recipe.sliceId)}
            roomDoorCount={mountedSpace.roomDoorCount}
            onRoomDoor={handleRoomDoor}
          />
        )}
        <LightConfigCompiler
          epoch={compileEpoch}
          phase={compilePhase}
          corridorRef={corridorGroupRef}
        />
        <GameLoop
          playerRef={playerRef}
          keysRef={keysRef}
          motionRef={motionRef}
          doors={currentDoors}
          sliceIds={windowIds}
          doorXs={doorXs}
          layout={layout}
          corridorEnd={corridorEnd}
          returnDoorX={returnSides.north ? RETURN_DOOR_X : null}
          returnDoorSouthX={returnSides.south ? RETURN_DOOR_SOUTH_X : null}
          eastArrivalDoor={returnSides.east}
          onPageDoor={handlePageDoor}
          onReturnDoor={handleReturnDoor}
          onArrivalDoor={handleArrivalDoor}
          hopGuard={hopGuardRef}
          hotelLabel={`${location.timelineId}@${location.windowIndex}`}
          archetypeById={archetypeById}
          activeSpace={activeSpace}
          setActiveSpace={setActiveSpace}
          corridorHidden={corridorHidden}
          setCorridorHidden={setCorridorHidden}
          hudIdRef={hudIdRef}
          setHudDoor={setHudDoor}
          prewarmIdRef={prewarmIdRef}
          setPrewarmDoor={setPrewarmDoor}
          transitionActive={strandTransition.phase !== "idle"}
          roomDoors={activeRoomGeometry?.doors ?? []}
          roomDoorCountFor={roomDoorCountFor}
          roomPlan={activeRoomGeometry?.plan ?? NO_ROOM_PLAN}
          roomSeams={activeRoomGeometry?.seams ?? NO_ROOM_SEAMS}
          roomTerminal={activeRoomGeometry?.terminal ?? null}
          lobbyAnchorLabel={hotelName}
          departingRef={departingRef}
          departWatchRef={departWatchRef}
          anchorHudRef={anchorHudRef}
          setHudAnchor={setHudAnchor}
        />
        {/*
          Post chain — deliberately conservative. N8AO (half-res) adds
          screen-space contact shading, Bloom (threshold 1.0) glows only
          what is genuinely hot (emissive fixtures, sun pools), and a mild
          Vignette closes the frame. AO + vignette are the depth cue that
          replaced scene fog: both are camera-distance INDEPENDENT, so
          neither can wash the whole room into a veil the way distance fog
          did from this camera (commits 9116243/09c757b). Export names
          verified against @react-three/postprocessing v3 dist .d.ts.
        */}
        <EffectComposer multisampling={POST_MSAA_SAMPLES}>
          <N8AO
            halfRes
            quality="performance"
            intensity={AO_INTENSITY}
            aoRadius={AO_RADIUS}
            distanceFalloff={AO_DISTANCE_FALLOFF}
          />
          <Bloom
            mipmapBlur
            intensity={BLOOM_INTENSITY}
            luminanceThreshold={BLOOM_LUMINANCE_THRESHOLD}
            luminanceSmoothing={BLOOM_LUMINANCE_SMOOTHING}
          />
          <Vignette offset={VIGNETTE_OFFSET} darkness={VIGNETTE_DARKNESS} />
        </EffectComposer>
    </>
  );

  return (
    <div className="relative h-full w-full">
      <Hud door={hudDoor} anchor={hudAnchor} enterHint={t("enter")} />
    </div>
  );
}
