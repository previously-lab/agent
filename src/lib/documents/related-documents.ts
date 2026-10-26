import type { DocumentContextReference } from "@/lib/chat/document-context";
import { extractMarkdownRefs, extractSemanticDocumentLinks } from "@/lib/archive/ref-tokens";
import {
  documentLabelFallback,
  parseCanonicalDocumentRef,
  type DocumentLinkLocation,
} from "./document-link";

export interface RelatedDocument {
  ref: string;
  title: string;
  location: DocumentLinkLocation;
}

function title(value: string | undefined, ref: string): string {
  const label = value?.replace(/[*_`]/g, "").trim().slice(0, 160);
  return label || documentLabelFallback(ref) || ref;
}

export function collectRelatedDocuments(input: {
  currentRef: string;
  markdown?: string | null;
  evidence?: readonly string[];
  submitted?: readonly DocumentContextReference[];
  limit?: number;
}): RelatedDocument[] {
  const limit = Math.max(1, Math.min(input.limit ?? 8, 16));
  const currentRef = parseCanonicalDocumentRef(input.currentRef);
  const out: RelatedDocument[] = [];
  const keys = new Set<string>();
  const plainRefs = new Set<string>();
  const add = (refText: string, label: string | undefined, location: DocumentLinkLocation): void => {
    const ref = parseCanonicalDocumentRef(refText);
    if (!ref || ref === currentRef || out.length >= limit) return;
    const key = JSON.stringify([ref, location.turnId, location.role, location.edition]);
    if (keys.has(key)) return;
    keys.add(key);
    plainRefs.add(ref);
    out.push({ ref, title: title(label, ref), location });
  };

  for (const semantic of extractSemanticDocumentLinks(input.markdown ?? "")) {
    add(semantic.link.ref, semantic.label, {
      ...(semantic.link.turnId ? { turnId: semantic.link.turnId } : {}),
      ...(semantic.link.role ? { role: semantic.link.role } : {}),
      ...(semantic.link.edition ? { edition: semantic.link.edition } : {}),
    });
  }
  for (const ref of extractMarkdownRefs(input.markdown ?? "")) {
    if (!plainRefs.has(ref)) add(ref, undefined, {});
  }
  for (const ref of input.evidence ?? []) {
    if (!plainRefs.has(ref)) add(ref, undefined, { edition: "original" });
  }
  for (const reference of input.submitted ?? []) {
    add(reference.ref, reference.title, {
      ...(reference.turnId ? { turnId: reference.turnId } : {}),
      ...(reference.role ? { role: reference.role } : {}),
      ...(reference.edition ? { edition: reference.edition } : {}),
    });
  }
  return out;
}
