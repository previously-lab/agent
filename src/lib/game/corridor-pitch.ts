/**
 * Corridor pitch — time gaps become door spacing.
 *
 * WHY THIS EXISTS. v0.11-strand-field §1 defines the timeline as INTERVAL,
 * not list (时间线 = 间隔): a timeline that shows only order shows nothing —
 * the spacing is the information. The corridor is the timeline (hotel-rooms
 * §4), so the distance between doors must carry the distance between
 * memories: a busy week walks dense, a silent month walks long. This module
 * owns the pure conversion — gap days → bay pitches → cumulative geometry —
 * so hotel.ts can address doors and chunks against a variable grid and the
 * renderer never computes a position itself.
 *
 * THE MODEL. The corridor's door order is the flat slice sequence, newest
 * first, paired two per bay (north then south — see hotel.ts). Bay i's
 * pitch encodes the gap from bay i's LAST slice (the older of the pair,
 * flat index 2i + 1) to the next bay's FIRST slice (flat index 2i + 2) —
 * the silence that followed that memory until the next one. The oldest bay
 * has no older neighbor and takes DOOR_PITCH_BASE; so does any bay whose
 * endpoints are missing or malformed — an unknown gap reads as an ordinary
 * one, never as a broken corridor.
 *
 * GEOMETRY. Bay i spans x ∈ [-cumulative[i + 1], -cumulative[i]) and its
 * door sits at its own center, so door positions are a running sum of
 * half-pitches. With every gap ≤ 1 day every pitch is exactly
 * DOOR_PITCH_BASE and the positions collapse onto the legacy uniform grid
 * x = -(i + 0.5) * 6 — bit for bit (the regression test pins this), which
 * is what lets the machine be swapped in without changing the picture.
 * `cumulative` is exposed (length pitches.length + 1, starting at 0) so a
 * future loop/ring (hotel-rooms §4) can close the corridor: its last entry
 * is the corridor's total length.
 *
 * PURITY. No randomness, no I/O, no wall clock — the layout is a pure
 * function of the caller-supplied timestamps, on any machine (axiom A6).
 * Millisecond inputs keep the module agnostic about id formats; parsing
 * lives at the edges (corridorLayoutFromDoors reuses strand-graph's
 * sliceIdToMs for id-shaped doors).
 */

