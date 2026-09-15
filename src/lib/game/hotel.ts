/**
 * Hotel layout math — the pure geometry of the lobby + infinite corridor.
 *
 * WHY THIS EXISTS. The hotel is streamed: only chunks near the player are
 * materialized, doors are opened on demand, and the whole world must rebuild
 * identically from seeds alone. That is only possible if every position,
 * chunk assignment, and door lookup is a pure function of integers and
 * caller-supplied slice ids — so this module owns ALL of it, and no other
 * file is allowed to do layout arithmetic. Renderers consume; they never
 * compute.
 *
 * COORDINATES. X runs along the corridor (negative = the past, positive =
 * the future), Z runs across it (north wall at +Z, south wall at -Z), Y is
 * up and is not used here — every function works in the XZ plane. Units are
 * meters. The lobby occupies x ∈ [0, LOBBY_LENGTH); the past corridor is
 * x < 0 (past door 0 sits nearest the lobby) and the future corridor is
 * x > LOBBY_LENGTH.
 *
 * DOOR INDICES ARE SIGNED. A non-negative index addresses a PAST door:
 * door i is centered at x = -(i + 0.5) * DOOR_SPACING. A negative index
 * addresses a FUTURE door: index -1 is future door 0, index -(j + 1) is
 * future door j, centered at x = LOBBY_LENGTH + (j + 0.5) * DOOR_SPACING.
 * v1 materializes only the past side, but the signing convention keeps
 * doorPosition total (one index ↦ one door position, no separate direction
 * argument) and the future side is already wired through chunkIndexForX
 * and chunkBounds.
 *
 * CHUNK GRID. Chunks are CHUNK_LENGTH = DOOR_SPACING * CHUNK_DOORS meters
 * long and tile the corridor away from the lobby in BOTH directions:
 *
 *   - Past chunk c ≤ 0 owns ((c - 1) * L, c * L]. Chunk 0 owns
 *     (-CHUNK_LENGTH, 0] — past doors 0..CHUNK_DOORS-1.
 *   - The lobby interior (0, LOBBY_LENGTH] belongs to chunk 0 as well, so
 *     chunk 0 — the chunk the player stands in while still inside the
 *     lobby — owns (-CHUNK_LENGTH, LOBBY_LENGTH]. It is deliberately
 *     longer than CHUNK_LENGTH; every other chunk is exactly CHUNK_LENGTH.
 *   - Future chunk c ≥ 1 owns (LOBBY_LENGTH + (c - 1) * L, LOBBY_LENGTH +
 *     c * L], so each future chunk holds exactly CHUNK_DOORS future doors.
 *
 * Boundary ownership follows chunkIndexForX (a ceil convention): exactly
 * one chunk claims each boundary point, e.g. x = -CHUNK_LENGTH is chunk
 * -1's far edge and x = 0 is chunk 0's. Interior points never touch a
 * boundary, so treadmill streaming is unaffected by which side owns it.
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

/** Meters between adjacent door centers along X (same on both sides). */
export const DOOR_SPACING = 6;

/** Corridor width in meters (north wall at +Z, south wall at −Z) — a
 *  proper hotel hallway, ten meters between wall faces. */
export const CORRIDOR_WIDTH = 10;

/** Corridor wall height in meters — matches the 4 m enclosure walls of the
 *  door spaces. Unused by the math; exported for the renderer. */
export const WALL_HEIGHT = 4.0;

/** Doors per chunk per side; a full chunk is one north + one south row. */
export const CHUNK_DOORS = 4;

/** Chunk length along X — CHUNK_DOORS door bays of DOOR_SPACING each. */
export const CHUNK_LENGTH = DOOR_SPACING * CHUNK_DOORS;

/** Lobby length along X; the lobby occupies x ∈ [0, LOBBY_LENGTH). */
export const LOBBY_LENGTH = 14;

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
 * Center of door `index` in the XZ plane.
 *
 * index ≥ 0 → past side, x = -(index + 0.5) * DOOR_SPACING.
 * index < 0  → future side, j = -(index + 1), x = LOBBY_LENGTH +
 * (j + 0.5) * DOOR_SPACING. z is +(CORRIDOR_WIDTH / 2) on the north wall,
 * -(CORRIDOR_WIDTH / 2) on the south wall, past or future.
 */
