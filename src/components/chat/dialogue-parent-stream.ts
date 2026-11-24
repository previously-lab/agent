"use client";

import { readRecoverySnapshot, writeRecoverySnapshot } from "@/lib/chat/recovery-snapshot";
import { readChatEvents } from "@/lib/chat/client-stream";
import type { PublicUtterance } from "@/lib/chat/dialogue-contract";
import type { UIMessage, UIMessagePart } from "@/lib/chat/protocol";
import type { DialogueOffersDoneEvent, DialogueOfferStage } from "@/lib/dialogue/transport";
import { findDialogueThoughtRuns, type DialogueThoughtRecovery } from "@/lib/chat/dialogue-run-recovery";
import {
  appendDialogueTurn,
  applyDialoguePublication,
  dialogueMetadata,
  patchDialogueAssistant,
  publicationFromMessage,
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
  deliveryStatus?: DialogueOffersDoneEvent["deliveryStatus"];
}

export type DialogueParentEvent = ({ type: "offer" } & DialogueOffer) |
  { type: "dialogue_wake"; runId: string; wakeAt?: string } | DialogueParentDone;

export interface DialogueParentRecord extends DialogueAcceptedV2 {
  acceptedAt: string;
  assistantId: string;
  userMessage?: UIMessage;
  /** Public blocks awaiting archive confirmation. Rich bodies use their authorized source refs. */
  pendingPublications?: PublicUtterance[];
  done: boolean;
  cancelled?: boolean;
  failed?: boolean;
  /** Older cached failures predate the public delivery witness check. */
  failureVerified?: boolean;
  replyStarted?: boolean;
  replyCompleted?: boolean;
  dialogueRunId?: string;
  publicationId?: string;
}

type ParentStorage = Pick<Storage, "getItem" | "setItem">;
type Fetch = typeof fetch;
type HistorySetter = (update: (previous: UIMessage[]) => UIMessage[]) => void;
type FinalPreview = { actorRunId: string; utteranceId: string; offerId: string; record: DialogueParentRecord; text: string };

const STORAGE_PREFIX = "previously:dialogue:parents:v2:";

function storageKey(persona: string, source?: string) {
  return `${STORAGE_PREFIX}${encodeURIComponent(persona)}${source ? ":" + encodeURIComponent(source) : ""}`;
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
    if (event.deliveryStatus !== undefined && event.deliveryStatus !== "delivered" && event.deliveryStatus !== "unverified") throw new Error("Invalid delivery status");
    return { type: "done", ...(event.status ? { status: event.status } : {}),
      ...(event.deliveryStatus ? { deliveryStatus: event.deliveryStatus } : {}),
      ...(typeof event.cursor === "number" ? { cursor: event.cursor } : {}),
      ...(typeof event.retryAfterMs === "number" ? { retryAfterMs: event.retryAfterMs } : {}) };
  }
  if (event.type === "offer" && nonEmpty(event.offerId) && nonEmpty(event.runId) && nonEmpty(event.sourceInputId)) {
    return { type: "offer", offerId: event.offerId, runId: event.runId, sourceInputId: event.sourceInputId,
      ...(event.stage === "checkpoint" || event.stage === "final" ? { stage: event.stage } : {}) };
  }
  if (event.type === "dialogue_wake" && nonEmpty(event.runId)) return { type: "dialogue_wake", runId: event.runId,
    ...(typeof event.wakeAt === "string" && Number.isFinite(Date.parse(event.wakeAt)) ? { wakeAt: event.wakeAt } : {}) };
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
    const pendingPublications = Array.isArray(record.pendingPublications) ? record.pendingPublications.flatMap(data => {
      const parsed = publicationFromMessage({ id: acceptance.parentRunId, role: "assistant",
        parts: [{ type: "data-dialogue-publication", data }] });
      return parsed?.utterance.inputIds.includes(acceptance.sourceInputId) ? [parsed.utterance] : [];
    }) : undefined;
    return {
      ...acceptance,
      ...(pendingPublications ? { pendingPublications } : {}),
      acceptedAt: record.acceptedAt,
      assistantId: record.assistantId,
      done: record.done,
      ...(userMessage ? { userMessage } : {}),
      ...(record.cancelled === true ? { cancelled: true } : {}),
      ...(record.failed === true ? { failed: true } : {}),
      ...(record.failureVerified === true ? { failureVerified: true } : {}),
      ...(record.replyStarted === true ? { replyStarted: true } : {}),
      ...(record.replyCompleted === true ? { replyCompleted: true } : {}),
      ...(nonEmpty(record.dialogueRunId) ? { dialogueRunId: record.dialogueRunId } : {}),
      ...(nonEmpty(record.publicationId) ? { publicationId: record.publicationId } : {}),
    };
  } catch {
    return null;
  }
}

