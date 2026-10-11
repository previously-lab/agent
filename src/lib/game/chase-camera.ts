/**
 * The third-person chase camera (v0.28) — the pure half: rig constants, the
 * camera-yaw movement basis, and the analytic occlusion solids the boom's
 * sphere cast tests against. No three.js, no React — the integrator
 * (game-canvas.tsx) owns the per-frame loop; everything measurable lives
 * here so the unit tests can pin it.
 *
 * THE SOLIDS ARE THE CLAMPS' OWN DATA. The cast never touches render
 * meshes: the corridor/lobby walls are the planes clampToHotel boxes the
 * player by (hotel.ts + clamps.ts + the integrator's clampToHotel), the
 * room's walls are wallSegmentsFor over the SAME plan the movement clamp
 * consumes, the seam jambs are the clamp's SeamWall boxes, and the
 * terminal is the anchor's own footprint (anchor.ts). One derivation, two
 * call sites — the camera is contained by exactly the walls the player is.
 *
 * DRAWN HEIGHT, NOT FULL HEIGHT. A wall the renderer cut to the dollhouse
 * sill (WALL_SILL_HEIGHT — wallFacesCamera) or the lobby's cutaway parapet
 * is solid only up to its DRAWN height: the sight line from the pivot
 * (1.35 m) to the camera (1.9 m) clears a 1.1 m sill, so a sill must never
 * pull the boom in — exactly like the lobby parapet the player can see
 * over. Full-height walls (and the never-cut entrance wall) are solid to
 * the room's drawn wall height.
 */

import { WALL_Z, type SeamWall } from "./clamps";
import {
  CORRIDOR_WIDTH,
  LOBBY_LENGTH,
  LOBBY_SOUTH_REACH,
  WALL_HEIGHT,
} from "./hotel";
import { wallSegmentsFor, type RoomPlan } from "./room-plan";
import { wallFacesCamera } from "./room-doors";
import {
  TERMINAL_H,
  terminalFootprint,
  type TerminalAnchor,
} from "./anchor";
import {
  CORRIDOR_WALL_THICKNESS,
  LOBBY_CUTAWAY_HEIGHT,
} from "./tuning/hotel";
import {
  DOOR_GAP_HALF,
  WALL_SILL_HEIGHT,
} from "./tuning/room";

/* ------------------------------------------------------------------ */
/* The debug flag (game-shell reads it; the rig consumes it)           */
/* ------------------------------------------------------------------ */

/** Query param switching the rig: `?view=game&camera=top` keeps the old
 *  fixed 45° orthographic dollhouse for in-place comparison. Any other
 *  value (or none) is the chase rig. */
export const CAMERA_PARAM = "camera";
export const CAMERA_TOP_VALUE = "top";
export type GameCameraMode = "chase" | "top";

export function cameraModeFor(param: string | null): GameCameraMode {
  return param === CAMERA_TOP_VALUE ? "top" : "chase";
}

/* ------------------------------------------------------------------ */
/* Rig constants                                                       */
/* ------------------------------------------------------------------ */

/** Perspective FOV (vertical, degrees) — the standard third-person band. */
export const CHASE_FOV = 55;
/** Desired boom length (m): pivot → camera along the negative heading. */
export const CHASE_BOOM = 3.0;
/** Camera height above the avatar's ground (m). */
export const CHASE_CAM_HEIGHT = 1.9;
/** Pivot height above the avatar's ground (m) — the look target, chest. */
export const CHASE_PIVOT_HEIGHT = 1.35;
/** Lazy yaw follow: the heading only pulls the camera while the avatar
 *  moves (factor 1 − e^(−rate·dt)) — auto-follow, never a snap. */
export const CHASE_YAW_RATE = 4;
/** Focus position damping — the repo's λ≈12 idiom. */
export const CHASE_POS_RATE = 12;
/** Occlusion response: pull in FAST (an occluded camera is a wrong state,
 *  not a smoothed one), push back out slow so the boom never pumps. */
export const CHASE_PULL_IN_RATE = 30;
export const CHASE_PUSH_OUT_RATE = 2.2;
/** Sphere-cast probe radius (m) — the camera stays this far off any wall. */
export const CHASE_PROBE_RADIUS = 0.35;
/** Boom distance below which the avatar fades instead of the camera
 *  entering its own head. */
export const CHASE_MIN_DIST = 0.9;
/** Avatar opacity at/under CHASE_MIN_DIST (lerped, never a pop). */
export const CHASE_AVATAR_FADE = 0.25;
/** The fixed camera's yaw — the chase basis at this value reproduces the
 *  legacy KEY_DIRS diagonals exactly (forward (√2/2, −√2/2), right
 *  (√2/2, √2/2)), so top-down mode keeps byte-identical movement. */
