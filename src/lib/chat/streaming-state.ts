/**
 * Streaming state helpers — ported from Open Agents apps/web/lib/chat-streaming-state.ts
 */
import type { UIMessage } from "ai";

export function isChatInFlight(status: string): boolean {
  return status === "submitted" || status === "streaming";
}

export function getLastAssistantMessage(messages: UIMessage[]): UIMessage | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "assistant") return messages[i];
  }
  return null;
}

export function hasRenderableContent(message: UIMessage): boolean {
  return message.parts?.some(
    (p) => p.type === "text" || (p.type?.startsWith("tool-") && (p as { state?: string }).state === "output-available")
  ) ?? false;
}

export function shouldShowThinkingIndicator(
  status: string,
  messages: UIMessage[]
): boolean {
  if (!isChatInFlight(status)) return false;
  const last = getLastAssistantMessage(messages);
  if (!last) return false;
  return !hasRenderableContent(last);
}

export function shouldKeepCollapsedReasoningStreaming(
  isStreaming: boolean,
  hasRenderableAfter: boolean
): boolean {
  return isStreaming && !hasRenderableAfter;
}
