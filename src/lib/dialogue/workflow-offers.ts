import { getRun } from "workflow/api";
import {
  DIALOGUE_OFFERS_NAMESPACE,
  parseDialogueControlEvent,
  type DialogueControlEvent,
  type DialogueOfferEvent,
} from "./transport";
import { workUpdateAsDialogueCandidate } from "./work-contract";
import { readWorkflowStreamPrefix } from "./workflow-stream-prefix";

/** Read the thought run's replayable lifecycle and work events in one pass. */
export async function listDialogueEvents(parentRunId: string, cacheScope?: string): Promise<DialogueControlEvent[]> {
  const { entries } = await readWorkflowStreamPrefix(parentRunId, DIALOGUE_OFFERS_NAMESPACE,
    chunk => parseDialogueControlEvent(chunk) ?? undefined, cacheScope);
  const events = new Map<string, DialogueControlEvent>();
  for (const event of entries) {
    const id = event.type === "offer" ? event.offerId
      : event.type === "work_checkpoint" || event.type === "work_completed" ? event.updateId
      : event.type === "dialogue_wake" ? `${event.triggerKey}:${event.runId}` : `${event.type}:${event.runId}`;
    if (!events.has(id)) events.set(id, event);
  }
  return [...events.values()];
}

export async function listDialogueOffers(parentRunId: string): Promise<DialogueOfferEvent[]> {
  return (await listDialogueEvents(parentRunId)).flatMap(event => {
    if (event.type === "offer") return [event];
    if (event.type === "work_checkpoint" || event.type === "work_completed") {
      return [workUpdateAsDialogueCandidate(event)];
    }
    return [];
  });
}

export type DialogueAdmission = "admitted" | "duplicate" | "pending" | "parent_terminal";

export async function readDialogueAdmission(
  parentRunId: string,
  offerId: string,
  childRunId: string,
): Promise<DialogueAdmission> {
  const [offers, status] = await Promise.all([
    listDialogueOffers(parentRunId),
    getRun(parentRunId).status,
  ]);
  const selected = offers.find((offer) => offer.offerId === offerId);
  if (selected) return selected.runId === childRunId ? "admitted" : "duplicate";
  return status === "failed" || status === "cancelled" || status === "completed"
    ? "parent_terminal"
    : "pending";
}
