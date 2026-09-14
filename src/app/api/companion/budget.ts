/**
 * Companion budget gate (design v0.11 §5).
 *
 * The mouth is an unauthenticated, LLM-backed narration endpoint — without a
 * gate, drive-by traffic (or a runaway client loop) burns the model budget.
 * A simple module-level in-memory token bucket keyed by caller IP:
 * 20 narrations per rolling hour.
 *
 * The per-process limitation is deliberate and matches existing precedents
 * (the rework-signal Map in src/lib/episodic/rework-signal.ts): this is a
 * single-user / privately-deployed product, so per-instance state is exactly
 * as binding as a shared store would be, and an ephemeral narrator must not
 * drag in a datastore.
 */

/** Rolling window: one hour. */
const WINDOW_MS = 60 * 60 * 1000;

/** Max narrations per key within the window — the 21st request is rejected. */
export const COMPANION_BUDGET_MAX = 20;

/** Per-IP timestamp log, module-level per-process state (see header). */
const buckets = new Map<string, number[]>();

/**
 * Consume one slot for `key` when the budget allows it. Returns false when
 * the key already made COMPANION_BUDGET_MAX requests inside the rolling
 * window; no slot is consumed then.
 */
export function checkCompanionBudget(key: string, now: number = Date.now()): boolean {
  const cutoff = now - WINDOW_MS;
  const recent = (buckets.get(key) ?? []).filter((t) => t > cutoff);
  if (recent.length >= COMPANION_BUDGET_MAX) {
    buckets.set(key, recent);
    return false;
  }
  recent.push(now);
  buckets.set(key, recent);
  return true;
}

/** Test hook: drop every bucket so tests start from an empty budget. */
export function resetCompanionBudget(): void {
  buckets.clear();
}