function parseParentRecords(raw: string | null): DialogueParentRecord[] {
  try {
    const values: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(values) ? values.flatMap(value => {
      const record = parseStoredRecord(value);
      return record ? [record] : [];
    }) : [];
  } catch {
    return [];
  }
}

function writeDialogueParentRecords(key: string, records: readonly DialogueParentRecord[], storage = defaultStorage()) {
  if (!storage) return;
  try { writeRecoverySnapshot(storage, key, JSON.stringify(records)); } catch { /* local recovery is best-effort */ }
}

class ParentStreamUnavailable extends Error {}

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
  if ([401, 403, 404, 410].includes(response.status)) throw new ParentStreamUnavailable();
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

/** One controller owns thought recovery and the Workflow dialogue stream. */
export class DialogueParentController {
  private records: DialogueParentRecord[] = [];
  private restoring?: Promise<void>;
  private readonly disconnected = new Set<string>();
  private readonly reconnecting = new Set<string>();
  private readonly parentCursors = new Map<string, number>();
  private readonly parentTasks = new Map<string, Promise<void>>();
  private readonly stopping = new Map<string, Promise<void>>();
  private readonly published = new Set<string>();
  private readonly publishedCandidates = new Set<string>();
  private readonly previews = new Map<string, FinalPreview>();
  private readonly request: Fetch;
  private readonly storage?: ParentStorage;
  private readonly cacheKey: string;
  private readonly retryDelayMs: number;
  private registryTask?: Promise<void>;
  private publicationTask?: Promise<void>;
  private readonly orchestratorTasks = new Map<string, Promise<void>>();
  private readonly idleActorReads = new Map<string, { at: number; controller: AbortController }>();
  private readonly completedOrchestrators = new Set<string>();
  private orchestratorRunId?: string;
  private latestLeaseAt = -Infinity;

