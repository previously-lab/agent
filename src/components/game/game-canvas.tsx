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
 * snapping. The zoom TARGET is CAMERA_ZOOM in the corridor and eases down
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
 * corridor chunks stream, at most one space exists, and the corridor dims
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
 * a key/fill/ambient hierarchy (v0.11 P2): the sun is the one strong,
 * shadow-casting KEY light (its shadow camera follows the player so the
 * whole streaming corridor and every space stay inside the frustum); soft
 * FILL comes from one scene-wide <Environment> of Lightformer cards (IBL,
 * no HDRI) that also gives every PBR material something to reflect; the
 * AMBIENT term is a deliberately low floor so light pools instead of
 * filling evenly (doc §1 A3). Tone mapping is AgX, not the ACES default —
 * saturated accent colors clip under ACES.
 *
 * DEPTH CUE. There is NO scene fog
 * anywhere: with the camera ~23m above the player, every fog band that
 * could sell depth also washed the whole visible room into the fog color
 * (commits 9116243/09c757b/d9edf93 — do not re-add). Depth is carried by
 * things that are camera-distance INDEPENDENT instead: the background
 * color, the stage backdrop disc the diorama sits on (plain geometry at a
 * fixed depth — no distance term), the corridor's end-fade planes, and
 * the post chain — N8AO
 * (screen-space contact shading) plus a mild Vignette (frame-edge
 * falloff), both of which darken by geometry and screen position, never
 * by distance from the camera, so they cannot reproduce the
 * translucent-room bug. Bloom (threshold 1.0) glows only emissive
 * fixtures and the sun's hot pools.
 *
 * DETERMINISM. No randomness in this file at all — every generated thing the
 * player sees comes from corridor/space renderers fed by the seed module.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { Canvas, useFrame } from "@react-three/fiber";
import { Environment, Lightformer, OrthographicCamera } from "@react-three/drei";
import { Bloom, EffectComposer, N8AO, Vignette } from "@react-three/postprocessing";
import { useTranslations } from "next-intl";
import { useTheme } from "@teispace/next-themes";
import type { JSX, MutableRefObject } from "react";
import { GAME_DEBUG } from "./debug";
import { materializedDoorXs, nearestDoor, type DoorRef } from "@/lib/game/hotel";
import {
  corridorLayoutFromDoors,
  type CorridorLayout,
} from "@/lib/game/corridor-pitch";
import {
  CLEAR_HALF,
  WALL_IN,
  WALL_OUT,
  WALL_Z,
  clampToCorridor,
  clampToSpace,
} from "@/lib/game/clamps";
import { compileSpaceRecipe } from "@/lib/game/space-recipe";
import type { ArchetypeId, SpaceRecipe } from "@/lib/game/space-types";
import { scaledRecipeFor, type ScaleNotation } from "@/lib/game/room-plan";
import { terrainHeight, waterSideFor } from "@/lib/game/terrain";
import { Corridor, type CorridorDoor } from "./corridor";
import { SpaceScene } from "./space";
import { HIDE_DELAY_MS } from "@/lib/game/tuning/hotel";
import { WATER_Y } from "@/lib/game/tuning/room";
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
 *  avatar physics all share. */
interface ActiveSpace {
  door: DoorRef;
  recipe: SpaceRecipe;
  scaledRecipe: SpaceRecipe;
  scale: ScaleNotation;
}

type PlayerRef = MutableRefObject<PlayerPos>;

/** Live player/atmosphere/fade state for probes — re-exported from the
 *  shared module (see debug.ts). */
export { GAME_DEBUG } from "./debug";

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
 * floor at any room scale. The local transform mirrors SpaceScene's group
 * exactly (space.tsx): north doors sit at rotation 0 → local = world −
 * door; south doors rotate π about Y → local = −(world − door).
 */
