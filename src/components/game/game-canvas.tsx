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
 * top-right→bottom-left on screen. It never rotates, never zooms; useFrame
 * only lerps the follow point (factor 1 − e^(−6·dt)), so the view glides
 * instead of snapping.
 *
 * MOVEMENT & CLAMPS. WASD + arrow keys move the player on the XZ plane at
 * 4 m/s, delta-time corrected, screen-relative (screen-up is world
 * (+x, −z), screen-right (+x, +z) for this camera — verified against the
 * lookAt direction). The door manager alternates clampToCorridor and
 * clampToSpace on a hysteresis band around the wall plane (|z| 4.8–5.2
 * with the ten-meter corridor).
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
 * ATMOSPHERE. Background, fog (color/near/far), and the directional sun
 * lerp (factor 1 − e^(−2.5·dt)) between two target moods defined once in
 * resolveAtmosphere: the corridor (the void color, fog 30–90, matching the
 * corridor's end-fade planes) and the active space's palette. Inside a
 * space there is no distance fog — the room's far edge melts into its own
 * shadow (the background IS the palette's atmosphere fog), and fog planes
 * near the camera distance washed the contents into a translucent veil;
 * the sun tints to palette.sunColor × sunIntensity.
 *
 * DETERMINISM. No randomness in this file at all — every generated thing the
 * player sees comes from corridor/space renderers fed by the seed module.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { Canvas, useFrame } from "@react-three/fiber";
import { OrthographicCamera } from "@react-three/drei";
import { useTranslations } from "next-intl";
import { useTheme } from "@teispace/next-themes";
import type { JSX, MutableRefObject } from "react";
import { GAME_DEBUG } from "./debug";
import { doorPosition, nearestDoor, type DoorRef } from "@/lib/game/hotel";
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
import { terrainHeight, waterSideFor } from "@/lib/game/terrain";
import { Corridor, HIDE_DELAY_MS, VOID_COLORS, type CorridorDoor } from "./corridor";
import { SpaceScene } from "./space";

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

/** The one space that may be mounted at a time. */
interface ActiveSpace {
  door: DoorRef;
  recipe: SpaceRecipe;
}

type PlayerRef = MutableRefObject<PlayerPos>;

/** Live player/atmosphere/fade state for probes — re-exported from the
 *  shared module (see debug.ts). */
export { GAME_DEBUG } from "./debug";

/** Scene mood while no space is active — the void color for the active
 *  theme (exported from corridor.tsx so the end-fade planes always match
 *  the background/fog). */
const SCENE_COLORS = VOID_COLORS;
const FOG_NEAR = 30;
const FOG_FAR = 90;
/** Inside a space there is NO distance fog: the room's own shadow (the
 *  palette's atmosphere fog, painted as the scene background) already melts
 *  its far edge away, and any fog plane near the camera-to-player distance
 *  (~23 m at CAM_OFFSET) washed the whole room in its fog color — the
 *  floor, the furniture, the player all read as translucent. Pushed past
 *  any real view distance, fog effectively leaves the room. */
const SPACE_FOG_NEAR = 500;
const SPACE_FOG_FAR = 1000;

const CAMERA_ZOOM = 34;
const CAM_OFFSET = { x: -12, y: 16, z: 12 };
/** Follow smoothing: factor = 1 − e^(−rate·dt). */
const CAMERA_LERP_RATE = 6;

const PLAYER_SPEED = 4; // m/s
/** Clamp per-frame dt so a background tab can't tunnel the player through a wall. */
const MAX_DT = 0.05;
const BOB_RATE = 9; // rad/s while walking
const BOB_HEIGHT = 0.05;
const TURN_LERP_RATE = 12;
/** Avatar Y snapping toward the terrain (or back to corridor floor). */
const GROUND_LERP_RATE = 10;

const PLAYER_BODY = "#e8935c"; // warm accent
const PLAYER_HEAD = "#f4d3ae";
const SUN_BASE_COLOR = "#fff4e0";
const SUN_BASE_INTENSITY = 0.9;
/** Background/fog/sun lerp rate when a space opens or closes. */
const ATMOSPHERE_LERP_RATE = 2.5;
/** Water plane height — mirrors WATER_Y in space.tsx (module-local there). */
const WATER_SURFACE_Y = 0.35;
/** Wade depth below the water plane inside a pool basin. */
const WADE_DEPTH = 0.25;

/** Door grab distance when resolving which space a wall crossing enters. */
const DOOR_GRAB_DIST = 2.5;
/** HUD prompt radius around a door. */
const HUD_DIST = 1.8;

/** Player spawn: lobby floor, clear of the desk and armchairs. */
const SPAWN: PlayerPos = { x: 6, z: 0 };

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

/**
 * X of every door the slice list materializes, in bay order — the corridor
 * clamp's gap test. Mirrors doorsInChunk's pairing (sliceIds[2i] north,
 * sliceIds[2i + 1] south of bay i); both sides share one x per bay.
 */
function doorXsFor(sliceIds: readonly string[]): number[] {
  const xs: number[] = [];
  for (let i = 0; ; i++) {
    const northId = sliceIds[2 * i];
    const southId = sliceIds[2 * i + 1];
    if (northId === undefined && southId === undefined) break;
    if (northId !== undefined) xs.push(doorPosition(i, "north").x);
    if (southId !== undefined) xs.push(doorPosition(i, "south").x);
  }
  return xs;
}

/**
 * Avatar ground target at a world position inside an active space: the
 * shared terrainHeight in the space's local frame, with pool basins waded
 * at a fixed depth instead of walked on the floor. The local transform
 * mirrors SpaceScene's group exactly (space.tsx): north doors sit at
 * rotation 0 → local = world − door; south doors rotate π about Y →
 * local = −(world − door).
 */
function groundTargetY(
  space: ActiveSpace,
  waterSide: number,
  x: number,
  z: number,
): number {
  const { door, recipe } = space;
  const lx = door.z > 0 ? x - door.x : -(x - door.x);
  const lz = door.z > 0 ? z - door.z : -(z - door.z);
  const terrainY = terrainHeight(recipe, lx, lz);
  const waterHalf = waterSide / 2;
  if (
    waterHalf > 0 &&
    terrainY < WATER_SURFACE_Y &&
    Math.abs(lx) <= waterHalf &&
    Math.abs(lz - recipe.size.extent / 2) <= waterHalf
  ) {
    return Math.max(terrainY, WATER_SURFACE_Y - WADE_DEPTH);
  }
  return terrainY;
}

/** The atmosphere's target mood — one place defines both states. */
interface AtmosphereTargets {
  background: THREE.Color;
  fogColor: THREE.Color;
  fogNear: number;
  fogFar: number;
  sunColor: THREE.Color;
  sunIntensity: number;
}

/**
 * Resolve the target atmosphere for the current state into `out` (no
 * per-frame allocation): the corridor mood in the active theme's void
 * color, or the active space's palette under a fog of war — near tightens
 * to arm's length and the far plane covers only a short walk, so a space
 * reveals itself as you explore — with the sun tinted/intensified by the
 * palette. The space branch is theme-independent: a space's palette is
 * seed-fixed, not part of the app dark mode.
 */
function resolveAtmosphere(
  space: ActiveSpace | null,
  dark: boolean,
  out: AtmosphereTargets,
): AtmosphereTargets {
  if (space !== null) {
    const { palette } = space.recipe;
    // Background uses the recipe's atmosphere fog: a deep, hue-faithful
    // shadow of the room's own palette (see atmosphereFog in space-recipe).
    // The background is never fogged, so sharing the fog color makes the
    // room's far edge melt seamlessly into its own shadow. The room itself
    // stays fog-free (SPACE_FOG_NEAR/FAR) — fog planes near the camera
    // distance washed the contents into a translucent veil.
    out.background.set(palette.fog);
    out.fogColor.set(palette.fog);
    out.fogNear = SPACE_FOG_NEAR;
    out.fogFar = SPACE_FOG_FAR;
    out.sunColor.set(palette.sunColor);
    out.sunIntensity = SUN_BASE_INTENSITY * palette.sunIntensity;
  } else {
    const voidColor = SCENE_COLORS[dark ? "night" : "day"];
    out.background.set(voidColor);
    out.fogColor.set(voidColor);
    out.fogNear = FOG_NEAR;
    out.fogFar = FOG_FAR;
    out.sunColor.set(SUN_BASE_COLOR);
    out.sunIntensity = SUN_BASE_INTENSITY;
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Scene parts                                                         */
/* ------------------------------------------------------------------ */

/** Fixed 45° camera: lerped follow point + constant offset, lookAt player. */
function CameraRig({ playerRef }: { playerRef: PlayerRef }): JSX.Element {
  const focus = useRef(
    new THREE.Vector3(playerRef.current.x, 0, playerRef.current.z),
  );
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
  });

  return <OrthographicCamera makeDefault zoom={CAMERA_ZOOM} position={initialPosition} />;
}

/**
 * Scene background, fog, and sun — lerp continuously toward the target
 * mood (corridor vs active space palette) instead of swapping on mount.
 * The JSX objects are constructed once (constant args) and mutated in
 * place each frame; resolveAtmosphere is the single source of the targets.
 * `dark` follows the app theme — the corridor branch of the targets uses
 * the theme's void color; a toggle eases through the same lerp.
 */
function Atmosphere({
  space,
  dark,
}: {
  space: ActiveSpace | null;
  dark: boolean;
}): JSX.Element {
  const bgRef = useRef<THREE.Color>(null);
  const fogRef = useRef<THREE.Fog>(null);
  const sunRef = useRef<THREE.DirectionalLight>(null);
  // Reusable target bucket — resolved fresh each frame, never reallocated.
  const [targets] = useState<AtmosphereTargets>(() => ({
    background: new THREE.Color(SCENE_COLORS.night),
    fogColor: new THREE.Color(SCENE_COLORS.night),
    fogNear: FOG_NEAR,
    fogFar: FOG_FAR,
    sunColor: new THREE.Color(SUN_BASE_COLOR),
    sunIntensity: SUN_BASE_INTENSITY,
  }));

  useFrame((_, dt) => {
    const bg = bgRef.current;
    const fog = fogRef.current;
    const sun = sunRef.current;
    if (!bg || !fog || !sun) return;
    const k = 1 - Math.exp(-ATMOSPHERE_LERP_RATE * Math.min(dt, MAX_DT));
    resolveAtmosphere(space, dark, targets);
    bg.lerp(targets.background, k);
    fog.color.lerp(targets.fogColor, k);
    fog.near += (targets.fogNear - fog.near) * k;
    fog.far += (targets.fogFar - fog.far) * k;
    sun.color.lerp(targets.sunColor, k);
    sun.intensity += (targets.sunIntensity - sun.intensity) * k;
    // Probe mirror — lets the browser console read the live fog/background
    // state when diagnosing "is the veil fog or material alpha".
    GAME_DEBUG.fogNear = fog.near;
    GAME_DEBUG.fogFar = fog.far;
    GAME_DEBUG.bg = `#${bg.getHexString()}`;
    GAME_DEBUG.sunColor = `#${sun.color.getHexString()}`;
    GAME_DEBUG.sunIntensity = +sun.intensity.toFixed(3);
    GAME_DEBUG.ambient = 0.45;
  });

  return (
    <>
      <color ref={bgRef} attach="background" args={[SCENE_COLORS.night]} />
      <fog ref={fogRef} attach="fog" args={[SCENE_COLORS.night, FOG_NEAR, FOG_FAR]} />
      <ambientLight intensity={0.45} />
      <directionalLight
        ref={sunRef}
        position={[8, 14, 4]}
        intensity={SUN_BASE_INTENSITY}
        color={SUN_BASE_COLOR}
      />
    </>
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
        <mesh position={[0, 0.45, 0]}>
          <capsuleGeometry args={[0.26, 0.38, 4, 10]} />
          <meshStandardMaterial color={PLAYER_BODY} roughness={1} flatShading />
        </mesh>
        <mesh position={[0, 1.04, 0.02]}>
          <sphereGeometry args={[0.19, 12, 10]} />
          <meshStandardMaterial color={PLAYER_HEAD} roughness={1} flatShading />
        </mesh>
        {/* Visor nub — marks the facing direction (+z local). */}
        <mesh position={[0, 1.04, 0.2]} rotation={[Math.PI / 2, 0, 0]}>
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

    // 1. Movement — screen-relative, dt-corrected, no acceleration.
    const move = moveVectorFromKeys(keysRef.current);
    const moving = move.x !== 0 || move.z !== 0;
    motionRef.current = { x: move.x, z: move.z, moving };
    if (moving) {
      const dt = Math.min(delta, MAX_DT);
      p.x += move.x * PLAYER_SPEED * dt;
      p.z += move.z * PLAYER_SPEED * dt;
    }

    // 2. Door manager — hysteresis band around the wall plane. While a
    // space is active ONLY its own door can matter: a big room spans many
    // door bays, and re-resolving nearestDoor here would let the player
    // "walk through the wall" into the neighboring door's space.
    let space = activeSpace;
    const az = Math.abs(p.z);
    if (az > WALL_OUT && space === null) {
      const door = nearestDoor(p.x, p.z, sliceIds, DOOR_GRAB_DIST);
      if (door) {
        const recipe = compileSpaceRecipe(door.sliceId);
        const archetype = archetypeById.get(door.sliceId);
        space = {
          door,
          recipe: archetype === undefined ? recipe : { ...recipe, archetype },
        };
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

    // 3. Clamps for wherever the player ended up.
    if (space !== null) {
      clampToSpace(p, space.door, space.recipe.width, space.recipe.size.extent);
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
    const near = nearestDoor(p.x, p.z, sliceIds, HUD_DIST);
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
  // (fade="out", see SPACE_FADE_S in space.tsx) before unmounting — the
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
  const doorXs = useMemo(() => doorXsFor(sliceIds), [sliceIds]);
  const archetypeById = useMemo(() => {
    const map = new Map<string, ArchetypeId>();
    for (const door of doors) {
      if (door.archetype !== undefined) map.set(door.sliceId, door.archetype);
    }
    return map;
  }, [doors]);
  // 0 for every archetype without water (waterCoverage = 0 → side 0).
  const waterSide = useMemo(
    () => (activeSpace !== null ? waterSideFor(activeSpace.recipe) : 0),
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
      <Canvas frameloop="always" dpr={[1, 2]} gl={{ antialias: true }}>
        <Atmosphere space={activeSpace} dark={dark} />
        <CameraRig playerRef={playerRef} />
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
          archetypeById={archetypeById}
          activeSpace={activeSpace}
          setActiveSpace={setActiveSpace}
          corridorHidden={corridorHidden}
          setCorridorHidden={setCorridorHidden}
          hudIdRef={hudIdRef}
          setHudDoor={setHudDoor}
        />
      </Canvas>
      <Hud door={hudDoor} enterHint={t("enter")} />
    </div>
  );
}
