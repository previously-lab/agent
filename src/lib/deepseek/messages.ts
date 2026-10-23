import type { ModelMessage, NativeMessage, ModelPart, ToolResultOutput } from "./types";

function textContent(parts: ModelPart[]): string {
  return parts.filter((part) => part.type === "text").map((part) => part.text).join("");
}
function imageUrl(value: string | URL | Uint8Array, mediaType = "image/png"): string {
  if (typeof value === "string") return /^(https?:|data:)/.test(value) ? value : `data:${mediaType};base64,${value}`;
  if (value instanceof URL) return value.href;
  // This helper is also used in the deterministic workflow sandbox: no Buffer.
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let encoded = "";
  for (let i = 0; i < value.length; i += 3) {
    const n = (value[i] << 16) | ((value[i + 1] ?? 0) << 8) | (value[i + 2] ?? 0);
    encoded += alphabet[(n >>> 18) & 63] + alphabet[(n >>> 12) & 63] +
      (i + 1 < value.length ? alphabet[(n >>> 6) & 63] : "=") + (i + 2 < value.length ? alphabet[n & 63] : "=");
  }
  return `data:${mediaType};base64,${encoded}`;
}
function outputText(output: ToolResultOutput): string {
  return typeof output.value === "string" ? output.value : JSON.stringify(output.value) ?? "null";
}
export function toNativeMessages(messages: ModelMessage[]): NativeMessage[] {
  return messages.flatMap((message): NativeMessage[] => {
    if (message.deepseek) return [message.deepseek];
    if (typeof message.content === "string") return [{ role: message.role, content: message.content,
      ...(message.role === "assistant" ? { reasoning_content: message.reasoning_content ?? "" } : {}) }];
    const parts = message.content;
    if (message.role === "tool") return parts.flatMap((part) => part.type === "tool-result"
      ? [{ role: "tool" as const, tool_call_id: part.toolCallId, content: outputText(part.output) }] : []);
    if (message.role === "assistant") {
      const toolCalls = parts.flatMap((part) => part.type === "tool-call" ? [{ id: part.toolCallId, type: "function" as const,
        function: { name: part.toolName, arguments: JSON.stringify(part.input) } }] : []);
      return [{ role: "assistant", content: textContent(parts),
        reasoning_content: message.reasoning_content ?? parts.filter((part) => part.type === "reasoning").map((part) => part.text).join(""),
        ...(toolCalls.length ? { tool_calls: toolCalls } : {}) }];
    }
    if (message.role === "system") return [{ role: "system", content: textContent(parts) }];
    const content: Array<Record<string, unknown>> = parts.flatMap((part): Array<Record<string, unknown>> => {
      if (part.type === "text") return [{ type: "text", text: part.text }];
      if (part.type === "image") return [{ type: "image_url", image_url: { url: imageUrl(part.image, part.mediaType) } }];
      if (part.type === "file" && part.mediaType.startsWith("image/")) return [{ type: "image_url", image_url: { url: imageUrl(part.data, part.mediaType) } }];
      return [];
    });
    return [{ role: "user", content }];
  });
}
export function fromNativeAssistant(message: NativeMessage): ModelMessage {
  const content: ModelPart[] = [];
  if (message.reasoning_content) content.push({ type: "reasoning", text: message.reasoning_content });
  if (typeof message.content === "string" && message.content) content.push({ type: "text", text: message.content });
  for (const call of message.tool_calls ?? []) {
    let input: unknown;
    try { input = JSON.parse(call.function.arguments); } catch { input = call.function.arguments; }
    content.push({ type: "tool-call", toolCallId: call.id, toolName: call.function.name, input });
  }
  return { role: "assistant", content, deepseek: message, reasoning_content: message.reasoning_content ?? "" };
}
