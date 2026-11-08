/**
 * Safe, resumable projection of a thinking work's durable model stream.
 * Raw tool payloads, provider details and native source never cross the route
 * boundary. Only allowlisted, display-safe tool subjects and outcomes are
 * projected. The per-turn thoughts endpoint can explicitly include model
 * reasoning in a separate channel. Replaying the prefix also makes a
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

export type WorkPreviewToolOutcome = "found" | "empty";

export type WorkPreviewToolSignal = {
  type: "tool";
  toolCallId: string;
  toolName: string;
  state: "running" | "completed" | "failed";
  /** A short label derived server-side from one allowlisted input field. */
  subject?: string;
  /** Additional result semantics only when the tool contract proves them. */
  outcome?: WorkPreviewToolOutcome;
  resultCount?: number;
};

export type WorkPreviewEvent = WorkPreviewEnvelope & (
  | { type: "status"; status: WorkPreviewStatus; retryAfterMs?: number }
  | { type: "text"; partId?: string; delta: string }
  | { type: "reasoning"; partId?: string; delta: string }
  | WorkPreviewToolSignal
);

export type WorkPreviewSignal =
  | { type: "text"; partId?: string; delta: string }
  | { type: "reasoning"; partId?: string; delta: string }
  | WorkPreviewToolSignal;

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

const MAX_SUBJECT_CODE_POINTS = 96;
const DOCUMENT_CATEGORIES = new Set([
  "events", "people", "things", "tasks", "research", "self", "timeline", "records", "places", "orgs",
]);

function textSubject(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const clean = value.replace(/[\p{Cc}\p{Cf}]/gu, "").replace(/\s+/g, " ").trim();
  if (!clean) return undefined;
  const characters = Array.from(clean);
  return characters.length > MAX_SUBJECT_CODE_POINTS
    ? characters.slice(0, MAX_SUBJECT_CODE_POINTS - 1).join("") + "…"
    : clean;
}

/** Show only the site; credentials and access tokens can live in the URL path as well. */
function webPageSubject(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 4096) return undefined;
  try {
    const url = new URL(value);
    if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username || url.password || !url.host) {
      return undefined;
    }
    return textSubject(url.hostname);
  } catch {
    return undefined;
  }
}

/** Free-form questions often continue with pasted evidence. Use only their
 * first non-empty line, and reduce embedded HTTP(S) URLs to a hostname.
 * Credentialed URLs are removed entirely. */
