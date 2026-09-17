/**
 * Strand doors — the resolution layer for the thread walk
 * (v0.11-hotel-rooms 附录 B.11 契约, hotel-ified HD4; B.14 dedupe).
 *
 * Given the strand graph and the corridor's rendered slice window, this
 * module resolves, for every slice in the window, the room's strand-door
 * list: one door per strand passing through the slice (NO cap — B.8 用户定稿
 * decision 1), each either LIT or UNLIT but present. A lit door is a
 * FORWARD door when the strand's next slice exists; when the strand has no
 * further active slice, the door falls back to a BACKWARD door pointing at
 * the previous slice on the same thread (B.8 用户定稿 2026-09-18: a dark
 * forward door leads back along its thread — the fallback REPLACES the
 * unlit door, never adds a second one). A door stays unlit only when
 * neither direction exists: the thread has just begun and its only slice
 * is this one (B.4's "not written yet" door). Unlit doors are never
 * dropped and never throw: a missing door would lie about the thread
 * still being alive.
 *
 * THE DESTINATION IS A HOTEL (HD4, §10.2b). Every strand IS a timeline,
 * and every timeline renders as its own hotel: a lit door leads to the
 * lobby of the destination slice's OWN strand's hotel, at the window
 * (CHUNK_DOORS bays × two walls) that holds the destination slice —
 * `destination = { timelineId, windowIndex, sliceId }`. The integrator
 * (game-canvas.tsx) keeps the navigation stack; this module only says
 * WHERE each door leads. B.11's "destination outside the rendered window
 * → unlit" rule is gone: the destination window is derivable for every
 * slice on the strand, so a door with a next/previous chapter is always
 * walkable.
 *
 * DEDUPE, TWO STAGES (B.14 用户定稿 2026-09-18, extended HD4):
 *  1. BY DESTINATION SLICE (B.14, unchanged): lit doors sharing a
 *     destination slice merge into ONE door — several strands pointing at
 *     the same next chapter are one doorway. The merged door keeps the
 *     EARLIEST position any member would have occupied and carries all
 *     its strand names in `strands` (primary = the member that claimed
 *     the position, first).
 *  2. BY DESTINATION HOTEL (safety net): groups whose destinations land
 *     in the SAME (timelineId, windowIndex) merge again — one doorway per
 *     hotel lobby. From one room each strand resolves exactly once, so
 *     two groups can only share a hotel when two strands' timelines
 *     coincide — which they never do (the timelineId IS the strand name).
 *     The stage exists so the contract "one door per destination hotel"
 *     holds even if that ever changes.
 * UNLIT doors never merge — they have no destination to share, and each
 * is one thread's unwritten end.
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
import { windowIndexForFlatIndex } from "./hotel";
import { hashString } from "./seed";
import { PALETTES, VIVID_PALETTES } from "./space-types";

/** The core timeline's hotel id — every other hotel's id is its strand name. */
export const CORE_TIMELINE_ID = "core";

/**
 * Where a lit strand door leads (HD4): the LOBBY of the destination
 * slice's own strand's hotel, at the window holding that slice. `sliceId`
 * rides along for the plaque and for the return trip's landing (the
 * integrator lands the returning player back inside the room they left,
 * by this door's key).
 */
export interface StrandDestination {
  readonly timelineId: string;
  readonly windowIndex: number;
  readonly sliceId: string;
}

/**
 * The hotel accent for a strand timeline (§11.1): one of the 15 palette
 * accents the space recipe system already ships (PALETTES + VIVID_PALETTES
 * in space-types.ts), picked deterministically by strand name — the core
 * timeline wears brand blue (HOTEL_ACCENT_CORE, tuning/hotel.ts), every
 * strand one of these. Deterministic per name (A6): the same strand's
 * hotel reads the same color on every visit, on any machine.
 */
export function strandAccentFor(timelineId: string): string {
  const accents = [...PALETTES, ...VIVID_PALETTES].map((p) => p.accent);
  return accents[hashString(`hotel-accent:${timelineId}`) % accents.length];
}

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
  /** The destination hotel (HD4) — additive; `destination.sliceId` is
   *  always `destinationSliceId`. */
  readonly destination: StrandDestination;
  readonly gapDays: number;
  readonly direction: StrandDoorDirection;
}

/** One resolved strand door in a room. */
export interface RoomDoor {
  /**
   * Stable id, unique within the room and deterministic for the same
   * inputs. Lit doors: `"to:<timelineId>:<windowIndex>"` — destination-
   * hotel-derived (HD4: the door's identity IS the hotel it leads to, and
   * the two-stage merge is defined by the destination, so the key cannot
   * collide within a room nor flicker between visits). Unlit doors: the
   * bare strand name (an unlit door has no destination; its identity
   * stays the thread's).
   */
  readonly key: string;
  /**
   * Already-formatted plaque text. For lit doors this is the caller's
   * `label` callback output; for unlit doors it is the bare strand name —
   * an unlit door has no destination date to print (B.4).
   */
  readonly label: string;
  /**
   * False = neither direction exists: the strand's only slice is this one
   * (a thread that has just begun — B.4). Every door with a next or
   * previous chapter is lit (HD4: B.11's out-of-window rule is gone — the
   * destination's own hotel always exists). The door stays in the list
   * either way, and unlit doors are NEVER merged (a merge needs a
   * destination to share — an unlit door has none).
   */
  readonly lit: boolean;
  /**
   * The hotel this door leads to (HD4): the destination slice's own
   * strand's timeline, at the window holding that slice. For a
   * backward-fallback door this points at the PREVIOUS slice on the
   * strand. Null iff `lit` is false.
   */
  readonly destination: StrandDestination | null;
  /**
   * Every strand this door represents (two-stage merge), primary first, in
   * inherited order. A group of one carries `[strand]` — additive, so
   * single-strand doors are unchanged apart from the field's presence.
   */
  readonly strands: readonly string[];
}

