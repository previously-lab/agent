/**
 * Inner turn workflow — one queued user message, one read-only answer
 * (v0.30 §3.1/§3.3, batch B).
 *
 * Spawned ONLY by the outer episode run (turn-workflow.ts) via
 * `start(innerTurnWorkflow, [input], { region: "hkg1" })` — the route never
 * starts these (D1). The inner run is the outer loop's read-only silhouette:
 * the same brain (createInnerChatAgent) with the read-only tool subset, NO
 * housekeeping, NO finalize, NO bell (D8). Its whole context is the envelope
 * — its first and only user message (§3.2) — plus the outer run's assembled
 * system prompt, carried by value so the voice stays the same agent's.
 *
 * The answer returns to the outer run by HOOK, not returnValue (the polling
 * step would hold a worker slot for the whole answer — start.mdx): the tail
 * step resumeHooks the episode inbox with the bubble payload. If the outer
 * run is already gone (cancelled — D6), HookNotFoundError is swallowed with a
 * warning: the inner run is read-only, so nothing half-written exists, and
 * the orphaned user turn stays visible to reflection via the disk record.
 *
 * Lives under src/app so the withWorkflow loader picks up the directives.
 */
import { isStepCount, type ModelMessage } from "ai";
import { createInnerChatAgent } from "@/app/api/agent/agent";
import { buildReadonlyChatToolsContext } from "@/app/api/agent/tools";
import { errorMessage } from "@/lib/chat/workflow-errors";
import type { InnerTurnInput } from "@/lib/chat/turn-types";
import { reportInnerBubble } from "./steps";

/** The instance's answer = all assistant text after the envelope message. */
function extractInnerAnswer(messages: ModelMessage[]): string {
  const envelopeIdx = messages.findIndex((m) => m.role === "user");
  const start = envelopeIdx === -1 ? messages.length : envelopeIdx + 1;
  const parts: string[] = [];
  for (let i = start; i < messages.length; i++) {
    const m = messages[i];
    if (m.role !== "assistant") continue;
    if (typeof m.content === "string") {
      if (m.content.trim()) parts.push(m.content.trim());
      continue;
    }
    if (Array.isArray(m.content)) {
      for (const p of m.content) {
        if (
          p &&
          typeof p === "object" &&
          (p as { type?: string }).type === "text" &&
          typeof (p as { text?: unknown }).text === "string" &&
          (p as { text: string }).text.trim()
        ) {
          parts.push((p as { text: string }).text.trim());
        }
      }
    }
  }
  return parts.join("\n\n");
}

export async function innerTurnWorkflow(input: InnerTurnInput): Promise<void> {
  "use workflow";

  const agent = createInnerChatAgent({
    model: input.modelConfig,
    thinking: input.thinking,
    reasoningEffort: input.reasoningEffort,
    toolsContext: buildReadonlyChatToolsContext(input.toolsContext),
  });

  let text = "";
  let finishReason = "error";
  try {
    // No writable: the inner run has no client stream of its own — the outer
    // run reports the answer as a nested-bubble frame on ITS stream (§4.2).
    const result = await agent.stream({
      messages: [{ role: "user", content: input.envelope }],
      system: input.systemPrompt,
      stopWhen: isStepCount(20),
    });
    text = extractInnerAnswer(result.messages);
    finishReason = result.finishReason;
  } catch (err) {
    // The inner run never throws its way out of existence silently: the outer
    // run learns the failure as a `failed` bubble (finishReason "error") and
    // the merged summary states it plainly (§3.6).
    console.error(
      `[Inner:${input.turnId}] answer failed\n`,
      err instanceof Error ? (err.stack ?? err.message) : err,
    );
    text = "";
    finishReason = "error";
  }

  await reportInnerBubble(input.inboxToken, {
    kind: "bubble",
    turnId: input.turnId,
    replyTo: input.replyTo,
    text,
    finishReason,
  });
}
