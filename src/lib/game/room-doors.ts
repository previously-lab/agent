/**
 * Strand doors (v0.11-hotel-rooms §B.8/B.11) — pure placement and crossing
 * math for the room's extra doors: one per strand through the slice, each
 * leading to the next slice on that strand. No three.js, no React, no wall
 * clock: the layout is a deterministic function of (worldSeed, sliceId,
 * plan, count), so the same memory always grows the same doors (axiom A6;
 * the door SET may change as strands evolve — B.3.2 — but a given set
 * always lands identically).
 *
 * THE BRIEF (B.8): doors are composed like the doors of a home, not
 * sprinkled — a three-bedroom flat has six doors and still reads as a
 * place. So: NOT evenly spaced (doors cluster — two near one corner, one
 * on the far wall, like bedrooms off a hall), real frames and thresholds
 * (the renderer's half), human proportions (DOOR_WIDTH/DOOR_HEIGHT, never
 * scaled), and a minimum spacing so two doors never collide. No cap on
 * the count; if a small room genuinely cannot host its doors at domestic
 * spacing, the spacing ladder relaxes (denser, more walls) but NEVER
 * drops a door — the layout reports `relaxed` when that happened.
 *
 * SOLID WALLS ONLY. Hosts come from the plan's own wall segments
 * (room-plan.ts wallSegmentsFor), which is the single source of truth for
 * the perimeter: the entrance pair is structurally excluded (it owns the
 * doorway back to the corridor — B.3.1), colonnade open sides are not
 * wall segments at all so they can never host, and every door's inward
 * normal is PROBED with planContains (never assumed), so an l-shape's
 * doors always face the walkable side — the abandoned quadrant can probe
 * a wall's face as "outside" but can never receive a door's approach.
 * The caller additionally marks camera-facing (cutaway sill) walls as
 * non-hostable; the tight-case fallback may re-include them — the door's
 * portal dressing stands full height from the floor, so a door in a sill
 * wall reads as a frame rising above a half wall, not a hole in the air.
 *
 * GRID ALIGNED (v0.13 module grid): every strand door's center sits at a
 * CELL CENTER of the plan's module grid (doorLatticeCenters) — half a
 * cell off every grid line — so a door's 2.4m gap never straddles a
 * module seam, doors in abutting modules align door-to-door, and the
 * ladder's old continuous spacing relaxes into grid pitch (6m), wider
 * than every rung's authored spacing. Capacity is counted in lattice
 * seats, here AND in doorCapacityFor (Finding A's steering agreement
 * holds verbatim). The emergency forcePlace stays off-grid by necessity
 * — never dropping a door outranks alignment.
 *
 * AXIAL SEMANTICS (v0.11-room-interiors §10.5, user 2026-10): doors live
 * on the NORTH/SOUTH walls — the plan's horizontal segments, parallel to
 * the corridor's door walls — so "change timeline" and "turn back" always
 * face the same way; the east/west walls belong to windows and light.
 * The spacing ladder below bakes in the doc's retreat order: ① the
 * template/module layer steers the room toward longer N/S walls by
 * MEASURED capacity (doorCapacityFor, Finding A — now measured on the
 * axial rungs, so the number selection steers by is the number placement
 * honours); ② a same-wall SECOND bank (门厅式, the hotel-corridor move:
 * a freestanding screen row ROOM_DOOR_ROW_DEPTH inward, staggered so no
 * two frames touch — `doubleRow` reports it); ③ east/west overflow only
 * once ①② are full (`axialOverflow` reports it — never the norm). Two
 * rules outrank even the axis and the template bans: a door is never
 * DROPPED (B.8), and doors never OVERLAP (forcePlace re-runs over every
 * solid wall before it would space two frames tighter than a door's
 * width).
 */
import { GAP_HALF } from "./clamps";
import {
  planContains,
  wallRoleFor,
  type RoomPlan,
  type WallRole,
  type WallSegment,
} from "./room-plan";
import { createRng, hashString, WORLD_SEED } from "./seed";
import { CAM_OFFSET } from "./tuning/room";
import {
  DOOR_GAP_HALF,
  DOOR_LATTICE_HALF_CELL,
  DOOR_WIDTH,
  MODULE_GRID,
  ROOM_DOOR_CLEAR_DEPTH,
  ROOM_DOOR_CLEAR_HALF,
  ROOM_DOOR_CLUSTER_STICK,
  ROOM_DOOR_CROSS_DEPTH,
  ROOM_DOOR_END_PAD,
  ROOM_DOOR_MIN_GAP,
  ROOM_DOOR_PLAQUE_MAX_CHARS,
  ROOM_DOOR_ROW_DEPTH,
} from "./tuning/room";

