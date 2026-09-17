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
import { CAM_OFFSET } from "./tuning/render";
import {
  DOOR_GAP_HALF,
  DOOR_WIDTH,
  ROOM_DOOR_CLEAR_DEPTH,
  ROOM_DOOR_CLEAR_HALF,
  ROOM_DOOR_CLUSTER_STICK,
  ROOM_DOOR_CROSS_DEPTH,
  ROOM_DOOR_END_PAD,
  ROOM_DOOR_MIN_GAP,
  ROOM_DOOR_PLAQUE_MAX_CHARS,
} from "./tuning/room";

/** One placed strand door, in the plan's local frame (doorway at (0,0),
 *  +z outward, x centered on the entrance axis). */
export interface RoomDoorPlacement {
  /** Index into the roomDoors list the scene was handed. */
  index: number;
  /** Index into the walls array passed to placeRoomDoors. */
  wall: number;
  /** Door center on the wall line. */
  x: number;
  z: number;
  /** Inward unit normal (axis-aligned), PROBED toward the walkable plan. */
  nx: number;
  nz: number;
  /** Offset along the wall's run from the segment center (m). */
  along: number;
}

export interface RoomDoorLayout {
  doors: RoomDoorPlacement[];
  /** True when the spacing ladder had to relax (denser spacing, camera-
   *  side walls, or both) to place every requested door. */
  relaxed: boolean;
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
 */
interface LadderRung {
  hostableOnly: boolean;
  spacing: number;
  endPad: number;
}

const LADDER: readonly LadderRung[] = [
  // The home: full-height walls only, doors 3.0m on center, corners clear.
  {
    hostableOnly: true,
    spacing: DOOR_WIDTH + ROOM_DOOR_MIN_GAP,
    endPad: ROOM_DOOR_END_PAD,
  },
  // Too many doors for the tall walls: the cutaway sills may host too
  // (the portal dressing stands from the floor, so the door still works).
  {
    hostableOnly: false,
    spacing: DOOR_WIDTH + ROOM_DOOR_MIN_GAP,
    endPad: ROOM_DOOR_END_PAD,
  },
  // Denser: corridor-tight spacing, reduced corner pad.
  { hostableOnly: false, spacing: 2.4, endPad: 1.5 },
  // Emergency: doors just clear of each other's frames.
  { hostableOnly: false, spacing: DOOR_WIDTH + 0.5, endPad: 1.3 },
];

/** Wall capacity at a center spacing: n doors need run ≥ (n−1)·spacing. */
function capacity(run: number, spacing: number): number {
  if (run < 0) return 0;
  return 1 + Math.floor(run / spacing + 1e-9);
}

/**
 * Positions of k door centers along a run [0, run], pairwise ≥ spacing,
 * seeded and UNEVEN: rejection-sampled uniform draws (irregular gaps read
 * as authored, even gaps as wallpaper), with a guaranteed deterministic
 * fallback (seeded offset + exact spacing) for the near-capacity case.
 */
function samplePositions(
  rng: () => number,
  run: number,
  k: number,
  spacing: number,
): number[] {
  if (k === 1) {
    // Off-center, never dead middle — a lone door hugging one side of its
    // wall reads as the door to somewhere specific.
    return [run * (0.2 + rng() * 0.6)];
  }
  for (let tries = 0; tries < 60; tries++) {
    const pts = Array.from({ length: k }, () => rng() * run).sort(
      (a, b) => a - b,
    );
    let ok = true;
    for (let i = 1; i < k; i++) {
      if (pts[i] - pts[i - 1] < spacing) {
        ok = false;
        break;
      }
    }
    if (ok) return pts;
  }
  const slack = Math.max(0, run - (k - 1) * spacing);
  const offset = rng() * slack;
  return Array.from({ length: k }, (_, j) => offset + j * spacing);
}

/** One placement attempt at one ladder rung. Null when the walls cannot
 *  hold `count` doors at this spacing; otherwise exactly count doors.
 *  `permitted` (template affordance) bans wall roles outright, on every
 *  rung; null = every solid non-entrance wall may host. */
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
    const len = wallLength(wall);
    hosts.push({
      wall: i,
      horizontal: isHorizontal(wall),
      len,
      run: len - 2 * rung.endPad,
    });
  });
  const remaining = hosts.map((h) => capacity(h.run, rung.spacing));
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

  // Positions per host wall, then geometry.
  const counts = new Map<number, number>();
  assignment.forEach((h) => counts.set(h, (counts.get(h) ?? 0) + 1));
  const positions = new Map<number, number[]>();
  for (const [h, k] of counts) {
    positions.set(h, samplePositions(rng, hosts[h].run, k, rung.spacing));
  }
  const used = new Map<number, number>();
  const doors: RoomDoorPlacement[] = [];
  for (let d = 0; d < count; d++) {
    const h = hosts[assignment[d]];
    const slot = used.get(assignment[d]) ?? 0;
    used.set(assignment[d], slot + 1);
    const offset = rung.endPad + (positions.get(assignment[d]) ?? [0])[slot];
    const wall = walls[h.wall];
    // From segment start along the run: start = center − len/2.
    const along = offset - h.len / 2;
    const x = h.horizontal ? wall.x + along : wall.x;
    const z = h.horizontal ? wall.z : wall.z + along;
    const { nx, nz } = inwardNormal(plan, wall, x, z);
    doors.push({ index: d, wall: h.wall, x, z, nx, nz, along });
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
      doors.push({ index: doors.length, wall: h.wall, x, z, nx, nz, along });
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
 * capacity is measured from. Measured on the SCALED walls the caller already
 * built, so a miniature room's shortened wall reports shortened metres and
 * scale notation can no longer hide behind a tier-sized capacity claim.
 * `hostable` (optional) restricts the measure to the caller's full-height
 * walls, exactly like the ladder's primary rung; omit it to measure every
 * solid permitted wall. Pure.
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
    if (affordance && !affordance.walls.includes(wallRoleFor(plan, wall))) return;
    if (hostable && !hostable[i]) return;
    metres += Math.max(0, wallLength(wall) - 2 * ROOM_DOOR_END_PAD);
  });
  return metres;
}

