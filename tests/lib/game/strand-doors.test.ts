/**
 * Tests for the strand-door resolution layer (src/lib/game/strand-doors.ts) —
 * the first third of the B.11 contract in v0.11-hotel-rooms. These lock down
 * what the room lane and the door-manager lane build against: one door per
 * strand through the slice (no cap), unlit doors stay in the list with
 * `destinationIndex: null` (thread's end AND out-of-window destination),
 * order is inherited from `strandDoorsForSlice` byte-for-byte (axiom A6),
 * and `destinationIndex` is the EXACT index into the corridor's newest-first
 * slice list.
 *
 * The final describe block is a real-data pass over the repo's own
 * `memory/episodic/strands.json` + `timeline/index.json`: it asserts the map
 * resolves against the corridor window and PRINTS the door-count numbers
 * (how many doors a room gets, how many unlit) — coordination data, not
 * just assertions.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import { buildStrandGraph, type RawStrandEntries } from "@/lib/game/strand-graph";
import {
  buildRoomDoorMap,
  type RoomDoorMap,
} from "@/lib/game/strand-doors";

/** A label callback that just records its arguments — assertions read them back. */
const testLabel = (d: {
  strand: string;
  destinationSliceId: string;
  gapDays: number;
}) => `${d.strand}@${d.destinationSliceId}#${d.gapDays}`;

const ENTRIES: RawStrandEntries = {
  工作: ["2026/06/22/1400", "2026/06/22/0900", "2026/06/22/1400", "2026/09/15/0746"],
  家庭: ["2026/06/22/0900", "2026/10/01/1200"],
  跑步: ["2026/06/22/0900"],
};

/** Corridor window, newest first — the order game-shell hands to the canvas. */
const SLICE_IDS = [
  "2026-09-15-0746",
  "2026-06-22-1400",
  "2026-06-22-0900",
] as const;

describe("buildRoomDoorMap", () => {
  const graph = buildStrandGraph(ENTRIES);
  const map = buildRoomDoorMap({ graph, sliceIds: SLICE_IDS, label: testLabel });

  it("resolves one door per strand through the slice, in inherited order", () => {
    expect(map.get("2026-06-22-0900")).toEqual([
      { key: "工作", label: "工作@2026-06-22-1400#0", lit: true, destinationIndex: 1 },
      { key: "家庭", label: "家庭", lit: false, destinationIndex: null },
      { key: "跑步", label: "跑步", lit: false, destinationIndex: null },
    ]);
  });

  it("marks the strand's last position unlit but keeps the door (thread's end, B.4)", () => {
    // 工作 ends at 2026-09-15-0746 — the room still shows the door, unlit.
    expect(map.get("2026-09-15-0746")).toEqual([
      { key: "工作", label: "工作", lit: false, destinationIndex: null },
    ]);
  });

  it("marks a destination outside the corridor window unlit (B.11 boundary rule)", () => {
    // 家庭's next slice (2026-10-01-1200) is not in SLICE_IDS.
    const door = map.get("2026-06-22-0900")!.find((d) => d.key === "家庭")!;
    expect(door.lit).toBe(false);
    expect(door.destinationIndex).toBeNull();
  });

  it("gives the EXACT index of the destination in the newest-first slice list", () => {
    // 工作's door at 0900 points at 1400, which sits at index 1 of SLICE_IDS.
    const door = map.get("2026-06-22-0900")![0];
    expect(SLICE_IDS[door.destinationIndex!]).toBe("2026-06-22-1400");
  });

  it("enters every window slice in the map, even with no strands (empty list)", () => {
    const withGap = buildRoomDoorMap({
      graph,
      sliceIds: [...SLICE_IDS, "2027-01-01-0000"],
      label: testLabel,
    });
    expect(withGap.get("2027-01-01-0000")).toEqual([]);
    expect(withGap.size).toBe(4);
  });

  it("handles empty input — no strands, no slices, both", () => {
    const empty = buildStrandGraph({});
    expect(
      buildRoomDoorMap({ graph: empty, sliceIds: SLICE_IDS, label: testLabel }).get(
        "2026-06-22-0900",
      ),
    ).toEqual([]);
    expect(
      buildRoomDoorMap({ graph, sliceIds: [], label: testLabel }).size,
    ).toBe(0);
    expect(
      buildRoomDoorMap({ graph: empty, sliceIds: [], label: testLabel }).size,
    ).toBe(0);
  });

  it("calls the label callback exactly once per LIT door, never for unlit ones", () => {
    const calls: string[] = [];
    buildRoomDoorMap({
      graph,
      sliceIds: SLICE_IDS,
      label: (d) => {
        calls.push(`${d.strand}@${d.destinationSliceId}#${d.gapDays}`);
        return "x";
      },
    });
    expect(calls).toEqual([
      "工作@2026-09-15-0746#84", // from 2026-06-22-1400 (window order: newest first)
      "工作@2026-06-22-1400#0", // from 2026-06-22-0900
    ]);
  });

  it("is byte-for-byte stable across independent builds (determinism, A6)", () => {
    const again = buildRoomDoorMap({
      graph: buildStrandGraph(
        Object.fromEntries([...Object.entries(ENTRIES)].reverse()),
      ),
      sliceIds: SLICE_IDS,
      label: testLabel,
    });
    expect([...again]).toEqual([...map]);
  });

  it("inherits ordering from strandDoorsForSlice — activity desc, name asc", () => {
    // A tie on activity: door order must follow the graph's code-unit name
    // tiebreak, not insertion order.
    const tied = buildStrandGraph({
      zeta: ["2026/06/22/0900", "2026/06/22/1400"],
      alpha: ["2026/06/22/0900", "2026/06/22/1400"],
    });
    const doors = buildRoomDoorMap({
      graph: tied,
      sliceIds: ["2026-06-22-1400", "2026-06-22-0900"],
      label: testLabel,
    }).get("2026-06-22-0900")!;
    expect(doors.map((d) => d.key)).toEqual(["alpha", "zeta"]);
  });
});

