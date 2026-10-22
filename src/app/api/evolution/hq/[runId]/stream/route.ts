/**
 * GET /api/evolution/hq/[runId]/stream — attach to an HQ run's activity feed.
 *
 * Same shape as the chat turn's reconnect route
 * (src/app/api/chat/[runId]/stream/route.ts): the run's output stream is
 * durable (Redis-backed on Vercel, filesystem locally), so attaching replays
 * its chunks from `startIndex` (default 0 — the whole feed; HQ frames are
 * few and small, a full replay is the norm). That durability IS the
 * reconnect story: the companion pod stashes the run id from the hq.json
 * pointer and simply re-attaches here after a reload — no client-side state
 * to rebuild.
 *
 * The raw run stream is filtered to `data-hq-activity` chunks only
 * (createHQStreamFilter): the brief rounds run through runSubAgent, whose
 * `data-tool-progress` writes share the stream but are chat-shaped
 * telemetry, not part of this contract. Unlike the chat route there is no
 * mixed-stream transform — HQ writes UIMessageChunks of its own only, no
 * ModelCallStreamParts ever reach this stream.
 *
 * Read-only GET — absent from the mutation origin-guard list by design, and
 * a finished run's feed stays replayable: a pod that opens late still sees
 * the run's whole beat log before the stream drains.
 */
import { createUIMessageStreamResponse } from "ai";
import { getRun } from "workflow/api";
import { createHQStreamFilter, HQ_ACTIVITY_CHUNK } from "@/lib/chat/hq-stream";
import { formatErrorDetail } from "@/lib/chat/workflow-errors";

// The platform default (300 s) truncates any attachment to a live run mid-stream;
// the workflow endpoint gets 800, and the stream ends on its own when the run ends.
export const maxDuration = 800;

export async function GET(
  request: Request,
  { params }: { params: Promise<{ runId: string }> }
): Promise<Response> {
  const { runId } = await params;
  const { searchParams } = new URL(request.url);
  const startIndexParam = searchParams.get("startIndex");
  const parsed = startIndexParam !== null ? parseInt(startIndexParam, 10) : 0;
  const startIndex = Number.isFinite(parsed) ? parsed : 0;

  try {
    const run = getRun(runId);
    const status = await run.status;
    const readable = run.getReadable({ startIndex });
    const tailIndex = await readable.getTailIndex();
    const terminal = status === "completed" || status === "failed" || status === "cancelled";
    // Old runs may have finished without closing their shared writable. A
    // terminal run has a finite tail: replay exactly that snapshot, then end.
    const reader = readable.getReader();
    const firstIndex = startIndex < 0 ? Math.max(0, tailIndex + startIndex + 1) : startIndex;
    let remaining = Math.max(0, tailIndex - firstIndex + 1);
    const finished = () => ({
      type: HQ_ACTIVITY_CHUNK,
      data: { kind: "finished", at: new Date().toISOString(), status: status === "completed" ? "completed" : "failed" },
    });
    const abort = () => { void reader.cancel().catch(() => {}); };
    request.signal.addEventListener("abort", abort, { once: true });
    const source = new ReadableStream({
      async pull(controller) {
        if (request.signal.aborted || (terminal && remaining === 0)) {
          if (!request.signal.aborted) controller.enqueue(finished());
          controller.close();
          request.signal.removeEventListener("abort", abort);
          await reader.cancel().catch(() => {});
          return;
        }
        try {
          const next = await reader.read();
          if (next.done) {
            if (terminal && !request.signal.aborted) controller.enqueue(finished());
            controller.close();
            request.signal.removeEventListener("abort", abort);
          } else {
            remaining -= 1;
            controller.enqueue(next.value);
          }
        } catch (error) {
          request.signal.removeEventListener("abort", abort);
          controller.error(error);
        }
      },
      async cancel(reason) {
        request.signal.removeEventListener("abort", abort);
        await reader.cancel(reason).catch(() => {});
      },
    });

    return createUIMessageStreamResponse({
      stream: source.pipeThrough(createHQStreamFilter()),
      headers: { "x-workflow-stream-tail-index": String(tailIndex) },
    });
  } catch (err) {
    console.warn(
      `[evolution/hq-stream] run ${runId} unavailable:\n${formatErrorDetail(err)}`
    );
    return new Response(
      JSON.stringify({ error: "Run not available for attach" }),
      { status: 404, headers: { "Content-Type": "application/json" } }
    );
  }
}
