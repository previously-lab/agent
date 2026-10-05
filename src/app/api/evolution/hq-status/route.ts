/**
 * GET /api/evolution/hq-status — the companion pod's read on HQ (v0.21 §5
 * visibility layer).
 *
 * Read-only: answers the rolling pointer from `memory/config/hq.json`
 * (EMPTY before the first dispatch) plus the server clock, so the panel can
 * render relative times. Polled (~3s) while the pod's panel is open — no SSE
 * channel for a debug surface. Absent from the mutation origin-guard list by
 * design: it changes nothing.
 */
import { readHQStatus } from "../hq-status-store";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const status = await readHQStatus();
  return Response.json({
    status,
    asOf: new Date().toISOString(),
  });
}
