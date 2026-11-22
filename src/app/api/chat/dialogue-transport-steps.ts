import { createHash } from "node:crypto";
import { getWorkflowMetadata, getWritable } from "workflow";
import { getRun, start } from "workflow/api";
import type { UIMessageChunk } from "@/lib/chat/protocol";
import type { PublicUtterance } from "@/lib/chat/dialogue-contract";
import { parseNativeSections } from "@/lib/markdown/native-sections";
import { buildDialoguePrompt } from "@/lib/dialogue/dialogue-prompt";
import {
  DIALOGUE_ARTIFACT_CHUNK,
  DIALOGUE_OFFERS_NAMESPACE,
  DIALOGUE_PUBLICATION_CHUNK,
  CHECKPOINT_TEXT_MAX_CHARS,
  offerEventFromResult,
  parseOfferReplyResult,
  type DialogueRecordRequest,
  type DialogueRunInput,
  type DialogueTypedArtifact,
  type PreparedDialogueOffer,
  type DialogueOfferContext,
  type DialogueThoughtStartedEvent,
  type DialogueWakeEvent,
  type DialogueParentWritable,
  type DialogueDeliveryEvent,
} from "@/lib/dialogue/transport";
import type { DialogueRuntimeEvent } from "@/lib/dialogue/coordination";
import { listDialogueOffers, readDialogueAdmission, type DialogueAdmission } from "@/lib/dialogue/workflow-offers";
import type { DialogueOfferEvent } from "@/lib/dialogue/transport";
import { parseWorkUpdateEvent, type WorkUpdateEvent } from "@/lib/dialogue/work-contract";

export async function dialogueOwnRunIdStep(): Promise<string> {
  "use step";
  return getWorkflowMetadata().workflowRunId;
}

export async function dialogueAdmissionStep(
  parentRunId: string,
  offerId: string,
  childRunId: string,
): Promise<DialogueAdmission> {
  "use step";
  return readDialogueAdmission(parentRunId, offerId, childRunId);
}

/** Runs as soon as offerReply's start step is durable, independent of its siblings. */
export async function publishDialogueOfferControlsStep(results: unknown[]): Promise<number> {
  "use step";
  const offers = results.map(parseOfferReplyResult).filter((result): result is NonNullable<typeof result> => !!result);
  if (!offers.length) return 0;
  const writable = getWritable<DialogueOfferEvent>({ namespace: DIALOGUE_OFFERS_NAMESPACE });
  const writer = writable.getWriter();
  try {
    for (const result of offers) await writer.write(offerEventFromResult(result));
  } finally {
    writer.releaseLock();
  }
  return offers.length;
}

/** The full input rides a Workflow event, never a size-limited run attribute. */
export async function publishThoughtStartedStep(context: DialogueOfferContext): Promise<void> {
  "use step";
  const event: DialogueThoughtStartedEvent = {
    type: "thought_started",
    runId: context.parentRunId,
    sourceInputId: context.sourceInputId,
    workId: context.workId,
    input: context.source,
    record: context.record,
    acceptedAt: context.source.acceptedAt,
  };
  const writer = getWritable<DialogueThoughtStartedEvent>({ namespace: DIALOGUE_OFFERS_NAMESPACE }).getWriter();
  try { await writer.write(event); } finally { writer.releaseLock(); }
}

export async function publishWorkUpdateStep(update: WorkUpdateEvent, parentWritable?: DialogueParentWritable): Promise<void> {
  "use step";
  if (!parseWorkUpdateEvent(update)) throw new Error("Invalid work update");
  const writer = (parentWritable ?? getWritable<WorkUpdateEvent>({ namespace: DIALOGUE_OFFERS_NAMESPACE })).getWriter();
  try { await writer.write(update); } finally { writer.releaseLock(); }
}

