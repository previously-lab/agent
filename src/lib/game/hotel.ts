/**
 * Hotel layout math — the pure geometry of the lobby + infinite corridor.
 *
 * WHY THIS EXISTS. The hotel is streamed: only chunks near the player are
 * materialized, doors are opened on demand, and the whole world must rebuild
 * identically from seeds alone. That is only possible if every position,
 * chunk assignment, and door lookup is a pure function of integers, caller-
 * supplied slice ids, and a caller-supplied CorridorLayout — so this module
 * owns ALL addressing, and no other file is allowed to do layout arithmetic.
 * Renderers consume; they never compute. (The layout itself — time gaps →
 * bay pitches → cumulative sums — is built by corridor-pitch.ts; this module
 * consumes it.)
 *
 * COORDINATES. X runs along the corridor (negative = the past, positive =
 * the future), Z runs across it (north wall at +Z, south wall at -Z), Y is
 * up and is not used here — every function works in the XZ plane. Units are
 * meters. The lobby occupies x ∈ [0, LOBBY_LENGTH); the past corridor is
 * x < 0 (past door 0 sits nearest the lobby) and the future corridor is
 * x > LOBBY_LENGTH.
 *
 * THE LOBBY IS THE L'S SHORT LEG (v0.11-room-interiors §10: 短边 = 大厅,
 * 长边 = 走廊). Its floor extends SOUTH of the corridor band to
 * z = -LOBBY_SOUTH_REACH, so the lobby's own axis runs across the corridor,
 * not along it — arriving from the hall reads as a turn into a separate
 * room. Chunk addressing is blind to this: ownership is decided purely
 * along x (chunk 0 keeps the whole lobby, whatever its z), so the leg
 * changes no layout math below — LOBBY_SOUTH_REACH exists for the renderer
 * and the movement clamp, not for the chunk grid.
 *
 * DOOR INDICES ARE SIGNED. A non-negative index addresses a PAST door. With
 * no layout, door i is centered at x = -(i + 0.5) * DOOR_SPACING — the
 * legacy uniform grid. With a CorridorLayout, bay i is exactly pitches[i]
 * meters long, its door sits at its own center, and bays tile the corridor
 * contiguously from the lobby outward: bay i spans
 * [-cumulative[i + 1], -cumulative[i]) (see corridor-pitch.ts). A layout
 * whose gaps are all ≤ 1 day has every pitch equal to DOOR_PITCH_BASE and
 * reproduces the uniform grid bit for bit — DOOR_SPACING and
 * DOOR_PITCH_BASE are the same 6 meters, pinned by the tests. A negative
 * index addresses a FUTURE door: index -1 is future door 0, index -(j + 1)
 * is future door j, centered at x = LOBBY_LENGTH + (j + 0.5) * DOOR_SPACING
 * (the future side stays uniform — no future slices exist yet). v1
 * materializes only the past side, but the signing convention keeps
 * doorPosition total (one index ↦ one door position, no separate direction
 * argument) and the future side is already wired through chunkIndexForX
 * and chunkBounds.
 *
 * CHUNK GRID. Chunks own DOOR-INDEX RANGES, not meter ranges: past chunk
 * c ≤ 0 owns bays |c| * CHUNK_DOORS .. |c| * CHUNK_DOORS + CHUNK_DOORS - 1,
 * and its length is the SUM OF ITS BAYS' PITCHES. With no layout (or a
 * uniform one) that sum is CHUNK_LENGTH = DOOR_SPACING * CHUNK_DOORS and the
 * grid is the legacy fixed tiling:
 *
 *   - Past chunk c ≤ 0 owns ((c - 1) * L, c * L]. Chunk 0 owns
 *     (-CHUNK_LENGTH, 0] — past doors 0..CHUNK_DOORS-1.
 *   - The lobby interior (0, LOBBY_LENGTH] belongs to chunk 0 as well, so
 *     chunk 0 — the chunk the player stands in while still inside the
 *     lobby — owns (-CHUNK_LENGTH, LOBBY_LENGTH]. It is deliberately
 *     longer than CHUNK_LENGTH; every other uniform chunk is exactly
 *     CHUNK_LENGTH. (With a layout, chunk lengths vary with the pitches —
 *     "chunks are exactly CHUNK_LENGTH meters" is NO LONGER an invariant;
 *     "a chunk owns CHUNK_DOORS consecutive bays" is.)
 *   - Future chunk c ≥ 1 owns (LOBBY_LENGTH + (c - 1) * L, LOBBY_LENGTH +
 *     c * L], so each future chunk holds exactly CHUNK_DOORS future doors.
 *
 * Boundary ownership is unchanged and remains TOTAL and NON-OVERLAPPING:
 * every x belongs to exactly one chunk, and exact boundary points go to the
 * deeper chunk (the ceil convention — e.g. on the uniform grid x =
 * -CHUNK_LENGTH is chunk -1's far edge and x = 0 is chunk 0's). The
 * streaming treadmill depends on this: a point claimed twice double-mounts
 * geometry, a point claimed by none drops it.
 *
 * SLICE PAIRING. Past door index i is one PAIR element in the flat slice
 * sequence the caller passes in: the north door (sliceIds[2i]) and the
 * south door (sliceIds[2i + 1]) stand across the corridor from each other
 * at the same x but are two different doors behind two different slices.
 * Chunk c ≤ 0 holds past door indices |c| * CHUNK_DOORS + k for
 * k ∈ [0, CHUNK_DOORS). Note that for chunk -1 this means door indices
 * 4..7 consume sliceIds[8..15] — the index sequence counts doors from
 * the lobby outward, so it is |c|-based, not c-based; indexing
 * sliceIds[2 * (c * CHUNK_DOORS + k)] literally would walk off the array
 * for negative chunks. Future chunks (c ≥ 1) return no doors in v1: no
 * future slices exist yet. Positions and bounds for the future side ARE
 * implemented, so v2 only has to allocate slices.
 *
 * PURITY. No randomness (see seed.ts — entropy enters through the
 * caller-supplied sliceIds), no I/O, no mutable state. Same arguments,
 * same result, on any machine.
 */

