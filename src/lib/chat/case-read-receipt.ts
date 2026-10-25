import { z } from "zod";
import type { ModelMessage } from "@/lib/deepseek/types";
import { caseIndexPath, type CaseCategory } from "@/lib/docs/paths";
import { isValidCaseName } from "@/lib/docs/case-naming";

// Shared with the UI. Storage reads and hashing belong on the server.
const BEGIN = "<!-- PREVIOUSLY_CASE_READ_RECEIPT\n";
const END = "\n<!-- /PREVIOUSLY_CASE_READ_RECEIPT -->";

export const caseReadReceiptSchema = z.object({
  version: z.literal(1),
  toolName: z.literal("recallRead"),
  coverage: z.literal("full-index"),
  toolCallId: z.string().min(1).max(256),
  scopeId: z.string().min(1).max(512),
  requestedRef: z.string().min(1).max(2048),
  ref: z.string().min(1).max(2048),
  path: z.string().min(1).max(4096),
  revision: z.string().regex(/^[0-9a-f]{64}$/),
}).strict();

export type CaseReadReceipt = z.infer<typeof caseReadReceiptSchema>;

export function createCaseReadEnvelope(input: {
  scopeId: string;
  toolCallId: string;
  requestedRef: string;
  category: CaseCategory;
  caseName: string;
  revision: string;
  rendered: string;
}): string {
  const receipt = caseReadReceiptSchema.parse({
    version: 1, toolName: "recallRead", coverage: "full-index",
    toolCallId: input.toolCallId, scopeId: input.scopeId,
    requestedRef: input.requestedRef.trim(),
    ref: `${input.category}/${input.caseName}`,
    path: caseIndexPath(input.category, input.caseName), revision: input.revision,
  });
  return `${BEGIN}${JSON.stringify(receipt)}\n-->\n${input.rendered}${END}`;
}

export function parseCaseReadEnvelope(text: string): { receipt: CaseReadReceipt; body: string } | null {
  if (!text.startsWith(BEGIN) || !text.endsWith(END)) return null;
  const headerEnd = text.indexOf("\n-->\n", BEGIN.length);
  if (headerEnd < 0 || headerEnd - BEGIN.length > 8192) return null;
  try {
    const receipt = caseReadReceiptSchema.parse(JSON.parse(text.slice(BEGIN.length, headerEnd)));
    return { receipt, body: text.slice(headerEnd + 5, -END.length) };
  } catch { return null; }
}

export function unwrapCaseReadEnvelope(text: string): string {
  return parseCaseReadEnvelope(text)?.body ?? text;
}

function requestedRef(input: unknown): string | null {
  if (input === null || typeof input !== "object" || !("ref" in input)) return null;
  if ("outline" in input && input.outline === true) return null;
  return typeof input.ref === "string" && input.ref.trim() ? input.ref.trim() : null;
}

/** Only host results paired with preceding real tool calls can carry a receipt. */
export function findCaseReadReceipt(input: {
  messages: ModelMessage[]; scopeId: string; category: CaseCategory; caseName: string;
}): CaseReadReceipt | null {
  if (!input.scopeId || !isValidCaseName(input.caseName)) return null;
  const expectedRef = `${input.category}/${input.caseName}`;
  const expectedPath = caseIndexPath(input.category, input.caseName);
  const calls = new Map<string, string>();
  const invalidIds = new Set<string>();
  const completedIds = new Set<string>();
  const receipts: CaseReadReceipt[] = [];
  for (const message of input.messages) {
    if (typeof message.content === "string") continue;
    if (message.role === "assistant") {
      for (const part of message.content) {
        if (part.type !== "tool-call" || part.toolName !== "recallRead") continue;
        if (calls.has(part.toolCallId)) { invalidIds.add(part.toolCallId); continue; }
        const ref = requestedRef(part.input);
        if (ref) calls.set(part.toolCallId, ref);
      }
      continue;
    }
    if (message.role !== "tool") continue;
    for (const part of message.content) {
      if (part.type !== "tool-result" || part.toolName !== "recallRead") continue;
      if (completedIds.has(part.toolCallId)) invalidIds.add(part.toolCallId);
      completedIds.add(part.toolCallId);
      if (invalidIds.has(part.toolCallId) || part.isError || part.output.type !== "text") continue;
      const callRef = calls.get(part.toolCallId);
      if (!callRef) continue;
      const parsed = parseCaseReadEnvelope(part.output.value);
      if (!parsed) continue;
      const candidate = parsed.receipt;
      if (candidate.toolCallId !== part.toolCallId || candidate.scopeId !== input.scopeId ||
          candidate.requestedRef !== callRef || candidate.ref !== expectedRef || candidate.path !== expectedPath) continue;
      receipts.push(candidate);
    }
  }
  return receipts.filter((receipt) => !invalidIds.has(receipt.toolCallId)).at(-1) ?? null;
}