export const TOPDOWN_YAW = (Math.PI * 3) / 4;

/* ------------------------------------------------------------------ */
/* Movement basis — screen-relative from the camera's yaw              */
/* ------------------------------------------------------------------ */

export interface MoveBasis {
  /** Screen-up on the ground plane (the camera's horizontal forward). */
  fx: number;
  fz: number;
  /** Screen-right on the ground plane (forward × up). */
  rx: number;
  rz: number;
}

/** The basis for one yaw: forward (sinθ, cosθ), right (−cosθ, sinθ). At
 *  TOPDOWN_YAW this is exactly the legacy KEY_DIRS table. */
export function moveBasisFor(yaw: number): MoveBasis {
  const fx = Math.sin(yaw);
  const fz = Math.cos(yaw);
  return { fx, fz, rx: -fz, rz: fx };
}

/* ------------------------------------------------------------------ */
/* Live state (the rig writes every frame; movement/avatar/probes read) */
/* ------------------------------------------------------------------ */

/**
 * The rig's live pose — preallocated, mutated in place, one writer (the
 * CameraRig's frame loop). Consumers: GameLoop (the movement basis reads
 * `yaw`), PlayerAvatar (`fade`), the touch stick (`stick*`), and the
 * probe mirror (GAME_DEBUG.camera IS this record — debug.ts re-exports
 * it, so a probe reads the camera without entering the scene graph).
 */
export const CHASE_LIVE = {
  /** The rig's current yaw — the movement basis. Top-down mode pins
   *  TOPDOWN_YAW every frame, so movement never depends on the mode. */
  yaw: TOPDOWN_YAW,
  /** Live camera world position (either rig). */
  camX: 0,
  camY: 0,
  camZ: 0,
  /** Current boom length after the occlusion cast (CHASE_BOOM when clear). */
  dist: CHASE_BOOM,
  /** The sphere cast hit something this frame (the camera is pulled in). */
  blocked: false,
  /** Avatar opacity target — CHASE_AVATAR_FADE at/under CHASE_MIN_DIST. */
  fade: 1,
  /** The floating stick's vector in the screen frame (x = right, y = up),
   *  unit-clamped — zero while no touch drives it. */
  stickX: 0,
  stickY: 0,
  stickActive: false,
  /** The tap-to-walk target (world XZ) while an auto-walk runs. */
  walkX: 0,
  walkZ: 0,
  walking: false,
  /** The avatar's smoothed ground height — the tap projection's plane. */
  groundY: 0,
  /** Screen px → ground-plane point, assigned by the rig (undefined
   *  before its first frame / after unmount). */
  projectTap: undefined as
    | undefined
    | ((sx: number, sy: number) => { x: number; z: number } | null),
  /** World point → screen px (the inverse — probes aim a scripted tap at
   *  a paper/door without entering the scene graph). Null when behind
   *  the camera. */
  projectPoint: undefined as
    | undefined
    | ((x: number, y: number, z: number) => { sx: number; sy: number } | null),
};

/* ------------------------------------------------------------------ */
/* Occlusion solids                                                    */
/* ------------------------------------------------------------------ */

/**
 * One analytic solid: an axis-aligned box standing on the floor (y ∈
 * [0, y1]) — the shape every wall/terminal/blocker here shares. The cast
 * expands it by the probe radius, so the camera keeps CHASE_PROBE_RADIUS
 * off the real surface.
 */
export interface SolidBox {
  x0: number;
  x1: number;
  z0: number;
  z1: number;
  /** Top face (m) — the bottom is always the floor. */
  y1: number;
}

/**
 * Segment vs AABB set — the sphere cast, as a ray against every box
 * expanded by the probe radius on all sides (the Minkowski sum; slab
 * test, closed form, no allocation). Returns the t ∈ [0, 1] along
 * pivot→desired of the nearest entry, 1 when the path is clear. A pivot
 * already inside an expanded box answers 0 (the camera hugs the pivot
 * rather than starting inside a wall).
 */
export function castBoom(
  px: number,
  py: number,
  pz: number,
  cx: number,
  cy: number,
  cz: number,
  boxes: readonly SolidBox[],
  radius: number,
): number {
  const dx = cx - px;
  const dy = cy - py;
  const dz = cz - pz;
  let best = 1;
  for (const b of boxes) {
    const t = segmentBoxEntry(
      px, py, pz, dx, dy, dz,
      b.x0 - radius,
      b.x1 + radius,
      -radius,
      b.y1 + radius,
      b.z0 - radius,
      b.z1 + radius,
    );
    if (t < best) best = t;
  }
  return best;
}

