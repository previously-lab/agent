import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, describe, expect, it, vi } from "vitest";

let panelMode: "pill" | "fullscreen" = "fullscreen";

vi.mock("next-intl", () => ({
  useTranslations: (namespace: string) => (key: string) => `${namespace}.${key}`,
}));
vi.mock("../conversation-panel", () => ({
  usePanelTier: () => ({ mode: panelMode, setMode: vi.fn() }),
  reducePanelMode: () => "fullscreen",
}));
vi.mock("../document-context-provider", () => ({
  useDocumentContext: () => ({
    references: [{ ref: "research/rest", title: "Rest discussion" }],
    addReference: vi.fn(),
    removeReference: vi.fn(),
  }),
}));
vi.mock("../native-source-scope", () => ({ useNativePersona: () => "user" }));
vi.mock("../document-mention-picker", () => ({
  DocumentReferenceChips: ({ references }: { references: Array<{ title: string }> }) => React.createElement("div", { "data-reference-chips": true }, references[0]?.title),
  DocumentMentionPicker: () => null,
  useDocumentMentionCatalog: () => ({ items: [], activeIndex: -1, setActiveIndex: vi.fn() }),
}));
vi.mock("@/hooks/use-image-attachments", () => ({
  useImageAttachments: () => ({ images: [], removeImage: vi.fn(), clearImages: vi.fn(), handlePaste: vi.fn(), handleDrop: vi.fn() }),
}));
vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => React.createElement(React.Fragment, {}, children),
  TooltipTrigger: ({ render }: { render: React.ReactElement }) => render,
  TooltipContent: () => null,
}));

let ChatInput: typeof import("../chat-input").ChatInput;
beforeAll(async () => {
  vi.stubGlobal("React", React);
  ({ ChatInput } = await import("../chat-input"));
});

function renderInput() {
  return renderToStaticMarkup(React.createElement(ChatInput, { onSubmit: vi.fn(), isLoading: false, onStop: vi.fn() }));
}

describe("the single manuscript input contract", () => {
  it("keeps direct input, mini controls and reference chips in fullscreen", () => {
    panelMode = "fullscreen";
    const html = renderInput();
    expect(html.match(/data-manuscript-input/g)).toHaveLength(1);
    expect(html.match(/<textarea/g)).toHaveLength(1);
    expect(html).toContain('data-composer-mini-toolbar');
    expect(html).toContain('data-panel-form="manuscript"');
    expect(html).toContain('data-composer-state="idle"');
    expect(html).toContain("Rest discussion");
    expect(html).not.toContain("data-pill-expand");
  });

  it("uses the same textarea contract in the pill without a second input", () => {
    panelMode = "pill";
    const html = renderInput();
    expect(html.match(/data-manuscript-input/g)).toHaveLength(1);
    expect(html.match(/<textarea/g)).toHaveLength(1);
    expect(html).toContain('data-panel-form="pill"');
    expect(html).toContain("data-pill-expand");
    expect(html).toContain('data-composer-mini-toolbar');
    expect(html).toContain("Rest discussion");
  });
});
