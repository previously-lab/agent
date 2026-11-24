import type { ModelMessage } from "@/lib/deepseek/types";
import type {
  DialoguePriorContext,
  DialogueRunInput,
  DialogueTypedArtifact,
} from "./transport";
import { publicationText } from "./orchestrator";
import { WORK_RESPONSE_MODE_GUIDANCE } from "./work-contract";

const PRIOR_CONTEXT_MESSAGES = 8;
const PRIOR_CONTEXT_CHARS = 3_000;

function textOf(message: ModelMessage): string {
  if (typeof message.content === "string") return message.content;
  return message.content.flatMap((part) => part.type === "text" ? [part.text] : []).join("\n");
}

/** Only the server's assembled conversation window becomes prior context. */
export function dialoguePriorContext(messages: readonly ModelMessage[], sourceInputText: string): DialoguePriorContext[] {
  const history = messages.flatMap((message): DialoguePriorContext[] => {
    if (message.role !== "user" && message.role !== "assistant") return [];
    const text = textOf(message).trim();
    return text ? [{ role: message.role, text }] : [];
  });
  const current = history.findLastIndex(message => message.role === "user" && message.text === sourceInputText.trim());
  return history.filter((_, index) => index !== current).slice(-PRIOR_CONTEXT_MESSAGES)
    .map(message => ({ ...message, text: message.text.length > PRIOR_CONTEXT_CHARS
      ? message.text.slice(0, PRIOR_CONTEXT_CHARS) + "… [earlier message excerpt]" : message.text }));
}

/** Supply only handoff events and public context; native source never enters this prompt. */
export function buildDialoguePrompt(
  input: DialogueRunInput,
  artifacts: readonly DialogueTypedArtifact[],
  handoffNotes: string,
  alreadySaid: readonly string[] = [],
): string {
  const inputIds = input.publicationInputIds ?? [input.context.sourceInputId];
  const spokenForInput = [...new Set([
    ...alreadySaid,
    ...(input.orchestration?.publications ?? [])
      .filter(publication => publication.inputIds.some(id => inputIds.includes(id))).map(publicationText),
  ])].filter(text => text.trim());
  return JSON.stringify({
    locale: input.context.locale,
    sourceInput: {
      sourceInputId: input.context.sourceInputId,
      text: input.context.source.text,
      attachments: (input.context.source.attachments ?? []).map((image) => ({
        ordinal: image.ordinal,
        name: image.name,
        mediaType: image.mediaType,
      })),
      documentContext: input.context.source.documentContext ?? [],
    },
    priorContext: input.context.priorContext,
    currentTaskContract: {
      sourceInputId: input.context.sourceInputId,
      responseMode: input.responseMode ?? "focused",
      modeGuidance: WORK_RESPONSE_MODE_GUIDANCE[input.responseMode ?? "focused"],
      candidateIds: input.publicationSourceResults?.map(result => result.resultId) ?? [input.offerId],
      instruction: spokenForInput.length && input.stage !== "checkpoint"
        ? "The public stream already contains the parts in alreadySaid for this request. Reply with the remaining answer or correction, starting with that new point. The final handoff may also contain facts already covered."
        : "Respond to this input using the current event and candidates. Use priorContext, activeWorks and otherOffers as read-only background.",
    },
    stage: input.stage ?? "final",
    priorCheckpoints: (input.priorCheckpoints ?? []).map(({ text }) => text),
    alreadySaid: spokenForInput,
    activeWorks: input.orchestration?.works ?? [],
    otherOffers: (input.orchestration?.offers ?? []).filter(offer => offer.offerId !== input.offerId &&
      inputIds.includes(offer.sourceInputId))
      .map(offer => ({
        offerId: offer.offerId,
        workId: offer.workId,
        sourceInputId: offer.sourceInputId,
        stage: offer.stage,
        text: offer.text,
        event: offer.event,
        ...(offer.relation ? { relation: offer.relation } : {}),
        ...(offer.dependsOnInputIds ? { dependsOnInputIds: offer.dependsOnInputIds } : {}),
      })),
    event: input.event ?? { kind: "work_update", notes: handoffNotes.trim() },
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
