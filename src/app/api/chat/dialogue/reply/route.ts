import { getRun, start } from "workflow/api";
import { getWorld } from "workflow/runtime";
import { z } from "zod";
import type { ModelMessage } from "@/lib/deepseek/types";
import type { TurnRunResult, DialogueWorkResult } from "@/lib/chat/turn-types";
import { createUIMessageStreamResponse } from "@/lib/chat/server-stream";
import { guardRequest } from "@/lib/security/origin-guard";
import { thinkingReportSchema } from "@/lib/agents/thinking-product";
import { dialoguePriorContext } from "@/lib/dialogue/dialogue-prompt";
import {
  dialogueOfferId,
  type DialogueRunInput,
  type DialogueSemanticEvent,
} from "@/lib/dialogue/transport";
import { dialogueWorkflow } from "../../dialogue-workflow";
import { createMixedStreamTransform } from "../../mixed-stream-transform";

const replyBodySchema = z.object({
  thoughtRunId: z.string().regex(/^wrun_[A-Za-z0-9]+$/),
  workId: z.string().trim().min(1).max(512),
  messages: z.array(z.unknown()).max(200),
}).strict();

function publicHistory(messages: unknown[], sourceInputText: string) {
  const publicMessages = messages.flatMap((message): ModelMessage[] => {
    if (!message || typeof message !== "object") return [];
    const candidate = message as { role?: unknown; parts?: unknown };
    if (candidate.role !== "user" && candidate.role !== "assistant") return [];
    if (!Array.isArray(candidate.parts)) return [];
    const text = candidate.parts.flatMap((part): string[] => {
      if (!part || typeof part !== "object") return [];
      const candidatePart = part as { type?: unknown; text?: unknown };
      return candidatePart.type === "text" && typeof candidatePart.text === "string"
        ? [candidatePart.text]
        : [];
    }).join("\n");
    return text.trim() ? [{ role: candidate.role, content: text }] : [];
  });
  return dialoguePriorContext(publicMessages, sourceInputText);
}

function directEvent(work: DialogueWorkResult): DialogueSemanticEvent | undefined {
  if (!work.report) return undefined;
  const parsed = thinkingReportSchema.safeParse(work.report);
  if (!parsed.success) return undefined;
  if (parsed.data.needsUser) {
    return { kind: "needs_user", needsUser: parsed.data.needsUser };
  }
  if (!work.text.trim() && parsed.data.findings?.length) {
    return {
      kind: "findings",
      findings: parsed.data.findings.map((finding) => ({
        text: finding.text,
        kind: finding.kind,
        ...(finding.uncertainty ? { uncertainty: finding.uncertainty } : {}),
        ...(finding.decision ? { decision: finding.decision } : {}),
      })),
    };
  }
  return undefined;
}

async function findExistingReplyRun(workId: string, offerId: string, scopeKey: string): Promise<string | undefined> {
  const page = await (await getWorld()).runs.list({ pagination: { limit: 100 }, resolveData: "none" });
  const matches = page.data.filter(row => {
    const entry = row as { attributes?: Record<string, string> | null };
    return entry.attributes?.role === "dialogue" && entry.attributes.work === workId &&
      entry.attributes.offer === offerId && entry.attributes.scope === scopeKey;
  }) as Array<{ runId: string; createdAt?: Date | string }>;
  matches.sort((a, b) => {
    const left = a.createdAt ? new Date(a.createdAt).getTime() : NaN;
    const right = b.createdAt ? new Date(b.createdAt).getTime() : NaN;
    if (Number.isFinite(left) && Number.isFinite(right)) return right - left;
    return b.runId.localeCompare(a.runId);
  });
  return matches[0]?.runId;
}

export async function POST(request: Request): Promise<Response> {
  const blocked = guardRequest(request);
  if (blocked) return blocked;
  const parsedBody = replyBodySchema.safeParse(await request.json().catch(() => null));
  if (!parsedBody.success) {
    return Response.json({ error: "thoughtRunId, workId, and messages are required" }, { status: 400 });
  }
  const { thoughtRunId, workId, messages } = parsedBody.data;

  let work: DialogueWorkResult | undefined;
  try {
    const thoughtRun = getRun<TurnRunResult>(thoughtRunId);
    if (await thoughtRun.status !== "completed") {
      return Response.json({ error: "The thinking run has not completed" }, { status: 409 });
    }
    const result = await thoughtRun.returnValue;
    if (result.dialogueWork?.workId === workId) work = result.dialogueWork;
  } catch {
    return Response.json({ error: "The thinking run is unavailable" }, { status: 404 });
  }
  if (!work) {
    return Response.json({ error: "The completed thinking work is unavailable" }, { status: 409 });
  }

  const offerId = dialogueOfferId(workId, "direct");
  const event = directEvent(work);
  const input: DialogueRunInput = {
    offerId,
    publicSeq: 1,
    direct: true,
    stage: "final",
    text: work.text,
    ...(event ? { event } : {}),
    context: {
      parentRunId: thoughtRunId,
      workId,
      sourceInputId: work.source.inputId,
      sourceTurnId: work.sourceTurnId,
      source: work.source,
      priorContext: publicHistory(messages, work.source.text),
      locale: work.locale,
      record: work.record,
    },
  };
  const existingRunId = await findExistingReplyRun(workId, offerId, work.scopeKey);
  const run = existingRunId ? getRun(existingRunId) : await start(dialogueWorkflow, [input], {
    region: "hkg1",
    attributes: {
      role: "dialogue",
      parent: thoughtRunId,
      work: workId,
      offer: offerId,
      scope: work.scopeKey,
    },
  });
  return createUIMessageStreamResponse({
    stream: run.readable.pipeThrough(createMixedStreamTransform()),
    headers: { "x-workflow-run-id": run.runId },
  });
}
