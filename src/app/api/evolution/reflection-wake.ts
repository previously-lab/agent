/** A bell starts a reflection when its workflow hook is free. A live owner consumes shared work from the persisted cursor. */
import { getHookByToken, start } from "workflow/api";
import { REFLECTION_TOKEN, reflectionRun } from "@/app/api/evolution/reflection-run";
import type { ReflectionWakeRange } from "@/app/api/evolution/reflection-contract";

export type { ReflectionWakeRange };

export type ReflectionWakeResult =
  | { ok: true; delivered: "rung" | "started" | "tookOver"; runId: string }
  | { ok: false; reason: string };

/**
 * Start a fresh short-lived reflection unit (a dead/absent token is free).
 * `range` is the summary stream's hint (v0.42 §4) — absent on a zombie
 * takeover's fresh run, which then derives its scope from the commit log
 * (§3.5).
 */
async function startReflectionRun(
  range?: ReflectionWakeRange,
): Promise<ReflectionWakeResult> {
  try {
    // Same start config as the question sub-flow — background runs live in
    // one region, not two. The range rides the args (the run's input), not
    // the attributes (observability may read it from the run record either
    // way — the args are what the body consumes).
    const run = await start(reflectionRun, [range ?? null], { region: "hkg1" });
    return { ok: true, delivered: "started", runId: run.runId };
  } catch (e) {
    return {
      ok: false,
      reason: `the reflection unit could not be reached: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

export async function deliverReflectionWake(
  range?: ReflectionWakeRange,
): Promise<ReflectionWakeResult> {
  let hook: Awaited<ReturnType<typeof getHookByToken>>;
  try {
    hook = await getHookByToken(REFLECTION_TOKEN);
  } catch {
    return startReflectionRun(range);
  }
  const runId = (hook as { runId?: string } | null)?.runId ?? "";
  return { ok: true, delivered: "rung", runId };
}
