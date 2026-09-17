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
 *
 * STRAND DOORS (v0.11 B.8/B.11) get the same treatment on the room's other
 * walls: within a placed door's along-wall window the box clamp relaxes to
 * the wall plane + ROOM_DOOR_PASS_DEPTH so the crossing trigger is
 * reachable; outside those windows the box holds exactly as before. The
 * placements come from room-doors.ts placeRoomDoors — the one pure layout
 * the renderer also consumes.
 *
 * PLAN-AWARE CONTAINMENT. The rectangular box is only the plan's BOUNDING
 * box: an l-shape's abandoned quadrant lies inside it but outside the
 * room, so the plain box let the player walk straight through the step
 * and inner walls. clampToSpace therefore also takes the room's plan
 * (the same roomPlanFor derivation the renderer builds, template-declared
 * silhouette included) and, after the box, projects any position in the
 * abandoned quadrant back to the nearest walkable point — except inside
 * a strand door's slab passage, whose doorway is an opening in the plan's
 * boundary exactly like the entrance gap. rect and colonnade plans fill
 * their bounding box, so the plan step is a no-op for them and the clamp
 * stays byte-identical to the plain box.
 */
import { CORRIDOR_WIDTH, LOBBY_LENGTH, type DoorRef } from "./hotel";
import type { RoomDoorPlacement } from "./room-doors";
import type { RoomPlan } from "./room-plan";

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
/** Strand-door passage (v0.11 B.8/B.11): inside a placed door's along-wall
 *  window the box clamp relaxes out to the wall's own plane plus this
 *  overtravel, so the crossing trigger (ROOM_DOOR_CROSS_DEPTH = 0.55,
 *  measured inward from the plane) is comfortably reachable — the same
 *  overtravel the entrance gets past the corridor wall (GAP_Z_LIMIT). The
 *  relaxation is bounded by BOTH the GAP_HALF window and this plane: the
 *  player can stand between the jambs, never escape past them. */
export const ROOM_DOOR_PASS_DEPTH = 0.6;
/** End-wall (page door) passage: inside the page door's gap the far-end
 *  clamp relaxes past the wall plane by this much, so the page-door
 *  crossing trigger (PAGE_DOOR_CROSS_DEPTH, tuning/hotel.ts) is reachable
 *  — the same overtravel a strand door gets. */
export const END_WALL_PASS_DEPTH = 0.6;

/** Margin shrink cap: the effective space margin never exceeds this
 *  fraction of the room's half-span, so at least half of every span stays
 *  walkable at any scale. The human-scale constants above remain the
 *  ceiling — every tier is ≥16 m at ×1, so normal rooms take them
 *  unchanged and only miniature rooms (where a fixed 1 m margin would
 *  swallow the whole span) shrink. */
const MARGIN_HALF_SPAN_CAP = 0.5;

/** Scale-aware margin: the human-scale value, capped so a shrunken room
 *  keeps a meaningful walkable fraction of its half-span. */