/** One placed strand door, in the plan's local frame (doorway at (0,0),
 *  +z outward, x centered on the entrance axis). */
export interface RoomDoorPlacement {
  /** Index into the roomDoors list the scene was handed. */
  index: number;
  /** Index into the walls array passed to placeRoomDoors. */
  wall: number;
  /** Door center on the wall line (row 0), or on the freestanding screen
   *  line ROW_DEPTH inward of it (row 1). */
  x: number;
  z: number;
  /** Inward unit normal (axis-aligned), PROBED toward the walkable plan. */
  nx: number;
  nz: number;
  /** Offset along the wall's run from the segment center (m). */
  along: number;
  /** 0 = hung on the perimeter wall; 1 = the second bank (§10.5 fallback
   *  ② 门厅式): a freestanding door on the shallow screen standing
   *  ROOM_DOOR_ROW_DEPTH inward of its host wall, staggered against the
   *  wall row so no two frames ever touch. Row-1 doors do NOT cut the
   *  perimeter (splitWallsForDoors skips them) — the renderer builds
   *  their screen. */
  row: 0 | 1;
}

export interface RoomDoorLayout {
  doors: RoomDoorPlacement[];
  /** True when the spacing ladder had to relax (denser spacing, camera-
   *  side walls, the second row, or east/west overflow) to place every
   *  requested door. */
  relaxed: boolean;
  /** True when any door landed on the second (screen) row — §10.5's
   *  fallback ② engaged. */
  doubleRow: boolean;
  /** True when any door spilled onto an east/west wall — §10.5's
   *  fallback ③ engaged (never the norm: the axial rungs are exhausted
   *  first). */
  axialOverflow: boolean;
}

/** A wall's run direction: horizontal walls run along x. (Same convention
 *  as the dado builder: the long axis is the run.) */
function isHorizontal(wall: WallSegment): boolean {
  return wall.sizeZ <= wall.sizeX;
}

function wallLength(wall: WallSegment): number {
  return Math.max(wall.sizeX, wall.sizeZ);
}

/** Inward normal of a wall AT A POINT, probed with planContains: the side
 *  that answers "inside the walkable plan" is the inside. Walls are
 *  axis-aligned, so the normal is exactly one of (±1, 0) / (0, ±1). */
function inwardNormal(
  plan: RoomPlan,
  wall: WallSegment,
  x: number,
  z: number,
): { nx: number; nz: number } {
  if (isHorizontal(wall)) {
    return { nx: 0, nz: planContains(plan, x, z + 0.5, 0) ? 1 : -1 };
  }
  return { nx: planContains(plan, x + 0.5, z, 0) ? 1 : -1, nz: 0 };
}

/**
 * A layout template's door affordance (v0.11-room-interiors §7): which wall
 * ROLES may carry strand doors. The template declares, this module enforces
 * — a banned wall (the shelf run, the niche wall) never receives a door on
 * ANY ladder rung, tight cases included; the template's door capacity is
 * enforced upstream at selection time, not by dropping doors here.
 */
export interface DoorAffordance {
  walls: readonly WallRole[];
}

interface Host {
  wall: number;
  horizontal: boolean;
  /** Segment length along the run. */
  len: number;
  /** Center freedom along the run: len − 2·endPad. Negative = unusable. */
  run: number;
}

/**
 * One spacing configuration of the ladder. `hostableOnly` restricts hosts
 * to the caller-flagged (full-height, non-camera-facing) walls; later
 * rungs open every solid non-entrance wall and pack denser. The primary
 * rung is the authored domestic spacing; everything below it is the
 * tight-case fallback and flips `relaxed` on the layout.
 *
 * AXIAL SEMANTICS (v0.11-room-interiors §10.5): north/south walls — the
 * plan's HORIZONTAL segments, parallel to the corridor's door walls —
 * are the door walls; east/west walls belong to windows and light. The
 * ladder honours the retreat order the doc fixes:
 *   ① single row on the N/S walls (the template/module layer already
 *     steered the room toward longer N/S walls by measured capacity);
 *   ② `rows: 2` — a second bank of doors on the SAME wall (门厅式: the
 *     hotel-corridor move, a freestanding screen row off the wall);
 *   ③ `axialOnly: false` — east/west overflow, only once ①② are full.
 */
