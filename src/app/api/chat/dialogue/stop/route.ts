/**
 * POST /api/chat/dialogue/stop — stop the expression drain, or cancel one
 * work. The store persists the intent FIRST (lease fence / work state), the
 * run cancellation is best-effort afterwards: recovery never depends on the
 * cancel landing. Already-committed publications stay — stopping is not
 * rewind.
 */
import { guardRequest } from "@/lib/security/origin-guard";
import {
  dialogueResponseError,
  getDialogueStore,
  resolveDialogueScope,
} from "@/lib/dialogue/runtime";
import { serverDialogueRunner } from "../runner";
import { ensureDialogueDispatch } from "../dispatch-host";

export async function POST(request: Request): Promise<Response> {
  const blocked = guardRequest(request);
  if (blocked) return blocked;
  try {
    const body = (await request.json().catch(() => ({}))) as {
      persona?: unknown;
      workId?: unknown;
    };
    const scope = resolveDialogueScope(body.persona);
    const store = await getDialogueStore();
    const stopped = await store.stop(
      scope,
      typeof body.workId === "string" && body.workId ? body.workId : undefined,
    );
    if (stopped.runId) await serverDialogueRunner.cancelRun(stopped.runId);
    return Response.json({ ok: true, ...stopped });
  } catch (error) {
    return dialogueResponseError(error);
  }
}

ensureDialogueDispatch();
