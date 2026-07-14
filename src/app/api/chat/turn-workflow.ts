/**
 * Durable chat-turn workflow — every chat turn runs inside one of these.
 *
 * The deterministic controller: NO direct I/O and no Node.js modules in its
 * import graph. It threads the time-slice by value through the three steps,
 * re-binding it after each mutating step (the module-global `activeSlice` is
 * unusable here — steps run in separate invocations). Every LLM call, file
 * read/write, and stream write lives behind the `"use step"` functions in
 * ./steps, imported here by reference only.
 *
 * GitHub remains the source of truth for memory: the steps write slices,
 * indexes, strands, notes, and loop files straight to the repo. The workflow is
 * only the execution container that makes the turn durable and resumable.
 *
 * Lives under src/app so the `withWorkflow` loader (which scans app/src/app by
 * default) picks up the `"use workflow"` directive.
 */
import type { TurnInput } from "@/lib/chat/turn-types";
import { housekeeping, flashRecall, generate } from "./steps";

export async function turnWorkflow(input: TurnInput): Promise<void> {
  "use workflow";

  const { slice } = await housekeeping(input);
  const flash = await flashRecall(input, slice);
  await generate(input, flash.slice, flash.flashOutput, flash.flashMs);
}
