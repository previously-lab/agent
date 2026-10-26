import {
  EMPTY_DOCUMENT_CONTEXT,
  type DocumentContextSnapshot,
} from "./document-context";

export type DocumentScopeVersion = {
  scope: string;
  version: number;
};

export type ScopedDocumentReferences = DocumentScopeVersion & {
  references: DocumentContextSnapshot;
};

export function advanceDocumentScope(
  current: DocumentScopeVersion,
  scope: string,
): DocumentScopeVersion {
  return current.scope === scope
    ? current
    : { scope, version: current.version + 1 };
}

export function isDocumentScopeCurrent(
  expected: DocumentScopeVersion,
  actual: DocumentScopeVersion,
): boolean {
  return expected.scope === actual.scope && expected.version === actual.version;
}

export function documentReferencesForScope(
  stored: ScopedDocumentReferences,
  current: DocumentScopeVersion,
): ScopedDocumentReferences {
  return isDocumentScopeCurrent(stored, current)
    ? stored
    : { ...current, references: EMPTY_DOCUMENT_CONTEXT };
}
