import { guardRequest } from "@/lib/security/origin-guard";
import { IMAGE_ATTACHMENT_LIMITS } from "@/lib/chat/image-attachments";
import { stageImage } from "@/lib/tools/staged-images";
import { ImageAttachmentError } from "@/lib/tools/image-validation";

export async function POST(request: Request): Promise<Response> {
  const blocked = guardRequest(request); if (blocked) return blocked;
  try {
    // Bound the body even when Content-Length is absent or dishonest. Multipart
    // overhead has its own small allowance; the file gets its exact 5MB check.
    const max = IMAGE_ATTACHMENT_LIMITS.maxBytes + 64 * 1024;
    const reader = request.body?.getReader();
    if (!reader) throw new ImageAttachmentError("image_missing", "Choose an image to upload");
    const chunks: Uint8Array[] = []; let length = 0;
    try {
      while (true) {
        const { value, done } = await reader.read(); if (done) break;
        length += value.length;
        if (length > max) { await reader.cancel(); throw new ImageAttachmentError("image_size", "Uploaded image exceeds 5MB", 413); }
        chunks.push(value);
      }
    } finally { reader.releaseLock(); }
    const form = await new Response(Buffer.concat(chunks), { headers: { "Content-Type": request.headers.get("content-type") ?? "" } }).formData();
    const file = form.get("file");
    if (!(file instanceof File) || form.getAll("file").length !== 1) throw new ImageAttachmentError("image_missing", "Upload exactly one image");
    const attachment = await stageImage({ data: Buffer.from(await file.arrayBuffer()), name: file.name, persona: form.get("persona") });
    return Response.json({ attachment }, { status: 201, headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof ImageAttachmentError) return Response.json({ error: error.message, code: error.code }, { status: error.status });
    if (error instanceof TypeError) return Response.json({ error: "Invalid image upload", code: "invalid_upload" }, { status: 400 });
    console.error("[Images] upload failed", error);
    return Response.json({ error: "Image upload failed; retry", code: "upload_failed" }, { status: 503 });
  }
}