interface LadderRung {
  hostableOnly: boolean;
  /** The authored center spacing. The v0.13 door lattice seats doors at
   *  grid cell centers (6 m pitch — wider than every rung's spacing), so
   *  no rung's spacing binds anymore; the field stays as the authored
   *  record of the domestic spacing the lattice replaced. */
  spacing: number;
  endPad: number;
  /** 1 = the wall row only; 2 = the freestanding screen row may take the
   *  overflow (per-wall capacity doubles). */
  rows: 1 | 2;
  /** true: only horizontal (north/south) wall segments may host. */
  axialOnly: boolean;
}

const LADDER: readonly LadderRung[] = [
  // The home: full-height N/S walls only, doors 3.0m on center, corners clear.
  {
    hostableOnly: true,
    spacing: DOOR_WIDTH + ROOM_DOOR_MIN_GAP,
    endPad: ROOM_DOOR_END_PAD,
    rows: 1,
    axialOnly: true,
  },
  // Too many doors for the tall walls: the cutaway sills may host too
  // (the portal dressing stands from the floor, so the door still works).
  {
    hostableOnly: false,
    spacing: DOOR_WIDTH + ROOM_DOOR_MIN_GAP,
    endPad: ROOM_DOOR_END_PAD,
    rows: 1,
    axialOnly: true,
  },
  // ② 门厅式: the same N/S walls grow a second, freestanding bank.
  {
    hostableOnly: false,
    spacing: DOOR_WIDTH + ROOM_DOOR_MIN_GAP,
    endPad: ROOM_DOOR_END_PAD,
    rows: 2,
    axialOnly: true,
  },
  // Denser: corridor-tight spacing, reduced corner pad.
  { hostableOnly: false, spacing: 2.4, endPad: 1.5, rows: 2, axialOnly: true },
  // ③ East/west overflow — the N/S walls are genuinely full.
  { hostableOnly: false, spacing: 2.4, endPad: 1.5, rows: 2, axialOnly: false },
  // Emergency: doors just clear of each other's frames.
  {
    hostableOnly: false,
    spacing: DOOR_WIDTH + 0.5,
    endPad: 1.3,
    rows: 2,
    axialOnly: false,
  },
];

/**
 * The plan-frame door lattice (v0.13 module grid): the room's floor plan
 * IS the composition's bounding rect (module edges land on multiples of
 * MODULE_GRID measured from the plan's own origin), so strand-door centers
 * sit at CELL CENTERS — half a cell off every grid line, `stagger` further
 * shifted (the screen row's 3 m, landing on the boundary lattice). A
 * door's 2.4 m gap can then never straddle a module seam, and doors in
 * abutting modules align door-to-door. Returns the along-run positions (m
 * from the segment's start, i.e. inside [pad, len − pad]) of every legal
 * center.
 */
export function doorLatticeCenters(
  plan: RoomPlan,
  wall: WallSegment,
  pad: number,
  stagger: number = 0,
): number[] {
  const horizontal = isHorizontal(wall);
  const len = wallLength(wall);
  const phase = horizontal ? -plan.width / 2 : 0;
  const start = (horizontal ? wall.x : wall.z) - len / 2;
  const lo = start + pad;
  const hi = start + len - pad;
  const first = phase + DOOR_LATTICE_HALF_CELL + stagger;
  const out: number[] = [];
  for (
    let c = first + Math.ceil((lo - first) / MODULE_GRID - 1e-9) * MODULE_GRID;
    c <= hi + 1e-9;
    c += MODULE_GRID
  ) {
    out.push(c - start);
  }
  return out;
}

/** Seeded pick of k lattice centers (along-run positions), order
 *  preserved. Adjacent centers are one grid pitch (6 m) apart — wider
 *  than every ladder rung's spacing — so any subset satisfies the spacing
 *  and the never-overlap rule by construction; the domestic clustering
 *  still reads through the WALL ASSIGNMENT (CLUSTER_STICK), not through
 *  irregular gaps. */
function pickLattice(
  rng: () => number,
  centers: readonly number[],
  k: number,
): number[] {
  const pool = [...centers];
  const picked: number[] = [];
  for (let i = 0; i < k && pool.length > 0; i++) {
    picked.push(pool.splice(Math.floor(rng() * pool.length), 1)[0]);
  }
  return picked.sort((a, b) => a - b);
}

