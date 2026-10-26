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
 * CAMERA. Fixed 43° RTS view from southeast (+X, −Z; north is +Z).
 * The orthographic rig follows the player in the corridor and frames the
 * room's bounds inside a space, with a small amount of player follow.
 * Focus and zoom ease to their targets; a hotel hop snaps the focus.
 * rtsRoomZoom fits the actual scaled dimensions to the current viewport.
 *
 * MOVEMENT & CLAMPS. WASD + arrow keys move the player on the XZ plane at
 * 4 m/s in the corridor, delta-time corrected, screen-relative (screen-up
 * is world (−x, +z), screen-right (−x, −z) for this camera — verified
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
 * an ambient-led illustration hierarchy (matte overhaul, v0.11-streams):
 * the directional "sun" is the STUDIO key in the corridor and outdoor-class
 * sets, and a controlled shadow-casting face light at ROOM_INTERIOR_SUN_FILL
 * inside interior rooms. The lifted AMBIENT term owns the stable sage/cream
 * diffuse floor; window and lamp fixtures add only quiet local accents. The
 * sun's shadow camera follows the player so the whole streaming corridor
 * and every space stay inside the frustum. No exposure or tone-mapping
 * compensation is applied: the active EffectComposer uses NoToneMapping,
 * pinned by the shared world transition.
 *
 * DEPTH CUE. There is NO scene fog
 * anywhere: with the camera ~23m above the player, every fog band that
 * could sell depth also washed the whole visible room into the fog color
 * (commits 9116243/09c757b/d9edf93 — do not re-add). Depth is carried by
 * things that are camera-distance INDEPENDENT instead: the background
 * color and the post chain — N8AO (screen-space contact shading), the
 * game's only live effect, which darkens by geometry, never by distance
 * from the camera, so it cannot reproduce the translucent-room bug. The
 * stage backdrop disc, Bloom and Vignette were removed in the matte
 * overhaul (no all-over veil, no blown light blobs, no frame-edge
 * darkening).
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
import { OrthographicCamera, PerspectiveCamera } from "@react-three/drei";
import { EffectComposer, N8AO } from "@react-three/postprocessing";
import { useTranslations, useLocale } from "next-intl";
import { useReducedMotion } from "motion/react";
import { useTheme } from "@teispace/next-themes";
import type { ComponentRef, JSX, MutableRefObject, ReactNode } from "react";
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
  TERMINAL_H,
  TERMINAL_REACH_LOBBY,
  type TerminalAnchor,
} from "@/lib/game/anchor";
import {
  WORLD_TRANSITION,
  hotelShotPose,
  type FollowPose,
} from "@/lib/timeline3d/world-transition";
import {
  createFrozenFrameRepaintPlanner,
  renderFrozenComposerOnce,
  type FrozenFrameGeometry,
  type FrozenFrameRepaintPlanner,
} from "@/lib/timeline3d/frozen-frame";
import { GAME_SIM_FREEZE } from "./sim-freeze";
import { GameTimeOwner, useGameFrame } from "./use-game-frame";
import { gameElapsed } from "./game-time";
import { hotelDataEpoch } from "@/lib/game/hotel-data";
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
import { debugSliceIdWithoutSkin, isDebugSlice } from "@/lib/game/debug-slice";
import { compileSpaceRecipe } from "@/lib/game/space-recipe";
import { getBrowserRoomProfileCache, type RoomProfileRequest, type RoomProfileCacheResult } from "@/lib/game/room-profile-cache";
import { NEUTRAL_ROOM_PROFILE, type RoomProfile } from "@/lib/game/room-profile";
import {
  ROOM_SNAPSHOT_GENERATOR_VERSION,
  type RoomSnapshot,
} from "@/lib/game/room-snapshot";
import {
  clampToThreshold,
  decideGate,
  roomProfileSourceScope,
} from "@/lib/game/room-intent";
import { rtsRoomZoom, scenarioPalette, shouldInteractWithScene } from "@/lib/game/scenario-art";
import type { ArchetypeId, SpaceRecipe } from "@/lib/game/space-types";
import {
  CORE_TIMELINE_ID,
  strandAccentFor,
  type StrandDestination,
} from "@/lib/game/strand-doors";
import {
  roomPlanFor,
  scaledRecipeFor,
  scaledWallHeight,
  wallSegmentsFor,
  composeRoom,
  type RoomPlan,
  type ScaleNotation,
} from "@/lib/game/room-plan";
import {
  CHASE_AVATAR_FADE,
  CHASE_BOOM,
  CHASE_CAM_HEIGHT,
  CHASE_FOV,
  CHASE_LIVE,
  CHASE_MIN_DIST,
  CHASE_PIVOT_HEIGHT,
  CHASE_POS_RATE,
  CHASE_PROBE_RADIUS,
  CHASE_PULL_IN_RATE,
  CHASE_PUSH_OUT_RATE,
  CHASE_YAW_RATE,
  TOPDOWN_YAW,
  castBoom,
  corridorSolids,
  moveBasisFor,
  roomSolids,
  type GameCameraMode,
  type SolidBox,
} from "@/lib/game/chase-camera";
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
import {
  PAPER_REACH,
  roomPaperSpotsFor,
  type RoomPaperSpot,
} from "@/lib/game/room-papers";
import {
  getRoomPapers,
  type RoomPaper,
} from "@/lib/archive/actions";
import { ROOM_PAPER_LIMIT } from "@/lib/archive/refs";
import { type RoomPaperItem } from "./room-papers";
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
  CAMERA_LERP_RATE,
  CAMERA_ZOOM,
  CAM_OFFSET,
  CORRIDOR_AMBIENT,
  DOOR_GRAB_DIST,
  GROUND_LERP_RATE,
  HUD_DIST,
  PLAYER_BODY,
  PLAYER_HAIR,
  PLAYER_HEAD,
  PLAYER_LEG,
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

/** A tap-to-walk target (touch: tap a door or the terminal). Manual input
 *  (keys or the stick) cancels it the frame it appears; arrival fires the
 *  anchor interaction when the tap named a terminal. */
interface WalkTarget {
  active: boolean;
  x: number;
  z: number;
  /** Arrival radius (m): a door's threshold, the terminal's reach. */
  arrive: number;
  /** Fire the interaction on arrival (a tapped terminal). */
  interact: boolean;
  /** No-progress timer (s) — a wall the clamp won't pass cancels the walk. */
  still: number;
  lastD: number;
}

/** A corridor door's readiness verdict — the synchronous half of the
 *  profile lane. `ready` carries the fully resolved space (recipe compiled
 *  with the peeked profile, snapshot frozen) and mounts the same frame it
 *  is returned; `hold` keeps the player at the threshold with the gate's
 *  status (`loading` — read in flight, `retry` — failed, user decides). */
type RoomReadiness =
  | { kind: "ready"; space: ActiveSpace }
  | { kind: "hold"; status: "loading" | "retry" };

/** The one space that may be mounted at a time. `recipe` is the authored
 *  recipe (palette, archetype); `scaledRecipe` is the same recipe with the
 *  room-language scale notation applied to its plan dims — the ONE scaled
 *  view (room-plan.ts) that the renderer, the movement clamp, and the
 *  avatar physics all share. `roomDoorCount` is the strand-door count the
 *  space was resolved with, FROZEN at the wall crossing (the data lane's
 *  pure derivation for the slice): the composition that sized scaledRecipe
 *  grew by it (§8.4), and freezing it here keeps the renderer and the
 *  clamp on one value for the whole visit — the room can never morph
 *  mid-stay when the strand lane resolves after the mount.
 *
 *  `snapshot` is the frozen VISUAL CONTRACT of this exact visit (v0.13 §5):
 *  the bounded semantic profile the recipe compiled with, the strand-door
 *  count, and the corridor side — everything the clamp, the renderer, the
 *  return door and the chat view's describe-room snapshot ride, so a room
 *  mounted by ANY path (wall crossing, prewarm, return landing) describes
 *  itself identically. Never seeded into any RNG: the snapshot freezes
 *  state, it never perturbs the streams. */
interface ActiveSpace {
  door: DoorRef;
  recipe: SpaceRecipe;
  scaledRecipe: SpaceRecipe;
  scale: ScaleNotation;
  roomDoorCount: number;
  snapshot: RoomSnapshot;
}

/** The complete, frozen visual state of the room behind `door` for one
 *  visit — the single snapshot construction every mount path shares
 *  (room-snapshot.ts is the wire schema; this is its in-scene twin). */
