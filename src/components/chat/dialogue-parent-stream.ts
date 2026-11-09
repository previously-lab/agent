"use client";

import { readDurableChat } from "@/lib/chat/client-transport";
import { readChatEvents } from "@/lib/chat/client-stream";
import type { UIMessage } from "@/lib/chat/protocol";
import type { DialogueOfferStage } from "@/lib/dialogue/transport";
import { findDialogueThoughtRuns, type DialogueThoughtRecovery } from "@/lib/chat/dialogue-run-recovery";
import {
  appendDialogueTurn,
  applyDialoguePublicMessage,
  dialogueMetadata,
  patchDialogueAssistant,
  type DialogueMessageMetadata,
} from "./dialogue-stream-rows";

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
  stage?: DialogueOfferStage;
}

export interface DialogueParentDone {
  type: "done";
  status?: "running" | "completed" | "failed" | "cancelled";
  cursor?: number;
  retryAfterMs?: number;
}

export type DialogueParentEvent = ({ type: "offer" } & DialogueOffer) | DialogueParentDone;

export interface DialogueParentRecord extends DialogueAcceptedV2 {
  acceptedAt: string;
  assistantId: string;
  userMessage?: UIMessage;
  done: boolean;
  cancelled?: boolean;
  failed?: boolean;
  replyStarted?: boolean;
  replyCompleted?: boolean;
  dialogueRunId?: string;
  publicationId?: string;
}

type ParentStorage = Pick<Storage, "getItem" | "setItem">;
type Fetch = typeof fetch;
type HistorySetter = (update: (previous: UIMessage[]) => UIMessage[]) => void;

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
    return { type: "offer", offerId: event.offerId, runId: event.runId, sourceInputId: event.sourceInputId,
      ...(event.stage === "checkpoint" || event.stage === "final" ? { stage: event.stage } : {}) };
  }
  throw new Error("Invalid parent stream event");
}

export function parseSubmittedUserMessage(body: Record<string, unknown>): UIMessage | undefined {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const inputId = nonEmpty(body.dialogueInputId) ? body.dialogueInputId : undefined;
  const candidates = messages.filter((candidate): candidate is Record<string, unknown> => Boolean(candidate && typeof candidate === "object" &&
    (candidate as Record<string, unknown>).role === "user"));
  const value = inputId ? candidates.find(candidate => candidate.id === inputId ||
      candidate.metadata && typeof candidate.metadata === "object" &&
      (candidate.metadata as Record<string, unknown>).sourceInputId === inputId) : candidates.at(-1);
  if (!value || !nonEmpty(value.id) || !Array.isArray(value.parts)) throw new Error("Invalid dialogue input");
  return { id: value.id, role: "user", parts: value.parts as UIMessage["parts"], metadata: value.metadata };
}

