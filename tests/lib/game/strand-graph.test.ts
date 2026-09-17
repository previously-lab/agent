/**
 * Tests for the strand graph (src/lib/game/strand-graph.ts) — the data
 * foundation for strand doors (v0.11-hotel-rooms 附录 B). These lock down
 * the contract the room builder relies on: positions normalise losslessly,
 * paths are sorted and de-duplicated, neighbour lookup is exact (null = an
 * UNLIT door, never an error), gaps are honest day counts, and the door set
 * for a slice is byte-for-byte stable across builds (axiom A6: the same
 * memory always looks the same).
 *
 * The final describe block is a real-data sanity pass over the repo's own
 * `memory/episodic/strands.json` + `timeline/index.json`: it asserts the
 * graph builds and PRINTS the numbers (strand / position / orphan counts and
 * the gap distribution) — they are coordination data, not just assertions.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import {
  parseStrandPosition,
  sliceIdToPosition,
  sliceIdToMs,
  gapDaysBetween,
  buildStrandGraph,
  nextOnStrand,
  previousOnStrand,
  strandDoorsForSlice,
  type RawStrandEntries,
} from "@/lib/game/strand-graph";

describe("parseStrandPosition", () => {
  it("normalises a slash position into a dash slice id", () => {
    expect(parseStrandPosition("2026/06/22/1400")).toBe("2026-06-22-1400");
    expect(parseStrandPosition("2026/01/05/0007")).toBe("2026-01-05-0007");
  });

  it("returns null for malformed input", () => {
    for (const bad of [
      "",
      "2026-06-22-1400", // already a slice id — wrong format, not accepted
      "2026/06/22", // missing time
      "2026/6/22/1400", // unpadded
      "2026/06/22/140", // short time
      "2026/13/22/1400", // month 13
      "2026/02/30/1400", // Feb 30 doesn't exist
      "2026/06/22/2460", // 24:60 isn't a time
      "not a position",
    ]) {
      expect(parseStrandPosition(bad), JSON.stringify(bad)).toBeNull();
    }
  });
});

describe("sliceIdToPosition", () => {
  it("is the exact inverse of parseStrandPosition", () => {
    expect(sliceIdToPosition("2026-06-22-1400")).toBe("2026/06/22/1400");
    const id = parseStrandPosition("2026/12/31/2359");
    expect(id).not.toBeNull();
    expect(parseStrandPosition(sliceIdToPosition(id!)!)).toBe(id);
  });

  it("returns null for malformed ids", () => {
    expect(sliceIdToPosition("")).toBeNull();
    expect(sliceIdToPosition("2026/06/22/1400")).toBeNull();
    expect(sliceIdToPosition("2026-06-22-1400-extra")).toBeNull();
  });
});

describe("gapDaysBetween", () => {
  it("is 0 within the same day", () => {
    expect(gapDaysBetween("2026-06-22-0900", "2026-06-22-2300")).toBe(0);
  });

  it("counts whole ELAPSED days — crossing midnight isn't a day on its own", () => {
    // 2 hours across midnight: nothing to narrate yet.
    expect(gapDaysBetween("2026-06-22-2300", "2026-06-23-0100")).toBe(0);
    // 25 hours: the thread went quiet for a day.
    expect(gapDaysBetween("2026-06-22-2300", "2026-06-24-0000")).toBe(1);
  });

  it("counts whole days across months", () => {
    expect(gapDaysBetween("2026-06-22-1400", "2026-10-22-1400")).toBe(122);
    // Truncated toward zero: 3 days 23 hours is 3, not 4.
    expect(gapDaysBetween("2026-06-22-1400", "2026-06-26-1300")).toBe(3);
  });

  it("is negative when the second id is earlier", () => {
    expect(gapDaysBetween("2026-06-24-0100", "2026-06-22-2300")).toBe(-1);
  });

  it("returns null for malformed ids", () => {
    expect(gapDaysBetween("nope", "2026-06-22-1400")).toBeNull();
    expect(gapDaysBetween("2026-06-22-1400", "")).toBeNull();
  });
});

const ENTRIES: RawStrandEntries = {
  工作: ["2026/06/22/1400", "2026/06/22/0900", "2026/06/22/1400", "2026/09/15/0746"],
  家庭: ["2026/06/22/0900", "2026/10/01/1200"],
  跑步: ["2026/06/22/0900"],
  坏数据: ["garbage", "2026/13/01/0000"],
};

describe("buildStrandGraph", () => {
  const graph = buildStrandGraph(ENTRIES);

  it("sorts each path chronologically and de-duplicates it", () => {
    expect(graph.paths.get("工作")).toEqual([
      "2026-06-22-0900",
      "2026-06-22-1400",
      "2026-09-15-0746",
    ]);
  });

  it("drops malformed positions, and strands with no valid position at all", () => {
    expect(graph.paths.has("坏数据")).toBe(false);
    expect([...graph.bySlice.keys()]).not.toContain("garbage");
  });

  it("builds the exact reverse index (slice id → strands, door order)", () => {
    expect(graph.bySlice.get("2026-06-22-0900")).toEqual(["工作", "家庭", "跑步"]);
    expect(graph.bySlice.get("2026-06-22-1400")).toEqual(["工作"]);
    expect(graph.bySlice.get("2026-10-01-1200")).toEqual(["家庭"]);
    expect(graph.bySlice.has("2026-01-01-0000")).toBe(false);
  });

  it("reverse index order is activity desc, then name asc", () => {
    // 工作 has 3 positions; 家庭 and 跑步 tie at 1 → name asc (code-unit).
    const tie: RawStrandEntries = { b: ["2026/01/01/0000"], a: ["2026/01/01/0000"] };
    expect(buildStrandGraph(tie).bySlice.get("2026-01-01-0000")).toEqual(["a", "b"]);
  });

  it("is independent of input entry order", () => {
    const shuffled: RawStrandEntries = Object.fromEntries([...Object.entries(ENTRIES)].reverse());
    expect(buildStrandGraph(shuffled).bySlice.get("2026-06-22-0900")).toEqual(
      graph.bySlice.get("2026-06-22-0900"),
    );
  });
});

describe("neighbour lookup", () => {
  const graph = buildStrandGraph(ENTRIES);

  it("finds both neighbours in the middle of a path", () => {
    expect(nextOnStrand(graph, "工作", "2026-06-22-1400")).toBe("2026-09-15-0746");
    expect(previousOnStrand(graph, "工作", "2026-06-22-1400")).toBe("2026-06-22-0900");
  });

  it("returns null for previous at the strand's first position", () => {
    expect(previousOnStrand(graph, "工作", "2026-06-22-0900")).toBeNull();
  });

  it("returns null for next at the strand's last position (unlit door)", () => {
    expect(nextOnStrand(graph, "工作", "2026-09-15-0746")).toBeNull();
    // A single-position strand is unlit from its only room.
    expect(nextOnStrand(graph, "跑步", "2026-06-22-0900")).toBeNull();
  });

  it("returns null for unknown strands and slices not on the strand", () => {
    expect(nextOnStrand(graph, "不存在的线", "2026-06-22-0900")).toBeNull();
    expect(nextOnStrand(graph, "家庭", "2026-09-15-0746")).toBeNull();
    expect(previousOnStrand(graph, "家庭", "2026-06-22-1400")).toBeNull();
  });
});

describe("strandDoorsForSlice", () => {
  const graph = buildStrandGraph(ENTRIES);

  it("returns one door per strand through the slice, with destination and gap", () => {
    const doors = strandDoorsForSlice(graph, "2026-06-22-0900");
    expect(doors).toEqual([
      { strand: "工作", next: "2026-06-22-1400", gapDays: 0 },
      { strand: "家庭", next: "2026-10-01-1200", gapDays: 101 },
      { strand: "跑步", next: null, gapDays: null },
    ]);
  });

  it("includes unlit doors at the strand's last position", () => {
    const doors = strandDoorsForSlice(graph, "2026-09-15-0746");
    expect(doors).toEqual([{ strand: "工作", next: null, gapDays: null }]);
  });

  it("returns an empty set when no strand passes through the slice", () => {
    expect(strandDoorsForSlice(graph, "2027-01-01-0000")).toEqual([]);
  });

  it("is byte-for-byte stable across independent builds (axiom A6)", () => {
    const again = buildStrandGraph(ENTRIES);
    expect(strandDoorsForSlice(again, "2026-06-22-0900")).toEqual(
      strandDoorsForSlice(graph, "2026-06-22-0900"),
    );
  });
});

describe("real data sanity pass (memory/episodic)", () => {
  const root = fileURLToPath(new URL("../../../", import.meta.url));
  const strands = JSON.parse(
    readFileSync(`${root}memory/episodic/strands.json`, "utf8"),
  ) as Record<string, string[]>;
  const timeline = JSON.parse(
    readFileSync(`${root}memory/episodic/timeline/index.json`, "utf8"),
  ) as { slices: Array<{ id: string }> };
  const realIds = new Set(timeline.slices.map((s) => s.id));

  it("builds the graph from the repo's real strands.json", () => {
    const graph = buildStrandGraph(strands);
    expect(graph.paths.size).toBeGreaterThan(0);
    expect(graph.bySlice.size).toBeGreaterThan(0);

    // Every graph path element must BE a real slice id — by construction the
    // graph only holds normalised positions, so an element missing from the
    // timeline index is an orphan in the SOURCE data.
    let positionCount = 0;
    let orphanCount = 0;
    const gaps: number[] = [];
    for (const path of graph.paths.values()) {
      positionCount += path.length;
      for (const id of path) {
        if (!realIds.has(id)) orphanCount += 1;
      }
      for (let i = 1; i < path.length; i++) {
        const msA = sliceIdToMs(path[i - 1])!;
        const msB = sliceIdToMs(path[i])!;
        gaps.push((msB - msA) / (24 * 60 * 60 * 1000));
      }
    }
    gaps.sort((a, b) => a - b);
    const median = gaps[Math.floor(gaps.length / 2)];

    console.log(
      `[strand-graph real data] strands=${graph.paths.size} ` +
        `positions=${positionCount} orphans=${orphanCount} ` +
        `consecutivePairs=${gaps.length} ` +
        `gapDays min=${gaps[0]?.toFixed(2)} median=${median?.toFixed(2)} ` +
        `max=${gaps[gaps.length - 1]?.toFixed(2)}`,
    );

    // Gaps are chronological by construction: never negative.
    expect(gaps[0]).toBeGreaterThanOrEqual(0);
    // The reverse index only names slices the paths actually contain.
    for (const [id, carriers] of graph.bySlice) {
      for (const name of carriers) {
        expect(graph.paths.get(name)).toContain(id);
      }
    }
  });
});
