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

// Shows a "recalling…" placeholder while the request is in flight but no
// assistant content has rendered yet — i.e. during the pre-stream Flash window,
// so the user sees activity from the moment they send.
export function shouldShowThinkingIndicator(
  status: string,
  messages: UIMessage[]
): boolean {
  if (!isChatInFlight(status)) return false;
  const last = messages[messages.length - 1];
  if (!last) return false;
  if (last.role === "user") return true;
  if (last.role === "assistant") return !hasRenderableContent(last);
  return false;
}

export function shouldKeepCollapsedReasoningStreaming(
  isStreaming: boolean,
  hasRenderableAfter: boolean
): boolean {
  return isStreaming && !hasRenderableAfter;
}
