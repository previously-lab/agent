"use client";

import { useEffect, useState } from "react";
import { readChatEvents } from "@/lib/chat/client-stream";

export type DialogueWorkToolStatus = "running" | "completed" | "failed";
export type DialogueWorkStreamStatus = "waiting" | "live" | "completed" | "failed" | "cancelled";

export type DialogueWorkStreamEvent =
  | { type: "text"; cursor: number; delta: string }
  | { type: "reasoning"; cursor: number; delta: string }
  | { type: "tool"; cursor: number; toolCallId: string; toolName: string; state: DialogueWorkToolStatus }
  | { type: "status"; cursor: number; status: DialogueWorkStreamStatus; retryAfterMs?: number };

export interface DialogueWorkToolView {
  id: string;
  name: string;
  status: DialogueWorkToolStatus;
}

export type DialogueWorkActivity =
  | { type: "text" }
  | { type: "reasoning" }
  | { type: "tool"; toolCallId: string };

export interface DialogueWorkStreamView {
  cursor: number;
  text: string;
  reasoning: string;
  tools: readonly DialogueWorkToolView[];
  activity?: DialogueWorkActivity;
  status?: DialogueWorkStreamStatus;
  unavailable: boolean;
}

export const emptyDialogueWorkStream: DialogueWorkStreamView = {
  cursor: 0, text: "", reasoning: "", tools: [], unavailable: false,
};

/** The work stream is a deliberately narrow, safe projection. Reasoning is
 * accepted only through its explicit safe event; tool arguments, provider
 * fields and error details never enter the client view model. */
export function parseDialogueWorkStreamEvent(value: unknown): DialogueWorkStreamEvent {
  if (!value || typeof value !== "object") throw new Error("Invalid work stream event");
  const event = value as Record<string, unknown>;
  if (typeof event.workId !== "string" || !event.workId ||
    (event.runId !== undefined && typeof event.runId !== "string")) throw new Error("Invalid work stream identity");
  if (!Number.isSafeInteger(event.cursor) || (event.cursor as number) < 0) throw new Error("Invalid work stream cursor");
  if ((event.type === "text" || event.type === "reasoning") && typeof event.delta === "string") {
    return { type: event.type, cursor: event.cursor as number, delta: event.delta };
  }
  if (event.type === "tool" && typeof event.toolCallId === "string" && event.toolCallId &&
    typeof event.toolName === "string" && event.toolName &&
    (event.state === "running" || event.state === "completed" || event.state === "failed")) {
    return { type: "tool", cursor: event.cursor as number, toolCallId: event.toolCallId, toolName: event.toolName, state: event.state };
  }
  if (event.type === "status" && (event.status === "waiting" || event.status === "live" || event.status === "completed" ||
    event.status === "failed" || event.status === "cancelled") &&
    (event.retryAfterMs === undefined || (Number.isFinite(event.retryAfterMs) && (event.retryAfterMs as number) >= 0))) {
    return { type: "status", cursor: event.cursor as number, status: event.status,
      ...(typeof event.retryAfterMs === "number" ? { retryAfterMs: event.retryAfterMs } : {}) };
  }
  throw new Error("Invalid work stream event");
}

export function applyDialogueWorkStreamEvent(state: DialogueWorkStreamView, event: DialogueWorkStreamEvent): DialogueWorkStreamView {
  // A status heartbeat may carry the current cursor; content at or behind it
  // is a replay duplicate. A stale status can never move the cursor backward.
  if (event.cursor < state.cursor || (event.type !== "status" && event.cursor === state.cursor)) return state;
  const next = { ...state, cursor: Math.max(state.cursor, event.cursor), unavailable: false };
  if (event.type === "text") return { ...next, text: state.text + event.delta, activity: { type: "text" } };
  if (event.type === "reasoning") return { ...next, reasoning: state.reasoning + event.delta, activity: { type: "reasoning" } };
  if (event.type === "status") return { ...next, status: event.status };
  const tools = [...state.tools];
  const index = tools.findIndex(tool => tool.id === event.toolCallId);
  const tool = { id: event.toolCallId, name: event.toolName, status: event.state };
  if (index < 0) tools.push(tool); else tools[index] = tool;
  return { ...next, tools, activity: { type: "tool", toolCallId: event.toolCallId } };
}

type Fetch = typeof fetch;

interface WorkStreamOptions {
  workId: string;
  runId?: string;
  thoughtsUrl?: string;
  persona: string;
  signal: AbortSignal;
  onEvent: (event: DialogueWorkStreamEvent) => void;
  request?: Fetch;
}

/** One HTTP attachment. A live/waiting terminal frame tells the caller when
 * to attach again; terminal work needs no reconnect. */
