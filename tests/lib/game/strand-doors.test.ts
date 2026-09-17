/**
 * Tests for the strand-door resolution layer (src/lib/game/strand-doors.ts) —
 * the B.11 contract in v0.11-hotel-rooms, hotel-ified (HD4), plus the B.14
 * 用户定稿 (2026-09-18) destination dedupe extended to the two-stage merge.
 * These lock down what the room lane and the integrator build against:
 * a lit door's destination is a HOTEL — the destination slice's own strand
 * at the window holding that slice (`{timelineId, windowIndex, sliceId}`);
 * lit doors sharing a destination slice merge into ONE door (stage 1,
 * unchanged), groups sharing a destination hotel merge again (stage 2 —
 * unreachable from one room today, kept as the contract's safety net);
 * unlit doors never merge; a lit FORWARD door resolves whenever the strand
 * has a next slice (HD4 dropped B.11's out-of-window rule — the
 * destination's own hotel always exists), a lit BACKWARD door when the
 * thread has no next slice but a previous one (B.8 用户定稿 2026-09-18);
 * unlit is exactly one case left: the just-begun, single-slice thread.
 *
 * The final describe block is a real-data pass over the repo's own
 * `memory/episodic/strands.json` + `timeline/index.json`: it asserts the map
 * resolves against the corridor window and PRINTS the door-count numbers
 * before → after the dedupe (how many doors a room gets, the busiest
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
  strandAccentFor,
  CORE_TIMELINE_ID,
  type RoomDoorMap,
  type StrandDoorLabelQuery,
} from "@/lib/game/strand-doors";
import { WINDOW_SLICES } from "@/lib/game/hotel";
import { PALETTES, VIVID_PALETTES } from "@/lib/game/space-types";

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
    // keys are destination-HOTEL-derived (HD4), unlit keys stay strand
    // names. 家庭's next slice is outside the corridor window — lit all
    // the same (HD4: its own hotel exists).
    expect(map.get("2026-06-22-0900")).toEqual([
      {
        key: "to:工作:0",
        label: "forward:工作@2026-06-22-1400#0",
        lit: true,
        destination: {
          timelineId: "工作",
          windowIndex: 0,
          sliceId: "2026-06-22-1400",
        },
        strands: ["工作"],
      },
      {
        key: "to:家庭:0",
        label: "forward:家庭@2026-10-01-1200#101",
        lit: true,
        destination: {
          timelineId: "家庭",
          windowIndex: 0,
          sliceId: "2026-10-01-1200",
        },
        strands: ["家庭"],
      },
      {
        key: "跑步",
        label: "跑步",
        lit: false,
        destination: null,
        strands: ["跑步"],
      },
    ]);
  });

  it("turns a thread's end into a LIT backward door (B.8 用户定稿 2026-09-18)", () => {
    // 工作 ends at 2026-09-15-0746 — no next slice, but a previous one
    // (2026-06-22-1400): the door leads BACK along the same thread,
    // labeled with direction "backward" and a NEGATIVE gap.
    expect(map.get("2026-09-15-0746")).toEqual([
      {
        key: "to:工作:0",
        label: "backward:工作@2026-06-22-1400#-84",
        lit: true,
        destination: {
          timelineId: "工作",
          windowIndex: 0,
          sliceId: "2026-06-22-1400",
        },
        strands: ["工作"],
      },
    ]);
  });

  it("keeps a single-slice strand (neither next nor previous) unlit — B.4's not-written-yet door", () => {
    // 跑步's only position is 2026-06-22-0900: no direction exists. This is
    // the ONLY unlit case left (HD4).
    const door = map.get("2026-06-22-0900")!.find((d) => d.key === "跑步")!;
    expect(door).toEqual({
      key: "跑步",
      label: "跑步",
      lit: false,
      destination: null,
      strands: ["跑步"],
    });
  });

  it("lights a destination outside the corridor window — its own hotel exists (HD4)", () => {
    // 家庭's next slice (2026-10-01-1200) is not in SLICE_IDS. B.11's
    // boundary rule is gone: the door is lit and leads to 家庭's own
    // timeline, window 0 (a 2-slice strand fits one window).
    const door = map.get("2026-06-22-0900")!.find((d) => d.key === "to:家庭:0")!;
    expect(door.lit).toBe(true);
    expect(door.destination).toEqual({
      timelineId: "家庭",
      windowIndex: 0,
      sliceId: "2026-10-01-1200",
    });
  });

  it("lights the backward door even when the previous slice is outside the window (HD4)", () => {
    // Same rule on the fallback direction: 远方's previous slice
    // (2026-05-01-0900) is not rendered, but its hotel is derivable.
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
        key: "to:远方:0",
        label: "backward:远方@2026-05-01-0900#-136",
        lit: true,
        destination: {
          timelineId: "远方",
          windowIndex: 0,
          sliceId: "2026-05-01-0900",
        },
        strands: ["远方"],
      },
    ]);
  });

  it("computes the destination WINDOW from the strand's own timeline (HD4)", () => {
    // A 10-slice strand spans two windows (WINDOW_SLICES per window). The
    // destination's flat index in the newest-first door list is
    // path.length − 1 − i, so the strand's OLDEST slice lands in window 1.
    const positions = Array.from(
      { length: 10 },
      (_, k) => `2026/01/${String(k + 1).padStart(2, "0")}/0900`,
    );
    const g = buildStrandGraph({ 长途: positions });
    const m = buildRoomDoorMap({
      graph: g,
      sliceIds: ["2026-01-10-0900"],
      label: testLabel,
    });
    // From the newest slice the thread ends → backward fallback to
    // 2026-01-09-0900 (flat index 1 → window 0).
    const door = m.get("2026-01-10-0900")![0];
    expect(door.destination).toEqual({
      timelineId: "长途",
      windowIndex: 0,
      sliceId: "2026-01-09-0900",
    });
    // From the OLDEST slice the forward destination is the second-oldest
    // (flat index 8 → window 1).
    const m2 = buildRoomDoorMap({
      graph: g,
      sliceIds: ["2026-01-01-0900"],
      label: testLabel,
    });
    expect(m2.get("2026-01-01-0900")![0].destination).toEqual({
      timelineId: "长途",
      windowIndex: 1,
      sliceId: "2026-01-02-0900",
    });
    // Sanity: flat 8 really is window 1 under the hotel's own rule.
    expect(Math.floor(8 / WINDOW_SLICES)).toBe(1);
  });

  it("never emits more doors than strands, and never drops an unlit one", () => {
    for (const sliceId of SLICE_IDS) {
      const doors = map.get(sliceId)!;
      const strandCount = strandDoorsForSlice(graph, sliceId).length;
      expect(doors.length).toBeLessThanOrEqual(strandCount);
      // Every unlit strand keeps its own door (the merge is lit-only).
      expect(doors.filter((d) => !d.lit).length).toBe(
        doors.filter((d) => d.destination === null).length,
      );
      // Every strand in the room appears in exactly one door's group.
      expect(doors.flatMap((d) => d.strands).sort()).toEqual(
        strandDoorsForSlice(graph, sliceId)
          .map((d) => d.strand)
          .sort(),
      );
    }
  });

  it("points the destination at the exact slice on the strand's own path", () => {
    // 工作's door at 0900 leads to 1400 — the next position on 工作's path.
    const door = map.get("2026-06-22-0900")![0];
    expect(door.destination!.sliceId).toBe("2026-06-22-1400");
    expect(door.destination!.timelineId).toBe("工作");
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
      "forward:家庭@2026-10-01-1200#101", // from 2026-06-22-0900 (lit — HD4)
    ]);
  });

  it("passes the destination hotel to the label callback (additive, HD4)", () => {
    const seen: StrandDoorLabelQuery[] = [];
    buildRoomDoorMap({
      graph,
      sliceIds: SLICE_IDS,
      label: (d) => {
        seen.push(d);
        return "x";
      },
    });
    const q = seen.find((d) => d.destinationSliceId === "2026-10-01-1200")!;
    expect(q.destination).toEqual({
      timelineId: "家庭",
      windowIndex: 0,
      sliceId: "2026-10-01-1200",
    });
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
    expect(doors.map((d) => d.key)).toEqual(["to:alpha:0", "to:zeta:0"]);
  });
});

describe("two-stage destination dedupe (B.14 用户定稿 2026-09-18, HD4)", () => {
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

  it("collapses two strands with the same destination slice into ONE door (stage 1)", () => {
    const m = buildRoomDoorMap({
      graph: buildStrandGraph(MERGED_ENTRIES),
      sliceIds: MERGED_SLICES,
      label: testLabel,
    });
    const doors = m.get("2026-06-22-0900")!;
    // Three strands, two destinations → two doors. Activity is tied
    // (2 positions each), so the code-unit name tiebreak orders alpha
    // first; its group claims position 0 and the door's hotel is alpha's.
    expect(doors).toEqual([
      {
        key: "to:alpha:0",
        label: "forward:alpha@2026-09-15-0746#84",
        lit: true,
        destination: {
          timelineId: "alpha",
          windowIndex: 0,
          sliceId: "2026-09-15-0746",
        },
        strands: ["alpha", "beta"],
      },
      {
        key: "to:solo:0",
        label: "forward:solo@2026-07-01-1200#9",
        lit: true,
        destination: {
          timelineId: "solo",
          windowIndex: 0,
          sliceId: "2026-07-01-1200",
        },
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
    expect(merged.destination.timelineId).toBe("alpha");
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
    expect(doors[0].key).toBe("to:busy:0");
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
        key: "to:alpha:0",
        label: "backward:alpha@2026-06-01-0600#-21",
        lit: true,
        destination: {
          timelineId: "alpha",
          windowIndex: 0,
          sliceId: "2026-06-01-0600",
        },
        strands: ["alpha", "beta"],
      },
    ]);
  });

  it("never merges unlit doors — not with lit ones, not with each other", () => {
    const g = buildStrandGraph({
      lit: ["2026/06/22/0900", "2026/09/15/0746"],
      begun: ["2026/06/22/0900"], // only position: unlit
      faraway: ["2026/06/22/0900", "2027/01/01/0000"], // far ahead: lit (HD4)
    });
    const doors = buildRoomDoorMap({
      graph: g,
      sliceIds: ["2026-09-15-0746", "2026-06-22-0900"],
      label: testLabel,
    }).get("2026-06-22-0900")!;
    // lit and faraway tie on activity (2 positions): code-unit name order
    // faraway < lit; begun (1 position) last. All three strands present.
    expect(doors.map((d) => d.strands)).toEqual([
      ["faraway"],
      ["lit"],
      ["begun"],
    ]);
    expect(doors.filter((d) => !d.lit).map((d) => d.key)).toEqual(["begun"]);
    expect(doors.find((d) => d.key === "to:lit:0")!.strands).toEqual(["lit"]);
  });
});

describe("strandAccentFor / CORE_TIMELINE_ID (§11.1)", () => {
  const accents = [...PALETTES, ...VIVID_PALETTES].map((p) => p.accent);

  it("picks one of the 15 palette accents, deterministically per strand", () => {
    for (const name of ["工作", "家庭", "Kafka", "alpha"]) {
      expect(accents).toContain(strandAccentFor(name));
      expect(strandAccentFor(name)).toBe(strandAccentFor(name));
    }
  });

  it("names the core timeline 'core'", () => {
    expect(CORE_TIMELINE_ID).toBe("core");
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

  it("resolves against the corridor window and prints the door numbers (before → after dedupe)", () => {
    let roomsWithDoors = 0;
    let litForward = 0;
    let litBackward = 0;
    let unlit = 0;
    let mergedDoors = 0; // doors representing 2+ strands
    let strandsMerged = 0; // strand-doors absorbed into a group
    const doorCounts: number[] = [];
    const beforeCounts: number[] = [];

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
          const destination = door.destination!;
          // The destination slice id round-trips through the label query,
          // and the key is derived from the destination HOTEL.
          expect(destination.sliceId).toBeDefined();
          expect(door.key).toBe(
            `to:${destination.timelineId}:${destination.windowIndex}`,
          );
          expect(destination.timelineId).toBe(door.strands[0]);
          // The window must be exactly the one holding the destination on
          // the strand's own newest-first timeline.
          const destIndex = path.indexOf(destination.sliceId);
          expect(destIndex).toBeGreaterThanOrEqual(0);
          expect(destination.windowIndex).toBe(
            Math.floor((path.length - 1 - destIndex) / WINDOW_SLICES),
          );
          if (next !== undefined && destination.sliceId === next) {
            litForward += 1;
          } else {
            // A backward door must point EXACTLY at the previous slice.
            expect(prev).toBeDefined();
            expect(destination.sliceId).toBe(prev);
            litBackward += 1;
          }
        } else {
          unlit += 1;
          expect(door.destination).toBeNull();
          expect(door.strands).toEqual([door.strands[0]]);
          expect(door.key).toBe(door.strands[0]);
          // HD4: the ONLY unlit case left is the just-begun thread.
          expect(next).toBeUndefined();
          expect(prev).toBeUndefined();
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
        `  litForward=${litForward} litBackward=${litBackward} unlit=${unlit}`,
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
