/**
 * Dialogue acceptance — the POST /api/chat branch taken when the client
 * stamps dialogueVersion: 1. The input is persisted into the scoped control
 * store BEFORE anything answers (the browser lane is not authoritative), the
 * work-start intent rides the durable outbox, and only then does the API
 * return the accepted identity. Double submits and lost acknowledgements
 * converge on the same inputId/workId instead of minting new business events.
 */
import { after } from "next/server";
import type { UIMessage } from "@/lib/chat/protocol";
import type { ImageAttachmentEvidence } from "@/lib/chat/image-attachments";
import type { ImageReservation } from "@/lib/tools/staged-images";
import { withVerifiedImages } from "@/lib/tools/chat-image-input";
import {
  dialogueResponseError,
  getDialogueStore,
  resolveDialogueScope,
} from "@/lib/dialogue/runtime";
import { DialogueConflict } from "@/lib/dialogue/store";
import { prepareTurnInput, type StartTurnArgs } from "../start-turn";
import { dispatchDialogueDueScopes } from "./dispatch-host";

export interface AcceptDialogueArgs extends StartTurnArgs {
  persona: unknown;
  regenerate: boolean;
  /** Original input id on a dialogue regenerate retry. */
  dialogueInputId?: unknown;
  verifiedImages: ImageAttachmentEvidence[];
  reservation: ImageReservation;
}

export async function acceptDialogueTurn(args: AcceptDialogueArgs): Promise<Response> {
  // Store creation and scope resolution decide availability/demo — surface
  // that before any reservation commit.
  let store: Awaited<ReturnType<typeof getDialogueStore>>;
  let scope: string;
  try {
    store = await getDialogueStore();
    scope = resolveDialogueScope(args.persona);
  } catch (error) {
    await args.reservation.release().catch((cleanup) => console.error("[Images] reservation rollback needs recovery", cleanup));
    return dialogueResponseError(error);
  }

  // Build the serializable launch exactly like a legacy turn; the store
  // re-binds turnId/dialogue and clears the browser-authored history lane.
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
    // The store owns the bytes' lifecycle now. Never roll back after accept.
    await args.reservation.confirm().catch((error) =>
      console.error("[Images] accepted turn confirmation needs recovery", { workId: accepted.workId, error }));
    after(() => dispatchDialogueDueScopes().catch((error: unknown) => {
      console.warn(
        "[Dialogue] immediate dispatch failed (persisted outbox remains):",
        error instanceof Error ? error.message : error,
      );
    }));
    return Response.json(accepted);
  } catch (error) {
    // Handled rejections release here; unexpected throws propagate so the
    // route's own catch releases exactly once.
    if (error instanceof DialogueConflict) {
      await args.reservation.release().catch((cleanup) => console.error("[Images] reservation rollback needs recovery", cleanup));
      return dialogueResponseError(error);
    }
    throw error;
  }
}
