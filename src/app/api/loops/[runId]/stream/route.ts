/**
 * GET /api/loops/[runId]/stream — live-stream a durable loop's progress.
 *
 * Symmetric with the chat reconnect route (src/app/api/chat/[runId]/stream/):
 * same `getRun(runId).getReadable()` pattern, same tail-index header, same
 * replay-from-startIndex semantics. The loop's steps emit `data-loop` chunks
 * via `getWritable()`; a client connects here to follow along in real time.
 *
 * When the stream carries a `done: true` chunk, the loop has settled — the
 * client can then present results to the user (e.g. as a new chat message or
 * a toast notification).
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
      `[loops/reconnect] run ${runId} unavailable:`,
      err instanceof Error ? err.message : err
    );
    return new Response(
      JSON.stringify({ error: "Loop run not available for streaming" }),
      { status: 404, headers: { "Content-Type": "application/json" } }
    );
  }
}