function scaledMargin(humanMargin: number, halfSpan: number): number {
  return Math.min(humanMargin, halfSpan * MARGIN_HALF_SPAN_CAP);
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

/**
 * The corridor's far (past) end — the window's boundary (HD2/HD3). With a
 * page door the end wall carries one doorway (centered on the hall, z = 0)
 * into the next-older hotel's lobby; without one (the oldest window) the
 * end is a plain wall — "直到尽头就什么都没有了".
 */
export interface CorridorEnd {
  /** X of the end wall's plane. */
  endX: number;
  /** True when the end wall carries the page door: inside its gap the
   *  player may push past the wall plane to trigger the crossing. */
  pageDoor: boolean;
}

/**
 * Corridor clamp: z boxed to ±CORRIDOR_Z_LIMIT except within a door gap,
 * where the wall opening lets the player reach past the wall plane; the
 * lobby east wall caps x. The corridor is a FIXED length now (HD2 — no
 * treadmill): when `end` is given, x is also capped at the window's far
 * end — solid at endX + LOBBY_CLEAR, or, inside the page door's gap
 * (|z| < GAP_HALF), relaxed out to endX − END_WALL_PASS_DEPTH so the
 * page-door crossing trigger stays reachable, exactly like a room door's
 * slab passage. Without `end` the past corridor stays unbounded (legacy
 * behaviour, kept total for callers that predate windows).
 */
export function clampToCorridor(
  p: { x: number; z: number },
  doorXs: readonly number[],
  end?: CorridorEnd,
): void {
  if (p.x > LOBBY_LENGTH - LOBBY_CLEAR) p.x = LOBBY_LENGTH - LOBBY_CLEAR;
  if (end !== undefined) {
    const inPageGap = end.pageDoor && Math.abs(p.z) < GAP_HALF;
    const minX = inPageGap
      ? end.endX - END_WALL_PASS_DEPTH
      : end.endX + LOBBY_CLEAR;
    if (p.x < minX) p.x = minX;
  }
  const inGap = doorXs.some((dx) => Math.abs(p.x - dx) < GAP_HALF);
  const limit = inGap ? GAP_Z_LIMIT : CORRIDOR_Z_LIMIT;
  p.z = clamp(p.z, -limit, limit);
}

/**
 * Space clamp: the player is boxed to the recipe's rectangular footprint
 * (x within door.x ± (width/2 − edge margin), outward z from
 * wall + wall clear to wall + extent − edge margin, mirrored for south
 * doors). `width` is the plan's x span, `extent` its z depth — already
 * scale-adjusted by the caller, so the margins are derived from them via
 * scaledMargin: SPACE_EDGE_MARGIN / SPACE_WALL_CLEAR at human scale,
 * shrinking with the room so miniature plans stay walkable.
 * Inside the doorway gap (|x − door.x| < GAP_HALF) the inner bound relaxes
 * to the corridor band so the player can walk back through the wall;
 * everywhere else the wall plane is solid both ways — a player on the
 * corridor side outside the gap is pushed back into the space rather than
 * through the wall.
 *
 * STRAND-DOOR PASSAGES. `roomDoors` carries the room's placed strand doors
 * in the plan's local frame (room-doors.ts placeRoomDoors — the SAME pure
 * placement the renderer builds; never a second derivation). For each door
 * whose along-wall window (|along| < GAP_HALF, the slab passage — same as
 * the crossing trigger) contains the player, the bound on that wall's
 * normal axis widens out to the wall plane + ROOM_DOOR_PASS_DEPTH, exactly
 * as the entrance gap relaxes the corridor wall: without it the edge
 * margin keeps the player ≥ 0.85 m short of the wall and the 0.55 m
 * crossing band is unreachable. The widened interval is re-applied to the
 * PRE-clamp position so the overshoot the box just swallowed is restored.
 * Walls without a door — and every position outside a door's window —
 * clamp byte-identically to the plain box.
 *
 * PLAN CONTAINMENT. `plan` is the room's floor plan (room-plan.ts
 * roomPlanFor — the one derivation the renderer also builds). The box
 * above is only the plan's bounding box, so for an l-shape the clamp then
 * projects any position in the abandoned quadrant (past the step, on the
 * dropped side) back to the NEAREST walkable point: across the step wall
 * (whose near face IS the step plane) or sideways past the inner wall's
 * margin line, whichever is closer — closed form, idempotent, no search.
 * A strand door on the step or inner wall carves its slab passage out of
 * the forbidden zone exactly like a boundary doorway: inside the door's
 * along-window AND already within ±ROOM_DOOR_PASS_DEPTH of the wall plane
 * the position is legal (between the jambs), with the normal axis held
 * from the pre-clamp position. The band is gated on the CLAMPED position
 * so a far-flung point merely aligned with a door is projected, never
 * dragged across the room into a doorway. rect and colonnade plans fill
 * their bounding box, so this step is a no-op for them (byte-identical).
 */
export function clampToSpace(
  p: { x: number; z: number },
  door: DoorRef,
  width: number,
  extent: number,
  roomDoors: readonly RoomDoorPlacement[],
  plan: RoomPlan,
): void {
  const rawX = p.x;
  const rawZ = p.z;
  const xHalf = width / 2 - scaledMargin(SPACE_EDGE_MARGIN, width / 2);
  p.x = clamp(p.x, door.x - xHalf, door.x + xHalf);
  const far = WALL_Z + extent - scaledMargin(SPACE_EDGE_MARGIN, extent / 2);
  const inGap = Math.abs(p.x - door.x) < GAP_HALF;
  const near = inGap
    ? CORRIDOR_Z_LIMIT
    : WALL_Z + scaledMargin(SPACE_WALL_CLEAR, extent / 2);
  if (door.z > 0) {
    p.z = clamp(p.z, near, far);
  } else {
    p.z = clamp(p.z, -far, -near);
  }

  // Local frame (doorway at (0,0), +z outward — the placement's frame and
  // the mirror of SpaceScene's group transform), with the box bounds
  // expressed in it: x ∈ [−xHalf, xHalf], z ∈ [near, far] − WALL_Z.
  const dir = door.z > 0 ? 1 : -1;
  if (roomDoors.length > 0) {
    const lx = (p.x - door.x) * dir;
    const lz = (p.z - door.z) * dir;
    const zLo = near - WALL_Z;
    const zHi = far - WALL_Z;
    for (const d of roomDoors) {
      const along = -(lx - d.x) * d.nz + (lz - d.z) * d.nx;
      if (Math.abs(along) >= GAP_HALF) continue;
      if (d.nx !== 0) {
        // Vertical wall (normal ±x): widen only the wall's own side out to
        // the plane + overtravel; interior walls min/max to a no-op.
        const lo = d.nx > 0 ? Math.min(-xHalf, d.x - ROOM_DOOR_PASS_DEPTH) : -xHalf;
        const hi = d.nx < 0 ? Math.max(xHalf, d.x + ROOM_DOOR_PASS_DEPTH) : xHalf;
        if (lo !== -xHalf || hi !== xHalf) {
          p.x = door.x + dir * clamp((rawX - door.x) * dir, lo, hi);
        }
      } else {
        const lo = d.nz > 0 ? Math.min(zLo, d.z - ROOM_DOOR_PASS_DEPTH) : zLo;
        const hi = d.nz < 0 ? Math.max(zHi, d.z + ROOM_DOOR_PASS_DEPTH) : zHi;
        if (lo !== zLo || hi !== zHi) {
          p.z = door.z + dir * clamp((rawZ - door.z) * dir, lo, hi);
        }
      }
    }
  }

  if (plan.id !== "l-shape") return;
  // Plan containment (see the doc comment): the abandoned quadrant is
  // (lz past the step) on the dropped side of the inner wall's margin
  // line. The margin mirrors the box's own side-wall margin, so the kept
  // leg holds the player exactly as far off its inner wall as off every
  // outer wall; the step wall needs no margin — the band to its doors'
  // crossing trigger (0.55 m from a plane only thick/2 past the step)
  // must stay reachable, and the wall's near face lies on the step plane.
  const kept = plan.lSide;
  const innerMargin = width / 2 - xHalf;
  const plx = (p.x - door.x) * dir;
  const plz = (p.z - door.z) * dir;
  const onDroppedSide = kept > 0 ? plx < innerMargin : plx > -innerMargin;
  if (plz <= plan.stepZ || !onDroppedSide) return;

  // Door carve: a strand door's slab passage opens the forbidden zone.
  const rawLx = (rawX - door.x) * dir;
  const rawLz = (rawZ - door.z) * dir;
  for (const d of roomDoors) {
    const along = -(plx - d.x) * d.nz + (plz - d.z) * d.nx;
    if (Math.abs(along) >= GAP_HALF) continue;
    const perp = (plx - d.x) * d.nx + (plz - d.z) * d.nz;
    if (Math.abs(perp) > ROOM_DOOR_PASS_DEPTH + 1e-9) continue;
    const rawPerp = (rawLx - d.x) * d.nx + (rawLz - d.z) * d.nz;
    const held = clamp(rawPerp, -ROOM_DOOR_PASS_DEPTH, ROOM_DOOR_PASS_DEPTH);
    if (d.nx !== 0) {
      p.x = door.x + dir * (d.x + d.nx * held);
    } else {
      p.z = door.z + dir * (d.z + d.nz * held);
    }
    return;
  }

  // No doorway: project to the nearest walkable point. Both candidates
  // are clamp fixed points, so the projection never oscillates; a tie
  // takes the step wall.
  const toStep = plz - plan.stepZ;
  const toInner = kept > 0 ? innerMargin - plx : plx + innerMargin;
  if (toStep <= toInner) {
    p.z = door.z + dir * plan.stepZ;
  } else {
    p.x = door.x + dir * (kept * innerMargin);
  }
}