/** Slab-test entry t of the segment p + t·d, t ∈ [0, 1], into the box;
 *  1 when the segment never enters, 0 when it starts inside. */
function segmentBoxEntry(
  px: number, py: number, pz: number,
  dx: number, dy: number, dz: number,
  x0: number, x1: number,
  y0: number, y1: number,
  z0: number, z1: number,
): number {
  let tEnter = 0;
  let tExit = 1;
  // Per axis: the interval of t the segment spends inside the slab.
  const axes: readonly [number, number, number, number][] = [
    [px, dx, x0, x1],
    [py, dy, y0, y1],
    [pz, dz, z0, z1],
  ];
  for (const [p, d, lo, hi] of axes) {
    if (d === 0) {
      if (p < lo || p > hi) return 1; // parallel and outside — no hit
      continue;
    }
    let t0 = (lo - p) / d;
    let t1 = (hi - p) / d;
    if (t0 > t1) {
      const tmp = t0;
      t0 = t1;
      t1 = tmp;
    }
    if (t0 > tEnter) tEnter = t0;
    if (t1 < tExit) tExit = t1;
    if (tEnter > tExit) return 1;
  }
  return tEnter;
}

/** Split a wall run [x0, x1] around door gaps centered at `gaps` (each
 *  ±DOOR_GAP_HALF) — the cast passes through a real doorway exactly like
 *  the player does. Gaps are assumed within/near the run; out-of-run gap
 *  centers simply cut nothing. */
function splitRun(
  x0: number,
  x1: number,
  gaps: readonly number[],
): readonly (readonly [number, number])[] {
  const cuts = gaps
    .map((g) => [g - DOOR_GAP_HALF, g + DOOR_GAP_HALF] as const)
    .sort((a, b) => a[0] - b[0]);
  const runs: [number, number][] = [];
  let cursor = x0;
  for (const [g0, g1] of cuts) {
    if (g1 <= cursor || g0 >= x1) continue;
    if (g0 > cursor) runs.push([cursor, Math.min(g0, x1)]);
    cursor = Math.max(cursor, g1);
    if (cursor >= x1) return runs;
  }
  if (cursor < x1) runs.push([cursor, x1]);
  return runs;
}

/** A wall run as a solid box: centered on its plane, true thickness. */
function wallBox(
  x0: number,
  x1: number,
  z0: number,
  z1: number,
  y1: number,
): SolidBox {
  return { x0, x1, z0, z1, y1 };
}

/** The corridor + lobby's analytic solids (no space active). Inputs are
 *  the integrator's own door/clamp state — the same values clampToHotel
 *  reads, so the camera is contained by exactly the walls the player is.
 *  `doorXs` is the clamp's gap list (the window's materialized doors plus
 *  the north return door when hung). `blockers` carries the lobby's
 *  furniture (the front desk, the armchairs) and its terminal at their
 *  drawn heights — the integrator builds those boxes from corridor.tsx's
 *  LOBBY_BLOCKERS and anchor.ts's LOBBY_TERMINAL_BLOCKER. */
