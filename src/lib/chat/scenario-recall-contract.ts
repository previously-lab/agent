import { z } from "zod";
import type { ModelMessage, StepResult, ToolResultOutput } from "@/lib/deepseek/types";
import { readReceipt, type ThinkingReadReceipt } from "@/lib/agents/thinking-read-receipt";

const recordRef = z.string().regex(/^records\/\d{4}-\d{2}-\d{2}-\d{4}$/);

export const scenarioRecallTargetSchema = z.object({
  ref: recordRef,
  turnId: z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/),
  role: z.enum(["user", "assistant"]),
  charOffset: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional()
    .describe("Optional continuation within this same turn, from coverage.targets[].nextCharOffset."),
}).strict();

export type ScenarioRecallTarget = z.infer<typeof scenarioRecallTargetSchema>;

export const scenarioRecallRequestSchema = z.object({
  question: z.string().trim().min(1).describe("The focused question to recover from earlier conversations, including relevant context and what remains uncertain."),
  refs: z.array(recordRef).optional()
    .describe("Known original conversation refs. Omit to let recollection locate scenarios. Semantic documents are outside this tool."),
  searchOtherRecords: z.boolean().optional()
    .describe("Set true when a known ref is only a starting point and the question needs other conversations too. A single already-read short record can otherwise return its verified original turns directly."),
  targets: z.array(scenarioRecallTargetSchema).optional()
    .describe("Known exact original messages. With targets alone, the host reads those messages by ID and role and returns verified original excerpts without a model search."),
  searchTerms: z.array(z.string().trim().min(1)).min(1).optional()
    .describe("Literal keywords to find in original user messages within the supplied refs only. Requires at least one ref; omit targets and cursor. No model or wider search is used."),
  matchOffset: z.number().int().nonnegative().optional()
    .describe("For a keyword lookup, use coverage.keywordSearch.nextMatchOffset with the same refs and terms to retrieve further matching messages."),
  after: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("Optional inclusive UTC slice-date lower bound, YYYY-MM-DD. Omit when uncertain."),
  before: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("Optional inclusive UTC slice-date upper bound, YYYY-MM-DD. Omit when uncertain."),
  cursor: recordRef.optional()
    .describe("Exclusive continuation cursor returned as coverage.nextCursor. If missing coverage matters, reuse the same question and date window to scan older records; omit for the newest page."),
}).strict().superRefine((request, context) => {
  if (request.searchTerms === undefined) {
    if (request.matchOffset !== undefined) context.addIssue({ code: "custom", path: ["matchOffset"], message: "matchOffset requires searchTerms" });
    return;
  }
  if (!request.refs?.length || request.targets !== undefined || request.cursor !== undefined || request.searchOtherRecords) {
    context.addIssue({
      code: "custom",
      path: ["searchTerms"],
      message: "searchTerms requires known refs and cannot be combined with targets, cursor, or searchOtherRecords",
    });
  }
});

export type ScenarioRecallRequest = z.infer<typeof scenarioRecallRequestSchema>;

/** A date window, continuation, exact target or wider search has its own coverage contract. */
export function singleRecordForVerification(request: ScenarioRecallRequest): string | undefined {
  if (request.refs?.length === 1 && !request.targets?.length && !request.after && !request.before &&
      !request.cursor && !request.searchTerms && !request.searchOtherRecords) return request.refs[0];
}

export type ConversationRecordReadRedirect = {
  kind: "recallScenario_required";
  ref: string;
  message: string;
};

/** Distinct from a legacy executor's raw string (including old durable steps). */
export interface PublicRecordReadResult {
  kind: "public_record_v1";
  status?: "deferred";
  scopeId: string;
  toolCallId: string;
  ref: string;
  text: string;
  thinkingReceipt?: ThinkingReadReceipt;
}

export function isPublicRecordRead(value: unknown): value is PublicRecordReadResult {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Partial<PublicRecordReadResult>;
  return record.kind === "public_record_v1" && typeof record.text === "string" &&
    typeof record.scopeId === "string" && typeof record.toolCallId === "string" &&
    typeof record.ref === "string" && recordRef.safeParse(record.ref).success;
}

/**
 * Classify every public spelling of an original conversation record. The main
 * agent must not turn aliases or storage paths back into raw transcript reads.
 */
export function canonicalConversationRecordRef(value: unknown): string | null {
  if (typeof value !== "string") return null;
  let ref = value.trim().replace(/[《》]/g, "").replaceAll("\\", "/").trim();
  ref = ref.replace(/^previously:/i, "").replace(/^\/+|\/+$/g, "");
  if (ref.endsWith(".md")) ref = ref.slice(0, -3);

  const direct = /^records\/(\d{4}-\d{2}-\d{2}-\d{4})$/.exec(ref);
  if (direct) return `records/${direct[1]}`;

  const current = /(?:^|\/)memory\/records\/(\d{4})\/(\d{2})\/(\d{2})\/(\d{4})(?:\/(?:core|agent|previously))?$/.exec(ref)
    ?? /(?:^|\/)records\/(\d{4})\/(\d{2})\/(\d{2})\/(\d{4})(?:\/(?:core|agent|previously))?$/.exec(ref);
  return current ? `records/${current[1]}-${current[2]}-${current[3]}-${current[4]}` : null;
}

