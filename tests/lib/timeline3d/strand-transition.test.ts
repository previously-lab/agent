import { describe, expect, it } from "vitest";
import {
  bundleFor,
  joinStrandSets,
  LEAVE_FADE_AFTER,
  lineUpFor,
  spreadSelection,
  strandEnvelope,
} from "@/lib/timeline3d/strand-transition";
import type { FieldAnchor } from "@/lib/timeline3d/winding";

/** An anchor carrying only what these two functions read. */
const anchor = (strands: string[], y = 0.5): FieldAnchor => ({
  y,
  strands,
  span: 0.1,
});

describe("joinStrandSets", () => {
  it("is a no-op when the set is unchanged", () => {
    const join = joinStrandSets(["a", "b", "c"], ["a", "b", "c"]);
    expect(join.order).toEqual(["a", "b", "c"]);
    expect(join.retained).toEqual(["a", "b", "c"]);
    expect(join.joined).toEqual([]);
    expect(join.departed).toEqual([]);
  });

  it("appends joined strands in their new rank order", () => {
    const join = joinStrandSets(["a"], ["a", "x", "y"]);
    expect(join.order).toEqual(["a", "x", "y"]);
    expect(join.joined).toEqual(["x", "y"]);
    expect(join.departed).toEqual([]);
  });

  it("reports departed strands and keeps the retained order", () => {
    const join = joinStrandSets(["a", "b", "c"], ["a", "c"]);
    expect(join.order).toEqual(["a", "c"]);
    expect(join.retained).toEqual(["a", "c"]);
    expect(join.departed).toEqual(["b"]);
    expect(join.joined).toEqual([]);
  });

  it("keeps retained strands in their OLD order, not the new ranking", () => {
    // The bug this guards: re-ranking retained strands would slide lines past
    // each other on every count drift — a reshuffle under the user's eye.
    const join = joinStrandSets(["b", "a"], ["a", "b", "c"]);
    expect(join.order).toEqual(["b", "a", "c"]);
    expect(join.retained).toEqual(["b", "a"]);
  });

  it("composes a full swap — everything departs, everything else joins", () => {
    const join = joinStrandSets(["a", "b"], ["c", "d"]);
    expect(join.retained).toEqual([]);
    expect(join.joined).toEqual(["c", "d"]);
    expect(join.departed).toEqual(["a", "b"]);
    expect(join.order).toEqual(["c", "d"]);
  });

  it("treats the first line-up as all-joined", () => {
    // An empty previous order is the mount case: every strand is new.
    const join = joinStrandSets([], ["a", "b"]);
    expect(join.joined).toEqual(["a", "b"]);
    expect(join.order).toEqual(["a", "b"]);
    expect(join.departed).toEqual([]);
  });

  it("treats an empty next set as all-departed", () => {
    const join = joinStrandSets(["a", "b"], []);
    expect(join.departed).toEqual(["a", "b"]);
    expect(join.order).toEqual([]);
    expect(join.joined).toEqual([]);
  });

  it("never lists a strand twice and never invents one", () => {
    const join = joinStrandSets(["a", "b"], ["b", "a", "z"]);
    const seen = [...join.order, ...join.departed];
    expect(seen.slice().sort()).toEqual(["a", "b", "z"]);
    expect(new Set(join.order).size).toBe(join.order.length);
  });

  it("is deterministic — the same inputs give the same join", () => {
    const first = joinStrandSets(["a", "b", "c"], ["c", "d"]);
    const second = joinStrandSets(["a", "b", "c"], ["c", "d"]);
    expect(first).toEqual(second);
  });
});

