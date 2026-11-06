/** Opt-in safe thought preview from the thinking run's private namespace. */
import { getRun } from "workflow/api";
import { guardDialogueRead } from "@/lib/dialogue/runtime";
import {
  createWorkPreviewFilter,
  workPreviewCursor,
  type WorkPreviewEvent,
  type WorkPreviewStatus,
} from "@/lib/dialogue/work-preview";
import { DIALOGUE_THOUGHTS_NAMESPACE } from "@/lib/dialogue/transport";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const encoder = new TextEncoder();
const RETRY_MS = 600;
const LIVE_IDLE_MS = 1_000;

function terminal(status: string): WorkPreviewStatus {
  return status === "completed" || status === "failed" || status === "cancelled" ? status : "live";
}

/** A live local/Vercel reader can stall at EOF while a new chunk is arriving.
 * Probe the durable tail and reopen only when a known unconsumed chunk exists. */
async function readThoughtChunk(
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
  const read = pendingRead.then((result) => ({ kind: "read", result }) as const);
  try {
    if (!live) return await Promise.race([read, aborted]);
    const idle = new Promise<{ kind: "idle" }>((resolve) => {
      timer = setTimeout(() => resolve({ kind: "idle" }), LIVE_IDLE_MS);
    });
    const outcome = await Promise.race([read, aborted, idle]);
    if (outcome.kind !== "idle") return outcome;
    const tail = await Promise.race([
      read,
      aborted,
      readable.getTailIndex().then((tailIndex) => ({ kind: "tail", tailIndex }) as const),
    ]);
    if (tail.kind !== "tail") return tail;
    if (tail.tailIndex >= nextIndex) return { kind: "reopen" } as const;
    return { kind: "waiting" } as const;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ runId: string }> },
): Promise<Response> {
  const blocked = guardDialogueRead(request);
  if (blocked) return blocked;
  const { runId } = await params;
  const workId = new URL(request.url).searchParams.get("workId") ?? "";
  if (!/^wrun_[A-Za-z0-9]+$/.test(runId) || !/^[a-z0-9-]{1,128}$/i.test(workId)) {
    return Response.json({ code: "dialogue_preview_unavailable", error: "Work preview unavailable" }, { status: 404 });
  }
  const cursor = workPreviewCursor(new URL(request.url).searchParams.get("startIndex") ?? request.headers.get("last-event-id"));
  const run = getRun(runId);
  let initialStatus: string;
  try { initialStatus = await run.status; }
  catch { return Response.json({ code: "dialogue_preview_unavailable", error: "Work preview unavailable" }, { status: 404 }); }

  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      let rawIndex = 0;
      let readable = run.getReadable({ namespace: DIALOGUE_THOUGHTS_NAMESPACE, startIndex: 0 });
      let reader: ReadableStreamDefaultReader<unknown> | undefined;
      let pendingRead: Promise<ReadableStreamReadResult<unknown>> | undefined;
      const write = (event: WorkPreviewEvent) => {
        if (!closed) controller.enqueue(encoder.encode(`id: ${event.cursor}\ndata: ${JSON.stringify(event)}\n\n`));
      };
      const statusEvent = (status: WorkPreviewStatus, next: number): WorkPreviewEvent => ({
        type: "status", workId, runId, status, cursor: next,
        ...(status === "live" || status === "waiting" ? { retryAfterMs: RETRY_MS } : {}),
      });
      const abort = () => {
        closed = true;
        void reader?.cancel().catch(() => undefined);
      };
      if (request.signal.aborted) closed = true;
      else request.signal.addEventListener("abort", abort, { once: true });
      const live = initialStatus === "pending" || initialStatus === "running";
      try {
        // Replaying through the filter is required when the cursor splits a fence/tool.
        const filter = createWorkPreviewFilter();
        reader = readable.getReader();
        while (!closed) {
          pendingRead ??= reader.read();
          const outcome = await readThoughtChunk(readable, pendingRead, rawIndex, request.signal, live);
          if (outcome.kind === "aborted") break;
          if (outcome.kind === "waiting") continue;
          if (outcome.kind === "reopen") {
            const stalled = reader;
            reader = undefined;
            pendingRead = undefined;
            void stalled.cancel().catch(() => undefined);
            try { stalled.releaseLock(); } catch { /* Cancellation may settle later. */ }
            readable = run.getReadable({ namespace: DIALOGUE_THOUGHTS_NAMESPACE, startIndex: rawIndex });
            reader = readable.getReader();
            continue;
          }
          pendingRead = undefined;
          const next = outcome.result;
          if (next.done) break;
          rawIndex++;
          const signal = filter.push(next.value);
          if (signal && signal.type === "tool" && signal.toolName === "offerReply") continue;
          if (signal && rawIndex > cursor) write({ ...signal, workId, runId, cursor: rawIndex });
        }
        if (!closed) write(statusEvent(terminal(await run.status), Math.max(rawIndex, cursor)));
      } catch {
        if (!closed) write(statusEvent(terminal(await run.status.catch(() => "running")), Math.max(rawIndex, cursor)));
      } finally {
        request.signal.removeEventListener("abort", abort);
        try { reader?.releaseLock(); } catch { /* Already released. */ }
        if (!closed) {
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
          closed = true;
        }
      }
    },
  });
  return new Response(body, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      "x-accel-buffering": "no",
    },
  });
}