function groundTargetY(
  space: ActiveSpace,
  waterSide: number,
  x: number,
  z: number,
): number {
  const { door, scaledRecipe } = space;
  const lx = door.z > 0 ? x - door.x : -(x - door.x);
  const lz = door.z > 0 ? z - door.z : -(z - door.z);
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
    out.sunIntensity = SUN_BASE_INTENSITY * palette.sunIntensity;
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
/* Scene parts                                                         */
/* ------------------------------------------------------------------ */

/** Fixed 45° camera: lerped follow point + constant offset, lookAt player.
 *  The ortho zoom lerps (same easing) toward CAMERA_ZOOM divided by the
 *  active room's bounded pull-back — colossal rooms stay legible as rooms,
 *  and the corridor eases back to normal. */
function CameraRig({
  playerRef,
  space,
}: {
  playerRef: PlayerRef;
  space: ActiveSpace | null;
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
    const k = 1 - Math.exp(-CAMERA_LERP_RATE * Math.min(dt, MAX_DT));
    focus.current.x += (playerRef.current.x - focus.current.x) * k;
    focus.current.z += (playerRef.current.z - focus.current.z) * k;
    camera.position.set(
      focus.current.x + CAM_OFFSET.x,
      CAM_OFFSET.y,
      focus.current.z + CAM_OFFSET.z,
    );
    camera.lookAt(focus.current.x, 0, focus.current.z);
    const pullback = space === null ? 1 : roomZoomPullback(space.scale.factor);
    zoomRef.current += (CAMERA_ZOOM / pullback - zoomRef.current) * k;
    const ortho = camera as THREE.OrthographicCamera;
    ortho.zoom = zoomRef.current;
    ortho.updateProjectionMatrix();
  });

  return <OrthographicCamera makeDefault zoom={CAMERA_ZOOM} position={initialPosition} />;
}

/**
 * Scene background, ambient floor, and the KEY light — the one strong,
 * shadow-casting directional sun. Color/intensity lerp continuously toward
 * the target mood (corridor vs active space palette) instead of swapping
 * on mount; resolveAtmosphere is the single source of the targets. `dark`
 * follows the app theme — the corridor branch of the targets uses the
 * theme's void color; a toggle eases through the same lerp.
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
 */