function buildSnapshotForDoor(
  door: DoorRef,
  profile: RoomProfile,
  roomDoorCount: number,
): RoomSnapshot {
  return Object.freeze({
    sliceId: door.sliceId,
    generatorVersion: ROOM_SNAPSHOT_GENERATOR_VERSION,
    profile,
    roomDoorCount,
    corridorSide: door.side,
  });
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

/** The lobby's camera-occlusion blockers (v0.28): the front desk, the
 *  armchairs, and the anchor terminal at their drawn heights — the chase
 *  rig's sphere cast keeps out of the furniture the player also cannot
 *  walk through (LOBBY_BLOCKERS / LOBBY_TERMINAL_BLOCKER). The sight
 *  line (1.35 → 1.9 m) clears anything lower than ~1.45 m, so in
 *  practice these bind only close up. Module-level: the inputs are
 *  constants. */
const LOBBY_SOLID_BLOCKERS: readonly SolidBox[] = [
  ...LOBBY_BLOCKERS.map((b, i) => ({ ...b, y1: i === 0 ? 1.1 : 0.9 })),
  {
    x0: LOBBY_TERMINAL_BLOCKER.x0,
    x1: LOBBY_TERMINAL_BLOCKER.x1,
    z0: LOBBY_TERMINAL_BLOCKER.z0,
    z1: LOBBY_TERMINAL_BLOCKER.z1,
    y1: TERMINAL_H * LOBBY_TERMINAL_ANCHOR.scale,
  },
];

type PlayerRef = MutableRefObject<PlayerPos>;

/** The anchor HUD payload (§13.1) — set while the player stands in reach
 *  of the lobby's terminal (the ONE live machine; v0.29 retired the
 *  per-room terminals); wins over the door prompt in the Hud. `x`/`z`/
 *  `faceX`/`faceZ` are the terminal's world pose (the interaction point
 *  and the direction the terminal faces): the transition's scripted
 *  camera shot descends to it, so the thing the camera flies to is the
 *  thing the loop measured. `kind` keeps the retired "room" variant so
 *  the probe mirror's contract (GAME_DEBUG.anchor) stays readable. */
interface AnchorHud {
  kind: "room" | "lobby";
  sliceId: string;
  label: string;
  x: number;
  z: number;
  faceX: number;
  faceZ: number;
}

/** The paper HUD payload (v0.25a §五 B②) — set while the player stands in
 *  reach of a loose sheet AND the sheet is nearer than the anchor terminal
 *  (the loop arbitrates: the closer interaction wins the prompt AND the
 *  interact key). `x`/`z` are the sheet's world position. */
interface PaperHud {
  ref: string;
  title: string;
  x: number;
  z: number;
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
 * Screen-relative key directions in the CANONICAL screen frame ([right,
 * up] — W/↑ is screen-up, D/→ is screen-right). The world-space direction
 * comes from rotating this vector by the camera's live yaw (moveBasisFor,
 * chase-camera.ts): at TOPDOWN_YAW the result is byte-identical to the
 * legacy fixed-camera diagonals (screen-up = world (+x, −z)/√2), so the
 * top-down debug mode keeps the old movement exactly and the chase rig's
 * "left on screen is left in the world" falls out of the same formula.
 */
const KEY_DIRS: Record<string, readonly [number, number]> = {
  w: [0, 1],
  arrowup: [0, 1],
  s: [0, -1],
  arrowdown: [0, -1],
  a: [-1, 0],
  arrowleft: [-1, 0],
  d: [1, 0],
  arrowright: [1, 0],
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

/** Move vector in the SCREEN frame ([right, up], unit-clamped) for the
 *  pressed keys — the GameLoop rotates it by the live camera basis. */
function moveVectorFromKeys(keys: ReadonlySet<string>): { rx: number; up: number } {
  let rx = 0;
  let up = 0;
  for (const key of keys) {
    const dir = KEY_DIRS[key];
    if (dir) {
      rx += dir[0];
      up += dir[1];
    }
  }
  const len = Math.hypot(rx, up);
  if (len > 1) {
    rx /= len;
    up /= len;
  }
  return { rx, up };
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
 * the palette's own value (scaled by SPACE_AMBIENT_SCALE; a space's
 * lighting is seed-fixed, not part of the app dark mode). No fog targets
 * exist: scene fog has been removed
 * entirely (the camera geometry made any usable band wash the whole room).
 */
function resolveAtmosphere(
  space: ActiveSpace | null,
  dark: boolean,
  out: AtmosphereTargets,
): AtmosphereTargets {
  if (space !== null) {
    const palette = scenarioPalette(space.recipe.palette, dark);
    // The sage backdrop matches the room's material family. There is no
    // scene fog to target (removed — see Atmosphere).
    out.background.set(palette.fog);
    out.sunColor.set(palette.sunColor);
    // INTERIOR rooms get the directional at FILL level only, while
    // outdoor-class sets keep it at full strength as the soundstage's
    // overall key. The interior fill keeps casting so furniture stays
    // grounded; the lifted ambient owns the broad tonal floor and the
    // fixtures add only local accents.
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
   * the room renderer labels one door per entry.
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
  readonly returnTo: {
    readonly sliceId: string;
    readonly key: string;
    /** The room's frozen visual contract at departure (v0.13 §5): the
     *  return landing restores THE ROOM THE PLAYER LEFT — same profile,
     *  same strand-door count — with zero network and no re-derive. Old
     *  entries pushed before snapshots existed simply carry none and take
     *  the prepare path. */
    readonly snapshot?: RoomSnapshot;
  } | null;
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
 *  by the door manager's wall-crossing mount, the prewarm's invisible
 *  mount, and the return door's back-into-the-room landing, so a room
 *  mounted any way is identical (recipe, archetype override, the single
 *  scaled view the clamps and terrain consume, and the frozen snapshot).
 *  `roomDoorCount` is the strand-door count for this slice AT RESOLUTION
 *  TIME — frozen into the space (see ActiveSpace), so every consumer of
 *  the room shares one value.
 *
 *  THE PROFILE LANE (v0.13): a committable `profile` (peeked ready, a
 *  definitive missing, or an explicit user-chosen fallback) compiles into
 *  the recipe here — pinned archetype, never a reseed (space-recipe.ts).
 *  Absent (gallery/debug doors, prepare still in flight) the legacy
 *  byte-for-byte recipe compiles and the snapshot records the neutral
 *  profile. A saved `snapshot` (the return door's way back into the room
 *  the player left) wins only while it truly describes THIS door — same
 *  slice, same corridor side, same generator version — so a stale saved
 *  view can never print over a different door. */
function resolveSpaceForDoor(
  door: DoorRef,
  archetypeById: ReadonlyMap<string, ArchetypeId>,
  roomDoorCount: number = 0,
  profile?: RoomProfile,
  snapshot?: RoomSnapshot,
): ActiveSpace {
  const saved = snapshot?.sliceId === door.sliceId &&
    snapshot.generatorVersion === ROOM_SNAPSHOT_GENERATOR_VERSION &&
    snapshot.corridorSide === door.side ? snapshot : undefined;
  const visitProfile = saved?.profile ?? profile ?? NEUTRAL_ROOM_PROFILE;
  const visitDoorCount = saved?.roomDoorCount ?? roomDoorCount;
  // P3-b1: the recipe compiles from the SKIN-STRIPPED id — the skin is a
  // view-layer force and must never perturb the room's own streams
  // (palette/size/lightSeed feed every downstream seed, composition and
  // scale notation included). The raw id survives on `space.door`,
  // where the view layer (skinForSlice, probe mirrors) reads it.
  // Identity for every non-skinned id, so the default path is untouched.
  const recipe = compileSpaceRecipe(
    debugSliceIdWithoutSkin(door.sliceId),
    WORLD_SEED,
    visitProfile,
  );
  const archetype = archetypeById.get(door.sliceId);
  const finalRecipe = archetype === undefined || visitProfile.activity !== "neutral"
    ? recipe : { ...recipe, archetype };
  const { recipe: scaledRecipe, scale } = scaledRecipeFor(finalRecipe, visitDoorCount);
  const frozen = saved ?? buildSnapshotForDoor(door, visitProfile, visitDoorCount);
  return { door, recipe: finalRecipe, scaledRecipe, scale, roomDoorCount: visitDoorCount, snapshot: frozen };
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
 * The room's terminal anchor is STILL resolved here — not for the world
 * (v0.29: the per-room machine is retired) but as the loose papers' own
 * layout input (room-papers.ts keeps its sheets out of the footprint the
 * resolver reports, so the rooms' paper layouts stay byte-identical to
 * the ones the live machine produced).
 */
function roomGeometryForSpace(
  space: ActiveSpace,
  count: number,
): {
  plan: RoomPlan;
  doors: readonly RoomDoorPlacement[];
  seams: readonly SeamWall[];
  /** The loose papers' floor spots (v0.25a §五 B②) — the MAXIMUM count
   *  (ROOM_PAPER_LIMIT); the async document list renders a prefix, and the
   *  resolver's prefix stability keeps the drawn sheets put. */
  paperSpots: RoomPaperSpot[];
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
  const terminal = terminalForSpace(space, plan);
  // The papers' spots take the terminal resolver's own inputs (A6 — the
  // same composeRoom staging, the same scaled water rect); terminalForSpace
  // derives its comp internally, so the compose call here is the papers'
  // own copy of the same pure result.
  const paperSpots = roomPaperSpotsFor({
    sliceId: recipe.sliceId,
    plan,
    comp: composeRoom(recipe.sliceId, plan, scaleFactor),
    width,
    wallThick,
    water: waterRectFor(scaledRecipe),
    terminal,
    count: ROOM_PAPER_LIMIT,
  });
  if (count <= 0) {
    return { plan, doors: [], seams, paperSpots };
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
  return { plan, doors, seams, paperSpots };
}

/**
 * The retired room terminal's anchor, resolved through the same pure
 * inputs the room was built from: the composition over the same plan at
 * the same scale factor, the renderer's wall thickness, the prop scale
 * (scaleFactor^PROP_SCALE_EXP — the room's furniture scale), and the
 * scaled water rect. Called from roomGeometryForSpace only, as the loose
 * papers' layout input (v0.29 — nothing renders the machine any more).
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

/**
 * THE RIG (v0.28). Default: a third-person CHASE camera — pivot at the
 * avatar's chest (CHASE_PIVOT_HEIGHT), a boom CHASE_BOOM back and
 * CHASE_CAM_HEIGHT up, FOV CHASE_FOV, focus damped at the repo's λ≈12,
 * yaw following the avatar's heading lazily while it moves (auto-follow,
 * never a snap, no look control in v1). Occlusion is a SPHERE CAST from
 * the pivot toward the desired position against the analytic solids
 * (chase-camera.ts — the same data the movement clamps use, never render
 * meshes): on a hit the boom shortens FAST (an occluded camera is a wrong
 * state, not a smoothed one) and relaxes back SLOW; at/under
 * CHASE_MIN_DIST the avatar fades (CHASE_LIVE.fade) instead of the camera
 * entering its head. Ceilings (v0.29 — corridor.tsx's HallCeiling and
 * space.tsx's RoomEnvelope) hide themselves whenever the camera rides
 * above the wall top, so they never occlude the chase rig's sight line
 * from inside and never need a cast solid; camera-facing walls are solid
 * to the cast only up to their DRAWN sill height, which the sight line
 * clears (see chase-camera.ts).
 *
 * `?view=game&camera=top` (mode "top") keeps the legacy fixed 45°
 * orthographic dollhouse byte-for-byte — the in-place comparison switch.
 *
 * Both modes feed the world transition's scripted shot (world-transition
 * hotelShotPose): the chase rig reports its live pose with zoom 1, so the
 * shot's ×SHOT_ZOOM_CLOSE dolly-in plays on the perspective camera's own
 * zoom and the rise still ends exactly ON the live follow pose. The
 * strand-door wormhole teleport snaps the smoothed focus (and the chase
 * boom, which is wrong-state too) on the spot
 * (STRAND_TELEPORT_CAMERA_SNAP, tuning/render.ts).
 */
function CameraRig({
  playerRef,
  motionRef,
  space,
  snapRef,
  mode,
  solids,
  waterSide,
}: {
  playerRef: PlayerRef;
  motionRef: MutableRefObject<Motion>;
  space: ActiveSpace | null;
  snapRef: MutableRefObject<boolean>;
  mode: GameCameraMode;
  /** The occlusion solids for the current world state (memoised by the
   *  integrator — corridor/lobby or the active room). */
  solids: readonly SolidBox[];
  waterSide: number;
}): JSX.Element {
  const viewportSize = useThree((state) => state.size);
  const focus = useRef(
    new THREE.Vector3(playerRef.current.x, 0, playerRef.current.z),
  );
  const zoomRef = useRef(CAMERA_ZOOM);
  const yawRef = useRef(TOPDOWN_YAW);
  const distRef = useRef(CHASE_BOOM);
  /** One-frame flag: a teleport snap re-casts the boom on the spot. */
  const distSnapRef = useRef(false);
  const fadeRef = useRef(1);
  const groundRef = useRef(0);
  const cameraRef = useRef<THREE.Camera | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [tapTools] = useState(() => ({
    raycaster: new THREE.Raycaster(),
    plane: new THREE.Plane(new THREE.Vector3(0, 1, 0), 0),
    ndc: new THREE.Vector2(),
    hit: new THREE.Vector3(),
  }));
  const initialPosition = useMemo<[number, number, number]>(
    () => [
      playerRef.current.x + CAM_OFFSET.x,
      CAM_OFFSET.y,
      playerRef.current.z + CAM_OFFSET.z,
    ],
    [playerRef],
  );

  // Tap projection (tap-to-interact): screen px → the ground-plane point
  // under it. The touch layer's only scene access — the live camera and
  // the canvas rect, never meshes. Reads cameraRef/canvasRef per call, so
  // a mode switch (or the scripted shot) never goes stale.
  const projectTap = useCallback(
    (sx: number, sy: number): { x: number; z: number } | null => {
      const camera = cameraRef.current;
      const canvas = canvasRef.current;
      if (camera === null || canvas === null) return null;
      const rect = canvas.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return null;
      tapTools.ndc.set(
        ((sx - rect.left) / rect.width) * 2 - 1,
        -(((sy - rect.top) / rect.height) * 2 - 1),
      );
      tapTools.raycaster.setFromCamera(tapTools.ndc, camera);
      tapTools.plane.constant = -CHASE_LIVE.groundY;
      const hit = tapTools.raycaster.ray.intersectPlane(tapTools.plane, tapTools.hit);
      return hit === null ? null : { x: hit.x, z: hit.z };
    },
    [tapTools],
  );
  useEffect(() => {
    CHASE_LIVE.projectTap = projectTap;
    return () => {
      CHASE_LIVE.projectTap = undefined;
    };
  }, [projectTap]);

  // The inverse projection (probe surface): a world point's screen px, so
  // a scripted tap lands exactly on a sheet or a door. Null when the
  // point is behind the camera.
  const projectPoint = useCallback(
    (x: number, y: number, z: number): { sx: number; sy: number } | null => {
      const camera = cameraRef.current;
      const canvas = canvasRef.current;
      if (camera === null || canvas === null) return null;
      const rect = canvas.getBoundingClientRect();
      tapTools.hit.set(x, y, z).project(camera);
      if (tapTools.hit.z > 1) return null;
      return {
        sx: rect.left + ((tapTools.hit.x + 1) / 2) * rect.width,
        sy: rect.top + ((1 - tapTools.hit.y) / 2) * rect.height,
      };
    },
    [tapTools],
  );
  useEffect(() => {
    CHASE_LIVE.projectPoint = projectPoint;
    return () => {
      CHASE_LIVE.projectPoint = undefined;
    };
  }, [projectPoint]);

  useGameFrame(({ camera, gl }, { delta: dt, initialize }) => {
    cameraRef.current = camera;
    canvasRef.current = gl.domElement;
    if (GAME_SIM_FREEZE.frozen && !initialize) {
      camera.updateProjectionMatrix();
      return;
    }
    const step = Math.min(dt, MAX_DT);
    const live = CHASE_LIVE;
    const p = playerRef.current;
    if (STRAND_TELEPORT_CAMERA_SNAP && snapRef.current) {
      snapRef.current = false;
      focus.current.x = p.x;
      focus.current.z = p.z;
      // A cross-hotel teleport is wrong-state for the boom too: pin the
      // chase distance to the fresh cast this frame instead of gliding.
      distSnapRef.current = true;
    }
    const wt = WORLD_TRANSITION;

    if (mode === "top") {
      // A fixed RTS direction. The room is the subject; a small amount of
      // player follow makes walking legible without orbiting the scene.
      const k = initialize ? 1 : 1 - Math.exp(-CAMERA_LERP_RATE * step);
      const dir = space === null ? 1 : roomOrientationFor(space.door).dir;
      const centerX = space?.door.x ?? p.x;
      const centerZ = space === null ? p.z : space.door.z + dir * space.scaledRecipe.size.extent / 2;
      const targetX = space === null ? p.x : centerX * 0.88 + p.x * 0.12;
      const targetZ = space === null ? p.z : centerZ * 0.88 + p.z * 0.12;
      focus.current.x += (targetX - focus.current.x) * k;
      focus.current.z += (targetZ - focus.current.z) * k;
      const zoom = rtsRoomZoom(viewportSize, space === null ? null : {
        width: space.scaledRecipe.width,
        depth: space.scaledRecipe.size.extent,
        wallHeight: scaledWallHeight(space.scale.factor),
      });
      zoomRef.current += (zoom - zoomRef.current) * k;
      const ortho = camera as THREE.OrthographicCamera;
      if (wt.active && wt.mode !== "pause") {
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
          live.yaw = TOPDOWN_YAW;
          live.camX = shot.x;
          live.camY = shot.y;
          live.camZ = shot.z;
          live.dist = CHASE_BOOM;
          live.blocked = false;
          live.fade = 1;
          return;
        }
      }
      camera.position.set(
        focus.current.x + CAM_OFFSET.x,
        CAM_OFFSET.y,
        focus.current.z + CAM_OFFSET.z,
      );
      camera.lookAt(focus.current.x, 0, focus.current.z);
      // Same guard as the chase rig: a settled RTS camera converges the
      // lerped zoom to the ref's value, and re-projecting an unchanged
      // ortho zoom every frame wastes the whole-room frame budget.
      if (Math.abs(ortho.zoom - zoomRef.current) > 1e-4) {
        ortho.zoom = zoomRef.current;
        ortho.updateProjectionMatrix();
      }
      live.yaw = TOPDOWN_YAW;
      live.camX = camera.position.x;
      live.camY = camera.position.y;
      live.camZ = camera.position.z;
      live.dist = CHASE_BOOM;
      live.blocked = false;
      live.fade = 1;
      live.groundY = 0;
      return;
    }

    // ── THE CHASE RIG ──
    const k = 1 - Math.exp(-CHASE_POS_RATE * step);
    focus.current.x += (p.x - focus.current.x) * k;
    focus.current.z += (p.z - focus.current.z) * k;
    const groundY = space ? groundTargetY(space, waterSide, p.x, p.z) : 0;
    groundRef.current +=
      (groundY - groundRef.current) * (1 - Math.exp(-GROUND_LERP_RATE * step));
    const gy = groundRef.current;
    // Lazy yaw: the heading pulls the camera round only while the avatar
    // moves — standing still never swings the world.
    const motion = motionRef.current;
    if (motion.moving) {
      yawRef.current = lerpAngle(
        yawRef.current,
        Math.atan2(motion.x, motion.z),
        1 - Math.exp(-CHASE_YAW_RATE * step),
      );
    }
    const yaw = yawRef.current;
    const fx = Math.sin(yaw);
    const fz = Math.cos(yaw);
    const pivotX = focus.current.x;
    const pivotY = gy + CHASE_PIVOT_HEIGHT;
    const pivotZ = focus.current.z;
    const desiredX = pivotX - fx * CHASE_BOOM;
    const desiredY = gy + CHASE_CAM_HEIGHT;
    const desiredZ = pivotZ - fz * CHASE_BOOM;
    const t = castBoom(
      pivotX, pivotY, pivotZ,
      desiredX, desiredY, desiredZ,
      solids,
      CHASE_PROBE_RADIUS,
    );
    const target = Math.max(0.3, t * CHASE_BOOM);
    let dist = distRef.current;
    if (distSnapRef.current) {
      distSnapRef.current = false;
      dist = target;
    } else {
      // Pull in fast, push out slow — an occluded frame is corrected
      // immediately; the return to full boom never pumps.
      const rate = target < dist ? CHASE_PULL_IN_RATE : CHASE_PUSH_OUT_RATE;
      dist += (target - dist) * (1 - Math.exp(-rate * step));
    }
    distRef.current = dist;
    const along = dist / CHASE_BOOM;
    const camX = pivotX + (desiredX - pivotX) * along;
    const camY = pivotY + (desiredY - pivotY) * along;
    const camZ = pivotZ + (desiredZ - pivotZ) * along;
    // The avatar fades rather than the camera entering its head.
    const fadeTarget = dist <= CHASE_MIN_DIST ? CHASE_AVATAR_FADE : 1;
    fadeRef.current += (fadeTarget - fadeRef.current) * (1 - Math.exp(-10 * step));

    const persp = camera as THREE.PerspectiveCamera;
    if (wt.active && wt.mode !== "pause") {
      const follow: FollowPose = {
        x: camX,
        y: camY,
        z: camZ,
        lookX: pivotX,
        lookY: pivotY,
        lookZ: pivotZ,
        zoom: 1,
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
        if (Math.abs(persp.zoom - shot.zoom) > 1e-4) {
          persp.zoom = shot.zoom;
          persp.updateProjectionMatrix();
        }
        live.yaw = yaw;
        live.camX = shot.x;
        live.camY = shot.y;
        live.camZ = shot.z;
        live.dist = dist;
        live.blocked = t < 1;
        live.fade = fadeRef.current;
        live.groundY = gy;
        return;
      }
    }
    camera.position.set(camX, camY, camZ);
    camera.lookAt(pivotX, pivotY, pivotZ);
    if (persp.zoom !== 1) {
      persp.zoom = 1;
      persp.updateProjectionMatrix();
    }
    live.yaw = yaw;
    live.camX = camX;
    live.camY = camY;
    live.camZ = camZ;
    live.dist = dist;
    live.blocked = t < 1;
    live.fade = fadeRef.current;
    live.groundY = gy;
  });

  return mode === "top" ? (
    <OrthographicCamera makeDefault zoom={CAMERA_ZOOM} position={initialPosition} />
  ) : (
    <PerspectiveCamera
      makeDefault
      fov={CHASE_FOV}
      position={initialPosition}
      near={0.1}
      far={400}
    />
  );
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

  useGameFrame((_, { delta: dt, initialize }) => {
    const bg = bgRef.current;
    const sun = sunRef.current;
    const ambient = ambientRef.current;
    if (!bg || !sun || !ambient) return;
    if (GAME_SIM_FREEZE.frozen && !initialize) return;
    const k = initialize ? 1 : 1 - Math.exp(-ATMOSPHERE_LERP_RATE * Math.min(dt, MAX_DT));
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
          end-fade planes, and N8AO instead. */}
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
 * The walkable avatar: a simple expressive figure in smooth low-poly shapes
 * (legs, warm torso and arms, separate skin head under a sage-dark hair
 * cap, and a tiny facing cue) — the matte overhaul replaced the old
 * faceted wooden-peg look. Position/rotation are driven
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
  const matsRef = useRef<THREE.MeshStandardMaterial[]>([]);
  const headingRef = useRef(0);
  const bobPhaseRef = useRef(0);
  const bobRef = useRef(0);
  const yRef = useRef(0);

  useGameFrame((_, { delta: dt, initialize }) => {
    const root = rootRef.current;
    const body = bodyRef.current;
    if (!root || !body) return;
    if (GAME_SIM_FREEZE.frozen && !initialize) return;
    const step = Math.min(dt, MAX_DT);
    const motion = motionRef.current;

    const p = playerRef.current;
    const targetY = space ? groundTargetY(space, waterSide, p.x, p.z) : 0;
    if (initialize) yRef.current = targetY;
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
    // MIN-DIST FADE (v0.28): the chase rig drives CHASE_LIVE.fade — below
    // CHASE_MIN_DIST the avatar goes translucent instead of the camera
    // entering its head. The materials stay transparent+depthWrite from
    // construction (no program re-key at runtime), so this is one float
    // write per material per frame.
    for (const mat of matsRef.current) mat.opacity = CHASE_LIVE.fade;
  });

  /** Stable slot assignment for the shared materials (mount order). */
  const matRefAt = (i: number) => (mat: THREE.MeshStandardMaterial | null) => {
    if (mat) matsRef.current[i] = mat;
  };

  return (
    <group ref={rootRef}>
      <group ref={bodyRef}>
        {/* Legs — two quiet cylinders, understated against the warm torso.
            Total height ~1.2 m, feet at y = 0. */}
        <mesh castShadow position={[-0.1, 0.22, 0]}>
          <cylinderGeometry args={[0.07, 0.075, 0.44, 10]} />
          <meshStandardMaterial
            ref={matRefAt(0)}
            color={PLAYER_LEG}
            roughness={1}
            transparent
          />
        </mesh>
        <mesh castShadow position={[0.1, 0.22, 0]}>
          <cylinderGeometry args={[0.07, 0.075, 0.44, 10]} />
          <meshStandardMaterial
            ref={matRefAt(1)}
            color={PLAYER_LEG}
            roughness={1}
            transparent
          />
        </mesh>
        {/* Warm torso capsule. */}
        <mesh castShadow position={[0, 0.62, 0]}>
          <capsuleGeometry args={[0.2, 0.32, 4, 12]} />
          <meshStandardMaterial
            ref={matRefAt(2)}
            color={PLAYER_BODY}
            roughness={1}
            transparent
          />
        </mesh>
        {/* Arms — slim cylinders resting at the torso's sides. */}
        <mesh castShadow position={[-0.27, 0.6, 0]} rotation={[0, 0, 0.12]}>
          <cylinderGeometry args={[0.05, 0.055, 0.36, 8]} />
          <meshStandardMaterial
            ref={matRefAt(3)}
            color={PLAYER_BODY}
            roughness={1}
            transparent
          />
        </mesh>
        <mesh castShadow position={[0.27, 0.6, 0]} rotation={[0, 0, -0.12]}>
          <cylinderGeometry args={[0.05, 0.055, 0.36, 8]} />
          <meshStandardMaterial
            ref={matRefAt(4)}
            color={PLAYER_BODY}
            roughness={1}
            transparent
          />
        </mesh>
        {/* Skin head under a sage-dark hair cap. */}
        <mesh castShadow position={[0, 1.06, 0.02]}>
          <sphereGeometry args={[0.17, 14, 12]} />
          <meshStandardMaterial
            ref={matRefAt(5)}
            color={PLAYER_HEAD}
            roughness={1}
            transparent
          />
        </mesh>
        <mesh castShadow position={[0, 1.1, -0.02]} scale={[1, 0.82, 1]}>
          <sphereGeometry args={[0.175, 14, 12]} />
          <meshStandardMaterial
            ref={matRefAt(6)}
            color={PLAYER_HAIR}
            roughness={1}
            transparent
          />
        </mesh>
        {/* Facing cue — tiny nub toward +z local, marks the travel heading. */}
        <mesh castShadow position={[0, 1.05, 0.18]} rotation={[Math.PI / 2, 0, 0]}>
          <coneGeometry args={[0.045, 0.1, 8]} />
          <meshStandardMaterial
            ref={matRefAt(7)}
            color={PLAYER_HAIR}
            roughness={1}
            transparent
          />
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
  walkRef,
  onWalkArrive,
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
  roomReadiness,
  activeSpace,
  setActiveSpace,
  corridorHidden,
  setCorridorHidden,
  hudIdRef,
  setHudDoor,
  prewarmIdRef,
  setPrewarmDoor,
  transitionActive,
  suspended,
  roomDoors,
  roomPlan,
  roomSeams,
  roomPapers,
  paperHudRef,
  setPaperHud,
  lobbyAnchorLabel,
  departingRef,
  departWatchRef,
  anchorHudRef,
  setHudAnchor,
}: {
  playerRef: PlayerRef;
  keysRef: MutableRefObject<Set<string>>;
  motionRef: MutableRefObject<Motion>;
  /** The tap-to-walk target (touch controls) — cancelled by manual input,
   *  arrival, a stuck wall, a hop, or a freeze. */
  walkRef: MutableRefObject<WalkTarget>;
  /** Arrival on a target whose tap named the terminal: fire the same
   *  interaction the Enter/E key fires. */
  onWalkArrive: () => void;
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
  roomReadiness: (door: DoorRef) => RoomReadiness;
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
  suspended: boolean;
  /** The active space's placed strand doors (plan-local frame) — the
   *  clamp's passage windows; empty when the room grows none. */
  roomDoors: readonly RoomDoorPlacement[];
  /** The runtime strand-door count for ANY slice of the current window —
   *  the pure door-map lookup (data lane), consumed at the wall crossing
   *  to freeze the count into the new ActiveSpace. GameLoop sees only the
   *  ACTIVE space's placements above, so the mount asks here per slice. */
  /** The active space's floor plan (same derivation as roomDoors) — the
   *  clamp's plan-aware containment; a placeholder rect when no space is
   *  active (the space clamp never runs then). */
  roomPlan: RoomPlan;
  /** The active space's interior seam jamb walls (§8 — same derivation as
   *  the renderer's partitions; empty for non-composed rooms): the clamp's
   *  solid interior walls. */
  roomSeams: readonly SeamWall[];
  /** The active room's loose papers (v0.25a §五 B② — room-local spots with
   *  their documents; empty in the corridor, and empty until the room's
   *  document list resolves). */
  roomPapers: readonly RoomPaperItem[];
  /** The latest in-reach sheet that WON the arbitration against the anchor
   *  (also read by the interact key handler). */
  paperHudRef: MutableRefObject<PaperHud | null>;
  setPaperHud: (paper: PaperHud | null) => void;
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
  useGameFrame((_, { delta }) => {
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
      // next frame runs on the committed hotel. A tap-to-walk target from
      // the old hotel is stale by definition — drop it.
      hopGuard.current = false;
      motionRef.current = { x: 0, z: 0, moving: false };
      walkRef.current.active = false;
      CHASE_LIVE.walking = false;
    } else if (
      !suspended &&
      !transitionActive &&
      !departingRef.current &&
      !WORLD_TRANSITION.active &&
      !GAME_SIM_FREEZE.frozen
    ) {
      // 1. Movement — screen-relative, dt-corrected, no acceleration. The
      // basis comes from the camera's LIVE yaw (chase-camera.ts): "left on
      // screen is left in the world" under both rigs, and at TOPDOWN_YAW
      // the vectors are byte-identical to the legacy fixed-camera
      // diagonals. The floating stick adds into the same screen frame; a
      // tap-to-walk target drives the player in world space until manual
      // input, arrival (which may fire a tapped terminal), or a stuck
      // wall cancels it. Inside a space the speed scales with the room
      // (clamp(S,1,∞)^EXP): a colossal room should feel immense, not waste
      // the player's time; the corridor stays exactly PLAYER_SPEED.
      const keys = moveVectorFromKeys(keysRef.current);
      let rx = keys.rx + CHASE_LIVE.stickX;
      let up = keys.up + CHASE_LIVE.stickY;
      const manual = rx !== 0 || up !== 0;
      const walk = walkRef.current;
      let move = { x: 0, z: 0 };
      if (manual) {
        const len = Math.hypot(rx, up);
        if (len > 1) {
          rx /= len;
          up /= len;
        }
        const basis = moveBasisFor(CHASE_LIVE.yaw);
        move = {
          x: up * basis.fx + rx * basis.rx,
          z: up * basis.fz + rx * basis.rz,
        };
        if (walk.active) {
          walk.active = false;
          CHASE_LIVE.walking = false;
        }
      } else if (walk.active) {
        const dx = walk.x - p.x;
        const dz = walk.z - p.z;
        const d = Math.hypot(dx, dz);
        if (d <= walk.arrive) {
          walk.active = false;
          CHASE_LIVE.walking = false;
          if (walk.interact) onWalkArrive();
        } else {
          move = { x: dx / d, z: dz / d };
          // Stuck: the clamp won't let the player close on the target —
          // cancel rather than pushing a wall forever.
          const step = Math.min(delta, MAX_DT);
          if (Math.abs(walk.lastD - d) < 0.002) {
            walk.still += step;
            if (walk.still > 0.8) {
              walk.active = false;
              CHASE_LIVE.walking = false;
            }
          } else {
            walk.still = 0;
          }
          walk.lastD = d;
        }
      }
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
          const readiness = roomReadiness(door);
          if (readiness.kind === "ready") {
            space = readiness.space;
            setActiveSpace(space);
          } else {
            clampToThreshold(p, { door });
            if (prewarmIdRef.current !== door.sliceId) {
              prewarmIdRef.current = door.sliceId;
              setPrewarmDoor(door);
            }
          }
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
      // Frozen — mid-crossing (the strand door manager) or under the
      // document tier (GAME_SIM_FREEZE, v0.28 step 1): report "not moving"
      // so the avatar settles instead of bobbing in place. A tap-to-walk
      // target from the frozen world is dropped with it.
      motionRef.current = { x: 0, z: 0, moving: false };
      walkRef.current.active = false;
      CHASE_LIVE.walking = false;
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

    // 4. THE ANCHOR TERMINAL (§13.1): proximity of the lobby's index
    // terminal — the ONE live machine (v0.29: the per-room terminal is
    // retired; rooms no longer grow a machine or answer its interaction).
    // The interaction point is the anchor's own pose, so the thing
    // measured here IS the thing the corridor drew.
    let ax = 0;
    let az = 0;
    let aFaceX = 0;
    let aFaceZ = 1;
    let aKind: "" | "room" | "lobby" = "";
    let aSlice: string | null = null;
    const aReach = TERMINAL_REACH_LOBBY;
    if (space === null) {
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

    // 4b. THE LOOSE PAPERS (v0.25a §五 B②): the nearest in-reach sheet of
    // the ACTIVE room (world = door + local·dir — the terminal's own
    // mirror). Sheet and anchor arbitrate by distance: the nearer takes
    // the prompt AND the interact key; the door prompt yields to either.
    let pHud: PaperHud | null = null;
    if (space !== null && roomPapers.length > 0) {
      const dir = space.door.z > 0 ? 1 : -1;
      let best = PAPER_REACH;
      for (const rp of roomPapers) {
        const wx = space.door.x + dir * rp.spot.x;
        const wz = space.door.z + dir * rp.spot.z;
        const d = Math.hypot(p.x - wx, p.z - wz);
        if (d <= best) {
          best = d;
          pHud = { ref: rp.ref, title: rp.title, x: wx, z: wz };
        }
      }
      // A tie keeps the anchor — the room's own machine was there first.
      if (pHud !== null && aHud !== null && aDist <= best) pHud = null;
    }
    const prevPaper = paperHudRef.current;
    if (
      (prevPaper === null) !== (pHud === null) ||
      prevPaper?.ref !== pHud?.ref
    ) {
      paperHudRef.current = pHud;
      setPaperHud(pHud);
    }

    // 5. HUD prompt — setState only when the nearest door identity changes.
    // The anchor wins while in reach (its prompt replaces the door's), and
    // a won sheet wins over both (4b's arbitration).
    const near = aHud !== null || pHud !== null ? null : nearestDoor(p.x, p.z, sliceIds, HUD_DIST, layout);
    const nearId = near ? near.sliceId : null;
    if (nearId !== hudIdRef.current) {
      hudIdRef.current = nearId;
      setHudDoor(nearId === null ? null : (doors.find((d) => d.sliceId === nearId) ?? null));
    }

    // 6. Probe/e2e debug handle — mutate the preallocated object, no re-render.
    GAME_DEBUG.x = p.x;
    GAME_DEBUG.z = p.z;
    GAME_DEBUG.space = space === null ? null : space.door.sliceId;
    GAME_DEBUG.snapshot = space?.snapshot ?? null;
    GAME_DEBUG.elapsed = gameElapsed();
    GAME_DEBUG.hotel = hotelLabel;
  });
  return null;
}

/* ------------------------------------------------------------------ */
/* Pointer controls — click to read; one-thumb movement on touch      */
/* ------------------------------------------------------------------ */

/** Stick knob travel (px) — the vector saturates at the rim. */
const STICK_RADIUS_PX = 48;
/** Finger slop (px): below this a touch is a tap candidate, not a drag. */
const STICK_DEAD_PX = 10;
/** Longest press that still reads as a tap. */
const TAP_MAX_MS = 400;

/**
 * THE TOUCH LAYER — one-thumb controls. A touch anywhere in the LOWER
 * half of the screen spawns a floating stick under that thumb (it works
 * for either hand, and the thumb never travels to a fixed pad); drag =
 * move, release = stop. A TAP anywhere (short, unmoved) picks what is
 * under it through the tap-to-interact resolver — a loose sheet, the
 * terminal, a door. No look control, no second button.
 *
 * Mouse-left and pen taps use the same resolver; only a touch can engage
 * the floating movement stick. A drag never becomes a tap, even if it
 * returns to its starting point. The desktop also keeps arrow keys. Seating:
 * the layer fills the game pane UNDER the chrome — the exit and gallery
 * buttons (z-10/z-20) and the conversation pill (layout level) keep
 * their taps by stacking order; the world gate is field chrome and never
 * mounts over the hotel, so nothing competes for the lower half.
 */
function TouchControls({
  onTap,
}: {
  onTap: (sx: number, sy: number) => void;
}): JSX.Element {
  const [stick, setStick] = useState<{
    left: number;
    top: number;
    dx: number;
    dy: number;
  } | null>(null);
  const touchRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    startT: number;
    engaged: boolean;
    moved: boolean;
    lowerHalf: boolean;
  } | null>(null);

  const clearTouch = useCallback((): void => {
    touchRef.current = null;
    setStick(null);
    CHASE_LIVE.stickX = 0;
    CHASE_LIVE.stickY = 0;
    CHASE_LIVE.stickActive = false;
  }, []);

  useEffect(() => () => clearTouch(), [clearTouch]);

  return (
    <div
      data-game-pointer-surface
      className="absolute inset-0 touch-none"
      onPointerDown={(e) => {
        if (e.button !== 0 || !e.isPrimary || touchRef.current !== null) return;
        e.currentTarget.setPointerCapture(e.pointerId);
        touchRef.current = {
          pointerId: e.pointerId,
          startX: e.clientX,
          startY: e.clientY,
          startT: performance.now(),
          engaged: false,
          moved: false,
          lowerHalf: e.pointerType === "touch" && e.clientY > window.innerHeight / 2,
        };
      }}
      onPointerMove={(e) => {
        const t = touchRef.current;
        if (t === null || e.pointerId !== t.pointerId) return;
        const dx = e.clientX - t.startX;
        const dy = e.clientY - t.startY;
        const len = Math.hypot(dx, dy);
        if (len >= STICK_DEAD_PX) t.moved = true;
        if (!t.engaged) {
          if (!t.lowerHalf || len < STICK_DEAD_PX) return;
          t.engaged = true;
        }
        const clamped = Math.min(len, STICK_RADIUS_PX);
        const nx = len > 0 ? dx / len : 0;
        const ny = len > 0 ? dy / len : 0;
        CHASE_LIVE.stickX = (nx * clamped) / STICK_RADIUS_PX;
        // Screen-down is the stick's negative up.
        CHASE_LIVE.stickY = (-ny * clamped) / STICK_RADIUS_PX;
        CHASE_LIVE.stickActive = true;
        const rect = e.currentTarget.getBoundingClientRect();
        setStick({
          left: t.startX - rect.left,
          top: t.startY - rect.top,
          dx: nx * clamped,
          dy: ny * clamped,
        });
      }}
      onPointerUp={(e) => {
        const t = touchRef.current;
        if (t === null || e.pointerId !== t.pointerId) return;
        const wasTap =
          !t.engaged && !t.moved &&
          performance.now() - t.startT < TAP_MAX_MS &&
          Math.hypot(e.clientX - t.startX, e.clientY - t.startY) < STICK_DEAD_PX;
        clearTouch();
        if (wasTap) onTap(e.clientX, e.clientY);
      }}
      onPointerCancel={(e) => {
        if (touchRef.current?.pointerId === e.pointerId) clearTouch();
      }}
      onLostPointerCapture={(e) => {
        if (touchRef.current?.pointerId === e.pointerId) clearTouch();
      }}
    >
      {stick !== null && (
        <div
          className="pointer-events-none absolute size-28 -translate-x-1/2 -translate-y-1/2 rounded-full border border-white/25 bg-black/20"
          style={{ left: stick.left, top: stick.top }}
        >
          <div
            className="absolute left-1/2 top-1/2 size-12 rounded-full bg-white/35"
            style={{
              transform: `translate(calc(-50% + ${stick.dx}px), calc(-50% + ${stick.dy}px))`,
            }}
          />
        </div>
      )}
    </div>
  );
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
  paper,
  enterHint,
  readHint,
  onInteract,
}: {
  door: CorridorDoor | null;
  anchor: AnchorHud | null;
  /** The in-reach loose sheet that won the loop's arbitration (v0.25a §五) —
   *  wins over the anchor exactly when it is nearer. */
  paper: PaperHud | null;
  enterHint: string;
  /** The paper prompt's verb ("Read") — a sheet is opened, not entered. */
  readHint: string;
  onInteract: () => void;
}): JSX.Element | null {
  const label = paper ? paper.title : anchor ? anchor.label : door?.label;
  const hint = paper ? readHint : enterHint;
  if (label === undefined) return null;
  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-24 z-10 flex justify-center">
      {paper || anchor ? (
        <button
          type="button"
          data-game-interact={paper ? "paper" : "anchor"}
          onClick={onInteract}
          className="pointer-events-auto flex max-w-[min(80vw,30rem)] items-center gap-3 rounded-full border border-tool-line bg-tool/90 px-4 py-2 text-sm text-foreground shadow-float backdrop-blur-md transition hover:bg-tool"
        >
          <span className="truncate font-serif">{label}</span>
          <span className="shrink-0 text-xs text-muted-foreground">{hint}</span>
          <kbd aria-hidden className="hidden text-[10px] text-muted-foreground sm:inline">↵</kbd>
        </button>
      ) : (
        <div className="rounded-full border border-tool-line bg-tool/85 px-4 py-2 text-sm text-foreground shadow-float backdrop-blur-md">
          <span className="font-serif">{label}</span>
          <span className="mx-2 text-muted-foreground">·</span>
          <span className="text-xs text-muted-foreground">{hint}</span>
        </div>
      )}
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

/** Restore a cleared paused canvas after static initialization (priority 0)
 * and the ordinary composer (priority 1). The independent game clock keeps
 * demand frames frozen. Only actual paints discharge the resize debt. */
function FrozenGameFrameRepaint({
  suspended,
  composer,
}: {
  suspended: boolean;
  /** The game's EffectComposer ref — the postprocessing EffectComposerImpl
   *  the wrapper exposes. Null until the wrapper mounts its composer. */
  composer: ComponentRef<typeof EffectComposer> | null;
}): null {
  const plannerRef = useRef<FrozenFrameRepaintPlanner | null>(null);
  if (plannerRef.current === null) {
    plannerRef.current = createFrozenFrameRepaintPlanner();
  }
  const size = useThree((s) => s.size);
  const dpr = useThree((s) => s.viewport.dpr);
  useLayoutEffect(() => {
    plannerRef.current?.syncActive({ width: size.width, height: size.height, dpr });
  }, [size.width, size.height, dpr]);

  useFrame(({ gl, size, viewport, invalidate }) => {
    const planner = plannerRef.current;
    if (planner === null) return;
    const geometry: FrozenFrameGeometry = {
      width: size.width,
      height: size.height,
      dpr: viewport.dpr,
    };
    if (!suspended) {
      // The enabled composer ran at priority 1 in this frame.
      if (composer !== null) planner.markPainted(geometry);
      return;
    }
    if (planner.planSuspended(geometry, composer !== null) !== "paint") return;
    // planner said paint ⇒ composer !== null by construction.
    if (composer === null) return;
    renderFrozenComposerOnce(gl, composer, geometry);
    planner.markPainted(geometry);
    invalidate();
  }, 1.5);

  return null;
}

function CorridorHideDelay({ hidden, onHidden }: {
  hidden: boolean;
  onHidden: (hidden: boolean) => void;
}): null {
  const deadline = useRef<number | null>(null);
  const fired = useRef(false);
  useGameFrame((_, { elapsed }) => {
    if (!hidden) { deadline.current = null; fired.current = false; return; }
    deadline.current ??= elapsed + HIDE_DELAY_MS / 1000;
    if (!GAME_SIM_FREEZE.frozen && !fired.current && elapsed >= deadline.current) {
      fired.current = true;
      onHidden(true);
    }
  });
  return null;
}

export default function GameCanvas({
  doors,
  roomDoors,
  timelines,
  onActiveSliceChange,
  onRoomSnapshotChange,
  persona = "user",
  sourceScope = roomProfileSourceScope(),
  focusSlice = null,
  onOpenDoc,
  cameraMode = "top",
  suspended = false,
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
  onRoomSnapshotChange?: (snapshot: RoomSnapshot | null) => void;
  persona?: string;
  sourceScope?: string;
  /** The shared `?slice=` address (§14): enter the slice's own hotel window
   *  and stand at its door. Resolved once per value, through the same pure
   *  layout math the door manager uses; an unknown id is ignored (the
   *  corridor opens at its spawn, exactly as without the param). */
  focusSlice?: string | null;
  /** A loose paper's interact (v0.25a §五 B②): open the sheet's document in
   *  the original manuscript (the shell switches the world to the desk). */
  onOpenDoc?: (ref: string) => void;
  /** THE RIG (v0.28): "chase" is the third-person default; "top" is the
   *  legacy fixed 45° dollhouse, kept behind `?view=game&camera=top` for
   *  in-place comparison (game-shell parses the param). */
  cameraMode?: GameCameraMode;
  /** THE DOCUMENT PAUSE (v0.28 step 1): the document tier sits over the
   *  frozen world — the in-world chrome (the door HUD, the touch layer)
   *  stands down with the simulation. The scene itself keeps showing the
   *  frozen frame under the shell's blur layer; the only repaint it ever
   *  gets while suspended is the one-shot repair of a mid-pause resize/DPR
   *  change clearing the canvas (FrozenGameFrameRepaint, frozen-frame.ts). */
  suspended?: boolean;
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
  // The loose papers' prompt (v0.25a §五 B②): the in-reach sheet that WON
  // the loop's arbitration against the anchor terminal (the nearer one
  // takes the prompt and the interact key).
  const [hudPaper, setHudPaper] = useState<PaperHud | null>(null);
  const paperHudRef = useRef<PaperHud | null>(null);
  const onOpenDocRef = useRef(onOpenDoc);
  onOpenDocRef.current = onOpenDoc;
  const suspendedRef = useRef(suspended);
  suspendedRef.current = suspended;
  const departingRef = useRef(false);
  const departWatchRef = useRef(false);
  const interactRef = useRef<() => void>(() => {});
  useEffect(() => {
    interactRef.current = () => {
      if (suspendedRef.current || WORLD_TRANSITION.active || GAME_SIM_FREEZE.frozen) return;
      // A sheet in reach reads in the original manuscript — no flare, no
      // depart latch: the desk opens over the game and the room waits.
      const paper = paperHudRef.current;
      if (paper !== null) {
        onOpenDocRef.current?.(paper.ref);
        return;
      }
      const anchor = anchorHudRef.current;
      if (anchor === null || departingRef.current) return;
      departingRef.current = true;
      TERMINAL_DEPART.t0 = performance.now();
      window.setTimeout(
        () => {
          if (suspendedRef.current || GAME_SIM_FREEZE.frozen || !departingRef.current) {
            departingRef.current = false;
            return;
          }
          WORLD_TRANSITION.hooks.enter?.(anchor.sliceId);
        },
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
  /** The tap-to-walk target (touch controls) — see WalkTarget. */
  const walkRef = useRef<WalkTarget>({
    active: false,
    x: 0,
    z: 0,
    arrive: 0.45,
    interact: false,
    still: 0,
    lastD: 0,
  });
  const hudIdRef = useRef<string | null>(null);
  const [activeSpace, setActiveSpace] = useState<ActiveSpace | null>(null);
  const navigationEpoch = useRef(0);
  const profileCache = getBrowserRoomProfileCache();
  const [profileRevision, setProfileRevision] = useState(0);
  const visitFallback = useRef<{ request: RoomProfileRequest; result: RoomProfileCacheResult } | null>(null);
  const profileEpoch = hotelDataEpoch();
  const [returnRequest, setReturnRequest] = useState<{
    side: Side; request: RoomProfileRequest; status: "loading" | "retry";
  } | null>(null);
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
  useEffect(() => {
    onRoomSnapshotChange?.(suspended ? null : activeSpace?.snapshot ?? null);
    return () => onRoomSnapshotChange?.(null);
  }, [activeSpace, suspended, onRoomSnapshotChange]);
  // Keep the explicit choice for the whole visit: the canvas portal can
  // still run an older frame after this DOM root commits entry. Clearing
  // here on entry would let that frame re-gate against a late profile.
  const activeSliceId = activeSpace?.door.sliceId ?? null;
  useEffect(() => {
    return () => {
      if (activeSliceId !== null && visitFallback.current?.request.sliceId === activeSliceId) {
        visitFallback.current = null;
      }
    };
  }, [activeSliceId]);
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
  useEffect(() => {
    navigationEpoch.current += 1;
    visitFallback.current = null;
    setActiveSpace(null);
    setShownSpace(null);
    setPrewarmDoor(null);
    prewarmIdRef.current = null;
    return () => { navigationEpoch.current += 1; };
  }, [persona, sourceScope]);
  useEffect(() => {
    if (!prewarmDoor || isDebugSlice(prewarmDoor.sliceId)) return;
    let cancelled = false;
    const request = profileCache.capture(sourceScope, persona, prewarmDoor.sliceId);
    void profileCache.load(request).then(() => {
      if (!cancelled && profileCache.isCurrent(request)) setProfileRevision((n) => n + 1);
    });
    return () => { cancelled = true; };
  }, [prewarmDoor, sourceScope, persona, profileEpoch, profileCache]);
  // Wrapper around the corridor so LightConfigCompiler can exclude its
  // lights from a proxy compile (compile gathers lights via
  // traverseVisible) without touching corridor.tsx.
  const corridorGroupRef = useRef<THREE.Group>(null);
  // Door-slab handover: the corridor keeps the one physical slab until it
  // unmounts (HIDE_DELAY_MS after the hide threshold); the space's own
  // slab mounts exactly then — never two doors in one frame.
  const [corridorGone, setCorridorGone] = useState(false);
  useEffect(() => { if (!corridorHidden) setCorridorGone(false); }, [corridorHidden]);

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
  const roomReadiness = useCallback((door: DoorRef): RoomReadiness => {
    if (isDebugSlice(door.sliceId)) return {
      kind: "ready", space: resolveSpaceForDoor(door, archetypeById, roomDoorCountFor(door.sliceId)),
    };
    const request = profileCache.capture(sourceScope, persona, door.sliceId);
    const fallback = visitFallback.current;
    const sameFallback = fallback && profileCache.isCurrent(fallback.request) &&
      fallback.request.sliceId === request.sliceId && fallback.request.persona === persona &&
      fallback.request.sourceScope === sourceScope;
    const verdict = decideGate(sameFallback ? fallback.result : profileCache.peek(request));
    return verdict.kind === "commit" ? {
      kind: "ready", space: resolveSpaceForDoor(door, archetypeById, roomDoorCountFor(door.sliceId), verdict.profile),
    } : verdict;
  }, [profileCache, sourceScope, persona, archetypeById, roomDoorCountFor]);
  const prewarmSpace = useMemo(() => {
    if (!prewarmDoor) return null;
    const readiness = roomReadiness(prewarmDoor);
    return readiness.kind === "ready" ? readiness.space : null;
    // The cache is external mutable state; these revisions invalidate its peek.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prewarmDoor, roomReadiness, profileRevision, profileEpoch]);
  const profileStatus = prewarmDoor && !activeSpace && !isDebugSlice(prewarmDoor.sliceId)
    ? roomReadiness(prewarmDoor) : null;
  const retryProfile = () => {
    if (returnRequest) { void handleReturnDoor(returnRequest.side, true); return; }
    if (!prewarmDoor) return;
    visitFallback.current = null;
    const request = profileCache.capture(sourceScope, persona, prewarmDoor.sliceId);
    setProfileRevision((n) => n + 1);
    void profileCache.retry(request).then(() => {
      if (profileCache.isCurrent(request)) setProfileRevision((n) => n + 1);
    });
  };
  const enterBaseRoom = () => {
    if (returnRequest) { void handleReturnDoor(returnRequest.side, false, true); return; }
    if (!prewarmDoor) return;
    const request = profileCache.capture(sourceScope, persona, prewarmDoor.sliceId);
    visitFallback.current = { request, result: profileCache.fallback(request) };
    setProfileRevision((n) => n + 1);
  };
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

  // THE CHASE RIG'S OCCLUSION SOLIDS (v0.28): the analytic walls the
  // sphere cast tests — corridor/lobby while no space is active, the
  // room's own perimeter/seams/terminal inside one. chase-camera.ts
  // builds them from the SAME pure inputs the movement clamp consumes
  // (one derivation, two call sites), so the camera is contained by
  // exactly the walls the player is. Memoised per state change; the
  // per-frame cast itself is allocation-free.
  const cameraSolids = useMemo<readonly SolidBox[]>(() => {
    if (activeSpace !== null && activeRoomGeometry !== null) {
      const scaleFactor = activeSpace.scale.factor;
      return roomSolids({
        door: activeSpace.door,
        plan: activeRoomGeometry.plan,
        wallThick: ROOM_WALL_THICKNESS * Math.max(scaleFactor, 0.35),
        wallHeight: scaledWallHeight(scaleFactor),
        seams: activeRoomGeometry.seams,
        // v0.29: the per-room terminal is retired — nothing stands in the
        // room for the cast to keep off of.
        terminal: null,
      });
    }
    return corridorSolids({
      endX: corridorEnd.endX,
      pageDoor: corridorEnd.pageDoor,
      doorXs,
      returnDoorSouthX: returnSides.south ? RETURN_DOOR_SOUTH_X : null,
      eastArrivalDoor: returnSides.east,
      blockers: LOBBY_SOLID_BLOCKERS,
    });
  }, [activeSpace, activeRoomGeometry, corridorEnd, doorXs, returnSides]);

  // POINTER PICKUP: a mouse click, pen tap or touch projects to the ground plane
  // (the rig's projectTap) and picks what is under it — a loose sheet
  // opens straight into the manuscript (the same call the interact key's
  // paper branch makes); the terminal and the corridor doors start a
  // tap-to-walk, the terminal firing its interaction on arrival. The
  // candidates are the probe mirror's own world coordinates — the same
  // answers the interact key already gives, one thumb, no second button.
  const handleTap = useCallback((sx: number, sy: number): void => {
    if (suspended || WORLD_TRANSITION.active || GAME_SIM_FREEZE.frozen) return;
    const p = CHASE_LIVE.projectTap?.(sx, sy);
    if (!p) return;
    let best: {
      d: number;
      kind: "paper" | "anchor" | "door";
      x: number;
      z: number;
      ref: string | null;
    } | null = null;
    for (const paper of GAME_DEBUG.papers) {
      const d = Math.hypot(p.x - paper.x, p.z - paper.z);
      if (d <= 1.6 && (best === null || d < best.d)) {
        best = { d, kind: "paper", x: paper.x, z: paper.z, ref: paper.ref };
      }
    }
    const anchor = GAME_DEBUG.anchor;
    if (anchor.kind !== "") {
      const d = Math.hypot(p.x - anchor.x, p.z - anchor.z);
      if (d <= 2 && (best === null || d < best.d)) {
        best = { d, kind: "anchor", x: anchor.x, z: anchor.z, ref: null };
      }
    }
    for (const door of GAME_DEBUG.windowDoors) {
      const d = Math.hypot(p.x - door.x, p.z - door.z);
      if (d <= 1.8 && (best === null || d < best.d)) {
        best = { d, kind: "door", x: door.x, z: door.z * 1.15, ref: null };
      }
    }
    if (best === null) return;
    const pick = best;
    if (pick.kind === "paper" && pick.ref !== null) {
      onOpenDocRef.current?.(pick.ref);
      return;
    }
    walkRef.current = {
      active: true,
      x: pick.x,
      z: pick.z,
      arrive: pick.kind === "anchor" ? 1.3 : 0.45,
      interact: pick.kind === "anchor",
      still: 0,
      lastD: Number.POSITIVE_INFINITY,
    };
    CHASE_LIVE.walkX = pick.x;
    CHASE_LIVE.walkZ = pick.z;
    CHASE_LIVE.walking = true;
  }, [suspended]);

  // THE ROOM'S LOOSE PAPERS (v0.25a §五 B②): the slice's own record sheet +
  // the newest documents that stamped it. The list arrives async (one
  // server-action read per room); the spots are the geometry chain's pure
  // derivation, already here. The pack carries its slice id so a stale list
  // can never print against the next room's spots.
  const [roomPapersPack, setRoomPapersPack] = useState<{
    sliceId: string;
    papers: RoomPaper[];
  } | null>(null);
  useEffect(() => {
    const sliceId = mountedSpace?.recipe.sliceId ?? null;
    if (sliceId === null) {
      setRoomPapersPack(null);
      return;
    }
    let live = true;
    if (isDebugSlice(sliceId)) { setRoomPapersPack({ sliceId, papers: [] }); return; }
    getRoomPapers(sliceId, persona)
      .then((papers) => {
        if (live) setRoomPapersPack({ sliceId, papers });
      })
      .catch(() => {
        if (live) setRoomPapersPack({ sliceId, papers: [] });
      });
    return () => {
      live = false;
    };
  }, [mountedSpace?.recipe.sliceId, persona, sourceScope]);
  // Spot × document merge. The geometry call duplicates activeRoomGeometry's
  // derivation when the mounted room IS the active one — one extra pure pass
  // per mount, the A6 price both lanes already pay.
  const mountedPapers = useMemo<RoomPaperItem[]>(() => {
    if (
      mountedSpace === null ||
      roomPapersPack === null ||
      roomPapersPack.sliceId !== mountedSpace.recipe.sliceId
    )
      return [];
    const spots = roomGeometryForSpace(
      mountedSpace,
      mountedSpace.roomDoorCount,
    ).paperSpots;
    return roomPapersPack.papers.flatMap((paper, i) => {
      const spot = spots[i];
      return spot === undefined
        ? []
        : [{ spot, ref: paper.ref, title: paper.title, date: paper.date }];
    });
  }, [mountedSpace, roomPapersPack]);
  // Probe mirror (e2e): the ACTIVE room's sheets in world coordinates — a
  // probe teleports to one and fires interact(), never enters the scene.
  useEffect(() => {
    if (activeSpace === null) {
      GAME_DEBUG.papers = [];
      return;
    }
    const dir = activeSpace.door.z > 0 ? 1 : -1;
    GAME_DEBUG.papers = mountedPapers.map((p) => ({
      ref: p.ref,
      x: activeSpace.door.x + dir * p.spot.x,
      z: activeSpace.door.z + dir * p.spot.z,
    }));
  }, [activeSpace, mountedPapers]);

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
    navigationEpoch.current += 1;
    setReturnRequest(null);
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
    navigationEpoch.current += 1;
    setReturnRequest(null);
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
  const handleReturnDoor = async (side: Side, retry = false, base = false): Promise<void> => {
    if (returnRequest?.status === "loading" && !retry && !base) return;
    const trip = splitReturnTrip(navStackRef.current, side);
    if (trip === null) return;
    const token = ++navigationEpoch.current;
    const origin = { ...playerRef.current };
    const entry = trip.entry;
    const returnTo = entry.returnTo;
    if (returnTo === null) {
      navStackRef.current = trip.rest;
      syncNavStack();
      setLocation(entry.hotel);
      setReturnRequest(null);
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
      navStackRef.current = trip.rest;
      syncNavStack();
      setLocation(entry.hotel);
      setReturnRequest(null);
      arriveInLobby();
      return;
    }
    const backArchetypes = new Map<string, ArchetypeId>();
    for (const d of backDoors) {
      if (d.archetype !== undefined) backArchetypes.set(d.sliceId, d.archetype);
    }
    let profile = returnTo.snapshot?.profile ?? NEUTRAL_ROOM_PROFILE;
    if (!returnTo.snapshot && !isDebugSlice(door.sliceId)) {
      const request = profileCache.capture(sourceScope, persona, door.sliceId);
      setReturnRequest({ side, request, status: "loading" });
      const result = base ? profileCache.fallback(request)
        : await (retry ? profileCache.retry(request) : profileCache.load(request));
      if (token !== navigationEpoch.current || !profileCache.isCurrent(request) ||
        Math.hypot(playerRef.current.x - origin.x, playerRef.current.z - origin.z) > 1.5) {
        if (token === navigationEpoch.current) setReturnRequest(null);
        return;
      }
      const verdict = decideGate(result);
      if (verdict.kind !== "commit") {
        setReturnRequest({ side, request, status: "retry" });
        return;
      }
      profile = verdict.profile;
    }
    const space = resolveSpaceForDoor(
      door,
      backArchetypes,
      roomDoorCountFor(door.sliceId),
      profile,
      returnTo.snapshot,
    );
    navStackRef.current = trip.rest;
    syncNavStack();
    setLocation(entry.hotel);
    setReturnRequest(null);
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
      returnTo: { sliceId: shownSpace.door.sliceId, key: strandTransition.key, snapshot: shownSpace.snapshot },
      // §10.5: the lateral this trip came in from — the corridor wall the
      // departed room's door hangs on — so the destination lobby hangs the
      // way back on the matching wall.
      side: shownSpace.door.side,
    });
    syncNavStack();
    navigationEpoch.current += 1;
    setReturnRequest(null);
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
      navigationEpoch.current += 1;
      setReturnRequest(null);
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
    if (suspended || !focusSlice || focusAppliedRef.current === focusSlice) return;
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
    navigationEpoch.current += 1;
    setReturnRequest(null);
    visitFallback.current = null;
    setActiveSpace(null);
    setShownSpace(null);
    setCorridorHidden(false);
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
      setPrewarmDoor(door);
      prewarmIdRef.current = door.sliceId;
      playerRef.current = { x: door.x, z: 0 };
      cameraSnapRef.current = true;
      hopGuardRef.current = true;
    }
  }, [focusSlice, doors, timelines, location, activeSpace, suspended]);

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
      // Frozen under the document tier: the world's keys stand down — no
      // preventDefault either, so the desk's own arrow/Enter bindings (and
      // the page's scroll) keep their default behaviour while reading.
      if (suspendedRef.current || GAME_SIM_FREEZE.frozen) return;
      const key = event.key.toLowerCase();
      const targetOwnsKeys = isEditableTarget(event.target) ||
        (event.target instanceof HTMLElement && event.target.closest("button, a, select, [role='button'], [role='menuitem']") !== null);
      // Nearby papers and terminals share Enter/E. Focused chrome owns
      // its keys, including menu arrows, while the scene remains visible.
      if (key === "enter" || key === "e") {
        if (shouldInteractWithScene({
          key,
          blocked: suspendedRef.current || WORLD_TRANSITION.active || GAME_SIM_FREEZE.frozen,
          targetOwnsKeys,
          hasPaper: paperHudRef.current !== null,
          hasAnchor: anchorHudRef.current !== null,
        })) {
          event.preventDefault();
          interactRef.current();
        }
        return;
      }
      if (!HANDLED_KEYS.has(key) || targetOwnsKeys) return;
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

  useEffect(() => {
    if (!suspended) return;
    keysRef.current.clear();
    motionRef.current = { x: 0, z: 0, moving: false };
    walkRef.current.active = false;
  }, [suspended]);

  // THE FROZEN-FRAME COMPOSER REF. The hotel's composer, captured through
  // a stable callback ref so the suspended one-shot repaint (component
  // above) can drive it while the wrapper's own useFrame is disabled. The
  // wrapper's `enabled={!suspended}` only gates its useFrame — it never
  // disposes the composer — so a manual `setSize(CSS size) + render(0)`
  // reproduces the paused frame exactly (N8AO included,
  // delta 0, no clock advanced). State (not a bare ref) so the composer's
  // arrival re-runs the repaint effect and a repaint deferred while the
  // composer was unready still lands.
  const [frozenFrameComposer, setFrozenFrameComposer] =
    useState<ComponentRef<typeof EffectComposer> | null>(null);
  const frozenFrameComposerRef = useCallback(
    (composer: ComponentRef<typeof EffectComposer> | null) => {
      setFrozenFrameComposer(composer);
    },
    [],
  );

  // THE CANVAS IS THE SHELL'S (§14 merge). This component keeps every
  // cross-module decision and the DOM HUD; the scene subtree renders in the
  // app's ONE shared canvas through the world slot (`useWorldScene`). The
  // renderer-level props the old standalone canvas carried moved to the
  // WORLD CONTRACT (world-canvas.tsx / world-contract.ts), applied whenever
  // the game world is mounted:
  //   shadows → PCFShadowMap (three 0.185 deprecated PCFSoft; the shared
  //   canvas declares it via fiber's object form, world-canvas.tsx),
  //   the active composer's NoToneMapping pin (world-transition.ts),
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
      <GameTimeOwner />
      <CorridorHideDelay hidden={corridorHidden} onHidden={setCorridorGone} />
      <Atmosphere space={activeSpace} dark={dark} playerRef={playerRef} />
        <RenderTrace />
        <CameraRig
          playerRef={playerRef}
          motionRef={motionRef}
          space={activeSpace}
          snapRef={cameraSnapRef}
          mode={cameraMode}
          solids={cameraSolids}
          waterSide={waterSide}
        />
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
          {/* The lobby's anchor (§13.1): the ONE live terminal — the
              emitter disc marking the machine's footprint and its point
              light. Lives in the corridor wrapper so it unmounts with the
              corridor (HIDE_DELAY_MS after a room engages) and eases down
              with the same dissolve (`dimmed`). */}
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
            papers={mountedPapers}
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
          walkRef={walkRef}
          onWalkArrive={() => interactRef.current()}
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
          roomReadiness={roomReadiness}
          activeSpace={activeSpace}
          setActiveSpace={setActiveSpace}
          corridorHidden={corridorHidden}
          setCorridorHidden={setCorridorHidden}
          hudIdRef={hudIdRef}
          setHudDoor={setHudDoor}
          prewarmIdRef={prewarmIdRef}
          setPrewarmDoor={setPrewarmDoor}
          transitionActive={strandTransition.phase !== "idle"}
          suspended={suspended}
          roomDoors={activeRoomGeometry?.doors ?? []}
          roomPlan={activeRoomGeometry?.plan ?? NO_ROOM_PLAN}
          roomSeams={activeRoomGeometry?.seams ?? NO_ROOM_SEAMS}
          roomPapers={mountedPapers}
          paperHudRef={paperHudRef}
          setPaperHud={setHudPaper}
          lobbyAnchorLabel={hotelName}
          departingRef={departingRef}
          departWatchRef={departWatchRef}
          anchorHudRef={anchorHudRef}
          setHudAnchor={setHudAnchor}
        />
        {/* Post chain — deliberately minimal. N8AO (half-res) is the only
            live effect: gentle screen-space contact shading that grounds
            furniture and walls without a veil. It is camera-distance
            INDEPENDENT, so it cannot wash the whole room into one color
            the way distance fog did from this camera (commits
            9116243/09c757b). Bloom, Vignette and the stage backdrop were
            removed in the matte overhaul. Export names
            verified against @react-three/postprocessing v3 dist .d.ts.
            `enabled={!suspended}` freezes the chain's automatic render
            under the document tier — the one-shot frozen-frame repainter
            below is the only manual drive it ever gets, and only for a
            suspended size/DPR change (frozen-frame.ts). */}
        <EffectComposer
          ref={frozenFrameComposerRef}
          enabled={!suspended}
          multisampling={POST_MSAA_SAMPLES}
        >
          <N8AO
            halfRes
            quality="performance"
            intensity={AO_INTENSITY}
            aoRadius={AO_RADIUS}
            distanceFalloff={AO_DISTANCE_FALLOFF}
          />
        </EffectComposer>
        {/* Suspended one-shot repaint: repaints the frozen hotel frame
            exactly once when a mid-pause resize/DPR change cleared the
            canvas (decisions in src/lib/timeline3d/frozen-frame.ts). No-op
            while active — the composer's own useFrame owns every frame. */}
        <FrozenGameFrameRepaint
          suspended={suspended}
          composer={frozenFrameComposer}
        />
    </>
  );

  return (
    <div className="relative h-full w-full">
      {!suspended && (returnRequest || profileStatus?.kind === "hold") && (
        <div data-testid="room-profile-status" className="absolute left-1/2 top-24 z-20 flex -translate-x-1/2 items-center gap-3 rounded-full border border-white/30 bg-background/85 px-4 py-2 text-sm shadow-sm backdrop-blur-md" role="status" aria-live="polite">
          <span>{t((returnRequest?.status ?? (profileStatus?.kind === "hold" ? profileStatus.status : "loading")) === "loading" ? "roomPreparing" : "roomUnavailable")}</span>
          {(returnRequest?.status ?? (profileStatus?.kind === "hold" ? profileStatus.status : null)) === "retry" && <>
            <button type="button" onClick={retryProfile} className="underline underline-offset-4">{t("roomRetry")}</button>
            <button type="button" onClick={enterBaseRoom} className="whitespace-nowrap underline underline-offset-4">{t("roomEnterBase")}</button>
          </>}
        </div>
      )}
      {!suspended && (
        <>
          <TouchControls onTap={handleTap} />
          <Hud
            door={hudDoor}
            anchor={hudAnchor}
            paper={hudPaper}
            enterHint={t("enter")}
            readHint={t("readDoc")}
            onInteract={() => interactRef.current()}
          />
        </>
      )}
    </div>
  );
}
