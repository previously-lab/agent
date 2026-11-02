/**
 * GET /api/attachments?ref=<分类>/<case名>/<附件名> — serves ONE case
 * attachment's bytes to the browser (the shelf renders images through this;
 * §C.1). The client never sees base64 — the URL is the identity.
 *
 * Security is the hard requirement (repo rule: frontend-originated file paths
 * are validated and bounded): the reference is parsed with the case-model
 * validators — closed category set, red-line case-name check, and the
 * plain-file-name guard (no separators, no traversal, no edge whitespace) —
 * and `readCaseAttachment` re-validates everything against before reading
 * through the whitelist-checked fs (paths land strictly under memory/).
 * A dead name is a 404 (a dead link is visible, never a 500).
 */
import { isCaseCategory, isValidCaseName } from "@/lib/docs";
import { attachmentMediaType, readCaseAttachment, readRecordImage } from "@/lib/tools/attachments";
import { IMAGE_ASSET_ID, parseRecordImageRef } from "@/lib/chat/image-attachments";
import { readStagedImage } from "@/lib/tools/staged-images";
import { ImageAttachmentError } from "@/lib/tools/image-validation";

function isPlainFileName(name: string): boolean {
  return (
    name.length > 0 &&
    name === name.trim() &&
    !name.includes("/") &&
    !name.includes("\\") &&
    !name.includes("\0") &&
    name !== "." &&
    name !== ".." &&
    !name.includes("..")
  );
}

export async function GET(request: Request): Promise<Response> {
  const ref = new URL(request.url).searchParams.get("ref") ?? "";
  if (ref.startsWith("drafts/") || parseRecordImageRef(ref)) {
    try {
      const draftId = ref.slice("drafts/".length);
      if (ref.startsWith("drafts/") && !IMAGE_ASSET_ID.test(draftId)) return Response.json({ error: "Invalid image reference" }, { status: 400 });
      const { data, mediaType } = ref.startsWith("drafts/")
        ? await readStagedImage(draftId, new URL(request.url).searchParams.get("persona"))
        : await readRecordImage(ref);
      return new Response(new Uint8Array(data), { headers: {
        "Content-Type": mediaType, "Content-Length": String(data.length), "X-Content-Type-Options": "nosniff",
        // Read-only SVG legacy archives remain usable as images, never active documents.
        "Content-Security-Policy": "default-src 'none'; sandbox",
        // A URL may outlive a runtime datasource switch. Revalidate against
        // the current store instead of showing cached bytes from the old one.
        "Cache-Control": "no-store",
      } });
    } catch (error) {
      if (error instanceof ImageAttachmentError) return Response.json({ error: error.message, code: error.code }, { status: error.status });
      const absent = (error as { code?: string; status?: number })?.code === "ENOENT" || (error as { status?: number })?.status === 404 || /^File not found:/.test((error as Error)?.message ?? "");
      return Response.json({ error: absent ? "Image not found" : "Could not read image" }, { status: absent ? 404 : 503 });
    }
  }
  const segments = ref.split("/").filter((s) => s !== "");
  const [category, caseName, fileName] = [segments[0] ?? "", segments[1] ?? "", segments[2] ?? ""];

  if (
    segments.length !== 3 ||
    !isCaseCategory(category) ||
    !isValidCaseName(caseName) ||
    !isPlainFileName(fileName)
  ) {
    return Response.json(
      {
        error:
          "Invalid attachment reference — expected 分类/case名/附件名 " +
          "(a closed category, a legal case name, a plain file name).",
      },
      { status: 400 },
    );
  }

  try {
    const { data, mediaType } = await readCaseAttachment({
      category,
      caseName,
      fileName,
    });
    return new Response(new Uint8Array(data), {
      headers: {
        "Content-Type": attachmentMediaType(fileName) || mediaType,
        "Content-Length": String(data.byteLength),
        // Attachments are born-never-renamed (a same-name repeat lands under
        // a deterministic `-<n>` suffix, never an overwrite), so the bytes
        // behind a URL never change — cache privately for a day, immutable.
        // Server-side the read rides the content-addressed blob cache
        // (Wave A), so even a browser miss re-fetches nothing unchanged.
        "Cache-Control": "private, max-age=86400, immutable",
      },
    });
  } catch {
    return Response.json(
      { error: `Attachment not found: ${ref}` },
      { status: 404 },
    );
  }
}