import type { CorridorLayout } from "./corridor-pitch";

/** Meters between adjacent door centers along X on the uniform grid — equal
 *  to DOOR_PITCH_BASE (tuning/hotel.ts); a layout whose gaps are all ≤ 1
 *  day reproduces exactly this spacing. */
export const DOOR_SPACING = 6;

/** Corridor width in meters (north wall at +Z, south wall at −Z) — a
 *  proper hotel hallway, ten meters between wall faces. */
export const CORRIDOR_WIDTH = 10;

/** Corridor wall height in meters — matches the 4 m enclosure walls of the
 *  door spaces. Unused by the math; exported for the renderer. */
export const WALL_HEIGHT = 4.0;

/** Doors per chunk per side; a full chunk is one north + one south row. */
export const CHUNK_DOORS = 4;

/** Uniform-grid chunk length along X — CHUNK_DOORS door bays of
 *  DOOR_SPACING each. With a layout, a chunk's length is the sum of its
 *  bays' pitches instead; CHUNK_LENGTH remains the reference length of a
 *  fully dense stretch. */
export const CHUNK_LENGTH = DOOR_SPACING * CHUNK_DOORS;

/** Lobby length along X; the lobby occupies x ∈ [0, LOBBY_LENGTH). */
export const LOBBY_LENGTH = 14;

/** The lobby's south wall sits at z = −LOBBY_SOUTH_REACH — the lobby is the
 *  L's short leg (see the module doc): its floor runs south from the
 *  corridor band (z = −CORRIDOR_WIDTH / 2) to this wall, perpendicular to
 *  the corridor. Purely a footprint constant for the renderer and the
 *  movement clamp; the chunk grid never reads it (ownership is along x). */
export const LOBBY_SOUTH_REACH = 17;

/** Which corridor wall a door is set into. */
export type Side = "north" | "south";

/** A door: its slice plus where in the corridor it sits. */
export interface DoorRef {
  /** Past slice index i ≥ 0 (see module doc for the future-side signing). */
  index: number;
  /** Wall the door is set into — fixes the z sign. */
  side: Side;
  /** Id of the time slice this door opens into. */
  sliceId: string;
  /** Center of the door along the corridor, in meters. */
  x: number;
  /** Center of the door across the corridor: ±(CORRIDOR_WIDTH / 2). */
  z: number;
}

/** XZ footprint of a chunk (see module doc for boundary ownership). */
export interface ChunkRef {
  index: number;
  xStart: number;
  xEnd: number;
}

/**
 * Pitch sum before bay `m` on the past side, honoring the layout when one
 * is given and falling back to the uniform grid otherwise. Bay i's door
 * center is -(pitchBefore(i) + pitchOf(i) / 2). Bays past the end of the
 * layout extend at DOOR_SPACING — the same value corridor-pitch.ts extends
 * with as DOOR_PITCH_BASE (the two are pinned equal by the tests), and
 * deliberately re-implemented here rather than imported: corridor-pitch
 * pulls its constants from tuning/hotel.ts, which imports CHUNK_LENGTH and
 * WALL_HEIGHT from THIS module — a runtime import would close a module
 * cycle with a module-scope const read inside it.
 */
