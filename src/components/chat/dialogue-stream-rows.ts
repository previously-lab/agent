import { createDocumentContextMetadata } from "@/lib/chat/document-context";
import type { ContentBlockV1, DialogueArtifactRef, PublicUtterance } from "@/lib/chat/dialogue-contract";
import type { UIMessage, UIMessagePart } from "@/lib/chat/protocol";
import type { LiveStreamItem } from "@/lib/chat/stream-items";
import type { Turn } from "@/lib/episodic/types";
import type { DialogueWorkView, ManuscriptEntry } from "./dialogue-projection";

export interface DialogueMessageMetadata extends Record<string, unknown> {
  acceptedAt?: string;
  sourceInputId?: string;
  workId?: string;
  workStatus?: DialogueWorkView["status"];
  workConnection?: DialogueWorkView["connection"];
  thoughtRunId?: string;
  dialogueRunId?: string;
  thoughtsUrl?: string;
  offersUrl?: string;
  publicationId?: string;
}

export interface DialogueWorkSeat {
  work: DialogueWorkView;
  replying: boolean;
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

export function dialogueMetadata(message: UIMessage): DialogueMessageMetadata {
  return message.metadata && typeof message.metadata === "object"
    ? message.metadata as DialogueMessageMetadata
    : {};
}

export function appendDialogueTurn(messages: readonly UIMessage[], user: UIMessage, assistantId: string, acceptedAt = new Date().toISOString()): UIMessage[] {
  if (messages.some(message => message.id === assistantId)) return [...messages];
  const seatedUser: UIMessage = {
    ...user,
    metadata: { ...dialogueMetadata(user), acceptedAt: dialogueMetadata(user).acceptedAt ?? acceptedAt },
  };
  const assistant: UIMessage = {
    id: assistantId,
    role: "assistant",
    parts: [],
    metadata: { acceptedAt: dialogueMetadata(seatedUser).acceptedAt, workStatus: "queued" } satisfies DialogueMessageMetadata,
  };
  const sourceInputId = dialogueMetadata(seatedUser).sourceInputId;
  const existingUser = messages.findIndex(message => message.role === "user" &&
    (message.id === seatedUser.id || (sourceInputId && dialogueMetadata(message).sourceInputId === sourceInputId)));
  if (existingUser >= 0) return [...messages.slice(0, existingUser + 1), assistant, ...messages.slice(existingUser + 1)];
  return [...messages, seatedUser, assistant];
}

export function removeDialogueTurn(messages: readonly UIMessage[], assistantId: string, userId?: string): UIMessage[] {
  return messages.filter(message => message.id !== assistantId && (!userId || message.id !== userId));
}

export function patchDialogueAssistant(messages: readonly UIMessage[], assistantId: string, metadata: DialogueMessageMetadata): UIMessage[] {
  let changed = false;
  const next = messages.map(message => {
    if (message.id !== assistantId || message.role !== "assistant") return message;
    changed = true;
    return { ...message, metadata: { ...dialogueMetadata(message), ...metadata } };
  });
  return changed ? next : [...messages];
}

function publicationIdOf(message: UIMessage): string | undefined {
  const metadata = dialogueMetadata(message);
  if (metadata.publicationId) return metadata.publicationId;
  for (const part of message.parts) {
    if (part.type !== "data-dialogue-publication" || !part.data || typeof part.data !== "object") continue;
    const id = (part.data as Record<string, unknown>).utteranceId;
    if (typeof id === "string" && id) return id;
  }
  return undefined;
}

/** Only this function moves a public run into the hot history. The local seat
 * identity and work metadata survive the stream's own message id/metadata. */
export function applyDialoguePublicMessage(messages: readonly UIMessage[], assistantId: string, publicMessage: UIMessage,
  metadata: DialogueMessageMetadata = {}): UIMessage[] {
  let changed = false;
  const next = messages.map(message => {
    if (message.id !== assistantId || message.role !== "assistant") return message;
    changed = true;
    const privateParts = message.parts.filter(part => part.type === "reasoning" || part.type === "data-dialogue-thought");
    const publicationId = publicationIdOf(publicMessage) ?? publicMessage.id;
    return {
      ...publicMessage,
      id: message.id,
      role: "assistant" as const,
      parts: [...privateParts, ...publicMessage.parts],
      metadata: {
        ...dialogueMetadata(message),
        ...dialogueMetadata(publicMessage),
        ...metadata,
        ...(publicationId ? { publicationId } : {}),
      },
    };
  });
  return changed ? next : [...messages];
}

export function resetDialogueAssistant(messages: readonly UIMessage[], assistantId: string, acceptedAt = new Date().toISOString()): UIMessage[] {
  let changed = false;
  const next = messages.map(message => {
    if (message.id !== assistantId || message.role !== "assistant") return message;
    changed = true;
    return { ...message, parts: [], metadata: {
      acceptedAt: dialogueMetadata(message).acceptedAt ?? acceptedAt,
      workStatus: "queued",
    } satisfies DialogueMessageMetadata };
  });
  return changed ? next : [...messages];
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function parseArtifactRef(value: unknown): DialogueArtifactRef | null {
  if (!value || typeof value !== "object") return null;
  const artifact = value as Record<string, unknown>;
  if (!nonEmpty(artifact.artifactId) || !nonEmpty(artifact.sourceOwnerId) || artifact.revision !== 1 ||
      (artifact.kind !== "native_html" && artifact.kind !== "document") || !nonEmpty(artifact.mediaType) ||
      !nonEmpty(artifact.sha256) || !Number.isSafeInteger(artifact.byteSize) || (artifact.byteSize as number) < 0) return null;
  return artifact as unknown as DialogueArtifactRef;
}

function sameArtifactIdentity(a: DialogueArtifactRef, b: DialogueArtifactRef): boolean {
  return a.artifactId === b.artifactId && a.sourceOwnerId === b.sourceOwnerId && a.revision === b.revision &&
    a.sha256 === b.sha256 && a.kind === b.kind && a.mediaType === b.mediaType && a.byteSize === b.byteSize;
}

function parsePublicationBlocks(value: unknown): ContentBlockV1[] | null {
  if (!Array.isArray(value)) return null;
  const blocks: ContentBlockV1[] = [];
  for (const candidate of value) {
    if (!candidate || typeof candidate !== "object") return null;
    const block = candidate as Record<string, unknown>;
    if (!nonEmpty(block.blockId)) return null;
    if (block.kind === "markdown" && typeof block.text === "string") {
      blocks.push({ kind: "markdown", blockId: block.blockId, text: block.text });
    } else if (block.kind === "artifact_ref") {
      const artifact = parseArtifactRef(block.artifact);
      if (!artifact) return null;
      blocks.push({ kind: "artifact_ref", blockId: block.blockId, artifact });
    } else if (block.kind === "image_ref" && block.image && typeof block.image === "object") {
      blocks.push(candidate as unknown as ContentBlockV1);
    } else if (block.kind === "citation_ref" && nonEmpty(block.ref)) {
      blocks.push({ kind: "citation_ref", blockId: block.blockId, ref: block.ref,
        ...(typeof block.label === "string" ? { label: block.label } : {}) });
    } else return null;
  }
  return blocks;
}

function publicationFromMessage(message: UIMessage): { utterance: PublicUtterance; artifactBodies: ReadonlyMap<string, string> } | undefined {
  const artifactBodies = new Map<string, { ref: DialogueArtifactRef; body: string }>();
  let utterance: PublicUtterance | undefined;
  for (const part of message.parts) {
    if (part.type === "data-dialogue-artifact" && part.data && typeof part.data === "object") {
      const data = part.data as Record<string, unknown>;
      const artifact = parseArtifactRef(data.artifact);
      if (artifact && nonEmpty(data.blockId) && typeof data.body === "string") {
        artifactBodies.set(artifact.artifactId, { ref: artifact, body: data.body });
      }
    }
    if (part.type !== "data-dialogue-publication" || !part.data || typeof part.data !== "object") continue;
    const data = part.data as Record<string, unknown>;
    const blocks = parsePublicationBlocks(data.blocks);
    if (!nonEmpty(data.utteranceId) || !Number.isSafeInteger(data.publicSeq) || !nonEmpty(data.committedAt) ||
        !Array.isArray(data.inputIds) || !data.inputIds.every(nonEmpty) || !Array.isArray(data.sourceResults) || !blocks) continue;
    utterance = {
      utteranceId: data.utteranceId,
      publicSeq: data.publicSeq as number,
      committedAt: data.committedAt,
      inputIds: data.inputIds,
      sourceResults: data.sourceResults as PublicUtterance["sourceResults"],
      blocks,
    };
  }
  if (!utterance) return undefined;
  const bodies = new Map<string, string>();
  for (const block of utterance.blocks) {
    if (block.kind !== "artifact_ref") continue;
    const candidate = artifactBodies.get(block.artifact.artifactId);
    if (candidate && sameArtifactIdentity(candidate.ref, block.artifact)) {
      bodies.set(block.artifact.artifactId, candidate.body);
    }
  }
  return { utterance, artifactBodies: bodies };
}

function hasPublicContent(message: UIMessage): boolean {
  return message.parts.some(part => part.type === "text" ? part.text.length > 0
    : part.type === "file" || part.type === "data-dialogue-publication");
}

function workForMessage(message: UIMessage, user: UIMessage | undefined, userSeq: number): DialogueWorkView {
  const metadata = dialogueMetadata(message);
  return {
    workId: metadata.workId ?? `pending-${message.id}`,
    inputId: metadata.sourceInputId ?? user?.id ?? message.id,
    userSeq,
    status: metadata.workStatus ?? "completed",
    ...(metadata.thoughtRunId ? { runId: metadata.thoughtRunId } : {}),
    ...(metadata.thoughtsUrl ? { thoughtsUrl: metadata.thoughtsUrl } : {}),
    ...(metadata.workConnection ? { connection: metadata.workConnection } : {}),
  };
}

/** Project the one hot UIMessage[] directly. No event page or second live
 * history participates in seating, and empty assistants remain visible. */
export function dialogueStreamRows(messages: readonly UIMessage[]) {
  const items: LiveStreamItem[] = [];
  const workSeats = new Map<string, DialogueWorkSeat>();
  const utterances = new Map<string, DialogueUtteranceSeat>();
  let latestUser: UIMessage | undefined;
  let userSeq = 0;
  for (const message of messages) {
    const metadata = dialogueMetadata(message);
    const timeIso = metadata.acceptedAt ?? new Date(0).toISOString();
    if (message.role === "user") {
      latestUser = message;
      userSeq++;
      items.push({ kind: "live", key: `dialogue-input:${message.id}`, message, timeIso, startedAt: timeIso, isStreaming: false });
      continue;
    }
    if (message.role !== "assistant") continue;
    const work = workForMessage(message, latestUser, userSeq);
    const key = `dialogue-work:${message.id}`;
    const replying = metadata.workStatus === "running" && Boolean(metadata.dialogueRunId);
    const streaming = replying && hasPublicContent(message);
    let replies: DialogueWorkSeat["replies"];
    if (hasPublicContent(message)) {
      const publication = publicationFromMessage(message);
      if (publication) {
        replies = [{ kind: "utterance", id: publication.utterance.utteranceId, utterance: publication.utterance,
          artifactBodies: publication.artifactBodies }];
      } else {
        replies = [{ kind: "message", id: message.id, sourceInputId: metadata.sourceInputId,
          message, timeIso, isStreaming: streaming }];
      }
    }
    items.push({ kind: "live", key, timeIso, startedAt: timeIso, isStreaming: streaming, message });
    workSeats.set(key, { work, replying, ...(replies ? { replies } : {}) });
    latestUser = undefined;
  }
  return { items, utterances, workSeats };
}

function historyUser(turn: Turn, index: number): UIMessage {
  const inputId = turn.dialogue?.kind === "user_input" ? turn.dialogue.inputId : undefined;
  const id = turn.clientMessageId ?? inputId ?? turn.turnId ?? `history-user-${index}`;
  return {
    id,
    role: "user",
    parts: turn.content ? [{ type: "text", text: turn.content }] : [],
    metadata: {
      ...createDocumentContextMetadata(turn.documentContext ?? []),
      ...(turn.attachments?.length ? { attachments: turn.attachments } : {}),
      ...(inputId ? { sourceInputId: inputId } : {}),
      acceptedAt: turn.timestamp,
    } satisfies DialogueMessageMetadata,
  };
}

function historyAssistant(turn: Turn, index: number): UIMessage {
  const dialogue = turn.dialogue?.kind === "public_utterance" ? turn.dialogue : undefined;
  const publicationId = dialogue?.publicationId;
  const id = turn.turnId ?? publicationId ?? `history-assistant-${index}`;
  const blocks: ContentBlockV1[] = dialogue?.blocks ?? [{ kind: "markdown", blockId: `${id}-body`, text: turn.content }];
  const parts: UIMessagePart[] = turn.content ? [{ type: "text", text: turn.content, state: "done" }] : [];
  if (dialogue) {
    const utterance: PublicUtterance = {
      utteranceId: dialogue.publicationId,
      publicSeq: dialogue.publicSeq,
      committedAt: turn.timestamp,
      inputIds: dialogue.inputIds,
      sourceResults: dialogue.sourceResults,
      blocks,
    };
    parts.push({ type: "data-dialogue-publication", id: dialogue.publicationId, data: utterance });
    for (const block of blocks) {
      if (block.kind !== "artifact_ref") continue;
      const body = turn.artifactBodies?.[block.artifact.artifactId];
      if (body !== undefined) parts.push({ type: "data-dialogue-artifact", id: block.artifact.artifactId,
        data: { blockId: block.blockId, artifact: block.artifact, body } });
    }
  }
  return {
    id,
    role: "assistant",
    parts,
    metadata: {
      acceptedAt: turn.timestamp,
      workId: `history-${id}`,
      workStatus: "completed",
      ...(dialogue?.inputIds[0] ? { sourceInputId: dialogue.inputIds[0] } : {}),
      ...(publicationId ? { publicationId } : {}),
    } satisfies DialogueMessageMetadata,
  };
}

export function dialogueHistoryMessages(turns: readonly Turn[]): UIMessage[] {
  return turns.flatMap((turn, index) => {
    if (turn.role === "user") return [historyUser(turn, index)];
    if (turn.role === "agent") return [historyAssistant(turn, index)];
    return [];
  });
}

/** Saved records arrive after optimistic/live seats. Server-owned public and
 * input identities dedupe them without comparing prose or changing seat ids. */
export function mergeDialogueHistory(messages: readonly UIMessage[], turns: readonly Turn[]): UIMessage[] {
  const users = new Set<string>();
  const publications = new Set<string>();
  const answeredInputs = new Set<string>();
  for (const message of messages) {
    const metadata = dialogueMetadata(message);
    if (message.role === "user") {
      users.add(message.id);
      if (metadata.sourceInputId) users.add(metadata.sourceInputId);
    } else if (message.role === "assistant") {
      publications.add(message.id);
      const publicationId = publicationIdOf(message);
      if (publicationId) publications.add(publicationId);
      if (metadata.sourceInputId) answeredInputs.add(metadata.sourceInputId);
    }
  }
  const fresh = dialogueHistoryMessages(turns).filter(message => {
    const metadata = dialogueMetadata(message);
    if (message.role === "user") return !users.has(message.id) && (!metadata.sourceInputId || !users.has(metadata.sourceInputId));
    const publicationId = publicationIdOf(message);
    return !publications.has(message.id) && (!publicationId || !publications.has(publicationId)) &&
      (!metadata.sourceInputId || !answeredInputs.has(metadata.sourceInputId));
  });
  return fresh.length ? [...fresh, ...messages] : [...messages];
}
