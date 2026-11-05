/**
 * Task-result delivery settlement for the dialogue flow — the explicit
 * mapping the design requires in place of the legacy "a clean research run
 * consumed the result" semantics. The chain, every link host-verified:
 *
 *   1. The thinking work's model calls reportTaskFollowup for a pending
 *      ledger result; the TOOL mints the ack intent (resultId +
 *      expectedRevision read from the ledger — never model-authored) and
 *      rejects already-delivered results on the spot.
 *   2. completeDialogueWorkStep persists the intent on the immutable result
 *      record (only when the ledger still shows the result pending).
 *   3. The expression drain publicly publishes claims from that result; the
 *      record projection lands the utterance as a real agent turn.
 *   4. THIS module confirms delivery against the Git task ledger with the
 *      persisted public turn as reply evidence — after the projection
 *      returned, before the projection receipt settles, so a failed
 *      confirmation re-runs idempotently instead of being skipped forever.
 *
 * A research run succeeding WITHOUT a public publication confirms nothing;
 * a result whose work is never published stays pending (visible in the task
 * block), never silently dropped and never marked delivered twice.
 */
import { confirmTaskResultDelivery } from "@/lib/tasks/store";
import { TaskLedgerError } from "@/lib/tasks/contracts";
import { stableTaskOperationId } from "@/lib/chat/task-identity";
import { caseStorageRevision } from "@/lib/docs/case-doc";
import type { PublicUtterance } from "@/lib/chat/dialogue-contract";
import type { DialogueStore } from "./store";

export interface DeliveryConfirmation {
  resultId: string;
  expectedRevision: number;
  operationId: string;
  now: string;
  outcome: { status: "persisted"; sliceId: string; turnId: string };
}

/** The public turn identity minted by the record projection — deterministic
 *  from the utterance id, so the delivery receipt names the real persisted
 *  location rather than a prediction. */
export function publicTurnIdFor(utteranceId: string): string {
  return `p${caseStorageRevision(utteranceId).slice(0, 31)}`;
}

/** One confirmation per delivery intent cited by the published sources. */
export async function buildDeliveryConfirmations(
  store: DialogueStore,
  scope: string,
  utterance: PublicUtterance,
  sliceId: string,
  now: string,
): Promise<DeliveryConfirmation[]> {
  const confirmations: DeliveryConfirmation[] = [];
  for (const use of utterance.sourceResults) {
    const result = await store.result(scope, use.resultId);
    if (result?.productRevision !== use.productRevision) continue;
    for (const intent of result.deliveryIntents ?? []) {
      confirmations.push({
        resultId: intent.resultId,
        expectedRevision: intent.expectedRevision,
        operationId: stableTaskOperationId("dialogue:delivery", [utterance.utteranceId, intent.resultId]),
        now,
        outcome: { status: "persisted", sliceId, turnId: publicTurnIdFor(utterance.utteranceId) },
      });
    }
  }
  return confirmations;
}

/**
 * Confirm against the Git task ledger. Honest terminal conflicts (result
 * gone, revision moved on, already delivered) leave the ledger as the truth
 * and only warn — they must not fail the projection job; genuine persistence
 * errors throw so the job retries the whole idempotent chain.
 */
export async function confirmDeliveredTaskResults(
  confirmations: readonly DeliveryConfirmation[],
  log: { warn(message: string, ...details: unknown[]): void } = console,
): Promise<void> {
  for (const confirmation of confirmations) {
    try {
      await confirmTaskResultDelivery({
        operationId: confirmation.operationId,
        now: confirmation.now,
        resultId: confirmation.resultId,
        expectedRevision: confirmation.expectedRevision,
        outcome: confirmation.outcome,
      });
    } catch (error) {
      if (error instanceof TaskLedgerError) {
        log.warn(
          `[Dialogue] task delivery left pending for ${confirmation.resultId} (${error.code}):`,
          error.message,
        );
        continue;
      }
      throw error;
    }
  }
}
