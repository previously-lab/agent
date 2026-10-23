import type { UIMessage, UIMessageChunk } from "./protocol";
import type { ModelMessage, ModelPart } from "@/lib/deepseek/types";
import { fromNativeAssistant } from "@/lib/deepseek/messages";
import { z } from "zod";

/** Transport framing is owned by the application, with one SSE event per durable chunk. */
export function createUIMessageStreamResponse(opts: {stream: ReadableStream<UIMessageChunk>; headers?: HeadersInit; status?: number}): Response {
  const headers = new Headers(opts.headers);
  headers.set("content-type", "text/event-stream; charset=utf-8");
  headers.set("cache-control", "no-cache, no-transform");
  headers.set("x-accel-buffering", "no");
  const encoder = new TextEncoder();
  const stream = opts.stream.pipeThrough(new TransformStream<UIMessageChunk, Uint8Array>({
    transform(chunk, controller) { controller.enqueue(encoder.encode("data: " + JSON.stringify(chunk) + "\n\n")); },
    flush(controller) { controller.enqueue(encoder.encode("data: [DONE]\n\n")); },
  }));
  return new Response(stream, {status: opts.status ?? 200, headers});
}

const nativeAssistantSchema = z.object({
  role: z.literal("assistant"),
  content: z.string().nullable(),
  reasoning_content: z.string().nullable().optional(),
  tool_calls: z.array(z.object({
    id: z.string().min(1),
    type: z.literal("function"),
    function: z.object({ name: z.string().min(1), arguments: z.string() }),
  })).optional(),
});
const assistantPartSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), text: z.string() }),
  z.object({ type: z.literal("reasoning"), text: z.string() }),
  z.object({ type: z.literal("tool-call"), toolCallId: z.string().min(1), toolName: z.string().min(1), input: z.unknown() }),
]);
const assistantSchema = z.object({
  role: z.literal("assistant"),
  content: z.union([z.string(), z.array(assistantPartSchema)]),
  reasoning_content: z.string().optional(),
  deepseek: nativeAssistantSchema.optional(),
});
const toolResultSchema = z.object({
  type: z.literal("tool-result"), toolCallId: z.string().min(1), toolName: z.string().min(1),
  output: z.discriminatedUnion("type", [
    z.object({ type: z.enum(["text", "error-text"]), value: z.string() }),
    z.object({ type: z.enum(["json", "error-json"]), value: z.unknown() }),
  ]),
});
const toolMessageSchema = z.object({ role: z.literal("tool"), content: z.array(toolResultSchema).min(1) });

/** Live checkpoints contain one assistant response and all of its tool results;
 * completed-run recovery can carry several such groups in one record. Only
 * closed groups replay. Incomplete/foreign records fall back to visible text.
 */
function replayStep(data: unknown): ModelMessage[] | null {
  const parsed = z.object({ messages: z.array(z.unknown()).min(1) }).safeParse(data);
  if (!parsed.success) return null;
  const messages: ModelMessage[] = [];
  let remaining = new Map<string, string>();
  for (const raw of parsed.data.messages) {
    const parsedAssistant = assistantSchema.safeParse(raw);
    if (parsedAssistant.success) {
      if (remaining.size !== 0) return null;
      if (!parsedAssistant.data.deepseek && Array.isArray(parsedAssistant.data.content)
        && parsedAssistant.data.content.some((part) => part.type === "tool-call")) return null;
      const assistant: ModelMessage = parsedAssistant.data.deepseek
        ? fromNativeAssistant(parsedAssistant.data.deepseek)
        : parsedAssistant.data;
      const calls = typeof assistant.content === "string" ? [] : assistant.content.filter((p) => p.type === "tool-call");
      remaining = new Map(calls.map((call) => [call.toolCallId, call.toolName]));
      if (remaining.size !== calls.length) return null;
      messages.push(assistant);
      continue;
    }
    const tool = toolMessageSchema.safeParse(raw);
    if (!tool.success || messages.length === 0) return null;
    for (const result of tool.data.content) {
      if (remaining.get(result.toolCallId) !== result.toolName) return null;
      remaining.delete(result.toolCallId);
    }
    messages.push(tool.data);
  }
  return remaining.size === 0 ? messages : null;
}

/** Exact reasoning and raw argument strings survive complete native checkpoints.
 * Legacy chats and interrupted steps retain visible text without fabricated tool
 * calls. A later partial step must not disappear just because an earlier step
 * has a checkpoint. All client-supplied records pass an allowlist boundary.
 */
export async function convertToModelMessages(messages: UIMessage[]): Promise<ModelMessage[]> {
  const result: ModelMessage[] = [];
  for (const message of messages) {
    if (!message || (message.role !== "user" && message.role !== "assistant")) continue;
    let content: ModelPart[] = [];
    const flushVisible = () => {
      if (content.length) result.push({ role: message.role, content });
      content = [];
    };
    const parts = Array.isArray(message.parts) ? message.parts : [];
    for (const part of parts) {
      if (!part || typeof part !== "object") continue;
      if (part.type === "step-start" && message.role === "assistant") {
        flushVisible();
      } else if (part.type === "data-deepseek-step" && message.role === "assistant") {
        const replay = replayStep(part.data);
        if (replay) {
          result.push(...replay);
          // This checkpoint contains the preceding step's visible text and
          // reasoning already. Subsequent deltas remain a separate tail.
          content = [];
        }
      } else if (part.type === "text" && typeof part.text === "string") content.push({type:"text",text:part.text});
      else if (part.type === "reasoning" && message.role === "assistant" && typeof part.text === "string") content.push({type:"reasoning",text:part.text});
      else if (part.type === "file" && message.role === "user" && typeof part.mediaType === "string" && part.mediaType.startsWith("image/") && typeof part.url === "string") content.push({type:"image",image:part.url,mediaType:part.mediaType});
    }
    flushVisible();
  }
  return result;
}