function pitchBefore(layout: CorridorLayout, m: number): number {
  const n = layout.cumulative.length - 1;
  if (m <= n) return layout.cumulative[m];
  return layout.cumulative[n] + (m - n) * DOOR_SPACING;
}

function pitchOf(layout: CorridorLayout, bay: number): number {
  return bay < layout.pitches.length ? layout.pitches[bay] : DOOR_SPACING;
}

/**
 * Center of door `index` in the XZ plane.
 *
 * index ≥ 0 → past side: without a layout, x = -(index + 0.5) *
 * DOOR_SPACING; with one, x is the center of bay `index` (the bay is
 * pitches[index] long and its door sits at its own center). index < 0 →
 * future side, j = -(index + 1), x = LOBBY_LENGTH + (j + 0.5) *
 * DOOR_SPACING. z is +(CORRIDOR_WIDTH / 2) on the north wall,
 * -(CORRIDOR_WIDTH / 2) on the south wall, past or future.
 */
export function doorPosition(
  index: number,
  side: Side,
  layout?: CorridorLayout,
): { x: number; z: number } {
  const z = side === "north" ? CORRIDOR_WIDTH / 2 : -CORRIDOR_WIDTH / 2;
  if (index >= 0) {
    const x = layout
      ? -(pitchBefore(layout, index) + pitchOf(layout, index) / 2)
      : -(index + 0.5) * DOOR_SPACING;
    return { x, z };
  }
  const j = -(index + 1);
  return { x: LOBBY_LENGTH + (j + 0.5) * DOOR_SPACING, z };
}

/**
 * Chunk containing x. Ceil convention: an exact boundary point belongs to
 * the DEEPER chunk — without a layout, chunk c ≤ 0 owns ((c - 1) *
 * CHUNK_LENGTH, c * CHUNK_LENGTH], the lobby interior (0 < x ≤
 * LOBBY_LENGTH) maps to chunk 0, and future chunk c ≥ 1 owns
 * (LOBBY_LENGTH + (c - 1) * CHUNK_LENGTH, LOBBY_LENGTH + c * CHUNK_LENGTH].
 * In particular: x = -CHUNK_LENGTH → -1, x → 0⁻ → 0, x = 0 and the whole
 * lobby → 0, x slightly past LOBBY_LENGTH → 1.
 *
 * With a layout the past-side boundaries move to the layout's bay seams
 * (chunk c spans [-cumulative[|c|*CHUNK_DOORS + CHUNK_DOORS],
 * -cumulative[|c|*CHUNK_DOORS]]); the lookup walks chunkBounds outward from
 * chunk 0, so agreement between the two functions is by construction and
 * ownership stays total and non-overlapping. The walk is O(chunk depth) —
 * trivial for any corridor a player can actually stream.
 */
export function chunkIndexForX(x: number, layout?: CorridorLayout): number {
  if (x > LOBBY_LENGTH) {
    return Math.ceil((x - LOBBY_LENGTH) / CHUNK_LENGTH) || 0;
  }
  if (x > 0) return 0;
  if (!layout) {
    // Math.ceil alone maps (-CHUNK_LENGTH, 0) to -0; normalize so callers
    // can rely on `=== 0`.
    return Math.ceil(x / CHUNK_LENGTH) || 0;
  }
  for (let c = 0; ; c--) {
    if (x > chunkBounds(c, layout).xStart) return c;
  }
}

/**
 * Footprint of chunk `chunkIndex`, consistent with chunkIndexForX: every
 * x strictly between xStart and xEnd maps to this chunk. Chunk 0 spans the
 * nearest past bays plus the lobby — (-CHUNK_LENGTH, LOBBY_LENGTH] on the
 * uniform grid — so it is CHUNK_LENGTH + LOBBY_LENGTH long; every other
 * chunk is CHUNK_LENGTH on the uniform grid, or the sum of its bays'
 * pitches with a layout. Exact boundary points belong to whichever chunk
 * chunkIndexForX assigns them to.
 */
export function chunkBounds(
  chunkIndex: number,
  layout?: CorridorLayout,
): ChunkRef {
  if (chunkIndex > 0) {
    const xStart = LOBBY_LENGTH + (chunkIndex - 1) * CHUNK_LENGTH;
    return { index: chunkIndex, xStart, xEnd: xStart + CHUNK_LENGTH };
  }
  const base = -chunkIndex * CHUNK_DOORS;
  const xStart = layout
    ? -pitchBefore(layout, base + CHUNK_DOORS)
    : (chunkIndex - 1) * CHUNK_LENGTH;
  const xEnd =
    chunkIndex === 0
      ? LOBBY_LENGTH
      : layout
        ? -pitchBefore(layout, base)
        : chunkIndex * CHUNK_LENGTH;
  return { index: chunkIndex, xStart, xEnd };
}