/** One placement attempt at one ladder rung. Null when the walls cannot
 *  hold `count` doors at this spacing; otherwise exactly count doors.
 *  `permitted` (template affordance) bans wall roles outright, on every
 *  rung; null = every solid non-entrance wall may host. Axial rungs
 *  additionally skip the east/west (vertical) segments. A rows-2 rung
 *  seats each wall's overflow on the freestanding screen row, staggered
 *  half a spacing against the wall row so no two frames ever touch. */
function tryPlace(
  rng: () => number,
  plan: RoomPlan,
  walls: readonly WallSegment[],
  hostable: readonly boolean[],
  count: number,
  rung: LadderRung,
  permitted: readonly boolean[] | null,
): RoomDoorPlacement[] | null {
  const hosts: Host[] = [];
  walls.forEach((wall, i) => {
    if (wall.entrance) return; // the corridor doorway is untouchable (B.3.1)
    if (permitted && !permitted[i]) return; // template-banned wall role
    if (rung.hostableOnly && !hostable[i]) return;
    const horizontal = isHorizontal(wall);
    if (rung.axialOnly && !horizontal) return; // §10.5: doors face N/S
    const len = wallLength(wall);
    hosts.push({
      wall: i,
      horizontal,
      len,
      run: len - 2 * rung.endPad,
    });
  });
  // A rows-2 rung adds each host's screen-row seats, sampled on the
  // staggered boundary lattice (DOOR_LATTICE_HALF_CELL further than the
  // wall row's cell centers) so a screen door never stands directly in
  // front of a wall door and both rows stay grid-aligned. On the rungs
  // where ADJACENT (east/west) walls may also host, the screen's seats
  // give up the corner diagonal too: a screen door ROW_DEPTH in from its
  // wall line sits that much closer to the neighbouring wall's doors, so
  // its end pad grows by the row depth. The axial rungs host on
  // non-adjacent walls only (rect: the far wall; l-shape: the parallel
  // far/step), where the corner case cannot arise.
  const screenPad = rung.endPad + (rung.axialOnly ? 0 : ROOM_DOOR_ROW_DEPTH);
  const rowCenters = (h: Host) =>
    doorLatticeCenters(plan, walls[h.wall], rung.endPad);
  const screenCenters = (h: Host) =>
    rung.rows === 2
      ? doorLatticeCenters(
          plan,
          walls[h.wall],
          screenPad,
          DOOR_LATTICE_HALF_CELL,
        )
      : [];
  const remaining = hosts.map(
    (h) => rowCenters(h).length + screenCenters(h).length,
  );
  const total = remaining.reduce((a, b) => a + b, 0);
  if (total < count) return null;

  // Assignment with clustering: the first door picks a wall weighted by
  // spare capacity; each next door STAYS on the same wall with
  // probability CLUSTER_STICK (capacity permitting) — doors gather into
  // domestic clusters instead of being dealt around the perimeter.
  const pickWall = (): number => {
    let sum = 0;
    for (const r of remaining) sum += r;
    if (sum <= 0) return -1;
    let ticket = rng() * sum;
    for (let i = 0; i < hosts.length; i++) {
      ticket -= remaining[i];
      if (ticket < 0) return i;
    }
    return hosts.length - 1;
  };
  const assignment: number[] = new Array(count);
  let cur = pickWall();
  for (let d = 0; d < count; d++) {
    if (cur < 0) return null;
    assignment[d] = cur;
    remaining[cur] -= 1;
    if (d + 1 >= count) break;
    if (remaining[cur] > 0 && rng() < ROOM_DOOR_CLUSTER_STICK) continue;
    cur = pickWall();
  }

  // Positions per host wall: the wall row fills first; the overflow takes
  // the screen row, staggered half a grid cell (DOOR_LATTICE_HALF_CELL)
  // against the wall row so a screen door never stands directly in front
  // of a wall door. Both rows draw from grid lattices, so seats are
  // distinct by construction and the never-overlap rule holds trivially.
  const counts = new Map<number, number>();
  assignment.forEach((h) => counts.set(h, (counts.get(h) ?? 0) + 1));
  const rows = new Map<number, { wall: number[]; screen: number[] }>();
  for (const [h, k] of counts) {
    const wallSeats = rowCenters(hosts[h]);
    const k0 = Math.min(k, wallSeats.length);
    const k1 = k - k0;
    const onWall = pickLattice(rng, wallSeats, k0);
    const onScreen = pickLattice(rng, screenCenters(hosts[h]), k1);
    rows.set(h, { wall: onWall, screen: onScreen });
  }
  const used = new Map<number, number>();
  const doors: RoomDoorPlacement[] = [];
  for (let d = 0; d < count; d++) {
    const h = hosts[assignment[d]];
    const slot = used.get(assignment[d]) ?? 0;
    used.set(assignment[d], slot + 1);
    const r = rows.get(assignment[d]) ?? { wall: [0], screen: [] };
    const wallCap = r.wall.length;
    const row: 0 | 1 = slot < wallCap ? 0 : 1;
    // Lattice seats are already along-run offsets from the segment start.
    const offset = row === 0 ? r.wall[slot] : r.screen[slot - wallCap];
    const wall = walls[h.wall];
    // From segment start along the run: start = center − len/2.
    const along = offset - h.len / 2;
    let x = h.horizontal ? wall.x + along : wall.x;
    let z = h.horizontal ? wall.z : wall.z + along;
    const { nx, nz } = inwardNormal(plan, wall, x, z);
    if (row === 1) {
      // The screen row stands off the wall, toward the walkable plan.
      x += nx * ROOM_DOOR_ROW_DEPTH;
      z += nz * ROOM_DOOR_ROW_DEPTH;
    }
    doors.push({ index: d, wall: h.wall, x, z, nx, nz, along, row });
  }
  return doors;
}

