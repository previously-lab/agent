import { describe, expect, it } from "vitest";
import {
  DOCUMENT_CONTEXT_LIMITS,
  EMPTY_DOCUMENT_CONTEXT,
  addDocumentContextReference,
  canonicalDocumentContextRef,
  clearDocumentContextReferences,
  createDocumentContextMetadata,
  documentContextChars,
  documentContextFromMetadata,
  parseDocumentContext,
} from "@/lib/chat/document-context";
import { decodeDocumentContext, encodeDocumentContext } from "@/lib/chat/document-context-codec";
import { renderDocumentContext } from "@/lib/chat/document-context-prompt";
import { parseDocumentLink } from "@/lib/documents/document-link";
import { regenerationMessages } from "@/lib/chat/client-stream";
import type { UIMessage } from "@/lib/chat/protocol";

const reference = (ref: string, quote?: string) => ({ ref, title: ref.split("/").at(-1), ...(quote ? { quote } : {}) });

describe("document context validation and bounds", () => {
  it("accepts canonical case, piece, record, dossier, and bare legacy refs", () => {
    expect(canonicalDocumentContextRef("research/手机")).toBe("research/手机");
    expect(canonicalDocumentContextRef("research/手机/2026-10-01-price.md")).toBe("research/手机/2026-10-01-price");
    expect(canonicalDocumentContextRef("records/2028-02-29-2359")).toBe("records/2028-02-29-2359");
    expect(canonicalDocumentContextRef("dossier/previously")).toBe("dossier/previously");
    expect(canonicalDocumentContextRef("旧主题")).toBe("旧主题");
  });

  it("rejects traversal, storage prefixes, decorations, escaped separators, controls, URLs, and impossible record times", () => {
    for (const ref of [
      "../research/手机",
      "memory/research/手机",
      "research/../手机",
      "research/%E6%89%8B%E6%9C%BA",
      "《手机》",
      "https://example.com",
      "previously:research/手机",
      "research/手机?edition=current",
      "research/手机#fragment",
      "research\\手机",
      "records/9999-99-99-9999",
      "records/2025-02-29-1200",
      "records/2026-10-27-2460",
      "records/2026-10-27-1260",
      "research/\u0000bad",
    ]) {
      expect(canonicalDocumentContextRef(ref), ref).toBeNull();
    }
    expect(canonicalDocumentContextRef(`research/${"a".repeat(513)}`)).toBeNull();
  });

  it("drops malformed entries without touching the user message and inspects at most 32 candidates", () => {
    const message = "original user text";
    const parsed = parseDocumentContext({ version: 1, references: [
      { ref: "../bad" },
      { ref: "research/valid", title: "ok" },
      { ref: "records/9999-99-99-9999" },
      { ref: "research/oversize", quote: "x".repeat(1201) },
    ] });
    expect(parsed).toHaveLength(1);
    expect(parsed[0].ref).toBe("research/valid");
    expect(message).toBe("original user text");
    expect(parseDocumentContext(Array.from({ length: 33 }, (_, index) => index === 32 ? reference("research/late") : { ref: "../bad" }))).toEqual([]);
    expect(parseDocumentContext(Array.from({ length: 40 }, (_, index) => reference(`research/doc${index}`)))).toHaveLength(6);
  });

  it("enforces title, quote, count, and total bounds without truncating selected text", () => {
    expect(parseDocumentContext([{ ref: "research/title", title: "x".repeat(161) }])).toEqual([]);
    expect(parseDocumentContext([{ ref: "research/quote", quote: "x".repeat(1201) }])).toEqual([]);
    const full = parseDocumentContext(Array.from({ length: 6 }, (_, index) => reference(`research/doc${index}`, "汉".repeat(1200))));
    expect(full.length).toBeLessThanOrEqual(6);
    expect(documentContextChars(full)).toBeLessThanOrEqual(DOCUMENT_CONTEXT_LIMITS.maxTotalChars);
    expect(full.every((item) => (item.quote?.length ?? 0) <= 1200)).toBe(true);
  });

  it("merges distinct excerpts, keeps whole-document re-adds lossless, and replaces on observed revision change", () => {
    let current = addDocumentContextReference(EMPTY_DOCUMENT_CONTEXT, { ref: "research/doc", title: "Doc", quote: "first", observedRevision: "r1" }).references;
    current = addDocumentContextReference(current, { ref: "research/doc", title: "Doc", quote: "second", observedRevision: "r1" }).references;
    expect(current).toHaveLength(1);
    expect(current[0].quote).toBe("first\n\n…\n\nsecond");
    current = addDocumentContextReference(current, { ref: "research/doc", title: "Doc", observedRevision: "r1" }).references;
    expect(current[0].quote).toBe("first\n\n…\n\nsecond");
    current = addDocumentContextReference(current, { ref: "research/doc", title: "Doc", quote: "new edition", observedRevision: "r2" }).references;
    expect(current[0]).toMatchObject({ quote: "new edition", observedRevision: "r2" });
    expect(Object.isFrozen(current)).toBe(true);
    expect(Object.isFrozen(current[0])).toBe(true);
  });
});

