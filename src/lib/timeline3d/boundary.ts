/**
 * The boundary between two units (v0.13) — what the intertitle reads.
 *
 * A boundary is the same statement at every rung: "you are crossing from the
 * thing above to the thing below, and here is how far apart they are and what
 * the far side is about". The conversation has always said it (`SeamItem`
 * carries the two ends and `SliceGate` renders them). The card rungs said
 * nothing — they had a 6px dot on the band and no text at all — which is the
 * gap the merge closes by giving both sides the same input.
 *
 * WHY THIS IS AN ADAPTER AND NOT A COMPUTATION. The two sides do not hold the
 * same thing: the conversation knows the older slice's LAST TURN timestamp,
 * because its seam item carries it; the catalog knows only the slice's `start`
 * and an optional `end` (the close time, stamped when the slice closes). So the
 * card rungs' interval is the coarser of the two — `end ?? start`, which for a
 * slice that closed cleanly is its last activity and for a live one is its
 * start. That is a real loss of precision rather than a rounding detail, and it
 * is the honest answer given the data: the catalog does not carry turn
 * timestamps, and buying them would mean reading every slice's body to draw one
 * line of text.
 *
 * Direction is NOT here. Which way the reader is travelling decides which of
 * the two ends the phrase is anchored to, and that is live gesture state — the
 * gate reads it off the shared `GateSignal` every frame. This module only says
 * what the interval IS.
 */

/** One end of a boundary, as much as the two sides can supply. */
export interface BoundarySide {
  /** ISO start of the slice. Required — a boundary with no far side is not one. */
  start: string;
  /** ISO close time, when the slice has one. */
  end?: string;
  /** The slice's one-line focus, when it has been marked. */
  focus?: string;
}

/** The interval an intertitle states, in the gate's own vocabulary. */
export interface UnitBoundary {
  /** The NEWER side's start — where the reader is arriving. */
  atIso: string;
  /** The OLDER side's last known activity — the interval's other end. */
  fromIso: string;
  /** The newer slice's focus, if marked. */
  focus?: string;
  /** The older slice's focus, if marked. */
  prevFocus?: string;
}

/**
 * The boundary between two adjacent units, or null when there is not one.
 *
 * Null for a missing `start` on either side, and for two sides starting at the
 * same instant — a boundary you cannot measure is not a boundary, and the gate
 * would otherwise announce "moments apart" against itself.
 */
export function boundaryBetween(
  prev: BoundarySide | undefined,
  next: BoundarySide | undefined,
): UnitBoundary | null {
  if (!prev?.start || !next?.start) return null;
  if (prev.start === next.start) return null;
  return {
    atIso: next.start,
    fromIso: prev.end ?? prev.start,
    ...(next.focus ? { focus: next.focus } : {}),
    ...(prev.focus ? { prevFocus: prev.focus } : {}),
  };
}
