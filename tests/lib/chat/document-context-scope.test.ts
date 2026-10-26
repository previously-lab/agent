import { describe, expect, it } from "vitest";
import {
  advanceDocumentScope,
  documentReferencesForScope,
  isDocumentScopeCurrent,
} from "@/lib/chat/document-context-scope";
import { clearDocumentContextReferences, parseDocumentContext } from "@/lib/chat/document-context";

const references = parseDocumentContext([{ ref: "research/scope", title: "Scoped" }]);

describe("document scope version guards", () => {
  it("does not resurrect source A refs after A -> B -> A with no mutation in B", () => {
    const sourceA = { scope: "source-A:user", version: 0 };
    const storedA = { ...sourceA, references };
    const sourceB = advanceDocumentScope(sourceA, "source-B:user");
    expect(documentReferencesForScope(storedA, sourceB).references).toEqual([]);
    const backToA = advanceDocumentScope(sourceB, "source-A:user");
    expect(documentReferencesForScope(storedA, backToA).references).toEqual([]);
    const storedB = documentReferencesForScope(storedA, sourceB);
    expect(documentReferencesForScope(storedB, backToA).references).toEqual([]);
  });

  it("invalidates old persona refs even when the true source is unchanged", () => {
    const one = { scope: "source:persona-one", version: 0 };
    const stored = { ...one, references };
    const two = advanceDocumentScope(one, "source:persona-two");
    const back = advanceDocumentScope(two, "source:persona-one");
    expect(documentReferencesForScope(stored, two).references).toEqual([]);
    expect(documentReferencesForScope(stored, back).references).toEqual([]);
  });

  it("a stale async clear cannot remove an identical reference selected in a new scope", () => {
    const oldScope = { scope: "source-A:user", version: 0 };
    const newScope = advanceDocumentScope(oldScope, "source-B:user");
    let current = { ...newScope, references };
    const submitted = references;
    if (isDocumentScopeCurrent(oldScope, newScope)) {
      current = { ...current, references: clearDocumentContextReferences(current.references, submitted) };
    }
    expect(current.references).toEqual(references);
    expect(isDocumentScopeCurrent(newScope, newScope)).toBe(true);
  });
});
