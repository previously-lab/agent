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
 * Chunks OUR code writes into the run stream — the only chunks allowed to
 * pass through unchanged:
 * - lifecycle (`start` / `start-step` / `finish-step` / `finish`) written by
 *   the workflow steps, plus `finish-step` / `start-step` step-boundary
 *   markers written by WorkflowAgent itself — all already UI-shaped
 * - `data-flash` / `data-loop` / `data-reasoning` (legacy, from old runs)
 *
 * Everything else must go through `toUIMessageChunk()`. Type strings alone
 * are NOT proof a chunk is UI-shaped: raw model parts SHARE type strings
 * with UI chunks but use different fields — `text-delta` / `reasoning-delta`
 * carry `text` (UI chunks carry `delta`), `tool-input-start` carries `id`
 * (UI chunks carry `toolCallId`). Passing those through unchanged breaks
 * client-side UIMessageChunk validation.
 */
const OUR_CHUNK_TYPES = new Set([
  "start",
  "start-step",
  "finish-step",
  "data-flash",
  "data-reasoning",
  "data-loop",
]);

/**
 * `finish` is ambiguous: ours is exactly `{ type: "finish" }`; a raw model
 * finish part (if one ever flows through) carries `finishReason` / `usage`.
 * Legacy `text-delta` / `reasoning-delta` chunks from pre-WorkflowAgent runs
 * (streamText era) used the UI `delta` field, while raw model parts use
 * `text` — discriminate by shape so old-run replays keep rendering.
 */
function isOurs(c: Record<string, unknown>, chunkType: string): boolean {
  if (OUR_CHUNK_TYPES.has(chunkType)) return true;
  if (chunkType === "finish") return !("finishReason" in c);
  if (chunkType === "text-delta" || chunkType === "reasoning-delta") {
    return typeof c.delta === "string";
  }
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

      // One of ours (or a legacy UI chunk from an old run) — pass through.
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
