/**
 * Safe, resumable projection of a thinking work's durable model stream.
 * Raw reasoning, tool payloads, provider details and native source never cross
 * the route boundary. Replaying the prefix through this filter also makes a
 * reconnect inside a native fence safe.
 */
import { parseNativeSections } from "@/lib/markdown/native-sections";

export type WorkPreviewTerminalStatus = "completed" | "failed" | "cancelled";
export type WorkPreviewStatus = "waiting" | "live" | WorkPreviewTerminalStatus;

interface WorkPreviewEnvelope {
  workId: string;
  runId?: string;
  /** The next raw durable-stream index. Pass it back as startIndex. */
  cursor: number;
}

export type WorkPreviewEvent = WorkPreviewEnvelope & (
  | { type: "status"; status: WorkPreviewStatus; retryAfterMs?: number }
  | { type: "text"; partId?: string; delta: string }
  | { type: "tool"; toolCallId: string; toolName: string; state: "running" | "completed" | "failed" }
);

export type WorkPreviewSignal =
  | { type: "text"; partId?: string; delta: string }
  | { type: "tool"; toolCallId: string; toolName: string; state: "running" | "completed" | "failed" };

interface TextState {
  source: string;
  emitted: string;
  invalid: boolean;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

/** Hold a trailing line that can still become a root-level `html live` fence.
 * Ordinary prose streams immediately; only a possible fence opener waits for
 * enough bytes to prove what it is. An unfinished opener is never released. */
function withoutPossibleNativeOpener(source: string): string {
  const lineStart = Math.max(source.lastIndexOf("\n"), source.lastIndexOf("\r")) + 1;
  const tail = source.slice(lineStart);
  const match = /^ {0,3}(`+)([^`]*)$/.exec(tail);
  if (!match) return source;
  const info = match[2].trimStart();
  if ("html live".startsWith(info) || /^html[ \t]+live(?:[ \t]|$)/.test(info)) {
    return source.slice(0, lineStart);
  }
  return source;
}

/** Native HTML is removed by parseNativeSections. For malformed or ordinary
 * Markdown HTML, stop this Markdown section before the first tag-like token.
 * That conservative cut also prevents raw script/style bodies from becoming
 * preview text. A trailing `<` remains pending rather than becoming structure. */
function displayableMarkdown(source: string): string {
  const tag = /<(?=[A-Za-z!/?])/.exec(source);
  if (tag) return source.slice(0, tag.index);
  return source.endsWith("<") ? source.slice(0, -1) : source;
}

function displayablePrefix(source: string): string {
  return parseNativeSections(withoutPossibleNativeOpener(source))
    .flatMap((section) => section.kind === "markdown" ? [displayableMarkdown(section.source)] : [])
    .join("");
}

/** One filter instance per HTTP attachment. Raw chunks are replayed from zero
 * on resume, so this state always represents the complete prefix even when
 * the client's cursor points into the middle of a structure. */
export function createWorkPreviewFilter() {
  const text = new Map<string, TextState>();
  const tools = new Map<string, { toolName: string; state: "running" | "completed" | "failed" }>();

  function textDelta(partId: string, delta: string): WorkPreviewSignal | null {
    const state = text.get(partId) ?? { source: "", emitted: "", invalid: false };
    text.set(partId, state);
    if (state.invalid) return null;
    state.source += delta;
    const visible = displayablePrefix(state.source);
    // Never reinterpret bytes that are already visible. An unknown provider
    // shape that breaks this invariant suppresses the rest of the part.
    if (!visible.startsWith(state.emitted)) {
      state.invalid = true;
      return null;
    }
    const next = visible.slice(state.emitted.length);
    state.emitted = visible;
    if (!next) return null;
    return { type: "text", ...(partId ? { partId } : {}), delta: next };
  }

  function toolSignal(
    toolCallId: string,
    toolName: string | undefined,
    state: "running" | "completed" | "failed",
  ): WorkPreviewSignal | null {
    const prior = tools.get(toolCallId);
    const name = (toolName ?? prior?.toolName ?? "tool").slice(0, 128);
    // Native streams emit both tool-input-start and tool-call. One running
    // frame is enough; replay still reconstructs the name for result frames.
    if (prior?.state === "running" && state === "running") return null;
    tools.set(toolCallId, { toolName: name, state });
    return { type: "tool", toolCallId, toolName: name, state };
  }

  return {
    push(value: unknown): WorkPreviewSignal | null {
      const chunk = asRecord(value);
      const type = chunk?.type;
      if (!chunk || typeof type !== "string") return null;

      // reasoning_content is carried by reasoning-delta/data-reasoning in
      // different run generations. Neither is user-displayable preview text.
      if (type === "text-delta") {
        const delta = typeof chunk.delta === "string" ? chunk.delta
          : typeof chunk.text === "string" ? chunk.text : "";
        if (!delta) return null;
        return textDelta(nonEmptyString(chunk.id) ?? "", delta);
      }
      if (type === "text-end") {
        const partId = nonEmptyString(chunk.id) ?? "";
        const state = text.get(partId);
        text.delete(partId);
        if (!state || state.invalid) return null;
        const visible = displayablePrefix(state.source);
        if (!visible.startsWith(state.emitted)) return null;
        const next = visible.slice(state.emitted.length);
        return next ? { type: "text", ...(partId ? { partId } : {}), delta: next } : null;
      }

      const toolCallId = nonEmptyString(chunk.toolCallId) ?? nonEmptyString(chunk.id);
      if (!toolCallId) return null;
      const toolName = nonEmptyString(chunk.toolName);
      if (type === "tool-input-start" || type === "tool-input-available") {
        return toolSignal(toolCallId, toolName, "running");
      }
      if (type === "tool-call") {
        return toolSignal(toolCallId, toolName, chunk.invalid === true ? "failed" : "running");
      }
      if (type === "tool-input-error" || type === "tool-output-error" || type === "tool-error") {
        return toolSignal(toolCallId, toolName, "failed");
      }
      if (type === "tool-result" || type === "tool-output-available") {
        return toolSignal(toolCallId, toolName, chunk.isError === true ? "failed" : "completed");
      }
      return null;
    },
  };
}

export function workPreviewCursor(value: string | null): number {
  if (value === null || value.trim() === "") return 0;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 0;
}