import {
  DOOR_PITCH_BASE,
  DOOR_PITCH_GAIN,
  DOOR_PITCH_MAX,
  DOOR_PITCH_MIN,
} from "./tuning/hotel";
import { sliceIdToMs } from "./strand-graph";

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The pitch formula. log10 of the gap in days: under a day apart → BASE
 * (today's 6 m, unchanged); a decade of days adds GAIN meters; clamped so a
 * bay is never tighter than MIN and never longer than MAX (≈4× a dense
 * stretch — felt, not tedious at 4 m/s). Gaps below 1 day (and negative
 * gaps from misordered input) floor at 1 before the log, so they all map
 * to BASE.
 */
export function doorPitchMeters(gapDays: number): number {
  return Math.min(
    DOOR_PITCH_MAX,
    Math.max(
      DOOR_PITCH_MIN,
      DOOR_PITCH_BASE + DOOR_PITCH_GAIN * Math.log10(Math.max(1, gapDays)),
    ),
  );
}

/**
 * The corridor's variable grid, built once per door list and threaded
 * through hotel.ts. All arrays are indexed by PAST bay index (bay 0 nearest
 * the lobby); the future side stays uniform (no future slices exist yet).
 */
export interface CorridorLayout {
  /** Bay length in meters, dense from bay 0. */
  readonly pitches: readonly number[];
  /**
   * Pitch sum BEFORE bay i: cumulative[0] = 0, cumulative[i + 1] =
   * cumulative[i] + pitches[i]. One entry longer than `pitches`; the last
   * entry is the total corridor length the allocated bays occupy — the
   * number a future ring closure needs.
   */
  readonly cumulative: readonly number[];
  /** Door center x per bay: -(cumulative[i] + pitches[i] / 2). */
  readonly doorXs: readonly number[];
}

/**
 * Whole days between two timestamps, truncated toward zero — the same
 * semantics as strand-graph's gapDaysBetween (which takes ids; the
 * corridor's gaps arrive as timestamps).
 */
function gapDaysFromMs(olderMs: number, newerMs: number): number {
  const days = Math.trunc((newerMs - olderMs) / DAY_MS);
  return days === 0 ? 0 : days; // no -0
}

/**
 * Build the layout from per-slice start timestamps (ms since epoch, UTC),
 * newest first, paired two per bay exactly as hotel.ts pairs sliceIds. Null
 * entries (missing or unparseable starts) break the gap they touch — the
 * affected bay falls back to DOOR_PITCH_BASE.
 */
export function buildCorridorLayout(
  starts: readonly (number | null)[],
): CorridorLayout {
  const bayCount = Math.ceil(starts.length / 2);
  const pitches: number[] = [];
  const cumulative: number[] = [0];
  const doorXs: number[] = [];
  for (let i = 0; i < bayCount; i++) {
    // The between-bays gap: this pair's older slice (flat 2i + 1) against
    // the next pair's newer slice (flat 2i + 2). In a dense flat sequence
    // both exist exactly when 2i + 2 is in range.
    const newer = starts[2 * i + 1];
    const older = starts[2 * i + 2];
    const pitch =
      newer != null && older != null
        ? doorPitchMeters(gapDaysFromMs(older, newer))
        : DOOR_PITCH_BASE;
    pitches.push(pitch);
    doorXs.push(-(cumulative[i] + pitch / 2));
    cumulative.push(cumulative[i] + pitch);
  }
  return { pitches, cumulative, doorXs };
}

/**
 * Layout for the integrator's door list: parse each door's ISO `start`,
 * falling back to the slice id itself (YYYY-MM-DD-HHMM, via strand-graph's
 * parser) when `start` is absent or invalid — fixture doors with id-shaped
 * sliceIds still get honest gaps.
 */
export function corridorLayoutFromDoors(
  doors: readonly { sliceId: string; start?: string }[],
): CorridorLayout {
  const starts = doors.map((d) => {
    if (d.start !== undefined) {
      const ms = Date.parse(d.start);
      if (!Number.isNaN(ms)) return ms;
    }
    return sliceIdToMs(d.sliceId);
  });
  return buildCorridorLayout(starts);
}

/* ------------------------------------------------------------------ */
/* Accessors — total over all bay indices (allocated or not)           */
/* ------------------------------------------------------------------ */

/**
 * Pitch of any bay, allocated or not: bays past the end of the layout take
 * DOOR_PITCH_BASE, so the treadmill can stream bare corridor forever.
 */
export function layoutPitchAt(layout: CorridorLayout, bay: number): number {
  return bay < layout.pitches.length ? layout.pitches[bay] : DOOR_PITCH_BASE;
}

/**
 * Pitch sum before bay `m`, extended past the layout at DOOR_PITCH_BASE per
 * bay. m = 0 → 0; the boundary between bay m − 1 and bay m sits at
 * x = -cumulativePitchBefore(layout, m).
 */
export function cumulativePitchBefore(
  layout: CorridorLayout,
  m: number,
): number {
  const n = layout.cumulative.length - 1;
  if (m <= n) return layout.cumulative[m];
  return layout.cumulative[n] + (m - n) * DOOR_PITCH_BASE;
}

/** Door center x of any bay (its own bay's center). */
export function bayCenterX(layout: CorridorLayout, bay: number): number {
  return -(
    cumulativePitchBefore(layout, bay) +
    layoutPitchAt(layout, bay) / 2
  );
}

/** X of the boundary between bay m − 1 (deeper) and bay m (nearer). */
export function bayBoundaryX(layout: CorridorLayout, m: number): number {
  return -cumulativePitchBefore(layout, m);
}

/** One bay's footprint: span, its own length, and its door's x. */
export function bayGeometry(
  layout: CorridorLayout,
  bay: number,
): { xStart: number; xEnd: number; length: number; doorX: number } {
  const xEnd = bayBoundaryX(layout, bay);
  const xStart = bayBoundaryX(layout, bay + 1);
  return {
    xStart,
    xEnd,
    length: xEnd - xStart,
    doorX: bayCenterX(layout, bay),
  };
}
