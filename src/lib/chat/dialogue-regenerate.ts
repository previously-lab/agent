import type { DialogueInput } from "./dialogue-contract";
import { createDocumentContextEnvelope, createDocumentContextMetadata } from "./document-context";

/** Rebuild the accepted input for the shared route preflight. The store uses
 * dialogueInputId for the original input and the message id for the new work. */
export function buildDialogueRegenerationRequest(
  input: DialogueInput,
  requestId: string,
  options: { locale: string; timezone: string },
): Record<string, unknown> {
  const documentContext = input.documentContext ?? [];
  return {
    regenerate: true,
    inputId: input.inputId,
    dialogueInputId: input.inputId,
    dialogueRequestId: requestId,
    messages: [{
      id: requestId,
      role: "user",
      parts: [{ type: "text", text: input.text }],
      metadata: {
        ...createDocumentContextMetadata(documentContext),
        ...(input.attachments?.length ? { attachments: input.attachments } : {}),
      },
    }],
    ...(documentContext.length ? { documentContext: createDocumentContextEnvelope(documentContext) } : {}),
    locale: options.locale,
    timezone: options.timezone,
  };
}
