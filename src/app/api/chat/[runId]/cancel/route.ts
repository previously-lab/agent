/**
 * POST /api/chat/[runId]/cancel — really stop a durable chat turn.
 *
 * The input bar's stop button means STOP: the client aborts its stream locally
 * AND calls here so the run itself is cancelled — no further steps execute and
 * finalizeTurn never records an agent reply. Whatever housekeeping already
 * persisted stays (the user turn is snapshotted before streaming begins, so a
 * stoppable turn leaves a "question without an answer" in the slice — the
 * accepted semantic). A reply mid-flight in the model's HTTP call is discarded
 * when the step dies; nothing further is written.
 *
 * The EPISODE cascade (v0.31): an orchestrator run's children are independent
 * runs, and the world does NOT cascade cancellation — cancelling only the
 * outer run would leave every in-flight child burning tokens on an answer
 * nobody persists. The outer run's durable stream IS the roster (every
 * running frame carries its child's runId), so this route reads it back and
 * cancels each in-flight child alongside the outer. The scan happens BEFORE
 * the cancel (a live stream is readable without ceremony) and is bounded by
 * the tail index — the stream is open (preventClose), so reading to EOF
 * would hang. A child spawned in the milliseconds between the scan and the
 * outer's death is the accepted orphan window: it finishes, its bubble report
 * hits HookNotFoundError (swallowed — steps.ts), and nothing persists it.
 *
 * Terminal parents and unknown run ids are not cancelled again, but a terminal
 * dialogue parent's admitted replies are still checked and stopped if active —
 * the client fires this alongside the local abort and must never be punished
 * for a race with the run's own completion.
 *
 * A REAL cancel does NOT ring the reflection bell (v0.34 R1 retired the
 * bare wake this route used to send): an open slice is not reflection
 * material — the orphaned user message is covered when its slice seals,
 * and that seal is what rings the unit.
 */
import { getRun } from "workflow/api";
import { guardRequest } from "@/lib/security/origin-guard";
import {
  NESTED_BUBBLE_CHUNK,
  normalizeNestedBubble,
  type NestedBubbleFrame,
} from "@/lib/chat/nested-bubble";
import { listDialogueOffers } from "@/lib/dialogue/workflow-offers";

/**
 * The child run ids whose LATEST lifecycle frame is still in flight
 * (queued/running). Latest-frame-wins per bubble: a done/failed child's run
 * is terminal already, so cancelling it would be noise. Reads exactly the
 * chunks durable NOW (tail index + 1), then cancels the reader — never waits
 * on the open stream.
 */
async function collectInflightChildRuns(
  run: ReturnType<typeof getRun>,
): Promise<string[]> {
  const readable = run.getReadable({ startIndex: 0 });
  const tail = await readable.getTailIndex();
  if (tail < 0) return [];
  const latestByBubble = new Map<string, NestedBubbleFrame>();
  const reader = readable.getReader();
  let read = 0;
  try {
    while (read <= tail) {
      const { done, value } = await reader.read();
      if (done) break;
      read++;
      const chunk = value as { type?: unknown; data?: unknown } | undefined;
      if (chunk?.type !== NESTED_BUBBLE_CHUNK) continue;
      const frame = normalizeNestedBubble(chunk.data);
      if (frame) latestByBubble.set(frame.turnId, frame);
    }
  } finally {
    await reader.cancel().catch(() => {
      /* tearing down a half-read live stream is best-effort */
    });
  }
  return [...latestByBubble.values()]
    .filter(
      (f) => (f.status === "queued" || f.status === "running") && !!f.runId,
    )
    .map((f) => f.runId as string);
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ runId: string }> }
): Promise<Response> {
  const blocked = guardRequest(request);
  if (blocked) return blocked;
  const { runId } = await params;
  try {
    const run = getRun(runId);
    const status = await run.status;
    const parentActive = status === "pending" || status === "running";
    let nestedChildren: string[] = [];
    if (parentActive) {
      nestedChildren = await collectInflightChildRuns(run).catch((err) => {
        console.warn(
          `[chat/cancel] child roster scan failed for ${runId} (cascading skipped):`,
          err instanceof Error ? err.message : err,
        );
        return [] as string[];
      });
      await run.cancel();
    }

    // Read offers after stopping an active parent so admission cannot race the
    // roster. A terminal parent can still have an independently running reply.
    const offeredChildren = await listDialogueOffers(runId).catch((error) => {
      console.warn(`[chat/cancel] offer roster unavailable for ${runId}:`, error instanceof Error ? error.message : error);
      return [];
    });
    const inflightOffers = await Promise.all(offeredChildren.map(async (offer) => {
      try {
        const childStatus = await getRun(offer.runId).status;
        return childStatus === "pending" || childStatus === "running" ? offer.runId : null;
      } catch (error) {
        console.warn(`[chat/cancel] offered child ${offer.runId} status unavailable (cancel skipped):`,
          error instanceof Error ? error.message : error);
        return null;
      }
    }));
    const childRunIds = [...new Set([...nestedChildren, ...inflightOffers.filter((id): id is string => id !== null)])];
    // Per-child failures are quiet no-ops — a child that finished meanwhile is
    // already terminal.
    const cascades = await Promise.allSettled(
      childRunIds.map((childRunId) => getRun(childRunId).cancel()),
    );
    cascades.forEach((r, i) => {
      if (r.status === "rejected") {
        console.warn(
          `[chat/cancel] child run ${childRunIds[i]} cancel failed (ignored):`,
          r.reason instanceof Error ? r.reason.message : r.reason,
        );
      }
    });
    return Response.json(parentActive
      ? { ok: true, cancelled: true }
      : { ok: true, cancelled: false, status });
  } catch (error) {
    // A gone run is as good as a cancelled one for the caller's purpose.
    console.warn(
      `[chat/cancel] run ${runId} unavailable:`,
      error instanceof Error ? error.message : error,
    );
    return Response.json({ ok: true, cancelled: false, status: "gone" });
  }
}