describe("strandEnvelope", () => {
  it("starts a joining strand invisible and straight, and ends it settled", () => {
    expect(strandEnvelope(0, false)).toEqual({
      amplitude: 0,
      opacity: 0,
      done: false,
    });
    expect(strandEnvelope(1, false)).toEqual({
      amplitude: 1,
      opacity: 1,
      done: true,
    });
  });

  it("winds a joining strand up monotonically", () => {
    let prevAmp = -1;
    let prevOpacity = -1;
    for (let t = 0; t <= 1.0001; t += 0.02) {
      const e = strandEnvelope(t, false);
      expect(e.amplitude).toBeGreaterThanOrEqual(prevAmp);
      expect(e.opacity).toBeGreaterThanOrEqual(prevOpacity);
      prevAmp = e.amplitude;
      prevOpacity = e.opacity;
    }
  });

  it("starts a leaving strand wound and visible", () => {
    const e = strandEnvelope(0, true);
    expect(e.amplitude).toBe(1);
    expect(e.opacity).toBe(1);
    expect(e.done).toBe(false);
  });

  it("unwinds a leaving strand fully before it has faded at all", () => {
    // The whole point of §2.5: the line unwinds into its lane and only THEN
    // disappears — a simultaneous fade would read as a cut.
    const e = strandEnvelope(LEAVE_FADE_AFTER, true);
    expect(e.opacity).toBe(1);
    expect(e.amplitude).toBeLessThan(0.5);
    expect(e.amplitude).toBeGreaterThan(0);
  });

  it("ends a leaving strand straight and invisible", () => {
    expect(strandEnvelope(1, true)).toEqual({
      amplitude: 0,
      opacity: 0,
      done: true,
    });
  });

  it("unwinds a leaving strand monotonically and never lets it re-wind", () => {
    let prevAmp = Infinity;
    let prevOpacity = Infinity;
    for (let t = 0; t <= 1.0001; t += 0.02) {
      const e = strandEnvelope(t, true);
      expect(e.amplitude).toBeLessThanOrEqual(prevAmp);
      expect(e.opacity).toBeLessThanOrEqual(prevOpacity);
      prevAmp = e.amplitude;
      prevOpacity = e.opacity;
    }
  });

  it("mirrors the two ramps so a departure can be reversed mid-joint", () => {
    // Re-entering the set flips the clock (progress → 1 - progress) and the
    // strand resumes from the amplitude it had, with no jump.
    for (let t = 0; t <= 1; t += 0.05) {
      expect(strandEnvelope(1 - t, false).amplitude).toBeCloseTo(
        strandEnvelope(t, true).amplitude,
        12,
      );
    }
  });

  it("clamps out-of-range and non-finite progress to a settled state", () => {
    expect(strandEnvelope(-1, false).amplitude).toBe(0);
    expect(strandEnvelope(-1, true).amplitude).toBe(1);
    expect(strandEnvelope(2, true).done).toBe(true);
    expect(strandEnvelope(Number.NaN, true)).toEqual({
      amplitude: 0,
      opacity: 0,
      done: true,
    });
  });
});

describe("lineUpFor", () => {
  it("draws the base set in its own order", () => {
    expect(lineUpFor(["b", "a", "c"], [], 7)).toEqual(["b", "a", "c"]);
  });

  it("truncates to the limit", () => {
    expect(lineUpFor(["a", "b", "c", "d"], [], 2)).toEqual(["a", "b"]);
  });

  it("treats a non-positive limit as no limit", () => {
    expect(lineUpFor(["a", "b", "c"], [], 0)).toEqual(["a", "b", "c"]);
    expect(lineUpFor(["a", "b", "c"], [], -1)).toEqual(["a", "b", "c"]);
  });

  it("appends a selection the base does not carry", () => {
    // The safety net: with the right pane filtered by the pick the active unit
    // already carries it, but a highlight that vanished would break the gesture.
    expect(lineUpFor(["a", "b"], ["z"], 7)).toEqual(["a", "b", "z"]);
  });

  it("never draws one strand twice, whatever the spelling", () => {
    // "Fitness", "fitness " and the full-width form are ONE strand — the same
    // normalisation `strandColor` hashes by. The first spelling is kept.
    expect(lineUpFor(["Fitness"], ["fitness ", "ｆｉｔｎｅｓｓ"], 7)).toEqual([
      "Fitness",
    ]);
  });

  it("skips a nameless entry rather than drawing an unexplained line", () => {
    expect(lineUpFor(["", "  ", "a"], [], 7)).toEqual(["a"]);
  });

  it("drops greys before it drops a pick when the cap bites", () => {
    expect(lineUpFor(["a", "b", "c", "d"], ["c"], 2)).toEqual(["c", "a"]);
  });

  it("keeps the picks when the picks alone exceed the cap", () => {
    // Ten picks into a seven-line strip: render seven, highlight seven, drop
    // the rest — but never drop a pick to make room for a grey.
    const picked = ["p1", "p2", "p3", "p4", "p5", "p6", "p7", "p8", "p9"];
    expect(lineUpFor(["g1", "g2"], picked, 7)).toEqual(picked.slice(0, 7));
  });

  it("is empty for an empty base and no picks", () => {
    expect(lineUpFor([], [], 7)).toEqual([]);
  });
});

