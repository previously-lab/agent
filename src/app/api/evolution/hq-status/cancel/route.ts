/**
 * POST /api/evolution/hq-status/cancel — the panel's 一键停 (v0.39 §4.3).
 * The ONLY write the panel surface owns, and its target is a RUN, never
 * memory: `getRun(runId).cancel()` — the same action as the observability
 * UI's Cancel button (run_cancelled, hooks disposed, token released). The
 * consequences unfold per the unit table (停 turn: reply may live only in
 * the stream; 停 writer: the reply lands on the next same-turnId retry;
 * 停反思: the cursor holds, the next bell revives from the same level —
 * the zombie takeover's manual cousin).
 *
 * Same-origin guarded like every mutation endpoint. Stateless: no file
 * writes, no state of its own — 面板挂了系统照跑 (§6).
 */
import { getRun } from "workflow/api";
import { guardRequest } from "@/lib/security/origin-guard";

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  const blocked = guardRequest(request);
  if (blocked) return blocked;

  let runId: string | null = null;
  try {
    const body = (await request.json()) as { runId?: unknown } | null;
    runId = typeof body?.runId === "string" && body.runId ? body.runId : null;
  } catch {
    runId = null;
  }
  if (!runId) {
    return Response.json(
      { ok: false, reason: "runId is required" },
      { status: 400 },
    );
  }
  try {
    await getRun(runId).cancel();
    console.log(`[Panel] cancel requested for ${runId}`);
    return Response.json({ ok: true });
  } catch (e) {
    return Response.json(
      { ok: false, reason: e instanceof Error ? e.message : String(e) },
      { status: 502 },
    );
  }
}
