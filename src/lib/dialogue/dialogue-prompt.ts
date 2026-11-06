import type { ModelMessage } from "@/lib/deepseek/types";
import type {
  DialoguePriorContext,
  DialogueRunInput,
  DialogueTypedArtifact,
} from "./transport";

const PRIOR_CONTEXT_MESSAGES = 8;
const PRIOR_CONTEXT_CHARS = 3_000;
const SOURCE_TEXT_CHARS = 12_000;

function textOf(message: ModelMessage): string {
  if (typeof message.content === "string") return message.content;
  return message.content.flatMap((part) => part.type === "text" ? [part.text] : []).join("\n");
}

/** Only the server's assembled conversation window becomes prior context. */
export function dialoguePriorContext(messages: readonly ModelMessage[], sourceInputText: string): DialoguePriorContext[] {
  return messages.flatMap((message): DialoguePriorContext[] => {
    if (message.role !== "user" && message.role !== "assistant") return [];
    const text = textOf(message).trim();
    if (!text || message.role === "user" && text === sourceInputText.trim()) return [];
    return [{ role: message.role, text: text.slice(0, PRIOR_CONTEXT_CHARS) }];
  }).slice(-PRIOR_CONTEXT_MESSAGES);
}

/** The model sees descriptors and prose; native source never enters this prompt. */
export function buildDialoguePrompt(
  input: DialogueRunInput,
  artifacts: readonly DialogueTypedArtifact[],
  prose: string,
): string {
  return JSON.stringify({
    locale: input.context.locale,
    sourceInput: {
      sourceInputId: input.context.sourceInputId,
      text: input.context.source.text.slice(0, SOURCE_TEXT_CHARS),
      attachments: (input.context.source.attachments ?? []).map((image) => ({
        ordinal: image.ordinal,
        name: image.name,
        mediaType: image.mediaType,
      })),
      documentContext: input.context.source.documentContext ?? [],
    },
    priorContext: input.context.priorContext,
    result: prose.trim(),
    artifacts: artifacts.map(({ artifact }, index) => ({
      ordinal: index + 1,
      artifactId: artifact.artifactId,
      kind: artifact.kind,
      mediaType: artifact.mediaType,
      byteSize: artifact.byteSize,
      summary: artifact.summary,
    })),
  });
}