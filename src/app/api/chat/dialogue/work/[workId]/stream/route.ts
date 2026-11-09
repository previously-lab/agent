/**
 * GET /api/chat/dialogue/work/[workId]/stream?persona=&startIndex=
 *
 * A safe view of the durable stream belonging to the store-bound work run.
 * It never starts a model, writes a publication, or accepts an arbitrary run.
 * Reconnects replay the raw prefix through the stateful safety filter, then
 * emit only chunks at/after the requested cursor.
 */
import { getRun } from "workflow/api";
import {
  createWorkPreviewFilter,
  workPreviewCursor,
  type WorkPreviewEvent,
  type WorkPreviewStatus,
} from "@/lib/dialogue/work-preview";
import { authorizeWorkPreview } from "../../work-preview-auth";
import { DIALOGUE_THOUGHTS_NAMESPACE } from "@/lib/dialogue/transport";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const RETRY_MS = 600;
const LIVE_IDLE_MS = 1_000;
const encoder = new TextEncoder();
const DIAGNOSTICS = process.env.DIALOGUE_WORK_PREVIEW_DIAGNOSTICS === "1";

// Test-only structural trace: never include work/run ids, text, tool names,
// tool payloads, error messages, or request data.
function diagnostic(type: string, cursor: number) {
  if (DIAGNOSTICS) console.log(`[WorkPreviewRoute] ${JSON.stringify({ time: Date.now(), type, cursor })}`);
}

function sseResponse(body: ReadableStream<Uint8Array>): Response {
  return new Response(body, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      "x-accel-buffering": "no",
    },
  });
}

function staticStatus(
  workId: string,
  status: WorkPreviewStatus,
  cursor: number,
  runId?: string,
): Response {
  return sseResponse(new ReadableStream<Uint8Array>({
    start(controller) {
      const event: WorkPreviewEvent = {
        type: "status", workId, ...(runId ? { runId } : {}), status, cursor,
        ...(status === "waiting" || status === "live" ? { retryAfterMs: RETRY_MS } : {}),
      };
      controller.enqueue(encoder.encode(`id: ${cursor}\ndata: ${JSON.stringify(event)}\n\n`));
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    },
  }));
}

function unavailable(): Response {
  return Response.json(
    { code: "dialogue_preview_unavailable", error: "Work stream unavailable" },
    { status: 404 },
  );
}

/**
 * Workflow reconnects a framed stream after EOF or an error, but a pending
 * reader.read() has no recovery path. While the run is live, use the durable
 * tail as an idle probe: only a known unconsumed chunk justifies reopening.
 * The caller retains the same filter and resumes at its next raw index.
 */