export async function recordDialogueWakeStep(event: DialogueWakeEvent, parentWritable?: DialogueParentWritable): Promise<void> {
  "use step";
  const writer = (parentWritable ?? getWritable<DialogueWakeEvent>({ namespace: DIALOGUE_OFFERS_NAMESPACE })).getWriter();
  try { await writer.write(event); } finally { writer.releaseLock(); }
}

export async function publishThoughtDeliveryStep(event: DialogueDeliveryEvent): Promise<void> {
  "use step";
  const writer = getWritable<DialogueDeliveryEvent>({ namespace: DIALOGUE_OFFERS_NAMESPACE }).getWriter();
  try { await writer.write(event); } finally { writer.releaseLock(); }
}

/** Runtime events live in the dialogue run's own stream, not in a control store. */
export async function writeDialogueRuntimeEventStep(event: DialogueRuntimeEvent): Promise<void> {
  "use step";
  const writer = getWritable().getWriter();
  try {
    await writer.write({
      type: `data-dialogue-${event.type}`,
      id: `${event.type}:${sha256(JSON.stringify(event)).slice(0, 32)}`,
      data: event,
    });
  } finally {
    writer.releaseLock();
  }
}

/** A lap is not the end of the logical dialogue stream. */
export async function completeDialogueLapStep(offerId: string, error?: string): Promise<void> {
  "use step";
  const writer = getWritable().getWriter();
  try {
    await writer.write({
      type: "data-turn-status",
      id: `lap:${sha256(offerId).slice(0, 32)}`,
      data: { status: error ? "error" : "done", turnId: offerId, offerId, updatedAt: new Date().toISOString(), ...(error ? { error } : {}) },
    });
  } finally {
    writer.releaseLock();
  }
}

export async function closeDialogueRunStreamStep(): Promise<void> {
  "use step";
  await getWritable().close();
}

/** Reconcile before fallback so an uncertain control write cannot double offer. */
export async function reconcileDialogueOffersStep(parentRunId: string): Promise<DialogueOfferEvent[]> {
  "use step";
  return listDialogueOffers(parentRunId);
}
function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function checkpointSuperseded(input: DialogueRunInput, offers: DialogueOfferEvent[]): boolean {
  if (input.stage !== "checkpoint") return false;
  return offers.some((offer) => {
    if (offer.offerId === input.offerId || offer.sourceInputId !== input.context.sourceInputId) return false;
    // A final (or stageless) offer and any newer checkpoint supersede as before.
    if (offer.stage !== "checkpoint") return true;
    if ((offer.publicSeq ?? 0) > input.publicSeq) return true;
    // An automatic read_completed checkpoint loses to any other same-source
    // explicit/semantic offer — including an explicit checkpoint at the same
    // publicSeq — so a race never speaks a bare read announcement last.
    return input.event?.kind === "read_completed" && offer.eventKind !== "read_completed";
  });
}