function topicSubject(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const firstLine = value.split(/\r\n?|\n/).find(line => line.trim());
  if (!firstLine) return undefined;
  const safeLine = firstLine.replace(/https?:\/\/[^\s<>"'「」『』“”‘’，。；：！？、）》】]+/giu,
    segment => webPageSubject(segment) ?? "");
  return textSubject(safeLine);
}

/** Refs are user-facing document identities, never storage paths or links
 * carrying location/query data. Bare legacy document names remain valid. */
function documentSubject(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 512) return undefined;
  const ref = value.trim();
  if (!ref || /[\p{Cc}\p{Cf}?#\\]/u.test(ref) || /%[0-9a-f]{2}/i.test(ref) ||
    /^(?:memory|sessions|tasks)(?:\/|$)/i.test(ref) || /^[a-z][a-z0-9+.-]*:\/\//i.test(ref)) {
    return undefined;
  }
  const segments = ref.split("/");
  if (segments.some(segment => !segment || segment === "." || segment === "..") || segments.length > 3) {
    return undefined;
  }
  if (segments[0] === "records") {
    return /^records\/\d{4}-\d{2}-\d{2}-\d{4}$/.test(ref) ? textSubject(ref) : undefined;
  }
  if (segments.length > 1 && !DOCUMENT_CATEGORIES.has(segments[0])) return undefined;
  return textSubject(ref);
}

function toolSubject(toolName: string, input: unknown): string | undefined {
  const record = asRecord(input);
  if (!record) return undefined;
  if (toolName === "webSearch") return topicSubject(record.query);
  if (toolName === "webFetch") return webPageSubject(record.url);
  if (toolName === "recallRead") return documentSubject(record.ref);
  if (toolName === "recallSearch") return topicSubject(record.query);
  if (toolName === "recallScenario" || toolName === "thinkDeep") return topicSubject(record.question);
  return undefined;
}

interface ToolResultProjection {
  failed?: boolean;
  outcome?: WorkPreviewToolOutcome;
  resultCount?: number;
}

function outputValue(output: unknown): unknown {
  const record = asRecord(output);
  return record && (record.type === "json" || record.type === "error-json" ||
    record.type === "text" || record.type === "error-text") && "value" in record
    ? record.value
    : output;
}

/** Read only contract fields that establish a lightweight public outcome.
 * Unknown shapes deliberately produce no outcome rather than a guess. */
function toolResultProjection(toolName: string, rawOutput: unknown): ToolResultProjection {
  const output = outputValue(rawOutput);
  if (toolName === "webFetch" || toolName === "recallRead") {
    if (typeof output !== "string") return {};
    if (output.startsWith("ERROR:") || output.startsWith("This could not be read right now (")) {
      return { failed: true };
    }
    if (toolName === "recallRead" && output.startsWith("Nothing named \"")) return { outcome: "empty", resultCount: 0 };
    if (toolName === "webFetch" && !output.trim()) return { outcome: "empty", resultCount: 0 };
    return {};
  }
  const record = asRecord(output);
  if (!record) return {};
  if (toolName === "webSearch") {
    if (typeof record.error === "string") return { failed: true };
    if (!Array.isArray(record.sources)) return {};
    const resultCount = record.sources.length;
    return { outcome: resultCount > 0 ? "found" : "empty", resultCount };
  }
  if (toolName === "recallScenario") {
    if (record.status === "error") return { failed: true };
    if (!Array.isArray(record.evidence)) return {};
    const resultCount = record.evidence.length;
    if (resultCount > 0) return { outcome: "found", resultCount };
    return record.status === "ok" || record.status === "insufficient_evidence"
      ? { outcome: "empty", resultCount }
      : {};
  }
  if (toolName === "thinkDeep" && record.status === "error") return { failed: true };
  return {};
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
export function createWorkPreviewFilter({ includeReasoning = false }: { includeReasoning?: boolean } = {}) {
  const text = new Map<string, TextState>();
  const tools = new Map<string, Omit<WorkPreviewToolSignal, "type">>();

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
    detail: { subject?: string; outcome?: WorkPreviewToolOutcome; resultCount?: number } = {},
  ): WorkPreviewSignal | null {
    const prior = tools.get(toolCallId);
    const name = (toolName ?? prior?.toolName ?? "tool").slice(0, 128);
    const subject = detail.subject ?? prior?.subject;
    const outcome = state === "completed" ? detail.outcome : undefined;
    const resultCount = outcome === undefined ? undefined : detail.resultCount;
    // Native streams emit both tool-input-start and tool-call. Suppress only
    // exact duplicates: an input-available frame may add the public subject.
    if (prior?.state === state && prior.toolName === name && prior.subject === subject &&
      prior.outcome === outcome && prior.resultCount === resultCount) return null;
    const next: Omit<WorkPreviewToolSignal, "type"> = {
      toolCallId, toolName: name, state,
      ...(subject ? { subject } : {}),
      ...(outcome ? { outcome } : {}),
      ...(resultCount !== undefined ? { resultCount } : {}),
    };
    tools.set(toolCallId, next);
    return { type: "tool", ...next };
  }

  return {
    push(value: unknown): WorkPreviewSignal | null {
      const chunk = asRecord(value);
      const type = chunk?.type;
      if (!chunk || typeof type !== "string") return null;

      if (includeReasoning && type === "reasoning-delta") {
        const delta = typeof chunk.delta === "string" ? chunk.delta
          : typeof chunk.text === "string" ? chunk.text : "";
        return delta ? { type: "reasoning", ...(typeof chunk.id === "string" ? { partId: chunk.id } : {}), delta } : null;
      }
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
      if (type === "tool-input-start") {
        return toolSignal(toolCallId, toolName, "running");
      }
      if (type === "tool-input-available") {
        return toolSignal(toolCallId, toolName, "running", { subject: toolName ? toolSubject(toolName, chunk.input) : undefined });
      }
      if (type === "tool-call") {
        return toolSignal(toolCallId, toolName, chunk.invalid === true ? "failed" : "running", {
          subject: chunk.invalid === true || !toolName ? undefined : toolSubject(toolName, chunk.input),
        });
      }
      if (type === "tool-input-error" || type === "tool-output-error" || type === "tool-error") {
        return toolSignal(toolCallId, toolName, "failed");
      }
      if (type === "tool-result" || type === "tool-output-available") {
        const name = toolName ?? tools.get(toolCallId)?.toolName ?? "tool";
        const result = toolResultProjection(name, chunk.output);
        return toolSignal(toolCallId, name, chunk.isError === true || result.failed ? "failed" : "completed", result);
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