/**
 * Last-ditch placement when even the tightest rung lacks capacity (a room
 * smaller than its door count in every dimension): spread the doors across
 * every solid non-entrance wall in proportion to run length, evenly along
 * each wall. NEVER drops a door — spacing may go below the domestic
 * minimum, which `relaxed` reports.
 */
function forcePlace(
  rng: () => number,
  plan: RoomPlan,
  walls: readonly WallSegment[],
  count: number,
  permitted: readonly boolean[] | null,
): RoomDoorPlacement[] {
  const endPad = 1.0;
  const hosts: Host[] = [];
  walls.forEach((wall, i) => {
    if (wall.entrance) return;
    if (permitted && !permitted[i]) return;
    const len = wallLength(wall);
    hosts.push({
      wall: i,
      horizontal: isHorizontal(wall),
      len,
      run: Math.max(0.2, len - 2 * endPad),
    });
  });
  if (hosts.length === 0 && permitted) {
    // A template that bans every solid wall would strand its doors — the
    // never-drop rule (B.8) outranks the ban in this degenerate case only.
    return forcePlace(rng, plan, walls, count, null);
  }
  if (hosts.length === 0) return [];
  const totalRun = hosts.reduce((a, h) => a + h.run, 0);
  // Quota per wall ∝ run, rounded, with the remainder dealt to the
  // longest runs so the counts sum to exactly `count`.
  const quotas = hosts.map((h) => (h.run / totalRun) * count);
  const counts = quotas.map((q) => Math.floor(q));
  let left = count - counts.reduce((a, b) => a + b, 0);
  const order = hosts
    .map((_, i) => i)
    .sort((a, b) => quotas[b] - counts[b] - (quotas[a] - counts[a]));
  for (let i = 0; left > 0; i = (i + 1) % order.length) {
    counts[order[i]] += 1;
    left -= 1;
  }
  // No-overlap guard (user, 2026-10: 门不许挤到重叠): if the permitted
  // hosts alone would space doors tighter than a frame's width, re-run
  // over EVERY solid wall — the never-overlap rule outranks the
  // template's ban exactly as never-drop does.
  if (permitted) {
    const tight = hosts.some(
      (h, i) => counts[i] > 1 && h.run / (counts[i] - 1) < DOOR_WIDTH + 0.4,
    );
    if (tight) return forcePlace(rng, plan, walls, count, null);
  }
  const doors: RoomDoorPlacement[] = [];
  hosts.forEach((h, hi) => {
    const k = counts[hi];
    const wall = walls[h.wall];
    for (let j = 0; j < k; j++) {
      const t = k === 1 ? 0.5 : j / (k - 1);
      const offset = endPad + t * h.run;
      const along = offset - h.len / 2;
      const x = h.horizontal ? wall.x + along : wall.x;
      const z = h.horizontal ? wall.z : wall.z + along;
      const { nx, nz } = inwardNormal(plan, wall, x, z);
      doors.push({ index: doors.length, wall: h.wall, x, z, nx, nz, along, row: 0 });
    }
  });
  // Consume one draw so forcePlace's rng stream is not the identity.
  void rng();
  return doors;
}

