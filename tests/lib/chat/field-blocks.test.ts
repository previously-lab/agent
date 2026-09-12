/**
 * The conversation field's block model: how the stream is grouped into
 * top-anchored blocks, how a prepend is detected from the block keys alone,
 * and — the rule this module exists for — which boundary is announcing itself.
 */
import { describe, it, expect } from "vitest";
import {
  armedGate,
  groupBlocks,
  prependHeadCount,
  sliceIdOf,
  splitItems,
  FIELD_ORIGIN_PX,
  ORIGIN_REGION,
  SLICE_GATE_PX,
  type GateBand,
} from "@/lib/chat/field-blocks";
import type {
  ChatStreamItem,
  HistoryTurnItem,
  SeamItem,
} from "@/lib/chat/stream-items";
import type { Turn } from "@/lib/episodic/types";

function turn(sliceId: string, i: number, strands: string[] = []): HistoryTurnItem {
  const t: Turn = {
    timestamp: `2026-08-11T10:00:0${i}.000Z`,
    role: i % 2 === 0 ? "user" : "agent",
    content: `turn ${i}`,
  };
  return {
    kind: "history-turn",
    key: `ht-${sliceId}-${i}`,
    sliceId,
    strands,
    turn: t,
    timeIso: t.timestamp,
  };
}

function seam(sliceId: string, strands: string[] = []): SeamItem {
  return {
    kind: "seam",
    key: `seam-${sliceId}`,
    seam: "boundary",
    dateIso: "2026-08-11T10:00:00.000Z",
    strands,
    timeIso: "2026-08-11T10:00:00.000Z",
  };
}

let liveSeq = 0;
function live(key?: string): ChatStreamItem {
  liveSeq += 1;
  return {
    kind: "live",
    key: key ?? `live-${liveSeq}`,
    message: { id: `m${liveSeq}`, role: "assistant", parts: [] },
    timeIso: "2026-08-11T11:00:00.000Z",
    isStreaming: false,
  };
}

describe("splitItems", () => {
  it("puts everything before the first live item in history", () => {
    const items = [seam("a"), turn("a", 0), live(), live()];
    const { history, live: liveRun } = splitItems(items);
    expect(history.map((i) => i.kind)).toEqual(["seam", "history-turn"]);
    expect(liveRun).toHaveLength(2);
  });

  it("treats a list with no live items as all history", () => {
    const { history, live: liveRun } = splitItems([seam("a"), turn("a", 0)]);
    expect(history).toHaveLength(2);
    expect(liveRun).toHaveLength(0);
  });

  it("is empty-safe", () => {
    expect(splitItems([])).toEqual({ history: [], live: [] });
  });

  it("does not mutate the input", () => {
    const items = [turn("a", 0)];
    const { history } = splitItems(items);
    history.push(turn("b", 0));
    expect(items).toHaveLength(1);
  });
});

describe("sliceIdOf", () => {
  it("reads the slice id off a turn", () => {
    expect(sliceIdOf(turn("2026-08-11-1010", 0))).toBe("2026-08-11-1010");
  });

  it("reads it out of the seam and resume keys", () => {
    expect(sliceIdOf(seam("2026-08-11-1010"))).toBe("2026-08-11-1010");
    expect(
      sliceIdOf({
        kind: "resume-banner",
        key: "resume-2026-08-11-1010",
        startIso: "2026-08-11T10:10:00.000Z",
        timeIso: "2026-08-11T10:10:00.000Z",
      }),
    ).toBe("2026-08-11-1010");
  });

  it("is null for the live run and the briefing card", () => {
    expect(sliceIdOf(live())).toBeNull();
    expect(
      sliceIdOf({
        kind: "briefing",
        key: "briefing",
        timeIso: "2026-08-11T11:00:00.000Z",
      }),
    ).toBeNull();
  });
});

