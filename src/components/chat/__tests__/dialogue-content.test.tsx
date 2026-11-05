import * as React from "react";
import { createHash } from "node:crypto";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { ContentBlockV1, DialogueArtifactRef } from "@/lib/chat/dialogue-contract";
import type { ImageAttachmentSnapshot } from "@/lib/chat/image-attachments";

vi.mock("next-intl", () => ({ useTranslations: (namespace: string) => (key: string) => `${namespace}.${key}`, useLocale: () => "en" }));
vi.mock("next/navigation", () => ({ useSearchParams: () => new URLSearchParams() }));

let readDialogueArtifact: typeof import("../native-artifact").readDialogueArtifact;
let DialogueContent: typeof import("../dialogue-utterance").DialogueContent;
let RecordTurnView: typeof import("../../documents/record-turn").RecordTurnView;
let DialogueWorkStatus: typeof import("../dialogue-work-status").DialogueWorkStatus;
beforeAll(async () => {
  vi.stubGlobal("React", React);
  ({ readDialogueArtifact } = await import("../native-artifact"));
  ({ DialogueContent } = await import("../dialogue-utterance"));
  ({ RecordTurnView } = await import("../../documents/record-turn"));
  ({ DialogueWorkStatus } = await import("../dialogue-work-status"));
});

const htmlSource = "<!doctype html>\r\n<p>原始 HTML</p>  \r\n";
const descriptor = (body: string): DialogueArtifactRef => ({
  artifactId: "original-widget", sourceOwnerId: "thinking-owner", revision: 1, kind: "native_html", mediaType: "text/html",
  sha256: createHash("sha256").update(body).digest("hex"), byteSize: Buffer.byteLength(body), height: 240,
});
const artifact = descriptor(htmlSource);

describe("direct artifact reuse", () => {
  it("reads the same authorized ref and preserves every original body character without a fence", async () => {
    const request = vi.fn(async () => Response.json({ artifact, body: htmlSource }));
    await expect(readDialogueArtifact(artifact, "user", new AbortController().signal, request)).resolves.toBe(htmlSource);
    expect(request).toHaveBeenCalledWith("/api/chat/dialogue/artifacts/original-widget?persona=user", expect.objectContaining({ credentials: "same-origin", redirect: "error" }));
  });

  it("rejects a changed identity or altered body instead of executing it", async () => {
    const signal = new AbortController().signal;
    await expect(readDialogueArtifact(artifact, "user", signal, async () => Response.json({ artifact: { ...artifact, sourceOwnerId: "other" }, body: htmlSource }))).rejects.toThrow("identity");
    await expect(readDialogueArtifact(artifact, "user", signal, async () => Response.json({ artifact, body: htmlSource.replace("HTML", "Oops") }))).rejects.toThrow("bytes");
  });

  it("resolves a footnote across typed blocks and uses the same artifact seat in the saved reader", () => {
    const blocks: ContentBlockV1[] = [
      { kind: "markdown", blockId: "lead", text: "Start[^n].\n\n```html live\n<script>notAnArtifact()</script>\n```" },
      { kind: "artifact_ref", blockId: "display-slot", artifact },
      { kind: "markdown", blockId: "note", text: "Tail.\n\n[^n]: Original evidence." },
    ];
    const live = renderToStaticMarkup(React.createElement(DialogueContent, { blocks, mode: "interactive" }));
    const paper = renderToStaticMarkup(React.createElement(RecordTurnView, { docRef: "records/example", speaker: "Previously", focused: false,
      turn: { index: 0, role: "assistant", content: "Fallback only", timestamp: "2026-11-06T09:00:00.000Z", dialogue: {
        kind: "public_utterance", publicationId: "publication", publicSeq: 1, inputIds: ["input"], sourceResults: [], blocks,
      } } }));
    for (const markup of [live, paper]) {
      expect(markup).toContain('data-artifact-ref="original-widget"');
      expect(markup).toContain('data-artifact-state="pending"');
      expect(markup).toContain("Original evidence.");
      expect(markup).toContain("data-footnote-ref");
      expect(markup).not.toContain("<script>");
      expect(markup).not.toContain("<iframe");
    }
    expect(paper).not.toContain("Fallback only");
  });

  it("keeps photo markers, citations and prose in typed block order without guessing unknown photos", () => {
    const image: ImageAttachmentSnapshot = { version: 1, assetId: `img_${"7".padStart(32, "0")}`, ordinal: 7,
      ref: "records/2026/11/06/0900/photo.png", name: "photo.png", mediaType: "image/png" };
    const blocks: ContentBlockV1[] = [
      { kind: "markdown", blockId: "lead", text: "Before 〔图7〕 and unknown 〔图8〕." },
      { kind: "image_ref", blockId: "photo", image },
      { kind: "citation_ref", blockId: "source", ref: "previously:records/2026/11/06/0900?turn=turn-1&role=assistant", label: "Original source" },
      { kind: "markdown", blockId: "tail", text: "After the source." },
    ];
    const html = renderToStaticMarkup(React.createElement(DialogueContent, { blocks, mode: "reader" }));
    expect(html).toContain(`data-image-reference="${image.assetId}"`);
    expect(html).toContain(`data-image-asset="${image.assetId}"`);
    expect(html).toContain('data-image-ordinal="7"');
    expect(html).toContain("unknown 〔图8〕");
    expect(html).toContain("Original source");
    expect(html).toContain("data-document-unavailable");
    expect(html.indexOf("Before")).toBeLessThan(html.indexOf(`data-image-asset="${image.assetId}"`));
    expect(html.indexOf(`data-image-asset="${image.assetId}"`)).toBeLessThan(html.indexOf("Original source"));
    expect(html.indexOf("Original source")).toBeLessThan(html.indexOf("After the source."));
  });

  it("offers a collapsed thought-product disclosure for a text-only result", () => {
    const html = renderToStaticMarkup(React.createElement(DialogueWorkStatus, {
      works: [{ workId: "work", inputId: "input", userSeq: 1, status: "completed", summary: "A concise internal finding" }],
      inputs: new Map(), expression: "idle", onCancel: async () => {},
    }));
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain("chat.dialogue.workProducts");
    expect(html).not.toContain("A concise internal finding");
  });
});
