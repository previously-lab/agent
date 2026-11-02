import { guardRequest } from "@/lib/security/origin-guard";
import { cancelStagedImage } from "@/lib/tools/staged-images";
import { ImageAttachmentError } from "@/lib/tools/image-validation";

export async function POST(request: Request, context: { params: Promise<{ assetId: string }> }): Promise<Response> {
  const blocked = guardRequest(request); if (blocked) return blocked;
  try {
    const { assetId } = await context.params;
    await cancelStagedImage(assetId, new URL(request.url).searchParams.get("persona"));
    return new Response(null, { status: 204 });
  } catch (error) {
    if (error instanceof ImageAttachmentError) return Response.json({ error: error.message, code: error.code }, { status: error.status });
    console.error("[Images] cancellation failed", error);
    return Response.json({ error: "Could not cancel image upload; retry", code: "cancel_failed" }, { status: 503 });
  }
}
