"use client";

import type { ContentBlockV1, DialogueArtifactRef, DialogueInput, PublicUtterance } from "@/lib/chat/dialogue-contract";
import { documentContextFromMetadata } from "@/lib/chat/document-context";
import { messageImageAttachments } from "@/lib/chat/image-attachment-message";
import { readDurableChat } from "@/lib/chat/client-transport";
import { readChatEvents } from "@/lib/chat/client-stream";
import type { UIMessage } from "@/lib/chat/protocol";
import { emptyDialogueProjection, type DialogueProjection, type ManuscriptEntry } from "./dialogue-projection";

export interface DialogueAcceptedV2 {
  version: 2;
  parentRunId: string;
  sourceInputId: string;
  workId: string;
  offersUrl: string;
  thoughtsUrl: string;
}

export interface DialogueOffer {
  offerId: string;
  runId: string;
  sourceInputId: string;
}

export interface DialogueParentDone {
  type: "done";
  status?: "running" | "completed" | "failed" | "cancelled";
  cursor?: number;
  retryAfterMs?: number;
}

export type DialogueParentEvent = ({ type: "offer" } & DialogueOffer) | DialogueParentDone;

interface DialogueChildRecord extends DialogueOffer {
  messageId?: string;
  messageAt?: string;
}

interface DialoguePublicationView {
  utterance: PublicUtterance;
  artifactBodies: ReadonlyMap<string, string>;
}

export interface DialogueParentRecord extends DialogueAcceptedV2 {
  acceptedAt: string;
  userMessage?: UIMessage;
  offers: DialogueChildRecord[];
  done: boolean;
  cancelled?: boolean;
}

type ParentStorage = Pick<Storage, "getItem" | "setItem">;
type Fetch = typeof fetch;

const STORAGE_PREFIX = "previously:dialogue:parents:v2:";
const STORED_COMPLETED_PARENTS = 8;

function storageKey(persona: string) {
  return `${STORAGE_PREFIX}${encodeURIComponent(persona)}`;
}

