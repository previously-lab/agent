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
vi.mock("../native-source-scope", () => ({ useNativePersona: () => "user", useNativeSourceScope: () => "test:user" }));
vi.mock("../document-mention-picker", () => ({
  DocumentReferenceChips: ({ references }: { references: Array<{ title: string }> }) => React.createElement("div", { "data-reference-chips": true }, references[0]?.title),
  DocumentMentionPicker: () => null,
  useDocumentMentionCatalog: () => ({ items: [], activeIndex: -1, setActiveIndex: vi.fn() }),
}));
vi.mock("@/hooks/use-image-attachments", () => ({
  useImageAttachments: () => ({ images: [], removed: null, limitReached: false, addFiles: vi.fn(), removeImage: vi.fn(), retryImage: vi.fn(), undoRemove: vi.fn(), acceptImages: vi.fn() }),
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

function renderInput(isLoading = false) {
  return renderToStaticMarkup(React.createElement(ChatInput, { onSubmit: vi.fn(), isLoading, onStop: vi.fn() }));
}

describe("the single manuscript input contract", () => {
  it("keeps one direct input with discoverable floating tools and shortcut help", () => {
    panelMode = "fullscreen";
    const html = renderInput();
    expect(html.match(/data-manuscript-input/g)).toHaveLength(1);
    expect(html.match(/contentEditable="true"/g)).toHaveLength(1);
    expect(html).not.toContain("<textarea");
    expect(html).toContain('data-controls-form="viewport"');
    expect(html.match(/data-conversation-primary/g)).toHaveLength(1);
    expect(html).toContain('data-composer-mini-toolbar');
    expect(html).toContain('data-composer-tools-trigger');
    expect(html).toContain('aria-keyshortcuts="Enter Control+Enter Meta+Enter"');
    expect(html).toContain('chat.input.keyboardSendHint');
    expect(html).toContain('data-composer-tools="true" hidden=""');
    expect(html).toContain('data-panel-form="manuscript"');
    expect(html).toContain('data-composer-state="idle"');
    expect(html).toContain("Rest discussion");
    expect(html).not.toContain("data-pill-expand");
  });

  it("uses the same atomic editor contract in the pill without a second input", () => {
    panelMode = "pill";
    const html = renderInput();
    expect(html.match(/data-manuscript-input/g)).toHaveLength(1);
    expect(html.match(/contentEditable="true"/g)).toHaveLength(1);
    expect(html).toContain('data-controls-form="inline"');
    expect(html).toContain('data-panel-form="pill"');
    expect(html).toContain("data-pill-expand");
    expect(html).toContain('data-composer-mini-toolbar');
    expect(html).toContain("Rest discussion");
  });

  it("replaces the primary action with stop while keeping a separate send entry", () => {
    panelMode = "fullscreen";
    const html = renderInput(true);
    expect(html.match(/data-conversation-primary/g)).toHaveLength(1);
    expect(html).toContain('data-primary-action="stop"');
    expect(html).toContain('data-composer-secondary-send');
    expect(html).toContain('chat.input.stopTooltip');
    expect(html.match(/contentEditable="true"/g)).toHaveLength(1);
  });
});
