import { parseCanonicalDocumentRef } from "@/lib/documents/document-link";
import { parseRecordRef } from "@/lib/archive/refs";
import { parseSliceId } from "@/lib/episodic/turn-parser";

export type DocumentContextReference = {
  ref: string;
  title?: string;
  edition?: "current" | "original" | "history";
  quote?: string;
  turnId?: string;
  role?: "user" | "assistant";
  observedRevision?: string;
};

export type DocumentContextSnapshot = readonly DocumentContextReference[];

export type DocumentContextEnvelope = {
  version: 1;
  references: DocumentContextSnapshot;
};

export const DOCUMENT_CONTEXT_LIMITS = {
  maxReferences: 6,
  maxInspectedCandidates: 32,
  maxRefChars: 512,
  maxTitleChars: 160,
  maxQuoteChars: 1200,
  maxTurnIdChars: 128,
  maxObservedRevisionChars: 200,
  maxTotalChars: 8192,
} as const;

export const DOCUMENT_EXCERPT_SEPARATOR = "\n\n…\n\n";
export const EMPTY_DOCUMENT_CONTEXT: DocumentContextSnapshot = Object.freeze([]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasForbiddenControls(value: string): boolean {
  return /[\u0000-\u001f\u007f]/.test(value);
}

function boundedText(
  value: unknown,
  maximum: number,
  allowLineBreaks = false,
): string | undefined | null {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") return null;
  const normalized = (allowLineBreaks ? value.replaceAll("\r\n", "\n").replaceAll("\r", "\n") : value).trim();
  if (!normalized) return undefined;
  if (normalized.length > maximum) return null;
  if (allowLineBreaks ? /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(normalized) : hasForbiddenControls(normalized)) return null;
  return normalized;
}

export function canonicalDocumentContextRef(value: unknown): string | null {
  const ref = parseCanonicalDocumentRef(value);
  if (!ref) return null;
  const record = parseRecordRef(ref);
  return record && !parseSliceId(record.sliceId) ? null : ref;
}

export function parseDocumentContextReference(value: unknown): DocumentContextReference | null {
  if (!isRecord(value)) return null;
  const ref = canonicalDocumentContextRef(value.ref);
  if (!ref) return null;
  const title = boundedText(value.title, DOCUMENT_CONTEXT_LIMITS.maxTitleChars);
  const quote = boundedText(value.quote, DOCUMENT_CONTEXT_LIMITS.maxQuoteChars, true);
  const turnId = boundedText(value.turnId, DOCUMENT_CONTEXT_LIMITS.maxTurnIdChars);
  const observedRevision = boundedText(value.observedRevision, DOCUMENT_CONTEXT_LIMITS.maxObservedRevisionChars);
  if (title === null || quote === null || turnId === null || observedRevision === null) return null;
  if (value.edition !== undefined && value.edition !== "current" && value.edition !== "original" && value.edition !== "history") return null;
  if (value.role !== undefined && value.role !== "user" && value.role !== "assistant") return null;
  if (turnId && !/^[A-Za-z0-9_-]+$/.test(turnId)) return null;
  return {
    ref,
    ...(title ? { title } : {}),
    ...(value.edition ? { edition: value.edition } : {}),
    ...(quote ? { quote } : {}),
    ...(turnId ? { turnId } : {}),
    ...(value.role ? { role: value.role } : {}),
    ...(observedRevision ? { observedRevision } : {}),
  };
}

function freezeReferences(references: readonly DocumentContextReference[]): DocumentContextSnapshot {
  return Object.freeze(references.map((reference) => Object.freeze({ ...reference })));
}

export function documentContextChars(references: DocumentContextSnapshot): number {
  return JSON.stringify(references).length;
}

function targetKey(reference: DocumentContextReference): string {
  return JSON.stringify([reference.ref, reference.edition, reference.turnId, reference.role]);
}

function sameReference(a: DocumentContextReference, b: DocumentContextReference): boolean {
  return a.ref === b.ref &&
    a.title === b.title &&
    a.edition === b.edition &&
    a.quote === b.quote &&
    a.turnId === b.turnId &&
    a.role === b.role &&
    a.observedRevision === b.observedRevision;
}

function mergedQuote(existing: DocumentContextReference, incoming: DocumentContextReference): string | undefined | null {
  if (!incoming.quote) return existing.quote;
  if (!existing.quote || existing.quote === incoming.quote) return incoming.quote;
  const passages = existing.quote.split(DOCUMENT_EXCERPT_SEPARATOR);
  if (passages.includes(incoming.quote)) return existing.quote;
  const merged = `${existing.quote}${DOCUMENT_EXCERPT_SEPARATOR}${incoming.quote}`;
  return merged.length <= DOCUMENT_CONTEXT_LIMITS.maxQuoteChars ? merged : null;
}

export function addDocumentContextReference(
  current: DocumentContextSnapshot,
  value: unknown,
): { references: DocumentContextSnapshot; accepted: boolean } {
  const incoming = parseDocumentContextReference(value);
  if (!incoming) return { references: current, accepted: false };
  const index = current.findIndex((reference) => targetKey(reference) === targetKey(incoming));
  if (index < 0 && current.length >= DOCUMENT_CONTEXT_LIMITS.maxReferences) {
    return { references: current, accepted: false };
  }
  let next: DocumentContextReference[];
  if (index < 0) {
    next = [...current, incoming];
  } else {
    const existing = current[index];
    const revisionChanged = Boolean(
      existing.observedRevision && incoming.observedRevision && existing.observedRevision !== incoming.observedRevision,
    );
    if (revisionChanged) {
      next = current.map((reference, candidateIndex) => candidateIndex === index ? incoming : reference);
    } else {
      const quote = mergedQuote(existing, incoming);
      if (quote === null) return { references: current, accepted: false };
      const merged: DocumentContextReference = {
        ...existing,
        ...incoming,
        title: incoming.title ?? existing.title,
        observedRevision: incoming.observedRevision ?? existing.observedRevision,
        ...(quote ? { quote } : {}),
      };
      if (sameReference(existing, merged)) return { references: current, accepted: true };
      next = current.map((reference, candidateIndex) => candidateIndex === index ? merged : reference);
    }
  }
  if (documentContextChars(next) > DOCUMENT_CONTEXT_LIMITS.maxTotalChars) {
    return { references: current, accepted: false };
  }
  return { references: freezeReferences(next), accepted: true };
}

export function removeDocumentContextReference(
  current: DocumentContextSnapshot,
  ref: string,
): DocumentContextSnapshot {
  const canonical = canonicalDocumentContextRef(ref);
  if (!canonical) return current;
  const next = current.filter((reference) => reference.ref !== canonical);
  return next.length === current.length ? current : freezeReferences(next);
}

export function clearDocumentContextReferences(
  current: DocumentContextSnapshot,
  submitted?: DocumentContextSnapshot,
): DocumentContextSnapshot {
  if (!submitted) return EMPTY_DOCUMENT_CONTEXT;
  if (submitted.length === 0 || current.length === 0) return current;
  const next = current.filter((reference) => !submitted.some((sent) => sameReference(sent, reference)));
  return next.length === current.length ? current : freezeReferences(next);
}

export function snapshotDocumentContext(value: unknown): DocumentContextSnapshot {
  let snapshot = EMPTY_DOCUMENT_CONTEXT;
  const incoming = parseDocumentContextReference(value);
  if (!incoming) return snapshot;
  const result = addDocumentContextReference(snapshot, incoming);
  return result.accepted ? result.references : snapshot;
}

export function parseDocumentContext(value: unknown): DocumentContextSnapshot {
  if (value === undefined || value === null) return EMPTY_DOCUMENT_CONTEXT;
  const rawReferences = Array.isArray(value)
    ? value
    : isRecord(value) && (value.version === undefined || value.version === 1) && Array.isArray(value.references)
      ? value.references
      : null;
  if (!rawReferences) return EMPTY_DOCUMENT_CONTEXT;
  let references = EMPTY_DOCUMENT_CONTEXT;
  for (const candidate of rawReferences.slice(0, DOCUMENT_CONTEXT_LIMITS.maxInspectedCandidates)) {
    const result = addDocumentContextReference(references, candidate);
    if (result.accepted) references = result.references;
  }
  return references;
}

export function createDocumentContextEnvelope(
  references: DocumentContextSnapshot,
): DocumentContextEnvelope {
  return { version: 1, references: freezeReferences(references) };
}

export function createDocumentContextMetadata(
  references: DocumentContextSnapshot,
): { documentContext: DocumentContextEnvelope } | undefined {
  return references.length > 0 ? { documentContext: createDocumentContextEnvelope(references) } : undefined;
}

export function documentContextFromMetadata(value: unknown): DocumentContextSnapshot {
  if (!isRecord(value) || !("documentContext" in value)) return EMPTY_DOCUMENT_CONTEXT;
  return parseDocumentContext(value.documentContext);
}