function parseStoredRecord(value: unknown): DialogueParentRecord | null {
  try {
    const acceptance = parseDialogueAcceptedV2(value);
    const record = value as Record<string, unknown>;
    if (!nonEmpty(record.acceptedAt) || !nonEmpty(record.assistantId) || typeof record.done !== "boolean") return null;
    let userMessage: UIMessage | undefined;
    if (record.userMessage && typeof record.userMessage === "object") {
      const message = record.userMessage as Record<string, unknown>;
      if (!nonEmpty(message.id) || message.role !== "user" || !Array.isArray(message.parts)) return null;
      userMessage = { id: message.id, role: "user", parts: message.parts as UIMessage["parts"], metadata: message.metadata };
    }
    return {
      ...acceptance,
      acceptedAt: record.acceptedAt,
      assistantId: record.assistantId,
      done: record.done,
      ...(userMessage ? { userMessage } : {}),
      ...(record.cancelled === true ? { cancelled: true } : {}),
      ...(record.failed === true ? { failed: true } : {}),
      ...(record.replyStarted === true ? { replyStarted: true } : {}),
      ...(record.replyCompleted === true ? { replyCompleted: true } : {}),
      ...(nonEmpty(record.dialogueRunId) ? { dialogueRunId: record.dialogueRunId } : {}),
      ...(nonEmpty(record.publicationId) ? { publicationId: record.publicationId } : {}),
    };
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
  const active = records.filter(record => !record.replyCompleted && !record.cancelled && !record.failed);
  const completed = records.filter(record => record.replyCompleted || record.cancelled || record.failed).slice(-STORED_COMPLETED_PARENTS);
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

function isTerminalDialogueStreamError(error: unknown): boolean {
  if (!error || typeof error !== "object" || (error as { terminal?: unknown }).terminal !== true) return false;
  const message = error instanceof Error ? error.message : "";
  return message !== "Run not available" && !/^Chat stream HTTP \d{3}$/.test(message);
}

function hasVisibleContent(message: UIMessage): boolean {
  return message.parts.some(part => part.type === "text" ? part.text.length > 0
    : part.type === "file" || part.type === "data-dialogue-publication");
}

function publicationIdOf(message: UIMessage): string | undefined {
  const metadata = dialogueMetadata(message);
  if (nonEmpty(metadata.publicationId)) return metadata.publicationId;
  for (const part of message.parts) {
    if (part.type !== "data-dialogue-publication" || !part.data || typeof part.data !== "object") continue;
    const id = (part.data as Record<string, unknown>).utteranceId;
    if (nonEmpty(id)) return id;
  }
  return nonEmpty(message.id) ? message.id : undefined;
}

/** One controller owns independent thought/reply pipelines, but every pipeline
 * writes through the caller's single UIMessage[] history. */
export class DialogueParentController {
  private records: DialogueParentRecord[] = [];
  private readonly settledReplies = new Set<string>();
  private readonly disconnected = new Set<string>();
  private readonly reconnecting = new Set<string>();
  private readonly parentCursors = new Map<string, number>();
  private readonly parentTasks = new Map<string, Promise<void>>();
  private readonly replyTasks = new Map<string, Promise<void>>();
  private readonly published = new Set<string>();
  private readonly request: Fetch;
  private readonly storage?: ParentStorage;
  private readonly retryDelayMs: number;
  private registryTask?: Promise<void>;

  constructor(private readonly options: {
    persona: string;
    signal: AbortSignal;
    getMessages: () => UIMessage[];
    setMessages: HistorySetter;
    onPublication: () => void;
    request?: Fetch;
    storage?: ParentStorage;
    retryDelayMs?: number;
  }) {
    this.request = options.request ?? globalThis.fetch.bind(globalThis);
    this.storage = options.storage ?? defaultStorage();
    this.retryDelayMs = options.retryDelayMs ?? 500;
    this.records = readDialogueParentRecords(this.options.persona, this.storage);
  }

  start(since?: string, savedPublications: ReadonlySet<string> = new Set()) {
    this.records = this.records.filter(record => !record.publicationId || !savedPublications.has(record.publicationId));
    const current = new Set(this.records.map(record => record.parentRunId));
    const restored = readDialogueParentRecords(this.options.persona, this.storage)
      .filter(record => !current.has(record.parentRunId) && (!since || record.acceptedAt >= since))
      .filter(record => !record.publicationId || !savedPublications.has(record.publicationId));
    this.records = [...restored, ...this.records];
    for (const record of this.records) this.restoreSeat(record);
    this.resumeRecords(true);
    void this.recoverFromRegistry();
  }

  resume() {
    this.resumeRecords(false);
  }

  private recoverFromRegistry() {
    if (this.registryTask || this.options.signal.aborted) return;
    const task = findDialogueThoughtRuns(this.options.persona).then(entries => {
      for (const entry of entries) this.mergeRegistryEntry(entry);
      for (const record of this.records) this.restoreSeat(record);
      this.persist();
      this.resumeRecords(true);
    }).catch(() => {
      // Local recovery remains available when the registry cannot be read.
    }).finally(() => {
      if (this.registryTask === task) this.registryTask = undefined;
    });
    this.registryTask = task;
  }

  private mergeRegistryEntry(entry: DialogueThoughtRecovery) {
    const current = this.options.getMessages();
    const userMessage = entry.input ? {
      id: entry.input.clientMessageId,
      role: "user" as const,
      parts: [{ type: "text" as const, text: entry.input.text }],
      metadata: { acceptedAt: entry.input.acceptedAt, sourceInputId: entry.input.inputId },
    } : current.find(message => message.role === "user" && dialogueMetadata(message).sourceInputId === entry.sourceInputId);
    const existingSeat = current.find(message => message.role === "assistant" &&
      dialogueMetadata(message).thoughtRunId === entry.runId);
    let record = this.records.find(candidate => candidate.parentRunId === entry.runId);
    if (!record) {
      record = {
        version: 2,
        parentRunId: entry.runId,
        sourceInputId: entry.sourceInputId,
        workId: entry.workId,
        offersUrl: `/api/chat/${encodeURIComponent(entry.runId)}/offers`,
        thoughtsUrl: `/api/chat/${encodeURIComponent(entry.runId)}/thoughts?workId=${encodeURIComponent(entry.workId)}&namespace=dialogue-thinking-v2`,
        acceptedAt: entry.createdAt ?? entry.input?.acceptedAt ?? new Date().toISOString(),
        assistantId: existingSeat?.id ?? `recovered-${entry.workId}`,
        ...(userMessage ? { userMessage } : {}),
        done: entry.status === "completed" || entry.status === "failed" || entry.status === "cancelled",
      };
      this.records.push(record);
    }
    if (entry.status === "failed") { record.failed = true; record.done = true; }
    if (entry.status === "cancelled") { record.cancelled = true; record.done = true; }
    if (entry.status === "completed") record.done = true;
    if (!record.userMessage && userMessage) record.userMessage = userMessage;
    if (existingSeat) record.assistantId = existingSeat.id;
  }

  private resumeRecords(replayCompleted: boolean) {
    for (const record of this.records) {
      this.disconnected.delete(record.parentRunId);
      if (record.cancelled || record.failed) {
        this.patch(record, { workStatus: record.cancelled ? "cancelled" : "failed", workConnection: "connected" });
        continue;
      }
      if (!record.done) {
        this.startParent(record);
        continue;
      }
      if (this.settledReplies.has(record.parentRunId) || this.replyTasks.has(record.parentRunId)) continue;
      if (record.replyCompleted && !replayCompleted) {
        this.settledReplies.add(record.parentRunId);
        continue;
      }
      if (record.dialogueRunId) this.startPublicReplay(record);
      else this.startReply(record);
    }
  }

  accept(acceptance: DialogueAcceptedV2, assistantId: string, userMessage?: UIMessage) {
    if (this.records.some(record => record.parentRunId === acceptance.parentRunId)) return;
    const record: DialogueParentRecord = {
      ...acceptance,
      acceptedAt: new Date().toISOString(),
      assistantId,
      ...(userMessage ? { userMessage } : {}),
      done: false,
    };
    this.records.push(record);
    if (userMessage) {
      this.options.setMessages(previous => previous.map(message => message.id === userMessage.id && message.role === "user"
        ? { ...message, metadata: { ...dialogueMetadata(message), sourceInputId: acceptance.sourceInputId } }
        : message));
    }
    this.patch(record, this.workMetadata(record, "running"));
    this.persist();
    this.startParent(record);
  }

  async stop(workId?: string) {
    const targets = this.records.filter(record => (!workId || record.workId === workId) && !record.cancelled &&
      !record.failed && !record.replyCompleted);
    await Promise.all(targets.map(async record => {
      const runIds = [...new Set([record.parentRunId, ...(record.dialogueRunId ? [record.dialogueRunId] : [])])];
      const responses = await Promise.all(runIds.map(runId => this.request(`/api/chat/${encodeURIComponent(runId)}/cancel`, {
        method: "POST", credentials: "same-origin", keepalive: true,
      })));
      if (responses.some(response => !response.ok)) throw new Error("Dialogue stop failed");
      record.cancelled = true;
      record.done = true;
      this.patch(record, { workStatus: "cancelled", workConnection: "connected" });
    }));
    this.persist();
  }

  private persist() {
    writeDialogueParentRecords(this.options.persona, this.records, this.storage);
  }

  private workMetadata(record: DialogueParentRecord, workStatus: DialogueMessageMetadata["workStatus"]): DialogueMessageMetadata {
    return {
      sourceInputId: record.sourceInputId,
      workId: record.workId,
      workStatus,
      workConnection: this.disconnected.has(record.parentRunId) ? "disconnected"
        : this.reconnecting.has(record.parentRunId) ? "reconnecting" : "connected",
      thoughtRunId: record.parentRunId,
      thoughtsUrl: record.thoughtsUrl,
      offersUrl: record.offersUrl,
      ...(record.dialogueRunId ? { dialogueRunId: record.dialogueRunId } : {}),
      ...(record.publicationId ? { publicationId: record.publicationId } : {}),
    };
  }

  private patch(record: DialogueParentRecord, metadata: DialogueMessageMetadata) {
    this.options.setMessages(previous => patchDialogueAssistant(previous, record.assistantId, metadata));
  }

  private restoreSeat(record: DialogueParentRecord) {
    this.options.setMessages(previous => {
      const existing = previous.find(message => message.id === record.assistantId ||
        message.role === "assistant" && dialogueMetadata(message).thoughtRunId === record.parentRunId);
      if (existing) {
        record.assistantId = existing.id;
        return patchDialogueAssistant(previous, existing.id, this.workMetadata(record,
          record.cancelled ? "cancelled" : record.failed ? "failed" : record.replyCompleted ? "completed" : "running"));
      }
      if (!record.userMessage) return previous;
      const appended = appendDialogueTurn(previous, record.userMessage, record.assistantId, record.acceptedAt);
      return patchDialogueAssistant(appended, record.assistantId, this.workMetadata(record,
        record.cancelled ? "cancelled" : record.failed ? "failed" : record.replyCompleted ? "completed" : "running"));
    });
  }

  private startParent(record: DialogueParentRecord) {
    if (this.options.signal.aborted || record.done || record.cancelled || record.failed || this.parentTasks.has(record.parentRunId)) return;
    this.patch(record, this.workMetadata(record, "running"));
    const task = (async () => {
      let failures = 0;
      while (!this.options.signal.aborted && !record.done && !record.cancelled) {
        try {
          const done = await readDialogueParentOffers({
            offersUrl: record.offersUrl,
            startIndex: this.parentCursors.get(record.parentRunId),
            signal: this.options.signal,
            request: this.request,
            onEvent: () => {},
          });
          if (!done) throw new Error("Parent stream ended before done");
          if (done.cursor !== undefined) this.parentCursors.set(record.parentRunId, Math.max(done.cursor, this.parentCursors.get(record.parentRunId) ?? 0));
          failures = 0;
          this.reconnecting.delete(record.parentRunId);
          if (done.status === "running" || done.retryAfterMs !== undefined) {
            this.patch(record, this.workMetadata(record, "running"));
            await waitForReconnect(done.retryAfterMs ?? this.retryDelayMs, this.options.signal);
            continue;
          }
          record.done = true;
          if (done.status === "cancelled") record.cancelled = true;
          if (done.status === "failed") record.failed = true;
          this.persist();
          if (record.cancelled || record.failed) {
            this.patch(record, this.workMetadata(record, record.cancelled ? "cancelled" : "failed"));
          } else {
            this.startReply(record);
          }
          return;
        } catch {
          if (this.options.signal.aborted || record.cancelled) return;
          if (failures === 3) {
            this.reconnecting.delete(record.parentRunId);
            this.disconnected.add(record.parentRunId);
            this.patch(record, this.workMetadata(record, "running"));
            return;
          }
          this.reconnecting.add(record.parentRunId);
          this.patch(record, this.workMetadata(record, "running"));
          await waitForReconnect(Math.min(8_000, this.retryDelayMs * 2 ** failures++), this.options.signal);
          this.reconnecting.delete(record.parentRunId);
          this.patch(record, this.workMetadata(record, "running"));
        }
      }
    })().catch(() => {}).finally(() => {
      this.parentTasks.delete(record.parentRunId);
    });
    this.parentTasks.set(record.parentRunId, task);
  }

  private startReply(record: DialogueParentRecord) {
    if (this.options.signal.aborted || record.cancelled || record.failed || this.settledReplies.has(record.parentRunId) ||
        this.replyTasks.has(record.parentRunId)) return;
    record.replyStarted = true;
    this.persist();
    const task = (async () => {
      const response = await this.request("/api/chat/dialogue/reply", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
        body: JSON.stringify({
          thoughtRunId: record.parentRunId,
          workId: record.workId,
          messages: this.options.getMessages(),
        }),
        signal: this.options.signal,
      });
      if (!response.ok) throw Object.assign(new Error(`Dialogue reply HTTP ${response.status}`), {
        terminal: response.status >= 400 && response.status < 500 && response.status !== 408 && response.status !== 429,
      });
      const runId = response.headers.get("x-workflow-run-id");
      if (!runId) throw new Error("Dialogue reply run unavailable");
      record.dialogueRunId = runId;
      this.persist();
      this.patch(record, this.workMetadata(record, "running"));
      await this.readPublicReply(record, response);
    })().catch(error => this.handleReplyError(record, error)).finally(() => {
      this.replyTasks.delete(record.parentRunId);
    });
    this.replyTasks.set(record.parentRunId, task);
  }

  private startPublicReplay(record: DialogueParentRecord) {
    if (this.options.signal.aborted || record.cancelled || record.failed || this.settledReplies.has(record.parentRunId) ||
        this.replyTasks.has(record.parentRunId) || !record.dialogueRunId) return;
    const task = this.readPublicReply(record).catch(error => this.handleReplyError(record, error)).finally(() => {
      this.replyTasks.delete(record.parentRunId);
    });
    this.replyTasks.set(record.parentRunId, task);
  }

  private async readPublicReply(record: DialogueParentRecord, response?: Response) {
    await readDurableChat({
      runId: record.dialogueRunId!,
      assistantId: record.assistantId,
      signal: this.options.signal,
      response,
      fetch: this.request,
      retryDelayMs: this.retryDelayMs,
      onData: chunk => {
        if (chunk.type !== "data-turn-status" || !chunk.data || typeof chunk.data !== "object") return;
        const status = (chunk.data as Record<string, unknown>).status;
        if (status !== "error" && status !== "interrupted") return;
        throw Object.assign(new Error(`Dialogue reply ${status}`), { terminal: true });
      },
      onMessage: message => {
        if (record.cancelled || this.options.signal.aborted) return;
        const publicationId = publicationIdOf(message);
        if (publicationId) record.publicationId = publicationId;
        const visible = hasVisibleContent(message);
        this.options.setMessages(previous => applyDialoguePublicMessage(previous, record.assistantId, message,
          this.workMetadata(record, "running")));
        if (visible && !this.published.has(record.parentRunId)) {
          this.published.add(record.parentRunId);
          this.options.onPublication();
        }
        this.persist();
      },
    });
    if (record.cancelled || this.options.signal.aborted) return;
    record.replyCompleted = true;
    this.settledReplies.add(record.parentRunId);
    this.disconnected.delete(record.parentRunId);
    this.patch(record, this.workMetadata(record, "completed"));
    this.persist();
  }

  private handleReplyError(record: DialogueParentRecord, error: unknown) {
    if (this.options.signal.aborted || record.cancelled) return;
    if (isTerminalDialogueStreamError(error) || error instanceof Error && error.message === "Dialogue reply run unavailable") {
      record.failed = true;
      this.patch(record, this.workMetadata(record, "failed"));
    } else {
      this.disconnected.add(record.parentRunId);
      this.patch(record, this.workMetadata(record, "running"));
    }
    this.persist();
  }
}
