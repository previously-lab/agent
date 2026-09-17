/**
 * Strand doors — the resolution layer for the thread walk
 * (v0.11-hotel-rooms 附录 B.11 契约, first third).
 *
 * Given the strand graph and the corridor's rendered slice window, this
 * module resolves, for every slice in the window, the room's strand-door
 * list: one door per strand passing through the slice (NO cap — B.8 用户定稿
 * decision 1), each either LIT (its destination is the next slice on the
 * strand AND that slice is inside the corridor window, so the door manager
 * can walk the player there) or UNLIT but present — the strand's end (B.4,
 * "the part that has not been written yet") or a destination outside the
 * rendered window (B.11's boundary rule). Unlit doors are never dropped and
 * never throw: a missing door would lie about the thread still being alive.
 *
 * Ordering is INHERITED from `strandDoorsForSlice` (activity descending,
 * name tiebreak in code-unit order) — never re-sorted here — so a room's
 * door order cannot flicker between visits (axiom A6).
 *
 * Pure: no I/O, no clock, no randomness, no locale. The label text comes in
 * as a callback so formatting (dates, arrows, i18n) stays a caller concern
 * and this layer stays environment-independent.
 */

import { strandDoorsForSlice, type StrandGraph } from "./strand-graph";

/** One resolved strand door in a room. */
export interface RoomDoor {
  /** Stable id: the strand name (unique within a room's door list). */
  readonly key: string;
  /**
   * Already-formatted plaque text. For lit doors this is the caller's
   * `label` callback output; for unlit doors it is the bare strand name —
   * an unlit door has no destination date to print (B.4).
   */
  readonly label: string;
  /**
   * False = the destination is not walkable: the strand has no further
   * active slice (thread's end) or the destination lies outside the
   * corridor's rendered window (B.11). The door stays in the list either
   * way.
   */
  readonly lit: boolean;
  /**
   * Index of the destination slice in the corridor's NEWEST-FIRST slice
   * list (`sliceIds` below) — exactly the index the door manager needs to
   * place the player on the corridor. Null iff `lit` is false.
   */
  readonly destinationIndex: number | null;
}

/** The door map: corridor slice id → that room's strand doors. */
export type RoomDoorMap = ReadonlyMap<string, readonly RoomDoor[]>;

/**
 * Resolve the strand-door lists for every slice in the corridor window.
 *
 * `sliceIds` is the corridor's slice sequence, NEWEST FIRST (door index 0 =
 * the door nearest the lobby = the newest slice — the same order
 * `game-shell.tsx` hands to the canvas). Every slice in `sliceIds` gets a
 * map entry, even when no strand passes through it (an empty list), so the
 * room layer never distinguishes "missing" from "no strands".
 *
 * `label` is invoked exactly once per LIT door, with the strand, the
 * destination slice id, and the whole-day gap to it — plaque formatting is
 * the caller's job, so this stays pure.
 *
 * The destination index is resolved through one id→index map built up
 * front, not a per-door scan. Duplicate ids in `sliceIds` resolve to the
 * first occurrence (the corridor never has them; the guard keeps the
 * function total on adversarial input).
 */
export function buildRoomDoorMap(args: {
  graph: StrandGraph;
  sliceIds: readonly string[];
  label: (d: {
    strand: string;
    destinationSliceId: string;
    gapDays: number;
  }) => string;
}): RoomDoorMap {
  const { graph, sliceIds, label } = args;

  const indexById = new Map<string, number>();
  sliceIds.forEach((id, i) => {
    if (!indexById.has(id)) indexById.set(id, i);
  });

  const map = new Map<string, readonly RoomDoor[]>();
  for (const sliceId of sliceIds) {
    const doors: RoomDoor[] = strandDoorsForSlice(graph, sliceId).map(
      (door) => {
        // Unlit case (a): the thread's end — no further active slice.
        if (door.next === null || door.gapDays === null) {
          return {
            key: door.strand,
            label: door.strand,
            lit: false,
            destinationIndex: null,
          };
        }
        const destinationIndex = indexById.get(door.next);
        // Unlit case (b): the destination is outside the corridor's
        // rendered window (B.11's boundary rule). Present, labeled by name
        // alone, never dropped, never thrown.
        if (destinationIndex === undefined) {
          return {
            key: door.strand,
            label: door.strand,
            lit: false,
            destinationIndex: null,
          };
        }
        return {
          key: door.strand,
          label: label({
            strand: door.strand,
            destinationSliceId: door.next,
            gapDays: door.gapDays,
          }),
          lit: true,
          destinationIndex,
        };
      },
    );
    map.set(sliceId, doors);
  }
  return map;
}