export function corridorSolids({
  endX,
  pageDoor,
  doorXs,
  returnDoorSouthX,
  eastArrivalDoor,
  blockers,
}: {
  /** The window's far end wall plane (chunkBounds(0, layout).xStart). */
  endX: number;
  /** The end wall carries the page door (a z = 0 gap) when true. */
  pageDoor: boolean;
  /** Door centers along the corridor (both walls share each bay's x). */
  doorXs: readonly number[];
  /** The lobby leg's south return door x when hung, else null. */
  returnDoorSouthX: number | null;
  /** The lobby's east arrival door is hung (a z = 0 gap) when true. */
  eastArrivalDoor: boolean;
  /** Furniture/terminal boxes, drawn heights (appended as-is). */
  blockers: readonly SolidBox[];
}): SolidBox[] {
  const t = CORRIDOR_WALL_THICKNESS / 2;
  const out: SolidBox[] = [];
  // North wall (z = +WALL_Z): the corridor run plus the junction's north
  // wall out to the lobby's east wall — one run, split at every door gap.
  for (const [x0, x1] of splitRun(endX, LOBBY_LENGTH, doorXs)) {
    out.push(wallBox(x0, x1, WALL_Z - t, WALL_Z + t, WALL_HEIGHT));
  }
  // South wall (z = −WALL_Z): the corridor run only — it stops at the
  // lobby seam (x = 0), the leg's south side is open (corridor.tsx).
  for (const [x0, x1] of splitRun(endX, 0, doorXs)) {
    out.push(wallBox(x0, x1, -WALL_Z - t, -WALL_Z + t, WALL_HEIGHT));
  }
  // The far (west) end wall: solid at the oldest window, split around the
  // page door's z = 0 gap while an older window exists.
  for (const [z0, z1] of splitRun(-WALL_Z, WALL_Z, pageDoor ? [0] : [])) {
    out.push(wallBox(endX - t, endX + t, z0, z1, WALL_HEIGHT));
  }
  // The lobby's east wall: solid, split around the arrival door's gap
  // when the nav stack hangs one (§10.5 西出东进).
  for (const [z0, z1] of splitRun(-WALL_Z, WALL_Z, eastArrivalDoor ? [0] : [])) {
    out.push(wallBox(LOBBY_LENGTH - t, LOBBY_LENGTH + t, z0, z1, WALL_HEIGHT));
  }
  // The lobby leg's far (south) wall, split around its return door.
  for (const [x0, x1] of splitRun(
    0,
    LOBBY_LENGTH,
    returnDoorSouthX === null ? [] : [returnDoorSouthX],
  )) {
    out.push(
      wallBox(x0, x1, -LOBBY_SOUTH_REACH - t, -LOBBY_SOUTH_REACH + t, WALL_HEIGHT),
    );
  }
  // The leg's west parapet — a low cutaway (LOBBY_CUTAWAY_HEIGHT): solid
  // at its DRAWN height, so the sight line over it stays clear.
  out.push(
    wallBox(-t, t, -LOBBY_SOUTH_REACH, -WALL_Z, LOBBY_CUTAWAY_HEIGHT),
  );
  out.push(...blockers);
  return out;
}

/** The active room's analytic solids: the plan's perimeter wall segments
 *  (wallSegmentsFor — the SAME pure derivation the movement clamp and the
 *  renderer consume), the composition's seam jambs, and the terminal's
 *  own footprint — all mirrored into world space through the door's own
 *  dir (local = (world − door)·dir, so world = door + dir·local; boxes
 *  stay axis-aligned under the π mirror). Camera-facing walls are solid
 *  only to their DRAWN sill height (see the module doc). */
export function roomSolids({
  door,
  plan,
  wallThick,
  wallHeight,
  seams,
  terminal,
}: {
  door: { x: number; z: number };
  plan: RoomPlan;
  /** The renderer's scaled wall thickness (ROOM_WALL_THICKNESS × scale). */
  wallThick: number;
  /** The room's drawn wall height (scaledWallHeight). */
  wallHeight: number;
  seams: readonly SeamWall[];
  terminal: TerminalAnchor | null;
}): SolidBox[] {
  const dir = door.z > 0 ? 1 : -1;
  const out: SolidBox[] = [];
  for (const wall of wallSegmentsFor(plan, wallThick)) {
    const cx = door.x + dir * wall.x;
    const cz = door.z + dir * wall.z;
    const hx = wall.sizeX / 2;
    const hz = wall.sizeZ / 2;
    const y1 =
      wall.entrance || !wallFacesCamera(plan, wall, dir)
        ? wallHeight
        : WALL_SILL_HEIGHT;
    out.push(wallBox(cx - hx, cx + hx, cz - hz, cz + hz, y1));
  }
  // Interior seam jambs (§8): solid partitions up to the doorway header —
  // above human height, so the cast reads them as walls.
  const SEAM_TOP = 3.0;
  for (const s of seams) {
    const cx = door.x + dir * s.x;
    const cz = door.z + dir * s.z;
    const hx = s.sizeX / 2;
    const hz = s.sizeZ / 2;
    out.push(wallBox(cx - hx, cx + hx, cz - hz, cz + hz, Math.min(SEAM_TOP, wallHeight)));
  }
  if (terminal !== null) {
    const fp = terminalFootprint(terminal);
    out.push(
      wallBox(
        Math.min(door.x + dir * fp.x0, door.x + dir * fp.x1),
        Math.max(door.x + dir * fp.x0, door.x + dir * fp.x1),
        Math.min(door.z + dir * fp.z0, door.z + dir * fp.z1),
        Math.max(door.z + dir * fp.z0, door.z + dir * fp.z1),
        TERMINAL_H * terminal.scale,
      ),
    );
  }
  return out;
}

/** Corridor half-width re-export for probe callers (the cast's world is
 *  keyed to the clamp's, one definition). */
export const CHASE_CORRIDOR_HALF = CORRIDOR_WIDTH / 2;
