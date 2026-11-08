import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { ImageAttachmentSnapshot } from "@/lib/chat/image-attachments";

vi.mock("next-intl", () => ({ useTranslations: (namespace: string) => (key: string) => `${namespace}.${key}` }));
vi.mock("../native-source-scope", () => ({ useNativePersona: () => "user" }));
vi.mock("../markdown", () => ({ MarkdownRenderer: ({ content, nativeMode }: { content: string; nativeMode?: string }) => React.createElement("div", { "data-test-native": nativeMode }, content) }));
vi.mock("../../documents/submitted-document-references", () => ({ SubmittedDocumentReferences: () => null }));
let ConversationImageBody: typeof import("../conversation-images").ConversationImageBody;
let ImagePolaroid: typeof import("../conversation-images").ImagePolaroid;
let DraftImagePlaceholder: typeof import("../conversation-images").DraftImagePlaceholder;
let RecordTurnView: typeof import("../../documents/record-turn").RecordTurnView;
beforeAll(async () => {
  vi.stubGlobal("React", React);
  ({ ConversationImageBody, ImagePolaroid, DraftImagePlaceholder } = await import("../conversation-images"));
  ({ RecordTurnView } = await import("../../documents/record-turn"));
});
const photos: ImageAttachmentSnapshot[] = [1, 2].map(ordinal => ({ version: 1, assetId: `img_${String(ordinal).padStart(32, "0")}`, ordinal,
  ref: `records/2026/02/01/0900/photo-${ordinal}.png`, name: `photo-${ordinal}.png`, mediaType: "image/png" }));

describe("one photo reading language", () => {
  it("links only known stable ordinals, leaves unknown markers literal, and retains the appendix", () => {
    const html = renderToStaticMarkup(React.createElement(ConversationImageBody, { content: "Visible 〔图2〕 and unresolved 〔图3〕", images: photos }));
    expect(html.match(/data-image-reference=/g)).toHaveLength(1);
    expect(html).toContain(`data-image-reference="${photos[1].assetId}"`);
    expect(html).toContain("〔图3〕");
    expect(html).toContain("conversation-image-annex");
    expect(html.match(/data-image-asset=/g)).toHaveLength(2);
    expect(html).not.toContain("data-image-arrival");
  });

  it.each(["user", "tool", "system", "unknown"] as const)("keeps %s record text inert and its photos readable", role => {
    const html = renderToStaticMarkup(React.createElement(RecordTurnView, { docRef: "records/example", speaker: "Fallback must not imply user", focused: false,
      turn: { index: 0, turnId: "stable", timestamp: "2026-02-01T09:00:00.000Z", role, content: "```html live\n<button>quoted</button>\n``` 〔图2〕", attachments: photos } }));
    expect(html).not.toContain("data-test-native");
    expect(html).toContain("&lt;button&gt;quoted&lt;/button&gt;");
    expect(html).toContain("data-image-reference");
    if (role !== "user") expect(html).toContain(`chat.input.source.${role}`);
  });

  it("enables the archived assistant's native reading surface", () => {
    const html = renderToStaticMarkup(React.createElement(RecordTurnView, { docRef: "records/example", speaker: "Previously", focused: false,
      turn: { index: 0, turnId: "stable", timestamp: "2026-02-01T09:00:00.000Z", role: "assistant", content: "agent native output" } }));
    expect(html).toContain('data-test-native="reader"');
  });
});


describe("photo framing and original access", () => {
  const longName = "a-very-long-photo-filename-that-must-remain-available-to-assistive-technology.png";
  const aspect = (html: string) => {
    const match = html.match(/--photo-aspect:([0-9.]+)/);
    expect(match).not.toBeNull();
    return Number(match![1]);
  };

  it.each([
    { width: 100, height: 100, expected: 1 },
    { width: 1, height: 99, expected: 3 / 4 },
    { width: 99, height: 1, expected: 16 / 9 },
  ])("bounds a $width × $height photo without cropping its source", ({ width, height, expected }) => {
    const image = { ...photos[0], width, height, name: longName };
    const html = renderToStaticMarkup(React.createElement(ImagePolaroid, { image, onSelect: vi.fn(), onRemove: vi.fn() }));
    expect(aspect(html)).toBeCloseTo(expected);
    expect(html).toContain('data-slot="dialog-trigger"');
    expect(html).toContain("conversation-photo-open");
    expect(html).toContain('aria-label="chat.richView.openNamedImage"');
    expect(html).toContain(`alt="${longName}"`);
    expect(html).toContain(`title="${longName}"`);
    expect(html).toContain(`width="${width}"`);
    expect(html).toContain(`height="${height}"`);
    expect(html).toContain("conversation-photo-label");
    expect(html).toContain("conversation-photo-remove");
  });

  it.each([
    { width: 1, height: 99, expected: 3 / 4 },
    { width: 99, height: 1, expected: 16 / 9 },
  ])("reserves the same bounded seat for a $width × $height upload", ({ width, height, expected }) => {
    const html = renderToStaticMarkup(React.createElement(DraftImagePlaceholder, {
      image: { localClientId: "draft-extreme", ordinal: 1, file: { name: longName } as File, status: "uploading", width, height },
      onRetry: vi.fn(), onRemove: vi.fn(),
    }));
    expect(aspect(html)).toBeCloseTo(expected);
    expect(html).toContain(`title="${longName}"`);
    expect(html).toContain("conversation-photo-remove");
  });
});