function GameLoop({
  playerRef,
  keysRef,
  motionRef,
  doors,
  sliceIds,
  doorXs,
  layout,
  archetypeById,
  activeSpace,
  setActiveSpace,
  corridorHidden,
  setCorridorHidden,
  hudIdRef,
  setHudDoor,
}: {
  playerRef: PlayerRef;
  keysRef: MutableRefObject<Set<string>>;
  motionRef: MutableRefObject<Motion>;
  doors: readonly CorridorDoor[];
  sliceIds: readonly string[];
  doorXs: readonly number[];
  layout: CorridorLayout;
  archetypeById: ReadonlyMap<string, ArchetypeId>;
  activeSpace: ActiveSpace | null;
  setActiveSpace: (space: ActiveSpace | null) => void;
  corridorHidden: boolean;
  setCorridorHidden: (hidden: boolean) => void;
  hudIdRef: MutableRefObject<string | null>;
  setHudDoor: (door: CorridorDoor | null) => void;
}): null {
  useFrame((_, delta) => {
    const p = playerRef.current;

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
        (activeSpace === null ? 1 : roomSpeedFactor(activeSpace.scale.factor));
      p.x += move.x * speed * dt;
      p.z += move.z * speed * dt;
    }

    // 2. Door manager — hysteresis band around the wall plane. While a
    // space is active ONLY its own door can matter: a big room spans many
    // door bays, and re-resolving nearestDoor here would let the player
    // "walk through the wall" into the neighboring door's space.
    let space = activeSpace;
    const az = Math.abs(p.z);
    if (az > WALL_OUT && space === null) {
      const door = nearestDoor(p.x, p.z, sliceIds, DOOR_GRAB_DIST, layout);
      if (door) {
        const recipe = compileSpaceRecipe(door.sliceId);
        const archetype = archetypeById.get(door.sliceId);
        const finalRecipe = archetype === undefined ? recipe : { ...recipe, archetype };
        // The scaled view is computed ONCE here — room-plan.ts is the single
        // definition of "how big is this room"; clamps, terrain, and water
        // below all consume it, matching the geometry space.tsx builds.
        const { recipe: scaledRecipe, scale } = scaledRecipeFor(finalRecipe);
        space = { door, recipe: finalRecipe, scaledRecipe, scale };
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
    }

    // 3. Clamps for wherever the player ended up. The space clamp boxes to
    // the SCALED footprint — the same dims the room was built at, so the
    // player can reach the far end of a colossal room and cannot walk
    // through a miniature room's walls.
    if (space !== null) {
      clampToSpace(p, space.door, space.scaledRecipe.width, space.scaledRecipe.size.extent);
    } else {
      clampToCorridor(p, doorXs);
    }

    // 3b. Corridor visibility: the instant a space engages — the player has
    //  crossed the threshold — the world behind them begins to dissolve
    //  (dim at 6/s, unmount after HIDE_DELAY_MS), so entering a room reads
    //  as leaving the hotel behind, not as a window next door. The release
    //  is symmetric: back in the corridor band the hotel returns the same
    //  frame, remounting dark and easing up (useDimLerp's recovery lerp in
    //  corridor.tsx), so neither direction pops.
    const gone = space !== null;
    if (gone !== corridorHidden) setCorridorHidden(gone);

    // 4. HUD prompt — setState only when the nearest door identity changes.
    const near = nearestDoor(p.x, p.z, sliceIds, HUD_DIST, layout);
    const nearId = near ? near.sliceId : null;
    if (nearId !== hudIdRef.current) {
      hudIdRef.current = nearId;
      setHudDoor(nearId === null ? null : (doors.find((d) => d.sliceId === nearId) ?? null));
    }

    // 5. Probe/e2e debug handle — mutate the preallocated object, no re-render.
    GAME_DEBUG.x = p.x;
    GAME_DEBUG.z = p.z;
    GAME_DEBUG.space = space === null ? null : space.door.sliceId;
  });
  return null;
}