/** The door map: corridor slice id → that room's strand doors. */
export type RoomDoorMap = ReadonlyMap<string, readonly RoomDoor[]>;

/** Per-strand resolution, before the two-stage merge. */
type ResolvedDoor =
  | { readonly lit: false; readonly strand: string }
  | {
      readonly lit: true;
      readonly strand: string;
      readonly destination: StrandDestination;
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
 * `label` is invoked exactly once per LIT door (after the two-stage merge:
 * once per surviving group), with the primary strand, the whole strand
 * group, the destination slice id, the destination HOTEL (HD4), the
 * whole-day gap to it (NEGATIVE for a backward door — the destination lies
 * in the past), and the `direction` of travel (`"forward" | "backward"`,
 * additive) — plaque formatting is the caller's job, so this stays pure.
 *
 * The destination window is derived per strand: a strand's path is sorted
 * oldest → newest, its hotel presents it newest-first (the corridor's own
 * convention), so the destination's flat index in the hotel's door list is
 * `path.length − 1 − i` and its window `windowIndexForFlatIndex` of that.
 */
export function buildRoomDoorMap(args: {
  graph: StrandGraph;
  sliceIds: readonly string[];
  label: (d: StrandDoorLabelQuery) => string;
}): RoomDoorMap {
  const { graph, sliceIds, label } = args;

  // The destination hotel for `destId` on `strand`: the strand's own
  // timeline at the window holding the destination slice.
  const destinationFor = (strand: string, destId: string): StrandDestination | null => {
    const path = graph.paths.get(strand);
    const i = graph.positionIndex.get(strand)?.get(destId);
    if (!path || i === undefined) return null;
    return {
      timelineId: strand,
      windowIndex: windowIndexForFlatIndex(path.length - 1 - i),
      sliceId: destId,
    };
  };

  // Per-strand resolution, in inherited order. No further active slice on
  // the thread: fall back BACKWARD along the same strand (B.8 用户定稿
  // 2026-09-18) — the fallback replaces the unlit door in place. Unlit ONLY
  // when the thread has just begun (no next AND no previous — B.4); HD4
  // dropped B.11's out-of-window rule: every destination's own hotel is
  // derivable, so every door with a chapter to lead to is walkable.
  const resolve = (sliceId: string): ResolvedDoor[] =>
    strandDoorsForSlice(graph, sliceId).map((door) => {
      const dark: ResolvedDoor = { lit: false, strand: door.strand };
      if (door.next === null) {
        const prev = previousOnStrand(graph, door.strand, sliceId);
        if (prev === null) return dark;
        const gapDays = gapDaysBetween(sliceId, prev);
        const destination = destinationFor(door.strand, prev);
        if (gapDays === null || destination === null) return dark;
        return {
          lit: true,
          strand: door.strand,
          destination,
          gapDays,
          direction: "backward",
        };
      }
      if (door.gapDays === null) return dark;
      const destination = destinationFor(door.strand, door.next);
      if (destination === null) return dark;
      return {
        lit: true,
        strand: door.strand,
        destination,
        gapDays: door.gapDays,
        direction: "forward",
      };
    });

  const map = new Map<string, readonly RoomDoor[]>();
  for (const sliceId of sliceIds) {
    const resolved = resolve(sliceId);

    // Two-stage merge, single pass in inherited order. Stage 1 (B.14): lit
    // doors sharing a destination SLICE merge; the first door to claim a
    // destination owns the group's position, later members only append
    // their strand name. Stage 2 (HD4 safety net): stage-1 groups sharing
    // a destination HOTEL merge the same way — from one room each strand
    // resolves once, so this only fires if two strands' timelines ever
    // coincide. Unlit doors never join a group.
    const groups: Array<Extract<ResolvedDoor, { lit: true }> & {
      strands: string[];
    }> = [];
    const bySliceGroup = new Map<string, number>(); // dest sliceId → groups index
    const byHotelGroup = new Map<string, number>(); // "timelineId:window" → groups index
    for (const door of resolved) {
      if (!door.lit) continue;
      const hotelKey = `${door.destination.timelineId}:${door.destination.windowIndex}`;
      const atHotel = byHotelGroup.get(hotelKey);
      if (atHotel !== undefined) {
        bySliceGroup.set(door.destination.sliceId, atHotel);
        groups[atHotel].strands.push(door.strand);
        continue;
      }
      const atSlice = bySliceGroup.get(door.destination.sliceId);
      if (atSlice !== undefined) {
        byHotelGroup.set(hotelKey, atSlice);
        groups[atSlice].strands.push(door.strand);
        continue;
      }
      bySliceGroup.set(door.destination.sliceId, groups.length);
      byHotelGroup.set(hotelKey, groups.length);
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
          destination: null,
          strands: [door.strand],
        });
        continue;
      }
      const at = bySliceGroup.get(door.destination.sliceId)!;
      if (emitted.has(at)) continue;
      emitted.add(at);
      const group = groups[at];
      doors.push({
        key: `to:${group.destination.timelineId}:${group.destination.windowIndex}`,
        label: label({
          strand: group.strand,
          strands: group.strands,
          destinationSliceId: group.destination.sliceId,
          destination: group.destination,
          gapDays: group.gapDays,
          direction: group.direction,
        }),
        lit: true,
        destination: group.destination,
        strands: group.strands,
      });
    }
    map.set(sliceId, doors);
  }
  return map;
}