describe("document context submission snapshots", () => {
  it("keeps normal and parallel snapshots independent across delayed image conversion and preserves later selections", async () => {
    const normal = parseDocumentContext([reference("research/normal", "normal quote")]);
    const parallel = parseDocumentContext([reference("research/parallel", "parallel quote")]);
    let conversion = (): void => undefined;
    const delayed = new Promise<void>((resolve) => { conversion = resolve; });
    const normalMessage = (async () => {
      await delayed;
      return { role: "user" as const, parts: [{ type: "file" as const, mediaType: "image/png", url: "data:image/png;base64,AA" }], metadata: createDocumentContextMetadata(normal) };
    })();
    const parallelMessage = (async () => {
      await delayed;
      return { role: "user" as const, parts: [{ type: "file" as const, mediaType: "image/png", url: "data:image/png;base64,BB" }], metadata: createDocumentContextMetadata(parallel) };
    })();
    let current = addDocumentContextReference(normal, reference("research/added-during-wait", "new")).references;
    conversion();
    const [normalUser, parallelUser] = await Promise.all([normalMessage, parallelMessage]);
    expect(documentContextFromMetadata(normalUser.metadata)[0].ref).toBe("research/normal");
    expect(documentContextFromMetadata(parallelUser.metadata)[0].ref).toBe("research/parallel");
    expect(normalUser.parts[0].url).toBe("data:image/png;base64,AA");
    expect(parallelUser.parts[0].url).toBe("data:image/png;base64,BB");
    current = clearDocumentContextReferences(current, normal);
    expect(current.map((item) => item.ref)).toEqual(["research/added-during-wait"]);
  });

  it("regenerates from the original message references and original images, never a new draft", () => {
    const original = parseDocumentContext([reference("research/original", "original quote")]);
    const user: UIMessage = {
      id: "u1",
      role: "user",
      metadata: createDocumentContextMetadata(original),
      parts: [
        { type: "file", mediaType: "image/png", filename: "original.png", url: "data:image/png;base64,ORIGINAL" },
        { type: "text", text: "original question" },
      ],
    };
    const answer: UIMessage = { id: "a1", role: "assistant", parts: [{ type: "text", text: "answer" }] };
    const retained = regenerationMessages([user, answer], answer.id);
    expect(retained).toHaveLength(1);
    expect(documentContextFromMetadata(retained[0].metadata)).toEqual(original);
    expect(retained[0].parts).toEqual(user.parts);
    const newDraft = parseDocumentContext([reference("research/new-draft")]);
    expect(newDraft).not.toEqual(original);
    expect(documentContextFromMetadata(retained[0].metadata)).not.toEqual(newDraft);
  });
});

describe("multilingual durable codec and grounding prompt", () => {
  it("round-trips six near-limit Chinese/emoji references beyond the old 12K ceiling", () => {
    const references = parseDocumentContext(Array.from({ length: 6 }, (_, index) => ({
      ref: `research/案例${index}`,
      title: "题".repeat(100),
      quote: "汉🙂".repeat(400),
    })));
    expect(references).toHaveLength(6);
    expect(documentContextChars(references)).toBeLessThanOrEqual(DOCUMENT_CONTEXT_LIMITS.maxTotalChars);
    const encoded = encodeDocumentContext(references);
    expect(encoded.length).toBeGreaterThan(12_288);
    expect(decodeDocumentContext(encoded)).toEqual(references);
  });

  it("uses B's escaped link formatter and labels selections as unverified pointers, never evidence or permission", () => {
    const prompt = renderDocumentContext(parseDocumentContext([{ ref: "research/项目 (试点)", title: "Project", quote: "client quote", observedRevision: "sha" }]));
    expect(prompt).toBeDefined();
    expect(prompt).toContain("recallScenario");
    expect(prompt).toContain("recallRead");
    expect(prompt).toContain("not durable-memory evidence");
    expect(prompt).toContain("not write authorization");
    expect(prompt).toContain("unverified reading pointer");
    expect(prompt).toContain("%20");
    expect(prompt).toContain("%28");
    expect(prompt).toContain("%29");
    const href = prompt?.match(/Reading pointer: \[[^\]]+\]\(([^)]+)\)/)?.[1];
    expect(href).toBeDefined();
    expect(parseDocumentLink(href)?.ref).toBe("research/项目 (试点)");
  });
});
