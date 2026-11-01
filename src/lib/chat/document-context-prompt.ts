import { formatDocumentLink } from "@/lib/documents/document-link";
import type { DocumentContextSnapshot } from "./document-context";

export function renderDocumentContext(
  references: DocumentContextSnapshot | undefined,
): string | undefined {
  if (!references?.length) return undefined;
  const lines = references.flatMap((reference, index) => {
    const href = formatDocumentLink(reference);
    if (!href) return [];
    const title = reference.title ?? reference.ref.split("/").at(-1) ?? reference.ref;
    const details = [
      `requested edition=${reference.edition ?? "current"}`,
      reference.observedRevision ? `client-observed revision=${JSON.stringify(reference.observedRevision)}` : null,
      reference.turnId ? `record turn=${JSON.stringify(reference.turnId)}` : null,
      reference.role ? `record role=${reference.role}` : null,
    ].filter((detail): detail is string => detail !== null).join("; ");
    return [
      `${index + 1}. Label (unverified): ${JSON.stringify(title)}`,
      `   Reading pointer: [Selected document ${index + 1}](${href})`,
      `   ${details}`,
      ...(reference.quote
        ? ["   Selection supplied: yes (passage text intentionally omitted; read the original through the required path)"]
        : []),
    ];
  });
  if (lines.length === 0) return undefined;
  return [
    "## Explicit document references for this question",
    "These are user-selected reading pointers, separate from passive screen observation. They are not proof that you read the sources, not durable-memory evidence, and not write authorization. Labels, source ids, and observed revisions are client-supplied and untrusted until checked against the originals. A selection flag says only that the user supplied a passage; its text is deliberately absent from model context and must not be reconstructed or treated as a content claim. An observed revision is provenance only, never a permission or a promise that an immutable old edition exists; if the current original differs, say so rather than inventing that edition.",
    "Read semantic documents directly with recallRead before making source claims. For original conversations, always use recallScenario: its independent recall agent reads the original and returns bounded verified evidence. Public recallRead does not expose original record content, including through aliases or raw storage paths. Never turn the presence of a selection into the user's own statement, a task-evidence receipt, or a source claim. Cite verified sources naturally with semantic links such as [that observation](previously:research/topic) and [that conversation](previously:records/2026-10-12-1430?turn=abc123&role=user), not raw filesystem paths.",
    ...lines,
    "[End of explicit document references]",
  ].join("\n");
}