describe("bundleFor", () => {
  it("leads with the centred anchor's own strands", () => {
    const anchors = [anchor(["a"]), anchor(["b", "c"]), anchor(["d"])];
    expect(bundleFor(anchors, 1, [], 7).slice(0, 2)).toEqual(["b", "c"]);
  });

  it("tops the bundle up from the neighbours, nearest first", () => {
    // The bug this guards: a moment tagged with two things drew two threads on
    // a strip sized for seven, so the highlight had almost nothing to stand
    // against. The neighbours fill it.
    const anchors = [anchor(["a"]), anchor(["b"]), anchor(["c"])];
    expect(bundleFor(anchors, 1, [], 7)).toEqual(["b", "c", "a"]);
  });

  it("alternates outward, so the top-up is balanced either side", () => {
    // Taking the nearest N by distance would put every extra strand on one side
    // of the moment whenever the moment is off-centre in the loaded window.
    const anchors = [anchor(["t2"]), anchor(["t1"]), anchor(["mid"]), anchor(["b1"]), anchor(["b2"])];
    expect(bundleFor(anchors, 2, [], 5)).toEqual([
      "mid",
      "b1",
      "t1",
      "b2",
      "t2",
    ]);
  });

  it("stops at the limit", () => {
    const anchors = [anchor(["a"]), anchor(["b"]), anchor(["c"]), anchor(["d"])];
    expect(bundleFor(anchors, 0, [], 3)).toEqual(["a", "b", "c"]);
  });

  it("counts one strand once when two anchors carry it", () => {
    const anchors = [anchor(["a", "b"]), anchor(["b", "c"])];
    expect(bundleFor(anchors, 0, [], 7)).toEqual(["a", "b", "c"]);
  });

  it("falls back to the ambient set with no active anchor", () => {
    expect(bundleFor([anchor(["a"])], -1, ["x", "y"], 7)).toEqual(["x", "y"]);
    expect(bundleFor([], 0, ["x", "y"], 7)).toEqual(["x", "y"]);
  });

  it("normalises, so two spellings of one strand are one line", () => {
    const anchors = [anchor(["Fitness"]), anchor(["fitness "])];
    expect(bundleFor(anchors, 0, [], 7)).toEqual(["Fitness"]);
  });
});

describe("spreadSelection", () => {
  it("is a no-op with fewer than two picks", () => {
    // One thread has nothing to be symmetric about.
    expect(spreadSelection(["a", "b", "c"], [])).toEqual(["a", "b", "c"]);
    expect(spreadSelection(["a", "b", "c"], ["b"])).toEqual(["a", "b", "c"]);
  });

  it("puts two picks on opposite flanks of a seven-seat line-up", () => {
    // The reader's ask: two picks bunched on one side read as one thick smear.
    // Seats 0 and 4 are 0° and 206° — cos of +0.9 and −0.9 — so one goes each
    // side of the core.
    const order = ["p1", "g1", "g2", "g3", "p2", "g4", "g5"];
    const out = spreadSelection(order, ["p1", "p2"]);
    expect(out.indexOf("p1")).toBe(0);
    expect(out.indexOf("p2")).toBe(4);
  });

  it("spaces three picks evenly", () => {
    const order = ["p1", "p2", "p3", "g1", "g2", "g3"];
    const out = spreadSelection(order, ["p1", "p2", "p3"]);
    expect([out.indexOf("p1"), out.indexOf("p2"), out.indexOf("p3")]).toEqual([
      0, 2, 4,
    ]);
  });

  it("keeps every strand — it re-orders, it does not filter", () => {
    const order = ["a", "b", "c", "d", "e"];
    const out = spreadSelection(order, ["a", "e"]);
    expect([...out].sort()).toEqual([...order].sort());
    expect(out).toHaveLength(order.length);
  });

  it("does not overwrite a seat when the picks exceed half the line-up", () => {
    const order = ["p1", "p2", "p3", "p4"];
    const out = spreadSelection(order, ["p1", "p2", "p3", "p4"]);
    expect([...out].sort()).toEqual([...order].sort());
  });

  it("matches picks by normalised name, like the rest of the line-up", () => {
    const order = ["Fitness", "g1", "g2", "running"];
    const out = spreadSelection(order, ["fitness ", "Running"]);
    expect(out.indexOf("Fitness")).toBe(0);
    expect(out.indexOf("running")).toBe(2);
  });
});