export function createConversationRecordReadRedirect(value: unknown): ConversationRecordReadRedirect | null {
  const ref = canonicalConversationRecordRef(value);
  if (!ref) return null;
  return {
    kind: "recallScenario_required",
    ref,
    message: `Use recallScenario with a focused question and refs: [${JSON.stringify(ref)}]. A deliberate direct read can return public conversation turns from core only.`,
  };
}

/** The executor and the current-work result filter use the same public surface. */
export function directPublicRecordRef(input: unknown): string | null {
  if (!input || typeof input !== "object") return null;
  const { ref, direct, part } = input as { ref?: unknown; direct?: unknown; part?: unknown };
  if (direct !== true || (part !== undefined && part !== "core") || typeof ref !== "string") return null;
  if (/(?:^|[\\/])(?:agent|previously)(?:\.md)?[\\/]*$/i.test(ref.trim().replace(/[《》]/g, ""))) return null;
  return canonicalConversationRecordRef(ref);
}

export function withoutConversationEntryContent<T extends {
  ref: string;
  category: string;
  title: string;
  excerpt: string;
  navigation?: { kind: "navigation_only"; focus: string; summary: string };
}>(entry: T): T {
  if (entry.category !== "records" && entry.category !== "timeline" && !canonicalConversationRecordRef(entry.ref)) return entry;
  const focus = entry.navigation?.focus.trim();
  const summary = entry.navigation?.summary.trim();
  return {
    ...entry,
    title: `${focus || "Original conversation"} [navigation only; not evidence]`,
    excerpt: summary ? `${summary} [navigation only; not evidence]` : "",
  };
}

/** Replace only record rows in the facade's fixed, single-line rendering. */
export function withoutReplayedConversationEntryContent(value: string): string {
  return value.split("\n").map((line) => {
    const match = /^- \[([^\]]+)\] ([\s\S]*) \(ref: (records\/\d{4}-\d{2}-\d{2}-\d{4})\)$/.exec(line);
    if (!match) return line;
    const title = match[2]!.split(" — ")[0] || "Original conversation";
    return `- [${match[1]}] ${title} [navigation only; not evidence] (ref: ${match[3]})`;
  }).join("\n");
}

type ReplayToolCall = {
  name: string;
  ref?: unknown;
};

function replayToolCalls(message: ModelMessage): Array<{ id: string } & ReplayToolCall> {
  const structured = Array.isArray(message.content)
    ? message.content.flatMap((part) => part.type === "tool-call"
        ? [{ id: part.toolCallId, name: part.toolName, ref: typeof part.input === "object" && part.input !== null && "ref" in part.input
            ? (part.input as { ref?: unknown }).ref
            : undefined }]
        : [])
    : [];
  const native = (message.deepseek?.tool_calls ?? []).map((call) => {
    let input: unknown;
    try { input = JSON.parse(call.function.arguments); } catch { input = undefined; }
    return {
      id: call.id,
      name: call.function.name,
      ref: typeof input === "object" && input !== null && "ref" in input
        ? (input as { ref?: unknown }).ref
        : undefined,
    };
  });
  return [...structured, ...native];
}

const orphanedRead = { kind: "unattributed_tool_result",
  message: "The original request for this archived tool result is unavailable. Use a fresh read if its contents matter." } as const;
type ReplayRedirect = ConversationRecordReadRedirect | typeof orphanedRead;

function redirectForPayload(output: unknown, call: ReplayToolCall | undefined, name?: string): ReplayRedirect | null {
  // Native history serializes structured tool results as JSON strings.
  let payload = output;
  if (typeof output === "string" && output.trimStart().startsWith("{")) {
    try { payload = JSON.parse(output); } catch { /* Ordinary document prose. */ }
  }
  if (payload && typeof payload === "object" && "kind" in payload && payload.kind === "public_record_v1") {
    return createConversationRecordReadRedirect("ref" in payload ? payload.ref : undefined) ?? orphanedRead;
  }
  // A paired scenario report is itself the mediated view, including original-turn receipts.
  if (call?.name === "recallScenario" && (!name || name === "recallScenario") &&
      payload && typeof payload === "object" && "verification" in payload && payload.verification === "quote_and_source_only") return null;
  const receipt = readReceipt(payload);
  const read = receipt?.reads.find(entry => canonicalConversationRecordRef(entry.ref));
  if (read) return createConversationRecordReadRedirect(read.ref);
  if ((name === "recallRead" || call?.name === "recallRead") &&
      (call?.name !== "recallRead" || typeof call.ref !== "string" || !call.ref.trim() || (name && name !== call.name))) return orphanedRead;
  return !call && !name ? orphanedRead : null;
}

