/**
 * The mechanical wake (v0.30 §2.1 机械铃; v0.34 常驻形态 R1) — the
 * reflection unit's ONLY event trigger. Nobody briefs it: the engineering
 * layer hands over a pure pointer ({sliceId, date}) after a slice is SEALED
 * on disk, and the unit reads the record itself. v0.34 narrowed WHEN the
 * bell rings: only a real slice close rings (the per-turn tail bell and the
 * cancel-route bare bell both retired — an open slice is not reflection
 * material, and a "question without an answer" is covered when its slice
 * seals). The engine below is unchanged: advisory getHookByToken →
 * resumeHook → start fallback — and the fallback is exactly the resident
 * unit's RESURRECTION path (a dead generation's token is free, so the next
 * bell starts a fresh one).
 *
 * Plain Node module, no "use step": the chat tail wraps it in a thin step
 * (steps.ts ringReflection). Importing reflectionRun statically is safe from
 * here: reflection-run → reflection-steps never reaches back (the steps'
 * impure edges — the unit, the status store, the world-read legs — are all
 * DYNAMIC imports, precisely so this graph stays acyclic; see the cycle
 * warning in reflection-steps.ts's header).
 */
import { getHookByToken, resumeHook, start } from "workflow/api";
import {
  REFLECTION_TOKEN,
  reflectionRun,
  type ReflectionWakePayload,
} from "@/app/api/evolution/reflection-run";
import { localDateKey } from "@/lib/time/relative";
import type { TurnInput } from "@/lib/chat/turn-types";

export type ReflectionWakeResult =
  | { ok: true; delivered: "resumed" | "started"; runId: string }
  | { ok: false; reason: string };

/**
 * Build the wake's pointer off a SEALED slice. The date rides the USER's
 * clock (the same convention slice ids are named by); absent when the turn's
 * own timestamps are missing. Pure.
 */
export function buildReflectionWakePayload(
  closedSliceId: string,
  input: TurnInput,
): ReflectionWakePayload {
  const date = localDateKey(input.startedAtIso, input.clientTimezone);
  return {
    sliceId: closedSliceId,
    ...(date ? { date } : {}),
  };
}

/** Start a fresh reflection run carrying this wake as its first payload. */
async function startReflectionRun(
  payload: ReflectionWakePayload,
): Promise<ReflectionWakeResult> {
  try {
    // Same start config as the question sub-flow — background runs live in
    // one region, not two.
    const run = await start(reflectionRun, [payload], { region: "hkg1" });
    return { ok: true, delivered: "started", runId: run.runId };
  } catch (e) {
    return {
      ok: false,
      reason: `the reflection unit could not be reached: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

/**
 * Deliver the wake. Step order: the advisory `getHookByToken` first; a live
 * hook → `resumeHook` (durable `hook_received` first, then the wake). Any
 * failure — hook absent (HookNotFoundError: no live generation holds the
 * mailbox), or a race where the run exited right after the advisory — falls
 * back to `start(reflectionRun, [payload])`; that fresh run IS the next
 * generation (the retirement relay's own start dedupes against it via
 * getConflict, §2.3). A resumeHook failure can leave the event durable while
 * the wake failed; re-delivering to a fresh run only appends a duplicate
 * `hook_received`, which the run absorbs writer-is-reader style (§11 ③).
 * Never throws: a lost bell is made up by the next seal's bell (the unit's
 * range is everything since its last look), so a failure rides the result,
 * not an exception.
 */
export async function deliverReflectionWake(
  payload: ReflectionWakePayload,
): Promise<ReflectionWakeResult> {
  try {
    // Advisory only (SDK): a hit does not guarantee the hook survives until
    // resumeHook — the race is closed by the fallback below.
    await getHookByToken(REFLECTION_TOKEN);
  } catch {
    return startReflectionRun(payload);
  }
  try {
    const resumed = await resumeHook(REFLECTION_TOKEN, payload);
    return { ok: true, delivered: "resumed", runId: resumed.runId };
  } catch (e) {
    console.warn(
      "[Reflection] resumeHook failed — starting a fresh run:",
      e instanceof Error ? e.message : e,
    );
    return startReflectionRun(payload);
  }
}
