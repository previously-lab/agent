import { getRun } from "workflow/api";
import {
  DIALOGUE_OFFERS_NAMESPACE,
  parseDialogueControlEvent,
  type DialogueControlEvent,
  type DialogueOfferEvent,
} from "./transport";
import { workUpdateAsDialogueCandidate } from "./work-contract";

/** Read the thought run's replayable lifecycle and work events in one pass. */
export async function listDialogueEvents(parentRunId: string): Promise<DialogueControlEvent[]> {
  const readable = getRun(parentRunId).getReadable({
    namespace: DIALOGUE_OFFERS_NAMESPACE,
    startIndex: 0,
  });
  const tail = await readable.getTailIndex();
  const reader = readable.getReader();
  const events = new Map<string, DialogueControlEvent>();
  try {
    for (let index = 0; index <= tail; index++) {
      const next = await reader.read();
      if (next.done) break;
      const event = parseDialogueControlEvent(next.value);
      if (!event) continue;
      const id = event.type === "offer" ? event.offerId
        : event.type === "work_checkpoint" || event.type === "work_completed" ? event.updateId
        : event.type === "dialogue_wake" ? `${event.triggerKey}:${event.runId}` : `${event.type}:${event.runId}`;
      if (!events.has(id)) events.set(id, event);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    try { reader.releaseLock(); } catch { /* Already released. */ }
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
