/**
 * The mechanical bell (v0.38 §3.3) — the reflection unit's ONLY trigger, now
 * a PURE DOORBELL: the mailbox retired to a mutex (the short-lived run
 * loops while the world has work and exits when it doesn't), so the wake
 * carries NO payload at all. The unit's range is everything past its
 * on-disk cursor — content is never delivered by the bell.
 *
 * Delivery, one step: `getHookByToken(REFLECTION_TOKEN)` → a live run means
 * the unit IS UP and the ring is DONE (触发即完成 — the loop re-checks the
 * world every lap, so a ring at any point is absorbed; NEVER resumeHook,
 * the mailbox no longer exists as a queue). No live run → `start` a fresh
 * short-lived unit. A lost bell is made up by the next writer's bell (the
 * work sits on disk past the cursor), so a failure rides the result, never
 * an exception.
 *
 * Plain Node module, no "use step": the chat tail (steps.ts ringReflection)
 * and the writer wrap it. Importing reflectionRun statically is safe from
 * here: reflection-run → reflection-steps never reaches back (the steps'
 * impure edges are all DYNAMIC imports, precisely so this graph stays
 * acyclic).
 */
import { getHookByToken, start } from "workflow/api";
import { REFLECTION_TOKEN, reflectionRun } from "@/app/api/evolution/reflection-run";

export type ReflectionWakeResult =
  | { ok: true; delivered: "rung" | "started"; runId: string }
  | { ok: false; reason: string };

/** Start a fresh short-lived reflection unit (a dead/absent token is free). */
async function startReflectionRun(): Promise<ReflectionWakeResult> {
  try {
    // Same start config as the question sub-flow — background runs live in
    // one region, not two. No payload: the bell carries no work (§3.3).
    const run = await start(reflectionRun, [], { region: "hkg1" });
    return { ok: true, delivered: "started", runId: run.runId };
  } catch (e) {
    return {
      ok: false,
      reason: `the reflection unit could not be reached: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

/**
 * Deliver the bell. `getHookByToken` resolves → the unit is alive and the
 * ring is complete (NO resumeHook — a live short-lived loop wakes only from
 * its own world re-checks… and from nothing else, which is exactly why a
 * ring means "keep looping": the loop never blocks between laps, so any
 * bell landing while it lives is redundant by construction). It rejects →
 * no live unit → start one. Never throws.
 */
export async function deliverReflectionWake(): Promise<ReflectionWakeResult> {
  try {
    const hook = await getHookByToken(REFLECTION_TOKEN);
    return {
      ok: true,
      delivered: "rung",
      runId: (hook as { runId?: string } | null)?.runId ?? "",
    };
  } catch {
    return startReflectionRun();
  }
}
