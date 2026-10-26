import { renderToString } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AddDocumentReferenceAction } from "@/components/documents/document-actions";
import type { DocumentContextReference } from "@/lib/chat/document-context";
import en from "../../../messages/en.json";

const { useDocumentContextMock, addReferenceMock } = vi.hoisted(() => ({
  useDocumentContextMock: vi.fn(),
  addReferenceMock: vi.fn(),
}));

vi.mock("@/components/chat/document-context-provider", () => ({
  useDocumentContext: useDocumentContextMock,
}));

const reference: DocumentContextReference = {
  ref: "research/rest",
  title: "Rest discussion",
  edition: "original",
  quote: "A bounded passage",
  turnId: "turn-1",
  role: "user",
};

function renderWithReferences(references: DocumentContextReference[]): string {
  useDocumentContextMock.mockReturnValue({
    references,
    addReference: addReferenceMock,
  });
  return renderToString(
    <NextIntlClientProvider locale="en" messages={en} timeZone="UTC">
      <AddDocumentReferenceAction reference={reference} />
    </NextIntlClientProvider>,
  );
}

describe("document reference actions", () => {
  beforeEach(() => {
    useDocumentContextMock.mockReset();
    addReferenceMock.mockReset();
  });

  it("derives add, remove and re-add availability from current provider references", () => {
    const initiallySelected = renderWithReferences([reference]);
    expect(initiallySelected).toContain("Added");
    expect(initiallySelected).toContain('disabled=""');

    const afterRemoveOrSend = renderWithReferences([]);
    expect(afterRemoveOrSend).toContain("Add to question");
    expect(afterRemoveOrSend).not.toContain('disabled=""');

    const readded = renderWithReferences([reference]);
    expect(readded).toContain("Added");
    expect(readded).toContain('disabled=""');
  });

  it("does not treat a distinct selected passage as the same saved reference", () => {
    const differentPassage = renderWithReferences([{ ...reference, quote: "Another passage" }]);
    expect(differentPassage).toContain("Add to question");
    expect(differentPassage).not.toContain('disabled=""');

    const samePassage = renderWithReferences([reference]);
    expect(samePassage).toContain('disabled=""');
  });
});
