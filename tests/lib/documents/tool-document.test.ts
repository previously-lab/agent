import { describe, expect, it } from "vitest";
import { createCaseReadEnvelope } from "@/lib/chat/case-read-receipt";
import {
  recallEntryDocumentTarget,
  recallReadDocumentTarget,
  writeCaseDocumentTarget,
} from "@/lib/documents/tool-document";

describe("tool document targets", () => {
  it("opens only the real committed writeCase path", () => {
    expect(writeCaseDocumentTarget({
      ok: true,
      action: "open",
      path: "memory/research/phone/index.md",
    })).toEqual({ ref: "research/phone", title: "phone", edition: "original" });
    expect(writeCaseDocumentTarget({
      ok: true,
      action: "addPiece",
      path: "memory/research/phone/2026-10-27-price.md",
    })).toEqual({ ref: "research/phone/2026-10-27-price", title: "price", edition: "original" });
  });

  it("never turns queued, refused, unknown, or unsafe write results into success actions", () => {
    for (const output of [
      undefined,
      { ok: false, reason: "read required" },
      { ok: true, action: "open", path: "src/lib/document.ts" },
      { ok: true, action: "open", path: "memory/research/phone/2026-10-27-price.md" },
      { ok: true, action: "addPiece", path: "memory/research/phone/index.md" },
      { ok: true, action: "rewrite", path: "memory/research/phone/index.md" },
      { unexpected: true },
      "not json",
    ]) {
      expect(writeCaseDocumentTarget(output)).toBeNull();
    }
  });

  it("uses the actual receipt ref and observed revision for a full case read", () => {
    const revision = "a".repeat(64);
    const output = createCaseReadEnvelope({
      scopeId: "scope",
      toolCallId: "call",
      requestedRef: "research/phon",
      category: "research",
      caseName: "phone",
      revision,
      rendered: "ACTUAL BODY",
    });
    expect(recallReadDocumentTarget({ ref: "research/phon" }, output)).toEqual({
      ref: "research/phone",
      title: "phone",
      edition: "original",
      observedRevision: revision,
    });
  });

  it("keeps read misses, failures, unsupported refs, and revisionless reads honest", () => {
    expect(recallReadDocumentTarget(
      { ref: "research/missing" },
      "Nothing named \"research/missing\" exists in memory — and nothing similar.",
    )).toBeNull();
    expect(recallReadDocumentTarget(
      { ref: "research/phone" },
      "This could not be read right now (offline). That is a read failure, not absence — it may still exist.",
    )).toBeNull();
    expect(recallReadDocumentTarget({ ref: "research/phone" }, "RAW BODY")).toEqual({
      ref: "research/phone",
      title: "phone",
      edition: "original",
    });
    expect(recallReadDocumentTarget({ ref: "self/agenda" }, "RAW BODY")).toBeNull();
    expect(recallEntryDocumentTarget("records/2026-10-12-1430", "A real title")).toEqual({
      ref: "records/2026-10-12-1430",
      title: "A real title",
      edition: "original",
    });
    expect(recallEntryDocumentTarget("memory/docs/topic/topic", "unsafe")).toBeNull();
  });
});
