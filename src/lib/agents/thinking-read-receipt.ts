import { z } from "zod";
import type { ModelMessage } from "@/lib/deepseek/types";
import { parseCaseReadEnvelope } from "@/lib/chat/case-read-receipt";

const BEGIN = "<!-- PREVIOUSLY_THINKING_READ_V1\n";
const END = "\n-->\n";
const READ_TOOLS = new Set(["recallRead", "recallScenario", "webFetch", "webSearch", "viewImage"]);
const reading = z.object({
  evidenceId: z.string().min(1).max(512),
  ref: z.string().min(1).max(2048),
  sourceKind: z.enum(["semantic_document", "original_turn", "external_result", "tool_observation", "navigation"]),
  edition: z.enum(["current", "original", "history"]).optional(),
  revision: z.string().min(1).max(256).nullable(),
  asOf: z.string().datetime({ offset: true }),
  coverage: z.enum(["full", "range", "excerpt", "outline", "failed", "stale"]),
  role: z.enum(["user", "assistant"]).optional(),
  turnId: z.string().min(1).max(128).optional(),
  turnIndex: z.number().int().nonnegative().optional(),
  excerpt: z.string().max(1200).optional(),
  range: z.object({ start: z.number().int().positive(), end: z.number().int().positive() }).strict().optional(),
}).strict();
const receiptSchema = z.object({
  version: z.literal(1), scopeId: z.string().min(1).max(512), toolCallId: z.string().min(1).max(256),
  reads: z.array(reading).max(24),
}).strict();

export type ThinkingRead = z.infer<typeof reading>;
export type ThinkingReadReceipt = z.infer<typeof receiptSchema>;

export function createThinkingReadReceipt(scopeId: string, toolCallId: string, reads: readonly Omit<ThinkingRead, "evidenceId">[]): ThinkingReadReceipt {
  return receiptSchema.parse({ version: 1, scopeId, toolCallId,
    reads: reads.slice(0, 24).map((read, index) => ({ ...read, evidenceId: `${toolCallId}:${index + 1}` })) });
}

export function wrapThinkingRead(receipt: ThinkingReadReceipt, text: string): string {
  // A source name or excerpt cannot close the enclosing Markdown comment.
  const json = JSON.stringify(receipt).replaceAll("<", "\\u003c").replaceAll(">", "\\u003e");
  return `${BEGIN}${json}${END}${text}`;
}

function readReceipt(output: unknown): ThinkingReadReceipt | null {
  let candidate: unknown;
  if (typeof output === "string") {
    const text = parseCaseReadEnvelope(output)?.body ?? output;
    if (!text.startsWith(BEGIN)) return null;
    const end = text.indexOf(END, BEGIN.length);
    if (end < 0 || end - BEGIN.length > 96_000) return null;
    try { candidate = JSON.parse(text.slice(BEGIN.length, end)); }
    catch { return null; }
  } else if (output && typeof output === "object" && "thinkingReceipt" in output) {
    candidate = output.thinkingReceipt;
  }
  const parsed = receiptSchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

/** Only paired tool returns from the current attempt can contribute read evidence. */
export function collectThinkingReads(messages: readonly ModelMessage[], scopeId: string): ThinkingRead[] {
  const calls = new Map<string, string>();
  const receipts = new Map<string, ThinkingReadReceipt>();
  const invalid = new Set<string>();
  const completed = new Set<string>();
  for (const message of messages) {
    if (typeof message.content === "string") continue;
    if (message.role === "assistant") for (const part of message.content) {
      if (part.type !== "tool-call" || !READ_TOOLS.has(part.toolName)) continue;
      if (calls.has(part.toolCallId)) invalid.add(part.toolCallId);
      calls.set(part.toolCallId, part.toolName);
    }
    if (message.role === "tool") for (const part of message.content) {
      if (part.type !== "tool-result" || !READ_TOOLS.has(part.toolName)) continue;
      if (completed.has(part.toolCallId)) invalid.add(part.toolCallId);
      completed.add(part.toolCallId);
      if (calls.get(part.toolCallId) !== part.toolName || part.isError ||
          (part.output.type !== "text" && part.output.type !== "json")) continue;
      const receipt = readReceipt(part.output.value);
      if (!receipt || receipt.scopeId !== scopeId || receipt.toolCallId !== part.toolCallId) continue;
      if (!receipt.reads.every((read, index) => read.evidenceId === `${part.toolCallId}:${index + 1}`)) continue;
      receipts.set(part.toolCallId, receipt);
    }
  }
  return [...receipts.entries()].flatMap(([id, receipt]) => invalid.has(id) ? [] : receipt.reads);
}
