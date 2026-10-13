/**
 * The mechanical wake (v0.30 §2.1 机械铃) — the reflection unit's ONLY
 * trigger. Nobody briefs it: the engineering layer hands over a pure pointer
 * ({sliceId, turnId, date}) after a turn lands on disk, and the unit reads
 * the record itself. The engine below is what the retired reportToHQ
 * executor used (advisory getHookByToken → resumeHook → start fallback);
 * v0.30 moves it here, off the model's tool surface.
 *
 * Plain Node module, no "use step": the chat tail wraps it in a thin step
 * (steps.ts ringReflection), and the cancel route — outside any workflow
 * run — calls it directly. Importing hqRun statically is safe from here:
 * hq-run → hq-steps never reaches back (see the cycle warning in
 * hq-steps.ts's header).
 */
import { getHookByToken, resumeHook, start } from "workflow/api";
import {
  HQ_TOKEN,
  hqRun,
  type ReflectionWakePayload,
} from "@/app/api/evolution/hq-run";
import { localDateKey } from "@/lib/time/relative";
import type { TimeSlice } from "@/lib/episodic";
import type { TurnInput } from "@/lib/chat/turn-types";

export type ReflectionWakeResult =
  | { ok: true; delivered: "resumed" | "started"; runId: string }
  | { ok: false; reason: string };

/**
 * Build the wake's pointer from the finished turn. The date rides the USER's
 * clock (the same convention slice ids are named by); absent when the turn's
 * own timestamps are missing. Pure.
 */
export function buildReflectionWakePayload(
  slice: TimeSlice,
  input: TurnInput,
): ReflectionWakePayload {
  const date = localDateKey(input.startedAtIso, input.clientTimezone);
  return {
    sliceId: slice.slice_id,
    turnId: input.turnId,
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
    const run = await start(hqRun, [payload], { region: "hkg1" });
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
 * failure — hook absent (HookNotFoundError), or a race where the run exited
 * right after the advisory — falls back to `start(hqRun, [payload])`. A
 * resumeHook failure can leave the event durable while the wake failed;
 * re-delivering to a fresh run only appends a duplicate `hook_received`,
 * which the run absorbs writer-is-reader style (§11 ③). Never throws: a lost
 * wake is made up by the next turn's bell (the unit's range is everything
 * since its last look), so a failure rides the result, not an exception.
 */
export async function deliverReflectionWake(
  payload: ReflectionWakePayload,
): Promise<ReflectionWakeResult> {
  try {
    // Advisory only (SDK): a hit does not guarantee the hook survives until
    // resumeHook — the race is closed by the fallback below.
    await getHookByToken(HQ_TOKEN);
  } catch {
    return startReflectionRun(payload);
  }
  try {
    const resumed = await resumeHook(HQ_TOKEN, payload);
    return { ok: true, delivered: "resumed", runId: resumed.runId };
  } catch (e) {
    console.warn(
      "[Reflection] resumeHook failed — starting a fresh run:",
      e instanceof Error ? e.message : e,
    );
    return startReflectionRun(payload);
  }
}
