/**
 * Tests for the hotel layout math — the pure geometry behind the lobby +
 * infinite corridor: door placement on both walls, the chunk grid
 * (including boundary ownership and the lobby-in-chunk-0 convention),
 * slice pairing into door pairs, the treadmill window, and the interact
 * query. The conventions under test are the ones documented in hotel.ts;
 * these tests are the contract other game code builds against.
 */
import { describe, it, expect } from "vitest";
import {
  DOOR_SPACING,
  CORRIDOR_WIDTH,
  WALL_HEIGHT,
  CHUNK_DOORS,
  CHUNK_LENGTH,
  LOBBY_LENGTH,
  type DoorRef,
  doorPosition,
  chunkIndexForX,
  chunkBounds,
  doorsInChunk,
  visibleChunkIndices,
  nearestDoor,
} from "@/lib/game/hotel";
import { WORLD_SEED, deriveSubSeed, createRng } from "@/lib/game/seed";

/** Deterministic slice ids from the real seed module — same ids every run. */
function makeSliceIds(count: number): string[] {
  const rng = createRng(
    deriveSubSeed(WORLD_SEED, "hotel-layout-test", "layout"),
  );
  return Array.from(
    { length: count },
    (_, i) => `slice-${i}-${Math.floor(rng() * 1e9).toString(36)}`,
  );
}

describe("layout constants", () => {
  it("pins the grid the whole suite and the game derive from", () => {
    expect(DOOR_SPACING).toBe(6);
    expect(CORRIDOR_WIDTH).toBe(10);
    expect(WALL_HEIGHT).toBe(4.0);
    expect(CHUNK_DOORS).toBe(4);
    expect(CHUNK_LENGTH).toBe(24);
    expect(LOBBY_LENGTH).toBe(14);
  });
});

describe("doorPosition", () => {
  it("places past door 0 on the north wall at x = -3, z = +3", () => {
    expect(doorPosition(0, "north")).toEqual({ x: -3, z: 5 });
  });

  it("mirrors z across the corridor: south is the negative wall", () => {
    expect(doorPosition(0, "south")).toEqual({ x: -3, z: -5 });
  });

  it("moves further into the past as the index grows", () => {
    expect(doorPosition(1, "north")).toEqual({ x: -9, z: 5 });
    expect(doorPosition(3, "north").x).toBe(-21);
    expect(doorPosition(4, "north").x).toBeLessThan(-21);
  });

  it("addresses future doors with negative indices (-1 is future door 0)", () => {
    expect(doorPosition(-1, "north")).toEqual({
      x: LOBBY_LENGTH + 0.5 * DOOR_SPACING,
      z: 5,
    });
    expect(doorPosition(-2, "south")).toEqual({
      x: LOBBY_LENGTH + 1.5 * DOOR_SPACING,
      z: -5,
    });
  });
});

describe("chunkIndexForX", () => {
  it("maps the chunk-0 window (-24, 0] to chunk 0", () => {
    expect(chunkIndexForX(-0.01)).toBe(0);
    expect(chunkIndexForX(-23.99)).toBe(0);
    expect(chunkIndexForX(0)).toBe(0);
  });

  it("gives the far boundary to the deeper chunk (ceil convention)", () => {
    expect(chunkIndexForX(-24)).toBe(-1);
    expect(chunkIndexForX(-48)).toBe(-2);
  });

  it("keeps the lobby in chunk 0 (documented decision)", () => {
    expect(chunkIndexForX(5)).toBe(0);
    expect(chunkIndexForX(LOBBY_LENGTH)).toBe(0);
  });

  it("starts the future grid just past the lobby", () => {
    expect(chunkIndexForX(LOBBY_LENGTH + 0.01)).toBe(1);
    expect(chunkIndexForX(LOBBY_LENGTH + CHUNK_LENGTH)).toBe(1);
    expect(chunkIndexForX(LOBBY_LENGTH + CHUNK_LENGTH + 0.01)).toBe(2);
  });
});

describe("chunkBounds", () => {
  it("spans chunk 0 over the nearest past bays plus the lobby", () => {
    expect(chunkBounds(0)).toEqual({ index: 0, xStart: -24, xEnd: 14 });
  });

  it("spans past and future chunks by CHUNK_LENGTH", () => {
    expect(chunkBounds(-1)).toEqual({ index: -1, xStart: -48, xEnd: -24 });
    expect(chunkBounds(1)).toEqual({ index: 1, xStart: 14, xEnd: 38 });
    expect(chunkBounds(2)).toEqual({ index: 2, xStart: 38, xEnd: 62 });
  });

  it("agrees with chunkIndexForX on every interior point", () => {
    for (const index of [-3, -2, -1, 0, 1, 2, 3]) {
      const { xStart, xEnd } = chunkBounds(index);
      for (const f of [0.25, 0.5, 0.75]) {
        expect(chunkIndexForX(xStart + (xEnd - xStart) * f)).toBe(index);
      }
    }
  });
});