/** Horizontal direction from any point toward the fixed camera (world XZ,
 *  unit length): CAM_OFFSET is a constant world vector and the camera never
 *  rotates, so which walls are "near" is decidable once per room. */
const CAM_DIR_XZ = (() => {
  const len = Math.hypot(CAM_OFFSET.x, CAM_OFFSET.z);
  return { x: CAM_OFFSET.x / len, z: CAM_OFFSET.z / len };
})();

/**
 * Dollhouse-cutaway probe: does this wall segment's OUTWARD face look
 * toward the fixed camera? The outward normal is found by probing
 * planContains just off both faces (the side with no walkable plan is the
 * outside), then rotated to world space (`dir` mirrors a south door's
 * π-rotated room). Walls are axis-aligned, so the dot is exactly ±1/√2 or
 * 0 and the 0.5 threshold splits cleanly. This is THE definition of
 * "camera-facing wall" — the room renderer (space.tsx) draws those walls
 * as low sills and the hostable-flags derivation below consumes it, so the
 * renderer and the movement clamp must share this one implementation.
 */
export function wallFacesCamera(
  plan: RoomPlan,
  wall: WallSegment,
  dir: number,
): boolean {
  const probe = 0.5;
  let nx = 0;
  let nz = 0;
  if (wall.sizeZ <= wall.sizeX) {
    nz = planContains(plan, wall.x, wall.z + probe, 0) ? -1 : 1;
  } else {
    nx = planContains(plan, wall.x + probe, wall.z, 0) ? -1 : 1;
  }
  const wx = dir > 0 ? nx : -nx;
  const wz = dir > 0 ? nz : -nz;
  return wx * CAM_DIR_XZ.x + wz * CAM_DIR_XZ.z > 0.5;
}

/**
 * The hostable flags placeRoomDoors expects, exactly as the room renderer
 * computes them: solid, non-entrance walls whose outward face does NOT
 * look toward the camera (full-height walls host first; the spacing ladder
 * may still relax onto the cutaway sills in tight rooms). Single source
 * for every consumer of door placements — renderer and movement clamp
 * alike — so both agree on WHERE the doors hang (A6).
 */
export function hostableWallsFor(
  plan: RoomPlan,
  walls: readonly WallSegment[],
  dir: number,
): boolean[] {
  return walls.map((wall) => !wall.entrance && !wallFacesCamera(plan, wall, dir));
}

/**
 * Hostable wall metres under a template's affordance (v0.11-room-interiors
 * §7, Finding A): the total USABLE run of the walls the affordance permits,
 * net of the domestic end pad on each segment — the raw material door
 * capacity is measured from. Measured on the SCALED walls the caller
 * already built (v0.13 draws every room at ×1, so the measure is the
 * wall itself); `hostable` (optional) restricts the measure to the
 * caller's full-height walls, exactly like the ladder's primary rung;
 * omit it to measure every solid permitted wall. Pure.
 */
export function hostableWallMetersFor(
  plan: RoomPlan,
  walls: readonly WallSegment[],
  hostable: readonly boolean[] | null = null,
  affordance?: DoorAffordance,
): number {
  let metres = 0;
  walls.forEach((wall, i) => {
    if (wall.entrance) return;
    if (!isHorizontal(wall)) return; // §10.5: door capacity lives on N/S walls
    if (affordance && !affordance.walls.includes(wallRoleFor(plan, wall))) return;
    if (hostable && !hostable[i]) return;
    metres += Math.max(0, wallLength(wall) - 2 * ROOM_DOOR_END_PAD);
  });
  return metres;
}

/**
 * Graceful door capacity under a template's affordance (Finding A): how
 * many strand doors the plan's PERMITTED walls absorb at the ladder's
 * primary rung — the rung that does not relax. THE SAME lattice
 * enumeration tryPlace seats (doorLatticeCenters at the primary rung's
 * end pad), summed over the same host set, so the number selection steers
 * by is the number placement can actually honour without loosening the
 * ladder. Measured, never declared: the wall the room truly has yields
 * the doors it truly hosts, not the tier-sized figure a template may have
 * been authored with (the template's declared doorCapacity remains as a
 * CEILING, applied by the caller).
 */
