import { z } from "zod";
import type { ModelMessage, ToolResultOutput } from "@/lib/deepseek/types";

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
  question: z.string().trim().min(1).max(4000).describe("The focused question to recover from earlier conversations, including relevant context and what remains uncertain."),
  refs: z.array(recordRef).max(4).optional()
    .describe("Up to four known original conversation refs. Omit to let recollection locate scenarios. Semantic documents are outside this tool."),
  targets: z.array(scenarioRecallTargetSchema).max(8).optional()
    .describe("Known exact original messages. With targets alone, the host reads those messages by ID and role and returns verified original excerpts without a model search."),
  searchTerms: z.array(z.string().trim().min(1).max(80)).min(1).max(5).optional()
    .describe("Literal keywords to find in original user messages within the supplied refs only. Requires at least one ref; omit targets and cursor. No model or wider search is used."),
  after: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("Optional inclusive UTC slice-date lower bound, YYYY-MM-DD. Omit when uncertain."),
  before: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("Optional inclusive UTC slice-date upper bound, YYYY-MM-DD. Omit when uncertain."),
  cursor: recordRef.optional()
    .describe("Exclusive continuation cursor returned as coverage.nextCursor. Repeat the same question and date window to scan older records; omit for the newest page."),
}).strict().superRefine((request, context) => {
  if (request.searchTerms === undefined) return;
  if (!request.refs?.length || request.targets !== undefined || request.cursor !== undefined) {
    context.addIssue({
      code: "custom",
      path: ["searchTerms"],
      message: "searchTerms requires one to four refs and cannot be combined with targets or cursor",
    });
  }
});

export type ScenarioRecallRequest = z.infer<typeof scenarioRecallRequestSchema>;

export type ConversationRecordReadRedirect = {
  kind: "recallScenario_required";
  ref: string;
  message: string;
};

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
    message: `Original conversation records are mediated. Call recallScenario with a focused question and refs: [${JSON.stringify(ref)}]. recallRead does not return raw record content to the main agent.`,
  };
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

function redirectedOutput(output: ToolResultOutput, redirect: ConversationRecordReadRedirect): ToolResultOutput {
  return output.type === "json" || output.type === "error-json"
    ? { ...output, value: redirect }
    : { ...output, value: JSON.stringify(redirect) };
}

/** Sanitize old raw-record tool output immediately before main-model use. */
export function mediateReplayedRecordReads(messages: ModelMessage[]): ModelMessage[] {
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
    if (message.role !== "tool") return message;
    const nativeId = message.deepseek?.role === "tool" ? message.deepseek.tool_call_id : undefined;
    const nativeCall = nativeId ? calls.get(nativeId) : undefined;
    const nativeRedirect = nativeId ? redirects.get(nativeId) : undefined;
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
        const redirect = redirects.get(part.toolCallId)
          ?? (part.toolName === "recallRead" ? nativeRedirect : undefined);
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
