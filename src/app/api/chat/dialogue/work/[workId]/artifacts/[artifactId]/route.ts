/**
 * Owner-bound preview for a completed work artifact. This deliberately does
 * not relax the public published-artifact route: both the scoped work and the
 * immutable result owner must contain the artifact id.
 */
import { authorizeWorkPreview, workPreviewNotFound } from "../../../work-preview-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ workId: string; artifactId: string }> },
): Promise<Response> {
  const { workId, artifactId } = await params;
  const authorized = await authorizeWorkPreview(request, workId);
  if (authorized instanceof Response) return authorized;
  const { store, scope, work } = authorized;
  if (work.status !== "completed" || !/^[a-f0-9]{64}$/.test(artifactId)
    || !work.artifacts?.some((artifact) => artifact.artifactId === artifactId)) {
    return workPreviewNotFound();
  }
  try {
    const found = await store.resultArtifact(scope, `${workId}:1`, artifactId);
    if (!found) return workPreviewNotFound();
    return Response.json(found, { headers: { "cache-control": "private, no-store" } });
  } catch {
    return workPreviewNotFound();
  }
}
