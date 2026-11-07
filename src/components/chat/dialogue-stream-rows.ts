import { createDocumentContextMetadata } from "@/lib/chat/document-context";
import type { DialogueInput, PublicUtterance } from "@/lib/chat/dialogue-contract";
import type { LiveStreamItem } from "@/lib/chat/stream-items";
import type { DialogueWorkView, ManuscriptEntry } from "./dialogue-projection";

export interface DialogueWorkSeat {
  work: DialogueWorkView;
  reply?: Exclude<ManuscriptEntry, { kind: "input" }>;
}

export interface DialogueUtteranceSeat {
  utterance: PublicUtterance;
  artifactBodies?: ReadonlyMap<string, string>;
  inReplyTo?: string;
}

export function dialogueInputExcerpt(input?: DialogueInput): string | undefined {
  const text = input?.text.trim() || input?.documentContext?.[0]?.title || input?.attachments?.[0]?.name;
  if (!text) return undefined;
  const normalized = text.replace(/\s+/g, " ");
  const characters = Array.from(normalized);
  return characters.length > 48 ? `${characters.slice(0, 48).join("")}…` : normalized;
}

export function dialogueStreamRows(entries: readonly ManuscriptEntry[], inputs: ReadonlyMap<string, DialogueInput>, works: readonly DialogueWorkView[] = []) {
  const utterances = new Map<string, DialogueUtteranceSeat>();
  const workSeats = new Map<string, DialogueWorkSeat>();
  const currentWork = new Map(works.map(work => [work.inputId, work]));
  const seatedReplies = new Set<string>();
  for (const [inputId, work] of currentWork) {
    const reply = entries.find((entry): entry is Exclude<ManuscriptEntry, { kind: "input" }> =>
      entry.kind === "utterance" ? entry.utterance.inputIds.includes(inputId)
        : entry.kind === "message" && entry.sourceInputId === inputId);
    workSeats.set(`dialogue-work:${work.workId}`, { work, reply });
    if (reply) seatedReplies.add(reply.id);
  }
  let newestInput: string | undefined;
  let previousReply: string | undefined;
  const items = entries.filter(entry => !seatedReplies.has(entry.id)).flatMap((entry): LiveStreamItem[] => {
    if (entry.kind === "input") {
      const input = entry.input;
      newestInput = input.inputId;
      previousReply = undefined;
      const user: LiveStreamItem = { kind: "live", key: `dialogue-input:${input.inputId}`, timeIso: input.acceptedAt, startedAt: input.acceptedAt, isStreaming: false,
        message: { id: input.clientMessageId, role: "user", parts: [{ type: "text", text: input.text }], metadata: {
          ...createDocumentContextMetadata(input.documentContext ?? []), attachments: input.attachments,
        } } };
      const work = currentWork.get(input.inputId);
      return work ? [user, { kind: "live", key: `dialogue-work:${work.workId}`, timeIso: input.acceptedAt,
        isStreaming: false, message: { id: work.workId, role: "assistant", parts: [] } }] : [user];
    }
    if (entry.kind === "message") {
      return [{ kind: "live", key: `dialogue-message:${entry.id}`, timeIso: entry.timeIso, startedAt: entry.timeIso,
        isStreaming: entry.isStreaming, message: entry.message }];
    }
    const { utterance } = entry;
    const key = `dialogue-utterance:${utterance.utteranceId}`;
    const target = JSON.stringify(utterance.inputIds);
    const contextual = target !== previousReply && (utterance.inputIds.length > 1 || utterance.inputIds[0] !== newestInput);
    const inReplyTo = contextual ? utterance.inputIds.slice(0, 2).map(id => dialogueInputExcerpt(inputs.get(id))).filter(Boolean).join(" · ") : undefined;
    previousReply = target;
    utterances.set(key, { utterance, artifactBodies: entry.artifactBodies, inReplyTo });
    return [{ kind: "live", key, timeIso: utterance.committedAt, isStreaming: false,
      message: { id: utterance.utteranceId, role: "assistant", parts: [] } }];
  });
  return { items, utterances, workSeats };
}
