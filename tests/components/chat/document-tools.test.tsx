import type { ReactNode } from "react";
import { renderToString } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import { describe, expect, it, vi } from "vitest";
import { DocumentContextProvider } from "@/components/chat/document-context-provider";
import { DocumentNavigationProvider } from "@/components/documents/document-navigation";
import { RecallReferencesBar } from "@/components/chat/recall-references-bar";
import { RecallToolRenderer } from "@/components/chat/tool-renderers/recall";
import { ScenarioRecallRenderer } from "@/components/chat/tool-renderers/scenario-recall";
import { WriteCaseRenderer } from "@/components/chat/tool-renderers/write-case";
import type { ToolRenderState } from "@/lib/chat/tool-state";
import en from "../../../messages/en.json";

vi.mock("@/components/chat/tool-layout", () => ({
  ToolLayout: ({ name, summary, expandedContent }: {
    name: ReactNode;
    summary: ReactNode;
    expandedContent?: ReactNode;
  }) => <div data-tool-layout>{name}{summary}{expandedContent}</div>,
}));

function state(running = false): ToolRenderState {
  return {
    running,
    inputStreaming: false,
    interrupted: false,
    denied: false,
    approvalRequested: false,
    isActiveApproval: false,
  };
}

function render(node: ReactNode, navigation = true): string {
  const content = navigation
    ? <DocumentNavigationProvider value={{ onOpen: () => undefined }}>{node}</DocumentNavigationProvider>
    : node;
  return renderToString(
    <NextIntlClientProvider locale="en" messages={en} timeZone="UTC">
      <DocumentContextProvider>{content}</DocumentContextProvider>
    </NextIntlClientProvider>,
  );
}

describe("document tool entrances", () => {
  it("renders Open and @ only for the actual committed write result", () => {
    const committed = render(<WriteCaseRenderer
      input={{ category: "research", caseName: "phone", pieceTitle: "price", body: "body" }}
      output={{ ok: true, action: "addPiece", path: "memory/research/phone/2026-10-27-price.md" }}
      state={state()}
    />);
    expect(committed).toContain("Written price");
    expect(committed).toContain("Open document");
    expect(committed).toContain("Add to question");
    expect(committed).toContain('data-document-ref="research/phone/2026-10-27-price"');

    const queued = render(<WriteCaseRenderer
      input={{ category: "research", caseName: "phone", body: "body" }}
      state={state(true)}
    />);
    expect(queued).toContain("lands when this turn does");
    expect(queued).not.toContain("Open document");
    expect(queued).not.toContain("Written research/phone");

    const refused = render(<WriteCaseRenderer
      input={{ category: "research", caseName: "phone", body: "body" }}
      output={{ ok: false, reason: "A full read is required." }}
      state={state()}
    />);
    expect(refused).toContain("Not written");
    expect(refused).toContain("A full read is required.");
    expect(refused).not.toContain("Open document");
  });

  it("opens exact recallScenario evidence with turn and role metadata", () => {
    const html = render(<ScenarioRecallRenderer
      input={{ question: "What was said?" }}
      output={{
        answer: "A bounded answer",
        evidence: [{
          ref: "records/2026-10-12-1430",
          turnId: "a3fk2w",
          role: "assistant",
          quote: "The verbatim answer.",
        }],
        uncertainty: [],
      }}
      state={state()}
    />);
    expect(html).toContain('data-document-ref="records/2026-10-12-1430"');
    expect(html).toContain('data-document-turn="a3fk2w"');
    expect(html).toContain('data-document-role="assistant"');
    expect(html).toContain("The verbatim answer.");
    expect(html).toContain("Open document");
  });

  it("shows an explicit scenario read error instead of guessing a miss", () => {
    const html = render(<ScenarioRecallRenderer
      input={{ question: "What was said?" }}
      output={{ error: "Source read was refused.", evidence: [], uncertainty: [] }}
      state={state()}
    />);
    expect(html).toContain("Source read was refused.");
    expect(html).not.toContain("Insufficient original evidence");
    expect(html).not.toContain("Open document");
  });

  it("keeps recall read failures honest and opens successful reads", () => {
    const failure = render(<RecallToolRenderer
      toolName="recallRead"
      input={{ ref: "research/phone" }}
      output="This could not be read right now (offline). That is a read failure, not absence — it may still exist."
      state={state()}
    />);
    expect(failure).toContain("read failure");
    expect(failure).not.toContain("Open document");

    const success = render(<RecallToolRenderer
      toolName="recallRead"
      input={{ ref: "research/phone" }}
      output="ACTUAL BODY"
      state={state()}
    />);
    expect(success).toContain('data-document-ref="research/phone"');
    expect(success).toContain("ACTUAL BODY");
    expect(success).toContain("Open document");
  });

  it("opens recall bars as records and degrades to labels without navigation", () => {
    const references = [{ slice_id: "2026-10-12-1430", note: "evidence" }];
    const linked = render(<RecallReferencesBar references={references} />);
    expect(linked).toContain('data-document-ref="records/2026-10-12-1430"');
    expect(linked).toContain("<button");

    const staticHtml = render(<RecallReferencesBar references={references} />, false);
    expect(staticHtml).toContain("data-document-unavailable");
    expect(staticHtml).not.toContain("<button");
    expect(staticHtml).toContain('title="evidence"');
  });
});
