import { parseCaseReadEnvelope } from "@/lib/chat/case-read-receipt";
import {
  deriveWriteCaseStatus,
  parseRecallOutput,
} from "@/lib/chat/recall-output";
import {
  documentLabelFallback,
  parseCanonicalDocumentRef,
  type DocumentEdition,
} from "./document-link";

export interface ToolDocumentTarget {
  ref: string;
  title: string;
  edition?: DocumentEdition;
  observedRevision?: string;
}

const RECALL_ONLY_FILE_REFS = new Set(["self/agenda", "people/user/profile"]);

function target(refText: unknown, title?: string, observedRevision?: string): ToolDocumentTarget | null {
  const ref = parseCanonicalDocumentRef(refText);
  if (!ref || RECALL_ONLY_FILE_REFS.has(ref)) return null;
  return {
    ref,
    title: title?.trim() || documentLabelFallback(ref) || ref,
    edition: "original",
    ...(observedRevision ? { observedRevision } : {}),
  };
}

export function recallEntryDocumentTarget(refText: unknown, title?: string): ToolDocumentTarget | null {
  return target(refText, title);
}

export function writeCaseDocumentTarget(output: unknown): ToolDocumentTarget | null {
  const status = deriveWriteCaseStatus(false, output);
  if (status.kind !== "committed") return null;
  const match = /^memory\/([^/]+)\/([^/]+)\/([^/]+\.md)$/.exec(status.path);
  if (!match) return null;
  const [, category, caseName, fileName] = match;
  if (status.action === "open") {
    return fileName === "index.md" ? target(`${category}/${caseName}`, caseName) : null;
  }
  if (status.action === "addPiece") {
    return fileName === "index.md"
      ? null
      : target(`${category}/${caseName}/${fileName.replace(/\.md$/, "")}`);
  }
  return null;
}

export function recallReadDocumentTarget(input: unknown, output: unknown): ToolDocumentTarget | null {
  if (typeof output !== "string") return null;
  const parsed = parseRecallOutput("recallRead", output);
  if (parsed?.kind !== "content" && parsed?.kind !== "outline") return null;
  const receipt = parseCaseReadEnvelope(output)?.receipt;
  const requestedRef = input !== null && typeof input === "object" && "ref" in input
    ? input.ref
    : undefined;
  const actualRef = receipt?.ref ?? (parsed.kind === "outline" ? parsed.ref : parsed.nearName ?? requestedRef);
  return target(actualRef, undefined, receipt?.revision);
}
