/**
 * Slicing Decision Engine — M8 simplified.
 *
 * Single rule: time silence. If the last activity was more than
 * THIRTY_MINUTES_MS ago, close the current slice and start a new one.
 *
 * Capacity checks and Flash continuity checks were removed in M8.
 * If long-session capacity issues emerge, they will be addressed in v2
 * with a configurable cap, not a per-request model call.
 */

// ─── Configurable threshold ────────────────────────────────────────────

/** Milliseconds of inactivity before a time-silence split triggers */
export const TIME_SILENCE_THRESHOLD_MS = 30 * 60 * 1000; // 30 minutes

/**
 * Check whether enough wall-clock time has passed since the last activity
 * to warrant closing the current time slice.
 *
 * @param lastActivity - Timestamp of the last turn in milliseconds (Date.now() style)
 */
export function checkTimeSilence(lastActivity: number): boolean {
  const elapsedMs = Date.now() - lastActivity;
  return elapsedMs >= TIME_SILENCE_THRESHOLD_MS;
}
