/**
 * Tests for the strand-door resolution layer (src/lib/game/strand-doors.ts) —
 * the first third of the B.11 contract in v0.11-hotel-rooms, plus the B.14
 * 用户定稿 (2026-09-18) destination dedupe. These lock down what the room
 * lane and the door-manager lane build against: lit doors sharing a
 * destination slice merge into ONE door (unlit doors never merge — no
 * destination to share), the merged door keeps its most-active member's
 * position (inherited order, A6), its key is destination-derived and stable,
 * a lit FORWARD door resolves when the strand's next slice is inside the
 * window, a lit BACKWARD door when the thread has no further active slice
 * but a previous one exists inside the window (B.8 用户定稿 2026-09-18 —
 * the fallback replaces the unlit door, never adds a second), unlit doors
 * stay in the list with `destinationIndex: null` (single-slice thread's
 * beginning AND out-of-window destination, either direction), and
 * `destinationIndex` is the EXACT index into the corridor's newest-first
 * slice list.
 *
 * The final describe block is a real-data pass over the repo's own
 * `memory/episodic/strands.json` + `timeline/index.json`: it asserts the map
 * resolves against the corridor window and PRINTS the door-count numbers
 * before → after the B.14 dedupe (how many doors a room gets, the busiest
 * room, the totals) — coordination data, not just assertions.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import {
  buildStrandGraph,
  strandDoorsForSlice,
  type RawStrandEntries,
} from "@/lib/game/strand-graph";
import {
  buildRoomDoorMap,
  type RoomDoorMap,
  type StrandDoorLabelQuery,
} from "@/lib/game/strand-doors";

/** A label callback that just records its arguments — assertions read them back. */
const testLabel = (d: StrandDoorLabelQuery) =>
  `${d.direction}:${d.strand}@${d.destinationSliceId}#${d.gapDays}`;

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
    // No two lit doors share a destination here, so nothing merges; lit
    // keys are destination-derived (B.14), unlit keys stay strand names.
    expect(map.get("2026-06-22-0900")).toEqual([
      {
        key: "to:2026-06-22-1400",
        label: "forward:工作@2026-06-22-1400#0",
        lit: true,
        destinationIndex: 1,
        strands: ["工作"],
      },
      {
        key: "家庭",
        label: "家庭",
        lit: false,
        destinationIndex: null,
        strands: ["家庭"],
      },
      {
        key: "跑步",
        label: "跑步",
        lit: false,
        destinationIndex: null,
        strands: ["跑步"],
      },
    ]);
  });

  it("turns a thread's end into a LIT backward door (B.8 用户定稿 2026-09-18)", () => {
    // 工作 ends at 2026-09-15-0746 — no next slice, but a previous one
    // (2026-06-22-1400) inside the window: the door now leads BACK along
    // the same thread, labeled with direction "backward" and a NEGATIVE gap.
    expect(map.get("2026-09-15-0746")).toEqual([
      {
        key: "to:2026-06-22-1400",
        label: "backward:工作@2026-06-22-1400#-84",
        lit: true,
        destinationIndex: 1,
        strands: ["工作"],
      },
    ]);
    expect(SLICE_IDS[map.get("2026-09-15-0746")![0].destinationIndex!]).toBe(
      "2026-06-22-1400",
    );
  });

  it("keeps a single-slice strand (neither next nor previous) unlit — B.4's not-written-yet door", () => {
    // 跑步's only position is 2026-06-22-0900: no direction is walkable.
    const door = map.get("2026-06-22-0900")!.find((d) => d.key === "跑步")!;
    expect(door).toEqual({
      key: "跑步",
      label: "跑步",
      lit: false,
      destinationIndex: null,
      strands: ["跑步"],
    });
  });

  it("marks a destination outside the corridor window unlit (B.11 boundary rule)", () => {
    // 家庭's next slice (2026-10-01-1200) is not in SLICE_IDS. The backward
    // fallback must NOT fire here: a forward destination exists, it is just
    // outside the rendered window.
    const door = map.get("2026-06-22-0900")!.find((d) => d.key === "家庭")!;
    expect(door.lit).toBe(false);
    expect(door.destinationIndex).toBeNull();
  });

  it("keeps the door unlit when the BACKWARD destination is outside the window", () => {
    // The boundary rule applies to the fallback too: 远方's previous slice
    // (2026-05-01-0900) is not rendered, so the door stays dark.
    const g = buildStrandGraph({
      远方: ["2026/05/01/0900", "2026/09/15/0746"],
    });
    const m = buildRoomDoorMap({
      graph: g,
      sliceIds: ["2026-09-15-0746"],
      label: testLabel,
    });
    expect(m.get("2026-09-15-0746")).toEqual([
      {
        key: "远方",
        label: "远方",
        lit: false,
        destinationIndex: null,
        strands: ["远方"],
      },
    ]);
  });

  it("never emits more doors than strands, and never drops an unlit one", () => {
    for (const sliceId of SLICE_IDS) {
      const doors = map.get(sliceId)!;
      const strandCount = strandDoorsForSlice(graph, sliceId).length;
      expect(doors.length).toBeLessThanOrEqual(strandCount);
      // Every unlit strand keeps its own door (B.14 merges lit doors only).
      expect(doors.filter((d) => !d.lit).length).toBe(
        doors.filter((d) => d.destinationIndex === null).length,
      );
      // Every strand in the room appears in exactly one door's group.
      expect(doors.flatMap((d) => d.strands).sort()).toEqual(
        strandDoorsForSlice(graph, sliceId)
          .map((d) => d.strand)
          .sort(),
      );
    }
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
        calls.push(
          `${d.direction}:${d.strand}@${d.destinationSliceId}#${d.gapDays}`,
        );
        return "x";
      },
    });
    expect(calls).toEqual([
      "backward:工作@2026-06-22-1400#-84", // from 2026-09-15-0746 (window order: newest first)
      "forward:工作@2026-09-15-0746#84", // from 2026-06-22-1400
      "forward:工作@2026-06-22-1400#0", // from 2026-06-22-0900
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
    // tiebreak, not insertion order. Distinct destinations, so nothing
    // merges and the tiebreak is directly visible in the keys.
    const tied = buildStrandGraph({
      zeta: ["2026/06/22/0900", "2026/06/22/1400"],
      alpha: ["2026/06/22/0900", "2026/06/22/1600"],
    });
    const doors = buildRoomDoorMap({
      graph: tied,
      sliceIds: ["2026-06-22-1600", "2026-06-22-1400", "2026-06-22-0900"],
      label: testLabel,
    }).get("2026-06-22-0900")!;
    expect(doors.map((d) => d.strands[0])).toEqual(["alpha", "zeta"]);
    expect(doors.map((d) => d.key)).toEqual([
      "to:2026-06-22-1600",
      "to:2026-06-22-1400",
    ]);
  });
});

