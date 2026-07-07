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
    (p) =>
      p.type === "text" ||
      p.type === "data-flash" ||
      p.type === "reasoning" ||
      (p.type?.startsWith("tool-") && (p as { state?: string }).state === "output-available")
  ) ?? false;
}

// Removed M8: outside "Thinking..." indicator is redundant with bubble-internal
// recall phase + reasoning display. Kept as no-op for backward compat.
export function shouldShowThinkingIndicator(
  _status: string,
  _messages: UIMessage[]
): boolean {
  return false;
}

export function shouldKeepCollapsedReasoningStreaming(
  isStreaming: boolean,
  hasRenderableAfter: boolean
): boolean {
  return isStreaming && !hasRenderableAfter;
}
