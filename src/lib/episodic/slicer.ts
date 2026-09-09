/**
 * Slicing Decision Engine — pure time-based (v0.9) + idle-gap close.
 *
 * Three close signals, checked in the chat route (steps.ts):
 * 1. Idle gap — no turn for `idleGapMinutes` means the user left and came
 *    back: close with `"idle_gap"` and open a genuinely NEW conversation
 *    (no context carry-over). Checked first, measured from the last turn.
 * 2. Slice age — force-close once the slice has been open for
 *    `maxSliceMinutes` (measured from the slice start, not last activity).
 *    This is a periodic autosave CHECKPOINT (`"time_cap"`), not the end of
 *    the conversation — the follow-up slice links back via `continuesFrom`.
 * 3. Turn count cap — pure safety net (`"capacity"`, also a checkpoint).
 *
 * A client-history mismatch (page refresh, device switch, stale writes) is
 * NOT a close signal: the server slice is authoritative and the model
 * history window is rebuilt from the slice's own turns instead (steps.ts).
 *
 * All closes are lazy — detected when the NEXT turn arrives — so an idle-gap
 * close fires on the first turn after the silence.
 *
 * Thresholds are read from the user config (`src/lib/config/defaults.ts`,
 * overridable via memory/user/config.json) at request time so they can be
 * adjusted in Settings without a redeploy — this module has NO defaults of
 * its own (the old 15-minute idle-gap constant lived here and is gone).
 */

/**
 * Check whether the slice has been open long enough (wall-clock time since
 * its start) to warrant closing it.
 */
export function checkSliceAge(startIso: string, maxMs: number): boolean {
  const elapsedMs = Date.now() - new Date(startIso).getTime();
  return elapsedMs >= maxMs;
}

/**
 * Check whether enough wall-clock time has passed since the slice's LAST TURN
 * to treat the conversation as abandoned. Unparseable/absent timestamps never
 * trigger the close.
 */
export function checkIdleGap(lastTurnIso: string, maxMs: number): boolean {
  const lastMs = new Date(lastTurnIso).getTime();
  if (Number.isNaN(lastMs) || Number.isNaN(maxMs)) return false;
  return Date.now() - lastMs >= maxMs;
}
