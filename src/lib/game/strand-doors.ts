/**
 * Strand doors — the resolution layer for the thread walk
 * (v0.11-hotel-rooms 附录 B.11 契约, first third; B.14 dedupe).
 *
 * Given the strand graph and the corridor's rendered slice window, this
 * module resolves, for every slice in the window, the room's strand-door
 * list: one door per strand passing through the slice (NO cap — B.8 用户定稿
 * decision 1), each either LIT or UNLIT but present. A lit door is a
 * FORWARD door when the strand's next slice exists and lies inside the
 * corridor window; when the strand has no further active slice, the door
 * falls back to a BACKWARD door pointing at the previous slice on the same
 * thread (B.8 用户定稿 2026-09-18: a dark forward door leads back along its
 * thread — the fallback REPLACES the unlit door, never adds a second one).
 * A door stays unlit when neither direction is walkable: the thread has
 * only just begun (its only slice is this one — B.4's "not written yet"
 * door), or the destination lies outside the rendered window (B.11's
 * boundary rule, applied to both directions). Unlit doors are never dropped
 * and never throw: a missing door would lie about the thread still being
 * alive.
 *
 * DEDUPE BY DESTINATION (B.14 用户定稿 2026-09-18): lit doors that share a
 * destination slice merge into ONE door — several strands pointing at the
 * same next chapter are one doorway as far as the player is concerned. This
 * is "a cap that is not a cap": the busiest room shrinks for the semantic
 * reason "same destination", never by truncation. The merged door keeps the
 * EARLIEST position any member would have occupied (the group inherits its
 * most-active member's place, so ordering stays stable across visits — A6),
 * and carries all its strand names in `strands` (primary = the member that
 * claimed the position, first). UNLIT doors never merge — they have no
 * destination to share, and each is one thread's unwritten end.
 *
 * Ordering is INHERITED from `strandDoorsForSlice` (activity descending,
 * name tiebreak in code-unit order) — never re-sorted here — so a room's
 * door order cannot flicker between visits (axiom A6).
 *
 * Pure: no I/O, no clock, no randomness, no locale. The label text comes in
 * as a callback so formatting (dates, arrows, i18n) stays a caller concern
 * and this layer stays environment-independent.
 */

import {
  gapDaysBetween,
  previousOnStrand,
  strandDoorsForSlice,
  type StrandGraph,
} from "./strand-graph";

/**
 * Which way a lit strand door leads along its thread. `"forward"` = the
 * next slice on the strand; `"backward"` = the previous slice (the B.8
 * 用户定稿 2026-09-18 fallback for a thread whose next chapter has not
 * happened yet). Additive payload field on the `label` callback — the
 * caller decides the wording; this module never invents UI text.
 */
export type StrandDoorDirection = "forward" | "backward";

/**
 * The `label` callback's payload. `strand` is the group's PRIMARY strand
 * (the member that claimed the door's position); `strands` is the whole
 * merged group, primary first, in inherited order — additive (B.14), so a
 * plaque can say "2 threads" or list them without this module inventing UI
 * wording. `gapDays` is NEGATIVE for a backward door (the destination lies
 * in the past). All members of a merged group share the same origin and
 * destination, so they share one gap and one direction.
 */
export interface StrandDoorLabelQuery {
  readonly strand: string;
  readonly strands: readonly string[];
  readonly destinationSliceId: string;
  readonly gapDays: number;
  readonly direction: StrandDoorDirection;
}

/** One resolved strand door in a room. */
export interface RoomDoor {
  /**
   * Stable id, unique within the room and deterministic for the same
   * inputs. Lit doors: `"to:<destinationSliceId>"` — destination-derived
   * (B.14: the door's identity IS where it leads, and the merged group is
   * defined by the destination, so the key cannot collide within a room
   * nor flicker between visits). Unlit doors: the bare strand name (an
   * unlit door has no destination; its identity stays the thread's).
   */
  readonly key: string;
  /**
   * Already-formatted plaque text. For lit doors this is the caller's
   * `label` callback output; for unlit doors it is the bare strand name —
   * an unlit door has no destination date to print (B.4).
   */
  readonly label: string;
  /**
   * False = neither direction is walkable: the strand's only slice is this
   * one (a thread that has just begun) or the destination lies outside the
   * corridor's rendered window (B.11). The door stays in the list either
   * way, and unlit doors are NEVER merged (B.14 dedupe applies to lit
   * doors sharing a destination — an unlit door has none).
   */
  readonly lit: boolean;
  /**
   * Index of the destination slice in the corridor's NEWEST-FIRST slice
   * list (`sliceIds` below) — exactly the index the door manager needs to
   * place the player on the corridor. For a backward-fallback door this
   * points at the PREVIOUS slice on the strand. Null iff `lit` is false.
   */
  readonly destinationIndex: number | null;
  /**
   * Every strand this door represents (B.14 dedupe), primary first, in
   * inherited order. A group of one carries `[strand]` — additive, so
   * single-strand doors are unchanged apart from the field's presence.
   */
  readonly strands: readonly string[];
}

