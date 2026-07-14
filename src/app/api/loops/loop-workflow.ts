/**
 * Durable loop workflow — the core of the "I come after you're done" engine.
 *
 * A loop takes a goal and works it in steps, backed by a Vercel Workflow run so
 * it survives deploys and cold starts. Each step reasons one increment toward
 * the goal; its result is persisted to the loop's markdown file IMMEDIATELY, so
 * progress is visible in memory/ the moment it happens.
 *
 * This module is the deterministic controller: NO direct I/O and no Node.js
 * modules in its import graph. Every LLM call and file write lives behind the
 * `"use step"` functions in ./steps, imported here by reference only.
 *
 * Lives under src/app so the `withWorkflow` loader (which scans app/src/app by
 * default) picks up the `"use workflow"` directive.
 */
import type { LoopInput, LoopResult, LoopStep, LoopStatus } from "@/lib/loops/types";
import { detectNoProgress } from "@/lib/loops/guards";
import { runLoopStep, persistLoop } from "./steps";

export async function loopWorkflow(input: LoopInput): Promise<LoopResult> {
  "use workflow";

  const steps: LoopStep[] = [];

  // Create the record up front so the human sees "running" immediately.
  await persistLoop(input, steps, "running", "");

  let status: LoopStatus = "running";

  try {
    for (let iteration = 1; iteration <= input.maxIterations; iteration++) {
      const next = await runLoopStep(input, steps);
      steps.push(next.step);

      if (next.done) {
        status = "completed";
        await persistLoop(input, steps, status, "");
        break;
      }

      if (detectNoProgress(steps)) {
        status = "stuck";
        await persistLoop(
          input,
          steps,
          status,
          "No progress across the last 3 steps."
        );
        break;
      }

      // Real-time writeback after each step.
      await persistLoop(input, steps, "running", "");
    }

    if (status === "running") {
      status = "timeout";
      await persistLoop(
        input,
        steps,
        status,
        `Hit max iterations (${input.maxIterations}).`
      );
    }
  } catch (err) {
    status = "failed";
    const message = err instanceof Error ? err.message : "unknown error";
    await persistLoop(input, steps, status, message);
  }

  return { loopId: input.loopId, status, iterations: steps.length };
}