function defaultStorage(): ParentStorage | undefined {
  try { return globalThis.localStorage; } catch { return undefined; }
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

export function parseDialogueAcceptedV2(value: unknown): DialogueAcceptedV2 {
  if (!value || typeof value !== "object") throw new Error("Invalid dialogue acceptance");
  const acceptance = value as Record<string, unknown>;
  if (acceptance.version !== 2 || !nonEmpty(acceptance.parentRunId) || !nonEmpty(acceptance.sourceInputId) ||
      !nonEmpty(acceptance.workId) || !nonEmpty(acceptance.offersUrl) || !nonEmpty(acceptance.thoughtsUrl)) {
    throw new Error("Invalid dialogue acceptance");
  }
  return {
    version: 2,
    parentRunId: acceptance.parentRunId,
    sourceInputId: acceptance.sourceInputId,
    workId: acceptance.workId,
    offersUrl: acceptance.offersUrl,
    thoughtsUrl: acceptance.thoughtsUrl,
  };
}

export function parseDialogueParentEvent(value: unknown): DialogueParentEvent {
  if (!value || typeof value !== "object") throw new Error("Invalid parent stream event");
  const event = value as Record<string, unknown>;
  if (event.type === "done") {
    if (event.status !== undefined && event.status !== "running" && event.status !== "completed" &&
        event.status !== "failed" && event.status !== "cancelled") throw new Error("Invalid parent stream status");
    if (event.cursor !== undefined && (!Number.isSafeInteger(event.cursor) || (event.cursor as number) < 0)) throw new Error("Invalid parent stream cursor");
    if (event.retryAfterMs !== undefined && (!Number.isFinite(event.retryAfterMs) || (event.retryAfterMs as number) < 0)) throw new Error("Invalid parent retry");
    return { type: "done", ...(event.status ? { status: event.status } : {}),
      ...(typeof event.cursor === "number" ? { cursor: event.cursor } : {}),
      ...(typeof event.retryAfterMs === "number" ? { retryAfterMs: event.retryAfterMs } : {}) };
  }
  if (event.type === "offer" && nonEmpty(event.offerId) && nonEmpty(event.runId) && nonEmpty(event.sourceInputId)) {
    return { type: "offer", offerId: event.offerId, runId: event.runId, sourceInputId: event.sourceInputId };
  }
  throw new Error("Invalid parent stream event");
}

export function parseSubmittedUserMessage(body: Record<string, unknown>): UIMessage | undefined {
  if (body.regenerate) return undefined;
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const value = messages.at(-1) as Record<string, unknown> | undefined;
  if (!value || value.role !== "user" || !nonEmpty(value.id) || !Array.isArray(value.parts)) {
    throw new Error("Invalid dialogue input");
  }
  return { id: value.id, role: "user", parts: value.parts as UIMessage["parts"], metadata: value.metadata };
}

function parseStoredRecord(value: unknown): DialogueParentRecord | null {
  try {
    const acceptance = parseDialogueAcceptedV2(value);
    const record = value as Record<string, unknown>;
    if (!nonEmpty(record.acceptedAt) || !Array.isArray(record.offers) || typeof record.done !== "boolean") return null;
    const offers: DialogueChildRecord[] = [];
    const offerIds = new Set<string>();
    for (const candidate of record.offers) {
      const parsed = parseDialogueParentEvent(candidate);
      if (parsed.type !== "offer" || offerIds.has(parsed.offerId)) continue;
      offerIds.add(parsed.offerId);
      const child = candidate as Record<string, unknown>;
      offers.push({
        ...parsed,
        ...(nonEmpty(child.messageId) ? { messageId: child.messageId } : {}),
        ...(nonEmpty(child.messageAt) ? { messageAt: child.messageAt } : {}),
      });
    }
    let userMessage: UIMessage | undefined;
    if (record.userMessage && typeof record.userMessage === "object") {
      const message = record.userMessage as Record<string, unknown>;
      if (!nonEmpty(message.id) || message.role !== "user" || !Array.isArray(message.parts)) return null;
      userMessage = { id: message.id, role: "user", parts: message.parts as UIMessage["parts"], metadata: message.metadata };
    }
    return { ...acceptance, acceptedAt: record.acceptedAt, offers, done: record.done,
      ...(record.cancelled === true ? { cancelled: true } : {}), ...(userMessage ? { userMessage } : {}) };
  } catch {
    return null;
  }
}

export function readDialogueParentRecords(persona: string, storage = defaultStorage()): DialogueParentRecord[] {
  if (!storage) return [];
  try {
    const raw = storage.getItem(storageKey(persona));
    const values: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(values) ? values.flatMap(value => {
      const record = parseStoredRecord(value);
      return record ? [record] : [];
    }) : [];
  } catch {
    return [];
  }
}

function writeDialogueParentRecords(persona: string, records: readonly DialogueParentRecord[], storage = defaultStorage()) {
  if (!storage) return;
  const active = records.filter(record => !record.done && !record.cancelled);
  const completed = records.filter(record => record.done || record.cancelled).slice(-STORED_COMPLETED_PARENTS);
  try { storage.setItem(storageKey(persona), JSON.stringify([...active, ...completed])); } catch { /* local recovery is best-effort */ }
}

export async function readDialogueParentOffers({ offersUrl, startIndex, signal, onEvent, request = fetch }: {
  offersUrl: string;
  startIndex?: number;
  signal: AbortSignal;
  onEvent: (event: DialogueParentEvent) => void;
  request?: Fetch;
}): Promise<DialogueParentDone | null> {
  const endpoint = new URL(offersUrl, "http://previously.local");
  if (startIndex !== undefined) endpoint.searchParams.set("startIndex", String(startIndex));
  const url = endpoint.origin === "http://previously.local" ? `${endpoint.pathname}${endpoint.search}` : endpoint.toString();
  const response = await request(url, {
    credentials: "same-origin", cache: "no-store", redirect: "error",
    headers: { Accept: "text/event-stream" }, signal,
  });
  if (!response.ok || !response.body) throw new Error("Parent stream unavailable");
  for await (const chunk of readChatEvents(response.body, signal)) {
    const event = parseDialogueParentEvent(chunk);
    onEvent(event);
    if (event.type === "done") return event;
  }
  return null;
}

function waitForReconnect(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(new DOMException("Aborted", "AbortError")); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, ms);
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
  });
}

