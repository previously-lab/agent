import { describe, expect, it } from "vitest";
import { createWorkPreviewFilter, workPreviewCursor } from "@/lib/dialogue/work-preview";

function project(chunks: unknown[]) {
  const filter = createWorkPreviewFilter();
  return chunks.map((chunk) => filter.push(chunk)).filter((signal) => signal !== null);
}

describe("dialogue work preview filtering", () => {
  it("streams displayable text but never raw reasoning", () => {
    expect(project([
      { type: "text-start", id: "text-1" },
      { type: "text-delta", id: "text-1", delta: "Hello" },
      { type: "reasoning-start", id: "reasoning-1" },
      { type: "reasoning-delta", id: "reasoning-1", delta: "private chain of thought" },
      { type: "data-reasoning", data: { reasoning_content: "also private" } },
      { type: "text-delta", id: "text-1", delta: " world" },
      { type: "text-end", id: "text-1" },
    ])).toEqual([
      { type: "text", partId: "text-1", delta: "Hello" },
      { type: "text", partId: "text-1", delta: " world" },
    ]);
  });

  it("withholds a split native opener, all HTML bytes, and resumes after its close", () => {
    const signals = project([
      { type: "text-delta", id: "text-1", delta: "Before\n" },
      { type: "text-delta", id: "text-1", delta: "`" },
      { type: "text-delta", id: "text-1", delta: "`" },
      { type: "text-delta", id: "text-1", delta: "`html" },
      { type: "text-delta", id: "text-1", delta: " live\n<!doctype html>\n<script>secret</script>\n" },
      { type: "text-delta", id: "text-1", delta: "```\nAfter" },
      { type: "text-end", id: "text-1" },
    ]);
    expect(signals).toEqual([
      { type: "text", partId: "text-1", delta: "Before\n" },
      { type: "text", partId: "text-1", delta: "After" },
    ]);
    expect(JSON.stringify(signals)).not.toContain("secret");
  });

  it("cuts malformed raw HTML and unfinished structure without breaking ordinary comparisons", () => {
    expect(project([
      { type: "text-delta", id: "html", delta: "Hello <" },
      { type: "text-delta", id: "html", delta: "script>secret</script>" },
      { type: "text-delta", id: "fence", delta: "```ht" },
      { type: "text-end", id: "fence" },
      { type: "text-delta", id: "math", delta: "2 < 3" },
    ])).toEqual([
      { type: "text", partId: "html", delta: "Hello " },
      { type: "text", partId: "math", delta: "2 < 3" },
    ]);
  });

  it("forwards only tool identity and state, with one running frame per call", () => {
    const signals = project([
      { type: "tool-input-start", toolCallId: "call-1", toolName: "readFile" },
      { type: "tool-input-delta", toolCallId: "call-1", inputTextDelta: "{\"path\":\"secret\"}" },
      { type: "tool-call", toolCallId: "call-1", toolName: "readFile", input: { path: "secret" } },
      { type: "tool-result", toolCallId: "call-1", toolName: "readFile", output: { token: "secret" } },
      { type: "tool-output-error", toolCallId: "call-2", errorText: "credential failed" },
    ]);
    expect(signals).toEqual([
      { type: "tool", toolCallId: "call-1", toolName: "readFile", state: "running" },
      { type: "tool", toolCallId: "call-1", toolName: "readFile", state: "completed" },
      { type: "tool", toolCallId: "call-2", toolName: "tool", state: "failed" },
    ]);
    expect(JSON.stringify(signals)).not.toContain("secret");
    expect(JSON.stringify(signals)).not.toContain("credential");
  });

  it("accepts only non-negative safe integer cursors", () => {
    expect(workPreviewCursor(null)).toBe(0);
    expect(workPreviewCursor("12")).toBe(12);
    expect(workPreviewCursor("-2")).toBe(0);
    expect(workPreviewCursor("2junk")).toBe(0);
    expect(workPreviewCursor("9007199254740992")).toBe(0);
  });
});
