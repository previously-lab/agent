import { sleep } from "workflow";
import { streamDialogueWording } from "@/lib/dialogue/wording-stream";
import { closeAgentStreamStep } from "@/lib/deepseek/steps";
import type { ModelCallStreamPart } from "@/lib/deepseek/types";
import { getWritable } from "workflow";
import { createDialogueAgent } from "@/app/api/agent/agent";
import {
  DIALOGUE_CHECKPOINT_NAMESPACE,
  type DialogueRunInput,
  type DialogueRunResult,
} from "@/lib/dialogue/transport";
import type { PublicUtterance } from "@/lib/chat/dialogue-contract";
import {
  closeDialogueStreamStep,
  dialogueAdmissionStep,
  dialogueOwnRunIdStep,
  dialogueRecordRequest,
  openDialogueStreamStep,
  prepareDialogueOfferStep,
  publishDialogueResultStep,
  startDialogueRecordRunStep,
} from "./dialogue-transport-steps";



function failureMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** One admitted offer or direct final, one public dialogue run. No runtime store. */
export async function dialogueWorkflow(input: DialogueRunInput): Promise<DialogueRunResult> {
  "use workflow";
  const childRunId = await dialogueOwnRunIdStep();
  if (!input.direct) {
    let admission = await dialogueAdmissionStep(input.context.parentRunId, input.offerId, childRunId);
    let delayMs = 1_000;
    while (admission === "pending") {
      await sleep(delayMs);
      delayMs = Math.min(delayMs * 2, 30_000);
      admission = await dialogueAdmissionStep(input.context.parentRunId, input.offerId, childRunId);
    }
    if (admission !== "admitted") {
      return {
        kind: "dialogue-reply",
        offerId: input.offerId,
        status: "not_admitted",
        error: "This reply offer was superseded or its parent had already ended.",
      };
    }
  }

  const prepared = await prepareDialogueOfferStep(input, childRunId);
  await openDialogueStreamStep(input);
  const checkpoint = input.stage === "checkpoint";
  if (prepared.superseded) {
    await closeDialogueStreamStep({ offerId: input.offerId, text: "" });
    return { kind: "dialogue-reply", offerId: input.offerId, status: "completed", held: true };
  }

  let text = "";
  let held = false;
  let error: string | undefined;
  try {
    const agent = createDialogueAgent(checkpoint, input.direct === true);
    text = await streamDialogueWording(agent, {
      prompt: prepared.prompt,
      // Publish checkpoint text only after the server checks it is still current.
      writable: getWritable<ModelCallStreamPart>(checkpoint ? { namespace: DIALOGUE_CHECKPOINT_NAMESPACE } : undefined),
      sendFinish: false,
    });
    held = checkpoint && !text.trim();
  } catch (cause) {
    error = failureMessage(cause);
  } finally {
    if (checkpoint) await closeAgentStreamStep(getWritable({ namespace: DIALOGUE_CHECKPOINT_NAMESPACE }));
  }

  let utterance: PublicUtterance | undefined;
  let recordRunId: string | undefined;
  let recordError: string | undefined;
  if (text.trim()) {
    try {
      utterance = await publishDialogueResultStep({ input, artifacts: prepared.artifacts, text });
      if (checkpoint && !utterance) {
        held = true;
        text = "";
      }
    } catch (cause) {
      error ??= failureMessage(cause);
    }
  } else if (!error && (input.direct || held)) {
    held = true;
  } else {
    error ??= "The dialogue ended without a public reply.";
  }

  // Publication is already durable. Finish the public stream before queueing
  // background memory work so record admission cannot delay the client tail.
  try {
    await closeDialogueStreamStep({ offerId: input.offerId, text, ...(error ? { error } : {}) });
  } catch (closeError) {
    console.warn("[Dialogue] public stream close failed after publication", {
      offerId: input.offerId,
      error: failureMessage(closeError),
    });
  }

  // Only published checkpoints are stored in the conversation record.
  if (!checkpoint || utterance) {
    try {
      recordRunId = await startDialogueRecordRunStep(dialogueRecordRequest(input, utterance));
    } catch (cause) {
      recordError = failureMessage(cause);
      console.warn("[Dialogue] record handoff failed after public output", {
        offerId: input.offerId,
        error: recordError,
      });
    }
  }
  return {
    kind: "dialogue-reply",
    offerId: input.offerId,
    status: error ? "failed" : "completed",
    ...(held ? { held: true } : {}),
    ...(utterance ? { utterance } : {}),
    artifacts: prepared.artifacts,
    ...(recordRunId ? { recordRunId } : {}),
    ...(recordError ? { recordError } : {}),
    ...(error ? { error } : {}),
  };
}