describe("B.14 destination dedupe (按目的地去重, 用户定稿 2026-09-18)", () => {
  // alpha and beta both lead forward to the SAME slice from 0900.
  const MERGED_ENTRIES: RawStrandEntries = {
    beta: ["2026/06/22/0900", "2026/09/15/0746"],
    alpha: ["2026/06/22/0900", "2026/09/15/0746"],
    solo: ["2026/06/22/0900", "2026/07/01/1200"],
  };
  const MERGED_SLICES = [
    "2026-09-15-0746",
    "2026-07-01-1200",
    "2026-06-22-0900",
  ] as const;

  it("collapses two strands with the same destination into ONE door", () => {
    const m = buildRoomDoorMap({
      graph: buildStrandGraph(MERGED_ENTRIES),
      sliceIds: MERGED_SLICES,
      label: testLabel,
    });
    const doors = m.get("2026-06-22-0900")!;
    // Three strands, two destinations → two doors. Activity is tied
    // (2 positions each), so the code-unit name tiebreak orders alpha
    // first; its group claims position 0.
    expect(doors).toEqual([
      {
        key: "to:2026-09-15-0746",
        label: "forward:alpha@2026-09-15-0746#84",
        lit: true,
        destinationIndex: 0,
        strands: ["alpha", "beta"],
      },
      {
        key: "to:2026-07-01-1200",
        label: "forward:solo@2026-07-01-1200#9",
        lit: true,
        destinationIndex: 1,
        strands: ["solo"],
      },
    ]);
  });

  it("gives the merged door a key that is stable across builds and unique in the room", () => {
    const args = {
      sliceIds: MERGED_SLICES,
      label: testLabel,
    } as const;
    const a = buildRoomDoorMap({
      graph: buildStrandGraph(MERGED_ENTRIES),
      ...args,
    });
    const b = buildRoomDoorMap({
      graph: buildStrandGraph(
        Object.fromEntries([...Object.entries(MERGED_ENTRIES)].reverse()),
      ),
      ...args,
    });
    expect([...b]).toEqual([...a]);
    for (const doors of a.values()) {
      const keys = doors.map((d) => d.key);
      expect(new Set(keys).size).toBe(keys.length);
    }
  });

  it("lets the label callback see the whole group (additive payload)", () => {
    const seen: StrandDoorLabelQuery[] = [];
    buildRoomDoorMap({
      graph: buildStrandGraph(MERGED_ENTRIES),
      sliceIds: MERGED_SLICES,
      label: (d) => {
        seen.push(d);
        return "x";
      },
    });
    const merged = seen.find((d) => d.destinationSliceId === "2026-09-15-0746")!;
    expect(merged.strand).toBe("alpha"); // primary
    expect(merged.strands).toEqual(["alpha", "beta"]);
    expect(merged.direction).toBe("forward");
  });

  it("keeps the group's position at its most-active member's place (A6)", () => {
    // busy is the most active strand (3 positions) but shares its
    // destination with quiet (1 position). quiet alone would sit AFTER
    // mid; merged into busy's group, the shared door takes position 0.
    const g = buildStrandGraph({
      quiet: ["2026/06/22/0900", "2026/09/15/0746"],
      mid: ["2026/06/22/0900", "2026/07/01/1200", "2026/08/01/1200"],
      busy: [
        "2026/06/22/0900",
        "2026/09/15/0746",
        "2026/09/16/0900",
        "2026/09/17/0900",
      ],
    });
    const doors = buildRoomDoorMap({
      graph: g,
      sliceIds: [
        "2026-09-17-0900",
        "2026-09-16-0900",
        "2026-09-15-0746",
        "2026-08-01-1200",
        "2026-07-01-1200",
        "2026-06-22-0900",
      ],
      label: testLabel,
    }).get("2026-06-22-0900")!;
    expect(doors.map((d) => d.strands)).toEqual([
      ["busy", "quiet"], // the merged door inherits busy's position 0
      ["mid"],
    ]);
    expect(doors[0].key).toBe("to:2026-09-15-0746");
  });

  it("merges a backward fallback group on the same destination", () => {
    // Two strands both END at 0900 with the same previous slice 0600:
    // both fall back BACKWARD to it (B.8) — one merged backward door.
    const g = buildStrandGraph({
      beta: ["2026/06/01/0600", "2026/06/22/0900"],
      alpha: ["2026/06/01/0600", "2026/06/22/0900"],
    });
    const doors = buildRoomDoorMap({
      graph: g,
      sliceIds: ["2026-06-22-0900", "2026-06-01-0600"],
      label: testLabel,
    }).get("2026-06-22-0900")!;
    expect(doors).toEqual([
      {
        key: "to:2026-06-01-0600",
        label: "backward:alpha@2026-06-01-0600#-21",
        lit: true,
        destinationIndex: 1,
        strands: ["alpha", "beta"],
      },
    ]);
  });

  it("never merges unlit doors — not with lit ones, not with each other", () => {
    const g = buildStrandGraph({
      lit: ["2026/06/22/0900", "2026/09/15/0746"],
      begun: ["2026/06/22/0900"], // only position: unlit
      outside: ["2026/06/22/0900", "2027/01/01/0000"], // next out of window: unlit
    });
    const doors = buildRoomDoorMap({
      graph: g,
      sliceIds: ["2026-09-15-0746", "2026-06-22-0900"],
      label: testLabel,
    }).get("2026-06-22-0900")!;
    // outside (3... 2 positions) ties with lit (2 positions): name order
    // lit < outside; begun (1 position) last. All three strands present.
    expect(doors.map((d) => d.strands)).toEqual([
      ["lit"],
      ["outside"],
      ["begun"],
    ]);
    expect(doors.filter((d) => !d.lit).map((d) => d.key)).toEqual([
      "outside",
      "begun",
    ]);
    expect(doors.find((d) => d.key === "to:2026-09-15-0746")!.strands).toEqual(
      ["lit"],
    );
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

  const graph = buildStrandGraph(strands);
  const map: RoomDoorMap = buildRoomDoorMap({
    graph,
    sliceIds,
    label: testLabel,
  });

  it("resolves against the corridor window and prints the door numbers (before → after B.14)", () => {
    let roomsWithDoors = 0;
    let litForward = 0;
    let litBackward = 0;
    let unlit = 0;
    let unlitOnlyPosition = 0;
    let unlitOutOfWindow = 0;
    let mergedDoors = 0; // doors representing 2+ strands
    let strandsMerged = 0; // strand-doors absorbed into a group
    const doorCounts: number[] = [];
    const beforeCounts: number[] = [];
    const inWindow = new Set(sliceIds);

    for (const [sliceId, doors] of map) {
      // Before-dedupe count: one door per strand (what B.11 alone gave).
      const before = strandDoorsForSlice(graph, sliceId).length;
      beforeCounts.push(before);
      if (doors.length === 0) continue;
      roomsWithDoors += 1;
      doorCounts.push(doors.length);
      for (const door of doors) {
        if (door.strands.length > 1) {
          mergedDoors += 1;
          strandsMerged += door.strands.length - 1;
        }
        // Re-derive the PRIMARY strand's path position to classify the
        // door (all group members share the destination, so the primary
        // classifies the whole door).
        const path = graph.paths.get(door.strands[0])!;
        const i = path.indexOf(sliceId);
        const next = path[i + 1] as string | undefined;
        const prev = i > 0 ? path[i - 1] : undefined;
        if (door.lit) {
          const destination = sliceIds[door.destinationIndex!];
          // The index must land exactly on a slice whose id round-trips,
          // and the key must be derived from that same destination.
          expect(destination).toBeDefined();
          expect(door.key).toBe(`to:${destination}`);
          expect(typeof door.destinationIndex).toBe("number");
          if (next !== undefined && destination === next) {
            litForward += 1;
          } else {
            // A backward door must point EXACTLY at the previous slice.
            expect(prev).toBeDefined();
            expect(destination).toBe(prev);
            litBackward += 1;
          }
        } else {
          unlit += 1;
          expect(door.destinationIndex).toBeNull();
          expect(door.strands).toEqual([door.strands[0]]);
          expect(door.key).toBe(door.strands[0]);
          // Classify: a just-begun thread (no previous position) vs a
          // destination (either direction) outside the window.
          if (next === undefined && prev === undefined) {
            unlitOnlyPosition += 1;
          } else if (
            (next !== undefined && !inWindow.has(next)) ||
            (next === undefined && prev !== undefined && !inWindow.has(prev))
          ) {
            unlitOutOfWindow += 1;
          }
        }
      }
    }

    doorCounts.sort((a, b) => a - b);
    beforeCounts.sort((a, b) => a - b);
    const median = doorCounts[Math.floor(doorCounts.length / 2)];
    const beforeMedian = beforeCounts[Math.floor(beforeCounts.length / 2)];
    const totalAfter = doorCounts.reduce((a, b) => a + b, 0);
    const totalBefore = beforeCounts.reduce((a, b) => a + b, 0);

    console.log(
      `[strand-doors real data] window=${sliceIds.length} slices, ` +
        `roomsWithDoors=${roomsWithDoors}\n` +
        `  doors/room BEFORE dedupe: min=${beforeCounts[0]} ` +
        `median=${beforeMedian} max=${beforeCounts[beforeCounts.length - 1]} ` +
        `total=${totalBefore}\n` +
        `  doors/room AFTER  dedupe: min=${doorCounts[0]} median=${median} ` +
        `max=${doorCounts[doorCounts.length - 1]} total=${totalAfter}\n` +
        `  mergedDoors=${mergedDoors} strandsMerged=${strandsMerged} ` +
        `(saved=${totalBefore - totalAfter})\n` +
        `  litForward=${litForward} litBackward=${litBackward} ` +
        `unlit=${unlit} (onlyPosition=${unlitOnlyPosition}, ` +
        `outOfWindow=${unlitOutOfWindow})`,
    );

    expect(roomsWithDoors).toBeGreaterThan(0);
    // The backward fallback must actually fire on the real dataset — the
    // newest rooms were exactly the ones with dark doors.
    expect(litBackward).toBeGreaterThan(0);
    // B.14 is a semantic reduction, not a cap: the after total never
    // exceeds the before total, and the dedupe genuinely fires.
    expect(totalAfter).toBeLessThanOrEqual(totalBefore);
    expect(mergedDoors).toBeGreaterThan(0);
    // Every map key is a window slice, and the map covers the whole window.
    expect(map.size).toBe(sliceIds.length);
  });

  it("is deterministic on the real dataset", () => {
    const again = buildRoomDoorMap({
      graph,
      sliceIds,
      label: testLabel,
    });
    expect([...again]).toEqual([...map]);
  });
});
