/**
 * Tool render state extraction — ported from Open Agents packages/shared/lib/tool-state.ts
 */
export type ToolRenderState = "running" | "interrupted" | "error" | "denied" | "done";

export function extractRenderState(
  state: string,
  isStreaming: boolean
): ToolRenderState {
  if (state === "output-error") return "error";
  if (state === "output-denied") return "denied";
  if (state === "output-available") return "done";
  if (state === "input-streaming" || state === "input-available") {
    return isStreaming ? "running" : "interrupted";
  }
  return "running";
}

export function getStatusColor(state: ToolRenderState): string {
  switch (state) {
    case "error":
    case "denied":
      return "text-destructive";
    case "running":
      return "text-blue-500";
    case "interrupted":
      return "text-yellow-500";
    case "done":
      return "text-green-500";
  }
}

const STATUS_WORDS = [
  "Pondering", "Thinking", "Crafting", "Analyzing",
  "Processing", "Reasoning", "Computing", "Working",
];

export function getStatusWord(messageId: string): string {
  let hash = 0;
  for (let i = 0; i < messageId.length; i++) {
    hash = (hash * 31 + messageId.charCodeAt(i)) | 0;
  }
  return STATUS_WORDS[Math.abs(hash) % STATUS_WORDS.length];
}

export function formatElapsedTime(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}