/** Bottom-center door prompt — label + localized hint, pointer-transparent. */
function Hud({
  door,
  enterHint,
}: {
  door: CorridorDoor | null;
  enterHint: string;
}): JSX.Element | null {
  if (door === null) return null;
  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-6 z-10 flex justify-center">
      <div className="rounded-full bg-black/35 px-4 py-1.5 font-serif text-sm text-neutral-300 backdrop-blur-sm">
        <span className="text-neutral-100">{door.label}</span>
        <span className="mx-2 text-neutral-500">·</span>
        <span>{enterHint}</span>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* GameCanvas                                                          */
/* ------------------------------------------------------------------ */

export default function GameCanvas({
  doors,
}: {
  doors: readonly CorridorDoor[];
}): JSX.Element {
  const t = useTranslations("game");
  // App dark mode, read OUTSIDE the Canvas — React context never crosses
  // the R3F reconciler boundary, so it is handed down as plain props.
  const { resolvedTheme } = useTheme();
  const dark = resolvedTheme !== "light";
  const playerRef = useRef<PlayerPos>({ ...SPAWN });
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

  const sliceIds = useMemo(() => doors.map((d) => d.sliceId), [doors]);
  const layout = useMemo(() => corridorLayoutFromDoors(doors), [doors]);
  const doorXs = useMemo(
    () => materializedDoorXs(sliceIds, layout),
    [sliceIds, layout],
  );
  const archetypeById = useMemo(() => {
    const map = new Map<string, ArchetypeId>();
    for (const door of doors) {
      if (door.archetype !== undefined) map.set(door.sliceId, door.archetype);
    }
    return map;
  }, [doors]);
  // 0 for every archetype without water (waterCoverage = 0 → side 0). The
  // scaled view keeps the wade rectangle coincident with the water plane
  // the renderer built.
  const waterSide = useMemo(
    () => (activeSpace !== null ? waterSideFor(activeSpace.scaledRecipe) : 0),
    [activeSpace],
  );

  // Probe/e2e debug handle on window (GAME_DEBUG is updated every frame).
  useEffect(() => {
    GAME_DEBUG.teleport = (x, z) => {
      playerRef.current.x = x;
      playerRef.current.z = z;
    };
    window.__gameDebug = GAME_DEBUG;
    return () => {
      GAME_DEBUG.teleport = undefined;
      delete window.__gameDebug;
    };
  }, []);

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

  return (
    <div className="relative h-full w-full">
      {/*
        shadows="percentage" → PCFShadowMap. three 0.185 DEPRECATED
        PCFSoftShadowMap: WebGLShadowMap now warns and silently rewrites
        it to PCFShadowMap at render time (WebGLShadowMap.js — "PCFSoftShadowMap
        has been deprecated. Using PCFShadowMap instead."), so the old
        shadows="soft" only claimed softness while shipping PCF. This value
        names what actually runs. Verified against the installed packages:
        fiber's dist maps "percentage" → THREE.PCFShadowMap.
        Softer options and why none is taken here: VSM ("variance") leaks
        light through the thin interior geometry; drei's <SoftShadows>
        (PCSS) recompiles every material's shader on mount (a hitch per
        streamed chunk/room); drei <AccumulativeShadows> bakes once and
        needs a static scene — the corridor is a streaming treadmill whose
        shadow camera follows the player, so a bake is stale the moment the
        player moves. Genuinely soft shadows would take a custom PCSS
        shadow shader or a light that never moves relative to static
        geometry.
        Tone mapping: AgX via the gl props — R3F applies plain-object gl
        props onto the renderer (applyProps) AFTER installing its ACES
        default on first configure, so this wins; saturated accent colors
        clip under ACES, and the `flat` prop would disable tone mapping
        entirely. three 0.185 enum: THREE.AgXToneMapping (6).
      */}
      <Canvas
        frameloop="always"
        dpr={[1, 2]}
        gl={{ antialias: true, toneMapping: THREE.AgXToneMapping }}
        shadows="percentage"
      >
        <Atmosphere space={activeSpace} dark={dark} playerRef={playerRef} />
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
        <CameraRig playerRef={playerRef} space={activeSpace} />
        {/* The corridor dissolves the moment a space engages (GameLoop above)
          and unmounts HIDE_DELAY_MS later; on return it remounts dark and
          eases back up. */}
        <Corridor
          playerRef={playerRef}
          doors={doors}
          dimmed={corridorHidden}
          dark={dark}
        />
        <PlayerAvatar
          playerRef={playerRef}
          motionRef={motionRef}
          space={activeSpace}
          waterSide={waterSide}
        />
        {shownSpace !== null && (
          <SpaceScene
            key={shownSpace.recipe.sliceId}
            recipe={shownSpace.recipe}
            door={shownSpace.door}
            playerRef={playerRef}
            corridorGone={corridorGone}
            fade={activeSpace !== null ? "in" : "out"}
            onFadedOut={() => setShownSpace(null)}
          />
        )}
        <GameLoop
          playerRef={playerRef}
          keysRef={keysRef}
          motionRef={motionRef}
          doors={doors}
          sliceIds={sliceIds}
          doorXs={doorXs}
          layout={layout}
          archetypeById={archetypeById}
          activeSpace={activeSpace}
          setActiveSpace={setActiveSpace}
          corridorHidden={corridorHidden}
          setCorridorHidden={setCorridorHidden}
          hudIdRef={hudIdRef}
          setHudDoor={setHudDoor}
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
      </Canvas>
      <Hud door={hudDoor} enterHint={t("enter")} />
    </div>
  );
}
