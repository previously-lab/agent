import { z } from "zod";
import type { ModelMessage, ToolResultOutput } from "@/lib/deepseek/types";

export const scenarioRecallRequestSchema = z.object({
  question: z.string().trim().min(1).max(4000).describe("The focused question to recover from earlier conversations, including relevant context and what remains uncertain."),
  refs: z.array(z.string().regex(/^records\/\d{4}-\d{2}-\d{2}-\d{4}$/)).max(4).optional()
    .describe("Up to four known original conversation refs. Omit to let recollection locate scenarios. Semantic documents are outside this tool."),
  after: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("Optional inclusive UTC slice-date lower bound, YYYY-MM-DD. Omit when uncertain."),
  before: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("Optional inclusive UTC slice-date upper bound, YYYY-MM-DD. Omit when uncertain."),
}).strict();

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
  const legacy = /(?:^|\/)memory\/episodic\/slices\/(\d{4})\/(\d{2})\/(\d{2})\/(\d{4})(?:\/timeline(?:\/(?:core|agent|previously))?)?$/.exec(ref);
  const match = current ?? legacy;
  return match ? `records/${match[1]}-${match[2]}-${match[3]}-${match[4]}` : null;
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
}>(entry: T): T {
  return entry.category === "records" || canonicalConversationRecordRef(entry.ref)
    ? { ...entry, title: "Original conversation", excerpt: "" }
    : entry;
}

/** Replace only record rows in the facade's fixed, single-line rendering. */
export function withoutReplayedConversationEntryContent(value: string): string {
  return value.split("\n").map((line) => {
    const match = /^- \[([^\]]+)\].*\(ref: (records\/\d{4}-\d{2}-\d{2}-\d{4})\)$/.exec(line);
    return match ? `- [${match[1]}] Original conversation (ref: ${match[2]})` : line;
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