async function readPreviewChunk(
  readable: { getTailIndex(): Promise<number> },
  pendingRead: Promise<ReadableStreamReadResult<unknown>>,
  nextIndex: number,
  signal: AbortSignal,
  live: boolean,
) {
  if (signal.aborted) return { kind: "aborted" } as const;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<{ kind: "aborted" }>((resolve) => {
    onAbort = () => resolve({ kind: "aborted" });
    signal.addEventListener("abort", onAbort, { once: true });
  });
  const read = pendingRead.then(result => ({ kind: "read", result }) as const);
  try {
    if (live) {
      const idle = new Promise<{ kind: "idle" }>((resolve) => {
        timer = setTimeout(() => resolve({ kind: "idle" }), LIVE_IDLE_MS);
      });
      const outcome = await Promise.race([read, aborted, idle]);
      if (outcome.kind !== "idle") return outcome;
      const tail = await Promise.race([
        read,
        aborted,
        readable.getTailIndex().then(tailIndex => ({ kind: "tail", tailIndex }) as const),
      ]);
      if (tail.kind !== "tail") return tail;
      diagnostic("tail", tail.tailIndex);
      diagnostic("tail.next", nextIndex);
      if (tail.tailIndex >= nextIndex) return { kind: "reopen" } as const;
      return { kind: "waiting" } as const;
    }
    return await Promise.race([read, aborted]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ workId: string }> },
): Promise<Response> {
  const { workId } = await params;
  const authorized = await authorizeWorkPreview(request, workId);
  if (authorized instanceof Response) return authorized;
  const { work } = authorized;
  const url = new URL(request.url);
  const cursor = workPreviewCursor(
    url.searchParams.get("startIndex") ?? request.headers.get("last-event-id"),
  );
  const expectedRunId = url.searchParams.get("runId");
  if (expectedRunId && expectedRunId !== work.runId) {
    return Response.json(
      { code: "dialogue_work_superseded", error: "The work attempt has changed" },
      { status: 409 },
    );
  }
  const runId = work.runId;
  if (!runId) {
    const status = work.status === "completed" || work.status === "failed" || work.status === "cancelled"
      ? work.status : "waiting";
    return staticStatus(workId, status, cursor);
  }

  let run: ReturnType<typeof getRun>;
  let initialStatus: string;
  try {
    run = getRun(runId);
    initialStatus = await run.status;
    diagnostic(`run.${initialStatus}`, cursor);
  } catch {
    return unavailable();
  }

  let readable: ReturnType<typeof run.getReadable>;
  try {
    // Always replay internally. startIndex alone cannot reconstruct whether
    // the cursor sits inside an HTML fence or an unfinished tool structure.
    readable = run.getReadable({ namespace: DIALOGUE_THOUGHTS_NAMESPACE, startIndex: 0 });
    diagnostic("open.initial", 0);
  } catch {
    return unavailable();
  }

  let reader: ReadableStreamDefaultReader<unknown> | undefined;
  let closed = false;
  const attachment = new AbortController();
  const abort = () => {
    diagnostic("abort", -1);
    closed = true;
    attachment.abort();
    void reader?.cancel().catch(() => undefined);
  };
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      const write = (event: WorkPreviewEvent) => {
        if (closed) {
          diagnostic(`safe.skip.${event.type}`, event.cursor);
          return;
        }
        const retry = event.type === "status" && event.retryAfterMs
          ? `retry: ${event.retryAfterMs}\n` : "";
        controller.enqueue(encoder.encode(
          `${retry}id: ${event.cursor}\ndata: ${JSON.stringify(event)}\n\n`,
        ));
        diagnostic(`enqueue.${event.type}`, event.cursor);
      };
      const statusEvent = (status: WorkPreviewStatus, nextCursor: number): WorkPreviewEvent => ({
        type: "status", workId, runId, status, cursor: nextCursor,
        ...(status === "live" ? { retryAfterMs: RETRY_MS } : {}),
      });
      const observedStatus = async (): Promise<WorkPreviewStatus> => {
        if (work.status === "completed" || work.status === "failed" || work.status === "cancelled") {
          return work.status;
        }
        try {
          const status = await run.status;
          if (status === "completed" || status === "failed" || status === "cancelled") return status;
        } catch { /* A reconnect will retry the authoritative lookup. */ }
        return "live";
      };
      if (request.signal.aborted) abort();
      else request.signal.addEventListener("abort", abort, { once: true });
      let rawIndex = 0;
      let pendingRead: Promise<ReadableStreamReadResult<unknown>> | undefined;
      const filter = createWorkPreviewFilter();
      const live = initialStatus === "pending" || initialStatus === "running";
      try {
        if (initialStatus === "pending" || initialStatus === "running") {
          write(statusEvent("live", cursor));
        }
        reader = readable.getReader();
        while (!closed) {
          pendingRead ??= reader.read();
          const outcome = await readPreviewChunk(
            readable, pendingRead, rawIndex, attachment.signal, live,
          );
          if (outcome.kind === "aborted") break;
          if (outcome.kind === "waiting") {
            diagnostic("waiting", rawIndex);
            continue;
          }
          if (outcome.kind === "reopen") {
            diagnostic("reopen", rawIndex);
            const stalled = reader;
            reader = undefined;
            pendingRead = undefined;
            void stalled.cancel().catch(() => undefined);
            try { stalled.releaseLock(); } catch { /* Cancellation may settle on a later microtask. */ }
            readable = run.getReadable({ namespace: DIALOGUE_THOUGHTS_NAMESPACE, startIndex: rawIndex });
            diagnostic("open.resume", rawIndex);
            reader = readable.getReader();
            continue;
          }
          pendingRead = undefined;
          const next = outcome.result;
          if (next.done) break;
          const nextCursor = ++rawIndex;
          const rawType = (next.value as { type?: unknown } | null)?.type;
          diagnostic(`raw.${typeof rawType === "string" ? rawType : "unknown"}`, nextCursor);
          const signal = filter.push(next.value);
          if (signal && nextCursor > cursor) {
            diagnostic(`safe.${signal.type}`, nextCursor);
            write({ ...signal, workId, runId, cursor: nextCursor });
          }
        }
        const finalStatus = await observedStatus();
        diagnostic(`safe.status.${finalStatus}`, Math.max(rawIndex, cursor));
        if (!closed) write(statusEvent(finalStatus, Math.max(rawIndex, cursor)));
      } catch {
        // Durable state survives a failed reader or an expired function. Send
        // no provider detail; the same work/cursor is safe to attach again.
        if (!closed) {
          console.warn(`[Dialogue] preview stream interrupted for work ${workId}; reconnect is safe`);
          write(statusEvent(await observedStatus(), Math.max(rawIndex, cursor)));
        }
      } finally {
        request.signal.removeEventListener("abort", abort);
        try { reader?.releaseLock(); } catch { /* Already released by cancel. */ }
        if (!closed) {
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
          closed = true;
        }
      }
    },
    cancel() {
      abort();
    },
  });
  return sseResponse(body);
}
