/**
 * Slicing Decision Engine — M8 simplified.
 *
 * Two rules, checked in the chat route:
 * 1. Time silence — 30 min inactivity (configurable via user config).
 * 2. Turn count cap — force-close after N turns (configurable, default 20).
 *
 * Both thresholds are read from the user config at request time so they can
 * be adjusted in Settings without a redeploy.
 */

// ─── Configurable defaults (overridable via memory/user/config.json) ───

export const DEFAULT_TIME_SILENCE_MS = 30 * 60 * 1000; // 30 minutes
export const DEFAULT_MAX_TURNS_PER_SLICE = 20;

/**
 * Check whether enough wall-clock time has passed since the last activity
 * to warrant closing the current time slice.
 */
export function checkTimeSilence(lastActivity: number, thresholdMs = DEFAULT_TIME_SILENCE_MS): boolean {
  const elapsedMs = Date.now() - lastActivity;
  return elapsedMs >= thresholdMs;
}
