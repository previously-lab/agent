/**
 * Universal stream transform that handles both ModelCallStreamPart (from
 * WorkflowAgent) and UIMessageChunk (from streamText / our custom data chunks)
 * in a single readable stream.
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

/**
 * All UIMessageChunk type strings — when we see one of these, the chunk is
 * already a UIMessageChunk and should pass through unchanged.
 */
const UI_CHUNK_TYPES = new Set([
  "start",
  "start-step",
  "finish-step",
  "finish",
  "text-start",
  "text-delta",
  "text-end",
  "reasoning-start",
  "reasoning-delta",
  "reasoning-end",
  "tool-input-start",
  "tool-input-delta",
  "tool-input-available",
  "tool-input-error",
  "tool-output-available",
  "tool-output-error",
  "tool-approval-request",
  "tool-output-denied",
  "error",
  "source-url",
  "source-document",
  "file",
  "data-flash",
  "data-reasoning",
  "data-loop",
]);

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

      // Already a UIMessageChunk — pass through unchanged.
      if (chunkType && UI_CHUNK_TYPES.has(chunkType)) {
        controller.enqueue(chunk as UIMessageChunk);
        return;
      }

      // Try to convert from ModelCallStreamPart → UIMessageChunk.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const uiChunk = toUIMessageChunk(chunk as any);
      if (uiChunk) {
        controller.enqueue(uiChunk);
      }
    },
  });
}