export function doorCapacityFor(
  plan: RoomPlan,
  walls: readonly WallSegment[],
  hostable: readonly boolean[] | null = null,
  affordance?: DoorAffordance,
): number {
  const rung = LADDER[0];
  let total = 0;
  walls.forEach((wall, i) => {
    if (wall.entrance) return;
    if (!isHorizontal(wall)) return; // §10.5: the ladder's rungs are N/S-first
    if (affordance && !affordance.walls.includes(wallRoleFor(plan, wall))) return;
    if (hostable && !hostable[i]) return;
    total += doorLatticeCenters(plan, wall, rung.endPad).length;
  });
  return total;
}

/**
 * Compose `count` strand doors onto the plan's solid walls. Deterministic
 * in (worldSeed, sliceId, plan, walls, hostable, count): the same slice
 * with the same door count always grows the same doorway positions.
 * `hostable[i]` marks walls the renderer wants doors on (solid AND
 * full-height); the ladder may fall back to any solid non-entrance wall.
 * Exactly `count` doors are returned — never fewer.
 *
 * `affordance` (optional, v0.11-room-interiors §7) restricts hosting to the
 * template's permitted wall roles — on every rung of the ladder, so a wall
 * carrying a shelf run or a niche never grows a door even in tight rooms.
 * Omitting it reproduces the legacy placement exactly.
 */
export function placeRoomDoors(
  sliceId: string,
  plan: RoomPlan,
  walls: readonly WallSegment[],
  hostable: readonly boolean[],
  count: number,
  worldSeed: string = WORLD_SEED,
  affordance?: DoorAffordance,
): RoomDoorLayout {
  if (count <= 0) {
    return { doors: [], relaxed: false, doubleRow: false, axialOverflow: false };
  }
  const permitted = affordance
    ? walls.map((wall) =>
        wall.entrance ? false : affordance.walls.includes(wallRoleFor(plan, wall)),
      )
    : null;
  const rng = createRng(hashString(`${worldSeed}:${sliceId}:strand-doors`));
  for (let r = 0; r < LADDER.length; r++) {
    const doors = tryPlace(rng, plan, walls, hostable, count, LADDER[r], permitted);
    if (doors) return finish(doors, walls, r > 0);
  }
  return finish(forcePlace(rng, plan, walls, count, permitted), walls, true);
}

/** Fold a placement set into the layout report: the relaxed flag comes
 *  from the ladder rung, the two fallback flags from where doors landed. */
function finish(
  doors: RoomDoorPlacement[],
  walls: readonly WallSegment[],
  relaxed: boolean,
): RoomDoorLayout {
  return {
    doors,
    relaxed,
    doubleRow: doors.some((d) => d.row === 1),
    axialOverflow: doors.some((d) => !isHorizontal(walls[d.wall])),
  };
}

/**
 * The set clearance consumers (kit staging, scatter, fixtures, structures)
 * should test approaches against: the doors themselves, PLUS a mirrored
 * copy of every second-row door — its approach strip then also covers the
 * shallow vestibule band BETWEEN the screen and its host wall, so no
 * furniture can be tucked behind the screen where the row-0 doors are
 * reached from. Pure; indexes are preserved (consumers never read them).
 */
export function doorClearanceSet(
  doors: readonly RoomDoorPlacement[],
): RoomDoorPlacement[] {
  const out = [...doors];
  for (const d of doors) {
    if (d.row === 1) out.push({ ...d, nx: -d.nx, nz: -d.nz });
  }
  return out;
}

/** One drawable wall run after splitting: a plain wall segment plus the
 *  index of the perimeter segment it was cut from (the renderer inherits
 *  the source's drawn height and material wiring). */
export interface SplitWall {
  wall: WallSegment;
  source: number;
}

/**
 * Generalise the entrance-gap split to N openings: cut every host wall
 * into the runs between its door gaps (gap = 2·gapHalf around each door
 * center, clamped to the segment bounds — exactly how wallSegmentsFor
 * splits the entrance pair around the corridor doorway). Walls without
 * doors pass through unchanged. The gaps themselves are dressed by the
 * door assembly (filler panels + lintel + transom), never by wall boxes.
 */
