import { describe, expect, it } from "vitest";
import { assertDocumentWrite, documentSize, isConversationRecordPath, assertTailBudget } from "@/lib/docs/write-limits";
const path = "memory/things/records/index.md";
describe("document storage budgets", () => {
  it("counts Unicode code points and UTF8 rather than UTF16", () => {
    expect(documentSize("中😀")).toEqual({ characters: 2, bytes: 7, lines: 1 });
    expect(() => assertDocumentWrite(path, "😀".repeat(12_000))).not.toThrow();
    expect(() => assertDocumentWrite(path, "😀".repeat(12_001))).toThrow("document_full");
  });
  it.each([["", 0], ["a", 1], ["a\n", 1], ["a\r\n", 1], ["a\n\n", 2], ["\n", 1], ["a\rb", 2]])("counts logical lines in %j", (text, lines) => {
    expect(documentSize(text as string).lines).toBe(lines);
  });
  it("uses inclusive limits and preserves identical oversize retries only", () => {
    expect(() => assertDocumentWrite(path, "a\n".repeat(400))).not.toThrow();
    expect(() => assertDocumentWrite(path, "a\n".repeat(401))).toThrow("document_full");
    const old = "x".repeat(15_000);
    expect(() => assertDocumentWrite(path, old, old)).not.toThrow();
    expect(() => assertDocumentWrite(path, "shorter", old)).toThrow("document_full");
    expect(() => assertDocumentWrite(path, "x".repeat(14_000), old, true)).not.toThrow();
    expect(() => assertDocumentWrite(path, old + "x", old, true)).toThrow();
  });
  it("exempts only real record storage paths", () => {
    for (const p of ["memory/records/2026/11/03/1200/core.md", "memory/records/2026/11/03/agent.md", "memory/episodic/slices/2026/11/03/1200/timeline/agent.md", "memory/episodic/slices/2026/11/03/previously.md"]) expect(isConversationRecordPath(p)).toBe(true);
    for (const p of [path, "memory/records/2026/02/31/1200/core.md", "memory/records/2026/11/03/2460/core.md", "memory/records/report.md", "memory/records/2026/11/03/1200/note.md"]) expect(isConversationRecordPath(p)).toBe(false);
  });
  it("bounds individual and accumulated tails", () => {
    expect(() => assertTailBudget(path, "x".repeat(601), "short")).toThrow("document_full");
    expect(() => assertTailBudget(path, "short", "x".repeat(2001))).toThrow("document_full");
  });
});
