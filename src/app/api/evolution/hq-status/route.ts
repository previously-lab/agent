/**
 * GET /api/evolution/hq-status — the companion pod's read on HQ (v0.21 §5
 * visibility layer).
 *
 * Answers the rolling pointer from `memory/config/hq.json` (EMPTY before the
 * first dispatch) plus the server clock, so the panel can render relative
 * times. Polled (~3s) while the pod's panel is open — no SSE channel for a
 * debug surface. Absent from the mutation origin-guard list by design.
 *
 * One write escapes the read-only rule: a stale "running" is settled here.
 * Run cancellation stops the workflow at its next suspension point — the
 * cancelled run's finish mark (a step) is never scheduled, so the pointer
 * would read "running" forever (observed 2026-10-14). When the pointer
 * claims a run the REGISTRY says is over, the route settles it (failed, with
 * the registry's verdict) and answers the settled state. The check costs one
 * getRun only while the pointer reads "running"; a registry error or a live
 * run leaves the pointer untouched — never heal on doubt.
 */
import { getRun } from "workflow/api";
import { isLiveRunStatus } from "@/lib/chat/parallel-runs";
import { readHQStatus, settleHQRunIfStale } from "../hq-status-store";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  let status = await readHQStatus();
  if (status.runStatus === "running" && status.runId) {
    try {
      const registryStatus = await getRun(status.runId).status;
      if (!isLiveRunStatus(registryStatus)) {
        status = await settleHQRunIfStale(status.runId, registryStatus);
      }
    } catch {
      /* registry unreachable — the pointer stands as read */
    }
  }
  return Response.json({
    status,
    asOf: new Date().toISOString(),
  });
}
