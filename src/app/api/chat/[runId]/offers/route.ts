/** Replayable parent-scoped offer stream, decoded by the Workflow SDK. */
import { getRun } from "workflow/api";
import { guardDialogueRead } from "@/lib/dialogue/runtime";
import { workPreviewCursor } from "@/lib/dialogue/work-preview";
import {
  DIALOGUE_OFFERS_NAMESPACE,
  parseDialogueOfferEvent,
  type DialogueOfferEvent,
  type DialogueOffersDoneEvent,
} from "@/lib/dialogue/transport";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const encoder = new TextEncoder();
const RETRY_MS = 600;

function terminalStatus(status: string): DialogueOffersDoneEvent["status"] {
  return status === "completed" || status === "failed" || status === "cancelled" ? status : "running";
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ runId: string }> },
): Promise<Response> {
  const blocked = guardDialogueRead(request);
  if (blocked) return blocked;
  const { runId: parentRunId } = await params;
  if (!/^wrun_[A-Za-z0-9]+$/.test(parentRunId)) {
    return Response.json({ code: "dialogue_parent_not_found", error: "Offer stream unavailable" }, { status: 404 });
  }
  const url = new URL(request.url);
  let cursor = workPreviewCursor(url.searchParams.get("startIndex") ?? request.headers.get("last-event-id"));
  const run = getRun(parentRunId);
  let initialStatus: string;
  try { initialStatus = await run.status; }
  catch { return Response.json({ code: "dialogue_parent_not_found", error: "Offer stream unavailable" }, { status: 404 }); }

  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      let reader: ReadableStreamDefaultReader<unknown> | undefined;
      const emitted = new Set<string>();
      const write = (event: DialogueOfferEvent | DialogueOffersDoneEvent) => {
        if (!closed) controller.enqueue(encoder.encode(`id: ${cursor}\ndata: ${JSON.stringify(event)}\n\n`));
      };
      const abort = () => {
        closed = true;
        void reader?.cancel().catch(() => undefined);
      };
      if (request.signal.aborted) closed = true;
      else request.signal.addEventListener("abort", abort, { once: true });
      try {
        const readable = run.getReadable({ namespace: DIALOGUE_OFFERS_NAMESPACE, startIndex: cursor });
        reader = readable.getReader();
        let terminalObserved = terminalStatus(initialStatus) !== "running";
        // Native terminal wait, not a route timer. If an abrupt parent failure
        // left the stream open, wake here and drain its already-durable tail.
        const terminal = terminalObserved ? undefined : run.returnValue.then(
          () => ({ kind: "terminal" as const }),
          () => ({ kind: "terminal" as const }),
        );
        let pendingRead: Promise<ReadableStreamReadResult<unknown>> | undefined;
        while (!closed) {
          if (terminalObserved && await readable.getTailIndex() < cursor) {
            await reader.cancel().catch(() => undefined);
            break;
          }
          pendingRead ??= reader.read();
          const outcome = terminalObserved
            ? { kind: "read" as const, result: await pendingRead }
            : await Promise.race([
                pendingRead.then((result) => ({ kind: "read" as const, result })),
                terminal!,
              ]);
          if (outcome.kind === "terminal") {
            terminalObserved = true;
            continue;
          }
          pendingRead = undefined;
          const next = outcome.result;
          if (next.done) break;
          cursor++;
          const offer = parseDialogueOfferEvent(next.value);
          if (!offer || emitted.has(offer.offerId)) continue;
          emitted.add(offer.offerId);
          write(offer);
        }
        if (!closed) {
          let status = terminalStatus(await run.status);
          let error: string | undefined;
          if (status === "completed") {
            try {
              const result = await run.returnValue as { error?: unknown } | undefined;
              if (emitted.size === 0 && typeof result?.error === "string" && result.error) {
                status = "failed";
                error = "The thinking run ended without a public reply.";
              }
            } catch { /* Terminal status remains sufficient. */ }
          } else if (status === "failed" || status === "cancelled") {
            error = status === "cancelled" ? "The reply was cancelled." : "The thinking run failed before completing its offers.";
          }
          write({
            type: "done",
            parentRunId,
            status,
            cursor,
            ...(status === "running" ? { retryAfterMs: RETRY_MS } : {}),
            ...(error ? { error } : {}),
          });
        }
      } catch {
        if (!closed) {
          const status = terminalStatus(await run.status.catch(() => "running"));
          write({
            type: "done", parentRunId, status, cursor,
            ...(status === "running" ? { retryAfterMs: RETRY_MS } : {}),
          });
        }
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