/** Read a snapshot of a prior checkpoint's committed public output without waiting on it. */
async function readSpokenCheckpoint(offer: DialogueOfferEvent): Promise<string[]> {
  try {
    const readable = getRun(offer.runId).getReadable({ startIndex: 0 });
    const tail = await readable.getTailIndex();
    if (tail < 0) return [];
    // Checkpoints emit a short single delta plus the typed publication.
    const reader = readable.getReader();
    try {
      for (let index = 0; index <= Math.min(tail, 10); index++) {
        const next = await reader.read();
        if (next.done) break;
        const chunk = next.value as { type?: string; data?: PublicUtterance } | undefined;
        if (chunk?.type === DIALOGUE_PUBLICATION_CHUNK && chunk.data?.utteranceId === offer.offerId) {
          return chunk.data.blocks.flatMap((block) => block.kind === "markdown"
            ? [block.text.slice(0, CHECKPOINT_TEXT_MAX_CHARS)] : []);
        }
      }
    } finally {
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
  } catch { /* Background context may still be publishing or no longer retained. */ }
  return [];
}

/** Native source is stored as typed Workflow data, unchanged and out of the prompt. */
export async function prepareDialogueOfferStep(
  input: DialogueRunInput,
  childRunId: string,
): Promise<PreparedDialogueOffer> {
  "use step";
  const prior = input.priorCheckpoints ?? [];
  const offers = !input.direct && (input.stage === "checkpoint" || input.stage === "final" || prior.length)
    ? await listDialogueOffers(input.context.parentRunId) : [];
  if (checkpointSuperseded(input, offers)) return { artifacts: [], prompt: "", superseded: true };
  const automaticRead = input.stage === "checkpoint" || input.stage === "final"
    ? offers.find((offer) => offer.offerId !== input.offerId && offer.runId !== childRunId &&
      offer.stage === "checkpoint" && offer.eventKind === "read_completed" &&
      offer.sourceInputId === input.context.sourceInputId && (offer.publicSeq ?? 0) < input.publicSeq &&
      !prior.some((entry) => entry.offerId === offer.offerId && entry.runId === offer.runId))
    : undefined;
  const alreadySaid = (await Promise.all([
    ...prior.flatMap((entry) => {
      const admitted = offers.find((offer) => offer.offerId === entry.offerId && offer.runId === entry.runId &&
        offer.stage === "checkpoint" && offer.sourceInputId === input.context.sourceInputId);
      return admitted ? [readSpokenCheckpoint(admitted)] : [];
    }),
    ...(automaticRead ? [readSpokenCheckpoint(automaticRead)] : []),
  ])).flat();
  const artifacts: DialogueTypedArtifact[] = [];
  const sections = parseNativeSections(input.text);
  const prose = sections.map((section) => {
    if (section.kind !== "native") return section.raw;
    if (!section.closed) return "\n\n[Incomplete interactive artifact omitted]\n\n";
    const ordinal = artifacts.length + 1;
    const bodySha = sha256(section.source);
    const blockId = `artifact-${ordinal}:${bodySha.slice(0, 16)}`;
    const artifactId = sha256(JSON.stringify([
      input.context.parentRunId,
      input.offerId,
      blockId,
      section.source,
    ]));
    const artifact: DialogueTypedArtifact = {
      blockId,
      body: section.source,
      artifact: {
        artifactId,
        sourceOwnerId: childRunId,
        revision: 1,
        sha256: bodySha,
        kind: "native_html",
        mediaType: "text/html",
        byteSize: Buffer.byteLength(section.source, "utf8"),
      },
    };
    if (artifact.artifact.byteSize <= 0) throw new Error("A native artifact must not be empty");
    artifacts.push(artifact);
    return `\n\n[Interactive artifact ${ordinal}: ${artifactId}]\n\n`;
  }).join("");
  return { artifacts, prompt: buildDialoguePrompt(input, artifacts, prose, alreadySaid) };
}

export async function openDialogueStreamStep(input: DialogueRunInput): Promise<void> {
  "use step";
  const writable = getWritable<UIMessageChunk>();
  const writer = writable.getWriter();
  try {
    await writer.write({ type: "start", messageId: input.offerId });
    await writer.write({
      type: "data-dialogue-source",
      id: input.offerId,
      data: {
        offerId: input.offerId,
        sourceInputId: input.context.sourceInputId,
        workId: input.context.workId,
        parentRunId: input.context.parentRunId,
        ...(input.orchestration && input.stage === "final" ? {
          phase: "final_answer", actorRunId: getWorkflowMetadata().workflowRunId,
          utteranceId: publicUtteranceId(input), inputIds: input.publicationInputIds ?? [input.context.sourceInputId],
        } : {}),
      },
    });
  } finally {
    writer.releaseLock();
  }
}

function publicUtteranceId(input: DialogueRunInput): string {
  return input.publicationId && (input.publicationSourceResults?.length ?? 0) > 1
    ? sha256(input.publicationId) : input.offerId;
}

export async function publishDialogueResultStep(args: {
  input: DialogueRunInput;
  artifacts: DialogueTypedArtifact[];
  text: string;
}): Promise<PublicUtterance | undefined> {
  "use step";
  const { input, artifacts, text } = args;
  // While the dialogue was choosing what to say, the thinking flow may have
  // handed off a newer result. Skip an interim publication in that case.
  if (input.stage === "checkpoint" &&
      checkpointSuperseded(input, await listDialogueOffers(input.context.parentRunId))) return undefined;
  const utterance: PublicUtterance = {
    utteranceId: publicUtteranceId(input),
    publicSeq: input.publicSeq,
    committedAt: new Date().toISOString(),
    inputIds: input.publicationInputIds ?? [input.context.sourceInputId],
    sourceResults: input.publicationSourceResults ?? [{ resultId: input.offerId, productRevision: 1, claimIds: [] }],
    phase: input.stage === "checkpoint" ? "commentary" : "final_answer",
    blocks: [
      { kind: "markdown", blockId: `reply:${sha256(input.offerId).slice(0, 32)}`, text },
      ...artifacts.map(({ blockId, artifact }) => ({ kind: "artifact_ref" as const, blockId, artifact })),
    ],
  };
  const writable = getWritable<UIMessageChunk>();
  const writer = writable.getWriter();
  try {
    if (input.stage === "checkpoint") {
      const id = `${input.offerId}:checkpoint`;
      await writer.write({ type: "text-start", id });
      await writer.write({ type: "text-delta", id, delta: text });
      await writer.write({ type: "text-end", id });
    }
    for (const artifact of artifacts) {
      await writer.write({
        type: DIALOGUE_ARTIFACT_CHUNK,
        id: artifact.artifact.artifactId,
        data: artifact,
      });
    }
    await writer.write({
      type: DIALOGUE_PUBLICATION_CHUNK,
      id: utterance.utteranceId,
      data: utterance,
    });
  } finally {
    writer.releaseLock();
  }
  return utterance;
}

export async function startDialogueRecordRunStep(request: DialogueRecordRequest): Promise<string> {
  "use step";
  const { dialogueRecordWorkflow } = await import("./dialogue-record-workflow");
  const run = await start(dialogueRecordWorkflow, [request], {
    region: "hkg1",
    attributes: {
      role: "summary",
      source: request.source.inputId,
      ...(request.utterance ? { offer: request.utterance.utteranceId } : {}),
    },
  });
  return run.runId;
}

export async function closeDialogueStreamStep(args: {
  offerId: string;
  text: string;
  error?: string;
  cancelled?: boolean;
}): Promise<void> {
  "use step";
  const writable = getWritable<UIMessageChunk>();
  const writer = writable.getWriter();
  try {
    await writer.write({
      type: "data-turn-status",
      id: "turn-status-terminal",
      data: {
        status: args.cancelled ? "interrupted" : args.error ? "error" : "done",
        turnId: args.offerId,
        offerId: args.offerId,
        updatedAt: new Date().toISOString(),
        ...(args.error ? { error: args.error } : {}),
      },
    });
    await writer.write({ type: "finish-step" });
    const finish = { type: "finish", protocol: "deepseek-v1", finishReason: args.error ? "error" : "stop" };
    await writer.write(finish);
  } finally {
    writer.releaseLock();
  }
  await writable.close();
}

export async function closeDialogueOffersStep(): Promise<void> {
  "use step";
  await getWritable({ namespace: DIALOGUE_OFFERS_NAMESPACE }).close();
}
export async function closeDialogueThoughtsStep(): Promise<void> {
  "use step";
  const { DIALOGUE_THOUGHTS_NAMESPACE } = await import("@/lib/dialogue/transport");
  await getWritable({ namespace: DIALOGUE_THOUGHTS_NAMESPACE }).close();
}

export function dialogueRecordRequest(
  input: DialogueRunInput,
  utterance?: PublicUtterance,
): DialogueRecordRequest {
  return {
    source: input.context.source,
    sourceTurnId: input.context.sourceTurnId,
    environment: input.context.record,
    ...(utterance ? { utterance } : {}),
  };
}
