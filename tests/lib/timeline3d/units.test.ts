import { describe, expect, it } from "vitest";
import {
  extentOf,
  FIELD_BOUNDARY_PX,
  presentationForRung,
  RUNG_ORDER,
  rungForStackLevel,
  rungIndex,
  stackLevelForRung,
  type FieldRung,
} from "@/lib/timeline3d/units";
import { SLICE_GATE_PX } from "@/lib/chat/field-blocks";

describe("the rung ladder", () => {
  it("runs finest to coarsest", () => {
    expect(RUNG_ORDER).toEqual(["conversation", "slice", "day", "week"]);
    expect(rungIndex("conversation")).toBe(0);
    expect(rungIndex("week")).toBe(3);
  });

  it("groups the conversation like a slice — that is why they merge", () => {
    // Both render ONE SLICE. Only the component differs, so a step between
    // them needs no regrouping — which is what makes it the cheap transition.
    expect(stackLevelForRung("conversation")).toBe(0);
    expect(stackLevelForRung("slice")).toBe(0);
    expect(presentationForRung("conversation")).toBe("turns");
    expect(presentationForRung("slice")).toBe("card");
  });

  it("maps the coarser rungs onto the stack levels that already exist", () => {
    expect(stackLevelForRung("day")).toBe(1);
    expect(stackLevelForRung("week")).toBe(2);
    expect(rungForStackLevel(0)).toBe("slice");
    expect(rungForStackLevel(1)).toBe("day");
    expect(rungForStackLevel(2)).toBe("week");
  });

  it("round-trips every stack level", () => {
    for (const level of [0, 1, 2] as const) {
      expect(stackLevelForRung(rungForStackLevel(level))).toBe(level);
    }
  });

  it("gives every rung a grouping — no rung invents a fourth StackLevel", () => {
    // `StackLevel` is three values and stays three; a rung MAPS onto it. The
    // map is total, and only L0 is claimed by two rungs.
    const rungs: FieldRung[] = ["conversation", "slice", "day", "week"];
    expect(rungs.map(stackLevelForRung)).toEqual([0, 0, 1, 2]);
  });

  it("presents a stack for both grouped rungs", () => {
    expect(presentationForRung("day")).toBe("stack");
    expect(presentationForRung("week")).toBe("stack");
  });
});

describe("extentOf", () => {
  it("adds a boundary's height only when the unit closes one", () => {
    expect(extentOf(600, false)).toBe(600);
    expect(extentOf(600, true)).toBe(600 + FIELD_BOUNDARY_PX);
  });

  it("uses the conversation's gate height, so there is one boundary height", () => {
    // A boundary is the same statement at every zoom, so it is the same box.
    expect(FIELD_BOUNDARY_PX).toBe(SLICE_GATE_PX);
  });

  it("is degenerate but well-formed for a unit with no face", () => {
    expect(extentOf(0, true)).toBe(FIELD_BOUNDARY_PX);
  });
});