function publicMessageIds(message: UIMessage): string[] {
  const ids = new Set([message.id]);
  if (message.metadata && typeof message.metadata === "object") {
    const metadata = message.metadata as Record<string, unknown>;
    if (nonEmpty(metadata.utteranceId)) ids.add(metadata.utteranceId);
    if (nonEmpty(metadata.publicationId)) ids.add(metadata.publicationId);
  }
  return [...ids];
}

function hasVisibleContent(message: UIMessage): boolean {
  return message.parts.some(part => part.type === "text" ? part.text.length > 0
    : part.type === "file" || part.type === "data-dialogue-publication");
}

function provisionalPublicMessage(message: UIMessage): UIMessage {
  return { ...message, parts: message.parts.filter(part => part.type === "text" || part.type === "file") };
}

function inputForRecord(record: DialogueParentRecord, userSeq: number): DialogueInput | undefined {
  const message = record.userMessage;
  if (!message) return undefined;
  return {
    inputId: record.sourceInputId,
    clientMessageId: message.id,
    userSeq,
    eventSeq: 0,
    acceptedAt: record.acceptedAt,
    text: message.parts.flatMap(part => part.type === "text" ? [part.text] : []).join("\n\n"),
    attachments: messageImageAttachments(message.metadata),
    documentContext: documentContextFromMetadata(message.metadata),
  };
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

/** The terminal typed publication replaces provisional stream parts. Artifact
 * bytes are accepted only for an exact ref in that publication and are still
 * size/hash checked by DialogueArtifact before they reach the sandbox. */
function publicationFromMessage(message: UIMessage): DialoguePublicationView | undefined {
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
    if (!nonEmpty(data.utteranceId) || data.utteranceId !== message.id || !Number.isSafeInteger(data.publicSeq) ||
        !nonEmpty(data.committedAt) || !Array.isArray(data.inputIds) || !data.inputIds.every(nonEmpty) ||
        !Array.isArray(data.sourceResults) || !blocks) continue;
    utterance = { utteranceId: data.utteranceId, publicSeq: data.publicSeq as number, committedAt: data.committedAt,
      inputIds: data.inputIds, sourceResults: data.sourceResults as PublicUtterance["sourceResults"], blocks };
  }
  if (!utterance) return undefined;
  const bodies = new Map<string, string>();
  for (const block of utterance.blocks) {
    if (block.kind !== "artifact_ref") continue;
    const candidate = artifactBodies.get(block.artifact.artifactId);
    if (!candidate || !sameArtifactIdentity(candidate.ref, block.artifact)) continue;
    bodies.set(block.artifact.artifactId, candidate.body);
  }
  return { utterance, artifactBodies: bodies };
}

/** Owns only v2 live transport. The optional historical projection is a
 * separate input to the hook and is never read or polled by this controller. */
export class DialogueParentController {
  private records: DialogueParentRecord[] = [];
  private readonly messages = new Map<string, UIMessage>();
  private readonly publications = new Map<string, DialoguePublicationView>();
  private readonly settledChildren = new Set<string>();
  private readonly failedChildren = new Set<string>();
  private readonly failedParents = new Set<string>();
  private readonly parentCursors = new Map<string, number>();
  private readonly parentTasks = new Map<string, Promise<void>>();
  private readonly childTasks = new Map<string, Promise<void>>();
  private readonly request: Fetch;
  private readonly storage?: ParentStorage;
  private readonly retryDelayMs: number;

