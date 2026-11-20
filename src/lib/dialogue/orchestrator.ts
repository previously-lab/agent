import type { DialogueInput, PublicUtterance } from "@/lib/chat/dialogue-contract";
import type { DialogueOfferEvent, DialogueOfferStage, DialogueThoughtStartedEvent, DialogueWakeEvent } from "./transport";
import { dialogueHeartbeatAt, dialogueOpeningHandled, sessionLastWakeAt, type DialogueRunState } from "./coordination";

export interface DialogueOrchestrationWorld {
  scope: string;
  works: Array<{
    runId?: string;
    workId: string;
    inputId: string;
    status: string;
    /** A short task label, not the other input's full history. */
    text?: string;
    acceptedAt?: string;
    latestStage?: "started" | "checkpoint" | "completed";
  }>;
  inputs: DialogueInput[];
  starts: DialogueThoughtStartedEvent[];
  dialogueRuns: DialogueRunState[];
  offers: DialogueOfferEvent[];
  publications: PublicUtterance[];
}

function workKey(offer: DialogueOfferEvent): string {
  return offer.workId ?? offer.sourceInputId;
}

function isFinal(stage?: DialogueOfferStage): boolean {
  return stage !== "checkpoint";
}

function selectDialogueOpening(
  world: Pick<DialogueOrchestrationWorld, "offers" | "publications"> & Partial<Pick<DialogueOrchestrationWorld, "inputs" | "works" | "starts" | "dialogueRuns">>,
  handled: ReadonlySet<string>,
): DialogueOfferEvent | undefined {
  const coveredInputs = new Set(world.publications.flatMap(publication => publication.inputIds));
  for (const input of world.inputs ?? []) {
    const work = (world.works ?? []).find(candidate => candidate.inputId === input.inputId);
    const start = (world.starts ?? []).find(candidate => candidate.sourceInputId === input.inputId);
    if (!work?.runId || !start || (work.status !== "pending" && work.status !== "running") ||
        coveredInputs.has(input.inputId) || (world.dialogueRuns ?? []).some(run => dialogueOpeningHandled(run, input.inputId))) continue;
    const offerId = `${work.workId}:opening`;
    if (handled.has(offerId)) continue;
    return {
      type: "offer",
      offerId,
      runId: work.runId,
      parentRunId: work.runId,
      sourceInputId: input.inputId,
      workId: work.workId,
      stage: "checkpoint",
      publicSeq: 1,
      text: "",
      locale: "zh",
      record: start.record,
    };
  }
  return undefined;
}

/** Select genuinely new public work; the Workflow stream is the only cursor. */
export function selectDialogueOffer(
  world: Pick<DialogueOrchestrationWorld, "offers" | "publications"> & Partial<Pick<DialogueOrchestrationWorld, "inputs" | "works" | "starts" | "dialogueRuns">>,
  handled: ReadonlySet<string> = new Set(),
): DialogueOfferEvent | undefined {
  const publishedResultIds = new Set(world.publications.flatMap(publication =>
    publication.sourceResults.map(result => result.resultId)));
  const finalizedInputs = new Set(world.publications
    .filter(publication => publication.phase !== "commentary")
    .flatMap(publication => publication.inputIds));
  const finalWorkIds = new Set(world.offers
    .filter(offer => !publishedResultIds.has(offer.offerId) && !handled.has(offer.offerId) && isFinal(offer.stage))
    .map(workKey));
  const pending = world.offers.filter(offer => {
    if (handled.has(offer.offerId) || publishedResultIds.has(offer.offerId)) return false;
    if (!isFinal(offer.stage)) {
      if (finalWorkIds.has(workKey(offer)) || finalizedInputs.has(offer.sourceInputId)) return false;
    }
    return true;
  });
  // Oldest final first avoids starving an earlier input under a live burst.
  return pending.find(offer => isFinal(offer.stage)) ?? pending.at(-1) ?? selectDialogueOpening(world, handled);
}

export function publicationText(publication: PublicUtterance): string {
  return publication.blocks.flatMap(block => block.kind === "markdown" ? [block.text] : []).join("\n\n");
}

export function publicationOfferIds(publications: readonly PublicUtterance[]): Set<string> {
  return new Set(publications.flatMap(publication => publication.sourceResults.map(result => result.resultId)));
}

export const DIALOGUE_HEARTBEAT_MS = 2 * 60 * 1000;
export const DIALOGUE_SESSION_MS = 30 * 60 * 1000;

/** Only a live run inside its wake window may be reused. */
export function dialogueRunUsable(status: string, lastTriggeredAt: string | undefined, nowMs: number): boolean {
  if (status !== "pending" && status !== "running") return false;
  const stamped = lastTriggeredAt ? Date.parse(lastTriggeredAt) : NaN;
  return Number.isFinite(stamped) && nowMs - stamped < DIALOGUE_SESSION_MS;
}

/** A sleeping hook emits no heartbeat. Once woken it again owes progress
 * within the active heartbeat window; repeated wake hints cannot extend it. */
export function dialogueRunStale(
  run: DialogueRunState,
  wakes: readonly DialogueWakeEvent[],
  nowMs: number,
  awaitingDeliverySince?: number,
): boolean {
  const phase = run.events.findLast(event => event.type === "heartbeat" || event.type === "handoff_wait" ||
    event.type === "exit_intent" || event.type === "exit_commit");
  if (phase?.type !== "exit_intent") {
    return nowMs - Date.parse(dialogueHeartbeatAt(run)) >= DIALOGUE_HEARTBEAT_MS;
  }
  if (!dialogueRunUsable(run.status, sessionLastWakeAt(run, wakes), nowMs)) return true;
  const idleAt = Date.parse(phase.at);
  let firstPendingWake = awaitingDeliverySince === undefined ? Infinity : Math.max(idleAt, awaitingDeliverySince);
  for (const wake of wakes) {
    if (wake.runId !== run.runId) continue;
    const wakeAt = Date.parse(wake.wakeAt);
    if (wakeAt > idleAt) firstPendingWake = Math.min(firstPendingWake, wakeAt);
  }
  return nowMs - firstPendingWake >= DIALOGUE_HEARTBEAT_MS;
}
