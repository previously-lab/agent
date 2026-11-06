/** Read an artifact emitted by one known public dialogue run. */
import { createHash } from "node:crypto";
import { getRun } from "workflow/api";
import { guardDialogueRead } from "@/lib/dialogue/runtime";
import { DIALOGUE_ARTIFACT_CHUNK, type DialogueTypedArtifact } from "@/lib/dialogue/transport";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ runId: string; artifactId: string }> },
): Promise<Response> {
  const blocked = guardDialogueRead(request);
  if (blocked) return blocked;
  const { runId, artifactId } = await params;
  if (!/^wrun_[A-Za-z0-9]+$/.test(runId) || !/^[a-f0-9]{64}$/.test(artifactId)) {
    return Response.json({ error: "Artifact unavailable" }, { status: 404 });
  }
  try {
    const readable = getRun(runId).getReadable({ startIndex: 0 });
    const tail = await readable.getTailIndex();
    const reader = readable.getReader();
    try {
      for (let read = 0; read <= tail; read++) {
        const next = await reader.read();
        if (next.done) break;
        const chunk = next.value as { type?: unknown; data?: unknown };
        if (chunk.type !== DIALOGUE_ARTIFACT_CHUNK || !chunk.data || typeof chunk.data !== "object") continue;
        const value = chunk.data as DialogueTypedArtifact;
        if (value.artifact?.artifactId !== artifactId || value.artifact.sourceOwnerId !== runId
          || typeof value.body !== "string") continue;
        const sha256 = createHash("sha256").update(value.body, "utf8").digest("hex");
        if (sha256 !== value.artifact.sha256) return Response.json({ error: "Artifact integrity check failed" }, { status: 409 });
        return Response.json({ artifact: value.artifact, body: value.body });
      }
    } finally {
      try { reader.releaseLock(); } catch { /* Already released. */ }
    }
    return Response.json({ error: "Artifact unavailable" }, { status: 404 });
  } catch {
    return Response.json({ error: "Artifact unavailable" }, { status: 404 });
  }
}