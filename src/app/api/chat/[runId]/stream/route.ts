/**
 * GET /api/chat/[runId]/stream — reconnect to a durable chat turn.
 *
 * When a client drops mid-response (tab closed, phone slept, function timed
 * out), it re-attaches here: the run's output stream is durable (Redis-backed
 * on Vercel, filesystem locally), so we replay its chunks from `startIndex`.
 * `WorkflowChatTransport` calls this automatically — on the same-session retry
 * loop, and on a post-reload resume using the run id it persisted to
 * localStorage.
 *
 * Default `startIndex` is 0 (replay the whole turn), which keeps the AI SDK's
 * part grammar intact — a fresh client has no prior chunks, so a full replay of
 * the single turn renders cleanly. The `x-workflow-stream-tail-index` header is
 * returned so the transport can resolve negative offsets if ever configured.
 */
import { createUIMessageStreamResponse } from "ai";
import { getRun } from "workflow/api";

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
    const readable = run.getReadable({ startIndex });
    const tailIndex = await readable.getTailIndex();

    return createUIMessageStreamResponse({
      stream: readable,
      headers: { "x-workflow-stream-tail-index": String(tailIndex) },
    });
  } catch (err) {
    console.warn(
      `[chat/reconnect] run ${runId} unavailable:`,
      err instanceof Error ? err.message : err
    );
    return new Response(
      JSON.stringify({ error: "Run not available for reconnect" }),
      { status: 404, headers: { "Content-Type": "application/json" } }
    );
  }
}