  constructor(private readonly options: {
    persona: string;
    signal: AbortSignal;
    onProjection: (projection: DialogueProjection) => void;
    onPublication: () => void;
    request?: Fetch;
    storage?: ParentStorage;
    retryDelayMs?: number;
  }) {
    this.request = options.request ?? fetch;
    this.storage = options.storage ?? defaultStorage();
    this.retryDelayMs = options.retryDelayMs ?? 500;
  }

  start() {
    this.records = readDialogueParentRecords(this.options.persona, this.storage);
    this.emit();
    this.resume();
  }

  resume() {
    for (const record of this.records) {
      if (!record.done && !record.cancelled) this.startParent(record);
      for (const offer of record.offers) this.startChild(record, offer);
    }
  }

  accept(acceptance: DialogueAcceptedV2, userMessage?: UIMessage) {
    if (this.records.some(record => record.parentRunId === acceptance.parentRunId)) return;
    const record: DialogueParentRecord = { ...acceptance, acceptedAt: new Date().toISOString(),
      ...(userMessage ? { userMessage } : {}), offers: [], done: false };
    this.records.push(record);
    this.persist();
    this.emit();
    this.startParent(record);
  }

  async stop(workId?: string) {
    const targets = this.records.filter(record => (!workId || record.workId === workId) && !record.cancelled &&
      (!record.done || record.offers.some(offer => !this.settledChildren.has(offer.runId))));
    await Promise.all(targets.map(async record => {
      const response = await this.request(`/api/chat/${encodeURIComponent(record.parentRunId)}/cancel`, {
        method: "POST", credentials: "same-origin", keepalive: true,
      });
      if (!response.ok) throw new Error("Dialogue stop failed");
      record.cancelled = true;
      record.done = true;
    }));
    this.persist();
    this.emit();
  }

  private persist() {
    writeDialogueParentRecords(this.options.persona, this.records, this.storage);
  }

  private emit() {
    this.options.onProjection(this.projection());
  }

  private projection(): DialogueProjection {
    const base = emptyDialogueProjection();
    const entries: ManuscriptEntry[] = [];
    const inputs = new Map(base.inputs);
    const works = new Map(base.works);
    const utterances = new Set(base.utterances);
    this.records.forEach((record, index) => {
      const input = inputForRecord(record, index + 1);
      if (input) {
        inputs.set(input.inputId, input);
        entries.push({ kind: "input", id: input.inputId, input });
      }
      const failed = this.failedParents.has(record.parentRunId) || record.offers.some(offer => this.failedChildren.has(offer.runId));
      const settled = record.offers.every(offer => this.settledChildren.has(offer.runId));
      const status = record.cancelled ? "cancelled" : failed ? "failed"
        : record.done && settled ? "completed" : this.parentTasks.has(record.parentRunId) || record.offers.length ? "running" : "queued";
      works.set(record.workId, { workId: record.workId, inputId: record.sourceInputId, userSeq: index + 1,
        status, runId: record.parentRunId, thoughtsUrl: record.thoughtsUrl });
      const seenChildren = new Set<string>();
      for (const offer of record.offers) {
        if (seenChildren.has(offer.runId)) continue;
        seenChildren.add(offer.runId);
        const message = this.messages.get(offer.runId);
        if (!message || !hasVisibleContent(message)) continue;
        const publication = this.publications.get(offer.runId);
        if (publication) {
          entries.push({ kind: "utterance", id: publication.utterance.utteranceId, utterance: publication.utterance,
            artifactBodies: publication.artifactBodies });
          utterances.add(publication.utterance.utteranceId);
        } else {
          entries.push({ kind: "message", id: message.id, message: provisionalPublicMessage(message), timeIso: offer.messageAt ?? record.acceptedAt,
            isStreaming: !this.settledChildren.has(offer.runId) });
        }
        for (const id of publicMessageIds(message)) utterances.add(id);
      }
    });
    entries.sort((a, b) => {
      const aTime = a.kind === "input" ? a.input.acceptedAt : a.kind === "message" ? a.timeIso : a.utterance.committedAt;
      const bTime = b.kind === "input" ? b.input.acceptedAt : b.kind === "message" ? b.timeIso : b.utterance.committedAt;
      return aTime.localeCompare(bTime);
    });
    return { ...base, entries, inputs, works, utterances };
  }

