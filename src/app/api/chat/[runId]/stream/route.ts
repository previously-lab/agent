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
import { createUIMessageStreamResponse } from "@/lib/chat/server-stream";
import { type UIMessageChunk } from "@/lib/chat/protocol";
import { getRun } from "workflow/api";
import { createMixedStreamTransform } from "../../mixed-stream-transform";
import { formatErrorDetail } from "@/lib/chat/workflow-errors";

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

    // failed / cancelled runs have nothing valid to recover — emit an ERROR
    // terminal frame (data-turn-status, the same shape closeTurnStream ends
    // with) so the client shows a visible "failed, resend" state instead of
    // silently ending on a bare finish. The failure detail is read off
    // run.returnValue — terminal, so it settles immediately, no hang risk.
    // A COMPLETED run, however, must return its actual stream: the client may
    // have dropped before receiving the finish chunk, and the durable stream
    // still carries the full reply. A bare terminal there would leave the
    // client with an empty assistant turn (the mount-resume path strips the
    // partial turn before replaying — see chat-page.tsx — so the rebuild must
    // come from the stream, not a terminal).
    if (status === "failed" || status === "cancelled") {
      let detail = "";
      try {
        await run.returnValue;
      } catch (err) {
        const cause = (err as { cause?: unknown })?.cause;
        detail =
          cause instanceof Error
            ? cause.message
            : err instanceof Error
              ? err.message
              : "";
      }
      const terminalStream = new ReadableStream<UIMessageChunk>({
        start(controller) {
          controller.enqueue({
            type: "data-turn-status",
            id: "turn-status-terminal",
            data: {
              status: "error",
              updatedAt: new Date().toISOString(),
              error:
                status === "cancelled"
                  ? "The turn was cancelled before it could finish."
                  : `The turn failed before it could finish. Your message was not saved — please send it again.${detail ? ` (${detail.slice(0, 300)})` : ""}`,
            },
          } as UIMessageChunk);
          controller.enqueue({ type: "finish-step" } as UIMessageChunk);
          controller.enqueue({ type: "finish" } as UIMessageChunk);
          controller.close();
        },
      });
      return createUIMessageStreamResponse({
        stream: terminalStream.pipeThrough(createMixedStreamTransform()),
      });
    }

    const readable = run.getReadable({ startIndex });
    const tailIndex = await readable.getTailIndex();

    return createUIMessageStreamResponse({
      // Same transform as the POST path: the raw run stream mixes our
      // UIMessageChunks (data-flash / data-reasoning / lifecycle) with the
      // agent's ModelCallStreamParts — the client only speaks UIMessageChunk.
      stream: readable.pipeThrough(createMixedStreamTransform()),
      headers: { "x-workflow-stream-tail-index": String(tailIndex) },
    });
  } catch (err) {
    console.warn(
      `[chat/reconnect] run ${runId} unavailable:\n${formatErrorDetail(err)}`
    );
    return new Response(
      JSON.stringify({ error: "Run not available for reconnect" }),
      { status: 404, headers: { "Content-Type": "application/json" } }
    );
  }
}
