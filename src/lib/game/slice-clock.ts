/**
 * Slice-id clock (B.14 rule 1) — the SINGLE source for "a time-slice id
 * encodes its own clock". `2026-09-15-0746` is Sep 15, 07:46: the corridor
 * door plate wears the HHMM half (group 4), a date plaque the MM·DD half,
 * and every strand door leading to the slice carries the same HHMM as its
 * door NUMBER — so the same slice hangs the same number in the corridor and
 * in every room, on any machine.
 *
 * This module exists because the rule used to live twice: corridor.tsx's
 * `sliceClock` and game-shell.tsx's mirrored copy (kept in sync by a
 * comment). Both now import from here; ids that do not match the format
 * (fixtures, tests) get no signage — the corridor's own "no signage" case.
 * Never derive the number from a locale-formatted `start` timestamp: that
 * one is locale-local time rendered from UTC and can differ from the id's
 * clock. Pure data — no three.js, no React, no seeding.
 */

/** Anchored slice-id pattern: year-month-day-clock, nothing else. */
export const SLICE_ID_RE = /^(\d{4})-(\d{2})-(\d{2})-(\d{4})$/;

/** The id's clock halves: `date` = "MM·DD" (date plaques), `time` = "HHMM"
 *  (door plates and strand-door numbers). Null when the id is not a
 *  time-slice id. */
export function sliceClock(sliceId: string): { date: string; time: string } | null {
  const m = SLICE_ID_RE.exec(sliceId);
  return m ? { date: `${m[2]}·${m[3]}`, time: m[4] } : null;
}

/** Just the HHMM door number (B.14 rule 1), or null. */
export function sliceClockTime(sliceId: string): string | null {
  const m = SLICE_ID_RE.exec(sliceId);
  return m ? m[4] : null;
}
