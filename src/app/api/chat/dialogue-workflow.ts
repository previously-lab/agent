import { sleep } from "workflow";
import { isStepCount } from "@/lib/deepseek/tools";
import type { ModelCallStreamPart } from "@/lib/deepseek/types";
import { getWritable } from "workflow";
import { createDialogueAgent } from "@/app/api/agent/agent";
import type {
  DialogueRunInput,
  DialogueRunResult,
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

const ADMISSION_POLLS = 15;

function failureMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** One admitted offer, one public dialogue run. No Git/file/runtime store. */
export async function dialogueWorkflow(input: DialogueRunInput): Promise<DialogueRunResult> {
  "use workflow";
  const childRunId = await dialogueOwnRunIdStep();
  let admission = await dialogueAdmissionStep(input.context.parentRunId, input.offerId, childRunId);
  for (let poll = 1; admission === "pending" && poll < ADMISSION_POLLS; poll++) {
    await sleep("1s");
    admission = await dialogueAdmissionStep(input.context.parentRunId, input.offerId, childRunId);
  }
  if (admission !== "admitted") {
    return {
      kind: "dialogue-reply",
      offerId: input.offerId,
      status: admission === "pending" ? "admission_timeout" : "not_admitted",
      error: admission === "pending"
        ? "The reply admission did not become visible in time."
        : "This reply offer was superseded or its parent had already ended.",
    };
  }

  const prepared = await prepareDialogueOfferStep(input, childRunId);
  await openDialogueStreamStep(input);

  let text = "";
  let error: string | undefined;
  try {
    const agent = createDialogueAgent();
    const result = await agent.stream({
      prompt: prepared.prompt,
      writable: getWritable<ModelCallStreamPart>(),
      stopWhen: isStepCount(1),
      sendFinish: false,
      preventClose: true,
      onStepEnd: (step) => {
        if (step.text) text = step.text;
      },
    });
    text = result.text || text;
  } catch (cause) {
    error = failureMessage(cause);
  }

  let utterance: PublicUtterance | undefined;
  let recordRunId: string | undefined;
  let recordError: string | undefined;
  if (text.trim()) {
    try {
      utterance = await publishDialogueResultStep({ input, artifacts: prepared.artifacts, text });
    } catch (cause) {
      error ??= failureMessage(cause);
    }
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

  // Actual public output (or an honest user-only failure) is handed off after
  // publication. A summary failure never retracts or suppresses that output.
  try {
    recordRunId = await startDialogueRecordRunStep(dialogueRecordRequest(input, utterance));
  } catch (cause) {
    recordError = failureMessage(cause);
    console.warn("[Dialogue] record handoff failed after public output", {
      offerId: input.offerId,
      error: recordError,
    });
  }
  return {
    kind: "dialogue-reply",
    offerId: input.offerId,
    status: error ? "failed" : "completed",
    ...(utterance ? { utterance } : {}),
    artifacts: prepared.artifacts,
    ...(recordRunId ? { recordRunId } : {}),
    ...(recordError ? { recordError } : {}),
    ...(error ? { error } : {}),
  };
}