/**
 * Native dialogue acceptance. Request preparation is the only work before the
 * thinking Workflow starts; Workflow owns every runtime ID and recovery path.
 */
import { after } from "next/server";
import type { UIMessage } from "@/lib/chat/protocol";
import type { ImageAttachmentEvidence } from "@/lib/chat/image-attachments";
import type { DialogueInput } from "@/lib/chat/dialogue-contract";
import type { ImageReservation } from "@/lib/tools/staged-images";
import { withVerifiedImages } from "@/lib/tools/chat-image-input";
import {
  dialogueResponseError,
  getDialogueStore,
  resolveDialogueScope,
} from "@/lib/dialogue/runtime";
import { digest } from "@/lib/dialogue/artifacts";
import { DialogueConflict } from "@/lib/dialogue/store";
import { dispatchDialogueDueScopes, ensureDialogueDispatch } from "./dispatch-host";
import {
  DIALOGUE_THOUGHTS_NAMESPACE,
  DIALOGUE_TRANSPORT,
  type DialogueAcceptedV2,
} from "@/lib/dialogue/transport";
import { prepareTurnInput, startPreparedTurn, type StartTurnArgs } from "../start-turn";

export interface AcceptDialogueArgs extends StartTurnArgs {
  persona: unknown;
  regenerate: boolean;
  /** Original input id on a dialogue regenerate retry. */
  dialogueInputId?: unknown;
  verifiedImages: ImageAttachmentEvidence[];
  reservation: ImageReservation;
}

export async function acceptDialogueTurnV2(args: AcceptDialogueArgs): Promise<Response> {
  let scope: string;
  try {
    scope = resolveDialogueScope(args.persona);
  } catch (error) {
    await args.reservation.release().catch((cleanup) => console.error("[Images] reservation rollback needs recovery", cleanup));
    return dialogueResponseError(error);
  }

  const prepared = await prepareTurnInput({
    ...args,
    messages: args.messages,
    ...(args.verifiedImages.length ? { verifiedImages: args.verifiedImages } : {}),
  });
  if (!prepared.clientMessageId) {
    await args.reservation.release().catch((cleanup) => console.error("[Images] reservation rollback needs recovery", cleanup));
    return Response.json({ error: "A client message id is required for dialogue acceptance" }, { status: 400 });
  }

  const regenerating = args.regenerate && typeof args.dialogueInputId === "string" && !!args.dialogueInputId;
  const sourceInputId = regenerating
    ? args.dialogueInputId as string
    : digest(JSON.stringify([scope, prepared.clientMessageId])).slice(0, 24);
  const workId = regenerating
    ? digest(JSON.stringify([scope, "regenerate", prepared.clientMessageId])).slice(0, 24)
    : sourceInputId;
  const input: DialogueInput = {
    inputId: sourceInputId,
    clientMessageId: prepared.clientMessageId,
    userSeq: 1,
    eventSeq: 1,
    acceptedAt: prepared.startedAtIso,
    text: prepared.lastUserMessage,
    ...(args.verifiedImages.length
      ? { attachments: args.verifiedImages.map((image) => image.snapshot) }
      : {}),
    ...(prepared.documentContext?.length ? { documentContext: prepared.documentContext } : {}),
  };
  const launch = {
    ...prepared,
    turnId: sourceInputId,
    dialogue: {
      scopeKey: scope,
      workId,
      transport: DIALOGUE_TRANSPORT,
      sourceInputId,
    },
  };

  const run = await startPreparedTurn(launch);
  // The accepted Workflow owns the verified bytes and the native source input.
  await args.reservation.confirm().catch((error) =>
    console.error("[Images] accepted turn confirmation needs recovery", { runId: run.runId, error }));
  const parentRunId = run.runId;
  const response: DialogueAcceptedV2 = {
    version: 2,
    parentRunId,
    runId: parentRunId,
    sourceInputId,
    workId,
    input,
    offersUrl: `/api/chat/${encodeURIComponent(parentRunId)}/offers`,
    thoughtsUrl: `/api/chat/${encodeURIComponent(parentRunId)}/thoughts?workId=${encodeURIComponent(workId)}&namespace=${DIALOGUE_THOUGHTS_NAMESPACE}`,
  };
  return Response.json(response);
}
/** Legacy v1 acceptance remains byte-for-byte store/outbox based. */
export async function acceptDialogueTurn(args: AcceptDialogueArgs): Promise<Response> {
  let store: Awaited<ReturnType<typeof getDialogueStore>>;
  let scope: string;
  try {
    store = await getDialogueStore();
    scope = resolveDialogueScope(args.persona);
  } catch (error) {
    await args.reservation.release().catch((cleanup) => console.error("[Images] reservation rollback needs recovery", cleanup));
    return dialogueResponseError(error);
  }

  const launch = await prepareTurnInput({
    ...args,
    messages: withVerifiedImages(args.messages, args.verifiedImages),
    ...(args.verifiedImages.length ? { verifiedImages: args.verifiedImages } : {}),
  });
  if (!launch.clientMessageId) {
    await args.reservation.release().catch((cleanup) => console.error("[Images] reservation rollback needs recovery", cleanup));
    return Response.json({ error: "A client message id is required for dialogue acceptance" }, { status: 400 });
  }

  try {
    const accepted = args.regenerate && typeof args.dialogueInputId === "string" && args.dialogueInputId
      ? await store.regenerate(scope, args.dialogueInputId, launch.clientMessageId)
      : await store.accept(scope, {
        clientMessageId: launch.clientMessageId,
        launch,
        ...(args.verifiedImages.length
          ? { attachments: args.verifiedImages.map((image) => image.snapshot) }
          : {}),
      });
    await args.reservation.confirm().catch((error) =>
      console.error("[Images] accepted turn confirmation needs recovery", { workId: accepted.workId, error }));
    ensureDialogueDispatch();
    after(() => dispatchDialogueDueScopes().catch((error: unknown) => {
      console.warn(
        "[Dialogue] immediate dispatch failed (persisted outbox remains):",
        error instanceof Error ? error.message : error,
      );
    }));
    return Response.json(accepted);
  } catch (error) {
    if (error instanceof DialogueConflict) {
      await args.reservation.release().catch((cleanup) => console.error("[Images] reservation rollback needs recovery", cleanup));
      return dialogueResponseError(error);
    }
    throw error;
  }
}
