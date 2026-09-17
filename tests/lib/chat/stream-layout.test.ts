/**
 * The DOM chat stream's layout model: estimates, the running offset table,
 * the mounted window, and the top-item lookup. These are the numbers the
 * scroll compensation rules are written against.
 */
import { describe, it, expect } from "vitest";
import {
  buildStreamOffsets,
  estimateHeightFor,
  topStreamIndex,
  visibleStreamRange,
} from "@/lib/chat/stream-layout";
import type { ChatStreamItem, LiveStreamItem } from "@/lib/chat/stream-items";
import type { UIMessage } from "ai";

function live(key: string): LiveStreamItem {
  return {
    kind: "live",
    key,
    message: { id: key, role: "user", parts: [] } as UIMessage,
    timeIso: "2026-09-18T10:00:00.000Z",
    isStreaming: false,
  };
}

function seam(key: string): ChatStreamItem {
  return {
    kind: "seam",
    key,
    seam: "boundary",
    dateIso: "2026-09-18T10:00:00.000Z",
    strands: [],
    timeIso: "2026-09-18T10:00:00.000Z",
  };
}

describe("estimateHeightFor", () => {
  it("gives every kind a positive estimate", () => {
    for (const item of [live("a"), seam("s")]) {
      expect(estimateHeightFor(item)).toBeGreaterThan(0);
    }
  });
});

describe("buildStreamOffsets", () => {
  it("accumulates measured heights and falls back to estimates", () => {
    const items = [live("a"), live("b"), live("c")];
    const measured = new Map([["b", 500]]);
    const tops = buildStreamOffsets(items, (i) => measured.get(i.key));
    const est = estimateHeightFor(live("a"));
    expect(tops).toEqual([0, est, est + 500, est + 500 + est]);
  });

  it("is monotonic however the heights land", () => {
    const items = [live("a"), seam("s"), live("b")];
    const tops = buildStreamOffsets(items, () => 1);
    for (let i = 1; i < tops.length; i++) {
      expect(tops[i]).toBeGreaterThanOrEqual(tops[i - 1] ?? 0);
    }
  });
});

describe("visibleStreamRange", () => {
  // Five 100px rows: tops [0, 100, 200, 300, 400, 500].
  const items = [live("a"), live("b"), live("c"), live("d"), live("e")];
  const tops = buildStreamOffsets(items, () => 100);

  it("mounts exactly the crossing rows plus the overscan", () => {
    // Viewport [200, 400) with no overscan: rows 2 and 3.
    expect(visibleStreamRange(tops, items.length, 200, 200, 0)).toEqual({
      start: 2,
      end: 4,
    });
  });

  it("extends by the overscan in both directions", () => {
    expect(visibleStreamRange(tops, items.length, 200, 200, 100)).toEqual({
      start: 1,
      end: 5,
    });
  });

  it("clamps at both ends of the list", () => {
    expect(visibleStreamRange(tops, items.length, 0, 1000, 500)).toEqual({
      start: 0,
      end: 5,
    });
    expect(visibleStreamRange(tops, items.length, 400, 100, 500)).toEqual({
      start: 0,
      end: 5,
    });
  });

  it("a row whose bottom edge just touches the window still mounts", () => {
    // Row 1 spans [100, 200); a window starting at 199 still crosses it.
    const r = visibleStreamRange(tops, items.length, 199, 100, 0);
    expect(r.start).toBe(1);
  });

  it("handles the empty list", () => {
    expect(visibleStreamRange([0], 0, 0, 800, 700)).toEqual({
      start: 0,
      end: 0,
    });
  });
});

describe("topStreamIndex", () => {
  const items = [live("a"), live("b"), live("c")];
  const tops = buildStreamOffsets(items, () => 100);

  it("is the last row whose top is at or above the scroll position", () => {
    expect(topStreamIndex(tops, items.length, 0)).toBe(0);
    expect(topStreamIndex(tops, items.length, 99)).toBe(0);
    expect(topStreamIndex(tops, items.length, 100)).toBe(1);
    expect(topStreamIndex(tops, items.length, 250)).toBe(2);
  });
});
