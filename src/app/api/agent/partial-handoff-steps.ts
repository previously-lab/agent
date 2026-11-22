import { getWritable } from "workflow";
import { getRun, start } from "workflow/api";
import { DIALOGUE_OFFERS_NAMESPACE, type DialogueParentWritable } from "@/lib/dialogue/transport";
import { listDialogueOffers } from "@/lib/dialogue/workflow-offers";
import type { ToolContext } from "./tool-executors";

export type PartialHandoffPassages = { id: string; text: string }[];

export async function startPartialHandoffStep(context: ToolContext, passages: PartialHandoffPassages): Promise<void> {
  "use step";
  const { partialHandoffWorkflow } = await import("./partial-handoff-workflow");
  const parentStream: DialogueParentWritable = getWritable({ namespace: DIALOGUE_OFFERS_NAMESPACE });
  await start(partialHandoffWorkflow, [context, passages, parentStream], {
    region: "hkg1", attributes: { source: context.turnId },
  });
}
// A lost launch receipt should not start another optional provider request.
startPartialHandoffStep.maxRetries = 0;

export async function partialHandoffOpenStep(parentRunId: string, workId: string, inputId: string): Promise<boolean> {
  "use step";
  const [status, offers] = await Promise.all([getRun(parentRunId).status, listDialogueOffers(parentRunId)]);
  return (status === "pending" || status === "running") &&
    !offers.some(offer => offer.workId === workId && offer.sourceInputId === inputId);
}
