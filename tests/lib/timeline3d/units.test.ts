import { describe, expect, it } from "vitest";
import {
  extentOf,
  FIELD_BOUNDARY_PX,
  layoutFor,
  layoutForRows,
  presentationForRung,
  RUNG_ORDER,
  rungForStackLevel,
  rungIndex,
  stackLevelForRung,
  unitMetricsFor,
  type FieldRung,
} from "@/lib/timeline3d/units";
import {
  frameGeometryFor,
  framePitchFor,
  type StackRow,
} from "@/lib/timeline3d/stacks";
import type { TimelineSliceEntry } from "@/lib/episodic/timeline/types";
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

describe("layoutFor", () => {
  const closes = (i: number, n: number) => i < n - 1;

  it("lays units out by their extent, boundary included", () => {
    const l = layoutFor(3, () => 400, (i) => closes(i, 3), 320);
    // 400 face + 128 boundary = 528 for the first two; the last closes nothing.
    expect(l.tops).toEqual([0, 528, 1056, 1456]);
    expect(l.total).toBe(1456);
  });

  it("reports the FACE separately from the extent", () => {
    // A face is what gets drawn; the extent is the room the unit takes in the
    // column. Conflating them makes every card 128px too tall.
    const l = layoutFor(2, () => 400, (i) => closes(i, 2), 320);
    expect(l.faceHeights).toEqual([400, 400]);
    expect(l.tops[1] - l.tops[0]).toBe(528);
  });

  it("carries the running height across a unit that has not measured", () => {
    // Including past a unit that CLOSES a boundary — its gate is a constant,
    // so it must not read as "this unit reported a height". If it did, an
    // unmounted conversation unit would lay out as a 128px stub and every
    // block below it would jump when it finally measured.
    const heights = [500, 0, 0];
    const l = layoutFor(3, (i) => heights[i], (i) => closes(i, 3), 320);
    expect(l.tops).toEqual([0, 628, 1256, 1884]);
  });

  it("is well-formed for an empty list", () => {
    const l = layoutFor(0, () => 400, () => false, 320);
    expect(l.tops).toEqual([0]);
    expect(l.faceHeights).toEqual([]);
    expect(l.total).toBe(0);
  });

  it("never reports a negative face when the carry is under one boundary", () => {
    // Reachable only via the running height: a measured face can never be
    // smaller than zero, but an INHERITED extent can be smaller than the gate
    // it is supposed to contain.
    const l = layoutFor(1, () => 0, () => true, 100);
    expect(l.faceHeights[0]).toBe(0);
    expect(l.tops[1] - l.tops[0]).toBe(100);
  });
});

describe("unitMetricsFor", () => {
  // A representative desktop field: 1280×800 → a landscape dossier card.
  const geo = frameGeometryFor(1280, 800);

  it("keys the grouping off the rung, not off a fourth StackLevel", () => {
    const empty = new Map<string, number>();
    expect(unitMetricsFor("conversation", geo, empty).level).toBe(0);
    expect(unitMetricsFor("slice", geo, empty).level).toBe(0);
    expect(unitMetricsFor("day", geo, empty).level).toBe(1);
    expect(unitMetricsFor("week", geo, empty).level).toBe(2);
  });

  it("sizes an unmeasured unit by the rung's own pitch", () => {
    const empty = new Map<string, number>();
    for (const rung of RUNG_ORDER) {
      expect(unitMetricsFor(rung, geo, empty).fallbackExtent).toBe(
        framePitchFor(stackLevelForRung(rung), geo),
      );
    }
  });

  it("keeps the card margin at a card rung however tall the measurements are", () => {
    // The measurements belong to the OTHER rung. Letting a stale 4000px
    // conversation unit widen the card margin would mount rows the reader is
    // nowhere near, for a reason that does not apply to cards.
    const measured = new Map([["a", 4000]]);
    for (const rung of ["slice", "day", "week"] as const) {
      expect(unitMetricsFor(rung, geo, measured).margin).toBe(geo.cardH * 1.2);
    }
  });

  it("widens the margin to the tallest measured unit at the conversation rung", () => {
    // THE invariant this exists for. A unit whose top has scrolled off screen
    // is still mounted while any part of it is in view; laying it out at the
    // inherited running height and unmounting it on the strength of that GUESS
    // loses the measurement, and every unit below jumps.
    const measured = new Map([
      ["a", 900],
      ["b", 5200],
      ["c", 1200],
    ]);
    expect(unitMetricsFor("conversation", geo, measured).margin).toBe(5200);
  });

  it("never narrows below the card margin when nothing has measured", () => {
    const m = unitMetricsFor("conversation", geo, new Map());
    expect(m.margin).toBe(geo.cardH * 1.2);
    expect(m.margin).toBeGreaterThan(0);
  });
});

describe("layoutForRows", () => {
  const geo = frameGeometryFor(1280, 800);

  function row(key: string): StackRow {
    return {
      key,
      level: 0,
      top: { id: key } as TimelineSliceEntry,
      count: 1,
      entries: [],
      strands: [],
    };
  }

  it("uses the card formula at every card rung", () => {
    const rows = [row("a"), row("b"), row("c")];
    const l = layoutForRows(rows, "slice", geo, new Map([["a", 9999]]));
    expect(l.faceHeights).toEqual([geo.cardH, geo.cardH, geo.cardH]);
    // Every row but the last closes a boundary.
    expect(l.tops[1] - l.tops[0]).toBe(geo.cardH + SLICE_GATE_PX);
  });

  it("measures a conversation unit and lets an unmeasured one inherit", () => {
    const rows = [row("a"), row("b"), row("c")];
    // `b` and `c` are still loading — no read has landed. They must INHERIT
    // `a`'s extent, not collapse: a 128px stub under a 700px unit would pull
    // everything below it up and then drop it again when the read lands.
    const l = layoutForRows(rows, "conversation", geo, new Map([["a", 700]]));
    expect(l.tops[1] - l.tops[0]).toBe(700 + SLICE_GATE_PX);
    expect(l.tops[2] - l.tops[1]).toBe(700 + SLICE_GATE_PX);
    expect(l.tops[3] - l.tops[2]).toBe(700 + SLICE_GATE_PX);
    expect(l.faceHeights[0]).toBe(700);
    // The last unit closes no boundary, so its face IS its whole extent — an
    // inherited guess of one gate more than the running face. That is the
    // read-back rule in `layoutFor` (a face and its column can never disagree),
    // and the guess is replaced the moment the unit reports.
    expect(l.faceHeights[2]).toBe(700 + SLICE_GATE_PX);
  });

  it("reads a measurement by ROW KEY, so a prepend cannot mis-assign one", () => {
    // The same slice sits at a different index either side of a page landing.
    // An index-keyed map would hand it the incoming slice's height.
    const before = layoutForRows([row("x"), row("y")], "conversation", geo, new Map([["y", 900]]));
    const after = layoutForRows(
      [row("w"), row("x"), row("y")],
      "conversation",
      geo,
      new Map([["y", 900]]),
    );
    expect(before.faceHeights[1]).toBe(900);
    expect(after.faceHeights[2]).toBe(900);
    expect(after.faceHeights[1]).not.toBe(900);
  });

  it("is boundary-free at the tail of the list at every rung", () => {
    for (const rung of RUNG_ORDER) {
      const l = layoutForRows([row("a"), row("b")], rung, geo, new Map([["a", 500], ["b", 500]]));
      const last = l.total - (l.tops[1] ?? 0);
      expect(last).toBe(l.faceHeights[1]);
    }
  });
});