describe("groupBlocks", () => {
  it("opens a block at each seam and marks it a gate", () => {
    const blocks = groupBlocks([
      turn("a", 0),
      turn("a", 1),
      seam("b"),
      turn("b", 0),
      seam("c"),
      turn("c", 0),
    ]);
    expect(blocks.map((b) => b.key)).toEqual(["ht-a-0", "seam-b", "seam-c"]);
    expect(blocks.map((b) => b.gate)).toEqual([false, true, true]);
    expect(blocks[1].items.map((i) => i.key)).toEqual(["seam-b", "ht-b-0"]);
  });

  it("marks the oldest block as NOT a gate — nothing precedes it to cross", () => {
    const blocks = groupBlocks([turn("a", 0), seam("b"), turn("b", 0)]);
    expect(blocks[0].gate).toBe(false);
  });

  it("opens a block at a resume banner too, but that is not a gate", () => {
    const blocks = groupBlocks([
      turn("a", 0),
      {
        kind: "resume-banner",
        key: "resume-b",
        startIso: "2026-08-11T10:00:00.000Z",
        timeIso: "2026-08-11T10:00:00.000Z",
      },
      turn("b", 0),
    ]);
    expect(blocks.map((b) => b.key)).toEqual(["ht-a-0", "resume-b"]);
    expect(blocks[1].gate).toBe(false);
  });

  it("collects a block's strands from its TURNS, first-seen order, no duplicates", () => {
    // The turns carry the slice's own strand set, so the seam's copy on the
    // opening item is not collected — it would only ever repeat them.
    const blocks = groupBlocks([
      seam("a", ["work", "rust"]),
      turn("a", 0, ["rust", "travel"]),
      turn("a", 1, ["work"]),
    ]);
    expect(blocks[0].strands).toEqual(["rust", "travel", "work"]);
  });

  it("gives a turn-less block no strands rather than the seam's", () => {
    const blocks = groupBlocks([seam("a", ["work"])]);
    expect(blocks[0].strands).toEqual([]);
  });

  it("returns nothing for an empty history", () => {
    expect(groupBlocks([])).toEqual([]);
  });
});

describe("prependHeadCount", () => {
  it("seeds the baseline at zero for the first list — an initial fill is not a prepend", () => {
    expect(prependHeadCount(null, [], ["a", "b", "c"])).toBe(0);
  });

  it("counts the blocks a prepend added, from the shared suffix", () => {
    expect(prependHeadCount(0, ["a", "b", "c"], ["x", "y", "a", "b", "c"])).toBe(2);
  });

  it("accumulates across successive prepends", () => {
    const first = prependHeadCount(0, ["a", "b"], ["x", "a", "b"]);
    const second = prependHeadCount(first, ["x", "a", "b"], ["y", "x", "a", "b"]);
    expect(first).toBe(1);
    expect(second).toBe(2);
  });

  it("counts zero when the list is unchanged or only grew at the tail", () => {
    expect(prependHeadCount(3, ["a", "b"], ["a", "b"])).toBe(3);
    expect(prependHeadCount(3, ["a", "b"], ["a", "b", "c"])).toBe(3);
  });

  it("is idempotent — a repeated call with the same list does not double-count", () => {
    const once = prependHeadCount(0, ["a", "b"], ["x", "a", "b"]);
    const twice = prependHeadCount(once, ["x", "a", "b"], ["x", "a", "b"]);
    expect(twice).toBe(once);
  });

  it("refuses to guess when the old head has vanished", () => {
    // A prepend cannot remove the head block, so this is not a prepend and the
    // running total must not move on the strength of a missing key.
    expect(prependHeadCount(1, ["a", "b"], ["c", "d", "e"])).toBe(1);
  });

  it("seeds at zero when the field had no blocks to begin with", () => {
    expect(prependHeadCount(0, [], ["a", "b"])).toBe(0);
  });
});

