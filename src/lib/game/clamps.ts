/**
 * Movement containment — the pure clamps that keep the player inside the
 * walkable world: the corridor band and the space behind a door.
 *
 * WHY THIS EXISTS. The integrator (game-canvas.tsx) decides WHEN each clamp
 * applies; the geometry lives here — pure, unit-tested, next to the hotel
 * layout math it builds on. No state, no randomness, no React: same
 * position in, mutated position out.
 *
 * THE CONTAINMENT INVARIANT. While a space is active, its corridor wall is
 * solid in BOTH directions everywhere except the door gap: the player may
 * only leave through |x − door.x| < GAP_HALF. Correspondingly, the door
 * manager (game-canvas.tsx) releases space mode only when the player is
 * back inside the corridor band AND within CLEAR_HALF of the door's x, and
 * otherwise re-clamps the player into the space. The release zone
 * (CLEAR_HALF) is deliberately wider than the physical gap (GAP_HALF) so a
 * player hugging the door frame never oscillates between modes.
 */
import { CORRIDOR_WIDTH, LOBBY_LENGTH, type DoorRef } from "./hotel";

/** Corridor half-width — walls sit at ±WALL_Z. */
export const WALL_Z = CORRIDOR_WIDTH / 2;
/** Corridor z bound: the player keeps 0.5 m clear of the walls. */
export const CORRIDOR_Z_LIMIT = WALL_Z - 0.5;
/** Inside a door gap the wall doesn't block — the player may reach past
 *  the wall plane (and into the space beyond). */
export const GAP_Z_LIMIT = WALL_Z + 0.6;
/** Crossing tolerance along x for "inside the door gap". Matches the
 *  visual doorway: the 2.4m wall gap is dressed down to the 1.4m door by
 *  filler panels (space.tsx SpaceDoorway), so passage must stay inside the
 *  slab — 0.6 keeps the player clear of the 0.7m panel edge. */
export const GAP_HALF = 0.6;
/** Wall-plane hysteresis: beyond OUT a space may engage, inside IN the
 *  corridor may reclaim the player. */
export const WALL_OUT = WALL_Z + 0.2;
export const WALL_IN = WALL_Z - 0.2;
/** Space mode releases the player only within this distance of the door's x. */
export const CLEAR_HALF = 1.2;
/** Min distance from the wall plane once inside a space. */
export const SPACE_WALL_CLEAR = 0.4;
/** Min distance from the space's outer edges. */
export const SPACE_EDGE_MARGIN = 1;
/** Lobby east wall clearance. */
export const LOBBY_CLEAR = 0.6;

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

/**
 * Corridor clamp: z boxed to ±CORRIDOR_Z_LIMIT except within a door gap,
 * where the wall opening lets the player reach past the wall plane; the
 * lobby east wall caps x, the past corridor runs unbounded.
 */
export function clampToCorridor(
  p: { x: number; z: number },
  doorXs: readonly number[],
): void {
  if (p.x > LOBBY_LENGTH - LOBBY_CLEAR) p.x = LOBBY_LENGTH - LOBBY_CLEAR;
  const inGap = doorXs.some((dx) => Math.abs(p.x - dx) < GAP_HALF);
  const limit = inGap ? GAP_Z_LIMIT : CORRIDOR_Z_LIMIT;
  p.z = clamp(p.z, -limit, limit);
}

/**
 * Space clamp: the player is boxed to the recipe's rectangular footprint
 * (x within door.x ± (width/2 − SPACE_EDGE_MARGIN), outward z from
 * wall + SPACE_WALL_CLEAR to wall + extent − SPACE_EDGE_MARGIN, mirrored
 * for south doors). `width` is the plan's x span, `extent` its z depth.
 * Inside the doorway gap (|x − door.x| < GAP_HALF) the inner bound relaxes
 * to the corridor band so the player can walk back through the wall;
 * everywhere else the wall plane is solid both ways — a player on the
 * corridor side outside the gap is pushed back into the space rather than
 * through the wall.
 */
export function clampToSpace(
  p: { x: number; z: number },
  door: DoorRef,
  width: number,
  extent: number,
): void {
  const xHalf = width / 2 - SPACE_EDGE_MARGIN;
  p.x = clamp(p.x, door.x - xHalf, door.x + xHalf);
  const far = WALL_Z + extent - SPACE_EDGE_MARGIN;
  const inGap = Math.abs(p.x - door.x) < GAP_HALF;
  const near = inGap ? CORRIDOR_Z_LIMIT : WALL_Z + SPACE_WALL_CLEAR;
  if (door.z > 0) {
    p.z = clamp(p.z, near, far);
  } else {
    p.z = clamp(p.z, -far, -near);
  }
}
