import type { UIMessageChunk } from "@/lib/chat/protocol";

const LIFECYCLE = new Set(["start", "start-step", "finish-step", "reset-step", "text-start", "text-end", "reasoning-start", "reasoning-end"]);
const OLD_ENVELOPES = new Set(["model-call-start", "model-call-end", "model-call-response-metadata", "raw", "tool-input-end"]);
const errorText = (value: unknown) => value instanceof Error ? value.message : String(value ?? "Unknown error");

/** Native runs already use the app protocol. Keep old durable runs readable
 * while they drain: their per-model finish is not a terminal conversation. */
export function createMixedStreamTransform(): TransformStream<unknown, UIMessageChunk> {
  return new TransformStream({ transform(value, controller) {
    if (!value || typeof value !== "object" || !("type" in value) || typeof value.type !== "string") return;
    const chunk = value as UIMessageChunk & Record<string, unknown>;
    const send = (next: UIMessageChunk) => controller.enqueue(next);
    if (OLD_ENVELOPES.has(chunk.type)) return;
    if (chunk.type === "finish") {
      if (!("finishReason" in chunk) || chunk.protocol === "deepseek-v1") send(chunk);
      return;
    }
    if ((chunk.type === "text-delta" || chunk.type === "reasoning-delta") && chunk.delta === undefined) {
      const { text, ...rest } = chunk;
      send({ ...rest, delta: typeof text === "string" ? text : "" });
      return;
    }
    if ((chunk.type === "tool-input-start" || chunk.type === "tool-input-delta") && !chunk.toolCallId) {
      send(chunk.type === "tool-input-start"
        ? { type: "tool-input-start", toolCallId: chunk.id, toolName: chunk.toolName }
        : { type: "tool-input-delta", toolCallId: chunk.id, inputTextDelta: chunk.delta });
      return;
    }
    if (chunk.type === "tool-call") {
      send({ type: chunk.invalid ? "tool-input-error" : "tool-input-available", toolCallId: chunk.toolCallId,
        toolName: chunk.toolName, input: chunk.input, ...(chunk.invalid ? { errorText: errorText(chunk.error) } : {}) });
      return;
    }
    if (chunk.type === "tool-result") { send({ type: "tool-output-available", toolCallId: chunk.toolCallId, output: chunk.output }); return; }
    if (chunk.type === "tool-error") { send({ type: "tool-output-error", toolCallId: chunk.toolCallId, errorText: errorText(chunk.error) }); return; }
    if (chunk.type === "error" && !chunk.errorText) { send({ type: "error", errorText: errorText(chunk.error) }); return; }
    if (LIFECYCLE.has(chunk.type) || chunk.type.startsWith("data-") || chunk.type.startsWith("tool-") ||
      chunk.type.startsWith("source-") || ["file", "error", "text-delta", "reasoning-delta"].includes(chunk.type)) send(chunk);
  } });
}
