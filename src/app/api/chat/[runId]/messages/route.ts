/**
 * POST /api/chat/[runId]/messages — say-into-episode (v0.30 §3.5, batch B).
 *
 * While an episode run E is alive, a new user message does NOT start a new
 * run: it lands here. The route does exactly two things (D1 — E is the only
 * spawner):
 *   1. persist the user turn IMMEDIATELY (appendTurn on the active slice,
 *      deduped by the client-minted turnId — a retried submit or double-click
 *      never writes twice);
 *   2. tap E's inbox hook (`episode:<runId>`, {kind:"arrived"}) so the drain
 *      loop wakes and spawns the inner run.
 * Returns 200 with no stream — the answer arrives on E's own durable stream
 * as nested-bubble frames; a reconnecting client replays them (§4.2).
 *
 * The tap is only a wake-up: HookNotFoundError (E exited in the status-check
 * window) is swallowed — the message is on disk, the drain's reconciliation
 * is disk-based, and the orphan case gets the reflection bell (the cancel
 * route's precedent: a "question without an answer" must not go unseen).
 *
 * Bridge/demo turns never nest (D10): those deployments reject here with 409
 * — their outer runs skip the episode phase, so a persisted message would
 * have no drainer. A terminal/unknown run id also 409s: the episode is over
 * and the client should start a fresh POST /api/chat.
 */
import { getRun, resumeHook } from "workflow/api";
import { HookNotFoundError } from "workflow/errors";
import { guardRequest } from "@/lib/security/origin-guard";
import {
  appendTurn,
  createBatch,
  flushBatch,
  saveSliceSnapshot,
  tryLoadTodaySlice,
} from "@/lib/episodic";
import { withSliceLock } from "@/lib/episodic/slice-mutex";
import { resolveDataSource } from "@/lib/data-source/resolve";
import { isBridgeBrainActive } from "@/lib/models/registry";
import { readClientConfig } from "@/lib/client-config";
import { episodeInboxToken } from "@/lib/chat/nested-bubble";
import { deliverReflectionWake } from "@/app/api/evolution/reflection-wake";

/** Client-minted turn id — same base64url alphabet start-turn mints with. */
const TURN_ID_RE = /^[A-Za-z0-9_-]{4,32}$/;

export async function POST(
  request: Request,
  { params }: { params: Promise<{ runId: string }> },
): Promise<Response> {
  const blocked = guardRequest(request);
  if (blocked) return blocked;
  const { runId } = await params;
  try {
    const body = (await request.json()) as {
      text?: unknown;
      turnId?: unknown;
    };
    const text = typeof body.text === "string" ? body.text.trim() : "";
    if (!text) {
      return Response.json({ error: "text is required" }, { status: 400 });
    }
    if (typeof body.turnId !== "string" || !TURN_ID_RE.test(body.turnId)) {
      return Response.json(
        { error: "turnId must be a client-minted base64url id" },
        { status: 400 },
      );
    }
    const turnId = body.turnId;

    // D10 gates: bridge/demo deployments have no episode phase to drain this.
    if (resolveDataSource() === "demo") {
      return Response.json(
        { error: "nested messages are not supported in demo mode" },
        { status: 409 },
      );
    }
    const clientConfig = await readClientConfig().catch(() => null);
    if (isBridgeBrainActive(clientConfig?.brain)) {
      return Response.json(
        { error: "nested messages are not supported on the subscription bridge" },
        { status: 409 },
      );
    }

    // The episode must be alive to drain this message — a terminal run means
    // the client should start a fresh turn instead.
    try {
      const status = await getRun(runId).status;
      if (status !== "pending" && status !== "running") {
        return Response.json(
          { error: "episode run already finished", status },
          { status: 409 },
        );
      }
    } catch {
      return Response.json({ error: "episode run not found" }, { status: 404 });
    }

    // 1. Persist immediately (红线) — deduped by the client-minted turnId.
    //    The slice lock serializes against E's own slice writes (finalize).
    const slice = await tryLoadTodaySlice();
    if (!slice) {
      return Response.json(
        { error: "no active slice to record into" },
        { status: 409 },
      );
    }
    const deduped = await withSliceLock(slice.slice_id, async () => {
      const already = slice.turns.some(
        (t) => t.role === "user" && t.turnId === turnId,
      );
      if (already) return true;
      appendTurn(slice, {
        timestamp: new Date().toISOString(),
        role: "user",
        content: text,
        turnId,
      });
      const batch = createBatch();
      await saveSliceSnapshot(slice, batch);
      await flushBatch(batch, `Turn ${turnId} — user message (episode)`);
      return false;
    });

    // 2. Tap E's inbox. HookNotFoundError = E exited inside the status-check
    //    window: the message is on disk (the drain's reconciliation is
    //    disk-based, D2), and the orphan gets the reflection bell — the cancel
    //    route's precedent for a "question without an answer".
    try {
      await resumeHook(episodeInboxToken(runId), { kind: "arrived", turnId });
    } catch (e) {
      if (HookNotFoundError.is(e)) {
        console.warn(
          `[chat/messages] episode inbox gone (run ${runId}) — message ${turnId} persists on disk`,
        );
        const wake = await deliverReflectionWake({});
        if (!wake.ok) {
          console.warn(
            `[chat/messages] reflection wake not delivered (ignored): ${wake.reason}`,
          );
        }
      } else {
        throw e;
      }
    }

    return Response.json({ ok: true, turnId, deduped });
  } catch (error) {
    if (error instanceof SyntaxError) {
      return Response.json({ error: "Invalid JSON in request body" }, { status: 400 });
    }
    console.error(
      "[chat/messages] unhandled:",
      error instanceof Error ? (error.stack ?? error.message) : error,
    );
    throw error;
  }
}