describe("armedGate", () => {
  const viewportH = 800;
  // Two gates on a 4000px field, plus the origin band above block 0.
  const bands: GateBand[] = [
    { index: ORIGIN_REGION, top: -FIELD_ORIGIN_PX, height: FIELD_ORIGIN_PX },
    { index: 1, top: 1200, height: SLICE_GATE_PX },
    { index: 2, top: 2600, height: SLICE_GATE_PX },
  ];

  it("arms nothing when no boundary is on screen", () => {
    // Viewport [0, 800] — the origin is off screen above, the first gate far below.
    expect(armedGate(bands, 200, viewportH, -FIELD_ORIGIN_PX)).toBeNull();
  });

  it("arms the boundary whose band the viewport centre is inside", () => {
    // Centre 1200+64 = the first gate's mid-band.
    const viewTop = 1200 + SLICE_GATE_PX / 2 - viewportH / 2;
    expect(armedGate(bands, viewTop, viewportH, -FIELD_ORIGIN_PX)).toBe(1);
  });

  it("picks the NEARER of two boundaries on screen at once", () => {
    // A viewport holding both gates: centre 1700 sits between them, nearer to
    // the first (distance 436) than to the second (distance 964).
    expect(armedGate(bands, 1300, viewportH, -FIELD_ORIGIN_PX)).toBe(1);
    // Slide down and the second takes over.
    expect(armedGate(bands, 2200, viewportH, -FIELD_ORIGIN_PX)).toBe(2);
  });

  it("arms exactly ONE boundary even when several are on screen", () => {
    // A viewport tall enough to hold the origin and both gates at once.
    const armed = armedGate(bands, -FIELD_ORIGIN_PX, 3000, -FIELD_ORIGIN_PX);
    expect(armed).toBe(ORIGIN_REGION);
  });

  it("hands over from the origin to the nearest visible boundary", () => {
    // Head of the window: the origin speaks.
    expect(armedGate(bands, -FIELD_ORIGIN_PX, viewportH, -FIELD_ORIGIN_PX)).toBe(
      ORIGIN_REGION,
    );
    // Scrolled down out of the origin's slop; the first gate is the only
    // boundary on screen, so it takes over.
    expect(armedGate(bands, 500, viewportH, -FIELD_ORIGIN_PX)).toBe(1);
    // Past the first gate and into the open — nothing to announce.
    expect(armedGate(bands, 1500, viewportH, -FIELD_ORIGIN_PX)).toBeNull();
    // Approaching the second gate.
    expect(armedGate(bands, 2400, viewportH, -FIELD_ORIGIN_PX)).toBe(2);
  });

  it("gives the origin the floor at the head of the window", () => {
    // At the top clamp, the origin speaks even though a gate is nearer the centre.
    const atHead = armedGate(
      [
        { index: ORIGIN_REGION, top: -FIELD_ORIGIN_PX, height: FIELD_ORIGIN_PX },
        { index: 1, top: 40, height: SLICE_GATE_PX },
      ],
      -FIELD_ORIGIN_PX,
      viewportH,
      -FIELD_ORIGIN_PX,
    );
    expect(atHead).toBe(ORIGIN_REGION);
  });

  it("does not announce a boundary that has scrolled fully out of view", () => {
    // The origin sits at [-128, 0]; at viewTop 0 it is entirely above the fold,
    // so it must not claim the floor even though the reader is at the head.
    const only = [
      { index: ORIGIN_REGION, top: -FIELD_ORIGIN_PX, height: FIELD_ORIGIN_PX },
      { index: 1, top: 900, height: SLICE_GATE_PX },
    ];
    expect(armedGate(only, 0, viewportH, -FIELD_ORIGIN_PX)).toBeNull();
  });

  it("does not give the origin the floor when there is no origin band", () => {
    const noOrigin: GateBand[] = [{ index: 1, top: 0, height: SLICE_GATE_PX }];
    expect(armedGate(noOrigin, -FIELD_ORIGIN_PX, viewportH, -FIELD_ORIGIN_PX)).toBe(1);
  });

  it("ignores a band that is entirely below the fold", () => {
    expect(armedGate([{ index: 5, top: 2000, height: SLICE_GATE_PX }], 0, viewportH, 0)).toBeNull();
  });

  it("ignores a band that is entirely above the fold", () => {
    expect(armedGate([{ index: 5, top: 0, height: SLICE_GATE_PX }], 400, viewportH, 0)).toBeNull();
  });

  it("is empty-safe", () => {
    expect(armedGate([], 0, viewportH, 0)).toBeNull();
  });
});
