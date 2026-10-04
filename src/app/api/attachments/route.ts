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
import { attachmentMediaType, readCaseAttachment } from "@/lib/tools/attachments";

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
        // Attachments are born-never-renamed — cache privately, briefly.
        "Cache-Control": "private, max-age=300",
      },
    });
  } catch {
    return Response.json(
      { error: `Attachment not found: ${ref}` },
      { status: 404 },
    );
  }
}