export function splitWallsForDoors(
  walls: readonly WallSegment[],
  doors: readonly RoomDoorPlacement[],
  gapHalf: number = DOOR_GAP_HALF,
): SplitWall[] {
  const byWall = new Map<number, RoomDoorPlacement[]>();
  for (const d of doors) {
    if (d.row !== 0) continue; // screen-row doors cut their own screen, not the perimeter
    const list = byWall.get(d.wall) ?? [];
    list.push(d);
    byWall.set(d.wall, list);
  }
  const out: SplitWall[] = [];
  walls.forEach((wall, i) => {
    const hosted = byWall.get(i);
    if (!hosted || hosted.length === 0) {
      out.push({ wall, source: i });
      return;
    }
    const horizontal = isHorizontal(wall);
    const len = wallLength(wall);
    const lo = -len / 2;
    const hi = len / 2;
    const cuts: number[] = [lo];
    for (const d of [...hosted].sort((a, b) => a.along - b.along)) {
      cuts.push(Math.max(lo, d.along - gapHalf));
      cuts.push(Math.min(hi, d.along + gapHalf));
    }
    cuts.push(hi);
    for (let c = 0; c + 1 < cuts.length; c += 2) {
      const a = cuts[c];
      const b = cuts[c + 1];
      if (b - a <= 1e-3) continue;
      const mid = (a + b) / 2;
      out.push({
        wall: horizontal
          ? { x: wall.x + mid, z: wall.z, sizeX: b - a, sizeZ: wall.sizeZ, entrance: false }
          : { x: wall.x, z: wall.z + mid, sizeX: wall.sizeX, sizeZ: b - a, entrance: false },
        source: i,
      });
    }
  });
  return out;
}

/**
 * Crossing predicate, in the plan's local frame (the same transform the
 * doorway swing uses: lx/lz = (world − door) mirrored for south doors).
 * Returns the crossed door's index when the player is between the jambs
 * (|along| < GAP_HALF — the slab passage, as in clamps.ts) and their
 * inward distance from the wall plane has dropped below crossDepth —
 * genuinely inside the doorway, matching the entrance's hysteresis-band
 * pattern. The lower perp bound keeps a player teleported just OUTSIDE
 * the far side from retriggering the same door. The entrance is never a
 * candidate (no placement exists on its wall), so it cannot fire here.
 */
export function crossedRoomDoor(
  lx: number,
  lz: number,
  doors: readonly RoomDoorPlacement[],
  crossDepth: number = ROOM_DOOR_CROSS_DEPTH,
): number | null {
  for (const d of doors) {
    const dx = lx - d.x;
    const dz = lz - d.z;
    const perp = dx * d.nx + dz * d.nz; // inward-positive distance to the wall plane
    const along = -dx * d.nz + dz * d.nx; // tangent offset from the door center
    if (Math.abs(along) < GAP_HALF && perp < crossDepth && perp > -1) {
      return d.index;
    }
  }
  return null;
}

/**
 * Approach-clearance predicate (B.11): is (x, z) inside any strand door's
 * approach strip? The strip is the rectangle extending `depth` meters
 * inward from the door's wall plane along its PROBED inward normal,
 * `half` meters to each side of the door center along the wall — the
 * doorway gap plus a body's margin, the same shaping as the entrance's
 * own doorway corridor (ROOM_DOOR_CLEAR_HALF/_DEPTH). It follows each
 * door's own wall and normal, so doors on the cutaway sills, the
 * l-shape's step wall, or its inner leg wall are all covered — never a
 * fixed axis. Furnishing (kits.ts) and the renderer's scatter/structure
 * layers reject anything landing here: a door you cannot walk to is a
 * door buried behind a bookshelf. Pure; the plan's local frame, the same
 * perp/along decomposition crossedRoomDoor uses.
 */
export function inDoorApproach(
  x: number,
  z: number,
  doors: readonly RoomDoorPlacement[],
  half: number = ROOM_DOOR_CLEAR_HALF,
  depth: number = ROOM_DOOR_CLEAR_DEPTH,
): boolean {
  for (const d of doors) {
    const dx = x - d.x;
    const dz = z - d.z;
    const perp = dx * d.nx + dz * d.nz; // inward distance from the wall plane
    const along = -dx * d.nz + dz * d.nx; // tangent offset from the door center
    if (perp > 0 && perp < depth && Math.abs(along) < half) return true;
  }
  return false;
}

/**
 * Plaque label, final form: whitespace collapsed, capped at maxChars with
 * an ellipsis so a long strand name still fits the plate. Pure and
 * deterministic — the same label always yields the same plaque text (the
 * canvas rasterization that consumes this lives in space.tsx; what the
 * plaque SAYS is decided here, where it can be unit-tested in node).
 */
export function plaqueLabelFor(
  label: string,
  maxChars: number = ROOM_DOOR_PLAQUE_MAX_CHARS,
): string {
  const clean = label.replace(/\s+/g, " ").trim();
  if (clean.length <= maxChars) return clean;
  return `${clean.slice(0, maxChars - 1).trimEnd()}…`;
}
