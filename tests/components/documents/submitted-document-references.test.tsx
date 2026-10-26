import type { ReactNode } from "react";
import { renderToString } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import { describe, expect, it } from "vitest";
import { ChatMessage } from "@/components/chat/chat-message";
import { HistoryTurn } from "@/components/chat/history-turn";
import { DocumentNavigationProvider } from "@/components/documents/document-navigation";
import { SubmittedDocumentReferences } from "@/components/documents/submitted-document-references";
import type { DocumentContextReference } from "@/lib/chat/document-context";
import type { UIMessage } from "@/lib/chat/protocol";
import en from "../../../messages/en.json";

const reference: DocumentContextReference = {
  ref: "research/rest",
  title: "Rest discussion",
  edition: "original",
  quote: "A bounded passage",
  turnId: "turn-1",
  role: "user",
  observedRevision: "a".repeat(64),
};

function render(node: ReactNode, navigation = false): string {
  const content = navigation
    ? <DocumentNavigationProvider value={{ onOpen: () => undefined }}>{node}</DocumentNavigationProvider>
    : node;
  return renderToString(
    <NextIntlClientProvider locale="en" messages={en} timeZone="UTC">
      {content}
    </NextIntlClientProvider>,
  );
}

describe("submitted document references", () => {
  it("renders read-only labels without requiring a navigation provider", () => {
    const html = render(<SubmittedDocumentReferences references={[reference]} />);
    expect(html).toContain("data-submitted-document-references");
    expect(html).toContain("Rest discussion");
    expect(html).toContain("passage");
    expect(html).toContain("data-document-unavailable");
    expect(html).not.toContain("<button");
  });

  it("opens exact persisted coordinates when navigation is available", () => {
    const html = render(<SubmittedDocumentReferences references={[reference]} />, true);
    expect(html).toContain('data-document-ref="research/rest"');
    expect(html).toContain('data-document-turn="turn-1"');
    expect(html).toContain('data-document-role="user"');
    expect(html).toContain('data-document-edition="original"');
    expect(html).toContain("<button");
  });

  it("shows versioned live message metadata separately from user prose", () => {
    const message: UIMessage = {
      id: "user-1",
      role: "user",
      metadata: { documentContext: { version: 1, references: [reference] } },
      parts: [{ type: "text", text: "The question itself, not a selected chip." }],
    };
    const html = render(<ChatMessage message={message} />, true);
    expect(html).toContain("data-submitted-document-references");
    expect(html).toContain("Rest discussion");
    expect(html).toContain("The question itself, not a selected chip.");

    const proseOnly = render(<ChatMessage message={{ ...message, metadata: undefined }} />, true);
    expect(proseOnly).not.toContain("data-submitted-document-references");
    expect(proseOnly).not.toContain("Rest discussion");
  });

  it("renders saved-turn metadata and never invents references from assistant prose", () => {
    const saved = render(<HistoryTurn
      role="user"
      content="Original user words"
      sliceId="2026-10-12-1430"
      turnId="turn-1"
      timestamp="2026-10-12T14:30:00.000Z"
      documentContext={[reference]}
    />, true);
    expect(saved).toContain("data-submitted-document-references");
    expect(saved).toContain("Original user words");

    const assistant = render(<ChatMessage message={{
      id: "assistant-1",
      role: "assistant",
      parts: [{ type: "text", text: "[A model citation](previously:research/rest)" }],
    }} />, true);
    expect(assistant).toContain('data-document-ref="research/rest"');
    expect(assistant).not.toContain("data-submitted-document-references");
  });

  it("exposes the exact saved excerpt through a native disclosure outside the Open button", () => {
    const html = render(<SubmittedDocumentReferences references={[reference]} />, true);
    expect(html).toContain("<details");
    expect(html).toContain("<summary");
    expect(html).toContain("Selected passage from Rest discussion");
    expect(html).toContain("A bounded passage");
    expect(html.indexOf("<details")).toBeGreaterThan(html.indexOf("</button>"));
  });
});
