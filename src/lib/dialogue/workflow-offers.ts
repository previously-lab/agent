import { getRun } from "workflow/api";
import {
  DIALOGUE_OFFERS_NAMESPACE,
  parseDialogueOfferEvent,
  type DialogueOfferEvent,
} from "./transport";

/** Read only the known parent's SDK-decoded native control stream. */
export async function listDialogueOffers(parentRunId: string): Promise<DialogueOfferEvent[]> {
  const readable = getRun(parentRunId).getReadable({
    namespace: DIALOGUE_OFFERS_NAMESPACE,
    startIndex: 0,
  });
  const tail = await readable.getTailIndex();
  const reader = readable.getReader();
  const offers = new Map<string, DialogueOfferEvent>();
  try {
    for (let index = 0; index <= tail; index++) {
      const next = await reader.read();
      if (next.done) break;
      const offer = parseDialogueOfferEvent(next.value);
      if (offer && !offers.has(offer.offerId)) offers.set(offer.offerId, offer);
    }
  } finally {
    try { reader.releaseLock(); } catch { /* Already released. */ }
  }
  return [...offers.values()];
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