/**
 * Graceful door capacity under a template's affordance (Finding A): how
 * many strand doors the plan's PERMITTED walls absorb at the authored
 * domestic spacing — the ladder's primary rung, the rung that does not
 * relax. This is the same per-wall `capacity(run, spacing)` math tryPlace
 * uses, summed over the same host set, so the number selection steers by is
 * the number placement can actually honour without loosening the ladder.
 * Measured, never declared: a ×0.2 miniature's 13m door wall yields the
 * four doors it truly hosts, not the tier-sized figure its template was
 * authored with (the template's declared doorCapacity remains as a CEILING,
 * applied by the caller, so a colossal room cannot demand an absurd count).
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
    if (affordance && !affordance.walls.includes(wallRoleFor(plan, wall))) return;
    if (hostable && !hostable[i]) return;
    total += capacity(wallLength(wall) - 2 * rung.endPad, rung.spacing);
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
  if (count <= 0) return { doors: [], relaxed: false };
  const permitted = affordance
    ? walls.map((wall) =>
        wall.entrance ? false : affordance.walls.includes(wallRoleFor(plan, wall)),
      )
    : null;
  const rng = createRng(hashString(`${worldSeed}:${sliceId}:strand-doors`));
  for (let r = 0; r < LADDER.length; r++) {
    const doors = tryPlace(rng, plan, walls, hostable, count, LADDER[r], permitted);
    if (doors) return { doors, relaxed: r > 0 };
  }
  return { doors: forcePlace(rng, plan, walls, count, permitted), relaxed: true };
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