describe("real data pass (memory/episodic)", () => {
  const root = fileURLToPath(new URL("../../../", import.meta.url));
  const strands = JSON.parse(
    readFileSync(`${root}memory/episodic/strands.json`, "utf8"),
  ) as Record<string, string[]>;
  const timeline = JSON.parse(
    readFileSync(`${root}memory/episodic/timeline/index.json`, "utf8"),
  ) as { slices: Array<{ id: string }> };

  // The corridor window exactly as game-shell builds it: catalog oldest→
  // newest, capped to the newest MAX_DOORS, presented reversed.
  const MAX_DOORS = 200;
  const sliceIds = timeline.slices
    .slice(-MAX_DOORS)
    .map((s) => s.id)
    .reverse();

  const map: RoomDoorMap = buildRoomDoorMap({
    graph: buildStrandGraph(strands),
    sliceIds,
    label: testLabel,
  });

  it("resolves against the corridor window and prints the door numbers", () => {
    let roomsWithDoors = 0;
    let lit = 0;
    let unlit = 0;
    let unlitThreadEnd = 0;
    let unlitOutOfWindow = 0;
    const doorCounts: number[] = [];
    const inWindow = new Set(sliceIds);
    const graph = buildStrandGraph(strands);

    for (const [sliceId, doors] of map) {
      if (doors.length === 0) continue;
      roomsWithDoors += 1;
      doorCounts.push(doors.length);
      for (const door of doors) {
        if (door.lit) {
          lit += 1;
          // The index must land exactly on a slice whose id round-trips.
          expect(sliceIds[door.destinationIndex!]).toBeDefined();
          expect(typeof door.destinationIndex).toBe("number");
        } else {
          unlit += 1;
          expect(door.destinationIndex).toBeNull();
          // Classify: thread's end vs out-of-window. Re-derive the raw
          // destination from the graph to tell the two apart.
          const path = graph.paths.get(door.key)!;
          const next = path[path.indexOf(sliceId) + 1] as string | undefined;
          if (next === undefined) unlitThreadEnd += 1;
          else if (!inWindow.has(next)) unlitOutOfWindow += 1;
        }
      }
    }

    doorCounts.sort((a, b) => a - b);
    const median = doorCounts[Math.floor(doorCounts.length / 2)];

    console.log(
      `[strand-doors real data] window=${sliceIds.length} slices, ` +
        `roomsWithDoors=${roomsWithDoors}, ` +
        `doors/room min=${doorCounts[0]} median=${median} ` +
        `max=${doorCounts[doorCounts.length - 1]}, ` +
        `lit=${lit} unlit=${unlit} ` +
        `(threadEnd=${unlitThreadEnd}, outOfWindow=${unlitOutOfWindow})`,
    );

    expect(roomsWithDoors).toBeGreaterThan(0);
    // Every map key is a window slice, and the map covers the whole window.
    expect(map.size).toBe(sliceIds.length);
  });

  it("is deterministic on the real dataset", () => {
    const again = buildRoomDoorMap({
      graph: buildStrandGraph(strands),
      sliceIds,
      label: testLabel,
    });
    expect([...again]).toEqual([...map]);
  });
});
