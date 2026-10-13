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
 * Terminal runs (completed/failed/cancelled) and unknown run ids are no-ops —
 * the client fires this alongside the local abort and must never be punished
 * for a race with the run's own completion.
 *
 * A REAL cancel also rings the reflection bell (v0.30 §2.1): the turn's own
 * tail never ran, so without this wake the orphaned user message would go
 * unseen until the next turn. The route holds no slice/turn pointer — a
 * bare wake is legal (the unit's range is everything since its last look).
 */
import { getRun } from "workflow/api";
import { guardRequest } from "@/lib/security/origin-guard";
import { deliverReflectionWake } from "@/app/api/evolution/reflection-wake";

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
    if (status === "pending" || status === "running") {
      await run.cancel();
      // The bell never delays or breaks the cancel response.
      const wake = await deliverReflectionWake({});
      if (!wake.ok) {
        console.warn(`[chat/cancel] reflection wake not delivered (ignored): ${wake.reason}`);
      }
      return Response.json({ ok: true, cancelled: true });
    }
    return Response.json({ ok: true, cancelled: false, status });
  } catch (error) {
    // A gone run is as good as a cancelled one for the caller's purpose.
    console.warn(
      `[chat/cancel] run ${runId} unavailable:`,
      error instanceof Error ? error.message : error,
    );
    return Response.json({ ok: true, cancelled: false, status: "gone" });
  }
}
