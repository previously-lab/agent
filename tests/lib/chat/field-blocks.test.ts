/**
 * The conversation field's block model: how the stream is grouped into
 * top-anchored blocks, how a prepend is detected from the block keys alone,
 * and — the rule this module exists for — which boundary is announcing itself.
 */
import { describe, it, expect } from "vitest";
import {
  armedGate,
  gateBands,
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
  it("gives the gate to the block it CLOSES, not the one it opens", () => {
    const blocks = groupBlocks([
      turn("a", 0),
      turn("a", 1),
      seam("b"),
      turn("b", 0),
      seam("c"),
      turn("c", 0),
    ]);
    expect(blocks.map((b) => b.key)).toEqual(["ht-a-0", "ht-b-0", "ht-c-0"]);
    // The last block ends the stream, so nothing follows it to cross.
    expect(blocks.map((b) => b.gate)).toEqual([true, true, false]);
    expect(blocks[0].items.map((i) => i.key)).toEqual(["ht-a-0", "ht-a-1", "seam-b"]);
  });

  it("keeps a block byte-identical when a page lands above it", () => {
    // THE property the whole prepend compensation rests on. If the seam that
    // now precedes the old head were attached to the old head, its block would
    // grow by a gate's height under the reader and their text would slide down
    // by exactly that much while the camera tracked something else.
    const before = groupBlocks([turn("old", 0), seam("new"), turn("new", 0)]);
    const after = groupBlocks([
      turn("older", 0),
      seam("old"),
      turn("old", 0),
      seam("new"),
      turn("new", 0),
    ]);
    expect(after[1].key).toBe(before[0].key);
    expect(after[1].items.map((i) => i.key)).toEqual(
      before[0].items.map((i) => i.key),
    );
    expect(after[1].sliceId).toBe(before[0].sliceId);
    expect(after[1].gate).toBe(before[0].gate);
  });

  it("opens a block at a resume banner", () => {
    const blocks = groupBlocks([
      turn("a", 0),
      seam("b"),
      {
        kind: "resume-banner",
        key: "resume-b",
        startIso: "2026-08-11T10:00:00.000Z",
        timeIso: "2026-08-11T10:00:00.000Z",
      },
      turn("b", 0),
    ]);
    // The seam closes slice a's block; the banner opens the resumed one.
    expect(blocks.map((b) => b.key)).toEqual(["ht-a-0", "resume-b"]);
    expect(blocks.map((b) => b.gate)).toEqual([true, false]);
    expect(blocks[1].sliceId).toBe("b");
  });

  it("collects a block's strands from its TURNS, first-seen order, no duplicates", () => {
    // A seam's strand list is that of the NEXT slice, and the seam belongs to
    // this block — so it must not leak in here.
    const blocks = groupBlocks([
      turn("a", 0, ["rust", "travel"]),
      turn("a", 1, ["work"]),
      seam("b", ["work", "rust"]),
    ]);
    expect(blocks[0].strands).toEqual(["rust", "travel", "work"]);
  });

  it("returns nothing for an empty history", () => {
    expect(groupBlocks([])).toEqual([]);
  });

  it("seats the briefing card in the last block rather than opening one", () => {
    // The briefing is a TAIL, not a boundary: it belongs to whatever slice the
    // reader is already in, so it must not split the block it lands in.
    const blocks = groupBlocks([
      turn("a", 0),
      { kind: "briefing", key: "briefing", timeIso: "2026-08-11T11:00:00.000Z" },
    ]);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].sliceId).toBe("a");
  });
});

describe("prependHeadCount", () => {
  it("seeds the baseline at zero for the first list — an initial fill is not a prepend", () => {
    expect(prependHeadCount(null, [], ["a", "b", "c"])).toBe(0);
  });

  it("counts the blocks a prepend added by where the old head went", () => {
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

  it("refuses to guess when the head's id has vanished", () => {
    // A prepend cannot remove the head, so this is not one, and the running
    // total must not move on the strength of a missing id.
    expect(prependHeadCount(1, ["a", "b"], ["c", "d", "e"])).toBe(1);
  });

  it("refuses to guess when the head has no stable id (the briefing card)", () => {
    expect(prependHeadCount(2, [null, "a"], ["x", "y"])).toBe(2);
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

describe("gateBands", () => {
  /** Two 400px blocks, the first of which closes with a gate. */
  const count = 2;
  const closes = (i: number) => i === 0;
  const tops = [0, 400, 800];

  it("puts a gate's band at the TAIL of the unit it closes", () => {
    // Not the head: a gate belongs to the block it closes. Attach it to the
    // next block and the seam arriving with a fresh page lands inside the
    // reader's own block, growing it under them.
    const bands = gateBands([], count, closes, tops, 320, false);
    expect(bands).toEqual([
      { index: 0, top: 400 - SLICE_GATE_PX, height: SLICE_GATE_PX },
    ]);
  });

  it("puts the origin band first, above unit 0", () => {
    const bands = gateBands([], count, closes, tops, 320, true);
    expect(bands[0]).toEqual({
      index: ORIGIN_REGION,
      top: -FIELD_ORIGIN_PX,
      height: FIELD_ORIGIN_PX,
    });
    expect(bands).toHaveLength(2);
  });

  it("emits nothing for units with no boundary", () => {
    const bands = gateBands([], 1, () => false, [0, 100], 320, false);
    expect(bands).toEqual([]);
  });

  it("falls back to an extent for units past the end of the table", () => {
    // The frames between a unit list growing and its table being rebuilt.
    const bands = gateBands([], 1, () => true, [0], 320, false);
    expect(bands[0].top).toBe(320 - SLICE_GATE_PX);
  });

  it("never inverts a unit shorter than the gate", () => {
    const bands = gateBands([], 1, () => true, [0, 40], 320, false);
    expect(bands[0].top).toBe(0);
    expect(bands[0].height).toBe(SLICE_GATE_PX);
  });

  it("empties the caller's buffer before refilling it", () => {
    // This runs once per frame against a persistent array.
    const buffer: GateBand[] = [{ index: 99, top: 0, height: 0 }];
    const bands = gateBands(buffer, count, closes, tops, 320, false);
    expect(bands).toBe(buffer);
    expect(bands).toHaveLength(1);
  });
});
