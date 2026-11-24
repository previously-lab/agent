import { describe, expect, it } from "vitest";
import { documentSize, isConversationRecordPath } from "@/lib/docs/write-limits";
const path = "memory/things/records/index.md";
describe("document measurements and path classification", () => {
  it("counts Unicode code points and UTF8 rather than UTF16", () => {
    expect(documentSize("中😀")).toEqual({ characters: 2, bytes: 7, lines: 1 });
  });
  it.each([["", 0], ["a", 1], ["a\n", 1], ["a\r\n", 1], ["a\n\n", 2], ["\n", 1], ["a\rb", 2]])("counts logical lines in %j", (text, lines) => {
    expect(documentSize(text as string).lines).toBe(lines);
  });
  it("exempts only real record storage paths", () => {
    for (const p of ["memory/records/2026/11/03/1200/core.md", "memory/records/2026/11/03/agent.md"]) expect(isConversationRecordPath(p)).toBe(true);
    for (const p of [path, "memory/records/2026/02/31/1200/core.md", "memory/records/2026/11/03/2460/core.md", "memory/records/report.md", "memory/records/2026/11/03/1200/note.md", "memory/episodic/slices/2026/11/03/1200/timeline/agent.md", "memory/episodic/slices/2026/11/03/previously.md"]) expect(isConversationRecordPath(p)).toBe(false);
  });

});
