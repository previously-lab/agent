/**
 * Reflection contract — what the wake channel's two sides share
 * (v0.30 §2; v0.34 常驻形态 R1).
 *
 * Pure by construction: one token constant, the payload/outcome types, and
 * one pure pointer helper. `reflection-run.ts` is a WORKFLOW file, and the
 * Workflow SDK bundles a workflow file's static import graph into the
 * sandbox — which has no Node modules
 * (docs/errors/node-js-module-in-workflow). So this module must stay free of
 * imports; anything impure belongs in `reflection-steps.ts` behind
 * "use step".
 */

/**
 * The one global reflection mailbox token (v0.30 §4 裁决 9: globally unique,
 * need not be hard-guaranteed — a re-start simply claims it again). Renamed
 * and re-valued in v0.34 (was HQ_TOKEN = "hq:main"): a hook is per-run and
 * the token value carries no cross-deployment legacy, so the rename is safe.
 */
export const REFLECTION_TOKEN = "reflection:main";

/**
 * The mechanical wake: a PURE POINTER, nothing else. Nobody briefs the
 * reflection unit — the field rings this after a slice is SEALED on disk
 * (v0.34 R1: the per-turn tail bell and the cancel-route bare bell both
 * retired; only a real close rings), and the unit reads the record itself.
 * Every field is optional: the pointer is a hint (the unit's range is
 * everything since its last look), and a bare wake is legal — a resurrection
 * fallback start carries whatever triggered it, and a future platform cron
 * tick (§6.4) would carry nothing.
 */
export interface ReflectionWakePayload {
  /** The slice that was just sealed. */
  sliceId?: string;
  /**
   * The field's USER-LOCAL calendar date (YYYY-MM-DD) — the unit's write
   * stamps ride the user's clock. Absent on bare wakes; consumers fall back
   * to the UTC date.
   */
  date?: string;
}

/**
 * How a reflection run ended (its return value). A claiming run ends ONLY by
 * retiring (v0.34 修订 D: the unit's lifetime is ONE visit — the idle grace
 * winning the blocking race at a lap boundary IS the retirement; death by
 * cancel/crash/platform produces no outcome at all, and the next bell's
 * delivery fallback starts the next generation off the on-disk cursor).
 */
export type ReflectionRunOutcome =
  | { kind: "dedupedTo"; runId: string }
  | { kind: "retired"; rounds: number };

/**
 * Collapse a drained mailbox into ONE lap pointer (v0.34 §3.1/§3.2: the bell
 * is a doorbell — N bells ≠ N rounds). Slice ids sort chronologically
 * (`YYYY-MM-DD-HHMM`), so the string max IS the furthest sealed slice; the
 * date rides the furthest slice's wake, falling back to the last dated wake
 * (bare wakes name nothing). Pure — sandbox-safe.
 */
export function furthestWakePointer(
  wakes: ReadonlyArray<ReflectionWakePayload>,
): ReflectionWakePayload {
  let furthest: ReflectionWakePayload | undefined;
  let lastDated: ReflectionWakePayload | undefined;
  for (const wake of wakes) {
    if (wake.date) lastDated = wake;
    if (
      wake.sliceId &&
      (!furthest?.sliceId || wake.sliceId > furthest.sliceId)
    ) {
      furthest = wake;
    }
  }
  const date = furthest?.date ?? lastDated?.date;
  return {
    ...(furthest?.sliceId ? { sliceId: furthest.sliceId } : {}),
    ...(date ? { date } : {}),
  };
}