  constructor(private readonly options: {
    persona: string;
    source?: string;
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
    this.cacheKey = storageKey(options.persona, options.source);
    this.retryDelayMs = options.retryDelayMs ?? 500;
    try {
      let raw = this.storage ? readRecoverySnapshot(this.storage, this.cacheKey) : null;
      if (raw === null && this.storage && options.source) {
        // Old installations used just the persona. Claim that copy once so a
        // later source change on the same origin cannot import its transcript.
        const oldKey = storageKey(options.persona), legacy = this.storage.getItem(oldKey);
        const ownerKey = oldKey + ":migration-source";
        const owner = this.storage.getItem(ownerKey);
        if (legacy && (!owner || owner === options.source)) {
          this.storage.setItem(ownerKey, options.source);
          raw = readRecoverySnapshot(this.storage, oldKey);
        }
      }
      if (raw instanceof Promise) {
        this.restoring = raw.then(value => {
          const records = new Map([...parseParentRecords(value), ...this.records].map(record => [record.parentRunId, record]));
          this.records = [...records.values()];
        }).catch(() => {}).finally(() => { this.restoring = undefined; });
      } else this.records = parseParentRecords(raw);
    } catch { /* Browser persistence can be unavailable in private mode. */ }
  }

  start(window?: { since?: string; savedPublications: ReadonlySet<string>; answeredInputs: ReadonlySet<string> }) {
    if (window) for (const id of window.savedPublications) this.published.add(id);
    if (this.restoring) {
      void this.restoring.then(() => { if (!this.options.signal.aborted) this.start(window); });
      return;
    }
    this.records = this.records.filter(record => {
      if (!window) return true;
      if (record.pendingPublications) record.pendingPublications = record.pendingPublications.filter(item => !window.savedPublications.has(item.utteranceId));
      if ((!record.done && !record.cancelled && !record.failed) || record.pendingPublications?.length) return true;
      if (record.pendingPublications && !window.answeredInputs.has(record.sourceInputId)) return true;
      // Old local parents contain a prompt and a status, never the public answer.
      // A terminal shell cannot represent a saved reply or a slice outside the opened window.
      if (!window.since || Date.parse(record.acceptedAt) < Date.parse(window.since)) return false;
      return !window.answeredInputs.has(record.sourceInputId) && (!record.publicationId || !window.savedPublications.has(record.publicationId));
    });
    for (const record of this.records) {
      this.restoreSeat(record);
      for (const utterance of record.pendingPublications ?? []) {
        this.published.add(utterance.utteranceId);
        this.options.setMessages(previous => applyDialoguePublication(previous, utterance, { workId: record.workId, inputId: record.sourceInputId }));
      }
    }
    this.resumeRecords(true);
    this.startPublications();
    void this.recoverFromRegistry();
  }

  resume() {
    // Thought streams carry every new wake. A reconnect must not rediscover
    // and replay every historical orchestrator merely because the tab woke.
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
        pendingPublications: [],
        done: entry.status === "completed" || entry.status === "failed" || entry.status === "cancelled",
      };
      this.records.push(record);
    }
    if (entry.status === "failed") { record.failed = true; record.failureVerified = true; record.done = true; }
    if (entry.status === "cancelled") { record.cancelled = true; record.done = true; }
    if (entry.status === "completed") record.done = true;
    if (!record.userMessage && userMessage) record.userMessage = userMessage;
    if (existingSeat) record.assistantId = existingSeat.id;
  }

  private resumeRecords(_replayCompleted: boolean) {
    for (const record of this.records) {
      this.disconnected.delete(record.parentRunId);
      if (record.cancelled || record.failed) {
        this.patch(record, { workStatus: record.cancelled ? "cancelled" : "failed", workConnection: "connected" });
        if (!record.cancelled && !record.failureVerified) this.startParent(record, true);
        continue;
      }
      if (record.done) {
        this.patch(record, { workStatus: "completed", workConnection: "connected" });
        continue;
      }
      this.startParent(record);
    }
  }

  accept(acceptance: DialogueAcceptedV2, assistantId: string, userMessage?: UIMessage) {
    if (this.records.some(record => record.parentRunId === acceptance.parentRunId)) return;
    const record: DialogueParentRecord = {
      ...acceptance,
      acceptedAt: new Date().toISOString(),
      assistantId,
      ...(userMessage ? { userMessage } : {}),
      pendingPublications: [],
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
    this.startPublications();
  }

  async stop(workId?: string) {
    const targets = this.records.filter(record => (!workId || record.workId === workId) && !record.cancelled &&
      !record.failed && (!record.done || record.replyStarted && !record.replyCompleted));
    await Promise.all(targets.map(record => {
      const existing = this.stopping.get(record.parentRunId);
      if (existing) return existing;
      const preview = this.previews.get(record.assistantId);
      if (preview) this.discardPreview(preview);
      // The Actor may already be serving a different question. Only the
      // server can identify children that belong exclusively to this parent.
      const task = this.request(`/api/chat/${encodeURIComponent(record.parentRunId)}/cancel`, {
        method: "POST", credentials: "same-origin", keepalive: true,
      }).then(response => {
        if (!response.ok) throw new Error("Dialogue stop failed");
        record.cancelled = true;
        record.done = true;
        this.patch(record, { workStatus: "cancelled", workConnection: "connected" });
        this.persist();
      }).finally(() => { this.stopping.delete(record.parentRunId); });
      this.stopping.set(record.parentRunId, task);
      return task;
    }));
  }

  private persist() {
    if (this.restoring) {
      void this.restoring.then(() => { if (!this.options.signal.aborted) this.persist(); });
      return;
    }
    writeDialogueParentRecords(this.cacheKey, this.records, this.storage);
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
    if (metadata.workStatus === "cancelled" || metadata.workStatus === "failed") {
      this.previews.delete(record.assistantId);
      metadata = { ...metadata, replyPreview: undefined };
    }
    this.options.setMessages(previous => patchDialogueAssistant(previous, record.assistantId, metadata));
  }

  private restoreSeat(record: DialogueParentRecord) {
    this.options.setMessages(previous => {
      const existing = previous.find(message => message.id === record.assistantId ||
        message.role === "assistant" && dialogueMetadata(message).thoughtRunId === record.parentRunId);
      if (existing) {
        record.assistantId = existing.id;
        return patchDialogueAssistant(previous, existing.id, this.workMetadata(record,
          record.cancelled ? "cancelled" : record.failed ? "failed" : record.done || record.replyCompleted ? "completed" : "running"));
      }
      if (!record.userMessage) return previous;
      const appended = appendDialogueTurn(previous, record.userMessage, record.assistantId, record.acceptedAt);
      return patchDialogueAssistant(appended, record.assistantId, this.workMetadata(record,
        record.cancelled ? "cancelled" : record.failed ? "failed" : record.done || record.replyCompleted ? "completed" : "running"));
    });
  }

  private startParent(record: DialogueParentRecord, recheckFailure = false) {
    if (this.options.signal.aborted || record.cancelled || this.parentTasks.has(record.parentRunId) ||
        (!recheckFailure && (record.done || record.failed))) return;
    if (!recheckFailure) this.patch(record, this.workMetadata(record, "running"));
    const task = (async () => {
      let failures = 0;
      while (!this.options.signal.aborted && (!record.done || recheckFailure) && !record.cancelled) {
        try {
          const done = await readDialogueParentOffers({
            offersUrl: record.offersUrl,
            startIndex: this.parentCursors.get(record.parentRunId),
            signal: this.options.signal,
            request: this.request,
            onEvent: event => {
              if (!recheckFailure && (event.type === "offer" || event.type === "dialogue_wake")) {
                void this.attachOrchestrator(event.runId, event.type === "dialogue_wake" ? event.wakeAt : undefined);
              }
            },
          });
          if (record.cancelled || this.options.signal.aborted) return;
          if (!done) throw new Error("Parent stream ended before done");
          if (done.deliveryStatus === "unverified") throw new Error("Delivery status unavailable");
          if (recheckFailure && !done.status) return;
          if (recheckFailure && done.status === "completed" && done.deliveryStatus !== "delivered") return;
          if (done.cursor !== undefined) this.parentCursors.set(record.parentRunId, Math.max(done.cursor, this.parentCursors.get(record.parentRunId) ?? 0));
          failures = 0;
          this.reconnecting.delete(record.parentRunId);
          if (done.status === "running" || done.retryAfterMs !== undefined) {
            if (recheckFailure) return;
            this.patch(record, this.workMetadata(record, "running"));
            await waitForReconnect(done.retryAfterMs ?? this.retryDelayMs, this.options.signal);
            continue;
          }
          record.done = true;
          if (done.status === "cancelled") record.cancelled = true;
          record.failed = done.status === "failed";
          record.failureVerified = record.failed;
          this.persist();
          if (record.cancelled || record.failed) {
            this.patch(record, this.workMetadata(record, record.cancelled ? "cancelled" : "failed"));
          } else {
            this.patch(record, this.workMetadata(record, "completed"));
          }
          return;
        } catch (error) {
          if (this.options.signal.aborted || record.cancelled) return;
          if (error instanceof ParentStreamUnavailable) {
            this.reconnecting.delete(record.parentRunId);
            this.disconnected.add(record.parentRunId);
            if (!recheckFailure) this.patch(record, this.workMetadata(record, "running"));
            return;
          }
          if (!recheckFailure) {
            this.reconnecting.add(record.parentRunId);
            this.patch(record, this.workMetadata(record, "running"));
          }
          await waitForReconnect(Math.min(8_000, this.retryDelayMs * 2 ** failures++), this.options.signal);
        }
      }
    })().catch(() => {}).finally(() => {
      this.parentTasks.delete(record.parentRunId);
    });
    this.parentTasks.set(record.parentRunId, task);
  }

  /** Discovery happens only on mount/recovery or a newly accepted input. */
  private startPublications() {
    if (this.publicationTask || this.options.signal.aborted) return;
    const task = (async () => {
      const response = await this.request(`/api/chat/dialogue/orchestrator?persona=${encodeURIComponent(this.options.persona)}`, {
        credentials: "same-origin", cache: "no-store", signal: this.options.signal,
      });
      if (!response.ok) throw new Error("Dialogue discovery unavailable");
      const discovery = await response.json() as {
        runId: string | null;
        status: string;
        runs?: Array<{ runId: string; status: string; createdAt?: string; triggeredAt?: string }>;
      };
      const discovered = discovery.runs ??
        (discovery.runId ? [{ runId: discovery.runId, status: discovery.status }] : []);
      // Terminal Workflow runs are history, not live subscriptions. Remember
      // them so a delayed wake cannot attach them after this discovery either.
      for (const run of discovered) {
        if (nonEmpty(run.runId) && run.status !== "pending" && run.status !== "running") {
          this.completedOrchestrators.add(run.runId);
        }
      }
      const runs = discovered.filter(run => nonEmpty(run.runId) && (run.status === "pending" || run.status === "running"))
        .sort((a, b) => (a.createdAt ?? a.triggeredAt ?? "").localeCompare(b.createdAt ?? b.triggeredAt ?? ""));
      if (runs.length && (!this.orchestratorRunId || this.completedOrchestrators.has(this.orchestratorRunId))) {
        this.selectOrchestrator(runs.at(-1)!.runId);
      }
      for (const run of runs) void this.attachOrchestrator(run.runId);
    })().catch(() => undefined).finally(() => {
      if (this.publicationTask === task) this.publicationTask = undefined;
    });
    this.publicationTask = task;
  }

  private selectOrchestrator(runId: string) {
    if (this.orchestratorRunId === runId) return;
    this.orchestratorRunId = runId;
    for (const preview of this.previews.values()) {
      if (preview.actorRunId !== runId) this.discardPreview(preview);
    }
  }

  private attachOrchestrator(runId: string, wakeAt?: string): Promise<void> {
    if (this.completedOrchestrators.has(runId)) return Promise.resolve();
    // A wake may be replayed from an older thought. Subscribe for committed
    // publications, but only lease or handoff evidence can unseat a live Actor.
    if (!this.orchestratorRunId || this.completedOrchestrators.has(this.orchestratorRunId)) {
      this.selectOrchestrator(runId);
    }
    const existing = this.orchestratorTasks.get(runId);
    if (existing) {
      const idle = this.idleActorReads.get(runId);
      if (idle && wakeAt && Date.parse(wakeAt) > idle.at) idle.controller.abort();
      return existing;
    }
    const task = this.followOrchestrator(runId).catch(() => undefined).finally(() => {
      this.orchestratorTasks.delete(runId);
    });
    this.orchestratorTasks.set(runId, task);
    return task;
  }

  private discardPreview(preview: FinalPreview) {
    if (this.previews.get(preview.record.assistantId) !== preview) return;
    this.previews.delete(preview.record.assistantId);
    if (preview.text) this.patch(preview.record, { replyPreview: undefined });
  }

  private bindFinalPreview(runId: string, messageId: string | undefined, data?: Record<string, unknown>): FinalPreview | undefined {
    if (this.orchestratorRunId !== runId || data?.phase !== "final_answer" || data.actorRunId !== runId ||
        !nonEmpty(messageId) || data.offerId !== messageId || this.publishedCandidates.has(messageId) ||
        !nonEmpty(data.utteranceId) || this.published.has(data.utteranceId) || !Array.isArray(data.inputIds) ||
        data.inputIds.length !== 1 || data.inputIds[0] !== data.sourceInputId) return;
    const record = this.records.find(item => !item.done && !item.cancelled && !item.failed &&
      item.parentRunId === data.parentRunId && item.workId === data.workId && item.sourceInputId === data.sourceInputId);
    if (!record || this.stopping.has(record.parentRunId)) return;
    const previous = this.previews.get(record.assistantId);
    if (previous) this.discardPreview(previous);
    const preview = { actorRunId: runId, utteranceId: data.utteranceId, offerId: messageId, record, text: "" };
    this.previews.set(record.assistantId, preview);
    return preview;
  }

  private async followOrchestrator(runId: string): Promise<void> {
    const { signal } = this.options;
    let delay = this.retryDelayMs;
    while (!signal.aborted && !this.completedOrchestrators.has(runId)) {
      const attempt = new AbortController();
      await this.readOrchestrator(runId, attempt).catch(() => undefined);
      if (signal.aborted || this.completedOrchestrators.has(runId)) return;
      // A newer parent wake after exit_intent restarts an idle reader now.
      if (attempt.signal.aborted) { delay = this.retryDelayMs; continue; }
      await waitForReconnect(delay, signal);
      delay = Math.min(delay * 2, 30_000);
    }
  }

  private async readOrchestrator(runId: string, attempt: AbortController): Promise<void> {
    const signal = AbortSignal.any([this.options.signal, attempt.signal]);
    const response = await this.request(`/api/chat/${encodeURIComponent(runId)}/stream?startIndex=0`, {
      credentials: "same-origin", cache: "no-store", redirect: "error",
      headers: { Accept: "text/event-stream" }, signal,
    });
    if ([401, 403, 404, 410].includes(response.status)) {
      this.completedOrchestrators.add(runId);
      return;
    }
    if (!response.ok || !response.body) throw new Error("Dialogue stream unavailable");
    const markComplete = () => { this.completedOrchestrators.add(runId); };
    let messageId: string | undefined;
    let preview: FinalPreview | undefined;
    let textId: string | undefined;
    let artifacts: UIMessagePart[] = [];
    const discard = () => {
      if (preview) this.discardPreview(preview);
      preview = undefined;
      textId = undefined;
    };
    try {
      for await (const chunk of readChatEvents(response.body, signal, markComplete)) {
        const data = chunk.data as Record<string, unknown> | undefined;
        if (chunk.type === "data-dialogue-exit_intent" && typeof data?.at === "string") {
          this.idleActorReads.set(runId, { at: Date.parse(data.at), controller: attempt });
        } else this.idleActorReads.delete(runId);
        if (chunk.type === "start") {
          discard();
          messageId = chunk.messageId;
          artifacts = [];
        } else if (chunk.type === "data-dialogue-lease_acquired" && typeof data?.at === "string") {
          const at = Date.parse(data.at);
          if (!this.completedOrchestrators.has(runId) && at > this.latestLeaseAt) {
            this.latestLeaseAt = at;
            this.selectOrchestrator(runId);
          }
        } else if (chunk.type === "data-dialogue-source") {
          discard();
          preview = this.bindFinalPreview(runId, messageId, data);
        } else if (chunk.type === "start-step" || chunk.type === "reset-step") {
          // A new attempt may reuse the provider's text block ID.
          textId = undefined;
          if (preview && this.previews.get(preview.record.assistantId) === preview && preview.text) {
            preview.text = "";
            this.patch(preview.record, { replyPreview: undefined });
          }
        } else if (chunk.type === "text-start") {
          textId = chunk.id;
        } else if (chunk.type === "text-delta" && preview && textId && chunk.id === textId && typeof chunk.delta === "string" &&
            this.previews.get(preview.record.assistantId) === preview && !preview.record.cancelled && !preview.record.failed) {
          preview.text += chunk.delta;
          if (preview.text.trim()) this.patch(preview.record, { replyPreview: {
            actorRunId: runId, utteranceId: preview.utteranceId, text: preview.text,
          } });
        } else if (chunk.type === "text-end") {
          if (chunk.id === textId) textId = undefined;
        } else if (chunk.type === "data-dialogue-artifact" && globalThis.crypto?.subtle) {
          // On insecure origins the existing artifact GET verifies SHA-256
          // server-side. Inline bytes require the renderer's Web Crypto check.
          artifacts.push({ type: chunk.type, id: chunk.id, data });
        } else if (chunk.type === "data-dialogue-publication") {
          const publication = publicationFromMessage({ role: "assistant", id: runId,
            parts: [...artifacts, { type: chunk.type, id: chunk.id, data }] }, runId);
          if (publication) this.publish(runId, publication.utterance, publication.artifactBodies);
          discard();
          artifacts = [];
        } else if (chunk.type === "data-dialogue-continued" || chunk.type === "data-dialogue-delegated") {
          discard();
          const target = data?.nextRunId ?? data?.holderRunId;
          if (nonEmpty(target) && target !== runId) {
            this.completedOrchestrators.add(runId);
            if (this.orchestratorRunId === runId && !this.completedOrchestrators.has(target)) this.selectOrchestrator(target);
            void this.attachOrchestrator(target);
          }
        } else if (chunk.type === "data-turn-status" || chunk.type === "data-dialogue-expression_outcome" ||
            chunk.type === "error" || chunk.type === "abort" || chunk.type === "finish") {
          discard();
          if (chunk.type === "finish") markComplete();
        }
      }
    } finally {
      // Truncation, reconnect from zero, and abort cannot leave an orphan.
      this.idleActorReads.delete(runId);
      discard();
    }
  }

  private publish(runId: string, utterance: PublicUtterance, artifactBodies: ReadonlyMap<string, string>) {
    for (const result of utterance.sourceResults) this.publishedCandidates.add(result.resultId);
    const known = this.published.has(utterance.utteranceId);
    const replaced = [...this.previews.values()].filter(preview => preview.utteranceId === utterance.utteranceId ||
      utterance.sourceResults.some(result => result.resultId === preview.offerId) ||
      (!known && runId === preview.actorRunId && utterance.phase === "final_answer" && utterance.inputIds.includes(preview.record.sourceInputId)));
    if (known) {
      for (const preview of replaced) this.discardPreview(preview);
      return;
    }
    this.published.add(utterance.utteranceId);
    const work = this.records
      .filter(record => utterance.inputIds.includes(record.sourceInputId))
      .sort((a, b) => b.acceptedAt.localeCompare(a.acceptedAt))[0];
    if (work) {
      (work.pendingPublications ??= []).push(utterance);
      this.persist();
    }
    for (const preview of replaced) this.previews.delete(preview.record.assistantId);
    this.options.setMessages(previous => {
      let messages = previous;
      for (const preview of replaced) messages = patchDialogueAssistant(messages, preview.record.assistantId, { replyPreview: undefined });
      return applyDialoguePublication(messages, utterance, work ? { workId: work.workId, inputId: work.sourceInputId } : undefined, artifactBodies);
    });
    this.options.onPublication();
  }
}
