import type { TimelineSliceEntry } from "@/lib/episodic/timeline/types";

/**
 * field-rig.ts — shared mutable scroll/animation rig types for the 3D card
 * field.
 *
 * Pulled out of card-field.tsx so that `RowGroup` and `LeavingCard` can import
 * the rig without creating a circular dependency on the main container.
 */

/**
 * The deal's timings, in one place because THREE faces now play it — the card
 * faces (`RowGroup`), the leaving cards, and the conversation unit — and a
 * fourth copy of "0.55 seconds" is how a transition stops looking like one
 * gesture. They lived as a mirrored pair in `card-field.tsx` and `row-group.tsx`
 * and are defined here, beside the rig that carries the deal they describe.
 */
/** Seconds for the fly-in to complete. */
export const DEAL_DURATION = 0.55;
/** Seconds of extra delay per row of distance from the anchor. */
export const DEAL_STAGGER = 0.05;
/** Mounts within this window after a rung/filter change play the deal. */
export const GEN_WINDOW_MS = 650;

export interface DealOrigin {
  /** World-y offset from the new slot to the old slot (added to yWorld). */
  dy: number;
  /** World-z start offset (cards fly in from slightly behind). */
  dz: number;
}

/** Shared mutable scroll/animation rig — read by every row each frame. */
export interface FieldRig {
  target: number;
  current: number;
  /** Row index the last level change anchored on (deal origin). */
  anchorIndex: number;
  /** Timestamp of the last generation (level/filter/mount). */
  genAt: number;
  hoverKey: string | null;
  /** Per-new-row world offset from old slot to new slot. */
  dealOrigins: Map<string, DealOrigin> | null;
  /** Row keys eligible to play the deal-in animation on this generation. */
  dealEligible: Set<string> | null;
}

/** A slice that got swallowed by a coarser stack during a level transition. */
export interface LeavingItem {
  id: string;
  slice: TimelineSliceEntry;
  /** Old slot center in content px at transition start. */
  fromYpx: number;
  /** New row key the slice belongs to. */
  toRowKey: string;
  /** Index of the slice inside the new row's entries. */
  depth: number;
}