/**
 * Doors materialized for one chunk, in a stable order: for k ascending,
 * the north door then the south door of bay k.
 *
 * Chunk c ≤ 0 holds past door indices i = |c| * CHUNK_DOORS + k; the
 * north door of bay k consumes sliceIds[2i] and the south door
 * sliceIds[2i + 1] — the flat sequence is pairs, one pair per door index,
 * shared by both walls (see module doc). sliceIds shorter than 2i + 2
 * simply yields fewer doors: a slice that has not been allocated yet
 * means the door is not materialized yet, and the treadmill skips it.
 *
 * Chunk c ≥ 1 (the future corridor) returns [] in v1 — the future chunk
 * grid and doorPosition already handle future x, but no future slices are
 * allocated, so there is nothing to map to.
 */
export function doorsInChunk(
  chunkIndex: number,
  sliceIds: readonly string[],
  layout?: CorridorLayout,
): DoorRef[] {
  if (chunkIndex > 0) return [];
  const doors: DoorRef[] = [];
  const base = -chunkIndex * CHUNK_DOORS;
  for (let k = 0; k < CHUNK_DOORS; k++) {
    const i = base + k;
    const northId = sliceIds[2 * i];
    if (northId !== undefined) {
      doors.push({
        sliceId: northId,
        index: i,
        side: "north",
        ...doorPosition(i, "north", layout),
      });
    }
    const southId = sliceIds[2 * i + 1];
    if (southId !== undefined) {
      doors.push({
        sliceId: southId,
        index: i,
        side: "south",
        ...doorPosition(i, "south", layout),
      });
    }
  }
  return doors;
}

/**
 * X of every door the slice list materializes, in bay order — the corridor
 * movement clamp's gap test (game-canvas threads the result into
 * clampToCorridor). Both walls share one x per bay, so each allocated bay
 * contributes its center once per allocated side. With a layout the xs are
 * the pitched bay centers; without one they are the uniform grid — either
 * way the list matches what doorsInChunk materializes.
 */
export function materializedDoorXs(
  sliceIds: readonly string[],
  layout?: CorridorLayout,
): number[] {
  const xs: number[] = [];
  for (let i = 0; ; i++) {
    const northId = sliceIds[2 * i];
    const southId = sliceIds[2 * i + 1];
    if (northId === undefined && southId === undefined) break;
    if (northId !== undefined) xs.push(doorPosition(i, "north", layout).x);
    if (southId !== undefined) xs.push(doorPosition(i, "south", layout).x);
  }
  return xs;
}

/**
 * The treadmill window: the chunk containing playerX plus `radius`
 * neighbors in both directions, ordered future-ward first (descending
 * index), so visibleChunkIndices(0) === [1, 0, -1].
 */
export function visibleChunkIndices(
  playerX: number,
  radius = 1,
  layout?: CorridorLayout,
): number[] {
  const center = chunkIndexForX(playerX, layout);
  const indices: number[] = [];
  for (let i = center + radius; i >= center - radius; i--) {
    indices.push(i);
  }
  return indices;
}

/**
 * Door nearest to the (x, z) position within maxDist meters — the
 * interact-key query. Distance is Euclidean in the XZ plane (Y ignored:
 * doors span the full wall height). Scans the player's chunk and its two
 * neighbors, which always covers maxDist ≤ DOOR_SPACING / 2; a larger
 * maxDist is still correct because the scan window grows with radius 1
 * (three chunks span at least 2 * CHUNK_DOORS bays to either side, ≥ 40 m
 * even at minimum pitch). "Within maxDist" is inclusive. Ties resolve to
 * the earliest door in scan order (north before south within a pair),
 * keeping the result deterministic. Returns null when no door is within
 * maxDist.
 */
export function nearestDoor(
  x: number,
  z: number,
  sliceIds: readonly string[],
  maxDist = 1.6,
  layout?: CorridorLayout,
): DoorRef | null {
  let best: DoorRef | null = null;
  let bestSq = Infinity;
  const maxSq = maxDist * maxDist;
  for (const chunkIndex of visibleChunkIndices(x, 1, layout)) {
    for (const door of doorsInChunk(chunkIndex, sliceIds, layout)) {
      const dx = door.x - x;
      const dz = door.z - z;
      const distSq = dx * dx + dz * dz;
      if (distSq <= maxSq && distSq < bestSq) {
        bestSq = distSq;
        best = door;
      }
    }
  }
  return best;
}
