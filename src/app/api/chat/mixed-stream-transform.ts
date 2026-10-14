/**
 * Universal stream transform that handles both ModelCallStreamPart (from
 * WorkflowAgent) and UIMessageChunk (from our custom data chunks) in a
 * single readable stream.
 *
 * The built-in `createModelCallToUIChunkTransform()` from @ai-sdk/workflow
 * drops unknown chunk types in its default case. This version is universal:
 * it passes through any UIMessageChunk type unchanged, and only falls back
 * to `toUIMessageChunk()` for ModelCallStreamPart types.
 *
 * Used by the chat route to pipe a workflow run's readable into a
 * UIMessageStream that the client can consume.
 */

import { toUIMessageChunk } from "@ai-sdk/workflow";
import type { UIMessageChunk } from "ai";
import { PARALLEL_SUMMARY_CHUNK } from "@/lib/chat/parallel-runs";

/**
 * Chunks OUR code writes into the run stream — the only chunks allowed to
 * pass through unchanged:
 * - lifecycle (`start` / `start-step` / `finish-step` / `finish`) written by
 *   the workflow steps, plus step-boundary markers written by WorkflowAgent
 * - `data-belief` / `data-phase` — our custom data chunks
 *
 * Everything else must go through `toUIMessageChunk()`. The `finish` type is
 * ambiguous (ours vs. raw model finish part), so it's discriminated by shape.
 *
 * A chunk type missing HERE is dead on both the POST path and the reconnect
 * path at once (toUIMessageChunk drops it silently) — v0.33's summary chunk
 * shipped exactly that way, so add the constant, never the string.
 */
const OUR_CHUNK_TYPES = new Set([
  "start",
  "start-step",
  "finish-step",
  "data-belief",
  "data-phase",
  "data-evolution",
  "data-turn-status",
  "data-tool-progress",
  // v0.10 §4.1 — recall's evidence anchors for the references bar.
  "data-recall-references",
  // v0.30 §4.2 — the episode's nested-bubble lifecycle frames (transient:
  // they feed the client's side store via onData, never UIMessage parts).
  "data-nested-bubble",
  // v0.33 §3 — the batch summary's runId on the last finisher's stream.
  PARALLEL_SUMMARY_CHUNK,
]);

function isOurs(c: Record<string, unknown>, chunkType: string): boolean {
  if (OUR_CHUNK_TYPES.has(chunkType)) return true;
  if (chunkType === "finish") return !("finishReason" in c);
  return false;
}

/**
 * Creates a TransformStream that:
 * 1. Passes all known UIMessageChunk types through unchanged
 * 2. Converts ModelCallStreamPart → UIMessageChunk via toUIMessageChunk
 * 3. Silently drops truly unknown chunks
 *
 * Deliberately STATELESS and ~1:1: lifecycle chunks (start / start-step /
 * finish-step / finish) are written into the durable run stream by the
 * workflow steps themselves (housekeeping / finalizeTurn), never injected
 * here. WorkflowChatTransport resumes by chunk index against the raw run
 * stream — per-connection injection would desynchronize the POST path and
 * the reconnect path.
 */
export function createMixedStreamTransform(): TransformStream<
  unknown,
  UIMessageChunk
> {
  return new TransformStream<unknown, UIMessageChunk>({
    transform(chunk: unknown, controller) {
      const c = chunk as Record<string, unknown>;
      const chunkType = typeof c?.type === "string" ? c.type : undefined;

      // One of ours — pass through.
      if (chunkType && isOurs(c, chunkType)) {
        controller.enqueue(chunk as UIMessageChunk);
        return;
      }

      // Try to convert from ModelCallStreamPart → UIMessageChunk.
      const uiChunk = toUIMessageChunk(chunk as never);
      if (uiChunk) {
        controller.enqueue(uiChunk);
      }
    },
  });
}