export function doorPosition(
  index: number,
  side: Side,
): { x: number; z: number } {
  const z = side === "north" ? CORRIDOR_WIDTH / 2 : -CORRIDOR_WIDTH / 2;
  if (index >= 0) {
    return { x: -(index + 0.5) * DOOR_SPACING, z };
  }
  const j = -(index + 1);
  return { x: LOBBY_LENGTH + (j + 0.5) * DOOR_SPACING, z };
}

/**
 * Chunk containing x. Ceil convention: chunk c ≤ 0 owns ((c - 1) *
 * CHUNK_LENGTH, c * CHUNK_LENGTH], the lobby interior (0 < x ≤
 * LOBBY_LENGTH) maps to chunk 0, and future chunk c ≥ 1 owns
 * (LOBBY_LENGTH + (c - 1) * CHUNK_LENGTH, LOBBY_LENGTH + c * CHUNK_LENGTH].
 * In particular: x = -CHUNK_LENGTH → -1, x → 0⁻ → 0, x = 0 and the whole
 * lobby → 0, x slightly past LOBBY_LENGTH → 1.
 */
export function chunkIndexForX(x: number): number {
  if (x > LOBBY_LENGTH) {
    return Math.ceil((x - LOBBY_LENGTH) / CHUNK_LENGTH) || 0;
  }
  if (x > 0) return 0;
  // Math.ceil alone maps (-CHUNK_LENGTH, 0) to -0; normalize so callers
  // can rely on `=== 0`.
  return Math.ceil(x / CHUNK_LENGTH) || 0;
}

/**
 * Footprint of chunk `chunkIndex`, consistent with chunkIndexForX: every
 * x strictly between xStart and xEnd maps to this chunk. Chunk 0 spans
 * (-CHUNK_LENGTH, LOBBY_LENGTH] — the nearest past bays plus the lobby —
 * so it is CHUNK_LENGTH + LOBBY_LENGTH long; all other chunks are exactly
 * CHUNK_LENGTH. Exact boundary points belong to whichever chunk
 * chunkIndexForX assigns them to.
 */
export function chunkBounds(chunkIndex: number): ChunkRef {
  if (chunkIndex > 0) {
    const xStart = LOBBY_LENGTH + (chunkIndex - 1) * CHUNK_LENGTH;
    return { index: chunkIndex, xStart, xEnd: xStart + CHUNK_LENGTH };
  }
  const xStart = (chunkIndex - 1) * CHUNK_LENGTH;
  const xEnd = chunkIndex === 0 ? LOBBY_LENGTH : chunkIndex * CHUNK_LENGTH;
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
        ...doorPosition(i, "north"),
      });
    }
    const southId = sliceIds[2 * i + 1];
    if (southId !== undefined) {
      doors.push({
        sliceId: southId,
        index: i,
        side: "south",
        ...doorPosition(i, "south"),
      });
    }
  }
  return doors;
}

/**
 * The treadmill window: the chunk containing playerX plus `radius`
 * neighbors in both directions, ordered future-ward first (descending
 * index), so visibleChunkIndices(0) === [1, 0, -1].
 */
export function visibleChunkIndices(playerX: number, radius = 1): number[] {
  const center = chunkIndexForX(playerX);
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
 * maxDist is still correct because the scan window grows with radius 1.
 * "Within maxDist" is inclusive. Ties resolve to the earliest door in
 * scan order (north before south within a pair), keeping the result
 * deterministic. Returns null when no door is within maxDist.
 */
export function nearestDoor(
  x: number,
  z: number,
  sliceIds: readonly string[],
  maxDist = 1.6,
): DoorRef | null {
  let best: DoorRef | null = null;
  let bestSq = Infinity;
  const maxSq = maxDist * maxDist;
  for (const chunkIndex of visibleChunkIndices(x, 1)) {
    for (const door of doorsInChunk(chunkIndex, sliceIds)) {
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