/** The door map: corridor slice id → that room's strand doors. */
export type RoomDoorMap = ReadonlyMap<string, readonly RoomDoor[]>;

/** Per-strand resolution, before the B.14 destination merge. */
type ResolvedDoor =
  | { readonly lit: false; readonly strand: string }
  | {
      readonly lit: true;
      readonly strand: string;
      readonly destinationSliceId: string;
      readonly destinationIndex: number;
      readonly gapDays: number;
      readonly direction: StrandDoorDirection;
    };

/**
 * Resolve the strand-door lists for every slice in the corridor window.
 *
 * `sliceIds` is the corridor's slice sequence, NEWEST FIRST (door index 0 =
 * the door nearest the lobby = the newest slice — the same order
 * `game-shell.tsx` hands to the canvas). Every slice in `sliceIds` gets a
 * map entry, even when no strand passes through it (an empty list), so the
 * room layer never distinguishes "missing" from "no strands".
 *
 * `label` is invoked exactly once per LIT door (after the B.14 merge: once
 * per destination group), with the primary strand, the whole strand group,
 * the destination slice id, the whole-day gap to it (NEGATIVE for a
 * backward door — the destination lies in the past), and the `direction`
 * of travel (`"forward"` | `"backward"`, additive) — plaque formatting is
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
  label: (d: StrandDoorLabelQuery) => string;
}): RoomDoorMap {
  const { graph, sliceIds, label } = args;

  const indexById = new Map<string, number>();
  sliceIds.forEach((id, i) => {
    if (!indexById.has(id)) indexById.set(id, i);
  });

  // Per-strand resolution, in inherited order. No further active slice on
  // the thread: fall back BACKWARD along the same strand (B.8 用户定稿
  // 2026-09-18) — the fallback replaces the unlit door in place. Unlit when
  // the thread has only just begun (no previous slice), when the previous
  // slice lies outside the corridor's rendered window (B.11's boundary
  // rule, same as forward), or when the forward destination does.
  const resolve = (sliceId: string): ResolvedDoor[] =>
    strandDoorsForSlice(graph, sliceId).map((door) => {
      const dark: ResolvedDoor = { lit: false, strand: door.strand };
      if (door.next === null) {
        const prev = previousOnStrand(graph, door.strand, sliceId);
        if (prev === null) return dark;
        const destinationIndex = indexById.get(prev);
        const gapDays = gapDaysBetween(sliceId, prev);
        if (destinationIndex === undefined || gapDays === null) return dark;
        return {
          lit: true,
          strand: door.strand,
          destinationSliceId: prev,
          destinationIndex,
          gapDays,
          direction: "backward",
        };
      }
      if (door.gapDays === null) return dark;
      const destinationIndex = indexById.get(door.next);
      // Unlit case (b): the destination is outside the corridor's
      // rendered window (B.11's boundary rule).
      if (destinationIndex === undefined) return dark;
      return {
        lit: true,
        strand: door.strand,
        destinationSliceId: door.next,
        destinationIndex,
        gapDays: door.gapDays,
        direction: "forward",
      };
    });

  const map = new Map<string, readonly RoomDoor[]>();
  for (const sliceId of sliceIds) {
    const resolved = resolve(sliceId);

    // B.14 merge, single pass in inherited order: the first lit door to
    // claim a destination owns the group's position; later members only
    // append their strand name. Unlit doors never join a group.
    const groups: Array<Extract<ResolvedDoor, { lit: true }> & {
      strands: string[];
    }> = [];
    const groupAt = new Map<number, number>(); // destinationIndex → groups index
    for (const door of resolved) {
      if (!door.lit) continue;
      const at = groupAt.get(door.destinationIndex);
      if (at !== undefined) {
        groups[at].strands.push(door.strand);
        continue;
      }
      groupAt.set(door.destinationIndex, groups.length);
      groups.push({ ...door, strands: [door.strand] });
    }

    // Emit in inherited order: each lit group at its first member's
    // position, each unlit door at its own.
    const emitted = new Set<number>();
    const doors: RoomDoor[] = [];
    for (const door of resolved) {
      if (!door.lit) {
        // Present but dark, labeled by the bare strand name (B.4). Never
        // dropped, never merged, never thrown.
        doors.push({
          key: door.strand,
          label: door.strand,
          lit: false,
          destinationIndex: null,
          strands: [door.strand],
        });
        continue;
      }
      const at = groupAt.get(door.destinationIndex)!;
      if (emitted.has(at)) continue;
      emitted.add(at);
      const group = groups[at];
      doors.push({
        key: `to:${group.destinationSliceId}`,
        label: label({
          strand: group.strand,
          strands: group.strands,
          destinationSliceId: group.destinationSliceId,
          gapDays: group.gapDays,
          direction: group.direction,
        }),
        lit: true,
        destinationIndex: group.destinationIndex,
        strands: group.strands,
      });
    }
    map.set(sliceId, doors);
  }
  return map;
}
