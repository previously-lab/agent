/**
 * GET /api/chat/dialogue/artifacts/[artifactId]?persona= — public artifact
 * bytes. Only artifacts the publication transaction marked "published" are
 * readable here: producer-side bytes stay owner-bound and unreachable. The
 * client verifies the full identity (id, owner, revision, sha256, kind,
 * media type, byte size) before executing anything.
 */
import {
  dialogueResponseError,
  getDialogueStore,
  guardDialogueRead,
  resolveDialogueScope,
} from "@/lib/dialogue/runtime";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ artifactId: string }> },
): Promise<Response> {
  const blocked = guardDialogueRead(request);
  if (blocked) return blocked;
  try {
    const { artifactId } = await params;
    if (!/^[a-f0-9]{64}$/.test(artifactId)) {
      return Response.json({ code: "dialogue_not_found", error: "Artifact unavailable" }, { status: 404 });
    }
    const persona = new URL(request.url).searchParams.get("persona");
    const store = await getDialogueStore();
    const found = await store.artifact(resolveDialogueScope(persona), artifactId);
    if (!found) {
      return Response.json({ code: "dialogue_not_found", error: "Artifact unavailable" }, { status: 404 });
    }
    return Response.json(found);
  } catch (error) {
    return dialogueResponseError(error);
  }
}
