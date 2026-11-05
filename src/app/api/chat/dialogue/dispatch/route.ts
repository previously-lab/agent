/**
 * GET /api/chat/dialogue/dispatch — recovery-only Vercel Cron entry.
 *
 * Normal dialogue progress is triggered by the acceptance and durable-result
 * hooks. This route only re-scans persisted due scopes after a lost wake or a
 * crashed invocation; it is not part of the interactive sending path.
 */
import { dialogueResponseError } from "@/lib/dialogue/runtime";
import { dispatchDialogueDueScopes } from "../dispatch-host";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return Response.json(
      { code: "cron_secret_missing", error: "Dialogue recovery cron is not configured" },
      { status: 503 },
    );
  }
  if (request.headers.get("authorization") !== `Bearer ${secret}`) {
    return Response.json({ code: "unauthorized", error: "Unauthorized" }, { status: 401 });
  }
  try {
    const result = await dispatchDialogueDueScopes({ scopeLimit: 16, jobsPerScope: 4 });
    return Response.json({ ok: true, ...result });
  } catch (error) {
    return dialogueResponseError(error);
  }
}
