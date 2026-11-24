import { callModelStep } from "@/lib/deepseek/steps";
import { candidatePartialAnswer, partialEvidencePrompt } from "@/lib/dialogue/partial-evidence";
import { partialHandoffOpenStep, type PartialHandoffPassages } from "./partial-handoff-steps";
import type { DialogueParentWritable } from "@/lib/dialogue/transport";
import { workCheckpointExecute, type ToolContext } from "./tool-executors";

export async function partialHandoffWorkflow(context: ToolContext, passages: PartialHandoffPassages, parentStream: DialogueParentWritable) {
  "use workflow";
  const target = context.dialogueOffer;
  if (!target) return;
  const open = () => partialHandoffOpenStep(target.parentRunId, target.workId, target.sourceInputId);
  if (!await open()) return;
  const response = await callModelStep({
    messages: partialEvidencePrompt(context.currentUserText, passages),
    thinking: false, reasoningEffort: "low", temperature: 0.2,
    callId: "partial-evidence", sessionId: context.sliceId,
  });
  if (response.error) throw new Error(response.error.message);
  if (response.finishReason !== "stop" || typeof response.message.content !== "string") return;
  // A different conversation about the same date or number is not a duplicate.
  // The dialogue Actor separately sees the publications for the current input.
  const text = candidatePartialAnswer(response.message.content, passages, []);
  if (text && await open()) {
    await workCheckpointExecute({ text }, { context, toolCallId: "host-partial-evidence", messages: [] }, parentStream);
  }
}
