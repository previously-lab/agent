/**
 * Child turn workflow — one user message, one answering agent run
 * (v0.31 — the orchestrator-shell architecture).
 *
 * Spawned ONLY by the orchestrator run (turn-workflow.ts) via
 * `start(innerTurnWorkflow, [input], { region })` — the route never starts
 * these (D1). Every user message gets its own child run, including the
 * episode's first: the orchestrator is a pure dispatch/persistence shell and
 * does no answering itself.
 *
 * The child is the FULL agent (same tool set the outer turn had — children
 * are the answerers now), and it answers onto its OWN durable stream
 * (`writable` below): the client attaches to `/api/chat/[runId]/stream` and
 * watches the reply live, so a slow sibling never blocks anyone else's
 * pixels. The orchestrator learns only the terminal outcome — the bubble
 * report rides the episode inbox hook (reportInnerBubble), not the stream.
 *
 * No housekeeping, NO finalize, NO bell (D8): persistence is centralized in
 * the orchestrator, which records every terminal bubble at finalizeTurn.
 * If the child dies WITHOUT reporting (platform kill mid-step — the watchdog
 * in the orchestrator's drain loop is the bound on that), the instance is
 * marked failed there; a child that regains control always reports, even on
 * failure.
 *
 * The report rides TWO channels (v0.32): the inbox hook tap (fast path) AND
 * the run's return value (the channel of record — the orchestrator's drain
 * reconciles terminal runs from the registry every busy lap, so a lost or
 * undelivered hook wake costs one short tick, never the episode).
 *
 * Lives under src/app so the withWorkflow loader picks up the directives.
 */
import { isStepCount, type ModelMessage } from "ai";
import { getWritable } from "workflow";
import type { ModelCallStreamPart } from "@ai-sdk/workflow";
import { createChatAgent } from "@/app/api/agent/agent";
import { buildChatToolsContext } from "@/app/api/agent/tools";
import type { InnerTurnInput, InnerTurnReport } from "@/lib/chat/turn-types";
import { closeChildStream, reportInnerBubble } from "./steps";

/**
 * The instance's answer = all assistant text the RUN produced (everything
 * after the input messages; index 0 is the SDK-prepended system message, so
 * the slice point is 1 + input length — the same discipline as the outer
 * turn's extractAllAssistantText).
 */
function extractChildAnswer(
  messages: ModelMessage[],
  inputCount: number,
): string {
  const parts: string[] = [];
  for (let i = 1 + inputCount; i < messages.length; i++) {
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
          (p as { type?: unknown }).type === "text" &&
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

export async function innerTurnWorkflow(
  input: InnerTurnInput,
): Promise<InnerTurnReport> {
  "use workflow";

  const agent = createChatAgent({
    model: input.modelConfig,
    thinking: input.thinking,
    reasoningEffort: input.reasoningEffort,
    toolsContext: buildChatToolsContext(input.toolsContext),
  });

  let text = "";
  let finishReason = "error";
  try {
    // The child's own stream — sendFinish:false + preventClose keep it open
    // until closeChildStream writes the lifecycle tail below, so the client's
    // bubble reader settles on a real finish chunk, not a connection drop.
    const result = await agent.stream({
      messages: input.messages,
      system: input.systemPrompt,
      writable: getWritable<ModelCallStreamPart>(),
      stopWhen: isStepCount(20),
      sendFinish: false,
      preventClose: true,
    });
    text = extractChildAnswer(result.messages, input.messages.length);
    finishReason = result.finishReason;
  } catch (err) {
    // The child never throws its way out of existence silently: the
    // orchestrator learns the failure as a `failed` bubble (finishReason
    // "error") and the merged summary states it plainly (§3.6).
    console.error(
      `[Inner:${input.turnId}] answer failed\n`,
      err instanceof Error ? (err.stack ?? err.message) : err,
    );
    text = "";
    finishReason = "error";
  }

  // Stream tail first, then the report: a client reading the child stream
  // settles on the finish chunk; the orchestrator's done frame carries the
  // settled text for history/replay.
  await closeChildStream();
  const report: InnerTurnReport = {
    turnId: input.turnId,
    replyTo: input.replyTo,
    text,
    finishReason,
  };
  await reportInnerBubble(input.inboxToken, { kind: "bubble", ...report });
  // The return value is the report's channel of record (v0.32): the
  // orchestrator's registry poll folds it in even when the hook tap above
  // never wakes the drain.
  return report;
}
