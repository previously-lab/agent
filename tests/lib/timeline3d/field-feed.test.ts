/**
 * The band feed: the ownership default a field starts under, what "relax"
 * means, and THE one progress rule — the piece the two fields disagreed about.
 */
import { describe, expect, it } from "vitest";
import {
  clearFeed,
  createFieldFeed,
  progressFor,
} from "@/lib/timeline3d/field-feed";
import { DEFAULT_LEVEL } from "@/lib/timeline3d/stacks";

describe("createFieldFeed", () => {
  it("starts at the present, with nothing wound and nothing announcing", () => {
    const feed = createFieldFeed();
    // 1, not 0: an empty field is at NOW. A band that started at the oldest
    // end would swing to zero and back on every view switch.
    expect(feed.progress).toBe(1);
    expect(feed.anchors).toEqual([]);
    expect(feed.crossing.y).toBeNull();
    expect(feed.level).toBe(DEFAULT_LEVEL);
  });

  it("hands out a fresh object each time", () => {
    const a = createFieldFeed();
    const b = createFieldFeed();
    a.crossing.y = 0.5;
    a.anchors.push({ y: 0, strands: [], span: 0 });
    expect(b.crossing.y).toBeNull();
    expect(b.anchors).toEqual([]);
  });
});

describe("clearFeed", () => {
  it("relaxes the winding and the dot, and leaves the reader's position", () => {
    const feed = createFieldFeed();
    feed.anchors = [{ y: 0.25, strands: ["x"], span: 0.2 }];
    feed.crossing.y = 0.4;
    feed.progress = 0.3;
    clearFeed(feed);
    expect(feed.anchors).toEqual([]);
    expect(feed.crossing.y).toBeNull();
    // NOT reset. A frozen band is a lie the reader cannot tell from a still
    // one, but a scale that jumps back to the beginning when a pane unmounts
    // is a worse lie — the reader did not move.
    expect(feed.progress).toBe(0.3);
  });
});

describe("progressFor", () => {
  it("is the fraction of the scrollable range the reader is through", () => {
    expect(progressFor(0, 0, 1000)).toBe(0);
    expect(progressFor(250, 0, 1000)).toBe(0.25);
    expect(progressFor(1000, 0, 1000)).toBe(1);
  });

  it("measures from the caller's range, not from zero", () => {
    // The chat field's range starts at the ORIGIN region, one region above its
    // oldest block. Both fields ask the same question about different ranges —
    // which is the whole reason this is a function and not a formula inlined
    // twice, as it was.
    expect(progressFor(-128, -128, 872)).toBe(0);
    expect(progressFor(372, -128, 872)).toBe(0.5);
    expect(progressFor(872, -128, 872)).toBe(1);
  });

  it("reports the present when the content fits in the pane", () => {
    // Nowhere to scroll to, and the reader is already looking at now.
    // Reporting 0 would peg the ruler to the oldest end of a memory they can
    // see all of.
    expect(progressFor(0, 0, 0)).toBe(1);
    expect(progressFor(500, 0, -200)).toBe(1);
  });

  it("clamps, so a rig that has not settled cannot drive the band off scale", () => {
    expect(progressFor(-50, 0, 1000)).toBe(0);
    expect(progressFor(1200, 0, 1000)).toBe(1);
  });

  it("is finite for a degenerate range", () => {
    expect(Number.isFinite(progressFor(0, 100, 100))).toBe(true);
  });
});
