/** Native V2 starts thinking directly; legacy V1 remains store-backed. */
import { after } from "next/server";
import type { ImageAttachmentEvidence } from "@/lib/chat/image-attachments";
import type { DialogueInput } from "@/lib/chat/dialogue-contract";
import type { ImageReservation } from "@/lib/tools/staged-images";
import { withVerifiedImages } from "@/lib/tools/chat-image-input";
import { messageImageAttachments } from "@/lib/chat/image-attachment-message";
import { restoreDialogueImages } from "@/lib/dialogue/regeneration-images";
import { ImageAttachmentError } from "@/lib/tools/image-validation";
import {
  dialogueResponseError,
  getDialogueStore,
  resolveDialogueScope,
} from "@/lib/dialogue/runtime";
import { digest } from "@/lib/dialogue/artifacts";
import { formatLocalTime } from "@/lib/turn-priming";
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
  dialogueSourceRunId?: unknown;
  verifiedImages: ImageAttachmentEvidence[];
  reservation: ImageReservation;
}

function scopedInputId(scope: string, clientMessageId: string): string {
  return digest(JSON.stringify([scope, clientMessageId])).slice(0, 24);
}

/** Capture identities only. Hot publication rows can have structured blocks and no text part. */
function recentExchangeHints(messages: StartTurnArgs["messages"], scope: string) {
  const current = messages.findLastIndex(message => message.role === "user");
  const inputIds = new Set<string>();
  const publicationIds = new Set<string>();
  // Leave room for unfinished parallel inputs and more than one published checkpoint per input.
  for (let i = current - 1; i >= 0; i--) {
    const row = messages[i];
    if (row.role === "user" && row.id) {
      inputIds.add(scopedInputId(scope, row.id));
      if (inputIds.size === 8) break;
    }
    if (row.role !== "assistant" || publicationIds.size >= 16) continue;
    for (const part of row.parts ?? []) {
      if (part.type !== "data-dialogue-publication" || !part.data || typeof part.data !== "object") continue;
      const id = "utteranceId" in part.data && part.data.utteranceId;
      if (typeof id === "string" && id.length > 0 && id.length <= 256) publicationIds.add(id);
      if (publicationIds.size === 16) break;
    }
  }
  if (inputIds.size && publicationIds.size) return { inputIds: [...inputIds], publicationIds: [...publicationIds] };
}

export async function acceptDialogueTurnV2(args: AcceptDialogueArgs): Promise<Response> {
  let scope: string;
  try {
    scope = resolveDialogueScope(args.persona);
  } catch (error) {
    await args.reservation.release().catch((cleanup) => console.error("[Images] reservation rollback needs recovery", cleanup));
    return dialogueResponseError(error);
  }

  const regenerating = args.regenerate && typeof args.dialogueInputId === "string" && !!args.dialogueInputId;
  const user = args.messages.findLast(message => message.role === "user");
  const hints = regenerating ? messageImageAttachments(user?.metadata) : [];
  if (args.regenerate && user?.metadata && typeof user.metadata === "object" && "attachments" in user.metadata &&
      Array.isArray(user.metadata.attachments) && user.metadata.attachments.length !== hints.length) {
    throw new ImageAttachmentError("regenerate_attachments", "Invalid original attachment metadata");
  }
  const original = hints.length ? await restoreDialogueImages(scope, args.dialogueInputId as string, args.dialogueSourceRunId, hints).catch(error => {
    if (error instanceof ImageAttachmentError) throw error;
    throw new ImageAttachmentError("original_images_unavailable", "Could not read the original images; retry shortly", 503);
  }) : undefined;
  const verifiedImages = original?.images ?? args.verifiedImages;
  const prepared = await prepareTurnInput({
    ...args,
    messages: withVerifiedImages(original ? args.messages.map(message => message === user
      ? { ...message, parts: [{ type: "text", text: original.text }] } : message) : args.messages, verifiedImages),
    ...(original ? { originalUserText: original.text } : {}),
    ...(verifiedImages.length ? { verifiedImages } : {}),
  });
  if (!prepared.clientMessageId) {
    await args.reservation.release().catch((cleanup) => console.error("[Images] reservation rollback needs recovery", cleanup));
    return Response.json({ error: "A client message id is required for dialogue acceptance" }, { status: 400 });
  }

  const sourceInputId = regenerating
    ? args.dialogueInputId as string
    : scopedInputId(scope, prepared.clientMessageId);
  const recentExchanges = args.regenerate ? undefined : recentExchangeHints(args.messages, scope);
  const workId = regenerating
    ? digest(JSON.stringify([scope, "regenerate", prepared.clientMessageId])).slice(0, 24)
    : sourceInputId;
  const input: DialogueInput = {
    inputId: sourceInputId,
    clientMessageId: original?.clientMessageId ?? prepared.clientMessageId,
    userSeq: 1,
    eventSeq: 1,
    acceptedAt: original?.acceptedAt ?? prepared.startedAtIso,
    text: prepared.lastUserMessage,
    ...(verifiedImages.length
      ? { attachments: verifiedImages.map((image) => image.snapshot) }
      : {}),
    ...(prepared.documentContext?.length ? { documentContext: prepared.documentContext } : {}),
  };
  const run = await startPreparedTurn({
    ...prepared,
    turnId: sourceInputId,
    dialogue: {
      scopeKey: scope,
      workId,
      transport: DIALOGUE_TRANSPORT,
      sourceInputId,
      acceptedTime: formatLocalTime(prepared.startedAtIso, prepared.clientTimezone),
      ...(recentExchanges ? { recentExchangeHints: recentExchanges } : {}),
      ...(original ? { originalInput: { acceptedAt: original.acceptedAt, clientMessageId: original.clientMessageId } } : {}),
    },
  });
  await args.reservation.confirm().catch((error) =>
    console.error("[Images] accepted turn confirmation needs recovery", { runId: run.runId, error }));
  const response: DialogueAcceptedV2 = {
    version: 2,
    parentRunId: run.runId,
    runId: run.runId,
    sourceInputId,
    workId,
    input,
    offersUrl: `/api/chat/${encodeURIComponent(run.runId)}/offers`,
    thoughtsUrl: `/api/chat/${encodeURIComponent(run.runId)}/thoughts?workId=${encodeURIComponent(workId)}&namespace=${DIALOGUE_THOUGHTS_NAMESPACE}`,
  };
  return Response.json(response);
}

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
