/**
 * The rung ladder (v0.13) — what the field is showing, and how each step down
 * is the same thing at a finer grain.
 *
 * The chat view and the timeline view are not two views. They are one field at
 * different zoom, and this module is the vocabulary for saying so:
 *
 *   conversation  one slice, rendered as its TURNS
 *   slice         one slice, rendered as a CARD
 *   day           a day's slices, rendered as a stack
 *   week          a week's slices, rendered as a stack
 *
 * A conversation block is one slice plus the gate that closes it
 * (`field-blocks.ts`); an L0 card row is one slice (`stacks.ts`). Same unit,
 * different component — which is why `conversation` and `slice` share a
 * GROUPING and differ only in presentation. Regrouping happens exactly once per
 * step below them (`slice` → `day` → `week`), which is also why the transition
 * between the two finest rungs is the cheapest one to animate: nothing has to
 * be regrouped, only re-rendered.
 *
 * `StackLevel` is deliberately NOT renumbered. `0 | 1 | 2` is load-bearing:
 * `rowKeyFor`, `groupForLevel`, `framePitchFor` and `backingSheets` all key off
 * it, and the band's camera zoom multiplies it. A rung therefore does not ADD a
 * fourth value to a three-value type — it maps ONTO it, and the map is total:
 * the conversation groups like L0, because it is one slice, exactly as an L0
 * row is. This module is where those two vocabularies meet, so that no other
 * file has to know both.
 */
import { SLICE_GATE_PX } from "@/lib/chat/field-blocks";
import { buildOffsets } from "./field-offsets";
import type { StackLevel } from "./stacks";

/** The four steps of the field's zoom, finest first. */
export type FieldRung = "conversation" | "slice" | "day" | "week";

/** Finest → coarsest. The index into this is what the band's camera scales by. */
export const RUNG_ORDER = [
  "conversation",
  "slice",
  "day",
  "week",
] as const satisfies readonly FieldRung[];

/** How a unit draws itself at a rung. */
export type Presentation = "turns" | "card" | "stack";

/** 0 = the conversation (deepest zoom), 3 = a week stack (widest). */
export function rungIndex(rung: FieldRung): number {
  return RUNG_ORDER.indexOf(rung);
}

/**
 * Which of `StackLevel`'s three groups this rung builds its units from. Total:
 * every rung has one, and the conversation shares L0's because it renders ONE
 * SLICE. That shared answer is the whole reason the two finest rungs can be one
 * list of the same units with a different component on each.
 */
export function stackLevelForRung(rung: FieldRung): StackLevel {
  if (rung === "conversation") return 0;
  if (rung === "slice") return 0;
  if (rung === "day") return 1;
  return 2;
}

/** The rung a stack level is the CARD form of. */
export function rungForStackLevel(level: StackLevel): FieldRung {
  if (level === 0) return "slice";
  if (level === 1) return "day";
  return "week";
}

/** How a unit draws itself at this rung. */
export function presentationForRung(rung: FieldRung): Presentation {
  if (rung === "conversation") return "turns";
  if (rung === "slice") return "card";
  return "stack";
}

/**
 * The boundary's height at EVERY rung — one number, because a boundary is the
 * same statement at every zoom.
 *
 * It is the conversation's `SLICE_GATE_PX` rather than a new constant: the gate
 * was already the app's one intertitle ("how far away is the next slice, and
 * what is it about"), and the card rungs previously had no boundary text at
 * all — only a 6px dot on the band. Reusing the component is the point of the
 * merge; reusing its height is what makes the card rows' pitch a function of
 * one constant they can share.
 */
export const FIELD_BOUNDARY_PX = SLICE_GATE_PX;

/**
 * How much room one unit takes: its face, plus a boundary if it closes one.
 *
 * The asymmetry with the window's head is deliberate and stays: `FieldOrigin`
 * is a LEADING region above unit 0 (`field-blocks.ts`), while a gate is a
 * TRAILING region on the unit it closes. Getting that backwards makes a page
 * arriving at the head grow the reader's own block by a gate's height under
 * them — see `groupBlocks`.
 */
export function extentOf(faceHeight: number, closesBoundary: boolean): number {
  return faceHeight + (closesBoundary ? FIELD_BOUNDARY_PX : 0);
}

/** Where every unit sits, and how tall its face is on its own. */
export interface UnitLayout {
  /** Running start offsets; `tops.length === count + 1`, so the last is the
   *  total extent AND `tops[i + 1] - tops[i]` is the unit's full extent. */
  tops: number[];
  /** The unit's own height, WITHOUT its boundary — what a face is drawn at and
   *  what a measured unit reports. Kept separate from the extent because the
   *  two answer different questions: "how tall is this card" and "how much room
   *  does it take up in the column". */
  faceHeights: number[];
  /** The whole column's extent, boundary regions included. */
  total: number;
}

/**
 * The one place a unit's height is decided, per rung.
 *
 * `faceHeightOf` is the only thing a rung has to answer. A conversation unit
 * MEASURES (its text has no formula), a card unit is a constant
 * (`framePitchFor`), and either way the boundary is added here rather than by
 * the caller — because a boundary belongs to the unit that CLOSES it, and the
 * cost of getting that wrong is that a page arriving at the head grows the
 * reader's own block by a gate's height under them.
 *
 * A unit with no measured height yet inherits the running one (`buildOffsets`),
 * so the column stays monotonic while a freshly-paged window settles.
 */
export function layoutFor(
  count: number,
  faceHeightOf: (index: number) => number,
  closesBoundaryOf: (index: number) => boolean,
  fallbackExtent: number,
): UnitLayout {
  const { tops, total } = buildOffsets(
    count,
    (i) => {
      const face = faceHeightOf(i);
      // A boundary is a CONSTANT, so it must not count as "this unit has
      // reported a height" — an unmounted conversation unit would otherwise
      // look measured at exactly one gate, and the column would lay it out as
      // a 128px stub instead of letting it inherit the running height the way
      // an unmeasured unit is supposed to.
      return face > 0 ? extentOf(face, closesBoundaryOf(i)) : 0;
    },
    fallbackExtent,
  );
  // The face is read back off the table rather than recomputed, so a face and
  // the column it sits in can never disagree — including for a unit that
  // inherited the running height instead of reporting one of its own.
  const faceHeights: number[] = [];
  for (let i = 0; i < count; i++) {
    const full = (tops[i + 1] ?? tops[i]) - tops[i];
    faceHeights[i] = closesBoundaryOf(i)
      ? Math.max(0, full - FIELD_BOUNDARY_PX)
      : full;
  }
  return { tops, faceHeights, total };
}