describe("doorsInChunk", () => {
  it("materializes 8 doors for a full chunk, pairing sliceIds as documented", () => {
    const ids = ["a", "b", "c", "d", "e", "f", "g", "h"];
    // Chunk 0 holds past door indices 0..3. Bay k: north = sliceIds[2k]
    // at (−(k+0.5)·6, +5), south = sliceIds[2k+1] at the same x, z = −5 —
    // north first, then south, bays ascending.
    expect(doorsInChunk(0, ids)).toEqual([
      { sliceId: "a", index: 0, side: "north", x: -3, z: 5 },
      { sliceId: "b", index: 0, side: "south", x: -3, z: -5 },
      { sliceId: "c", index: 1, side: "north", x: -9, z: 5 },
      { sliceId: "d", index: 1, side: "south", x: -9, z: -5 },
      { sliceId: "e", index: 2, side: "north", x: -15, z: 5 },
      { sliceId: "f", index: 2, side: "south", x: -15, z: -5 },
      { sliceId: "g", index: 3, side: "north", x: -21, z: 5 },
      { sliceId: "h", index: 3, side: "south", x: -21, z: -5 },
    ]);
  });

  it("counts door indices from the lobby outward for deeper chunks", () => {
    const ids = makeSliceIds(16);
    // Chunk -1 holds past door indices 4..7 → sliceIds[8..15].
    const doors = doorsInChunk(-1, ids);
    expect(doors).toHaveLength(8);
    expect(doors[0]).toEqual({
      sliceId: ids[8],
      index: 4,
      side: "north",
      x: -27,
      z: 5,
    });
    expect(doors[1]).toEqual({
      sliceId: ids[9],
      index: 4,
      side: "south",
      x: -27,
      z: -5,
    });
    expect(doors[6]).toEqual({
      sliceId: ids[14],
      index: 7,
      side: "north",
      x: -45,
      z: 5,
    });
    expect(doors[7]).toEqual({
      sliceId: ids[15],
      index: 7,
      side: "south",
      x: -45,
      z: -5,
    });
  });

  it("skips doors whose slice has not been allocated yet", () => {
    // Only three slices allocated: north 0, south 0, north 1 exist.
    expect(doorsInChunk(0, ["a", "b", "c"])).toEqual([
      { sliceId: "a", index: 0, side: "north", x: -3, z: 5 },
      { sliceId: "b", index: 0, side: "south", x: -3, z: -5 },
      { sliceId: "c", index: 1, side: "north", x: -9, z: 5 },
    ]);
  });

  it("materializes no future doors in v1 (no future slices allocated)", () => {
    expect(doorsInChunk(1, makeSliceIds(32))).toEqual([]);
  });
});

describe("visibleChunkIndices", () => {
  it("centers the window on the player's chunk, future-ward first", () => {
    expect(visibleChunkIndices(0)).toEqual([1, 0, -1]);
  });

  it("centers on chunk -1 at x = -30", () => {
    expect(visibleChunkIndices(-30)).toEqual([0, -1, -2]);
  });

  it("grows with radius", () => {
    expect(visibleChunkIndices(0, 2)).toEqual([2, 1, 0, -1, -2]);
    expect(visibleChunkIndices(-30, 0)).toEqual([-1]);
  });
});

describe("nearestDoor", () => {
  it("returns the door in front of the player within maxDist", () => {
    const ids = makeSliceIds(16);
    const door = nearestDoor(-3.4, 4.9, ids);
    expect(door).not.toBeNull();
    expect(door!.index).toBe(0);
    expect(door!.side).toBe("north");
    expect(door!.sliceId).toBe(ids[0]);
  });

  it("finds south-wall doors too", () => {
    const ids = makeSliceIds(16);
    const door = nearestDoor(-3, -3.5, ids);
    expect(door).not.toBeNull();
    expect(door!.side).toBe("south");
    expect(door!.sliceId).toBe(ids[1]);
  });

  it("returns null when the nearest door is beyond maxDist", () => {
    const ids = makeSliceIds(16);
    // Mid-corridor: 5 m from either wall, past the 1.6 m default.
    expect(nearestDoor(-3, 0, ids)).toBeNull();
    expect(nearestDoor(-3, 0, ids, 2.9)).toBeNull();
  });

  it("treats maxDist as inclusive", () => {
    const ids = makeSliceIds(16);
    // Exactly 2.0 m from door 0 on the north wall (walls at z = ±5).
    expect(nearestDoor(-3, 3, ids, 2)).not.toBeNull();
  });

  it("resolves exact ties to the earliest door in scan order (north first)", () => {
    const ids = makeSliceIds(16);
    // Equidistant from north 0 and south 0 at z = 0.
    const door = nearestDoor(-3, 0, ids, 5.2);
    expect(door).not.toBeNull();
    expect(door!.side).toBe("north");
  });

  it("finds doors across a chunk boundary", () => {
    const ids = makeSliceIds(16);
    // Player just inside chunk -1, within range of its nearest door (-27).
    const door = nearestDoor(-25.5, 4.9, ids);
    expect(door).not.toBeNull();
    expect(door!.index).toBe(4);
    expect(door!.sliceId).toBe(ids[8]);
  });

  it("returns null inside the lobby, far from any materialized door", () => {
    expect(nearestDoor(5, 0, makeSliceIds(16))).toBeNull();
  });

  it("never returns a door without an allocated slice", () => {
    const ids = makeSliceIds(4); // only door indices 0 and 1 allocated
    const nearUnallocated = nearestDoor(-9.5, 4.9, ids);
    const allocated = nearUnallocated as DoorRef | null;
    expect(allocated === null || allocated.index <= 1).toBe(true);
  });
});
