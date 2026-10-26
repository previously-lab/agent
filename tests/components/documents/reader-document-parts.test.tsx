import { renderToString } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import { describe, expect, it } from "vitest";
import { DocumentNavigationProvider } from "@/components/documents/document-navigation";
import { RecordTurnView } from "@/components/documents/record-turn";
import { RelatedDocuments } from "@/components/documents/related-documents";
import type { VerifiedRef } from "@/lib/archive/actions";
import en from "../../../messages/en.json";

function render(node: React.ReactNode): string {
  return renderToString(
    <NextIntlClientProvider locale="en" messages={en} timeZone="UTC">
      <DocumentNavigationProvider value={{ onOpen: () => undefined }}>
        {node}
      </DocumentNavigationProvider>
    </NextIntlClientProvider>,
  );
}

describe("reader document parts", () => {
  it("renders exact record identity, focus, persisted references, and verbatim content", () => {
    const html = render(<RecordTurnView
      docRef="records/2026-10-12-1430"
      turn={{
        index: 7,
        turnId: "turn-7",
        role: "user",
        timestamp: "2026-10-12T14:30:00.000Z",
        content: "The exact user paragraph.",
        documentContext: [{ ref: "research/rest", title: "Rest discussion" }],
      }}
      speaker="You"
      focused
    />);
    expect(html).toContain('data-record-turn-index="7"');
    expect(html).toContain('data-turn-id="turn-7"');
    expect(html).toContain('data-turn-role="user"');
    expect(html).toContain("data-reading-focus");
    expect(html).toContain("data-submitted-document-references");
    expect(html).toContain('data-document-ref="research/rest"');
    expect(html).toContain("The exact user paragraph.");
  });

  it("renders related open, not-found, and unresolved states without fetching", () => {
    const status = new Map<string, VerifiedRef>([
      ["research/rest", { ref: "research/rest", kind: "case", alive: true }],
      ["research/missing", { ref: "research/missing", kind: "case", alive: false }],
    ]);
    const html = render(<RelatedDocuments
      documents={[
        { ref: "research/rest", title: "Rest discussion", location: { edition: "original" } },
        { ref: "research/missing", title: "Missing document", location: {} },
        { ref: "research/unresolved", title: "Unresolved document", location: {} },
      ]}
      status={status}
    />);
    expect(html).toContain("Related documents");
    expect(html).toContain('data-document-ref="research/rest"');
    expect(html).toContain('data-document-edition="original"');
    expect(html).toContain("Missing document");
    expect(html).toContain("Not found");
    expect(html).toContain("Unresolved document");
    expect(html).toContain("Unavailable to open");
  });
});