export async function readDialogueWorkStream({ workId, runId, thoughtsUrl, persona, signal, onEvent, request = fetch,
  startIndex = 0 }: WorkStreamOptions & { startIndex?: number }) {
  const endpoint = new URL(thoughtsUrl ?? `/api/chat/dialogue/work/${encodeURIComponent(workId)}/stream`, "http://previously.local");
  endpoint.searchParams.set("workId", workId);
  endpoint.searchParams.set("persona", persona);
  endpoint.searchParams.set("startIndex", String(startIndex));
  if (runId) endpoint.searchParams.set("runId", runId);
  const url = endpoint.origin === "http://previously.local" ? `${endpoint.pathname}${endpoint.search}` : endpoint.toString();
  const response = await request(url, {
    credentials: "same-origin", cache: "no-store", redirect: "error",
    headers: { Accept: "text/event-stream" }, signal,
  });
  if (!response.ok || !response.body) throw new Error("Work stream unavailable");
  let body: ReadableStream<Uint8Array<ArrayBufferLike>> = response.body;
  if (process.env.NEXT_PUBLIC_DIALOGUE_WORK_PREVIEW_DIAGNOSTICS === "1") {
    const reader = response.body.getReader();
    body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        console.info(`[WorkPreviewBrowser] ${JSON.stringify({ time: Date.now(), type: "reader.pull", cursor: -1 })}`);
        const next = await reader.read();
        console.info(`[WorkPreviewBrowser] ${JSON.stringify({ time: Date.now(), type: next.done ? "reader.done" : "network.chunk", cursor: -1 })}`);
        if (next.done) controller.close(); else controller.enqueue(next.value);
      },
      async cancel(reason) { await reader.cancel(reason); },
    });
  }
  let latest: Extract<DialogueWorkStreamEvent, { type: "status" }> | undefined;
  for await (const raw of readChatEvents(body, signal)) {
    if ((raw as { workId?: unknown }).workId !== workId) throw new Error("Wrong work stream");
    const event = parseDialogueWorkStreamEvent(raw);
    if (process.env.NEXT_PUBLIC_DIALOGUE_WORK_PREVIEW_DIAGNOSTICS === "1") {
      console.info(`[WorkPreviewBrowser] ${JSON.stringify({ time: Date.now(), type: `recv.${event.type}`, cursor: event.cursor })}`);
    }
    if (event.type === "status") latest = event;
    onEvent(event);
    if (process.env.NEXT_PUBLIC_DIALOGUE_WORK_PREVIEW_DIAGNOSTICS === "1") {
      console.info(`[WorkPreviewBrowser] ${JSON.stringify({ time: Date.now(), type: `consumed.${event.type}`, cursor: event.cursor })}`);
    }
  }
  return latest;
}

function waitForRetry(delay: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) { reject(new DOMException("Aborted", "AbortError")); return; }
    const abort = () => {
      clearTimeout(timer);
      reject(new DOMException("Aborted", "AbortError"));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, delay);
    signal.addEventListener("abort", abort, { once: true });
  });
}

/** Keep one logical view across server-bounded attachments. The cursor is a
 * raw durable-stream position, so replay resumes without duplicating text. */
export async function streamDialogueWork({ request = fetch, wait = waitForRetry, ...options }: WorkStreamOptions & {
  wait?: (delay: number, signal: AbortSignal) => Promise<void>;
}) {
  let cursor = 0;
  for (;;) {
    const latest = await readDialogueWorkStream({ ...options, request, startIndex: cursor,
      onEvent: event => {
        cursor = Math.max(cursor, event.cursor);
        options.onEvent(event);
      } });
    if (latest?.retryAfterMs === undefined || (latest.status !== "live" && latest.status !== "waiting")) return;
    await wait(latest.retryAfterMs, options.signal);
  }
}

interface DialogueWorkStreamSnapshot {
  identity: string;
  view: DialogueWorkStreamView;
}

/** Identity is part of the read, not just effect cleanup: a render for a new
 * work/run can never expose the previous work's content, even before effects
 * flush. The retry generation also gives preview reconnects a fresh replay. */
export function dialogueWorkStreamIdentity(work: { workId: string; runId?: string; thoughtsUrl?: string }, persona: string, retry = 0) {
  return JSON.stringify([work.workId, work.runId ?? null, work.thoughtsUrl ?? null, persona, retry]);
}

export function selectDialogueWorkStream(snapshot: DialogueWorkStreamSnapshot, identity: string): DialogueWorkStreamView {
  return snapshot.identity === identity ? snapshot.view : emptyDialogueWorkStream;
}

/** The caller keeps this subscribed for the caption's entire mounted life.
 * Folding is presentation-only. Unmounting aborts the read; cancelling work
 * remains an explicit, separate action. */
export function useDialogueWorkStream(
  work: { workId: string; runId?: string; thoughtsUrl?: string },
  persona: string,
  active: boolean,
  retry = 0,
) {
  const workId = work.workId;
  const runId = work.runId;
  const thoughtsUrl = work.thoughtsUrl;
  const identity = dialogueWorkStreamIdentity({ workId, runId, thoughtsUrl }, persona, retry);
  const [snapshot, setSnapshot] = useState<DialogueWorkStreamSnapshot>({ identity, view: emptyDialogueWorkStream });
  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    setSnapshot({ identity, view: emptyDialogueWorkStream });
    void streamDialogueWork({
      workId, runId, thoughtsUrl, persona, signal: controller.signal,
      onEvent: event => {
        if (!controller.signal.aborted) {
          setSnapshot(current => current.identity === identity
            ? { identity, view: applyDialogueWorkStreamEvent(current.view, event) }
            : current);
        }
      },
    }).catch(() => {
      if (!controller.signal.aborted) {
        setSnapshot(current => current.identity === identity
          ? { identity, view: { ...current.view, unavailable: true } }
          : current);
      }
    });
    return () => controller.abort();
  }, [active, identity, persona, workId, runId, thoughtsUrl]);
  return selectDialogueWorkStream(snapshot, identity);
}
