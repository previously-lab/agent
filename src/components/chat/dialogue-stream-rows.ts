import { createDocumentContextMetadata } from "@/lib/chat/document-context";
import type { DialogueInput, PublicUtterance } from "@/lib/chat/dialogue-contract";
import type { LiveStreamItem } from "@/lib/chat/stream-items";
import type { DialogueWorkView, ManuscriptEntry } from "./dialogue-projection";

export interface DialogueWorkSeat {
  work: DialogueWorkView;
  replies?: Exclude<ManuscriptEntry, { kind: "input" }>[];
}

export interface DialoguePublicationSeat {
  utterance: PublicUtterance;
  artifactBodies?: ReadonlyMap<string, string>;
}

export interface DialogueUtteranceSeat {
  publications: DialoguePublicationSeat[];
  inReplyTo?: string;
}

export function dialogueInputExcerpt(input?: DialogueInput): string | undefined {
  const text = input?.text.trim() || input?.documentContext?.[0]?.title || input?.attachments?.[0]?.name;
  if (!text) return undefined;
  const normalized = text.replace(/\s+/g, " ");
  const characters = Array.from(normalized);
  return characters.length > 48 ? `${characters.slice(0, 48).join("")}…` : normalized;
}

function replyTarget(entry: Exclude<ManuscriptEntry, { kind: "input" }>): string {
  return JSON.stringify(entry.kind === "utterance" ? entry.utterance.inputIds : [entry.sourceInputId]);
}

export function dialogueStreamRows(entries: readonly ManuscriptEntry[], inputs: ReadonlyMap<string, DialogueInput>, works: readonly DialogueWorkView[] = []) {
  const utterances = new Map<string, DialogueUtteranceSeat>();
  const workSeats = new Map<string, DialogueWorkSeat>();
  const currentWork = new Map(works.map(work => [work.inputId, work]));
  const seatedReplies = new Set<string>();
  for (const [inputId, work] of currentWork) {
    const belongsToWork = (entry: ManuscriptEntry): entry is Exclude<ManuscriptEntry, { kind: "input" }> =>
      entry.kind === "utterance" ? entry.utterance.inputIds.includes(inputId)
        : entry.kind === "message" && entry.sourceInputId === inputId;
    const first = entries.findIndex(entry => !seatedReplies.has(entry.id) && belongsToWork(entry));
    const replies: Exclude<ManuscriptEntry, { kind: "input" }>[] = [];
    if (first >= 0) {
      const firstReply = entries[first] as Exclude<ManuscriptEntry, { kind: "input" }>;
      const target = replyTarget(firstReply);
      const inputIndex = entries.findIndex(entry => entry.kind === "input" && entry.input.inputId === inputId);
      // The first reply keeps its legacy stable work seat. Later replies may
      // join only when that seat does not move them across another turn.
      const canContinue = inputIndex >= 0 && first === inputIndex + 1;
      replies.push(firstReply);
      seatedReplies.add(firstReply.id);
      if (canContinue) {
        for (let index = first + 1; index < entries.length; index++) {
          const entry = entries[index];
          if (entry.kind === "input" || seatedReplies.has(entry.id) || replyTarget(entry) !== target) break;
          replies.push(entry);
          seatedReplies.add(entry.id);
        }
      }
    }
    workSeats.set(`dialogue-work:${work.workId}`, { work, ...(replies.length ? { replies } : {}) });
  }
  let newestInput: string | undefined;
  let previousReply: string | undefined;
  const items: LiveStreamItem[] = [];
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index];
    if (seatedReplies.has(entry.id)) continue;
    if (entry.kind === "input") {
      const input = entry.input;
      newestInput = input.inputId;
      previousReply = undefined;
      const user: LiveStreamItem = { kind: "live", key: `dialogue-input:${input.inputId}`, timeIso: input.acceptedAt, startedAt: input.acceptedAt, isStreaming: false,
        message: { id: input.clientMessageId, role: "user", parts: [{ type: "text", text: input.text }], metadata: {
          ...createDocumentContextMetadata(input.documentContext ?? []), attachments: input.attachments,
        } } };
      const work = currentWork.get(input.inputId);
      items.push(user);
      if (work) items.push({ kind: "live", key: `dialogue-work:${work.workId}`, timeIso: input.acceptedAt,
        isStreaming: false, message: { id: work.workId, role: "assistant", parts: [] } });
      continue;
    }
    if (entry.kind === "message") {
      items.push({ kind: "live", key: `dialogue-message:${entry.id}`, timeIso: entry.timeIso, startedAt: entry.timeIso,
        isStreaming: entry.isStreaming, message: entry.message });
      continue;
    }
    const { utterance } = entry;
    const key = `dialogue-utterance:${utterance.utteranceId}`;
    const target = JSON.stringify(utterance.inputIds);
    const publications: DialoguePublicationSeat[] = [{ utterance, artifactBodies: entry.artifactBodies }];
    while (index + 1 < entries.length) {
      const next = entries[index + 1];
      if (next.kind !== "utterance" || seatedReplies.has(next.id) || JSON.stringify(next.utterance.inputIds) !== target) break;
      publications.push({ utterance: next.utterance, artifactBodies: next.artifactBodies });
      index++;
    }
    const contextual = target !== previousReply && (utterance.inputIds.length > 1 || utterance.inputIds[0] !== newestInput);
    const inReplyTo = contextual ? utterance.inputIds.slice(0, 2).map(id => dialogueInputExcerpt(inputs.get(id))).filter(Boolean).join(" · ") : undefined;
    previousReply = target;
    utterances.set(key, { publications, inReplyTo });
    items.push({ kind: "live", key, timeIso: utterance.committedAt, isStreaming: false,
      message: { id: utterance.utteranceId, role: "assistant", parts: [] } });
  }
  return { items, utterances, workSeats };
}
