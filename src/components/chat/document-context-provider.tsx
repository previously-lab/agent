"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  EMPTY_DOCUMENT_CONTEXT,
  addDocumentContextReference,
  clearDocumentContextReferences,
  removeDocumentContextReference,
  type DocumentContextReference,
  type DocumentContextSnapshot,
} from "@/lib/chat/document-context";
import {
  advanceDocumentScope,
  documentReferencesForScope,
  isDocumentScopeCurrent,
  type ScopedDocumentReferences,
} from "@/lib/chat/document-context-scope";
import { useNativeSourceScope } from "./native-source-scope";

export interface DocumentContextValue {
  references: DocumentContextSnapshot;
  addReference: (reference: DocumentContextReference) => boolean;
  removeReference: (ref: string) => void;
  clearReferences: (submitted?: DocumentContextSnapshot) => void;
  getSnapshot: () => DocumentContextSnapshot;
}

const DocumentContext = createContext<DocumentContextValue | null>(null);
const DocumentContextPersona = createContext<((persona: string) => void) | null>(null);

export function DocumentContextProvider({ children }: { children: ReactNode }): React.JSX.Element {
  const source = useNativeSourceScope();
  const [persona, setPersona] = useState("user");
  const scope = JSON.stringify([source, persona]);
  const scopeRef = useRef({ scope, version: 0 });
  if (scopeRef.current.scope !== scope) {
    scopeRef.current = advanceDocumentScope(scopeRef.current, scope);
  }
  const currentScope = scopeRef.current;
  const [state, setState] = useState<ScopedDocumentReferences>({
    ...currentScope,
    references: EMPTY_DOCUMENT_CONTEXT,
  });
  const current = documentReferencesForScope(state, currentScope);
  const stateRef = useRef(current);
  stateRef.current = current;

  useEffect(() => {
    setState((stored) => isDocumentScopeCurrent(stored, currentScope)
      ? stored
      : { ...currentScope, references: EMPTY_DOCUMENT_CONTEXT });
  }, [currentScope]);

  const addReference = useCallback((reference: DocumentContextReference): boolean => {
    if (!isDocumentScopeCurrent(currentScope, scopeRef.current)) return false;
    const result = addDocumentContextReference(stateRef.current.references, reference);
    if (!result.accepted) return false;
    if (result.references !== stateRef.current.references) {
      const next = { ...currentScope, references: result.references };
      stateRef.current = next;
      setState(next);
    }
    return true;
  }, [currentScope]);

  const removeReference = useCallback((ref: string): void => {
    if (!isDocumentScopeCurrent(currentScope, scopeRef.current)) return;
    const nextReferences = removeDocumentContextReference(stateRef.current.references, ref);
    if (nextReferences === stateRef.current.references) return;
    const next = { ...currentScope, references: nextReferences };
    stateRef.current = next;
    setState(next);
  }, [currentScope]);

  const clearReferences = useCallback((submitted?: DocumentContextSnapshot): void => {
    if (!isDocumentScopeCurrent(currentScope, scopeRef.current)) return;
    const nextReferences = clearDocumentContextReferences(stateRef.current.references, submitted);
    if (nextReferences === stateRef.current.references) return;
    const next = { ...currentScope, references: nextReferences };
    stateRef.current = next;
    setState(next);
  }, [currentScope]);

  const getSnapshot = useCallback((): DocumentContextSnapshot => {
    return isDocumentScopeCurrent(currentScope, scopeRef.current)
      ? stateRef.current.references
      : EMPTY_DOCUMENT_CONTEXT;
  }, [currentScope]);
  const value = useMemo<DocumentContextValue>(() => ({
    references: current.references,
    addReference,
    removeReference,
    clearReferences,
    getSnapshot,
  }), [current.references, addReference, removeReference, clearReferences, getSnapshot]);

  return (
    <DocumentContextPersona.Provider value={setPersona}>
      <DocumentContext.Provider value={value}>{children}</DocumentContext.Provider>
    </DocumentContextPersona.Provider>
  );
}

export function DocumentContextPersonaSync({ persona }: { persona: string }): null {
  const setPersona = useContext(DocumentContextPersona);
  useEffect(() => {
    setPersona?.(persona);
  }, [persona, setPersona]);
  return null;
}

export function useDocumentContext(): DocumentContextValue {
  const value = useContext(DocumentContext);
  if (!value) throw new Error("useDocumentContext must be used inside DocumentContextProvider");
  return value;
}
