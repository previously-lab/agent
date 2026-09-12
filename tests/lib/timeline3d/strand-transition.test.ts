import { describe, expect, it } from "vitest";
import {
  joinStrandSets,
  LEAVE_FADE_AFTER,
  strandEnvelope,
} from "@/lib/timeline3d/strand-transition";

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
