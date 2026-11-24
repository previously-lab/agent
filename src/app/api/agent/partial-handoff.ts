import type { StepResult, ToolCall } from "@/lib/deepseek/types";
import { collectPartialEvidence } from "@/lib/dialogue/partial-evidence";
import type { ToolContext } from "./tool-executors";
import { startPartialHandoffStep } from "./partial-handoff-steps";

const furtherResearch = new Set(["recallRead", "recallSearch", "recallFind", "recallList", "recallRecent",
  "recallSince", "recallScenario", "webFetch", "webSearch", "webResearch", "thinkDeep"]);

/** One optional, private extraction over a real read. The original investigation keeps running. */
export function createPartialHandoff(context: ToolContext) {
  let closed = false;
  let pending: Promise<void> | undefined;

  function onBatch(calls: readonly ToolCall[], previous?: Pick<StepResult, "toolCalls" | "toolResults">) {
    if (!calls.length || calls.some(call => !call.invalid &&
      ["completeWork", "finishThinking", "workCheckpoint"].includes(call.toolName))) {
      closed = true;
      return;
    }
    if (closed || pending || !previous || !context.dialogueOffer || !context.currentUserText.trim()) return;
    if (!calls.every(call => !call.invalid && furtherResearch.has(call.toolName))) return;
    const pairedResults = previous.toolResults.filter(result => previous.toolCalls.some(call =>
      !call.invalid && call.toolCallId === result.toolCallId && call.toolName === result.toolName));
    const passages = collectPartialEvidence(pairedResults, context.readScopeId);
    if (!passages.length) return;

    // Only the source question, verified passages and delivery address cross the run boundary.
    // The child has its own step schedule. A slow lookup in this parent cannot park its handoff.
    const { owner, repo, useGithub, useDemo, sliceId, turnId, readScopeId, currentUserText, dialogueOffer } = context;
    pending = startPartialHandoffStep({ owner, repo, useGithub, useDemo, sliceId, turnId, readScopeId,
      currentUserText, recentTurns: [], dialogueOffer: { ...dialogueOffer, priorContext: [] } }, passages).catch(error => {
      console.warn("[Dialogue] Could not start the optional partial handoff", error);
    });
  }
  return {
    onBatch,
    close() { closed = true; },
    settled() { return pending; },
  };
}