  private startParent(record: DialogueParentRecord) {
    if (this.options.signal.aborted || record.done || record.cancelled || this.parentTasks.has(record.parentRunId)) return;
    const task = (async () => {
      let failures = 0;
      while (!this.options.signal.aborted && !record.done && !record.cancelled) {
        try {
          const done = await readDialogueParentOffers({ offersUrl: record.offersUrl, startIndex: this.parentCursors.get(record.parentRunId),
            signal: this.options.signal, request: this.request, onEvent: event => {
              if (event.type === "offer") {
                if (!record.offers.some(offer => offer.offerId === event.offerId)) record.offers.push(event);
                const offer = record.offers.find(candidate => candidate.offerId === event.offerId)!;
                this.startChild(record, offer);
                this.persist();
                this.emit();
              }
            } });
          if (!done) throw new Error("Parent stream ended before done");
          if (done.cursor !== undefined) this.parentCursors.set(record.parentRunId, Math.max(done.cursor, this.parentCursors.get(record.parentRunId) ?? 0));
          failures = 0;
          if (done.status === "running" || done.retryAfterMs !== undefined) {
            await waitForReconnect(done.retryAfterMs ?? this.retryDelayMs, this.options.signal);
            continue;
          }
          record.done = true;
          if (done.status === "cancelled") record.cancelled = true;
          if (done.status === "failed") this.failedParents.add(record.parentRunId);
          this.persist();
          this.emit();
          return;
        } catch (error) {
          if (this.options.signal.aborted || record.cancelled) return;
          await waitForReconnect(Math.min(8_000, this.retryDelayMs * 2 ** failures++), this.options.signal);
        }
      }
    })().catch(() => {}).finally(() => {
      this.parentTasks.delete(record.parentRunId);
      this.emit();
    });
    this.parentTasks.set(record.parentRunId, task);
    this.emit();
  }

  private startChild(record: DialogueParentRecord, offer: DialogueChildRecord) {
    if (this.options.signal.aborted || record.cancelled || this.settledChildren.has(offer.runId) || this.childTasks.has(offer.runId)) return;
    this.failedChildren.delete(offer.runId);
    const task = readDurableChat({
      runId: offer.runId,
      assistantId: `dialogue-child-${offer.runId}`,
      signal: this.options.signal,
      fetch: this.request,
      retryDelayMs: this.retryDelayMs,
      onMessage: message => {
        if (record.cancelled) return;
        const visible = hasVisibleContent(message);
        const first = visible && !offer.messageAt;
        if (visible) offer.messageAt ??= new Date().toISOString();
        const identityChanged = offer.messageId !== message.id;
        offer.messageId = message.id;
        this.messages.set(offer.runId, message);
        const publication = publicationFromMessage(message);
        if (publication) this.publications.set(offer.runId, publication);
        if (first) this.options.onPublication();
        if (first || identityChanged) this.persist();
        this.emit();
      },
    }).then(() => {
      this.settledChildren.add(offer.runId);
      this.failedChildren.delete(offer.runId);
    }).catch(() => {
      if (!this.options.signal.aborted && !record.cancelled) this.failedChildren.add(offer.runId);
    }).finally(() => {
      this.childTasks.delete(offer.runId);
      this.emit();
    });
    this.childTasks.set(offer.runId, task);
  }
}