function redirectedOutput(output: ToolResultOutput, redirect: ReplayRedirect): ToolResultOutput {
  return output.type === "json" || output.type === "error-json"
    ? { ...output, value: redirect }
    : { ...output, value: JSON.stringify(redirect) };
}

/** Only result messages constructed by the runner for this work qualify.
 * Replayed input can copy a call ID, arguments and even a receipt. */
export function rememberPublicRecordReads(step: StepResult, scopeId: string | undefined, trusted: WeakSet<ModelMessage>): void {
  if (!scopeId) return;
  const directRefs = new Map(step.toolCalls.filter(call =>
    call.toolName === "recallRead" && !call.invalid).map(call => [call.toolCallId, directPublicRecordRef(call.input)]));
  for (const message of step.response.messages) {
    if (message.role !== "tool" || message.deepseek || !Array.isArray(message.content) || message.content.length !== 1) continue;
    const part = message.content[0];
    if (part.type !== "tool-result" || part.toolName !== "recallRead" || !isPublicRecordRead(part.output.value)) continue;
    const read = part.output.value;
    if (read.toolCallId !== part.toolCallId || read.scopeId !== scopeId || read.ref !== directRefs.get(part.toolCallId)) continue;
    if (step.toolResults.some(result => result.toolName === "recallRead" && result.toolCallId === part.toolCallId &&
        result.output === part.output.value)) trusted.add(message);
  }
}

/** Sanitize old raw-record tool output immediately before main-model use. */
export function mediateReplayedRecordReads(messages: ModelMessage[], trusted?: WeakSet<ModelMessage>): ModelMessage[] {
  const calls = new Map<string, ReplayToolCall>();
  const redirects = new Map<string, ConversationRecordReadRedirect>();
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    for (const call of replayToolCalls(message)) {
      calls.set(call.id, call);
      const redirect = call.name === "recallRead" ? createConversationRecordReadRedirect(call.ref) : null;
      if (redirect) redirects.set(call.id, redirect);
    }
  }

  return messages.map((message) => {
    if (message.role !== "tool" || trusted?.has(message)) return message;
    const nativeId = message.deepseek?.role === "tool" ? message.deepseek.tool_call_id : undefined;
    const nativeCall = nativeId ? calls.get(nativeId) : undefined;
    const nativePart = Array.isArray(message.content) ? message.content.find(part =>
      part.type === "tool-result" && part.toolCallId === nativeId) : undefined;
    const nativeRedirect = message.deepseek?.role === "tool" ? (nativeId && redirects.get(nativeId)) ||
      redirectForPayload(message.deepseek.content, nativeCall, nativePart?.type === "tool-result" ? nativePart.toolName : undefined) ||
      (nativePart?.type === "tool-result" ? redirectForPayload(nativePart.output.value, nativeCall, nativePart.toolName) : null) : null;
    const nativeContent = message.deepseek?.role === "tool" && typeof message.deepseek.content === "string"
      ? nativeRedirect
        ? JSON.stringify(nativeRedirect)
        : nativeCall && ["recallRecent", "recallFind", "recallSearch"].includes(nativeCall.name)
          ? withoutReplayedConversationEntryContent(message.deepseek.content)
          : message.deepseek.content
      : undefined;
    const nativeChanged = Boolean(
      message.deepseek?.role === "tool"
      && nativeContent !== undefined
      && nativeContent !== message.deepseek.content,
    );

    let contentChanged = false;
    let content = message.content;
    if (Array.isArray(content)) {
      content = content.map((part) => {
        if (part.type !== "tool-result") return part;
        const redirect = redirects.get(part.toolCallId) ?? redirectForPayload(part.output.value, calls.get(part.toolCallId), part.toolName)
          ?? (part.toolCallId === nativeId ? nativeRedirect : undefined);
        if (redirect) {
          contentChanged = true;
          return { ...part, output: redirectedOutput(part.output, redirect) };
        }
        const name = part.toolName || (nativeId ? calls.get(nativeId)?.name : undefined);
        if (name && ["recallRecent", "recallFind", "recallSearch"].includes(name)
          && (part.output.type === "text" || part.output.type === "error-text")) {
          const value = withoutReplayedConversationEntryContent(part.output.value);
          if (value !== part.output.value) {
            contentChanged = true;
            return { ...part, output: { ...part.output, value } };
          }
        }
        return part;
      });
    } else if (nativeRedirect) {
      content = JSON.stringify(nativeRedirect);
      contentChanged = true;
    } else if (nativeCall && ["recallRecent", "recallFind", "recallSearch"].includes(nativeCall.name)) {
      const value = withoutReplayedConversationEntryContent(content);
      if (value !== content) {
        content = value;
        contentChanged = true;
      }
    }

    return nativeChanged || contentChanged
      ? {
          ...message,
          content,
          ...(nativeChanged && message.deepseek?.role === "tool"
            ? { deepseek: { ...message.deepseek, content: nativeContent! } }
            : {}),
        }
      : message;
  });
}
