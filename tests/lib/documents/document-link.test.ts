import { describe, expect, it } from "vitest";
import {
  documentLabelFallback,
  formatDocumentLink,
  parseCanonicalDocumentRef,
  parseDocumentLink,
} from "@/lib/documents/document-link";

describe("document links", () => {
  it("accepts the existing canonical desk ref families", () => {
    expect(parseCanonicalDocumentRef("records/2026-10-12-1430")).toBe("records/2026-10-12-1430");
    expect(parseCanonicalDocumentRef("dossier/previously")).toBe("dossier/previously");
    expect(parseCanonicalDocumentRef("dossier/direction")).toBe("dossier/direction");
    expect(parseCanonicalDocumentRef("research/工作压力")).toBe("research/工作压力");
    expect(parseCanonicalDocumentRef("research/phone/2026-10-01-price.md")).toBe("research/phone/2026-10-01-price");
    expect(parseCanonicalDocumentRef("legacy-topic")).toBe("legacy-topic");
  });

  it("rejects paths, traversal, decorations, controls, and malformed refs", () => {
    const rejected = [
      "memory/docs/topic/legacy-topic",
      "/research/phone",
      "research//phone",
      "research/../phone",
      "research/phone?turn=a",
      "research/phone#fragment",
      "research/phone\\other",
      "records/not-a-slice",
      "records/2026-02-29-1200",
      "records/2026-13-01-1200",
      "records/2026-10-12-2400",
      "records/2026-10-12-1260",
      "dossier/other",
      "《legacy-topic》",
      " research/phone",
      "research/%2e%2e/phone",
      "research/phone\u0000",
      "unknown/topic",
      "https://example.com",
    ];
    for (const ref of rejected) expect(parseCanonicalDocumentRef(ref), ref).toBeNull();
  });

  it("parses semantic links with exact optional source coordinates", () => {
    expect(parseDocumentLink("previously:records/2026-10-12-1430")).toEqual({
      ref: "records/2026-10-12-1430",
    });
    expect(parseDocumentLink("previously:records/2026-10-12-1430?turn=a3fk2w&role=assistant&edition=original")).toEqual({
      ref: "records/2026-10-12-1430",
      turnId: "a3fk2w",
      role: "assistant",
      edition: "original",
    });
    expect(parseDocumentLink("previously:research/工作压力")).toEqual({ ref: "research/工作压力" });
  });

  it("round-trips formatting without fetching labels", () => {
    const formatted = formatDocumentLink("research/phone", {
      turnId: "turn-1",
      role: "user",
      edition: "history",
    });
    expect(formatted).toBe("previously:research/phone?turn=turn-1&role=user&edition=history");
    expect(parseDocumentLink(formatted)).toEqual({
      ref: "research/phone",
      turnId: "turn-1",
      role: "user",
      edition: "history",
    });
    const spaced = formatDocumentLink("research/phone review");
    expect(spaced).toBe("previously:research/phone%20review");
    expect(parseDocumentLink(spaced)?.ref).toBe("research/phone review");
    expect(documentLabelFallback("research/phone/2026-10-01-price")).toBe("price");
    expect(documentLabelFallback("dossier/previously")).toBe("Previously on");
  });

  it("percent-encodes Markdown delimiters without changing Unicode identity", () => {
    const formatted = formatDocumentLink("research/手机)评测(正式");
    expect(formatted).toBe("previously:research/手机%29评测%28正式");
    expect(parseDocumentLink(formatted)).toEqual({ ref: "research/手机)评测(正式" });
  });

  it("aligns turn ID bounds with document context", () => {
    const accepted = "a".repeat(128);
    const rejected = "a".repeat(129);
    expect(parseDocumentLink(`previously:research/phone?turn=${accepted}`)?.turnId).toBe(accepted);
    expect(parseDocumentLink(`previously:research/phone?turn=${rejected}`)).toBeNull();
    expect(formatDocumentLink("research/phone", { turnId: rejected })).toBeNull();
  });

  it("refuses every unsafe or ambiguous internal URL", () => {
    const rejected = [
      "http://example.com",
      "javascript:alert(1)",
      "previously://research/phone",
      "Previously:research/phone",
      "previously:memory/docs/topic/topic",
      "previously:research/../phone",
      "previously:research/%2e%2e/phone",
      "previously:research/phone%2Fother",
      "previously:research/phone%252Fother",
      "previously:research/phone#other",
      "previously:research/phone?turn=a&turn=b",
      "previously:research/phone?role=system",
      "previously:research/phone?edition=immutable",
      "previously:research/phone?unknown=value",
      "previously:research/phone?turn=a/b",
      "previously:research/phone?turn=",
      "previously:research/phone?",
    ];
    for (const href of rejected) expect(parseDocumentLink(href), href).toBeNull();
  });
});
