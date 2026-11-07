import { createHash } from "node:crypto";
import { getWorkflowMetadata, getWritable } from "workflow";
import { start } from "workflow/api";
import type { UIMessageChunk } from "@/lib/chat/protocol";
import type { PublicUtterance } from "@/lib/chat/dialogue-contract";
import { parseNativeSections } from "@/lib/markdown/native-sections";
import { buildDialoguePrompt } from "@/lib/dialogue/dialogue-prompt";
import {
  DIALOGUE_ARTIFACT_CHUNK,
  DIALOGUE_OFFERS_NAMESPACE,
  DIALOGUE_PUBLICATION_CHUNK,
  offerEventFromResult,
  parseOfferReplyResult,
  type DialogueRecordRequest,
  type DialogueRunInput,
  type DialogueTypedArtifact,
  type PreparedDialogueOffer,
} from "@/lib/dialogue/transport";
import { listDialogueOffers, readDialogueAdmission, type DialogueAdmission } from "@/lib/dialogue/workflow-offers";
import type { DialogueOfferEvent } from "@/lib/dialogue/transport";

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

/** Runs after offerReply's start step is durable, before the next model call. */
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

/** Reconcile before fallback so an uncertain control write cannot double offer. */
export async function reconcileDialogueOffersStep(parentRunId: string): Promise<DialogueOfferEvent[]> {
  "use step";
  return listDialogueOffers(parentRunId);
}
function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/** Native source is stored as typed Workflow data, unchanged and out of the prompt. */
export async function prepareDialogueOfferStep(
  input: DialogueRunInput,
  childRunId: string,
): Promise<PreparedDialogueOffer> {
  "use step";
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
  return { artifacts, prompt: buildDialoguePrompt(input, artifacts, prose) };
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
      },
    });
  } finally {
    writer.releaseLock();
  }
}

export async function publishDialogueResultStep(args: {
  input: DialogueRunInput;
  artifacts: DialogueTypedArtifact[];
  text: string;
}): Promise<PublicUtterance> {
  "use step";
  const { input, artifacts, text } = args;
  const utterance: PublicUtterance = {
    utteranceId: input.offerId,
    publicSeq: input.publicSeq,
    committedAt: new Date().toISOString(),
    inputIds: [input.context.sourceInputId],
    sourceResults: [],
    blocks: [
      { kind: "markdown", blockId: `reply:${sha256(input.offerId).slice(0, 32)}`, text },
      ...artifacts.map(({ blockId, artifact }) => ({ kind: "artifact_ref" as const, blockId, artifact })),
    ],
  };
  const writable = getWritable<UIMessageChunk>();
  const writer = writable.getWriter();
  try {
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
